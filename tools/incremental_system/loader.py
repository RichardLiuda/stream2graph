from __future__ import annotations

import json
import re
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
    dialogue_payload = _normalize_dialogue_payload(
        agent_payload.get("final_dialogue")
        or (agent_payload.get("dialogue_writer") or {}).get("result")
    )
    alignment_payload = _normalize_alignment_payload(
        agent_payload.get("final_alignment")
        or (agent_payload.get("turn_aligner") or {}).get("result")
    )
    return dialogue_payload, alignment_payload


def _normalize_dialogue_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return dict(payload)
    if not isinstance(payload, list):
        return {}

    normalized: dict[str, Any] = {}
    turns: list[Any] = []

    for item in payload:
        if not isinstance(item, dict):
            continue
        if any(key in item for key in ("dialogue_language", "conversation_title", "turns", "stage_boundaries")):
            for key in ("dialogue_language", "conversation_title", "stage_boundaries", "stage_boundary"):
                if key in item and key not in normalized:
                    normalized[key] = item[key]
            if isinstance(item.get("turns"), list):
                turns.extend(item["turns"])
            continue
        if any(
            key in item
            for key in (
                "speaker",
                "content",
                "turn_id",
                "turn_index",
                "stage_index",
                "stage_transition",
                "stage_boundary_context",
            )
        ):
            turns.append(item)

    if turns:
        normalized["turns"] = turns
    return normalized


def _normalize_alignment_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return dict(payload)
    if not isinstance(payload, list):
        return {}

    normalized: dict[str, Any] = {}
    aligned_turns: list[Any] = []
    trigger_turns: list[Any] = []
    notes: list[Any] = []

    for item in payload:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("aligned_turns"), list):
            aligned_turns.extend(item["aligned_turns"])
        elif any(
            key in item
            for key in ("turn_id", "turn_index", "stage_index", "stage", "aligned_turn_indices", "turn_indices")
        ):
            aligned_turns.append(item)

        if isinstance(item.get("trigger_turns"), list):
            trigger_turns.extend(item["trigger_turns"])
        elif any(key in item for key in ("trigger_type", "source_stage", "target_stage", "trigger_content")):
            trigger_turns.append(item)

        if "notes" in item:
            notes.append(item["notes"])

    if aligned_turns:
        normalized["aligned_turns"] = aligned_turns
    if trigger_turns:
        normalized["trigger_turns"] = trigger_turns
    if notes:
        normalized["notes"] = notes
    return normalized


def _coerce_int_ref(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    match = re.search(r"-?\d+", text)
    if match:
        return int(match.group(0))
    return None


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _extract_turn_ref_from_mapping(row: dict[str, Any]) -> int | None:
    for key in ("turn_id", "turn_index", "trigger_turn", "turn"):
        value = _coerce_int_ref(row.get(key))
        if value is not None:
            return value
    return None


def _expand_turn_refs(value: Any) -> list[int]:
    refs: list[int] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                turn_ref = _extract_turn_ref_from_mapping(item)
                if turn_ref is not None:
                    refs.append(turn_ref)
            else:
                turn_ref = _coerce_int_ref(item)
                if turn_ref is not None:
                    refs.append(turn_ref)
    else:
        turn_ref = _coerce_int_ref(value)
        if turn_ref is not None:
            refs.append(turn_ref)
    return refs


def _alignment_row_turn_refs(row: dict[str, Any]) -> list[int]:
    if isinstance(row.get("aligned_turn_indices"), list):
        refs = _expand_turn_refs(row.get("aligned_turn_indices"))
        if refs:
            return refs
    if isinstance(row.get("turn_indices"), list):
        refs = _expand_turn_refs(row.get("turn_indices"))
        if refs:
            return refs
    if isinstance(row.get("turns"), list):
        refs = _expand_turn_refs(row.get("turns"))
        if refs:
            return refs
    if isinstance(row.get("turn_ids"), list):
        refs = _expand_turn_refs(row.get("turn_ids"))
        if refs:
            return refs
    if isinstance(row.get("turn_alignment"), list):
        refs = _expand_turn_refs(row.get("turn_alignment"))
        if refs:
            return refs
    if isinstance(row.get("turn_range"), list):
        refs = _expand_turn_refs(row.get("turn_range"))
        if len(refs) >= 2 and refs[0] <= refs[-1]:
            return list(range(refs[0], refs[-1] + 1))
    direct_ref = _extract_turn_ref_from_mapping(row)
    if direct_ref is not None:
        return [direct_ref]
    return []


def _raw_turn_references(dialogue_payload: dict[str, Any], alignment_payload: dict[str, Any]) -> list[int]:
    refs: list[int] = []
    for raw in dialogue_payload.get("turns", []):
        if not isinstance(raw, dict):
            continue
        turn_ref = _extract_turn_ref_from_mapping(raw)
        if turn_ref is not None:
            refs.append(turn_ref)

    for row in _aligned_turn_rows(alignment_payload):
        if not isinstance(row, dict):
            continue
        refs.extend(_alignment_row_turn_refs(row))

    for row in _trigger_turn_rows(alignment_payload):
        if isinstance(row, dict):
            turn_ref = _extract_turn_ref_from_mapping(row)
            if turn_ref is not None:
                refs.append(turn_ref)
        else:
            turn_ref = _coerce_int_ref(row)
            if turn_ref is not None:
                refs.append(turn_ref)

    raw_boundaries = dialogue_payload.get("stage_boundaries", [])
    if isinstance(raw_boundaries, dict):
        boundary_rows = raw_boundaries.values()
    else:
        boundary_rows = raw_boundaries
    for row in boundary_rows:
        if not isinstance(row, dict):
            continue
        for key in ("start_turn", "end_turn", "start_line", "end_line"):
            value = row.get(key)
            turn_ref = _coerce_int_ref(value)
            if turn_ref is not None:
                refs.append(turn_ref)
    return refs


def _default_turn_start(dialogue_payload: dict[str, Any], alignment_payload: dict[str, Any]) -> int:
    refs = _raw_turn_references(dialogue_payload, alignment_payload)
    if refs and min(refs) >= 1:
        return 1
    return 0


def _aligned_turn_rows(alignment_payload: dict[str, Any]) -> list[Any]:
    raw_rows = alignment_payload.get("aligned_turns", [])
    if isinstance(raw_rows, list):
        return raw_rows
    if isinstance(raw_rows, dict):
        normalized_rows: list[dict[str, Any]] = []
        for key, value in raw_rows.items():
            if isinstance(value, dict):
                row = dict(value)
                row.setdefault("turn_id", key)
            else:
                row = {
                    "turn_id": key,
                    "stage_name": _coerce_text(value),
                }
            normalized_rows.append(row)
        return normalized_rows
    return []


def _trigger_turn_rows(alignment_payload: dict[str, Any]) -> list[Any]:
    raw_rows = alignment_payload.get("trigger_turns", [])
    if isinstance(raw_rows, list):
        return raw_rows
    if isinstance(raw_rows, dict):
        normalized_rows: list[dict[str, Any]] = []
        for key, value in raw_rows.items():
            if isinstance(value, dict):
                row = dict(value)
                row.setdefault("turn_id", key)
            else:
                row = {
                    "turn_id": key,
                    "note": _coerce_text(value),
                }
            normalized_rows.append(row)
        return normalized_rows
    return []


def _alignment_turn_lookup(alignment_payload: dict[str, Any]) -> dict[int, dict[str, Any]]:
    lookup: dict[int, dict[str, Any]] = {}
    for row in _aligned_turn_rows(alignment_payload):
        if not isinstance(row, dict):
            continue
        stage_index = row.get("stage_index", row.get("stage"))
        stage_name = row.get("stage_name")
        normalized_stage_index = _coerce_int_ref(stage_index)
        turn_refs = _alignment_row_turn_refs(row)
        if not turn_refs:
            continue
        for turn_ref in turn_refs:
            lookup[turn_ref] = {
                "stage_index": normalized_stage_index,
                "stage_name": stage_name,
                "alignment_status": row.get("alignment_status", row.get("status")),
                "alignment_note": row.get("alignment_note", row.get("reason")),
            }
    return lookup


def _trigger_stage_lookup(alignment_payload: dict[str, Any], turn_ids: list[int]) -> dict[int, int]:
    trigger_rows = []
    for index, row in enumerate(_trigger_turn_rows(alignment_payload), start=1):
        if isinstance(row, dict):
            turn_id = _extract_turn_ref_from_mapping(row)
            stage_value = row.get(
                "stage_index",
                row.get("stage", row.get("triggered_stage", row.get("to_stage", index + 1))),
            )
        else:
            turn_id = _coerce_int_ref(row)
            stage_value = index + 1
        if turn_id is None:
            continue
        stage_index = _coerce_int_ref(stage_value)
        if stage_index is None:
            stage_index = index + 1
        trigger_rows.append(
            {
                "turn_id": turn_id,
                "stage_index": stage_index,
            }
        )
    trigger_rows.sort(key=lambda item: item["turn_id"])
    if not trigger_rows:
        return {}

    lookup: dict[int, int] = {}
    cursor = 0
    current_stage = trigger_rows[0]["stage_index"]
    for turn_id in sorted(turn_ids):
        while cursor + 1 < len(trigger_rows) and turn_id >= trigger_rows[cursor + 1]["turn_id"]:
            cursor += 1
            current_stage = trigger_rows[cursor]["stage_index"]
        if turn_id >= trigger_rows[0]["turn_id"]:
            lookup[turn_id] = current_stage
    return lookup


def _boundary_sequence_exact(turns: list[DialogueTurn], boundaries: list[StageBoundary]) -> bool:
    if not turns:
        return len(boundaries) == 0
    ordered_turn_ids = [int(turn.turn_id) for turn in sorted(turns, key=lambda item: item.turn_id)]
    covered_turns: list[int] = []
    last_end: int | None = None
    for boundary in sorted(boundaries, key=lambda item: (int(item.stage_index), int(item.start_turn), int(item.end_turn))):
        start_turn = int(boundary.start_turn)
        end_turn = int(boundary.end_turn)
        if end_turn < start_turn:
            return False
        if last_end is not None and start_turn != (last_end + 1):
            return False
        covered_turns.extend(range(start_turn, end_turn + 1))
        last_end = end_turn
    return covered_turns == ordered_turn_ids


def _normalize_boundary_stage_indices(boundaries: list[StageBoundary]) -> list[StageBoundary]:
    normalized: list[StageBoundary] = []
    for index, boundary in enumerate(
        sorted(boundaries, key=lambda item: (int(item.start_turn), int(item.end_turn), int(item.stage_index))),
        start=1,
    ):
        normalized.append(
            StageBoundary(
                stage_index=index,
                start_turn=int(boundary.start_turn),
                end_turn=int(boundary.end_turn),
                stage_name=boundary.stage_name,
            )
        )
    return normalized


def _boundary_candidate_score(
    turns: list[DialogueTurn],
    boundaries: list[StageBoundary],
    expected_stage_count: int,
) -> tuple[int, int, int, int]:
    exact_coverage = 1 if _boundary_sequence_exact(turns, boundaries) else 0
    exact_stage_count = 1 if expected_stage_count > 0 and len(boundaries) == expected_stage_count else 0
    stage_count_gap = -abs(len(boundaries) - expected_stage_count) if expected_stage_count > 0 else 0
    covered_turns = sum(max(0, int(boundary.end_turn) - int(boundary.start_turn) + 1) for boundary in boundaries)
    return (exact_coverage, exact_stage_count, stage_count_gap, covered_turns)


def _turns_from_payload(dialogue_payload: dict[str, Any], alignment_payload: dict[str, Any]) -> list[DialogueTurn]:
    aligned_stage_lookup = _alignment_turn_lookup(alignment_payload)
    fallback_turn_start = _default_turn_start(dialogue_payload, alignment_payload)
    turns: list[DialogueTurn] = []
    for index, raw in enumerate(dialogue_payload.get("turns", []), start=fallback_turn_start):
        if not isinstance(raw, dict):
            continue
        turn_id = _extract_turn_ref_from_mapping(raw)
        if turn_id is None:
            turn_id = index
        aligned = aligned_stage_lookup.get(turn_id, {})
        stage_index = _coerce_int_ref(
            raw.get(
                "stage_index",
                raw.get(
                    "stage",
                    raw.get(
                        "stage_from",
                        raw.get(
                            "stage_to",
                            raw.get("stage_relevance", aligned.get("stage_index")),
                        ),
                    ),
                ),
            )
        )
        turns.append(
            DialogueTurn(
                turn_id=turn_id,
                speaker=str(raw.get("speaker", "")),
                content=_coerce_text(
                    raw.get(
                        "content",
                        raw.get(
                            "utterance",
                            raw.get(
                                "text",
                                raw.get("message", raw.get("value", "")),
                            ),
                        ),
                    )
                ),
                stage_index=stage_index,
                metadata={
                    "alignment_status": aligned.get("alignment_status"),
                    "alignment_note": aligned.get("alignment_note"),
                    "stage_name": aligned.get("stage_name"),
                },
            )
        )
    trigger_lookup = _trigger_stage_lookup(alignment_payload, [turn.turn_id for turn in turns])
    for turn in turns:
        if turn.stage_index is None and turn.turn_id in trigger_lookup:
            turn.stage_index = trigger_lookup[turn.turn_id]
    return sorted(turns, key=lambda item: item.turn_id)


def _boundaries_from_payload(
    dialogue_payload: dict[str, Any],
    alignment_payload: dict[str, Any],
    turns: list[DialogueTurn],
    expected_stage_count: int = 0,
) -> list[StageBoundary]:
    raw_boundaries = dialogue_payload.get("stage_boundaries", [])
    max_turn_id = max((turn.turn_id for turn in turns), default=0)
    boundaries: list[StageBoundary] = []
    if isinstance(raw_boundaries, dict):
        items = sorted(raw_boundaries.items(), key=lambda item: item[0])
        derived_simple_bounds: dict[int, dict[str, Any]] = {}
        for key, row in items:
            if isinstance(row, dict):
                stage_index = row.get("stage_index")
                if stage_index is None:
                    digits = "".join(ch for ch in str(key) if ch.isdigit())
                    stage_index = int(digits) if digits else 0
                turn_refs = _expand_turn_refs(row.get("turns") or row.get("turn_ids") or [])
                start_turn = _coerce_int_ref(row.get("start_turn"))
                end_turn = _coerce_int_ref(row.get("end_turn"))
                if start_turn is None:
                    start_turn = _coerce_int_ref(row.get("starts_at_turn"))
                if end_turn is None:
                    end_turn = _coerce_int_ref(row.get("ends_at_turn"))
                boundary_after_turn = _coerce_int_ref(row.get("boundary_after_turn"))
                if turn_refs and (start_turn is None or end_turn is None):
                    start_turn = min(turn_refs)
                    end_turn = max(turn_refs)
                if end_turn is None and boundary_after_turn is not None:
                    end_turn = boundary_after_turn
                start_line = _coerce_int_ref(row.get("start_line"))
                end_line = _coerce_int_ref(row.get("end_line"))
                if (start_turn is None or end_turn is None) and start_line is not None and end_line is not None:
                    start_turn = start_line
                    end_turn = end_line
                boundaries.append(
                    StageBoundary(
                        stage_index=int(stage_index or 0),
                        start_turn=int(start_turn or 0),
                        end_turn=int(end_turn or 0),
                        stage_name=str(row.get("stage_name") or row.get("stage_title") or row.get("title") or row.get("description") or ""),
                    )
                )
                continue

            stage_index = _coerce_int_ref(key)
            turn_ref = _coerce_int_ref(row)
            if stage_index is None or turn_ref is None:
                continue
            bucket = derived_simple_bounds.setdefault(stage_index, {"start_turn": None, "end_turn": None})
            lower_key = str(key).lower()
            if "start" in lower_key:
                bucket["start_turn"] = turn_ref
            else:
                bucket["end_turn"] = turn_ref
        if derived_simple_bounds:
            ordered = sorted(derived_simple_bounds.items())
            fallback_start = min((turn.turn_id for turn in turns), default=0)
            previous_end = fallback_start - 1
            for stage_index, bucket in ordered:
                start_turn = bucket["start_turn"]
                end_turn = bucket["end_turn"]
                if start_turn is None:
                    start_turn = previous_end + 1
                if end_turn is None:
                    end_turn = start_turn
                boundaries.append(
                    StageBoundary(
                        stage_index=stage_index,
                        start_turn=int(start_turn),
                        end_turn=int(end_turn),
                        stage_name="",
                    )
                )
                previous_end = int(end_turn)
        boundaries = sorted(boundaries, key=lambda item: item.stage_index)
    else:
        for row in raw_boundaries:
            if not isinstance(row, dict):
                continue
            start_turn = row.get("start_turn")
            end_turn = row.get("end_turn")
            if start_turn is None:
                start_turn = row.get("starts_at_turn")
            if end_turn is None:
                end_turn = row.get("ends_at_turn")
            boundary_after_turn = _coerce_int_ref(row.get("boundary_after_turn"))
            if end_turn is None and boundary_after_turn is not None:
                end_turn = boundary_after_turn
            start_line = _coerce_int_ref(row.get("start_line"))
            end_line = _coerce_int_ref(row.get("end_line"))
            if (start_turn is None or end_turn is None) and start_line is not None and end_line is not None:
                start_turn = start_line
                end_turn = end_line
            boundaries.append(
                StageBoundary(
                    stage_index=int(row.get("stage_index", 0) or 0),
                    start_turn=int(start_turn or 0),
                    end_turn=int(end_turn or 0),
                    stage_name=str(row.get("stage_name") or row.get("stage_title") or row.get("title") or row.get("description") or ""),
                )
            )
        boundaries = sorted(boundaries, key=lambda item: item.stage_index)

    plausible_boundaries = [
        boundary
        for boundary in boundaries
        if 0 <= boundary.start_turn <= boundary.end_turn <= max_turn_id
    ]
    candidate_boundaries: list[list[StageBoundary]] = []
    if len(plausible_boundaries) == len(boundaries) and plausible_boundaries:
        candidate_boundaries.append(_normalize_boundary_stage_indices(plausible_boundaries))

    aligned_boundaries: list[StageBoundary] = []
    for row in _aligned_turn_rows(alignment_payload):
        if not isinstance(row, dict):
            continue
        stage_index = _coerce_int_ref(row.get("stage_index", row.get("stage")))
        refs = _alignment_row_turn_refs(row)
        if stage_index is None or not refs:
            continue
        aligned_boundaries.append(
            StageBoundary(
                stage_index=stage_index,
                start_turn=min(refs),
                end_turn=max(refs),
                stage_name=str(row.get("stage_name", "")),
            )
        )
    if aligned_boundaries:
        candidate_boundaries.append(_normalize_boundary_stage_indices(aligned_boundaries))

    trigger_rows = []
    for index, row in enumerate(_trigger_turn_rows(alignment_payload), start=1):
        if isinstance(row, dict):
            turn_ref = _extract_turn_ref_from_mapping(row)
            stage_index = _coerce_int_ref(
                row.get(
                    "stage_index",
                    row.get("stage", row.get("triggered_stage", row.get("to_stage", index + 1))),
                )
            )
            stage_name = str(row.get("stage_name") or row.get("description") or "")
        else:
            turn_ref = _coerce_int_ref(row)
            stage_index = index + 1
            stage_name = ""
        if turn_ref is None or stage_index is None:
            continue
        trigger_rows.append((stage_index, turn_ref, stage_name))
    trigger_rows.sort(key=lambda item: item[1])
    if trigger_rows:
        derived: list[StageBoundary] = []
        for index, (stage_index, start_turn, stage_name) in enumerate(trigger_rows):
            next_start = trigger_rows[index + 1][1] if index + 1 < len(trigger_rows) else (max_turn_id + 1)
            derived.append(
                StageBoundary(
                    stage_index=stage_index,
                    start_turn=start_turn,
                    end_turn=max(start_turn, next_start - 1),
                    stage_name=stage_name,
                )
            )
        candidate_boundaries.append(_normalize_boundary_stage_indices(derived))

    stage_groups: dict[int, list[int]] = {}
    for turn in turns:
        if turn.stage_index is None:
            continue
        stage_groups.setdefault(int(turn.stage_index), []).append(turn.turn_id)
    if stage_groups:
        grouped_boundaries = [
            StageBoundary(
                stage_index=stage_index,
                start_turn=min(refs),
                end_turn=max(refs),
                stage_name="",
            )
            for stage_index, refs in sorted(stage_groups.items())
        ]
        candidate_boundaries.append(_normalize_boundary_stage_indices(grouped_boundaries))

    if candidate_boundaries:
        return max(
            candidate_boundaries,
            key=lambda item: _boundary_candidate_score(turns, item, expected_stage_count),
        )
    if plausible_boundaries:
        return _normalize_boundary_stage_indices(plausible_boundaries)
    return _normalize_boundary_stage_indices(boundaries)


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

    turns = _turns_from_payload(dialogue_payload, alignment_payload)
    boundaries = _boundaries_from_payload(
        dialogue_payload,
        alignment_payload,
        turns,
        expected_stage_count=len(stages),
    )

    return RuntimeSample(
        sample_id=str(structure_payload.get("sample_id", sample_id)),
        diagram_type=str(structure_payload.get("diagram_type", "unknown")),
        graph_ir=_graph_ir_from_payload(dict(structure_payload.get("graph_ir", {}))),
        stages=stages,
        turns=turns,
        stage_boundaries=boundaries,
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
