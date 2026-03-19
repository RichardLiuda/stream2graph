from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.eval.common import read_json, resolve_path
from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode, StageState
from tools.incremental_system.schema import DialogueTurn, RuntimeSample, StageBoundary


def _graph_ir_from_payload(payload: dict[str, Any]) -> GraphIR:
    return GraphIR(
        graph_id=str(payload.get("graph_id", "")),
        diagram_type=str(payload.get("diagram_type", "unknown")),
        nodes=[
            GraphNode(
                id=str(node.get("id", "")),
                label=str(node.get("label", "")),
                kind=str(node.get("kind", "node")),
                parent=node.get("parent"),
                source_index=int(node.get("source_index", 0) or 0),
                metadata=dict(node.get("metadata", {})),
            )
            for node in payload.get("nodes", [])
        ],
        edges=[
            GraphEdge(
                id=str(edge.get("id", "")),
                source=str(edge.get("source", "")),
                target=str(edge.get("target", "")),
                label=str(edge.get("label", "")),
                kind=str(edge.get("kind", "edge")),
                source_index=int(edge.get("source_index", 0) or 0),
                metadata=dict(edge.get("metadata", {})),
            )
            for edge in payload.get("edges", [])
        ],
        groups=[
            GraphGroup(
                id=str(group.get("id", "")),
                label=str(group.get("label", "")),
                parent=group.get("parent"),
                member_ids=[str(item) for item in group.get("member_ids", [])],
                source_index=int(group.get("source_index", 0) or 0),
                metadata=dict(group.get("metadata", {})),
            )
            for group in payload.get("groups", [])
        ],
        styles=list(payload.get("styles", [])),
        metadata=dict(payload.get("metadata", {})),
    )


def _stage_state_from_payload(payload: dict[str, Any]) -> StageState:
    return StageState(
        stage_index=int(payload.get("stage_index", 0) or 0),
        stage_name=str(payload.get("stage_name", "")),
        stage_description=str(payload.get("stage_description", "")),
        graph_ir=_graph_ir_from_payload(dict(payload.get("graph_ir", {}))),
        delta_ops=list(payload.get("delta_ops", [])),
        preview_mermaid=str(payload.get("preview_mermaid", "")),
        metrics=dict(payload.get("metrics", {})),
    )


def _load_dialogue_payload(agent_payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    dialogue_payload = (
        agent_payload.get("final_dialogue")
        or (agent_payload.get("dialogue_writer") or {}).get("result")
        or {}
    )
    alignment_payload = (
        agent_payload.get("final_alignment")
        or (agent_payload.get("turn_aligner") or {}).get("result")
        or {}
    )
    return dict(dialogue_payload), dict(alignment_payload)


def _turns_from_payload(dialogue_payload: dict[str, Any], alignment_payload: dict[str, Any]) -> list[DialogueTurn]:
    aligned_stage_lookup = {
        int((row.get("turn_id") or row.get("turn_index") or 0) or 0): row
        for row in alignment_payload.get("aligned_turns", [])
        if (row.get("turn_id") or row.get("turn_index")) is not None
    }
    turns: list[DialogueTurn] = []
    for raw in dialogue_payload.get("turns", []):
        turn_id = int((raw.get("turn_id") or raw.get("turn_index") or 0) or 0)
        aligned = aligned_stage_lookup.get(turn_id, {})
        stage_index = raw.get("stage_index", aligned.get("stage_index"))
        turns.append(
            DialogueTurn(
                turn_id=turn_id,
                speaker=str(raw.get("speaker", "")),
                content=str(raw.get("content", "")),
                stage_index=int(stage_index) if stage_index not in {None, ""} else None,
                metadata={
                    "alignment_status": aligned.get("alignment_status"),
                },
            )
        )
    return sorted(turns, key=lambda item: item.turn_id)


def _boundaries_from_payload(dialogue_payload: dict[str, Any]) -> list[StageBoundary]:
    raw_boundaries = dialogue_payload.get("stage_boundaries", [])
    boundaries: list[StageBoundary] = []
    if isinstance(raw_boundaries, dict):
        items = sorted(raw_boundaries.items(), key=lambda item: item[0])
        for key, row in items:
            stage_index = row.get("stage_index")
            if stage_index is None:
                digits = "".join(ch for ch in str(key) if ch.isdigit())
                stage_index = int(digits) if digits else 0
            turns = row.get("turns") or []
            start_turn = row.get("start_turn")
            end_turn = row.get("end_turn")
            if turns and (start_turn is None or end_turn is None):
                numeric_turns = [int(item) for item in turns]
                start_turn = min(numeric_turns)
                end_turn = max(numeric_turns)
            boundaries.append(
                StageBoundary(
                    stage_index=int(stage_index or 0),
                    start_turn=int(start_turn or 0),
                    end_turn=int(end_turn or 0),
                    stage_name=str(row.get("stage_name") or row.get("stage_title") or row.get("title") or row.get("description") or ""),
                )
            )
        return sorted(boundaries, key=lambda item: item.stage_index)

    for row in raw_boundaries:
        boundaries.append(
            StageBoundary(
                stage_index=int(row.get("stage_index", 0) or 0),
                start_turn=int(row.get("start_turn", 0) or 0),
                end_turn=int(row.get("end_turn", 0) or 0),
                stage_name=str(row.get("stage_name") or row.get("stage_title") or row.get("title") or ""),
            )
        )
    return sorted(boundaries, key=lambda item: item.stage_index)


def load_runtime_sample(run_root: str | Path, sample_id: str) -> RuntimeSample:
    root = resolve_path(run_root)
    structure_path = root / "structure" / "samples" / f"{sample_id}.json"
    agent_path = root / "agent_cluster" / "sample_outputs" / f"{sample_id}.json"

    if not structure_path.exists():
        raise FileNotFoundError(f"Missing structure sample: {structure_path}")
    if not agent_path.exists():
        raise FileNotFoundError(f"Missing agent sample: {agent_path}")

    structure_payload = read_json(structure_path)
    agent_payload = read_json(agent_path)
    dialogue_payload, alignment_payload = _load_dialogue_payload(agent_payload)

    stages = [_stage_state_from_payload(row) for row in structure_payload.get("stages", [])]
    if not stages:
        raise ValueError(f"No staged structure found for sample: {sample_id}")

    return RuntimeSample(
        sample_id=str(structure_payload.get("sample_id", sample_id)),
        diagram_type=str(structure_payload.get("diagram_type", "unknown")),
        graph_ir=_graph_ir_from_payload(dict(structure_payload.get("graph_ir", {}))),
        stages=stages,
        turns=_turns_from_payload(dialogue_payload, alignment_payload),
        stage_boundaries=_boundaries_from_payload(dialogue_payload),
        metadata={
            "run_root": str(root),
            "structure_path": str(structure_path),
            "agent_path": str(agent_path),
            "agent_status": agent_payload.get("status"),
            "verification_summary": agent_payload.get("verification_summary"),
        },
    )


def list_completed_sample_ids(run_root: str | Path, limit: int = 0) -> list[str]:
    root = resolve_path(run_root)
    sample_dir = root / "agent_cluster" / "sample_outputs"
    sample_ids: list[str] = []
    for path in sorted(sample_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if payload.get("status") in {"completed", "completed_with_warnings"}:
            sample_ids.append(path.stem)
            if limit > 0 and len(sample_ids) >= limit:
                break
    return sample_ids
