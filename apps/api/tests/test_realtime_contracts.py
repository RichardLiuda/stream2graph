from __future__ import annotations

import json
import re
from types import MethodType, SimpleNamespace

from app.services.realtime_coordination import (
    CoordinationRuntimeSession,
    DialogueTurn,
    GateDecision,
    LIVE_PLANNER_SYSTEM_PROMPT,
    LIVE_RELAYOUT_SYSTEM_PROMPT,
    PlannerDecision,
    _backfill_sparse_flow_edges,
    _coerce_gate_action,
    _coerce_style_entries,
)
from app.models import RealtimeSession
from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode
from tools.incremental_dataset.staging import render_preview_mermaid
from tools.incremental_system.chat_clients import ChatResult
from tools.incremental_system.models import _diagram_type_alignment_priors


class _SequenceClient:
    def __init__(self, responses: list[str], *, latency_ms: float = 3.0) -> None:
        self.responses = list(responses)
        self.latency_ms = latency_ms
        self.messages: list[list[dict[str, str]]] = []

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        self.messages.append(messages)
        if not self.responses:
            raise AssertionError("unexpected chat call")
        return ChatResult(text=self.responses.pop(0), latency_ms=self.latency_ms, usage={"test": True})


def _runtime_session_obj() -> RealtimeSession:
    return RealtimeSession(
        title="planner repair",
        status="active",
        config_snapshot={
            "runtime_options": {
                "diagram_type": "flowchart",
                "planner_profile_id": "planner-profile",
                "planner_model": "planner-model",
                "gate_profile_id": "gate-profile",
                "gate_model": "gate-model",
            },
            "input_runtime": {"input_source": "demo_mode", "capture_mode": "manual_text"},
        },
    )


def _install_planner_repair_fakes(
    monkeypatch,
    *,
    planner_responses: list[str],
    gate_responses: list[str],
    include_gate_profile: bool = True,
) -> tuple[_SequenceClient, _SequenceClient]:
    planner_client = _SequenceClient(planner_responses, latency_ms=11.0)
    gate_client = _SequenceClient(gate_responses, latency_ms=7.0)

    def _fake_resolve_profile(db, kind, profile_id):
        if kind == "planner":
            return {"id": "planner-profile", "provider_kind": "openai_compatible", "default_model": "planner-model"}
        if kind == "gate" and include_gate_profile:
            return {"id": "gate-profile", "provider_kind": "openai_compatible", "default_model": "gate-model"}
        return None

    def _fake_build_chat_client(profile, model, *, timeout_sec=180):
        if model == "planner-model":
            return planner_client
        if model == "gate-model":
            return gate_client
        raise AssertionError(f"unexpected model {model}")

    monkeypatch.setattr("app.services.realtime_coordination.resolve_profile", _fake_resolve_profile)
    monkeypatch.setattr("app.services.realtime_coordination.build_chat_client", _fake_build_chat_client)
    monkeypatch.setattr(
        "app.services.realtime_coordination.CoordinationRuntimeSession._decide_gate",
        lambda self, db, obj, pending_turns, force_emit=False: GateDecision(
            action="EMIT_UPDATE",
            reason="test initial gate",
            confidence=1.0,
            metadata={"provider": "initial-gate", "model_name": "initial-gate", "latency_ms": 1.0},
        ),
    )
    return planner_client, gate_client


def _valid_repaired_plan(node_id: str = "gateway") -> str:
    return json.dumps(
        {
            "diagram_type": "flowchart",
            "delta_ops": [{"op": "add_node", "node_id": node_id, "id": node_id, "label": "Gateway"}],
            "notes": "repaired",
        }
    )


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


def test_planner_malformed_json_is_repaired_then_rechecked_by_gate(session_factory, monkeypatch) -> None:
    _, gate_client = _install_planner_repair_fakes(
        monkeypatch,
        planner_responses=['{"diagram_type":"flowchart","delta_ops":['],
        gate_responses=[
            _valid_repaired_plan("gateway"),
            json.dumps({"action": "EMIT_UPDATE", "reason": "repaired plan is safe", "confidence": 0.91}),
        ],
    )
    with session_factory() as db:
        obj = _runtime_session_obj()
        db.add(obj)
        db.flush()
        runtime = CoordinationRuntimeSession.create(obj.id)
        events = runtime.ingest_chunk(
            db,
            obj,
            timestamp_ms=0,
            text="Add a gateway component.",
            speaker="expert",
            is_final=True,
            expected_intent="structural",
        )

    assert len(events) == 1
    assert runtime.pending_turn_ids == []
    assert [node.id for node in runtime.current_graph_ir.nodes] == ["gateway"]
    assert runtime.gate_action_counts["EMIT_UPDATE"] == 1
    assert len(gate_client.messages) == 2
    assert runtime.planner_state["debug"]["json_repair_attempted"] is True
    assert runtime.planner_state["debug"]["json_repair_succeeded"] is True
    assert runtime.planner_state["debug"]["gate_paused_during_repair"] is True
    assert runtime.planner_state["debug"]["post_repair_gate_action"] == "EMIT_UPDATE"
    assert events[0]["planner"]["metadata"]["repair_model"] == "gate-model"
    assert events[0]["gate"]["action"] == "EMIT_UPDATE"


def test_planner_contract_error_is_repaired_and_applied(session_factory, monkeypatch) -> None:
    _install_planner_repair_fakes(
        monkeypatch,
        planner_responses=[json.dumps({"diagram_type": "flowchart", "notes": "missing graph update"})],
        gate_responses=[
            _valid_repaired_plan("parser"),
            json.dumps({"action": "EMIT_UPDATE", "reason": "contract repaired", "confidence": 0.88}),
        ],
    )
    with session_factory() as db:
        obj = _runtime_session_obj()
        db.add(obj)
        db.flush()
        runtime = CoordinationRuntimeSession.create(obj.id)
        events = runtime.ingest_chunk(
            db,
            obj,
            timestamp_ms=0,
            text="Add a parser component.",
            speaker="expert",
            is_final=True,
            expected_intent="structural",
        )

    assert len(events) == 1
    assert runtime.pending_turn_ids == []
    assert [node.id for node in runtime.current_graph_ir.nodes] == ["parser"]
    assert runtime.planner_state["debug"]["json_repair_succeeded"] is True


def test_repaired_planner_json_waits_when_post_repair_gate_waits(session_factory, monkeypatch) -> None:
    _install_planner_repair_fakes(
        monkeypatch,
        planner_responses=['{"diagram_type":"flowchart","delta_ops":['],
        gate_responses=[
            _valid_repaired_plan("gateway"),
            json.dumps({"action": "WAIT", "reason": "dialogue needs more context", "confidence": 0.72}),
        ],
    )
    with session_factory() as db:
        obj = _runtime_session_obj()
        db.add(obj)
        db.flush()
        runtime = CoordinationRuntimeSession.create(obj.id)
        events = runtime.ingest_chunk(
            db,
            obj,
            timestamp_ms=0,
            text="Maybe gateway.",
            speaker="expert",
            is_final=True,
            expected_intent="structural",
        )

    assert events == []
    assert runtime.pending_turn_ids == [1]
    assert runtime.current_graph_ir.nodes == []
    assert runtime.gate_action_counts["WAIT"] == 1
    assert runtime.planner_state["status"] == "repair_succeeded_but_gate_wait"
    assert runtime.planner_state["debug"]["json_repair_succeeded"] is True
    assert runtime.planner_state["debug"]["post_repair_gate_action"] == "WAIT"


def test_planner_json_repair_failure_keeps_pending_turns(session_factory, monkeypatch) -> None:
    _install_planner_repair_fakes(
        monkeypatch,
        planner_responses=['{"diagram_type":"flowchart","delta_ops":['],
        gate_responses=[json.dumps({"diagram_type": "flowchart", "notes": "still missing graph update"})],
    )
    with session_factory() as db:
        obj = _runtime_session_obj()
        db.add(obj)
        db.flush()
        runtime = CoordinationRuntimeSession.create(obj.id)
        events = runtime.ingest_chunk(
            db,
            obj,
            timestamp_ms=0,
            text="Add gateway.",
            speaker="expert",
            is_final=True,
            expected_intent="structural",
        )

    assert events == []
    assert runtime.pending_turn_ids == [1]
    assert runtime.current_graph_ir.nodes == []
    assert runtime.gate_action_counts["WAIT"] == 1
    assert runtime.planner_state["status"] == "error"
    assert runtime.planner_state["debug"]["json_repair_attempted"] is True
    assert runtime.planner_state["debug"]["json_repair_succeeded"] is False
    assert runtime.planner_state["debug"]["repair_error"]


def test_planner_json_repair_skips_when_gate_profile_missing(session_factory, monkeypatch) -> None:
    _, gate_client = _install_planner_repair_fakes(
        monkeypatch,
        planner_responses=['{"diagram_type":"flowchart","delta_ops":['],
        gate_responses=[_valid_repaired_plan("gateway")],
        include_gate_profile=False,
    )
    with session_factory() as db:
        obj = _runtime_session_obj()
        db.add(obj)
        db.flush()
        runtime = CoordinationRuntimeSession.create(obj.id)
        events = runtime.ingest_chunk(
            db,
            obj,
            timestamp_ms=0,
            text="Add gateway.",
            speaker="expert",
            is_final=True,
            expected_intent="structural",
        )

    assert events == []
    assert runtime.pending_turn_ids == [1]
    assert runtime.current_graph_ir.nodes == []
    assert gate_client.messages == []
    assert runtime.planner_state["status"] == "error"
    assert runtime.planner_state["debug"]["json_repair_attempted"] is False
    assert runtime.planner_state["debug"]["json_repair_succeeded"] is False


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


def test_render_preview_mermaid_emits_lane_flowchart_with_sorted_lanes_and_relation_edges() -> None:
    graph_ir = GraphIR(
        graph_id="debate-lanes",
        diagram_type="flowchart",
        nodes=[
            GraphNode(id="alice_claim", label="主张 A", parent="alice_lane", source_index=2, metadata={"turn_index": 2}),
            GraphNode(id="alice_evidence", label="证据 A1", parent="alice_lane", source_index=1, metadata={"turn_index": 1}),
            GraphNode(id="bob_counter", label="反驳 B", parent="bob_lane", source_index=2, metadata={"turn_index": 2}),
            GraphNode(id="bob_question", label="追问 B1", parent="bob_lane", source_index=1, metadata={"turn_index": 1}),
        ],
        edges=[
            GraphEdge(id="support_1", source="alice_evidence", target="alice_claim", source_index=1, metadata={"relation_type": "support"}),
            GraphEdge(id="attack_1", source="bob_counter", target="alice_claim", source_index=2, metadata={"relation_type": "attack"}),
            GraphEdge(id="reply_1", source="bob_question", target="alice_claim", source_index=3, metadata={"relation_type": "reply"}),
            GraphEdge(id="reference_1", source="alice_claim", target="bob_question", source_index=4, metadata={"relation_type": "reference"}),
        ],
        groups=[
            GraphGroup(
                id="alice_lane",
                label="正方",
                source_index=2,
                metadata={"group_type": "speaker_lane", "lane_index": 2, "speaker_id": "alice"},
            ),
            GraphGroup(
                id="bob_lane",
                label="反方",
                source_index=1,
                metadata={"group_type": "speaker_lane", "lane_index": 1, "speaker_id": "bob"},
            ),
        ],
        metadata={"view_mode": "debate_lane_flowchart"},
    )

    code = render_preview_mermaid(graph_ir)

    assert code.startswith("flowchart LR")
    assert code.index('subgraph bob_lane["反方"]') < code.index('subgraph alice_lane["正方"]')
    assert "    direction TB" in code
    assert code.index('bob_question["#1 追问 B1"]') < code.index('bob_counter["#2 反驳 B"]')
    assert code.index('alice_evidence["#1 证据 A1"]') < code.index('alice_claim["#2 主张 A"]')
    assert "alice_evidence ---o alice_claim" in code
    assert "bob_counter ---x alice_claim" in code
    assert "bob_question --> alice_claim" in code
    assert "alice_claim ==> bob_question" in code


def test_render_preview_mermaid_keeps_plain_flowchart_unchanged_without_lane_view() -> None:
    graph_ir = GraphIR(
        graph_id="plain-flowchart",
        diagram_type="flowchart",
        nodes=[
            GraphNode(id="start", label="开始", source_index=1),
            GraphNode(id="next_step", label="下一步", source_index=2),
        ],
        edges=[GraphEdge(id="edge_1", source="start", target="next_step", source_index=1)],
    )

    code = render_preview_mermaid(graph_ir)

    assert code.startswith("graph TD")
    assert "flowchart LR" not in code
    assert 'start["开始"]' in code
    assert "start --> next_step" in code


def test_runtime_session_pipeline_payload_exposes_lane_metadata_and_edges() -> None:
    runtime = CoordinationRuntimeSession.create("debate-runtime")
    runtime.current_graph_ir = GraphIR(
        graph_id="debate-runtime",
        diagram_type="flowchart",
        nodes=[
            GraphNode(id="speaker_a_1", label="观点 A1", parent="speaker_a", source_index=1),
            GraphNode(id="speaker_b_1", label="观点 B1", parent="speaker_b", source_index=2),
        ],
        edges=[
            GraphEdge(id="edge_1", source="speaker_b_1", target="speaker_a_1", source_index=1, metadata={"relation_type": "attack"})
        ],
        groups=[
            GraphGroup(id="speaker_a", label="甲方", source_index=1),
            GraphGroup(id="speaker_b", label="乙方", source_index=2),
        ],
    )
    runtime.rendered_mermaid = render_preview_mermaid(runtime.current_graph_ir)

    payload = runtime.pipeline_payload()
    graph_payload = payload["graph_state"]["current_graph_ir"]

    assert graph_payload["metadata"]["view_mode"] == "debate_lane_flowchart"
    assert graph_payload["nodes"][0]["metadata"]["lane_id"] == "speaker_a"
    assert graph_payload["nodes"][0]["metadata"]["speaker_label"] == "甲方"
    assert graph_payload["edges"][0]["metadata"]["relation_type"] == "attack"
    assert graph_payload["edges"][0]["metadata"]["cross_lane"] is True
    assert graph_payload["edges"][0]["metadata"]["mermaid_source_id"]
    assert payload["graph_state"]["preview_mermaid"].startswith("flowchart LR")


def test_diagram_type_priors_keep_edges_for_structured_diagrams() -> None:
    assert _diagram_type_alignment_priors("flowchart")["allow_edges"] is True
    assert _diagram_type_alignment_priors("sequence")["allow_edges"] is True
    assert _diagram_type_alignment_priors("statediagram")["allow_edges"] is True
    assert _diagram_type_alignment_priors("er")["allow_edges"] is True


def test_realtime_prompts_require_language_consistency() -> None:
    assert "Use the same dominant language as the observed dialogue" in LIVE_PLANNER_SYSTEM_PROMPT
    assert "Do not translate unless the user explicitly asks for translation." in LIVE_PLANNER_SYSTEM_PROMPT
    assert "Do not silently translate Chinese content into English" in LIVE_RELAYOUT_SYSTEM_PROMPT


def test_backfill_sparse_flow_edges_connects_root_and_prefixed_children() -> None:
    graph_ir = GraphIR(
        graph_id="sparse-flow",
        diagram_type="flowchart",
        nodes=[
            GraphNode(id="root", label="中心主题", source_index=1),
            GraphNode(id="fusion", label="融合发展", source_index=2),
            GraphNode(id="night", label="夜间文旅", source_index=3),
            GraphNode(id="fusion_path", label="路径", source_index=4),
            GraphNode(id="night_1", label="夜间演出", source_index=5),
        ],
    )

    next_graph, changed = _backfill_sparse_flow_edges(graph_ir)

    assert changed is True
    assert {(edge.source, edge.target) for edge in next_graph.edges} == {
        ("root", "fusion"),
        ("root", "night"),
        ("fusion", "fusion_path"),
        ("night", "night_1"),
    }
