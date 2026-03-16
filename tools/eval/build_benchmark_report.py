#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_json, resolve_path, utc_iso, write_json
from tools.eval.reporting import markdown_table


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a combined benchmark report for Stream2Graph.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--title", type=str, default="Stream2Graph Benchmark Report")
    parser.add_argument("--offline-summary", type=str, default="")
    parser.add_argument("--realtime-summary", type=str, default="")
    parser.add_argument("--output-dir", type=str, default="reports/evaluation/reports/default_run")
    parser.add_argument("--notes", type=str, default="")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def _overall_rows(summary: dict, fields: list[str]) -> list[dict]:
    rows = []
    overall = summary.get("overall", {})
    for field in fields:
        metric = overall.get(field)
        if not metric:
            continue
        rows.append(
            {
                "metric": field,
                "count": metric.get("count"),
                "mean_or_rate": metric.get("mean", metric.get("rate")),
                "p50": metric.get("p50", ""),
                "p95": metric.get("p95", ""),
            }
        )
    return rows


def main() -> None:
    args = parse_args()
    output_dir = resolve_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    offline_summary = read_json(resolve_path(args.offline_summary)) if args.offline_summary else None
    realtime_summary = read_json(resolve_path(args.realtime_summary)) if args.realtime_summary else None

    combined = {
        "generated_at_utc": utc_iso(),
        "title": args.title,
        "notes": args.notes,
        "offline_summary": offline_summary,
        "realtime_summary": realtime_summary,
    }

    markdown_parts = [
        f"# {args.title}",
        "",
        f"- Generated at (UTC): {combined['generated_at_utc']}",
    ]
    if args.notes:
        markdown_parts.extend(["", "## Notes", "", args.notes])

    if offline_summary:
        markdown_parts.extend(
            [
                "",
                "## Offline Evaluation",
                "",
                markdown_table(
                    _overall_rows(
                        offline_summary,
                        [
                            "normalized_exact_match",
                            "diagram_type_match",
                            "normalized_similarity",
                            "line_f1",
                            "token_f1",
                            "edge_f1",
                            "compile_success",
                        ],
                    ),
                    [
                        ("Metric", "metric"),
                        ("Count", "count"),
                        ("Mean/Rate", "mean_or_rate"),
                        ("P50", "p50"),
                        ("P95", "p95"),
                    ],
                ),
            ]
        )

    if realtime_summary:
        markdown_parts.extend(
            [
                "",
                "## Realtime Evaluation",
                "",
                markdown_table(
                    _overall_rows(
                        realtime_summary,
                        [
                            "realtime_eval_pass",
                            "e2e_latency_p95_ms",
                            "flicker_mean",
                            "mental_map_mean",
                            "runtime_over_transcript_ratio",
                            "updates_emitted",
                            "intent_accuracy",
                        ],
                    ),
                    [
                        ("Metric", "metric"),
                        ("Count", "count"),
                        ("Mean/Rate", "mean_or_rate"),
                        ("P50", "p50"),
                        ("P95", "p95"),
                    ],
                ),
            ]
        )

    markdown_text = "\n".join(markdown_parts).strip() + "\n"
    write_json(output_dir / "benchmark_report.json", combined)
    (output_dir / "benchmark_report.md").write_text(markdown_text, encoding="utf-8")
    try:
        print(json.dumps(combined, ensure_ascii=False, indent=2))
    except UnicodeEncodeError:
        print(json.dumps(combined, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
