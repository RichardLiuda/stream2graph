from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterable, Optional

from tools.eval.common import ensure_parent


BOOL_FIELDS = {
    "normalized_exact_match",
    "diagram_type_match",
    "compile_success",
    "realtime_eval_pass",
    "parse_valid",
    "completed_all_stages",
    "final_matches_reference",
    "exact_update_count_match",
}


def dialogue_turn_bucket(turns: int) -> str:
    if turns <= 8:
        return "<=8"
    if turns <= 20:
        return "9-20"
    if turns <= 40:
        return "21-40"
    return ">40"


def code_line_bucket(lines: int) -> str:
    if lines <= 20:
        return "<=20"
    if lines <= 50:
        return "21-50"
    if lines <= 100:
        return "51-100"
    return ">100"


def summarize_numeric(values: Iterable[float | int | None]) -> Optional[dict]:
    arr = [float(v) for v in values if v is not None]
    if not arr:
        return None
    ordered = sorted(arr)
    p50 = ordered[int(round((len(ordered) - 1) * 0.50))]
    p95 = ordered[int(round((len(ordered) - 1) * 0.95))]
    return {
        "count": len(arr),
        "mean": round(sum(arr) / len(arr), 4),
        "p50": round(float(p50), 4),
        "p95": round(float(p95), 4),
        "max": round(float(max(arr)), 4),
        "min": round(float(min(arr)), 4),
    }


def summarize_bool(values: Iterable[bool | None]) -> Optional[dict]:
    arr = [bool(v) for v in values if v is not None]
    if not arr:
        return None
    success = sum(1 for v in arr if v)
    return {
        "count": len(arr),
        "rate": round(success / len(arr), 4),
    }


def aggregate_rows(rows: list[dict], metric_fields: list[str]) -> dict:
    payload: dict[str, dict | None] = {}
    for field in metric_fields:
        if field in BOOL_FIELDS:
            payload[field] = summarize_bool(row.get(field) for row in rows)
        else:
            payload[field] = summarize_numeric(row.get(field) for row in rows)
    return payload


def group_rows(rows: list[dict], key: str, metric_fields: list[str]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        group_value = str(row.get(key, "unknown"))
        groups.setdefault(group_value, []).append(row)

    items: list[dict] = []
    for group_value in sorted(groups.keys()):
        group_rows_value = groups[group_value]
        summary = aggregate_rows(group_rows_value, metric_fields)
        items.append(
            {
                "group": group_value,
                "count": len(group_rows_value),
                "metrics": summary,
            }
        )
    return items


def top_failure_examples(rows: list[dict], score_field: str, limit: int = 20) -> list[dict]:
    ranked = sorted(rows, key=lambda row: (row.get(score_field) is None, row.get(score_field, 0.0)))
    return ranked[:limit]


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    ensure_parent(path)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def markdown_table(rows: list[dict], columns: list[tuple[str, str]]) -> str:
    if not rows:
        return "_No rows_\n"
    header = "| " + " | ".join(title for title, _ in columns) + " |"
    sep = "| " + " | ".join("---" for _ in columns) + " |"
    body = []
    for row in rows:
        body.append("| " + " | ".join(str(row.get(key, "")) for _, key in columns) + " |")
    return "\n".join([header, sep, *body]) + "\n"
