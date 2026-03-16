#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, utc_iso, write_json
from tools.eval.dataset import load_split_ids


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge sharded prediction JSONL files into a single ordered file.")
    parser.add_argument("--output-jsonl", type=str, required=True)
    parser.add_argument("--split-dir", type=str, required=True)
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test"])
    parser.add_argument("--input-jsonl", action="append", default=[])
    parser.add_argument("--manifest-output", type=str, default="")
    return parser.parse_args()


def _read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def main() -> None:
    args = parse_args()
    if not args.input_jsonl:
        raise SystemExit("At least one --input-jsonl is required.")

    output_jsonl = resolve_path(args.output_jsonl)
    split_dir = resolve_path(args.split_dir)
    split_map = load_split_ids(split_dir)
    ordered_ids = split_map[args.split]

    merged: dict[str, dict] = {}
    duplicates = []
    sources = []
    for raw in args.input_jsonl:
        path = resolve_path(raw)
        sources.append(str(path))
        for row in _read_jsonl(path):
            sid = str(row.get("sample_id"))
            if sid in merged:
                duplicates.append(sid)
                continue
            merged[sid] = row

    ordered_rows = [merged[sid] for sid in ordered_ids if sid in merged]
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with output_jsonl.open("w", encoding="utf-8") as handle:
        for row in ordered_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    manifest = {
        "generated_at_utc": utc_iso(),
        "output_jsonl": str(output_jsonl),
        "split_dir": str(split_dir),
        "split": args.split,
        "input_jsonls": sources,
        "row_count": len(ordered_rows),
        "duplicate_sample_ids": sorted(set(duplicates)),
        "missing_from_split_count": len([sid for sid in ordered_ids if sid not in merged]),
    }
    manifest_output = resolve_path(args.manifest_output) if args.manifest_output else output_jsonl.with_suffix(".manifest.json")
    write_json(manifest_output, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
