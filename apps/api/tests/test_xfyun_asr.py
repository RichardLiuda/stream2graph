from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlsplit

from app.models import RealtimeSession, VoiceprintFeature
from app.services import realtime_ai
from app.services.xfyun_asr import (
    RTASRRealtimeSessionStream,
    _group_role_segments,
    build_xfyun_asr_auth_url,
)


def test_build_xfyun_asr_auth_url_contains_required_query_fields() -> None:
    signed = build_xfyun_asr_auth_url(
        "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
        app_id="demo-app",
        api_key="demo-key",
        api_secret="demo-secret",
        uuid_value="demo-uuid",
        utc_value="2026-03-30T18:00:00+0800",
        role_type=2,
        feature_ids=["feature_alice", "feature_bob"],
        eng_spk_match=1,
    )
    parsed = urlsplit(signed)
    query = parse_qs(parsed.query)

    assert parsed.scheme == "wss"
    assert parsed.netloc == "office-api-ast-dx.iflyaisol.com"
    assert parsed.path == "/ast/communicate/v1"
    assert query["accessKeyId"] == ["demo-key"]
    assert query["appId"] == ["demo-app"]
    assert query["uuid"] == ["demo-uuid"]
    assert query["utc"] == ["2026-03-30T18:00:00+0800"]
    assert query["role_type"] == ["2"]
    assert query["feature_ids"] == ["feature_alice,feature_bob"]
    assert query["eng_spk_match"] == ["1"]
    assert query["signature"][0]


def test_transcribe_audio_chunk_dispatches_to_xfyun_provider(session_factory, monkeypatch) -> None:
    captured: dict[str, object] = {}

    with session_factory() as db:
        session_obj = RealtimeSession(
            title="xfyun stt session",
            status="active",
            config_snapshot={"runtime_options": {"stt_profile_id": "xfyun-stt", "stt_model": "iat"}},
        )
        db.add(session_obj)
        db.add(
            VoiceprintFeature(
                stt_profile_id="xfyun-stt",
                group_id="meeting_group",
                feature_id="feature_alice",
                speaker_label="Alice",
                feature_info="Alice",
                status="active",
                remote_payload={},
            )
        )
        db.flush()

        monkeypatch.setattr(
            realtime_ai,
            "resolve_profile",
            lambda _db, kind, profile_id: {
                "id": "xfyun-stt",
                "provider_kind": "xfyun_asr",
                "endpoint": "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
                "app_id": "demo-app",
                "api_key": "demo-key",
                "api_secret": "demo-secret",
                "default_model": "rtasr_llm",
                "voiceprint": {
                    "enabled": True,
                    "api_base": "https://office-api-personal-dx.iflyaisol.com",
                    "group_id": "meeting_group",
                },
            },
        )

        def _fake_transcribe(**kwargs):
            captured.update(kwargs)
            return {
                "text": "你好，世界",
                "speaker": "Alice",
                "segments": [
                    {
                        "seg_id": 1,
                        "text": "你好，世界",
                        "speaker": "Alice",
                        "role_index": 1,
                        "feature_id": "feature_alice",
                        "speaker_resolution_source": "rtasr_feature",
                    }
                ],
                "role_separated": True,
                "sid": "sid-001",
                "latency_ms": 12.3,
            }

        monkeypatch.setattr(realtime_ai, "transcribe_pcm_s16le_with_xfyun", _fake_transcribe)

        result = realtime_ai.transcribe_audio_chunk(
            db,
            session_obj,
            {
                "pcm_s16le_base64": "AAA=",
                "sample_rate": 16000,
                "channel_count": 1,
                "is_final": False,
                "speaker": "speaker",
            },
        )

    assert captured["session_id"] == session_obj.id
    assert captured["model"] == "rtasr_llm"
    assert captured["role_type"] == 2
    assert captured["feature_ids"] == ["feature_alice"]
    assert captured["eng_spk_match"] == 1
    assert captured["is_final"] is False
    assert result["text"] == "你好，世界"
    assert result["speaker"] == "Alice"
    assert result["provider"] == "xfyun-stt"
    assert result["model"] == "rtasr_llm"
    assert result["sid"] == "sid-001"
    assert result["role_separated"] is True
    assert result["segments"][0]["speaker"] == "Alice"


def test_group_role_segments_splits_words_by_role_and_feature_mapping() -> None:
    result = _group_role_segments(
        {
            "seg_id": 7,
            "ls": True,
            "cn": {
                "st": {
                    "rt": [
                        {
                            "ws": [
                                {"cw": [{"w": "你好", "rl": 1, "feature_id": "feature_alice"}]},
                                {"cw": [{"w": "，", "rl": 0}]},
                                {"cw": [{"w": "我来补充", "rl": 2}]},
                            ]
                        }
                    ]
                }
            },
        },
        fallback_speaker="speaker",
        feature_label_by_id={"feature_alice": "Alice"},
    )

    assert result["role_separated"] is True
    assert result["text"] == "你好，我来补充"
    assert result["speaker_count"] == 2
    assert result["segments"] == [
        {
            "seg_id": 7,
            "text": "你好，",
            "speaker": "Alice",
            "role_index": 1,
            "feature_id": "feature_alice",
            "speaker_resolution_source": "rtasr_feature",
            "word_begin": None,
            "word_end": None,
            "word_count": 2,
        },
        {
            "seg_id": 7,
            "text": "我来补充",
            "speaker": "role_2",
            "role_index": 2,
            "feature_id": "",
            "speaker_resolution_source": "rtasr_role",
            "word_begin": None,
            "word_end": None,
            "word_count": 1,
        },
    ]


def test_rtasr_session_stream_retries_once_after_connection_closed(monkeypatch) -> None:
    class _DummyWs:
        closed = False

        async def close(self) -> None:
            self.closed = True

    async def _fake_connect(_auth_url: str):
        return _DummyWs()

    async def _fake_receiver_loop(self):
        await asyncio.Future()

    send_calls = {"count": 0}

    async def _fake_send_audio_frames(self, _raw_pcm: bytes) -> None:
        send_calls["count"] += 1
        if send_calls["count"] == 1:
            raise RuntimeError("no close frame received or sent")
        self._segments.append(
            {
                "seg_id": 1,
                "text": "恢复后的文本",
                "speaker": "role_1",
                "role_index": 1,
                "feature_id": "",
                "speaker_resolution_source": "rtasr_role",
            }
        )

    async def _fake_wait_for_segments(self, *, start_count: int, is_final: bool) -> None:
        return None

    monkeypatch.setattr("app.services.xfyun_asr._websocket_connect", _fake_connect)
    monkeypatch.setattr(RTASRRealtimeSessionStream, "_receiver_loop", _fake_receiver_loop)
    monkeypatch.setattr(RTASRRealtimeSessionStream, "_send_audio_frames", _fake_send_audio_frames)
    monkeypatch.setattr(RTASRRealtimeSessionStream, "_wait_for_segments", _fake_wait_for_segments)

    stream = RTASRRealtimeSessionStream(
        session_id="session-1",
        endpoint="wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
        app_id="demo-app",
        api_key="demo-key",
        api_secret="demo-secret",
        sample_rate=16000,
        lang="autodialect",
        role_type=2,
        feature_ids=[],
        eng_spk_match=None,
        pd=None,
        feature_label_by_id={},
        fallback_speaker="speaker",
    )
    try:
        result = stream.submit_chunk(b"\x00\x01", is_final=False)
    finally:
        stream.close()

    assert send_calls["count"] == 2
    assert result["text"] == "恢复后的文本"
    assert result["speaker"] == "role_1"


def test_rtasr_session_stream_times_out_and_resets(monkeypatch) -> None:
    async def _fake_submit_chunk_async(self, raw_pcm: bytes, *, is_final: bool) -> dict[str, object]:
        await asyncio.sleep(60)
        return {}

    reset_calls = {"count": 0}

    async def _fake_reset_connection(self) -> None:
        reset_calls["count"] += 1

    monkeypatch.setattr(RTASRRealtimeSessionStream, "_submit_chunk_async", _fake_submit_chunk_async)
    monkeypatch.setattr(RTASRRealtimeSessionStream, "_reset_connection", _fake_reset_connection)

    stream = RTASRRealtimeSessionStream(
        session_id="session-timeout",
        endpoint="wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
        app_id="demo-app",
        api_key="demo-key",
        api_secret="demo-secret",
        sample_rate=16000,
        lang="autodialect",
        role_type=2,
        feature_ids=[],
        eng_spk_match=None,
        pd=None,
        feature_label_by_id={},
        fallback_speaker="speaker",
    )
    try:
        try:
            stream.submit_chunk(b"\x00\x01", is_final=False, timeout_sec=0.01)
            assert False, "expected timeout"
        except RuntimeError as exc:
            assert "响应超时" in str(exc)
    finally:
        stream.close()

    assert reset_calls["count"] >= 1


def test_rtasr_end_marker_omits_local_session_id_when_remote_missing() -> None:
    sent: list[str] = []

    class _DummyWs:
        async def send(self, payload: str) -> None:
            sent.append(payload)

        async def close(self) -> None:
            return None

    stream = RTASRRealtimeSessionStream(
        session_id="local-session-id",
        endpoint="wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
        app_id="demo-app",
        api_key="demo-key",
        api_secret="demo-secret",
        sample_rate=16000,
        lang="autodialect",
        role_type=2,
        feature_ids=[],
        eng_spk_match=None,
        pd=None,
        feature_label_by_id={},
        fallback_speaker="speaker",
    )
    try:
        stream._ws = _DummyWs()
        stream._remote_session_id = ""
        future = asyncio.run_coroutine_threadsafe(stream._send_end_marker(), stream._loop)
        future.result(timeout=2)
    finally:
        stream.close()

    assert sent == ['{"end": true}']
