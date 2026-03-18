#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import append_jsonl, read_json, resolve_path, utc_iso, write_json
from tools.incremental_dataset.agent_cluster import AgentClusterRunner
from tools.incremental_dataset.complexity import assign_complexity_buckets, build_profile
from tools.incremental_dataset.mermaid_ir import parse_mermaid_to_graph_ir
from tools.incremental_dataset.minimax_client import MiniMaxChatClient, QuotaPauseRequested
from tools.incremental_dataset.selection import select_profiles
from tools.incremental_dataset.source_dataset import DEFAULT_SOURCE_DIR, DEFAULT_SPLIT_DIR, load_source_samples
from tools.incremental_dataset.staging import build_incremental_stages


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the new incremental Stream2Graph dataset pipeline.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--run-name", type=str, default="")
    parser.add_argument("--source-dir", type=str, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--split-dir", type=str, default=DEFAULT_SPLIT_DIR)
    parser.add_argument("--target-samples", type=int, default=3000)
    parser.add_argument("--output-root", type=str, default="data/incremental_dataset/runs")
    parser.add_argument("--force-selection", action="store_true")
    parser.add_argument("--force-structure", action="store_true")
    parser.add_argument("--agent-enabled", action="store_true")
    parser.add_argument("--agent-max-samples", type=int, default=0)
    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**payload)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_name = args.run_name or f"incremental_build_{utc_iso().replace(':', '').replace('-', '')}"
    run_root = resolve_path(args.output_root) / run_name
    selection_dir = run_root / "selection"
    structure_dir = run_root / "structure" / "samples"
    agent_dir = run_root / "agent_cluster" / "sample_outputs"
    selection_dir.mkdir(parents=True, exist_ok=True)
    structure_dir.mkdir(parents=True, exist_ok=True)
    agent_dir.mkdir(parents=True, exist_ok=True)
    events_path = run_root / "events.jsonl"

    write_json(
        run_root / "run_manifest.json",
        {
            "run_name": run_name,
            "started_at_utc": utc_iso(),
            "source_dir": str(resolve_path(args.source_dir)),
            "split_dir": str(resolve_path(args.split_dir)),
            "target_samples": args.target_samples,
            "agent_enabled": bool(args.agent_enabled),
            "agent_max_samples": args.agent_max_samples,
        },
    )

    profiles = build_or_load_profiles(args, selection_dir, events_path)
    selection_payload = build_or_load_selection(args, selection_dir, profiles, events_path)
    selected_profiles = selection_payload["selected_profiles"]
    selected_lookup = {row["sample_id"]: row for row in selected_profiles}

    structure_report = build_structural_records(args, structure_dir, selected_lookup, events_path)
    write_json(run_root / "structure" / "build_report.json", structure_report)

    if args.agent_enabled:
        agent_report = run_agent_cluster(args, structure_dir, agent_dir, events_path)
        write_json(run_root / "agent_cluster" / "run_report.json", agent_report)

    print(json.dumps({"run_root": str(run_root), "selected_samples": len(selected_profiles)}, ensure_ascii=False, indent=2))


def build_or_load_profiles(args: argparse.Namespace, selection_dir: Path, events_path: Path) -> list[dict]:
    profiles_path = selection_dir / "all_profiles.jsonl"
    if profiles_path.exists() and not args.force_selection:
        return _read_jsonl(profiles_path)

    rows = load_source_samples(source_dir=args.source_dir, split_dir=args.split_dir)
    profiles: list[dict] = []
    profiles_path.parent.mkdir(parents=True, exist_ok=True)
    if profiles_path.exists():
        profiles_path.unlink()
    for sample in rows:
        graph_ir = parse_mermaid_to_graph_ir(sample)
        profile = build_profile(sample, graph_ir)
        profiles.append(profile)
        append_jsonl(profiles_path, profile)
    assign_complexity_buckets(profiles)
    write_json(selection_dir / "all_profiles.with_buckets.json", profiles)
    append_jsonl(events_path, {"event": "profiles_built", "count": len(profiles), "at_utc": utc_iso()})
    return profiles


def build_or_load_selection(
    args: argparse.Namespace,
    selection_dir: Path,
    profiles: list[dict],
    events_path: Path,
) -> dict:
    manifest_path = selection_dir / "selection_manifest.json"
    if manifest_path.exists() and not args.force_selection:
        return read_json(manifest_path)

    if profiles and "complexity_bucket" not in profiles[0]:
        assign_complexity_buckets(profiles)
    payload = select_profiles(profiles, target_samples=args.target_samples)
    write_json(manifest_path, payload)
    write_json(selection_dir / "selected_sample_ids.json", {"ids": [row["sample_id"] for row in payload["selected_profiles"]]})
    _write_split_files(selection_dir / "splits", payload["selected_profiles"])
    append_jsonl(
        events_path,
        {"event": "selection_built", "selected": payload["selected_count"], "at_utc": utc_iso()},
    )
    return payload


def build_structural_records(
    args: argparse.Namespace,
    structure_dir: Path,
    selected_lookup: dict[str, dict],
    events_path: Path,
) -> dict:
    rows = load_source_samples(source_dir=args.source_dir, split_dir=args.split_dir)
    built = 0
    skipped = 0
    for sample in rows:
        profile = selected_lookup.get(sample.sample_id)
        if profile is None:
            continue
        target_path = structure_dir / f"{sample.sample_id}.json"
        if target_path.exists() and not args.force_structure:
            skipped += 1
            continue
        graph_ir = parse_mermaid_to_graph_ir(sample)
        stages = build_incremental_stages(graph_ir, int(profile["recommended_stage_count"]))
        payload = {
            "sample_id": sample.sample_id,
            "diagram_type": sample.diagram_type,
            "source_sample": sample.to_payload(),
            "profile": profile,
            "graph_ir": graph_ir.to_payload(),
            "stages": [stage.to_payload() for stage in stages],
            "built_at_utc": utc_iso(),
        }
        write_json(target_path, payload)
        built += 1
    append_jsonl(
        events_path,
        {"event": "structure_built", "built": built, "skipped": skipped, "at_utc": utc_iso()},
    )
    return {"built": built, "skipped": skipped, "sample_count": len(selected_lookup)}


def run_agent_cluster(
    args: argparse.Namespace,
    structure_dir: Path,
    agent_dir: Path,
    events_path: Path,
) -> dict:
    config_payload = json.loads(resolve_path(args.config).read_text(encoding="utf-8")) if args.config else {}
    minimax_config = config_payload.get("minimax", {})
    api_key_env = str(minimax_config.get("api_key_env", "MINIMAX_API_KEY"))
    if not os.environ.get(api_key_env):
        append_jsonl(
            events_path,
            {
                "event": "agent_cluster_skipped_missing_api_key",
                "api_key_env": api_key_env,
                "at_utc": utc_iso(),
            },
        )
        return {
            "processed": 0,
            "paused_for_quota": False,
            "errors": 0,
            "quota_status": {},
            "preflight_error": f"missing environment variable: {api_key_env}",
        }
    client = MiniMaxChatClient(minimax_config)
    runner = AgentClusterRunner(client, agent_dir)
    processed = 0
    paused = False
    errors = 0
    sample_paths = sorted(structure_dir.glob("*.json"))
    if args.agent_max_samples > 0:
        sample_paths = sample_paths[: args.agent_max_samples]

    for sample_path in sample_paths:
        payload = read_json(sample_path)
        try:
            result = runner.run_sample(payload)
            processed += 1
            if result.get("status") == "error":
                errors += 1
        except QuotaPauseRequested as exc:
            append_jsonl(
                events_path,
                {
                    "event": "agent_cluster_paused_for_quota",
                    "sample_id": payload.get("sample_id"),
                    "reason": str(exc),
                    "quota_status": client.current_quota_status().payload,
                    "at_utc": utc_iso(),
                },
            )
            paused = True
            break

    return {
        "processed": processed,
        "paused_for_quota": paused,
        "errors": errors,
        "quota_status": client.current_quota_status().payload,
    }


def _write_split_files(split_dir: Path, selected_profiles: list[dict]) -> None:
    split_dir.mkdir(parents=True, exist_ok=True)
    for split in ("train", "validation", "test"):
        ids = [row["sample_id"] for row in selected_profiles if row.get("incremental_split") == split]
        write_json(split_dir / f"{split}_ids.json", {"ids": ids})


def _read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


if __name__ == "__main__":
    main()
