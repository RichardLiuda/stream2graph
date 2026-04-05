from __future__ import annotations

from sqlalchemy.orm import sessionmaker

from app.models import RealtimeChunk, RealtimeSession
from app.services import realtime_ai
from tools.mermaid_prompting import (
    MERMAID_GENERATION_SYSTEM_PROMPT,
    MERMAID_RUNTIME_VERSION,
    MERMAID_SYNTAX_PROFILE,
    build_final_diagram_user_prompt,
    build_output_language_requirement,
    detect_dominant_dialogue_language,
)


def test_shared_mermaid_prompt_includes_runtime_and_structure_rules() -> None:
    prompt = build_final_diagram_user_prompt(
        "Turn 1 | user | propose\n先画网关和鉴权服务。",
        sample_id="sample-1",
        diagram_type="flowchart",
    )

    assert f"Mermaid runtime version: {MERMAID_RUNTIME_VERSION}" in prompt
    assert f"Syntax profile: {MERMAID_SYNTAX_PROFILE}" in prompt
    assert "Use this header unless the dialogue makes a different valid family unavoidable: flowchart TD" in prompt
    assert "Never chain multiple edges or declarations on one line." in MERMAID_GENERATION_SYSTEM_PROMPT
    assert "Detected dominant dialogue language: Chinese." in prompt
    assert "Output every human-readable diagram label in Chinese." in prompt
    assert "Use the same dominant language as the source dialogue for every human-readable label." in MERMAID_GENERATION_SYSTEM_PROMPT


def test_language_requirement_prefers_source_language_without_translation() -> None:
    assert detect_dominant_dialogue_language("先提交材料，再进入审批流程。API Gateway 保留英文名。") == "Chinese"
    assert detect_dominant_dialogue_language("User submits the form and waits for approval.") == "English"
    requirement = build_output_language_requirement("办事人先填写申请表单，再提交材料。")
    assert "Do not translate Chinese source content into English." in requirement


def test_generate_mermaid_state_repairs_failed_candidate(
    session_factory: sessionmaker,
    monkeypatch,
) -> None:
    with session_factory() as db:
        session_obj = RealtimeSession(
            title="repair session",
            status="active",
            config_snapshot={"runtime_options": {"llm_profile_id": "llm-default", "llm_model": "model-a"}},
            pipeline_payload={
                "mermaid_state": {
                    "code": "flowchart TD\nPrev[Previous] --> Safe[Safe]",
                    "normalized_code": "flowchart TD\nPrev[Previous] --> Safe[Safe]",
                }
            },
        )
        db.add(session_obj)
        db.flush()
        db.add(
            RealtimeChunk(
                session_id=session_obj.id,
                sequence_no=1,
                timestamp_ms=0,
                speaker="expert",
                text="先有 API Gateway，再连到 Auth 和 Backend。",
                is_final=True,
                meta_json={},
            )
        )
        db.commit()

        monkeypatch.setattr(
            realtime_ai,
            "resolve_profile",
            lambda db, kind, profile_id: {
                "id": "llm-default",
                "endpoint": "https://example.test/v1/chat/completions",
                "default_model": "model-a",
            },
        )
        monkeypatch.setattr(realtime_ai, "_profile_headers", lambda profile: {})

        request_messages: list[list[dict[str, str]]] = []
        raw_outputs = iter(
            [
                {
                    "choices": [
                        {
                            "message": {
                                "content": "flowchart TD\nClient[Client] --> APIGateway[API Gateway] APIGateway -- Auth[Auth]"
                            }
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "message": {
                                "content": "flowchart TD\nClient[Client] --> APIGateway[API Gateway]\nAPIGateway --> Auth[Auth]"
                            }
                        }
                    ]
                },
            ]
        )

        def fake_json_post(endpoint, payload, headers, timeout_sec=90):
            request_messages.append(payload["messages"])
            return next(raw_outputs)

        monkeypatch.setattr(realtime_ai, "_json_post", fake_json_post)

        compile_inputs: list[str] = []

        def fake_compile_state(code: str):
            compile_inputs.append(code)
            if len(compile_inputs) == 1:
                return False, {
                    "compile_success": False,
                    "returncode": 1,
                    "stderr": "Lexical error near APIGateway -- Auth",
                    "stdout": "",
                    "command": "mmdc",
                }
            return True, {
                "compile_success": True,
                "returncode": 0,
                "stderr": "",
                "stdout": "",
                "command": "mmdc",
            }

        monkeypatch.setattr(realtime_ai, "_compile_state", fake_compile_state)

        repaired = realtime_ai.generate_mermaid_state(db, session_obj)

    assert len(request_messages) == 2
    assert request_messages[0][0]["content"] == MERMAID_GENERATION_SYSTEM_PROMPT
    assert f"Mermaid runtime version: {MERMAID_RUNTIME_VERSION}" in request_messages[1][1]["content"]
    assert "Compiler feedback:" in request_messages[1][1]["content"]
    assert repaired["compile_ok"] is True
    assert repaired["repair_attempted"] is True
    assert repaired["repair_succeeded"] is True
    assert repaired["mermaid_version"] == MERMAID_RUNTIME_VERSION
    assert repaired["syntax_profile"] == MERMAID_SYNTAX_PROFILE
    assert "APIGateway -- Auth[Auth]" in repaired["raw_output_text"]
    assert "APIGateway --> Auth[Auth]" in repaired["repair_raw_output_text"]
    assert repaired["normalized_code"] == "flowchart TD\nClient[Client] --> APIGateway[API Gateway]\nAPIGateway --> Auth[Auth]"
