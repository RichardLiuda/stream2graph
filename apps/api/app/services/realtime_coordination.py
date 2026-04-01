from __future__ import annotations

import json
import logging
import os
import ssl
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from types import SimpleNamespace
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.legacy import IncrementalGraphRenderer
from app.models import RealtimeSession
from app.services.runtime_options import resolve_profile
from incremental_renderer import NodeState
from tools.eval.common import strip_think_traces
from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode
from tools.incremental_dataset.staging import render_preview_mermaid
from tools.incremental_system.chat_clients import LocalHFChatClient, OpenAICompatibleChatClient
from tools.incremental_system.loader import _graph_ir_from_payload
from tools.incremental_system.models import (
    _build_recent_dialogue_snapshot,
    _coerce_delta_ops,
    _diagram_type_alignment_priors,
    _extract_graph_payload,
    _extract_identifier_candidates,
    _has_delta_ops_field,
    _parse_json_object,
    _refine_delta_ops,
    _refine_graph_ir,
    _repair_prompt,
)
from tools.incremental_system.schema import DialogueTurn


logger = logging.getLogger(__name__)


def _log_coordination_event(message: str, payload: dict[str, Any]) -> None:
    logger.info("%s %s", message, json.dumps(payload, ensure_ascii=False))


def _stats(values: list[float]) -> dict[str, float]:
    if not values:
        return {"count": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0}
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        p50 = ordered[mid]
    else:
        p50 = (ordered[mid - 1] + ordered[mid]) / 2.0
    p95_index = int(round((len(ordered) - 1) * 0.95))
    return {
        "count": float(len(values)),
        "mean": round(float(sum(values) / len(values)), 4),
        "p50": round(float(p50), 4),
        "p95": round(float(ordered[p95_index]), 4),
        "max": round(float(max(values)), 4),
    }


def _dialogue_payload(turn: DialogueTurn) -> dict[str, Any]:
    return {
        "turn_id": turn.turn_id,
        "speaker": turn.speaker,
        "content": turn.content,
        "timestamp_ms": int(turn.metadata.get("timestamp_ms", 0) or 0),
        "is_final": bool(turn.metadata.get("is_final", True)),
    }


def _graph_metrics(graph_ir: GraphIR) -> dict[str, Any]:
    return {
        "node_count": len(graph_ir.nodes),
        "edge_count": len(graph_ir.edges),
        "group_count": len(graph_ir.groups),
        "node_ids": [node.id for node in graph_ir.nodes[:12]],
        "edge_ids": [edge.id for edge in graph_ir.edges[:12]],
        "group_ids": [group.id for group in graph_ir.groups[:12]],
    }


def _graph_payload_signature(graph_ir: GraphIR) -> str:
    return json.dumps(graph_ir.to_payload(), ensure_ascii=False, sort_keys=True)


def _clone_graph_ir(graph_ir: GraphIR) -> GraphIR:
    return GraphIR(
        graph_id=graph_ir.graph_id,
        diagram_type=graph_ir.diagram_type,
        nodes=[
            GraphNode(
                id=node.id,
                label=node.label,
                kind=node.kind,
                parent=node.parent,
                source_index=node.source_index,
                metadata=dict(node.metadata),
            )
            for node in graph_ir.nodes
        ],
        edges=[
            GraphEdge(
                id=edge.id,
                source=edge.source,
                target=edge.target,
                label=edge.label,
                kind=edge.kind,
                source_index=edge.source_index,
                metadata=dict(edge.metadata),
            )
            for edge in graph_ir.edges
        ],
        groups=[
            GraphGroup(
                id=group.id,
                label=group.label,
                parent=group.parent,
                member_ids=list(group.member_ids),
                source_index=group.source_index,
                metadata=dict(group.metadata),
            )
            for group in graph_ir.groups
        ],
        styles=list(graph_ir.styles),
        metadata=dict(graph_ir.metadata),
    )


def build_empty_graph(graph_id: str, diagram_type: str = "flowchart") -> GraphIR:
    return GraphIR(graph_id=graph_id, diagram_type=diagram_type or "flowchart")


def _coerce_gate_action(raw_action: object) -> str:
    value = str(raw_action or "").strip().upper()
    if value in {"WAIT", "EMIT_UPDATE"}:
        return value
    compact = value.replace("-", "_").replace(" ", "_")
    if any(token in compact for token in ("EMIT", "UPDATE", "ACKNOWLEDGE", "ADD", "PROCEED", "CONTINUE")):
        return "EMIT_UPDATE"
    if any(token in compact for token in ("WAIT", "HOLD", "DEFER", "NOOP", "NO_UPDATE", "SKIP")):
        return "WAIT"
    raise ValueError(f"invalid gate action: {raw_action}")


def normalize_runtime_options(raw_options: dict[str, Any] | None) -> dict[str, Any]:
    options = dict(raw_options) if isinstance(raw_options, dict) else {}
    llm_profile_id = str(options.get("llm_profile_id") or "").strip()
    llm_model = str(options.get("llm_model") or "").strip()

    if llm_profile_id and not str(options.get("gate_profile_id") or "").strip():
        options["gate_profile_id"] = llm_profile_id
    if llm_model and not str(options.get("gate_model") or "").strip():
        options["gate_model"] = llm_model
    if llm_profile_id and not str(options.get("planner_profile_id") or "").strip():
        options["planner_profile_id"] = llm_profile_id
    if llm_model and not str(options.get("planner_model") or "").strip():
        options["planner_model"] = llm_model
    if not str(options.get("diagram_type") or "").strip():
        options["diagram_type"] = "flowchart"
    return options


def _sanitize_graph_ir(base: GraphIR, candidate: GraphIR) -> GraphIR:
    if candidate.diagram_type and candidate.diagram_type != base.diagram_type:
        candidate.diagram_type = base.diagram_type

    base_entity_ids = {
        *(node.id for node in base.nodes),
        *(edge.id for edge in base.edges),
        *(group.id for group in base.groups),
    }
    candidate_entity_ids = {
        *(node.id for node in candidate.nodes),
        *(edge.id for edge in candidate.edges),
        *(group.id for group in candidate.groups),
    }
    if base_entity_ids and not base_entity_ids.issubset(candidate_entity_ids):
        return _clone_graph_ir(base)

    node_ids: set[str] = set()
    clean_nodes: list[GraphNode] = []
    for node in candidate.nodes:
        if not node.id or node.id in node_ids:
            continue
        node_ids.add(node.id)
        clean_nodes.append(
            GraphNode(
                id=node.id,
                label=node.label or node.id,
                kind=node.kind or "node",
                parent=node.parent,
                source_index=node.source_index,
                metadata=dict(node.metadata),
            )
        )

    group_ids: set[str] = set()
    clean_groups: list[GraphGroup] = []
    allowed_members = set(node_ids)
    for group in candidate.groups:
        if not group.id or group.id in group_ids:
            continue
        group_ids.add(group.id)
        clean_groups.append(
            GraphGroup(
                id=group.id,
                label=group.label or group.id,
                parent=group.parent,
                member_ids=list(dict.fromkeys([item for item in group.member_ids if item in allowed_members])),
                source_index=group.source_index,
                metadata=dict(group.metadata),
            )
        )

    for node in clean_nodes:
        if node.parent and node.parent not in group_ids:
            node.parent = None
    for group in clean_groups:
        if group.parent and group.parent not in group_ids:
            group.parent = None

    edge_ids: set[str] = set()
    clean_edges: list[GraphEdge] = []
    for edge in candidate.edges:
        if (
            not edge.id
            or edge.id in edge_ids
            or edge.source not in node_ids
            or edge.target not in node_ids
        ):
            continue
        edge_ids.add(edge.id)
        clean_edges.append(
            GraphEdge(
                id=edge.id,
                source=edge.source,
                target=edge.target,
                label=edge.label,
                kind=edge.kind or "edge",
                source_index=edge.source_index,
                metadata=dict(edge.metadata),
            )
        )

    sanitized = GraphIR(
        graph_id=base.graph_id,
        diagram_type=base.diagram_type,
        nodes=clean_nodes,
        edges=clean_edges,
        groups=clean_groups,
        styles=list(candidate.styles),
        metadata=dict(candidate.metadata),
    )
    if len(clean_nodes) + len(clean_edges) + len(clean_groups) < len(base.nodes) + len(base.edges) + len(base.groups):
        return _clone_graph_ir(base)
    return sanitized


def _merge_structural_metadata_from_snapshot(base: GraphIR, snapshot: GraphIR) -> GraphIR:
    merged = _clone_graph_ir(base)
    snapshot_nodes = {node.id: node for node in snapshot.nodes}
    snapshot_groups = {group.id: group for group in snapshot.groups}

    for node in merged.nodes:
        source = snapshot_nodes.get(node.id)
        if source is None:
            continue
        node.parent = source.parent
        if source.label:
            node.label = source.label
        if source.kind:
            node.kind = source.kind
        if source.metadata:
            node.metadata = dict(source.metadata)

    for group in merged.groups:
        source = snapshot_groups.get(group.id)
        if source is None:
            continue
        group.parent = source.parent
        group.member_ids = list(source.member_ids)
        if source.label:
            group.label = source.label
        if source.metadata:
            group.metadata = dict(source.metadata)

    if snapshot.styles:
        merged.styles = list(snapshot.styles)
    if snapshot.metadata:
        merged.metadata = dict(snapshot.metadata)
    return _sanitize_graph_ir(base, merged)


def _apply_delta_ops(base: GraphIR, delta_ops: list[dict[str, Any]]) -> GraphIR:
    graph = _clone_graph_ir(base)
    node_ids = {node.id for node in graph.nodes}
    edge_ids = {edge.id for edge in graph.edges}
    group_ids = {group.id for group in graph.groups}
    next_node_index = max((node.source_index for node in graph.nodes), default=0) + 1
    next_edge_index = max((edge.source_index for edge in graph.edges), default=0) + 1
    next_group_index = max((group.source_index for group in graph.groups), default=0) + 1

    for index, op in enumerate(delta_ops, start=1):
        op_name = str(op.get("op") or op.get("type") or "").strip().lower()
        if op_name == "add_group":
            group_id = str(op.get("group_id") or op.get("id") or "").strip()
            if not group_id or group_id in group_ids:
                continue
            group_ids.add(group_id)
            graph.groups.append(
                GraphGroup(
                    id=group_id,
                    label=str(op.get("label") or group_id),
                    parent=str(op.get("parent") or "").strip() or None,
                    member_ids=[str(item).strip() for item in op.get("member_ids", []) if str(item).strip()],
                    source_index=next_group_index + index,
                    metadata={},
                )
            )
            continue

        if op_name == "add_node":
            node_id = str(op.get("node_id") or op.get("id") or "").strip()
            if not node_id or node_id in node_ids:
                continue
            node_ids.add(node_id)
            graph.nodes.append(
                GraphNode(
                    id=node_id,
                    label=str(op.get("label") or node_id),
                    kind=str(op.get("kind") or op.get("node_type") or "node"),
                    parent=str(op.get("parent") or "").strip() or None,
                    source_index=next_node_index + index,
                    metadata={},
                )
            )
            continue

        if op_name == "add_edge":
            edge_id = str(op.get("edge_id") or op.get("id") or "").strip()
            source = str(op.get("source") or "").strip()
            target = str(op.get("target") or "").strip()
            if not edge_id or edge_id in edge_ids or source not in node_ids or target not in node_ids:
                continue
            edge_ids.add(edge_id)
            graph.edges.append(
                GraphEdge(
                    id=edge_id,
                    source=source,
                    target=target,
                    label=str(op.get("label") or ""),
                    kind=str(op.get("kind") or "edge"),
                    source_index=next_edge_index + index,
                    metadata={},
                )
            )

    return _sanitize_graph_ir(base, graph)


def _graph_delta(base: GraphIR, target: GraphIR) -> list[dict[str, Any]]:
    base_groups = {group.id for group in base.groups}
    base_nodes = {node.id for node in base.nodes}
    base_edges = {edge.id for edge in base.edges}
    delta_ops: list[dict[str, Any]] = []

    for group in target.groups:
        if group.id in base_groups:
            continue
        delta_ops.append(
            {
                "op": "add_group",
                "group_id": group.id,
                "id": group.id,
                "label": group.label,
                "parent": group.parent,
                "member_ids": list(group.member_ids),
            }
        )
    for node in target.nodes:
        if node.id in base_nodes:
            continue
        delta_ops.append(
            {
                "op": "add_node",
                "node_id": node.id,
                "id": node.id,
                "label": node.label,
                "kind": node.kind,
                "parent": node.parent,
            }
        )
    for edge in target.edges:
        if edge.id in base_edges:
            continue
        delta_ops.append(
            {
                "op": "add_edge",
                "edge_id": edge.id,
                "id": edge.id,
                "source": edge.source,
                "target": edge.target,
                "label": edge.label,
                "kind": edge.kind,
            }
        )
    return delta_ops


def _renderer_operations(delta_ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ops: list[dict[str, Any]] = []
    for op in delta_ops:
        op_name = str(op.get("op") or "").strip().lower()
        if op_name == "add_group":
            group_id = str(op.get("group_id") or op.get("id") or "").strip()
            if group_id:
                ops.append(
                    {
                        "op": "add_group",
                        "id": group_id,
                        "label": str(op.get("label") or group_id),
                        "member_ids": [str(item).strip() for item in op.get("member_ids", []) if str(item).strip()],
                    }
                )
        elif op_name == "add_node":
            node_id = str(op.get("node_id") or op.get("id") or "").strip()
            if node_id:
                ops.append({"op": "add_node", "id": node_id, "label": str(op.get("label") or node_id)})
        elif op_name == "add_edge":
            source = str(op.get("source") or "").strip()
            target = str(op.get("target") or "").strip()
            if source and target:
                ops.append({"op": "add_edge", "from": source, "to": target, "label": str(op.get("label") or "")})
    return ops


def _restore_renderer(payload: dict[str, Any], graph_ir: GraphIR) -> IncrementalGraphRenderer:
    renderer = IncrementalGraphRenderer()
    renderer_state = payload.get("renderer_state")
    if not isinstance(renderer_state, dict):
        for op in _renderer_operations(_graph_delta(build_empty_graph(graph_ir.graph_id, graph_ir.diagram_type), graph_ir)):
            renderer.apply_update(1, [op], "graph")
        return renderer

    nodes = renderer_state.get("nodes", [])
    if isinstance(nodes, list):
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("id") or "").strip()
            if not node_id:
                continue
            renderer.nodes[node_id] = NodeState(
                id=node_id,
                label=str(node.get("label") or node_id),
                x=float(node.get("x", 0.0) or 0.0),
                y=float(node.get("y", 0.0) or 0.0),
                created_frame=int(node.get("created_frame", 0) or 0),
            )
    edges = renderer_state.get("edges", [])
    if isinstance(edges, list):
        renderer.edges = {
            (str(edge.get("from") or "").strip(), str(edge.get("to") or "").strip())
            for edge in edges
            if isinstance(edge, dict)
            and str(edge.get("from") or "").strip()
            and str(edge.get("to") or "").strip()
        }
    renderer.frame_id = int(renderer_state.get("frame_count", 0) or 0)
    return renderer


def _resolve_api_key(profile: dict[str, Any]) -> tuple[str, str]:
    api_key = str(profile.get("api_key", "") or "").strip()
    api_key_env = str(profile.get("api_key_env", "") or "").strip()
    if api_key:
        return api_key, api_key_env
    if api_key_env:
        return os.getenv(api_key_env, "").strip(), api_key_env
    return "", api_key_env


def _build_ssl_context() -> ssl.SSLContext:
    settings = get_settings()
    if not settings.tls_verify:
        return ssl._create_unverified_context()
    if settings.ca_bundle.strip():
        return ssl.create_default_context(cafile=settings.ca_bundle.strip())
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


def build_chat_client(profile: dict[str, Any], model: str):
    provider_kind = str(profile.get("provider_kind", "openai_compatible") or "openai_compatible").strip()
    api_key, api_key_env = _resolve_api_key(profile)
    common_kwargs = {
        "endpoint": str(profile.get("endpoint", "")),
        "model": model,
        "api_key": api_key,
        "api_key_env": api_key_env or "OPENAI_API_KEY",
        "temperature": 0.0,
        "omit_temperature": False,
        "extra_body": {},
    }
    if provider_kind == "local_hf":
        return LocalHFChatClient(**common_kwargs)
    if provider_kind != "openai_compatible":
        raise RuntimeError(f"unsupported provider_kind: {provider_kind}")
    return OpenAICompatibleChatClient(
        **common_kwargs,
        ssl_context=_build_ssl_context(),
        disable_proxy=True,
    )


LIVE_GATE_SYSTEM_PROMPT = (
    "You are the small gate model for a collaborative realtime diagram system. "
    "Decide whether the current pending dialogue should WAIT or EMIT_UPDATE. "
    "Judge sufficiency of the buffered turns, not whether the graph already contains the information. "
    "If pending turns introduce concrete nodes, components, actors, modules, steps, or explicit relations, prefer EMIT_UPDATE. "
    "Use WAIT only when the buffer is still generic, meta, or too incomplete to add stable structure. "
    "Return strict JSON only with keys: action, reason, confidence. "
    "Allowed action values: WAIT, EMIT_UPDATE."
)


LIVE_PLANNER_SYSTEM_PROMPT = (
    "You are the large planner model for a collaborative realtime diagram system. "
    "Extend the current graph monotonically using only the observed dialogue and the current GraphIR. "
    "Return one JSON object only. No markdown, no explanations, no prose before or after JSON. "
    "Preferred top-level keys: delta_ops, notes. Optional top-level key: target_graph_ir. "
    "Use these operation names only: add_group, add_node, add_edge. "
    "Never remove, rename, or rewrite existing ids. Never switch to an unrelated domain. "
    "Reuse literal identifiers from the dialogue whenever possible. "
    "If you are unsure about a full graph snapshot, omit target_graph_ir and return delta_ops only. "
    "If target_graph_ir is provided, it must include all previously existing items and all new additions."
)


@dataclass
class GateDecision:
    action: str
    reason: str = ""
    confidence: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "reason": self.reason,
            "confidence": self.confidence,
            "metadata": dict(self.metadata),
        }


@dataclass
class PlannerDecision:
    delta_ops: list[dict[str, Any]] = field(default_factory=list)
    target_graph_ir: GraphIR | None = None
    notes: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "delta_ops": list(self.delta_ops),
            "target_graph_ir": self.target_graph_ir.to_payload() if self.target_graph_ir else None,
            "notes": self.notes,
            "metadata": dict(self.metadata),
        }


@dataclass
class CoordinationRuntimeSession:
    session_id: str
    diagram_type: str = "flowchart"
    created_wall_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    turns: list[DialogueTurn] = field(default_factory=list)
    pending_turn_ids: list[int] = field(default_factory=list)
    current_graph_ir: GraphIR = field(default_factory=lambda: build_empty_graph("session"))
    rendered_mermaid: str = "graph TD"
    renderer: IncrementalGraphRenderer = field(default_factory=IncrementalGraphRenderer)
    events: list[dict[str, Any]] = field(default_factory=list)
    gate_state: dict[str, Any] = field(default_factory=dict)
    planner_state: dict[str, Any] = field(default_factory=dict)
    gate_latency_ms: list[float] = field(default_factory=list)
    planner_latency_ms: list[float] = field(default_factory=list)
    render_latency_ms: list[float] = field(default_factory=list)
    e2e_latency_ms: list[float] = field(default_factory=list)
    gate_action_counts: Counter[str] = field(default_factory=Counter)
    planner_noop_count: int = 0
    update_index: int = 0
    first_ts: int | None = None
    last_ts: int | None = None
    chunk_count: int = 0
    last_consumed_turn_id: int = 0
    read_only: bool = False
    stored_pipeline: dict[str, Any] | None = None
    stored_evaluation: dict[str, Any] | None = None

    @classmethod
    def create(cls, session_id: str, *, diagram_type: str = "flowchart") -> CoordinationRuntimeSession:
        graph_ir = build_empty_graph(session_id, diagram_type)
        return cls(
            session_id=session_id,
            diagram_type=diagram_type,
            current_graph_ir=graph_ir,
            rendered_mermaid=render_preview_mermaid(graph_ir),
            gate_state={
                "status": "idle",
                "last_action": "WAIT",
                "reason": "等待输入",
                "confidence": None,
                "error_message": None,
            },
            planner_state={
                "status": "idle",
                "delta_ops_count": 0,
                "error_message": None,
            },
        )

    @classmethod
    def restore(
        cls,
        session_id: str,
        *,
        config_snapshot: dict[str, Any],
        pipeline_payload: dict[str, Any] | None,
        evaluation_payload: dict[str, Any] | None,
        rows: list[dict[str, Any]],
    ) -> CoordinationRuntimeSession:
        payload = pipeline_payload if isinstance(pipeline_payload, dict) else {}
        runtime_options = normalize_runtime_options(
            config_snapshot.get("runtime_options", {})
            if isinstance(config_snapshot, dict) and isinstance(config_snapshot.get("runtime_options"), dict)
            else {}
        )
        if not any(
            str(runtime_options.get(key) or "").strip()
            for key in ("gate_profile_id", "planner_profile_id")
        ):
            return cls(
                session_id=session_id,
                diagram_type=str(payload.get("graph_state", {}).get("diagram_type", "flowchart")),
                read_only=True,
                stored_pipeline=payload,
                stored_evaluation=evaluation_payload if isinstance(evaluation_payload, dict) else {},
            )

        graph_state = payload.get("graph_state", {}) if isinstance(payload.get("graph_state"), dict) else {}
        graph_payload = graph_state.get("current_graph_ir")
        if not isinstance(graph_payload, dict):
            graph_payload = {
                "graph_id": session_id,
                "diagram_type": str(graph_state.get("diagram_type", "flowchart") or "flowchart"),
                "nodes": [],
                "edges": [],
                "groups": [],
                "styles": [],
                "metadata": {},
            }
        graph_ir = _graph_ir_from_payload(graph_payload)
        runtime = cls.create(session_id, diagram_type=graph_ir.diagram_type)
        runtime.current_graph_ir = graph_ir
        runtime.rendered_mermaid = str(
            (payload.get("mermaid_state") or {}).get("normalized_code")
            or (payload.get("mermaid_state") or {}).get("code")
            or graph_state.get("preview_mermaid")
            or render_preview_mermaid(graph_ir)
        )
        runtime.renderer = _restore_renderer(payload, graph_ir)
        runtime.events = payload.get("events", []) if isinstance(payload.get("events"), list) else []
        runtime.gate_state = payload.get("gate_state", {}) if isinstance(payload.get("gate_state"), dict) else {}
        runtime.planner_state = payload.get("planner_state", {}) if isinstance(payload.get("planner_state"), dict) else {}
        runtime.update_index = int(graph_state.get("update_index", payload.get("summary", {}).get("updates_emitted", 0)) or 0)
        runtime.last_consumed_turn_id = int(graph_state.get("last_consumed_turn_id", 0) or 0)
        meta = payload.get("meta", {}) if isinstance(payload.get("meta"), dict) else {}
        runtime.created_wall_ms = int(time.time() * 1000) - int(meta.get("runtime_ms", 0) or 0)
        runtime.gate_action_counts = Counter(
            {
                str(key): int(value)
                for key, value in (
                    (payload.get("coordination_summary", {}) or {}).get("gate_action_counts", {})
                    if isinstance((payload.get("coordination_summary", {}) or {}).get("gate_action_counts", {}), dict)
                    else {}
                ).items()
            }
        )
        runtime.planner_noop_count = int(
            (payload.get("coordination_summary", {}) or {}).get("planner_noop_count", 0) or 0
        )
        for event in runtime.events:
            if not isinstance(event, dict):
                continue
            e2e_ms = event.get("e2e_latency_ms")
            render_ms = event.get("render_latency_ms")
            gate_ms = ((event.get("gate") or {}).get("metadata") or {}).get("latency_ms")
            planner_ms = ((event.get("planner") or {}).get("metadata") or {}).get("latency_ms")
            if isinstance(e2e_ms, (int, float)):
                runtime.e2e_latency_ms.append(float(e2e_ms))
            if isinstance(render_ms, (int, float)):
                runtime.render_latency_ms.append(float(render_ms))
            if isinstance(gate_ms, (int, float)):
                runtime.gate_latency_ms.append(float(gate_ms))
            if isinstance(planner_ms, (int, float)):
                runtime.planner_latency_ms.append(float(planner_ms))

        runtime.turns = []
        for index, row in enumerate(rows, start=1):
            timestamp_ms = int(row.get("timestamp_ms", 0) or 0)
            runtime.turns.append(
                DialogueTurn(
                    turn_id=index,
                    speaker=str(row.get("speaker", "user")),
                    content=str(row.get("text", "")),
                    stage_index=None,
                    metadata={
                        "timestamp_ms": timestamp_ms,
                        "is_final": bool(row.get("is_final", True)),
                        "expected_intent": row.get("expected_intent"),
                    },
                )
            )
            if runtime.first_ts is None:
                runtime.first_ts = timestamp_ms
            runtime.last_ts = timestamp_ms
        runtime.chunk_count = len(runtime.turns)
        pending_turn_ids = graph_state.get("pending_turn_ids", [])
        if isinstance(pending_turn_ids, list) and pending_turn_ids:
            runtime.pending_turn_ids = [int(item) for item in pending_turn_ids if str(item).strip()]
        else:
            runtime.pending_turn_ids = [
                turn.turn_id for turn in runtime.turns if int(turn.turn_id) > int(runtime.last_consumed_turn_id)
            ]
        runtime.stored_evaluation = evaluation_payload if isinstance(evaluation_payload, dict) else {}
        return runtime

    def current_turns(self) -> list[DialogueTurn]:
        return list(self.turns)

    def pending_turns(self) -> list[DialogueTurn]:
        pending = set(self.pending_turn_ids)
        return [turn for turn in self.turns if turn.turn_id in pending]

    def ingest_chunk(
        self,
        db: Session,
        session_obj: RealtimeSession,
        *,
        timestamp_ms: int,
        text: str,
        speaker: str,
        is_final: bool,
        expected_intent: str | None,
    ) -> list[dict[str, Any]]:
        if self.read_only:
            raise RuntimeError("legacy realtime sessions are read-only and cannot ingest new chunks")
        if self.first_ts is None:
            self.first_ts = timestamp_ms
        self.last_ts = timestamp_ms
        self.chunk_count += 1
        turn = DialogueTurn(
            turn_id=len(self.turns) + 1,
            speaker=speaker,
            content=text,
            stage_index=None,
            metadata={
                "timestamp_ms": timestamp_ms,
                "is_final": is_final,
                "expected_intent": expected_intent,
            },
        )
        self.turns.append(turn)
        self.pending_turn_ids.append(turn.turn_id)
        return self._run_cycle(db, session_obj, force_emit=False)

    def buffer_chunk(
        self,
        *,
        timestamp_ms: int,
        text: str,
        speaker: str,
        is_final: bool,
        expected_intent: str | None,
    ) -> None:
        if self.read_only:
            raise RuntimeError("legacy realtime sessions are read-only and cannot ingest new chunks")
        if self.first_ts is None:
            self.first_ts = timestamp_ms
        self.last_ts = timestamp_ms
        self.chunk_count += 1
        turn = DialogueTurn(
            turn_id=len(self.turns) + 1,
            speaker=speaker,
            content=text,
            stage_index=None,
            metadata={
                "timestamp_ms": timestamp_ms,
                "is_final": is_final,
                "expected_intent": expected_intent,
            },
        )
        self.turns.append(turn)
        self.pending_turn_ids.append(turn.turn_id)

    def run_pending(self, db: Session, session_obj: RealtimeSession) -> list[dict[str, Any]]:
        if self.read_only:
            return []
        return self._run_cycle(db, session_obj, force_emit=False)

    def flush(self, db: Session, session_obj: RealtimeSession) -> list[dict[str, Any]]:
        if self.read_only:
            return []
        return self._run_cycle(db, session_obj, force_emit=True)

    def _run_cycle(self, db: Session, session_obj: RealtimeSession, *, force_emit: bool) -> list[dict[str, Any]]:
        pending_turns = self.pending_turns()
        _log_coordination_event(
            "Coordination cycle started",
            {
                "session_id": self.session_id,
                "force_emit": force_emit,
                "pending_turn_count": len(pending_turns),
                "pending_turn_ids": [turn.turn_id for turn in pending_turns],
                "current_update_index": self.update_index,
            },
        )
        if not pending_turns:
            self.gate_state = {
                **self.gate_state,
                "status": "success",
                "last_action": "WAIT",
                "reason": "当前没有待处理文本。",
                "confidence": 1.0,
                "updated_at": int(time.time() * 1000),
                "error_message": None,
            }
            _log_coordination_event(
                "Coordination cycle skipped",
                {
                    "session_id": self.session_id,
                    "reason": "no_pending_turns",
                    "current_update_index": self.update_index,
                },
            )
            return []

        gate_decision = self._decide_gate(db, session_obj, pending_turns, force_emit=force_emit)
        self.gate_action_counts[gate_decision.action] += 1
        _log_coordination_event(
            "Gate decision produced",
            {
                "session_id": self.session_id,
                "action": gate_decision.action,
                "reason": gate_decision.reason,
                "confidence": gate_decision.confidence,
                "metadata": gate_decision.metadata,
            },
        )
        if gate_decision.action != "EMIT_UPDATE":
            return []

        try:
            planner_decision = self._plan_update(db, session_obj, pending_turns)
        except Exception as exc:
            self.planner_state = {
                "status": "error",
                "provider": "",
                "model": "",
                "latency_ms": 0.0,
                "delta_ops_count": 0,
                "graph_changed": False,
                "notes": "",
                "updated_at": int(time.time() * 1000),
                "error_message": str(exc),
            }
            _log_coordination_event(
                "Planner decision failed",
                {
                    "session_id": self.session_id,
                    "error": str(exc),
                    "pending_turn_ids": [turn.turn_id for turn in pending_turns],
                },
            )
            return []
        base_graph = _clone_graph_ir(self.current_graph_ir)
        next_graph, effective_delta_ops, graph_changed = self._apply_planner_decision(base_graph, planner_decision)
        pending_turn_ids = [turn.turn_id for turn in pending_turns]
        self.last_consumed_turn_id = pending_turn_ids[-1]
        self.pending_turn_ids = [turn_id for turn_id in self.pending_turn_ids if turn_id not in pending_turn_ids]

        if not graph_changed:
            self.planner_noop_count += 1
            self.planner_state = {
                **self.planner_state,
                "status": "success",
                "delta_ops_count": 0,
                "graph_changed": False,
                "notes": planner_decision.notes,
                "updated_at": int(time.time() * 1000),
                "error_message": None,
            }
            _log_coordination_event(
                "Planner produced no graph change",
                {
                    "session_id": self.session_id,
                    "pending_turn_ids": pending_turn_ids,
                    "planner_state": self.planner_state,
                },
            )
            return []

        self.update_index += 1
        render_ops = _renderer_operations(effective_delta_ops)
        render_t0 = time.time()
        frame = self.renderer.apply_update(self.update_index, render_ops, "emit_update")
        render_ms = round((time.time() - render_t0) * 1000.0, 4)
        self.render_latency_ms.append(render_ms)
        self.current_graph_ir = next_graph
        self.rendered_mermaid = render_preview_mermaid(next_graph)

        planner_latency = float(planner_decision.metadata.get("latency_ms") or 0.0)
        gate_latency = float(gate_decision.metadata.get("latency_ms") or 0.0)
        e2e_ms = round(gate_latency + planner_latency + render_ms, 4)
        self.e2e_latency_ms.append(e2e_ms)

        event = {
            "update": {
                "update_id": self.update_index,
                "intent_type": "emit_update",
                "semantic_action": "emit_update",
                "operations": render_ops,
                "focus_entities": list(_extract_identifier_candidates(pending_turns).values())[:12],
                "annotations": [planner_decision.notes] if planner_decision.notes else [],
                "transcript_text": "\n".join(turn.content for turn in pending_turns if turn.content.strip()),
                "start_ms": int(pending_turns[0].metadata.get("timestamp_ms", 0) or 0),
                "end_ms": int(pending_turns[-1].metadata.get("timestamp_ms", 0) or 0),
                "processing_latency_ms": round(gate_latency + planner_latency, 4),
            },
            "gate": gate_decision.to_payload(),
            "planner": planner_decision.to_payload(),
            "pending_turns": [_dialogue_payload(turn) for turn in pending_turns],
            "graph_before": _graph_metrics(base_graph),
            "graph_after": _graph_metrics(next_graph),
            "render_frame": asdict(frame),
            "gold_intent": None,
            "intent_correct": None,
            "render_latency_ms": render_ms,
            "e2e_latency_ms": e2e_ms,
        }
        self.events.append(event)
        _log_coordination_event(
            "Coordination update emitted",
            {
                "session_id": self.session_id,
                "update_index": self.update_index,
                "pending_turn_ids": pending_turn_ids,
                "gate_latency_ms": gate_latency,
                "planner_latency_ms": planner_latency,
                "render_latency_ms": render_ms,
                "e2e_latency_ms": e2e_ms,
                "graph_before": _graph_metrics(base_graph),
                "graph_after": _graph_metrics(next_graph),
                "delta_ops_count": len(effective_delta_ops),
            },
        )

        self.planner_state = {
            "status": "success",
            "provider": planner_decision.metadata.get("provider", ""),
            "model": planner_decision.metadata.get("model_name", ""),
            "latency_ms": planner_latency,
            "delta_ops_count": len(effective_delta_ops),
            "graph_changed": True,
            "notes": planner_decision.notes,
            "updated_at": int(time.time() * 1000),
            "error_message": None,
            "debug": {
                "semantic_attempt": planner_decision.metadata.get("semantic_attempt"),
                "raw_text_preview": planner_decision.metadata.get("raw_text_preview"),
                "usage": planner_decision.metadata.get("usage"),
                "planner_noop": planner_decision.metadata.get("planner_noop", False),
            },
        }
        return [event]

    def _decide_gate(
        self,
        db: Session,
        session_obj: RealtimeSession,
        pending_turns: list[DialogueTurn],
        *,
        force_emit: bool,
    ) -> GateDecision:
        input_runtime = _current_input_runtime(session_obj)
        input_source = str(input_runtime.get("input_source") or "").strip()
        capture_mode = str(input_runtime.get("capture_mode") or "").strip()
        if input_source == "transcript" and capture_mode == "manual_text" and pending_turns:
            decision = GateDecision(
                action="EMIT_UPDATE",
                reason="手动 transcript 批量输入默认直接触发结构更新。",
                confidence=1.0,
                metadata={
                    "provider": "heuristic_batch_gate",
                    "model_name": "heuristic_batch_gate",
                    "latency_ms": 0.0,
                    "force_emit": force_emit,
                },
            )
            self.gate_state = {
                "status": "success",
                "last_action": decision.action,
                "reason": decision.reason,
                "confidence": decision.confidence,
                "provider": "heuristic_batch_gate",
                "model": "heuristic_batch_gate",
                "latency_ms": 0.0,
                "updated_at": int(time.time() * 1000),
                "error_message": None,
                "debug": {"force_emit": force_emit, "shortcut": "manual_transcript_batch"},
            }
            _log_coordination_event(
                "Gate shortcut applied",
                {
                    "session_id": self.session_id,
                    "input_source": input_source,
                    "capture_mode": capture_mode,
                    "pending_turn_ids": [turn.turn_id for turn in pending_turns],
                },
            )
            return decision
        runtime_options = _current_runtime_options(session_obj)
        profile = resolve_profile(db, "gate", runtime_options.get("gate_profile_id"))
        model = str(runtime_options.get("gate_model") or (profile or {}).get("default_model") or "")

        if not profile or not model:
            if force_emit:
                decision = GateDecision(
                    action="EMIT_UPDATE",
                    reason="flush 强制执行更新，但未配置 Gate 模型。",
                    confidence=0.0,
                    metadata={"provider": (profile or {}).get("id", ""), "model_name": model, "latency_ms": 0.0},
                )
            else:
                decision = GateDecision(
                    action="WAIT",
                    reason="未配置可用的 Gate profile / model。",
                    confidence=0.0,
                    metadata={"provider": (profile or {}).get("id", ""), "model_name": model, "latency_ms": 0.0},
                )
            self.gate_state = {
                "status": "error" if not force_emit else "success",
                "last_action": decision.action,
                "reason": decision.reason,
                "confidence": decision.confidence,
                "provider": (profile or {}).get("id", ""),
                "model": model,
                "latency_ms": 0.0,
                "updated_at": int(time.time() * 1000),
                "error_message": None if force_emit else decision.reason,
            }
            _log_coordination_event(
                "Gate configuration missing",
                {
                    "session_id": self.session_id,
                    "force_emit": force_emit,
                    "provider": (profile or {}).get("id", ""),
                    "model": model,
                    "action": decision.action,
                },
            )
            return decision

        try:
            _log_coordination_event(
                "Gate request started",
                {
                    "session_id": self.session_id,
                    "provider": str(profile.get("id", "")),
                    "model": model,
                    "force_emit": force_emit,
                    "pending_turn_ids": [turn.turn_id for turn in pending_turns],
                },
            )
            client = build_chat_client(profile, model)
            messages = [
                {"role": "system", "content": LIVE_GATE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "session_id": self.session_id,
                            "diagram_type": self.diagram_type,
                            "current_update_index": self.update_index,
                            "pending_turns": [_dialogue_payload(turn) for turn in pending_turns],
                            "recent_turns": [_dialogue_payload(turn) for turn in self.turns[-8:]],
                            "current_graph_metrics": _graph_metrics(self.current_graph_ir),
                            "current_graph_ir": self.current_graph_ir.to_payload(),
                            "force_emit": force_emit,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                },
            ]
            result = client.chat(messages)
            payload = _parse_json_object(result.text)
            action = _coerce_gate_action(payload.get("action", "WAIT"))
            if force_emit:
                action = "EMIT_UPDATE"
            decision = GateDecision(
                action=action,
                reason=str(payload.get("reason", "")).strip() or ("flush 强制更新" if force_emit else ""),
                confidence=float(payload["confidence"]) if payload.get("confidence") is not None else None,
                metadata={
                    "provider": str(profile.get("id", "")),
                    "model_name": model,
                    "latency_ms": result.latency_ms,
                    "usage": result.usage,
                    "semantic_attempt": 1,
                    "raw_text_preview": (result.text or "")[:400],
                    "force_emit": force_emit,
                },
            )
            self.gate_latency_ms.append(float(result.latency_ms))
            self.gate_state = {
                "status": "success",
                "last_action": decision.action,
                "reason": decision.reason,
                "confidence": decision.confidence,
                "provider": str(profile.get("id", "")),
                "model": model,
                "latency_ms": float(result.latency_ms),
                "updated_at": int(time.time() * 1000),
                "error_message": None,
                "debug": {
                    "semantic_attempt": 1,
                    "raw_text_preview": (result.text or "")[:400],
                    "usage": result.usage,
                    "force_emit": force_emit,
                },
            }
            _log_coordination_event(
                "Gate request succeeded",
                {
                    "session_id": self.session_id,
                    "provider": str(profile.get("id", "")),
                    "model": model,
                    "action": decision.action,
                    "confidence": decision.confidence,
                    "latency_ms": result.latency_ms,
                },
            )
            return decision
        except Exception as exc:
            if force_emit:
                fallback = GateDecision(
                    action="EMIT_UPDATE",
                    reason=f"Gate 失败，flush 改为强制更新：{exc}",
                    confidence=0.0,
                    metadata={
                        "provider": str((profile or {}).get("id", "")),
                        "model_name": model,
                        "latency_ms": 0.0,
                        "force_emit": True,
                    },
                )
                self.gate_state = {
                    "status": "error",
                    "last_action": fallback.action,
                    "reason": fallback.reason,
                    "confidence": fallback.confidence,
                    "provider": str((profile or {}).get("id", "")),
                    "model": model,
                    "latency_ms": 0.0,
                    "updated_at": int(time.time() * 1000),
                    "error_message": str(exc),
                    "debug": {"force_emit": True},
                }
                _log_coordination_event(
                    "Gate request failed but force_emit continued",
                    {
                        "session_id": self.session_id,
                        "provider": str((profile or {}).get("id", "")),
                        "model": model,
                        "error": str(exc),
                    },
                )
                return fallback
            self.gate_state = {
                "status": "error",
                "last_action": "WAIT",
                "reason": "Gate 模型失败。",
                "confidence": None,
                "provider": str((profile or {}).get("id", "")),
                "model": model,
                "latency_ms": 0.0,
                "updated_at": int(time.time() * 1000),
                "error_message": str(exc),
            }
            _log_coordination_event(
                "Gate request failed",
                {
                    "session_id": self.session_id,
                    "provider": str((profile or {}).get("id", "")),
                    "model": model,
                    "error": str(exc),
                },
            )
            return GateDecision(action="WAIT", reason=str(exc), confidence=None, metadata={"latency_ms": 0.0})

    def _plan_update(
        self,
        db: Session,
        session_obj: RealtimeSession,
        pending_turns: list[DialogueTurn],
    ) -> PlannerDecision:
        runtime_options = _current_runtime_options(session_obj)
        profile = resolve_profile(db, "planner", runtime_options.get("planner_profile_id"))
        model = str(runtime_options.get("planner_model") or (profile or {}).get("default_model") or "")
        if not profile or not model:
            raise RuntimeError("未配置可用的 Planner profile / model。")

        _log_coordination_event(
            "Planner request started",
            {
                "session_id": self.session_id,
                "provider": str(profile.get("id", "")),
                "model": model,
                "current_update_index": self.update_index,
                "pending_turn_ids": [turn.turn_id for turn in pending_turns],
            },
        )
        client = build_chat_client(profile, model)
        sample_hint = SimpleNamespace(sample_id=self.session_id, diagram_type=self.diagram_type)
        state_hint = SimpleNamespace(current_graph_ir=self.current_graph_ir)
        base_messages = [
            {"role": "system", "content": LIVE_PLANNER_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "session_id": self.session_id,
                        "diagram_type": self.diagram_type,
                        "current_update_index": self.update_index,
                        "pending_turns": [_dialogue_payload(turn) for turn in pending_turns],
                        "recent_turns": [_dialogue_payload(turn) for turn in self.turns[-24:]],
                        "recent_dialogue_snapshot": _build_recent_dialogue_snapshot(self.turns[-24:]),
                        "identifier_candidates": list(_extract_identifier_candidates(self.turns).values())[:24],
                        "diagram_type_priors": _diagram_type_alignment_priors(self.diagram_type),
                        "current_graph_ir": self.current_graph_ir.to_payload(),
                        "current_graph_metrics": _graph_metrics(self.current_graph_ir),
                        "output_contract": {
                            "delta_ops": [
                                {
                                    "op": "add_group|add_node|add_edge",
                                    "group_id": "for add_group",
                                    "node_id": "for add_node",
                                    "edge_id": "for add_edge",
                                    "source": "for add_edge",
                                    "target": "for add_edge",
                                    "label": "string",
                                    "kind": "optional string",
                                    "parent": "optional group id",
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
        current_messages = list(base_messages)
        last_error: Exception | None = None
        last_result_text = ""

        for attempt in range(2):
            result = client.chat(current_messages)
            try:
                last_result_text = result.text or ""
                payload = _parse_json_object(result.text)
                raw_graph_payload = _extract_graph_payload(payload)
                target_graph_ir = None
                if isinstance(raw_graph_payload, dict) and raw_graph_payload:
                    target_graph_ir = _graph_ir_from_payload(raw_graph_payload)
                    target_graph_ir = _refine_graph_ir(sample_hint, self.turns, target_graph_ir)
                delta_ops = _refine_delta_ops(sample_hint, self.turns, state_hint, _coerce_delta_ops(payload))
                if not delta_ops and target_graph_ir is None and _has_delta_ops_field(payload):
                    target_graph_ir = _clone_graph_ir(self.current_graph_ir)
                if not delta_ops and target_graph_ir is None:
                    raise ValueError("planner returned neither delta_ops nor target_graph_ir")
                decision = PlannerDecision(
                    delta_ops=delta_ops,
                    target_graph_ir=target_graph_ir,
                    notes=str(payload.get("notes", "")).strip(),
                    metadata={
                        "provider": str(profile.get("id", "")),
                        "model_name": model,
                        "latency_ms": result.latency_ms,
                        "usage": result.usage,
                        "semantic_attempt": attempt + 1,
                        "raw_text_preview": (result.text or "")[:400],
                        "planner_noop": (not delta_ops and target_graph_ir is not None),
                    },
                )
                self.planner_latency_ms.append(float(result.latency_ms))
                _log_coordination_event(
                    "Planner request succeeded",
                    {
                        "session_id": self.session_id,
                        "provider": str(profile.get("id", "")),
                        "model": model,
                        "latency_ms": result.latency_ms,
                        "semantic_attempt": attempt + 1,
                        "delta_ops_count": len(delta_ops),
                        "has_target_graph_ir": target_graph_ir is not None,
                    },
                )
                return decision
            except Exception as exc:
                last_error = exc
                if attempt >= 1:
                    preview = strip_think_traces(last_result_text).strip().replace("\n", " ")[:300]
                    raise RuntimeError(f"{exc}; raw_preview={preview}") from exc
                current_messages = [
                    *base_messages,
                    {"role": "assistant", "content": strip_think_traces(result.text or "")[:4000]},
                    {"role": "user", "content": _repair_prompt(exc)},
                ]

        raise RuntimeError(str(last_error) if last_error else "planner failed without an explicit error")

    def _apply_planner_decision(
        self,
        base_graph: GraphIR,
        planner_decision: PlannerDecision,
    ) -> tuple[GraphIR, list[dict[str, Any]], bool]:
        target_graph = planner_decision.target_graph_ir
        if planner_decision.delta_ops:
            target_graph = _apply_delta_ops(base_graph, planner_decision.delta_ops)
            if planner_decision.target_graph_ir is not None:
                target_graph = _merge_structural_metadata_from_snapshot(target_graph, planner_decision.target_graph_ir)
        elif target_graph is not None:
            target_graph = _sanitize_graph_ir(base_graph, target_graph)
        else:
            target_graph = _clone_graph_ir(base_graph)

        effective_delta = planner_decision.delta_ops or _graph_delta(base_graph, target_graph)
        graph_changed = _graph_payload_signature(base_graph) != _graph_payload_signature(target_graph)
        return target_graph, effective_delta, graph_changed

    def pipeline_payload(self) -> dict[str, Any]:
        if self.read_only and self.stored_pipeline is not None:
            return dict(self.stored_pipeline)
        runtime_ms = int(time.time() * 1000) - self.created_wall_ms
        transcript_duration_ms = 0
        if self.first_ts is not None and self.last_ts is not None:
            transcript_duration_ms = max(0, self.last_ts - self.first_ts)
        speed_vs_realtime = (
            round(transcript_duration_ms / runtime_ms, 4)
            if runtime_ms > 0 and transcript_duration_ms > 0
            else 0.0
        )
        graph_metrics = _graph_metrics(self.current_graph_ir)
        mermaid_state = {
            "code": self.rendered_mermaid,
            "normalized_code": self.rendered_mermaid,
            "source": "algorithm_preview",
            "provider": str(self.planner_state.get("provider") or "deterministic_algorithm_layer"),
            "model": self.planner_state.get("model"),
            "latency_ms": self.planner_state.get("latency_ms"),
            "compile_ok": True,
            "render_ok": True,
            "error_message": None,
            "updated_at": int(time.time() * 1000),
        }
        return {
            "meta": {
                "mode": "collaborative_live_session",
                "time_scale": 1.0,
                "input_chunk_count": self.chunk_count,
                "runtime_ms": runtime_ms,
                "transcript_duration_ms": transcript_duration_ms,
                "speedup_vs_realtime": speed_vs_realtime,
            },
            "summary": {
                "updates_emitted": len(self.events),
                "pending_turn_count": len(self.pending_turn_ids),
                "latency_e2e_ms": _stats(self.e2e_latency_ms),
                "latency_gate_ms": _stats(self.gate_latency_ms),
                "latency_planner_ms": _stats(self.planner_latency_ms),
                "latency_render_ms": _stats(self.render_latency_ms),
                "intent_labeled_eval_count": 0,
                "intent_labeled_accuracy": None,
                "renderer_stability": self.renderer.summary(),
                "graph_metrics": graph_metrics,
            },
            "coordination_summary": {
                "update_index": self.update_index,
                "pending_turn_count": len(self.pending_turn_ids),
                "gate_action_counts": dict(self.gate_action_counts),
                "planner_noop_count": self.planner_noop_count,
                "last_consumed_turn_id": self.last_consumed_turn_id,
            },
            "gate_state": dict(self.gate_state),
            "planner_state": dict(self.planner_state),
            "graph_state": {
                "diagram_type": self.diagram_type,
                "update_index": self.update_index,
                "current_graph_ir": self.current_graph_ir.to_payload(),
                "graph_metrics": graph_metrics,
                "preview_mermaid": self.rendered_mermaid,
                "pending_turn_count": len(self.pending_turn_ids),
                "pending_turn_ids": list(self.pending_turn_ids),
                "last_consumed_turn_id": self.last_consumed_turn_id,
                "observed_turn_count": len(self.turns),
            },
            "mermaid_state": mermaid_state,
            "renderer_state": {
                **self.renderer.export_state(),
                "groups": [group.to_payload() for group in self.current_graph_ir.groups],
            },
            "events": list(self.events),
        }


def _current_runtime_options(session_obj: RealtimeSession) -> dict[str, Any]:
    snapshot = session_obj.config_snapshot if isinstance(session_obj.config_snapshot, dict) else {}
    options = snapshot.get("runtime_options", {})
    return normalize_runtime_options(options if isinstance(options, dict) else {})


def _current_input_runtime(session_obj: RealtimeSession) -> dict[str, Any]:
    snapshot = session_obj.config_snapshot if isinstance(session_obj.config_snapshot, dict) else {}
    payload = snapshot.get("input_runtime", {})
    return payload if isinstance(payload, dict) else {}
