from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from tools.eval.common import read_json, resolve_path


DEFAULT_INCREMENTAL_RUN_ROOT = "data/incremental_dataset/runs/minimax_m27_incremental_full_v1"


@dataclass
class IncrementalEvaluationEntry:
    sample_id: str
    split: str
    diagram_type: str
    source_path: str
    complexity_bucket: int | None
    metadata: dict


def load_incremental_split_ids(selection_root: str | Path) -> dict[str, list[str]]:
    selection_root = resolve_path(selection_root)
    split_dir = selection_root / "splits"
    split_map: dict[str, list[str]] = {}
    for split_name, file_name in (
        ("train", "train_ids.json"),
        ("validation", "validation_ids.json"),
        ("test", "test_ids.json"),
    ):
        payload = read_json(split_dir / file_name)
        split_map[split_name] = [str(item) for item in payload.get("ids", [])]
    return split_map


def load_incremental_entries(
    run_root: str | Path = DEFAULT_INCREMENTAL_RUN_ROOT,
    split: str = "test",
    max_samples: int = 0,
    sample_ids: Optional[set[str]] = None,
) -> list[IncrementalEvaluationEntry]:
    root = resolve_path(run_root)
    selection_root = root / "selection"
    manifest = read_json(selection_root / "selection_manifest.json")
    split_map = load_incremental_split_ids(selection_root)

    if split == "all":
        ordered_ids: list[tuple[str, str]] = []
        for split_name in ("train", "validation", "test"):
            ordered_ids.extend((sample_id, split_name) for sample_id in split_map[split_name])
    else:
        ordered_ids = [(sample_id, split) for sample_id in split_map[split]]

    profile_lookup = {
        str(row.get("sample_id")): row
        for row in manifest.get("selected_profiles", [])
        if row.get("sample_id")
    }
    rows: list[IncrementalEvaluationEntry] = []
    for sample_id, sample_split in ordered_ids:
        if sample_ids is not None and sample_id not in sample_ids:
            continue
        profile = dict(profile_lookup.get(sample_id, {}))
        rows.append(
            IncrementalEvaluationEntry(
                sample_id=sample_id,
                split=sample_split,
                diagram_type=str(profile.get("diagram_type", "unknown")),
                source_path=str(profile.get("source_path", "")),
                complexity_bucket=(
                    int(profile["complexity_bucket"])
                    if profile.get("complexity_bucket") is not None
                    else None
                ),
                metadata=profile,
            )
        )
        if max_samples > 0 and len(rows) >= max_samples:
            break
    return rows


def load_incremental_sample_ids(path_value: str) -> set[str]:
    if not path_value:
        return set()
    path = resolve_path(path_value)
    if path.suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        values = payload.get("ids", payload) if isinstance(payload, dict) else payload
        return {str(item) for item in values}
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
