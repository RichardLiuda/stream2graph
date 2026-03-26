from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, utc_now
from app.legacy import evaluate_payload, TranscriptChunk
from app.models import RealtimeChunk, RealtimeSession
from app.routers.auth import get_current_admin
from app.schemas import (
    RealtimeAudioTranscriptionRequest,
    RealtimeAudioTranscriptionResponse,
    RealtimeChunkCreateRequest,
    RealtimeSession as RealtimeSessionSchema,
    RealtimeSessionCreateRequest,
    RealtimeSnapshot,
)
from app.services.realtime_ai import generate_mermaid_state, transcribe_audio_chunk
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


def _timestamp_for_chunk(db: Session, session_id: str, requested: int | None) -> int:
    if requested is not None:
        return requested
    last_ts = db.scalar(
        select(RealtimeChunk.timestamp_ms)
        .where(RealtimeChunk.session_id == session_id)
        .order_by(RealtimeChunk.sequence_no.desc())
        .limit(1)
    )
    return 0 if last_ts is None else int(last_ts) + 450


def _rebuild_snapshot(db: Session, obj: RealtimeSession, runtime) -> tuple[dict, dict]:
    pipeline = runtime.pipeline_payload()
    pipeline["mermaid_state"] = generate_mermaid_state(db, obj)
    evaluation = evaluate_payload(pipeline)
    replace_events(db, obj.id, pipeline["events"])
    save_snapshot(db, obj, pipeline=pipeline, evaluation=evaluation)
    return pipeline, evaluation


def _ingest_transcript_payload(
    db: Session,
    obj: RealtimeSession,
    *,
    timestamp_ms: int,
    text: str,
    speaker: str,
    is_final: bool,
    expected_intent: str | None,
    metadata: dict,
) -> tuple[list[dict], dict, dict]:
    runtime = restore_runtime_if_needed(db, obj)
    emitted = runtime.ingest_chunk(
        TranscriptChunk(
            timestamp_ms=timestamp_ms,
            text=text,
            speaker=speaker,
            is_final=is_final,
        ),
        expected_intent=expected_intent,
    )
    persist_chunk(
        db,
        obj.id,
        {
            "timestamp_ms": timestamp_ms,
            "text": text,
            "speaker": speaker,
            "is_final": is_final,
            "expected_intent": expected_intent,
            "metadata": metadata,
        },
    )
    if isinstance(metadata, dict) and metadata:
        snapshot = obj.config_snapshot if isinstance(obj.config_snapshot, dict) else {}
        input_runtime = snapshot.get("input_runtime", {}) if isinstance(snapshot.get("input_runtime"), dict) else {}
        obj.config_snapshot = {
            **snapshot,
            "input_runtime": {
                **input_runtime,
                **metadata,
            },
        }
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    return emitted, pipeline, evaluation


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
            "runtime_options": {
                "llm_profile_id": payload.llm_profile_id,
                "llm_model": payload.llm_model,
                "stt_profile_id": payload.stt_profile_id,
                "stt_model": payload.stt_model,
                "diagram_mode": payload.diagram_mode,
            },
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
    timestamp_ms = _timestamp_for_chunk(db, session_id, payload.timestamp_ms)
    emitted, pipeline, evaluation = _ingest_transcript_payload(
        db,
        obj,
        timestamp_ms=timestamp_ms,
        text=payload.text,
        speaker=payload.speaker,
        is_final=payload.is_final,
        expected_intent=payload.expected_intent,
        metadata=payload.metadata,
    )
    db.commit()
    return {
        "ok": True,
        "session_id": session_id,
        "emitted_events": emitted,
        "pipeline": pipeline,
        "evaluation": evaluation,
    }


@router.post("/{session_id}/audio/transcriptions", response_model=RealtimeAudioTranscriptionResponse)
def transcribe_audio(session_id: str, payload: RealtimeAudioTranscriptionRequest, db: Session = Depends(get_db)) -> RealtimeAudioTranscriptionResponse:
    obj = _get_session_or_404(db, session_id)
    try:
        result = transcribe_audio_chunk(
            db,
            obj,
            {
                "pcm_s16le_base64": payload.pcm_s16le_base64,
                "sample_rate": payload.sample_rate,
                "channel_count": payload.channel_count,
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    pipeline = obj.pipeline_payload if isinstance(obj.pipeline_payload, dict) else {}
    evaluation = obj.evaluation_payload if isinstance(obj.evaluation_payload, dict) else {}
    if result["text"]:
        merged_metadata = {
            **(payload.metadata if isinstance(payload.metadata, dict) else {}),
            "transcription_backend": "api_stt",
            "stt_provider": result["provider"],
            "stt_model": result["model"],
        }
        _emitted, pipeline, evaluation = _ingest_transcript_payload(
            db,
            obj,
            timestamp_ms=_timestamp_for_chunk(db, session_id, payload.timestamp_ms),
            text=result["text"],
            speaker=payload.speaker,
            is_final=payload.is_final,
            expected_intent=None,
            metadata=merged_metadata,
        )
        db.commit()
    return RealtimeAudioTranscriptionResponse(
        ok=True,
        text=result["text"],
        is_final=payload.is_final,
        provider=result["provider"],
        model=result["model"],
        latency_ms=result["latency_ms"],
        pipeline=pipeline,
        evaluation=evaluation,
    )


@router.post("/{session_id}/snapshot", response_model=RealtimeSnapshot)
def snapshot(session_id: str, db: Session = Depends(get_db)) -> RealtimeSnapshot:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    db.commit()
    return RealtimeSnapshot(session_id=session_id, pipeline=pipeline, evaluation=evaluation)


@router.post("/{session_id}/flush", response_model=RealtimeSnapshot)
def flush(session_id: str, db: Session = Depends(get_db)) -> RealtimeSnapshot:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    runtime.flush()
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
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
