#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import repo_root, resolve_path, utc_iso, write_json
from tools.eval.dataset import load_split_ids


STEP_SCRIPTS = {
    "generation": "tools/dialogue_regen/run_generation.py",
    "build": "tools/dialogue_regen/build_dataset_version.py",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the final Kimi dialogue regeneration pipeline.")
    parser.add_argument("--config", type=str, required=True)
    parser.add_argument("--python-executable", type=str, default=sys.executable)
    parser.add_argument("--dry-run", action="store_true")
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


def _write_ids(path: Path, ids: list[str]) -> None:
    write_json(path, {"count": len(ids), "ids": ids})


def _run_step(
    *,
    step_name: str,
    config: dict,
    output_root: Path,
    python_executable: str,
    dry_run: bool,
) -> dict:
    resolved_dir = output_root / "resolved_configs"
    resolved_dir.mkdir(parents=True, exist_ok=True)
    config_path = resolved_dir / f"{step_name}.json"
    write_json(config_path, config)

    script_path = repo_root() / STEP_SCRIPTS[step_name]
    command = [python_executable, str(script_path), "--config", str(config_path)]
    log_dir = output_root / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = log_dir / f"{step_name}.stdout.log"
    stderr_path = log_dir / f"{step_name}.stderr.log"

    if dry_run:
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        return {
            "step": step_name,
            "status": "dry_run",
            "command": command,
            "config": str(config_path),
            "stdout_log": str(stdout_path),
            "stderr_log": str(stderr_path),
            "duration_seconds": 0.0,
        }

    started = time.time()
    with stdout_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open(
        "w", encoding="utf-8"
    ) as stderr_handle:
        completed = subprocess.run(
            command,
            cwd=repo_root(),
            stdout=stdout_handle,
            stderr=stderr_handle,
            text=True,
            encoding="utf-8",
        )
    duration = round(time.time() - started, 3)
    return {
        "step": step_name,
        "status": "ok" if completed.returncode == 0 else "failed",
        "returncode": completed.returncode,
        "command": command,
        "config": str(config_path),
        "stdout_log": str(stdout_path),
        "stderr_log": str(stderr_path),
        "duration_seconds": duration,
    }


def _merge_rows(row_sources: list[Path], output_path: Path) -> dict:
    merged: dict[str, dict] = {}
    source_counts: list[dict] = []
    for source in row_sources:
        rows = _read_jsonl(source)
        source_counts.append({"path": str(source), "rows": len(rows)})
        for row in rows:
            sample_id = str(row.get("sample_id") or "")
            if not sample_id:
                continue
            merged[sample_id] = row
    ordered = [merged[sample_id] for sample_id in sorted(merged)]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in ordered:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {
        "output_path": str(output_path),
        "row_count": len(ordered),
        "sources": source_counts,
    }


def _compute_turn_count(payload: dict) -> int:
    dialogue_metadata = payload.get("dialogue_metadata") or {}
    if dialogue_metadata.get("total_turns"):
        return int(dialogue_metadata["total_turns"])
    return len(payload.get("cscw_dialogue") or [])


def main() -> None:
    args = parse_args()
    payload = json.loads(resolve_path(args.config).read_text(encoding="utf-8"))

    source_dir = resolve_path(payload["source_dir"])
    split_dir = resolve_path(payload["split_dir"])
    output_root = resolve_path(payload["output_root"])
    dataset_output_dir = resolve_path(payload["dataset_output_dir"])
    split_name = str(payload.get("split", "train"))
    target_language = str(payload.get("target_language", "zh-CN"))
    turn_threshold = int(payload.get("long_sample_min_turns", 41))
    version_tag = str(payload["version_tag"])

    output_root.mkdir(parents=True, exist_ok=True)
    ids_dir = output_root / "ids"
    ids_dir.mkdir(parents=True, exist_ok=True)

    split_map = load_split_ids(split_dir)
    split_ids = list(split_map[split_name])

    standard_ids: list[str] = []
    long_ids: list[str] = []
    missing_ids: list[str] = []

    for sample_id in split_ids:
        sample_path = source_dir / f"{sample_id}.json"
        if not sample_path.exists():
            missing_ids.append(sample_id)
            continue
        sample = json.loads(sample_path.read_text(encoding="utf-8"))
        turn_count = _compute_turn_count(sample)
        if turn_count >= turn_threshold:
            long_ids.append(sample_id)
        else:
            standard_ids.append(sample_id)

    standard_ids_path = ids_dir / "train_standard_ids.json"
    long_ids_path = ids_dir / "train_long_ids.json"
    failed_ids_path = ids_dir / "train_failed_ids.json"
    _write_ids(standard_ids_path, standard_ids)
    _write_ids(long_ids_path, long_ids)

    primary_standard_output = output_root / "generated_primary_standard.jsonl"
    primary_long_output = output_root / "generated_primary_long.jsonl"
    primary_merged_output = output_root / "generated_primary_merged.jsonl"
    repair_output = output_root / "generated_repair.jsonl"
    final_output = output_root / "generated_final.jsonl"

    common_generation = {
        "provider": "moonshot_chat_completions",
        "provider_name": "moonshot_chat_completions",
        "model": payload["model"],
        "endpoint": payload["endpoint"],
        "api_key_env": payload["api_key_env"],
        "source_dir": str(source_dir),
        "split_dir": str(split_dir),
        "split": split_name,
        "target_language": target_language,
        "temperature": payload.get("temperature", 0.6),
        "timeout_sec": payload.get("timeout_sec", 180),
        "max_retries": payload.get("max_retries", 5),
        "retry_backoff_sec": payload.get("retry_backoff_sec", 3.0),
        "request_interval_sec": 0.0,
        "resume": True,
        "resume_skip_mode": "success_only",
        "extra_body": payload.get("extra_body", {"thinking": {"type": "disabled"}}),
    }

    primary_standard_config = {
        **common_generation,
        "sample_ids_file": str(standard_ids_path),
        "max_tokens": int(payload["primary_standard"]["max_tokens"]),
        "max_concurrency": int(payload["primary_standard"]["max_concurrency"]),
        "requests_per_minute": int(payload["primary_standard"]["requests_per_minute"]),
        "output_jsonl": str(primary_standard_output),
    }
    primary_long_config = {
        **common_generation,
        "sample_ids_file": str(long_ids_path),
        "max_tokens": int(payload["primary_long"]["max_tokens"]),
        "max_concurrency": int(payload["primary_long"]["max_concurrency"]),
        "requests_per_minute": int(payload["primary_long"]["requests_per_minute"]),
        "output_jsonl": str(primary_long_output),
    }

    manifest = {
        "generated_at_utc": utc_iso(),
        "title": payload.get("title", "Final Kimi k2.5 Dialogue Regeneration Pipeline"),
        "config_path": str(resolve_path(args.config)),
        "output_root": str(output_root),
        "source_dir": str(source_dir),
        "split_dir": str(split_dir),
        "split": split_name,
        "turn_threshold": turn_threshold,
        "sample_counts": {
            "target_split_total": len(split_ids),
            "missing_source_files": len(missing_ids),
            "standard_ids": len(standard_ids),
            "long_ids": len(long_ids),
        },
        "steps": [],
    }
    write_json(output_root / "pipeline_manifest.json", manifest)

    for label, config in (
        ("generation_primary_standard", primary_standard_config),
        ("generation_primary_long", primary_long_config),
    ):
        print(f"[kimi-final] running {label}", flush=True)
        result = _run_step(
            step_name="generation",
            config=config,
            output_root=output_root / label,
            python_executable=args.python_executable,
            dry_run=args.dry_run,
        )
        manifest["steps"].append(result)
        write_json(output_root / "pipeline_manifest.json", manifest)
        if result["status"] not in {"ok", "dry_run"}:
            raise SystemExit(1)

    if args.dry_run:
        merge_report = _merge_rows([primary_standard_output, primary_long_output], primary_merged_output)
        manifest["primary_merge"] = merge_report
        write_json(output_root / "pipeline_manifest.json", manifest)
        return

    merge_report = _merge_rows([primary_standard_output, primary_long_output], primary_merged_output)
    manifest["primary_merge"] = merge_report
    write_json(output_root / "pipeline_manifest.json", manifest)

    merged_rows = _read_jsonl(primary_merged_output)
    failed_ids = sorted(
        {
            str(row.get("sample_id"))
            for row in merged_rows
            if row.get("sample_id") and (not row.get("parse_valid") or row.get("error"))
        }
    )
    _write_ids(failed_ids_path, failed_ids)
    manifest["sample_counts"]["repair_ids"] = len(failed_ids)
    write_json(output_root / "pipeline_manifest.json", manifest)

    if failed_ids:
        repair_config = {
            **common_generation,
            "sample_ids_file": str(failed_ids_path),
            "max_tokens": int(payload["repair"]["max_tokens"]),
            "max_concurrency": int(payload["repair"]["max_concurrency"]),
            "requests_per_minute": int(payload["repair"]["requests_per_minute"]),
            "output_jsonl": str(repair_output),
        }
        print("[kimi-final] running generation_repair", flush=True)
        result = _run_step(
            step_name="generation",
            config=repair_config,
            output_root=output_root / "generation_repair",
            python_executable=args.python_executable,
            dry_run=False,
        )
        manifest["steps"].append(result)
        write_json(output_root / "pipeline_manifest.json", manifest)
        if result["status"] != "ok":
            raise SystemExit(1)
        final_merge = _merge_rows([primary_merged_output, repair_output], final_output)
    else:
        final_merge = _merge_rows([primary_merged_output], final_output)

    manifest["final_merge"] = final_merge
    write_json(output_root / "pipeline_manifest.json", manifest)

    build_config = {
        "source_dir": str(source_dir),
        "generated_jsonl": str(final_output),
        "output_dir": str(dataset_output_dir),
        "version_tag": version_tag,
        "copy_splits": True,
        "freeze_non_generated": True,
    }
    print("[kimi-final] running dataset_build", flush=True)
    result = _run_step(
        step_name="build",
        config=build_config,
        output_root=output_root / "build_dataset",
        python_executable=args.python_executable,
        dry_run=False,
    )
    manifest["steps"].append(result)
    write_json(output_root / "pipeline_manifest.json", manifest)
    if result["status"] != "ok":
        raise SystemExit(1)

    final_rows = _read_jsonl(final_output)
    manifest["final_counts"] = {
        "rows": len(final_rows),
        "parse_valid_rows": sum(1 for row in final_rows if row.get("parse_valid")),
        "error_rows": sum(1 for row in final_rows if row.get("error")),
    }
    write_json(output_root / "pipeline_manifest.json", manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
