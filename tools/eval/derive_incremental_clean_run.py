#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import read_json, resolve_path, utc_iso, write_json
from tools.eval.incremental_dataset import DEFAULT_INCREMENTAL_RUN_ROOT, load_incremental_entries
from tools.incremental_system.loader import load_runtime_sample


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Derive a clean incremental dataset run root from the frozen v1 benchmark."
    )
    parser.add_argument("--source-run-root", type=str, default=DEFAULT_INCREMENTAL_RUN_ROOT)
    parser.add_argument(
        "--output-run-root",
        type=str,
        default="data/incremental_dataset/runs/minimax_m27_incremental_full_v1_clean",
    )
    parser.add_argument(
        "--report-output",
        type=str,
        default="reports/evaluation/published/incremental_dataset_full_v1_clean_analysis",
    )
    parser.add_argument(
        "--require-nonempty-final-graph",
        action="store_true",
        help="Drop samples whose final graph has zero total entities.",
    )
    return parser.parse_args()


def _boundary_exact(sample) -> bool:
    turns = sorted(sample.turns, key=lambda item: item.turn_id)
    ordered_turn_ids = [int(turn.turn_id) for turn in turns]
    covered: list[int] = []
    last_end: int | None = None
    for boundary in sorted(sample.stage_boundaries, key=lambda item: item.stage_index):
        start_turn = int(boundary.start_turn)
        end_turn = int(boundary.end_turn)
        if end_turn < start_turn:
            return False
        if last_end is not None and start_turn != (last_end + 1):
            return False
        covered.extend(range(start_turn, end_turn + 1))
        last_end = end_turn
    return covered == ordered_turn_ids


def _sample_issues(sample) -> list[str]:
    turn_ids = [int(turn.turn_id) for turn in sample.turns]
    issues: list[str] = []
    if len(sample.stage_boundaries) != len(sample.stages):
        issues.append("boundary_count_mismatch")
    if not _boundary_exact(sample):
        issues.append("boundary_not_exact")
    if len(turn_ids) != len(set(turn_ids)):
        issues.append("duplicate_turn_ids")
    return issues


def _final_entity_count(sample) -> int:
    if sample.stages:
        final_graph = sample.stages[-1].graph_ir
    else:
        final_graph = sample.graph_ir
    return len(final_graph.nodes) + len(final_graph.edges) + len(final_graph.groups)


def _safe_remove(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _copy_selected_json_files(
    source_dir: Path,
    target_dir: Path,
    selected_ids: set[str],
) -> list[str]:
    target_dir.mkdir(parents=True, exist_ok=True)
    missing: list[str] = []
    for sample_id in sorted(selected_ids):
        source_file = source_dir / f"{sample_id}.json"
        if not source_file.exists():
            missing.append(sample_id)
            continue
        shutil.copy2(source_file, target_dir / source_file.name)
    return missing


def main() -> None:
    args = parse_args()
    source_root = resolve_path(args.source_run_root)
    output_root = resolve_path(args.output_run_root)
    report_output = resolve_path(args.report_output)

    entries = load_incremental_entries(source_root, split="all")
    bad_ids: set[str] = set()
    issue_counter: Counter[str] = Counter()
    diagram_removed_counter: Counter[str] = Counter()
    split_removed_counter: Counter[str] = Counter()
    issue_examples: list[dict[str, Any]] = []

    for entry in entries:
        sample = load_runtime_sample(source_root, entry.sample_id)
        issues = _sample_issues(sample)
        if args.require_nonempty_final_graph and _final_entity_count(sample) == 0:
            issues.append("empty_final_graph")
        if not issues:
            continue
        bad_ids.add(entry.sample_id)
        for issue in issues:
            issue_counter[issue] += 1
        diagram_removed_counter[entry.diagram_type] += 1
        split_removed_counter[entry.split] += 1
        if len(issue_examples) < 20:
            issue_examples.append(
                {
                    "sample_id": entry.sample_id,
                    "split": entry.split,
                    "diagram_type": entry.diagram_type,
                    "issues": issues,
                }
            )

    clean_entries = [entry for entry in entries if entry.sample_id not in bad_ids]
    clean_ids = {entry.sample_id for entry in clean_entries}

    source_selection = source_root / "selection"
    selection_manifest = read_json(source_selection / "selection_manifest.json")
    filtered_profiles = [
        row
        for row in selection_manifest.get("selected_profiles", [])
        if str(row.get("sample_id", "")) in clean_ids
    ]
    selection_stats: dict[str, dict[str, Any]] = {}
    selected_counter = Counter(str(row.get("diagram_type", "unknown")) for row in filtered_profiles)
    for diagram_type, stats in (selection_manifest.get("selection_stats") or {}).items():
        selection_stats[diagram_type] = {
            **stats,
            "selected": int(selected_counter.get(diagram_type, 0)),
        }

    split_ids: dict[str, list[str]] = {"train": [], "validation": [], "test": []}
    for entry in clean_entries:
        split_ids[entry.split].append(entry.sample_id)
    split_counts = {key: len(value) for key, value in split_ids.items()}
    diagram_type_counts = dict(Counter(entry.diagram_type for entry in clean_entries))

    if output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    structure_output = output_root / "structure"
    structure_output.mkdir(parents=True, exist_ok=True)
    missing_structure_ids = _copy_selected_json_files(
        source_root / "structure" / "samples",
        structure_output / "samples",
        clean_ids,
    )
    write_json(
        structure_output / "build_report.json",
        {
            "sample_count": len(clean_entries),
            "materialized_sample_count": len(clean_entries) - len(missing_structure_ids),
            "missing_sample_count": len(missing_structure_ids),
            "missing_sample_ids": missing_structure_ids[:50],
            "source_run_root": str(source_root),
            "generated_at_utc": utc_iso(),
            "materialized_selected_only": True,
        },
    )

    agent_output = output_root / "agent_cluster"
    sample_output_dir = agent_output / "sample_outputs"
    missing_agent_ids = _copy_selected_json_files(
        source_root / "agent_cluster" / "sample_outputs",
        sample_output_dir,
        clean_ids,
    )
    agent_status_counts: Counter[str] = Counter()
    diagram_type_breakdown: dict[str, Counter[str]] = {}
    examples_by_status: dict[str, list[str]] = {}
    entry_by_id = {entry.sample_id: entry for entry in clean_entries}
    for sample_id in sorted(clean_ids - set(missing_agent_ids)):
        payload = read_json(sample_output_dir / f"{sample_id}.json")
        status = str(payload.get("status") or "<missing>")
        agent_status_counts[status] += 1
        diagram_type = entry_by_id[sample_id].diagram_type
        breakdown = diagram_type_breakdown.setdefault(diagram_type, Counter())
        breakdown[status] += 1
        examples_by_status.setdefault(status, [])
        if len(examples_by_status[status]) < 5:
            examples_by_status[status].append(sample_id)
    finished_total = sum(agent_status_counts.values())
    write_json(
        agent_output / "run_report.json",
        {
            "generated_at_utc": utc_iso(),
            "sample_output_dir": str(sample_output_dir),
            "total_samples": len(clean_entries),
            "completion": {
                "completed": int(agent_status_counts.get("completed", 0)),
                "completed_with_warnings": int(agent_status_counts.get("completed_with_warnings", 0)),
                "finished_total": finished_total,
                "unfinished_total": len(clean_entries) - finished_total,
                "completion_rate_percent": round((finished_total / len(clean_entries)) * 100.0, 4)
                if clean_entries
                else None,
            },
            "normalized_status_counts": {key: int(value) for key, value in agent_status_counts.items()},
            "raw_status_counts": {key: int(value) for key, value in agent_status_counts.items()},
            "diagram_type_counts": diagram_type_counts,
            "diagram_type_breakdown": {
                key: {status: int(count) for status, count in counts.items()}
                for key, counts in diagram_type_breakdown.items()
            },
            "missing_sample_output_count": len(missing_agent_ids),
            "missing_sample_output_ids": missing_agent_ids[:50],
            "examples": examples_by_status,
            "source_run_root": str(source_root),
            "generated_from_selected_only": True,
        },
    )

    selection_output = output_root / "selection"
    selection_output.mkdir(parents=True, exist_ok=True)
    for file_name in ("all_profiles.jsonl", "all_profiles.with_bucket.jsonl"):
        source_file = source_selection / file_name
        if source_file.exists():
            shutil.copy2(source_file, selection_output / file_name)

    write_json(selection_output / "selected_sample_ids.json", {"ids": sorted(clean_ids)})
    split_dir = selection_output / "splits"
    split_dir.mkdir(parents=True, exist_ok=True)
    for split_name, ids in split_ids.items():
        write_json(split_dir / f"{split_name}_ids.json", {"ids": ids})

    clean_manifest = {
        "target_samples": len(clean_entries),
        "selected_count": len(clean_entries),
        "split_counts": split_counts,
        "diagram_type_counts": diagram_type_counts,
        "selection_stats": selection_stats,
        "selected_profiles": filtered_profiles,
        "source_run_root": str(source_root),
        "cleaning": {
            "generated_at_utc": utc_iso(),
            "source_selected_count": len(entries),
            "removed_count": len(bad_ids),
            "kept_count": len(clean_entries),
            "issue_counts": {key: int(value) for key, value in issue_counter.items()},
            "removed_by_split": {key: int(value) for key, value in split_removed_counter.items()},
            "removed_by_diagram_type": {key: int(value) for key, value in diagram_removed_counter.items()},
            "rules": [
                "drop boundary_count_mismatch",
                "drop boundary_not_exact",
                "drop duplicate_turn_ids",
            ],
            "materialization": {
                "structure_missing_count": len(missing_structure_ids),
                "agent_output_missing_count": len(missing_agent_ids),
            },
            "example_removed_samples": issue_examples,
        },
    }
    if args.require_nonempty_final_graph:
        clean_manifest["cleaning"]["rules"].append("drop empty_final_graph")
    write_json(selection_output / "selection_manifest.json", clean_manifest)
    write_json(output_root / "cleaning_manifest.json", clean_manifest["cleaning"])

    report_output.mkdir(parents=True, exist_ok=True)
    summary = {
        "generated_at_utc": utc_iso(),
        "source_run_root": str(source_root),
        "output_run_root": str(output_root),
        "source_selected_count": len(entries),
        "clean_selected_count": len(clean_entries),
        "removed_count": len(bad_ids),
        "kept_rate": round(len(clean_entries) / len(entries), 4) if entries else None,
        "issue_counts": {key: int(value) for key, value in issue_counter.items()},
        "removed_by_split": {key: int(value) for key, value in split_removed_counter.items()},
        "removed_by_diagram_type": {key: int(value) for key, value in diagram_removed_counter.items()},
        "clean_split_sizes": {key: len(value) for key, value in split_ids.items()},
        "example_removed_samples": issue_examples,
    }
    write_json(report_output / "clean_derivation.summary.json", summary)
    (report_output / "clean_derivation.summary.md").write_text(
        "\n".join(
            [
                "# Incremental Clean Derivation",
                "",
                f"- Source run root: `{source_root}`",
                f"- Output run root: `{output_root}`",
                f"- Source selected count: {len(entries)}",
                f"- Clean selected count: {len(clean_entries)}",
                f"- Removed count: {len(bad_ids)}",
                f"- Kept rate: {summary['kept_rate']}",
                "",
                "## Issue Counts",
                "",
                *[f"- `{key}`: {value}" for key, value in summary["issue_counts"].items()],
                "",
                "## Removed By Split",
                "",
                *[f"- `{key}`: {value}" for key, value in summary["removed_by_split"].items()],
                "",
                "## Removed By Diagram Type",
                "",
                *[f"- `{key}`: {value}" for key, value in summary["removed_by_diagram_type"].items()],
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"Output run root: {output_root}")
    print(f"Selection manifest: {selection_output / 'selection_manifest.json'}")
    print(f"Cleaning manifest: {output_root / 'cleaning_manifest.json'}")
    print(f"Report JSON: {report_output / 'clean_derivation.summary.json'}")


if __name__ == "__main__":
    main()
