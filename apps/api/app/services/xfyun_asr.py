from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import contextlib
import hashlib
import hmac
import json
import logging
import ssl
import threading
import time
import urllib.parse
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from app.config import get_settings


logger = logging.getLogger(__name__)
XFYUN_ASR_PROVIDER_KIND = "xfyun_asr"
DEFAULT_XFYUN_ASR_ENDPOINT = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"
DEFAULT_XFYUN_ASR_MODELS = ["rtasr_llm"]
DEFAULT_XFYUN_ASR_LANGUAGE = "autodialect"
DEFAULT_XFYUN_ASR_AUDIO_ENCODE = "pcm_s16le"
XFYUN_ASR_FRAME_BYTES = 1280
DEFAULT_XFYUN_ASR_FRAME_INTERVAL_SEC = 0.02
RTASR_INTERMEDIATE_CHUNK_TIMEOUT_SEC = 30.0
RTASR_FINAL_CHUNK_TIMEOUT_SEC = 45.0
RTASR_RESET_TIMEOUT_SEC = 1.5
RTASR_READY_TIMEOUT_SEC = 1.5
_STREAMS_LOCK = threading.Lock()
_STREAMS: dict[str, "RTASRRealtimeSessionStream"] = {}


def _xfyun_asr_frame_interval_sec() -> float:
    configured = float(get_settings().xfyun_asr_frame_interval_sec)
    return max(0.0, min(0.04, configured))


def _anonymous_speaker_label(index: int) -> str:
    normalized = max(1, int(index or 1))
    if normalized <= 26:
        return f"匿名说话人 {chr(ord('A') + normalized - 1)}"
    return f"匿名说话人 {normalized}"


def _build_ssl_context() -> ssl.SSLContext:
    settings = get_settings()
    if not settings.tls_verify:
        return ssl._create_unverified_context()
    if settings.ca_bundle.strip():
        return ssl.create_default_context(cafile=settings.ca_bundle.strip())
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


def _beijing_timestamp_now() -> str:
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


def build_xfyun_asr_auth_url(
    endpoint: str,
    *,
    app_id: str,
    api_key: str,
    api_secret: str,
    uuid_value: str | None = None,
    utc_value: str | None = None,
    audio_encode: str = DEFAULT_XFYUN_ASR_AUDIO_ENCODE,
    lang: str = DEFAULT_XFYUN_ASR_LANGUAGE,
    sample_rate: int = 16000,
    role_type: int | None = None,
    feature_ids: Iterable[str] | None = None,
    eng_spk_match: int | None = None,
    pd: str | None = None,
) -> str:
    parsed = urllib.parse.urlsplit((endpoint or DEFAULT_XFYUN_ASR_ENDPOINT).strip())
    if parsed.scheme not in {"ws", "wss"}:
        raise RuntimeError("讯飞 RTASR endpoint 必须是 ws 或 wss 地址。")

    feature_ids_value = ",".join(
        str(item).strip() for item in (feature_ids or []) if str(item).strip()
    )
    query_params: dict[str, Any] = {
        "accessKeyId": api_key,
        "appId": app_id,
        "audio_encode": audio_encode,
        "feature_ids": feature_ids_value or None,
        "eng_spk_match": eng_spk_match,
        "lang": lang,
        "pd": pd,
        "role_type": role_type,
        "samplerate": int(sample_rate),
        "utc": utc_value or _beijing_timestamp_now(),
        "uuid": uuid_value or uuid.uuid4().hex,
    }
    base_string = _sorted_query_string(query_params)
    signature = base64.b64encode(
        hmac.new(
            api_secret.encode("utf-8"),
            base_string.encode("utf-8"),
            hashlib.sha1,
        ).digest()
    ).decode("utf-8")
    query_params["signature"] = signature
    query = urllib.parse.urlencode(
        [(key, value) for key, value in query_params.items() if value is not None and str(value).strip() != ""],
        quote_via=urllib.parse.quote,
    )
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def _first_candidate_text(ws_item: dict[str, Any]) -> str:
    candidates = ws_item.get("cw", [])
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0]
    if not isinstance(first, dict):
        return ""
    return str(first.get("w", ""))


def _decode_message_payload(raw_message: Any) -> dict[str, Any]:
    if isinstance(raw_message, bytes):
        raw_message = raw_message.decode("utf-8", errors="ignore")
    if not isinstance(raw_message, str):
        raise RuntimeError("讯飞 RTASR 返回了无法识别的消息类型。")
    payload = json.loads(raw_message)
    if not isinstance(payload, dict):
        raise RuntimeError("讯飞 RTASR 返回了非法 JSON。")
    return payload


def _decode_nested_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _is_recoverable_connection_error(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if isinstance(exc, ConnectionClosed):
        return True
    return "no close frame received or sent" in str(exc).strip().lower()


def _extract_remote_session_id(payload: dict[str, Any]) -> str:
    if str(payload.get("sid", "")).strip():
        return str(payload.get("sid", "")).strip()
    nested = _decode_nested_json(payload.get("data"))
    for key in ("sessionId", "session_id", "sid"):
        if str(payload.get(key, "")).strip():
            return str(payload.get(key, "")).strip()
        if str(nested.get(key, "")).strip():
            return str(nested.get(key, "")).strip()
    return ""


def _extract_result_data(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    if isinstance(data, str) and data.strip():
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _message_error(payload: dict[str, Any]) -> RuntimeError | None:
    action = str(payload.get("action", "")).strip().lower()
    msg_type = str(payload.get("msg_type", "")).strip().lower()
    res_type = str(payload.get("res_type", "")).strip().lower()
    desc = str(payload.get("desc", "") or payload.get("message", "")).strip()
    code_raw = payload.get("code")

    try:
        code = int(code_raw)
    except (TypeError, ValueError):
        code = 0

    if action == "error" or msg_type == "error":
        return RuntimeError(desc or f"讯飞 RTASR 返回错误 code={code or 'unknown'}。")
    if code not in {0, 200, None}:
        return RuntimeError(desc or f"讯飞 RTASR 返回错误 code={code}。")
    if msg_type == "result" and res_type == "frc":
        return RuntimeError(desc or "讯飞 RTASR 返回异常结果 frc。")
    return None


def _result_words(result_data: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    cn = result_data.get("cn", {})
    st = cn.get("st", {}) if isinstance(cn, dict) else {}
    rt_rows = st.get("rt", []) if isinstance(st, dict) else []
    words: list[dict[str, Any]] = []
    has_explicit_roles = False
    previous_role: int | None = None
    for rt_index, rt_item in enumerate(rt_rows if isinstance(rt_rows, list) else []):
        if not isinstance(rt_item, dict):
            continue
        ws_rows = rt_item.get("ws", [])
        if not isinstance(ws_rows, list):
            continue
        for ws_index, ws_item in enumerate(ws_rows):
            if not isinstance(ws_item, dict):
                continue
            text = _first_candidate_text(ws_item)
            if not text:
                continue
            first_candidate = ws_item.get("cw", [{}])[0]
            if not isinstance(first_candidate, dict):
                first_candidate = {}
            try:
                role_index = int(first_candidate.get("rl", 0) or 0)
            except (TypeError, ValueError):
                role_index = 0
            if role_index > 0:
                has_explicit_roles = True
            normalized_role = role_index if role_index > 0 else previous_role
            previous_role = normalized_role or previous_role
            words.append(
                {
                    "text": text,
                    "role_index": normalized_role,
                    "role_raw": role_index,
                    "word_index": len(words),
                    "wb": first_candidate.get("wb"),
                    "we": first_candidate.get("we"),
                    "rt_index": rt_index,
                    "ws_index": ws_index,
                    "candidate": first_candidate,
                    "ws_item": ws_item,
                    "rt_item": rt_item,
                }
            )
    return words, has_explicit_roles


def _group_role_segments(
    result_data: dict[str, Any],
    *,
    fallback_speaker: str,
    feature_label_by_id: dict[str, str],
) -> dict[str, Any]:
    seg_id_raw = result_data.get("seg_id", -1)
    try:
        seg_id = int(seg_id_raw)
    except (TypeError, ValueError):
        seg_id = -1

    words, has_explicit_roles = _result_words(result_data)
    full_text = "".join(item["text"] for item in words)
    if not full_text:
        return {
            "seg_id": seg_id,
            "text": "",
            "segments": [],
            "role_separated": False,
            "speaker_count": 0,
            "ls": bool(result_data.get("ls", False)),
        }

    if not has_explicit_roles:
        return {
            "seg_id": seg_id,
            "text": full_text,
            "segments": [],
            "role_separated": False,
            "speaker_count": 0,
            "ls": bool(result_data.get("ls", False)),
        }

    grouped: list[dict[str, Any]] = []
    role_state_by_index: dict[int, dict[str, str]] = {}
    for item in words:
        role_index = item.get("role_index")
        normalized_role_index = int(role_index or 0)
        feature_id = ""
        candidate = item.get("candidate", {}) if isinstance(item.get("candidate"), dict) else {}
        for key in ("feature_id", "featureId", "uid", "speakerId", "speaker_id"):
            if str(candidate.get(key, "")).strip():
                feature_id = str(candidate.get(key, "")).strip()
                break

        resolution_source = "rtasr_role"
        raw_role_label = f"role_{normalized_role_index or len(grouped) + 1}"
        speaker_identity = ""
        speaker_label = _anonymous_speaker_label(normalized_role_index or len(grouped) + 1)
        if feature_id and feature_id in feature_label_by_id:
            resolution_source = "rtasr_feature"
            speaker_identity = feature_label_by_id[feature_id]
            speaker_label = speaker_identity
        elif normalized_role_index > 0 and normalized_role_index in role_state_by_index:
            previous_state = role_state_by_index[normalized_role_index]
            speaker_label = previous_state.get("speaker", speaker_label)
            speaker_identity = previous_state.get("speaker_identity", "")
            resolution_source = previous_state.get("speaker_resolution_source", resolution_source)

        if normalized_role_index > 0:
            role_state_by_index[normalized_role_index] = {
                "speaker": speaker_label,
                "speaker_identity": speaker_identity,
                "speaker_resolution_source": resolution_source,
            }

        if grouped and grouped[-1]["speaker"] == speaker_label and grouped[-1]["role_index"] == normalized_role_index:
            grouped[-1]["text"] += item["text"]
            grouped[-1]["word_count"] += 1
            grouped[-1]["word_end"] = item.get("we")
            continue

        grouped.append(
            {
                "seg_id": seg_id,
                "text": item["text"],
                "speaker": speaker_label or fallback_speaker,
                "speaker_display_label": speaker_label or fallback_speaker,
                "speaker_identity": speaker_identity,
                "raw_role_label": raw_role_label,
                "role_index": normalized_role_index,
                "feature_id": feature_id,
                "speaker_resolution_source": resolution_source,
                "word_begin": item.get("wb"),
                "word_end": item.get("we"),
                "word_count": 1,
            }
        )

    return {
        "seg_id": seg_id,
        "text": full_text,
        "segments": grouped,
        "role_separated": True,
        "speaker_count": len({item["speaker"] for item in grouped if item.get("speaker")}),
        "ls": bool(result_data.get("ls", False)),
    }


async def _websocket_connect(auth_url: str):
    ssl_context = _build_ssl_context() if auth_url.startswith("wss://") else None
    return await websockets.connect(
        auth_url,
        ssl=ssl_context,
        proxy=None,
        max_size=4 * 1024 * 1024,
        ping_interval=None,
        close_timeout=5,
        open_timeout=10,
    )


class RTASRRealtimeSessionStream:
    def __init__(
        self,
        *,
        session_id: str,
        endpoint: str,
        app_id: str,
        api_key: str,
        api_secret: str,
        sample_rate: int,
        lang: str,
        role_type: int,
        feature_ids: list[str],
        eng_spk_match: int | None,
        pd: str | None,
        feature_label_by_id: dict[str, str],
        fallback_speaker: str,
    ) -> None:
        self.session_id = session_id
        self.endpoint = endpoint
        self.app_id = app_id
        self.api_key = api_key
        self.api_secret = api_secret
        self.sample_rate = int(sample_rate)
        self.lang = lang
        self.role_type = int(role_type)
        self.feature_ids = list(feature_ids)
        self.eng_spk_match = eng_spk_match
        self.pd = pd
        self.feature_label_by_id = dict(feature_label_by_id)
        self.fallback_speaker = fallback_speaker

        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run_loop, name=f"rtasr-{session_id[:8]}", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._ws = None
        self._receiver_task = None
        self._remote_session_id = ""
        self._last_error: RuntimeError | None = None
        self._segments: list[dict[str, Any]] = []
        self._delivered_count = 0
        self._segment_fingerprint_by_seg_id: dict[int, str] = {}
        self._message_event = asyncio.Event()
        self._final_event = asyncio.Event()
        self._ready_event = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self._ready.set()
        self._loop.run_forever()

    def submit_chunk(self, raw_pcm: bytes, *, is_final: bool, timeout_sec: float | None = None) -> dict[str, Any]:
        effective_timeout = timeout_sec or (
            RTASR_FINAL_CHUNK_TIMEOUT_SEC if is_final else RTASR_INTERMEDIATE_CHUNK_TIMEOUT_SEC
        )
        future = asyncio.run_coroutine_threadsafe(
            self._submit_chunk_async(raw_pcm, is_final=is_final),
            self._loop,
        )
        try:
            return future.result(timeout=effective_timeout)
        except concurrent.futures.TimeoutError as exc:
            future.cancel()
            with contextlib.suppress(Exception):
                reset_future = asyncio.run_coroutine_threadsafe(self._reset_connection(), self._loop)
                reset_future.result(timeout=RTASR_RESET_TIMEOUT_SEC + 0.5)
            raise RuntimeError(
                f"讯飞 RTASR 响应超时（>{effective_timeout:.0f}s），当前流已重置，请重试。"
            ) from exc

    def close(self, timeout_sec: float = 10.0) -> None:
        if self._closed.is_set():
            return
        future = asyncio.run_coroutine_threadsafe(self._close_async(), self._loop)
        with contextlib.suppress(Exception):
            future.result(timeout=timeout_sec)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=timeout_sec)
        self._closed.set()

    async def _ensure_connected(self) -> None:
        if self._ws is not None and not getattr(self._ws, "closed", False):
            return
        await self._reset_connection()
        auth_url = build_xfyun_asr_auth_url(
            self.endpoint,
            app_id=self.app_id,
            api_key=self.api_key,
            api_secret=self.api_secret,
            sample_rate=self.sample_rate,
            lang=self.lang,
            role_type=self.role_type,
            feature_ids=self.feature_ids,
            eng_spk_match=self.eng_spk_match,
            pd=self.pd,
        )
        self._ws = await _websocket_connect(auth_url)
        self._last_error = None
        self._final_event.clear()
        self._receiver_task = asyncio.create_task(self._receiver_loop())
        await self._wait_until_ready()

    async def _submit_chunk_async(self, raw_pcm: bytes, *, is_final: bool) -> dict[str, Any]:
        async with self._send_lock:
            for attempt in range(2):
                try:
                    if self._last_error is not None:
                        raise RuntimeError(str(self._last_error))
                    await self._ensure_connected()
                    start_count = len(self._segments)
                    self._message_event.clear()
                    await self._send_audio_frames(raw_pcm)
                    if is_final:
                        await self._send_end_marker()
                    await self._wait_for_segments(start_count=start_count, is_final=is_final)
                    if self._last_error is not None:
                        raise RuntimeError(str(self._last_error))

                    new_segments = self._segments[self._delivered_count :]
                    self._delivered_count = len(self._segments)
                    text = "".join(item["text"] for item in new_segments)
                    distinct_speakers = [item["speaker"] for item in new_segments if str(item.get("speaker", "")).strip()]
                    speaker = ""
                    if len(set(distinct_speakers)) == 1 and distinct_speakers:
                        speaker = distinct_speakers[0]
                    elif distinct_speakers:
                        speaker = "multi_speaker"
                    else:
                        speaker = self.fallback_speaker

                    response = {
                        "text": text,
                        "speaker": speaker,
                        "segments": new_segments,
                        "sid": self._remote_session_id or self.session_id,
                        "role_separated": bool(new_segments),
                    }
                    if is_final:
                        await self._close_async()
                    return response
                except Exception as exc:
                    recoverable = _is_recoverable_connection_error(exc) or _is_recoverable_connection_error(self._last_error)
                    if attempt == 0 and recoverable:
                        logger.warning("RTASR stream disconnected for session=%s; retrying chunk once", self.session_id)
                        await self._reset_connection()
                        continue
                    raise

    async def _wait_for_segments(self, *, start_count: int, is_final: bool) -> None:
        deadline = time.monotonic() + (20.0 if is_final else 1.2)
        while True:
            if self._last_error is not None:
                raise RuntimeError(str(self._last_error))
            if is_final and self._final_event.is_set():
                await asyncio.sleep(0.05)
                return
            if not is_final and len(self._segments) > start_count:
                await asyncio.sleep(0.05)
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                await asyncio.wait_for(self._message_event.wait(), timeout=remaining)
            except TimeoutError:
                return
            self._message_event.clear()

    async def _wait_until_ready(self) -> None:
        try:
            await asyncio.wait_for(self._ready_event.wait(), timeout=RTASR_READY_TIMEOUT_SEC)
        except TimeoutError:
            logger.warning("RTASR ready handshake timed out for session=%s; proceeding without remote sessionId", self.session_id)

    async def _send_audio_frames(self, raw_pcm: bytes) -> None:
        if self._ws is None:
            raise RuntimeError("讯飞 RTASR 连接尚未建立。")
        frames = [
            raw_pcm[index : index + XFYUN_ASR_FRAME_BYTES]
            for index in range(0, len(raw_pcm), XFYUN_ASR_FRAME_BYTES)
        ] or [b""]
        frame_interval_sec = _xfyun_asr_frame_interval_sec()
        for index, frame in enumerate(frames):
            await self._ws.send(frame)
            if frame_interval_sec > 0 and index < len(frames) - 1:
                await asyncio.sleep(frame_interval_sec)

    async def _send_end_marker(self) -> None:
        if self._ws is None:
            raise RuntimeError("讯飞 RTASR 连接尚未建立。")
        frame_interval_sec = _xfyun_asr_frame_interval_sec()
        if frame_interval_sec > 0:
            await asyncio.sleep(frame_interval_sec)
        payload: dict[str, Any] = {"end": True}
        if self._remote_session_id:
            payload["sessionId"] = self._remote_session_id
        await self._ws.send(
            json.dumps(
                payload,
                ensure_ascii=False,
            )
        )

    async def _receiver_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw_message in self._ws:
                payload = _decode_message_payload(raw_message)
                maybe_error = _message_error(payload)
                if maybe_error is not None:
                    self._last_error = maybe_error
                    self._message_event.set()
                    self._final_event.set()
                    return

                remote_session_id = _extract_remote_session_id(payload)
                if remote_session_id:
                    self._remote_session_id = remote_session_id
                    self._ready_event.set()
                if str(payload.get("msg_type", "")).strip().lower() == "action" or str(payload.get("action", "")).strip().lower() == "action":
                    self._ready_event.set()

                result_data = _extract_result_data(payload)
                if not result_data:
                    self._message_event.set()
                    continue

                result_type = int(result_data.get("cn", {}).get("st", {}).get("type", 1) or 1)
                if result_type != 0:
                    if bool(result_data.get("ls", False)):
                        self._final_event.set()
                    self._message_event.set()
                    continue

                grouped = _group_role_segments(
                    result_data,
                    fallback_speaker=self.fallback_speaker,
                    feature_label_by_id=self.feature_label_by_id,
                )
                seg_id = int(grouped.get("seg_id", -1))
                fingerprint = json.dumps(grouped.get("segments", []), ensure_ascii=False, sort_keys=True)
                if grouped.get("segments") and self._segment_fingerprint_by_seg_id.get(seg_id) != fingerprint:
                    self._segment_fingerprint_by_seg_id[seg_id] = fingerprint
                    self._segments.extend(grouped["segments"])
                if bool(grouped.get("ls", False)) or bool(result_data.get("ls", False)):
                    self._final_event.set()
                self._message_event.set()
        except Exception as exc:
            self._last_error = RuntimeError(str(exc))
            self._message_event.set()
            self._final_event.set()

    async def _reset_connection(self) -> None:
        if self._receiver_task is not None:
            receiver_task = self._receiver_task
            self._receiver_task = None
            receiver_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(receiver_task, timeout=RTASR_RESET_TIMEOUT_SEC)
        if self._ws is not None:
            ws = self._ws
            self._ws = None
            with contextlib.suppress(Exception):
                await asyncio.wait_for(ws.close(), timeout=RTASR_RESET_TIMEOUT_SEC)
        self._remote_session_id = ""
        self._last_error = None
        self._message_event.clear()
        self._final_event.clear()
        self._ready_event.clear()

    async def _close_async(self) -> None:
        await self._reset_connection()


def get_or_create_rtasr_session_stream(
    *,
    session_id: str,
    endpoint: str,
    app_id: str,
    api_key: str,
    api_secret: str,
    sample_rate: int,
    lang: str,
    role_type: int,
    feature_ids: list[str],
    eng_spk_match: int | None,
    pd: str | None,
    feature_label_by_id: dict[str, str],
    fallback_speaker: str,
) -> RTASRRealtimeSessionStream:
    with _STREAMS_LOCK:
        stream = _STREAMS.get(session_id)
        if stream is None:
            logger.info("Creating RTASR session stream for realtime session=%s", session_id)
            stream = RTASRRealtimeSessionStream(
                session_id=session_id,
                endpoint=endpoint,
                app_id=app_id,
                api_key=api_key,
                api_secret=api_secret,
                sample_rate=sample_rate,
                lang=lang,
                role_type=role_type,
                feature_ids=feature_ids,
                eng_spk_match=eng_spk_match,
                pd=pd,
                feature_label_by_id=feature_label_by_id,
                fallback_speaker=fallback_speaker,
            )
            _STREAMS[session_id] = stream
        else:
            logger.info("Reusing RTASR session stream for realtime session=%s", session_id)
        return stream


def close_rtasr_session_stream(session_id: str) -> None:
    with _STREAMS_LOCK:
        stream = _STREAMS.pop(session_id, None)
    if stream is not None:
        logger.info("Closing RTASR session stream for realtime session=%s", session_id)
        stream.close()


def transcribe_pcm_s16le_with_xfyun(
    *,
    session_id: str,
    endpoint: str,
    app_id: str,
    api_key: str,
    api_secret: str,
    pcm_s16le_base64: str,
    sample_rate: int,
    model: str,
    channel_count: int = 1,
    is_final: bool = True,
    fallback_speaker: str = "speaker",
    role_type: int = 2,
    feature_ids: Iterable[str] | None = None,
    eng_spk_match: int | None = None,
    pd: str | None = None,
    feature_label_by_id: dict[str, str] | None = None,
    reuse_session_stream: bool = False,
) -> dict[str, Any]:
    if int(channel_count or 1) != 1:
        raise RuntimeError("讯飞 RTASR LLM 目前仅支持单声道 chunk。")
    raw_pcm = base64.b64decode(pcm_s16le_base64.encode("utf-8"))
    if not raw_pcm:
        raise RuntimeError("音频数据为空，无法调用讯飞 RTASR。")
    started_at = time.time()
    normalized_feature_ids = [str(item).strip() for item in (feature_ids or []) if str(item).strip()]
    if reuse_session_stream:
        stream = get_or_create_rtasr_session_stream(
            session_id=session_id,
            endpoint=endpoint or DEFAULT_XFYUN_ASR_ENDPOINT,
            app_id=app_id,
            api_key=api_key,
            api_secret=api_secret,
            sample_rate=int(sample_rate),
            lang=DEFAULT_XFYUN_ASR_LANGUAGE,
            role_type=int(role_type or 2),
            feature_ids=normalized_feature_ids,
            eng_spk_match=eng_spk_match,
            pd=pd,
            feature_label_by_id=feature_label_by_id or {},
            fallback_speaker=fallback_speaker,
        )
        try:
            result = stream.submit_chunk(raw_pcm, is_final=bool(is_final))
        finally:
            if is_final:
                close_rtasr_session_stream(session_id)
    else:
        # Match the official demo more closely: each upload chunk is handled as an
        # independent RTASR session that sends audio once, then sends `end=true`.
        stream = RTASRRealtimeSessionStream(
            session_id=f"{session_id}-{uuid.uuid4().hex[:8]}",
            endpoint=endpoint or DEFAULT_XFYUN_ASR_ENDPOINT,
            app_id=app_id,
            api_key=api_key,
            api_secret=api_secret,
            sample_rate=int(sample_rate),
            lang=DEFAULT_XFYUN_ASR_LANGUAGE,
            role_type=int(role_type or 2),
            feature_ids=normalized_feature_ids,
            eng_spk_match=eng_spk_match,
            pd=pd,
            feature_label_by_id=feature_label_by_id or {},
            fallback_speaker=fallback_speaker,
        )
        try:
            result = stream.submit_chunk(raw_pcm, is_final=True)
        finally:
            stream.close()
    return {
        "text": str(result.get("text", "")).strip(),
        "speaker": str(result.get("speaker", fallback_speaker)).strip() or fallback_speaker,
        "segments": result.get("segments", []),
        "role_separated": bool(result.get("role_separated", False)),
        "sid": str(result.get("sid", "")).strip(),
        "latency_ms": round((time.time() - started_at) * 1000.0, 4),
        "model": model or DEFAULT_XFYUN_ASR_MODELS[0],
    }
