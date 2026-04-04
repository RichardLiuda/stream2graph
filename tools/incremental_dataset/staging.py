from __future__ import annotations

import math
import re
from collections import Counter, defaultdict, deque

from tools.incremental_dataset.schema import GraphGroup, GraphIR, StageState


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


def render_preview_mermaid(graph_ir: GraphIR) -> str:
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
