from __future__ import annotations

import json
import logging
import os
import ssl
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from types import SimpleNamespace
from typing import Any, TypeVar

from sqlalchemy.orm import Session

from app.config import get_settings
from app.legacy import IncrementalGraphRenderer
from app.models import RealtimeSession
from app.services.runtime_options import resolve_profile
from incremental_renderer import NodeState, RenderFrame
from tools.eval.common import strip_think_traces
from tools.eval.metrics import canonical_diagram_type
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
GraphEntityT = TypeVar("GraphEntityT")
LLM_LOG_TEXT_LIMIT = 4000


def _log_coordination_event(message: str, payload: dict[str, Any]) -> None:
    logger.info("%s %s", message, json.dumps(payload, ensure_ascii=False))


def _llm_log_text(text: str) -> str:
    normalized = strip_think_traces(text or "").strip()
    if len(normalized) <= LLM_LOG_TEXT_LIMIT:
        return normalized
    return f"{normalized[:LLM_LOG_TEXT_LIMIT]}...<truncated>"


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
        "style_count": len(graph_ir.styles),
        "node_ids": [node.id for node in graph_ir.nodes[:12]],
        "edge_ids": [edge.id for edge in graph_ir.edges[:12]],
        "group_ids": [group.id for group in graph_ir.groups[:12]],
    }


def _graph_payload_signature(graph_ir: GraphIR) -> str:
    return json.dumps(graph_ir.to_payload(), ensure_ascii=False, sort_keys=True)


def _normalize_style_line(line: str) -> str:
    compact = " ".join(str(line or "").strip().split())
    if not compact:
        return ""
    lower = compact.lower()
    if lower.startswith("class ") and not lower.startswith("classdef "):
        tokens = compact.split()
        if len(tokens) >= 3:
            class_name = tokens[-1]
            target_tokens = tokens[1:-1]
            targets: list[str] = []
            for token in target_tokens:
                targets.extend(part.strip() for part in token.split(",") if part.strip())
            if targets:
                return f"class {','.join(targets)} {class_name}"
    return compact


def _coerce_style_entries(raw_styles: object) -> list[dict[str, Any]]:
    if not isinstance(raw_styles, list):
        return []
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_styles:
        normalized: dict[str, Any] | None = None
        if isinstance(item, str):
            line = _normalize_style_line(item)
            if line:
                normalized = {"line": line}
        elif isinstance(item, dict):
            line = _normalize_style_line(item.get("line") or item.get("statement") or item.get("raw") or "")
            if line:
                normalized = {"line": line}
            else:
                kind = str(item.get("kind") or "").strip()
                payload: dict[str, Any] = {}
                if kind:
                    payload["kind"] = kind
                for key in ("target", "targets", "name", "class_name", "attributes", "css", "value", "index"):
                    value = item.get(key)
                    if value is not None and value != "":
                        payload[key] = value
                if payload:
                    normalized = payload
        if normalized is None:
            continue
        signature = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
        if signature in seen:
            continue
        seen.add(signature)
        cleaned.append(normalized)
    return cleaned


def _default_graph_styles(graph_ir: GraphIR) -> list[dict[str, Any]]:
    if not graph_ir.nodes and not graph_ir.groups:
        return []

    incoming: Counter[str] = Counter()
    outgoing: Counter[str] = Counter()
    ordered_edges = sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id))
    for edge in ordered_edges:
        outgoing[edge.source] += 1
        incoming[edge.target] += 1

    root_ids: list[str] = []
    detail_ids: list[str] = []
    decision_ids: list[str] = []
    terminal_ids: list[str] = []

    decision_tokens = ("如果", "是否", "审批", "审核", "分支", "条件", "风险", "退回", "未通过", "decision", "branch")
    terminal_tokens = ("完成", "结束", "归档", "通过", "立项", "结题", "上线", "发布", "已", "done", "final")

    for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
        label = str(node.label or "")
        kind = str(node.kind or "").lower()
        is_root = node.id == "root" or (incoming[node.id] == 0 and (outgoing[node.id] > 0 or node.parent is None))
        is_decision = any(token in label for token in decision_tokens) or any(token in kind for token in ("decision", "conditional", "branch", "warning"))
        is_terminal = outgoing[node.id] == 0 and any(token in label for token in terminal_tokens)
        if is_root:
            root_ids.append(node.id)
            continue
        if is_decision:
            decision_ids.append(node.id)
            continue
        if is_terminal:
            terminal_ids.append(node.id)
            continue
        if outgoing[node.id] == 0:
            detail_ids.append(node.id)

    styles: list[dict[str, Any]] = [
        {"line": "classDef primary fill:#ede9fe,stroke:#7c3aed,color:#4c1d95,font-weight:bold,font-size:16px"},
        {"line": "classDef detail fill:#f8fafc,stroke:#94a3b8,color:#334155,font-size:13px"},
        {"line": "classDef decision fill:#fff7ed,stroke:#ea580c,color:#9a3412,font-weight:bold"},
        {"line": "classDef terminal fill:#ecfeff,stroke:#0891b2,color:#155e75,font-weight:bold"},
    ]

    if root_ids:
        styles.append({"line": f"class {','.join(root_ids[:8])} primary"})
    if detail_ids:
        styles.append({"line": f"class {','.join(detail_ids[:16])} detail"})
    if decision_ids:
        styles.append({"line": f"class {','.join(decision_ids[:12])} decision"})
    if terminal_ids:
        styles.append({"line": f"class {','.join(terminal_ids[:12])} terminal"})

    group_palette = [
        ("#f5f3ff", "#8b5cf6", "#4c1d95"),
        ("#eff6ff", "#3b82f6", "#1d4ed8"),
        ("#f0fdf4", "#22c55e", "#166534"),
        ("#fff7ed", "#f97316", "#9a3412"),
    ]
    for index, group in enumerate(sorted(graph_ir.groups, key=lambda item: (item.source_index, item.id))[:6]):
        fill, stroke, color = group_palette[index % len(group_palette)]
        styles.append(
            {
                "line": f"style {group.id} fill:{fill},stroke:{stroke},stroke-width:1.5px,color:{color}",
            }
        )

    for index, edge in enumerate(ordered_edges):
        label = str(edge.label or "")
        kind = str(edge.kind or "").lower()
        if any(token in label for token in decision_tokens) or any(token in kind for token in ("conditional", "warning", "branch")):
            styles.append(
                {
                    "line": f"linkStyle {index} stroke:#d97706,stroke-width:2.5px,color:#92400e",
                }
            )

    return _coerce_style_entries(styles)


def _ensure_graph_styles(graph_ir: GraphIR) -> GraphIR:
    if graph_ir.styles or (not graph_ir.nodes and not graph_ir.groups):
        return graph_ir
    clone = _clone_graph_ir(graph_ir)
    clone.styles = _default_graph_styles(clone)
    return clone


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
    if value in {"WAIT", "EMIT_UPDATE", "SWITCH_CANVAS"}:
        return value
    compact = value.replace("-", "_").replace(" ", "_")
    if any(token in compact for token in ("SWITCH_CANVAS", "NEW_CANVAS", "NEXT_CANVAS", "SPLIT_CANVAS")):
        return "SWITCH_CANVAS"
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


def _normalize_source_index_order(items: list[GraphEntityT]) -> list[GraphEntityT]:
    ordered = sorted(
        enumerate(items),
        key=lambda pair: (int(getattr(pair[1], "source_index", 0) or 0), pair[0]),
    )
    normalized: list[GraphEntityT] = []
    for rank, (_index, item) in enumerate(ordered, start=1):
        setattr(item, "source_index", rank)
        normalized.append(item)
    return normalized


def _sanitize_relayout_graph_ir(base: GraphIR, candidate: GraphIR) -> GraphIR:
    if candidate.diagram_type and candidate.diagram_type != base.diagram_type:
        candidate.diagram_type = base.diagram_type

    base_nodes = {node.id: node for node in base.nodes}
    base_groups = {group.id: group for group in base.groups}
    candidate_nodes = {node.id: node for node in candidate.nodes if node.id in base_nodes}
    candidate_groups = {group.id: group for group in candidate.groups if group.id in base_groups}

    ordered_nodes: list[GraphNode] = []
    seen_node_ids: set[str] = set()
    for row in list(candidate.nodes) + list(base.nodes):
        if row.id not in base_nodes or row.id in seen_node_ids:
            continue
        source = candidate_nodes.get(row.id) or base_nodes[row.id]
        seen_node_ids.add(row.id)
        ordered_nodes.append(
            GraphNode(
                id=row.id,
                label=source.label or base_nodes[row.id].label or row.id,
                kind=source.kind or base_nodes[row.id].kind or "node",
                parent=source.parent if row.id in candidate_nodes else base_nodes[row.id].parent,
                source_index=int(source.source_index or 0),
                metadata=dict(base_nodes[row.id].metadata) | dict(source.metadata),
            )
        )

    ordered_groups: list[GraphGroup] = []
    seen_group_ids: set[str] = set()
    for row in list(candidate.groups) + list(base.groups):
        if row.id not in base_groups or row.id in seen_group_ids:
            continue
        source = candidate_groups.get(row.id) or base_groups[row.id]
        seen_group_ids.add(row.id)
        ordered_groups.append(
            GraphGroup(
                id=row.id,
                label=source.label or base_groups[row.id].label or row.id,
                parent=source.parent if row.id in candidate_groups else base_groups[row.id].parent,
                member_ids=list(source.member_ids) if candidate_groups.get(row.id) else list(base_groups[row.id].member_ids),
                source_index=int(source.source_index or 0),
                metadata=dict(base_groups[row.id].metadata) | dict(source.metadata),
            )
        )

    valid_group_ids = {group.id for group in ordered_groups}
    valid_node_ids = {node.id for node in ordered_nodes}
    for node in ordered_nodes:
        if node.parent and node.parent not in valid_group_ids:
            node.parent = None

    for group in ordered_groups:
        if group.parent and group.parent not in valid_group_ids:
            group.parent = None
        group.member_ids = list(dict.fromkeys(member_id for member_id in group.member_ids if member_id in valid_node_ids))

    edge_source = candidate.edges if candidate.edges or not base.edges else base.edges
    ordered_edges: list[GraphEdge] = []
    seen_edge_ids: set[str] = set()
    for index, edge in enumerate(edge_source, start=1):
        edge_id = str(edge.id or f"{edge.source}__{edge.target}__{index}").strip()
        if (
            not edge_id
            or edge_id in seen_edge_ids
            or edge.source not in valid_node_ids
            or edge.target not in valid_node_ids
        ):
            continue
        seen_edge_ids.add(edge_id)
        ordered_edges.append(
            GraphEdge(
                id=edge_id,
                source=edge.source,
                target=edge.target,
                label=edge.label,
                kind=edge.kind or "edge",
                source_index=int(edge.source_index or 0),
                metadata=dict(edge.metadata),
            )
        )

    sanitized = GraphIR(
        graph_id=base.graph_id,
        diagram_type=base.diagram_type,
        nodes=_normalize_source_index_order(ordered_nodes),
        edges=_normalize_source_index_order(ordered_edges),
        groups=_normalize_source_index_order(ordered_groups),
        styles=list(candidate.styles) if candidate.styles else list(base.styles),
        metadata=dict(base.metadata) | dict(candidate.metadata),
    )
    if not sanitized.nodes:
        return _clone_graph_ir(base)
    return sanitized


def _node_positions_from_drag_payload(payload: dict[str, Any]) -> dict[str, dict[str, float]]:
    positions: dict[str, dict[str, float]] = {}
    rows = payload.get("node_positions", [])
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            node_id = str(row.get("id", "")).strip()
            if not node_id:
                continue
            try:
                positions[node_id] = {
                    "x": float(row.get("x", 0.0) or 0.0),
                    "y": float(row.get("y", 0.0) or 0.0),
                }
            except (TypeError, ValueError):
                continue
    node_id = str(payload.get("node_id", "")).strip()
    to_position = payload.get("to_position")
    if node_id and isinstance(to_position, dict):
        try:
            positions[node_id] = {
                "x": float(to_position.get("x", 0.0) or 0.0),
                "y": float(to_position.get("y", 0.0) or 0.0),
            }
        except (TypeError, ValueError):
            pass
    return positions


def _rebuild_renderer_from_graph(
    graph_ir: GraphIR,
    *,
    update_id: int,
    node_positions: dict[str, dict[str, float]] | None = None,
    previous_frames: list[RenderFrame] | None = None,
) -> tuple[IncrementalGraphRenderer, RenderFrame]:
    renderer = IncrementalGraphRenderer()
    render_ops = _renderer_operations(_graph_delta(build_empty_graph(graph_ir.graph_id, graph_ir.diagram_type), graph_ir))
    frame = renderer.apply_update(update_id, render_ops, "manual_relayout")
    if node_positions:
        for node_id, position in node_positions.items():
            if node_id not in renderer.nodes:
                continue
            renderer.nodes[node_id].x = float(position.get("x", renderer.nodes[node_id].x))
            renderer.nodes[node_id].y = float(position.get("y", renderer.nodes[node_id].y))
    if previous_frames is not None:
        frame = RenderFrame(
            frame_id=len(previous_frames) + 1,
            update_id=frame.update_id,
            node_count=frame.node_count,
            edge_count=frame.edge_count,
            touched_nodes=frame.touched_nodes,
            added_nodes=frame.added_nodes,
            added_edges=frame.added_edges,
            flicker_index=frame.flicker_index,
            mean_displacement=frame.mean_displacement,
            p95_displacement=frame.p95_displacement,
            unchanged_max_drift=frame.unchanged_max_drift,
            mental_map_score=frame.mental_map_score,
        )
        renderer.frames = [*previous_frames, frame]
        renderer.frame_id = len(renderer.frames)
    return renderer, frame


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


def _root_like_node_id(nodes: list[GraphNode]) -> str | None:
    if not nodes:
        return None
    root_tokens = ("主题", "中心", "核心", "总览", "总图", "主线", "root", "center", "theme", "overview")

    def _score(node: GraphNode) -> tuple[int, int]:
        identifier = str(node.id or "").lower()
        label = str(node.label or "")
        score_value = 0
        if identifier in {"root", "center", "center_theme"}:
            score_value += 4
        if any(token in identifier for token in ("root", "center", "theme")):
            score_value += 2
        if any(token in label for token in root_tokens):
            score_value += 3
        if int(node.source_index or 0) <= 1:
            score_value += 1
        return (score_value, -int(node.source_index or 0))

    ranked = sorted(nodes, key=_score, reverse=True)
    best = ranked[0]
    if _score(best)[0] <= 0:
        return nodes[0].id
    return best.id


def _prefix_parent_node_id(node_id: str, existing_node_ids: set[str]) -> str | None:
    parts = [part for part in str(node_id or "").split("_") if part]
    if len(parts) <= 1:
        return None
    for index in range(len(parts) - 1, 0, -1):
        candidate = "_".join(parts[:index])
        if candidate in existing_node_ids and candidate != node_id:
            return candidate
    return None


def _backfill_sparse_flow_edges(graph_ir: GraphIR) -> tuple[GraphIR, bool]:
    diagram_type = canonical_diagram_type(graph_ir.diagram_type or "")
    if graph_ir.edges or graph_ir.groups or len(graph_ir.nodes) < 2:
        return graph_ir, False

    ordered_nodes = sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id))
    existing_node_ids = {node.id for node in ordered_nodes}
    root_id = _root_like_node_id(ordered_nodes)
    if not root_id:
        return graph_ir, False

    inferred_edges: list[GraphEdge] = []
    seen_edge_ids: set[str] = set()
    next_edge_index = 1
    flow_like = diagram_type in {"flowchart", "architecture", "mindmap", "unknown"}
    for index, node in enumerate(ordered_nodes):
        if node.id == root_id:
            continue
        parent_id = _prefix_parent_node_id(node.id, existing_node_ids)
        if not parent_id:
            if flow_like or root_id != ordered_nodes[0].id:
                parent_id = root_id
            elif index > 0:
                parent_id = ordered_nodes[index - 1].id
        if not parent_id or parent_id == node.id:
            continue
        edge_id = f"edge_{parent_id}__{node.id}"
        if edge_id in seen_edge_ids:
            continue
        seen_edge_ids.add(edge_id)
        inferred_edges.append(
            GraphEdge(
                id=edge_id,
                source=parent_id,
                target=node.id,
                label="",
                kind="hierarchy",
                source_index=next_edge_index,
                metadata={"inferred": True, "source": "sparse_flow_backfill"},
            )
        )
        next_edge_index += 1

    if not inferred_edges:
        return graph_ir, False

    clone = _clone_graph_ir(graph_ir)
    clone.edges = inferred_edges
    return clone, True


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


REALTIME_LLM_TIMEOUT_SEC = 180
REALTIME_RELAYOUT_LLM_TIMEOUT_SEC = 300
REALTIME_LLM_MAX_RETRIES = 1
REALTIME_LLM_RETRY_BACKOFF_SEC = 0.5


def _parse_profile_extra_body(profile: dict[str, Any]) -> dict[str, Any]:
    raw = str(profile.get("extra_body_json", "") or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid extra_body_json for profile {profile.get('id', '')}: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"invalid extra_body_json for profile {profile.get('id', '')}: must be a JSON object")
    return parsed


def build_chat_client(profile: dict[str, Any], model: str, *, timeout_sec: int = REALTIME_LLM_TIMEOUT_SEC):
    provider_kind = str(profile.get("provider_kind", "openai_compatible") or "openai_compatible").strip()
    api_key, api_key_env = _resolve_api_key(profile)
    common_kwargs = {
        "endpoint": str(profile.get("endpoint", "")),
        "model": model,
        "api_key": api_key,
        "api_key_env": api_key_env or "OPENAI_API_KEY",
        "timeout_sec": timeout_sec,
        "max_retries": REALTIME_LLM_MAX_RETRIES,
        "retry_backoff_sec": REALTIME_LLM_RETRY_BACKOFF_SEC,
        "temperature": 0.0,
        "omit_temperature": False,
        "extra_body": _parse_profile_extra_body(profile),
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
    "Decide whether the current pending dialogue should WAIT, EMIT_UPDATE, or SWITCH_CANVAS. "
    "Judge sufficiency of the buffered turns, not whether the graph already contains the information. "
    "If pending turns introduce concrete nodes, components, actors, modules, steps, or explicit relations, prefer EMIT_UPDATE. "
    "If pending turns request concrete visual emphasis, grouping, highlighting, or Mermaid styling for existing structure, also prefer EMIT_UPDATE instead of WAIT. "
    "Use SWITCH_CANVAS when the pending turns begin a clearly new subtopic, stage, subsystem, or workflow that should continue on a fresh canvas, and the current canvas already has meaningful structure. "
    "Prefer SWITCH_CANVAS only when continuing on the current canvas would make the diagram confusing or overly crowded. "
    "Use WAIT only when the buffer is still generic, meta, or too incomplete to add stable structure. "
    "Return strict JSON only with keys: action, reason, confidence. "
    "Allowed action values: WAIT, EMIT_UPDATE, SWITCH_CANVAS."
)


LIVE_PLANNER_SYSTEM_PROMPT = (
    "You are the large planner model for a collaborative realtime diagram system. "
    "Extend the current graph monotonically using only the observed dialogue and the current GraphIR. "
    "Return one JSON object only. No markdown, no explanations, no prose before or after JSON. "
    "Required top-level keys: diagram_type, delta_ops, notes. "
    "Optional top-level keys: target_graph_ir, styles. "
    "Use these operation names only: add_group, add_node, add_edge. "
    "Never remove, rename, or rewrite existing ids. Never switch to an unrelated domain. "
    "Reuse literal identifiers from the dialogue whenever possible. "
    "Whenever the dialogue implies visual grouping, emphasis, warning states, decision nodes, or branch hierarchy, add a compact Mermaid styles list for readability. "
    "Represent Mermaid styling as raw directive lines such as classDef, class, style, or linkStyle, for example {\"line\":\"classDef primary fill:#ede9fe,stroke:#7c3aed,color:#3b0764,font-weight:bold\"}. "
    "Prefer CSS-like attributes that Mermaid accepts, such as fill, stroke, color, stroke-width, font-size, font-style, font-weight, and text-decoration. "
    "Prefer 2 to 8 style lines total, and keep them valid Mermaid syntax. "
    "If you are unsure about a full graph snapshot, you may omit target_graph_ir and return delta_ops only, but if you need to add or change styles you should include either top-level styles or target_graph_ir.styles. "
    "If target_graph_ir is provided, it must include all previously existing items and all new additions. "
    "STRUCTURAL COMPLETENESS: If you add 3 or more nodes, you should also add explicit edges or groups that explain how those nodes relate. "
    "A response with isolated nodes only and zero edges/groups is incomplete unless the dialogue is explicitly just an unordered inventory. "
    "For mind-map-like content rendered as flowchart, connect the center topic to first-level branches and connect branches to their details. "
    "DIAGRAM TYPE SELECTION: The diagram_type field is REQUIRED in every response. "
    "Analyze the dialogue content and choose the most appropriate type: "
    "- flowchart: processes, workflows, step-by-step procedures, decision trees, system architecture "
    "- sequence: actor-to-actor interactions over time, message passing, API call chains, request/response flows "
    "- statediagram: state machines, lifecycle transitions, status changes with triggers/guards "
    "- class: OOP class/struct definitions, inheritance, composition, UML class relationships "
    "- er: database entity relationships, table schemas, data modeling "
    "- requirement: requirements specification, use case traceability, functional requirements "
    "Do NOT default to flowchart unless the dialogue truly describes a generic process or workflow."
)


LIVE_RELAYOUT_SYSTEM_PROMPT = (
    "You are the large planner model for a collaborative realtime diagram editor. "
    "A user manually dragged one existing Mermaid node to a new position, and you must infer the intended structural reorganization. "
    "Return one JSON object only. No markdown, no explanations, no prose before or after JSON. "
    "Top-level keys: notes, target_graph_ir. "
    "Preserve every existing node id and group id. Do not create or delete nodes or groups. "
    "You may reorder source_index, rewire edges, change edge labels, change node parent, and update group member_ids to reflect the new meaning of the drag. "
    "Preserve existing Mermaid styles unless the new organization clearly calls for updated highlighting or grouping, and when you change styles use Mermaid-compatible attributes such as fill, stroke, color, stroke-width, font-size, font-style, font-weight, and text-decoration. "
    "Prefer the smallest coherent graph edit that explains the new spatial arrangement. "
    "If the drag does not imply a real structural change, return the current graph unchanged with a short note."
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
    diagram_type: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "delta_ops": list(self.delta_ops),
            "target_graph_ir": self.target_graph_ir.to_payload() if self.target_graph_ir else None,
            "notes": self.notes,
            "metadata": dict(self.metadata),
            "diagram_type": self.diagram_type,
        }


@dataclass
class RuntimeCanvas:
    canvas_id: str
    title: str
    diagram_type: str = "flowchart"
    graph_ir: GraphIR = field(default_factory=lambda: build_empty_graph("canvas"))
    rendered_mermaid: str = "graph TD"
    renderer: IncrementalGraphRenderer = field(default_factory=IncrementalGraphRenderer)
    created_turn_id: int = 0
    last_turn_id: int = 0
    switch_reason: str | None = None
    switch_trigger_turn_id: int | None = None
    updated_at: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_payload(self, *, is_active: bool, planner_state: dict[str, Any] | None = None) -> dict[str, Any]:
        planner_meta = planner_state if isinstance(planner_state, dict) else {}
        return {
            "canvas_id": self.canvas_id,
            "title": self.title,
            "diagram_type": self.diagram_type,
            "created_turn_id": self.created_turn_id,
            "last_turn_id": self.last_turn_id,
            "switch_reason": self.switch_reason,
            "switch_trigger_turn_id": self.switch_trigger_turn_id,
            "updated_at": self.updated_at,
            "is_active": is_active,
            "graph_ir": self.graph_ir.to_payload(),
            "graph_metrics": _graph_metrics(self.graph_ir),
            "preview_mermaid": self.rendered_mermaid,
            "mermaid_state": {
                "code": self.rendered_mermaid,
                "normalized_code": self.rendered_mermaid,
                "source": "algorithm_preview",
                "provider": str(planner_meta.get("provider") or "deterministic_algorithm_layer"),
                "model": planner_meta.get("model"),
                "latency_ms": planner_meta.get("latency_ms"),
                "compile_ok": True,
                "render_ok": True,
                "error_message": None,
                "updated_at": self.updated_at,
            },
            "renderer_state": {
                **self.renderer.export_state(),
                "groups": [group.to_payload() for group in self.graph_ir.groups],
            },
        }


def _runtime_canvas_id(session_id: str, index: int) -> str:
    return f"{session_id}::canvas_{index}"


def _runtime_canvas_title(index: int) -> str:
    return f"Canvas {index}"


def _create_runtime_canvas(
    session_id: str,
    index: int,
    *,
    diagram_type: str,
    created_turn_id: int = 0,
    last_turn_id: int = 0,
    switch_reason: str | None = None,
    switch_trigger_turn_id: int | None = None,
) -> RuntimeCanvas:
    canvas_id = _runtime_canvas_id(session_id, index)
    graph_ir = _ensure_graph_styles(build_empty_graph(canvas_id, diagram_type))
    return RuntimeCanvas(
        canvas_id=canvas_id,
        title=_runtime_canvas_title(index),
        diagram_type=diagram_type,
        graph_ir=graph_ir,
        rendered_mermaid=render_preview_mermaid(graph_ir),
        renderer=IncrementalGraphRenderer(),
        created_turn_id=created_turn_id,
        last_turn_id=last_turn_id,
        switch_reason=switch_reason,
        switch_trigger_turn_id=switch_trigger_turn_id,
    )


def _restore_runtime_canvas(
    payload: dict[str, Any],
    *,
    fallback_canvas_id: str,
    fallback_diagram_type: str,
) -> RuntimeCanvas:
    graph_payload = payload.get("graph_ir")
    if not isinstance(graph_payload, dict):
        graph_payload = {
            "graph_id": fallback_canvas_id,
            "diagram_type": str(payload.get("diagram_type", fallback_diagram_type) or fallback_diagram_type),
            "nodes": [],
            "edges": [],
            "groups": [],
            "styles": [],
            "metadata": {},
        }
    graph_ir = _ensure_graph_styles(_backfill_sparse_flow_edges(_graph_ir_from_payload(graph_payload))[0])
    renderer_payload = {"renderer_state": payload.get("renderer_state")}
    mermaid_state = payload.get("mermaid_state") if isinstance(payload.get("mermaid_state"), dict) else {}
    rendered_mermaid = render_preview_mermaid(graph_ir)
    return RuntimeCanvas(
        canvas_id=str(payload.get("canvas_id") or graph_ir.graph_id or fallback_canvas_id),
        title=str(payload.get("title") or _runtime_canvas_title(1)),
        diagram_type=graph_ir.diagram_type or fallback_diagram_type,
        graph_ir=graph_ir,
        rendered_mermaid=rendered_mermaid,
        renderer=_restore_renderer(renderer_payload, graph_ir),
        created_turn_id=int(payload.get("created_turn_id", 0) or 0),
        last_turn_id=int(payload.get("last_turn_id", 0) or 0),
        switch_reason=str(payload.get("switch_reason") or "").strip() or None,
        switch_trigger_turn_id=(
            int(payload.get("switch_trigger_turn_id", 0) or 0)
            if payload.get("switch_trigger_turn_id") is not None
            else None
        ),
        updated_at=int(payload.get("updated_at", 0) or int(time.time() * 1000)),
    )


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
    canvases: list[RuntimeCanvas] = field(default_factory=list)
    active_canvas_index: int = 0
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
        initial_canvas = _create_runtime_canvas(session_id, 1, diagram_type=diagram_type)
        return cls(
            session_id=session_id,
            diagram_type=diagram_type,
            current_graph_ir=initial_canvas.graph_ir,
            rendered_mermaid=initial_canvas.rendered_mermaid,
            renderer=initial_canvas.renderer,
            canvases=[initial_canvas],
            active_canvas_index=0,
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
        graph_ir = _ensure_graph_styles(_backfill_sparse_flow_edges(_graph_ir_from_payload(graph_payload))[0])
        runtime = cls.create(session_id, diagram_type=graph_ir.diagram_type)
        runtime.current_graph_ir = graph_ir
        runtime.rendered_mermaid = render_preview_mermaid(graph_ir)
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
        canvas_state = payload.get("canvas_state") if isinstance(payload.get("canvas_state"), dict) else {}
        canvas_rows = canvas_state.get("canvases") if isinstance(canvas_state.get("canvases"), list) else []
        if canvas_rows:
            runtime.canvases = [
                _restore_runtime_canvas(
                    item,
                    fallback_canvas_id=_runtime_canvas_id(session_id, index),
                    fallback_diagram_type=graph_ir.diagram_type,
                )
                for index, item in enumerate(canvas_rows, start=1)
                if isinstance(item, dict)
            ]
            active_canvas_id = str(canvas_state.get("active_canvas_id") or "").strip()
            if active_canvas_id:
                runtime.active_canvas_index = next(
                    (
                        index
                        for index, canvas in enumerate(runtime.canvases)
                        if canvas.canvas_id == active_canvas_id
                    ),
                    0,
                )
            else:
                runtime.active_canvas_index = min(
                    max(int(canvas_state.get("active_canvas_index", 0) or 0), 0),
                    max(len(runtime.canvases) - 1, 0),
                )
        else:
            runtime.canvases = [
                RuntimeCanvas(
                    canvas_id=graph_ir.graph_id or _runtime_canvas_id(session_id, 1),
                    title=_runtime_canvas_title(1),
                    diagram_type=graph_ir.diagram_type,
                    graph_ir=_ensure_graph_styles(_clone_graph_ir(graph_ir)),
                    rendered_mermaid=runtime.rendered_mermaid,
                    renderer=runtime.renderer,
                    created_turn_id=1 if runtime.turns else 0,
                    last_turn_id=runtime.last_consumed_turn_id,
                    updated_at=int((payload.get("mermaid_state") or {}).get("updated_at") or int(time.time() * 1000)),
                )
            ]
            runtime.active_canvas_index = 0
        runtime._sync_runtime_from_active_canvas()
        runtime.stored_evaluation = evaluation_payload if isinstance(evaluation_payload, dict) else {}
        return runtime

    def current_turns(self) -> list[DialogueTurn]:
        return list(self.turns)

    def pending_turns(self) -> list[DialogueTurn]:
        pending = set(self.pending_turn_ids)
        return [turn for turn in self.turns if turn.turn_id in pending]

    def active_canvas(self) -> RuntimeCanvas:
        if not self.canvases:
            self.canvases = [_create_runtime_canvas(self.session_id, 1, diagram_type=self.diagram_type)]
            self.active_canvas_index = 0
        self.active_canvas_index = min(max(self.active_canvas_index, 0), len(self.canvases) - 1)
        return self.canvases[self.active_canvas_index]

    def _sync_runtime_from_active_canvas(self) -> None:
        canvas = self.active_canvas()
        self.diagram_type = canvas.diagram_type or self.diagram_type
        self.current_graph_ir = _clone_graph_ir(canvas.graph_ir)
        self.rendered_mermaid = str(canvas.rendered_mermaid or render_preview_mermaid(canvas.graph_ir))
        self.renderer = canvas.renderer

    def _sync_active_canvas_from_runtime(
        self,
        *,
        last_turn_id: int | None = None,
        updated_at: int | None = None,
    ) -> None:
        canvas = self.active_canvas()
        canvas.diagram_type = self.diagram_type or canvas.diagram_type
        canvas.graph_ir = _clone_graph_ir(self.current_graph_ir)
        canvas.rendered_mermaid = str(self.rendered_mermaid or render_preview_mermaid(self.current_graph_ir))
        canvas.renderer = self.renderer
        if last_turn_id is not None:
            canvas.last_turn_id = int(last_turn_id)
        if updated_at is not None:
            canvas.updated_at = int(updated_at)

    def _canvas_prompt_summary(self) -> dict[str, Any]:
        self._sync_active_canvas_from_runtime(last_turn_id=self.last_consumed_turn_id)
        active_canvas = self.active_canvas()
        return {
            "active_canvas_id": active_canvas.canvas_id,
            "active_canvas_index": self.active_canvas_index,
            "canvas_count": len(self.canvases),
            "canvases": [
                {
                    "canvas_id": canvas.canvas_id,
                    "title": canvas.title,
                    "diagram_type": canvas.diagram_type,
                    "created_turn_id": canvas.created_turn_id,
                    "last_turn_id": canvas.last_turn_id,
                    "switch_reason": canvas.switch_reason,
                    "switch_trigger_turn_id": canvas.switch_trigger_turn_id,
                    "graph_metrics": _graph_metrics(canvas.graph_ir),
                    "is_active": canvas.canvas_id == active_canvas.canvas_id,
                }
                for canvas in self.canvases
            ],
        }

    def _should_shortcut_manual_transcript_gate(self) -> bool:
        if len(self.canvases) > 1:
            return False
        if self.update_index > 0 or self.events:
            return False
        return not (
            self.current_graph_ir.nodes
            or self.current_graph_ir.edges
            or self.current_graph_ir.groups
        )

    def _switch_to_new_canvas(
        self,
        pending_turns: list[DialogueTurn],
        gate_decision: GateDecision,
    ) -> dict[str, Any]:
        previous_canvas = self.active_canvas()
        previous_canvas_index = self.active_canvas_index
        self._sync_active_canvas_from_runtime(last_turn_id=self.last_consumed_turn_id)
        next_index = len(self.canvases) + 1
        next_canvas = _create_runtime_canvas(
            self.session_id,
            next_index,
            diagram_type=self.diagram_type,
            created_turn_id=pending_turns[0].turn_id if pending_turns else 0,
            last_turn_id=self.last_consumed_turn_id,
            switch_reason=gate_decision.reason,
            switch_trigger_turn_id=pending_turns[0].turn_id if pending_turns else None,
        )
        self.canvases.append(next_canvas)
        self.active_canvas_index = len(self.canvases) - 1
        self._sync_runtime_from_active_canvas()
        _log_coordination_event(
            "Canvas switch applied",
            {
                "session_id": self.session_id,
                "previous_canvas_id": previous_canvas.canvas_id,
                "next_canvas_id": next_canvas.canvas_id,
                "canvas_count": len(self.canvases),
                "trigger_turn_ids": [turn.turn_id for turn in pending_turns],
                "reason": gate_decision.reason,
            },
        )
        return {
            "previous_canvas_id": previous_canvas.canvas_id,
            "previous_canvas_index": previous_canvas_index,
            "active_canvas_id": next_canvas.canvas_id,
            "active_canvas_index": self.active_canvas_index,
            "canvas_count": len(self.canvases),
            "switch_reason": gate_decision.reason,
            "switch_trigger_turn_id": pending_turns[0].turn_id if pending_turns else None,
        }

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
        if gate_decision.action == "WAIT":
            return []
        canvas_transition = None
        if gate_decision.action == "SWITCH_CANVAS":
            canvas_transition = self._switch_to_new_canvas(pending_turns, gate_decision)

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
        # Apply diagram_type suggestion from planner if provided
        if planner_decision.diagram_type:
            self.diagram_type = planner_decision.diagram_type
            next_graph.diagram_type = planner_decision.diagram_type
            _log_coordination_event(
                "Diagram type updated by planner",
                {
                    "session_id": self.session_id,
                    "new_diagram_type": self.diagram_type,
                    "suggested_by_planner": True,
                },
            )

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
            self._sync_active_canvas_from_runtime(
                last_turn_id=self.last_consumed_turn_id,
                updated_at=int(time.time() * 1000),
            )
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
        next_graph = _ensure_graph_styles(next_graph)
        self.current_graph_ir = next_graph
        self.rendered_mermaid = render_preview_mermaid(next_graph)
        now_ms = int(time.time() * 1000)
        self._sync_active_canvas_from_runtime(
            last_turn_id=self.last_consumed_turn_id,
            updated_at=now_ms,
        )

        planner_latency = float(planner_decision.metadata.get("latency_ms") or 0.0)
        gate_latency = float(gate_decision.metadata.get("latency_ms") or 0.0)
        e2e_ms = round(gate_latency + planner_latency + render_ms, 4)
        self.e2e_latency_ms.append(e2e_ms)
        active_canvas = self.active_canvas()

        event = {
            "update": {
                "update_id": self.update_index,
                "intent_type": "emit_update",
                "semantic_action": "emit_update",
                "canvas_id": active_canvas.canvas_id,
                "canvas_index": self.active_canvas_index,
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
        if canvas_transition:
            event["canvas_transition"] = canvas_transition
        self.events.append(event)
        _log_coordination_event(
            "Coordination update emitted",
            {
                "session_id": self.session_id,
                "update_index": self.update_index,
                "active_canvas_id": active_canvas.canvas_id,
                "canvas_count": len(self.canvases),
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
        if (
            input_source == "transcript"
            and capture_mode == "manual_text"
            and pending_turns
            and self._should_shortcut_manual_transcript_gate()
        ):
            # Check if the pending turns suggest switching to a new canvas
            switch_keywords = (
                "切换", "新画布", "新图", "分开", "单独", "另一张",
                "第二个", "第二个图", "下一张", "另外", "另一个",
                "切换到", "新canvas", "新 canvas",
            )
            combined_text = " ".join(turn.content.lower() for turn in pending_turns)
            should_switch = any(kw in combined_text for kw in switch_keywords)
            action = "SWITCH_CANVAS" if should_switch else "EMIT_UPDATE"
            reason = (
                "对话内容明确建议切换到新画布。" if should_switch
                else "手动 transcript 批量输入默认直接触发结构更新。"
            )
            decision = GateDecision(
                action=action,
                reason=reason,
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
                "debug": {"force_emit": force_emit, "shortcut": "manual_transcript_batch", "switch_intent": should_switch},
            }
            _log_coordination_event(
                "Gate shortcut applied",
                {
                    "session_id": self.session_id,
                    "input_source": input_source,
                    "capture_mode": capture_mode,
                    "pending_turn_ids": [turn.turn_id for turn in pending_turns],
                    "switch_intent": should_switch,
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
            last_result_text = ""
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
                            "canvas_state": self._canvas_prompt_summary(),
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
            last_result_text = result.text or ""
            payload = _parse_json_object(result.text)
            action = _coerce_gate_action(payload.get("action", "WAIT"))
            if force_emit and action == "WAIT":
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
                    "usage": result.usage,
                    "llm_response_text": _llm_log_text(last_result_text),
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
                        "llm_response_text": _llm_log_text(locals().get("last_result_text", "")),
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
                    "llm_response_text": _llm_log_text(locals().get("last_result_text", "")),
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
        client = build_chat_client(profile, model, timeout_sec=REALTIME_RELAYOUT_LLM_TIMEOUT_SEC)
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
                        "canvas_state": self._canvas_prompt_summary(),
                        "pending_turns": [_dialogue_payload(turn) for turn in pending_turns],
                        "recent_turns": [_dialogue_payload(turn) for turn in self.turns[-24:]],
                        "recent_dialogue_snapshot": _build_recent_dialogue_snapshot(self.turns[-24:]),
                        "identifier_candidates": list(_extract_identifier_candidates(self.turns).values())[:24],
                        "diagram_type_priors": _diagram_type_alignment_priors(self.diagram_type),
                        "current_graph_ir": self.current_graph_ir.to_payload(),
                        "current_graph_metrics": _graph_metrics(self.current_graph_ir),
                        "output_contract": {
                            "diagram_type": "REQUIRED: one of flowchart, sequence, statediagram, class, er, requirement — always include based on dialogue content",
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
                            "styles": [
                                {
                                    "line": "optional Mermaid style directive such as classDef/class/style/linkStyle",
                                }
                            ],
                            "notes": "short string",
                            "target_graph_ir": "optional full graph object, including styles when available",
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
                style_entries = _coerce_style_entries(payload.get("styles"))
                target_graph_ir = None
                if isinstance(raw_graph_payload, dict) and raw_graph_payload:
                    target_graph_ir = _graph_ir_from_payload(raw_graph_payload)
                    if style_entries and not target_graph_ir.styles:
                        target_graph_ir.styles = list(style_entries)
                    target_graph_ir = _refine_graph_ir(sample_hint, self.turns, target_graph_ir)
                elif style_entries:
                    target_graph_ir = _clone_graph_ir(self.current_graph_ir)
                    target_graph_ir.styles = list(style_entries)
                delta_ops = _refine_delta_ops(sample_hint, self.turns, state_hint, _coerce_delta_ops(payload))
                if not delta_ops and target_graph_ir is None and _has_delta_ops_field(payload):
                    target_graph_ir = _clone_graph_ir(self.current_graph_ir)
                if not delta_ops and target_graph_ir is None:
                    raise ValueError("planner returned neither delta_ops nor target_graph_ir")
                # Extract diagram_type suggestion from planner response
                suggested_diagram_type = payload.get("diagram_type")
                if suggested_diagram_type and isinstance(suggested_diagram_type, str):
                    validated_type = canonical_diagram_type(suggested_diagram_type)
                    if validated_type not in ("unknown", ""):
                        suggested_diagram_type = validated_type
                    else:
                        suggested_diagram_type = None
                else:
                    suggested_diagram_type = None
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
                    diagram_type=suggested_diagram_type,
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
                        "usage": result.usage,
                        "llm_response_text": _llm_log_text(last_result_text),
                    },
                )
                return decision
            except Exception as exc:
                last_error = exc
                _log_coordination_event(
                    "Planner request parse failed",
                    {
                        "session_id": self.session_id,
                        "provider": str(profile.get("id", "")),
                        "model": model,
                        "semantic_attempt": attempt + 1,
                        "error": str(exc),
                        "llm_response_text": _llm_log_text(last_result_text),
                    },
                )
                if attempt >= 1:
                    preview = strip_think_traces(last_result_text).strip().replace("\n", " ")[:300]
                    raise RuntimeError(f"{exc}; raw_preview={preview}") from exc
                current_messages = [
                    *base_messages,
                    {"role": "assistant", "content": strip_think_traces(result.text or "")[:4000]},
                    {"role": "user", "content": _repair_prompt(exc)},
                ]

        raise RuntimeError(str(last_error) if last_error else "planner failed without an explicit error")

    def _plan_relayout(
        self,
        db: Session,
        session_obj: RealtimeSession,
        drag_payload: dict[str, Any],
    ) -> PlannerDecision:
        runtime_options = _current_runtime_options(session_obj)
        profile = resolve_profile(db, "planner", runtime_options.get("planner_profile_id"))
        model = str(runtime_options.get("planner_model") or (profile or {}).get("default_model") or "")
        if not profile or not model:
            raise RuntimeError("鏈厤缃彲鐢ㄧ殑 Planner profile / model銆?")

        _log_coordination_event(
            "Diagram relayout request started",
            {
                "session_id": self.session_id,
                "provider": str(profile.get("id", "")),
                "model": model,
                "node_id": str(drag_payload.get("node_id", "")),
                "relation_hint": str(drag_payload.get("relation_hint", "")),
            },
        )
        client = build_chat_client(profile, model)
        sample_hint = SimpleNamespace(sample_id=self.session_id, diagram_type=self.diagram_type)
        base_messages = [
            {"role": "system", "content": LIVE_RELAYOUT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "session_id": self.session_id,
                        "diagram_type": self.diagram_type,
                        "canvas_state": self._canvas_prompt_summary(),
                        "recent_turns": [_dialogue_payload(turn) for turn in self.turns[-24:]],
                        "current_graph_ir": self.current_graph_ir.to_payload(),
                        "current_graph_metrics": _graph_metrics(self.current_graph_ir),
                        "current_mermaid_preview": self.rendered_mermaid,
                        "manual_relayout_intent": drag_payload,
                        "output_contract": {
                            "notes": "short string",
                            "styles": [
                                {
                                    "line": "optional Mermaid style directive such as classDef/class/style/linkStyle",
                                }
                            ],
                            "target_graph_ir": {
                                "graph_id": self.current_graph_ir.graph_id,
                                "diagram_type": self.current_graph_ir.diagram_type,
                                "nodes": "full list with every existing node id",
                                "edges": "full list after rewiring",
                                "groups": "full list with every existing group id",
                                "styles": "optional Mermaid style directives",
                            },
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
                if not isinstance(raw_graph_payload, dict) or not raw_graph_payload:
                    raise ValueError("relayout planner returned no target_graph_ir")
                target_graph_ir = _graph_ir_from_payload(raw_graph_payload)
                style_entries = _coerce_style_entries(payload.get("styles"))
                if style_entries and not target_graph_ir.styles:
                    target_graph_ir.styles = list(style_entries)
                target_graph_ir = _refine_graph_ir(sample_hint, self.turns, target_graph_ir)
                decision = PlannerDecision(
                    target_graph_ir=target_graph_ir,
                    notes=str(payload.get("notes", "")).strip(),
                    metadata={
                        "provider": str(profile.get("id", "")),
                        "model_name": model,
                        "latency_ms": result.latency_ms,
                        "usage": result.usage,
                        "semantic_attempt": attempt + 1,
                        "raw_text_preview": (result.text or "")[:400],
                        "manual_relayout": True,
                    },
                )
                self.planner_latency_ms.append(float(result.latency_ms))
                _log_coordination_event(
                    "Diagram relayout request succeeded",
                    {
                        "session_id": self.session_id,
                        "provider": str(profile.get("id", "")),
                        "model": model,
                        "latency_ms": result.latency_ms,
                        "semantic_attempt": attempt + 1,
                        "usage": result.usage,
                        "llm_response_text": _llm_log_text(last_result_text),
                    },
                )
                return decision
            except Exception as exc:
                last_error = exc
                _log_coordination_event(
                    "Diagram relayout parse failed",
                    {
                        "session_id": self.session_id,
                        "provider": str(profile.get("id", "")),
                        "model": model,
                        "semantic_attempt": attempt + 1,
                        "error": str(exc),
                        "llm_response_text": _llm_log_text(last_result_text),
                    },
                )
                if attempt >= 1:
                    preview = strip_think_traces(last_result_text).strip().replace("\n", " ")[:300]
                    raise RuntimeError(f"{exc}; raw_preview={preview}") from exc
                current_messages = [
                    *base_messages,
                    {"role": "assistant", "content": strip_think_traces(result.text or "")[:4000]},
                    {"role": "user", "content": _repair_prompt(exc)},
                ]

        raise RuntimeError(str(last_error) if last_error else "relayout planner failed without an explicit error")

    def relayout_from_drag(
        self,
        db: Session,
        session_obj: RealtimeSession,
        drag_payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        if self.read_only:
            raise RuntimeError("legacy realtime sessions are read-only and cannot apply manual relayout")

        base_graph = _clone_graph_ir(self.current_graph_ir)
        try:
            planner_decision = self._plan_relayout(db, session_obj, drag_payload)
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
                "Diagram relayout failed",
                {
                    "session_id": self.session_id,
                    "error": str(exc),
                    "drag_payload": drag_payload,
                },
            )
            raise

        next_graph = _sanitize_relayout_graph_ir(base_graph, planner_decision.target_graph_ir or base_graph)
        graph_changed = _graph_payload_signature(base_graph) != _graph_payload_signature(next_graph)
        self.gate_state = {
            "status": "success",
            "last_action": "EMIT_UPDATE",
            "reason": "manual Mermaid node drag requested a planner relayout",
            "confidence": 1.0,
            "provider": "manual_drag_intent",
            "model": "manual_drag_intent",
            "latency_ms": 0.0,
            "updated_at": int(time.time() * 1000),
            "error_message": None,
        }

        if not graph_changed:
            self.planner_noop_count += 1
            self.planner_state = {
                "status": "success",
                "provider": planner_decision.metadata.get("provider", ""),
                "model": planner_decision.metadata.get("model_name", ""),
                "latency_ms": float(planner_decision.metadata.get("latency_ms") or 0.0),
                "delta_ops_count": 0,
                "graph_changed": False,
                "notes": planner_decision.notes,
                "updated_at": int(time.time() * 1000),
                "error_message": None,
                "debug": {
                    "semantic_attempt": planner_decision.metadata.get("semantic_attempt"),
                    "raw_text_preview": planner_decision.metadata.get("raw_text_preview"),
                    "usage": planner_decision.metadata.get("usage"),
                    "manual_relayout": True,
                },
            }
            return None

        self.update_index += 1
        render_t0 = time.time()
        node_positions = _node_positions_from_drag_payload(drag_payload)
        previous_frames = list(self.renderer.frames)
        self.renderer, frame = _rebuild_renderer_from_graph(
            next_graph,
            update_id=self.update_index,
            node_positions=node_positions,
            previous_frames=previous_frames,
        )
        render_ms = round((time.time() - render_t0) * 1000.0, 4)
        self.render_latency_ms.append(render_ms)
        next_graph = _ensure_graph_styles(next_graph)
        self.current_graph_ir = next_graph
        self.rendered_mermaid = render_preview_mermaid(next_graph)
        now_ms = int(time.time() * 1000)
        self._sync_active_canvas_from_runtime(
            last_turn_id=self.last_consumed_turn_id,
            updated_at=now_ms,
        )

        planner_latency = float(planner_decision.metadata.get("latency_ms") or 0.0)
        e2e_ms = round(planner_latency + render_ms, 4)
        self.e2e_latency_ms.append(e2e_ms)
        focus_entities = [
            item
            for item in (
                str(drag_payload.get("node_id", "")).strip(),
                str(drag_payload.get("nearest_anchor_id", "")).strip(),
                str(drag_payload.get("target_group_id", "")).strip(),
            )
            if item
        ]
        now_ms = int(time.time() * 1000)
        event = {
            "update": {
                "update_id": self.update_index,
                "intent_type": "manual_relayout",
                "semantic_action": "manual_relayout",
                "canvas_id": self.active_canvas().canvas_id,
                "canvas_index": self.active_canvas_index,
                "operations": [],
                "focus_entities": focus_entities,
                "annotations": [
                    value
                    for value in (
                        planner_decision.notes,
                        str(drag_payload.get("spatial_summary", "")).strip(),
                    )
                    if value
                ],
                "transcript_text": "",
                "start_ms": now_ms,
                "end_ms": now_ms,
                "processing_latency_ms": planner_latency,
                "manual_relayout": drag_payload,
            },
            "gate": GateDecision(
                action="EMIT_UPDATE",
                reason="manual Mermaid node drag requested a planner relayout",
                confidence=1.0,
                metadata={
                    "provider": "manual_drag_intent",
                    "model_name": "manual_drag_intent",
                    "latency_ms": 0.0,
                },
            ).to_payload(),
            "planner": planner_decision.to_payload(),
            "pending_turns": [],
            "graph_before": _graph_metrics(base_graph),
            "graph_after": _graph_metrics(next_graph),
            "render_frame": asdict(frame),
            "gold_intent": None,
            "intent_correct": None,
            "render_latency_ms": render_ms,
            "e2e_latency_ms": e2e_ms,
        }
        self.events.append(event)
        self.planner_state = {
            "status": "success",
            "provider": planner_decision.metadata.get("provider", ""),
            "model": planner_decision.metadata.get("model_name", ""),
            "latency_ms": planner_latency,
            "delta_ops_count": len(_graph_delta(base_graph, next_graph)),
            "graph_changed": True,
            "notes": planner_decision.notes,
            "updated_at": int(time.time() * 1000),
            "error_message": None,
            "debug": {
                "semantic_attempt": planner_decision.metadata.get("semantic_attempt"),
                "raw_text_preview": planner_decision.metadata.get("raw_text_preview"),
                "usage": planner_decision.metadata.get("usage"),
                "manual_relayout": True,
            },
        }
        _log_coordination_event(
            "Diagram relayout applied",
            {
                "session_id": self.session_id,
                "update_index": self.update_index,
                "planner_latency_ms": planner_latency,
                "render_latency_ms": render_ms,
                "graph_before": _graph_metrics(base_graph),
                "graph_after": _graph_metrics(next_graph),
                "focus_entities": focus_entities,
            },
        )
        return event

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

        target_graph, backfilled_sparse_edges = _backfill_sparse_flow_edges(target_graph)
        if backfilled_sparse_edges:
            _log_coordination_event(
                "Backfilled sparse flow edges",
                {
                    "session_id": self.session_id,
                    "node_count": len(target_graph.nodes),
                    "edge_count": len(target_graph.edges),
                    "diagram_type": target_graph.diagram_type,
                },
            )

        effective_delta = (
            _graph_delta(base_graph, target_graph)
            if backfilled_sparse_edges or not planner_decision.delta_ops
            else planner_decision.delta_ops
        )
        graph_changed = _graph_payload_signature(base_graph) != _graph_payload_signature(target_graph)
        return target_graph, effective_delta, graph_changed

    def pipeline_payload(self) -> dict[str, Any]:
        if self.read_only and self.stored_pipeline is not None:
            return dict(self.stored_pipeline)
        self._sync_active_canvas_from_runtime(last_turn_id=self.last_consumed_turn_id)
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
                "active_canvas_index": self.active_canvas_index,
                "canvas_count": len(self.canvases),
            },
            "gate_state": dict(self.gate_state),
            "planner_state": dict(self.planner_state),
            "canvas_state": {
                "active_canvas_id": self.active_canvas().canvas_id,
                "active_canvas_index": self.active_canvas_index,
                "canvas_count": len(self.canvases),
                "canvases": [
                    canvas.to_payload(
                        is_active=index == self.active_canvas_index,
                        planner_state=self.planner_state if index == self.active_canvas_index else None,
                    )
                    for index, canvas in enumerate(self.canvases)
                ],
            },
            "graph_state": {
                "diagram_type": self.diagram_type,
                "update_index": self.update_index,
                "current_graph_ir": self.current_graph_ir.to_payload(),
                "graph_metrics": graph_metrics,
                "preview_mermaid": self.rendered_mermaid,
                "active_canvas_id": self.active_canvas().canvas_id,
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
    merged = dict(options) if isinstance(options, dict) else {}
    input_runtime = snapshot.get("input_runtime", {})
    if isinstance(input_runtime, dict):
        for key in (
            "gate_profile_id",
            "gate_model",
            "planner_profile_id",
            "planner_model",
            "stt_profile_id",
            "stt_model",
            "llm_profile_id",
            "llm_model",
        ):
            value = input_runtime.get(key)
            if isinstance(value, str) and value.strip():
                merged[key] = value.strip()
    return normalize_runtime_options(merged)


def _current_input_runtime(session_obj: RealtimeSession) -> dict[str, Any]:
    snapshot = session_obj.config_snapshot if isinstance(session_obj.config_snapshot, dict) else {}
    payload = snapshot.get("input_runtime", {})
    return payload if isinstance(payload, dict) else {}
