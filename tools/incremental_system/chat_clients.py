from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


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
        self._last_request_started_at = 0.0
        self._request_gate = threading.Lock()

    def _wait_for_request_slot(self) -> None:
        with self._request_gate:
            wait_sec = self.request_interval_sec - (time.time() - self._last_request_started_at)
            if wait_sec > 0:
                time.sleep(wait_sec)
            self._last_request_started_at = time.time()

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
                with urllib.request.urlopen(request, timeout=self.timeout_sec) as response:
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
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc
            except urllib.error.URLError as exc:
                last_error = RuntimeError(f"URL error: {exc.reason}")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                    continue
                raise last_error from exc

        raise RuntimeError(str(last_error) if last_error else "OpenAI-compatible chat request failed.")
