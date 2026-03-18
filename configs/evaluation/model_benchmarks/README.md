# Model Benchmark Configs

This folder is the canonical home for hand-authored large-model benchmark templates.

## Current active benchmark set

- `moonshot_kimi_benchmark.example.json`
  - Kimi 2.5, provider default reasoning, tuned to 80% of the current RPM/concurrency ceiling
- `minimax_benchmark.example.json`
  - MiniMax 2.5, provider default reasoning
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
