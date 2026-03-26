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


RUNTIME_OPTIONS_KEY = "runtime_options"


def _normalize_profile(row: dict[str, Any], *, include_secrets: bool = False) -> dict[str, Any] | None:
    models = row.get("models", [])
    if isinstance(models, str):
        models = [part.strip() for part in models.split(",") if part.strip()]
    if not isinstance(models, list):
        models = []
    normalized_models = [str(model).strip() for model in models if str(model).strip()]
    profile_id = str(row.get("id", "")).strip()
    endpoint = str(row.get("endpoint", "")).strip()
    label = str(row.get("label", profile_id)).strip() or profile_id
    default_model = str(row.get("default_model", "")).strip()
    provider_kind = str(row.get("provider_kind", "openai_compatible")).strip() or "openai_compatible"
    api_key_env = str(row.get("api_key_env", "")).strip()
    api_key = str(row.get("api_key", "")).strip()

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
        "api_key_env": api_key_env,
    }
    if include_secrets:
        payload["api_key"] = api_key
    return payload


def _profile_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id", "")),
        "label": str(row.get("label", row.get("id", ""))),
        "provider_kind": str(row.get("provider_kind", "openai_compatible")),
        "models": list(row.get("models", [])),
        "default_model": str(row.get("default_model", "")),
    }


def _load_persisted_payload(db: Session) -> dict[str, Any]:
    row = db.scalar(select(PlatformSetting).where(PlatformSetting.setting_key == RUNTIME_OPTIONS_KEY))
    if row is None or not isinstance(row.value_json, dict):
        return {}
    return row.value_json


def _persisted_profiles(db: Session, kind: str, *, include_secrets: bool = False) -> list[dict[str, Any]]:
    payload = _load_persisted_payload(db)
    raw_profiles = payload.get(f"{kind}_profiles", [])
    if not isinstance(raw_profiles, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in raw_profiles:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_profile(item, include_secrets=include_secrets)
        if normalized:
            rows.append(normalized)
    return rows


def _env_profiles(kind: str, *, include_secrets: bool = False) -> list[dict[str, Any]]:
    settings = get_settings()
    raw_profiles = settings.llm_profiles if kind == "llm" else settings.stt_profiles
    rows: list[dict[str, Any]] = []
    for item in raw_profiles:
        normalized = _normalize_profile(item, include_secrets=include_secrets)
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
    llm_profiles = _merge_profiles(
        _persisted_profiles(db, "llm", include_secrets=include_secrets),
        _env_profiles("llm", include_secrets=include_secrets),
    )
    stt_profiles = _merge_profiles(
        _persisted_profiles(db, "stt", include_secrets=include_secrets),
        _env_profiles("stt", include_secrets=include_secrets),
    )
    if include_secrets:
        return {
            "llm_profiles": llm_profiles,
            "stt_profiles": stt_profiles,
        }
    return {
        "llm_profiles": [_profile_summary(item) for item in llm_profiles],
        "stt_profiles": [_profile_summary(item) for item in stt_profiles],
    }


def list_persisted_runtime_options(db: Session, *, include_secrets: bool = False) -> dict[str, list[dict[str, Any]]]:
    llm_profiles = _persisted_profiles(db, "llm", include_secrets=include_secrets)
    stt_profiles = _persisted_profiles(db, "stt", include_secrets=include_secrets)
    return {
        "llm_profiles": llm_profiles,
        "stt_profiles": stt_profiles,
    }


def save_runtime_options(db: Session, payload: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    normalized_payload = {
        "llm_profiles": _persisted_profiles_from_payload(payload.get("llm_profiles", [])),
        "stt_profiles": _persisted_profiles_from_payload(payload.get("stt_profiles", [])),
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


def _persisted_profiles_from_payload(raw_profiles: list[Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(raw_profiles, list):
        return rows
    for item in raw_profiles:
        if not isinstance(item, dict):
            continue
        normalized = _normalize_profile(item, include_secrets=True)
        if normalized:
            rows.append(normalized)
    return rows


def resolve_profile(db: Session, kind: str, profile_id: str | None) -> dict[str, Any] | None:
    profiles = list_runtime_options(db, include_secrets=True)
    items = profiles["llm_profiles"] if kind == "llm" else profiles["stt_profiles"]
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
