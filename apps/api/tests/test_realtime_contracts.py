from __future__ import annotations

import re
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
from tools.incremental_dataset.schema import GraphGroup, GraphIR, GraphNode
from tools.incremental_dataset.staging import render_preview_mermaid


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


def test_render_preview_mermaid_sanitizes_reserved_identifiers_and_style_aliases() -> None:
    graph_ir = GraphIR(
        graph_id="render-smoke",
        diagram_type="flowchart",
        nodes=[
            GraphNode(id="end", label="结束节点", parent="online_group", source_index=1),
            GraphNode(id="423_market", label="423书菜云集市", parent="online_group", source_index=2),
            GraphNode(id="sound_cloud_reading", label="声动云端有声阅读大赛", parent="online_group", source_index=3),
        ],
        groups=[
            GraphGroup(id="online_group", label="线上活动", source_index=1),
        ],
        styles=[
            {"line": "classDef end fill:#fef3c7,stroke:#f59e0b,font-weight:bold"},
            {"line": "class node_end,423_market,sound_cloud_reading start,end"},
            {"line": "style group_online_group fill:#eff6ff,stroke:#3b82f6"},
        ],
    )

    code = render_preview_mermaid(graph_ir)

    assert "classDef end " not in code
    assert "class node_end" not in code
    assert "style group_online_group " not in code
    assert not re.search(r"^\s*end\[", code, flags=re.MULTILINE)
    assert not re.search(r"^\s*423_market\[", code, flags=re.MULTILINE)
    assert re.search(r"^\s*classDef [A-Za-z][A-Za-z0-9_]* fill:#fef3c7,stroke:#f59e0b,font-weight:bold$", code, flags=re.MULTILINE)
    assert re.search(r"^\s*class [A-Za-z0-9_,]+ start,class_end$", code, flags=re.MULTILINE)
    assert re.search(r"^\s*style online_group fill:#eff6ff,stroke:#3b82f6$", code, flags=re.MULTILINE)
