from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import RealtimeChunk, RealtimeSession
from app.services.runtime_sessions import drop_runtime


def test_realtime_session_workflow_requires_auth_and_persists_reports(
    client: TestClient,
    admin_client: TestClient,
    session_factory,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.routers.realtime.generate_mermaid_state",
        lambda db, obj: {
            "code": "flowchart TD\nA[Gateway] --> B[Parser]",
            "normalized_code": "flowchart TD\nA[Gateway] --> B[Parser]",
            "compile_ok": True,
            "render_ok": True,
            "provider": "test-llm",
            "model": "test-model",
            "latency_ms": 12.3,
            "error_message": None,
            "updated_at": 1,
        },
    )

    unauthorized = client.post("/api/v1/realtime/sessions", json={"title": "unauthorized"})
    assert unauthorized.status_code == 401

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "integration session",
            "dataset_version_slug": None,
            "min_wait_k": 1,
            "base_wait_k": 2,
            "max_wait_k": 4,
            "llm_profile_id": "test-llm",
            "llm_model": "test-model",
            "stt_profile_id": "test-stt",
            "stt_model": "test-stt-model",
            "client_context": {
                "input_source": "transcript",
                "capture_mode": "manual_text",
                "platform": "macos",
                "browser_family": "chrome",
                "capability_status": "supported",
                "capability_reason": "always available",
            },
        },
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    chunk = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks",
        json={
            "timestamp_ms": 0,
            "text": "First define gateway and parser.",
            "speaker": "expert",
            "is_final": True,
            "expected_intent": "sequential",
            "metadata": {
                "input_source": "transcript",
                "capture_mode": "manual_text",
                "platform": "macos",
                "browser_family": "chrome",
                "capability_status": "supported",
                "capability_reason": "always available",
            },
        },
    )
    assert chunk.status_code == 200
    assert chunk.json()["pipeline"]["meta"]["input_chunk_count"] == 1
    assert chunk.json()["pipeline"]["mermaid_state"]["provider"] == "test-llm"

    with session_factory() as db:
        saved_session = db.scalar(select(RealtimeSession).where(RealtimeSession.id == session_id))
        assert saved_session is not None
        assert saved_session.config_snapshot["input_runtime"]["input_source"] == "transcript"
        assert saved_session.config_snapshot["runtime_options"]["llm_profile_id"] == "test-llm"
        saved_chunk = db.scalar(select(RealtimeChunk).where(RealtimeChunk.session_id == session_id))
        assert saved_chunk is not None
        assert saved_chunk.meta_json["capture_mode"] == "manual_text"

    drop_runtime(session_id)
    restored = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/snapshot")
    assert restored.status_code == 200
    assert restored.json()["pipeline"]["meta"]["input_chunk_count"] == 1

    flushed = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/flush")
    assert flushed.status_code == 200
    assert "evaluation" in flushed.json()

    report = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/report")
    assert report.status_code == 200
    report_id = report.json()["report_id"]

    report_detail = admin_client.get(f"/api/v1/reports/{report_id}")
    assert report_detail.status_code == 200
    detail_payload = report_detail.json()
    assert detail_payload["report_type"] == "realtime_session"
    assert Path(detail_payload["json_path"]).exists()
    assert Path(detail_payload["markdown_path"]).exists()

    export_response = admin_client.get(
        "/api/v1/reports/exports/download",
        params={"target": "realtime", "fmt": "json"},
    )
    assert export_response.status_code == 200
    assert session_id in export_response.text

    closed = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/close")
    assert closed.status_code == 200
    assert closed.json()["closed"] is True


def test_runtime_options_and_audio_transcription_endpoint(
    admin_client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.routers.catalog.list_runtime_options",
        lambda db, include_secrets=False: {
            "llm_profiles": [
                {
                    "id": "llm-default",
                    "label": "LLM Default",
                    "provider_kind": "openai_compatible",
                    "models": ["model-a"],
                    "default_model": "model-a",
                }
            ],
            "stt_profiles": [
                {
                    "id": "stt-default",
                    "label": "STT Default",
                    "provider_kind": "openai_compatible",
                    "models": ["stt-a"],
                    "default_model": "stt-a",
                }
            ],
        },
    )
    monkeypatch.setattr(
        "app.routers.realtime.generate_mermaid_state",
        lambda db, obj: {
            "code": "flowchart TD\nA[Audio] --> B[Mermaid]",
            "normalized_code": "flowchart TD\nA[Audio] --> B[Mermaid]",
            "compile_ok": True,
            "render_ok": True,
            "provider": "llm-default",
            "model": "model-a",
            "latency_ms": 10.0,
            "error_message": None,
            "updated_at": 2,
        },
    )
    monkeypatch.setattr(
        "app.routers.realtime.transcribe_audio_chunk",
        lambda db, session_obj, payload: {
            "text": "识别出的系统音频文本",
            "provider": "stt-default",
            "model": "stt-a",
            "latency_ms": 88.6,
        },
    )

    runtime_options = admin_client.get("/api/v1/catalog/runtime-options")
    assert runtime_options.status_code == 200
    assert runtime_options.json()["llm_profiles"][0]["id"] == "llm-default"

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "audio session",
            "llm_profile_id": "llm-default",
            "llm_model": "model-a",
            "stt_profile_id": "stt-default",
            "stt_model": "stt-a",
            "client_context": {"input_source": "system_audio"},
        },
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    response = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/audio/transcriptions",
        json={
            "chunk_id": 0,
            "sample_rate": 16000,
            "channel_count": 1,
            "pcm_s16le_base64": "AAA=",
            "speaker": "system_audio",
            "is_final": True,
            "metadata": {"input_source": "system_audio", "capture_mode": "api_stt"},
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["text"] == "识别出的系统音频文本"
    assert payload["provider"] == "stt-default"
    assert payload["pipeline"]["mermaid_state"]["model"] == "model-a"


def test_runtime_options_can_be_saved_from_admin_ui(admin_client: TestClient) -> None:
    response = admin_client.put(
        "/api/v1/catalog/runtime-options/admin",
        json={
            "llm_profiles": [
                {
                    "id": "openai-main",
                    "label": "OpenAI Main",
                    "provider_kind": "openai_compatible",
                    "endpoint": "https://api.openai.com/v1/chat/completions",
                    "models": ["gpt-4.1-mini", "gpt-4.1"],
                    "default_model": "gpt-4.1-mini",
                    "api_key": "test-openai-key",
                    "api_key_env": "",
                }
            ],
            "stt_profiles": [
                {
                    "id": "openai-stt",
                    "label": "OpenAI STT",
                    "provider_kind": "openai_compatible",
                    "endpoint": "https://api.openai.com/v1/audio/transcriptions",
                    "models": ["gpt-4o-mini-transcribe"],
                    "default_model": "gpt-4o-mini-transcribe",
                    "api_key": "test-openai-key",
                    "api_key_env": "",
                }
            ],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["llm_profiles"][0]["endpoint"] == "https://api.openai.com/v1/chat/completions"
    assert payload["llm_profiles"][0]["api_key"] == "test-openai-key"

    admin_view = admin_client.get("/api/v1/catalog/runtime-options/admin")
    assert admin_view.status_code == 200
    assert admin_view.json()["llm_profiles"][0]["id"] == "openai-main"

    public_view = admin_client.get("/api/v1/catalog/runtime-options")
    assert public_view.status_code == 200
    assert public_view.json()["llm_profiles"][0]["id"] == "openai-main"
    assert "api_key" not in public_view.text


def test_runtime_model_probe_endpoint(admin_client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.routers.catalog.probe_runtime_models",
        lambda **kwargs: {
            "provider_kind": kwargs["provider_kind"],
            "models_endpoint": "https://api.openai.com/v1/models",
            "models": ["gpt-4.1", "gpt-4.1-mini"],
        },
    )

    response = admin_client.post(
        "/api/v1/catalog/runtime-options/admin/probe-models",
        json={
            "endpoint": "https://api.openai.com/v1/chat/completions",
            "provider_kind": "openai_compatible",
            "api_key": "test-key",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["models_endpoint"] == "https://api.openai.com/v1/models"
    assert payload["models"] == ["gpt-4.1", "gpt-4.1-mini"]


def test_study_participant_workflow_records_submission_survey_and_exports(
    client: TestClient,
    admin_client: TestClient,
) -> None:
    created_task = admin_client.post(
        "/api/v1/studies/tasks",
        json={
            "title": "用户研究任务",
            "description": "根据材料产出 Mermaid",
            "default_condition": "manual",
            "system_outputs": {
                "manual": "",
                "heuristic": "flowchart TD\nA[Heuristic]",
                "model_system": "flowchart TD\nA[Model]",
            },
        },
    )
    assert created_task.status_code == 200
    task_id = created_task.json()["task_id"]

    created_session = admin_client.post(
        f"/api/v1/studies/tasks/{task_id}/sessions",
        json={
            "participant_id": "P-001",
            "study_condition": "manual",
            "participant_code": "TESTP001",
        },
    )
    assert created_session.status_code == 200
    participant_code = created_session.json()["participant_code"]

    task_list = admin_client.get("/api/v1/studies/tasks")
    assert task_list.status_code == 200
    assert any(item["task_id"] == task_id for item in task_list.json())

    participant_view = client.get(f"/api/v1/studies/participant/{participant_code}")
    assert participant_view.status_code == 200
    assert participant_view.json()["status"] == "pending"

    started = client.post(f"/api/v1/studies/participant/{participant_code}/start")
    assert started.status_code == 200
    assert started.json()["status"] == "active"

    autosave = client.post(
        f"/api/v1/studies/participant/{participant_code}/autosave",
        json={
            "draft_output": "flowchart TD\nA[Draft] --> B[Node]",
            "input_transcript": "speaker: draft transcript",
        },
    )
    assert autosave.status_code == 200
    assert autosave.json()["draft_output"].startswith("flowchart TD")

    submitted = client.post(
        f"/api/v1/studies/participant/{participant_code}/submit",
        json={
            "final_output": "flowchart TD\nA[Final] --> B[Done]",
            "input_transcript": "speaker: final transcript",
        },
    )
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "submitted"
    assert submitted.json()["final_output"].startswith("flowchart TD")

    survey = client.post(
        f"/api/v1/studies/participant/{participant_code}/survey",
        json={
            "payload": {
                "usefulness": 6,
                "confidence": 5,
                "workload": 3,
                "notes": "integration test",
            }
        },
    )
    assert survey.status_code == 200
    assert survey.json()["payload"]["notes"] == "integration test"

    report_list = admin_client.get("/api/v1/reports")
    assert report_list.status_code == 200
    assert any(item["report_type"] == "study_session" for item in report_list.json())

    export_csv = admin_client.get(
        "/api/v1/reports/exports/download",
        params={"target": "studies", "fmt": "csv"},
    )
    assert export_csv.status_code == 200
    assert participant_code in export_csv.text
