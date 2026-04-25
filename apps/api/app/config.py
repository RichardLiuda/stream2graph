from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_XFYUN_VOICEPRINT_BASE = "https://office-api-personal-dx.iflyaisol.com"

# 与 FastAPI CORSMiddleware.allow_origin_regex 配合 allow_credentials=True。
# 覆盖 RFC1918 局域网、127.0.0.1 及常见内网穿透前端域名；生产可改为显式 S2G_CORS_ORIGINS 或收窄本正则。
_DEFAULT_S2G_CORS_ORIGIN_REGEX = (
    r"^https?://("
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|"
    r"127\.0\.0\.1"
    r")(:\d+)?$"
    r"|^https?://[a-zA-Z0-9-]+\.ngrok-free\.app(?::\d+)?$"
    r"|^https?://[a-zA-Z0-9-]+\.ngrok\.io(?::\d+)?$"
    r"|^https?://[a-zA-Z0-9-]+\.trycloudflare\.com(?::\d+)?$"
)
LEGACY_XFYUN_VOICEPRINT_BASE = "https://api.xf-yun.com"
DEFAULT_XFYUN_ASR_ENDPOINT = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"
LEGACY_XFYUN_ASR_ENDPOINT = "wss://iat-api.xfyun.cn/v2/iat"
DEFAULT_XFYUN_ASR_MODELS = ["rtasr_llm"]


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
    cors_origin_regex: str = Field(_DEFAULT_S2G_CORS_ORIGIN_REGEX, alias="S2G_CORS_ORIGIN_REGEX")
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
    xfyun_asr_frame_interval_sec: float = Field(0.02, alias="S2G_XFYUN_ASR_FRAME_INTERVAL_SEC")

    @property
    def repo_root(self) -> Path:
        return Path(__file__).resolve().parents[3]

    @property
    def dataset_root(self) -> Path:
        return self.repo_root / "versions" / "v3_2026-02-27_latest_9k_cscw" / "dataset" / "stream2graph_dataset"

    @property
    def artifact_root(self) -> Path:
        return self.repo_root / "var" / "artifacts"

    @field_validator("cors_origin_regex", mode="before")
    @classmethod
    def cors_origin_regex_blank_uses_lan_default(cls, value: object) -> object:
        """环境变量留空或全空白时沿用内置局域网/穿透规则，避免 .env 中写 `S2G_CORS_ORIGIN_REGEX=` 误关闭。"""
        if value is None:
            return _DEFAULT_S2G_CORS_ORIGIN_REGEX
        if isinstance(value, str) and not value.strip():
            return _DEFAULT_S2G_CORS_ORIGIN_REGEX
        return value

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
                "models": [],
                "default_model": "",
                "provider_kind": str(
                    item.get("provider_kind", "xfyun_asr" if kind == "stt" else "openai_compatible")
                ).strip()
                or ("xfyun_asr" if kind == "stt" else "openai_compatible"),
            }
            api_secret = str(item.get("api_secret", "")).strip()
            if api_secret:
                row["api_secret"] = api_secret
            if voiceprint is not None:
                voiceprint_api_base = str(voiceprint.get("api_base", DEFAULT_XFYUN_VOICEPRINT_BASE)).strip() or DEFAULT_XFYUN_VOICEPRINT_BASE
                if voiceprint_api_base.rstrip("/") == LEGACY_XFYUN_VOICEPRINT_BASE:
                    voiceprint_api_base = DEFAULT_XFYUN_VOICEPRINT_BASE
                row["voiceprint"] = {
                    "enabled": bool(voiceprint.get("enabled", False)),
                    "provider_kind": str(voiceprint.get("provider_kind", "xfyun_isv")).strip() or "xfyun_isv",
                    "api_base": voiceprint_api_base,
                    "app_id": str(voiceprint.get("app_id", "")).strip(),
                    "api_key": str(voiceprint.get("api_key", "")).strip(),
                    "api_secret": str(voiceprint.get("api_secret", "")).strip(),
                    "group_id": str(voiceprint.get("group_id", "")).strip(),
                    "score_threshold": float(voiceprint.get("score_threshold", 0.75) or 0.75),
                    "top_k": int(voiceprint.get("top_k", 3) or 3),
                }
            if kind == "stt" and row["provider_kind"] == "xfyun_asr":
                if row["endpoint"].rstrip("/") == LEGACY_XFYUN_ASR_ENDPOINT:
                    row["endpoint"] = DEFAULT_XFYUN_ASR_ENDPOINT
                if not row["endpoint"]:
                    row["endpoint"] = DEFAULT_XFYUN_ASR_ENDPOINT
                row["models"], row["default_model"] = _normalize_stt_models(models, str(item.get("default_model", "")).strip())
            else:
                if isinstance(models, str):
                    models = [part.strip() for part in models.split(",") if part.strip()]
                if not isinstance(models, list):
                    models = []
                row["models"] = [str(model).strip() for model in models if str(model).strip()]
                row["default_model"] = str(item.get("default_model", "")).strip()
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
