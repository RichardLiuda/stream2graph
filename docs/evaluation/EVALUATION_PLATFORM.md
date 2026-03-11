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
- `tools/eval/run_openai_compatible_benchmark.py`
  - benchmark entrypoint for official OpenAI-compatible providers such as Kimi, DeepSeek, MiniMax, Qwen DashScope, and SiliconFlow
- `tools/eval/export_run_bundle.py`
  - exports selected run outputs into a git-trackable bundle under `reports/evaluation/published/`
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
- `anthropic_messages`
  - frontier API baseline
- `google_generate_content`
  - frontier API baseline
- `static_jsonl`
  - reuse already-generated prediction files

## Actual evaluation flow

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
python tools/eval/run_openai_benchmark.py --config configs/evaluation/openai_gpt_benchmark.example.json
```

This wrapper writes resolved configs, runs inference and offline metrics, builds a report,
and can optionally publish a commit-ready bundle:

```bash
python tools/eval/run_openai_benchmark.py --model gpt-4.1 --split test --publish-bundle
```

### 7. Run Gemini with the official Google interface

```bash
python tools/eval/run_gemini_benchmark.py --config configs/evaluation/gemini_benchmark.example.json
```

### 8. Run Kimi / DeepSeek / MiniMax / Qwen / SiliconFlow with OpenAI-compatible endpoints

```bash
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/deepseek_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/moonshot_kimi_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/minimax_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/qwen_dashscope_benchmark.example.json
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/siliconflow_benchmark.example.json
```

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
- `openai_gpt_benchmark.example.json`
- `gemini_benchmark.example.json`
- `moonshot_kimi_benchmark.example.json`
- `deepseek_benchmark.example.json`
- `minimax_benchmark.example.json`
- `qwen_dashscope_benchmark.example.json`
- `siliconflow_benchmark.example.json`

These are intended to verify the pipeline without requiring model weights or API keys.
