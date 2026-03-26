from __future__ import annotations

import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
import uuid
import wave
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import RealtimeChunk, RealtimeSession
from app.services.runtime_options import resolve_profile
from tools.eval.common import extract_mermaid_candidate
from tools.eval.metrics import MermaidCompileChecker, normalize_mermaid


LLM_SYSTEM_PROMPT = (
    "You update the current best Mermaid diagram for an in-progress collaborative conversation. "
    "Return Mermaid code only. Do not add explanations, markdown fences, or commentary."
)


def _json_post(endpoint: str, payload: dict[str, Any], headers: dict[str, str], timeout_sec: int = 90) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_sec) as response:
        return json.loads(response.read().decode("utf-8"))


def _multipart_post(
    endpoint: str,
    fields: dict[str, str],
    file_field_name: str,
    file_name: str,
    file_bytes: bytes,
    file_content_type: str,
    headers: dict[str, str],
    timeout_sec: int = 120,
) -> dict[str, Any]:
    boundary = f"stream2graph-{uuid.uuid4().hex}"
    body = io.BytesIO()
    for key, value in fields.items():
        body.write(f"--{boundary}\r\n".encode("utf-8"))
        body.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        body.write(str(value).encode("utf-8"))
        body.write(b"\r\n")
    body.write(f"--{boundary}\r\n".encode("utf-8"))
    body.write(
        (
            f'Content-Disposition: form-data; name="{file_field_name}"; filename="{file_name}"\r\n'
            f"Content-Type: {file_content_type}\r\n\r\n"
        ).encode("utf-8")
    )
    body.write(file_bytes)
    body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode("utf-8"))
    payload = body.getvalue()
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_sec) as response:
        return json.loads(response.read().decode("utf-8"))


def _profile_headers(profile: dict[str, Any]) -> dict[str, str]:
    api_key = str(profile.get("api_key", "")).strip()
    if api_key:
        return {"Authorization": f"Bearer {api_key}"}
    api_key_env = str(profile.get("api_key_env", ""))
    api_key = os.getenv(api_key_env, "") if api_key_env else ""
    if api_key_env and not api_key:
        raise RuntimeError(f"missing environment variable: {api_key_env}")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def _extract_text_from_chat_response(payload: dict[str, Any]) -> str:
    choices = payload.get("choices", [])
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message", {})
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") in {"text", "output_text"}:
                texts.append(str(item.get("text", "")))
        return "\n".join(part for part in texts if part)
    return ""


def _transcript_lines(db: Session, session_id: str) -> list[str]:
    rows = db.scalars(
        select(RealtimeChunk).where(RealtimeChunk.session_id == session_id).order_by(RealtimeChunk.sequence_no.asc())
    ).all()
    return [f"{row.speaker}: {row.text}" for row in rows]


def _current_runtime_options(session_obj: RealtimeSession) -> dict[str, Any]:
    snapshot = session_obj.config_snapshot if isinstance(session_obj.config_snapshot, dict) else {}
    options = snapshot.get("runtime_options", {})
    return options if isinstance(options, dict) else {}


def _previous_mermaid_state(session_obj: RealtimeSession) -> dict[str, Any]:
    payload = session_obj.pipeline_payload if isinstance(session_obj.pipeline_payload, dict) else {}
    state = payload.get("mermaid_state", {})
    return state if isinstance(state, dict) else {}


def _compile_state(normalized_code: str) -> tuple[bool | None, dict[str, Any] | None]:
    settings = get_settings()
    if not settings.mermaid_compile_command:
        return None, None
    checker = MermaidCompileChecker(settings.mermaid_compile_command)
    result = checker.check(normalized_code)
    return bool(result.get("compile_success")), result


def generate_mermaid_state(db: Session, session_obj: RealtimeSession) -> dict[str, Any]:
    runtime_options = _current_runtime_options(session_obj)
    profile = resolve_profile(db, "llm", runtime_options.get("llm_profile_id"))
    model = str(runtime_options.get("llm_model") or (profile or {}).get("default_model") or "")
    previous = _previous_mermaid_state(session_obj)
    if not profile or not model:
        return {
            **previous,
            "provider": (profile or {}).get("id", ""),
            "model": model,
            "render_ok": False,
            "error_message": "未配置可用的 LLM profile / model。",
            "updated_at": int(time.time() * 1000),
        }

    transcript = "\n".join(_transcript_lines(db, session_obj.id)).strip()
    if not transcript:
        return {
            **previous,
            "provider": str(profile.get("id", "")),
            "model": model,
            "render_ok": False,
            "error_message": "当前会话还没有可用于生成 Mermaid 的文本。",
            "updated_at": int(time.time() * 1000),
        }

    prompt = "\n".join(
        [
            f"Session title: {session_obj.title}",
            "",
            "Generate the current best complete Mermaid diagram from the transcript below.",
            "Return Mermaid code only.",
            "",
            transcript,
        ]
    )
    t0 = time.time()
    try:
        response = _json_post(
            str(profile["endpoint"]),
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
            },
            _profile_headers(profile),
        )
        raw_text = _extract_text_from_chat_response(response)
        candidate = extract_mermaid_candidate(raw_text)
        normalized = normalize_mermaid(candidate)
        if not normalized:
            raise RuntimeError("LLM 未返回可用 Mermaid 代码。")
        compile_ok, compile_payload = _compile_state(normalized)
        error_message = None
        if compile_ok is False:
            error_message = "Mermaid 编译失败，已保留上一次成功结果。"
        latency_ms = round((time.time() - t0) * 1000.0, 4)
        state = {
            "code": previous.get("code") if compile_ok is False and previous.get("code") else candidate,
            "normalized_code": previous.get("normalized_code") if compile_ok is False and previous.get("normalized_code") else normalized,
            "compile_ok": compile_ok,
            "render_ok": compile_ok is not False,
            "provider": str(profile.get("id", "")),
            "model": model,
            "latency_ms": latency_ms,
            "error_message": error_message,
            "updated_at": int(time.time() * 1000),
        }
        if compile_payload is not None:
            state["compile_payload"] = compile_payload
        return state
    except (RuntimeError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        return {
            **previous,
            "provider": str(profile.get("id", "")),
            "model": model,
            "render_ok": False,
            "latency_ms": round((time.time() - t0) * 1000.0, 4),
            "error_message": str(exc),
            "updated_at": int(time.time() * 1000),
        }


def _pcm_s16le_to_wav_bytes(raw_pcm: bytes, sample_rate: int, channel_count: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(channel_count)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(raw_pcm)
    return output.getvalue()


def transcribe_audio_chunk(db: Session, session_obj: RealtimeSession, payload: dict[str, Any]) -> dict[str, Any]:
    runtime_options = _current_runtime_options(session_obj)
    profile = resolve_profile(db, "stt", runtime_options.get("stt_profile_id"))
    model = str(runtime_options.get("stt_model") or (profile or {}).get("default_model") or "")
    if not profile or not model:
        raise RuntimeError("未配置可用的 STT profile / model。")
    raw_pcm = base64.b64decode(str(payload["pcm_s16le_base64"]).encode("utf-8"))
    wav_bytes = _pcm_s16le_to_wav_bytes(raw_pcm, int(payload["sample_rate"]), int(payload.get("channel_count", 1)))
    t0 = time.time()
    response = _multipart_post(
        str(profile["endpoint"]),
        {
            "model": model,
            "language": "zh",
            "response_format": "json",
        },
        "file",
        "chunk.wav",
        wav_bytes,
        "audio/wav",
        _profile_headers(profile),
    )
    latency_ms = round((time.time() - t0) * 1000.0, 4)
    return {
        "text": str(response.get("text", "")).strip(),
        "provider": str(profile.get("id", "")),
        "model": model,
        "latency_ms": latency_ms,
    }
