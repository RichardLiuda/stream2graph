from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Any

from tools.eval.common import normalize_whitespace, strip_code_fences, strip_think_traces
from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode
from tools.incremental_system.chat_clients import ChatCompletionClient
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
    raw = strip_code_fences(strip_think_traces(text or "")).lstrip("\ufeff").strip()
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


def _looks_like_graph_payload(value: Any) -> bool:
    return isinstance(value, dict) and any(
        key in value for key in ("nodes", "edges", "groups", "graph_id", "diagram_type")
    )


def _extract_graph_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("target_graph_ir", "graph_ir", "target_graph", "next_graph", "graph", "state"):
        candidate = payload.get(key)
        if _looks_like_graph_payload(candidate):
            return candidate
    if _looks_like_graph_payload(payload):
        return payload
    return None


def _coerce_delta_ops(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("delta_ops", "ops", "operations", "delta", "actions"):
        candidate = payload.get(key)
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
        if isinstance(candidate, dict):
            if "ops" in candidate and isinstance(candidate["ops"], list):
                return [item for item in candidate["ops"] if isinstance(item, dict)]
            if candidate.get("op") or candidate.get("type"):
                return [candidate]
    return []


def _has_delta_ops_field(payload: dict[str, Any]) -> bool:
    return any(key in payload for key in ("delta_ops", "ops", "operations", "delta", "actions"))


def _repair_prompt(error: Exception) -> str:
    return (
        "Your previous response was invalid for the incremental planner. "
        f"Validation error: {error}. "
        "Return one repaired JSON object only. "
        "Prefer delta_ops-only output if you are unsure about a full graph snapshot. "
        "Do not include markdown, explanations, or extra text."
    )


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


def _normalize_identifier(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _extract_identifier_candidates(turns: list[DialogueTurn], limit: int = 24) -> dict[str, str]:
    candidates: dict[str, str] = {}
    pattern = re.compile(r"[A-Za-z][A-Za-z0-9_]{1,39}")
    for turn in turns[-limit:]:
        content = turn.content or ""
        for token in pattern.findall(content):
            normalized = _normalize_identifier(token)
            if not normalized or normalized in candidates:
                continue
            candidates[normalized] = token
    return candidates


def _diagram_type_alignment_priors(diagram_type: str) -> dict[str, Any]:
    diagram_type = (diagram_type or "").lower()
    if diagram_type in {"mindmap", "statediagram", "er"}:
        return {"allow_edges": False, "allow_groups": False}
    if diagram_type == "sequence":
        return {"allow_edges": False, "allow_groups": False}
    if diagram_type == "flowchart":
        return {"allow_edges": False, "allow_groups": True}
    if diagram_type == "architecture":
        return {"allow_edges": False, "allow_groups": True}
    return {"allow_edges": True, "allow_groups": True}


def _generic_id_base(identifier: str) -> str | None:
    text = (identifier or "").strip()
    if not text:
        return None
    lowered = text.lower()
    for prefix in ("node_", "group_", "edge_", "participant_", "n_", "g_", "e_"):
        if lowered.startswith(prefix) and len(text) > len(prefix):
            return text[len(prefix) :]
    if re.fullmatch(r"(node|group|edge)_[0-9]+", lowered):
        return None
    return None


def _candidate_from_label(label: str, candidates: dict[str, str]) -> str | None:
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_]{1,39}", label or ""):
        normalized = _normalize_identifier(token)
        if normalized in candidates:
            return candidates[normalized]
    normalized_label = _normalize_identifier(label or "")
    if normalized_label in candidates:
        return candidates[normalized_label]
    return None


def _align_identifier(
    identifier: str,
    label: str,
    candidates: dict[str, str],
) -> str:
    text = (identifier or "").strip()
    if not text:
        return text

    generic_base = _generic_id_base(text)
    if generic_base:
        normalized_base = _normalize_identifier(generic_base)
        label_candidate = _candidate_from_label(label, candidates)
        if label_candidate and _normalize_identifier(label_candidate) != normalized_base:
            return label_candidate
        if normalized_base:
            candidate = candidates.get(normalized_base)
            if candidate and "_" in generic_base:
                return candidate
            return generic_base

    normalized_id = _normalize_identifier(text)
    candidate = candidates.get(normalized_id)
    if candidate and candidate != text:
        return candidate

    label_candidate = _candidate_from_label(label, candidates)
    if label_candidate and re.fullmatch(r"(node|group|edge)_[0-9]+", text.lower()):
        return label_candidate

    return text


def _build_recent_dialogue_snapshot(turns: list[DialogueTurn], limit: int = 8) -> str:
    rows: list[str] = []
    for turn in turns[-limit:]:
        content = normalize_whitespace(turn.content)
        if not content:
            continue
        rows.append(content)
    return "\n".join(rows)


def _canonicalize_identifier_for_diagram(
    sample: RuntimeSample,
    *,
    item_type: str,
    identifier: str,
    label: str,
    kind: str = "",
) -> str:
    text = (identifier or "").strip()
    if not text:
        return text
    diagram_type = (sample.diagram_type or "").lower()
    if diagram_type == "mindmap" and item_type == "node" and (kind or "").lower() == "root":
        return "root"
    return text


def _substantive_turns_for_stage(
    observed_turns: list[DialogueTurn],
    stage_index: int,
) -> list[DialogueTurn]:
    turns: list[DialogueTurn] = []
    for turn in observed_turns:
        if not _has_substantive_turn_content(turn):
            continue
        if turn.stage_index is None or int(turn.stage_index) == int(stage_index):
            turns.append(turn)
    return turns


def _should_delay_emit_update(
    sample: RuntimeSample,
    state: SessionState,
    observed_turns: list[DialogueTurn],
    action: str,
) -> bool:
    if action != "EMIT_UPDATE":
        return False
    next_stage_index = state.current_stage_index + 1
    if next_stage_index > sample.total_stages:
        return False

    stage_turns = _substantive_turns_for_stage(observed_turns, next_stage_index)
    identifier_count = len(_extract_identifier_candidates(stage_turns))
    later_stage_turns = [
        turn
        for turn in observed_turns
        if _has_substantive_turn_content(turn)
        and turn.stage_index is not None
        and int(turn.stage_index) > next_stage_index
    ]

    # If later-stage evidence is already visible, do not keep blocking the
    # missing next-stage emission forever. Emit the next stage and let runtime
    # advance monotonically.
    if later_stage_turns:
        return False

    if sample.total_stages == 1:
        return False

    if next_stage_index == 1:
        return len(stage_turns) < 2 and identifier_count < 2

    return False


def _refine_delta_ops(
    sample: RuntimeSample,
    observed_turns: list[DialogueTurn],
    state: SessionState,
    delta_ops: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    priors = _diagram_type_alignment_priors(sample.diagram_type)
    candidates = _extract_identifier_candidates(observed_turns)
    existing_ids = {
        *(node.id for node in (state.current_graph_ir.nodes if state.current_graph_ir else [])),
        *(group.id for group in (state.current_graph_ir.groups if state.current_graph_ir else [])),
        *(edge.id for edge in (state.current_graph_ir.edges if state.current_graph_ir else [])),
    }
    renamed: dict[str, str] = {}
    refined: list[dict[str, Any]] = []

    for op in delta_ops:
        if not isinstance(op, dict):
            continue
        op_name = str(op.get("op") or op.get("type") or "").strip().lower()
        current = dict(op)
        if op_name == "add_group":
            if not priors["allow_groups"]:
                continue
            raw_id = str(current.get("group_id") or current.get("id") or "").strip()
            aligned_id = _align_identifier(raw_id, str(current.get("label", "")), candidates)
            aligned_id = _canonicalize_identifier_for_diagram(
                sample,
                item_type="group",
                identifier=aligned_id,
                label=str(current.get("label", "")),
            )
            if aligned_id and aligned_id not in existing_ids:
                renamed[raw_id] = aligned_id
                existing_ids.add(aligned_id)
                current["group_id"] = aligned_id
                current["id"] = aligned_id
            refined.append(current)
        elif op_name == "add_node":
            raw_id = str(current.get("node_id") or current.get("id") or "").strip()
            aligned_id = _align_identifier(raw_id, str(current.get("label", "")), candidates)
            aligned_id = _canonicalize_identifier_for_diagram(
                sample,
                item_type="node",
                identifier=aligned_id,
                label=str(current.get("label", "")),
                kind=str(current.get("kind") or current.get("node_type") or ""),
            )
            if aligned_id and aligned_id not in existing_ids:
                renamed[raw_id] = aligned_id
                existing_ids.add(aligned_id)
                current["node_id"] = aligned_id
                current["id"] = aligned_id
            parent = current.get("parent")
            if isinstance(parent, str) and parent in renamed:
                current["parent"] = renamed[parent]
            refined.append(current)
        elif op_name == "add_edge":
            if not priors["allow_edges"]:
                continue
            current["source"] = renamed.get(str(current.get("source", "")), str(current.get("source", "")))
            current["target"] = renamed.get(str(current.get("target", "")), str(current.get("target", "")))
            raw_id = str(current.get("edge_id") or current.get("id") or "").strip()
            aligned_id = _align_identifier(raw_id, str(current.get("label", "")), candidates)
            if aligned_id and aligned_id not in existing_ids:
                current["edge_id"] = aligned_id
                current["id"] = aligned_id
                existing_ids.add(aligned_id)
            refined.append(current)
        else:
            refined.append(current)
    return refined


def _refine_graph_ir(
    sample: RuntimeSample,
    observed_turns: list[DialogueTurn],
    graph_ir: GraphIR,
) -> GraphIR:
    priors = _diagram_type_alignment_priors(sample.diagram_type)
    candidates = _extract_identifier_candidates(observed_turns)
    node_renames: dict[str, str] = {}
    group_renames: dict[str, str] = {}
    used_ids: set[str] = set()

    refined_nodes: list[GraphNode] = []
    for node in graph_ir.nodes:
        aligned_id = _align_identifier(node.id, node.label, candidates)
        aligned_id = _canonicalize_identifier_for_diagram(
            sample,
            item_type="node",
            identifier=aligned_id,
            label=node.label,
            kind=node.kind,
        )
        if not aligned_id or aligned_id in used_ids:
            aligned_id = node.id
        used_ids.add(aligned_id)
        node_renames[node.id] = aligned_id
        refined_nodes.append(
            GraphNode(
                id=aligned_id,
                label=node.label,
                kind=node.kind,
                parent=node.parent,
                source_index=node.source_index,
                metadata=dict(node.metadata),
            )
        )

    refined_groups: list[GraphGroup] = []
    if priors["allow_groups"]:
        for group in graph_ir.groups:
            aligned_id = _align_identifier(group.id, group.label, candidates)
            aligned_id = _canonicalize_identifier_for_diagram(
                sample,
                item_type="group",
                identifier=aligned_id,
                label=group.label,
            )
            if not aligned_id or aligned_id in used_ids:
                aligned_id = group.id
            used_ids.add(aligned_id)
            group_renames[group.id] = aligned_id
            refined_groups.append(
                GraphGroup(
                    id=aligned_id,
                    label=group.label,
                    parent=group.parent,
                    member_ids=list(group.member_ids),
                    source_index=group.source_index,
                    metadata=dict(group.metadata),
                )
            )

    for node in refined_nodes:
        if isinstance(node.parent, str) and node.parent in group_renames:
            node.parent = group_renames[node.parent]
    for group in refined_groups:
        if isinstance(group.parent, str) and group.parent in group_renames:
            group.parent = group_renames[group.parent]
        group.member_ids = [
            group_renames.get(member, node_renames.get(member, member))
            for member in group.member_ids
        ]

    refined_edges: list[GraphEdge] = []
    if priors["allow_edges"]:
        for edge in graph_ir.edges:
            aligned_id = _align_identifier(edge.id, edge.label, candidates)
            aligned_id = _canonicalize_identifier_for_diagram(
                sample,
                item_type="edge",
                identifier=aligned_id,
                label=edge.label,
            )
            if not aligned_id or aligned_id in used_ids:
                aligned_id = edge.id
            used_ids.add(aligned_id)
            refined_edges.append(
                GraphEdge(
                    id=aligned_id,
                    source=node_renames.get(edge.source, group_renames.get(edge.source, edge.source)),
                    target=node_renames.get(edge.target, group_renames.get(edge.target, edge.target)),
                    label=edge.label,
                    kind=edge.kind,
                    source_index=edge.source_index,
                    metadata=dict(edge.metadata),
                )
            )

    return GraphIR(
        graph_id=graph_ir.graph_id,
        diagram_type=graph_ir.diagram_type,
        nodes=refined_nodes,
        edges=refined_edges,
        groups=refined_groups,
        styles=list(graph_ir.styles),
        metadata=dict(graph_ir.metadata),
    )


def _has_substantive_turn_content(turn: DialogueTurn) -> bool:
    content = normalize_whitespace(turn.content)
    if not content:
        return False
    if turn.stage_index is not None:
        return True
    if re.search(r"[A-Za-z_][A-Za-z0-9_]{1,}", content):
        return True
    return len(content) >= 12


def _should_force_emit_update(
    sample: RuntimeSample,
    state: SessionState,
    observed_turns: list[DialogueTurn],
    action: str,
) -> bool:
    if action != "WAIT":
        return False
    next_stage_index = state.current_stage_index + 1
    if next_stage_index > sample.total_stages:
        return False
    recent_turns = observed_turns[-6:]
    substantive_turns = [turn for turn in recent_turns if _has_substantive_turn_content(turn)]
    if not substantive_turns:
        return False
    labeled_for_next = [
        turn
        for turn in substantive_turns
        if turn.stage_index is not None and int(turn.stage_index) >= next_stage_index
    ]
    if sample.total_stages == 1:
        return bool(labeled_for_next)
    return bool(labeled_for_next) and len(substantive_turns) >= 2


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


GATE_SYSTEM_PROMPT = (
    "You are the small gate model for an incremental diagram system. "
    "Decide whether the system should WAIT or EMIT_UPDATE. "
    "Judge dialogue sufficiency, not whether the current graph already contains the new items. "
    "An empty or lagging current graph is normal before an update is emitted. "
    "If recent turns introduce concrete nodes, groups, actors, components, or other buildable structure for the next stage, prefer EMIT_UPDATE. "
    "If recent turns request concrete Mermaid styling, highlighting, or regrouping for existing structure, also prefer EMIT_UPDATE. "
    "Always target exactly the immediate next stage. Never skip stage numbers. "
    "Do not emit too early for bootstrap-heavy stages: when the same stage is still actively introducing concrete identifiers, prefer WAIT until the stage has at least a couple of substantive turns. "
    "Use WAIT only when the dialogue is still generic, meta, or missing buildable structure. "
    "Return strict JSON only with keys: action, target_stage_index, reason, confidence."
)


PLANNER_SYSTEM_PROMPT = (
    "You are the large planner model for an incremental diagram system. "
    "Your job is to extend the current graph by one monotonic stage based only on the observed dialogue. "
    "Return one JSON object only. No markdown. No explanations. No prose before or after JSON. "
    "Prefer a compact incremental answer: produce accurate delta_ops first. "
    "Never remove or rename existing nodes, edges, or groups. Never switch to an unrelated domain. "
    "Always plan exactly the immediate next stage. Never skip stage numbers. "
    "Reuse literal identifiers from the dialogue whenever possible. "
    "If the dialogue mentions names like U1, DB, AppShell, UserInput, Try, PageLayout, reuse those exact identifiers instead of inventing node_1/group_1/node_webui-style aliases. "
    "For mindmaps, keep the visible root label from the dialogue but use the canonical root node id 'root'. "
    "Use these operation names only: add_group, add_node, add_edge. "
    "Required top-level keys: target_stage_index, delta_ops, notes. "
    "Optional top-level key: target_graph_ir. "
    "Structural priors for this benchmark matter: edges are rare; do not invent edges unless the dialogue explicitly requires a concrete connection. "
    "For sequence, mindmap, ER, and state diagrams, prefer node-only outputs. "
    "For architecture, prefer groups plus nodes and avoid speculative edges. "
    "For flowcharts, prefer nodes and only essential groups; avoid speculative edges. "
    "Whenever the dialogue implies visual grouping, emphasis, warning states, decision nodes, or branch hierarchy, include Mermaid style directives in target_graph_ir.styles as raw lines such as classDef, class, style, or linkStyle. "
    "Prefer Mermaid-compatible attributes such as fill, stroke, color, stroke-width, font-size, font-style, font-weight, and text-decoration, and keep the style list compact. "
    "If target_graph_ir is provided, it must be the full next graph state and must include all previously existing items plus the new additions. "
    "If you are not fully confident about a complete next graph snapshot, omit target_graph_ir and return delta_ops only."
)


class LLMGateModel(GateModel):
    name = "llm_gate"

    def __init__(
        self,
        client: ChatCompletionClient,
        recent_turn_limit: int = 8,
        semantic_retry_attempts: int = 1,
    ) -> None:
        self.client = client
        self.recent_turn_limit = recent_turn_limit
        self.semantic_retry_attempts = semantic_retry_attempts

    def decide(
        self,
        sample: RuntimeSample,
        state: SessionState,
        observed_turns: list[DialogueTurn],
    ) -> GateDecision:
        messages = [
            {
                "role": "system",
                "content": GATE_SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "sample_id": sample.sample_id,
                        "diagram_type": sample.diagram_type,
                        "total_stages": sample.total_stages,
                        "current_stage_index": state.current_stage_index,
                        "next_stage_index_hint": min(state.current_stage_index + 1, sample.total_stages),
                        "recent_turns": _recent_turns(observed_turns, self.recent_turn_limit),
                        "current_state": state.metadata.get("graph_metrics", {}),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            },
        ]
        last_error: Exception | None = None
        for attempt in range(self.semantic_retry_attempts + 1):
            result = self.client.chat(messages)
            try:
                payload = _parse_json_object(result.text)
                target_stage_index = payload.get("target_stage_index")
                normalized_target = (
                    int(target_stage_index) if target_stage_index not in {None, ""} else None
                )
                if normalized_target is not None:
                    normalized_target = max(1, min(normalized_target, sample.total_stages))
                action = str(payload.get("action", "WAIT")).upper()
                if action not in {"WAIT", "EMIT_UPDATE"}:
                    raise ValueError(f"invalid gate action: {action}")
                fallback_forced = _should_force_emit_update(sample, state, observed_turns, action)
                if fallback_forced:
                    action = "EMIT_UPDATE"
                if action == "EMIT_UPDATE":
                    normalized_target = state.current_stage_index + 1
                if _should_delay_emit_update(sample, state, observed_turns, action):
                    action = "WAIT"
                    normalized_target = state.current_stage_index + 1
                return GateDecision(
                    action=action,
                    target_stage_index=normalized_target,
                    reason=str(payload.get("reason", "")),
                    confidence=float(payload["confidence"]) if payload.get("confidence") is not None else None,
                    metadata={
                        "model_name": self.client.model,
                        "latency_ms": result.latency_ms,
                        "usage": result.usage,
                        "raw_text_preview": (result.text or "")[:400],
                        "semantic_attempt": attempt + 1,
                        "fallback_forced_emit": fallback_forced,
                    },
                )
            except Exception as exc:
                last_error = exc
                if attempt >= self.semantic_retry_attempts:
                    raise
        raise RuntimeError(str(last_error) if last_error else "gate model failed without an explicit error")


class LLMPlannerModel(PlannerModel):
    name = "llm_planner"

    def __init__(
        self,
        client: ChatCompletionClient,
        recent_turn_limit: int = 24,
        semantic_retry_attempts: int = 1,
    ) -> None:
        self.client = client
        self.recent_turn_limit = recent_turn_limit
        self.semantic_retry_attempts = semantic_retry_attempts

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
                "content": PLANNER_SYSTEM_PROMPT,
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
                        "identifier_candidates": list(_extract_identifier_candidates(observed_turns).values())[:24],
                        "recent_dialogue_snapshot": _build_recent_dialogue_snapshot(observed_turns),
                        "diagram_type_priors": _diagram_type_alignment_priors(sample.diagram_type),
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
                            "target_graph_ir": "optional full graph object, including Mermaid style directives in styles when available",
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            },
        ]
        current_messages = list(messages)
        last_error: Exception | None = None
        last_raw_text = ""
        for attempt in range(self.semantic_retry_attempts + 1):
            result = self.client.chat(current_messages)
            try:
                last_raw_text = result.text or ""
                payload = _parse_json_object(result.text)
                target_graph_payload = _extract_graph_payload(payload)
                target_graph_ir = None
                if isinstance(target_graph_payload, dict) and target_graph_payload:
                    target_graph_ir = _graph_ir_from_payload(target_graph_payload)
                    target_graph_ir = _refine_graph_ir(sample, observed_turns, target_graph_ir)
                delta_ops = _refine_delta_ops(sample, observed_turns, state, _coerce_delta_ops(payload))
                if not delta_ops and target_graph_ir is None and _has_delta_ops_field(payload):
                    target_graph_ir = _graph_ir_from_payload(current_graph_payload)
                if not delta_ops and target_graph_ir is None:
                    raise ValueError("planner returned neither delta_ops nor target_graph_ir")
                target_stage_index = next_stage_index
                return PlannerOutput(
                    target_stage_index=target_stage_index,
                    delta_ops=delta_ops,
                    target_graph_ir=target_graph_ir,
                    notes=str(payload.get("notes", "")),
                    metadata={
                        "model_name": self.client.model,
                        "latency_ms": result.latency_ms,
                        "usage": result.usage,
                        "raw_text_preview": (result.text or "")[:400],
                        "semantic_attempt": attempt + 1,
                        "planner_noop": (not delta_ops and target_graph_ir is not None),
                    },
                )
            except Exception as exc:
                last_error = exc
                if attempt >= self.semantic_retry_attempts:
                    preview = strip_think_traces(last_raw_text).strip().replace("\n", " ")[:300]
                    raise ValueError(f"{exc}; raw_preview={preview}") from exc
                current_messages = [
                    *messages,
                    {
                        "role": "assistant",
                        "content": strip_think_traces(result.text or "")[:4000],
                    },
                    {
                        "role": "user",
                        "content": _repair_prompt(exc),
                    },
                ]
        raise RuntimeError(str(last_error) if last_error else "planner model failed without an explicit error")
