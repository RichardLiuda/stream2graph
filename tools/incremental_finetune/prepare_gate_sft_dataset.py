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
    gate_messages,
    iter_samples,
    write_dataset_rows,
    write_manifest,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare incremental gate SFT data for Qwen3.5-4B.")
    parser.add_argument("--run-root", type=str, default=DEFAULT_INCREMENTAL_RUN_ROOT)
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--max-train-samples", type=int, default=0)
    parser.add_argument("--max-validation-samples", type=int, default=0)
    parser.add_argument("--max-test-samples", type=int, default=0)
    parser.add_argument("--recent-turn-limit", type=int, default=8)
    return parser.parse_args()


def _target_payload(action: str, target_stage_index: int | None, reason: str) -> str:
    return json.dumps(
        {
            "action": action,
            "target_stage_index": target_stage_index,
            "reason": reason,
            "confidence": 1.0,
        },
        ensure_ascii=False,
        indent=2,
    )


def build_rows(run_root: str, split: str, max_samples: int, recent_turn_limit: int) -> list[dict]:
    rows: list[dict] = []
    samples = iter_samples(run_root, split, max_samples=max_samples)
    for sample in samples:
        current_stage_index = 0
        for turn_index, turn in enumerate(sample.turns, start=1):
            observed_turns = sample.turns[:turn_index]
            next_stage_index = current_stage_index + 1
            if next_stage_index > sample.total_stages:
                action = "WAIT"
                target_stage = None
                reason = "all stages already applied"
            else:
                boundary = sample.boundary_by_stage(next_stage_index)
                if boundary and turn.turn_id >= boundary.end_turn:
                    action = "EMIT_UPDATE"
                    target_stage = next_stage_index
                    reason = f"turn {turn.turn_id} reached end boundary for stage {next_stage_index}"
                else:
                    action = "WAIT"
                    target_stage = next_stage_index
                    reason = f"waiting for stage {next_stage_index} boundary"
            rows.append(
                {
                    "id": f"{sample.sample_id}_turn_{turn.turn_id:03d}",
                    "messages": [
                        *gate_messages(
                            sample,
                            current_stage_index=current_stage_index,
                            observed_turns=observed_turns,
                            recent_turn_limit=recent_turn_limit,
                        ),
                        {
                            "role": "assistant",
                            "content": _target_payload(action, target_stage, reason),
                        },
                    ],
                    "metadata": {
                        "task": "incremental_gate",
                        "sample_id": sample.sample_id,
                        "split": split,
                        "diagram_type": sample.diagram_type,
                        "turn_id": turn.turn_id,
                        "current_stage_index": current_stage_index,
                        "target_stage_index": target_stage,
                        "oracle_action": action,
                    },
                }
            )
            if action == "EMIT_UPDATE":
                current_stage_index = next_stage_index
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
        rows = build_rows(args.run_root, split, limits.value_for(split), args.recent_turn_limit)
        write_dataset_rows(args.output_dir, split, rows)
        split_counts[split] = len(rows)
        print(f"[gate-sft] split={split} rows={len(rows)}", flush=True)
    manifest = dataset_manifest(
        task_name="incremental_gate_sft",
        run_root=args.run_root,
        output_dir=args.output_dir,
        split_counts=split_counts,
        extra={
            "target_model": "Qwen/Qwen3.5-4B",
            "recent_turn_limit": args.recent_turn_limit,
        },
    )
    manifest_path = write_manifest(args.output_dir, manifest)
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
