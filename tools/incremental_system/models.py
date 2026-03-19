from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Any

from tools.eval.common import normalize_whitespace, strip_code_fences
from tools.incremental_system.chat_clients import OpenAICompatibleChatClient
from tools.incremental_system.loader import _graph_ir_from_payload
from tools.incremental_system.schema import (
    DialogueTurn,
    GateDecision,
    PlannerOutput,
    RuntimeSample,
    SessionState,
)


def _parse_json_object(text: str) -> dict[str, Any]:
    raw = strip_code_fences(text or "")
    if not raw.strip():
        raise ValueError("empty model output")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\})", raw, flags=re.DOTALL)
        if not match:
            raise
        payload = json.loads(match.group(1))
    if not isinstance(payload, dict):
        raise ValueError("model output is not a JSON object")
    return payload


def _recent_turns(turns: list[DialogueTurn], limit: int = 8) -> list[dict[str, Any]]:
    rows = []
    for turn in turns[-limit:]:
        rows.append(
            {
                "turn_id": turn.turn_id,
                "speaker": turn.speaker,
                "content": normalize_whitespace(turn.content),
                "stage_index": turn.stage_index,
            }
        )
    return rows


class GateModel(ABC):
    name = "gate_model"

    @abstractmethod
    def decide(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
    ) -> GateDecision:
        raise NotImplementedError


class PlannerModel(ABC):
    name = "planner_model"

    @abstractmethod
    def plan(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
        gate_decision: GateDecision,
    ) -> PlannerOutput:
        raise NotImplementedError


class OracleGateModel(GateModel):
    name = "oracle_gate"

    def decide(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
    ) -> GateDecision:
        next_stage_index = state.current_stage_index + 1
        if next_stage_index > sample.total_stages:
            return GateDecision(action="WAIT", reason="all stages already applied")
        boundary = sample.boundary_by_stage(next_stage_index)
        current_turn = observed_turns[-1]
        if boundary and current_turn.turn_id >= boundary.end_turn:
            return GateDecision(
                action="EMIT_UPDATE",
                target_stage_index=next_stage_index,
                reason=f"turn {current_turn.turn_id} reached end boundary for stage {next_stage_index}",
                confidence=1.0,
            )
        return GateDecision(
            action="WAIT",
            target_stage_index=next_stage_index,
            reason=f"waiting for stage {next_stage_index} boundary",
            confidence=1.0,
        )


class OraclePlannerModel(PlannerModel):
    name = "oracle_planner"

    def plan(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
        gate_decision: GateDecision,
    ) -> PlannerOutput:
        if gate_decision.target_stage_index is None:
            raise ValueError("OraclePlannerModel requires gate_decision.target_stage_index")
        stage = sample.stage_by_index(gate_decision.target_stage_index)
        return PlannerOutput(
            target_stage_index=stage.stage_index,
            delta_ops=list(stage.delta_ops),
            target_graph_ir=stage.graph_ir,
            notes=stage.stage_description,
            metadata={
                "planner_mode": "oracle",
                "stage_name": stage.stage_name,
            },
        )


class LLMGateModel(GateModel):
    name = "llm_gate"

    def __init__(self, client: OpenAICompatibleChatClient, recent_turn_limit: int = 8) -> None:
        self.client = client
        self.recent_turn_limit = recent_turn_limit

    def decide(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
    ) -> GateDecision:
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the small gate model for an incremental diagram system. "
                    "Decide whether the system should WAIT or EMIT_UPDATE. "
                    "Return strict JSON only with keys: action, target_stage_index, reason, confidence."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "sample_id": sample.sample_id,
                        "diagram_type": sample.diagram_type,
                        "total_stages": sample.total_stages,
                        "current_stage_index": state.current_stage_index,
                        "recent_turns": _recent_turns(observed_turns, self.recent_turn_limit),
                        "current_state": state.metadata.get("graph_metrics", {}),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            },
        ]
        result = self.client.chat(messages)
        payload = _parse_json_object(result.text)
        target_stage_index = payload.get("target_stage_index")
        return GateDecision(
            action=str(payload.get("action", "WAIT")).upper(),
            target_stage_index=int(target_stage_index) if target_stage_index not in {None, ""} else None,
            reason=str(payload.get("reason", "")),
            confidence=float(payload["confidence"]) if payload.get("confidence") is not None else None,
            metadata={
                "model_name": self.client.model,
                "latency_ms": result.latency_ms,
                "usage": result.usage,
            },
        )


class LLMPlannerModel(PlannerModel):
    name = "llm_planner"

    def __init__(self, client: OpenAICompatibleChatClient, recent_turn_limit: int = 10) -> None:
        self.client = client
        self.recent_turn_limit = recent_turn_limit

    def plan(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
        gate_decision: GateDecision,
    ) -> PlannerOutput:
        next_stage_index = gate_decision.target_stage_index or (state.current_stage_index + 1)
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the large planner model for an incremental diagram system. "
                    "Given the latest conversational prefix and the current graph state, predict the next graph state. "
                    "Return strict JSON only with keys: target_stage_index, delta_ops, target_graph_ir, notes."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "sample_id": sample.sample_id,
                        "diagram_type": sample.diagram_type,
                        "current_stage_index": state.current_stage_index,
                        "next_stage_index_hint": next_stage_index,
                        "recent_turns": _recent_turns(observed_turns, self.recent_turn_limit),
                        "current_state": state.metadata.get("graph_metrics", {}),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            },
        ]
        result = self.client.chat(messages)
        payload = _parse_json_object(result.text)
        target_graph_payload = payload.get("target_graph_ir") or payload.get("graph_ir")
        target_graph_ir = None
        if isinstance(target_graph_payload, dict):
            target_graph_ir = _graph_ir_from_payload(target_graph_payload)
        return PlannerOutput(
            target_stage_index=int(payload.get("target_stage_index", next_stage_index) or next_stage_index),
            delta_ops=list(payload.get("delta_ops", [])),
            target_graph_ir=target_graph_ir,
            notes=str(payload.get("notes", "")),
            metadata={
                "model_name": self.client.model,
                "latency_ms": result.latency_ms,
                "usage": result.usage,
            },
        )
