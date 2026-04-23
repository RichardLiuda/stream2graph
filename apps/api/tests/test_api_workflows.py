from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import utc_now
from app.models import RealtimeChunk, RealtimeSession, RealtimeSessionAnnotations, VoiceprintFeature, VoiceprintGroup
from app.services.realtime_coordination import GateDecision, PlannerDecision
from app.services.runtime_sessions import drop_runtime
from tools.incremental_dataset.schema import GraphGroup, GraphIR, GraphNode


def test_realtime_session_workflow_requires_auth_and_persists_reports(
    admin_client: TestClient,
    session_factory,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="enough structure",
            confidence=0.96,
            metadata={"provider": "test-gate", "model_name": "test-gate-model", "latency_ms": 7.1},
        ),
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[
                {"op": "add_node", "node_id": "Gateway", "id": "Gateway", "label": "Gateway"},
                {"op": "add_node", "node_id": "Parser", "id": "Parser", "label": "Parser"},
                {
                    "op": "add_edge",
                    "edge_id": "edge_gateway_parser",
                    "id": "edge_gateway_parser",
                    "source": "Gateway",
                    "target": "Parser",
                    "label": "",
                },
            ],
            notes="bootstrap graph",
            metadata={"provider": "test-planner", "model_name": "test-planner-model", "latency_ms": 12.3},
        ),
    )

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "integration session",
            "dataset_version_slug": None,
            "min_wait_k": 1,
            "base_wait_k": 2,
            "max_wait_k": 4,
            "gate_profile_id": "test-gate",
            "gate_model": "test-gate-model",
            "planner_profile_id": "test-planner",
            "planner_model": "test-planner-model",
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
    assert chunk.json()["pipeline"]["graph_state"]["update_index"] == 1
    assert chunk.json()["pipeline"]["planner_state"]["provider"] == "test-planner"
    assert chunk.json()["pipeline"]["mermaid_state"]["source"] == "algorithm_preview"

    with session_factory() as db:
        saved_session = db.scalar(select(RealtimeSession).where(RealtimeSession.id == session_id))
        assert saved_session is not None
        assert saved_session.config_snapshot["input_runtime"]["input_source"] == "transcript"
        assert saved_session.config_snapshot["runtime_options"]["gate_profile_id"] == "test-gate"
        assert saved_session.config_snapshot["runtime_options"]["planner_profile_id"] == "test-planner"
        saved_chunk = db.scalar(select(RealtimeChunk).where(RealtimeChunk.session_id == session_id))
        assert saved_chunk is not None
        assert saved_chunk.meta_json["capture_mode"] == "manual_text"

    drop_runtime(session_id)
    restored = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/snapshot")
    assert restored.status_code == 200
    assert restored.json()["pipeline"]["meta"]["input_chunk_count"] == 1
    assert restored.json()["pipeline"]["summary"]["latency_gate_ms"]["count"] == 1.0
    assert restored.json()["pipeline"]["summary"]["latency_planner_ms"]["count"] == 1.0


def test_realtime_chunk_batch_runs_single_coordination_cycle(
    admin_client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="enough structure",
            confidence=0.91,
            metadata={"provider": "test-gate", "model_name": "test-gate-model", "latency_ms": 5.0},
        ),
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[
                {"op": "add_node", "node_id": "Gateway", "id": "Gateway", "label": "Gateway"},
                {"op": "add_node", "node_id": "Manager", "id": "Manager", "label": "Manager"},
            ],
            notes="batch graph",
            metadata={"provider": "test-planner", "model_name": "test-planner-model", "latency_ms": 11.0},
        ),
    )

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "batch session",
            "gate_profile_id": "test-gate",
            "gate_model": "test-gate-model",
            "planner_profile_id": "test-planner",
            "planner_model": "test-planner-model",
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

    batch = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks/batch",
        json={
            "chunks": [
                {"timestamp_ms": 0, "text": "Add Gateway.", "speaker": "expert", "metadata": {"input_source": "transcript"}},
                {"timestamp_ms": 450, "text": "Add Manager.", "speaker": "expert", "metadata": {"input_source": "transcript"}},
            ]
        },
    )
    assert batch.status_code == 200
    payload = batch.json()
    assert payload["pipeline"]["meta"]["input_chunk_count"] == 2
    assert payload["pipeline"]["graph_state"]["update_index"] == 1
    assert payload["pipeline"]["planner_state"]["provider"] == "test-planner"
    assert len(payload["emitted_events"]) == 1
    assert payload["pipeline"]["transcript_state"]["turn_count"] == 2
    assert payload["pipeline"]["transcript_state"]["current_turn"]["text"] == "Add Manager."
    assert [row["text"] for row in payload["pipeline"]["transcript_state"]["archived_recent_turns"]] == ["Add Gateway."]
    assert [row["text"] for row in payload["pipeline"]["transcript_state"]["recent_turns"]] == [
        "Add Manager.",
        "Add Gateway.",
    ]

    flushed = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/flush")
    assert flushed.status_code == 200
    assert "evaluation" in flushed.json()
    assert flushed.json()["pipeline"]["transcript_state"]["turn_count"] == 2

    report = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/report")
    assert report.status_code == 200
    report_id = report.json()["report_id"]

    graph_report = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/graph")
    assert graph_report.status_code == 200
    graph_report_id = graph_report.json()["report_id"]

    report_detail = admin_client.get(f"/api/v1/reports/{report_id}")
    assert report_detail.status_code == 200
    detail_payload = report_detail.json()
    assert detail_payload["report_type"] == "realtime_session"
    assert Path(detail_payload["json_path"]).exists()
    assert Path(detail_payload["markdown_path"]).exists()

    graph_detail = admin_client.get(f"/api/v1/reports/{graph_report_id}")
    assert graph_detail.status_code == 200
    graph_payload = graph_detail.json()
    assert graph_payload["report_type"] == "realtime_graph"
    assert graph_payload["payload"]["graph_state"]["current_graph_ir"]["nodes"]

    export_response = admin_client.get(
        "/api/v1/reports/exports/download",
        params={"target": "realtime", "fmt": "json"},
    )
    assert export_response.status_code == 200
    assert session_id in export_response.text

    closed = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/close")
    assert closed.status_code == 200
    assert closed.json()["closed"] is True
    assert closed.json()["downloads"]["txt_url"].endswith(f"/api/v1/realtime/sessions/{session_id}/transcript/download?fmt=txt")
    assert closed.json()["downloads"]["markdown_url"].endswith(
        f"/api/v1/realtime/sessions/{session_id}/transcript/download?fmt=markdown"
    )
    assert closed.json()["transcript_summary"]["turn_count"] == 2

    txt_download = admin_client.get(f"/api/v1/realtime/sessions/{session_id}/transcript/download", params={"fmt": "txt"})
    assert txt_download.status_code == 200
    assert "attachment;" in txt_download.headers["content-disposition"]
    assert "[00:00.000 - 00:00.000] expert: Add Gateway." in txt_download.text
    assert "[00:00.450 - 00:00.450] expert: Add Manager." in txt_download.text

    md_download = admin_client.get(
        f"/api/v1/realtime/sessions/{session_id}/transcript/download",
        params={"fmt": "markdown"},
    )
    assert md_download.status_code == 200
    assert md_download.text.startswith("# batch session")
    assert "## Transcript" in md_download.text
    assert "### [00:00.450 - 00:00.450] expert" in md_download.text


def test_realtime_timeline_preview_and_apply_rollback(admin_client: TestClient, session_factory, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="emit",
            confidence=0.95,
            metadata={"provider": "test-gate", "model_name": "test-gate-model", "latency_ms": 5.5},
        ),
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[
                {"op": "add_node", "node_id": f"Node_{self.update_index + 1}", "id": f"Node_{self.update_index + 1}", "label": "Node"}
            ],
            notes="timeline node",
            metadata={"provider": "test-planner", "model_name": "test-planner-model", "latency_ms": 9.0},
        ),
    )

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={"title": "timeline rollback session", "client_context": {"input_source": "transcript", "capture_mode": "manual_text"}},
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    first = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks",
        json={"timestamp_ms": 0, "text": "first input", "speaker": "user", "is_final": True},
    )
    assert first.status_code == 200

    ann = admin_client.put(
        f"/api/v1/realtime/sessions/{session_id}/annotations",
        json={
            "version": 3,
            "payload": {
                "mermaid": {"items": [], "maskStrokes": []},
                "structure": {"items": [], "maskStrokes": []},
            },
        },
    )
    assert ann.status_code == 200

    snap = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/snapshot")
    assert snap.status_code == 200

    second = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks",
        json={"timestamp_ms": 450, "text": "second input", "speaker": "user", "is_final": True},
    )
    assert second.status_code == 200

    timeline = admin_client.get(f"/api/v1/realtime/sessions/{session_id}/timeline")
    assert timeline.status_code == 200
    nodes = timeline.json()["nodes"]
    assert len(nodes) >= 2
    preview_payload = None
    target_snapshot_id = None
    for row in nodes:
        current_snapshot_id = row["snapshot_id"]
        candidate_preview = admin_client.post(
            f"/api/v1/realtime/sessions/{session_id}/rollback/preview",
            json={"snapshot_id": current_snapshot_id},
        )
        assert candidate_preview.status_code == 200
        payload = candidate_preview.json()
        if payload.get("transcript_turn_count") == 1:
            target_snapshot_id = current_snapshot_id
            preview_payload = payload
            break
    assert target_snapshot_id is not None
    assert preview_payload is not None
    assert preview_payload["snapshot_id"] == target_snapshot_id

    applied = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/rollback/apply",
        json={"snapshot_id": target_snapshot_id},
    )
    assert applied.status_code == 200
    assert applied.json()["restored_from_snapshot_id"] == target_snapshot_id

    with session_factory() as db:
        chunks = db.scalars(select(RealtimeChunk).where(RealtimeChunk.session_id == session_id).order_by(RealtimeChunk.sequence_no.asc())).all()
        assert len(chunks) == 1
        assert chunks[0].text == "first input"
        ann_row = db.scalar(select(RealtimeSessionAnnotations).where(RealtimeSessionAnnotations.session_id == session_id))
        assert ann_row is not None
        assert int(ann_row.version) >= 1


def test_realtime_transcript_state_merges_stt_chunks_by_speaker_and_gap(
    admin_client: TestClient,
) -> None:
    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "stt merge session",
            "client_context": {
                "input_source": "microphone_browser",
                "capture_mode": "browser_speech",
            },
        },
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    rows = [
        (0, "speaker_a", "Hello", False),
        (600, "speaker_a", "world", True),
        (1_100, "speaker_b", "Reply", True),
        (4_300, "speaker_b", "Later", True),
    ]
    for timestamp_ms, speaker, text, is_final in rows:
        response = admin_client.post(
            f"/api/v1/realtime/sessions/{session_id}/chunks",
            json={
                "timestamp_ms": timestamp_ms,
                "text": text,
                "speaker": speaker,
                "is_final": is_final,
                "metadata": {
                    "input_source": "microphone_browser",
                    "capture_mode": "browser_speech",
                },
            },
        )
        assert response.status_code == 200

    snapshot = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/snapshot")
    assert snapshot.status_code == 200
    transcript_state = snapshot.json()["pipeline"]["transcript_state"]
    assert transcript_state["turn_count"] == 3
    assert transcript_state["speaker_count"] == 2
    assert transcript_state["current_turn"]["text"] == "Later"
    assert [row["text"] for row in transcript_state["archived_recent_turns"]] == ["Reply", "Hello world"]
    recent_turns = transcript_state["recent_turns"]
    assert [row["text"] for row in recent_turns] == ["Later", "Reply", "Hello world"]
    assert recent_turns[-1]["speaker"] == "speaker_a"
    assert recent_turns[-1]["start_ms"] == 0
    assert recent_turns[-1]["end_ms"] == 600


def test_runtime_options_and_audio_transcription_endpoint(
    admin_client: TestClient,
    monkeypatch,
    session_factory,
) -> None:
    monkeypatch.setattr(
        "app.routers.catalog.list_runtime_options",
        lambda db, include_secrets=False: {
            "gate_profiles": [
                {
                    "id": "gate-default",
                    "label": "Gate Default",
                    "provider_kind": "openai_compatible",
                    "models": ["model-small"],
                    "default_model": "model-small",
                }
            ],
            "planner_profiles": [
                {
                    "id": "planner-default",
                    "label": "Planner Default",
                    "provider_kind": "openai_compatible",
                    "models": ["model-large"],
                    "default_model": "model-large",
                }
            ],
            "stt_profiles": [
                {
                    "id": "stt-default",
                    "label": "STT Default",
                    "provider_kind": "xfyun_asr",
                    "models": ["rtasr_llm"],
                    "default_model": "rtasr_llm",
                }
            ],
        },
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="audio yielded concrete structure",
            confidence=0.91,
            metadata={"provider": "gate-default", "model_name": "model-small", "latency_ms": 5.0},
        ),
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[
                {"op": "add_node", "node_id": "Audio", "id": "Audio", "label": "Audio"},
                {"op": "add_node", "node_id": "Mermaid", "id": "Mermaid", "label": "Mermaid"},
                {
                    "op": "add_edge",
                    "edge_id": "edge_audio_mermaid",
                    "id": "edge_audio_mermaid",
                    "source": "Audio",
                    "target": "Mermaid",
                    "label": "",
                },
            ],
            notes="audio graph",
            metadata={"provider": "planner-default", "model_name": "model-large", "latency_ms": 10.0},
        ),
    )
    monkeypatch.setattr(
        "app.routers.realtime.transcribe_audio_chunk",
        lambda db, session_obj, payload: {
            "text": "识别出的系统音频文本",
            "provider": "stt-default",
            "model": "rtasr_llm",
            "latency_ms": 88.6,
            "speaker": "multi_speaker",
            "segments": [
                {
                    "seg_id": 1,
                    "text": "张三先说。",
                    "speaker": "张三",
                    "role_index": 1,
                    "feature_id": "feature_zhangsan",
                    "speaker_resolution_source": "rtasr_feature",
                },
                {
                    "seg_id": 1,
                    "text": "李四补充。",
                    "speaker": "role_2",
                    "role_index": 2,
                    "feature_id": "",
                    "speaker_resolution_source": "rtasr_role",
                },
            ],
        },
    )
    monkeypatch.setattr(
        "app.routers.realtime.blind_recognize_speaker",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("blind_recognize_speaker should not run for role-separated segments")),
    )

    runtime_options = admin_client.get("/api/v1/catalog/runtime-options")
    assert runtime_options.status_code == 200
    assert runtime_options.json()["gate_profiles"][0]["id"] == "gate-default"
    assert runtime_options.json()["planner_profiles"][0]["id"] == "planner-default"

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "audio session",
            "gate_profile_id": "gate-default",
            "gate_model": "model-small",
            "planner_profile_id": "planner-default",
            "planner_model": "model-large",
            "stt_profile_id": "stt-default",
            "stt_model": "rtasr_llm",
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
            "timestamp_ms": 1775133797936,
            "speaker": "system_audio",
            "is_final": True,
            "metadata": {"input_source": "system_audio", "capture_mode": "api_stt"},
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["text"] == "识别出的系统音频文本"
    assert payload["speaker"] == "multi_speaker"
    assert payload["voiceprint"]["matched"] is True
    assert payload["voiceprint"]["mode"] == "feature_split"
    assert len(payload["segments"]) == 2
    assert payload["provider"] == "stt-default"
    assert payload["pipeline"]["planner_state"]["model"] == "model-large"
    assert payload["pipeline"]["mermaid_state"]["source"] == "algorithm_preview"
    with session_factory() as db:
        rows = db.scalars(
            select(RealtimeChunk)
            .where(RealtimeChunk.session_id == session_id)
            .order_by(RealtimeChunk.sequence_no.asc())
        ).all()
        assert rows
        assert all(0 <= int(row.timestamp_ms) <= 2_147_483_647 for row in rows)


def test_runtime_options_can_persist_stt_voiceprint_config(admin_client: TestClient) -> None:
    response = admin_client.put(
        "/api/v1/catalog/runtime-options/admin",
        json={
            "gate_profiles": [],
            "planner_profiles": [],
            "stt_profiles": [
                {
                    "id": "xfyun-stt",
                    "label": "XFYun STT",
                    "provider_kind": "xfyun_asr",
                    "endpoint": "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
                    "models": ["iat", "xfime-mianqie"],
                    "default_model": "iat",
                    "app_id": "xfyun-app",
                    "api_key": "test-xfyun-key",
                    "api_secret": "test-xfyun-secret",
                    "api_key_env": "",
                    "api_secret_env": "",
                    "voiceprint": {
                        "enabled": True,
                        "provider_kind": "xfyun_isv",
                        "group_id": "lab_group",
                        "score_threshold": 0.82,
                        "top_k": 4,
                    },
                }
            ],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["stt_profiles"][0]["models"] == ["rtasr_llm"]
    assert payload["stt_profiles"][0]["default_model"] == "rtasr_llm"
    assert payload["stt_profiles"][0]["voiceprint"]["group_id"] == "lab_group"
    assert payload["stt_profiles"][0]["voiceprint"]["api_base"] == "https://office-api-personal-dx.iflyaisol.com"
    assert "api_secret" not in payload["stt_profiles"][0]["voiceprint"]

    public_view = admin_client.get("/api/v1/catalog/runtime-options")
    assert public_view.status_code == 200
    assert public_view.json()["stt_profiles"][0]["voiceprint"]["enabled"] is True
    assert "test-xfyun-secret" not in public_view.text


def test_voiceprint_management_api_and_audio_transcription_fallback(
    admin_client: TestClient,
    monkeypatch,
    session_factory,
) -> None:
    admin_client.put(
        "/api/v1/catalog/runtime-options/admin",
        json={
            "gate_profiles": [],
            "planner_profiles": [],
            "stt_profiles": [
                {
                    "id": "voice-stt",
                    "label": "Voice STT",
                    "provider_kind": "xfyun_asr",
                    "endpoint": "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
                    "models": ["rtasr_llm"],
                    "default_model": "rtasr_llm",
                    "app_id": "xfyun-app",
                    "api_key": "test-xfyun-key",
                    "api_secret": "test-xfyun-secret",
                    "api_key_env": "",
                    "api_secret_env": "",
                    "voiceprint": {
                        "enabled": True,
                        "provider_kind": "xfyun_isv",
                        "api_base": "https://api.xf-yun.com",
                        "group_id": "meeting_group",
                        "score_threshold": 0.88,
                        "top_k": 3,
                    },
                }
            ],
        },
    )

    monkeypatch.setattr(
        "app.routers.voiceprints.sync_group_and_features",
        lambda db, stt_profile_id, profile, display_name=None, group_info=None: (
            VoiceprintGroup(
                id="voice_group_1",
                stt_profile_id=stt_profile_id,
                group_id="meeting_group",
                display_name=display_name or "Voice STT",
                provider_kind="xfyun_isv",
                status="active",
                remote_payload={"group_id": "meeting_group"},
                created_at=utc_now(),
                updated_at=utc_now(),
            ),
            [{"featureId": "remote_feature_a", "featureInfo": "Alice"}],
        ),
    )
    monkeypatch.setattr(
        "app.routers.voiceprints.create_voiceprint_feature",
        lambda db, stt_profile_id, profile, speaker_label, feature_info, pcm_s16le_base64, sample_rate, channel_count: VoiceprintFeature(
            id="voice_feature_1",
            stt_profile_id=stt_profile_id,
            group_id="meeting_group",
            feature_id="feature_alice",
            speaker_label=speaker_label,
            feature_info=feature_info,
            status="active",
            remote_payload={"featureId": "feature_alice"},
            created_at=utc_now(),
            updated_at=utc_now(),
        ),
    )
    monkeypatch.setattr(
        "app.routers.voiceprints.delete_voiceprint_feature",
        lambda db, stt_profile_id, profile, feature_id: VoiceprintFeature(
            id="voice_feature_1",
            stt_profile_id=stt_profile_id,
            group_id="meeting_group",
            feature_id=feature_id,
            speaker_label="Alice",
            feature_info="Alice",
            status="deleted",
            remote_payload={"msg": "success"},
            created_at=utc_now(),
            updated_at=utc_now(),
        ),
    )
    monkeypatch.setattr(
        "app.routers.realtime.transcribe_audio_chunk",
        lambda db, session_obj, payload: {
            "text": "这段音频会回退到原 speaker",
            "provider": "voice-stt",
            "model": "rtasr_llm",
            "latency_ms": 55.2,
        },
    )
    monkeypatch.setattr(
        "app.routers.realtime.blind_recognize_speaker",
        lambda db, stt_profile_id, profile, pcm_s16le_base64, sample_rate, channel_count, fallback_speaker: {
            "matched": False,
            "provider": "xfyun_isv",
            "group_id": "meeting_group",
            "feature_id": "feature_alice",
            "speaker_label": fallback_speaker,
            "score": 0.42,
            "top_candidates": [{"feature_id": "feature_alice", "speaker_label": "Alice", "score": 0.42}],
            "latency_ms": 22.5,
            "threshold": 0.88,
            "error_message": None,
        },
    )

    sync_response = admin_client.post(
        "/api/v1/voiceprints/stt-profiles/voice-stt/group/sync",
        json={"display_name": "会议声纹库", "group_info": "demo"},
    )
    assert sync_response.status_code == 200
    assert sync_response.json()["group"]["group_id"] == "meeting_group"

    create_feature_response = admin_client.post(
        "/api/v1/voiceprints/stt-profiles/voice-stt/features",
        json={
            "speaker_label": "Alice",
            "feature_info": "Alice sample",
            "sample_rate": 16000,
            "channel_count": 1,
            "pcm_s16le_base64": "AAA=",
        },
    )
    assert create_feature_response.status_code == 200
    assert create_feature_response.json()["feature_id"] == "feature_alice"

    features_response = admin_client.get("/api/v1/voiceprints/stt-profiles/voice-stt/features")
    assert features_response.status_code == 200

    delete_feature_response = admin_client.delete("/api/v1/voiceprints/stt-profiles/voice-stt/features/feature_alice")
    assert delete_feature_response.status_code == 200
    assert delete_feature_response.json()["ok"] is True

    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="audio update",
            confidence=0.91,
            metadata={"provider": "gate-default", "model_name": "gate-model", "latency_ms": 5.0},
        ),
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[{"op": "add_node", "node_id": "Audio", "id": "Audio", "label": "Audio"}],
            notes="audio node",
            metadata={"provider": "planner-default", "model_name": "planner-model", "latency_ms": 9.0},
        ),
    )

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "voiceprint fallback",
            "stt_profile_id": "voice-stt",
            "stt_model": "rtasr_llm",
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
            "speaker": "speaker",
            "is_final": True,
            "metadata": {"input_source": "microphone_browser", "capture_mode": "api_stt"},
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["speaker"] == "speaker"
    assert payload["voiceprint"]["matched"] is False

    with session_factory() as db:
        chunk = db.scalar(select(RealtimeChunk).where(RealtimeChunk.session_id == session_id))
        assert chunk is not None
        assert chunk.speaker == "speaker"
        assert chunk.meta_json["voiceprint_result"]["score"] == 0.42


def test_realtime_session_gracefully_degrades_when_planner_errors(
    admin_client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="emit update",
            confidence=0.8,
            metadata={"provider": "gate-default", "model_name": "gate-model", "latency_ms": 1.0},
        ),
    )

    def _raise_planner_error(self, db, obj, pending_turns):
        raise AttributeError("tls settings missing")

    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        _raise_planner_error,
    )

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "degraded collaborative session",
            "gate_profile_id": "gate-default",
            "gate_model": "gate-model",
            "planner_profile_id": "planner-default",
            "planner_model": "planner-model",
            "client_context": {"input_source": "transcript"},
        },
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    chunk = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks",
        json={
            "timestamp_ms": 0,
            "text": "Create a simple flow from audio to diagram.",
            "speaker": "expert",
            "is_final": True,
        },
    )
    assert chunk.status_code == 200

    drop_runtime(session_id)
    snapshot = admin_client.post(f"/api/v1/realtime/sessions/{session_id}/snapshot")
    assert snapshot.status_code == 200
    assert snapshot.json()["pipeline"]["planner_state"]["status"] == "error"
    assert "tls settings missing" in snapshot.json()["pipeline"]["planner_state"]["error_message"]
    assert snapshot.json()["pipeline"]["mermaid_state"]["render_ok"] is True


def test_legacy_llm_runtime_session_remains_writable(
    admin_client: TestClient,
    session_factory,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="legacy mapped",
            confidence=0.9,
            metadata={"provider": "legacy-llm", "model_name": "legacy-model", "latency_ms": 4.0},
        ),
    )
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[{"op": "add_node", "node_id": "Legacy", "id": "Legacy", "label": "Legacy"}],
            notes="legacy graph",
            metadata={"provider": "legacy-llm", "model_name": "legacy-model", "latency_ms": 6.0},
        ),
    )

    with session_factory() as db:
        session = RealtimeSession(
            title="legacy session",
            status="active",
            config_snapshot={
                "runtime_options": {
                    "llm_profile_id": "legacy-llm",
                    "llm_model": "legacy-model",
                }
            },
            summary_json={},
            pipeline_payload={"meta": {}, "summary": {}, "events": []},
            evaluation_payload={},
        )
        db.add(session)
        db.commit()
        session_id = session.id

    chunk = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks",
        json={"timestamp_ms": 0, "text": "Continue the old session.", "speaker": "expert", "is_final": True},
    )
    assert chunk.status_code == 200
    assert chunk.json()["pipeline"]["graph_state"]["update_index"] == 1
    assert chunk.json()["pipeline"]["planner_state"]["provider"] == "legacy-llm"


def test_realtime_session_uses_requested_diagram_type_and_preserves_groups(
    admin_client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="enough structure",
            confidence=0.95,
            metadata={"provider": "test-gate", "model_name": "test-gate-model", "latency_ms": 2.0},
        ),
    )

    def _plan_sequence(self, db, obj, pending_turns):
        return PlannerDecision(
            target_graph_ir=GraphIR(
                graph_id=self.session_id,
                diagram_type="sequence",
                nodes=[
                    GraphNode(id="User", label="User", parent="actors"),
                    GraphNode(id="API", label="API", parent="actors"),
                ],
                edges=[],
                groups=[GraphGroup(id="actors", label="Actors", member_ids=["User", "API"])],
            ),
            notes="sequence graph",
            metadata={"provider": "test-planner", "model_name": "test-planner-model", "latency_ms": 8.0},
        )

    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        _plan_sequence,
    )

    created = admin_client.post(
        "/api/v1/realtime/sessions",
        json={
            "title": "sequence session",
            "diagram_type": "sequence",
            "gate_profile_id": "test-gate",
            "gate_model": "test-gate-model",
            "planner_profile_id": "test-planner",
            "planner_model": "test-planner-model",
        },
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    chunk = admin_client.post(
        f"/api/v1/realtime/sessions/{session_id}/chunks",
        json={"timestamp_ms": 0, "text": "User calls API.", "speaker": "expert", "is_final": True},
    )
    assert chunk.status_code == 200
    pipeline = chunk.json()["pipeline"]
    assert pipeline["graph_state"]["diagram_type"] == "sequence"
    assert pipeline["mermaid_state"]["code"].splitlines()[0] == "sequenceDiagram"
    assert pipeline["renderer_state"]["groups"][0]["id"] == "actors"


def test_runtime_options_admin_view_includes_runtime_defaults(admin_client: TestClient) -> None:
    response = admin_client.get("/api/v1/catalog/runtime-options/admin")
    assert response.status_code == 200
    payload = response.json()
    assert payload["gate_profiles"][0]["id"] == "gate-default"
    assert payload["planner_profiles"][0]["id"] == "planner-default"
    assert payload["stt_profiles"][0]["id"] == "stt-default"


def test_runtime_options_can_be_saved_from_admin_ui(admin_client: TestClient) -> None:
    response = admin_client.put(
        "/api/v1/catalog/runtime-options/admin",
        json={
            "gate_profiles": [
                {
                    "id": "openai-gate",
                    "label": "OpenAI Gate",
                    "provider_kind": "openai_compatible",
                    "endpoint": "https://api.openai.com/v1/chat/completions",
                    "models": ["gpt-4.1-mini", "gpt-4.1"],
                    "default_model": "gpt-4.1-mini",
                    "api_key": "test-openai-key",
                    "api_key_env": "",
                }
            ],
            "planner_profiles": [
                {
                    "id": "openai-planner",
                    "label": "OpenAI Planner",
                    "provider_kind": "openai_compatible",
                    "endpoint": "https://api.openai.com/v1/chat/completions",
                    "models": ["gpt-4.1-mini", "gpt-4.1"],
                    "default_model": "gpt-4.1-mini",
                    "extra_body_json": '{"enable_thinking": false}',
                    "api_key": "test-openai-key",
                    "api_key_env": "",
                }
            ],
            "stt_profiles": [
                {
                    "id": "xfyun-stt",
                    "label": "XFYun STT",
                    "provider_kind": "xfyun_asr",
                    "endpoint": "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
                    "models": ["iat", "xfime-mianqie"],
                    "default_model": "iat",
                    "app_id": "xfyun-app",
                    "api_key": "test-xfyun-key",
                    "api_secret": "test-xfyun-secret",
                    "api_key_env": "",
                    "api_secret_env": "",
                }
            ],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["gate_profiles"][0]["endpoint"] == "https://api.openai.com/v1/chat/completions"
    assert payload["gate_profiles"][0]["api_key"] == "test-openai-key"
    assert payload["planner_profiles"][0]["id"] == "openai-planner"
    assert payload["planner_profiles"][0]["extra_body_json"] == '{"enable_thinking": false}'
    assert payload["stt_profiles"][0]["provider_kind"] == "xfyun_asr"
    assert payload["stt_profiles"][0]["app_id"] == "xfyun-app"
    assert payload["stt_profiles"][0]["models"] == ["rtasr_llm"]
    assert payload["stt_profiles"][0]["default_model"] == "rtasr_llm"

    admin_view = admin_client.get("/api/v1/catalog/runtime-options/admin")
    assert admin_view.status_code == 200
    assert admin_view.json()["gate_profiles"][0]["id"] == "openai-gate"
    assert admin_view.json()["planner_profiles"][0]["id"] == "openai-planner"
    assert admin_view.json()["planner_profiles"][0]["extra_body_json"] == '{"enable_thinking": false}'
    assert admin_view.json()["stt_profiles"][0]["endpoint"] == "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"

    public_view = admin_client.get("/api/v1/catalog/runtime-options")
    assert public_view.status_code == 200
    assert public_view.json()["gate_profiles"][0]["id"] == "openai-gate"
    assert public_view.json()["planner_profiles"][0]["id"] == "openai-planner"
    assert "api_key" not in public_view.text


def test_runtime_options_normalize_legacy_xfyun_endpoint(admin_client: TestClient) -> None:
    response = admin_client.put(
        "/api/v1/catalog/runtime-options/admin",
        json={
            "gate_profiles": [],
            "planner_profiles": [],
            "stt_profiles": [
                {
                    "id": "stt-1",
                    "label": "xunfei",
                    "provider_kind": "xfyun_asr",
                    "endpoint": "wss://iat-api.xfyun.cn/v2/iat",
                    "models": ["iat"],
                    "default_model": "iat",
                    "app_id": "53281301",
                    "api_key": "test-key",
                    "api_secret": "test-secret",
                    "voiceprint": {
                        "enabled": True,
                        "provider_kind": "xfyun_isv",
                        "api_base": "https://api.xf-yun.com",
                        "group_id": "stt_1_group",
                    },
                }
            ],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["stt_profiles"][0]["endpoint"] == "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"
    assert payload["stt_profiles"][0]["models"] == ["rtasr_llm"]
    assert payload["stt_profiles"][0]["default_model"] == "rtasr_llm"
    assert payload["stt_profiles"][0]["voiceprint"]["api_base"] == "https://office-api-personal-dx.iflyaisol.com"


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


def test_runtime_model_probe_endpoint_for_xfyun_stt(admin_client: TestClient) -> None:
    response = admin_client.post(
        "/api/v1/catalog/runtime-options/admin/probe-models",
        json={
            "endpoint": "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
            "provider_kind": "xfyun_asr",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["models_endpoint"] == "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"
    assert payload["models"] == ["rtasr_llm"]


def test_runtime_connection_test_endpoint(admin_client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.routers.catalog.test_runtime_connection",
        lambda **kwargs: {
            "ok": True,
            "provider_kind": kwargs["provider_kind"],
            "summary": "连接成功",
            "logs": [
                f"provider_kind={kwargs['provider_kind']}",
                "最终结果：成功，摘要=连接成功",
            ],
        },
    )

    response = admin_client.post(
        "/api/v1/catalog/runtime-options/admin/test-connection",
        json={
            "endpoint": "https://api.openai.com/v1/chat/completions",
            "provider_kind": "openai_compatible",
            "api_key": "test-key",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["provider_kind"] == "openai_compatible"
    assert payload["summary"] == "连接成功"
    assert len(payload["logs"]) == 2


def test_runtime_connection_test_endpoint_returns_failure_logs(admin_client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.routers.catalog.test_runtime_connection",
        lambda **kwargs: {
            "ok": False,
            "provider_kind": kwargs["provider_kind"],
            "summary": "讯飞 RTASR 连接测试失败：缺少 App ID / API Key / API Secret。",
            "logs": [
                "provider_kind=xfyun_asr",
                "API Key: 未提供",
                "API Secret: 未提供",
                "最终结果：失败，原因=讯飞 RTASR 连接测试失败：缺少 App ID / API Key / API Secret。",
            ],
        },
    )

    response = admin_client.post(
        "/api/v1/catalog/runtime-options/admin/test-connection",
        json={
            "endpoint": "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1",
            "provider_kind": "xfyun_asr",
            "voiceprint": {"enabled": True, "group_id": "meeting_group"},
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["provider_kind"] == "xfyun_asr"
    assert "缺少 App ID" in payload["summary"]
    assert any("API Key" in line for line in payload["logs"])


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
