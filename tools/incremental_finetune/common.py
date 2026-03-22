from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from tools.eval.common import append_jsonl, resolve_path, utc_iso, write_json
from tools.eval.incremental_dataset import DEFAULT_INCREMENTAL_RUN_ROOT, load_incremental_entries
from tools.incremental_system.algorithm import build_empty_graph, graph_metrics
from tools.incremental_system.loader import load_runtime_sample
from tools.incremental_system.models import (
    GATE_SYSTEM_PROMPT,
    PLANNER_SYSTEM_PROMPT,
    _build_recent_dialogue_snapshot,
    _diagram_type_alignment_priors,
    _extract_identifier_candidates,
    _recent_turns,
)
from tools.incremental_system.schema import DialogueTurn, RuntimeSample


@dataclass
class SplitLimit:
    train: int = 0
    validation: int = 0
    test: int = 0

    def value_for(self, split: str) -> int:
        return {
            "train": self.train,
            "validation": self.validation,
            "test": self.test,
        }.get(split, 0)


def current_graph_payload(sample: RuntimeSample, current_stage_index: int) -> dict:
    if current_stage_index <= 0:
        return build_empty_graph(sample.sample_id, sample.diagram_type).to_payload()
    return sample.stage_by_index(current_stage_index).graph_ir.to_payload()


def current_graph_metrics(sample: RuntimeSample, current_stage_index: int) -> dict:
    if current_stage_index <= 0:
        return graph_metrics(build_empty_graph(sample.sample_id, sample.diagram_type))
    return graph_metrics(sample.stage_by_index(current_stage_index).graph_ir)


def gate_messages(
    sample: RuntimeSample,
    *,
    current_stage_index: int,
    observed_turns: list[DialogueTurn],
    recent_turn_limit: int = 8,
) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": GATE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "sample_id": sample.sample_id,
                    "diagram_type": sample.diagram_type,
                    "total_stages": sample.total_stages,
                    "current_stage_index": current_stage_index,
                    "next_stage_index_hint": min(current_stage_index + 1, sample.total_stages),
                    "recent_turns": _recent_turns(observed_turns, recent_turn_limit),
                    "current_state": current_graph_metrics(sample, current_stage_index),
                },
                ensure_ascii=False,
                indent=2,
            ),
        },
    ]


def planner_messages(
    sample: RuntimeSample,
    *,
    current_stage_index: int,
    next_stage_index: int,
    observed_turns: list[DialogueTurn],
    recent_turn_limit: int = 24,
) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "sample_id": sample.sample_id,
                    "diagram_type": sample.diagram_type,
                    "current_stage_index": current_stage_index,
                    "next_stage_index_hint": next_stage_index,
                    "total_stages_hint": sample.total_stages,
                    "observed_turns": _recent_turns(observed_turns, recent_turn_limit),
                    "identifier_candidates": list(_extract_identifier_candidates(observed_turns).values())[:24],
                    "recent_dialogue_snapshot": _build_recent_dialogue_snapshot(observed_turns),
                    "diagram_type_priors": _diagram_type_alignment_priors(sample.diagram_type),
                    "current_graph_ir": current_graph_payload(sample, current_stage_index),
                    "current_state_metrics": current_graph_metrics(sample, current_stage_index),
                    "output_contract": {
                        "target_stage_index": "integer",
                        "delta_ops": [
                            {
                                "op": "add_group|add_node|add_edge",
                                "group_id": "for add_group",
                                "node_id": "for add_node",
                                "edge_id": "for add_edge",
                                "label": "string",
                                "kind": "string",
                                "source": "for add_edge",
                                "target": "for add_edge",
                                "parent": "optional parent group id",
                            }
                        ],
                        "notes": "short string",
                        "target_graph_ir": "optional full graph object",
                    },
                },
                ensure_ascii=False,
                indent=2,
            ),
        },
    ]


def iter_samples(run_root: str, split: str, max_samples: int = 0) -> list[RuntimeSample]:
    entries = load_incremental_entries(run_root=run_root, split=split, max_samples=max_samples)
    return [load_runtime_sample(run_root, entry.sample_id) for entry in entries]


def write_dataset_rows(output_dir: str | Path, split: str, rows: list[dict]) -> Path:
    target = resolve_path(output_dir) / f"{split}.jsonl"
    if target.exists():
        target.unlink()
    for row in rows:
        append_jsonl(target, row)
    return target


def write_manifest(output_dir: str | Path, payload: dict) -> Path:
    path = resolve_path(output_dir) / "manifest.json"
    write_json(path, payload)
    return path


def dataset_manifest(
    *,
    task_name: str,
    run_root: str,
    output_dir: str | Path,
    split_counts: dict[str, int],
    extra: dict | None = None,
) -> dict:
    payload = {
        "generated_at_utc": utc_iso(),
        "task_name": task_name,
        "run_root": str(resolve_path(run_root or DEFAULT_INCREMENTAL_FINETUNE_RUN_ROOT or DEFAULT_INCREMENTAL_RUN_ROOT)),
        "output_dir": str(resolve_path(output_dir)),
        "split_counts": split_counts,
    }
    if extra:
        payload.update(extra)
    return payload
DEFAULT_INCREMENTAL_FINETUNE_RUN_ROOT = "data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean"
