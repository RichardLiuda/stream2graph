from __future__ import annotations

import math
from collections import Counter, defaultdict, deque

from tools.incremental_dataset.schema import GraphIR, StageState


STAGE_NAMES = {
    1: "Bootstrap Core",
    2: "Expand Main Branches",
    3: "Add Supporting Structure",
    4: "Resolve Conditions",
    5: "Finalize Surface Details",
}


def _escape_label(label: str) -> str:
    return (label or "").replace('"', "'")


def render_preview_mermaid(graph_ir: GraphIR) -> str:
    diagram_type = (graph_ir.diagram_type or "flowchart").strip()
    normalized_type = diagram_type.lower()

    if normalized_type in {"sequence", "sequencediagram"}:
        lines = ["sequenceDiagram"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            label = _escape_label(node.label or node.id)
            lines.append(f"    participant {node.id} as {label}")
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = _escape_label(edge.label or edge.id or "relates")
            lines.append(f"    {edge.source}->>{edge.target}: {edge_label}")
        return "\n".join(lines)

    if normalized_type in {"class", "classdiagram"}:
        lines = ["classDiagram"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            lines.append(f"    class {node.id}")
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = f" : {_escape_label(edge.label)}" if edge.label else ""
            lines.append(f"    {edge.source} --> {edge.target}{edge_label}")
        return "\n".join(lines)

    if normalized_type in {"state", "statediagram", "statediagram-v2"}:
        lines = ["stateDiagram-v2"]
        for node in sorted(graph_ir.nodes, key=lambda item: (item.source_index, item.id)):
            label = _escape_label(node.label or node.id)
            lines.append(f'    state "{label}" as {node.id}')
        for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
            edge_label = f" : {_escape_label(edge.label)}" if edge.label else ""
            lines.append(f"    {edge.source} --> {edge.target}{edge_label}")
        return "\n".join(lines)

    lines = ["graph TD"]
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
            lines.append(f'{prefix}subgraph {group.id}["{_escape_label(group.label or group.id)}"]')
            for node in nodes_by_parent.get(group.id, []):
                label = _escape_label(node.label or node.id)
                lines.append(f'{prefix}    {node.id}["{label}"]')
            emit_group(group.id, indent + 1)
            lines.append(f"{prefix}end")

    for node in nodes_by_parent.get(None, []):
        label = _escape_label(node.label or node.id)
        lines.append(f'    {node.id}["{label}"]')
    emit_group(None)
    for edge in sorted(graph_ir.edges, key=lambda item: (item.source_index, item.id)):
        edge_label = f"|{_escape_label(edge.label)}|" if edge.label else ""
        lines.append(f"    {edge.source} -->{edge_label} {edge.target}")
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
