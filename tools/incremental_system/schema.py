from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tools.incremental_dataset.schema import GraphIR, StageState


@dataclass
class DialogueTurn:
    turn_id: int
    speaker: str
    content: str
    stage_index: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "turn_id": self.turn_id,
            "speaker": self.speaker,
            "content": self.content,
            "stage_index": self.stage_index,
            "metadata": self.metadata,
        }


@dataclass
class StageBoundary:
    stage_index: int
    start_turn: int
    end_turn: int
    stage_name: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "stage_index": self.stage_index,
            "start_turn": self.start_turn,
            "end_turn": self.end_turn,
            "stage_name": self.stage_name,
        }


@dataclass
class RuntimeSample:
    sample_id: str
    diagram_type: str
    graph_ir: GraphIR
    stages: list[StageState]
    turns: list[DialogueTurn]
    stage_boundaries: list[StageBoundary]
    metadata: dict[str, Any] = field(default_factory=dict)

    def stage_by_index(self, stage_index: int) -> StageState:
        for stage in self.stages:
            if int(stage.stage_index) == int(stage_index):
                return stage
        raise KeyError(f"stage_index not found: {stage_index}")

    def boundary_by_stage(self, stage_index: int) -> StageBoundary | None:
        for boundary in self.stage_boundaries:
            if int(boundary.stage_index) == int(stage_index):
                return boundary
        return None

    @property
    def total_stages(self) -> int:
        return len(self.stages)


@dataclass
class GateDecision:
    action: str
    target_stage_index: int | None = None
    reason: str = ""
    confidence: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "target_stage_index": self.target_stage_index,
            "reason": self.reason,
            "confidence": self.confidence,
            "metadata": self.metadata,
        }


@dataclass
class PlannerOutput:
    target_stage_index: int
    delta_ops: list[dict[str, Any]] = field(default_factory=list)
    target_graph_ir: GraphIR | None = None
    notes: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "target_stage_index": self.target_stage_index,
            "delta_ops": self.delta_ops,
            "target_graph_ir": self.target_graph_ir.to_payload() if self.target_graph_ir else None,
            "notes": self.notes,
            "metadata": self.metadata,
        }


@dataclass
class SessionState:
    sample_id: str
    diagram_type: str
    current_stage_index: int = 0
    current_graph_ir: GraphIR | None = None
    rendered_mermaid: str = ""
    applied_stage_indices: list[int] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "sample_id": self.sample_id,
            "diagram_type": self.diagram_type,
            "current_stage_index": self.current_stage_index,
            "current_graph_ir": self.current_graph_ir.to_payload() if self.current_graph_ir else None,
            "rendered_mermaid": self.rendered_mermaid,
            "applied_stage_indices": self.applied_stage_indices,
            "metadata": self.metadata,
        }
