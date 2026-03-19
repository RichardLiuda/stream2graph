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


def _extract_first_balanced_json_object(text: str) -> str:
    in_string = False
    escape = False
    depth = 0
    start = -1
    for index, ch in enumerate(text):
        if start < 0:
            if ch == "{":
                start = index
                depth = 1
            continue
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return ""


def _parse_json_object(text: str) -> dict[str, Any]:
    raw = strip_code_fences(text or "").lstrip("\ufeff").strip()
    if not raw.strip():
        raise ValueError("empty model output")
    decoder = json.JSONDecoder()
    candidates: list[str] = [raw]
    first_brace = raw.find("{")
    if first_brace >= 0:
        candidates.append(raw[first_brace:])
    balanced = _extract_first_balanced_json_object(raw)
    if balanced:
        candidates.append(balanced)

    last_error: Exception | None = None
    seen: set[str] = set()
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            payload, _ = decoder.raw_decode(candidate)
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        if isinstance(payload, dict):
            return payload
        last_error = ValueError("model output is not a JSON object")
    raise ValueError(str(last_error) if last_error else "unable to parse model JSON object")


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

    def __init__(self, client: OpenAICompatibleChatClient, recent_turn_limit: int = 24) -> None:
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
        current_graph_payload = (
            state.current_graph_ir.to_payload()
            if state.current_graph_ir is not None
            else {
                "graph_id": sample.sample_id,
                "diagram_type": sample.diagram_type,
                "nodes": [],
                "edges": [],
                "groups": [],
                "styles": [],
                "metadata": {},
            }
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the large planner model for an incremental diagram system. "
                    "Your job is to extend the current graph by one monotonic stage based only on the observed dialogue. "
                    "Return one JSON object only. No markdown. No explanations. No prose before or after JSON. "
                    "Prefer a compact incremental answer: produce accurate delta_ops first. "
                    "Never remove or rename existing nodes, edges, or groups. Never switch to an unrelated domain. "
                    "Use these operation names only: add_group, add_node, add_edge. "
                    "Required top-level keys: target_stage_index, delta_ops, notes. "
                    "Optional top-level key: target_graph_ir. "
                    "If target_graph_ir is provided, it must be the full next graph state and must include all previously existing items plus the new additions. "
                    "If you are not fully confident about a complete next graph snapshot, omit target_graph_ir and return delta_ops only."
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
                        "total_stages_hint": sample.total_stages,
                        "observed_turns": _recent_turns(observed_turns, self.recent_turn_limit),
                        "current_graph_ir": current_graph_payload,
                        "current_state_metrics": state.metadata.get("graph_metrics", {}),
                        "output_contract": {
                            "target_stage_index": "integer",
                            "delta_ops": [
                                {
                                    "op": "add_group|add_node|add_edge",
                                    "group_id": "for add_group",
                                    "node_id": "for add_node",
                                    "edge_id": "for add_edge",
                                    "label": "string",
                                    "kind": "string",
                                    "source": "for add_edge",
                                    "target": "for add_edge",
                                    "parent": "optional parent group id",
                                }
                            ],
                            "notes": "short string",
                            "target_graph_ir": "optional full graph object",
                        },
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
        if isinstance(target_graph_payload, dict) and target_graph_payload:
            target_graph_ir = _graph_ir_from_payload(target_graph_payload)
        return PlannerOutput(
            target_stage_index=int(
                payload.get("target_stage_index", payload.get("stage_index", next_stage_index)) or next_stage_index
            ),
            delta_ops=list(payload.get("delta_ops", [])),
            target_graph_ir=target_graph_ir,
            notes=str(payload.get("notes", "")),
            metadata={
                "model_name": self.client.model,
                "latency_ms": result.latency_ms,
                "usage": result.usage,
                "raw_text_preview": (result.text or "")[:400],
            },
        )
