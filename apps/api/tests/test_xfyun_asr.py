from __future__ import annotations

import asyncio
import json
from urllib.parse import parse_qs, urlsplit

from app.models import RealtimeSession
from app.services import realtime_ai
from app.services.xfyun_asr import _collect_transcript, build_xfyun_asr_auth_url


def test_build_xfyun_asr_auth_url_contains_required_query_fields() -> None:
    signed = build_xfyun_asr_auth_url(
        "wss://iat-api.xfyun.cn/v2/iat",
        api_key="demo-key",
        api_secret="demo-secret",
        date_header="Mon, 30 Mar 2026 10:00:00 GMT",
    )
    parsed = urlsplit(signed)
    query = parse_qs(parsed.query)

    assert parsed.scheme == "wss"
    assert parsed.netloc == "iat-api.xfyun.cn"
    assert parsed.path == "/v2/iat"
    assert query["host"] == ["iat-api.xfyun.cn"]
    assert query["date"] == ["Mon, 30 Mar 2026 10:00:00 GMT"]
    assert query["authorization"][0]


def test_transcribe_audio_chunk_dispatches_to_xfyun_provider(session_factory, monkeypatch) -> None:
    with session_factory() as db:
        session_obj = RealtimeSession(
            title="xfyun stt session",
            status="active",
            config_snapshot={"runtime_options": {"stt_profile_id": "xfyun-stt", "stt_model": "iat"}},
        )
        db.add(session_obj)
        db.flush()

        monkeypatch.setattr(
            realtime_ai,
            "resolve_profile",
            lambda _db, kind, profile_id: {
                "id": "xfyun-stt",
                "provider_kind": "xfyun_asr",
                "endpoint": "wss://iat-api.xfyun.cn/v2/iat",
                "app_id": "demo-app",
                "api_key": "demo-key",
                "api_secret": "demo-secret",
                "default_model": "iat",
            },
        )
        monkeypatch.setattr(
            realtime_ai,
            "transcribe_pcm_s16le_with_xfyun",
            lambda **kwargs: {"text": "你好，世界", "sid": "sid-001", "latency_ms": 12.3},
        )

        result = realtime_ai.transcribe_audio_chunk(
            db,
            session_obj,
            {
                "pcm_s16le_base64": "AAA=",
                "sample_rate": 16000,
                "channel_count": 1,
            },
        )

    assert result["text"] == "你好，世界"
    assert result["provider"] == "xfyun-stt"
    assert result["model"] == "iat"
    assert result["sid"] == "sid-001"
    assert result["latency_ms"] == 12.3


def test_collect_transcript_accepts_zero_code_success_payload() -> None:
    class _DummyWs:
        def __init__(self) -> None:
            self._messages = [
                json.dumps(
                    {
                        "code": 0,
                        "message": "success",
                        "sid": "sid-001",
                        "data": {
                            "result": {
                                "sn": 1,
                                "ls": True,
                                "ws": [{"cw": [{"w": "测试"}]}],
                            },
                            "status": 2,
                        },
                    }
                )
            ]

        async def recv(self):
            if not self._messages:
                raise RuntimeError("no more messages")
            return self._messages.pop(0)

    result = asyncio.run(_collect_transcript(_DummyWs()))
    assert result["sid"] == "sid-001"
    assert result["text"] == "测试"
