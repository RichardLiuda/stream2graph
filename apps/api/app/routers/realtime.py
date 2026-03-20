from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, utc_now
from app.legacy import evaluate_payload, TranscriptChunk
from app.models import RealtimeChunk, RealtimeSession
from app.routers.auth import get_current_admin
from app.schemas import RealtimeChunkCreateRequest, RealtimeSession as RealtimeSessionSchema, RealtimeSessionCreateRequest, RealtimeSnapshot
from app.services.reports import create_report
from app.services.runtime_sessions import (
    create_runtime_session,
    drop_runtime,
    persist_chunk,
    replace_events,
    restore_runtime_if_needed,
    save_snapshot,
)


router = APIRouter(prefix="/realtime/sessions", tags=["realtime"], dependencies=[Depends(get_current_admin)])


def _get_session_or_404(db: Session, session_id: str) -> RealtimeSession:
    obj = db.get(RealtimeSession, session_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="session not found")
    return obj


@router.get("", response_model=list[RealtimeSessionSchema])
def list_sessions(db: Session = Depends(get_db)) -> list[RealtimeSessionSchema]:
    items = db.scalars(select(RealtimeSession).order_by(RealtimeSession.created_at.desc())).all()
    return [
        RealtimeSessionSchema(
            session_id=item.id,
            title=item.title,
            status=item.status,
            dataset_version_slug=item.dataset_version_slug,
            created_at=item.created_at,
            updated_at=item.updated_at,
            summary=item.summary_json,
        )
        for item in items
    ]


@router.post("", response_model=RealtimeSessionSchema)
def create_session(payload: RealtimeSessionCreateRequest, db: Session = Depends(get_db)) -> RealtimeSessionSchema:
    obj = RealtimeSession(
        title=payload.title,
        status="active",
        dataset_version_slug=payload.dataset_version_slug,
        config_snapshot={
            "min_wait_k": payload.min_wait_k,
            "base_wait_k": payload.base_wait_k,
            "max_wait_k": payload.max_wait_k,
            "input_runtime": payload.client_context if isinstance(payload.client_context, dict) else {},
        },
    )
    db.add(obj)
    db.flush()
    create_runtime_session(db, obj)
    db.commit()
    return RealtimeSessionSchema(
        session_id=obj.id,
        title=obj.title,
        status=obj.status,
        dataset_version_slug=obj.dataset_version_slug,
        created_at=obj.created_at,
        updated_at=obj.updated_at,
        summary=obj.summary_json,
    )


@router.get("/{session_id}", response_model=RealtimeSessionSchema)
def get_session(session_id: str, db: Session = Depends(get_db)) -> RealtimeSessionSchema:
    obj = _get_session_or_404(db, session_id)
    restore_runtime_if_needed(db, obj)
    return RealtimeSessionSchema(
        session_id=obj.id,
        title=obj.title,
        status=obj.status,
        dataset_version_slug=obj.dataset_version_slug,
        created_at=obj.created_at,
        updated_at=obj.updated_at,
        summary=obj.summary_json,
    )


@router.post("/{session_id}/chunks")
def add_chunk(session_id: str, payload: RealtimeChunkCreateRequest, db: Session = Depends(get_db)) -> dict:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    if payload.timestamp_ms is None:
        last_ts = db.scalar(
            select(RealtimeChunk.timestamp_ms)
            .where(RealtimeChunk.session_id == session_id)
            .order_by(RealtimeChunk.sequence_no.desc())
            .limit(1)
        )
        timestamp_ms = 0 if last_ts is None else int(last_ts) + 450
    else:
        timestamp_ms = payload.timestamp_ms
    emitted = runtime.ingest_chunk(
        TranscriptChunk(
            timestamp_ms=timestamp_ms,
            text=payload.text,
            speaker=payload.speaker,
            is_final=payload.is_final,
        ),
        expected_intent=payload.expected_intent,
    )
    persist_chunk(
        db,
        session_id,
        {
            "timestamp_ms": timestamp_ms,
            "text": payload.text,
            "speaker": payload.speaker,
            "is_final": payload.is_final,
            "expected_intent": payload.expected_intent,
            "metadata": payload.metadata,
        },
    )
    if isinstance(payload.metadata, dict) and payload.metadata:
        input_runtime = obj.config_snapshot.get("input_runtime", {}) if isinstance(obj.config_snapshot, dict) else {}
        obj.config_snapshot = {
            **(obj.config_snapshot if isinstance(obj.config_snapshot, dict) else {}),
            "input_runtime": {
                **(input_runtime if isinstance(input_runtime, dict) else {}),
                **payload.metadata,
            },
        }
    pipeline = runtime.pipeline_payload()
    evaluation = evaluate_payload(pipeline)
    replace_events(db, session_id, pipeline["events"])
    save_snapshot(db, obj, pipeline=pipeline, evaluation=evaluation)
    db.commit()
    return {
        "ok": True,
        "session_id": session_id,
        "emitted_events": emitted,
        "pipeline": pipeline,
        "evaluation": evaluation,
    }


@router.post("/{session_id}/snapshot", response_model=RealtimeSnapshot)
def snapshot(session_id: str, db: Session = Depends(get_db)) -> RealtimeSnapshot:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    pipeline = runtime.pipeline_payload()
    evaluation = evaluate_payload(pipeline)
    save_snapshot(db, obj, pipeline=pipeline, evaluation=evaluation)
    db.commit()
    return RealtimeSnapshot(session_id=session_id, pipeline=pipeline, evaluation=evaluation)


@router.post("/{session_id}/flush", response_model=RealtimeSnapshot)
def flush(session_id: str, db: Session = Depends(get_db)) -> RealtimeSnapshot:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    runtime.flush()
    pipeline = runtime.pipeline_payload()
    evaluation = evaluate_payload(pipeline)
    replace_events(db, session_id, pipeline["events"])
    save_snapshot(db, obj, pipeline=pipeline, evaluation=evaluation)
    db.commit()
    return RealtimeSnapshot(session_id=session_id, pipeline=pipeline, evaluation=evaluation)


@router.post("/{session_id}/close")
def close_session(session_id: str, db: Session = Depends(get_db)) -> dict[str, bool | str]:
    obj = _get_session_or_404(db, session_id)
    obj.status = "closed"
    obj.closed_at = utc_now()
    obj.updated_at = utc_now()
    db.commit()
    drop_runtime(session_id)
    return {"ok": True, "session_id": session_id, "closed": True}


@router.post("/{session_id}/report")
def save_realtime_report(session_id: str, db: Session = Depends(get_db)) -> dict:
    obj = _get_session_or_404(db, session_id)
    report = create_report(
        db,
        report_type="realtime_session",
        title=f"realtime_{session_id}",
        summary=obj.summary_json or {},
        payload={
            "session_id": session_id,
            "pipeline": obj.pipeline_payload,
            "evaluation": obj.evaluation_payload,
        },
        related_session_id=session_id,
    )
    db.commit()
    return {"ok": True, "report_id": report.id}
