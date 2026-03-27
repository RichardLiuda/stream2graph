from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Iterable
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "reports" / "evaluation" / "runs" / "incremental_system"
OUTPUT_ROOT = ROOT / "artifacts" / "evaluation" / "localhf_incremental_analysis"
DATA_DIR = OUTPUT_ROOT / "data"
CHART_DIR = OUTPUT_ROOT / "charts"


ABLATION_RUNS = [
    {"id": "gateft_plannerft", "label": "Gate FT + Planner FT", "gate": "FT", "planner": "FT", "dir": "incremental_localhf_qwen35_gateft_plannerft_validation_public_clean"},
    {"id": "gateft_plannerbase", "label": "Gate FT + Planner Base", "gate": "FT", "planner": "Base", "dir": "incremental_localhf_qwen35_gateft_plannerbase_validation_public_clean"},
    {"id": "gatebase_plannerft", "label": "Gate Base + Planner FT", "gate": "Base", "planner": "FT", "dir": "incremental_localhf_qwen35_gatebase_plannerft_validation_public_clean"},
    {"id": "gatebase_plannerbase", "label": "Gate Base + Planner Base", "gate": "Base", "planner": "Base", "dir": "incremental_localhf_qwen35_gatebase_plannerbase_validation_public_clean"},
]


TEST_RUNS = [
    {"id": "localhf_final_combo", "label": "LocalHF FT Combo", "dir": "incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full_public_clean"},
    {"id": "claude_sonnet45", "label": "Claude Sonnet 4.5", "dir": "incremental_claude_sonnet45_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "gemini3flash_rerun2", "label": "Gemini 3 Flash r2", "dir": "incremental_gemini3flash_google_siliconflow_qwen35_4b_gate_test_full_public_clean_rerun2_official"},
    {"id": "gpt54_gateway", "label": "GPT-5.4 gateway", "dir": "incremental_gpt54_gateway_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "minimax_m27", "label": "MiniMax M2.7", "dir": "incremental_minimax_m27_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "moonshot_k25", "label": "Moonshot K2.5", "dir": "incremental_moonshot_k25_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "qwen35plus", "label": "Qwen3.5-Plus", "dir": "incremental_qwen35plus_dashscope_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "qwen35plus_thinking_on", "label": "Qwen3.5-Plus thinking", "dir": "incremental_qwen35plus_dashscope_thinking_on_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "qwen35_27b_dashscope", "label": "Qwen3.5-27B DashScope", "dir": "incremental_qwen35_27b_dashscope_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
]


METRICS = [
    "completed_all_stages",
    "final_matches_reference",
    "canonicalized_match",
    "stage_coverage_rate",
    "node_semantic_f1",
    "group_semantic_f1",
    "edge_semantic_f1",
    "attachment_semantic_f1",
    "entity_semantic_f1",
    "updates_emitted",
    "total_stages",
    "planner_calls",
    "gate_latency_mean_ms",
    "planner_latency_mean_ms",
    "total_model_latency_ms",
]


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CHART_DIR.mkdir(parents=True, exist_ok=True)


def load_summary(run_dir: str) -> dict:
    path = RUN_ROOT / run_dir / "metrics" / "incremental_metrics.summary.json"
    return json.loads(path.read_text(encoding="utf-8"))


def metric_value(metric: dict | None) -> float | None:
    if not metric:
        return None
    if "rate" in metric:
        return float(metric["rate"])
    if "mean" in metric:
        return float(metric["mean"])
    return None


def round4(value: float) -> float:
    return round(float(value), 4)


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def read_run_overall(summary: dict) -> dict[str, float | None]:
    overall = summary["overall"]
    return {field: metric_value(overall.get(field)) for field in METRICS}


def by_diagram_type(summary: dict, field: str) -> dict[str, float | None]:
    rows = {}
    for item in summary["slices"]["by_diagram_type"]:
        rows[item["group"]] = metric_value(item["metrics"].get(field))
    return rows


def mean(values: Iterable[float]) -> float:
    items = list(values)
    return sum(items) / len(items)


def color_scale(value: float, min_value: float, max_value: float) -> str:
    if max_value <= min_value:
        ratio = 1.0
    else:
        ratio = (value - min_value) / (max_value - min_value)
    ratio = max(0.0, min(1.0, ratio))
    start = (243, 244, 246)
    end = (37, 99, 235)
    rgb = tuple(int(start[i] + (end[i] - start[i]) * ratio) for i in range(3))
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def text_color_for_fill(fill: str) -> str:
    fill = fill.lstrip("#")
    r = int(fill[0:2], 16)
    g = int(fill[2:4], 16)
    b = int(fill[4:6], 16)
    luminance = 0.299 * r + 0.587 * g + 0.114 * b
    return "#111827" if luminance > 170 else "#ffffff"


def svg_header(width: int, height: int, title: str) -> list[str]:
    return [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        f'<title>{escape(title)}</title>',
        "<style>",
        'text { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; fill: #111827; }',
        ".title { font-size: 22px; font-weight: 700; }",
        ".axis { font-size: 12px; }",
        ".label { font-size: 13px; }",
        ".small { font-size: 11px; }",
        ".legend { font-size: 12px; }",
        "</style>",
    ]


def save_svg(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


def grouped_bar_chart(
    path: Path,
    title: str,
    categories: list[str],
    series: list[tuple[str, list[float], str]],
    y_max: float | None = None,
    y_label: str = "",
) -> None:
    width = max(920, 180 + len(categories) * 170)
    height = 560
    margin_left = 90
    margin_right = 40
    margin_top = 80
    margin_bottom = 120
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom
    max_value = max(max(values) for _, values, _ in series)
    max_value = y_max if y_max is not None else max_value
    if max_value <= 0:
        max_value = 1.0
    lines = svg_header(width, height, title)
    lines.append(f'<text x="{width / 2}" y="36" text-anchor="middle" class="title">{escape(title)}</text>')
    if y_label:
        cy = margin_top + plot_h / 2
        lines.append(f'<text x="18" y="{cy}" transform="rotate(-90 18 {cy})" class="label">{escape(y_label)}</text>')
    for tick in range(6):
        value = max_value * tick / 5
        y = margin_top + plot_h - plot_h * (value / max_value)
        lines.append(f'<line x1="{margin_left}" y1="{y:.1f}" x2="{width - margin_right}" y2="{y:.1f}" stroke="#e5e7eb" stroke-width="1"/>')
        label = f"{value:.2f}" if max_value <= 2 else f"{value:.0f}"
        lines.append(f'<text x="{margin_left - 10}" y="{y + 4:.1f}" text-anchor="end" class="axis">{label}</text>')
    lines.append(f'<line x1="{margin_left}" y1="{margin_top}" x2="{margin_left}" y2="{margin_top + plot_h}" stroke="#111827" stroke-width="1.5"/>')
    lines.append(f'<line x1="{margin_left}" y1="{margin_top + plot_h}" x2="{width - margin_right}" y2="{margin_top + plot_h}" stroke="#111827" stroke-width="1.5"/>')
    group_width = plot_w / max(len(categories), 1)
    inner_width = group_width * 0.78
    bar_width = inner_width / max(len(series), 1)
    for index, category in enumerate(categories):
        group_x = margin_left + index * group_width + (group_width - inner_width) / 2
        for series_index, (_, values, color) in enumerate(series):
            value = values[index]
            bar_h = plot_h * (value / max_value)
            x = group_x + series_index * bar_width
            y = margin_top + plot_h - bar_h
            lines.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_width - 4:.1f}" height="{bar_h:.1f}" fill="{color}" rx="3"/>')
            label_text = f"{value:.3f}" if value < 10 else f"{value:.1f}"
            lines.append(f'<text x="{x + (bar_width - 4) / 2:.1f}" y="{max(y - 6, margin_top + 12):.1f}" text-anchor="middle" class="small">{label_text}</text>')
        cx = group_x + inner_width / 2
        lines.append(f'<text x="{cx:.1f}" y="{height - 60}" text-anchor="middle" class="label">{escape(category)}</text>')
    legend_x = margin_left
    legend_y = height - 30
    for label, _, color in series:
        lines.append(f'<rect x="{legend_x}" y="{legend_y - 10}" width="14" height="14" fill="{color}" rx="2"/>')
        lines.append(f'<text x="{legend_x + 22}" y="{legend_y + 1}" class="legend">{escape(label)}</text>')
        legend_x += 180
    save_svg(path, lines)


def signed_bar_chart(
    path: Path,
    title: str,
    categories: list[str],
    left_values: list[float],
    right_values: list[float],
    left_label: str,
    right_label: str,
    colors: tuple[str, str],
    x_label: str,
) -> None:
    width = 980
    height = 520
    margin_left = 220
    margin_right = 80
    margin_top = 80
    margin_bottom = 70
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom
    max_abs = max(abs(v) for v in left_values + right_values)
    if max_abs == 0:
        max_abs = 1.0
    zero_x = margin_left + plot_w / 2
    row_h = plot_h / len(categories)
    lines = svg_header(width, height, title)
    lines.append(f'<text x="{width / 2}" y="36" text-anchor="middle" class="title">{escape(title)}</text>')
    lines.append(f'<text x="{width / 2}" y="{height - 18}" text-anchor="middle" class="label">{escape(x_label)}</text>')
    for tick in range(-4, 5):
        value = max_abs * tick / 4
        x = zero_x + (plot_w / 2) * (value / max_abs)
        lines.append(f'<line x1="{x:.1f}" y1="{margin_top}" x2="{x:.1f}" y2="{margin_top + plot_h}" stroke="#e5e7eb" stroke-width="1"/>')
        if tick != 0:
            lines.append(f'<text x="{x:.1f}" y="{margin_top - 10}" text-anchor="middle" class="axis">{value:.2f}</text>')
    lines.append(f'<line x1="{zero_x:.1f}" y1="{margin_top}" x2="{zero_x:.1f}" y2="{margin_top + plot_h}" stroke="#111827" stroke-width="1.5"/>')
    for idx, category in enumerate(categories):
        y = margin_top + idx * row_h + row_h * 0.25
        h = row_h * 0.5
        lv = left_values[idx]
        rv = right_values[idx]
        left_w = (plot_w / 2) * abs(lv) / max_abs
        right_w = (plot_w / 2) * abs(rv) / max_abs
        lines.append(f'<text x="{margin_left - 12}" y="{y + h / 2 + 4:.1f}" text-anchor="end" class="label">{escape(category)}</text>')
        lines.append(f'<rect x="{zero_x - left_w:.1f}" y="{y:.1f}" width="{left_w:.1f}" height="{h:.1f}" fill="{colors[0]}" rx="3"/>')
        lines.append(f'<rect x="{zero_x:.1f}" y="{y:.1f}" width="{right_w:.1f}" height="{h:.1f}" fill="{colors[1]}" rx="3"/>')
        lines.append(f'<text x="{zero_x - left_w - 6:.1f}" y="{y + h / 2 + 4:.1f}" text-anchor="end" class="small">{lv:.4f}</text>')
        lines.append(f'<text x="{zero_x + right_w + 6:.1f}" y="{y + h / 2 + 4:.1f}" text-anchor="start" class="small">{rv:.4f}</text>')
    legend_y = height - 34
    lines.append(f'<rect x="{margin_left}" y="{legend_y - 12}" width="14" height="14" fill="{colors[0]}" rx="2"/>')
    lines.append(f'<text x="{margin_left + 22}" y="{legend_y}" class="legend">{escape(left_label)}</text>')
    lines.append(f'<rect x="{margin_left + 220}" y="{legend_y - 12}" width="14" height="14" fill="{colors[1]}" rx="2"/>')
    lines.append(f'<text x="{margin_left + 242}" y="{legend_y}" class="legend">{escape(right_label)}</text>')
    save_svg(path, lines)


def heatmap_chart(
    path: Path,
    title: str,
    rows: list[str],
    cols: list[str],
    values: list[list[float]],
    min_value: float | None = None,
    max_value: float | None = None,
) -> None:
    cell_w = 120
    cell_h = 48
    margin_left = 210
    margin_top = 90
    margin_right = 40
    margin_bottom = 60
    width = margin_left + len(cols) * cell_w + margin_right
    height = margin_top + len(rows) * cell_h + margin_bottom
    flat = [item for row in values for item in row]
    lo = min_value if min_value is not None else min(flat)
    hi = max_value if max_value is not None else max(flat)
    lines = svg_header(width, height, title)
    lines.append(f'<text x="{width / 2}" y="36" text-anchor="middle" class="title">{escape(title)}</text>')
    for col_idx, col in enumerate(cols):
        x = margin_left + col_idx * cell_w + cell_w / 2
        lines.append(f'<text x="{x:.1f}" y="{margin_top - 20}" text-anchor="middle" class="label">{escape(col)}</text>')
    for row_idx, row in enumerate(rows):
        y = margin_top + row_idx * cell_h + cell_h / 2 + 5
        lines.append(f'<text x="{margin_left - 12}" y="{y:.1f}" text-anchor="end" class="label">{escape(row)}</text>')
        for col_idx, value in enumerate(values[row_idx]):
            x = margin_left + col_idx * cell_w
            y0 = margin_top + row_idx * cell_h
            fill = color_scale(value, lo, hi)
            text_fill = text_color_for_fill(fill)
            lines.append(f'<rect x="{x}" y="{y0}" width="{cell_w - 2}" height="{cell_h - 2}" fill="{fill}" rx="4"/>')
            lines.append(f'<text x="{x + cell_w / 2 - 1:.1f}" y="{y0 + cell_h / 2 + 5:.1f}" text-anchor="middle" class="small" style="fill:{text_fill}">{value:.4f}</text>')
    save_svg(path, lines)


def scatter_chart(
    path: Path,
    title: str,
    points: list[dict],
    x_key: str,
    y_key: str,
    x_label: str,
    y_label: str,
    highlight_id: str,
) -> None:
    width = 980
    height = 620
    margin_left = 90
    margin_right = 40
    margin_top = 80
    margin_bottom = 80
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom
    x_values = [p[x_key] for p in points]
    y_values = [p[y_key] for p in points]
    min_x, max_x = min(x_values), max(x_values)
    min_y, max_y = min(y_values), max(y_values)
    x_pad = max((max_x - min_x) * 0.08, 1.0)
    y_pad = max((max_y - min_y) * 0.08, 0.01)
    min_x -= x_pad
    max_x += x_pad
    min_y -= y_pad
    max_y += y_pad

    def sx(value: float) -> float:
        return margin_left + plot_w * (value - min_x) / (max_x - min_x)

    def sy(value: float) -> float:
        return margin_top + plot_h - plot_h * (value - min_y) / (max_y - min_y)

    lines = svg_header(width, height, title)
    lines.append(f'<text x="{width / 2}" y="36" text-anchor="middle" class="title">{escape(title)}</text>')
    lines.append(f'<text x="{width / 2}" y="{height - 22}" text-anchor="middle" class="label">{escape(x_label)}</text>')
    lines.append(f'<text x="24" y="{height / 2}" transform="rotate(-90 24 {height / 2})" class="label">{escape(y_label)}</text>')
    for tick in range(6):
        xv = min_x + (max_x - min_x) * tick / 5
        x = sx(xv)
        lines.append(f'<line x1="{x:.1f}" y1="{margin_top}" x2="{x:.1f}" y2="{margin_top + plot_h}" stroke="#e5e7eb" stroke-width="1"/>')
        lines.append(f'<text x="{x:.1f}" y="{margin_top + plot_h + 24}" text-anchor="middle" class="axis">{xv:.1f}</text>')
        yv = min_y + (max_y - min_y) * tick / 5
        y = sy(yv)
        lines.append(f'<line x1="{margin_left}" y1="{y:.1f}" x2="{margin_left + plot_w}" y2="{y:.1f}" stroke="#e5e7eb" stroke-width="1"/>')
        lines.append(f'<text x="{margin_left - 10}" y="{y + 4:.1f}" text-anchor="end" class="axis">{yv:.3f}</text>')
    lines.append(f'<rect x="{margin_left}" y="{margin_top}" width="{plot_w}" height="{plot_h}" fill="none" stroke="#111827" stroke-width="1.5"/>')
    for point in points:
        x = sx(point[x_key])
        y = sy(point[y_key])
        is_highlight = point["id"] == highlight_id
        fill = "#dc2626" if is_highlight else "#2563eb"
        radius = 7 if is_highlight else 5
        lines.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius}" fill="{fill}" opacity="0.9"/>')
        lines.append(f'<text x="{x + 8:.1f}" y="{y - 8:.1f}" class="small">{escape(point["label"])}</text>')
    save_svg(path, lines)


def horizontal_bar_chart(
    path: Path,
    title: str,
    labels: list[str],
    values: list[float],
    bar_color: str,
    x_label: str,
) -> None:
    width = 980
    height = max(420, 120 + len(labels) * 42)
    margin_left = 260
    margin_right = 60
    margin_top = 80
    margin_bottom = 70
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom
    max_value = max(values)
    if max_value <= 0:
        max_value = 1.0
    lines = svg_header(width, height, title)
    lines.append(f'<text x="{width / 2}" y="36" text-anchor="middle" class="title">{escape(title)}</text>')
    lines.append(f'<text x="{width / 2}" y="{height - 22}" text-anchor="middle" class="label">{escape(x_label)}</text>')
    for tick in range(6):
        value = max_value * tick / 5
        x = margin_left + plot_w * value / max_value
        lines.append(f'<line x1="{x:.1f}" y1="{margin_top}" x2="{x:.1f}" y2="{margin_top + plot_h}" stroke="#e5e7eb" stroke-width="1"/>')
        lines.append(f'<text x="{x:.1f}" y="{margin_top + plot_h + 24}" text-anchor="middle" class="axis">{value:.3f}</text>')
    row_h = plot_h / len(labels)
    for idx, label in enumerate(labels):
        y = margin_top + idx * row_h + row_h * 0.2
        h = row_h * 0.6
        value = values[idx]
        w = plot_w * value / max_value
        lines.append(f'<text x="{margin_left - 12}" y="{y + h / 2 + 4:.1f}" text-anchor="end" class="label">{escape(label)}</text>')
        lines.append(f'<rect x="{margin_left}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{bar_color}" rx="3"/>')
        lines.append(f'<text x="{margin_left + w + 8:.1f}" y="{y + h / 2 + 4:.1f}" class="small">{value:.4f}</text>')
    lines.append(f'<rect x="{margin_left}" y="{margin_top}" width="{plot_w}" height="{plot_h}" fill="none" stroke="#111827" stroke-width="1.5"/>')
    save_svg(path, lines)


def build_ablation_assets() -> tuple[list[dict], list[dict]]:
    summaries: dict[str, dict] = {}
    rows: list[dict] = []
    for run in ABLATION_RUNS:
        summary = load_summary(run["dir"])
        summaries[run["id"]] = summary
        overall = read_run_overall(summary)
        rows.append({"setting": run["id"], "label": run["label"], "gate": run["gate"], "planner": run["planner"], "sample_count": int(summary["sample_count"]), **{k: round4(v) if v is not None else None for k, v in overall.items()}})
    write_csv(DATA_DIR / "ablation_overall.csv", rows, list(rows[0].keys()))

    count_rows = []
    for row in rows:
        count_rows.append(
            {
                "setting": row["setting"],
                "label": row["label"],
                "sample_count": row["sample_count"],
                "final_match_count_est": round(row["sample_count"] * row["final_matches_reference"], 2),
                "canonicalized_count_est": round(row["sample_count"] * row["canonicalized_match"], 2),
            }
        )
    write_csv(DATA_DIR / "ablation_count_estimates.csv", count_rows, list(count_rows[0].keys()))

    planner_ft = [row for row in rows if row["planner"] == "FT"]
    planner_base = [row for row in rows if row["planner"] == "Base"]
    gate_ft = [row for row in rows if row["gate"] == "FT"]
    gate_base = [row for row in rows if row["gate"] == "Base"]
    main_effects: list[dict] = []
    for field in ["completed_all_stages", "final_matches_reference", "canonicalized_match", "stage_coverage_rate", "entity_semantic_f1", "gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"]:
        planner_effect = mean(r[field] for r in planner_ft) - mean(r[field] for r in planner_base)
        gate_effect = mean(r[field] for r in gate_ft) - mean(r[field] for r in gate_base)
        main_effects.append({"metric": field, "planner_ft_minus_base": round4(planner_effect), "gate_ft_minus_base": round4(gate_effect)})
    write_csv(DATA_DIR / "ablation_main_effects.csv", main_effects, list(main_effects[0].keys()))

    diagram_types = sorted(by_diagram_type(summaries[ABLATION_RUNS[0]["id"]], "final_matches_reference").keys())
    final_match_rows: list[dict] = []
    entity_rows: list[dict] = []
    planner_latency_rows: list[dict] = []
    for dt in diagram_types:
        row_final = {"diagram_type": dt}
        row_entity = {"diagram_type": dt}
        row_planner = {"diagram_type": dt}
        for run in ABLATION_RUNS:
            row_final[run["id"]] = round4(by_diagram_type(summaries[run["id"]], "final_matches_reference")[dt])
            row_entity[run["id"]] = round4(by_diagram_type(summaries[run["id"]], "entity_semantic_f1")[dt])
            row_planner[run["id"]] = round4(by_diagram_type(summaries[run["id"]], "planner_latency_mean_ms")[dt] / 1000.0)
        final_match_rows.append(row_final)
        entity_rows.append(row_entity)
        planner_latency_rows.append(row_planner)
    write_csv(DATA_DIR / "ablation_by_type_final_match.csv", final_match_rows, list(final_match_rows[0].keys()))
    write_csv(DATA_DIR / "ablation_by_type_entity_f1.csv", entity_rows, list(entity_rows[0].keys()))
    write_csv(DATA_DIR / "ablation_by_type_planner_latency_sec.csv", planner_latency_rows, list(planner_latency_rows[0].keys()))

    categories = [run["label"] for run in ABLATION_RUNS]
    grouped_bar_chart(CHART_DIR / "ablation_quality_overall.svg", "Ablation Overall Quality", categories, [("Final match", [r["final_matches_reference"] for r in rows], "#2563eb"), ("Canonicalized", [r["canonicalized_match"] for r in rows], "#0f766e"), ("Entity F1", [r["entity_semantic_f1"] for r in rows], "#dc2626")], y_max=0.5, y_label="score")
    grouped_bar_chart(CHART_DIR / "ablation_latency_overall_sec.svg", "Ablation Overall Latency (sec)", categories, [("Gate", [r["gate_latency_mean_ms"] / 1000.0 for r in rows], "#2563eb"), ("Planner", [r["planner_latency_mean_ms"] / 1000.0 for r in rows], "#f59e0b"), ("Total", [r["total_model_latency_ms"] / 1000.0 for r in rows], "#dc2626")], y_label="seconds")
    signed_bar_chart(CHART_DIR / "ablation_main_effects_quality.svg", "Ablation Main Effects on Quality", ["Completed", "Final match", "Canonicalized", "Coverage", "Entity F1"], [next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "completed_all_stages"), next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "final_matches_reference"), next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "canonicalized_match"), next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "stage_coverage_rate"), next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "entity_semantic_f1")], [next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "completed_all_stages"), next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "final_matches_reference"), next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "canonicalized_match"), next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "stage_coverage_rate"), next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "entity_semantic_f1")], "Planner FT - Base", "Gate FT - Base", ("#2563eb", "#dc2626"), "delta")
    signed_bar_chart(CHART_DIR / "ablation_main_effects_latency_sec.svg", "Ablation Main Effects on Latency (sec)", ["Gate latency", "Planner latency", "Total latency"], [next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "gate_latency_mean_ms") / 1000.0, next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "planner_latency_mean_ms") / 1000.0, next(item["planner_ft_minus_base"] for item in main_effects if item["metric"] == "total_model_latency_ms") / 1000.0], [next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "gate_latency_mean_ms") / 1000.0, next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "planner_latency_mean_ms") / 1000.0, next(item["gate_ft_minus_base"] for item in main_effects if item["metric"] == "total_model_latency_ms") / 1000.0], "Planner FT - Base", "Gate FT - Base", ("#2563eb", "#dc2626"), "delta (seconds)")
    heatmap_chart(CHART_DIR / "ablation_by_type_final_match_heatmap.svg", "Ablation by Diagram Type: Final Match", diagram_types, [run["label"] for run in ABLATION_RUNS], [[row[run["id"]] for run in ABLATION_RUNS] for row in final_match_rows], min_value=0.0, max_value=max(max(row[run["id"]] for run in ABLATION_RUNS) for row in final_match_rows))
    heatmap_chart(CHART_DIR / "ablation_by_type_entity_f1_heatmap.svg", "Ablation by Diagram Type: Entity F1", diagram_types, [run["label"] for run in ABLATION_RUNS], [[row[run["id"]] for run in ABLATION_RUNS] for row in entity_rows], min_value=0.15, max_value=max(max(row[run["id"]] for run in ABLATION_RUNS) for row in entity_rows))
    heatmap_chart(CHART_DIR / "ablation_by_type_planner_latency_sec_heatmap.svg", "Ablation by Diagram Type: Planner Latency (sec)", diagram_types, [run["label"] for run in ABLATION_RUNS], [[row[run["id"]] for run in ABLATION_RUNS] for row in planner_latency_rows])
    return rows, main_effects


def build_test_assets() -> list[dict]:
    rows: list[dict] = []
    summaries: dict[str, dict] = {}
    for run in TEST_RUNS:
        summary = load_summary(run["dir"])
        summaries[run["id"]] = summary
        overall = read_run_overall(summary)
        rows.append({"model": run["label"], "id": run["id"], "sample_count": int(summary["sample_count"]), **{k: round4(v) if v is not None else None for k, v in overall.items()}})
    write_csv(DATA_DIR / "test_overall.csv", rows, list(rows[0].keys()))

    rankings: list[dict] = []
    for metric in ["final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1", "attachment_semantic_f1", "gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"]:
        reverse = not metric.endswith("_ms")
        sorted_rows = sorted(rows, key=lambda item: item[metric], reverse=reverse)
        for rank, row in enumerate(sorted_rows, start=1):
            rankings.append({"metric": metric, "rank": rank, "model": row["model"], "value": row[metric]})
    write_csv(DATA_DIR / "test_rankings.csv", rankings, list(rankings[0].keys()))

    localhf = next(row for row in rows if row["id"] == "localhf_final_combo")
    gain_rows: list[dict] = []
    for metric in ["final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1", "attachment_semantic_f1"]:
        baseline_rows = [row for row in rows if row["id"] != "localhf_final_combo"]
        best_baseline = max(baseline_rows, key=lambda item: item[metric])
        abs_gain = localhf[metric] - best_baseline[metric]
        rel_gain = abs_gain / best_baseline[metric] * 100 if best_baseline[metric] else None
        gain_rows.append(
            {
                "metric": metric,
                "localhf_value": localhf[metric],
                "best_baseline_model": best_baseline["model"],
                "best_baseline_value": best_baseline[metric],
                "absolute_gain": round4(abs_gain),
                "relative_gain_pct": round4(rel_gain) if rel_gain is not None else None,
            }
        )
    write_csv(DATA_DIR / "test_gain_vs_best_baseline.csv", gain_rows, list(gain_rows[0].keys()))

    frontier_rows = []
    sorted_by_latency = sorted(rows, key=lambda item: item["total_model_latency_ms"])
    best_exact = -1.0
    for row in sorted_by_latency:
        is_pareto = row["final_matches_reference"] > best_exact
        frontier_rows.append(
            {
                "model": row["model"],
                "total_model_latency_ms": row["total_model_latency_ms"],
                "final_matches_reference": row["final_matches_reference"],
                "entity_semantic_f1": row["entity_semantic_f1"],
                "pareto_exact_latency": is_pareto,
            }
        )
        if row["final_matches_reference"] > best_exact:
            best_exact = row["final_matches_reference"]
    write_csv(DATA_DIR / "test_pareto_frontier.csv", frontier_rows, list(frontier_rows[0].keys()))

    diagram_types = sorted(by_diagram_type(summaries[TEST_RUNS[0]["id"]], "final_matches_reference").keys())
    by_type_final_rows: list[dict] = []
    by_type_entity_rows: list[dict] = []
    for dt in diagram_types:
        row_final = {"diagram_type": dt}
        row_entity = {"diagram_type": dt}
        for run in TEST_RUNS:
            row_final[run["id"]] = round4(by_diagram_type(summaries[run["id"]], "final_matches_reference")[dt])
            row_entity[run["id"]] = round4(by_diagram_type(summaries[run["id"]], "entity_semantic_f1")[dt])
        by_type_final_rows.append(row_final)
        by_type_entity_rows.append(row_entity)
    write_csv(DATA_DIR / "test_by_type_final_match.csv", by_type_final_rows, list(by_type_final_rows[0].keys()))
    write_csv(DATA_DIR / "test_by_type_entity_f1.csv", by_type_entity_rows, list(by_type_entity_rows[0].keys()))

    sorted_exact = sorted(rows, key=lambda item: item["final_matches_reference"], reverse=True)
    horizontal_bar_chart(CHART_DIR / "test_final_match_rank.svg", "Full Test: Final Match Ranking", [row["model"] for row in sorted_exact], [row["final_matches_reference"] for row in sorted_exact], "#2563eb", "final match rate")
    sorted_entity = sorted(rows, key=lambda item: item["entity_semantic_f1"], reverse=True)
    horizontal_bar_chart(CHART_DIR / "test_entity_f1_rank.svg", "Full Test: Entity F1 Ranking", [row["model"] for row in sorted_entity], [row["entity_semantic_f1"] for row in sorted_entity], "#dc2626", "entity semantic F1")
    grouped_bar_chart(CHART_DIR / "test_topline_quality.svg", "Full Test Topline Quality", [row["model"] for row in rows], [("Final match", [row["final_matches_reference"] for row in rows], "#2563eb"), ("Canonicalized", [row["canonicalized_match"] for row in rows], "#0f766e"), ("Entity F1", [row["entity_semantic_f1"] for row in rows], "#dc2626")], y_max=0.5, y_label="score")
    grouped_bar_chart(CHART_DIR / "test_topline_latency_sec.svg", "Full Test Topline Latency (sec)", [row["model"] for row in rows], [("Gate", [row["gate_latency_mean_ms"] / 1000.0 for row in rows], "#2563eb"), ("Planner", [row["planner_latency_mean_ms"] / 1000.0 for row in rows], "#f59e0b"), ("Total", [row["total_model_latency_ms"] / 1000.0 for row in rows], "#dc2626")], y_label="seconds")
    scatter_points = [{"id": row["id"], "label": row["model"], "total_sec": row["total_model_latency_ms"] / 1000.0, "final_match": row["final_matches_reference"], "entity_f1": row["entity_semantic_f1"]} for row in rows]
    scatter_chart(CHART_DIR / "test_quality_latency_scatter_final_match.svg", "Full Test: Final Match vs Total Latency", scatter_points, "total_sec", "final_match", "total latency (sec)", "final match rate", "localhf_final_combo")
    scatter_chart(CHART_DIR / "test_quality_latency_scatter_entity_f1.svg", "Full Test: Entity F1 vs Total Latency", scatter_points, "total_sec", "entity_f1", "total latency (sec)", "entity semantic F1", "localhf_final_combo")
    heatmap_chart(CHART_DIR / "test_by_type_final_match_heatmap.svg", "Full Test by Diagram Type: Final Match", diagram_types, [run["label"] for run in TEST_RUNS], [[row[run["id"]] for run in TEST_RUNS] for row in by_type_final_rows], min_value=0.0, max_value=max(max(row[run["id"]] for run in TEST_RUNS) for row in by_type_final_rows))
    heatmap_chart(CHART_DIR / "test_by_type_entity_f1_heatmap.svg", "Full Test by Diagram Type: Entity F1", diagram_types, [run["label"] for run in TEST_RUNS], [[row[run["id"]] for run in TEST_RUNS] for row in by_type_entity_rows], min_value=0.15, max_value=max(max(row[run["id"]] for run in TEST_RUNS) for row in by_type_entity_rows))
    return rows


def write_manifest(ablation_rows: list[dict], main_effects: list[dict], test_rows: list[dict]) -> None:
    payload = {"ablation_overall": ablation_rows, "ablation_main_effects": main_effects, "test_overall": test_rows, "generated_files": {"data_dir": str(DATA_DIR.relative_to(ROOT)), "chart_dir": str(CHART_DIR.relative_to(ROOT))}}
    (OUTPUT_ROOT / "analysis_manifest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    ensure_dirs()
    ablation_rows, main_effects = build_ablation_assets()
    test_rows = build_test_assets()
    write_manifest(ablation_rows, main_effects, test_rows)
    print(f"Data written to: {DATA_DIR}")
    print(f"Charts written to: {CHART_DIR}")


if __name__ == "__main__":
    main()
