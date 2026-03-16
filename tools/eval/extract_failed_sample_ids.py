#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_jsonl, resolve_path, write_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract failed sample IDs from an inference predictions JSONL.")
    parser.add_argument("--input-jsonl", type=str, required=True)
    parser.add_argument("--output-json", type=str, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = read_jsonl(resolve_path(args.input_jsonl))
    failed_ids = [str(row.get("sample_id")) for row in rows if row.get("error")]
    payload = {
        "ids": failed_ids,
        "count": len(failed_ids),
        "input_jsonl": str(resolve_path(args.input_jsonl)),
    }
    write_json(resolve_path(args.output_json), payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
