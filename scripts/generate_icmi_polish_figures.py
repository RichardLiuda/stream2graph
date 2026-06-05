from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from matplotlib import font_manager
from matplotlib.ticker import FuncFormatter


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "localhf_incremental_analysis_en" / "data"
OUT_DIR = ROOT / "docs" / "paper" / "icmi2026_latex" / "figures_polish"

OURS_ID = "localhf_final_combo"
OURS_COLOR = "#D55E00"
BASE_COLOR = "#4C78A8"
BASE_LIGHT = "#9DB7CF"
GRID_COLOR = "#D8DEE9"
TEXT_COLOR = "#222222"

MODEL_LABELS_EN = {
    "localhf_final_combo": "S2G local",
    "claude_sonnet45": "Claude Sonnet 4.5",
    "gemini3flash_rerun2": "Gemini 3 Flash",
    "gpt54_gateway": "GPT-5.4",
    "minimax_m27": "MiniMax M2.7",
    "moonshot_k25": "Moonshot K2.5",
    "qwen35plus": "Qwen3.5-Plus",
    "qwen35plus_thinking_on": "Qwen3.5-Plus (thinking)",
    "qwen35_27b_dashscope": "Qwen3.5-27B",
}

MODEL_LABELS_ZH = {
    "localhf_final_combo": "S2G 本地",
    "claude_sonnet45": "Claude Sonnet 4.5",
    "gemini3flash_rerun2": "Gemini 3 Flash",
    "gpt54_gateway": "GPT-5.4",
    "minimax_m27": "MiniMax M2.7",
    "moonshot_k25": "Moonshot K2.5",
    "qwen35plus": "Qwen3.5-Plus",
    "qwen35plus_thinking_on": "Qwen3.5-Plus（思考）",
    "qwen35_27b_dashscope": "Qwen3.5-27B",
}

TYPE_LABELS_EN = {
    "architecture": "Architecture",
    "er": "ER",
    "flowchart": "Flowchart",
    "mindmap": "Mind map",
    "sequence": "Sequence",
    "statediagram": "State",
}

TYPE_LABELS_ZH = {
    "architecture": "架构图",
    "er": "ER",
    "flowchart": "流程图",
    "mindmap": "思维导图",
    "sequence": "时序图",
    "statediagram": "状态图",
}

SETTING_LABELS_EN = {
    "gateft_plannerft": "G-FT / P-FT",
    "gateft_plannerbase": "G-FT / P-Base",
    "gatebase_plannerft": "G-Base / P-FT",
    "gatebase_plannerbase": "G-Base / P-Base",
}

SETTING_LABELS_ZH = {
    "gateft_plannerft": "Gate 微调 / Planner 微调",
    "gateft_plannerbase": "Gate 微调 / Planner 基座",
    "gatebase_plannerft": "Gate 基座 / Planner 微调",
    "gatebase_plannerbase": "Gate 基座 / Planner 基座",
}

METRIC_LABELS_EN = {
    "final_matches_reference": "Final",
    "canonicalized_match": "Canon.",
    "entity_semantic_f1": "Entity F1",
}

METRIC_LABELS_ZH = {
    "final_matches_reference": "最终匹配",
    "canonicalized_match": "规范匹配",
    "entity_semantic_f1": "实体 F1",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate paper-polish ICMI figures.")
    parser.add_argument("--lang", choices=["en", "zh", "all"], default="all")
    return parser.parse_args()


def pct_formatter(x: float, _pos: int) -> str:
    return f"{x * 100:.0f}"


def label_suffix(lang: str) -> str:
    return "_en" if lang == "en" else ""


def model_label(row: pd.Series, lang: str) -> str:
    labels = MODEL_LABELS_EN if lang == "en" else MODEL_LABELS_ZH
    return labels.get(row["id"], row["模型"])


def scatter_label(model_id: str, lang: str) -> str:
    wrapped_en = {
        "claude_sonnet45": "Claude Sonnet\n4.5",
        "gemini3flash_rerun2": "Gemini 3\nFlash",
        "minimax_m27": "MiniMax\nM2.7",
        "moonshot_k25": "Moonshot\nK2.5",
        "qwen35plus": "Qwen3.5-\nPlus",
        "qwen35plus_thinking_on": "Qwen3.5-Plus\n(thinking)",
        "qwen35_27b_dashscope": "Qwen3.5-\n27B",
    }
    wrapped_zh = {
        "claude_sonnet45": "Claude Sonnet\n4.5",
        "gemini3flash_rerun2": "Gemini 3\nFlash",
        "minimax_m27": "MiniMax\nM2.7",
        "moonshot_k25": "Moonshot\nK2.5",
        "qwen35plus": "Qwen3.5-\nPlus",
        "qwen35plus_thinking_on": "Qwen3.5-Plus\n（思考）",
        "qwen35_27b_dashscope": "Qwen3.5-\n27B",
    }
    wrapped = wrapped_en if lang == "en" else wrapped_zh
    labels = MODEL_LABELS_EN if lang == "en" else MODEL_LABELS_ZH
    return wrapped.get(model_id, labels.get(model_id, model_id))

def setup_style(lang: str) -> None:
    available_fonts = {font.name for font in font_manager.fontManager.ttflist}
    cjk_candidates = [
        "Microsoft YaHei",
        "SimHei",
        "Noto Sans CJK SC",
        "Source Han Sans SC",
        "Arial Unicode MS",
    ]
    cjk_fonts = [font for font in cjk_candidates if font in available_fonts]
    primary = cjk_fonts[0] if lang == "zh" and cjk_fonts else "DejaVu Sans"

    sns.set_theme(style="whitegrid", context="paper")
    plt.rcParams.update(
        {
            "font.family": primary,
            "font.sans-serif": cjk_fonts + ["DejaVu Sans"] if lang == "zh" else ["DejaVu Sans"],
            "axes.unicode_minus": False,
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "savefig.facecolor": "white",
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "font.size": 7.0,
            "axes.labelsize": 7.3,
            "xtick.labelsize": 6.5,
            "ytick.labelsize": 6.5,
            "legend.fontsize": 5.9,
            "legend.title_fontsize": 5.9,
            "axes.edgecolor": "#666666",
            "axes.labelcolor": TEXT_COLOR,
            "xtick.color": TEXT_COLOR,
            "ytick.color": TEXT_COLOR,
            "grid.color": GRID_COLOR,
            "grid.linewidth": 0.55,
        }
    )


def save(fig: plt.Figure, name: str, lang: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    suffix = label_suffix(lang)
    fig.savefig(OUT_DIR / f"{name}{suffix}.pdf", bbox_inches="tight", pad_inches=0.018)
    fig.savefig(OUT_DIR / f"{name}{suffix}.png", dpi=420, bbox_inches="tight", pad_inches=0.018)
    plt.close(fig)


def draw_rank(lang: str) -> None:
    df = pd.read_csv(DATA_DIR / "test_overall.csv")
    df = df.sort_values("final_matches_reference", ascending=True).reset_index(drop=True)
    labels = [model_label(row, lang) for _, row in df.iterrows()]
    values = df["final_matches_reference"].astype(float).to_numpy()
    colors = [OURS_COLOR if row_id == OURS_ID else BASE_LIGHT for row_id in df["id"]]

    fig, ax = plt.subplots(figsize=(3.45, 1.9))
    fig.subplots_adjust(left=0.41, right=0.98, top=0.98, bottom=0.20)
    y = np.arange(len(df))
    ax.barh(y, values, color=colors, edgecolor="none", height=0.66)
    ax.set_yticks(y, labels)
    ax.set_xlim(0, 0.12)
    ax.xaxis.set_major_formatter(FuncFormatter(pct_formatter))
    ax.set_xlabel("Strict final match (%)" if lang == "en" else "严格最终匹配率 (%)")
    ax.set_ylabel("")
    ax.grid(axis="x")
    ax.grid(axis="y", visible=False)
    ax.spines[["top", "right", "left"]].set_visible(False)
    for yi, value in zip(y, values):
        ax.text(value + 0.002, yi, f"{value * 100:.1f}", va="center", ha="left", fontsize=5.9)
    save(fig, "test_final_match_rank", lang)


def draw_scatter(lang: str) -> None:
    df = pd.read_csv(DATA_DIR / "test_overall.csv")
    df["total_sec"] = df["total_model_latency_ms"].astype(float) / 1000.0
    df["display"] = [scatter_label(row["id"], lang) for _, row in df.iterrows()]

    fig, ax = plt.subplots(figsize=(3.45, 1.9))
    base = df[df["id"] != OURS_ID]
    ours = df[df["id"] == OURS_ID]
    ax.scatter(base["total_sec"], base["final_matches_reference"], s=34, color=BASE_COLOR, alpha=0.78)
    ax.scatter(ours["total_sec"], ours["final_matches_reference"], s=74, color=OURS_COLOR, marker="D", zorder=3)

    offsets = {
        "localhf_final_combo": (6, 2),
        "claude_sonnet45": (10, 4),
        "gemini3flash_rerun2": (6, 8),
        "gpt54_gateway": (8, -12),
        "minimax_m27": (8, -8),
        "moonshot_k25": (-10, 8),
        "qwen35plus": (-30, -4),
        "qwen35plus_thinking_on": (-44, -8),
        "qwen35_27b_dashscope": (-2, 13),
    }
    for _, row in df.iterrows():
        dx, dy = offsets.get(row["id"], (3, 0.002))
        ax.annotate(
            row["display"],
            xy=(row["total_sec"], row["final_matches_reference"]),
            xytext=(dx, dy),
            textcoords="offset points",
            fontsize=5.4,
            color=TEXT_COLOR,
            bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.62, "pad": 0.15},
        )
    ax.set_xlabel("Total model latency (s)" if lang == "en" else "总模型时延 (秒)")
    ax.set_ylabel("Strict final match (%)" if lang == "en" else "严格最终匹配率 (%)")
    ax.yaxis.set_major_formatter(FuncFormatter(pct_formatter))
    ax.set_xlim(32, 252)
    ax.set_ylim(0.015, 0.122)
    ax.grid(True)
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, "test_quality_latency_scatter_final_match", lang)


def draw_ablation(lang: str) -> None:
    df = pd.read_csv(DATA_DIR / "ablation_long_quality.csv")
    df = df[df["metric"].isin(METRIC_LABELS_EN)].copy()
    setting_labels = SETTING_LABELS_EN if lang == "en" else SETTING_LABELS_ZH
    metric_labels = METRIC_LABELS_EN if lang == "en" else METRIC_LABELS_ZH
    df["setting_label"] = df["setting"].map(setting_labels)
    df["metric_label"] = df["metric"].map(metric_labels)
    order_metrics = [metric_labels[key] for key in METRIC_LABELS_EN]
    order_settings = [setting_labels[key] for key in SETTING_LABELS_EN]

    fig, ax = plt.subplots(figsize=(3.45, 1.85))
    palette = {
        order_settings[0]: OURS_COLOR,
        order_settings[1]: "#56B4E9",
        order_settings[2]: "#009E73",
        order_settings[3]: "#999999",
    }
    sns.barplot(
        data=df,
        x="metric_label",
        y="value",
        hue="setting_label",
        order=order_metrics,
        hue_order=order_settings,
        palette=palette,
        ax=ax,
        width=0.78,
    )
    ax.yaxis.set_major_formatter(FuncFormatter(pct_formatter))
    ax.set_xlabel("")
    ax.set_ylabel("Score (%)" if lang == "en" else "分数 (%)")
    ax.set_ylim(0, 0.55)
    ax.grid(axis="y")
    ax.grid(axis="x", visible=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(
        title="",
        ncols=2,
        loc="upper center",
        bbox_to_anchor=(0.5, 1.02),
        frameon=False,
        columnspacing=0.75,
        handlelength=1.1,
        handletextpad=0.35,
    )
    save(fig, "ablation_quality_overall", lang)


def draw_by_type_pair(lang: str) -> None:
    df = pd.read_csv(DATA_DIR / "test_localhf_vs_best_by_type.csv")
    type_labels = TYPE_LABELS_EN if lang == "en" else TYPE_LABELS_ZH
    df["type_label"] = df["diagram_type"].map(type_labels)
    df = df.iloc[::-1].reset_index(drop=True)

    fig, ax = plt.subplots(figsize=(3.45, 1.85))
    y = np.arange(len(df))
    h = 0.32
    ax.barh(
        y + h / 2,
        df["localhf_final_match"].astype(float),
        height=h,
        color=OURS_COLOR,
        label="S2G local" if lang == "en" else "S2G 本地",
    )
    ax.barh(
        y - h / 2,
        df["best_baseline_final_match"].astype(float),
        height=h,
        color=BASE_COLOR,
        label="Best baseline" if lang == "en" else "最佳基线",
    )
    ax.set_yticks(y, df["type_label"])
    ax.xaxis.set_major_formatter(FuncFormatter(pct_formatter))
    ax.set_xlabel("Strict final match (%)" if lang == "en" else "严格最终匹配率 (%)")
    ax.set_xlim(0, 0.42)
    ax.grid(axis="x")
    ax.grid(axis="y", visible=False)
    ax.spines[["top", "right", "left"]].set_visible(False)
    for yi, local_value, base_value in zip(
        y,
        df["localhf_final_match"].astype(float),
        df["best_baseline_final_match"].astype(float),
    ):
        if local_value > 0:
            ax.text(local_value + 0.008, yi + h / 2, f"{local_value * 100:.1f}", va="center", fontsize=5.8)
        if base_value > 0:
            ax.text(base_value + 0.008, yi - h / 2, f"{base_value * 100:.1f}", va="center", fontsize=5.8)
    ax.legend(loc="lower right", frameon=False)
    save(fig, "test_by_type_final_match_pair", lang)


def main() -> None:
    args = parse_args()
    langs = ["en", "zh"] if args.lang == "all" else [args.lang]
    for lang in langs:
        setup_style(lang)
        draw_rank(lang)
        draw_scatter(lang)
        draw_ablation(lang)
        draw_by_type_pair(lang)


if __name__ == "__main__":
    main()
