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
        target_graph = planner_output.target_graph_ir
        if target_graph is None:
            raise ValueError("PlannerOutput.target_graph_ir is required for state application.")

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
