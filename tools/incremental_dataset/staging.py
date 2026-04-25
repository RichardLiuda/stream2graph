from __future__ import annotations

import math
import re
from collections import Counter, defaultdict, deque

from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode, StageState


STAGE_NAMES = {
    1: "Bootstrap Core",
    2: "Expand Main Branches",
    3: "Add Supporting Structure",
    4: "Resolve Conditions",
    5: "Finalize Surface Details",
}

MERMAID_STYLE_RE = re.compile(r"^\s*(classDef|class|style|linkStyle)\b", flags=re.IGNORECASE)
MERMAID_INIT_RE = re.compile(r"^\s*%%\s*\{init:", flags=re.IGNORECASE)
MERMAID_RESERVED_IDENTIFIERS = {
    "end",
    "subgraph",
    "class",
    "classdef",
    "style",
    "linkstyle",
    "click",
    "graph",
    "flowchart",
}
DEFAULT_LANE_COLORS = (
    "#eff6ff",
    "#fef3c7",
    "#ecfccb",
    "#fce7f3",
    "#ede9fe",
    "#cffafe",
)
VALID_ARGUMENT_ROLES = {"claim", "evidence", "counter", "summary", "question"}
VALID_RELATION_TYPES = {"support", "attack", "reply", "elaborate", "reference"}
FLOWCHART_CANONICAL_TYPES = {"flowchart", "architecture", "mindmap", "unknown"}


def _escape_label(label: str) -> str:
    return (label or "").replace('"', "'")


def _has_cycle_to_root(group_id: str, groups_by_id: dict[str, GraphGroup], visited: set[str]) -> bool:
    """Check if following parent chain from group_id creates a cycle back to any visited node."""
    if group_id in visited:
        return True  # Found a cycle back to an ancestor
    visited.add(group_id)
    group = groups_by_id.get(group_id)
    if group and group.parent:
        return _has_cycle_to_root(group.parent, groups_by_id, visited)
    return False


def _fix_group_parent_cycles(graph_ir: GraphIR) -> GraphIR:
    """Fix cyclic group parent references by breaking self-referencing and circular chains."""
    if not graph_ir.groups:
        return graph_ir

    groups_by_id = {group.id: group for group in graph_ir.groups}

    # Find groups with invalid parent references (self-reference or circular chains)
    fixed_groups: list[GraphGroup] = []

    for group in graph_ir.groups:
        parent = group.parent
        if parent is not None:
            # Check for self-reference
            if parent == group.id:
                parent = None
            # Check if parent exists
            elif parent not in groups_by_id:
                parent = None
            # Check for cycles in parent chain (e.g., g1->g2->g1)
            else:
                visited: set[str] = set()
                if _has_cycle_to_root(parent, groups_by_id, visited):
                    parent = None

        fixed_groups.append(
            GraphGroup(
                id=group.id,
                label=group.label,
                parent=parent,
                member_ids=list(group.member_ids),
                source_index=group.source_index,
                metadata=dict(group.metadata),
            )
        )

    return GraphIR(
        graph_id=graph_ir.graph_id,
        diagram_type=graph_ir.diagram_type,
        nodes=list(graph_ir.nodes),
        edges=list(graph_ir.edges),
        groups=fixed_groups,
        styles=list(graph_ir.styles),
        metadata=dict(graph_ir.metadata),
    )


def _style_line_from_entry(entry: object) -> tuple[str, str] | None:
    raw_line = ""
    if isinstance(entry, str):
        raw_line = entry.strip()
    elif isinstance(entry, dict):
        raw_line = str(entry.get("line") or entry.get("statement") or entry.get("raw") or "").strip()
        if not raw_line:
            kind = str(entry.get("kind") or "").strip().lower()
            if kind == "style":
                target = str(entry.get("target") or "").strip()
                attrs = str(entry.get("attributes") or entry.get("css") or entry.get("value") or "").strip()
                if target and attrs:
                    raw_line = f"style {target} {attrs}"
            elif kind == "classdef":
                name = str(entry.get("name") or entry.get("class_name") or "").strip()
                attrs = str(entry.get("attributes") or entry.get("css") or entry.get("value") or "").strip()
                if name and attrs:
                    raw_line = f"classDef {name} {attrs}"
            elif kind == "class":
                targets = entry.get("targets")
                if isinstance(targets, list):
                    target_text = ",".join(str(item).strip() for item in targets if str(item).strip())
                else:
                    target_text = str(entry.get("target") or "").strip()
                class_name = str(entry.get("name") or entry.get("class_name") or entry.get("value") or "").strip()
                if target_text and class_name:
                    raw_line = f"class {target_text} {class_name}"
            elif kind == "linkstyle":
                index = str(entry.get("index") or entry.get("target") or "").strip()
                attrs = str(entry.get("attributes") or entry.get("css") or entry.get("value") or "").strip()
                if index and attrs:
                    raw_line = f"linkStyle {index} {attrs}"
    if not raw_line:
        return None
    if MERMAID_INIT_RE.match(raw_line):
        return ("init", raw_line)
    if MERMAID_STYLE_RE.match(raw_line):
        return ("style", raw_line)
    return None


def _safe_mermaid_identifier(raw: str, fallback: str, seen: set[str]) -> str:
    value = re.sub(r"[^A-Za-z0-9_]+", "_", str(raw or "").strip())
    value = re.sub(r"_+", "_", value).strip("_")
    if not value:
        value = fallback
    if not re.match(r"^[A-Za-z]", value):
        value = f"{fallback}_{value}"
    if value.lower() in MERMAID_RESERVED_IDENTIFIERS:
        value = f"{fallback}_{value}"
    value = value[:64].strip("_") or fallback

    candidate = value
    suffix = 2
    while candidate in seen:
        suffix_text = f"_{suffix}"
        candidate = f"{value[: max(1, 64 - len(suffix_text))]}{suffix_text}"
        suffix += 1
    seen.add(candidate)
    return candidate


def _standalone_mermaid_identifier(raw: str, fallback: str) -> str:
    return _safe_mermaid_identifier(raw, fallback, set())


def _build_mermaid_identifier_maps(graph_ir: GraphIR) -> tuple[dict[str, str], dict[str, str]]:
    seen: set[str] = set()
    entity_ids: dict[str, str] = {}

    for index, group in enumerate(sorted(graph_ir.groups, key=lambda item: (item.source_index, item.id)), start=1):
        entity_ids[group.id] = _safe_mermaid_identifier(group.id, f"group_{index}", seen)
    for index, node in enumerate(sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)), start=1):
        entity_ids[node.id] = _safe_mermaid_identifier(node.id, f"node_{index}", seen)

    alias_ids: dict[str, str] = {}
    for original, safe in entity_ids.items():
        alias_ids[original] = safe
        alias_ids[safe] = safe
        alias_ids.setdefault(f"node_{original}", safe)
        alias_ids.setdefault(f"group_{original}", safe)
    return entity_ids, alias_ids


def _build_mermaid_class_name_map(style_lines: list[str]) -> tuple[dict[str, str], set[str]]:
    seen: set[str] = set()
    class_names: dict[str, str] = {}
    for raw_line in style_lines:
        compact = " ".join(str(raw_line or "").strip().split())
        match = re.match(r"(?i)^classDef\s+(\S+)\s+(.+)$", compact)
        if not match:
            continue
        raw_name = match.group(1).strip()
        if raw_name and raw_name not in class_names:
            class_names[raw_name] = _safe_mermaid_identifier(raw_name, "class", seen)
    return class_names, seen


def _rewrite_mermaid_style_line(
    raw_line: str,
    entity_aliases: dict[str, str],
    class_names: dict[str, str],
    seen_class_names: set[str],
) -> str:
    compact = " ".join(str(raw_line or "").strip().split())
    if not compact:
        return ""
    lowered = compact.lower()
    if MERMAID_INIT_RE.match(compact):
        return compact
    if lowered.startswith("classdef "):
        match = re.match(r"(?i)^classDef\s+(\S+)\s+(.+)$", compact)
        if not match:
            return compact
        raw_name = match.group(1).strip()
        attrs = match.group(2).strip()
        safe_name = class_names.setdefault(raw_name, _safe_mermaid_identifier(raw_name, "class", seen_class_names))
        return f"classDef {safe_name} {attrs}"
    if lowered.startswith("class "):
        match = re.match(r"(?i)^class\s+(.+?)\s+(\S+)$", compact)
        if not match:
            return compact
        raw_targets = match.group(1).strip()
        raw_name = match.group(2).strip()
        targets: list[str] = []
        for token in re.split(r"[\s,]+", raw_targets):
            candidate = token.strip()
            if not candidate:
                continue
            targets.append(entity_aliases.get(candidate, _standalone_mermaid_identifier(candidate, "id")))
        if not targets:
            return ""
        safe_names: list[str] = []
        for token in raw_name.split(","):
            class_token = token.strip()
            if not class_token:
                continue
            safe_names.append(
                class_names.setdefault(class_token, _safe_mermaid_identifier(class_token, "class", seen_class_names))
            )
        if not safe_names:
            return ""
        return f"class {','.join(dict.fromkeys(targets))} {','.join(dict.fromkeys(safe_names))}"
    if lowered.startswith("style "):
        match = re.match(r"(?i)^style\s+(\S+)\s+(.+)$", compact)
        if not match:
            return compact
        raw_target = match.group(1).strip()
        attrs = match.group(2).strip()
        safe_target = entity_aliases.get(raw_target, _standalone_mermaid_identifier(raw_target, "id"))
        return f"style {safe_target} {attrs}"
    return compact


def _extract_mermaid_style_lines(graph_ir: GraphIR) -> tuple[list[str], list[str]]:
    init_lines: list[str] = []
    style_lines: list[str] = []
    seen_init: set[str] = set()
    seen_style: set[str] = set()
    for entry in graph_ir.styles:
        parsed = _style_line_from_entry(entry)
        if parsed is None:
            continue
        bucket, line = parsed
        if bucket == "init":
            if line not in seen_init:
                seen_init.add(line)
                init_lines.append(line)
            continue
        if line not in seen_style:
            seen_style.add(line)
            style_lines.append(line)
    return init_lines, style_lines


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


def _metadata_int(metadata: dict[str, object], key: str, default: int) -> int:
    value = metadata.get(key)
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _metadata_bool(metadata: dict[str, object], key: str, default: bool) -> bool:
    value = metadata.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def _canonical_diagram_type(diagram_type: str | None) -> str:
    lowered = str(diagram_type or "flowchart").strip().lower()
    if lowered in {"flowchart", "graph"}:
        return "flowchart"
    if lowered in {"architecture-beta", "architecture"}:
        return "architecture"
    if lowered.startswith("mindmap"):
        return "mindmap"
    return lowered or "unknown"


def _infer_argument_role(node: GraphNode) -> str:
    metadata = dict(node.metadata)
    explicit = str(metadata.get("argument_role") or "").strip().lower()
    if explicit in VALID_ARGUMENT_ROLES:
        return explicit
    kind = str(node.kind or "").strip().lower()
    if kind in VALID_ARGUMENT_ROLES:
        return kind
    label = str(node.label or "")
    if any(token in label for token in ("?", "？", "问题", "提问")):
        return "question"
    if any(token in label for token in ("总结", "结论", "summary")):
        return "summary"
    if any(token in label for token in ("反驳", "质疑", "counter")):
        return "counter"
    if any(token in label for token in ("证据", "依据", "evidence")):
        return "evidence"
    return "claim"


def _infer_relation_type(edge: GraphEdge) -> str:
    metadata = dict(edge.metadata)
    explicit = str(metadata.get("relation_type") or "").strip().lower()
    if explicit in VALID_RELATION_TYPES:
        return explicit
    kind = str(edge.kind or "").strip().lower()
    if kind in VALID_RELATION_TYPES:
        return kind
    label = str(edge.label or "").lower()
    if any(token in label for token in ("反驳", "驳斥", "质疑", "attack", "oppose")):
        return "attack"
    if any(token in label for token in ("支持", "赞同", "support", "agree")):
        return "support"
    if any(token in label for token in ("展开", "补充", "说明", "elaborate")):
        return "elaborate"
    if any(token in label for token in ("引用", "参考", "reference")):
        return "reference"
    return "reply"


def _lane_group_order_key(group: GraphGroup) -> tuple[int, int, str]:
    metadata = dict(group.metadata)
    return (
        _metadata_int(metadata, "lane_index", int(group.source_index or 0)),
        int(group.source_index or 0),
        group.id,
    )


def _node_turn_order_key(node: GraphNode) -> tuple[int, int, str]:
    metadata = dict(node.metadata)
    return (
        _metadata_int(metadata, "turn_index", int(node.source_index or 0)),
        int(node.source_index or 0),
        node.id,
    )


def _lane_mode_enabled(graph_ir: GraphIR, *, force_lane_view: bool) -> bool:
    metadata = dict(graph_ir.metadata)
    if str(metadata.get("view_mode") or "").strip() == "debate_lane_flowchart":
        return True
    if any(str(group.metadata.get("group_type") or "").strip() == "speaker_lane" for group in graph_ir.groups):
        return True
    if any(node.metadata.get("speaker_id") or node.metadata.get("lane_id") for node in graph_ir.nodes):
        return True
    if not force_lane_view:
        return False
    top_level_groups = [group for group in graph_ir.groups if not group.parent]
    return _canonical_diagram_type(graph_ir.diagram_type) in FLOWCHART_CANONICAL_TYPES and len(top_level_groups) >= 2


def prepare_graph_for_mermaid_display(graph_ir: GraphIR, *, force_lane_view: bool = False) -> GraphIR:
    prepared = _fix_group_parent_cycles(_clone_graph_ir(graph_ir))
    lane_mode = _lane_mode_enabled(prepared, force_lane_view=force_lane_view)
    top_level_groups = sorted([group for group in prepared.groups if not group.parent], key=_lane_group_order_key)
    lane_groups: list[GraphGroup] = []
    if lane_mode:
        explicit_lane_groups = [group for group in top_level_groups if str(group.metadata.get("group_type") or "").strip() == "speaker_lane"]
        lane_groups = explicit_lane_groups or top_level_groups

    lane_group_ids = {group.id for group in lane_groups}
    lane_color_by_group: dict[str, str] = {}
    lane_index_by_group: dict[str, int] = {}
    speaker_label_by_group: dict[str, str] = {}

    for index, group in enumerate(lane_groups, start=1):
        group.metadata = dict(group.metadata)
        lane_index = _metadata_int(group.metadata, "lane_index", index)
        lane_color = str(group.metadata.get("lane_color") or DEFAULT_LANE_COLORS[(index - 1) % len(DEFAULT_LANE_COLORS)]).strip()
        speaker_id = str(group.metadata.get("speaker_id") or group.id).strip() or group.id
        speaker_label = str(group.metadata.get("speaker_label") or group.label or group.id).strip() or group.id
        group.metadata.setdefault("group_type", "speaker_lane")
        group.metadata["lane_index"] = lane_index
        group.metadata["speaker_id"] = speaker_id
        group.metadata["speaker_label"] = speaker_label
        group.metadata["lane_color"] = lane_color
        lane_color_by_group[group.id] = lane_color
        lane_index_by_group[group.id] = lane_index
        speaker_label_by_group[group.id] = speaker_label

    groups_by_id = {group.id: group for group in prepared.groups}
    lane_groups_by_node: dict[str, GraphGroup] = {}
    for node in prepared.nodes:
        cursor = node.parent
        while cursor:
            group = groups_by_id.get(cursor)
            if group is None:
                break
            if group.id in lane_group_ids:
                lane_groups_by_node[node.id] = group
                break
            cursor = group.parent

    for index, node in enumerate(sorted(prepared.nodes, key=lambda item: (item.source_index, item.id)), start=1):
        node.metadata = dict(node.metadata)
        lane_group = lane_groups_by_node.get(node.id)
        fallback_lane_id = lane_group.id if lane_group else str(node.metadata.get("lane_id") or "")
        fallback_lane_index = lane_index_by_group.get(fallback_lane_id, index)
        speaker_label = (
            speaker_label_by_group.get(fallback_lane_id)
            or str(node.metadata.get("speaker_label") or "")
            or (lane_group.label if lane_group else "")
            or node.parent
            or "Speaker"
        )
        speaker_id = str(node.metadata.get("speaker_id") or (lane_group.metadata.get("speaker_id") if lane_group else "") or fallback_lane_id or speaker_label).strip()
        node.metadata["speaker_id"] = speaker_id or node.id
        node.metadata["speaker_label"] = speaker_label
        node.metadata["lane_id"] = fallback_lane_id or node.id
        node.metadata["lane_index"] = _metadata_int(node.metadata, "lane_index", fallback_lane_index)
        node.metadata["turn_index"] = _metadata_int(node.metadata, "turn_index", int(node.source_index or index))
        node.metadata["argument_role"] = _infer_argument_role(node)
        node.metadata["thread_id"] = str(node.metadata.get("thread_id") or prepared.graph_id)

    node_by_id = {node.id: node for node in prepared.nodes}
    for index, edge in enumerate(sorted(prepared.edges, key=lambda item: (item.source_index, item.id)), start=1):
        edge.metadata = dict(edge.metadata)
        source_node = node_by_id.get(edge.source)
        target_node = node_by_id.get(edge.target)
        source_lane = str(source_node.metadata.get("lane_id") or "") if source_node else ""
        target_lane = str(target_node.metadata.get("lane_id") or "") if target_node else ""
        edge.metadata["relation_type"] = _infer_relation_type(edge)
        edge.metadata["cross_lane"] = bool(source_lane and target_lane and source_lane != target_lane)
        edge.metadata["source_turn_index"] = _metadata_int(
            edge.metadata,
            "source_turn_index",
            _metadata_int(source_node.metadata, "turn_index", index) if source_node else index,
        )
        edge.metadata["target_turn_index"] = _metadata_int(
            edge.metadata,
            "target_turn_index",
            _metadata_int(target_node.metadata, "turn_index", index) if target_node else index,
        )

    prepared.metadata = dict(prepared.metadata)
    if lane_mode:
        prepared.metadata["view_mode"] = "debate_lane_flowchart"
        prepared.metadata["time_axis_enabled"] = _metadata_bool(prepared.metadata, "time_axis_enabled", True)
        prepared.metadata["lane_order_strategy"] = str(prepared.metadata.get("lane_order_strategy") or "lane_index")
    else:
        prepared.metadata.setdefault("view_mode", "standard_flowchart")
        prepared.metadata["time_axis_enabled"] = _metadata_bool(prepared.metadata, "time_axis_enabled", False)
        prepared.metadata.setdefault("lane_order_strategy", "source_index")

    entity_id_map, _entity_aliases = _build_mermaid_identifier_maps(prepared)
    for node in prepared.nodes:
        node.metadata["mermaid_id"] = entity_id_map.get(node.id, node.id)
    for group in prepared.groups:
        group.metadata["mermaid_id"] = entity_id_map.get(group.id, group.id)
    for edge in prepared.edges:
        edge.metadata["mermaid_source_id"] = entity_id_map.get(edge.source, edge.source)
        edge.metadata["mermaid_target_id"] = entity_id_map.get(edge.target, edge.target)
        edge.metadata["mermaid_edge_key"] = f"L_{edge.metadata['mermaid_source_id']}_{edge.metadata['mermaid_target_id']}"
    return prepared


def _format_lane_node_label(node: GraphNode) -> str:
    label = _escape_label(node.label or node.id)
    turn_index = _metadata_int(dict(node.metadata), "turn_index", 0)
    if turn_index <= 0:
        return label
    if label.startswith(f"#{turn_index} "):
        return label
    return f"#{turn_index} {label}"


def _flowchart_edge_statement(source_id: str, target_id: str, relation_type: str, label: str) -> str:
    escaped_label = _escape_label(label or "")
    if relation_type == "attack":
        if escaped_label:
            return f"{source_id} -->|{escaped_label}| {target_id}"
        return f"{source_id} ---x {target_id}"
    if relation_type == "support":
        if escaped_label:
            return f"{source_id} -->|{escaped_label}| {target_id}"
        return f"{source_id} ---o {target_id}"
    if relation_type == "elaborate":
        if escaped_label:
            return f"{source_id} -. {escaped_label} .-> {target_id}"
        return f"{source_id} -.-> {target_id}"
    if relation_type == "reference":
        if escaped_label:
            return f"{source_id} ==>|{escaped_label}| {target_id}"
        return f"{source_id} ==> {target_id}"
    if escaped_label:
        return f"{source_id} -->|{escaped_label}| {target_id}"
    return f"{source_id} --> {target_id}"


def _lane_link_style(index: int, relation_type: str, cross_lane: bool) -> str | None:
    if relation_type == "attack":
        return f"linkStyle {index} stroke:#dc2626,stroke-width:2.8px,color:#991b1b"
    if relation_type == "support":
        return f"linkStyle {index} stroke:#16a34a,stroke-width:2.6px,color:#166534"
    if relation_type == "reference":
        return f"linkStyle {index} stroke:#2563eb,stroke-width:2.4px,color:#1d4ed8"
    if relation_type == "elaborate":
        return f"linkStyle {index} stroke:#7c3aed,stroke-width:2.2px,color:#5b21b6"
    if cross_lane:
        return f"linkStyle {index} stroke:#0f172a,stroke-width:2.2px,color:#0f172a"
    return None


def _emit_debate_lane_flowchart(
    graph_ir: GraphIR,
    init_lines: list[str],
    rewritten_style_lines: list[str],
    entity_id_map: dict[str, str],
) -> str:
    lines = [*init_lines, "flowchart LR"]
    groups_by_id = {group.id: group for group in graph_ir.groups}
    child_groups: dict[str | None, list[GraphGroup]] = defaultdict(list)
    for group in sorted(graph_ir.groups, key=_lane_group_order_key):
        child_groups[group.parent].append(group)

    nodes_by_parent: dict[str | None, list[GraphNode]] = defaultdict(list)
    for node in sorted(graph_ir.nodes, key=_node_turn_order_key):
        parent_id = node.parent if node.parent in groups_by_id else None
        nodes_by_parent[parent_id].append(node)

    lane_groups = sorted(
        [group for group in graph_ir.groups if str(group.metadata.get("group_type") or "").strip() == "speaker_lane" and not group.parent],
        key=_lane_group_order_key,
    )
    lane_group_ids = {group.id for group in lane_groups}
    role_members: dict[str, list[str]] = defaultdict(list)

    def emit_group(group: GraphGroup, indent: int) -> None:
        prefix = "    " * indent
        group_label = _escape_label(group.label or group.id)
        lines.append(f'{prefix}subgraph {entity_id_map.get(group.id, group.id)}["{group_label}"]')
        if group.id in lane_group_ids:
            lines.append(f"{prefix}    direction TB")
        for node in sorted(nodes_by_parent.get(group.id, []), key=_node_turn_order_key):
            label = _format_lane_node_label(node) if group.id in lane_group_ids else _escape_label(node.label or node.id)
            lines.append(f'{prefix}    {entity_id_map.get(node.id, node.id)}["{label}"]')
            role_members[str(node.metadata.get("argument_role") or "claim")].append(entity_id_map.get(node.id, node.id))
        for child in child_groups.get(group.id, []):
            emit_group(child, indent + 1)
        lines.append(f"{prefix}end")

    for node in sorted(nodes_by_parent.get(None, []), key=_node_turn_order_key):
        lines.append(f'    {entity_id_map.get(node.id, node.id)}["{_format_lane_node_label(node)}"]')
        role_members[str(node.metadata.get("argument_role") or "claim")].append(entity_id_map.get(node.id, node.id))

    non_lane_groups = [group for group in child_groups.get(None, []) if group.id not in lane_group_ids]
    for group in non_lane_groups:
        emit_group(group, 1)
    for group in lane_groups:
        emit_group(group, 1)

    edge_styles: list[str] = []
    for edge_index, edge in enumerate(sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id))):
        relation_type = str(edge.metadata.get("relation_type") or "reply")
        statement = _flowchart_edge_statement(
            entity_id_map.get(edge.source, edge.source),
            entity_id_map.get(edge.target, edge.target),
            relation_type,
            edge.label,
        )
        lines.append(f"    {statement}")
        edge_style = _lane_link_style(edge_index, relation_type, bool(edge.metadata.get("cross_lane")))
        if edge_style:
            edge_styles.append(edge_style)

    lane_palette_style_lines: list[str] = []
    for group in lane_groups:
        lane_color = str(group.metadata.get("lane_color") or "#eff6ff").strip()
        lane_palette_style_lines.append(
            f"style {entity_id_map.get(group.id, group.id)} fill:{lane_color},stroke:#334155,stroke-width:2px,color:#0f172a"
        )

    role_style_lines = [
        "classDef laneClaim fill:#ffffff,stroke:#2563eb,stroke-width:1.8px,color:#0f172a,font-weight:600",
        "classDef laneEvidence fill:#f0fdf4,stroke:#16a34a,stroke-width:1.8px,color:#166534",
        "classDef laneCounter fill:#fef2f2,stroke:#dc2626,stroke-width:1.8px,color:#991b1b",
        "classDef laneSummary fill:#f8fafc,stroke:#475569,stroke-width:1.8px,color:#0f172a,font-weight:600",
        "classDef laneQuestion fill:#faf5ff,stroke:#9333ea,stroke-width:1.8px,color:#6b21a8",
    ]
    role_class_lines: list[str] = []
    if role_members.get("claim"):
        role_class_lines.append(f"class {','.join(dict.fromkeys(role_members['claim']))} laneClaim")
    if role_members.get("evidence"):
        role_class_lines.append(f"class {','.join(dict.fromkeys(role_members['evidence']))} laneEvidence")
    if role_members.get("counter"):
        role_class_lines.append(f"class {','.join(dict.fromkeys(role_members['counter']))} laneCounter")
    if role_members.get("summary"):
        role_class_lines.append(f"class {','.join(dict.fromkeys(role_members['summary']))} laneSummary")
    if role_members.get("question"):
        role_class_lines.append(f"class {','.join(dict.fromkeys(role_members['question']))} laneQuestion")

    lines.extend(f"    {line}" for line in role_style_lines)
    lines.extend(f"    {line}" for line in role_class_lines)
    lines.extend(f"    {line}" for line in lane_palette_style_lines)
    lines.extend(f"    {line}" for line in edge_styles)
    lines.extend(f"    {line}" for line in rewritten_style_lines)
    return "\n".join(lines)


def render_preview_mermaid(graph_ir: GraphIR) -> str:
    graph_ir = prepare_graph_for_mermaid_display(graph_ir)
    diagram_type = (graph_ir.diagram_type or "flowchart").strip()
    normalized_type = diagram_type.lower()
    init_lines, style_lines = _extract_mermaid_style_lines(graph_ir)
    entity_id_map, entity_aliases = _build_mermaid_identifier_maps(graph_ir)
    class_name_map, seen_class_names = _build_mermaid_class_name_map(style_lines)
    rewritten_style_lines: list[str] = []
    seen_rewritten_style_lines: set[str] = set()
    for raw_line in style_lines:
        rewritten = _rewrite_mermaid_style_line(raw_line, entity_aliases, class_name_map, seen_class_names)
        if not rewritten or rewritten in seen_rewritten_style_lines:
            continue
        seen_rewritten_style_lines.add(rewritten)
        rewritten_style_lines.append(rewritten)

    if normalized_type in {"sequence", "sequencediagram"}:
        lines = [*init_lines, "sequenceDiagram"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            label = _escape_label(node.label or node.id)
            lines.append(f"    participant {entity_id_map.get(node.id, node.id)} as {label}")
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = _escape_label(edge.label or edge.id or "relates")
            lines.append(
                f"    {entity_id_map.get(edge.source, edge.source)}->>{entity_id_map.get(edge.target, edge.target)}: {edge_label}"
            )
        lines.extend(f"    {line}" for line in rewritten_style_lines)
        return "\n".join(lines)

    if normalized_type in {"class", "classdiagram"}:
        lines = [*init_lines, "classDiagram"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            lines.append(f"    class {entity_id_map.get(node.id, node.id)}")
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = f" : {_escape_label(edge.label)}" if edge.label else ""
            lines.append(
                f"    {entity_id_map.get(edge.source, edge.source)} --> {entity_id_map.get(edge.target, edge.target)}{edge_label}"
            )
        lines.extend(f"    {line}" for line in rewritten_style_lines)
        return "\n".join(lines)

    if normalized_type in {"state", "statediagram", "statediagram-v2"}:
        lines = [*init_lines, "stateDiagram-v2"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            label = _escape_label(node.label or node.id)
            lines.append(f'    state "{label}" as {entity_id_map.get(node.id, node.id)}')
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = f" : {_escape_label(edge.label)}" if edge.label else ""
            lines.append(
                f"    {entity_id_map.get(edge.source, edge.source)} --> {entity_id_map.get(edge.target, edge.target)}{edge_label}"
            )
        lines.extend(f"    {line}" for line in rewritten_style_lines)
        return "\n".join(lines)

    if normalized_type in {"er", "erdiagram"}:
        lines = [*init_lines, "erDiagram"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            label = _escape_label(node.label or node.id)
            lines.append(f'    {entity_id_map.get(node.id, node.id)}["{label}"]')
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = f" {_escape_label(edge.label)}" if edge.label else ""
            lines.append(
                f"    {entity_id_map.get(edge.source, edge.source)} }}|--|| {entity_id_map.get(edge.target, edge.target)}{edge_label}"
            )
        lines.extend(f"    {line}" for line in rewritten_style_lines)
        return "\n".join(lines)

    if normalized_type in {"requirement", "requirementdiagram"}:
        lines = [*init_lines, "requirementDiagram"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            node_id = entity_id_map.get(node.id, node.id)
            label = _escape_label(node.label or node.id)
            lines.append(f'    requirement {node_id} {{')
            lines.append(f'        id: "{label}"')
            lines.append(f'    }}')
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = edge.label or "traces"
            lines.append(
                f"    {entity_id_map.get(edge.source, edge.source)} - traces -> {entity_id_map.get(edge.target, edge.target)}"
            )
        lines.extend(f"    {line}" for line in rewritten_style_lines)
        return "\n".join(lines)

    if str(graph_ir.metadata.get("view_mode") or "").strip() == "debate_lane_flowchart":
        return _emit_debate_lane_flowchart(graph_ir, init_lines, rewritten_style_lines, entity_id_map)

    lines = [*init_lines, "graph TD"]
    graph_ir = _fix_group_parent_cycles(graph_ir)
    groups_by_id = {group.id: group for group in graph_ir.groups}
    child_groups: dict[str | None, list] = defaultdict(list)
    for group in sorted(graph_ir.groups, key=lambda item: (item.source_index, item.id)):
        child_groups[group.parent].append(group)

    nodes_by_parent: dict[str | None, list] = defaultdict(list)
    for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
        parent_id = node.parent if node.parent in groups_by_id else None
        nodes_by_parent[parent_id].append(node)

    def emit_group(group_id: str | None, indent: int = 1) -> None:
        prefix = "    " * indent
        for group in child_groups.get(group_id, []):
            lines.append(
                f'{prefix}subgraph {entity_id_map.get(group.id, group.id)}["{_escape_label(group.label or group.id)}"]'
            )
            for node in nodes_by_parent.get(group.id, []):
                label = _escape_label(node.label or node.id)
                lines.append(f'{prefix}    {entity_id_map.get(node.id, node.id)}["{label}"]')
            emit_group(group.id, indent + 1)
            lines.append(f"{prefix}end")

    for node in nodes_by_parent.get(None, []):
        label = _escape_label(node.label or node.id)
        lines.append(f'    {entity_id_map.get(node.id, node.id)}["{label}"]')
    emit_group(None)
    for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
        edge_label = f"|{_escape_label(edge.label)}|" if edge.label else ""
        lines.append(
            f"    {entity_id_map.get(edge.source, edge.source)} -->{edge_label} {entity_id_map.get(edge.target, edge.target)}"
        )
    lines.extend(f"    {line}" for line in rewritten_style_lines)
    return "\n".join(lines)


def _node_depths(graph_ir: GraphIR) -> dict[str, int]:
    adjacency: dict[str, list[str]] = defaultdict(list)
    indegree: Counter[str] = Counter()
    for node in graph_ir.nodes:
        indegree[node.id] += 0
    for edge in graph_ir.edges:
        adjacency[edge.source].append(edge.target)
        indegree[edge.target] += 1
        indegree[edge.source] += 0

    queue = deque(sorted((node_id for node_id, degree in indegree.items() if degree == 0)))
    depths = {node_id: 0 for node_id in queue}
    visited: set[str] = set(queue)

    while queue:
        node_id = queue.popleft()
        base_depth = depths[node_id]
        for target in adjacency.get(node_id, []):
            depths[target] = max(depths.get(target, 0), base_depth + 1)
            if target not in visited:
                visited.add(target)
                queue.append(target)

    current_depth = max(depths.values(), default=0)
    for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
        if node.id not in depths:
            current_depth += 1
            depths[node.id] = current_depth
    return depths


def _quantile_stage(position: int, total: int, stage_count: int) -> int:
    if total <= 0:
        return 1
    return min(stage_count, max(1, int(math.floor(position * stage_count / total)) + 1))


def _assign_node_stages(graph_ir: GraphIR, stage_count: int) -> dict[str, int]:
    if not graph_ir.nodes:
        return {}
    if graph_ir.diagram_type == "sequence":
        return {node.id: 1 for node in graph_ir.nodes}

    depths = _node_depths(graph_ir)
    ordered = sorted(graph_ir.nodes, key=lambda item: (depths.get(item.id, 0), item.source_index, item.id))
    return {node.id: _quantile_stage(index, len(ordered), stage_count) for index, node in enumerate(ordered)}


def _compress_used_stages(values: list[int]) -> dict[int, int]:
    used = sorted({value for value in values if value > 0})
    return {old: index + 1 for index, old in enumerate(used)}


def _subset_graph_ir(base: GraphIR, node_ids: set[str], edge_ids: set[str], group_ids: set[str]) -> GraphIR:
    nodes = [node for node in base.nodes if node.id in node_ids]
    edges = [edge for edge in base.edges if edge.id in edge_ids]
    groups = [group for group in base.groups if group.id in group_ids]
    return GraphIR(
        graph_id=base.graph_id,
        diagram_type=base.diagram_type,
        nodes=nodes,
        edges=edges,
        groups=groups,
        styles=list(base.styles),
        metadata=dict(base.metadata),
    )


def build_incremental_stages(graph_ir: GraphIR, recommended_stage_count: int) -> list[StageState]:
    stage_count = min(5, max(1, recommended_stage_count))
    node_stage = _assign_node_stages(graph_ir, stage_count)

    if graph_ir.diagram_type == "sequence":
        ordered_edges = sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id))
        edge_stage = {
            edge.id: max(1, _quantile_stage(index, max(len(ordered_edges), 1), stage_count))
            for index, edge in enumerate(ordered_edges)
        }
    else:
        edge_stage = {
            edge.id: min(stage_count, max(node_stage.get(edge.source, 1), node_stage.get(edge.target, 1)))
            for edge in graph_ir.edges
        }

    group_stage: dict[str, int] = {}
    for group in graph_ir.groups:
        member_stages = [node_stage.get(member_id) for member_id in group.member_ids if member_id in node_stage]
        group_stage[group.id] = min(member_stages) if member_stages else 1

    remap = _compress_used_stages([*node_stage.values(), *edge_stage.values(), *group_stage.values()])
    node_stage = {key: remap.get(value, 1) for key, value in node_stage.items()}
    edge_stage = {key: remap.get(value, 1) for key, value in edge_stage.items()}
    group_stage = {key: remap.get(value, 1) for key, value in group_stage.items()}
    stage_count = max([1, *node_stage.values(), *edge_stage.values(), *group_stage.values()])

    states: list[StageState] = []
    for stage_index in range(1, stage_count + 1):
        active_node_ids = {node_id for node_id, value in node_stage.items() if value <= stage_index}
        active_edge_ids = {
            edge.id
            for edge in graph_ir.edges
            if edge_stage.get(edge.id, 1) <= stage_index
            and edge.source in active_node_ids
            and edge.target in active_node_ids
        }
        active_group_ids = {group_id for group_id, value in group_stage.items() if value <= stage_index}
        delta_ops = []

        for group in graph_ir.groups:
            if group_stage.get(group.id) == stage_index:
                delta_ops.append({"op": "add_group", "group_id": group.id, "label": group.label})
        for node in graph_ir.nodes:
            if node_stage.get(node.id) == stage_index:
                delta_ops.append({"op": "add_node", "node_id": node.id, "label": node.label, "kind": node.kind})
        for edge in graph_ir.edges:
            if edge_stage.get(edge.id) == stage_index and edge.id in active_edge_ids:
                delta_ops.append(
                    {
                        "op": "add_edge",
                        "edge_id": edge.id,
                        "source": edge.source,
                        "target": edge.target,
                        "label": edge.label,
                    }
                )

        subset_ir = _subset_graph_ir(graph_ir, active_node_ids, active_edge_ids, active_group_ids)
        states.append(
            StageState(
                stage_index=stage_index,
                stage_name=STAGE_NAMES.get(stage_index, f"Stage {stage_index}"),
                stage_description=_describe_stage(stage_index, stage_count, subset_ir, delta_ops),
                graph_ir=subset_ir,
                delta_ops=delta_ops,
                preview_mermaid=render_preview_mermaid(subset_ir),
                metrics={
                    "node_count": len(subset_ir.nodes),
                    "edge_count": len(subset_ir.edges),
                    "group_count": len(subset_ir.groups),
                    "delta_count": len(delta_ops),
                },
            )
        )
    return states


def _describe_stage(stage_index: int, stage_count: int, subset_ir: GraphIR, delta_ops: list[dict]) -> str:
    parts = [
        f"Stage {stage_index}/{stage_count}",
        f"adds {sum(1 for item in delta_ops if item['op'] == 'add_node')} nodes",
        f"{sum(1 for item in delta_ops if item['op'] == 'add_edge')} edges",
    ]
    if any(item["op"] == "add_group" for item in delta_ops):
        parts.append(f"{sum(1 for item in delta_ops if item['op'] == 'add_group')} groups")
    parts.append(
        f"current state now contains {len(subset_ir.nodes)} nodes and {len(subset_ir.edges)} edges"
    )
    return ", ".join(parts)
