# Gemini And GPT Testing Platform

This document describes the formal evaluation workflows for:

- full-run GPT benchmarks
- official Google Gemini benchmark templates
- simplified direct-Google Gemini single-key benchmarks

Both workflows are built on the shared evaluation stack under `tools/eval/`.

## GPT full-run workflow

Use:

- `configs/evaluation/model_benchmarks/openai_gpt_benchmark.example.json`
- `tools/eval/run_openai_benchmark.py`

The current formal template is configured for:

- dataset: `V7`
- split: `test`
- full evaluation
- local `mmdc` compile validation

Example:

```bash
python tools/eval/run_openai_benchmark.py --config configs/evaluation/model_benchmarks/openai_gpt_benchmark.example.json
```

## GPT via OpenRouter

If you want to run OpenAI models through OpenRouter instead of the direct OpenAI API, use:

- `configs/evaluation/model_benchmarks/openrouter_gpt_benchmark.example.json`
- `tools/eval/run_openai_compatible_benchmark.py`

The current formal template is configured for:

- model: `openai/gpt-5.4`
- reasoning: `high`
- dataset: `V7`
- split: `test`
- local `mmdc` compile validation

Example:

```bash
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/openrouter_gpt_benchmark.example.json
```

This template is still available, but GPT is not part of the current active run plan.

## Gemini official Google template

Use:

- `configs/evaluation/model_benchmarks/gemini_benchmark.example.json`
- `tools/eval/run_gemini_benchmark.py`

The current formal template is configured for:

- model: `gemini-3-flash-preview`
- thinking: `high`
- request pacing: `1.0s` between request starts by default
- dataset: `V7`
- split: `test`
- local `mmdc` compile validation

Example:

```bash
python tools/eval/run_gemini_benchmark.py --config configs/evaluation/model_benchmarks/gemini_benchmark.example.json
```

## Optional single-key materialized workflow

If you want a fully resolved config file before running, materialize a single Gemini 3 Flash config from the template.

### 1. Materialize a resolved config

Use:

- `configs/evaluation/gemini3flash_v7_single_key.example.json`
- `tools/eval/materialize_api_shards.py`

Example:

```bash
python tools/eval/materialize_api_shards.py --config configs/evaluation/gemini3flash_v7_single_key.example.json
```

This creates:

- one `sample_ids.json`
- one fully resolved Gemini config
- one manifest

### 2. Run the generated config

The generated config can be run with the standard Google Gemini wrapper:

```bash
python tools/eval/run_gemini_benchmark.py --config configs/evaluation/generated_shards/gemini3flash_google_v7_single_key/gemini3flash_google_v7_test_shard01of01.config.json
```

### 3. Run scoring on the generated run output

```bash
python tools/eval/run_offline_metrics.py \
  --input-jsonl reports/evaluation/runs/google/gemini3flash_google_v7_test_shard01of01/inference/predictions.jsonl \
  --output-dir reports/evaluation/runs/google/gemini3flash_google_v7_test_shard01of01/offline \
  --compile-command "mmdc -i \"{input}\" -o \"{output}\""
```

Then build the report:

```bash
python tools/eval/build_benchmark_report.py \
  --offline-summary reports/evaluation/runs/google/gemini3flash_google_v7_test_shard01of01/offline/offline_metrics.summary.json \
  --output-dir reports/evaluation/runs/google/gemini3flash_google_v7_test_shard01of01/report \
  --title "Gemini 3 Flash Preview Stream2Graph Offline Benchmark"
```

## Notes

- `gemini-3-flash-preview` is the current configured Gemini model.
- The template keeps `thinkingLevel=high`, which Gemini 3 Flash supports on the official Google interface.
- The direct benchmark template now assumes one Google API key instead of the older multi-project shard plan.
- If you later need quota splitting again, `tools/eval/materialize_api_shards.py` can still produce multiple shards from the same benchmark template.
- GPT does not require sharding unless cost or rate limits make it necessary.
- The current active benchmark setup uses the direct Google single-key Gemini path, not OpenRouter Gemini.
