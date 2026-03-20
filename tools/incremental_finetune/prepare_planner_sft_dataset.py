#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.incremental_dataset import DEFAULT_INCREMENTAL_RUN_ROOT
from tools.incremental_finetune.common import (
    SplitLimit,
    dataset_manifest,
    iter_samples,
    planner_messages,
    write_dataset_rows,
    write_manifest,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare incremental planner SFT data for Qwen3.5-27B.")
    parser.add_argument("--run-root", type=str, default=DEFAULT_INCREMENTAL_RUN_ROOT)
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--max-train-samples", type=int, default=0)
    parser.add_argument("--max-validation-samples", type=int, default=0)
    parser.add_argument("--max-test-samples", type=int, default=0)
    parser.add_argument("--recent-turn-limit", type=int, default=24)
    parser.add_argument("--omit-target-graph", action="store_true")
    return parser.parse_args()


def _target_payload(stage, omit_target_graph: bool) -> str:
    payload = {
        "target_stage_index": stage.stage_index,
        "delta_ops": list(stage.delta_ops),
        "notes": stage.stage_description,
    }
    if not omit_target_graph:
        payload["target_graph_ir"] = stage.graph_ir.to_payload()
    return json.dumps(payload, ensure_ascii=False, indent=2)


def build_rows(run_root: str, split: str, max_samples: int, recent_turn_limit: int, omit_target_graph: bool) -> list[dict]:
    rows: list[dict] = []
    samples = iter_samples(run_root, split, max_samples=max_samples)
    for sample in samples:
        current_stage_index = 0
        for stage in sample.stages:
            boundary = sample.boundary_by_stage(stage.stage_index)
            if boundary is not None:
                observed_turns = [turn for turn in sample.turns if turn.turn_id <= boundary.end_turn]
            else:
                observed_turns = [
                    turn
                    for turn in sample.turns
                    if turn.stage_index is not None and int(turn.stage_index) <= int(stage.stage_index)
                ]
            rows.append(
                {
                    "id": f"{sample.sample_id}_stage_{stage.stage_index:02d}",
                    "messages": [
                        *planner_messages(
                            sample,
                            current_stage_index=current_stage_index,
                            next_stage_index=stage.stage_index,
                            observed_turns=observed_turns,
                            recent_turn_limit=recent_turn_limit,
                        ),
                        {
                            "role": "assistant",
                            "content": _target_payload(stage, omit_target_graph),
                        },
                    ],
                    "metadata": {
                        "task": "incremental_planner",
                        "sample_id": sample.sample_id,
                        "split": split,
                        "diagram_type": sample.diagram_type,
                        "stage_index": stage.stage_index,
                        "current_stage_index": current_stage_index,
                        "delta_op_count": len(stage.delta_ops),
                    },
                }
            )
            current_stage_index = stage.stage_index
    return rows


def main() -> None:
    args = parse_args()
    limits = SplitLimit(
        train=args.max_train_samples,
        validation=args.max_validation_samples,
        test=args.max_test_samples,
    )
    split_counts: dict[str, int] = {}
    for split in ("train", "validation", "test"):
        rows = build_rows(
            args.run_root,
            split,
            limits.value_for(split),
            args.recent_turn_limit,
            args.omit_target_graph,
        )
        write_dataset_rows(args.output_dir, split, rows)
        split_counts[split] = len(rows)
        print(f"[planner-sft] split={split} rows={len(rows)}", flush=True)
    manifest = dataset_manifest(
        task_name="incremental_planner_sft",
        run_root=args.run_root,
        output_dir=args.output_dir,
        split_counts=split_counts,
        extra={
            "target_model": "Qwen/Qwen3.5-27B",
            "recent_turn_limit": args.recent_turn_limit,
            "omit_target_graph": args.omit_target_graph,
        },
    )
    manifest_path = write_manifest(args.output_dir, manifest)
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
