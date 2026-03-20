#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, utc_iso, write_json


BUNDLE_FILES = [
    "requirements/finetune.txt",
    "tools/finetune/bootstrap_local_finetune_env.sh",
    "tools/finetune/train_qwen3_lora.py",
    "tools/finetune/run_local_qwen35_4b_gate_smoke.sh",
    "tools/finetune/run_local_qwen35_27b_planner_smoke.sh",
    "tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh",
    "tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh",
    "tools/finetune/prefetch_hf_models.py",
    "tools/incremental_finetune/prepare_gate_sft_dataset.py",
    "tools/incremental_finetune/prepare_planner_sft_dataset.py",
    "tools/incremental_finetune/common.py",
    "tools/eval/run_incremental_benchmark.py",
    "tools/eval/run_incremental_inference.py",
    "tools/eval/run_incremental_metrics.py",
    "tools/incremental_system/run_session.py",
    "tools/incremental_system/chat_clients.py",
    "tools/incremental_system/models.py",
    "configs/finetune/qwen35_4b_gate_local_smoke.json",
    "configs/finetune/qwen35_4b_gate_cloud_autodl.json",
    "configs/finetune/qwen35_27b_planner_local_smoke.json",
    "configs/finetune/qwen35_27b_planner_cloud_autodl.json",
    "configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_validation.example.json",
    "configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full.example.json",
    "configs/evaluation/model_benchmarks/local_hf_qwen35_27b_base_benchmark.example.json",
    "configs/evaluation/model_benchmarks/local_hf_qwen35_27b_sft_benchmark.example.json",
    "docs/operations/AUTODL_CLOUD_TRAINING.md",
    "docs/evaluation/EVALUATION_PLATFORM.md",
    "docs/training/INCREMENTAL_QWEN35_FINETUNE_PREP.md",
]


OPTIONAL_DIRS = [
    "artifacts/model_cache/qwen35_incremental",
    "data/finetune/incremental_gate_sft_cloud",
    "data/finetune/incremental_planner_sft_cloud",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a transfer-ready local bundle for incremental Qwen3.5 finetune.")
    parser.add_argument(
        "--output-dir",
        type=str,
        default="artifacts/finetune/qwen35_incremental_transfer_bundle",
    )
    parser.add_argument("--include-optional-dirs", action="store_true")
    return parser.parse_args()


def _copy_file(raw_path: str, output_dir: Path) -> None:
    source = resolve_path(raw_path)
    target = output_dir / raw_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _copy_dir(raw_path: str, output_dir: Path) -> bool:
    source = resolve_path(raw_path)
    if not source.exists():
        return False
    target = output_dir / raw_path
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return True


def main() -> None:
    args = parse_args()
    output_dir = resolve_path(args.output_dir)
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    copied_files: list[str] = []
    copied_dirs: list[str] = []
    for file_path in BUNDLE_FILES:
        _copy_file(file_path, output_dir)
        copied_files.append(file_path)
    if args.include_optional_dirs:
        for dir_path in OPTIONAL_DIRS:
            if _copy_dir(dir_path, output_dir):
                copied_dirs.append(dir_path)

    manifest = {
        "generated_at_utc": utc_iso(),
        "output_dir": str(output_dir),
        "copied_files": copied_files,
        "copied_dirs": copied_dirs,
    }
    write_json(output_dir / "bundle_manifest.json", manifest)
    print(f"Bundle: {output_dir}")


if __name__ == "__main__":
    main()
