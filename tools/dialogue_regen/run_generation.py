#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import threading
import time
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.dialogue_regen.dataset import (
    DEFAULT_SOURCE_DIR,
    DEFAULT_SPLIT_DIR,
    load_regen_samples,
)
from tools.dialogue_regen.parsing import parse_generated_dialogue
from tools.dialogue_regen.providers import build_generator
from tools.eval.common import append_jsonl, read_jsonl, resolve_path, utc_iso, write_json


MOONSHOT_RATE_TIERS = {
    "tier0": {"max_concurrency": 1, "requests_per_minute": 3},
    "tier1": {"max_concurrency": 50, "requests_per_minute": 200},
    "tier2": {"max_concurrency": 100, "requests_per_minute": 500},
    "tier3": {"max_concurrency": 200, "requests_per_minute": 5000},
    "tier4": {"max_concurrency": 400, "requests_per_minute": 5000},
    "tier5": {"max_concurrency": 1000, "requests_per_minute": 10000},
}


class RequestStartRateLimiter:
    def __init__(self, requests_per_minute: int) -> None:
        self.requests_per_minute = max(0, int(requests_per_minute))
        self.interval_sec = 0.0 if self.requests_per_minute <= 0 else 60.0 / self.requests_per_minute
        self._lock = threading.Lock()
        self._next_allowed_at = 0.0

    def acquire(self) -> None:
        if self.interval_sec <= 0:
            return
        wait_sec = 0.0
        with self._lock:
            now = time.monotonic()
            if now < self._next_allowed_at:
                wait_sec = self._next_allowed_at - now
            scheduled_at = max(now, self._next_allowed_at)
            self._next_allowed_at = scheduled_at + self.interval_sec
        if wait_sec > 0:
            time.sleep(wait_sec)


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unified LLM dialogue regeneration runner.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--source-dir", type=str, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--split-dir", type=str, default=DEFAULT_SPLIT_DIR)
    parser.add_argument("--split", type=str, default="validation", choices=["train", "validation", "test", "all"])
    parser.add_argument("--output-jsonl", type=str, default="reports/dialogue_regen/runs/generation.jsonl")
    parser.add_argument("--manifest-output", type=str, default="")
    parser.add_argument("--target-language", type=str, default="zh-CN")
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--sample-ids-file", type=str, default="")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--provider", type=str, default="reference_dialogue")
    parser.add_argument("--provider-name", type=str, default="")
    parser.add_argument("--model", type=str, default="")
    parser.add_argument("--endpoint", type=str, default="")
    parser.add_argument("--api-key-env", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff-sec", type=float, default=3.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.0)
    parser.add_argument("--thinking-budget", type=int, default=0)
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--requests-per-minute", type=int, default=0)
    parser.add_argument("--provider-rate-tier", type=str, default="")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def _resolve_rate_controls(args: argparse.Namespace) -> dict:
    provider_rate_tier = str(args.provider_rate_tier or "").strip().lower()
    max_concurrency = max(1, int(args.max_concurrency or 1))
    requests_per_minute = max(0, int(args.requests_per_minute or 0))

    if provider_rate_tier:
        normalized_tier = provider_rate_tier.replace("moonshot_", "").replace("moonshot:", "")
        preset = MOONSHOT_RATE_TIERS.get(normalized_tier)
        if not preset:
            raise ValueError(
                f"Unsupported provider_rate_tier: {args.provider_rate_tier}. "
                f"Supported Moonshot tiers: {', '.join(sorted(MOONSHOT_RATE_TIERS))}"
            )
        if int(args.max_concurrency or 0) <= 0:
            max_concurrency = preset["max_concurrency"]
        if int(args.requests_per_minute or 0) <= 0:
            requests_per_minute = preset["requests_per_minute"]

    return {
        "provider_rate_tier": provider_rate_tier,
        "max_concurrency": max_concurrency,
        "requests_per_minute": requests_per_minute,
    }


def main() -> None:
    args = parse_args()
    output_jsonl = resolve_path(args.output_jsonl)
    manifest_output = (
        resolve_path(args.manifest_output)
        if args.manifest_output
        else output_jsonl.with_suffix(".manifest.json")
    )

    selected_ids = _load_sample_ids(args.sample_ids_file)
    samples = load_regen_samples(
        source_dir=args.source_dir,
        split_dir=args.split_dir,
        split=args.split,
        max_samples=args.max_samples,
        sample_ids=selected_ids if selected_ids else None,
        target_language=args.target_language,
    )

    completed_ids: set[str] = set()
    if args.resume and output_jsonl.exists():
        completed_ids = {str(row.get("sample_id")) for row in read_jsonl(output_jsonl)}
    elif output_jsonl.exists():
        output_jsonl.unlink()

    generator_config = {
        "provider": args.provider,
        "provider_name": args.provider_name or args.provider,
        "model": args.model,
        "endpoint": args.endpoint,
        "api_key_env": args.api_key_env,
        "temperature": args.temperature,
        "max_output_tokens": args.max_output_tokens,
        "max_tokens": args.max_tokens,
        "timeout_sec": args.timeout_sec,
        "max_retries": args.max_retries,
        "retry_backoff_sec": args.retry_backoff_sec,
        "request_interval_sec": args.request_interval_sec,
        "thinking_budget": args.thinking_budget,
    }
    raw_config = json.loads(resolve_path(args.config).read_text(encoding="utf-8")) if args.config else {}
    if isinstance(raw_config.get("extra_body"), dict):
        generator_config["extra_body"] = raw_config["extra_body"]

    rate_controls = _resolve_rate_controls(args)
    rate_limiter = RequestStartRateLimiter(rate_controls["requests_per_minute"])
    generator_lock = threading.Lock()
    generator_tls = threading.local()
    generators: list = []
    processed = 0
    failures = 0
    skipped = 0
    parse_failures = 0
    samples_to_process = [sample for sample in samples if sample.sample_id not in completed_ids]

    skipped = len(samples) - len(samples_to_process)

    def get_generator():
        generator = getattr(generator_tls, "generator", None)
        if generator is None:
            config = dict(generator_config)
            config["request_interval_sec"] = 0.0
            generator = build_generator(config)
            generator_tls.generator = generator
            with generator_lock:
                generators.append(generator)
        return generator

    def process_sample(sample):
        try:
            rate_limiter.acquire()
            result = get_generator().generate(sample)
            parsed_dialogue = None
            parse_error = None
            parse_warnings: list[str] = []
            if not result.error:
                parsed_dialogue, parse_error = parse_generated_dialogue(
                    result.raw_output_text,
                    sample_id=sample.sample_id,
                    requested_language=args.target_language,
                )
                if parsed_dialogue is not None:
                    parse_warnings = parsed_dialogue.get("parse_warnings", [])

            return {
                "generated_at_utc": utc_iso(),
                "sample_id": sample.sample_id,
                "split": sample.split,
                "diagram_type": sample.diagram_type,
                "source_path": sample.source_path,
                "source_url": sample.source_url,
                "reference_dialogue_turns": sample.reference_dialogue_turns,
                "provider": result.provider,
                "model_name": result.model_name,
                "prompt": sample.prompt,
                "raw_output_text": result.raw_output_text,
                "generated_dialogue": parsed_dialogue,
                "target_language": args.target_language,
                "latency_ms": result.latency_ms,
                "finish_reason": result.finish_reason,
                "usage": result.usage,
                "parse_valid": bool(parsed_dialogue and not parse_error),
                "parse_warnings": parse_warnings,
                "error": result.error or parse_error,
            }
        except Exception as exc:
            return {
                "generated_at_utc": utc_iso(),
                "sample_id": sample.sample_id,
                "split": sample.split,
                "diagram_type": sample.diagram_type,
                "source_path": sample.source_path,
                "source_url": sample.source_url,
                "reference_dialogue_turns": sample.reference_dialogue_turns,
                "provider": generator_config["provider_name"],
                "model_name": generator_config["model"],
                "prompt": sample.prompt,
                "raw_output_text": "",
                "generated_dialogue": None,
                "target_language": args.target_language,
                "latency_ms": 0.0,
                "finish_reason": None,
                "usage": {},
                "parse_valid": False,
                "parse_warnings": [],
                "error": str(exc),
            }

    def persist_row(row: dict) -> None:
        nonlocal processed, failures, parse_failures
        append_jsonl(output_jsonl, row)
        processed += 1
        if row["error"]:
            failures += 1
        if row["error"] and row["raw_output_text"]:
            parse_failures += 1
        print(
            f"[dialogue-regen] sample={row['sample_id']} split={row['split']} "
            f"provider={row['provider']} model={row['model_name']} "
            f"latency_ms={row['latency_ms']:.2f} parse_valid={row['parse_valid']} "
            f"error={bool(row['error'])}",
            flush=True,
        )

    if output_jsonl.exists() and not args.resume:
        output_jsonl.unlink()

    if rate_controls["max_concurrency"] <= 1:
        for sample in samples_to_process:
            persist_row(process_sample(sample))
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=rate_controls["max_concurrency"]) as executor:
            future_to_sample = {executor.submit(process_sample, sample): sample for sample in samples_to_process}
            for future in concurrent.futures.as_completed(future_to_sample):
                persist_row(future.result())

    for generator in generators:
        generator.close()

    manifest = {
        "generated_at_utc": utc_iso(),
        "source_dir": str(resolve_path(args.source_dir)),
        "split_dir": str(resolve_path(args.split_dir)),
        "split": args.split,
        "sample_count_requested": len(samples),
        "sample_count_scheduled": len(samples_to_process),
        "sample_count_processed": processed,
        "sample_count_skipped": skipped,
        "failure_count": failures,
        "parse_failure_count": parse_failures,
        "output_jsonl": str(output_jsonl),
        "generator": generator_config,
        "rate_controls": rate_controls,
    }
    write_json(manifest_output, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
