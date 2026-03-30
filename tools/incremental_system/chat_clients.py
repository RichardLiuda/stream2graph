from __future__ import annotations

import json
import os
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol


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


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content") or ""
                if text:
                    parts.append(str(text))
        return "\n".join(parts).strip()
    return ""


@dataclass
class ChatResult:
    text: str
    latency_ms: float
    finish_reason: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    raw_response: dict[str, Any] = field(default_factory=dict)


class ChatCompletionClient(Protocol):
    model: str

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        ...


def _deep_merge_dicts(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge_dicts(dict(merged[key]), value)
        else:
            merged[key] = value
    return merged


class OpenAICompatibleChatClient:
    def __init__(
        self,
        endpoint: str,
        model: str,
        api_key: str = "",
        api_key_env: str = "OPENAI_API_KEY",
        timeout_sec: int = 180,
        max_retries: int = 5,
        retry_backoff_sec: float = 3.0,
        request_interval_sec: float = 0.0,
        extra_body: dict[str, Any] | None = None,
        omit_temperature: bool = False,
        temperature: float = 0.0,
        ssl_context: ssl.SSLContext | None = None,
        disable_proxy: bool = False,
    ) -> None:
        self.endpoint = endpoint
        self.model = model
        self.api_key = api_key or _resolve_api_key(api_key_env)
        self.timeout_sec = timeout_sec
        self.max_retries = max_retries
        self.retry_backoff_sec = retry_backoff_sec
        self.request_interval_sec = request_interval_sec
        self.extra_body = dict(extra_body or {})
        self.omit_temperature = omit_temperature
        self.temperature = temperature
        self.ssl_context = ssl_context
        self.disable_proxy = disable_proxy
        self._last_request_started_at = 0.0
        self._rate_limited_until = 0.0
        self._request_gate = threading.Lock()

    def _open_request(self, request: urllib.request.Request):
        if self.disable_proxy:
            handlers: list[urllib.request.BaseHandler] = [urllib.request.ProxyHandler({})]
            if self.ssl_context is not None:
                handlers.append(urllib.request.HTTPSHandler(context=self.ssl_context))
            opener = urllib.request.build_opener(*handlers)
            return opener.open(request, timeout=self.timeout_sec)
        if self.ssl_context is not None:
            return urllib.request.urlopen(request, timeout=self.timeout_sec, context=self.ssl_context)
        return urllib.request.urlopen(request, timeout=self.timeout_sec)

    def _wait_for_request_slot(self) -> None:
        with self._request_gate:
            now = time.time()
            provider_wait_sec = self._rate_limited_until - now
            request_wait_sec = self.request_interval_sec - (now - self._last_request_started_at)
            wait_sec = max(provider_wait_sec, request_wait_sec)
            if wait_sec > 0:
                time.sleep(wait_sec)
            self._last_request_started_at = time.time()

    def _set_rate_limit_pause(self, wait_sec: float) -> None:
        if wait_sec <= 0:
            return
        with self._request_gate:
            self._rate_limited_until = max(self._rate_limited_until, time.time() + wait_sec)

    def _retry_after_seconds(self, exc: urllib.error.HTTPError, detail: str, attempt: int) -> float:
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        if retry_after:
            try:
                return max(float(retry_after), 0.0)
            except ValueError:
                pass
        if "TPM limit reached" in detail:
            return max(self.retry_backoff_sec * attempt * 6.0, 30.0)
        if exc.code == 429:
            match = re.search(r"retry after[:\\s]+([0-9]+(?:\\.[0-9]+)?)", detail, flags=re.IGNORECASE)
            if match:
                return max(float(match.group(1)), 0.0)
            return max(self.retry_backoff_sec * attempt * 3.0, 15.0)
        return self.retry_backoff_sec * attempt

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        if not self.api_key:
            raise RuntimeError("Missing API key for OpenAI-compatible chat client.")

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            **self.extra_body,
        }
        if not self.omit_temperature:
            payload["temperature"] = self.temperature

        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        retryable_status_codes = {408, 429, 500, 502, 503, 504}
        last_error: Exception | None = None

        for attempt in range(1, self.max_retries + 1):
            self._wait_for_request_slot()
            started_at = time.time()
            try:
                with self._open_request(request) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                latency_ms = (time.time() - started_at) * 1000.0
                choice = (payload.get("choices") or [{}])[0]
                message = choice.get("message", {})
                return ChatResult(
                    text=_extract_text(message.get("content")),
                    latency_ms=round(latency_ms, 4),
                    finish_reason=str(choice.get("finish_reason", "")),
                    usage=payload.get("usage", {}) if isinstance(payload.get("usage"), dict) else {},
                    raw_response=payload,
                )
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                last_error = RuntimeError(f"HTTP {exc.code}: {detail}")
                if exc.code in retryable_status_codes and attempt < self.max_retries:
                    wait_sec = self._retry_after_seconds(exc, detail, attempt)
                    self._set_rate_limit_pause(wait_sec)
                    time.sleep(wait_sec)
                    continue
                raise last_error from exc
            except urllib.error.URLError as exc:
                last_error = RuntimeError(f"URL error: {exc.reason}")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc
            except (TimeoutError, socket.timeout) as exc:
                last_error = RuntimeError("The read operation timed out")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc

        raise RuntimeError(str(last_error) if last_error else "OpenAI-compatible chat request failed.")


class LocalHFChatClient:
    def __init__(
        self,
        endpoint: str,
        model: str,
        api_key: str = "",
        api_key_env: str = "OPENAI_API_KEY",
        timeout_sec: int = 180,
        max_retries: int = 5,
        retry_backoff_sec: float = 3.0,
        request_interval_sec: float = 0.0,
        extra_body: dict[str, Any] | None = None,
        omit_temperature: bool = False,
        temperature: float = 0.0,
    ) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        self.endpoint = endpoint
        self.model = model
        self.timeout_sec = timeout_sec
        self.max_retries = max_retries
        self.retry_backoff_sec = retry_backoff_sec
        self.request_interval_sec = request_interval_sec
        self.extra_body = dict(extra_body or {})
        self.omit_temperature = omit_temperature
        self.temperature = temperature
        self._torch = torch
        self._last_request_started_at = 0.0
        self._request_gate = threading.Lock()

        self.max_new_tokens = int(self.extra_body.get("max_new_tokens", self.extra_body.get("max_output_tokens", 2048)))
        self.top_p = float(self.extra_body.get("top_p", 1.0))
        self.do_sample = bool(self.extra_body.get("do_sample", False))
        self.enable_thinking = bool(self.extra_body.get("enable_thinking", False))
        self.trust_remote_code = bool(self.extra_body.get("trust_remote_code", False))
        self.adapter_path = str(self.extra_body.get("adapter_path", "")).strip()

        dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
        model_kwargs: dict[str, Any] = {
            "torch_dtype": dtype,
            "low_cpu_mem_usage": True,
            "trust_remote_code": self.trust_remote_code,
        }
        if bool(self.extra_body.get("use_4bit", False)):
            model_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=dtype,
            )
        attn_implementation = str(self.extra_body.get("attn_implementation", "")).strip()
        if attn_implementation:
            model_kwargs["attn_implementation"] = attn_implementation
        gpu_memory_limit_mib = self.extra_body.get("gpu_memory_limit_mib")
        cpu_memory_limit_gib = self.extra_body.get("cpu_memory_limit_gib")
        if torch.cuda.is_available() and gpu_memory_limit_mib:
            max_memory: dict[Any, str] = {0: f"{int(gpu_memory_limit_mib)}MiB"}
            if cpu_memory_limit_gib:
                max_memory["cpu"] = f"{int(cpu_memory_limit_gib)}GiB"
            model_kwargs["device_map"] = "auto"
            model_kwargs["max_memory"] = max_memory

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model,
            use_fast=False,
            trust_remote_code=self.trust_remote_code,
        )
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "left"

        model_instance = AutoModelForCausalLM.from_pretrained(self.model, **model_kwargs)
        if self.adapter_path:
            model_instance = PeftModel.from_pretrained(model_instance, self.adapter_path)
            self.model = f"{self.model}+{self.adapter_path}"
        model_instance.eval()
        self._model_instance = model_instance

    def _render_prompt(self, messages: list[dict[str, str]]) -> str:
        try:
            return self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=self.enable_thinking,
            )
        except TypeError:
            return self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        with self._request_gate:
            wait_sec = self.request_interval_sec - (time.time() - self._last_request_started_at)
            if wait_sec > 0:
                time.sleep(wait_sec)
            self._last_request_started_at = time.time()

            prompt = self._render_prompt(messages)
            started_at = time.time()
            inputs = self.tokenizer(prompt, return_tensors="pt")
            if self._torch.cuda.is_available():
                inputs = {key: value.to(0) for key, value in inputs.items()}

            generation_kwargs: dict[str, Any] = {
                "max_new_tokens": self.max_new_tokens,
                "do_sample": self.do_sample,
                "pad_token_id": self.tokenizer.pad_token_id,
                "eos_token_id": self.tokenizer.eos_token_id,
            }
            if self.do_sample:
                if not self.omit_temperature:
                    generation_kwargs["temperature"] = self.temperature
                generation_kwargs["top_p"] = self.top_p

            with self._torch.inference_mode():
                outputs = self._model_instance.generate(**inputs, **generation_kwargs)

            prompt_len = int(inputs["input_ids"].shape[1])
            generated_ids = outputs[0][prompt_len:]
            raw_text = self.tokenizer.decode(generated_ids, skip_special_tokens=True)
            latency_ms = (time.time() - started_at) * 1000.0
            return ChatResult(
                text=raw_text,
                latency_ms=round(latency_ms, 4),
                finish_reason="completed",
                usage={},
                raw_response={},
            )


class GeminiGenerateContentChatClient:
    def __init__(
        self,
        endpoint: str,
        model: str,
        api_key: str = "",
        api_key_env: str = "GOOGLE_API_KEY",
        timeout_sec: int = 180,
        max_retries: int = 5,
        retry_backoff_sec: float = 3.0,
        request_interval_sec: float = 0.0,
        extra_body: dict[str, Any] | None = None,
        omit_temperature: bool = False,
        temperature: float = 0.0,
    ) -> None:
        self.model = model
        self.api_key_env = api_key_env
        self.api_key = api_key or _resolve_api_key(api_key_env)
        self.endpoint = endpoint.strip() or f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        self.timeout_sec = timeout_sec
        self.max_retries = max_retries
        self.retry_backoff_sec = retry_backoff_sec
        self.request_interval_sec = request_interval_sec
        self.extra_body = dict(extra_body or {})
        self.omit_temperature = omit_temperature
        self.temperature = temperature
        self._last_request_started_at = 0.0
        self._rate_limited_until = 0.0
        self._request_gate = threading.Lock()

    def _wait_for_request_slot(self) -> None:
        with self._request_gate:
            now = time.time()
            provider_wait_sec = self._rate_limited_until - now
            request_wait_sec = self.request_interval_sec - (now - self._last_request_started_at)
            wait_sec = max(provider_wait_sec, request_wait_sec)
            if wait_sec > 0:
                time.sleep(wait_sec)
            self._last_request_started_at = time.time()

    def _set_rate_limit_pause(self, wait_sec: float) -> None:
        if wait_sec <= 0:
            return
        with self._request_gate:
            self._rate_limited_until = max(self._rate_limited_until, time.time() + wait_sec)

    def _retry_after_seconds(self, exc: urllib.error.HTTPError, detail: str, attempt: int) -> float:
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        if retry_after:
            try:
                return max(float(retry_after), 0.0)
            except ValueError:
                pass
        if "TPM limit reached" in detail:
            return max(self.retry_backoff_sec * attempt * 6.0, 30.0)
        if exc.code == 429:
            match = re.search(r"retry after[:\\s]+([0-9]+(?:\\.[0-9]+)?)", detail, flags=re.IGNORECASE)
            if match:
                return max(float(match.group(1)), 0.0)
            return max(self.retry_backoff_sec * attempt * 3.0, 15.0)
        return self.retry_backoff_sec * attempt

    def _endpoint_has_key(self) -> bool:
        try:
            parsed = urllib.parse.urlparse(self.endpoint)
            return bool(urllib.parse.parse_qs(parsed.query).get("key", [""])[0])
        except Exception:
            return False

    def _request_headers(self, api_key: str) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if api_key and not self._endpoint_has_key():
            headers["x-goog-api-key"] = api_key
        return headers

    def _build_payload(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        system_parts: list[dict[str, str]] = []
        contents: list[dict[str, Any]] = []
        for message in messages:
            role = str(message.get("role", "user")).strip().lower()
            text = _extract_text(message.get("content"))
            if not text:
                continue
            if role == "system":
                system_parts.append({"text": text})
                continue
            gemini_role = "model" if role == "assistant" else "user"
            contents.append({"role": gemini_role, "parts": [{"text": text}]})
        if not contents:
            contents = [{"role": "user", "parts": [{"text": ""}]}]

        payload: dict[str, Any] = {"contents": contents}
        if system_parts:
            payload["systemInstruction"] = {"parts": system_parts}
        if not self.omit_temperature:
            payload["generationConfig"] = {"temperature": self.temperature}
        return _deep_merge_dicts(payload, self.extra_body)

    def _extract_text(self, response: dict[str, Any]) -> str:
        chunks: list[str] = []
        for candidate in response.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                text = part.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        return "\n".join(chunks).strip()

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        api_key = self.api_key or _resolve_api_key(self.api_key_env)
        if not api_key and not self._endpoint_has_key():
            raise RuntimeError(f"Missing API key for Gemini generateContent client: {self.api_key_env}")

        body = json.dumps(self._build_payload(messages)).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers=self._request_headers(api_key),
            method="POST",
        )
        retryable_status_codes = {408, 429, 500, 502, 503, 504}
        last_error: Exception | None = None

        for attempt in range(1, self.max_retries + 1):
            self._wait_for_request_slot()
            started_at = time.time()
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_sec) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                latency_ms = (time.time() - started_at) * 1000.0
                finish_reason = None
                if isinstance(payload.get("candidates"), list) and payload.get("candidates"):
                    finish_reason = payload["candidates"][0].get("finishReason")
                return ChatResult(
                    text=self._extract_text(payload),
                    latency_ms=round(latency_ms, 4),
                    finish_reason=str(finish_reason or ""),
                    usage=payload.get("usageMetadata", {}) if isinstance(payload.get("usageMetadata"), dict) else {},
                    raw_response=payload,
                )
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                last_error = RuntimeError(f"HTTP {exc.code}: {detail}")
                if exc.code in retryable_status_codes and attempt < self.max_retries:
                    wait_sec = self._retry_after_seconds(exc, detail, attempt)
                    self._set_rate_limit_pause(wait_sec)
                    time.sleep(wait_sec)
                    continue
                raise last_error from exc
            except urllib.error.URLError as exc:
                last_error = RuntimeError(f"URL error: {exc.reason}")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc
            except (TimeoutError, socket.timeout) as exc:
                last_error = RuntimeError("The read operation timed out")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc

        raise RuntimeError(str(last_error) if last_error else "Gemini generateContent request failed.")
