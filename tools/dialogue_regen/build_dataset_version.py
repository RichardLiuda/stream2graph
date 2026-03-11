#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import repo_root, resolve_path, utc_iso, write_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a new dataset version from dialogue regeneration outputs.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--source-dir", type=str, required=False, default="")
    parser.add_argument("--generated-jsonl", type=str, required=False, default="")
    parser.add_argument("--output-dir", type=str, required=False, default="")
    parser.add_argument("--version-tag", type=str, default="v5_minimax_regen")
    parser.add_argument("--copy-splits", action="store_true")
    parser.add_argument("--freeze-non-generated", action="store_true")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**payload)
    return parser.parse_args()


def _read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _compute_dialogue_metadata(dialogue: list[dict], previous: dict | None) -> dict:
    previous = previous or {}
    return {
        "total_turns": len(dialogue),
        "repair_count": sum(1 for turn in dialogue if bool(turn.get("is_repair"))),
        "grounding_acts_count": sum(1 for turn in dialogue if turn.get("elements_involved")),
        "theoretical_framework": previous.get(
            "theoretical_framework",
            "Grounding in Communication (Clark & Brennan, 1991)",
        ),
    }


def main() -> None:
    args = parse_args()
    source_dir = resolve_path(args.source_dir)
    generated_jsonl = resolve_path(args.generated_jsonl)
    output_dir = resolve_path(args.output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    generated_rows = _read_jsonl(generated_jsonl)
    generated_by_id = {str(row.get("sample_id")): row for row in generated_rows if row.get("sample_id")}

    data_files = sorted(path for path in source_dir.glob("*.json") if path.is_file())
    copied = 0
    regenerated = 0
    fallback_kept = 0
    parse_failures = 0

    for source_path in data_files:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
        sample_id = str(payload.get("id") or source_path.stem)
        row = generated_by_id.get(sample_id)
        record = dict(payload)

        regen_meta: dict | None = None
        if row is not None:
            generated_dialogue = row.get("generated_dialogue") or {}
            generated_turns = generated_dialogue.get("cscw_dialogue", []) if isinstance(generated_dialogue, dict) else []
            if row.get("parse_valid") and generated_turns:
                record["cscw_dialogue"] = generated_turns
                record["dialogue_metadata"] = _compute_dialogue_metadata(
                    generated_turns,
                    record.get("dialogue_metadata"),
                )
                regenerated += 1
                regen_meta = {
                    "enabled": True,
                    "regenerated_at_utc": utc_iso(),
                    "provider": row.get("provider"),
                    "model_name": row.get("model_name"),
                    "source_generated_jsonl": str(generated_jsonl),
                    "latency_ms": row.get("latency_ms"),
                    "parse_valid": True,
                    "fallback_used": False,
                    "reference_dialogue_turns": row.get("reference_dialogue_turns"),
                }
            else:
                fallback_kept += 1
                if row.get("error"):
                    parse_failures += 1
                regen_meta = {
                    "enabled": True,
                    "regenerated_at_utc": utc_iso(),
                    "provider": row.get("provider"),
                    "model_name": row.get("model_name"),
                    "source_generated_jsonl": str(generated_jsonl),
                    "latency_ms": row.get("latency_ms"),
                    "parse_valid": False,
                    "fallback_used": True,
                    "error": row.get("error"),
                    "reference_dialogue_turns": row.get("reference_dialogue_turns"),
                }
        elif args.freeze_non_generated:
            regen_meta = {
                "enabled": False,
                "frozen_from_source": True,
            }

        if regen_meta is not None:
            record["dialogue_regen"] = regen_meta

        record["release_version"] = args.version_tag
        record["release_built_at"] = utc_iso()

        target_path = output_dir / source_path.name
        target_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        copied += 1

    if args.copy_splits:
        splits_src = source_dir / "splits"
        splits_dst = output_dir / "splits"
        if splits_src.exists():
            if splits_dst.exists():
                shutil.rmtree(splits_dst)
            shutil.copytree(splits_src, splits_dst)

    report = {
        "generated_at_utc": utc_iso(),
        "repo_root": str(repo_root()),
        "source_dir": str(source_dir),
        "generated_jsonl": str(generated_jsonl),
        "output_dir": str(output_dir),
        "version_tag": args.version_tag,
        "file_count": copied,
        "generated_rows": len(generated_rows),
        "regenerated_records": regenerated,
        "fallback_kept_records": fallback_kept,
        "parse_failure_rows": parse_failures,
        "copy_splits": bool(args.copy_splits),
        "freeze_non_generated": bool(args.freeze_non_generated),
    }
    write_json(output_dir / "_regen_build_report.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
