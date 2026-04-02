from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utc_now
from app.models import VoiceprintFeature, VoiceprintGroup


logger = logging.getLogger(__name__)
VOICEPRINT_PROVIDER_KIND = "xfyun_isv"
VOICEPRINT_SERVICE_PATH = "/v1/private/s782b4996"
VOICEPRINT_SERVICE_ID = "s782b4996"
DEFAULT_XFYUN_VOICEPRINT_BASE = "https://office-api-personal-dx.iflyaisol.com"
LEGACY_XFYUN_VOICEPRINT_BASE = "https://api.xf-yun.com"
RTASR_VOICEPRINT_REGISTER_PATH = "/res/feature/v1/register"
RTASR_VOICEPRINT_DELETE_PATH = "/res/feature/v1/delete"


def _build_ssl_context() -> ssl.SSLContext:
    settings = get_settings()
    if not settings.tls_verify:
        return ssl._create_unverified_context()
    if settings.ca_bundle.strip():
        return ssl.create_default_context(cafile=settings.ca_bundle.strip())
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


def voiceprint_config_from_profile(profile: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(profile, dict):
        return None
    raw = profile.get("voiceprint")
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None
    inherited_api_key = str(profile.get("api_key", "")).strip()
    inherited_api_secret = str(profile.get("api_secret", "")).strip()
    inherited_api_key_env = str(profile.get("api_key_env", "")).strip()
    inherited_api_secret_env = str(profile.get("api_secret_env", "")).strip()
    if not inherited_api_key and inherited_api_key_env:
        inherited_api_key = os.getenv(inherited_api_key_env, "").strip()
    if not inherited_api_secret and inherited_api_secret_env:
        inherited_api_secret = os.getenv(inherited_api_secret_env, "").strip()
    api_base = str(raw.get("api_base", DEFAULT_XFYUN_VOICEPRINT_BASE)).strip().rstrip("/") or DEFAULT_XFYUN_VOICEPRINT_BASE
    if (
        str(profile.get("provider_kind", "")).strip() == "xfyun_asr"
        and api_base.rstrip("/") == LEGACY_XFYUN_VOICEPRINT_BASE
    ):
        api_base = DEFAULT_XFYUN_VOICEPRINT_BASE
    return {
        "enabled": True,
        "provider_kind": str(raw.get("provider_kind", VOICEPRINT_PROVIDER_KIND)).strip() or VOICEPRINT_PROVIDER_KIND,
        "api_base": api_base,
        "app_id": str(raw.get("app_id", "")).strip() or str(profile.get("app_id", "")).strip(),
        "api_key": str(raw.get("api_key", "")).strip() or inherited_api_key,
        "api_secret": str(raw.get("api_secret", "")).strip() or inherited_api_secret,
        "group_id": str(raw.get("group_id", "")).strip(),
        "score_threshold": float(raw.get("score_threshold", 0.75) or 0.75),
        "top_k": max(1, min(int(raw.get("top_k", 3) or 3), 10)),
    }


def _is_rtasr_voiceprint_config(config: dict[str, Any]) -> bool:
    return "office-api-personal-dx.iflyaisol.com" in str(config.get("api_base", "")).strip().lower()


def _is_rtasr_stt_profile(profile: dict[str, Any] | None) -> bool:
    if not isinstance(profile, dict):
        return False
    if str(profile.get("provider_kind", "")).strip() != "xfyun_asr":
        return False
    endpoint = str(profile.get("endpoint", "")).strip().lower()
    return "office-api-ast-dx.iflyaisol.com/ast/communicate/v1" in endpoint


def _require_voiceprint_config(profile: dict[str, Any] | None) -> dict[str, Any]:
    config = voiceprint_config_from_profile(profile)
    if config is None:
        raise RuntimeError("当前 STT profile 未启用可用的声纹盲认配置。")
    missing = [field for field in ("api_base", "app_id", "api_key", "api_secret", "group_id") if not config.get(field)]
    if missing:
        raise RuntimeError(f"声纹配置不完整：缺少 {', '.join(missing)}。")
    return config


def _service_url(api_base: str) -> str:
    base = api_base.strip().rstrip("/")
    if base.endswith(VOICEPRINT_SERVICE_PATH):
        return base
    return f"{base}{VOICEPRINT_SERVICE_PATH}"


def _join_api_url(api_base: str, path: str) -> str:
    return f"{api_base.strip().rstrip('/')}{path}"


def _rfc1123_now() -> str:
    return datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def _voiceprint_datetime_now() -> str:
    beijing = timezone(timedelta(hours=8))
    return datetime.now(beijing).strftime("%Y-%m-%dT%H:%M:%S%z")


def _sorted_query_string(params: dict[str, Any]) -> str:
    rows = sorted(
        [
            (str(key), str(value))
            for key, value in params.items()
            if value is not None and str(value).strip() != ""
        ],
        key=lambda item: item[0],
    )
    return "&".join(
        f"{urllib.parse.quote(key, safe='')}={urllib.parse.quote(value, safe='')}"
        for key, value in rows
    )


def _signed_url(service_url: str, *, api_key: str, api_secret: str, date_header: str) -> str:
    parsed = urllib.parse.urlsplit(service_url)
    request_line = f"POST {parsed.path or '/'} HTTP/1.1"
    signature_origin = f"host: {parsed.netloc}\ndate: {date_header}\n{request_line}"
    signature = base64.b64encode(
        hmac.new(api_secret.encode("utf-8"), signature_origin.encode("utf-8"), digestmod=hashlib.sha256).digest()
    ).decode("utf-8")
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", headers="host date request-line", '
        f'signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    query = urllib.parse.urlencode(
        {
            "authorization": authorization,
            "host": parsed.netloc,
            "date": date_header,
        }
    )
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def _rtasr_voiceprint_auth(
    endpoint: str,
    *,
    app_id: str,
    api_key: str,
    api_secret: str,
    date_time: str | None = None,
    signature_random: str | None = None,
) -> tuple[str, dict[str, str]]:
    query_params = {
        "accessKeyId": api_key,
        "appId": app_id,
        "dateTime": date_time or _voiceprint_datetime_now(),
        "signatureRandom": signature_random or uuid.uuid4().hex,
    }
    base_string = _sorted_query_string(query_params)
    signature = base64.b64encode(
        hmac.new(api_secret.encode("utf-8"), base_string.encode("utf-8"), hashlib.sha1).digest()
    ).decode("utf-8")
    signed_url = f"{endpoint}?{urllib.parse.urlencode(query_params, quote_via=urllib.parse.quote)}"
    return signed_url, {"signature": signature}


def _decode_payload_block(response: dict[str, Any], payload_key: str) -> Any:
    header = response.get("header", {})
    header_code = int(header.get("code", -1) or -1)
    header_message = str(header.get("message", "")).strip()
    if header_code != 0:
        raise RuntimeError(header_message or f"讯飞声纹请求失败，header.code={header_code}")

    payload = response.get("payload", {})
    block = payload.get(payload_key, {}) if isinstance(payload, dict) else {}
    if not isinstance(block, dict):
        return {}
    text_b64 = str(block.get("text", "")).strip()
    if not text_b64:
        return {}
    decoded = base64.b64decode(text_b64.encode("utf-8")).decode("utf-8", errors="ignore")
    if not decoded.strip():
        return {}
    return json.loads(decoded)


def _voiceprint_request(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    service_url = _service_url(str(config["api_base"]))
    date_header = _rfc1123_now()
    request = urllib.request.Request(
        _signed_url(
            service_url,
            api_key=str(config["api_key"]),
            api_secret=str(config["api_secret"]),
            date_header=date_header,
        ),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Date": date_header,
            "Host": urllib.parse.urlsplit(service_url).netloc,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60, context=_build_ssl_context()) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else ""
        raise RuntimeError(f"讯飞声纹请求失败：HTTP {exc.code} {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"讯飞声纹请求失败：{exc.reason}") from exc


def _rtasr_voiceprint_request(
    config: dict[str, Any],
    *,
    path: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    endpoint = _join_api_url(str(config["api_base"]), path)
    signed_url, headers = _rtasr_voiceprint_auth(
        endpoint,
        app_id=str(config["app_id"]),
        api_key=str(config["api_key"]),
        api_secret=str(config["api_secret"]),
    )
    request = urllib.request.Request(
        signed_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            **headers,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60, context=_build_ssl_context()) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else ""
        raise RuntimeError(f"讯飞 RTASR 声纹请求失败：HTTP {exc.code} {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"讯飞 RTASR 声纹请求失败：{exc.reason}") from exc


def build_voiceprint_auth_preview(
    service_url: str,
    *,
    api_key: str,
    api_secret: str,
    date_header: str,
) -> dict[str, str]:
    if RTASR_VOICEPRINT_REGISTER_PATH in service_url or RTASR_VOICEPRINT_DELETE_PATH in service_url:
        signed_url, headers = _rtasr_voiceprint_auth(
            service_url,
            app_id="preview-app",
            api_key=api_key,
            api_secret=api_secret,
            date_time=date_header,
            signature_random="preview-random",
        )
        return {
            "date": date_header,
            "signature": headers.get("signature", ""),
            "host": urllib.parse.urlsplit(service_url).netloc,
            "signed_url": signed_url,
        }
    signed = _signed_url(service_url, api_key=api_key, api_secret=api_secret, date_header=date_header)
    parsed = urllib.parse.urlsplit(signed)
    params = urllib.parse.parse_qs(parsed.query)
    return {
        "date": date_header,
        "authorization": params.get("authorization", [""])[0],
        "host": params.get("host", [""])[0],
        "signed_url": signed,
    }


def pcm_s16le_to_mp3_base64(
    pcm_s16le_base64: str,
    *,
    sample_rate: int,
    channel_count: int,
) -> str:
    raw_pcm = base64.b64decode(pcm_s16le_base64.encode("utf-8"))
    process = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(sample_rate),
            "-ac",
            str(channel_count),
            "-i",
            "pipe:0",
            "-codec:a",
            "libmp3lame",
            "-f",
            "mp3",
            "pipe:1",
        ],
        input=raw_pcm,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0 or not process.stdout:
        stderr = process.stderr.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(f"无法把 PCM 音频转成 mp3：{stderr or 'ffmpeg failed'}")
    return base64.b64encode(process.stdout).decode("utf-8")


def _resource_payload(audio_base64: str, *, sample_rate: int, channel_count: int) -> dict[str, Any]:
    return {
        "resource": {
            "encoding": "lame",
            "sample_rate": int(sample_rate),
            "channels": int(channel_count),
            "bit_depth": 16,
            "status": 3,
            "audio": audio_base64,
        }
    }


def _request_envelope(config: dict[str, Any], parameter: dict[str, Any], payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "header": {"app_id": str(config["app_id"]), "status": 3},
        "parameter": {VOICEPRINT_SERVICE_ID: parameter},
        **({"payload": payload} if payload else {}),
    }


def create_group_remote(
    config: dict[str, Any],
    *,
    display_name: str,
    group_info: str,
) -> dict[str, Any]:
    response = _voiceprint_request(
        config,
        _request_envelope(
            config,
            {
                "func": "createGroup",
                "groupId": str(config["group_id"]),
                "groupName": display_name,
                "groupInfo": group_info,
                "createGroupRes": {"encoding": "utf8", "compress": "raw", "format": "json"},
            },
        ),
    )
    return _decode_payload_block(response, "createGroupRes")


def query_feature_list_remote(config: dict[str, Any]) -> list[dict[str, Any]]:
    response = _voiceprint_request(
        config,
        _request_envelope(
            config,
            {
                "func": "queryFeatureList",
                "groupId": str(config["group_id"]),
                "queryFeatureListRes": {"encoding": "utf8", "compress": "raw", "format": "json"},
            },
        ),
    )
    result = _decode_payload_block(response, "queryFeatureListRes")
    return result if isinstance(result, list) else []


def create_feature_remote(
    config: dict[str, Any],
    *,
    feature_id: str,
    feature_info: str,
    pcm_s16le_base64: str,
    sample_rate: int,
    channel_count: int,
) -> dict[str, Any]:
    response = _voiceprint_request(
        config,
        _request_envelope(
            config,
            {
                "func": "createFeature",
                "groupId": str(config["group_id"]),
                "featureId": feature_id,
                "featureInfo": feature_info,
                "createFeatureRes": {"encoding": "utf8", "compress": "raw", "format": "json"},
            },
            _resource_payload(
                pcm_s16le_to_mp3_base64(
                    pcm_s16le_base64,
                    sample_rate=sample_rate,
                    channel_count=channel_count,
                ),
                sample_rate=sample_rate,
                channel_count=channel_count,
            ),
        ),
    )
    result = _decode_payload_block(response, "createFeatureRes")
    return result if isinstance(result, dict) else {}


def register_feature_remote(
    config: dict[str, Any],
    *,
    speaker_label: str,
    feature_info: str,
    pcm_s16le_base64: str,
) -> dict[str, Any]:
    response = _rtasr_voiceprint_request(
        config,
        path=RTASR_VOICEPRINT_REGISTER_PATH,
        payload={
            "audio_data": pcm_s16le_base64,
            "audio_type": "pcm_s16le",
            "uid": speaker_label,
            "feature_info": feature_info,
        },
    )
    data = response.get("data", {}) if isinstance(response, dict) else {}
    feature_id = str((data or {}).get("feature_id", "")).strip()
    if not feature_id:
        raise RuntimeError("讯飞 RTASR 声纹注册未返回 feature_id。")
    return {
        "feature_id": feature_id,
        "uid": speaker_label,
        "feature_info": feature_info,
        "raw_response": response,
    }


def delete_feature_remote(config: dict[str, Any], *, feature_id: str) -> dict[str, Any]:
    response = _voiceprint_request(
        config,
        _request_envelope(
            config,
            {
                "func": "deleteFeature",
                "groupId": str(config["group_id"]),
                "featureId": feature_id,
                "deleteFeatureRes": {"encoding": "utf8", "compress": "raw", "format": "json"},
            },
        ),
    )
    result = _decode_payload_block(response, "deleteFeatureRes")
    return result if isinstance(result, dict) else {}


def delete_feature_remote_v2(config: dict[str, Any], *, feature_id: str) -> dict[str, Any]:
    response = _rtasr_voiceprint_request(
        config,
        path=RTASR_VOICEPRINT_DELETE_PATH,
        payload={"feature_id": feature_id},
    )
    return response if isinstance(response, dict) else {}


def search_feature_remote(
    config: dict[str, Any],
    *,
    pcm_s16le_base64: str,
    sample_rate: int,
    channel_count: int,
) -> dict[str, Any]:
    response = _voiceprint_request(
        config,
        _request_envelope(
            config,
            {
                "func": "searchFea",
                "groupId": str(config["group_id"]),
                "topK": int(config.get("top_k", 3) or 3),
                "searchFeaRes": {"encoding": "utf8", "compress": "raw", "format": "json"},
            },
            _resource_payload(
                pcm_s16le_to_mp3_base64(
                    pcm_s16le_base64,
                    sample_rate=sample_rate,
                    channel_count=channel_count,
                ),
                sample_rate=sample_rate,
                channel_count=channel_count,
            ),
        ),
    )
    result = _decode_payload_block(response, "searchFeaRes")
    return result if isinstance(result, dict) else {}


def upsert_voiceprint_group(
    db: Session,
    *,
    stt_profile_id: str,
    config: dict[str, Any],
    display_name: str,
    status: str,
    remote_payload: dict[str, Any],
) -> VoiceprintGroup:
    group = db.scalar(select(VoiceprintGroup).where(VoiceprintGroup.stt_profile_id == stt_profile_id))
    if group is None:
        group = VoiceprintGroup(
            stt_profile_id=stt_profile_id,
            group_id=str(config["group_id"]),
            display_name=display_name,
            provider_kind=str(config.get("provider_kind", VOICEPRINT_PROVIDER_KIND)),
            status=status,
            remote_payload=remote_payload,
            last_synced_at=utc_now(),
        )
    else:
        group.group_id = str(config["group_id"])
        group.display_name = display_name
        group.provider_kind = str(config.get("provider_kind", VOICEPRINT_PROVIDER_KIND))
        group.status = status
        group.remote_payload = remote_payload
        group.last_synced_at = utc_now()
    db.add(group)
    db.flush()
    return group


def sync_group_and_features(
    db: Session,
    *,
    stt_profile_id: str,
    profile: dict[str, Any],
    display_name: str | None = None,
    group_info: str | None = None,
) -> tuple[VoiceprintGroup, list[dict[str, Any]]]:
    config = _require_voiceprint_config(profile)
    resolved_display_name = (display_name or str(profile.get("label", stt_profile_id)) or stt_profile_id).strip()
    resolved_group_info = (group_info or resolved_display_name).strip()

    remote_features: list[dict[str, Any]]
    remote_group_payload: dict[str, Any]
    if _is_rtasr_voiceprint_config(config):
        remote_group_payload = {
            "group_id": str(config["group_id"]),
            "group_name": resolved_display_name,
            "group_info": resolved_group_info,
            "source": "rtasr_voice_print_local_registry",
        }
        group = upsert_voiceprint_group(
            db,
            stt_profile_id=stt_profile_id,
            config=config,
            display_name=resolved_display_name,
            status="active",
            remote_payload=remote_group_payload,
        )
        local_rows = list_voiceprint_features(db, stt_profile_id=stt_profile_id)
        remote_features = [
            {
                "feature_id": row.feature_id,
                "speaker_label": row.speaker_label,
                "feature_info": row.feature_info,
                "status": row.status,
            }
            for row in local_rows
        ]
        return group, remote_features

    try:
        remote_features = query_feature_list_remote(config)
        remote_group_payload = {
            "group_id": str(config["group_id"]),
            "group_name": resolved_display_name,
            "group_info": resolved_group_info,
            "source": "queryFeatureList",
        }
    except RuntimeError:
        remote_group_payload = create_group_remote(
            config,
            display_name=resolved_display_name,
            group_info=resolved_group_info,
        )
        remote_features = query_feature_list_remote(config)

    group = upsert_voiceprint_group(
        db,
        stt_profile_id=stt_profile_id,
        config=config,
        display_name=resolved_display_name,
        status="active",
        remote_payload=remote_group_payload,
    )

    local_rows = db.scalars(select(VoiceprintFeature).where(VoiceprintFeature.stt_profile_id == stt_profile_id)).all()
    local_by_feature_id = {row.feature_id: row for row in local_rows}
    remote_feature_ids = {str(item.get("featureId", "")).strip() for item in remote_features if str(item.get("featureId", "")).strip()}

    for remote in remote_features:
        feature_id = str(remote.get("featureId", "")).strip()
        if not feature_id:
            continue
        feature_info = str(remote.get("featureInfo", "")).strip()
        row = local_by_feature_id.get(feature_id)
        if row is None:
            row = VoiceprintFeature(
                stt_profile_id=stt_profile_id,
                group_id=group.group_id,
                feature_id=feature_id,
                speaker_label=feature_info or feature_id,
                feature_info=feature_info,
                status="remote_only",
                remote_payload=remote,
            )
        else:
            row.group_id = group.group_id
            row.feature_info = feature_info or row.feature_info
            row.remote_payload = remote
            if row.status == "deleted":
                row.status = "active"
        db.add(row)

    for row in local_rows:
        if row.feature_id not in remote_feature_ids and row.status != "deleted":
            row.status = "missing_remote"
            db.add(row)

    db.flush()
    return group, remote_features


def list_voiceprint_features(db: Session, *, stt_profile_id: str) -> list[VoiceprintFeature]:
    return db.scalars(
        select(VoiceprintFeature)
        .where(VoiceprintFeature.stt_profile_id == stt_profile_id, VoiceprintFeature.status != "deleted")
        .order_by(VoiceprintFeature.created_at.desc())
    ).all()


def create_voiceprint_feature(
    db: Session,
    *,
    stt_profile_id: str,
    profile: dict[str, Any],
    speaker_label: str,
    feature_info: str,
    pcm_s16le_base64: str,
    sample_rate: int,
    channel_count: int,
) -> VoiceprintFeature:
    config = _require_voiceprint_config(profile)
    group, _remote_features = sync_group_and_features(db, stt_profile_id=stt_profile_id, profile=profile)
    feature_id = uuid.uuid4().hex[:32]
    if _is_rtasr_voiceprint_config(config):
        remote_payload = register_feature_remote(
            config,
            speaker_label=speaker_label,
            feature_info=feature_info,
            pcm_s16le_base64=pcm_s16le_base64,
        )
        resolved_feature_id = str(remote_payload.get("feature_id", feature_id)).strip() or feature_id
    else:
        remote_payload = create_feature_remote(
            config,
            feature_id=feature_id,
            feature_info=feature_info,
            pcm_s16le_base64=pcm_s16le_base64,
            sample_rate=sample_rate,
            channel_count=channel_count,
        )
        resolved_feature_id = str(remote_payload.get("featureId", feature_id)).strip() or feature_id
    row = db.scalar(
        select(VoiceprintFeature).where(
            VoiceprintFeature.stt_profile_id == stt_profile_id,
            VoiceprintFeature.feature_id == resolved_feature_id,
        )
    )
    if row is None:
        row = VoiceprintFeature(
            stt_profile_id=stt_profile_id,
            group_id=group.group_id,
            feature_id=resolved_feature_id,
            speaker_label=speaker_label,
            feature_info=feature_info,
            status="active",
            remote_payload=remote_payload,
        )
    else:
        row.group_id = group.group_id
        row.speaker_label = speaker_label
        row.feature_info = feature_info
        row.status = "active"
        row.remote_payload = remote_payload
    db.add(row)
    db.flush()
    return row


def delete_voiceprint_feature(
    db: Session,
    *,
    stt_profile_id: str,
    profile: dict[str, Any],
    feature_id: str,
) -> VoiceprintFeature | None:
    row = db.scalar(
        select(VoiceprintFeature).where(
            VoiceprintFeature.stt_profile_id == stt_profile_id,
            VoiceprintFeature.feature_id == feature_id,
        )
    )
    if row is None:
        return None
    config = _require_voiceprint_config(profile)
    remote_payload = (
        delete_feature_remote_v2(config, feature_id=feature_id)
        if _is_rtasr_voiceprint_config(config)
        else delete_feature_remote(config, feature_id=feature_id)
    )
    row.status = "deleted"
    row.remote_payload = remote_payload
    db.add(row)
    db.flush()
    return row


def blind_recognize_speaker(
    db: Session,
    *,
    stt_profile_id: str,
    profile: dict[str, Any] | None,
    pcm_s16le_base64: str,
    sample_rate: int,
    channel_count: int,
    fallback_speaker: str,
) -> dict[str, Any] | None:
    config = voiceprint_config_from_profile(profile)
    if config is None:
        return None

    t0 = time.time()
    result: dict[str, Any] = {
        "matched": False,
        "provider": VOICEPRINT_PROVIDER_KIND,
        "group_id": str(config.get("group_id", "")),
        "feature_id": "",
        "speaker_label": fallback_speaker,
        "score": None,
        "top_candidates": [],
        "latency_ms": 0.0,
        "threshold": float(config.get("score_threshold", 0.75) or 0.75),
        "error_message": None,
    }
    if _is_rtasr_voiceprint_config(config) or _is_rtasr_stt_profile(profile):
        result["latency_ms"] = round((time.time() - t0) * 1000.0, 4)
        result["mode"] = "rtasr_primary"
        result["skipped"] = True
        return result
    try:
        remote_payload = search_feature_remote(
            config,
            pcm_s16le_base64=pcm_s16le_base64,
            sample_rate=sample_rate,
            channel_count=channel_count,
        )
        score_list = remote_payload.get("scoreList", [])
        candidates: list[dict[str, Any]] = []
        feature_rows = db.scalars(
            select(VoiceprintFeature).where(
                VoiceprintFeature.stt_profile_id == stt_profile_id,
                VoiceprintFeature.status != "deleted",
            )
        ).all()
        label_by_feature_id = {row.feature_id: row.speaker_label for row in feature_rows}
        for item in score_list if isinstance(score_list, list) else []:
            feature_id = str((item or {}).get("featureId", "")).strip()
            feature_info = str((item or {}).get("featureInfo", "")).strip()
            speaker_label = label_by_feature_id.get(feature_id) or feature_info or feature_id or fallback_speaker
            try:
                score = float((item or {}).get("score", 0.0) or 0.0)
            except (TypeError, ValueError):
                score = 0.0
            candidates.append(
                {
                    "feature_id": feature_id,
                    "feature_info": feature_info,
                    "speaker_label": speaker_label,
                    "score": score,
                }
            )
        candidates.sort(key=lambda item: float(item.get("score", 0.0) or 0.0), reverse=True)
        threshold = float(config.get("score_threshold", 0.75) or 0.75)
        top = candidates[0] if candidates else None
        result["top_candidates"] = candidates[: int(config.get("top_k", 3) or 3)]
        if top is not None:
            result["feature_id"] = str(top.get("feature_id", ""))
            result["speaker_label"] = str(top.get("speaker_label", fallback_speaker))
            result["score"] = float(top.get("score", 0.0) or 0.0)
            result["matched"] = bool(result["score"] is not None and float(result["score"]) >= threshold)
            if not result["matched"]:
                result["speaker_label"] = fallback_speaker
        result["latency_ms"] = round((time.time() - t0) * 1000.0, 4)
        return result
    except Exception as exc:
        result["latency_ms"] = round((time.time() - t0) * 1000.0, 4)
        result["error_message"] = str(exc)
        return result
