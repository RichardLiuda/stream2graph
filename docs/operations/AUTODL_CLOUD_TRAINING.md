# AutoDL Cloud Training

This document describes the current cloud workflow for the incremental
Stream2Graph project. The active path is:

- gate model: `Qwen/Qwen3.5-4B`
- planner model: `Qwen/Qwen3.5-27B`
- official benchmark / finetune source:
  `data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean`

The older `Qwen3-14B` route is legacy only and should not be used for new runs.

## 1. Recommended instance choices

- gate finetune:
  - `1 x RTX 4090 24GB` or better
- planner finetune:
  - `1 x A100 80GB` or better
- your current machine class:
  - `1 x RTX PRO 6000 96GB` on Ubuntu 22.04 is fully suitable for both runs
- billing:
  - use pay-as-you-go for environment bring-up
- image:
  - `PyTorch 2.8 / Python 3.10 / CUDA 12.8`
  - `Ubuntu 22.04` remains the recommended OS base
- storage:
  - keep the repo under fast local cloud disk such as `/root/autodl-tmp`
  - if you want the full local base-model bundle on cloud, expand data disk to at least `200GB`

## 2. Start a persistent shell

```bash
ssh root@<your-host> -p <your-port>
tmux new -s stream2graph
```

## 3. Put the project on local cloud storage

You can either transfer the prepared bundle or clone the repo fresh.

### Option A: transfer the local bundle

Export locally:

```bash
python tools/finetune/export_incremental_qwen35_bundle.py --include-optional-dirs
```

Then upload `artifacts/finetune/qwen35_incremental_transfer_bundle` to:

```bash
/root/autodl-tmp/stream2graph
```

### Option B: clone and prepare on cloud

```bash
cd /root/autodl-tmp
git clone https://github.com/linlinlin-zhang/stream2graph.git
cd stream2graph
```

## 4. Optional but recommended: log in to Hugging Face

```bash
export HF_TOKEN=<your_hf_token>
huggingface-cli login --token "$HF_TOKEN"
```

## 5. Build the environment

```bash
cd /root/autodl-tmp/stream2graph
bash tools/finetune/bootstrap_local_finetune_env.sh /root/autodl-tmp/stream2graph/.venv-finetune
```

The bootstrap script now defaults to the `cu128` PyTorch wheels and explicit
`PyTorch 2.8.0` package versions, which is the recommended match when your
cloud image is `Ubuntu 22.04 + PyTorch 2.8 + CUDA 12.8`.

If you later switch to a different image family, you can override the wheel
channel explicitly:

```bash
TORCH_WHL_CHANNEL=cu118 \
  bash tools/finetune/bootstrap_local_finetune_env.sh /root/autodl-tmp/stream2graph/.venv-finetune
```

## 6. Make sure the base models are available

If you transferred the local cache, verify it exists under:

```bash
artifacts/model_cache/qwen35_incremental
```

If you need to download on cloud, run:

```bash
python tools/finetune/prefetch_hf_models.py --cache-dir artifacts/model_cache/qwen35_incremental
```

If `Qwen3.5-27B` stalls under concurrent snapshot download, switch to the serial
mode:

```bash
python tools/finetune/prefetch_hf_models.py \
  --cache-dir artifacts/model_cache/qwen35_incremental \
  --model Qwen/Qwen3.5-27B \
  --download-mode serial
```

## 7. Start the finetune runs

### Gate finetune

```bash
cd /root/autodl-tmp/stream2graph
bash tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh
```

### Planner finetune

```bash
cd /root/autodl-tmp/stream2graph
bash tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh
```

For your `RTX PRO 6000 96GB` machine, use the hardware-tuned configs:

```bash
cd /root/autodl-tmp/stream2graph
CONFIG_PATH=/root/autodl-tmp/stream2graph/configs/finetune/qwen35_4b_gate_cloud_rtxpro6000_96g.json \
  bash tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh

CONFIG_PATH=/root/autodl-tmp/stream2graph/configs/finetune/qwen35_27b_planner_cloud_rtxpro6000_96g.json \
  bash tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh
```

If you want to watch training progress directly in the terminal, run in
foreground mode:

```bash
FOREGROUND=1 \
CONFIG_PATH=/root/autodl-tmp/stream2graph/configs/finetune/qwen35_4b_gate_cloud_rtxpro6000_96g.json \
  bash tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh

FOREGROUND=1 \
CONFIG_PATH=/root/autodl-tmp/stream2graph/configs/finetune/qwen35_27b_planner_cloud_rtxpro6000_96g.json \
  bash tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh
```

These launchers will:

- regenerate the SFT dataset from the official public clean benchmark
- start QLoRA training in the background
- write logs to `reports/finetune/*.log`
- save adapters under `artifacts/finetune/`

## 8. Monitor logs

Gate:

```bash
tail -n 200 -f reports/finetune/qwen35_4b_incremental_gate_cloud_autodl.log
```

Planner:

```bash
tail -n 200 -f reports/finetune/qwen35_27b_incremental_planner_cloud_autodl.log
```

## 9. Four-way post-finetune ablation

After adapters are ready, run the four comparison experiments:

```bash
cd /root/autodl-tmp/stream2graph
bash tools/finetune/run_cloud_incremental_qwen35_ablation_eval.sh
```

This evaluates:

- finetuned gate + finetuned planner
- finetuned gate + base planner
- base gate + finetuned planner
- base gate + base planner

Useful environment overrides:

```bash
export SPLIT=validation
export MAX_SAMPLES=0
export GATE_ADAPTER=/root/autodl-tmp/stream2graph/artifacts/finetune/qwen35_4b_incremental_gate_cloud_autodl/final_adapter
export PLANNER_ADAPTER=/root/autodl-tmp/stream2graph/artifacts/finetune/qwen35_27b_incremental_planner_cloud_autodl/final_adapter
```

## 10. Outputs

- prepared gate dataset:
  `data/finetune/incremental_gate_sft_cloud`
- prepared planner dataset:
  `data/finetune/incremental_planner_sft_cloud`
- gate adapter:
  `artifacts/finetune/qwen35_4b_incremental_gate_cloud_autodl/final_adapter`
- planner adapter:
  `artifacts/finetune/qwen35_27b_incremental_planner_cloud_autodl/final_adapter`
- benchmark outputs:
  `reports/evaluation/runs/incremental_system`

## 11. Re-attach after disconnect

```bash
tmux attach -t stream2graph
```

## 12. Stop runs manually

Gate:

```bash
kill "$(cat reports/finetune/qwen35_4b_incremental_gate_cloud_autodl.pid)"
```

Planner:

```bash
kill "$(cat reports/finetune/qwen35_27b_incremental_planner_cloud_autodl.pid)"
```

## Notes

- The training path is QLoRA with 4-bit loading, not full finetuning.
- The benchmark dataset bundled for release and default training is
  `incremental_open_balanced_v1_3360_public_clean`.
- If local `27B` transfer is incomplete, the safest fallback is to upload the
  project bundle and let cloud download only the missing `27B` base model.
