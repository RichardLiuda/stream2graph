from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from tools.dialogue_regen.dataset import DialogueRegenSample, SYSTEM_PROMPT, build_messages


@dataclass
class DialogueGenerationResult:
    provider: str
    model_name: str
    raw_output_text: str
    latency_ms: float
    finish_reason: Optional[str] = None
    usage: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class DialogueGenerator(ABC):
    @abstractmethod
    def generate(self, sample: DialogueRegenSample) -> DialogueGenerationResult:
        raise NotImplementedError

    def close(self) -> None:
        return None


class ReferenceDialogueGenerator(DialogueGenerator):
    def __init__(self) -> None:
        self.provider = "reference_dialogue"
        self.model_name = "reference_dialogue"

    def generate(self, sample: DialogueRegenSample) -> DialogueGenerationResult:
        payload = {
            "sample_id": sample.sample_id,
            "dialogue_language": "unknown",
            "cscw_dialogue": sample.raw_sample.get("cscw_dialogue", []),
        }
        return DialogueGenerationResult(
            provider=self.provider,
            model_name=self.model_name,
            raw_output_text=json.dumps(payload, ensure_ascii=False, indent=2),
            latency_ms=0.0,
            finish_reason="reference_dialogue",
        )


class JSONHttpGenerator(DialogueGenerator):
    provider = "http_json"

    def __init__(self, config: dict[str, Any]) -> None:
        self.endpoint = str(config["endpoint"])
        self.model_name = str(config["model"])
        self.timeout_sec = int(config.get("timeout_sec", 180))
        self.max_retries = int(config.get("max_retries", 5))
        self.retry_backoff_sec = float(config.get("retry_backoff_sec", 3.0))
        self.request_interval_sec = float(config.get("request_interval_sec", 0.0))
        self._last_request_started_at = 0.0

    def _post_json(self, payload: dict, headers: dict[str, str]) -> dict:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={"Content-Type": "application/json", **headers},
            method="POST",
        )
        retryable_status_codes = {408, 429, 500, 502, 503, 504}
        last_error: Exception | None = None

        for attempt in range(1, self.max_retries + 1):
            wait_sec = self.request_interval_sec - (time.time() - self._last_request_started_at)
            if wait_sec > 0:
                time.sleep(wait_sec)
            self._last_request_started_at = time.time()
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_sec) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                last_error = RuntimeError(f"HTTP {exc.code}: {detail}")
                if exc.code in retryable_status_codes and attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc
            except urllib.error.URLError as exc:
                last_error = RuntimeError(f"URL error: {exc.reason}")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc

        raise RuntimeError(str(last_error) if last_error else "request failed without details")


class OpenAIResponsesGenerator(JSONHttpGenerator):
    provider = "openai_responses"

    def __init__(self, config: dict[str, Any]) -> None:
        endpoint = str(config.get("endpoint", "https://api.openai.com/v1/responses"))
        super().__init__({**config, "endpoint": endpoint})
        self.api_key_env = str(config.get("api_key_env", "OPENAI_API_KEY"))
        self.temperature = float(config.get("temperature", 0.2))
        self.max_output_tokens = int(config.get("max_output_tokens", 4096))

    def generate(self, sample: DialogueRegenSample) -> DialogueGenerationResult:
        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            return DialogueGenerationResult(
                provider=self.provider,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=f"missing environment variable: {self.api_key_env}",
            )
        try:
            messages = build_messages(sample)
            payload = {
                "model": self.model_name,
                "input": [
                    {
                        "role": messages[0]["role"],
                        "content": [{"type": "input_text", "text": messages[0]["content"]}],
                    },
                    {
                        "role": messages[1]["role"],
                        "content": [{"type": "input_text", "text": messages[1]["content"]}],
                    },
                ],
                "max_output_tokens": self.max_output_tokens,
                "temperature": self.temperature,
            }
            t0 = time.time()
            response = self._post_json(payload, {"Authorization": f"Bearer {api_key}"})
            latency_ms = (time.time() - t0) * 1000.0
            raw_text = self._extract_text(response)
            return DialogueGenerationResult(
                provider=self.provider,
                model_name=self.model_name,
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=response.get("status"),
                usage=response.get("usage", {}) if isinstance(response.get("usage"), dict) else {},
            )
        except Exception as exc:
            return DialogueGenerationResult(
                provider=self.provider,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=str(exc),
            )

    def _extract_text(self, response: dict[str, Any]) -> str:
        if isinstance(response.get("output_text"), str):
            return response["output_text"]
        chunks: list[str] = []
        for item in response.get("output", []):
            for content in item.get("content", []):
                text = content.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        return "\n".join(chunks).strip()


class OpenAICompatibleChatGenerator(JSONHttpGenerator):
    provider = "openai_compatible_chat"

    def __init__(self, config: dict[str, Any]) -> None:
        if not config.get("endpoint"):
            raise ValueError("OpenAI-compatible chat generator requires an endpoint.")
        super().__init__(config)
        self.provider_name = str(config.get("provider_name", config.get("provider", self.provider)))
        self.api_key_env = str(config.get("api_key_env", "OPENAI_API_KEY"))
        self.temperature = float(config.get("temperature", 0.2))
        self.max_tokens = int(config.get("max_tokens", config.get("max_output_tokens", 4096)))
        self.extra_body = config.get("extra_body", {}) if isinstance(config.get("extra_body"), dict) else {}

    def generate(self, sample: DialogueRegenSample) -> DialogueGenerationResult:
        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            return DialogueGenerationResult(
                provider=self.provider_name,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=f"missing environment variable: {self.api_key_env}",
            )
        try:
            payload = {
                "model": self.model_name,
                "messages": build_messages(sample),
                "max_tokens": self.max_tokens,
                "temperature": self.temperature,
            }
            payload.update(self.extra_body)
            t0 = time.time()
            response = self._post_json(payload, {"Authorization": f"Bearer {api_key}"})
            latency_ms = (time.time() - t0) * 1000.0
            return DialogueGenerationResult(
                provider=self.provider_name,
                model_name=self.model_name,
                raw_output_text=self._extract_text(response),
                latency_ms=round(latency_ms, 4),
                finish_reason=(
                    response["choices"][0].get("finish_reason")
                    if isinstance(response.get("choices"), list) and response.get("choices")
                    else None
                ),
                usage=response.get("usage", {}) if isinstance(response.get("usage"), dict) else {},
            )
        except Exception as exc:
            return DialogueGenerationResult(
                provider=self.provider_name,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=str(exc),
            )

    def _extract_text(self, response: dict[str, Any]) -> str:
        chunks: list[str] = []
        for choice in response.get("choices", []):
            message = choice.get("message", {})
            content = message.get("content")
            if isinstance(content, str):
                chunks.append(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        chunks.append(item["text"])
        return "\n".join(chunks).strip()


class AnthropicMessagesGenerator(JSONHttpGenerator):
    provider = "anthropic_messages"

    def __init__(self, config: dict[str, Any]) -> None:
        endpoint = str(config.get("endpoint", "https://api.anthropic.com/v1/messages"))
        super().__init__({**config, "endpoint": endpoint})
        self.provider_name = str(config.get("provider_name", config.get("provider", self.provider)))
        self.api_key_env = str(config.get("api_key_env", "ANTHROPIC_API_KEY"))
        self.temperature = float(config.get("temperature", 0.2))
        self.max_tokens = int(config.get("max_tokens", 4096))
        self.api_version = str(config.get("anthropic_version", "2023-06-01"))

    def generate(self, sample: DialogueRegenSample) -> DialogueGenerationResult:
        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            return DialogueGenerationResult(
                provider=self.provider_name,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=f"missing environment variable: {self.api_key_env}",
            )
        try:
            payload = {
                "model": self.model_name,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": sample.prompt}],
                "max_tokens": self.max_tokens,
                "temperature": self.temperature,
            }
            t0 = time.time()
            response = self._post_json(
                payload,
                {"x-api-key": api_key, "anthropic-version": self.api_version},
            )
            latency_ms = (time.time() - t0) * 1000.0
            raw_text = "\n".join(
                block.get("text", "")
                for block in response.get("content", [])
                if isinstance(block, dict)
            ).strip()
            response_model = response.get("model") if isinstance(response.get("model"), str) else self.model_name
            return DialogueGenerationResult(
                provider=self.provider_name,
                model_name=response_model,
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=response.get("stop_reason"),
                usage=response.get("usage", {}) if isinstance(response.get("usage"), dict) else {},
            )
        except Exception as exc:
            return DialogueGenerationResult(
                provider=self.provider_name,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=str(exc),
            )


class GeminiGenerateContentGenerator(JSONHttpGenerator):
    provider = "google_generate_content"

    def __init__(self, config: dict[str, Any]) -> None:
        api_key_env = str(config.get("api_key_env", "GOOGLE_API_KEY"))
        model_name = str(config["model"])
        api_key = os.environ.get(api_key_env, "")
        configured_endpoint = str(config.get("endpoint", "")).strip()
        endpoint = configured_endpoint or (
            f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        )
        super().__init__({**config, "endpoint": endpoint})
        self.api_key_env = api_key_env
        self.temperature = float(config.get("temperature", 0.2))
        self.max_output_tokens = int(config.get("max_output_tokens", 4096))
        self.thinking_budget = int(config.get("thinking_budget", 0))
        self.response_mime_type = str(config.get("response_mime_type", "")).strip()
        self.response_schema = config.get("response_schema")
        self.response_json_schema = config.get("response_json_schema")

    def generate(self, sample: DialogueRegenSample) -> DialogueGenerationResult:
        api_key = os.environ.get(self.api_key_env)
        if not api_key and "key=" not in self.endpoint:
            return DialogueGenerationResult(
                provider=self.provider,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=f"missing environment variable: {self.api_key_env}",
            )
        try:
            payload = {
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": sample.prompt}]}],
                "generationConfig": {
                    "temperature": self.temperature,
                    "maxOutputTokens": self.max_output_tokens,
                },
            }
            if self.thinking_budget >= 0:
                payload["generationConfig"]["thinkingConfig"] = {"thinkingBudget": self.thinking_budget}
            if self.response_mime_type:
                payload["generationConfig"]["responseMimeType"] = self.response_mime_type
            if self.response_schema is not None:
                payload["generationConfig"]["responseSchema"] = self.response_schema
            if self.response_json_schema is not None:
                payload["generationConfig"]["responseJsonSchema"] = self.response_json_schema
            t0 = time.time()
            response = self._post_json(payload, {})
            latency_ms = (time.time() - t0) * 1000.0
            raw_text = self._extract_text(response)
            finish_reason = None
            if isinstance(response.get("candidates"), list) and response.get("candidates"):
                finish_reason = response["candidates"][0].get("finishReason")
            return DialogueGenerationResult(
                provider=self.provider,
                model_name=self.model_name,
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=finish_reason,
                usage=response.get("usageMetadata", {}) if isinstance(response.get("usageMetadata"), dict) else {},
            )
        except Exception as exc:
            return DialogueGenerationResult(
                provider=self.provider,
                model_name=self.model_name,
                raw_output_text="",
                latency_ms=0.0,
                error=str(exc),
            )

    def _extract_text(self, response: dict[str, Any]) -> str:
        chunks: list[str] = []
        for candidate in response.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                text = part.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        return "\n".join(chunks).strip()


def build_generator(config: dict[str, Any]) -> DialogueGenerator:
    provider = str(config.get("provider", "reference_dialogue"))
    openai_compatible_providers = {
        "openai_compatible_chat",
        "moonshot_chat_completions",
        "deepseek_chat_completions",
        "minimax_chat_completions",
        "dashscope_chat_completions",
        "siliconflow_chat_completions",
    }
    if provider == "reference_dialogue":
        return ReferenceDialogueGenerator()
    if provider == "openai_responses":
        return OpenAIResponsesGenerator(config)
    if provider in openai_compatible_providers:
        return OpenAICompatibleChatGenerator(config)
    if provider == "anthropic_messages":
        return AnthropicMessagesGenerator(config)
    if provider == "google_generate_content":
        return GeminiGenerateContentGenerator(config)
    raise ValueError(f"Unsupported dialogue regeneration provider: {provider}")
