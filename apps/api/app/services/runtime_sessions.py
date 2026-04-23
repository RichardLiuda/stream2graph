from __future__ import annotations

from threading import Lock
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db import utc_now
from app.models import RealtimeChunk, RealtimeEvent, RealtimeSession, RealtimeSessionAnnotations, RealtimeSnapshot
from app.services.realtime_coordination import CoordinationRuntimeSession, normalize_runtime_options
from app.services.realtime_transcript import attach_transcript_state


_RUNTIME_LOCK = Lock()
_RUNTIMES: dict[str, CoordinationRuntimeSession] = {}


def get_runtime(session_id: str) -> CoordinationRuntimeSession | None:
    with _RUNTIME_LOCK:
        return _RUNTIMES.get(session_id)


def put_runtime(runtime: CoordinationRuntimeSession) -> None:
    with _RUNTIME_LOCK:
        _RUNTIMES[runtime.session_id] = runtime


def drop_runtime(session_id: str) -> None:
    with _RUNTIME_LOCK:
        _RUNTIMES.pop(session_id, None)


def restore_runtime_if_needed(db: Session, session_obj: RealtimeSession) -> CoordinationRuntimeSession:
    runtime = get_runtime(session_obj.id)
    if runtime is not None:
        return runtime
    rows = [
        {
            "timestamp_ms": row.timestamp_ms,
            "text": row.text,
            "speaker": row.speaker,
            "is_final": row.is_final,
            "expected_intent": row.expected_intent,
        }
        for row in db.scalars(
            select(RealtimeChunk).where(RealtimeChunk.session_id == session_obj.id).order_by(RealtimeChunk.sequence_no.asc())
        ).all()
    ]
    runtime = CoordinationRuntimeSession.restore(
        session_obj.id,
        config_snapshot=session_obj.config_snapshot if isinstance(session_obj.config_snapshot, dict) else {},
        pipeline_payload=session_obj.pipeline_payload if isinstance(session_obj.pipeline_payload, dict) else {},
        evaluation_payload=session_obj.evaluation_payload if isinstance(session_obj.evaluation_payload, dict) else {},
        rows=rows,
    )
    put_runtime(runtime)
    return runtime


def create_runtime_session(db: Session, session_obj: RealtimeSession) -> CoordinationRuntimeSession:
    runtime_options = normalize_runtime_options(
        (
            session_obj.config_snapshot.get("runtime_options", {})
            if isinstance(session_obj.config_snapshot, dict)
            else {}
        )
    )
    runtime = CoordinationRuntimeSession.create(
        session_obj.id,
        diagram_type=str(runtime_options.get("diagram_type", "flowchart") or "flowchart"),
    )
    put_runtime(runtime)
    return runtime


def persist_chunk(db: Session, session_id: str, payload: dict[str, Any]) -> RealtimeChunk:
    count = db.scalar(select(func.count()).select_from(RealtimeChunk).where(RealtimeChunk.session_id == session_id)) or 0
    obj = RealtimeChunk(
        session_id=session_id,
        sequence_no=int(count),
        timestamp_ms=int(payload["timestamp_ms"]),
        speaker=str(payload.get("speaker", "user")),
        text=str(payload["text"]),
        is_final=bool(payload.get("is_final", True)),
        expected_intent=payload.get("expected_intent"),
        meta_json=payload.get("metadata", {}) if isinstance(payload.get("metadata"), dict) else {},
    )
    db.add(obj)
    return obj


def replace_events(db: Session, session_id: str, events: list[dict[str, Any]]) -> None:
    db.execute(delete(RealtimeEvent).where(RealtimeEvent.session_id == session_id))
    for index, event in enumerate(events):
        db.add(RealtimeEvent(session_id=session_id, event_index=index, payload=event))


def save_snapshot(db: Session, session_obj: RealtimeSession, *, pipeline: dict[str, Any], evaluation: dict[str, Any] | None) -> None:
    pipeline = attach_transcript_state(db, session_obj.id, pipeline)
    runtime_meta = {}
    if isinstance(session_obj.config_snapshot, dict):
        runtime_meta = session_obj.config_snapshot.get("input_runtime", {}) if isinstance(session_obj.config_snapshot.get("input_runtime"), dict) else {}
    mermaid_state = pipeline.get("mermaid_state", {}) if isinstance(pipeline.get("mermaid_state"), dict) else {}
    transcript_state = pipeline.get("transcript_state", {}) if isinstance(pipeline.get("transcript_state"), dict) else {}
    session_obj.summary_json = {
        **(pipeline.get("summary", {}) if isinstance(pipeline.get("summary", {}), dict) else {}),
        "input_runtime": runtime_meta,
        "mermaid_state": mermaid_state,
        "transcript_summary": {
            "turn_count": transcript_state.get("turn_count", 0),
            "speaker_count": transcript_state.get("speaker_count", 0),
            "chunk_count": transcript_state.get("chunk_count", 0),
        },
    }
    chunk_rows = db.scalars(
        select(RealtimeChunk)
        .where(RealtimeChunk.session_id == session_obj.id)
        .order_by(RealtimeChunk.sequence_no.asc())
    ).all()
    chunk_checkpoint = [
        {
            "sequence_no": int(row.sequence_no),
            "timestamp_ms": int(row.timestamp_ms),
            "speaker": str(row.speaker),
            "text": str(row.text),
            "is_final": bool(row.is_final),
            "expected_intent": row.expected_intent,
            "metadata": row.meta_json if isinstance(row.meta_json, dict) else {},
        }
        for row in chunk_rows
    ]
    annotations_row = db.scalar(
        select(RealtimeSessionAnnotations).where(RealtimeSessionAnnotations.session_id == session_obj.id)
    )
    annotation_version = int(annotations_row.version or 1) if annotations_row else 1
    annotation_payload = annotations_row.payload_json if annotations_row and isinstance(annotations_row.payload_json, dict) else {}
    checkpoint = {
        "chunk_count": len(chunk_checkpoint),
        "chunks": chunk_checkpoint,
        "annotations": {
            "version": annotation_version,
            "payload": annotation_payload,
        },
    }
    session_obj.pipeline_payload = pipeline
    session_obj.evaluation_payload = evaluation or {}
    session_obj.updated_at = utc_now()
    db.add(
        RealtimeSnapshot(
            session_id=session_obj.id,
            summary_json={**session_obj.summary_json, "timeline_checkpoint": checkpoint},
            pipeline_payload=pipeline,
            evaluation_payload=evaluation or {},
        )
    )
