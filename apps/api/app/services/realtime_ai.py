from __future__ import annotations

import base64
import io
import json
import logging
import os
import ssl
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
from app.services.xfyun_asr import (
    DEFAULT_XFYUN_ASR_ENDPOINT,
    XFYUN_ASR_PROVIDER_KIND,
    transcribe_pcm_s16le_with_xfyun,
)
from tools.eval.common import extract_mermaid_candidate
from tools.eval.metrics import MermaidCompileChecker, normalize_mermaid
from tools.mermaid_prompting import (
    MERMAID_GENERATION_SYSTEM_PROMPT,
    MERMAID_RUNTIME_VERSION,
    MERMAID_SYNTAX_PROFILE,
    build_final_diagram_user_prompt,
    build_repair_diagram_user_prompt,
)


LLM_SYSTEM_PROMPT = MERMAID_GENERATION_SYSTEM_PROMPT
logger = logging.getLogger(__name__)


def _snippet(text: str, max_chars: int = 1200) -> str:
    value = (text or "").strip()
    if len(value) <= max_chars:
        return value
    return f"{value[:max_chars]}\n... [truncated {len(value) - max_chars} chars]"


def _log_payload(prefix: str, payload: dict[str, Any]) -> None:
    logger.info("%s %s", prefix, json.dumps(payload, ensure_ascii=False))


def _json_post(endpoint: str, payload: dict[str, Any], headers: dict[str, str], timeout_sec: int = 90) -> dict[str, Any]:
    settings = get_settings()
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_sec, context=_build_ssl_context(settings)) as response:
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
    settings = get_settings()
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
    with urllib.request.urlopen(request, timeout=timeout_sec, context=_build_ssl_context(settings)) as response:
        return json.loads(response.read().decode("utf-8"))


def _build_ssl_context(settings) -> ssl.SSLContext:
    if not settings.tls_verify:
        return ssl._create_unverified_context()
    if settings.ca_bundle.strip():
        return ssl.create_default_context(cafile=settings.ca_bundle.strip())
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


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


def _request_mermaid_candidate(
    profile: dict[str, Any],
    model: str,
    *,
    system_prompt: str,
    user_prompt: str,
) -> tuple[str, str, str]:
    response = _json_post(
        str(profile["endpoint"]),
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0,
        },
        _profile_headers(profile),
    )
    raw_text = _extract_text_from_chat_response(response)
    candidate = extract_mermaid_candidate(raw_text)
    normalized = normalize_mermaid(candidate)
    return raw_text, candidate, normalized


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

    prompt = build_final_diagram_user_prompt(
        transcript,
        session_title=session_obj.title,
        current_best=True,
    )
    t0 = time.time()
    raw_text = ""
    repair_raw_text = ""
    _log_payload(
        "Mermaid generation started",
        {
            "session_id": session_obj.id,
            "session_title": session_obj.title,
            "provider": str((profile or {}).get("id", "")),
            "model": model,
            "transcript_chars": len(transcript),
            "transcript_preview": _snippet(transcript, 800),
        },
    )
    try:
        raw_text, candidate, normalized = _request_mermaid_candidate(
            profile,
            model,
            system_prompt=LLM_SYSTEM_PROMPT,
            user_prompt=prompt,
        )
        _log_payload(
            "Mermaid generation received candidate",
            {
                "session_id": session_obj.id,
                "raw_chars": len(raw_text),
                "candidate_chars": len(candidate),
                "normalized_chars": len(normalized),
                "candidate_preview": _snippet(candidate),
                "normalized_preview": _snippet(normalized),
            },
        )
        if not normalized:
            raise RuntimeError("LLM 未返回可用 Mermaid 代码。")
        compile_ok, compile_payload = _compile_state(normalized)
        error_message = None
        repair_attempted = False
        repair_succeeded = False
        if compile_ok is False:
            repair_attempted = True
            repair_prompt = build_repair_diagram_user_prompt(
                transcript,
                candidate,
                str((compile_payload or {}).get("stderr", "")),
                session_title=session_obj.title,
            )
            _log_payload(
                "Mermaid repair attempt started",
                {
                    "session_id": session_obj.id,
                    "compile_stderr": _snippet(str((compile_payload or {}).get("stderr", ""))),
                    "broken_candidate_preview": _snippet(candidate),
                },
            )
            repair_raw_text, repaired_candidate, repaired_normalized = _request_mermaid_candidate(
                profile,
                model,
                system_prompt=LLM_SYSTEM_PROMPT,
                user_prompt=repair_prompt,
            )
            _log_payload(
                "Mermaid repair attempt received candidate",
                {
                    "session_id": session_obj.id,
                    "raw_chars": len(repair_raw_text),
                    "candidate_chars": len(repaired_candidate),
                    "normalized_chars": len(repaired_normalized),
                    "candidate_preview": _snippet(repaired_candidate),
                    "normalized_preview": _snippet(repaired_normalized),
                },
            )
            if repaired_normalized:
                repaired_compile_ok, repaired_compile_payload = _compile_state(repaired_normalized)
                if repaired_compile_ok is not False:
                    candidate = repaired_candidate
                    normalized = repaired_normalized
                    compile_ok = repaired_compile_ok
                    compile_payload = repaired_compile_payload
                    repair_succeeded = True
                else:
                    compile_payload = repaired_compile_payload
            error_message = (
                None
                if repair_succeeded
                else "Mermaid 编译失败，已保留上一次成功结果。"
            )
        latency_ms = round((time.time() - t0) * 1000.0, 4)
        _log_payload(
            "Mermaid generation compile result",
            {
                "session_id": session_obj.id,
                "compile_ok": compile_ok,
                "latency_ms": latency_ms,
                "compile_returncode": None if compile_payload is None else compile_payload.get("returncode"),
                "compile_stderr": ""
                if compile_payload is None
                else _snippet(str(compile_payload.get("stderr", "")), 1200),
                "reused_previous_state": bool(compile_ok is False and previous.get("code")),
                "repair_attempted": repair_attempted,
                "repair_succeeded": repair_succeeded,
            },
        )
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
            "mermaid_version": MERMAID_RUNTIME_VERSION,
            "syntax_profile": MERMAID_SYNTAX_PROFILE,
            "repair_attempted": repair_attempted,
            "repair_succeeded": repair_succeeded,
            "raw_output_text": raw_text,
        }
        if repair_raw_text:
            state["repair_raw_output_text"] = repair_raw_text
        if compile_payload is not None:
            state["compile_payload"] = compile_payload
        return state
    except (RuntimeError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError, AttributeError) as exc:
        logger.exception(
            "Mermaid generation failed %s",
            json.dumps(
                {
                    "session_id": session_obj.id,
                    "provider": str((profile or {}).get("id", "")),
                    "model": model,
                    "error": str(exc),
                },
                ensure_ascii=False,
            ),
        )
        return {
            **previous,
            "provider": str(profile.get("id", "")),
            "model": model,
            "render_ok": False,
            "latency_ms": round((time.time() - t0) * 1000.0, 4),
            "error_message": str(exc),
            "updated_at": int(time.time() * 1000),
            "raw_output_text": raw_text or str(previous.get("raw_output_text", "")),
            "repair_raw_output_text": repair_raw_text or str(previous.get("repair_raw_output_text", "")),
        }
    except Exception as exc:
        logger.exception(
            "Mermaid generation failed %s",
            json.dumps(
                {
                    "session_id": session_obj.id,
                    "provider": str((profile or {}).get("id", "")),
                    "model": model,
                    "error": str(exc),
                },
                ensure_ascii=False,
            ),
        )
        return {
            **previous,
            "provider": str(profile.get("id", "")),
            "model": model,
            "render_ok": False,
            "latency_ms": round((time.time() - t0) * 1000.0, 4),
            "error_message": str(exc),
            "updated_at": int(time.time() * 1000),
            "raw_output_text": raw_text or str(previous.get("raw_output_text", "")),
            "repair_raw_output_text": repair_raw_text or str(previous.get("repair_raw_output_text", "")),
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
    provider_kind = str(profile.get("provider_kind", "openai_compatible")).strip() or "openai_compatible"
    _log_payload(
        "STT transcription started",
        {
            "session_id": session_obj.id,
            "provider": str(profile.get("id", "")),
            "provider_kind": provider_kind,
            "model": model,
            "sample_rate": int(payload["sample_rate"]),
            "channel_count": int(payload.get("channel_count", 1)),
        },
    )
    if provider_kind == XFYUN_ASR_PROVIDER_KIND:
        app_id = str(profile.get("app_id", "")).strip()
        api_key = str(profile.get("api_key", "")).strip()
        api_secret = str(profile.get("api_secret", "")).strip()
        api_key_env = str(profile.get("api_key_env", "")).strip()
        api_secret_env = str(profile.get("api_secret_env", "")).strip()
        if not api_key and api_key_env:
            api_key = os.getenv(api_key_env, "").strip()
        if not api_secret and api_secret_env:
            api_secret = os.getenv(api_secret_env, "").strip()
        missing = [name for name, value in (("app_id", app_id), ("api_key", api_key), ("api_secret", api_secret)) if not value]
        if missing:
            raise RuntimeError(f"讯飞 STT 配置不完整：缺少 {', '.join(missing)}。")
        result = transcribe_pcm_s16le_with_xfyun(
            endpoint=str(profile.get("endpoint", DEFAULT_XFYUN_ASR_ENDPOINT) or DEFAULT_XFYUN_ASR_ENDPOINT),
            app_id=app_id,
            api_key=api_key,
            api_secret=api_secret,
            pcm_s16le_base64=str(payload["pcm_s16le_base64"]),
            sample_rate=int(payload["sample_rate"]),
            channel_count=int(payload.get("channel_count", 1)),
            model=model,
        )
        response = {
            "text": str(result.get("text", "")).strip(),
            "provider": str(profile.get("id", "")),
            "model": model,
            "latency_ms": float(result.get("latency_ms", 0.0) or 0.0),
            "sid": str(result.get("sid", "")).strip(),
        }
        _log_payload(
            "STT transcription succeeded",
            {
                "session_id": session_obj.id,
                "provider": response["provider"],
                "provider_kind": provider_kind,
                "model": model,
                "latency_ms": response["latency_ms"],
                "text_chars": len(response["text"]),
                "sid": response["sid"],
            },
        )
        return response

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
    response = {
        "text": str(response.get("text", "")).strip(),
        "provider": str(profile.get("id", "")),
        "model": model,
        "latency_ms": latency_ms,
    }
    _log_payload(
        "STT transcription succeeded",
        {
            "session_id": session_obj.id,
            "provider": response["provider"],
            "provider_kind": provider_kind,
            "model": model,
            "latency_ms": latency_ms,
            "text_chars": len(response["text"]),
        },
    )
    return response
