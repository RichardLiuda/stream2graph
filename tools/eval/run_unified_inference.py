#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import append_jsonl, inject_api_key, read_jsonl, resolve_path, utc_iso, write_json
from tools.eval.dataset import DEFAULT_SOURCE_DIR, DEFAULT_SPLIT_DIR, load_evaluation_samples
from tools.eval.predictors import build_predictor


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _acquire_output_lock(output_jsonl: Path) -> tuple[Path, dict]:
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    lock_path = output_jsonl.with_suffix(output_jsonl.suffix + ".lock")
    payload = {
        "pid": os.getpid(),
        "created_at_utc": utc_iso(),
        "output_jsonl": str(output_jsonl),
    }

    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            return lock_path, payload
        except FileExistsError:
            try:
                existing = json.loads(lock_path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
            existing_pid = int(existing.get("pid") or 0)
            if _pid_is_running(existing_pid):
                raise SystemExit(
                    f"Another run_unified_inference process already owns {output_jsonl} "
                    f"(pid={existing_pid}). Refusing to write duplicate rows."
                )
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass


def _release_output_lock(lock_path: Path, lock_payload: dict) -> None:
    try:
        existing = json.loads(lock_path.read_text(encoding="utf-8"))
    except Exception:
        existing = {}
    if int(existing.get("pid") or 0) != int(lock_payload.get("pid") or -1):
        return
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


def _load_sample_ids(path_value: str) -> set[str]:
    if not path_value:
        return set()
    path = resolve_path(path_value)
    if path.suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            values = payload.get("ids", [])
        else:
            values = payload
        return {str(item) for item in values}
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


def _predictor_config_from_args(args: argparse.Namespace) -> dict:
    config = {
        "provider": args.provider,
        "model": args.model,
        "model_name_or_path": args.model_name_or_path or args.model,
        "adapter_path": args.adapter_path,
        "static_rows_path": args.static_rows_path,
        "endpoint": args.endpoint,
        "api_key_env": args.api_key_env,
        "temperature": args.temperature,
        "thinking_level": getattr(args, "thinking_level", ""),
        "top_p": args.top_p,
        "do_sample": args.do_sample,
        "max_new_tokens": args.max_new_tokens,
        "max_output_tokens": args.max_new_tokens,
        "max_tokens": args.max_new_tokens,
        "timeout_sec": args.timeout_sec,
        "max_retries": args.max_retries,
        "retry_backoff_sec": args.retry_backoff_sec,
        "request_interval_sec": args.request_interval_sec,
        "max_concurrency": args.max_concurrency,
        "use_4bit": args.use_4bit,
        "gpu_memory_limit_mib": args.gpu_memory_limit_mib,
        "cpu_memory_limit_gib": args.cpu_memory_limit_gib,
        "attn_implementation": args.attn_implementation,
    }
    return {key: value for key, value in config.items() if value not in {"", None}}


def _supports_parallel_inference(predictor) -> bool:
    return bool(getattr(predictor, "supports_parallel", False))


def _row_from_prediction_result(sample, result) -> dict:
    return {
        "generated_at_utc": utc_iso(),
        "sample_id": sample.sample_id,
        "split": sample.split,
        "diagram_type": sample.diagram_type,
        "source_path": sample.source_path,
        "dialogue_turns": sample.dialogue_turns,
        "prompt": sample.prompt,
        "reference_code": sample.reference_code,
        "provider": result.provider,
        "model_name": result.model_name,
        "generated_code": result.generated_code,
        "raw_output_text": result.raw_output_text,
        "latency_ms": result.latency_ms,
        "finish_reason": result.finish_reason,
        "usage": result.usage,
        "error": result.error,
    }


def _row_from_exception(sample, predictor_config: dict, exc: Exception) -> dict:
    result_provider = str(predictor_config.get("provider", "unknown"))
    result_model = str(
        predictor_config.get("model_name_or_path")
        or predictor_config.get("model")
        or result_provider
    )
    return {
        "generated_at_utc": utc_iso(),
        "sample_id": sample.sample_id,
        "split": sample.split,
        "diagram_type": sample.diagram_type,
        "source_path": sample.source_path,
        "dialogue_turns": sample.dialogue_turns,
        "prompt": sample.prompt,
        "reference_code": sample.reference_code,
        "provider": result_provider,
        "model_name": result_model,
        "generated_code": "",
        "raw_output_text": "",
        "latency_ms": 0.0,
        "finish_reason": "exception",
        "usage": {},
        "error": str(exc),
    }


def _predict_sample(sample, predictor, predictor_config: dict) -> dict:
    try:
        result = predictor.predict(sample)
        return _row_from_prediction_result(sample, result)
    except Exception as exc:
        return _row_from_exception(sample, predictor_config, exc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unified inference runner for Stream2Graph evaluation.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--source-dir", type=str, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--split-dir", type=str, default=DEFAULT_SPLIT_DIR)
    parser.add_argument("--split", type=str, default="test", choices=["train", "validation", "test", "all"])
    parser.add_argument("--output-jsonl", type=str, default="reports/evaluation/inference/predictions.jsonl")
    parser.add_argument("--manifest-output", type=str, default="")
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--sample-ids-file", type=str, default="")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--provider", type=str, default="gold_reference")
    parser.add_argument("--model", type=str, default="")
    parser.add_argument("--model-name-or-path", type=str, default="")
    parser.add_argument("--adapter-path", type=str, default="")
    parser.add_argument("--static-rows-path", type=str, default="")
    parser.add_argument("--endpoint", type=str, default="")
    parser.add_argument("--api-key-env", type=str, default="")
    parser.add_argument("--api-key", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--do-sample", action="store_true")
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff-sec", type=float, default=3.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.0)
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--use-4bit", action="store_true")
    parser.add_argument("--gpu-memory-limit-mib", type=int, default=0)
    parser.add_argument("--cpu-memory-limit-gib", type=int, default=0)
    parser.add_argument("--attn-implementation", type=str, default="sdpa")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    inject_api_key(args.api_key_env, args.api_key)
    raw_config = json.loads(resolve_path(args.config).read_text(encoding="utf-8")) if args.config else {}
    output_jsonl = resolve_path(args.output_jsonl)
    manifest_output = (
        resolve_path(args.manifest_output)
        if args.manifest_output
        else output_jsonl.with_suffix(".manifest.json")
    )
    lock_path, lock_payload = _acquire_output_lock(output_jsonl)

    predictor = None
    try:
        selected_ids = _load_sample_ids(args.sample_ids_file)
        samples = load_evaluation_samples(
            source_dir=args.source_dir,
            split_dir=args.split_dir,
            split=args.split,
            max_samples=args.max_samples,
            sample_ids=selected_ids if selected_ids else None,
        )

        completed_ids: set[str] = set()
        if args.resume and output_jsonl.exists():
            completed_ids = {str(row.get("sample_id")) for row in read_jsonl(output_jsonl)}
        elif output_jsonl.exists():
            output_jsonl.unlink()

        predictor_config = {
            key: raw_config[key]
            for key in {
                "extra_body",
                "omit_temperature",
                "provider_name",
                "turn_interval_ms",
                "realtime",
                "time_scale",
                "max_chunks",
                "min_wait_k",
                "base_wait_k",
                "max_wait_k",
                "expected_intent_strategy",
                "diagram_export_style",
            }
            if key in raw_config
        }
        predictor_config.update(_predictor_config_from_args(args))
        static_rows = None
        if predictor_config.get("provider") == "static_jsonl" and predictor_config.get("static_rows_path"):
            static_rows = read_jsonl(resolve_path(str(predictor_config["static_rows_path"])))
        predictor = build_predictor(predictor_config, static_rows=static_rows)
        pending_samples = [sample for sample in samples if sample.sample_id not in completed_ids]

        processed = 0
        skipped = 0
        failures = 0
        skipped = len(samples) - len(pending_samples)

        row_iterable = pending_samples
        if args.max_concurrency > 1 and _supports_parallel_inference(predictor) and len(pending_samples) > 1:
            worker_count = min(max(1, args.max_concurrency), len(pending_samples))
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                row_iterable = executor.map(
                    lambda sample: _predict_sample(sample, predictor, predictor_config),
                    pending_samples,
                )
                for row in row_iterable:
                    append_jsonl(output_jsonl, row)
                    processed += 1
                    if row.get("error"):
                        failures += 1
                    print(
                        f"[eval-infer] sample={row['sample_id']} split={row['split']} "
                        f"provider={row['provider']} model={row['model_name']} "
                        f"latency_ms={float(row['latency_ms'] or 0.0):.2f} error={bool(row.get('error'))}",
                        flush=True,
                    )
        else:
            for sample in pending_samples:
                row = _predict_sample(sample, predictor, predictor_config)
                append_jsonl(output_jsonl, row)
                processed += 1
                if row.get("error"):
                    failures += 1
                print(
                    f"[eval-infer] sample={row['sample_id']} split={row['split']} "
                    f"provider={row['provider']} model={row['model_name']} "
                    f"latency_ms={float(row['latency_ms'] or 0.0):.2f} error={bool(row.get('error'))}",
                    flush=True,
                )
        manifest = {
            "generated_at_utc": utc_iso(),
            "source_dir": str(resolve_path(args.source_dir)),
            "split_dir": str(resolve_path(args.split_dir)),
            "split": args.split,
            "sample_count_requested": len(samples),
            "sample_count_processed": processed,
            "sample_count_skipped": skipped,
            "failure_count": failures,
            "output_jsonl": str(output_jsonl),
            "predictor": predictor_config,
        }
        write_json(manifest_output, manifest)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
    finally:
        if predictor is not None:
            predictor.close()
        _release_output_lock(lock_path, lock_payload)


if __name__ == "__main__":
    main()
