#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_jsonl, resolve_path, utc_iso, write_json
from tools.eval.metrics import MermaidCompileChecker, score_prediction
from tools.eval.reporting import (
    aggregate_rows,
    code_line_bucket,
    dialogue_turn_bucket,
    group_rows,
    markdown_table,
    top_failure_examples,
    write_csv,
)

OFFLINE_METRIC_FIELDS = [
    "normalized_exact_match",
    "diagram_type_match",
    "normalized_similarity",
    "line_f1",
    "token_f1",
    "node_f1",
    "edge_f1",
    "label_f1",
    "compile_success",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline Mermaid scoring for Stream2Graph predictions.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--input-jsonl", type=str, default="reports/evaluation/inference/predictions.jsonl")
    parser.add_argument("--output-dir", type=str, default="reports/evaluation/offline/default_run")
    parser.add_argument("--compile-command", type=str, default="")
    parser.add_argument("--compile-cache-dir", type=str, default="artifacts/evaluation/compile_cache")
    parser.add_argument("--max-workers", type=int, default=8)

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def _summary_markdown(summary: dict) -> str:
    overall_rows = []
    overall = summary["overall"]
    for field in OFFLINE_METRIC_FIELDS:
        metric = overall.get(field)
        if metric is None:
            continue
        overall_rows.append(
            {
                "metric": field,
                "count": metric.get("count"),
                "mean_or_rate": metric.get("mean", metric.get("rate")),
                "p50": metric.get("p50", ""),
                "p95": metric.get("p95", ""),
            }
        )

    by_type_rows = []
    for item in summary["slices"]["by_diagram_type"][:12]:
        by_type_rows.append(
            {
                "diagram_type": item["group"],
                "count": item["count"],
                "line_f1": (item["metrics"].get("line_f1") or {}).get("mean"),
                "edge_f1": (item["metrics"].get("edge_f1") or {}).get("mean"),
                "compile_rate": (item["metrics"].get("compile_success") or {}).get("rate"),
            }
        )

    failure_rows = [
        {
            "sample_id": item["sample_id"],
            "diagram_type": item["diagram_type"],
            "line_f1": item["line_f1"],
            "compile_success": item["compile_success"],
        }
        for item in summary["failure_examples"][:10]
    ]

    parts = [
        "# Offline Metrics Summary",
        "",
        f"- Generated at (UTC): {summary['generated_at_utc']}",
        f"- Input predictions: {summary['input_jsonl']}",
        f"- Sample count: {summary['sample_count']}",
        "",
        "## Overall",
        "",
        markdown_table(
            overall_rows,
            [
                ("Metric", "metric"),
                ("Count", "count"),
                ("Mean/Rate", "mean_or_rate"),
                ("P50", "p50"),
                ("P95", "p95"),
            ],
        ),
        "## By Diagram Type",
        "",
        markdown_table(
            by_type_rows,
            [
                ("Diagram Type", "diagram_type"),
                ("Count", "count"),
                ("Line F1", "line_f1"),
                ("Edge F1", "edge_f1"),
                ("Compile Rate", "compile_rate"),
            ],
        ),
        "## Lowest-Scoring Examples",
        "",
        markdown_table(
            failure_rows,
            [
                ("Sample ID", "sample_id"),
                ("Diagram Type", "diagram_type"),
                ("Line F1", "line_f1"),
                ("Compile", "compile_success"),
            ],
        ),
    ]
    return "\n".join(parts).strip() + "\n"


def _detail_row_from_prediction(row: dict, compile_checker: MermaidCompileChecker | None) -> dict:
    metrics = score_prediction(
        reference_code=str(row.get("reference_code", "")),
        predicted_code=str(row.get("generated_code", "")),
        declared_diagram_type=str(row.get("diagram_type", "unknown")),
        compile_checker=compile_checker,
    )
    return {
        "sample_id": row.get("sample_id"),
        "split": row.get("split"),
        "diagram_type": row.get("diagram_type"),
        "dialogue_turns": row.get("dialogue_turns"),
        "dialogue_turn_bucket": dialogue_turn_bucket(int(row.get("dialogue_turns", 0))),
        "reference_nonempty_lines": metrics["reference_nonempty_lines"],
        "reference_code_bucket": code_line_bucket(int(metrics["reference_nonempty_lines"])),
        "provider": row.get("provider"),
        "model_name": row.get("model_name"),
        "latency_ms": row.get("latency_ms"),
        **metrics,
    }


def main() -> None:
    args = parse_args()
    input_jsonl = resolve_path(args.input_jsonl)
    output_dir = resolve_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    compile_checker = None
    if args.compile_command:
        compile_checker = MermaidCompileChecker(
            command_template=args.compile_command,
            cache_dir=resolve_path(args.compile_cache_dir),
        )

    rows = read_jsonl(input_jsonl)
    detail_rows: list[dict] = []
    worker_count = max(1, args.max_workers)
    if compile_checker is not None and len(rows) > 1:
        worker_count = min(worker_count, len(rows), os.cpu_count() or worker_count)
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            detail_rows = list(executor.map(lambda row: _detail_row_from_prediction(row, compile_checker), rows))
    else:
        detail_rows = [_detail_row_from_prediction(row, compile_checker) for row in rows]

    summary = {
        "generated_at_utc": utc_iso(),
        "input_jsonl": str(input_jsonl),
        "sample_count": len(detail_rows),
        "overall": aggregate_rows(detail_rows, OFFLINE_METRIC_FIELDS),
        "slices": {
            "by_diagram_type": group_rows(detail_rows, "diagram_type", OFFLINE_METRIC_FIELDS),
            "by_dialogue_turn_bucket": group_rows(detail_rows, "dialogue_turn_bucket", OFFLINE_METRIC_FIELDS),
            "by_reference_code_bucket": group_rows(detail_rows, "reference_code_bucket", OFFLINE_METRIC_FIELDS),
        },
        "failure_examples": top_failure_examples(detail_rows, "line_f1", limit=20),
    }

    details_path = output_dir / "offline_metrics.detail.jsonl"
    summary_path = output_dir / "offline_metrics.summary.json"
    markdown_path = output_dir / "offline_metrics.summary.md"
    csv_path = output_dir / "offline_metrics.detail.csv"

    with details_path.open("w", encoding="utf-8") as handle:
        for row in detail_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    write_json(summary_path, summary)
    markdown_path.write_text(_summary_markdown(summary), encoding="utf-8")
    write_csv(
        csv_path,
        detail_rows,
        [
            "sample_id",
            "split",
            "diagram_type",
            "dialogue_turns",
            "dialogue_turn_bucket",
            "reference_nonempty_lines",
            "reference_code_bucket",
            "provider",
            "model_name",
            "latency_ms",
            "normalized_exact_match",
            "diagram_type_match",
            "normalized_similarity",
            "line_f1",
            "token_f1",
            "node_f1",
            "edge_f1",
            "label_f1",
            "compile_success",
        ],
    )

    try:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    except UnicodeEncodeError:
        print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
