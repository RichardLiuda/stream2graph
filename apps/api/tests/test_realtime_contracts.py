from __future__ import annotations

from app.services.realtime_coordination import CoordinationRuntimeSession, DialogueTurn, PlannerDecision, _coerce_gate_action
from app.models import RealtimeSession


def test_runtime_session_emits_pipeline_payload() -> None:
    runtime = CoordinationRuntimeSession.create("test")
    runtime.turns.append(
        DialogueTurn(
            turn_id=1,
            speaker="expert",
            content="First define gateway and parser.",
            metadata={"timestamp_ms": 0, "is_final": True},
        )
    )
    runtime.pending_turn_ids = [1]
    runtime.chunk_count = 1
    payload = runtime.pipeline_payload()
    assert "summary" in payload
    assert payload["meta"]["input_chunk_count"] == 1


def test_coerce_gate_action_accepts_emit_like_variants() -> None:
    assert _coerce_gate_action("acknowledge_instruction") == "EMIT_UPDATE"
    assert _coerce_gate_action("emit-update") == "EMIT_UPDATE"
    assert _coerce_gate_action("hold") == "WAIT"


def test_manual_transcript_shortcuts_gate_without_model_call(session_factory, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._plan_update",
        lambda self, db, obj, pending_turns: PlannerDecision(
            delta_ops=[],
            notes="noop",
            metadata={"provider": "stub-planner", "model_name": "stub-planner"},
        ),
    )
    with session_factory() as db:
        obj = RealtimeSession(
            title="manual transcript",
            status="active",
            config_snapshot={
                "runtime_options": {
                    "gate_profile_id": "llm-1",
                    "gate_model": "Qwen/Qwen3.5-4B",
                },
                "input_runtime": {
                    "input_source": "transcript",
                    "capture_mode": "manual_text",
                },
            },
        )
        db.add(obj)
        db.flush()
        runtime = CoordinationRuntimeSession.create(obj.id)
        emitted = runtime.ingest_chunk(
            db,
            obj,
            timestamp_ms=0,
            text="Add alert ingestion and triage.",
            speaker="expert",
            is_final=True,
            expected_intent="structural",
        )
        assert runtime.gate_state["provider"] == "heuristic_batch_gate"
        assert runtime.gate_state["last_action"] == "EMIT_UPDATE"
        assert isinstance(emitted, list)
