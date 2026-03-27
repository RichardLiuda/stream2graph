#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Iterable

from tools.mermaid_prompting import MERMAID_GENERATION_SYSTEM_PROMPT, build_final_diagram_user_prompt


SYSTEM_PROMPT = MERMAID_GENERATION_SYSTEM_PROMPT


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_path(raw: str) -> Path:
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate
    return repo_root() / candidate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare Stream2Graph release data for Qwen3 SFT.")
    parser.add_argument(
        "--source-dir",
        default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228",
    )
    parser.add_argument(
        "--split-dir",
        default="versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228/splits",
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--max-train-samples", type=int, default=0)
    parser.add_argument("--max-validation-samples", type=int, default=0)
    parser.add_argument("--max-test-samples", type=int, default=0)
    return parser.parse_args()


def load_split_ids(split_dir: Path) -> dict[str, list[str]]:
    split_map: dict[str, list[str]] = {}
    for split_name, file_name in (
        ("train", "train_ids.json"),
        ("validation", "validation_ids.json"),
        ("test", "test_ids.json"),
    ):
        payload = json.loads((split_dir / file_name).read_text(encoding="utf-8"))
        split_map[split_name] = payload["ids"]
    return split_map


def normalize_text(raw: str) -> str:
    return " ".join(raw.split())


def render_dialogue(dialogue: Iterable[dict]) -> str:
    rendered: list[str] = []
    for turn in dialogue:
        turn_id = turn.get("turn_id", "?")
        role = turn.get("role", "Unknown")
        action = turn.get("action_type", "unknown")
        elements = turn.get("elements_involved") or []
        header = f"Turn {turn_id} | {role} | {action}"
        if elements:
            header += f" | elements: {', '.join(elements)}"
        body = normalize_text(turn.get("utterance", ""))
        rendered.append(f"{header}\n{body}")
    return "\n\n".join(rendered)


def build_user_prompt(sample: dict) -> str:
    dialogue = render_dialogue(sample["cscw_dialogue"])
    return build_final_diagram_user_prompt(
        dialogue,
        sample_id=str(sample["id"]),
        diagram_type=str(sample.get("diagram_type", "unknown")),
        current_best=False,
    )


def make_record(sample: dict) -> dict:
    return {
        "id": sample["id"],
        "diagram_type": sample.get("diagram_type", "unknown"),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_prompt(sample)},
            {"role": "assistant", "content": sample["code"].rstrip() + "\n"},
        ],
        "metadata": {
            "source": sample.get("source"),
            "source_url": sample.get("source_url"),
            "content_size": sample.get("content_size"),
            "dialogue_turns": len(sample.get("cscw_dialogue", [])),
        },
    }


def apply_limit(records: list[dict], limit: int) -> list[dict]:
    if limit <= 0:
        return records
    return records[:limit]


def write_jsonl(path: Path, records: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def main() -> None:
    args = parse_args()
    source_dir = resolve_path(args.source_dir)
    split_dir = resolve_path(args.split_dir)
    output_dir = resolve_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    split_ids = load_split_ids(split_dir)
    subset_limits = {
        "train": args.max_train_samples,
        "validation": args.max_validation_samples,
        "test": args.max_test_samples,
    }

    stats: dict[str, dict] = {}
    for split_name, ids in split_ids.items():
        records: list[dict] = []
        missing_ids: list[str] = []
        for sample_id in ids:
            sample_path = source_dir / f"{sample_id}.json"
            if not sample_path.exists():
                missing_ids.append(sample_id)
                continue
            sample = json.loads(sample_path.read_text(encoding="utf-8"))
            records.append(make_record(sample))

        records = apply_limit(records, subset_limits[split_name])
        write_jsonl(output_dir / f"{split_name}.jsonl", records)

        prompt_lengths = [len(r["messages"][1]["content"]) for r in records]
        answer_lengths = [len(r["messages"][2]["content"]) for r in records]
        turn_lengths = [r["metadata"]["dialogue_turns"] for r in records]
        stats[split_name] = {
            "count": len(records),
            "missing_ids": len(missing_ids),
            "mean_prompt_chars": round(statistics.mean(prompt_lengths), 2) if prompt_lengths else 0,
            "mean_answer_chars": round(statistics.mean(answer_lengths), 2) if answer_lengths else 0,
            "mean_dialogue_turns": round(statistics.mean(turn_lengths), 2) if turn_lengths else 0,
        }

    manifest = {
        "source_dir": str(source_dir),
        "split_dir": str(split_dir),
        "output_dir": str(output_dir),
        "system_prompt": SYSTEM_PROMPT,
        "stats": stats,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
