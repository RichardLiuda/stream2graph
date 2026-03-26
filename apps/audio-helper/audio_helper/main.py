from __future__ import annotations

import asyncio
import base64
import importlib
import json
import os
import platform
import threading
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:
    import numpy as np
except Exception:  # pragma: no cover - optional dependency
    np = None


CaptureStatus = Literal["idle", "starting", "running", "stopped", "failed"]


def _platform_family() -> str:
    system = platform.system().lower()
    if system == "darwin":
        return "macos"
    if system == "windows":
        return "windows"
    if system == "linux":
        return "linux"
    return "other"


def _split_origins(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def _helper_cors_origins() -> list[str]:
    return _split_origins(
        os.getenv(
            "S2G_AUDIO_HELPER_CORS_ORIGINS",
            "http://127.0.0.1:3000,http://localhost:3000,https://stream.richardliuda.top",
        )
    )


def _env(name: str, default: str) -> str:
    return os.getenv(name, default).strip()


class CaptureStartRequest(BaseModel):
    source_type: str = "system_audio_helper"
    session_id: str | None = None
    language: str | None = None


class CaptureResponse(BaseModel):
    ok: bool
    status: CaptureStatus
    source_type: str
    message: str


class AudioChunkRequest(BaseModel):
    source_type: str = "system_audio_helper"
    session_id: str | None = None
    chunk_id: int = Field(ge=0)
    sample_rate: int = Field(ge=8000, le=96000)
    channel_count: int = Field(ge=1, le=8, default=1)
    pcm_s16le_base64: str
    timestamp_ms: int | None = None
    is_final: bool = True


class AudioChunkResponse(BaseModel):
    ok: bool
    accepted: bool
    status: CaptureStatus
    chunk_id: int
    queued_chunks: int
    message: str


@dataclass
class HelperState:
    status: CaptureStatus = "idle"
    source_type: str = "system_audio_helper"
    session_id: str | None = None
    language: str | None = None
    message: str = "helper idle"
    queues: list[asyncio.Queue[str]] = field(default_factory=list)
    chunk_queue: asyncio.Queue[AudioChunkRequest] | None = None
    worker_task: asyncio.Task[None] | None = None

    async def publish(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        for queue in list(self.queues):
            await queue.put(data)


STATE = HelperState()
MODEL_LOCK = threading.Lock()
MODEL_INSTANCE: Any | None = None


def _transcriber_backend() -> str:
    return _env("S2G_HELPER_TRANSCRIBER", "faster_whisper")


def _helper_model_size() -> str:
    return _env("S2G_HELPER_MODEL_SIZE", "small")


def _helper_language() -> str:
    return _env("S2G_HELPER_LANGUAGE", "zh")


def _helper_device() -> str:
    return _env("S2G_HELPER_DEVICE", "cpu")


def _helper_compute_type() -> str:
    return _env("S2G_HELPER_COMPUTE_TYPE", "int8")


def _build_capability_payload() -> dict[str, Any]:
    platform_name = _platform_family()
    backend = _transcriber_backend()

    if platform_name not in {"macos", "windows"}:
        return {
            "source_type": "system_audio_helper",
            "platform": platform_name,
            "capability_status": "unsupported",
            "capability_reason": "当前平台未纳入系统声音增强模式支持范围。",
            "native_engine": "unsupported",
            "transcriber_backend": backend,
            "model_size": _helper_model_size(),
            "supported_sources": [],
        }

    if backend == "mock":
        return {
            "source_type": "system_audio_helper",
            "platform": platform_name,
            "capability_status": "supported",
            "capability_reason": "当前使用 mock transcriber，适合本地联调链路。",
            "native_engine": "browser_display_audio_bridge",
            "transcriber_backend": backend,
            "model_size": "mock",
            "supported_sources": ["system_audio_helper"],
        }

    if np is None:
        return {
            "source_type": "system_audio_helper",
            "platform": platform_name,
            "capability_status": "limited",
            "capability_reason": "未安装 numpy，无法处理浏览器上传的 PCM 音频块。",
            "native_engine": "missing_numpy",
            "transcriber_backend": backend,
            "model_size": _helper_model_size(),
            "supported_sources": [],
        }

    try:
        importlib.import_module("faster_whisper")
    except Exception:
        return {
            "source_type": "system_audio_helper",
            "platform": platform_name,
            "capability_status": "limited",
            "capability_reason": "未安装 faster-whisper。请先为 audio helper 安装本地转写依赖。",
            "native_engine": "missing_faster_whisper",
            "transcriber_backend": backend,
            "model_size": _helper_model_size(),
            "supported_sources": [],
        }

    return {
        "source_type": "system_audio_helper",
        "platform": platform_name,
        "capability_status": "supported",
        "capability_reason": "本地转写引擎已就绪，可以接收浏览器共享音频并回推文本。",
        "native_engine": "browser_display_audio_bridge",
        "transcriber_backend": backend,
        "model_size": _helper_model_size(),
        "supported_sources": ["system_audio_helper"],
    }


def _ensure_model():
    global MODEL_INSTANCE

    if _transcriber_backend() == "mock":
        return "mock"

    if MODEL_INSTANCE is not None:
        return MODEL_INSTANCE

    with MODEL_LOCK:
        if MODEL_INSTANCE is not None:
            return MODEL_INSTANCE

        from faster_whisper import WhisperModel

        MODEL_INSTANCE = WhisperModel(
            _helper_model_size(),
            device=_helper_device(),
            compute_type=_helper_compute_type(),
        )
        return MODEL_INSTANCE


def _decode_pcm_to_float32(payload: AudioChunkRequest):
    if np is None:  # pragma: no cover - guarded by capabilities
        raise RuntimeError("numpy is required for PCM decoding")

    raw = base64.b64decode(payload.pcm_s16le_base64.encode("utf-8"))
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if payload.channel_count > 1:
        usable = (pcm.size // payload.channel_count) * payload.channel_count
        pcm = pcm[:usable].reshape(-1, payload.channel_count).mean(axis=1)
    return pcm


def _resample_to_16k(samples, sample_rate: int):
    if np is None:  # pragma: no cover - guarded by capabilities
        raise RuntimeError("numpy is required for resampling")
    if sample_rate == 16000:
        return samples.astype(np.float32, copy=False)
    if samples.size == 0:
        return samples.astype(np.float32, copy=False)
    source_positions = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
    target_size = max(1, int(round(samples.size * (16000.0 / float(sample_rate)))))
    target_positions = np.linspace(0.0, 1.0, num=target_size, endpoint=False)
    return np.interp(target_positions, source_positions, samples).astype(np.float32)


def _transcribe_chunk_sync(payload: AudioChunkRequest) -> dict[str, Any]:
    backend = _transcriber_backend()
    if backend == "mock":
        return {
            "text": f"mock chunk {payload.chunk_id}",
            "language": payload.session_id or _helper_language(),
        }

    model = _ensure_model()
    samples = _decode_pcm_to_float32(payload)
    samples_16k = _resample_to_16k(samples, payload.sample_rate)
    segments, info = model.transcribe(
        samples_16k,
        language=STATE.language or _helper_language(),
        vad_filter=True,
        condition_on_previous_text=False,
        beam_size=1,
        without_timestamps=True,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "text": text,
        "language": getattr(info, "language", None) or STATE.language or _helper_language(),
    }


async def _transcription_worker() -> None:
    while True:
        payload = await STATE.chunk_queue.get()
        try:
            result = await asyncio.to_thread(_transcribe_chunk_sync, payload)
            if result["text"]:
                await STATE.publish(
                    {
                        "source_type": payload.source_type,
                        "platform": _platform_family(),
                        "status": "running",
                        "text": result["text"],
                        "timestamp_ms": payload.timestamp_ms or int(time.time() * 1000),
                        "is_final": payload.is_final,
                        "error_code": None,
                        "error_message": None,
                    }
                )
        except Exception as exc:  # pragma: no cover - runtime integration path
            STATE.status = "failed"
            STATE.message = str(exc)
            await STATE.publish(
                {
                    "source_type": payload.source_type,
                    "platform": _platform_family(),
                    "status": "failed",
                    "text": None,
                    "timestamp_ms": payload.timestamp_ms or int(time.time() * 1000),
                    "is_final": True,
                    "error_code": "transcription_failed",
                    "error_message": f"本地转写失败：{exc}",
                }
            )
        finally:
            STATE.chunk_queue.task_done()


@asynccontextmanager
async def lifespan(_: FastAPI):
    STATE.chunk_queue = asyncio.Queue()
    STATE.worker_task = asyncio.create_task(_transcription_worker())
    try:
        yield
    finally:
        if STATE.worker_task:
            STATE.worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await STATE.worker_task


app = FastAPI(title="Stream2Graph Audio Helper", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_helper_cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "stream2graph-audio-helper",
        "platform": _platform_family(),
        "status": STATE.status,
        "transcriber_backend": _transcriber_backend(),
    }


@app.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    return _build_capability_payload()


@app.post("/capture/start", response_model=CaptureResponse)
async def start_capture(payload: CaptureStartRequest) -> CaptureResponse:
    caps = _build_capability_payload()
    STATE.source_type = payload.source_type
    STATE.session_id = payload.session_id
    STATE.language = payload.language or _helper_language()

    if caps["capability_status"] != "supported":
        STATE.status = "failed"
        STATE.message = caps["capability_reason"]
        await STATE.publish(
            {
                "source_type": payload.source_type,
                "platform": caps["platform"],
                "status": "failed",
                "error_code": "transcriber_unavailable",
                "error_message": caps["capability_reason"],
            }
        )
        return CaptureResponse(ok=False, status=STATE.status, source_type=payload.source_type, message=STATE.message)

    STATE.status = "running"
    STATE.message = "capture ready"
    await STATE.publish(
        {
            "source_type": payload.source_type,
            "platform": caps["platform"],
            "status": "running",
            "error_code": None,
            "error_message": None,
        }
    )
    return CaptureResponse(ok=True, status=STATE.status, source_type=payload.source_type, message=STATE.message)


@app.post("/capture/audio-chunk", response_model=AudioChunkResponse)
async def push_audio_chunk(payload: AudioChunkRequest) -> AudioChunkResponse:
    if STATE.chunk_queue is None:
        raise HTTPException(status_code=503, detail="audio helper worker is not ready")
    if STATE.status not in {"running", "starting"}:
        raise HTTPException(status_code=409, detail="capture is not running")

    await STATE.chunk_queue.put(payload)
    return AudioChunkResponse(
        ok=True,
        accepted=True,
        status=STATE.status,
        chunk_id=payload.chunk_id,
        queued_chunks=STATE.chunk_queue.qsize(),
        message="chunk accepted",
    )


@app.post("/capture/stop", response_model=CaptureResponse)
async def stop_capture() -> CaptureResponse:
    STATE.status = "stopped"
    STATE.message = "capture stopped"
    await STATE.publish(
        {
            "source_type": STATE.source_type,
            "platform": _platform_family(),
            "status": "stopped",
            "error_code": None,
            "error_message": None,
        }
    )
    return CaptureResponse(ok=True, status=STATE.status, source_type=STATE.source_type, message=STATE.message)


@app.get("/stream/events")
async def stream_events() -> StreamingResponse:
    queue: asyncio.Queue[str] = asyncio.Queue()
    STATE.queues.append(queue)

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            initial = {
                "source_type": STATE.source_type,
                "platform": _platform_family(),
                "status": STATE.status,
                "error_code": None,
                "error_message": None,
            }
            yield f"data: {json.dumps(initial, ensure_ascii=False)}\n\n"
            while True:
                payload = await queue.get()
                yield f"data: {payload}\n\n"
        finally:
            with suppress(ValueError):
                STATE.queues.remove(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
