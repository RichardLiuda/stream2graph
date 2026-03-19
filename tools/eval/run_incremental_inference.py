#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import append_jsonl, inject_api_key, read_jsonl, resolve_path, utc_iso, write_json
from tools.eval.incremental_dataset import (
    DEFAULT_INCREMENTAL_RUN_ROOT,
    load_incremental_entries,
    load_incremental_sample_ids,
)
from tools.incremental_system.algorithm import DeterministicAlgorithmLayer
from tools.incremental_system.chat_clients import OpenAICompatibleChatClient
from tools.incremental_system.loader import load_runtime_sample
from tools.incremental_system.models import (
    LLMGateModel,
    LLMPlannerModel,
    OracleGateModel,
    OraclePlannerModel,
)
from tools.incremental_system.runtime import IncrementalSystemRunner


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run incremental-system inference on the new staged dataset.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--run-root", type=str, default=DEFAULT_INCREMENTAL_RUN_ROOT)
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test", "all"])
    parser.add_argument("--output-jsonl", type=str, default="reports/evaluation/incremental/inference/predictions.jsonl")
    parser.add_argument("--manifest-output", type=str, default="")
    parser.add_argument("--details-dir", type=str, default="")
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--sample-ids-file", type=str, default="")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--gate-kind", type=str, default="oracle", choices=["oracle", "openai_compatible"])
    parser.add_argument("--planner-kind", type=str, default="oracle", choices=["oracle", "openai_compatible"])
    parser.add_argument("--gate-endpoint", type=str, default="")
    parser.add_argument("--gate-model", type=str, default="")
    parser.add_argument("--gate-api-key-env", type=str, default="OPENAI_API_KEY")
    parser.add_argument("--gate-api-key", type=str, default="")
    parser.add_argument("--gate-extra-body-json", type=str, default="")
    parser.add_argument("--planner-endpoint", type=str, default="")
    parser.add_argument("--planner-model", type=str, default="")
    parser.add_argument("--planner-api-key-env", type=str, default="OPENAI_API_KEY")
    parser.add_argument("--planner-api-key", type=str, default="")
    parser.add_argument("--planner-extra-body-json", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff-sec", type=float, default=3.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.0)

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def _make_client(
    *,
    endpoint: str,
    model: str,
    api_key_env: str,
    api_key: str,
    extra_body_json: str,
    args: argparse.Namespace,
) -> OpenAICompatibleChatClient:
    return OpenAICompatibleChatClient(
        endpoint=endpoint,
        model=model,
        api_key=api_key,
        api_key_env=api_key_env,
        timeout_sec=args.timeout_sec,
        max_retries=args.max_retries,
        retry_backoff_sec=args.retry_backoff_sec,
        request_interval_sec=args.request_interval_sec,
        extra_body=json.loads(extra_body_json) if extra_body_json else {},
        temperature=args.temperature,
    )


def _build_runner(args: argparse.Namespace) -> IncrementalSystemRunner:
    if args.gate_kind == "oracle":
        gate_model = OracleGateModel()
    else:
        gate_model = LLMGateModel(
            _make_client(
                endpoint=args.gate_endpoint,
                model=args.gate_model,
                api_key_env=args.gate_api_key_env,
                api_key=args.gate_api_key,
                extra_body_json=args.gate_extra_body_json,
                args=args,
            )
        )

    if args.planner_kind == "oracle":
        planner_model = OraclePlannerModel()
    else:
        planner_model = LLMPlannerModel(
            _make_client(
                endpoint=args.planner_endpoint,
                model=args.planner_model,
                api_key_env=args.planner_api_key_env,
                api_key=args.planner_api_key,
                extra_body_json=args.planner_extra_body_json,
                args=args,
            )
        )
    return IncrementalSystemRunner(
        algorithm_layer=DeterministicAlgorithmLayer(),
        gate_model=gate_model,
        planner_model=planner_model,
    )


def _latency_summary(payload: dict) -> dict[str, float | int | None]:
    gate_latencies: list[float] = []
    planner_latencies: list[float] = []
    planner_calls = 0
    for event in payload.get("events", []):
        gate_latency = ((event.get("gate") or {}).get("metadata") or {}).get("latency_ms")
        if gate_latency is not None:
            gate_latencies.append(float(gate_latency))
        planner = event.get("planner") or {}
        if planner:
            planner_calls += 1
            planner_latency = (planner.get("metadata") or {}).get("latency_ms")
            if planner_latency is not None:
                planner_latencies.append(float(planner_latency))
    gate_mean = round(sum(gate_latencies) / len(gate_latencies), 4) if gate_latencies else None
    planner_mean = round(sum(planner_latencies) / len(planner_latencies), 4) if planner_latencies else None
    return {
        "gate_calls": len(payload.get("events", [])),
        "planner_calls": planner_calls,
        "gate_latency_mean_ms": gate_mean,
        "planner_latency_mean_ms": planner_mean,
        "total_model_latency_ms": round(sum(gate_latencies) + sum(planner_latencies), 4),
    }


def _row_from_payload(sample_entry, payload: dict, detail_path: Path) -> dict:
    summary = dict(payload.get("summary", {}))
    latencies = _latency_summary(payload)
    total_stages = int(summary.get("total_stages", 0) or 0)
    final_stage_index = int(summary.get("final_stage_index", 0) or 0)
    updates_emitted = int(summary.get("updates_emitted", 0) or 0)
    return {
        "generated_at_utc": utc_iso(),
        "sample_id": sample_entry.sample_id,
        "split": sample_entry.split,
        "diagram_type": sample_entry.diagram_type,
        "complexity_bucket": sample_entry.complexity_bucket,
        "gate_kind": payload.get("system", {}).get("gate_model"),
        "planner_kind": payload.get("system", {}).get("planner_model"),
        "turn_count": summary.get("turn_count"),
        "total_stages": total_stages,
        "updates_emitted": updates_emitted,
        "final_stage_index": final_stage_index,
        "stage_coverage_rate": round(final_stage_index / total_stages, 4) if total_stages > 0 else 0.0,
        "completed_all_stages": bool(summary.get("completed_all_stages")),
        "final_matches_reference": bool(summary.get("final_matches_reference")),
        "exact_update_count_match": (updates_emitted == total_stages) if total_stages > 0 else None,
        **latencies,
        "detail_path": str(detail_path),
        "error": None,
    }


def _row_from_error(sample_entry, exc: Exception) -> dict:
    return {
        "generated_at_utc": utc_iso(),
        "sample_id": sample_entry.sample_id,
        "split": sample_entry.split,
        "diagram_type": sample_entry.diagram_type,
        "complexity_bucket": sample_entry.complexity_bucket,
        "gate_kind": "",
        "planner_kind": "",
        "turn_count": None,
        "total_stages": None,
        "updates_emitted": None,
        "final_stage_index": None,
        "stage_coverage_rate": None,
        "completed_all_stages": None,
        "final_matches_reference": None,
        "exact_update_count_match": None,
        "gate_calls": None,
        "planner_calls": None,
        "gate_latency_mean_ms": None,
        "planner_latency_mean_ms": None,
        "total_model_latency_ms": None,
        "detail_path": "",
        "error": str(exc),
    }


def _run_entry(entry, args: argparse.Namespace, runner: IncrementalSystemRunner, details_dir: Path) -> tuple[object, dict]:
    try:
        sample = load_runtime_sample(args.run_root, entry.sample_id)
        payload = runner.run_sample(sample)
        detail_path = details_dir / f"{entry.sample_id}.json"
        write_json(detail_path, payload)
        return entry, _row_from_payload(entry, payload, detail_path)
    except Exception as exc:
        return entry, _row_from_error(entry, exc)


def main() -> None:
    args = parse_args()
    inject_api_key(args.gate_api_key_env, args.gate_api_key)
    inject_api_key(args.planner_api_key_env, args.planner_api_key)

    output_jsonl = resolve_path(args.output_jsonl)
    manifest_output = resolve_path(args.manifest_output) if args.manifest_output else output_jsonl.with_suffix(".manifest.json")
    details_dir = resolve_path(args.details_dir) if args.details_dir else output_jsonl.parent / "details"
    details_dir.mkdir(parents=True, exist_ok=True)

    selected_ids = load_incremental_sample_ids(args.sample_ids_file)
    entries = load_incremental_entries(
        run_root=args.run_root,
        split=args.split,
        max_samples=args.max_samples,
        sample_ids=selected_ids if selected_ids else None,
    )

    completed_ids: set[str] = set()
    if args.resume and output_jsonl.exists():
        completed_ids = {str(row.get("sample_id")) for row in read_jsonl(output_jsonl)}
    elif output_jsonl.exists():
        output_jsonl.unlink()

    runner = _build_runner(args)
    manifest = {
        "generated_at_utc": utc_iso(),
        "run_root": str(resolve_path(args.run_root)),
        "split": args.split,
        "requested_sample_count": len(entries),
        "completed_ids_before_run": len(completed_ids),
        "gate_kind": args.gate_kind,
        "planner_kind": args.planner_kind,
        "output_jsonl": str(output_jsonl),
        "details_dir": str(details_dir),
        "rows_written": 0,
        "error_rows": 0,
    }

    pending_entries = [entry for entry in entries if entry.sample_id not in completed_ids]

    if args.max_concurrency <= 1:
        for entry in pending_entries:
            _, row = _run_entry(entry, args, runner, details_dir)
            if row.get("error"):
                manifest["error_rows"] += 1
            append_jsonl(output_jsonl, row)
            manifest["rows_written"] += 1
            print(
                f"[incremental-inference] sample={entry.sample_id} split={entry.split} "
                f"match={row.get('final_matches_reference')} error={bool(row.get('error'))}",
                flush=True,
            )
    else:
        with ThreadPoolExecutor(max_workers=args.max_concurrency) as executor:
            futures = {
                executor.submit(_run_entry, entry, args, runner, details_dir): entry
                for entry in pending_entries
            }
            for future in as_completed(futures):
                entry, row = future.result()
                if row.get("error"):
                    manifest["error_rows"] += 1
                append_jsonl(output_jsonl, row)
                manifest["rows_written"] += 1
                print(
                    f"[incremental-inference] sample={entry.sample_id} split={entry.split} "
                    f"match={row.get('final_matches_reference')} error={bool(row.get('error'))}",
                    flush=True,
                )

    write_json(manifest_output, manifest)
    print(f"Output JSONL: {output_jsonl}")
    print(f"Manifest: {manifest_output}")


if __name__ == "__main__":
    main()
