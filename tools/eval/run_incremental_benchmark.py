#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, slugify, write_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the incremental Stream2Graph benchmark.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--run-root", type=str, default="data/incremental_dataset/runs/minimax_m27_incremental_full_v1")
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test", "all"])
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--sample-ids-file", type=str, default="")
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--gate-kind", type=str, default="oracle", choices=["oracle", "openai_compatible"])
    parser.add_argument("--planner-kind", type=str, default="oracle", choices=["oracle", "openai_compatible"])
    parser.add_argument("--gate-endpoint", type=str, default="")
    parser.add_argument("--gate-model", type=str, default="")
    parser.add_argument("--gate-api-key-env", type=str, default="OPENAI_API_KEY")
    parser.add_argument("--gate-api-key", type=str, default="")
    parser.add_argument("--gate-extra-body-json", type=str, default="")
    parser.add_argument("--planner-endpoint", type=str, default="")
    parser.add_argument("--planner-model", type=str, default="")
    parser.add_argument("--planner-api-key-env", type=str, default="OPENAI_API_KEY")
    parser.add_argument("--planner-api-key", type=str, default="")
    parser.add_argument("--planner-extra-body-json", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff-sec", type=float, default=3.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.0)
    parser.add_argument("--run-name", type=str, default="")
    parser.add_argument("--output-root", type=str, default="reports/evaluation/runs/incremental_system")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def _run_script(script: str, config_path: Path) -> None:
    command = [sys.executable, str(resolve_path(script)), "--config", str(config_path)]
    subprocess.run(command, cwd=resolve_path("."), check=True)


def main() -> None:
    args = parse_args()
    planner_label = args.planner_model or args.planner_kind
    gate_label = args.gate_model or args.gate_kind
    run_name = args.run_name or slugify(f"incremental_{gate_label}_{planner_label}_{args.split}")
    run_root = resolve_path(args.output_root) / run_name
    config_root = run_root / "configs"
    inference_dir = run_root / "inference"
    metrics_dir = run_root / "metrics"
    config_root.mkdir(parents=True, exist_ok=True)

    inference_config = {
        "run_root": args.run_root,
        "split": args.split,
        "max_samples": args.max_samples,
        "sample_ids_file": args.sample_ids_file,
        "resume": True,
        "output_jsonl": str(inference_dir / "predictions.jsonl"),
        "manifest_output": str(inference_dir / "manifest.json"),
        "details_dir": str(inference_dir / "details"),
        "max_concurrency": args.max_concurrency,
        "gate_kind": args.gate_kind,
        "planner_kind": args.planner_kind,
        "gate_endpoint": args.gate_endpoint,
        "gate_model": args.gate_model,
        "gate_api_key_env": args.gate_api_key_env,
        "gate_api_key": args.gate_api_key,
        "gate_extra_body_json": args.gate_extra_body_json,
        "planner_endpoint": args.planner_endpoint,
        "planner_model": args.planner_model,
        "planner_api_key_env": args.planner_api_key_env,
        "planner_api_key": args.planner_api_key,
        "planner_extra_body_json": args.planner_extra_body_json,
        "temperature": args.temperature,
        "timeout_sec": args.timeout_sec,
        "max_retries": args.max_retries,
        "retry_backoff_sec": args.retry_backoff_sec,
        "request_interval_sec": args.request_interval_sec,
    }
    metrics_config = {
        "input_jsonl": str(inference_dir / "predictions.jsonl"),
        "output_dir": str(metrics_dir),
    }

    inference_config_path = config_root / "incremental_inference.json"
    metrics_config_path = config_root / "incremental_metrics.json"
    write_json(inference_config_path, inference_config)
    write_json(metrics_config_path, metrics_config)

    _run_script("tools/eval/run_incremental_inference.py", inference_config_path)
    _run_script("tools/eval/run_incremental_metrics.py", metrics_config_path)

    print(f"Run root: {run_root}")


if __name__ == "__main__":
    main()
