# Claude Sonnet 4.5 Testing Platform

This document explains how Claude Sonnet 4.5 is wired into the existing Stream2Graph evaluation platform.

## What was added

- a dedicated provider alias: `claude_chat_completions`
- a reusable benchmark template:
  - `configs/evaluation/model_benchmarks/claude_sonnet45_benchmark.example.json`
- documentation so Claude runs show up as Claude in reports instead of being mislabeled as another OpenAI-compatible provider

## Endpoint and request shape

This integration uses the existing OpenAI-compatible benchmark runner:

```bash
python tools/eval/run_openai_compatible_benchmark.py --config configs/evaluation/model_benchmarks/claude_sonnet45_benchmark.example.json
```

The benchmark template is configured to call:

```text
https://api.richardliuda.top/v1/chat/completions
```

The payload shape follows the same OpenAI-compatible chat-completions flow already used by Kimi, Qwen, DeepSeek, SiliconFlow, and OpenRouter-backed models in this repo:

- `model`
- `messages`
- `max_tokens`
- `temperature`
- `Authorization: Bearer ...`

## Official-setting alignment

This template follows Anthropic's OpenAI-compatibility conventions in two places:

- the model is configured as `claude-sonnet-4-5`
- the API key variable defaults to `ANTHROPIC_API_KEY`

Two practical notes:

1. Anthropic's model overview often uses versioned model IDs for production stability.
2. The current gateway token was verified to expose `claude-sonnet-4-5`, not `4.6`.

If your gateway later exposes a newer Claude model, edit the `model` field in the benchmark config and switch it to the model ID your gateway actually serves.

## Current benchmark defaults

To stay comparable with the rest of this repo's model benchmarks, the template keeps the usual evaluation defaults:

- `temperature=0.0`
- `max_new_tokens=16384`
- `timeout_sec=180`
- `max_retries=6`
- `retry_backoff_sec=5.0`
- `request_interval_sec=0.5`
- `max_concurrency=1`

That means this platform uses Anthropic-style model naming and endpoint conventions, while still staying consistent with the repo's benchmark-control settings.

## Result layout

The template writes outputs to:

```text
reports/evaluation/runs/openai_compatible/claude_sonnet45_v7_test_full/
```

As with the other benchmark wrappers, the run produces:

- `configs/`
- `inference/`
- `offline/`
- `report/`
- `suite/`

## Recommended workflow

1. Set `ANTHROPIC_API_KEY` locally, or put a temporary key in the example config.
2. Verify the gateway accepts your chosen Claude Sonnet 4.5 model string.
3. Run the full benchmark with the config above.
4. If the gateway has stricter rate limits, tune `request_interval_sec` and `max_concurrency`.

## Official references

- Anthropic OpenAI SDK compatibility:
  - https://docs.anthropic.com/en/api/openai-sdk
- Anthropic model naming and versioned IDs:
  - https://docs.anthropic.com/en/docs/about-claude/models/all-models

## Source note

This platform is built on top of the repo's existing OpenAI-compatible evaluation path, not the native Anthropic `/v1/messages` runner. That choice is intentional because the requested gateway endpoint is `/v1/chat/completions`.
