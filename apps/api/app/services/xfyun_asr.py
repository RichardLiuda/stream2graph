from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import logging
import ssl
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

import websockets

from app.config import get_settings


logger = logging.getLogger(__name__)
XFYUN_ASR_PROVIDER_KIND = "xfyun_asr"
DEFAULT_XFYUN_ASR_ENDPOINT = "wss://iat-api.xfyun.cn/v2/iat"
DEFAULT_XFYUN_ASR_MODELS = ["iat", "xfime-mianqie"]
DEFAULT_XFYUN_ASR_LANGUAGE = "zh_cn"
DEFAULT_XFYUN_ASR_ACCENT = "mandarin"
DEFAULT_XFYUN_ASR_VAD_EOS = 2000
XFYUN_ASR_FRAME_BYTES = 1280
XFYUN_ASR_FRAME_INTERVAL_SEC = 0.04


def _build_ssl_context() -> ssl.SSLContext:
    settings = get_settings()
    if not settings.tls_verify:
        return ssl._create_unverified_context()
    if settings.ca_bundle.strip():
        return ssl.create_default_context(cafile=settings.ca_bundle.strip())
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


def _rfc1123_now() -> str:
    return datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def build_xfyun_asr_auth_url(
    endpoint: str,
    *,
    api_key: str,
    api_secret: str,
    date_header: str | None = None,
) -> str:
    parsed = urllib.parse.urlsplit((endpoint or DEFAULT_XFYUN_ASR_ENDPOINT).strip())
    if parsed.scheme not in {"ws", "wss"}:
        raise RuntimeError("讯飞 STT endpoint 必须是 ws 或 wss 地址。")
    path = parsed.path or "/"
    host = parsed.netloc
    signed_date = date_header or _rfc1123_now()
    request_line = f"GET {path} HTTP/1.1"
    signature_origin = f"host: {host}\ndate: {signed_date}\n{request_line}"
    digest = hmac.new(api_secret.encode("utf-8"), signature_origin.encode("utf-8"), digestmod=hashlib.sha256).digest()
    signature = base64.b64encode(digest).decode("utf-8")
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", headers="host date request-line", '
        f'signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    query = urllib.parse.urlencode({"authorization": authorization, "date": signed_date, "host": host})
    return urllib.parse.urlunsplit((parsed.scheme, host, path, query, parsed.fragment))


def _frame_chunks(raw_pcm: bytes, *, frame_size: int = XFYUN_ASR_FRAME_BYTES) -> list[bytes]:
    if not raw_pcm:
        return [b""]
    return [raw_pcm[index : index + frame_size] for index in range(0, len(raw_pcm), frame_size)]


def _first_candidate_text(result: dict[str, Any]) -> str:
    parts: list[str] = []
    for word in result.get("ws", []) if isinstance(result.get("ws"), list) else []:
        if not isinstance(word, dict):
            continue
        candidates = word.get("cw", [])
        if not isinstance(candidates, list) or not candidates:
            continue
        first = candidates[0]
        if isinstance(first, dict):
            text = str(first.get("w", ""))
            if text:
                parts.append(text)
    return "".join(parts)


def _assemble_text(results_by_sn: dict[int, str]) -> str:
    return "".join(results_by_sn[key] for key in sorted(results_by_sn))


async def _collect_transcript(ws: Any) -> dict[str, Any]:
    results_by_sn: dict[int, str] = {}
    sid = ""
    while True:
        raw_message = await ws.recv()
        payload = json.loads(raw_message)
        code_raw = payload.get("code")
        message = str(payload.get("message", "")).strip()
        if code_raw in (None, ""):
            logger.info("XFYun ASR control payload %s", json.dumps(payload, ensure_ascii=False))
            if message.lower() == "success":
                continue
            code = -1
        else:
            code = int(code_raw)
        if code != 0:
            sid = str(payload.get("sid", sid)).strip()
            suffix = f" sid={sid}" if sid else ""
            logger.error("XFYun ASR error payload %s", json.dumps(payload, ensure_ascii=False))
            raise RuntimeError(message or f"讯飞 STT 返回错误 code={code}.{suffix}")
        sid = str(payload.get("sid", sid)).strip()
        data = payload.get("data", {})
        if not isinstance(data, dict):
            continue
        result = data.get("result", {})
        if isinstance(result, dict):
            sn = int(result.get("sn", len(results_by_sn) + 1) or len(results_by_sn) + 1)
            pgs = str(result.get("pgs", "")).strip()
            if pgs == "rpl":
                rg = result.get("rg", [])
                if isinstance(rg, list) and len(rg) == 2:
                    try:
                        start, end = int(rg[0]), int(rg[1])
                    except (TypeError, ValueError):
                        start, end = 0, -1
                    for key in range(start, end + 1):
                        results_by_sn.pop(key, None)
            results_by_sn[sn] = _first_candidate_text(result)
            if bool(result.get("ls")):
                break
        if int(data.get("status", -1) or -1) == 2:
            break
    return {"sid": sid, "text": _assemble_text(results_by_sn)}


async def _send_audio_frames(
    ws: Any,
    *,
    raw_pcm: bytes,
    app_id: str,
    sample_rate: int,
    domain: str,
    language: str,
    accent: str,
    vad_eos: int,
) -> None:
    frames = _frame_chunks(raw_pcm)
    first_frame = {
        "common": {"app_id": app_id},
        "business": {
            "language": language,
            "domain": domain,
            "accent": accent,
            "vad_eos": int(vad_eos),
        },
        "data": {
            "status": 0,
            "format": f"audio/L16;rate={int(sample_rate)}",
            "encoding": "raw",
            "audio": base64.b64encode(frames[0]).decode("utf-8"),
        },
    }
    await ws.send(json.dumps(first_frame))
    for frame in frames[1:]:
        await asyncio.sleep(XFYUN_ASR_FRAME_INTERVAL_SEC)
        await ws.send(
            json.dumps(
                {
                    "data": {
                        "status": 1,
                        "format": f"audio/L16;rate={int(sample_rate)}",
                        "encoding": "raw",
                        "audio": base64.b64encode(frame).decode("utf-8"),
                    }
                }
            )
        )
    await asyncio.sleep(XFYUN_ASR_FRAME_INTERVAL_SEC)
    await ws.send(json.dumps({"data": {"status": 2}}))


async def _transcribe_xfyun_async(
    *,
    endpoint: str,
    app_id: str,
    api_key: str,
    api_secret: str,
    raw_pcm: bytes,
    sample_rate: int,
    model: str,
    language: str = DEFAULT_XFYUN_ASR_LANGUAGE,
    accent: str = DEFAULT_XFYUN_ASR_ACCENT,
    vad_eos: int = DEFAULT_XFYUN_ASR_VAD_EOS,
) -> dict[str, Any]:
    auth_url = build_xfyun_asr_auth_url(endpoint, api_key=api_key, api_secret=api_secret)
    ssl_context = _build_ssl_context() if auth_url.startswith("wss://") else None
    logger.info(
        "XFYun ASR websocket connect %s",
        json.dumps(
            {
                "endpoint": endpoint,
                "sample_rate": sample_rate,
                "model": model,
                "proxy": None,
            },
            ensure_ascii=False,
        ),
    )
    async with websockets.connect(
        auth_url,
        ssl=ssl_context,
        proxy=None,
        max_size=4 * 1024 * 1024,
        ping_interval=None,
        close_timeout=5,
        open_timeout=10,
    ) as ws:
        receiver = asyncio.create_task(_collect_transcript(ws))
        try:
            await _send_audio_frames(
                ws,
                raw_pcm=raw_pcm,
                app_id=app_id,
                sample_rate=sample_rate,
                domain=model,
                language=language,
                accent=accent,
                vad_eos=vad_eos,
            )
            result = await asyncio.wait_for(receiver, timeout=30)
        finally:
            if not receiver.done():
                receiver.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await receiver
    return result


def transcribe_pcm_s16le_with_xfyun(
    *,
    endpoint: str,
    app_id: str,
    api_key: str,
    api_secret: str,
    pcm_s16le_base64: str,
    sample_rate: int,
    model: str,
    channel_count: int = 1,
) -> dict[str, Any]:
    if int(channel_count or 1) != 1:
        raise RuntimeError("讯飞 STT 目前仅支持单声道 chunk。")
    raw_pcm = base64.b64decode(pcm_s16le_base64.encode("utf-8"))
    if not raw_pcm:
        raise RuntimeError("音频数据为空，无法调用讯飞 STT。")
    started_at = time.time()
    result = asyncio.run(
        _transcribe_xfyun_async(
            endpoint=endpoint or DEFAULT_XFYUN_ASR_ENDPOINT,
            app_id=app_id,
            api_key=api_key,
            api_secret=api_secret,
            raw_pcm=raw_pcm,
            sample_rate=int(sample_rate),
            model=model or DEFAULT_XFYUN_ASR_MODELS[0],
        )
    )
    return {
        "text": str(result.get("text", "")).strip(),
        "sid": str(result.get("sid", "")).strip(),
        "latency_ms": round((time.time() - started_at) * 1000.0, 4),
    }
