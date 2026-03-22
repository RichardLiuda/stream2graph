# Incremental Qwen3.5 Finetune Prep

This document freezes the current finetune preparation path for the incremental Stream2Graph system.

## Target models

- small gate model: `Qwen/Qwen3.5-4B`
- large planner model: `Qwen/Qwen3.5-27B`

The previous `Qwen3-14B` probe path is no longer the mainline for this project.

## Finetune data source

The current official benchmark and default finetune-preparation source now align on:

- `data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean`

This gives the finetune path the same balanced, open-license, benchmark-grade
distribution that the current evaluation framework uses by default.

The older internal clean derivative remains available as a legacy source:

- `data/incremental_dataset/runs/minimax_m27_incremental_full_v1_clean`

## What is prepared

- gate SFT dataset exporter:
  - `tools/incremental_finetune/prepare_gate_sft_dataset.py`
- planner SFT dataset exporter:
  - `tools/incremental_finetune/prepare_planner_sft_dataset.py`
- generic QLoRA trainer:
  - `tools/finetune/train_qwen3_lora.py`
- local smoke launchers:
  - `tools/finetune/run_local_qwen35_4b_gate_smoke.sh`
  - `tools/finetune/run_local_qwen35_27b_planner_smoke.sh`
- cloud launchers:
  - `tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh`
  - `tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh`
- RTX PRO 6000 96GB cloud configs:
  - `configs/finetune/qwen35_4b_gate_cloud_rtxpro6000_96g.json`
  - `configs/finetune/qwen35_27b_planner_cloud_rtxpro6000_96g.json`
- local HF incremental benchmark templates:
  - `configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_validation.example.json`
  - `configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full.example.json`
- model prefetch helper:
  - `tools/finetune/prefetch_hf_models.py`
- transfer bundle exporter:
  - `tools/finetune/export_incremental_qwen35_bundle.py`

## Suggested workflow

1. Prefetch or prepare the base model cache locally:

```bash
python tools/finetune/prefetch_hf_models.py --cache-dir artifacts/model_cache/qwen35_incremental
```

This helper pulls the official Hugging Face snapshots for `Qwen/Qwen3.5-4B` and
`Qwen/Qwen3.5-27B` into the local cache directory. By default these are the base
`safetensors` checkpoints, not GGUF / GPTQ / AWQ quantized variants.

If the large `27B` snapshot stalls under concurrent download, prefer the new
serial shard mode:

```bash
python tools/finetune/prefetch_hf_models.py \
  --cache-dir artifacts/model_cache/qwen35_incremental \
  --model Qwen/Qwen3.5-27B \
  --download-mode serial
```

2. Build the local finetune environment:

```bash
bash tools/finetune/bootstrap_local_finetune_env.sh
```

3. Prepare and smoke-test the gate path:

```bash
bash tools/finetune/run_local_qwen35_4b_gate_smoke.sh
```

4. Prepare and smoke-test the planner path:

```bash
bash tools/finetune/run_local_qwen35_27b_planner_smoke.sh
```

5. Export a cloud-transfer-ready bundle:

```bash
python tools/finetune/export_incremental_qwen35_bundle.py --include-optional-dirs
```

## Cloud notes

- Use `tools/finetune/run_cloud_qwen35_4b_gate_autodl.sh` for the gate model.
- Use `tools/finetune/run_cloud_qwen35_27b_planner_autodl.sh` for the planner model.
- Both cloud launchers now support `CONFIG_PATH=...` overrides for hardware-specific configs.
- Keep the repo on fast local cloud storage such as `/root/autodl-tmp`.

## Testing after finetune

Once the adapters are produced, point the local-HF incremental benchmark templates to:

- gate adapter: `artifacts/finetune/qwen35_4b_incremental_gate/final_adapter`
- planner adapter: `artifacts/finetune/qwen35_27b_incremental_planner/final_adapter`

Then run:

```bash
python tools/eval/run_incremental_benchmark.py --config configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_validation.example.json
python tools/eval/run_incremental_benchmark.py --config configs/evaluation/model_benchmarks/incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full.example.json
```

For the four-way cloud ablation after finetune, use:

```bash
bash tools/finetune/run_cloud_incremental_qwen35_ablation_eval.sh
```

This runs the four combinations sequentially:

- finetuned gate + finetuned planner
- finetuned gate + base planner
- base gate + finetuned planner
- base gate + base planner
