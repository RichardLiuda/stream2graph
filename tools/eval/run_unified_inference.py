#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import append_jsonl, read_jsonl, resolve_path, utc_iso, write_json
from tools.eval.dataset import DEFAULT_SOURCE_DIR, DEFAULT_SPLIT_DIR, load_evaluation_samples
from tools.eval.predictors import build_predictor


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
        "top_p": args.top_p,
        "do_sample": args.do_sample,
        "max_new_tokens": args.max_new_tokens,
        "max_output_tokens": args.max_new_tokens,
        "max_tokens": args.max_new_tokens,
        "timeout_sec": args.timeout_sec,
        "max_retries": args.max_retries,
        "retry_backoff_sec": args.retry_backoff_sec,
        "request_interval_sec": args.request_interval_sec,
        "use_4bit": args.use_4bit,
        "gpu_memory_limit_mib": args.gpu_memory_limit_mib,
        "cpu_memory_limit_gib": args.cpu_memory_limit_gib,
        "attn_implementation": args.attn_implementation,
    }
    return {key: value for key, value in config.items() if value not in {"", None}}


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
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--do-sample", action="store_true")
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff-sec", type=float, default=3.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.0)
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
    raw_config = json.loads(resolve_path(args.config).read_text(encoding="utf-8")) if args.config else {}
    output_jsonl = resolve_path(args.output_jsonl)
    manifest_output = (
        resolve_path(args.manifest_output)
        if args.manifest_output
        else output_jsonl.with_suffix(".manifest.json")
    )

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
        for key in {"extra_body", "provider_name"}
        if key in raw_config
    }
    predictor_config.update(_predictor_config_from_args(args))
    static_rows = None
    if predictor_config.get("provider") == "static_jsonl" and predictor_config.get("static_rows_path"):
        static_rows = read_jsonl(resolve_path(str(predictor_config["static_rows_path"])))
    predictor = build_predictor(predictor_config, static_rows=static_rows)

    processed = 0
    skipped = 0
    failures = 0
    for sample in samples:
        if sample.sample_id in completed_ids:
            skipped += 1
            continue
        try:
            result = predictor.predict(sample)
        except Exception as exc:
            result_provider = str(predictor_config.get("provider", "unknown"))
            result_model = str(
                predictor_config.get("model_name_or_path")
                or predictor_config.get("model")
                or result_provider
            )
            row = {
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
            append_jsonl(output_jsonl, row)
            processed += 1
            failures += 1
            print(
                f"[eval-infer] sample={sample.sample_id} split={sample.split} "
                f"provider={result_provider} model={result_model} "
                f"latency_ms=0.00 error=True exception={exc}",
                flush=True,
            )
            continue
        row = {
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
        append_jsonl(output_jsonl, row)
        processed += 1
        if result.error:
            failures += 1
        print(
            f"[eval-infer] sample={sample.sample_id} split={sample.split} "
            f"provider={result.provider} model={result.model_name} "
            f"latency_ms={result.latency_ms:.2f} error={bool(result.error)}",
            flush=True,
        )

    predictor.close()

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


if __name__ == "__main__":
    main()
