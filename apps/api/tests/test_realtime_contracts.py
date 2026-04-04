from __future__ import annotations

from types import MethodType, SimpleNamespace

from app.services.realtime_coordination import (
    CoordinationRuntimeSession,
    DialogueTurn,
    GateDecision,
    PlannerDecision,
    _coerce_gate_action,
    _coerce_style_entries,
)
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
    assert _coerce_gate_action("next_canvas") == "SWITCH_CANVAS"


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


def test_runtime_session_switches_canvas_and_restores() -> None:
    runtime = CoordinationRuntimeSession.create("canvas-smoke")
    session_obj = SimpleNamespace(
        config_snapshot={
            "runtime_options": {"diagram_type": "flowchart"},
            "input_runtime": {"input_source": "demo_mode", "capture_mode": "manual_text"},
        }
    )

    def _fake_plan(self, db, obj, pending_turns):
        node_suffix = self.update_index + 1
        return PlannerDecision(
            delta_ops=[
                {
                    "op": "add_node",
                    "node_id": f"Node_{node_suffix}",
                    "id": f"Node_{node_suffix}",
                    "label": f"Node {node_suffix}",
                }
            ],
            notes=f"update {node_suffix}",
            metadata={"provider": "stub-planner", "model_name": "stub-planner", "latency_ms": 2.5},
        )

    def _fake_gate(self, db, obj, pending_turns, force_emit=False):
        if self.update_index == 0:
            return GateDecision(
                action="EMIT_UPDATE",
                reason="first topic",
                confidence=0.9,
                metadata={"provider": "stub-gate", "model_name": "stub-gate", "latency_ms": 1.0},
            )
        return GateDecision(
            action="SWITCH_CANVAS",
            reason="new topic detected",
            confidence=0.88,
            metadata={"provider": "stub-gate", "model_name": "stub-gate", "latency_ms": 1.0},
        )

    runtime._plan_update = MethodType(_fake_plan, runtime)
    runtime._decide_gate = MethodType(_fake_gate, runtime)

    runtime.ingest_chunk(
        None,
        session_obj,
        timestamp_ms=0,
        text="First topic",
        speaker="host",
        is_final=True,
        expected_intent=None,
    )
    runtime.ingest_chunk(
        None,
        session_obj,
        timestamp_ms=450,
        text="Second topic",
        speaker="host",
        is_final=True,
        expected_intent=None,
    )

    payload = runtime.pipeline_payload()
    assert payload["canvas_state"]["canvas_count"] == 2
    assert payload["canvas_state"]["active_canvas_index"] == 1
    assert payload["canvas_state"]["canvases"][0]["graph_metrics"]["node_count"] == 1
    assert payload["canvas_state"]["canvases"][1]["graph_metrics"]["node_count"] == 1
    assert payload["events"][-1]["canvas_transition"]["canvas_count"] == 2

    restored = CoordinationRuntimeSession.restore(
        "canvas-smoke",
        config_snapshot=session_obj.config_snapshot,
        pipeline_payload=payload,
        evaluation_payload={},
        rows=[
            {"speaker": "host", "text": "First topic", "timestamp_ms": 0, "is_final": True},
            {"speaker": "host", "text": "Second topic", "timestamp_ms": 450, "is_final": True},
        ],
    )
    restored_payload = restored.pipeline_payload()
    assert restored_payload["canvas_state"]["canvas_count"] == 2
    assert restored_payload["canvas_state"]["active_canvas_index"] == 1


def test_style_entries_normalize_class_targets() -> None:
    styles = _coerce_style_entries(
        [
            {"line": "class node_a node_b primary"},
            {"line": "class node_c, node_d secondary"},
        ]
    )
    assert styles == [
        {"line": "class node_a,node_b primary"},
        {"line": "class node_c,node_d secondary"},
    ]
