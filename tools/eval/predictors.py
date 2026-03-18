from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from tools.eval.common import extract_mermaid_candidate
from tools.eval.dataset import EvaluationSample, SYSTEM_PROMPT, build_messages
from tools.eval.traditional_baselines import TraditionalBaselineRunner


def _resolve_api_key(env_name: str) -> str:
    value = os.environ.get(env_name, "")
    if value:
        return value
    if os.name != "nt":
        return ""
    try:
        import winreg  # type: ignore

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            registry_value, _ = winreg.QueryValueEx(key, env_name)
        if isinstance(registry_value, str) and registry_value:
            os.environ[env_name] = registry_value
            return registry_value
    except OSError:
        return ""
    return ""


@dataclass
class PredictionResult:
    provider: str
    model_name: str
    generated_code: str
    raw_output_text: str
    latency_ms: float
    finish_reason: Optional[str] = None
    usage: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class Predictor(ABC):
    supports_parallel = False

    @abstractmethod
    def predict(self, sample: EvaluationSample) -> PredictionResult:
        raise NotImplementedError

    def close(self) -> None:
        return None


class GoldReferencePredictor(Predictor):
    def __init__(self) -> None:
        self.provider = "gold_reference"
        self.model_name = "gold_reference"

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        return PredictionResult(
            provider=self.provider,
            model_name=self.model_name,
            generated_code=sample.reference_code,
            raw_output_text=sample.reference_code,
            latency_ms=0.0,
            finish_reason="gold_reference",
        )


class StaticJsonlPredictor(Predictor):
    def __init__(self, rows: list[dict], provider_name: str = "static_jsonl") -> None:
        self.provider = provider_name
        self.lookup = {str(row["sample_id"]): row for row in rows}
        self.model_name = provider_name

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        row = self.lookup.get(sample.sample_id)
        if row is None:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
                raw_output_text="",
                latency_ms=0.0,
                error=f"sample_id not found in static predictions: {sample.sample_id}",
            )
        text = str(row.get("generated_code") or row.get("raw_output_text") or "")
        return PredictionResult(
            provider=self.provider,
            model_name=str(row.get("model_name", self.model_name)),
            generated_code=extract_mermaid_candidate(text),
            raw_output_text=text,
            latency_ms=float(row.get("latency_ms", 0.0)),
            finish_reason=row.get("finish_reason"),
            usage=row.get("usage", {}) if isinstance(row.get("usage"), dict) else {},
            error=row.get("error"),
        )


class TraditionalRuleBasedPredictor(Predictor):
    def __init__(self, config: dict[str, Any]) -> None:
        self.provider = "traditional_rule_based"
        self.model_name = str(config.get("model", "traditional_rule_based"))
        self.runner = TraditionalBaselineRunner(
            turn_interval_ms=int(config.get("turn_interval_ms", 450)),
            realtime=bool(config.get("realtime", False)),
            time_scale=float(config.get("time_scale", 1.0)),
            max_chunks=int(config.get("max_chunks", 0)),
            min_wait_k=int(config.get("min_wait_k", 1)),
            base_wait_k=int(config.get("base_wait_k", 2)),
            max_wait_k=int(config.get("max_wait_k", 4)),
            expected_intent_strategy=str(config.get("expected_intent_strategy", "none")),
            diagram_export_style=str(config.get("diagram_export_style", "auto")),
        )

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        try:
            output = self.runner.run_sample(sample)
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code=output.generated_code,
                raw_output_text=output.raw_output_text,
                latency_ms=output.latency_ms,
                finish_reason="completed",
                usage=output.metadata,
            )
        except Exception as exc:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
                raw_output_text="",
                latency_ms=0.0,
                error=str(exc),
            )


class LocalHFPredictor(Predictor):
    def __init__(self, config: dict[str, Any]) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        self._torch = torch
        self.provider = "huggingface_local"
        self.model_name = str(config["model_name_or_path"])
        self.max_new_tokens = int(config.get("max_new_tokens", 2048))
        self.temperature = float(config.get("temperature", 0.0))
        self.top_p = float(config.get("top_p", 1.0))
        self.do_sample = bool(config.get("do_sample", False))

        dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
        model_kwargs: dict[str, Any] = {
            "torch_dtype": dtype,
            "low_cpu_mem_usage": True,
        }

        if bool(config.get("use_4bit", False)):
            model_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=dtype,
            )

        if config.get("attn_implementation"):
            model_kwargs["attn_implementation"] = config["attn_implementation"]

        gpu_memory_limit_mib = config.get("gpu_memory_limit_mib")
        cpu_memory_limit_gib = config.get("cpu_memory_limit_gib")
        if torch.cuda.is_available() and gpu_memory_limit_mib:
            max_memory: dict[Any, str] = {0: f"{int(gpu_memory_limit_mib)}MiB"}
            if cpu_memory_limit_gib:
                max_memory["cpu"] = f"{int(cpu_memory_limit_gib)}GiB"
            model_kwargs["device_map"] = "auto"
            model_kwargs["max_memory"] = max_memory

        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name, use_fast=False)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "left"

        model = AutoModelForCausalLM.from_pretrained(self.model_name, **model_kwargs)
        adapter_path = config.get("adapter_path")
        if adapter_path:
            model = PeftModel.from_pretrained(model, adapter_path)
            self.model_name = f"{self.model_name}+{adapter_path}"
        model.eval()
        self.model = model

    def _render_prompt(self, messages: list[dict[str, str]]) -> str:
        try:
            return self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            return self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        prompt = self._render_prompt(build_messages(sample))
        t0 = time.time()
        inputs = self.tokenizer(prompt, return_tensors="pt")
        if self._torch.cuda.is_available():
            inputs = {k: v.to(0) for k, v in inputs.items()}

        generation_kwargs = {
            "max_new_tokens": self.max_new_tokens,
            "do_sample": self.do_sample,
            "pad_token_id": self.tokenizer.pad_token_id,
            "eos_token_id": self.tokenizer.eos_token_id,
        }
        if self.do_sample:
            generation_kwargs["temperature"] = self.temperature
            generation_kwargs["top_p"] = self.top_p

        with self._torch.inference_mode():
            outputs = self.model.generate(**inputs, **generation_kwargs)

        prompt_len = int(inputs["input_ids"].shape[1])
        generated_ids = outputs[0][prompt_len:]
        raw_text = self.tokenizer.decode(generated_ids, skip_special_tokens=True)
        latency_ms = (time.time() - t0) * 1000.0
        return PredictionResult(
            provider=self.provider,
            model_name=self.model_name,
            generated_code=extract_mermaid_candidate(raw_text),
            raw_output_text=raw_text,
            latency_ms=round(latency_ms, 4),
            finish_reason="completed",
        )


class JSONHttpPredictor(Predictor):
    provider = "http_json"
    supports_parallel = True

    def __init__(self, config: dict[str, Any]) -> None:
        self.endpoint = str(config["endpoint"])
        self.model_name = str(config["model"])
        self.timeout_sec = int(config.get("timeout_sec", 180))
        self.max_retries = int(config.get("max_retries", 5))
        self.retry_backoff_sec = float(config.get("retry_backoff_sec", 3.0))
        self.request_interval_sec = float(config.get("request_interval_sec", 0.0))
        self._last_request_started_at = 0.0
        self._request_gate = threading.Lock()

    def _wait_for_request_slot(self) -> None:
        with self._request_gate:
            wait_sec = self.request_interval_sec - (time.time() - self._last_request_started_at)
            if wait_sec > 0:
                time.sleep(wait_sec)
            self._last_request_started_at = time.time()

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
            self._wait_for_request_slot()

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


class OpenAIResponsesPredictor(JSONHttpPredictor):
    provider = "openai_responses"

    def __init__(self, config: dict[str, Any]) -> None:
        endpoint = str(config.get("endpoint", "https://api.openai.com/v1/responses"))
        config = {**config, "endpoint": endpoint}
        super().__init__(config)
        self.api_key_env = str(config.get("api_key_env", "OPENAI_API_KEY"))
        self.temperature = float(config.get("temperature", 0.0))
        self.max_output_tokens = int(config.get("max_output_tokens", 2048))

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        api_key = _resolve_api_key(self.api_key_env)
        if not api_key:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
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
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code=extract_mermaid_candidate(raw_text),
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=response.get("status"),
                usage=response.get("usage", {}) if isinstance(response.get("usage"), dict) else {},
            )
        except Exception as exc:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
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


class OpenAICompatibleChatPredictor(JSONHttpPredictor):
    provider = "openai_compatible_chat"

    def __init__(self, config: dict[str, Any]) -> None:
        if not config.get("endpoint"):
            raise ValueError("OpenAI-compatible chat predictor requires an endpoint.")
        super().__init__(config)
        self.provider_name = str(config.get("provider_name", config.get("provider", self.provider)))
        self.api_key_env = str(config.get("api_key_env", "OPENAI_API_KEY"))
        self.temperature = float(config.get("temperature", 0.0))
        self.max_tokens = int(config.get("max_tokens", config.get("max_output_tokens", 2048)))
        self.extra_body = config.get("extra_body", {}) if isinstance(config.get("extra_body"), dict) else {}
        self.omit_temperature = bool(config.get("omit_temperature", False))

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        api_key = _resolve_api_key(self.api_key_env)
        if not api_key:
            return PredictionResult(
                provider=self.provider_name,
                model_name=self.model_name,
                generated_code="",
                raw_output_text="",
                latency_ms=0.0,
                error=f"missing environment variable: {self.api_key_env}",
            )

        try:
            payload = {
                "model": self.model_name,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": sample.prompt},
                ],
                "max_tokens": self.max_tokens,
            }
            if not self.omit_temperature:
                payload["temperature"] = self.temperature
            payload.update(self.extra_body)
            t0 = time.time()
            response = self._post_json(payload, {"Authorization": f"Bearer {api_key}"})
            latency_ms = (time.time() - t0) * 1000.0
            raw_text = self._extract_text(response)
            finish_reason = None
            if isinstance(response.get("choices"), list) and response.get("choices"):
                finish_reason = response["choices"][0].get("finish_reason")
            usage = response.get("usage", {}) if isinstance(response.get("usage"), dict) else {}
            if not usage and isinstance(response.get("choices"), list) and response.get("choices"):
                candidate_usage = response["choices"][0].get("usage")
                if isinstance(candidate_usage, dict):
                    usage = candidate_usage
            return PredictionResult(
                provider=self.provider_name,
                model_name=self.model_name,
                generated_code=extract_mermaid_candidate(raw_text),
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=finish_reason,
                usage=usage,
            )
        except Exception as exc:
            return PredictionResult(
                provider=self.provider_name,
                model_name=self.model_name,
                generated_code="",
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
                continue
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        text = item.get("text")
                        if isinstance(text, str):
                            chunks.append(text)
        return "\n".join(chunks).strip()


class AnthropicMessagesPredictor(JSONHttpPredictor):
    provider = "anthropic_messages"

    def __init__(self, config: dict[str, Any]) -> None:
        endpoint = str(config.get("endpoint", "https://api.anthropic.com/v1/messages"))
        config = {**config, "endpoint": endpoint}
        super().__init__(config)
        self.api_key_env = str(config.get("api_key_env", "ANTHROPIC_API_KEY"))
        self.temperature = float(config.get("temperature", 0.0))
        self.max_tokens = int(config.get("max_tokens", 2048))
        self.api_version = str(config.get("anthropic_version", "2023-06-01"))

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        api_key = _resolve_api_key(self.api_key_env)
        if not api_key:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
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
                {
                    "x-api-key": api_key,
                    "anthropic-version": self.api_version,
                },
            )
            latency_ms = (time.time() - t0) * 1000.0
            content_blocks = response.get("content", [])
            raw_text = "\n".join(block.get("text", "") for block in content_blocks if isinstance(block, dict)).strip()
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code=extract_mermaid_candidate(raw_text),
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=response.get("stop_reason"),
                usage=response.get("usage", {}) if isinstance(response.get("usage"), dict) else {},
            )
        except Exception as exc:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
                raw_output_text="",
                latency_ms=0.0,
                error=str(exc),
            )


class GeminiGenerateContentPredictor(JSONHttpPredictor):
    provider = "google_generate_content"

    def __init__(self, config: dict[str, Any]) -> None:
        api_key_env = str(config.get("api_key_env", "GOOGLE_API_KEY"))
        model_name = str(config["model"])
        api_key = _resolve_api_key(api_key_env)
        endpoint = str(config.get("endpoint", "")).strip()
        if not endpoint:
            endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
            if api_key:
                endpoint = f"{endpoint}?key={api_key}"
        config = {**config, "endpoint": endpoint}
        super().__init__(config)
        self.api_key_env = api_key_env
        self.temperature = float(config.get("temperature", 0.0))
        self.max_output_tokens = int(config.get("max_output_tokens", 2048))
        self.thinking_level = str(config.get("thinking_level", "")).strip().lower()

    def predict(self, sample: EvaluationSample) -> PredictionResult:
        api_key = _resolve_api_key(self.api_key_env)
        endpoint_key = ""
        try:
            endpoint_key = urllib.parse.parse_qs(urllib.parse.urlparse(self.endpoint).query).get("key", [""])[0]
        except Exception:
            endpoint_key = ""
        if not api_key and not endpoint_key:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
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
            if self.thinking_level in {"low", "medium", "high"}:
                payload["generationConfig"]["thinkingConfig"] = {"thinkingLevel": self.thinking_level}
            t0 = time.time()
            response = self._post_json(payload, {})
            latency_ms = (time.time() - t0) * 1000.0
            raw_text = self._extract_text(response)
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code=extract_mermaid_candidate(raw_text),
                raw_output_text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason=(
                    response.get("candidates", [{}])[0].get("finishReason")
                    if isinstance(response.get("candidates"), list) and response.get("candidates")
                    else None
                ),
                usage=response.get("usageMetadata", {}) if isinstance(response.get("usageMetadata"), dict) else {},
            )
        except Exception as exc:
            return PredictionResult(
                provider=self.provider,
                model_name=self.model_name,
                generated_code="",
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


def build_predictor(config: dict[str, Any], static_rows: Optional[list[dict]] = None) -> Predictor:
    provider = str(config.get("provider", "gold_reference"))
    openai_compatible_providers = {
        "openai_compatible_chat",
        "claude_chat_completions",
        "moonshot_chat_completions",
        "deepseek_chat_completions",
        "minimax_chat_completions",
        "dashscope_chat_completions",
        "siliconflow_chat_completions",
        "openrouter_chat_completions",
    }
    if provider == "gold_reference":
        return GoldReferencePredictor()
    if provider == "static_jsonl":
        return StaticJsonlPredictor(static_rows or [], provider_name=str(config.get("provider_name", provider)))
    if provider == "traditional_rule_based":
        return TraditionalRuleBasedPredictor(config)
    if provider == "huggingface_local":
        return LocalHFPredictor(config)
    if provider == "openai_responses":
        return OpenAIResponsesPredictor(config)
    if provider in openai_compatible_providers:
        return OpenAICompatibleChatPredictor(config)
    if provider == "anthropic_messages":
        return AnthropicMessagesPredictor(config)
    if provider == "google_generate_content":
        return GeminiGenerateContentPredictor(config)
    raise ValueError(f"Unsupported predictor provider: {provider}")
