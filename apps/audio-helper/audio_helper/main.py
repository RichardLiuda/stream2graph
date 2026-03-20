from __future__ import annotations

import asyncio
import json
import os
import platform
from collections.abc import AsyncGenerator
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel


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


@dataclass
class HelperState:
    status: CaptureStatus = "idle"
    source_type: str = "system_audio_helper"
    message: str = "helper idle"
    queues: list[asyncio.Queue[str]] = field(default_factory=list)

    async def publish(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        for queue in list(self.queues):
            await queue.put(data)


STATE = HelperState()


class CaptureStartRequest(BaseModel):
    source_type: str = "system_audio_helper"
    session_id: str | None = None


class CaptureResponse(BaseModel):
    ok: bool
    status: CaptureStatus
    source_type: str
    message: str


def _capability_payload() -> dict[str, Any]:
    platform_name = _platform_family()
    enabled = os.getenv("S2G_HELPER_NATIVE_CAPTURE_ENABLED", "0") == "1"
    if enabled and platform_name in {"macos", "windows"}:
      return {
          "source_type": "system_audio_helper",
          "platform": platform_name,
          "capability_status": "supported",
          "capability_reason": "本地辅助层已声明原生系统声音驱动可用。",
          "native_engine": "configured",
          "supported_sources": ["system_audio_helper"],
      }
    if platform_name in {"macos", "windows"}:
      return {
          "source_type": "system_audio_helper",
          "platform": platform_name,
          "capability_status": "limited",
          "capability_reason": "辅助层桥接协议已就绪，但当前构建尚未接入原生采集驱动。",
          "native_engine": "missing",
          "supported_sources": [],
      }
    return {
        "source_type": "system_audio_helper",
        "platform": platform_name,
        "capability_status": "unsupported",
        "capability_reason": "当前平台未纳入系统声音辅助层支持范围。",
        "native_engine": "unsupported",
        "supported_sources": [],
    }


app = FastAPI(title="Stream2Graph Audio Helper", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "stream2graph-audio-helper", "platform": _platform_family()}


@app.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    return _capability_payload()


@app.post("/capture/start", response_model=CaptureResponse)
async def start_capture(payload: CaptureStartRequest) -> CaptureResponse:
    caps = _capability_payload()
    STATE.source_type = payload.source_type
    if caps["capability_status"] != "supported":
        STATE.status = "failed"
        STATE.message = caps["capability_reason"]
        await STATE.publish(
            {
                "source_type": payload.source_type,
                "platform": caps["platform"],
                "status": "failed",
                "error_code": "native_engine_missing",
                "error_message": caps["capability_reason"],
            }
        )
        return CaptureResponse(ok=False, status=STATE.status, source_type=payload.source_type, message=STATE.message)

    STATE.status = "running"
    STATE.message = "native capture started"
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


@app.post("/capture/stop", response_model=CaptureResponse)
async def stop_capture() -> CaptureResponse:
    caps = _capability_payload()
    STATE.status = "stopped"
    STATE.message = "capture stopped"
    await STATE.publish(
        {
            "source_type": STATE.source_type,
            "platform": caps["platform"],
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
