from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from audio_helper.main import app


def test_capabilities_show_supported_for_mock_backend(monkeypatch) -> None:
    monkeypatch.setenv("S2G_HELPER_TRANSCRIBER", "mock")
    monkeypatch.setattr("audio_helper.main._platform_family", lambda: "macos")

    with TestClient(app) as client:
        response = client.get("/capabilities")

    assert response.status_code == 200
    payload = response.json()
    assert payload["capability_status"] == "supported"
    assert payload["transcriber_backend"] == "mock"


def test_capture_accepts_audio_chunk_with_mock_backend(monkeypatch) -> None:
    monkeypatch.setenv("S2G_HELPER_TRANSCRIBER", "mock")
    monkeypatch.setattr("audio_helper.main._platform_family", lambda: "macos")
    pcm = base64.b64encode(b"\x00\x00" * 1600).decode("utf-8")

    with TestClient(app) as client:
        started = client.post("/capture/start", json={"source_type": "system_audio_helper", "session_id": "session-1"})
        assert started.status_code == 200
        assert started.json()["ok"] is True

        chunk_response = client.post(
            "/capture/audio-chunk",
            json={
                "source_type": "system_audio_helper",
                "session_id": "session-1",
                "chunk_id": 0,
                "sample_rate": 16000,
                "channel_count": 1,
                "pcm_s16le_base64": pcm,
                "is_final": True,
            },
        )

    assert chunk_response.status_code == 200
    payload = chunk_response.json()
    assert payload["accepted"] is True
    assert payload["chunk_id"] == 0
