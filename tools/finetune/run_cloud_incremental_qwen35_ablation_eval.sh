#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv-finetune}"
SPLIT="${SPLIT:-validation}"
MAX_SAMPLES="${MAX_SAMPLES:-0}"
MAX_CONCURRENCY="${MAX_CONCURRENCY:-1}"
TIMEOUT_SEC="${TIMEOUT_SEC:-240}"
RUN_ROOT="${RUN_ROOT:-$ROOT_DIR/data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean}"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT_DIR/reports/evaluation/runs/incremental_system}"
CONFIG_OUTPUT_DIR="${CONFIG_OUTPUT_DIR:-$ROOT_DIR/reports/evaluation/generated_configs/incremental_qwen35_ablation}"
GATE_MODEL="${GATE_MODEL:-$ROOT_DIR/artifacts/model_cache/qwen35_incremental/Qwen__Qwen3.5-4B}"
PLANNER_MODEL="${PLANNER_MODEL:-$ROOT_DIR/artifacts/model_cache/qwen35_incremental/Qwen__Qwen3.5-27B}"
GATE_ADAPTER="${GATE_ADAPTER:-$ROOT_DIR/artifacts/finetune/qwen35_4b_incremental_gate_cloud_autodl/final_adapter}"
PLANNER_ADAPTER="${PLANNER_ADAPTER:-$ROOT_DIR/artifacts/finetune/qwen35_27b_incremental_planner_cloud_autodl/final_adapter}"
GATE_GPU_MEMORY_MIB="${GATE_GPU_MEMORY_MIB:-16000}"
PLANNER_GPU_MEMORY_MIB="${PLANNER_GPU_MEMORY_MIB:-78000}"
GATE_CPU_MEMORY_GIB="${GATE_CPU_MEMORY_GIB:-64}"
PLANNER_CPU_MEMORY_GIB="${PLANNER_CPU_MEMORY_GIB:-96}"
ATTN_IMPLEMENTATION="${ATTN_IMPLEMENTATION:-sdpa}"
ENABLE_THINKING="${ENABLE_THINKING:-0}"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing virtual environment at $VENV_DIR"
  echo "Run tools/finetune/bootstrap_local_finetune_env.sh \"$VENV_DIR\" first."
  exit 1
fi

source "$VENV_DIR/bin/activate"
export HF_HOME="${HF_HOME:-/root/autodl-tmp/hf-cache}"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

cd "$ROOT_DIR"

CMD=(
  python "$ROOT_DIR/tools/finetune/run_incremental_qwen35_ablation_eval.py"
  --run-root "$RUN_ROOT"
  --split "$SPLIT"
  --max-samples "$MAX_SAMPLES"
  --max-concurrency "$MAX_CONCURRENCY"
  --timeout-sec "$TIMEOUT_SEC"
  --output-root "$OUTPUT_ROOT"
  --config-output-dir "$CONFIG_OUTPUT_DIR"
  --gate-model "$GATE_MODEL"
  --planner-model "$PLANNER_MODEL"
  --gate-adapter "$GATE_ADAPTER"
  --planner-adapter "$PLANNER_ADAPTER"
  --gate-gpu-memory-mib "$GATE_GPU_MEMORY_MIB"
  --planner-gpu-memory-mib "$PLANNER_GPU_MEMORY_MIB"
  --gate-cpu-memory-gib "$GATE_CPU_MEMORY_GIB"
  --planner-cpu-memory-gib "$PLANNER_CPU_MEMORY_GIB"
  --attn-implementation "$ATTN_IMPLEMENTATION"
)

if [[ "$ENABLE_THINKING" == "1" ]]; then
  CMD+=(--enable-thinking)
fi

echo "Running four-way Qwen3.5 ablation eval on split=$SPLIT"
"${CMD[@]}"
