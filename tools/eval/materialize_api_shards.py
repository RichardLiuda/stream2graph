#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, slugify, utc_iso, write_json
from tools.eval.dataset import load_split_ids


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Materialize shard configs for quota-limited API benchmarks.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--template-config", type=str, default="")
    parser.add_argument("--split-dir", type=str, default="")
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test"])
    parser.add_argument("--shard-count", type=int, default=4)
    parser.add_argument("--output-dir", type=str, default="configs/evaluation/generated_shards")
    parser.add_argument("--run-name-prefix", type=str, default="")
    parser.add_argument("--api-key-envs-json", type=str, default="")
    parser.add_argument("--api-keys-json", type=str, default="")
    parser.add_argument("--notes", type=str, default="")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**payload)
    args = parser.parse_args()
    if not args.template_config:
        raise SystemExit("--template-config is required.")
    return args


def _chunk_round_robin(items: list[str], shard_count: int) -> list[list[str]]:
    shards = [[] for _ in range(shard_count)]
    for idx, item in enumerate(items):
        shards[idx % shard_count].append(item)
    return shards


def _parse_optional_json(raw: str):
    if not raw:
        return None
    return json.loads(raw)


def main() -> None:
    args = parse_args()
    template_path = resolve_path(args.template_config)
    template = json.loads(template_path.read_text(encoding="utf-8"))
    split_dir = resolve_path(args.split_dir or template.get("split_dir"))
    split_map = load_split_ids(split_dir)
    ids = list(split_map[args.split])

    shard_count = max(1, int(args.shard_count))
    shards = _chunk_round_robin(ids, shard_count)
    output_dir = resolve_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    api_key_envs = _parse_optional_json(args.api_key_envs_json)
    api_keys = _parse_optional_json(args.api_keys_json)

    run_name_prefix = args.run_name_prefix or str(template.get("run_name") or slugify(template_path.stem))
    manifest_entries = []

    for index, shard_ids in enumerate(shards, start=1):
        shard_tag = f"shard{index:02d}of{shard_count:02d}"
        ids_payload = {
            "generated_at_utc": utc_iso(),
            "split": args.split,
            "shard_index": index,
            "shard_count": shard_count,
            "count": len(shard_ids),
            "ids": shard_ids,
        }
        ids_path = output_dir / f"{run_name_prefix}_{shard_tag}.sample_ids.json"
        write_json(ids_path, ids_payload)

        shard_config = dict(template)
        shard_config["split"] = args.split
        shard_config["max_samples"] = 0
        shard_config["sample_ids_file"] = str(ids_path)
        shard_config["run_name"] = f"{run_name_prefix}_{shard_tag}"
        shard_notes = str(template.get("notes", "")).strip()
        extra_notes = f"Shard {index}/{shard_count} for {args.split} split."
        shard_config["notes"] = f"{shard_notes} {extra_notes}".strip()

        if isinstance(api_key_envs, list) and index - 1 < len(api_key_envs):
            shard_config["api_key_env"] = api_key_envs[index - 1]
        if isinstance(api_keys, list) and index - 1 < len(api_keys):
            shard_config["api_key"] = api_keys[index - 1]

        config_path = output_dir / f"{run_name_prefix}_{shard_tag}.config.json"
        write_json(config_path, shard_config)

        manifest_entries.append(
            {
                "shard_index": index,
                "shard_count": shard_count,
                "sample_count": len(shard_ids),
                "sample_ids_file": str(ids_path),
                "config_file": str(config_path),
                "run_name": shard_config["run_name"],
            }
        )

    manifest = {
        "generated_at_utc": utc_iso(),
        "template_config": str(template_path),
        "split_dir": str(split_dir),
        "split": args.split,
        "shard_count": shard_count,
        "total_ids": len(ids),
        "output_dir": str(output_dir),
        "notes": args.notes,
        "shards": manifest_entries,
    }
    write_json(output_dir / f"{run_name_prefix}.manifest.json", manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
