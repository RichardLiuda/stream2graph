#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv-finetune}"
CONFIG_PATH="${CONFIG_PATH:-$ROOT_DIR/configs/finetune/qwen35_4b_gate_cloud_autodl.json}"
LOG_DIR="${ROOT_DIR}/reports/finetune"
RUN_NAME="qwen35_4b_incremental_gate_cloud_autodl"
LOG_FILE="${LOG_DIR}/${RUN_NAME}.log"
PID_FILE="${LOG_DIR}/${RUN_NAME}.pid"
DATASET_DIR="${ROOT_DIR}/data/finetune/incremental_gate_sft_cloud"
FINETUNE_RUN_ROOT="${FINETUNE_RUN_ROOT:-$ROOT_DIR/data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean}"
FOREGROUND="${FOREGROUND:-0}"

mkdir -p "$LOG_DIR"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing virtual environment at $VENV_DIR"
  echo "Run tools/finetune/bootstrap_local_finetune_env.sh \"$VENV_DIR\" first."
  exit 1
fi

source "$VENV_DIR/bin/activate"

export HF_HOME="${HF_HOME:-/root/autodl-tmp/hf-cache}"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

python "$ROOT_DIR/tools/incremental_finetune/prepare_gate_sft_dataset.py" \
  --run-root "$FINETUNE_RUN_ROOT" \
  --output-dir "$DATASET_DIR"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Training process already running with PID $(cat "$PID_FILE")"
  exit 1
fi

cd "$ROOT_DIR"
if [[ "$FOREGROUND" == "1" ]]; then
  echo "Running ${RUN_NAME} in foreground"
  echo "Log: $LOG_FILE"
  python -u "$ROOT_DIR/tools/finetune/train_qwen3_lora.py" \
    --config "$CONFIG_PATH" 2>&1 | tee "$LOG_FILE"
else
  nohup python -u "$ROOT_DIR/tools/finetune/train_qwen3_lora.py" \
    --config "$CONFIG_PATH" \
    > "$LOG_FILE" 2>&1 &

  echo $! > "$PID_FILE"
  echo "Started ${RUN_NAME} with PID $(cat "$PID_FILE")"
  echo "Log: $LOG_FILE"
fi
