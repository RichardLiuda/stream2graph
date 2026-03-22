#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

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
    parser.add_argument(
        "--download-mode",
        type=str,
        choices=["snapshot", "serial"],
        default="serial",
        help="Use serial per-file download for large models when snapshot concurrency is unstable.",
    )
    parser.add_argument("--max-workers", type=int, default=1)
    return parser.parse_args()


def _is_model_downloaded(model_dir: Path) -> bool:
    index_path = model_dir / "model.safetensors.index.json"
    if index_path.exists():
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        shard_files = set(payload.get("weight_map", {}).values())
        if shard_files:
            return all((model_dir / shard).exists() for shard in shard_files)
    shard_files = list(model_dir.glob("model*.safetensors"))
    return bool(shard_files)


def _serial_download_model(model_name: str, target_dir: Path, token: str | None) -> dict[str, Any]:
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi(token=token)
    repo_files = list(api.list_repo_files(repo_id=model_name))
    if not repo_files:
        raise RuntimeError(f"No files listed for model repo: {model_name}")

    index_name = "model.safetensors.index.json"
    metadata_first = [
        name
        for name in (
            "config.json",
            "generation_config.json",
            "tokenizer_config.json",
            "tokenizer.json",
            "merges.txt",
            "vocab.json",
            "preprocessor_config.json",
            "chat_template.jinja",
            "README.md",
            "LICENSE",
            index_name,
        )
        if name in repo_files
    ]
    downloaded_files: list[str] = []
    for file_name in metadata_first:
        hf_hub_download(repo_id=model_name, filename=file_name, local_dir=str(target_dir), token=token)
        downloaded_files.append(file_name)
        print(f"[prefetch-hf] metadata {model_name} -> {file_name}", flush=True)

    shard_files: list[str] = []
    index_path = target_dir / index_name
    if index_path.exists():
        index_payload = json.loads(index_path.read_text(encoding="utf-8"))
        shard_files = sorted(set(index_payload.get("weight_map", {}).values()))

    remaining = [name for name in repo_files if name not in downloaded_files and name not in shard_files]
    for file_name in remaining:
        hf_hub_download(repo_id=model_name, filename=file_name, local_dir=str(target_dir), token=token)
        downloaded_files.append(file_name)
        print(f"[prefetch-hf] extra {model_name} -> {file_name}", flush=True)

    for idx, file_name in enumerate(shard_files, start=1):
        hf_hub_download(repo_id=model_name, filename=file_name, local_dir=str(target_dir), token=token)
        print(f"[prefetch-hf] shard {idx}/{len(shard_files)} {model_name} -> {file_name}", flush=True)

    return {
        "repo_file_count": len(repo_files),
        "shard_count": len(shard_files),
        "download_mode": "serial",
    }


def main() -> None:
    from huggingface_hub import snapshot_download

    args = parse_args()
    cache_dir = resolve_path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    models = args.models or list(DEFAULT_MODELS)
    manifest_output = resolve_path(args.manifest_output) if args.manifest_output else cache_dir / "manifest.json"
    previous_models: dict[str, dict] = {}
    if manifest_output.exists():
        try:
            previous_payload = json.loads(manifest_output.read_text(encoding="utf-8"))
            if isinstance(previous_payload, dict) and isinstance(previous_payload.get("models"), dict):
                previous_models = dict(previous_payload["models"])
        except Exception:
            previous_models = {}

    manifest: dict[str, dict] = {
        "generated_at_utc": utc_iso(),
        "cache_dir": str(cache_dir),
        "models": previous_models,
    }
    token = os.environ.get("HF_TOKEN") or None

    for model_name in models:
        target_dir = cache_dir / model_name.replace("/", "__")
        target_dir.mkdir(parents=True, exist_ok=True)
        row = {
            "model_name": model_name,
            "local_dir": str(target_dir),
            "downloaded": _is_model_downloaded(target_dir),
            "download_mode": args.download_mode,
        }
        if not args.skip_download:
            if args.download_mode == "serial":
                row.update(_serial_download_model(model_name, target_dir, token))
            else:
                snapshot_download(
                    repo_id=model_name,
                    local_dir=str(target_dir),
                    local_dir_use_symlinks=False,
                    token=token,
                    resume_download=True,
                    max_workers=max(1, int(args.max_workers)),
                )
        row["downloaded"] = _is_model_downloaded(target_dir)
        manifest["models"][model_name] = row
        print(f"[prefetch-hf] model={model_name} local_dir={target_dir}", flush=True)

    write_json(manifest_output, manifest)
    print(f"Manifest: {manifest_output}")


if __name__ == "__main__":
    main()
