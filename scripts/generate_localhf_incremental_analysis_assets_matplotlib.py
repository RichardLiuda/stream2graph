from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from matplotlib import font_manager


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "reports" / "evaluation" / "runs" / "incremental_system"
OUTPUT_ROOT = ROOT / "artifacts" / "evaluation" / "localhf_incremental_analysis"
DATA_DIR = OUTPUT_ROOT / "data"
CHART_DIR = OUTPUT_ROOT / "charts"


ABLATION_RUNS = [
    {"id": "gateft_plannerft", "标签": "小模型微调 + 大模型微调", "Gate": "微调", "Planner": "微调", "dir": "incremental_localhf_qwen35_gateft_plannerft_validation_public_clean"},
    {"id": "gateft_plannerbase", "标签": "小模型微调 + 大模型基座", "Gate": "微调", "Planner": "基座", "dir": "incremental_localhf_qwen35_gateft_plannerbase_validation_public_clean"},
    {"id": "gatebase_plannerft", "标签": "小模型基座 + 大模型微调", "Gate": "基座", "Planner": "微调", "dir": "incremental_localhf_qwen35_gatebase_plannerft_validation_public_clean"},
    {"id": "gatebase_plannerbase", "标签": "小模型基座 + 大模型基座", "Gate": "基座", "Planner": "基座", "dir": "incremental_localhf_qwen35_gatebase_plannerbase_validation_public_clean"},
]

TEST_RUNS = [
    {"id": "localhf_final_combo", "模型": "LocalHF 最终组合", "dir": "incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full_public_clean"},
    {"id": "claude_sonnet45", "模型": "Claude Sonnet 4.5", "dir": "incremental_claude_sonnet45_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "gemini3flash_rerun2", "模型": "Gemini 3 Flash r2", "dir": "incremental_gemini3flash_google_siliconflow_qwen35_4b_gate_test_full_public_clean_rerun2_official"},
    {"id": "gpt54_gateway", "模型": "GPT-5.4 gateway", "dir": "incremental_gpt54_gateway_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "minimax_m27", "模型": "MiniMax M2.7", "dir": "incremental_minimax_m27_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "moonshot_k25", "模型": "Moonshot K2.5", "dir": "incremental_moonshot_k25_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "qwen35plus", "模型": "Qwen3.5-Plus", "dir": "incremental_qwen35plus_dashscope_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "qwen35plus_thinking_on", "模型": "Qwen3.5-Plus Thinking", "dir": "incremental_qwen35plus_dashscope_thinking_on_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
    {"id": "qwen35_27b_dashscope", "模型": "Qwen3.5-27B DashScope", "dir": "incremental_qwen35_27b_dashscope_siliconflow_qwen35_4b_gate_test_full_public_clean_official"},
]

OVERALL_METRICS = [
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

QUALITY_LABELS = {
    "final_matches_reference": "严格最终匹配率",
    "canonicalized_match": "规范化匹配率",
    "entity_semantic_f1": "实体语义 F1",
    "node_semantic_f1": "节点语义 F1",
    "group_semantic_f1": "分组语义 F1",
    "attachment_semantic_f1": "挂载语义 F1",
}

LATENCY_LABELS = {
    "gate_latency_mean_ms": "Gate 平均时延",
    "planner_latency_mean_ms": "Planner 平均时延",
    "total_model_latency_ms": "总模型时延",
}


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CHART_DIR.mkdir(parents=True, exist_ok=True)


def setup_style() -> None:
    available_fonts = {f.name for f in font_manager.fontManager.ttflist}
    preferred = ["Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC", "Arial Unicode MS"]
    selected = [f for f in preferred if f in available_fonts]
    sns.set_theme(style="whitegrid", context="talk")
    primary_font = selected[0] if selected else "DejaVu Sans"
    plt.rcParams.update(
        {
            "font.family": primary_font,
            "font.sans-serif": selected + ["DejaVu Sans"],
            "axes.unicode_minus": False,
            "figure.facecolor": "white",
            "axes.facecolor": "#fbfbfd",
            "savefig.facecolor": "white",
            "svg.fonttype": "none",
        }
    )


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


def overall_row(summary: dict) -> dict[str, float | None]:
    overall = summary["overall"]
    return {metric: metric_value(overall.get(metric)) for metric in OVERALL_METRICS}


def by_diagram(summary: dict, metric_name: str) -> dict[str, float | None]:
    rows = {}
    for item in summary["slices"]["by_diagram_type"]:
        rows[item["group"]] = metric_value(item["metrics"].get(metric_name))
    return rows


def save_csv(df: pd.DataFrame, name: str) -> None:
    df.to_csv(DATA_DIR / name, index=False, encoding="utf-8-sig")


def save_fig(fig: plt.Figure, name: str) -> None:
    fig.savefig(CHART_DIR / f"{name}.svg", bbox_inches="tight")
    fig.savefig(CHART_DIR / f"{name}.png", dpi=220, bbox_inches="tight")
    plt.close(fig)


def build_ablation_data() -> dict[str, pd.DataFrame]:
    summaries = {}
    overall_rows = []
    by_type_final = []
    by_type_entity = []
    by_type_latency = []
    for run in ABLATION_RUNS:
        summary = load_summary(run["dir"])
        summaries[run["id"]] = summary
        row = {"setting": run["id"], **{k: v for k, v in run.items() if k not in {"id", "dir"}}, "sample_count": int(summary["sample_count"]), **overall_row(summary)}
        overall_rows.append(row)
    overall_df = pd.DataFrame(overall_rows)
    overall_df["final_match_count_est"] = (overall_df["sample_count"] * overall_df["final_matches_reference"]).round(2)
    overall_df["canonicalized_count_est"] = (overall_df["sample_count"] * overall_df["canonicalized_match"]).round(2)
    save_csv(overall_df, "ablation_overall.csv")
    save_csv(overall_df[["setting", "标签", "sample_count", "final_match_count_est", "canonicalized_count_est"]], "ablation_count_estimates.csv")

    effect_records = []
    planner_ft = overall_df[overall_df["Planner"] == "微调"]
    planner_base = overall_df[overall_df["Planner"] == "基座"]
    gate_ft = overall_df[overall_df["Gate"] == "微调"]
    gate_base = overall_df[overall_df["Gate"] == "基座"]
    for metric in ["completed_all_stages", "final_matches_reference", "canonicalized_match", "stage_coverage_rate", "entity_semantic_f1", "gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"]:
        effect_records.append({
            "metric": metric,
            "planner_ft_minus_base": round(float(planner_ft[metric].mean() - planner_base[metric].mean()), 4),
            "gate_ft_minus_base": round(float(gate_ft[metric].mean() - gate_base[metric].mean()), 4),
        })
    effect_df = pd.DataFrame(effect_records)
    save_csv(effect_df, "ablation_main_effects.csv")

    diagram_types = sorted(by_diagram(summaries[ABLATION_RUNS[0]["id"]], "final_matches_reference").keys())
    for diagram in diagram_types:
        row_f = {"diagram_type": diagram}
        row_e = {"diagram_type": diagram}
        row_l = {"diagram_type": diagram}
        for run in ABLATION_RUNS:
            row_f[run["id"]] = by_diagram(summaries[run["id"]], "final_matches_reference")[diagram]
            row_e[run["id"]] = by_diagram(summaries[run["id"]], "entity_semantic_f1")[diagram]
            row_l[run["id"]] = by_diagram(summaries[run["id"]], "planner_latency_mean_ms")[diagram] / 1000.0
        by_type_final.append(row_f)
        by_type_entity.append(row_e)
        by_type_latency.append(row_l)
    final_df = pd.DataFrame(by_type_final)
    entity_df = pd.DataFrame(by_type_entity)
    latency_df = pd.DataFrame(by_type_latency)
    save_csv(final_df, "ablation_by_type_final_match.csv")
    save_csv(entity_df, "ablation_by_type_entity_f1.csv")
    save_csv(latency_df, "ablation_by_type_planner_latency_sec.csv")

    long_quality = overall_df.melt(id_vars=["setting", "标签", "Gate", "Planner"], value_vars=["final_matches_reference", "canonicalized_match", "entity_semantic_f1"], var_name="metric", value_name="value")
    long_quality["指标"] = long_quality["metric"].map({
        "final_matches_reference": "严格最终匹配率",
        "canonicalized_match": "规范化匹配率",
        "entity_semantic_f1": "实体语义 F1",
    })
    save_csv(long_quality, "ablation_long_quality.csv")

    long_latency = overall_df.melt(id_vars=["setting", "标签", "Gate", "Planner"], value_vars=["gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"], var_name="metric", value_name="value_ms")
    long_latency["value_sec"] = long_latency["value_ms"] / 1000.0
    long_latency["指标"] = long_latency["metric"].map({
        "gate_latency_mean_ms": "Gate 平均时延",
        "planner_latency_mean_ms": "Planner 平均时延",
        "total_model_latency_ms": "总模型时延",
    })
    save_csv(long_latency, "ablation_long_latency.csv")

    return {
        "overall": overall_df,
        "effects": effect_df,
        "by_type_final": final_df,
        "by_type_entity": entity_df,
        "by_type_latency": latency_df,
        "long_quality": long_quality,
        "long_latency": long_latency,
    }


def build_test_data() -> dict[str, pd.DataFrame]:
    summaries = {}
    rows = []
    for run in TEST_RUNS:
        summary = load_summary(run["dir"])
        summaries[run["id"]] = summary
        rows.append({"id": run["id"], "模型": run["模型"], "sample_count": int(summary["sample_count"]), **overall_row(summary)})
    overall_df = pd.DataFrame(rows)
    save_csv(overall_df, "test_overall.csv")

    ranking_rows = []
    for metric in ["final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1", "attachment_semantic_f1", "gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"]:
        reverse = not metric.endswith("_ms")
        ranked = overall_df.sort_values(metric, ascending=not reverse).reset_index(drop=True)
        ranked["rank"] = np.arange(1, len(ranked) + 1)
        ranked["metric"] = metric
        ranking_rows.append(ranked[["metric", "rank", "模型", metric]].rename(columns={metric: "value"}))
    ranking_df = pd.concat(ranking_rows, ignore_index=True)
    save_csv(ranking_df, "test_rankings.csv")

    localhf = overall_df.loc[overall_df["id"] == "localhf_final_combo"].iloc[0]
    gain_rows = []
    for metric in ["final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1", "attachment_semantic_f1"]:
        baseline_df = overall_df[overall_df["id"] != "localhf_final_combo"]
        best = baseline_df.sort_values(metric, ascending=False).iloc[0]
        abs_gain = float(localhf[metric] - best[metric])
        rel_gain = abs_gain / float(best[metric]) * 100 if float(best[metric]) else np.nan
        gain_rows.append({"metric": metric, "localhf_value": float(localhf[metric]), "best_baseline_model": best["模型"], "best_baseline_value": float(best[metric]), "absolute_gain": round(abs_gain, 4), "relative_gain_pct": round(rel_gain, 4)})
    gain_df = pd.DataFrame(gain_rows)
    save_csv(gain_df, "test_gain_vs_best_baseline.csv")

    frontier = overall_df.sort_values("total_model_latency_ms").copy()
    best_exact = -1.0
    flags = []
    for value in frontier["final_matches_reference"]:
        flag = float(value) > best_exact
        flags.append(flag)
        if float(value) > best_exact:
            best_exact = float(value)
    frontier["pareto_exact_latency"] = flags
    save_csv(frontier[["模型", "total_model_latency_ms", "final_matches_reference", "entity_semantic_f1", "pareto_exact_latency"]], "test_pareto_frontier.csv")

    diagram_types = sorted(by_diagram(summaries[TEST_RUNS[0]["id"]], "final_matches_reference").keys())
    by_type_final = []
    by_type_entity = []
    for diagram in diagram_types:
        row_f = {"diagram_type": diagram}
        row_e = {"diagram_type": diagram}
        for run in TEST_RUNS:
            row_f[run["id"]] = by_diagram(summaries[run["id"]], "final_matches_reference")[diagram]
            row_e[run["id"]] = by_diagram(summaries[run["id"]], "entity_semantic_f1")[diagram]
        by_type_final.append(row_f)
        by_type_entity.append(row_e)
    final_df = pd.DataFrame(by_type_final)
    entity_df = pd.DataFrame(by_type_entity)
    save_csv(final_df, "test_by_type_final_match.csv")
    save_csv(entity_df, "test_by_type_entity_f1.csv")

    long_quality = overall_df.melt(id_vars=["id", "模型"], value_vars=["final_matches_reference", "canonicalized_match", "entity_semantic_f1"], var_name="metric", value_name="value")
    long_quality["指标"] = long_quality["metric"].map({
        "final_matches_reference": "严格最终匹配率",
        "canonicalized_match": "规范化匹配率",
        "entity_semantic_f1": "实体语义 F1",
    })
    save_csv(long_quality, "test_long_quality.csv")

    long_latency = overall_df.melt(id_vars=["id", "模型"], value_vars=["gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"], var_name="metric", value_name="value_ms")
    long_latency["value_sec"] = long_latency["value_ms"] / 1000.0
    long_latency["指标"] = long_latency["metric"].map(LATENCY_LABELS)
    save_csv(long_latency, "test_long_latency.csv")

    localhf_vs_best = []
    baseline_final = final_df.drop(columns=["diagram_type", "localhf_final_combo"]).max(axis=1)
    baseline_entity = entity_df.drop(columns=["diagram_type", "localhf_final_combo"]).max(axis=1)
    for idx, diagram in enumerate(final_df["diagram_type"]):
        localhf_vs_best.append({
            "diagram_type": diagram,
            "localhf_final_match": float(final_df.loc[idx, "localhf_final_combo"]),
            "best_baseline_final_match": float(baseline_final.iloc[idx]),
            "localhf_entity_f1": float(entity_df.loc[idx, "localhf_final_combo"]),
            "best_baseline_entity_f1": float(baseline_entity.iloc[idx]),
        })
    localhf_vs_best_df = pd.DataFrame(localhf_vs_best)
    save_csv(localhf_vs_best_df, "test_localhf_vs_best_by_type.csv")

    return {
        "overall": overall_df,
        "rankings": ranking_df,
        "gain": gain_df,
        "frontier": frontier,
        "by_type_final": final_df,
        "by_type_entity": entity_df,
        "long_quality": long_quality,
        "long_latency": long_latency,
        "localhf_vs_best": localhf_vs_best_df,
    }


def draw_ablation_charts(data: dict[str, pd.DataFrame]) -> None:
    palette = sns.color_palette("Set2", 4)
    order = list(data["overall"]["标签"])

    fig, ax = plt.subplots(figsize=(11, 6))
    sns.barplot(data=data["long_quality"], x="指标", y="value", hue="标签", hue_order=order, palette=palette, ax=ax)
    ax.set_title("消融实验整体质量对比")
    ax.set_xlabel("")
    ax.set_ylabel("指标值")
    ax.legend(title="实验设置", bbox_to_anchor=(1.02, 1), loc="upper left")
    plt.xticks(rotation=0)
    save_fig(fig, "ablation_quality_overall")

    fig, ax = plt.subplots(figsize=(11, 6))
    sns.barplot(data=data["long_latency"], x="指标", y="value_sec", hue="标签", hue_order=order, palette=palette, ax=ax)
    ax.set_title("消融实验整体时延对比")
    ax.set_xlabel("")
    ax.set_ylabel("秒")
    ax.legend(title="实验设置", bbox_to_anchor=(1.02, 1), loc="upper left")
    plt.xticks(rotation=0)
    save_fig(fig, "ablation_latency_overall_sec")

    effect_quality = data["effects"].copy()
    effect_quality = effect_quality[effect_quality["metric"].isin(["completed_all_stages", "final_matches_reference", "canonicalized_match", "stage_coverage_rate", "entity_semantic_f1"])]
    effect_quality["指标"] = effect_quality["metric"].map({
        "completed_all_stages": "全部阶段完成率",
        "final_matches_reference": "严格最终匹配率",
        "canonicalized_match": "规范化匹配率",
        "stage_coverage_rate": "阶段覆盖率",
        "entity_semantic_f1": "实体语义 F1",
    })
    effect_quality = effect_quality.melt(id_vars=["指标"], value_vars=["planner_ft_minus_base", "gate_ft_minus_base"], var_name="效应", value_name="变化量")
    effect_quality["效应"] = effect_quality["效应"].map({"planner_ft_minus_base": "大模型微调主效应", "gate_ft_minus_base": "小模型微调主效应"})
    fig, ax = plt.subplots(figsize=(11, 6))
    sns.barplot(data=effect_quality, y="指标", x="变化量", hue="效应", palette=["#dc2626", "#2563eb"], ax=ax)
    ax.axvline(0, color="#111827", linewidth=1)
    ax.set_title("消融实验主效应：质量指标")
    ax.set_xlabel("变化量")
    ax.set_ylabel("")
    ax.legend(title="")
    save_fig(fig, "ablation_main_effects_quality")

    effect_latency = data["effects"].copy()
    effect_latency = effect_latency[effect_latency["metric"].isin(["gate_latency_mean_ms", "planner_latency_mean_ms", "total_model_latency_ms"])]
    effect_latency["指标"] = effect_latency["metric"].map({
        "gate_latency_mean_ms": "Gate 时延",
        "planner_latency_mean_ms": "Planner 时延",
        "total_model_latency_ms": "总模型时延",
    })
    effect_latency["planner_ft_minus_base"] = effect_latency["planner_ft_minus_base"] / 1000.0
    effect_latency["gate_ft_minus_base"] = effect_latency["gate_ft_minus_base"] / 1000.0
    effect_latency = effect_latency.melt(id_vars=["指标"], value_vars=["planner_ft_minus_base", "gate_ft_minus_base"], var_name="效应", value_name="变化量")
    effect_latency["效应"] = effect_latency["效应"].map({"planner_ft_minus_base": "大模型微调主效应", "gate_ft_minus_base": "小模型微调主效应"})
    fig, ax = plt.subplots(figsize=(11, 6))
    sns.barplot(data=effect_latency, y="指标", x="变化量", hue="效应", palette=["#dc2626", "#2563eb"], ax=ax)
    ax.axvline(0, color="#111827", linewidth=1)
    ax.set_title("消融实验主效应：时延指标")
    ax.set_xlabel("秒")
    ax.set_ylabel("")
    ax.legend(title="")
    save_fig(fig, "ablation_main_effects_latency_sec")

    heat_final = data["by_type_final"].set_index("diagram_type").rename(columns={item["id"]: item["标签"] for item in ABLATION_RUNS})
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.heatmap(heat_final, annot=True, fmt=".4f", cmap="YlGnBu", ax=ax)
    ax.set_title("按图类型的消融对比：严格最终匹配率")
    ax.set_xlabel("")
    ax.set_ylabel("图类型")
    save_fig(fig, "ablation_by_type_final_match_heatmap")

    heat_entity = data["by_type_entity"].set_index("diagram_type").rename(columns={item["id"]: item["标签"] for item in ABLATION_RUNS})
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.heatmap(heat_entity, annot=True, fmt=".4f", cmap="YlOrRd", ax=ax)
    ax.set_title("按图类型的消融对比：实体语义 F1")
    ax.set_xlabel("")
    ax.set_ylabel("图类型")
    save_fig(fig, "ablation_by_type_entity_f1_heatmap")

    heat_latency = data["by_type_latency"].set_index("diagram_type").rename(columns={item["id"]: item["标签"] for item in ABLATION_RUNS})
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.heatmap(heat_latency, annot=True, fmt=".2f", cmap="PuBuGn", ax=ax)
    ax.set_title("按图类型的消融对比：Planner 时延（秒）")
    ax.set_xlabel("")
    ax.set_ylabel("图类型")
    save_fig(fig, "ablation_by_type_planner_latency_sec_heatmap")

    fig, ax = plt.subplots(figsize=(10, 6))
    count_df = data["overall"][["标签", "final_match_count_est", "canonicalized_count_est"]].melt(id_vars=["标签"], var_name="metric", value_name="count")
    count_df["metric"] = count_df["metric"].map({"final_match_count_est": "严格匹配条数估计", "canonicalized_count_est": "规范化匹配条数估计"})
    sns.barplot(data=count_df, y="标签", x="count", hue="metric", ax=ax, palette=["#2563eb", "#0f766e"])
    ax.set_title("消融实验命中样本条数估计")
    ax.set_xlabel("条数")
    ax.set_ylabel("")
    ax.legend(title="")
    save_fig(fig, "ablation_exact_count_bar")

    radar_df = data["overall"][["标签", "final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1"]].copy()
    metrics = ["严格匹配", "规范化匹配", "实体F1", "节点F1", "分组F1"]
    angles = np.linspace(0, 2 * np.pi, len(metrics), endpoint=False).tolist()
    angles += angles[:1]
    fig = plt.figure(figsize=(8, 8))
    ax = plt.subplot(111, polar=True)
    for _, row in radar_df.iterrows():
        values = [row["final_matches_reference"], row["canonicalized_match"], row["entity_semantic_f1"], row["node_semantic_f1"], row["group_semantic_f1"]]
        values += values[:1]
        ax.plot(angles, values, linewidth=2, label=row["标签"])
        ax.fill(angles, values, alpha=0.08)
    ax.set_thetagrids(np.degrees(angles[:-1]), metrics)
    ax.set_title("消融实验质量雷达图", pad=28)
    ax.legend(loc="upper right", bbox_to_anchor=(1.4, 1.1), frameon=False)
    save_fig(fig, "ablation_radar_quality")

    point_df = data["by_type_entity"].melt(id_vars=["diagram_type"], var_name="setting", value_name="value")
    label_map = {item["id"]: item["标签"] for item in ABLATION_RUNS}
    point_df["设置"] = point_df["setting"].map(label_map)
    fig, ax = plt.subplots(figsize=(11, 6))
    sns.pointplot(data=point_df, x="diagram_type", y="value", hue="设置", dodge=0.3, markers="o", linestyles="-", ax=ax)
    ax.set_title("各图类型上的实体语义 F1 变化趋势")
    ax.set_xlabel("图类型")
    ax.set_ylabel("实体语义 F1")
    ax.legend(title="实验设置", bbox_to_anchor=(1.02, 1), loc="upper left")
    save_fig(fig, "ablation_entity_f1_pointplot")

    point_df2 = data["by_type_final"].melt(id_vars=["diagram_type"], var_name="setting", value_name="value")
    point_df2["设置"] = point_df2["setting"].map(label_map)
    fig, ax = plt.subplots(figsize=(11, 6))
    sns.pointplot(data=point_df2, x="diagram_type", y="value", hue="设置", dodge=0.3, markers="D", linestyles="-", ax=ax)
    ax.set_title("各图类型上的严格最终匹配率变化趋势")
    ax.set_xlabel("图类型")
    ax.set_ylabel("严格最终匹配率")
    ax.legend(title="实验设置", bbox_to_anchor=(1.02, 1), loc="upper left")
    save_fig(fig, "ablation_final_match_pointplot")


def draw_test_charts(data: dict[str, pd.DataFrame]) -> None:
    overall = data["overall"].copy()
    overall = overall.sort_values("final_matches_reference", ascending=False)

    fig, ax = plt.subplots(figsize=(12, 6))
    sns.barplot(data=overall, y="模型", x="final_matches_reference", hue="模型", palette="Blues_r", dodge=False, legend=False, ax=ax)
    ax.set_title("全量测试：严格最终匹配率排名")
    ax.set_xlabel("严格最终匹配率")
    ax.set_ylabel("")
    save_fig(fig, "test_final_match_rank")

    fig, ax = plt.subplots(figsize=(12, 6))
    entity_sorted = data["overall"].sort_values("entity_semantic_f1", ascending=False)
    sns.barplot(data=entity_sorted, y="模型", x="entity_semantic_f1", hue="模型", palette="Reds_r", dodge=False, legend=False, ax=ax)
    ax.set_title("全量测试：实体语义 F1 排名")
    ax.set_xlabel("实体语义 F1")
    ax.set_ylabel("")
    save_fig(fig, "test_entity_f1_rank")

    fig, ax = plt.subplots(figsize=(13, 7))
    sns.barplot(data=data["long_quality"], x="模型", y="value", hue="指标", ax=ax, palette=["#2563eb", "#0f766e", "#dc2626"])
    ax.set_title("全量测试：核心质量指标对比")
    ax.set_xlabel("")
    ax.set_ylabel("指标值")
    ax.tick_params(axis="x", rotation=25)
    ax.legend(title="")
    save_fig(fig, "test_topline_quality")

    fig, ax = plt.subplots(figsize=(13, 7))
    sns.barplot(data=data["long_latency"], x="模型", y="value_sec", hue="指标", ax=ax, palette=["#2563eb", "#f59e0b", "#dc2626"])
    ax.set_title("全量测试：核心时延指标对比")
    ax.set_xlabel("")
    ax.set_ylabel("秒")
    ax.tick_params(axis="x", rotation=25)
    ax.legend(title="")
    save_fig(fig, "test_topline_latency_sec")

    fig, ax = plt.subplots(figsize=(11, 7))
    scatter = data["overall"].copy()
    sns.scatterplot(data=scatter, x="total_model_latency_ms", y="final_matches_reference", hue="模型", style="模型", s=180, ax=ax)
    ax.set_title("全量测试：严格最终匹配率与总时延")
    ax.set_xlabel("总模型时延（毫秒）")
    ax.set_ylabel("严格最终匹配率")
    ax.legend(title="", bbox_to_anchor=(1.02, 1), loc="upper left")
    save_fig(fig, "test_quality_latency_scatter_final_match")

    fig, ax = plt.subplots(figsize=(11, 7))
    sns.scatterplot(data=scatter, x="total_model_latency_ms", y="entity_semantic_f1", hue="模型", style="模型", s=180, ax=ax)
    ax.set_title("全量测试：实体语义 F1 与总时延")
    ax.set_xlabel("总模型时延（毫秒）")
    ax.set_ylabel("实体语义 F1")
    ax.legend(title="", bbox_to_anchor=(1.02, 1), loc="upper left")
    save_fig(fig, "test_quality_latency_scatter_entity_f1")

    heat_final = data["by_type_final"].set_index("diagram_type").rename(columns={item["id"]: item["模型"] for item in TEST_RUNS})
    fig, ax = plt.subplots(figsize=(14, 5.5))
    sns.heatmap(heat_final, annot=True, fmt=".4f", cmap="YlGnBu", ax=ax)
    ax.set_title("全量测试：按图类型的严格最终匹配率")
    ax.set_xlabel("")
    ax.set_ylabel("图类型")
    save_fig(fig, "test_by_type_final_match_heatmap")

    heat_entity = data["by_type_entity"].set_index("diagram_type").rename(columns={item["id"]: item["模型"] for item in TEST_RUNS})
    fig, ax = plt.subplots(figsize=(14, 5.5))
    sns.heatmap(heat_entity, annot=True, fmt=".4f", cmap="YlOrRd", ax=ax)
    ax.set_title("全量测试：按图类型的实体语义 F1")
    ax.set_xlabel("")
    ax.set_ylabel("图类型")
    save_fig(fig, "test_by_type_entity_f1_heatmap")

    metric_heatmap = data["overall"][["模型", "final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1", "attachment_semantic_f1"]].set_index("模型")
    metric_heatmap = metric_heatmap.rename(columns={
        "final_matches_reference": "严格匹配",
        "canonicalized_match": "规范化匹配",
        "entity_semantic_f1": "实体F1",
        "node_semantic_f1": "节点F1",
        "group_semantic_f1": "分组F1",
        "attachment_semantic_f1": "挂载F1",
    })
    fig, ax = plt.subplots(figsize=(10, 7))
    sns.heatmap(metric_heatmap, annot=True, fmt=".4f", cmap="crest", ax=ax)
    ax.set_title("全量测试：总体质量指标热力图")
    ax.set_xlabel("")
    ax.set_ylabel("")
    save_fig(fig, "test_quality_metric_heatmap")

    gain_df = data["gain"].copy()
    gain_df["指标"] = gain_df["metric"].map({
        "final_matches_reference": "严格最终匹配率",
        "canonicalized_match": "规范化匹配率",
        "entity_semantic_f1": "实体语义 F1",
        "node_semantic_f1": "节点语义 F1",
        "group_semantic_f1": "分组语义 F1",
        "attachment_semantic_f1": "挂载语义 F1",
    })
    fig, ax = plt.subplots(figsize=(11, 6))
    sns.barplot(data=gain_df, y="指标", x="absolute_gain", hue="指标", palette="viridis", dodge=False, legend=False, ax=ax)
    ax.set_title("最终模型相对最强基线的绝对增益")
    ax.set_xlabel("绝对增益")
    ax.set_ylabel("")
    save_fig(fig, "test_gain_vs_best_baseline")

    latency_stack = data["overall"][["模型", "gate_latency_mean_ms", "planner_latency_mean_ms"]].copy()
    latency_stack["Gate 时延"] = latency_stack["gate_latency_mean_ms"] / 1000.0
    latency_stack["Planner 时延"] = latency_stack["planner_latency_mean_ms"] / 1000.0
    latency_stack = latency_stack.sort_values("Gate 时延" if False else "Planner 时延", ascending=False)
    fig, ax = plt.subplots(figsize=(13, 7))
    ax.bar(latency_stack["模型"], latency_stack["Gate 时延"], label="Gate 时延", color="#2563eb")
    ax.bar(latency_stack["模型"], latency_stack["Planner 时延"], bottom=latency_stack["Gate 时延"], label="Planner 时延", color="#f59e0b")
    ax.set_title("全量测试：Gate / Planner 时延组成")
    ax.set_ylabel("秒")
    ax.set_xlabel("")
    ax.tick_params(axis="x", rotation=25)
    ax.legend()
    save_fig(fig, "test_latency_stacked")

    frontier = data["frontier"].copy().sort_values("total_model_latency_ms")
    fig, ax = plt.subplots(figsize=(11, 6.5))
    sns.lineplot(data=frontier, x="total_model_latency_ms", y="final_matches_reference", marker="o", ax=ax, color="#2563eb")
    pareto = frontier[frontier["pareto_exact_latency"]]
    ax.scatter(pareto["total_model_latency_ms"], pareto["final_matches_reference"], s=180, color="#dc2626", label="Pareto 前沿")
    for _, row in frontier.iterrows():
        ax.text(row["total_model_latency_ms"] * 1.005, row["final_matches_reference"] + 0.001, row["模型"], fontsize=10)
    ax.set_title("全量测试：严格匹配率 - 时延 Pareto 前沿")
    ax.set_xlabel("总模型时延（毫秒）")
    ax.set_ylabel("严格最终匹配率")
    ax.legend()
    save_fig(fig, "test_pareto_frontier")

    compare = data["localhf_vs_best"].copy()
    fig, axes = plt.subplots(1, 2, figsize=(15, 5.8), sharey=True)
    x = np.arange(len(compare))
    width = 0.38
    axes[0].bar(x - width / 2, compare["localhf_final_match"], width, label="LocalHF 最终组合", color="#dc2626")
    axes[0].bar(x + width / 2, compare["best_baseline_final_match"], width, label="最强通用基线", color="#2563eb")
    axes[0].set_title("按图类型：严格最终匹配率")
    axes[0].set_xticks(x)
    axes[0].set_xticklabels(compare["diagram_type"], rotation=25)
    axes[0].set_ylabel("匹配率")
    axes[0].legend()
    axes[1].bar(x - width / 2, compare["localhf_entity_f1"], width, label="LocalHF 最终组合", color="#dc2626")
    axes[1].bar(x + width / 2, compare["best_baseline_entity_f1"], width, label="最强通用基线", color="#2563eb")
    axes[1].set_title("按图类型：实体语义 F1")
    axes[1].set_xticks(x)
    axes[1].set_xticklabels(compare["diagram_type"], rotation=25)
    save_fig(fig, "test_localhf_vs_best_by_type")

    radar_df = data["overall"][["模型", "final_matches_reference", "canonicalized_match", "entity_semantic_f1", "node_semantic_f1", "group_semantic_f1"]].copy()
    metrics = ["严格匹配", "规范化匹配", "实体F1", "节点F1", "分组F1"]
    angles = np.linspace(0, 2 * np.pi, len(metrics), endpoint=False).tolist()
    angles += angles[:1]
    fig = plt.figure(figsize=(9, 9))
    ax = plt.subplot(111, polar=True)
    for _, row in radar_df.iterrows():
        values = [row["final_matches_reference"], row["canonicalized_match"], row["entity_semantic_f1"], row["node_semantic_f1"], row["group_semantic_f1"]]
        values += values[:1]
        ax.plot(angles, values, linewidth=2, label=row["模型"])
    ax.set_thetagrids(np.degrees(angles[:-1]), metrics)
    ax.set_title("全量测试：核心质量指标雷达图", pad=28)
    ax.legend(loc="upper right", bbox_to_anchor=(1.5, 1.15), frameon=False)
    save_fig(fig, "test_quality_radar")


def write_manifest(ablation: dict[str, pd.DataFrame], test: dict[str, pd.DataFrame]) -> None:
    manifest = {
        "charts_dir": str(CHART_DIR.relative_to(ROOT)),
        "data_dir": str(DATA_DIR.relative_to(ROOT)),
        "ablation_rows": int(len(ablation["overall"])),
        "test_rows": int(len(test["overall"])),
        "note": "Generated with pandas + matplotlib + seaborn using Chinese labels.",
    }
    (OUTPUT_ROOT / "analysis_manifest_matplotlib.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    ensure_dirs()
    setup_style()
    ablation = build_ablation_data()
    test = build_test_data()
    draw_ablation_charts(ablation)
    draw_test_charts(test)
    write_manifest(ablation, test)
    print(f"Data written to: {DATA_DIR}")
    print(f"Charts written to: {CHART_DIR}")


if __name__ == "__main__":
    main()
