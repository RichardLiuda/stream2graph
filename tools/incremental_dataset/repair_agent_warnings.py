#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, utc_iso, write_json
from tools.incremental_dataset.agent_cluster import AgentClusterRunner
from tools.incremental_dataset.minimax_client import MiniMaxChatClient, resolve_configured_api_key


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Repair warning samples by rerunning verifier only for selected sample ids."
    )
    parser.add_argument("--config", type=str, required=True)
    parser.add_argument("--run-root", type=str, required=True)
    parser.add_argument("--sample-ids-file", type=str, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def _load_sample_ids(path: Path) -> list[str]:
    rows = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()]
    return [row for row in rows if row]


def _prepare_record_for_verifier_retry(record: dict) -> dict:
    patched = dict(record)
    for key in ("verifier", "verification_summary", "warning", "completed_at_utc", "error"):
        patched.pop(key, None)
    patched["status"] = "in_progress"
    patched["updated_at_utc"] = utc_iso()
    return patched


def main() -> None:
    args = parse_args()
    config_payload = json.loads(resolve_path(args.config).read_text(encoding="utf-8"))
    minimax_config = config_payload.get("minimax", {})
    if not resolve_configured_api_key(minimax_config):
        raise RuntimeError("missing MiniMax api key in config or environment")

    run_root = resolve_path(args.run_root)
    structure_dir = run_root / "structure" / "samples"
    agent_dir = run_root / "agent_cluster" / "sample_outputs"
    sample_ids = _load_sample_ids(resolve_path(args.sample_ids_file))

    client = MiniMaxChatClient(minimax_config)
    runner = AgentClusterRunner(client, agent_dir)

    results: list[dict] = []
    for sample_id in sample_ids:
        structure_path = structure_dir / f"{sample_id}.json"
        agent_path = agent_dir / f"{sample_id}.json"
        if not structure_path.exists():
            results.append({"sample_id": sample_id, "status": "missing_structure"})
            continue
        if not agent_path.exists():
            results.append({"sample_id": sample_id, "status": "missing_agent"})
            continue

        record = json.loads(agent_path.read_text(encoding="utf-8"))
        patched = _prepare_record_for_verifier_retry(record)
        if args.dry_run:
            results.append(
                {
                    "sample_id": sample_id,
                    "status": "would_retry_verifier",
                    "previous_status": record.get("status"),
                }
            )
            continue

        write_json(agent_path, patched)
        structural_payload = json.loads(structure_path.read_text(encoding="utf-8"))
        result = runner.run_sample(structural_payload)
        results.append(
            {
                "sample_id": sample_id,
                "status": result.get("status"),
                "has_verification_summary": bool(result.get("verification_summary")),
            }
        )

    output = {
        "run_root": str(run_root),
        "sample_ids_file": str(resolve_path(args.sample_ids_file)),
        "dry_run": bool(args.dry_run),
        "count": len(sample_ids),
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
