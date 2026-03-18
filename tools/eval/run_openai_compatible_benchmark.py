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


DEFAULT_ENDPOINTS = {
    "openai_compatible_chat": "",
    "claude_chat_completions": "https://api.anthropic.com/v1/chat/completions",
    "moonshot_chat_completions": "https://api.moonshot.cn/v1/chat/completions",
    "deepseek_chat_completions": "https://api.deepseek.com/chat/completions",
    "minimax_chat_completions": "https://api.minimax.io/v1/chat/completions",
    "dashscope_chat_completions": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "siliconflow_chat_completions": "https://api.siliconflow.com/v1/chat/completions",
    "openrouter_chat_completions": "https://openrouter.ai/api/v1/chat/completions",
}

DEFAULT_API_KEY_ENVS = {
    "openai_compatible_chat": "OPENAI_API_KEY",
    "claude_chat_completions": "ANTHROPIC_API_KEY",
    "moonshot_chat_completions": "MOONSHOT_API_KEY",
    "deepseek_chat_completions": "DEEPSEEK_API_KEY",
    "minimax_chat_completions": "MINIMAX_API_KEY",
    "dashscope_chat_completions": "DASHSCOPE_API_KEY",
    "siliconflow_chat_completions": "SILICONFLOW_API_KEY",
    "openrouter_chat_completions": "OPENROUTER_API_KEY",
}

PROVIDER_LABELS = {
    "openai_compatible_chat": "OpenAI Compatible",
    "claude_chat_completions": "Claude Compatible",
    "moonshot_chat_completions": "Moonshot Kimi",
    "deepseek_chat_completions": "DeepSeek",
    "minimax_chat_completions": "MiniMax",
    "dashscope_chat_completions": "Qwen DashScope",
    "siliconflow_chat_completions": "SiliconFlow",
    "openrouter_chat_completions": "OpenRouter",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an OpenAI-compatible API benchmark for Stream2Graph.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--provider", type=str, default="")
    parser.add_argument("--model", type=str, default="")
    parser.add_argument("--endpoint", type=str, default="")
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test", "all"])
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--sample-ids-file", type=str, default="")
    parser.add_argument("--api-key-env", type=str, default="")
    parser.add_argument("--api-key", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=6)
    parser.add_argument("--retry-backoff-sec", type=float, default=5.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.5)
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--source-dir", type=str, default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228")
    parser.add_argument("--split-dir", type=str, default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228/splits")
    parser.add_argument("--compile-command", type=str, default="")
    parser.add_argument("--run-name", type=str, default="")
    parser.add_argument("--output-root", type=str, default="reports/evaluation/runs/openai_compatible")
    parser.add_argument("--publish-bundle", action="store_true")
    parser.add_argument("--published-dir", type=str, default="reports/evaluation/published")
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument("--extra-body-json", type=str, default="")
    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    args = parser.parse_args()
    if not args.provider:
        raise SystemExit("--provider is required, either directly or through --config.")
    if args.provider not in DEFAULT_ENDPOINTS:
        raise SystemExit(f"Unsupported provider: {args.provider}")
    if not args.model:
        raise SystemExit("--model is required, either directly or through --config.")
    return args


def _run_script(script: str, config_path: Path) -> None:
    command = [sys.executable, str(resolve_path(script)), "--config", str(config_path)]
    subprocess.run(command, cwd=resolve_path("."), check=True)


def _parse_extra_body(raw: str) -> dict:
    if not raw:
        return {}
    return json.loads(raw)


def main() -> None:
    args = parse_args()
    raw_config = json.loads(resolve_path(args.config).read_text(encoding="utf-8")) if args.config else {}
    provider_label = PROVIDER_LABELS[args.provider]
    endpoint = args.endpoint or DEFAULT_ENDPOINTS[args.provider]
    api_key_env = args.api_key_env or DEFAULT_API_KEY_ENVS[args.provider]
    inject_api_key(api_key_env, args.api_key)
    run_name = args.run_name or slugify(f"{args.provider}_{args.model}_{args.split}")
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
        "sample_ids_file": args.sample_ids_file,
        "resume": True,
        "output_jsonl": str(inference_dir / "predictions.jsonl"),
        "manifest_output": str(inference_dir / "manifest.json"),
        "provider": args.provider,
        "provider_name": provider_label,
        "endpoint": endpoint,
        "model": args.model,
        "api_key_env": api_key_env,
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
        "timeout_sec": args.timeout_sec,
        "max_retries": args.max_retries,
        "retry_backoff_sec": args.retry_backoff_sec,
        "request_interval_sec": args.request_interval_sec,
        "max_concurrency": args.max_concurrency,
        "extra_body": _parse_extra_body(args.extra_body_json),
        "omit_temperature": bool(raw_config.get("omit_temperature", False)),
    }
    offline_config = {
        "input_jsonl": str(inference_dir / "predictions.jsonl"),
        "output_dir": str(offline_dir),
        "compile_command": args.compile_command,
    }
    report_config = {
        "title": f"{provider_label} {args.model} Stream2Graph Offline Benchmark",
        "offline_summary": str(offline_dir / "offline_metrics.summary.json"),
        "realtime_summary": "",
        "output_dir": str(report_dir),
        "notes": args.notes or f"Offline API benchmark for {provider_label} / {args.model}.",
    }
    suite_config = {
        "title": f"{provider_label} {args.model} Evaluation Suite",
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
            notes=args.notes or f"Published benchmark bundle for {provider_label} / {args.model}.",
        )
        print(f"Published bundle: {bundle_dir}")

    print(f"Run root: {run_root}")


if __name__ == "__main__":
    main()
