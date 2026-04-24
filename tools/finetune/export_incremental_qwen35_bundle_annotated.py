#!/usr/bin/env python3
# shebang：允许在支持的环境中直接用 python3 执行本脚本。

from __future__ import annotations
# 推迟类型注解求值。

import argparse
# 用来解析命令行参数。

import json
# 用来读取和写入 JSON。

import shutil
# 用来复制文件/目录，以及删除已有目录。

import sys
# 用来调整 sys.path，保证脚本能在直接执行时找到项目模块。

from pathlib import Path
# 用 Path 做路径处理。

if __package__ in {None, ""}:
    # 如果当前脚本是“直接执行”的，而不是作为包模块执行，
    # 那么 __package__ 可能为空。
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    # 这里手动把仓库根目录插到 sys.path 最前面，
    # 这样后面才能正常 import tools.eval.common。

from tools.eval.common import resolve_path, utc_iso, write_json
# 导入项目里的公共工具函数：
# - resolve_path：路径解析
# - utc_iso：生成 UTC 时间戳
# - write_json：写 JSON 文件


BUNDLE_FILES = [
    # requirements：训练环境依赖清单。
    "requirements/finetune.txt",

    # 环境准备脚本。
    "tools/finetune/bootstrap_local_finetune_env.sh",

    # 当前这个 bundle 导出脚本本身。
    "tools/finetune/export_incremental_qwen35_bundle.py",

    # 通用 QLoRA 训练脚本。
    "tools/finetune/train_qwen3_lora.py",

    # gate / planner 本地 smoke 训练脚本。
    "tools/finetune/run_local_qwen35_4b_gate_smoke.sh",
    "tools/finetune/run_local_qwen35_27b_planner_smoke.sh",

    # gate / planner 云端 AutoDL 训练脚本。
    "tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh",
    "tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh",

    # 增量 Qwen3.5 消融评测脚本。
    "tools/finetune/run_incremental_qwen35_ablation_eval.py",
    "tools/finetune/run_cloud_incremental_qwen35_ablation_eval.sh",

    # 预拉取 HF 模型缓存的辅助脚本。
    "tools/finetune/prefetch_hf_models.py",

    # gate / planner 的 SFT 数据准备脚本。
    "tools/incremental_finetune/prepare_gate_sft_dataset.py",
    "tools/incremental_finetune/prepare_planner_sft_dataset.py",
    "tools/incremental_finetune/common.py",

    # benchmark / eval 公共脚本。
    "tools/eval/common.py",
    "tools/eval/incremental_dataset.py",
    "tools/eval/run_incremental_benchmark.py",
    "tools/eval/run_incremental_inference.py",
    "tools/eval/run_incremental_metrics.py",
    "tools/eval/reporting.py",

    # 增量数据与运行时系统相关文件。
    "tools/incremental_dataset/__init__.py",
    "tools/incremental_dataset/schema.py",
    "tools/incremental_dataset/staging.py",
    "tools/incremental_system/algorithm.py",
    "tools/incremental_system/loader.py",
    "tools/incremental_system/run_session.py",
    "tools/incremental_system/chat_clients.py",
    "tools/incremental_system/models.py",
    "tools/incremental_system/runtime.py",
    "tools/incremental_system/schema.py",

    # 训练配置。
    "configs/finetune/qwen35_4b_gate_local_smoke.json",
    "configs/finetune/qwen35_4b_gate_cloud_autodl.json",
    "configs/finetune/qwen35_4b_gate_cloud_rtxpro6000_96g.json",
    "configs/finetune/qwen35_27b_planner_local_smoke.json",
    "configs/finetune/qwen35_27b_planner_cloud_autodl.json",
    "configs/finetune/qwen35_27b_planner_cloud_rtxpro6000_96g.json",

    # benchmark 配置模板。
    "configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_validation.example.json",
    "configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full.example.json",
    "configs/evaluation/model_benchmarks/local_hf_qwen35_27b_base_benchmark.example.json",
    "configs/evaluation/model_benchmarks/local_hf_qwen35_27b_sft_benchmark.example.json",

    # 关键文档。
    "docs/operations/AUTODL_CLOUD_TRAINING.md",
    "docs/evaluation/EVALUATION_PLATFORM.md",
    "docs/training/INCREMENTAL_QWEN35_FINETUNE_PREP.md",
]
# 这份列表定义了“导出 bundle 时，哪些文件一定要带走”。
# 你可以把它理解成：最小可复现实验室的必需文件清单。


OPTIONAL_DIRS = [
    # 可选：模型缓存目录。
    "artifacts/model_cache/qwen35_incremental",

    # 可选：增量 benchmark 样本目录。
    "data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean",

    # 可选：已准备好的 gate / planner 训练数据目录。
    "data/finetune/incremental_gate_sft_cloud",
    "data/finetune/incremental_planner_sft_cloud",

    # 可选：已发布的 benchmark 分析报告目录。
    "reports/evaluation/published/incremental_open_balanced_v1_3360_public_clean_analysis_reaudit_20260322",

    # 可选：oracle smoke 评测结果目录。
    "reports/evaluation/runs/incremental_system/incremental_oracle_smoke_test_open_balanced_v1_3360_public_clean_20260322_r2",
]
# 这份列表定义的是“有了更方便，但不是 bundle 最小闭环必须”的目录。


def parse_args() -> argparse.Namespace:
    # 解析命令行参数。
    parser = argparse.ArgumentParser(description="Export a transfer-ready local bundle for incremental Qwen3.5 finetune.")
    # 创建解析器并写明用途：导出可转移的本地 bundle。

    parser.add_argument(
        "--output-dir",
        type=str,
        default="artifacts/finetune/qwen35_incremental_transfer_bundle",
    )
    # 指定 bundle 导出目录。

    parser.add_argument("--include-optional-dirs", action="store_true")
    # 如果打开这个开关，就连 OPTIONAL_DIRS 里的大目录也一起复制。

    return parser.parse_args()
    # 返回解析结果。


def _copy_file(raw_path: str, output_dir: Path) -> None:
    # 复制单个文件到 bundle 目录里。
    source = resolve_path(raw_path)
    # 解析源文件路径。

    target = output_dir / raw_path
    # 目标路径会保留原来的相对目录结构。

    target.parent.mkdir(parents=True, exist_ok=True)
    # 确保目标父目录存在。

    shutil.copy2(source, target)
    # copy2 会尽量保留元信息（如修改时间）。


def _copy_dir(raw_path: str, output_dir: Path) -> bool:
    # 复制整个目录。
    source = resolve_path(raw_path)
    # 解析源目录。

    if not source.exists():
        # 如果目录不存在，返回 False，表示没复制成功。
        return False

    target = output_dir / raw_path
    # 目标目录同样保留原相对结构。

    if target.exists():
        # 如果目标目录已经存在，先删掉，避免残留旧内容。
        shutil.rmtree(target)

    ignore = None
    # 默认不忽略任何文件。

    if raw_path.startswith("artifacts/model_cache/"):
        # 如果复制的是模型缓存目录，需要特殊处理。
        # 因为 Hugging Face 下载过程中会产生一些不稳定的中间状态文件。
        ignore = shutil.ignore_patterns(".cache", "*.lock", "*.incomplete")
        # 忽略缓存目录、锁文件和未完成下载文件。

    shutil.copytree(source, target, ignore=ignore)
    # 复制整棵目录树。

    return True
    # 返回 True 表示复制成功。


def _read_json_if_exists(raw_path: str) -> dict | list | None:
    # 读取某个 JSON 文件，但如果它不存在就返回 None。
    source = resolve_path(raw_path)
    # 解析源路径。

    if not source.exists():
        # 如果源文件不存在，就直接返回 None。
        return None

    return json.loads(source.read_text(encoding="utf-8"))
    # 存在就读取并解析 JSON。


def main() -> None:
    # 脚本主入口。
    args = parse_args()
    # 解析参数。

    output_dir = resolve_path(args.output_dir)
    # 解析导出目录。

    if output_dir.exists():
        # 如果目标目录已经存在，先整个删掉，保证 bundle 是全新导出。
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    # 重新创建导出目录。

    copied_files: list[str] = []
    # 记录本次实际复制了哪些必需文件。

    copied_dirs: list[str] = []
    # 记录本次实际复制了哪些可选目录。

    optional_dir_statuses: dict[str, bool] = {}
    # 记录每个可选目录的复制状态，哪怕没复制成功也会记下来。

    for file_path in BUNDLE_FILES:
        # 先把必需文件全部复制进去。
        _copy_file(file_path, output_dir)
        copied_files.append(file_path)
        # 同时把路径记入 manifest。

    if args.include_optional_dirs:
        # 如果用户要求携带大目录，再处理 OPTIONAL_DIRS。
        for dir_path in OPTIONAL_DIRS:
            copied = _copy_dir(dir_path, output_dir)
            # 尝试复制这个目录。

            optional_dir_statuses[dir_path] = copied
            # 无论成功失败，都记录状态。

            if copied:
                copied_dirs.append(dir_path)
                # 成功复制的目录再加入 copied_dirs。

    manifest = {
        "generated_at_utc": utc_iso(),
        # 记录 bundle 生成时间（UTC）。

        "output_dir": str(output_dir),
        # 记录 bundle 目录。

        "copied_files": copied_files,
        # 记录复制了哪些必需文件。

        "copied_dirs": copied_dirs,
        # 记录复制了哪些可选目录。

        "optional_dir_statuses": optional_dir_statuses,
        # 记录所有可选目录的状态。

        "source_state": {
            "model_cache_manifest": _read_json_if_exists("artifacts/model_cache/qwen35_incremental/manifest.json"),
            # 当前模型缓存目录的 manifest。

            "gate_finetune_manifest": _read_json_if_exists("data/finetune/incremental_gate_sft_cloud/manifest.json"),
            # gate 训练数据 manifest。

            "planner_finetune_manifest": _read_json_if_exists("data/finetune/incremental_planner_sft_cloud/manifest.json"),
            # planner 训练数据 manifest。

            "public_benchmark_analysis": _read_json_if_exists(
                "reports/evaluation/published/incremental_open_balanced_v1_3360_public_clean_analysis_reaudit_20260322/incremental_dataset_analysis.summary.json"
            ),
            # 公开 benchmark 分析摘要。

            "public_benchmark_hard_audit": _read_json_if_exists(
                "reports/evaluation/published/incremental_open_balanced_v1_3360_public_clean_analysis_reaudit_20260322/direct_dataset_hard_audit.summary.json"
            ),
            # 硬审计摘要。

            "public_benchmark_oracle_smoke": _read_json_if_exists(
                "reports/evaluation/runs/incremental_system/incremental_oracle_smoke_test_open_balanced_v1_3360_public_clean_20260322_r2/metrics/incremental_metrics.summary.json"
            ),
            # oracle smoke 评测摘要。
        },
    }
    # 这个 manifest 是整个 bundle 的核心说明书。
    # 它不只记录“复制了什么”，还记录“源环境当时处于什么状态”。

    write_json(output_dir / "bundle_manifest.json", manifest)
    # 把 manifest 写到 bundle 根目录。

    print(f"Bundle: {output_dir}")
    # 在终端打印导出完成信息。


if __name__ == "__main__":
    # 标准脚本入口。
    main()
