#!/usr/bin/env python3
# 这一行叫 shebang。
# 它告诉类 Unix 环境：如果直接执行这个文件，请用 python3 解释器来运行。

from __future__ import annotations
# 这一行会推迟类型注解的求值。
# 好处是：即使注解里写了还没定义的类型，也不会立刻报错。
# 这是现代 Python 里很常见的写法，尤其适合类型标注较多的脚本。

import argparse
# argparse 用来解析命令行参数。
# 这个脚本会通过它读取 source-dir、split-dir、output-dir 等配置。

import json
# json 用来读写 JSON。
# 这里既要读取样本 JSON、split JSON，也要把结果写成 JSONL 和 manifest。

import statistics
# statistics 用来计算平均值。
# 这个脚本最后会统计 prompt 长度、答案长度、对话轮数等平均值。

from pathlib import Path
# Path 是现代 Python 里处理文件路径的推荐方式。
# 相比字符串拼路径更安全，也更可读。

from typing import Iterable
# Iterable 是类型注解。
# 这里用它标明 render_dialogue 接受的是“可迭代的 turn 列表”。

from tools.mermaid_prompting import MERMAID_GENERATION_SYSTEM_PROMPT, build_final_diagram_user_prompt
# 从项目自己的 prompting 模块里导入两样东西：
# 1. 固定的 system prompt
# 2. 把 dialogue 包装成 user prompt 的函数


SYSTEM_PROMPT = MERMAID_GENERATION_SYSTEM_PROMPT
# 这里给系统提示词起一个更短的本地别名。
# 这样后面 make_record 里写 messages 时更直观。


def repo_root() -> Path:
    # 这个函数负责找到仓库根目录。
    # 当前文件在 tools/finetune/ 下，所以向上 parents[2] 就是仓库根目录。
    return Path(__file__).resolve().parents[2]


def resolve_path(raw: str) -> Path:
    # 这个函数把“命令行传进来的路径字符串”转换成真正可用的 Path 对象。
    candidate = Path(raw)
    # 先把原始字符串包装成 Path。

    if candidate.is_absolute():
        # 如果用户给的是绝对路径，就直接用。
        return candidate

    return repo_root() / candidate
    # 如果用户给的是相对路径，就默认相对于仓库根目录解析。


def parse_args() -> argparse.Namespace:
    # 这个函数专门负责定义脚本支持哪些命令行参数，并返回解析结果。
    parser = argparse.ArgumentParser(description="Prepare Stream2Graph release data for Qwen3 SFT.")
    # 创建命令行解析器，并写一段简短描述。

    parser.add_argument(
        "--source-dir",
        default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228",
    )
    # source-dir 表示样本 JSON 所在目录。
    # 默认值指向一个旧版 release 数据目录。

    parser.add_argument(
        "--split-dir",
        default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228/splits",
    )
    # split-dir 表示 train/validation/test 的 id 划分目录。
    # 这里默认指向 release 数据里的 splits 子目录。

    parser.add_argument("--output-dir", required=True)
    # output-dir 是输出目录，必须显式提供。
    # 因为训练数据应该放到哪个目录，通常由当前实验来决定。

    parser.add_argument("--max-train-samples", type=int, default=0)
    # 如果 > 0，就只导出前若干条 train 样本。
    # 默认 0 表示不限制。

    parser.add_argument("--max-validation-samples", type=int, default=0)
    # validation 集的截断上限。

    parser.add_argument("--max-test-samples", type=int, default=0)
    # test 集的截断上限。

    return parser.parse_args()
    # 真正解析命令行，并返回 argparse.Namespace。


def load_split_ids(split_dir: Path) -> dict[str, list[str]]:
    # 这个函数把 split 目录里的 train_ids.json / validation_ids.json / test_ids.json 读进来。
    split_map: dict[str, list[str]] = {}
    # 这里最后会返回形如：
    # {
    #   "train": [...],
    #   "validation": [...],
    #   "test": [...]
    # }

    for split_name, file_name in (
        ("train", "train_ids.json"),
        ("validation", "validation_ids.json"),
        ("test", "test_ids.json"),
    ):
        # 用一个固定映射遍历三种 split。
        payload = json.loads((split_dir / file_name).read_text(encoding="utf-8"))
        # 读取 JSON 文件并解析成字典。
        split_map[split_name] = payload["ids"]
        # 当前项目的 split 文件格式里，真正的 id 列表放在 "ids" 键下。

    return split_map
    # 返回三份样本 id 列表。


def normalize_text(raw: str) -> str:
    # 这个函数做很轻量的文本规范化。
    return " ".join(raw.split())
    # raw.split() 会按任意空白切开，再用单个空格拼回去。
    # 结果是：多余空格、换行、制表符都会被压成普通空格。


def render_dialogue(dialogue: Iterable[dict]) -> str:
    # 这个函数负责把原始 cscw_dialogue 列表渲染成一段适合塞进 prompt 的可读文本。
    rendered: list[str] = []
    # rendered 用来一轮一轮收集字符串块。

    for turn in dialogue:
        # 遍历每一轮对话 turn。
        turn_id = turn.get("turn_id", "?")
        # 读取 turn_id；如果没有，就用 "?" 占位。

        role = turn.get("role", "Unknown")
        # 读取说话角色；如果没有，就标成 Unknown。

        action = turn.get("action_type", "unknown")
        # 读取动作类型；如果没有，就用 unknown。

        elements = turn.get("elements_involved") or []
        # 读取本轮涉及的元素列表。
        # 如果是 None 或空值，就退成空列表。

        header = f"Turn {turn_id} | {role} | {action}"
        # 先拼一个对话头部，包含轮次、角色、动作。

        if elements:
            # 如果这一轮标了相关元素，就把它们也拼进 header。
            header += f" | elements: {', '.join(elements)}"

        body = normalize_text(turn.get("utterance", ""))
        # 读取真正的话语内容，并做空白规范化。

        rendered.append(f"{header}\n{body}")
        # 把“头部 + 正文”作为当前 turn 的渲染结果收进去。

    return "\n\n".join(rendered)
    # 最后用空行把所有 turn 拼成一整段对话文本。


def build_user_prompt(sample: dict) -> str:
    # 这个函数负责为一条样本生成 user prompt。
    dialogue = render_dialogue(sample["cscw_dialogue"])
    # 先把原始 dialogue 列表渲染成纯文本。

    return build_final_diagram_user_prompt(
        dialogue,
        sample_id=str(sample["id"]),
        diagram_type=str(sample.get("diagram_type", "unknown")),
        current_best=False,
    )
    # 然后交给项目里的 prompt builder，组合成最终 user prompt。
    # current_best=False 表示这里不是“在已有最优图基础上继续改”，
    # 而是更像从当前对话直接生成最终图。


def make_record(sample: dict) -> dict:
    # 这个函数把一条原始样本变成一条 SFT 训练记录。
    return {
        "id": sample["id"],
        # 保留样本 id，便于追踪。

        "diagram_type": sample.get("diagram_type", "unknown"),
        # 保留图类型，便于后续分析。

        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            # system 消息：岗位说明书。

            {"role": "user", "content": build_user_prompt(sample)},
            # user 消息：把这条样本变成模型看到的题目卡。

            {"role": "assistant", "content": sample["code"].rstrip() + "\n"},
            # assistant 消息：标准答案，也就是真值 Mermaid 代码。
            # rstrip() 先去掉尾部多余空白，再统一补一个换行。
        ],

        "metadata": {
            "source": sample.get("source"),
            # 样本来源。

            "source_url": sample.get("source_url"),
            # 来源链接。

            "content_size": sample.get("content_size"),
            # 内容规模信息。

            "dialogue_turns": len(sample.get("cscw_dialogue", [])),
            # 记录这一条样本有多少轮对话。
        },
    }


def apply_limit(records: list[dict], limit: int) -> list[dict]:
    # 这个函数负责在导出时截断样本数，便于做 smoke / 小规模实验。
    if limit <= 0:
        # limit <= 0 表示不截断。
        return records

    return records[:limit]
    # 否则只保留前 limit 条。


def write_jsonl(path: Path, records: list[dict]) -> None:
    # 这个函数把 records 列表写成 JSONL 文件。
    with path.open("w", encoding="utf-8") as handle:
        # 以 utf-8 文本模式打开输出文件。
        for record in records:
            # 一条一条写。
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            # JSONL 要求每行一个 JSON 对象，所以每条后面都补换行。


def main() -> None:
    # 脚本主入口。
    args = parse_args()
    # 先解析命令行参数。

    source_dir = resolve_path(args.source_dir)
    # 解析样本目录路径。

    split_dir = resolve_path(args.split_dir)
    # 解析 split 目录路径。

    output_dir = resolve_path(args.output_dir)
    # 解析输出目录路径。

    output_dir.mkdir(parents=True, exist_ok=True)
    # 如果输出目录不存在，就递归创建。

    split_ids = load_split_ids(split_dir)
    # 读取 train / validation / test 的样本 id 列表。

    subset_limits = {
        "train": args.max_train_samples,
        "validation": args.max_validation_samples,
        "test": args.max_test_samples,
    }
    # 把三种 split 的截断上限统一收成一个字典，后面循环里好取。

    stats: dict[str, dict] = {}
    # 这里用来汇总每个 split 的统计信息。

    for split_name, ids in split_ids.items():
        # 逐个处理 train / validation / test。
        records: list[dict] = []
        # 当前 split 的训练记录列表。

        missing_ids: list[str] = []
        # 如果某个 sample_id 对应 JSON 文件不存在，就记在这里。

        for sample_id in ids:
            # 遍历当前 split 里的每个 sample_id。
            sample_path = source_dir / f"{sample_id}.json"
            # 拼出样本 JSON 文件路径。

            if not sample_path.exists():
                # 如果缺文件，记录下来并跳过。
                missing_ids.append(sample_id)
                continue

            sample = json.loads(sample_path.read_text(encoding="utf-8"))
            # 读取并解析样本 JSON。

            records.append(make_record(sample))
            # 转成一条 SFT 记录并加入当前 split。

        records = apply_limit(records, subset_limits[split_name])
        # 按命令行上限截断当前 split。

        write_jsonl(output_dir / f"{split_name}.jsonl", records)
        # 把当前 split 写成对应的 JSONL 文件。

        prompt_lengths = [len(r["messages"][1]["content"]) for r in records]
        # 收集 user prompt 的字符长度。

        answer_lengths = [len(r["messages"][2]["content"]) for r in records]
        # 收集 assistant 标准答案的字符长度。

        turn_lengths = [r["metadata"]["dialogue_turns"] for r in records]
        # 收集每条样本的对话轮数。

        stats[split_name] = {
            "count": len(records),
            # 当前 split 最终导出了多少条。

            "missing_ids": len(missing_ids),
            # 缺失了多少条样本文件。

            "mean_prompt_chars": round(statistics.mean(prompt_lengths), 2) if prompt_lengths else 0,
            # 平均 prompt 长度。

            "mean_answer_chars": round(statistics.mean(answer_lengths), 2) if answer_lengths else 0,
            # 平均答案长度。

            "mean_dialogue_turns": round(statistics.mean(turn_lengths), 2) if turn_lengths else 0,
            # 平均对话轮数。
        }

    manifest = {
        "source_dir": str(source_dir),
        # 记录样本目录，方便回溯。

        "split_dir": str(split_dir),
        # 记录 split 目录。

        "output_dir": str(output_dir),
        # 记录输出目录。

        "system_prompt": SYSTEM_PROMPT,
        # 记录本次导出时使用的 system prompt。

        "stats": stats,
        # 记录每个 split 的统计信息。
    }

    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # 把 manifest 写到输出目录里，便于后续检查数据集版本和规模。

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    # 同时打印到终端，方便马上看到导出结果。


if __name__ == "__main__":
    # 只有直接执行当前脚本时，才进入 main()。
    main()
