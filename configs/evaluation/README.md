# Evaluation Config Layout

This folder mixes stable templates and generated evaluation helpers. Use the groups below to keep new files predictable.

## Stable templates

- `model_benchmarks/`
  - canonical home for hand-authored large-model benchmark templates
  - includes the current active benchmark set:
    - Kimi 2.5 provider default
    - MiniMax 2.5 provider default
    - Gemini 3 Flash via the official Google interface with `thinkingLevel=high`
    - Qwen 3.5 with both thinking-on and thinking-off templates
    - Claude Sonnet 4.5 via a Claude-compatible chat-completions gateway
  - also includes optional GPT/OpenRouter and local-HF templates for side experiments
- `traditional_benchmark_*.example.json`
  - heuristic baseline benchmark templates that stay in the root
- `inference_release_test_*.example.json`
  - single-step unified inference templates
- `*_release_test_smoke.json`
  - small smoke configs for pipeline verification
- `paper_matrix_*.json`
  - experiment-matrix templates for paper-facing comparisons

## Generated configs

- `generated_shards/`
  - shard-specific configs and sample ID lists created by `tools/eval/materialize_api_shards.py`
  - safe to regenerate; avoid hand-editing unless you are debugging a specific shard run

## Naming rules

- Keep smoke, inference, and matrix configs in the root of `configs/evaluation/`.
- Keep reusable large-model benchmark templates in `configs/evaluation/model_benchmarks/`.
- Use `.example.json` for reusable templates that expect local edits.
- Use `smoke` in the file name for quick verification runs.
- Put generated multi-file outputs under a dedicated subfolder instead of adding more loose files at the root.

## Output pairing

- Configs here should normally write raw outputs to `reports/evaluation/runs/`.
- Only curated bundles should end up under `reports/evaluation/published/`.
