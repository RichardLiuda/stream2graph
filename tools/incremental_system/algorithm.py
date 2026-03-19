from __future__ import annotations

from dataclasses import replace
from typing import Any

from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode
from tools.incremental_dataset.staging import render_preview_mermaid
from tools.incremental_system.schema import PlannerOutput, RuntimeSample, SessionState


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


def _graph_item_count(graph_ir: GraphIR | None) -> int:
    if graph_ir is None:
        return 0
    return len(graph_ir.nodes) + len(graph_ir.edges) + len(graph_ir.groups)


def build_empty_graph(graph_id: str, diagram_type: str) -> GraphIR:
    return GraphIR(graph_id=graph_id, diagram_type=diagram_type)


def graph_metrics(graph_ir: GraphIR) -> dict[str, Any]:
    return {
        "node_count": len(graph_ir.nodes),
        "edge_count": len(graph_ir.edges),
        "group_count": len(graph_ir.groups),
        "node_ids": [node.id for node in graph_ir.nodes[:12]],
        "edge_ids": [edge.id for edge in graph_ir.edges[:12]],
        "group_ids": [group.id for group in graph_ir.groups[:12]],
    }


def graph_exact_match(left: GraphIR | None, right: GraphIR | None) -> bool:
    if left is None or right is None:
        return False
    return (
        sorted(node.id for node in left.nodes) == sorted(node.id for node in right.nodes)
        and sorted(edge.id for edge in left.edges) == sorted(edge.id for edge in right.edges)
        and sorted(group.id for group in left.groups) == sorted(group.id for group in right.groups)
    )


def _apply_delta_ops(base: GraphIR, delta_ops: list[dict[str, Any]]) -> GraphIR:
    graph = _clone_graph_ir(base)
    node_ids = {node.id for node in graph.nodes}
    edge_ids = {edge.id for edge in graph.edges}
    group_ids = {group.id for group in graph.groups}
    next_node_index = max((node.source_index for node in graph.nodes), default=0) + 1
    next_edge_index = max((edge.source_index for edge in graph.edges), default=0) + 1
    next_group_index = max((group.source_index for group in graph.groups), default=0) + 1

    for op_index, op in enumerate(delta_ops, start=1):
        op_name = str(op.get("op") or op.get("type") or "").strip().lower()
        if op_name == "add_group":
            group_id = str(op.get("group_id") or op.get("id") or "").strip()
            if not group_id or group_id in group_ids:
                continue
            graph.groups.append(
                GraphGroup(
                    id=group_id,
                    label=str(op.get("label", group_id)),
                    parent=(str(op["parent"]) if op.get("parent") not in {None, ""} else None),
                    member_ids=[str(item) for item in op.get("member_ids", [])],
                    source_index=next_group_index + op_index,
                    metadata={},
                )
            )
            group_ids.add(group_id)
        elif op_name == "add_node":
            node_id = str(op.get("node_id") or op.get("id") or "").strip()
            if not node_id or node_id in node_ids:
                continue
            graph.nodes.append(
                GraphNode(
                    id=node_id,
                    label=str(op.get("label", node_id)),
                    kind=str(op.get("kind") or op.get("node_type") or "node"),
                    parent=(str(op["parent"]) if op.get("parent") not in {None, ""} else None),
                    source_index=next_node_index + op_index,
                    metadata={},
                )
            )
            node_ids.add(node_id)
        elif op_name == "add_edge":
            edge_id = str(op.get("edge_id") or op.get("id") or "").strip()
            if not edge_id or edge_id in edge_ids:
                continue
            graph.edges.append(
                GraphEdge(
                    id=edge_id,
                    source=str(op.get("source", "")),
                    target=str(op.get("target", "")),
                    label=str(op.get("label", "")),
                    kind=str(op.get("kind") or "edge"),
                    source_index=next_edge_index + op_index,
                    metadata={},
                )
            )
            edge_ids.add(edge_id)
    return graph


class DeterministicAlgorithmLayer:
    name = "deterministic_algorithm_layer"

    def bootstrap_state(self, sample: RuntimeSample) -> SessionState:
        empty_graph = build_empty_graph(sample.sample_id, sample.diagram_type)
        return SessionState(
            sample_id=sample.sample_id,
            diagram_type=sample.diagram_type,
            current_stage_index=0,
            current_graph_ir=empty_graph,
            rendered_mermaid=render_preview_mermaid(empty_graph),
            applied_stage_indices=[],
            metadata={
                "graph_metrics": graph_metrics(empty_graph),
            },
        )

    def summarize_state(self, state: SessionState) -> dict[str, Any]:
        graph_ir = state.current_graph_ir or build_empty_graph(state.sample_id, state.diagram_type)
        return {
            "current_stage_index": state.current_stage_index,
            "applied_stage_indices": list(state.applied_stage_indices),
            "graph_metrics": graph_metrics(graph_ir),
            "rendered_mermaid": state.rendered_mermaid,
        }

    def apply_planner_output(
        self,
        sample: RuntimeSample,
        state: SessionState,
        planner_output: PlannerOutput,
    ) -> tuple[SessionState, dict[str, Any]]:
        base_graph = state.current_graph_ir or build_empty_graph(sample.sample_id, sample.diagram_type)
        target_graph = planner_output.target_graph_ir
        if planner_output.delta_ops:
            target_graph = _apply_delta_ops(base_graph, planner_output.delta_ops)
        elif target_graph is None:
            raise ValueError("PlannerOutput must include delta_ops or target_graph_ir.")
        elif _graph_item_count(target_graph) < _graph_item_count(base_graph):
            # The runtime task is monotonic. If the model returns a partial or shrinking
            # graph snapshot, trust delta ops and extend the current state instead.
            target_graph = base_graph

        next_state = replace(
            state,
            current_stage_index=planner_output.target_stage_index,
            current_graph_ir=_clone_graph_ir(target_graph),
            rendered_mermaid=render_preview_mermaid(target_graph),
            applied_stage_indices=sorted(
                {*(state.applied_stage_indices or []), int(planner_output.target_stage_index)}
            ),
        )
        next_state.metadata = {
            **dict(state.metadata),
            "graph_metrics": graph_metrics(target_graph),
        }
        gold_stage = sample.stage_by_index(planner_output.target_stage_index)
        update_payload = {
            "target_stage_index": planner_output.target_stage_index,
            "delta_ops": planner_output.delta_ops,
            "graph_metrics": graph_metrics(target_graph),
            "gold_stage_metrics": dict(gold_stage.metrics),
            "preview_mermaid": next_state.rendered_mermaid,
            "matches_reference_stage": graph_exact_match(target_graph, gold_stage.graph_ir),
        }
        return next_state, update_payload
