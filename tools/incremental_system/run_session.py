#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, write_json
from tools.incremental_system.algorithm import DeterministicAlgorithmLayer
from tools.incremental_system.chat_clients import OpenAICompatibleChatClient
from tools.incremental_system.loader import list_completed_sample_ids, load_runtime_sample
from tools.incremental_system.models import LLMGateModel, LLMPlannerModel, OracleGateModel, OraclePlannerModel
from tools.incremental_system.runtime import IncrementalSystemRunner


DEFAULT_RUN_ROOT = "data/incremental_dataset/runs/minimax_m27_incremental_full_v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the incremental Stream2Graph core system on one sample.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--run-root", type=str, default=DEFAULT_RUN_ROOT)
    parser.add_argument("--sample-id", type=str, default="")
    parser.add_argument("--output", type=str, default="")
    parser.add_argument("--gate-kind", type=str, default="oracle", choices=["oracle", "openai_compatible"])
    parser.add_argument("--planner-kind", type=str, default="oracle", choices=["oracle", "openai_compatible"])
    parser.add_argument("--gate-endpoint", type=str, default="")
    parser.add_argument("--gate-model", type=str, default="")
    parser.add_argument("--gate-api-key-env", type=str, default="OPENAI_API_KEY")
    parser.add_argument("--gate-api-key", type=str, default="")
    parser.add_argument("--planner-endpoint", type=str, default="")
    parser.add_argument("--planner-model", type=str, default="")
    parser.add_argument("--planner-api-key-env", type=str, default="OPENAI_API_KEY")
    parser.add_argument("--planner-api-key", type=str, default="")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout-sec", type=int, default=180)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff-sec", type=float, default=3.0)
    parser.add_argument("--request-interval-sec", type=float, default=0.0)
    parser.add_argument("--extra-body-json", type=str, default="")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def _make_client(
    endpoint: str,
    model: str,
    api_key: str,
    api_key_env: str,
    args: argparse.Namespace,
) -> OpenAICompatibleChatClient:
    extra_body = json.loads(args.extra_body_json) if args.extra_body_json else {}
    return OpenAICompatibleChatClient(
        endpoint=endpoint,
        model=model,
        api_key=api_key,
        api_key_env=api_key_env,
        timeout_sec=args.timeout_sec,
        max_retries=args.max_retries,
        retry_backoff_sec=args.retry_backoff_sec,
        request_interval_sec=args.request_interval_sec,
        extra_body=extra_body,
        temperature=args.temperature,
    )


def _build_models(args: argparse.Namespace):
    if args.gate_kind == "oracle":
        gate_model = OracleGateModel()
    else:
        gate_client = _make_client(
            endpoint=args.gate_endpoint,
            model=args.gate_model,
            api_key=args.gate_api_key,
            api_key_env=args.gate_api_key_env,
            args=args,
        )
        gate_model = LLMGateModel(gate_client)

    if args.planner_kind == "oracle":
        planner_model = OraclePlannerModel()
    else:
        planner_client = _make_client(
            endpoint=args.planner_endpoint,
            model=args.planner_model,
            api_key=args.planner_api_key,
            api_key_env=args.planner_api_key_env,
            args=args,
        )
        planner_model = LLMPlannerModel(planner_client)
    return gate_model, planner_model


def main() -> None:
    args = parse_args()
    sample_id = args.sample_id
    if not sample_id:
        completed = list_completed_sample_ids(args.run_root, limit=1)
        if not completed:
            raise SystemExit("No completed samples found under the run root.")
        sample_id = completed[0]

    sample = load_runtime_sample(args.run_root, sample_id)
    gate_model, planner_model = _build_models(args)
    runner = IncrementalSystemRunner(
        algorithm_layer=DeterministicAlgorithmLayer(),
        gate_model=gate_model,
        planner_model=planner_model,
    )
    payload = runner.run_sample(sample)

    if args.output:
        write_json(resolve_path(args.output), payload)
        print(f"Output: {resolve_path(args.output)}")
    else:
        print(json.dumps(payload["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
