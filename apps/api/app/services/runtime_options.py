from __future__ import annotations

import asyncio
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

import certifi
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import PlatformSetting
from app.services.voiceprints import (
    RTASR_VOICEPRINT_REGISTER_PATH,
    build_voiceprint_auth_preview,
    voiceprint_config_from_profile,
)
from app.services.xfyun_asr import (
    DEFAULT_XFYUN_ASR_ENDPOINT,
    DEFAULT_XFYUN_ASR_MODELS,
    XFYUN_ASR_PROVIDER_KIND,
    _decode_message_payload,
    _extract_remote_session_id,
    _message_error,
    _websocket_connect,
    build_xfyun_asr_auth_url,
)


RUNTIME_OPTIONS_KEY = "runtime_options"
DEFAULT_XFYUN_VOICEPRINT_BASE = "https://office-api-personal-dx.iflyaisol.com"
LEGACY_XFYUN_VOICEPRINT_BASE = "https://api.xf-yun.com"
LEGACY_XFYUN_ASR_ENDPOINT = "wss://iat-api.xfyun.cn/v2/iat"

DEFAULT_GATE_PROFILES = [
    {
        "id": "gate-default",
        "label": "Gate Default",
        "provider_kind": "openai_compatible",
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "models": ["gpt-4.1-mini"],
        "default_model": "gpt-4.1-mini",
        "api_key_env": "OPENAI_API_KEY",
    }
]
DEFAULT_PLANNER_PROFILES = [
    {
        "id": "planner-default",
        "label": "Planner Default",
        "provider_kind": "openai_compatible",
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "models": ["gpt-4.1-mini"],
        "default_model": "gpt-4.1-mini",
        "api_key_env": "OPENAI_API_KEY",
    }
]
DEFAULT_STT_PROFILES = [
    {
        "id": "stt-default",
        "label": "STT Default",
        "provider_kind": XFYUN_ASR_PROVIDER_KIND,
        "endpoint": DEFAULT_XFYUN_ASR_ENDPOINT,
        "models": list(DEFAULT_XFYUN_ASR_MODELS),
        "default_model": DEFAULT_XFYUN_ASR_MODELS[0],
    }
]


def _normalize_stt_models(models: Any, default_model: str) -> tuple[list[str], str]:
    raw_models = models
    if isinstance(raw_models, str):
        raw_models = [part.strip() for part in raw_models.split(",") if part.strip()]
    if not isinstance(raw_models, list):
        raw_models = []
    normalized_models = [str(model).strip() for model in raw_models if str(model).strip()]
    if not normalized_models or any(model in {"iat", "xfime-mianqie"} for model in normalized_models):
        normalized_models = list(DEFAULT_XFYUN_ASR_MODELS)
    resolved_default = str(default_model or "").strip()
    if not resolved_default or resolved_default in {"iat", "xfime-mianqie"} or resolved_default not in normalized_models:
        resolved_default = normalized_models[0]
    return normalized_models, resolved_default


def _legacy_collection_name(kind: str) -> str | None:
    if kind in {"gate", "planner", "llm"}:
        return "llm_profiles"
    if kind == "stt":
        return "stt_profiles"
    return None


def _collection_name(kind: str) -> str:
    if kind == "llm":
        return "planner_profiles"
    return f"{kind}_profiles"


def _normalize_profile(row: dict[str, Any], *, kind: str, include_secrets: bool = False) -> dict[str, Any] | None:
    models = row.get("models", [])
    if isinstance(models, str):
        models = [part.strip() for part in models.split(",") if part.strip()]
    if not isinstance(models, list):
        models = []
    normalized_models = [str(model).strip() for model in models if str(model).strip()]
    profile_id = str(row.get("id", "")).strip()
    provider_kind_default = XFYUN_ASR_PROVIDER_KIND if kind == "stt" else "openai_compatible"
    provider_kind = str(row.get("provider_kind", provider_kind_default)).strip() or provider_kind_default
    endpoint_default = DEFAULT_XFYUN_ASR_ENDPOINT if provider_kind == XFYUN_ASR_PROVIDER_KIND else ""
    endpoint = str(row.get("endpoint", endpoint_default)).strip() or endpoint_default
    if kind == "stt" and provider_kind == XFYUN_ASR_PROVIDER_KIND and endpoint.rstrip("/") == LEGACY_XFYUN_ASR_ENDPOINT:
        endpoint = DEFAULT_XFYUN_ASR_ENDPOINT
    label = str(row.get("label", profile_id)).strip() or profile_id
    default_model = str(row.get("default_model", "")).strip()
    extra_body_json = str(row.get("extra_body_json", "") or "").strip()
    app_id = str(row.get("app_id", "")).strip()
    api_key_env = str(row.get("api_key_env", "")).strip()
    api_key = str(row.get("api_key", "")).strip()
    api_secret_env = str(row.get("api_secret_env", "")).strip()
    api_secret = str(row.get("api_secret", "")).strip()
    voiceprint = _normalize_voiceprint(
        row.get("voiceprint"),
        profile_id=profile_id,
        include_secrets=include_secrets,
    )

    if provider_kind == XFYUN_ASR_PROVIDER_KIND and kind == "stt":
        normalized_models, default_model = _normalize_stt_models(models, default_model)

    if not profile_id or not endpoint or not normalized_models:
        return None
    if not default_model or default_model not in normalized_models:
        default_model = normalized_models[0]

    payload: dict[str, Any] = {
        "id": profile_id,
        "label": label,
        "provider_kind": provider_kind,
        "endpoint": endpoint,
        "models": normalized_models,
        "default_model": default_model,
        "extra_body_json": extra_body_json,
        "app_id": app_id,
        "api_key_env": api_key_env,
        "api_secret_env": api_secret_env,
    }
    if voiceprint is not None:
        payload["voiceprint"] = voiceprint
    if include_secrets:
        payload["api_key"] = api_key
        payload["api_secret"] = api_secret
    return payload


def _profile_summary(row: dict[str, Any], *, kind: str) -> dict[str, Any]:
    models = list(row.get("models", []))
    default_model = str(row.get("default_model", ""))
    if kind == "stt" and str(row.get("provider_kind", "")) == XFYUN_ASR_PROVIDER_KIND:
        models, default_model = _normalize_stt_models(models, default_model)
    extra_body_json = str(row.get("extra_body_json", "") or "").strip()
    payload = {
        "id": str(row.get("id", "")),
        "label": str(row.get("label", row.get("id", ""))),
        "provider_kind": str(row.get("provider_kind", XFYUN_ASR_PROVIDER_KIND if kind == "stt" else "openai_compatible")),
        "models": models,
        "default_model": default_model,
        "extra_body_json": extra_body_json,
    }
    voiceprint = _normalize_voiceprint(
        row.get("voiceprint"),
        profile_id=str(row.get("id", "")),
        include_secrets=False,
    )
    if voiceprint is not None:
        payload["voiceprint"] = voiceprint
    return payload


def _normalize_voiceprint(raw: Any, *, profile_id: str, include_secrets: bool) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    enabled = bool(raw.get("enabled", False))
    provider_kind = str(raw.get("provider_kind", "xfyun_isv")).strip() or "xfyun_isv"
    api_base = str(raw.get("api_base", DEFAULT_XFYUN_VOICEPRINT_BASE)).strip().rstrip("/") or DEFAULT_XFYUN_VOICEPRINT_BASE
    if api_base == LEGACY_XFYUN_VOICEPRINT_BASE:
        api_base = DEFAULT_XFYUN_VOICEPRINT_BASE
    app_id = str(raw.get("app_id", "")).strip()
    api_key = str(raw.get("api_key", "")).strip()
    api_secret = str(raw.get("api_secret", "")).strip()
    group_id = str(raw.get("group_id", "")).strip() or (f"{profile_id}_group" if profile_id else "")
    try:
        score_threshold = float(raw.get("score_threshold", 0.75) or 0.75)
    except (TypeError, ValueError):
        score_threshold = 0.75
    try:
        top_k = int(raw.get("top_k", 3) or 3)
    except (TypeError, ValueError):
        top_k = 3
    top_k = max(1, min(top_k, 10))

    payload: dict[str, Any] = {
        "enabled": enabled,
        "provider_kind": provider_kind,
        "api_base": api_base,
        "app_id": app_id,
        "group_id": group_id,
        "score_threshold": score_threshold,
        "top_k": top_k,
    }
    if include_secrets:
        if api_key:
            payload["api_key"] = api_key
        if api_secret:
            payload["api_secret"] = api_secret
    return payload


def _load_persisted_payload(db: Session) -> dict[str, Any]:
    row = db.scalar(select(PlatformSetting).where(PlatformSetting.setting_key == RUNTIME_OPTIONS_KEY))
    if row is None or not isinstance(row.value_json, dict):
        return {}
    return row.value_json


def _persisted_profiles(db: Session, kind: str, *, include_secrets: bool = False) -> list[dict[str, Any]]:
    payload = _load_persisted_payload(db)
    raw_profiles = payload.get(_collection_name(kind), [])
    if not raw_profiles and _legacy_collection_name(kind):
        raw_profiles = payload.get(_legacy_collection_name(kind) or "", [])
    if not isinstance(raw_profiles, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in raw_profiles:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_profile(item, kind=kind, include_secrets=include_secrets)
        if normalized:
            rows.append(normalized)
    return rows


def _env_profiles(kind: str, *, include_secrets: bool = False) -> list[dict[str, Any]]:
    settings = get_settings()
    if kind == "gate":
        raw_profiles = settings.gate_profiles or DEFAULT_GATE_PROFILES
    elif kind in {"planner", "llm"}:
        raw_profiles = settings.planner_profiles or DEFAULT_PLANNER_PROFILES
    else:
        raw_profiles = settings.stt_profiles or DEFAULT_STT_PROFILES
    rows: list[dict[str, Any]] = []
    for item in raw_profiles:
        normalized = _normalize_profile(item, kind=kind, include_secrets=include_secrets)
        if normalized:
            rows.append(normalized)
    return rows


def _merge_profiles(primary: list[dict[str, Any]], fallback: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in [*primary, *fallback]:
        profile_id = str(item.get("id", "")).strip()
        if not profile_id or profile_id in seen:
            continue
        merged.append(item)
        seen.add(profile_id)
    return merged


def list_runtime_options(db: Session, *, include_secrets: bool = False) -> dict[str, list[dict[str, Any]]]:
    gate_profiles = _merge_profiles(
        _persisted_profiles(db, "gate", include_secrets=include_secrets),
        _env_profiles("gate", include_secrets=include_secrets),
    )
    planner_profiles = _merge_profiles(
        _persisted_profiles(db, "planner", include_secrets=include_secrets),
        _env_profiles("planner", include_secrets=include_secrets),
    )
    stt_profiles = _merge_profiles(
        _persisted_profiles(db, "stt", include_secrets=include_secrets),
        _env_profiles("stt", include_secrets=include_secrets),
    )
    if include_secrets:
        return {
            "gate_profiles": gate_profiles,
            "planner_profiles": planner_profiles,
            "stt_profiles": stt_profiles,
        }
    return {
        "gate_profiles": [_profile_summary(item, kind="gate") for item in gate_profiles],
        "planner_profiles": [_profile_summary(item, kind="planner") for item in planner_profiles],
        "stt_profiles": [_profile_summary(item, kind="stt") for item in stt_profiles],
    }


def list_persisted_runtime_options(db: Session, *, include_secrets: bool = False) -> dict[str, list[dict[str, Any]]]:
    gate_profiles = _persisted_profiles(db, "gate", include_secrets=include_secrets)
    planner_profiles = _persisted_profiles(db, "planner", include_secrets=include_secrets)
    stt_profiles = _persisted_profiles(db, "stt", include_secrets=include_secrets)
    return {
        "gate_profiles": gate_profiles,
        "planner_profiles": planner_profiles,
        "stt_profiles": stt_profiles,
    }


def save_runtime_options(db: Session, payload: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    normalized_payload = {
        "gate_profiles": _persisted_profiles_from_payload(payload.get("gate_profiles", []), kind="gate"),
        "planner_profiles": _persisted_profiles_from_payload(payload.get("planner_profiles", []), kind="planner"),
        "stt_profiles": _persisted_profiles_from_payload(payload.get("stt_profiles", []), kind="stt"),
    }
    row = db.scalar(select(PlatformSetting).where(PlatformSetting.setting_key == RUNTIME_OPTIONS_KEY))
    if row is None:
        row = PlatformSetting(setting_key=RUNTIME_OPTIONS_KEY, value_json=normalized_payload)
        db.add(row)
    else:
        row.value_json = normalized_payload
        db.add(row)
    db.flush()
    return list_persisted_runtime_options(db, include_secrets=True)


def _persisted_profiles_from_payload(raw_profiles: list[Any], *, kind: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(raw_profiles, list):
        return rows
    for item in raw_profiles:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_profile(
            item,
            kind=kind,
            include_secrets=True,
        )
        if normalized:
            rows.append(normalized)
    return rows


def resolve_profile(db: Session, kind: str, profile_id: str | None) -> dict[str, Any] | None:
    profiles = list_runtime_options(db, include_secrets=True)
    if kind == "gate":
        items = profiles["gate_profiles"]
    elif kind == "planner":
        items = profiles["planner_profiles"]
    elif kind == "llm":
        items = profiles["planner_profiles"] or profiles["gate_profiles"]
    else:
        items = profiles["stt_profiles"]
    if not items:
        return None
    if profile_id:
        for item in items:
            if str(item.get("id")) == profile_id:
                return item
    return items[0]


def _resolve_models_endpoint(endpoint: str) -> str:
    parsed = urllib.parse.urlsplit(endpoint.strip())
    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1/models"
    elif path.endswith("/models"):
        pass
    elif "/v1/" in path:
        prefix = path.split("/v1/", 1)[0]
        path = f"{prefix}/v1/models"
    else:
        path = f"{path}/models"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


def _build_ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


def _format_probe_error(reason: object) -> str:
    raw = str(reason).strip()
    upper = raw.upper()
    if "CERTIFICATE_VERIFY_FAILED" in upper:
        return "模型探测失败：TLS 证书校验失败。已使用 certifi 证书链；如果仍失败，请检查本机代理、系统证书或企业网络环境。"
    return f"model probe failed: {raw}"


def probe_runtime_models(
    *,
    endpoint: str,
    provider_kind: str = "openai_compatible",
    api_key: str | None = None,
    api_key_env: str | None = None,
    timeout_sec: int = 30,
) -> dict[str, Any]:
    if provider_kind == XFYUN_ASR_PROVIDER_KIND:
        return {
            "provider_kind": provider_kind,
            "models_endpoint": (endpoint or DEFAULT_XFYUN_ASR_ENDPOINT).strip() or DEFAULT_XFYUN_ASR_ENDPOINT,
            "models": list(DEFAULT_XFYUN_ASR_MODELS),
        }
    if provider_kind != "openai_compatible":
        raise RuntimeError(f"unsupported provider_kind: {provider_kind}")

    resolved_endpoint = _resolve_models_endpoint(endpoint)
    resolved_api_key = (api_key or "").strip()
    if not resolved_api_key and api_key_env:
        resolved_api_key = os.getenv(api_key_env.strip(), "").strip()

    headers = {"Accept": "application/json"}
    if resolved_api_key:
        headers["Authorization"] = f"Bearer {resolved_api_key}"

    request = urllib.request.Request(resolved_endpoint, headers=headers, method="GET")
    ssl_context = _build_ssl_context()
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec, context=ssl_context) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else str(exc)
        raise RuntimeError(f"model probe failed with HTTP {exc.code}: {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(_format_probe_error(exc.reason)) from exc

    rows = payload.get("data", [])
    if not isinstance(rows, list):
        raise RuntimeError("model probe failed: provider returned invalid model payload")

    models = sorted(
        {
            str(item.get("id", "")).strip()
            for item in rows
            if isinstance(item, dict) and str(item.get("id", "")).strip()
        }
    )
    if not models:
        raise RuntimeError("model probe succeeded but no models were returned")

    return {
        "provider_kind": provider_kind,
        "models_endpoint": resolved_endpoint,
        "models": models,
    }


def _beijing_datetime_now() -> str:
    beijing = timezone(timedelta(hours=8))
    return datetime.now(beijing).strftime("%Y-%m-%dT%H:%M:%S%z")


def _mask_value(value: str, *, leading: int = 4, trailing: int = 2) -> str:
    if not value:
        return "(empty)"
    if len(value) <= leading + trailing:
        return "*" * len(value)
    return f"{value[:leading]}***{value[-trailing:]}"


def _resolve_secret_value(
    *,
    label: str,
    direct_value: str | None,
    env_name: str | None,
    logs: list[str],
) -> str:
    direct = (direct_value or "").strip()
    env = (env_name or "").strip()
    if direct:
        logs.append(f"{label}: 使用配置中的明文值（masked={_mask_value(direct)})")
        return direct
    if env:
        env_value = os.getenv(env, "").strip()
        if env_value:
            logs.append(f"{label}: 使用环境变量 {env}（masked={_mask_value(env_value)})")
            return env_value
        logs.append(f"{label}: 环境变量 {env} 未设置或为空")
        return ""
    logs.append(f"{label}: 未提供")
    return ""


def _sanitize_signed_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted: list[tuple[str, str]] = []
    for key, value in query:
        if key in {"accessKeyId", "signature"}:
            redacted.append((key, _mask_value(value)))
        else:
            redacted.append((key, value))
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(redacted, quote_via=urllib.parse.quote), parsed.fragment)
    )


def _sanitize_preview_value(value: str) -> str:
    if not value:
        return value
    return _mask_value(value, leading=6, trailing=4)


async def _test_xfyun_websocket(auth_url: str, logs: list[str]) -> None:
    started_at = time.perf_counter()
    ws = await _websocket_connect(auth_url)
    try:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        logs.append(f"RTASR WebSocket 建连成功，耗时 {elapsed_ms:.1f} ms")
        try:
            raw_message = await asyncio.wait_for(ws.recv(), timeout=2.0)
        except TimeoutError:
            logs.append("连接已建立；2 秒内未收到服务端预热消息，这在 RTASR 首包发音频前是正常的。")
            return
        payload = _decode_message_payload(raw_message)
        remote_session_id = _extract_remote_session_id(payload)
        if remote_session_id:
            logs.append(f"服务端返回 sessionId={remote_session_id}")
        error = _message_error(payload)
        if error is not None:
            raise error
        action = str(payload.get("action", "")).strip() or str(payload.get("msg_type", "")).strip() or "(unknown)"
        logs.append(f"服务端首条消息类型：{action}")
    finally:
        await ws.close()
        logs.append("RTASR WebSocket 已关闭测试连接")


def _test_openai_connection(
    *,
    endpoint: str,
    api_key: str | None,
    api_key_env: str | None,
    logs: list[str],
    timeout_sec: int,
) -> tuple[bool, str]:
    resolved_endpoint = _resolve_models_endpoint(endpoint)
    logs.append(f"模型探测地址：{resolved_endpoint}")
    resolved_api_key = _resolve_secret_value(
        label="API Key",
        direct_value=api_key,
        env_name=api_key_env,
        logs=logs,
    )
    if not resolved_api_key:
        raise RuntimeError("OpenAI Compatible 连接测试失败：缺少 API Key。")

    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {resolved_api_key}",
    }
    request = urllib.request.Request(resolved_endpoint, headers=headers, method="GET")
    started_at = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec, context=_build_ssl_context()) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else str(exc)
        raise RuntimeError(f"连接测试失败：HTTP {exc.code} {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(_format_probe_error(exc.reason)) from exc

    elapsed_ms = (time.perf_counter() - started_at) * 1000
    logs.append(f"模型列表请求成功，HTTP {status}，耗时 {elapsed_ms:.1f} ms")
    rows = payload.get("data", [])
    if not isinstance(rows, list):
        raise RuntimeError("连接测试失败：provider 返回的模型列表结构非法。")
    models = sorted(
        {
            str(item.get("id", "")).strip()
            for item in rows
            if isinstance(item, dict) and str(item.get("id", "")).strip()
        }
    )
    if not models:
        raise RuntimeError("连接测试失败：provider 可访问，但没有返回任何模型。")
    logs.append(f"共返回 {len(models)} 个模型；示例：{', '.join(models[:5])}")
    return True, f"连接成功，可读取 {len(models)} 个模型。"


def _test_xfyun_connection(
    *,
    endpoint: str,
    app_id: str | None,
    api_key: str | None,
    api_key_env: str | None,
    api_secret: str | None,
    api_secret_env: str | None,
    voiceprint: dict[str, Any] | None,
    logs: list[str],
) -> tuple[bool, str]:
    resolved_endpoint = (endpoint or DEFAULT_XFYUN_ASR_ENDPOINT).strip() or DEFAULT_XFYUN_ASR_ENDPOINT
    resolved_app_id = (app_id or "").strip()
    resolved_api_key = _resolve_secret_value(
        label="API Key",
        direct_value=api_key,
        env_name=api_key_env,
        logs=logs,
    )
    resolved_api_secret = _resolve_secret_value(
        label="API Secret",
        direct_value=api_secret,
        env_name=api_secret_env,
        logs=logs,
    )
    logs.append(f"RTASR endpoint：{resolved_endpoint}")
    logs.append(f"App ID：{resolved_app_id or '(empty)'}")
    if not resolved_app_id or not resolved_api_key or not resolved_api_secret:
        raise RuntimeError("讯飞 RTASR 连接测试失败：缺少 App ID / API Key / API Secret。")

    profile = {
        "provider_kind": XFYUN_ASR_PROVIDER_KIND,
        "endpoint": resolved_endpoint,
        "app_id": resolved_app_id,
        "api_key": resolved_api_key,
        "api_secret": resolved_api_secret,
        "voiceprint": voiceprint or None,
    }
    role_type = 2 if isinstance(voiceprint, dict) and bool(voiceprint.get("enabled")) else None
    auth_url = build_xfyun_asr_auth_url(
        resolved_endpoint,
        app_id=resolved_app_id,
        api_key=resolved_api_key,
        api_secret=resolved_api_secret,
        role_type=role_type,
    )
    logs.append(f"签名后的 RTASR 地址：{_sanitize_signed_url(auth_url)}")
    asyncio.run(_test_xfyun_websocket(auth_url, logs))

    if role_type == 2:
        config = voiceprint_config_from_profile(profile)
        if config is None:
            logs.append("声纹增强：已启用，但当前草稿无法解析出可用 voiceprint 配置。")
        else:
            preview_url = f"{str(config['api_base']).rstrip('/')}{RTASR_VOICEPRINT_REGISTER_PATH}"
            preview = build_voiceprint_auth_preview(
                preview_url,
                api_key=str(config["api_key"]),
                api_secret=str(config["api_secret"]),
                date_header=_beijing_datetime_now(),
            )
            logs.append(
                "声纹增强：已启用，测试时仅做签名预览，不会创建或删除远端特征。"
            )
            logs.append(
                f"声纹接口：api_base={config['api_base']} group_id={config['group_id']} app_id={config['app_id'] or '(inherit stt app_id)'}"
            )
            logs.append(
                "声纹签名预览："
                f" host={preview.get('host', '')}"
                f" signature={_sanitize_preview_value(preview.get('signature', ''))}"
            )

    return True, "连接成功，RTASR 鉴权与 WebSocket 建连已通过。"


def test_runtime_connection(
    *,
    endpoint: str,
    provider_kind: str = "openai_compatible",
    app_id: str | None = None,
    api_key: str | None = None,
    api_key_env: str | None = None,
    api_secret: str | None = None,
    api_secret_env: str | None = None,
    voiceprint: dict[str, Any] | None = None,
    timeout_sec: int = 30,
) -> dict[str, Any]:
    logs: list[str] = [f"provider_kind={provider_kind}"]
    try:
        if provider_kind == XFYUN_ASR_PROVIDER_KIND:
            ok, summary = _test_xfyun_connection(
                endpoint=endpoint,
                app_id=app_id,
                api_key=api_key,
                api_key_env=api_key_env,
                api_secret=api_secret,
                api_secret_env=api_secret_env,
                voiceprint=voiceprint,
                logs=logs,
            )
        elif provider_kind == "openai_compatible":
            ok, summary = _test_openai_connection(
                endpoint=endpoint,
                api_key=api_key,
                api_key_env=api_key_env,
                logs=logs,
                timeout_sec=timeout_sec,
            )
        else:
            raise RuntimeError(f"unsupported provider_kind: {provider_kind}")
    except Exception as exc:
        logs.append(f"最终结果：失败，原因={exc}")
        return {
            "ok": False,
            "provider_kind": provider_kind,
            "summary": str(exc),
            "logs": logs,
        }
    logs.append(f"最终结果：成功，摘要={summary}")
    return {
        "ok": ok,
        "provider_kind": provider_kind,
        "summary": summary,
        "logs": logs,
    }
