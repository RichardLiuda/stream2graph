from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_XFYUN_VOICEPRINT_BASE = "https://api.xf-yun.com"
DEFAULT_XFYUN_ASR_ENDPOINT = "wss://iat-api.xfyun.cn/v2/iat"
DEFAULT_XFYUN_ASR_MODELS = ["iat", "xfime-mianqie"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Stream2Graph Formal Platform API"
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://stream2graph:stream2graph@127.0.0.1:5432/stream2graph"
    session_secret: str = Field("change-me", alias="S2G_SESSION_SECRET")
    admin_username: str = Field("admin", alias="S2G_ADMIN_USERNAME")
    admin_password: str = Field("admin123456", alias="S2G_ADMIN_PASSWORD")
    admin_display_name: str = Field("Stream2Graph Admin", alias="S2G_ADMIN_DISPLAY_NAME")
    cors_origins_raw: str = Field("http://127.0.0.1:3000,http://localhost:3000", alias="S2G_CORS_ORIGINS")
    cookie_secure: bool = Field(False, alias="S2G_COOKIE_SECURE")
    cookie_samesite: str = Field("lax", alias="S2G_COOKIE_SAMESITE")
    cookie_domain: str | None = Field(None, alias="S2G_COOKIE_DOMAIN")
    tls_verify: bool = Field(True, alias="S2G_TLS_VERIFY")
    ca_bundle: str = Field("", alias="S2G_CA_BUNDLE")
    default_dataset_version: str = Field(
        "release_v7_kimi_k25_fullregen_strict_20260313",
        alias="S2G_DEFAULT_DATASET_VERSION",
    )
    inline_worker: bool = Field(False, alias="S2G_INLINE_WORKER")
    inline_worker_poll_interval: float = Field(2.0, alias="S2G_INLINE_WORKER_POLL_INTERVAL")
    mermaid_compile_command: str = Field("", alias="S2G_MERMAID_COMPILE_COMMAND")
    gate_profiles_raw: str = Field("", alias="S2G_GATE_PROFILES_JSON")
    planner_profiles_raw: str = Field("", alias="S2G_PLANNER_PROFILES_JSON")
    llm_profiles_raw: str = Field("[]", alias="S2G_LLM_PROFILES_JSON")
    stt_profiles_raw: str = Field("[]", alias="S2G_STT_PROFILES_JSON")

    @property
    def repo_root(self) -> Path:
        return Path(__file__).resolve().parents[3]

    @property
    def dataset_root(self) -> Path:
        return self.repo_root / "versions" / "v3_2026-02-27_latest_9k_cscw" / "dataset" / "stream2graph_dataset"

    @property
    def artifact_root(self) -> Path:
        return self.repo_root / "var" / "artifacts"

    @property
    def cors_origins(self) -> list[str]:
        return [item.strip() for item in self.cors_origins_raw.split(",") if item.strip()]

    def _parse_profiles(self, raw: str, *, kind: str) -> list[dict[str, Any]]:
        try:
            payload = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
        if not isinstance(payload, list):
            return []

        rows: list[dict[str, Any]] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            models = item.get("models", [])
            if isinstance(models, str):
                models = [part.strip() for part in models.split(",") if part.strip()]
            if not isinstance(models, list):
                models = []
            voiceprint = item.get("voiceprint")
            if not isinstance(voiceprint, dict):
                voiceprint = None
            row = {
                "id": str(item.get("id", "")).strip(),
                "label": str(item.get("label", item.get("id", ""))).strip(),
                "endpoint": str(
                    item.get(
                        "endpoint",
                        DEFAULT_XFYUN_ASR_ENDPOINT if kind == "stt" else "",
                    )
                ).strip(),
                "app_id": str(item.get("app_id", "")).strip(),
                "api_key": str(item.get("api_key", "")).strip(),
                "api_key_env": str(item.get("api_key_env", "")).strip(),
                "api_secret_env": str(item.get("api_secret_env", "")).strip(),
                "models": [str(model).strip() for model in models if str(model).strip()],
                "default_model": str(item.get("default_model", "")).strip(),
                "provider_kind": str(
                    item.get("provider_kind", "xfyun_asr" if kind == "stt" else "openai_compatible")
                ).strip()
                or ("xfyun_asr" if kind == "stt" else "openai_compatible"),
            }
            api_secret = str(item.get("api_secret", "")).strip()
            if api_secret:
                row["api_secret"] = api_secret
            if voiceprint is not None:
                row["voiceprint"] = {
                    "enabled": bool(voiceprint.get("enabled", False)),
                    "provider_kind": str(voiceprint.get("provider_kind", "xfyun_isv")).strip() or "xfyun_isv",
                    "api_base": str(voiceprint.get("api_base", DEFAULT_XFYUN_VOICEPRINT_BASE)).strip()
                    or DEFAULT_XFYUN_VOICEPRINT_BASE,
                    "app_id": str(voiceprint.get("app_id", "")).strip(),
                    "api_key": str(voiceprint.get("api_key", "")).strip(),
                    "api_secret": str(voiceprint.get("api_secret", "")).strip(),
                    "group_id": str(voiceprint.get("group_id", "")).strip(),
                    "score_threshold": float(voiceprint.get("score_threshold", 0.75) or 0.75),
                    "top_k": int(voiceprint.get("top_k", 3) or 3),
                }
            if kind == "stt" and row["provider_kind"] == "xfyun_asr":
                if not row["endpoint"]:
                    row["endpoint"] = DEFAULT_XFYUN_ASR_ENDPOINT
                if not row["models"]:
                    row["models"] = list(DEFAULT_XFYUN_ASR_MODELS)
            if row["id"] and row["endpoint"] and row["models"]:
                if not row["default_model"]:
                    row["default_model"] = row["models"][0]
                rows.append(row)
        return rows

    def _profiles_or_legacy(self, raw: str, *, kind: str) -> list[dict[str, Any]]:
        return self._parse_profiles(raw, kind=kind) if raw.strip() else self._parse_profiles(self.llm_profiles_raw, kind=kind)

    @property
    def gate_profiles(self) -> list[dict[str, Any]]:
        return self._profiles_or_legacy(self.gate_profiles_raw, kind="gate")

    @property
    def planner_profiles(self) -> list[dict[str, Any]]:
        return self._profiles_or_legacy(self.planner_profiles_raw, kind="planner")

    @property
    def llm_profiles(self) -> list[dict[str, Any]]:
        return self._parse_profiles(self.llm_profiles_raw, kind="planner")

    @property
    def stt_profiles(self) -> list[dict[str, Any]]:
        return self._parse_profiles(self.stt_profiles_raw, kind="stt")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
