from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import certifi
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import PlatformSetting
from app.services.xfyun_asr import (
    DEFAULT_XFYUN_ASR_ENDPOINT,
    DEFAULT_XFYUN_ASR_MODELS,
    XFYUN_ASR_PROVIDER_KIND,
)


RUNTIME_OPTIONS_KEY = "runtime_options"
DEFAULT_XFYUN_VOICEPRINT_BASE = "https://api.xf-yun.com"


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
    label = str(row.get("label", profile_id)).strip() or profile_id
    default_model = str(row.get("default_model", "")).strip()
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

    if provider_kind == XFYUN_ASR_PROVIDER_KIND and kind == "stt" and not normalized_models:
        normalized_models = list(DEFAULT_XFYUN_ASR_MODELS)

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
    payload = {
        "id": str(row.get("id", "")),
        "label": str(row.get("label", row.get("id", ""))),
        "provider_kind": str(row.get("provider_kind", XFYUN_ASR_PROVIDER_KIND if kind == "stt" else "openai_compatible")),
        "models": list(row.get("models", [])),
        "default_model": str(row.get("default_model", "")),
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
        raw_profiles = settings.gate_profiles
    elif kind in {"planner", "llm"}:
        raw_profiles = settings.planner_profiles
    else:
        raw_profiles = settings.stt_profiles
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
