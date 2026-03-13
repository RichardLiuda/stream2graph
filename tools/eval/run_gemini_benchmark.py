#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import inject_api_key, resolve_path, slugify, write_json
from tools.eval.export_run_bundle import export_entries


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Gemini benchmark workflow for Stream2Graph.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--model", type=str, default="gemini-2.5-pro")
    parser.add_argument("--endpoint", type=str, default="")
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test", "all"])
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--api-key-env", type=str, default="GOOGLE_API_KEY")
    parser.add_argument("--api-key", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=6)
    parser.add_argument("--retry-backoff-sec", type=float, default=5.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.5)
    parser.add_argument("--source-dir", type=str, default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228")
    parser.add_argument("--split-dir", type=str, default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228/splits")
    parser.add_argument("--compile-command", type=str, default="")
    parser.add_argument("--run-name", type=str, default="")
    parser.add_argument("--output-root", type=str, default="reports/evaluation/runs/google")
    parser.add_argument("--publish-bundle", action="store_true")
    parser.add_argument("--published-dir", type=str, default="reports/evaluation/published")
    parser.add_argument("--notes", type=str, default="")
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
    inject_api_key(args.api_key_env, args.api_key)
    run_name = args.run_name or slugify(f"gemini_{args.model}_{args.split}")
    run_root = resolve_path(args.output_root) / run_name
    config_root = run_root / "configs"
    inference_dir = run_root / "inference"
    offline_dir = run_root / "offline"
    report_dir = run_root / "report"
    config_root.mkdir(parents=True, exist_ok=True)

    inference_config = {
        "source_dir": args.source_dir,
        "split_dir": args.split_dir,
        "split": args.split,
        "max_samples": args.max_samples,
        "resume": True,
        "output_jsonl": str(inference_dir / "predictions.jsonl"),
        "manifest_output": str(inference_dir / "manifest.json"),
        "provider": "google_generate_content",
        "endpoint": args.endpoint,
        "model": args.model,
        "api_key_env": args.api_key_env,
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
        "timeout_sec": args.timeout_sec,
        "max_retries": args.max_retries,
        "retry_backoff_sec": args.retry_backoff_sec,
        "request_interval_sec": args.request_interval_sec,
    }
    offline_config = {
        "input_jsonl": str(inference_dir / "predictions.jsonl"),
        "output_dir": str(offline_dir),
        "compile_command": args.compile_command,
    }
    report_config = {
        "title": f"Gemini {args.model} Stream2Graph Offline Benchmark",
        "offline_summary": str(offline_dir / "offline_metrics.summary.json"),
        "realtime_summary": "",
        "output_dir": str(report_dir),
        "notes": args.notes or f"Offline API benchmark for Gemini / {args.model}.",
    }
    suite_config = {
        "title": f"Gemini {args.model} Evaluation Suite",
        "output_dir": str(run_root / "suite"),
        "stop_on_error": True,
        "steps": {
            "inference": {"enabled": True, "config": str(config_root / "inference.json")},
            "offline_metrics": {"enabled": True, "config": str(config_root / "offline_metrics.json")},
            "realtime_metrics": {"enabled": False, "config": ""},
            "benchmark_report": {"enabled": True, "config": str(config_root / "benchmark_report.json")},
        },
    }

    inference_config_path = config_root / "inference.json"
    offline_config_path = config_root / "offline_metrics.json"
    report_config_path = config_root / "benchmark_report.json"
    suite_config_path = config_root / "suite.json"
    write_json(inference_config_path, inference_config)
    write_json(offline_config_path, offline_config)
    write_json(report_config_path, report_config)
    write_json(suite_config_path, suite_config)

    _run_script("tools/eval/run_eval_suite.py", suite_config_path)

    if args.publish_bundle:
        bundle_dir = export_entries(
            bundle_name=run_name,
            published_dir=args.published_dir,
            entries=[
                ("configs", config_root),
                ("inference", inference_dir),
                ("offline", offline_dir),
                ("report", report_dir),
                ("suite", run_root / "suite"),
            ],
            notes=args.notes or f"Published benchmark bundle for Gemini / {args.model}.",
        )
        print(f"Published bundle: {bundle_dir}")

    print(f"Run root: {run_root}")


if __name__ == "__main__":
    main()
