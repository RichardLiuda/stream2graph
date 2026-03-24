#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_jsonl, resolve_path, write_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair only the error rows of an incremental benchmark run.")
    parser.add_argument("--config", required=True, type=str)
    parser.add_argument("--run-name", required=True, type=str)
    parser.add_argument("--output-root", type=str, default="reports/evaluation/runs/incremental_system")
    parser.add_argument("--max-passes", type=int, default=2)
    parser.add_argument("--max-concurrency", type=int, default=0)
    parser.add_argument("--max-retries", type=int, default=0)
    parser.add_argument("--retry-backoff-sec", type=float, default=0.0)
    parser.add_argument("--timeout-sec", type=int, default=0)
    return parser.parse_args()


def _is_error_row(row: dict) -> bool:
    value = row.get("error")
    return value not in (None, "", False)


def _run_root(args: argparse.Namespace) -> Path:
    return resolve_path(args.output_root) / args.run_name


def _predictions_path(run_root: Path) -> Path:
    return run_root / "inference" / "predictions.jsonl"


def _details_dir(run_root: Path) -> Path:
    return run_root / "inference" / "details"


def _repair_dir(run_root: Path) -> Path:
    return run_root / "repair"


def _error_sample_ids(rows: list[dict]) -> list[str]:
    return [str(row.get("sample_id")) for row in rows if _is_error_row(row) and row.get("sample_id")]


def _rewrite_predictions(predictions_path: Path, kept_rows: list[dict], pass_index: int) -> None:
    backup_path = predictions_path.with_suffix(f".before_error_repair_pass{pass_index}.jsonl")
    shutil.copy2(predictions_path, backup_path)
    with predictions_path.open("w", encoding="utf-8") as handle:
        for row in kept_rows:
            handle.write(__import__("json").dumps(row, ensure_ascii=False) + "\n")


def _delete_error_details(details_dir: Path, sample_ids: list[str]) -> None:
    for sample_id in sample_ids:
        detail_path = details_dir / f"{sample_id}.json"
        if detail_path.exists():
            detail_path.unlink()


def _run_benchmark(args: argparse.Namespace, sample_ids_file: Path) -> None:
    command = [
        sys.executable,
        str(resolve_path("tools/eval/run_incremental_benchmark.py")),
        "--config",
        str(resolve_path(args.config)),
        "--run-name",
        args.run_name,
        "--sample-ids-file",
        str(sample_ids_file),
    ]
    if args.max_concurrency > 0:
        command.extend(["--max-concurrency", str(args.max_concurrency)])
    if args.max_retries > 0:
        command.extend(["--max-retries", str(args.max_retries)])
    if args.retry_backoff_sec > 0:
        command.extend(["--retry-backoff-sec", str(args.retry_backoff_sec)])
    if args.timeout_sec > 0:
        command.extend(["--timeout-sec", str(args.timeout_sec)])
    subprocess.run(command, cwd=resolve_path("."), check=True)


def main() -> None:
    args = parse_args()
    run_root = _run_root(args)
    predictions_path = _predictions_path(run_root)
    details_dir = _details_dir(run_root)
    repair_dir = _repair_dir(run_root)
    repair_dir.mkdir(parents=True, exist_ok=True)

    if not predictions_path.exists():
        print(f"[repair] predictions missing for run {args.run_name}: {predictions_path}")
        return

    for pass_index in range(1, args.max_passes + 1):
        rows = read_jsonl(predictions_path)
        error_ids = _error_sample_ids(rows)
        if not error_ids:
            print(f"[repair] run={args.run_name} pass={pass_index} no error rows left")
            return

        print(f"[repair] run={args.run_name} pass={pass_index} repairing {len(error_ids)} error rows")
        kept_rows = [row for row in rows if not _is_error_row(row)]
        _rewrite_predictions(predictions_path, kept_rows, pass_index)
        _delete_error_details(details_dir, error_ids)

        sample_ids_file = repair_dir / f"error_sample_ids.pass{pass_index}.json"
        write_json(sample_ids_file, {"ids": error_ids})
        _run_benchmark(args, sample_ids_file)

    final_rows = read_jsonl(predictions_path)
    remaining = len(_error_sample_ids(final_rows))
    print(f"[repair] run={args.run_name} finished with remaining_error_rows={remaining}")


if __name__ == "__main__":
    main()
