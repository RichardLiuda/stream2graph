# Model Benchmark Configs

This folder is the canonical home for hand-authored large-model benchmark templates.

## Current active benchmark set

- `moonshot_kimi_benchmark.example.json`
  - Kimi 2.5, provider default reasoning, tuned to 80% of the current RPM/concurrency ceiling
- `minimax_benchmark.example.json`
  - MiniMax 2.5, provider default reasoning
- `incremental_minimax_siliconflow_gate_validation.example.json`
  - Official incremental-system validation smoke with SiliconFlow Qwen3.5-4B as the gate and MiniMax-M2.7 as the planner, aligned to the current r12-stable framework defaults
- `incremental_minimax_siliconflow_gate_test_full.example.json`
  - Official incremental-system full-test template with SiliconFlow Qwen3.5-4B as the gate and MiniMax-M2.7 as the planner, aligned to the current r12-stable framework defaults
- `incremental_moonshot_k25_siliconflow_gate_validation.example.json`
  - Incremental-system validation smoke with SiliconFlow Qwen3.5-4B fixed as the gate and Moonshot Kimi K2.5 as the planner
- `incremental_qwen35plus_dashscope_siliconflow_gate_validation.example.json`
  - Incremental-system validation smoke with SiliconFlow Qwen3.5-4B fixed as the gate and DashScope Qwen3.5-Plus as the planner
- `incremental_qwen35plus_dashscope_thinking_on_siliconflow_gate_validation.example.json`
  - Incremental-system validation smoke with SiliconFlow Qwen3.5-4B fixed as the gate and DashScope Qwen3.5-Plus as the planner, with thinking enabled
- `incremental_gemini3flash_google_siliconflow_gate_validation.example.json`
  - Incremental-system validation smoke with SiliconFlow Qwen3.5-4B fixed as the gate and Gemini 3 Flash Preview on the official Google `generateContent` interface as the planner, with `thinkingLevel=high`
- `incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_validation.example.json`
  - Incremental-system validation smoke with locally hosted Hugging Face Qwen3.5-4B gate and Qwen3.5-27B planner adapters
- `incremental_gpt54_openrouter_siliconflow_gate_validation.example.json`
  - Incremental-system validation smoke with SiliconFlow Qwen3.5-4B fixed as the gate and GPT-5.4 through the configured OpenAI-compatible gateway as the planner, with reasoning=high
- `incremental_claude_sonnet45_siliconflow_gate_validation.example.json`
  - Incremental-system validation smoke with SiliconFlow Qwen3.5-4B fixed as the gate and Claude Sonnet 4.5 through the configured Claude-compatible gateway as the planner
- `gemini_benchmark.example.json`
  - Gemini 3 Flash Preview on the official Google interface, `thinkingLevel=high`, intended for the simplified single-key workflow
- `qwen_dashscope_benchmark.example.json`
  - Qwen 3.5, thinking explicitly off
- `qwen_dashscope_benchmark_thinking_on.example.json`
  - Qwen 3.5, thinking explicitly on
- `openrouter_gpt_benchmark.example.json`
  - GPT-5.4 via OpenRouter, retained as an optional template but not part of the current active run plan
- `claude_sonnet45_benchmark.example.json`
  - Claude Sonnet 4.5 via a Claude-compatible chat-completions gateway

## Frontier / direct API

- `openai_gpt_benchmark.example.json`
  - direct OpenAI benchmark template
- `openrouter_gpt_benchmark.example.json`
  - OpenAI models through OpenRouter
- `gemini_benchmark.example.json`
  - Gemini via the official Google interface for the single-key Flash workflow
- `claude_sonnet45_benchmark.example.json`
  - Claude Sonnet 4.5 through an Anthropic-style OpenAI-compatible endpoint

## Official OpenAI-compatible providers

- `moonshot_kimi_benchmark.example.json`
  - Moonshot / Kimi
- `deepseek_benchmark.example.json`
  - DeepSeek
- `minimax_benchmark.example.json`
  - MiniMax
- `qwen_dashscope_benchmark.example.json`
  - Qwen DashScope, thinking off
- `qwen_dashscope_benchmark_thinking_on.example.json`
  - Qwen DashScope, thinking on
- `siliconflow_benchmark.example.json`
  - SiliconFlow-hosted open-weight models
- `claude_sonnet45_benchmark.example.json`
  - Claude Sonnet 4.5 through a custom OpenAI-compatible Claude gateway

## Local open-weight models

- `local_hf_qwen35_27b_base_benchmark.example.json`
  - local Hugging Face base-model benchmark
- `local_hf_qwen35_27b_sft_benchmark.example.json`
  - local Hugging Face SFT benchmark

## Notes

- Smoke configs and single-step inference configs stay in the parent folder: `configs/evaluation/`.
- The traditional heuristic baseline also stays in the parent folder because it is not a large-model config.
- Incremental runners now default to a shared local key bundle at `configs/evaluation/model_benchmarks/api_keys.local.json`. Fill keys there once and keep the example templates themselves keyless.
- Incremental benchmark configs now support provider-specific `gate_omit_temperature` and `planner_omit_temperature` for models that only accept default temperature behavior.
- Incremental runner kinds now include `google_generate_content`, so Gemini can be evaluated in the same staged runtime and metrics pipeline as the OpenAI-compatible planners.
- Incremental runner kinds now also include `local_hf`, so locally hosted or cloud-hosted Hugging Face adapters can be evaluated inside the same staged runtime and metrics pipeline.
- Incremental benchmark summaries now expose layered quality signals: strict `final_matches_reference`, `canonicalized_match`, and semantic-structure F1 metrics in addition to stage-completion and latency metrics.
- The current official incremental benchmark run root is `data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean`.
- This official public-clean benchmark currently contains `3199` samples with near-balanced six-type coverage and fully clean structural self-checks.
