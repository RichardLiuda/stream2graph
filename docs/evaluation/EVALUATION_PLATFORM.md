# Evaluation Platform

This document describes the evaluation platform built under `tools/eval/`.

## Purpose

The platform is designed to support a rigorous paper workflow with:

- unified inference for local and API models
- offline Mermaid-quality scoring
- realtime pipeline benchmarking
- summary report generation

## Folder structure

- `tools/eval/run_unified_inference.py`
  - runs the same held-out dataset through one predictor and stores normalized predictions
- `tools/eval/run_offline_metrics.py`
  - scores generated Mermaid code against references
- `tools/eval/run_realtime_metrics.py`
  - benchmarks the realtime pipeline on held-out dialogue samples
- `tools/eval/build_benchmark_report.py`
  - merges offline and realtime summaries into one report
- `tools/eval/run_eval_suite.py`
  - orchestration entrypoint that runs the full paper-style benchmark workflow
- `tools/eval/run_openai_benchmark.py`
  - GPT / OpenAI-specific benchmark entrypoint with retries, config materialization, and optional bundle publishing
- `tools/eval/run_gemini_benchmark.py`
  - Gemini-specific benchmark entrypoint for the official Google interface
- `tools/eval/materialize_api_shards.py`
  - generates shard-specific sample ID files and per-shard configs for quota-limited API models such as Gemini
- `tools/eval/merge_prediction_shards.py`
  - merges disjoint shard prediction JSONL files back into one ordered prediction file
- `tools/eval/run_openai_compatible_benchmark.py`
  - benchmark entrypoint for official or gateway-based OpenAI-compatible providers such as Claude-compatible gateways, Kimi, DeepSeek, MiniMax, Qwen DashScope, and SiliconFlow
- `tools/eval/run_local_hf_benchmark.py`
  - benchmark entrypoint for local or cloud-hosted open-weight models loaded via Hugging Face + optional LoRA adapters
- `tools/eval/run_traditional_benchmark.py`
  - heuristic / traditional baseline benchmark entrypoint that runs both offline and realtime evaluation
- `tools/eval/incremental_dataset.py`
  - loads the new staged incremental dataset splits from `data/incremental_dataset/runs/.../selection/`
- `tools/eval/run_incremental_inference.py`
  - runs the new incremental core system on staged dialogue/state samples and stores one summary row plus one detailed JSON per sample
- `tools/eval/run_incremental_metrics.py`
  - aggregates incremental-system metrics such as stage coverage, final state match, and update-count accuracy
- `tools/eval/run_incremental_benchmark.py`
  - wrapper that materializes configs and runs incremental inference + incremental metrics in one command
- `tools/eval/materialize_experiment_matrix.py`
  - materializes paper-oriented experiment matrices into per-run configs and can optionally execute them
- `tools/eval/export_run_bundle.py`
  - exports selected run outputs into a git-trackable bundle under `reports/evaluation/published/`
- `tools/eval/traditional_baselines.py`
  - rule-based dialogue-to-diagram baseline built on the existing realtime heuristic pipeline
- `tools/eval/common.py`
  - shared path and JSON helpers
- `tools/eval/dataset.py`
  - release dataset loading and prompt rendering
- `tools/eval/predictors.py`
  - predictor backends for local Hugging Face models and API models
- `tools/eval/metrics.py`
  - Mermaid normalization, structure extraction, and scoring
- `tools/eval/reporting.py`
  - bucketed aggregation and markdown / CSV helpers

## Supported predictor types

- `gold_reference`
  - useful for smoke tests
- `huggingface_local`
  - local or cloud-hosted open-weight models, with optional LoRA adapter
- `openai_responses`
  - frontier API baseline
  - supports timeout, retry, backoff, and request pacing controls
- `moonshot_chat_completions`
  - official Moonshot / Kimi OpenAI-compatible endpoint
- `deepseek_chat_completions`
  - official DeepSeek OpenAI-compatible endpoint
- `minimax_chat_completions`
  - official MiniMax OpenAI-compatible endpoint
- `dashscope_chat_completions`
  - official Qwen DashScope OpenAI-compatible endpoint
- `siliconflow_chat_completions`
  - SiliconFlow-hosted open-weight models via OpenAI-compatible endpoint
- `claude_chat_completions`
  - Claude-compatible chat-completions gateway using Anthropic-style model naming on an OpenAI-compatible endpoint
- `anthropic_messages`
  - frontier API baseline
- `google_generate_content`
  - frontier API baseline
- `static_jsonl`
  - reuse already-generated prediction files
- `traditional_rule_based`
  - heuristic baseline built from the existing intent engine and incremental renderer

## Actual evaluation flow

## Incremental system flow

The legacy `tools/eval/dataset.py` path is still designed for the old task:

- full dialogue -> final Mermaid

For the new project direction, the recommended path is the incremental-system flow:

- staged dataset sample -> continuous dialogue prefix replay -> gate decision -> planner update -> current graph state

### A. Run a smoke benchmark on the new system

```bash
python tools/eval/run_incremental_benchmark.py --config configs/evaluation/incremental_oracle_smoke.example.json
```

### B. Test one advanced API planner while keeping the small model fixed

This is the recommended first comparison setup for frontier API models:

- keep the small gate model fixed
- only replace the large planner model

Example:

```bash
python tools/eval/run_incremental_benchmark.py --config configs/evaluation/model_benchmarks/incremental_openai_compatible_planner.example.json
```

The resulting run will contain:

- `inference/predictions.jsonl`
- `inference/details/*.json`
- `metrics/incremental_metrics.summary.json`
- `metrics/incremental_metrics.summary.md`

### 1. Run unified inference

Example:

```bash
python tools/eval/run_unified_inference.py --config configs/evaluation/inference_release_test_local_hf.example.json
```

This produces a prediction JSONL and a run manifest.

### 2. Run offline metrics

Example:

```bash
python tools/eval/run_offline_metrics.py --input-jsonl reports/evaluation/inference/qwen35_27b_sft_test/predictions.jsonl --output-dir reports/evaluation/offline/qwen35_27b_sft_test
```

Optional compile checking is supported through a custom command template, for example:

```bash
python tools/eval/run_offline_metrics.py \
  --input-jsonl reports/evaluation/inference/qwen35_27b_sft_test/predictions.jsonl \
  --output-dir reports/evaluation/offline/qwen35_27b_sft_test \
  --compile-command "mmdc -i {input} -o {output}"
```

### 3. Run realtime metrics

Example:

```bash
python tools/eval/run_realtime_metrics.py --config configs/evaluation/realtime_metrics_release_test_smoke.json
```

The realtime runner derives transcript-style chunks directly from held-out dialogue samples
and scores the current builtin pipeline.

### 4. Build a combined report

Example:

```bash
python tools/eval/build_benchmark_report.py --config configs/evaluation/benchmark_report_release_test_smoke.json
```

### 5. Run the full suite from one config

Example:

```bash
python tools/eval/run_eval_suite.py --config configs/evaluation/eval_suite_release_test_smoke.json
```

This is the recommended paper workflow entrypoint once the per-step configs are ready.

### 6. Run a GPT benchmark with one command

Example:

```bash
python tools/eval/run_openai_benchmark.py --model gpt-4.1 --split test --max-samples 100
```

Or with a saved config:

```bash
python tools/eval/run_openai_benchmark.py --config configs/evaluation/model_benchmarks/openai_gpt_benchmark.example.json
```

This wrapper writes resolved configs, runs inference and offline metrics, builds a report,
and can optionally publish a commit-ready bundle:

```bash
python tools/eval/run_openai_benchmark.py --model gpt-4.1 --split test --publish-bundle
```

### 7. Run Gemini 3 Flash with the official Google interface

```bash
python tools/eval/run_gemini_benchmark.py --config configs/evaluation/model_benchmarks/gemini_benchmark.example.json
```

If you want a fully resolved single-key config first, materialize it from the helper template:

```bash
python tools/eval/materialize_api_shards.py --config configs/evaluation/gemini3flash_v7_single_key.example.json
python tools/eval/run_gemini_benchmark.py --config configs/evaluation/generated_shards/gemini3flash_google_v7_single_key/gemini3flash_google_v7_test_shard01of01.config.json
```

### 8. Run Claude-compatible / Kimi / DeepSeek / MiniMax / Qwen / OpenRouter models with OpenAI-compatible endpoints

```bash
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/claude_sonnet45_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/deepseek_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/moonshot_kimi_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/minimax_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/qwen_dashscope_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/qwen_dashscope_benchmark_thinking_on.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/siliconflow_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/openrouter_gpt_benchmark.example.json
```

### 9. Run a local Hugging Face benchmark

```bash
python tools/eval/run_local_hf_benchmark.py --config configs/evaluation/model_benchmarks/local_hf_qwen35_27b_base_benchmark.example.json
```

Use the SFT template when the adapter is already available:

```bash
python tools/eval/run_local_hf_benchmark.py --config configs/evaluation/model_benchmarks/local_hf_qwen35_27b_sft_benchmark.example.json
```

### 10. Run the traditional heuristic baseline

```bash
python tools/eval/run_traditional_benchmark.py --config configs/evaluation/traditional_benchmark_smoke.json
```

This produces:

- a heuristic final Mermaid prediction file
- offline structure-quality scores
- realtime latency / stability scores
- a combined report

The current implementation can also inject a weak `diagram_type_proxy` intent label for
diagnostic intent scoring. That proxy is useful for internal comparison, but should not be
treated as a gold annotation in the paper.

### 11. Materialize the paper comparison matrix

```bash
python tools/eval/materialize_experiment_matrix.py --config configs/evaluation/paper_matrix_icmi_smoke.json
```

### 12. Repair only failed API samples

When an API run finishes with a small number of transport or quota failures, do not rerun the full split by default.
Instead:

1. Extract the failed sample IDs from the original prediction file.
2. Rerun inference only for those sample IDs into a new JSONL.
3. Merge the repaired JSONL in front of the original JSONL so repaired rows win by `sample_id`.
4. Recompute offline metrics and the report on the merged file.

Example:

```bash
python tools/eval/extract_failed_sample_ids.py \
  --input-jsonl reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/inference/predictions.jsonl \
  --output-json reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair/failed_sample_ids.json

python tools/eval/run_unified_inference.py \
  --config reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/configs/inference.json \
  --sample-ids-file reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair/failed_sample_ids.json \
  --output-jsonl reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair/predictions.repaired.jsonl \
  --manifest-output reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair/manifest.repaired.json

python tools/eval/merge_prediction_shards.py \
  --output-jsonl reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair/predictions.merged.jsonl \
  --split-dir versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v7_kimi_k25_fullregen_strict_20260313/splits \
  --split test \
  --input-jsonl reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair/predictions.repaired.jsonl \
  --input-jsonl reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/inference/predictions.jsonl
```

Important:

- write repaired outputs to a new JSONL, not the original `predictions.jsonl`
- do not rely on `resume` against the old JSONL because previously failed `sample_id`s are still treated as completed rows
- keep the repaired file first in `merge_prediction_shards.py` so the repaired rows override the old failures

## Main offline metrics

- normalized exact match
- normalized text similarity
- diagram type match
- line-level F1
- token-level F1
- node F1
- edge F1
- label F1
- optional compile success

## Main realtime metrics

- realtime pass rate
- e2e latency p95
- flicker mean
- mental-map mean
- runtime over transcript ratio
- updates emitted
- intent accuracy when gold intent labels are available

## Output convention

Generated evaluation artifacts should go under:

- `reports/evaluation/`
- `artifacts/evaluation/`
- `data/evaluation/`

The recommended split is:

- `reports/evaluation/runs/`
  - raw local or cloud outputs, ignored by git
- `reports/evaluation/published/`
  - curated bundles that should be committed back into the repository

## Smoke verification configs

The repository includes smoke configs under `configs/evaluation/`:

- `inference_release_test_gold_smoke.json`
- `offline_metrics_release_test_smoke.json`
- `realtime_metrics_release_test_smoke.json`
- `benchmark_report_release_test_smoke.json`
- `eval_suite_release_test_smoke.json`
- `model_benchmarks/openai_gpt_benchmark.example.json`
- `model_benchmarks/openrouter_gpt_benchmark.example.json`
- `model_benchmarks/gemini_benchmark.example.json`
- `gemini3flash_v7_single_key.example.json`
- `gemini31pro_v7_sharded_4way.example.json`
  - legacy compatibility alias for the old multi-project helper name; now resolves to the single-key Gemini 3 Flash materialization setup
- `model_benchmarks/moonshot_kimi_benchmark.example.json`
- `model_benchmarks/deepseek_benchmark.example.json`
- `model_benchmarks/minimax_benchmark.example.json`
- `model_benchmarks/qwen_dashscope_benchmark.example.json`
- `model_benchmarks/qwen_dashscope_benchmark_thinking_on.example.json`
- `model_benchmarks/siliconflow_benchmark.example.json`
- `model_benchmarks/local_hf_qwen35_27b_base_benchmark.example.json`
- `model_benchmarks/local_hf_qwen35_27b_sft_benchmark.example.json`
- `traditional_benchmark_smoke.json`
- `traditional_benchmark_full.example.json`
- `paper_matrix_icmi_smoke.json`
- `paper_matrix_icmi_main.example.json`

These are intended to verify the pipeline without requiring model weights or API keys.

See also:

- `docs/evaluation/GEMINI_GPT_TESTING_PLATFORM.md`
  - GPT template notes plus the current direct-Google single-key workflow for Gemini
