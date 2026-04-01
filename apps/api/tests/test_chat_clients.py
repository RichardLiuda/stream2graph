from __future__ import annotations

import json
import ssl
import urllib.request
from types import SimpleNamespace

from app.services.realtime_coordination import build_chat_client
from tools.incremental_system.chat_clients import OpenAICompatibleChatClient


class _DummyResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


def test_build_chat_client_applies_runtime_tls_and_proxy_policy(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.get_settings",
        lambda: SimpleNamespace(tls_verify=False, ca_bundle=""),
    )

    client = build_chat_client(
        {
            "provider_kind": "openai_compatible",
            "endpoint": "https://llm.example.com/v1/chat/completions",
            "api_key": "secret",
        },
        "gate-model",
    )

    assert isinstance(client, OpenAICompatibleChatClient)
    assert client.disable_proxy is True
    assert client.ssl_context is not None
    assert client.ssl_context.verify_mode == ssl.CERT_NONE


def test_openai_chat_client_uses_proxyless_opener_when_requested(monkeypatch) -> None:
    ssl_context = ssl._create_unverified_context()
    captured: dict[str, object] = {}

    class _DummyOpener:
        def open(self, request, timeout=None):
            captured["request"] = request
            captured["timeout"] = timeout
            return _DummyResponse(
                {
                    "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                    "usage": {"total_tokens": 3},
                }
            )

    def _build_opener(*handlers):
        captured["handlers"] = handlers
        return _DummyOpener()

    monkeypatch.setattr("tools.incremental_system.chat_clients.urllib.request.build_opener", _build_opener)

    client = OpenAICompatibleChatClient(
        endpoint="https://llm.example.com/v1/chat/completions",
        model="planner-model",
        api_key="secret",
        ssl_context=ssl_context,
        disable_proxy=True,
    )

    result = client.chat([{"role": "user", "content": "hello"}])

    assert result.text == "ok"
    handlers = captured["handlers"]
    assert handlers
    assert handlers[0].proxies == {}
    https_handler = next(handler for handler in handlers if isinstance(handler, urllib.request.HTTPSHandler))
    assert https_handler._context is ssl_context
    assert captured["timeout"] == client.timeout_sec
