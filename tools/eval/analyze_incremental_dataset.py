#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median
from typing import Any, Iterable

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, utc_iso, write_json
from tools.eval.incremental_dataset import DEFAULT_INCREMENTAL_RUN_ROOT, load_incremental_entries
from tools.eval.reporting import markdown_table
from tools.incremental_system.loader import load_runtime_sample


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze the incremental Stream2Graph dataset and run structural self-checks."
    )
    parser.add_argument("--run-root", type=str, default=DEFAULT_INCREMENTAL_RUN_ROOT)
    parser.add_argument(
        "--output-dir",
        type=str,
        default="reports/evaluation/published/incremental_dataset_full_v1_analysis",
    )
    return parser.parse_args()


def _text_units(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]", text or ""))


def _safe_ratio(numerator: float, denominator: float) -> float | None:
    if denominator == 0:
        return None
    return numerator / denominator


def _round_or_none(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    return round(float(value), digits)


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(item) for item in values)
    if len(ordered) == 1:
        return ordered[0]
    rank = quantile * (len(ordered) - 1)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _numeric_summary(values: Iterable[float | int]) -> dict[str, float | int | None]:
    nums = [float(item) for item in values]
    if not nums:
        return {
            "count": 0,
            "mean": None,
            "min": None,
            "max": None,
            "p50": None,
            "p95": None,
        }
    return {
        "count": len(nums),
        "mean": _round_or_none(sum(nums) / len(nums)),
        "min": _round_or_none(min(nums)),
        "max": _round_or_none(max(nums)),
        "p50": _round_or_none(float(median(nums))),
        "p95": _round_or_none(_percentile(nums, 0.95)),
    }


def _counter_rows(counter: Counter[str | int]) -> list[dict[str, Any]]:
    rows = [{"label": str(key), "count": int(value)} for key, value in counter.most_common()]
    return rows


def _is_sequential(indices: list[int]) -> bool:
    return indices == list(range(1, len(indices) + 1))


def _boundary_coverage_exact(turn_ids: list[int], boundaries: list[Any]) -> bool:
    if not turn_ids:
        return len(boundaries) == 0
    covered: list[int] = []
    last_end: int | None = None
    for boundary in sorted(boundaries, key=lambda item: item.stage_index):
        start = int(boundary.start_turn)
        end = int(boundary.end_turn)
        if end < start:
            return False
        if last_end is not None and start != (last_end + 1):
            return False
        covered.extend(range(start, end + 1))
        last_end = end
    return covered == turn_ids


def _stage_entity_sets(stage_graph) -> tuple[set[str], set[str], set[str]]:
    return (
        {node.id for node in stage_graph.nodes},
        {edge.id for edge in stage_graph.edges},
        {group.id for group in stage_graph.groups},
    )


def _monotonic_stage_growth(stages: list[Any]) -> tuple[bool, bool, bool]:
    prev_nodes: set[str] = set()
    prev_edges: set[str] = set()
    prev_groups: set[str] = set()
    nodes_ok = True
    edges_ok = True
    groups_ok = True
    for stage in sorted(stages, key=lambda item: item.stage_index):
        curr_nodes, curr_edges, curr_groups = _stage_entity_sets(stage.graph_ir)
        nodes_ok = nodes_ok and prev_nodes.issubset(curr_nodes)
        edges_ok = edges_ok and prev_edges.issubset(curr_edges)
        groups_ok = groups_ok and prev_groups.issubset(curr_groups)
        prev_nodes, prev_edges, prev_groups = curr_nodes, curr_edges, curr_groups
    return nodes_ok, edges_ok, groups_ok


def _actual_stage_growth(stages: list[Any]) -> list[int]:
    growth: list[int] = []
    prev_nodes: set[str] = set()
    prev_edges: set[str] = set()
    prev_groups: set[str] = set()
    for stage in sorted(stages, key=lambda item: item.stage_index):
        curr_nodes, curr_edges, curr_groups = _stage_entity_sets(stage.graph_ir)
        added = (
            len(curr_nodes - prev_nodes)
            + len(curr_edges - prev_edges)
            + len(curr_groups - prev_groups)
        )
        growth.append(added)
        prev_nodes, prev_edges, prev_groups = curr_nodes, curr_edges, curr_groups
    return growth


def _diagram_slice_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["diagram_type"]].append(row)
    output: list[dict[str, Any]] = []
    for diagram_type, bucket in sorted(grouped.items(), key=lambda item: item[0]):
        output.append(
            {
                "diagram_type": diagram_type,
                "count": len(bucket),
                "avg_turns": _round_or_none(sum(item["turn_count"] for item in bucket) / len(bucket)),
                "avg_stages": _round_or_none(sum(item["stage_count"] for item in bucket) / len(bucket)),
                "avg_final_entities": _round_or_none(
                    sum(item["final_entities"] for item in bucket) / len(bucket)
                ),
                "avg_delta_ops_per_stage": _round_or_none(
                    sum(item["mean_delta_ops_per_stage"] for item in bucket) / len(bucket)
                ),
                "avg_actual_entity_growth_per_stage": _round_or_none(
                    sum(item["mean_actual_entity_growth_per_stage"] for item in bucket) / len(bucket)
                ),
                "boundary_exact_rate": _round_or_none(
                    sum(1 for item in bucket if item["boundary_exact"]) / len(bucket)
                ),
                "monotonic_graph_rate": _round_or_none(
                    sum(1 for item in bucket if item["graph_monotonic"]) / len(bucket)
                ),
            }
        )
    return output


def _summary_markdown(summary: dict[str, Any]) -> str:
    overview_rows = [
        {"metric": "sample_count", "value": summary["sample_count"]},
        {"metric": "load_error_count", "value": summary["self_check"]["load_error_count"]},
        {
            "metric": "boundary_exact_rate",
            "value": summary["self_check"]["boundary_exact_rate"],
        },
        {
            "metric": "monotonic_graph_rate",
            "value": summary["self_check"]["monotonic_graph_rate"],
        },
        {
            "metric": "stage_count_match_rate",
            "value": summary["self_check"]["boundary_count_match_rate"],
        },
        {
            "metric": "preview_present_rate",
            "value": summary["self_check"]["preview_present_rate"],
        },
        {
            "metric": "nonempty_delta_stage_rate",
            "value": summary["self_check"]["nonempty_delta_stage_rate"],
        },
    ]
    numeric_rows = []
    for key in (
        "turn_count",
        "stage_count",
        "turn_tokens_per_dialogue",
        "turn_tokens_per_turn",
        "final_nodes",
        "final_edges",
        "final_groups",
        "final_entities",
        "turns_per_stage",
        "delta_ops_per_stage",
        "actual_entity_growth_per_stage",
        "final_edge_density",
    ):
        metric = summary["metrics"][key]
        numeric_rows.append(
            {
                "metric": key,
                "mean": metric["mean"],
                "p50": metric["p50"],
                "p95": metric["p95"],
                "min": metric["min"],
                "max": metric["max"],
            }
        )
    parts = [
        "# Incremental Dataset Analysis",
        "",
        f"- Generated at (UTC): {summary['generated_at_utc']}",
        f"- Run root: `{summary['run_root']}`",
        "",
        "## Overview",
        "",
        markdown_table(overview_rows, [("Metric", "metric"), ("Value", "value")]),
        "## Core Numeric Metrics",
        "",
        markdown_table(
            numeric_rows,
            [
                ("Metric", "metric"),
                ("Mean", "mean"),
                ("P50", "p50"),
                ("P95", "p95"),
                ("Min", "min"),
                ("Max", "max"),
            ],
        ),
        "## By Diagram Type",
        "",
        markdown_table(
            summary["slices"]["by_diagram_type"],
            [
                ("Diagram Type", "diagram_type"),
                ("Count", "count"),
                ("Avg Turns", "avg_turns"),
                ("Avg Stages", "avg_stages"),
                ("Avg Final Entities", "avg_final_entities"),
                ("Avg Delta Ops/Stage", "avg_delta_ops_per_stage"),
                ("Avg Actual Growth/Stage", "avg_actual_entity_growth_per_stage"),
                ("Boundary Exact Rate", "boundary_exact_rate"),
                ("Monotonic Graph Rate", "monotonic_graph_rate"),
            ],
        ),
        "## Split Distribution",
        "",
        markdown_table(summary["distributions"]["split"], [("Split", "label"), ("Count", "count")]),
        "## Diagram Distribution",
        "",
        markdown_table(
            summary["distributions"]["diagram_type"],
            [("Diagram Type", "label"), ("Count", "count")],
        ),
    ]
    error_examples = summary["self_check"]["load_error_examples"]
    if error_examples:
        parts.extend(
            [
                "## Load Error Examples",
                "",
                *[f"- `{item['sample_id']}`: `{item['error']}`" for item in error_examples],
            ]
        )
    return "\n".join(parts).strip() + "\n"


def main() -> None:
    args = parse_args()
    entries = load_incremental_entries(args.run_root, split="all")

    split_counter: Counter[str] = Counter()
    diagram_counter: Counter[str] = Counter()
    source_counter: Counter[str] = Counter()
    license_counter: Counter[str] = Counter()
    augmented_counter: Counter[str] = Counter()
    complexity_counter: Counter[str] = Counter()

    turn_count_values: list[int] = []
    stage_count_values: list[int] = []
    turns_per_stage_values: list[float] = []
    dialogue_token_values: list[int] = []
    turn_token_values: list[int] = []
    final_nodes_values: list[int] = []
    final_edges_values: list[int] = []
    final_groups_values: list[int] = []
    final_entities_values: list[int] = []
    delta_ops_per_stage_values: list[int] = []
    actual_growth_per_stage_values: list[int] = []
    final_edge_density_values: list[float] = []

    boundary_exact_count = 0
    boundary_count_match_count = 0
    stage_indices_sequential_count = 0
    boundary_indices_sequential_count = 0
    turn_ids_unique_count = 0
    turn_ids_monotonic_count = 0
    graph_monotonic_count = 0
    preview_present_stage_count = 0
    delta_present_stage_count = 0
    total_stage_rows = 0
    turns_with_stage_label = 0
    total_turn_rows = 0
    load_errors: list[dict[str, str]] = []
    boundary_count_mismatch_examples: list[dict[str, Any]] = []
    boundary_not_exact_examples: list[dict[str, Any]] = []
    duplicate_turn_id_examples: list[dict[str, Any]] = []
    sample_rows: list[dict[str, Any]] = []

    for entry in entries:
        split_counter[entry.split] += 1
        diagram_counter[entry.diagram_type] += 1
        source_counter[str(entry.metadata.get("source", ""))] += 1
        license_counter[str(entry.metadata.get("license", ""))] += 1
        augmented_counter[str(bool(entry.metadata.get("augmented", False))).lower()] += 1
        complexity_value = entry.metadata.get("complexity_bucket")
        complexity_counter[str(complexity_value if complexity_value is not None else "unknown")] += 1

        try:
            sample = load_runtime_sample(args.run_root, entry.sample_id)
        except Exception as exc:  # noqa: BLE001
            load_errors.append({"sample_id": entry.sample_id, "error": str(exc)})
            continue

        turns = sample.turns
        stages = sorted(sample.stages, key=lambda item: item.stage_index)
        boundaries = sorted(sample.stage_boundaries, key=lambda item: item.stage_index)
        final_graph = stages[-1].graph_ir if stages else sample.graph_ir

        turn_ids = [int(turn.turn_id) for turn in turns]
        turn_id_unique = len(turn_ids) == len(set(turn_ids))
        turn_id_monotonic = turn_ids == sorted(turn_ids)
        if turn_id_unique:
            turn_ids_unique_count += 1
        elif len(duplicate_turn_id_examples) < 10:
            duplicate_turn_id_examples.append(
                {
                    "sample_id": entry.sample_id,
                    "diagram_type": entry.diagram_type,
                    "turn_ids_head": turn_ids[:12],
                }
            )
        if turn_id_monotonic:
            turn_ids_monotonic_count += 1

        stage_indices = [int(stage.stage_index) for stage in stages]
        boundary_indices = [int(boundary.stage_index) for boundary in boundaries]
        if len(boundaries) == len(stages):
            boundary_count_match_count += 1
        elif len(boundary_count_mismatch_examples) < 10:
            boundary_count_mismatch_examples.append(
                {
                    "sample_id": entry.sample_id,
                    "diagram_type": entry.diagram_type,
                    "stage_count": len(stages),
                    "boundary_count": len(boundaries),
                    "boundary_head": [
                        {
                            "stage_index": int(boundary.stage_index),
                            "start_turn": int(boundary.start_turn),
                            "end_turn": int(boundary.end_turn),
                        }
                        for boundary in boundaries[:5]
                    ],
                }
            )
        if _is_sequential(stage_indices):
            stage_indices_sequential_count += 1
        if _is_sequential(boundary_indices):
            boundary_indices_sequential_count += 1
        boundary_exact = _boundary_coverage_exact(turn_ids, boundaries)
        if boundary_exact:
            boundary_exact_count += 1
        elif len(boundary_not_exact_examples) < 10:
            boundary_not_exact_examples.append(
                {
                    "sample_id": entry.sample_id,
                    "diagram_type": entry.diagram_type,
                    "turn_ids_head": turn_ids[:12],
                    "boundary_head": [
                        {
                            "stage_index": int(boundary.stage_index),
                            "start_turn": int(boundary.start_turn),
                            "end_turn": int(boundary.end_turn),
                        }
                        for boundary in boundaries[:5]
                    ],
                }
            )

        nodes_ok, edges_ok, groups_ok = _monotonic_stage_growth(stages)
        graph_monotonic = nodes_ok and edges_ok and groups_ok
        if graph_monotonic:
            graph_monotonic_count += 1

        turn_count = len(turns)
        stage_count = len(stages)
        turn_tokens = [_text_units(turn.content) for turn in turns]
        dialogue_tokens = sum(turn_tokens)
        turns_with_stage_label += sum(1 for turn in turns if turn.stage_index is not None)
        total_turn_rows += turn_count

        final_nodes = len(final_graph.nodes)
        final_edges = len(final_graph.edges)
        final_groups = len(final_graph.groups)
        final_entities = final_nodes + final_edges + final_groups
        final_edge_density = _safe_ratio(final_edges, max(final_nodes, 1))

        stage_delta_sizes = [len(stage.delta_ops) for stage in stages]
        actual_growth_sizes = _actual_stage_growth(stages)
        preview_present_stage_count += sum(1 for stage in stages if str(stage.preview_mermaid).strip())
        delta_present_stage_count += sum(1 for stage in stages if len(stage.delta_ops) > 0)
        total_stage_rows += stage_count

        turn_count_values.append(turn_count)
        stage_count_values.append(stage_count)
        turns_per_stage_values.append(_safe_ratio(turn_count, stage_count) or 0.0)
        dialogue_token_values.append(dialogue_tokens)
        turn_token_values.extend(turn_tokens)
        final_nodes_values.append(final_nodes)
        final_edges_values.append(final_edges)
        final_groups_values.append(final_groups)
        final_entities_values.append(final_entities)
        delta_ops_per_stage_values.extend(stage_delta_sizes)
        actual_growth_per_stage_values.extend(actual_growth_sizes)
        if final_edge_density is not None:
            final_edge_density_values.append(final_edge_density)

        sample_rows.append(
            {
                "sample_id": entry.sample_id,
                "split": entry.split,
                "diagram_type": entry.diagram_type,
                "turn_count": turn_count,
                "stage_count": stage_count,
                "final_entities": final_entities,
                "mean_delta_ops_per_stage": sum(stage_delta_sizes) / max(stage_count, 1),
                "mean_actual_entity_growth_per_stage": sum(actual_growth_sizes) / max(stage_count, 1),
                "boundary_exact": boundary_exact,
                "graph_monotonic": graph_monotonic,
            }
        )

    sample_count = len(entries)
    loaded_count = sample_count - len(load_errors)
    output_dir = resolve_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "generated_at_utc": utc_iso(),
        "run_root": str(resolve_path(args.run_root)),
        "sample_count": sample_count,
        "loaded_count": loaded_count,
        "self_check": {
            "load_error_count": len(load_errors),
            "load_error_examples": load_errors[:10],
            "boundary_count_mismatch_count": loaded_count - boundary_count_match_count,
            "boundary_count_mismatch_examples": boundary_count_mismatch_examples,
            "boundary_not_exact_count": loaded_count - boundary_exact_count,
            "boundary_not_exact_examples": boundary_not_exact_examples,
            "duplicate_turn_id_count": loaded_count - turn_ids_unique_count,
            "duplicate_turn_id_examples": duplicate_turn_id_examples,
            "boundary_exact_rate": _round_or_none(_safe_ratio(boundary_exact_count, loaded_count)),
            "boundary_count_match_rate": _round_or_none(
                _safe_ratio(boundary_count_match_count, loaded_count)
            ),
            "stage_indices_sequential_rate": _round_or_none(
                _safe_ratio(stage_indices_sequential_count, loaded_count)
            ),
            "boundary_indices_sequential_rate": _round_or_none(
                _safe_ratio(boundary_indices_sequential_count, loaded_count)
            ),
            "turn_ids_unique_rate": _round_or_none(_safe_ratio(turn_ids_unique_count, loaded_count)),
            "turn_ids_monotonic_rate": _round_or_none(
                _safe_ratio(turn_ids_monotonic_count, loaded_count)
            ),
            "monotonic_graph_rate": _round_or_none(_safe_ratio(graph_monotonic_count, loaded_count)),
            "preview_present_rate": _round_or_none(
                _safe_ratio(preview_present_stage_count, total_stage_rows)
            ),
            "nonempty_delta_stage_rate": _round_or_none(
                _safe_ratio(delta_present_stage_count, total_stage_rows)
            ),
            "turn_stage_label_coverage_rate": _round_or_none(
                _safe_ratio(turns_with_stage_label, total_turn_rows)
            ),
        },
        "distributions": {
            "split": _counter_rows(split_counter),
            "diagram_type": _counter_rows(diagram_counter),
            "source": _counter_rows(source_counter),
            "license": _counter_rows(license_counter),
            "augmented": _counter_rows(augmented_counter),
            "complexity_bucket": _counter_rows(complexity_counter),
        },
        "metrics": {
            "turn_count": _numeric_summary(turn_count_values),
            "stage_count": _numeric_summary(stage_count_values),
            "turns_per_stage": _numeric_summary(turns_per_stage_values),
            "turn_tokens_per_dialogue": _numeric_summary(dialogue_token_values),
            "turn_tokens_per_turn": _numeric_summary(turn_token_values),
            "final_nodes": _numeric_summary(final_nodes_values),
            "final_edges": _numeric_summary(final_edges_values),
            "final_groups": _numeric_summary(final_groups_values),
            "final_entities": _numeric_summary(final_entities_values),
            "delta_ops_per_stage": _numeric_summary(delta_ops_per_stage_values),
            "actual_entity_growth_per_stage": _numeric_summary(actual_growth_per_stage_values),
            "final_edge_density": _numeric_summary(final_edge_density_values),
        },
        "slices": {
            "by_diagram_type": _diagram_slice_rows(sample_rows),
        },
    }

    write_json(output_dir / "incremental_dataset_analysis.summary.json", summary)
    (output_dir / "incremental_dataset_analysis.summary.md").write_text(
        _summary_markdown(summary),
        encoding="utf-8",
    )
    print(f"Summary JSON: {output_dir / 'incremental_dataset_analysis.summary.json'}")
    print(f"Summary MD: {output_dir / 'incremental_dataset_analysis.summary.md'}")


if __name__ == "__main__":
    main()
