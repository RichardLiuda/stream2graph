from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from tools.eval.common import strip_code_fences, strip_think_traces


def _resolve_api_key(env_name: str) -> str:
    return os.environ.get(env_name, "")


class QuotaPauseRequested(RuntimeError):
    pass


@dataclass
class QuotaStatus:
    remaining: int | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    checked_at_utc: str = ""
    source: str = ""


@dataclass
class MiniMaxResult:
    text: str
    raw_response: dict[str, Any]
    usage: dict[str, Any]
    latency_ms: float
    finish_reason: str | None = None
    reasoning: str = ""


class MiniMaxChatClient:
    def __init__(self, config: dict[str, Any]) -> None:
        self.endpoint = str(config.get("endpoint", "https://api.minimaxi.com/v1/chat/completions"))
        self.remains_endpoint = str(
            config.get("remains_endpoint", "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains")
        )
        self.api_key_env = str(config.get("api_key_env", "MINIMAX_API_KEY"))
        self.model = str(config.get("model", "MiniMax-M2.7"))
        self.max_tokens = int(config.get("max_tokens", 4096))
        self.temperature = float(config.get("temperature", 0.2))
        self.timeout_sec = int(config.get("timeout_sec", 180))
        self.max_retries = int(config.get("max_retries", 6))
        self.retry_backoff_sec = float(config.get("retry_backoff_sec", 5.0))
        self.request_interval_sec = float(config.get("request_interval_sec", 0.5))
        self.reasoning_split = bool(config.get("reasoning_split", True))
        self.extra_body = config.get("extra_body", {}) if isinstance(config.get("extra_body"), dict) else {}
        quota = config.get("quota", {}) if isinstance(config.get("quota"), dict) else {}
        self.quota_enabled = bool(quota.get("enabled", True))
        self.max_calls_per_window = int(quota.get("max_calls_per_window", 1500))
        self.window_hours = float(quota.get("window_hours", 5.0))
        self.min_remaining_prompts = int(quota.get("min_remaining_prompts", 5))
        self.poll_interval_calls = int(quota.get("poll_interval_calls", 25))
        self.window_started_at = time.time()
        self.calls_in_window = 0
        self.calls_since_quota_poll = 0
        self._last_request_started_at = 0.0
        self._last_quota_status = QuotaStatus()

    def chat(self, messages: list[dict[str, str]]) -> MiniMaxResult:
        api_key = _resolve_api_key(self.api_key_env)
        if not api_key:
            raise RuntimeError(f"missing environment variable: {self.api_key_env}")
        self._ensure_quota_available(api_key)
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "extra_body": {"reasoning_split": self.reasoning_split},
        }
        payload.update(self.extra_body)
        t0 = time.time()
        response = self._post_json(self.endpoint, payload, {"Authorization": f"Bearer {api_key}"})
        latency_ms = round((time.time() - t0) * 1000.0, 4)
        self.calls_in_window += 1
        self.calls_since_quota_poll += 1
        finish_reason = None
        if isinstance(response.get("choices"), list) and response["choices"]:
            finish_reason = response["choices"][0].get("finish_reason")
        return MiniMaxResult(
            text=self._extract_text(response),
            raw_response=response,
            usage=response.get("usage", {}) if isinstance(response.get("usage"), dict) else {},
            latency_ms=latency_ms,
            finish_reason=finish_reason,
            reasoning=self._extract_reasoning(response),
        )

    def current_quota_status(self) -> QuotaStatus:
        return self._last_quota_status

    def _ensure_quota_available(self, api_key: str) -> None:
        if not self.quota_enabled:
            return
        elapsed = time.time() - self.window_started_at
        if elapsed >= self.window_hours * 3600:
            self.window_started_at = time.time()
            self.calls_in_window = 0
            self.calls_since_quota_poll = 0
        if self.max_calls_per_window > 0 and self.calls_in_window >= self.max_calls_per_window:
            raise QuotaPauseRequested(
                f"reached local MiniMax call budget ({self.max_calls_per_window}) inside the current {self.window_hours}h window"
            )
        if self.calls_since_quota_poll == 0 or self.calls_since_quota_poll >= self.poll_interval_calls:
            self._last_quota_status = self._fetch_quota_status(api_key)
            self.calls_since_quota_poll = 0
        if self._last_quota_status.remaining is not None and self._last_quota_status.remaining <= self.min_remaining_prompts:
            raise QuotaPauseRequested(
                f"MiniMax coding plan remaining prompts is {self._last_quota_status.remaining}, below threshold {self.min_remaining_prompts}"
            )

    def _fetch_quota_status(self, api_key: str) -> QuotaStatus:
        try:
            payload = self._request_json(self.remains_endpoint, None, {"Authorization": f"Bearer {api_key}"}, method="GET")
            remaining = self._extract_remaining(payload)
            return QuotaStatus(
                remaining=remaining,
                payload=payload,
                checked_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                source=self.remains_endpoint,
            )
        except Exception as exc:
            return QuotaStatus(
                remaining=None,
                payload={"error": str(exc)},
                checked_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                source=self.remains_endpoint,
            )

    def _extract_remaining(self, payload: Any) -> int | None:
        matches: list[int] = []

        if isinstance(payload, dict) and isinstance(payload.get("model_remains"), list):
            preferred_models = {self.model.lower(), self.model.lower().replace(".7", ""), self.model.lower().replace(".5", "")}
            for item in payload["model_remains"]:
                if not isinstance(item, dict):
                    continue
                model_name = str(item.get("model_name", "")).lower()
                if preferred_models and model_name and model_name not in preferred_models:
                    continue
                interval_total = item.get("current_interval_total_count")
                interval_used = item.get("current_interval_usage_count")
                weekly_total = item.get("current_weekly_total_count")
                weekly_used = item.get("current_weekly_usage_count")
                if isinstance(interval_total, (int, float)) and isinstance(interval_used, (int, float)):
                    matches.append(max(0, int(interval_total - interval_used)))
                if isinstance(weekly_total, (int, float)) and isinstance(weekly_used, (int, float)):
                    matches.append(max(0, int(weekly_total - weekly_used)))

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                for key, item in value.items():
                    lowered = str(key).lower()
                    if any(token in lowered for token in ("remain_count", "remaining_count")) and isinstance(item, (int, float)):
                        matches.append(int(item))
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(payload)
        positives = [item for item in matches if item >= 0]
        return min(positives) if positives else None

    def _post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        return self._request_json(url, payload, headers, method="POST")

    def _request_json(
        self,
        url: str,
        payload: dict[str, Any] | None,
        headers: dict[str, str],
        method: str = "POST",
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", **headers},
            method=method,
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
        return strip_code_fences(strip_think_traces("\n".join(chunks).strip()))

    def _extract_reasoning(self, response: dict[str, Any]) -> str:
        chunks: list[str] = []
        for choice in response.get("choices", []):
            message = choice.get("message", {})
            details = message.get("reasoning_details")
            if isinstance(details, list):
                for item in details:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        chunks.append(item["text"])
        return "\n".join(chunks).strip()
