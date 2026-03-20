#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, utc_iso, write_json


DEFAULT_MODELS = [
    "Qwen/Qwen3.5-4B",
    "Qwen/Qwen3.5-27B",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prefetch required HF models for incremental Qwen3.5 finetune.")
    parser.add_argument("--cache-dir", type=str, default="artifacts/model_cache/qwen35_incremental")
    parser.add_argument("--model", action="append", dest="models", default=[])
    parser.add_argument("--manifest-output", type=str, default="")
    parser.add_argument("--skip-download", action="store_true")
    return parser.parse_args()


def main() -> None:
    from huggingface_hub import snapshot_download

    args = parse_args()
    cache_dir = resolve_path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    models = args.models or list(DEFAULT_MODELS)
    manifest: dict[str, dict] = {
        "generated_at_utc": utc_iso(),
        "cache_dir": str(cache_dir),
        "models": {},
    }
    token = os.environ.get("HF_TOKEN") or None

    for model_name in models:
        target_dir = cache_dir / model_name.replace("/", "__")
        target_dir.mkdir(parents=True, exist_ok=True)
        row = {
            "model_name": model_name,
            "local_dir": str(target_dir),
            "downloaded": False,
        }
        if not args.skip_download:
            snapshot_download(
                repo_id=model_name,
                local_dir=str(target_dir),
                local_dir_use_symlinks=False,
                token=token,
                resume_download=True,
            )
            row["downloaded"] = True
        manifest["models"][model_name] = row
        print(f"[prefetch-hf] model={model_name} local_dir={target_dir}", flush=True)

    manifest_output = resolve_path(args.manifest_output) if args.manifest_output else cache_dir / "manifest.json"
    write_json(manifest_output, manifest)
    print(f"Manifest: {manifest_output}")


if __name__ == "__main__":
    main()
