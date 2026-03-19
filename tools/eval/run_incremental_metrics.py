#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_jsonl, resolve_path, utc_iso, write_json
from tools.eval.reporting import aggregate_rows, group_rows, markdown_table, top_failure_examples, write_csv


INCREMENTAL_METRIC_FIELDS = [
    "completed_all_stages",
    "final_matches_reference",
    "exact_update_count_match",
    "stage_coverage_rate",
    "updates_emitted",
    "total_stages",
    "planner_calls",
    "gate_latency_mean_ms",
    "planner_latency_mean_ms",
    "total_model_latency_ms",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Aggregate incremental-system evaluation metrics.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--input-jsonl", type=str, default="")
    parser.add_argument("--output-dir", type=str, default="reports/evaluation/incremental/default_metrics")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    args = parser.parse_args()
    if not args.input_jsonl:
        raise SystemExit("--input-jsonl is required.")
    return args


def _summary_markdown(summary: dict) -> str:
    overall_rows = []
    for field in INCREMENTAL_METRIC_FIELDS:
        metric = summary["overall"].get(field)
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
    for item in summary["slices"]["by_diagram_type"]:
        by_type_rows.append(
            {
                "diagram_type": item["group"],
                "count": item["count"],
                "final_match_rate": (item["metrics"].get("final_matches_reference") or {}).get("rate"),
                "coverage_mean": (item["metrics"].get("stage_coverage_rate") or {}).get("mean"),
                "planner_latency_mean_ms": (item["metrics"].get("planner_latency_mean_ms") or {}).get("mean"),
            }
        )

    parts = [
        "# Incremental Metrics Summary",
        "",
        f"- Generated at (UTC): {summary['generated_at_utc']}",
        f"- Sample count: {summary['sample_count']}",
        f"- Error rows: {summary['error_rows']}",
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
                ("Final Match Rate", "final_match_rate"),
                ("Coverage Mean", "coverage_mean"),
                ("Planner Latency Mean Ms", "planner_latency_mean_ms"),
            ],
        ),
    ]
    return "\n".join(parts).strip() + "\n"


def main() -> None:
    args = parse_args()
    output_dir = resolve_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = read_jsonl(resolve_path(args.input_jsonl))
    valid_rows = [row for row in rows if not row.get("error")]

    summary = {
        "generated_at_utc": utc_iso(),
        "input_jsonl": str(resolve_path(args.input_jsonl)),
        "sample_count": len(rows),
        "valid_row_count": len(valid_rows),
        "error_rows": len(rows) - len(valid_rows),
        "overall": aggregate_rows(valid_rows, INCREMENTAL_METRIC_FIELDS),
        "slices": {
            "by_diagram_type": group_rows(valid_rows, "diagram_type", INCREMENTAL_METRIC_FIELDS),
            "by_split": group_rows(valid_rows, "split", INCREMENTAL_METRIC_FIELDS),
        },
        "failure_examples": top_failure_examples(valid_rows, "stage_coverage_rate", limit=20),
    }

    summary_path = output_dir / "incremental_metrics.summary.json"
    markdown_path = output_dir / "incremental_metrics.summary.md"
    csv_path = output_dir / "incremental_metrics.detail.csv"

    write_json(summary_path, summary)
    markdown_path.write_text(_summary_markdown(summary), encoding="utf-8")
    write_csv(csv_path, rows, fieldnames=sorted({key for row in rows for key in row.keys()}))

    print(f"Summary: {summary_path}")
    print(f"Markdown: {markdown_path}")
    print(f"CSV: {csv_path}")


if __name__ == "__main__":
    main()
