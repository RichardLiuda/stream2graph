#!/usr/bin/env python3
# shebang：在支持的环境里，允许这个脚本直接通过 python3 执行。

from __future__ import annotations
# 推迟类型注解求值，避免某些前向引用在运行时立刻报错。

import argparse
# argparse 用来解析命令行参数。

import json
# json 用来把 Python 对象序列化成 JSON 字符串。

import sys
# 这里主要用来在“直接运行脚本”时手动补 sys.path。

from pathlib import Path
# Path 用来做现代 Python 路径处理。

if __package__ in {None, ""}:
    # 如果当前脚本不是以包模块方式运行，而是被直接执行，
    # 那么 __package__ 通常为空。
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    # 这里把仓库根目录插入 sys.path 最前面，
    # 这样后面才能正确 import tools.incremental_finetune.common。

from tools.incremental_finetune.common import (
    DEFAULT_INCREMENTAL_FINETUNE_RUN_ROOT,
    SplitLimit,
    dataset_manifest,
    iter_samples,
    planner_messages,
    write_dataset_rows,
    write_manifest,
)
# 这里从公共模块里导入 planner 数据准备会用到的所有公共工具：
# - DEFAULT_INCREMENTAL_FINETUNE_RUN_ROOT：默认 benchmark/run 根目录
# - SplitLimit：统一管理 train/validation/test 截断数量
# - dataset_manifest：构建导出数据集的 manifest
# - iter_samples：遍历某个 split 的 RuntimeSample
# - planner_messages：生成 planner 的 system+user messages
# - write_dataset_rows：把每个 split 的 rows 写成 JSONL
# - write_manifest：把 manifest 写到输出目录


def parse_args() -> argparse.Namespace:
    # 这个函数定义并解析脚本支持的命令行参数。
    parser = argparse.ArgumentParser(description="Prepare incremental planner SFT data for Qwen3.5-27B.")
    # 创建命令行解析器，并说明这个脚本的用途：
    # 给 planner（Qwen3.5-27B）准备增量 SFT 数据。

    parser.add_argument("--run-root", type=str, default=DEFAULT_INCREMENTAL_FINETUNE_RUN_ROOT)
    # run-root 表示增量 benchmark 运行目录。
    # 默认值来自公共模块里的官方默认路径。

    parser.add_argument("--output-dir", type=str, required=True)
    # output-dir 表示导出的 JSONL 数据集目录。
    # 这是必填的，因为每次实验通常要写到不同目录。

    parser.add_argument("--max-train-samples", type=int, default=0)
    # train 集最多取多少条原始样本。
    # 0 表示不限制。

    parser.add_argument("--max-validation-samples", type=int, default=0)
    # validation 集最多取多少条原始样本。

    parser.add_argument("--max-test-samples", type=int, default=0)
    # test 集最多取多少条原始样本。

    parser.add_argument("--recent-turn-limit", type=int, default=24)
    # planner prompt 中最多保留多少条最近对话 turn。
    # 这是 prompt 长度控制的重要参数。

    parser.add_argument("--omit-target-graph", action="store_true")
    # 如果打开这个开关，就不在 assistant 标准答案里包含 target_graph_ir。
    # 只保留 delta_ops 和 notes。

    return parser.parse_args()
    # 返回解析后的命令行参数对象。


def _target_payload(stage, omit_target_graph: bool) -> str:
    # 这个函数负责把某个 gold stage 变成 assistant 标准答案 JSON 字符串。
    payload = {
        "target_stage_index": stage.stage_index,
        # 告诉模型：这次规划对应的是哪个目标阶段。

        "delta_ops": list(stage.delta_ops),
        # 这是 planner 最核心的监督信号：
        # 当前阶段应该新增哪些操作。

        "notes": stage.stage_description,
        # 用阶段描述作为 notes，帮助模型学习更自然的简短说明。
    }

    if not omit_target_graph:
        # 如果没有要求省略完整图快照，就把 target_graph_ir 也带上。
        payload["target_graph_ir"] = stage.graph_ir.to_payload()
        # 这里会把 GraphIR 转成纯 payload 字典，方便序列化到 JSON 中。

    return json.dumps(payload, ensure_ascii=False, indent=2)
    # 最后把 payload 序列化成格式化 JSON 字符串，作为 assistant 内容。


def build_rows(run_root: str, split: str, max_samples: int, recent_turn_limit: int, omit_target_graph: bool) -> list[dict]:
    # 这个函数是整个 planner 数据导出的核心。
    # 它会把某个 split 下的 RuntimeSample 转成一批 planner SFT rows。
    rows: list[dict] = []
    # rows 用来保存最终导出的样本列表。

    samples = iter_samples(run_root, split, max_samples=max_samples)
    # 从 run_root / split 中按需遍历 RuntimeSample。
    # 这里的 max_samples 不是“最终 row 数”，而是“原始 sample 数”上限。

    for sample in samples:
        # 逐条处理 RuntimeSample。
        current_stage_index = 0
        # planner 的输入里需要知道“当前已经走到哪一阶段”。
        # 对每条新样本，初始值从 0 开始。

        for stage in sample.stages:
            # 对这条样本里的每个 gold stage 依次生成一条 planner 训练题。
            boundary = sample.boundary_by_stage(stage.stage_index)
            # 先找这个 stage 对应的对话边界。
            # 如果能找到，就优先按 boundary 去截取 observed_turns。

            if boundary is not None:
                # 如果存在显式边界，就说明我们知道这个阶段大概覆盖到哪一句 turn。
                observed_turns = [turn for turn in sample.turns if turn.turn_id <= boundary.end_turn]
                # observed_turns 表示：在当前阶段结束时，系统已经“听到”的全部对话前缀。
            else:
                # 如果没有显式 boundary，就退回到另一种近似策略：
                # 按 turn.stage_index 是否 <= 当前 stage 去筛。
                observed_turns = [
                    turn
                    for turn in sample.turns
                    if turn.stage_index is not None and int(turn.stage_index) <= int(stage.stage_index)
                ]
                # 这一步本质上是在说：
                # “把所有不晚于当前阶段的 turn 都当成已观察上下文。”

            rows.append(
                {
                    "id": f"{sample.sample_id}_stage_{stage.stage_index:02d}",
                    # 这一条 row 的唯一 id。
                    # 同一 sample 会拆成多个 stage 级训练样本，所以要把 stage 编号拼进去。

                    "messages": [
                        *planner_messages(
                            sample,
                            current_stage_index=current_stage_index,
                            next_stage_index=stage.stage_index,
                            observed_turns=observed_turns,
                            recent_turn_limit=recent_turn_limit,
                        ),
                        # 先生成 planner 的 system + user 两段消息。
                        # 这里把当前状态、下一阶段提示、已观察 turns 等都打包进 prompt。

                        {
                            "role": "assistant",
                            "content": _target_payload(stage, omit_target_graph),
                        },
                        # 再补上 assistant 标准答案，也就是 gold planner output。
                    ],

                    "metadata": {
                        "task": "incremental_planner",
                        # 说明这条样本属于哪个任务类型。

                        "sample_id": sample.sample_id,
                        # 原始样本 id。

                        "split": split,
                        # 当前属于 train / validation / test 哪个 split。

                        "diagram_type": sample.diagram_type,
                        # 图类型。

                        "stage_index": stage.stage_index,
                        # 当前监督的是哪一个目标阶段。

                        "current_stage_index": current_stage_index,
                        # 这条题目中的“当前已完成阶段号”。

                        "delta_op_count": len(stage.delta_ops),
                        # 当前这个阶段一共需要新增多少个 delta op。
                        # 这是后续分析样本难度时很有用的元信息。
                    },
                }
            )
            # 到这里，一条 planner 训练样本 row 就完整生成了。

            current_stage_index = stage.stage_index
            # 非常关键：
            # 处理完当前 stage 后，要把 current_stage_index 向前推进。
            # 这样下一个 stage 的 prompt 才会知道“系统已经做到了上一阶段”。

    return rows
    # 返回当前 split 的全部 planner SFT rows。


def main() -> None:
    # 脚本主入口。
    args = parse_args()
    # 先解析命令行参数。

    limits = SplitLimit(
        train=args.max_train_samples,
        validation=args.max_validation_samples,
        test=args.max_test_samples,
    )
    # 用 SplitLimit 把三个 split 的样本上限打包起来。
    # 这样后面按 split 取值会更整洁。

    split_counts: dict[str, int] = {}
    # 这里用来记录每个 split 最终导出了多少条 row。

    for split in ("train", "validation", "test"):
        # 依次处理三种 split。
        rows = build_rows(
            args.run_root,
            split,
            limits.value_for(split),
            args.recent_turn_limit,
            args.omit_target_graph,
        )
        # 为当前 split 生成 planner SFT rows。

        write_dataset_rows(args.output_dir, split, rows)
        # 把 rows 写成 output_dir 下对应 split 的 JSONL。

        split_counts[split] = len(rows)
        # 记录当前 split 的 row 数。

        print(f"[planner-sft] split={split} rows={len(rows)}", flush=True)
        # 在终端打印导出进度，便于观察数据量。

    manifest = dataset_manifest(
        task_name="incremental_planner_sft",
        # 这份数据集的任务名。

        run_root=args.run_root,
        # 它来自哪个 benchmark/run 根目录。

        output_dir=args.output_dir,
        # 导出到了哪个输出目录。

        split_counts=split_counts,
        # train/validation/test 各有多少条 row。

        extra={
            "target_model": "Qwen/Qwen3.5-27B",
            # 说明这份数据默认面向哪个目标模型。

            "recent_turn_limit": args.recent_turn_limit,
            # 记录 prompt 使用的 recent turn 上限。

            "omit_target_graph": args.omit_target_graph,
            # 记录本次导出是否省略了 target_graph_ir。
        },
    )
    # 生成整个数据集的 manifest 字典。

    manifest_path = write_manifest(args.output_dir, manifest)
    # 把 manifest 写入 output_dir，并拿到最终路径。

    print(f"Manifest: {manifest_path}")
    # 打印 manifest 路径，方便后续检查。


if __name__ == "__main__":
    # 只有在直接执行当前脚本时，才调用 main()。
    main()
