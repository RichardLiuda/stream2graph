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
    parser = argparse.ArgumentParser(
        description="Run four-way local-HF incremental benchmark ablations for Qwen3.5 gate/planner."
    )
    parser.add_argument(
        "--run-root",
        type=str,
        default="data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean",
    )
    parser.add_argument("--split", type=str, default="validation", choices=["validation", "test"])
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--output-root", type=str, default="reports/evaluation/runs/incremental_system")
    parser.add_argument(
        "--config-output-dir",
        type=str,
        default="reports/evaluation/generated_configs/incremental_qwen35_ablation",
    )
    parser.add_argument(
        "--gate-model",
        type=str,
        default="artifacts/model_cache/qwen35_incremental/Qwen__Qwen3.5-4B",
    )
    parser.add_argument(
        "--planner-model",
        type=str,
        default="artifacts/model_cache/qwen35_incremental/Qwen__Qwen3.5-27B",
    )
    parser.add_argument(
        "--gate-adapter",
        type=str,
        default="artifacts/finetune/qwen35_4b_incremental_gate_cloud_autodl/final_adapter",
    )
    parser.add_argument(
        "--planner-adapter",
        type=str,
        default="artifacts/finetune/qwen35_27b_incremental_planner_cloud_autodl/final_adapter",
    )
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--timeout-sec", type=int, default=240)
    parser.add_argument("--gate-gpu-memory-mib", type=int, default=16000)
    parser.add_argument("--planner-gpu-memory-mib", type=int, default=78000)
    parser.add_argument("--gate-cpu-memory-gib", type=int, default=64)
    parser.add_argument("--planner-cpu-memory-gib", type=int, default=96)
    parser.add_argument("--gate-max-new-tokens", type=int, default=512)
    parser.add_argument("--planner-max-new-tokens", type=int, default=2048)
    parser.add_argument("--attn-implementation", type=str, default="sdpa")
    parser.add_argument("--enable-thinking", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def _local_hf_extra(
    *,
    adapter_path: str,
    max_new_tokens: int,
    gpu_memory_limit_mib: int,
    cpu_memory_limit_gib: int,
    attn_implementation: str,
    enable_thinking: bool,
) -> str:
    payload: dict[str, object] = {
        "use_4bit": True,
        "max_new_tokens": max_new_tokens,
        "gpu_memory_limit_mib": gpu_memory_limit_mib,
        "cpu_memory_limit_gib": cpu_memory_limit_gib,
        "attn_implementation": attn_implementation,
        "enable_thinking": enable_thinking,
    }
    if adapter_path:
        payload["adapter_path"] = adapter_path
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _experiment_rows(args: argparse.Namespace) -> list[dict[str, object]]:
    gate_adapter = str(resolve_path(args.gate_adapter))
    planner_adapter = str(resolve_path(args.planner_adapter))
    return [
        {
            "name": "gateft_plannerft",
            "gate_adapter": gate_adapter,
            "planner_adapter": planner_adapter,
        },
        {
            "name": "gateft_plannerbase",
            "gate_adapter": gate_adapter,
            "planner_adapter": "",
        },
        {
            "name": "gatebase_plannerft",
            "gate_adapter": "",
            "planner_adapter": planner_adapter,
        },
        {
            "name": "gatebase_plannerbase",
            "gate_adapter": "",
            "planner_adapter": "",
        },
    ]


def _assert_required_paths(experiment: dict[str, object]) -> None:
    for key in ("gate_adapter", "planner_adapter"):
        adapter_path = str(experiment[key])
        if adapter_path and not resolve_path(adapter_path).exists():
            raise FileNotFoundError(f"Missing adapter for {experiment['name']}: {adapter_path}")


def main() -> None:
    args = parse_args()
    config_output_dir = resolve_path(args.config_output_dir)
    config_output_dir.mkdir(parents=True, exist_ok=True)

    experiments = _experiment_rows(args)
    generated_configs: list[Path] = []

    for experiment in experiments:
        _assert_required_paths(experiment)
        run_name = slugify(
            f"incremental_localhf_qwen35_{experiment['name']}_{args.split}_public_clean"
        )
        config_payload = {
            "run_root": args.run_root,
            "split": args.split,
            "max_samples": args.max_samples,
            "resume": True,
            "max_concurrency": args.max_concurrency,
            "gate_kind": "local_hf",
            "planner_kind": "local_hf",
            "gate_endpoint": "",
            "gate_model": str(resolve_path(args.gate_model)),
            "gate_api_key_env": "OPENAI_API_KEY",
            "gate_api_key": "",
            "gate_extra_body_json": _local_hf_extra(
                adapter_path=str(experiment["gate_adapter"]),
                max_new_tokens=args.gate_max_new_tokens,
                gpu_memory_limit_mib=args.gate_gpu_memory_mib,
                cpu_memory_limit_gib=args.gate_cpu_memory_gib,
                attn_implementation=args.attn_implementation,
                enable_thinking=False,
            ),
            "planner_endpoint": "",
            "planner_model": str(resolve_path(args.planner_model)),
            "planner_api_key_env": "OPENAI_API_KEY",
            "planner_api_key": "",
            "planner_extra_body_json": _local_hf_extra(
                adapter_path=str(experiment["planner_adapter"]),
                max_new_tokens=args.planner_max_new_tokens,
                gpu_memory_limit_mib=args.planner_gpu_memory_mib,
                cpu_memory_limit_gib=args.planner_cpu_memory_gib,
                attn_implementation=args.attn_implementation,
                enable_thinking=bool(args.enable_thinking),
            ),
            "temperature": 0.0,
            "timeout_sec": args.timeout_sec,
            "max_retries": 1,
            "retry_backoff_sec": 3.0,
            "gate_request_interval_sec": 0.0,
            "planner_request_interval_sec": 0.0,
            "run_name": run_name,
            "output_root": args.output_root,
            "notes": f"Four-way ablation experiment: {experiment['name']}",
        }
        config_path = config_output_dir / f"{run_name}.json"
        write_json(config_path, config_payload)
        generated_configs.append(config_path)

    print(
        json.dumps(
            {
                "generated_config_count": len(generated_configs),
                "config_paths": [str(path) for path in generated_configs],
                "dry_run": bool(args.dry_run),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    if args.dry_run:
        return

    for config_path in generated_configs:
        command = [
            sys.executable,
            str(resolve_path("tools/eval/run_incremental_benchmark.py")),
            "--config",
            str(config_path),
        ]
        print(f"[ablation-eval] START {config_path.name}", flush=True)
        subprocess.run(command, cwd=resolve_path("."), check=True)
        print(f"[ablation-eval] DONE  {config_path.name}", flush=True)


if __name__ == "__main__":
    main()
