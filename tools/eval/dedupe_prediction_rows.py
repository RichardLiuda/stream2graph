#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_jsonl, resolve_path, utc_iso, write_json
from tools.eval.dataset import load_split_ids


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deduplicate prediction JSONL rows by sample_id.")
    parser.add_argument("--input-jsonl", type=str, required=True)
    parser.add_argument("--output-jsonl", type=str, required=True)
    parser.add_argument("--split-dir", type=str, default="")
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test"])
    parser.add_argument("--manifest-output", type=str, default="")
    return parser.parse_args()


def _prefer_replacement(existing: dict, candidate: dict) -> bool:
    existing_error = bool(existing.get("error"))
    candidate_error = bool(candidate.get("error"))
    if existing_error and not candidate_error:
        return True
    return False


def main() -> None:
    args = parse_args()
    rows = read_jsonl(resolve_path(args.input_jsonl))

    chosen: dict[str, dict] = {}
    first_order: list[str] = []
    duplicate_ids: list[str] = []
    replaced_error_with_success: list[str] = []

    for row in rows:
        sample_id = str(row.get("sample_id"))
        if sample_id not in chosen:
            chosen[sample_id] = row
            first_order.append(sample_id)
            continue
        duplicate_ids.append(sample_id)
        if _prefer_replacement(chosen[sample_id], row):
            chosen[sample_id] = row
            replaced_error_with_success.append(sample_id)

    ordered_ids = first_order
    if args.split_dir:
        split_map = load_split_ids(resolve_path(args.split_dir))
        ordered_ids = [sample_id for sample_id in split_map[args.split] if sample_id in chosen]

    output_jsonl = resolve_path(args.output_jsonl)
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with output_jsonl.open("w", encoding="utf-8") as handle:
        for sample_id in ordered_ids:
            handle.write(json.dumps(chosen[sample_id], ensure_ascii=False) + "\n")

    manifest = {
        "generated_at_utc": utc_iso(),
        "input_jsonl": str(resolve_path(args.input_jsonl)),
        "output_jsonl": str(output_jsonl),
        "input_row_count": len(rows),
        "output_row_count": len(ordered_ids),
        "unique_sample_id_count": len(chosen),
        "duplicate_row_count": len(rows) - len(chosen),
        "duplicate_sample_id_count": len(set(duplicate_ids)),
        "replaced_error_with_success_count": len(set(replaced_error_with_success)),
        "replaced_error_with_success_ids": sorted(set(replaced_error_with_success)),
    }
    manifest_output = resolve_path(args.manifest_output) if args.manifest_output else output_jsonl.with_suffix(".manifest.json")
    write_json(manifest_output, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
