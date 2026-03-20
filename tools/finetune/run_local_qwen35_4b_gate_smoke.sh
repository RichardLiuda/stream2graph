#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_RUN_ROOT="${LOCAL_RUN_ROOT:-$HOME/stream2graph_local}"
VENV_DIR="${LOCAL_RUN_ROOT}/.venv-finetune"
DATASET_DIR="${LOCAL_RUN_ROOT}/data/incremental_gate_sft_local_smoke"
LOG_DIR="${LOCAL_RUN_ROOT}/logs"
TB_DIR="${LOCAL_RUN_ROOT}/tensorboard/qwen35_4b_incremental_gate_local_smoke"
OUTPUT_DIR="${LOCAL_RUN_ROOT}/artifacts/qwen35_4b_incremental_gate_local_smoke"
OFFLOAD_DIR="${LOCAL_RUN_ROOT}/offload/qwen35_4b_incremental_gate_local_smoke"
RUNTIME_DIR="${LOCAL_RUN_ROOT}/runtime"
TRAIN_SCRIPT="${RUNTIME_DIR}/train_qwen3_lora.py"
RUN_NAME="qwen35_4b_incremental_gate_local_smoke"
LOG_FILE="${LOG_DIR}/${RUN_NAME}.log"
PID_FILE="${LOG_DIR}/${RUN_NAME}.pid"
CONFIG_PATH="${ROOT_DIR}/configs/finetune/qwen35_4b_gate_local_smoke.json"

mkdir -p "$LOG_DIR" "$DATASET_DIR" "$TB_DIR" "$OUTPUT_DIR" "$OFFLOAD_DIR" "$RUNTIME_DIR"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing virtual environment at $VENV_DIR"
  echo "Run tools/finetune/bootstrap_local_finetune_env.sh first."
  exit 1
fi

source "$VENV_DIR/bin/activate"

export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
cp "$ROOT_DIR/tools/finetune/train_qwen3_lora.py" "$TRAIN_SCRIPT"

python "$ROOT_DIR/tools/incremental_finetune/prepare_gate_sft_dataset.py" \
  --output-dir "$DATASET_DIR" \
  --max-train-samples "${MAX_TRAIN_SAMPLES:-128}" \
  --max-validation-samples "${MAX_VALIDATION_SAMPLES:-32}" \
  --max-test-samples "${MAX_TEST_SAMPLES:-32}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Training process already running with PID $(cat "$PID_FILE")"
  exit 1
fi

cd "$LOCAL_RUN_ROOT"
nohup python -u "$TRAIN_SCRIPT" \
  --config "$CONFIG_PATH" \
  --dataset-dir "$DATASET_DIR" \
  --output-dir "$OUTPUT_DIR" \
  --logging-dir "$TB_DIR" \
  --offload-dir "$OFFLOAD_DIR" \
  > "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
echo "Started ${RUN_NAME} with PID $(cat "$PID_FILE")"
echo "Log: $LOG_FILE"
