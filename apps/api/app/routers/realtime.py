from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import get_db, utc_now
from app.legacy import evaluate_payload
from app.models import RealtimeChunk, RealtimeEvent, RealtimeSession, RealtimeSessionAnnotations, RealtimeSnapshot as RealtimeSnapshotModel
from app.schemas import (
    RealtimeAudioTranscriptionRequest,
    RealtimeAudioTranscriptionResponse,
    RealtimeChunkBatchCreateRequest,
    RealtimeChunkCreateRequest,
    RealtimeDiagramRelayoutRequest,
    RealtimeRollbackApplyResponse,
    RealtimeRollbackEditApplyResponse,
    RealtimeRollbackEditRequest,
    RealtimeRollbackPreviewResponse,
    RealtimeRollbackRequest,
    RealtimeSessionCloseResponse,
    RealtimeSession as RealtimeSessionSchema,
    RealtimeSessionCreateRequest,
    RealtimeSessionUpdateRequest,
    RealtimeSnapshot,
    RealtimeSessionAnnotations as RealtimeSessionAnnotationsSchema,
    RealtimeSessionAnnotationsUpdateRequest,
    RealtimeTimelineNode,
    RealtimeTimelineResponse,
)
from app.services.realtime_ai import detect_diagram_type_from_transcript, transcribe_audio_chunk
from app.services.reports import create_report
from app.services.runtime_options import resolve_profile
from app.services.runtime_sessions import (
    create_runtime_session,
    drop_runtime,
    persist_chunk,
    replace_events,
    restore_runtime_if_needed,
    save_snapshot,
)
from app.services.realtime_transcript import (
    attach_transcript_state,
    build_transcript_download_urls,
    build_transcript_turns,
    list_session_chunks,
    render_transcript_markdown,
    render_transcript_txt,
    session_transcript_summary,
)
from app.services.voiceprints import blind_recognize_speaker
from app.services.xfyun_asr import close_rtasr_session_stream


router = APIRouter(prefix="/realtime/sessions", tags=["realtime"])
logger = logging.getLogger(__name__)
MAX_REALTIME_CHUNK_TIMESTAMP_MS = 2_147_483_647


def _log_runtime_event(message: str, payload: dict) -> None:
    logger.info("%s %s", message, json.dumps(payload, ensure_ascii=False))


def _get_session_or_404(db: Session, session_id: str) -> RealtimeSession:
    obj = db.get(RealtimeSession, session_id)
    if obj is None:
        raise HTTPException(status_code=404, detail="session not found")
    return obj


def _normalize_requested_timestamp_ms(obj: RealtimeSession, requested: int) -> int:
    value = int(requested)
    if value <= MAX_REALTIME_CHUNK_TIMESTAMP_MS:
        return max(0, value)
    session_started_ms = int(obj.created_at.timestamp() * 1000)
    relative_ms = max(0, value - session_started_ms)
    return min(relative_ms, MAX_REALTIME_CHUNK_TIMESTAMP_MS)


def _timestamp_for_chunk(db: Session, obj: RealtimeSession, requested: int | None) -> int:
    if requested is not None:
        return _normalize_requested_timestamp_ms(obj, requested)
    last_ts = db.scalar(
        select(RealtimeChunk.timestamp_ms)
        .where(RealtimeChunk.session_id == obj.id)
        .order_by(RealtimeChunk.sequence_no.desc())
        .limit(1)
    )
    return 0 if last_ts is None else min(int(last_ts) + 450, MAX_REALTIME_CHUNK_TIMESTAMP_MS)


def _rebuild_snapshot(db: Session, obj: RealtimeSession, runtime) -> tuple[dict, dict]:
    pipeline = attach_transcript_state(db, obj.id, runtime.pipeline_payload())
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
        db,
        obj,
        timestamp_ms=timestamp_ms,
        text=text,
        speaker=speaker,
        is_final=is_final,
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
    _merge_input_runtime_metadata(obj, metadata)
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    return emitted, pipeline, evaluation


def _buffer_transcript_payload(
    db: Session,
    obj: RealtimeSession,
    *,
    timestamp_ms: int,
    text: str,
    speaker: str,
    is_final: bool,
    expected_intent: str | None,
    metadata: dict,
) -> tuple[dict, dict]:
    runtime = restore_runtime_if_needed(db, obj)
    runtime.buffer_chunk(
        timestamp_ms=timestamp_ms,
        text=text,
        speaker=speaker,
        is_final=is_final,
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
    _merge_input_runtime_metadata(obj, metadata)
    pipeline = attach_transcript_state(db, obj.id, runtime.pipeline_payload())
    evaluation = evaluate_payload(pipeline)
    save_snapshot(db, obj, pipeline=pipeline, evaluation=evaluation)
    return pipeline, evaluation


def _merge_input_runtime_metadata(obj: RealtimeSession, metadata: dict) -> None:
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


def _normalize_segments(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        rows.append(item)
    return rows


def _role_split_voiceprint_summary(segments: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not segments:
        return None
    resolved_by_feature = [item for item in segments if str(item.get("speaker_resolution_source", "")).strip() == "rtasr_feature"]
    speakers = [str(item.get("speaker", "")).strip() for item in segments if str(item.get("speaker", "")).strip()]
    return {
        "matched": bool(resolved_by_feature),
        "mode": "feature_split" if resolved_by_feature else "blind_split",
        "role_separated": True,
        "speaker_count": len(set(speakers)),
        "segment_count": len(segments),
        "feature_ids": [
            str(item.get("feature_id", "")).strip()
            for item in resolved_by_feature
            if str(item.get("feature_id", "")).strip()
        ],
        "error_message": None,
    }


def _timeline_checkpoint(snapshot: RealtimeSnapshotModel) -> dict[str, Any]:
    summary = snapshot.summary_json if isinstance(snapshot.summary_json, dict) else {}
    checkpoint = summary.get("timeline_checkpoint", {})
    return checkpoint if isinstance(checkpoint, dict) else {}


def _timeline_node_from_snapshot(snapshot: RealtimeSnapshotModel) -> RealtimeTimelineNode:
    summary = snapshot.summary_json if isinstance(snapshot.summary_json, dict) else {}
    checkpoint = _timeline_checkpoint(snapshot)
    chunk_count = checkpoint.get("chunk_count")
    if not isinstance(chunk_count, int):
        chunks = checkpoint.get("chunks")
        chunk_count = len(chunks) if isinstance(chunks, list) else 0
    pipeline = snapshot.pipeline_payload if isinstance(snapshot.pipeline_payload, dict) else {}
    events = pipeline.get("events")
    event_count = len(events) if isinstance(events, list) else 0
    label = summary.get("timeline_label")
    return RealtimeTimelineNode(
        snapshot_id=snapshot.id,
        created_at=snapshot.created_at,
        summary=summary,
        event_count=event_count,
        chunk_count=max(0, int(chunk_count)),
        label=str(label) if isinstance(label, str) and label.strip() else None,
    )


def _coerce_turn_from_payload(item: dict[str, Any]) -> dict[str, Any] | None:
    speaker = str(item.get("speaker") or "speaker").strip() or "speaker"
    text = str(item.get("text") or item.get("content") or "").strip()
    if not text:
        return None
    start_ms = int(item.get("start_ms", item.get("timestamp_ms", 0)) or 0)
    end_ms = int(item.get("end_ms", item.get("timestamp_ms", start_ms)) or start_ms)
    return {
        "speaker": speaker,
        "text": text,
        "start_ms": max(0, start_ms),
        "end_ms": max(0, end_ms),
        "is_final": bool(item.get("is_final", True)),
        "source": str(item.get("source") or "timeline_fallback"),
        "capture_mode": str(item.get("capture_mode") or "snapshot"),
    }


def _speaker_priority(value: str) -> int:
    speaker = str(value or "").strip().lower()
    if not speaker or speaker == "speaker":
        return 0
    if speaker == "user":
        return 1
    return 2


def _merge_turns_dedup(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[str, int, int], dict[str, Any]] = {}
    for turn in rows:
        text = str(turn.get("text") or "").strip()
        if not text:
            continue
        start_ms = int(turn.get("start_ms", 0) or 0)
        end_ms = int(turn.get("end_ms", start_ms) or start_ms)
        key = (text, start_ms, end_ms)
        existing = merged.get(key)
        if existing is None:
            merged[key] = dict(turn)
            continue
        next_priority = _speaker_priority(str(turn.get("speaker") or ""))
        existing_priority = _speaker_priority(str(existing.get("speaker") or ""))
        if next_priority > existing_priority:
            merged[key] = {**existing, **turn}
    return sorted(merged.values(), key=lambda item: (int(item.get("start_ms", 0)), int(item.get("end_ms", 0))))


def _timeline_preview_turns(snapshot: RealtimeSnapshotModel, *, session_id: str, chunks: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if isinstance(chunks, list) and chunks:
        rows = []
        for index, item in enumerate(chunks):
            if not isinstance(item, dict):
                continue
            rows.append(
                RealtimeChunk(
                    session_id=session_id,
                    sequence_no=int(item.get("sequence_no", index)),
                    timestamp_ms=int(item.get("timestamp_ms", 0)),
                    speaker=str(item.get("speaker", "speaker")),
                    text=str(item.get("text", "")),
                    is_final=bool(item.get("is_final", True)),
                    expected_intent=item.get("expected_intent"),
                    meta_json=item.get("metadata", {}) if isinstance(item.get("metadata"), dict) else {},
                )
            )
        return build_transcript_turns(rows)

    pipeline = snapshot.pipeline_payload if isinstance(snapshot.pipeline_payload, dict) else {}
    transcript_state = pipeline.get("transcript_state") if isinstance(pipeline.get("transcript_state"), dict) else {}
    turns: list[dict[str, Any]] = []
    for key in ("current_turn", "latest_final_turn"):
        item = transcript_state.get(key)
        if isinstance(item, dict):
            turn = _coerce_turn_from_payload(item)
            if turn is not None:
                turns.append(turn)
    for key in ("archived_recent_turns", "recent_turns"):
        rows = transcript_state.get(key)
        if isinstance(rows, list):
            for item in rows:
                if not isinstance(item, dict):
                    continue
                turn = _coerce_turn_from_payload(item)
                if turn is None:
                    continue
                turns.append(turn)
    if turns:
        return _merge_turns_dedup(turns)

    events = pipeline.get("events")
    if isinstance(events, list):
        fallback_turns: list[dict[str, Any]] = []
        for event in events:
            if not isinstance(event, dict):
                continue
            pending_turns = event.get("pending_turns")
            if isinstance(pending_turns, list):
                for turn_payload in pending_turns:
                    if not isinstance(turn_payload, dict):
                        continue
                    turn = _coerce_turn_from_payload(turn_payload)
                    if turn is not None:
                        fallback_turns.append(turn)
            update = event.get("update")
            if isinstance(update, dict):
                turn = _coerce_turn_from_payload(
                    {
                        "speaker": update.get("speaker", "speaker"),
                        "text": update.get("transcript_text"),
                        "start_ms": update.get("start_ms", 0),
                        "end_ms": update.get("end_ms", update.get("start_ms", 0)),
                        "is_final": True,
                        "source": "timeline_event",
                        "capture_mode": "event",
                    }
                )
                if turn is not None:
                    fallback_turns.append(turn)
        if fallback_turns:
            return _merge_turns_dedup(fallback_turns)[-24:]
    return []


def _has_mermaid_render_issue(pipeline: dict[str, Any] | None) -> bool:
    if not isinstance(pipeline, dict):
        return True
    mermaid_state = pipeline.get("mermaid_state")
    if not isinstance(mermaid_state, dict):
        return True
    if mermaid_state.get("error_message"):
        return True
    if mermaid_state.get("compile_ok") is False:
        return True
    if mermaid_state.get("render_ok") is False:
        return True
    code = str(mermaid_state.get("code") or mermaid_state.get("normalized_code") or "").strip()
    return not bool(code)


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


@router.get("/{session_id}/annotations", response_model=RealtimeSessionAnnotationsSchema)
def get_session_annotations(session_id: str, db: Session = Depends(get_db)) -> RealtimeSessionAnnotationsSchema:
    _get_session_or_404(db, session_id)
    row = db.scalar(select(RealtimeSessionAnnotations).where(RealtimeSessionAnnotations.session_id == session_id))
    if row is None:
        return RealtimeSessionAnnotationsSchema(session_id=session_id, version=1, payload={})
    return RealtimeSessionAnnotationsSchema(session_id=session_id, version=int(row.version or 1), payload=row.payload_json or {})


@router.put("/{session_id}/annotations", response_model=RealtimeSessionAnnotationsSchema)
def put_session_annotations(
    session_id: str,
    req: RealtimeSessionAnnotationsUpdateRequest,
    db: Session = Depends(get_db),
) -> RealtimeSessionAnnotationsSchema:
    _get_session_or_404(db, session_id)
    row = db.scalar(select(RealtimeSessionAnnotations).where(RealtimeSessionAnnotations.session_id == session_id))
    if row is None:
        row = RealtimeSessionAnnotations(
            session_id=session_id,
            version=max(1, int(req.version or 1)),
            payload_json=req.payload or {},
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        db.add(row)
        db.flush()
    else:
        row.version = max(1, int(req.version or 1))
        row.payload_json = req.payload or {}
        row.updated_at = utc_now()
        db.add(row)
    return RealtimeSessionAnnotationsSchema(session_id=session_id, version=int(row.version or 1), payload=row.payload_json or {})


class DiagramTypeDetectionRequest(BaseModel):
    transcript: str = Field(..., min_length=1, description="Dialogue transcript to analyze for diagram type detection.")


@router.post("/detect-diagram-type", response_model=dict[str, str])
def detect_diagram_type(payload: DiagramTypeDetectionRequest, db: Session = Depends(get_db)) -> dict[str, str]:
    """Analyze dialogue transcript and automatically detect the most appropriate diagram type."""
    runtime_options = db.execute(
        select(RealtimeSession.config_snapshot)
        .order_by(RealtimeSession.created_at.desc())
        .limit(1)
    ).first()
    profile = None
    model = None
    if runtime_options:
        snapshot = runtime_options[0] if isinstance(runtime_options, tuple) else runtime_options
        if isinstance(snapshot, dict):
            ropts = snapshot.get("runtime_options", {})
            if isinstance(ropts, dict):
                profile = resolve_profile(db, "llm", ropts.get("llm_profile_id"))
                model = str(ropts.get("llm_model") or (profile or {}).get("default_model") or "")

    detected = detect_diagram_type_from_transcript(
        payload.transcript,
        profile=profile,
        model=model,
    )
    _log_runtime_event(
        "Diagram type auto-detected",
        {"detected_type": detected, "transcript_chars": len(payload.transcript)},
    )
    return {"diagram_type": detected}


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
                "diagram_type": payload.diagram_type,
                "gate_profile_id": payload.gate_profile_id,
                "gate_model": payload.gate_model,
                "planner_profile_id": payload.planner_profile_id,
                "planner_model": payload.planner_model,
                "stt_profile_id": payload.stt_profile_id,
                "stt_model": payload.stt_model,
                "diagram_mode": payload.diagram_mode,
            },
            "input_runtime": payload.client_context if isinstance(payload.client_context, dict) else {},
        },
    )
    db.add(obj)
    db.flush()
    _log_runtime_event(
        "Realtime session created",
        {
            "session_id": obj.id,
            "title": obj.title,
            "dataset_version_slug": obj.dataset_version_slug,
            "runtime_options": obj.config_snapshot.get("runtime_options", {}),
            "input_runtime": obj.config_snapshot.get("input_runtime", {}),
        },
    )
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


def _apply_session_title_update(db: Session, session_id: str, payload: RealtimeSessionUpdateRequest) -> RealtimeSessionSchema:
    obj = _get_session_or_404(db, session_id)
    obj.title = payload.title.strip()
    obj.updated_at = utc_now()
    db.commit()
    db.refresh(obj)
    _log_runtime_event(
        "Realtime session title updated",
        {"session_id": obj.id, "title": obj.title},
    )
    return RealtimeSessionSchema(
        session_id=obj.id,
        title=obj.title,
        status=obj.status,
        dataset_version_slug=obj.dataset_version_slug,
        created_at=obj.created_at,
        updated_at=obj.updated_at,
        summary=obj.summary_json,
    )


@router.patch("/{session_id}", response_model=RealtimeSessionSchema)
def patch_session(
    session_id: str,
    payload: RealtimeSessionUpdateRequest,
    db: Session = Depends(get_db),
) -> RealtimeSessionSchema:
    return _apply_session_title_update(db, session_id, payload)


@router.put("/{session_id}", response_model=RealtimeSessionSchema)
def put_session(
    session_id: str,
    payload: RealtimeSessionUpdateRequest,
    db: Session = Depends(get_db),
) -> RealtimeSessionSchema:
    """与 PATCH 相同；部分代理/网关对 PATCH 支持不佳时可改用 PUT。"""
    return _apply_session_title_update(db, session_id, payload)


@router.delete("/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db)) -> dict[str, bool | str]:
    obj = _get_session_or_404(db, session_id)
    close_rtasr_session_stream(session_id)
    drop_runtime(session_id)
    db.delete(obj)
    db.commit()
    _log_runtime_event("Realtime session deleted", {"session_id": session_id})
    return {"ok": True, "session_id": session_id}


@router.post("/{session_id}/chunks")
def add_chunk(session_id: str, payload: RealtimeChunkCreateRequest, db: Session = Depends(get_db)) -> dict:
    obj = _get_session_or_404(db, session_id)
    timestamp_ms = _timestamp_for_chunk(db, obj, payload.timestamp_ms)
    _log_runtime_event(
        "Realtime chunk ingest requested",
        {
            "session_id": session_id,
            "timestamp_ms": timestamp_ms,
            "speaker": payload.speaker,
            "is_final": payload.is_final,
            "text_chars": len(payload.text or ""),
            "metadata": payload.metadata,
        },
    )
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
    _log_runtime_event(
        "Realtime chunk ingest completed",
        {
            "session_id": session_id,
            "emitted_event_count": len(emitted),
            "updates_emitted": pipeline.get("summary", {}).get("updates_emitted"),
            "pending_turn_count": pipeline.get("coordination_summary", {}).get("pending_turn_count"),
            "gate_state": pipeline.get("gate_state"),
            "planner_state": pipeline.get("planner_state"),
        },
    )
    return {
        "ok": True,
        "session_id": session_id,
        "emitted_events": emitted,
        "pipeline": pipeline,
        "evaluation": evaluation,
    }


@router.post("/{session_id}/chunks/batch")
def add_chunk_batch(session_id: str, payload: RealtimeChunkBatchCreateRequest, db: Session = Depends(get_db)) -> dict:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    last_metadata: dict = {}
    for row in payload.chunks:
        timestamp_ms = _timestamp_for_chunk(db, obj, row.timestamp_ms)
        _log_runtime_event(
            "Realtime chunk buffered",
            {
                "session_id": session_id,
                "timestamp_ms": timestamp_ms,
                "speaker": row.speaker,
                "is_final": row.is_final,
                "text_chars": len(row.text or ""),
                "metadata": row.metadata,
            },
        )
        runtime.buffer_chunk(
            timestamp_ms=timestamp_ms,
            text=row.text,
            speaker=row.speaker,
            is_final=row.is_final,
            expected_intent=row.expected_intent,
        )
        persist_chunk(
            db,
            obj.id,
            {
                "timestamp_ms": timestamp_ms,
                "text": row.text,
                "speaker": row.speaker,
                "is_final": row.is_final,
                "expected_intent": row.expected_intent,
                "metadata": row.metadata,
            },
        )
        if isinstance(row.metadata, dict):
            last_metadata = row.metadata
    _merge_input_runtime_metadata(obj, last_metadata)
    emitted = runtime.run_pending(db, obj)
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    db.commit()
    _log_runtime_event(
        "Realtime chunk batch completed",
        {
            "session_id": session_id,
            "buffered_count": len(payload.chunks),
            "emitted_event_count": len(emitted),
            "updates_emitted": pipeline.get("summary", {}).get("updates_emitted"),
            "pending_turn_count": pipeline.get("coordination_summary", {}).get("pending_turn_count"),
            "gate_state": pipeline.get("gate_state"),
            "planner_state": pipeline.get("planner_state"),
        },
    )
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
    runtime_options = obj.config_snapshot.get("runtime_options", {}) if isinstance(obj.config_snapshot, dict) else {}
    stt_profile = resolve_profile(db, "stt", runtime_options.get("stt_profile_id"))
    _log_runtime_event(
        "Realtime audio transcription requested",
        {
            "session_id": session_id,
            "stt_profile_id": (stt_profile or {}).get("id", runtime_options.get("stt_profile_id")),
            "stt_model": runtime_options.get("stt_model"),
            "sample_rate": payload.sample_rate,
            "channel_count": payload.channel_count,
            "speaker": payload.speaker,
            "metadata": payload.metadata,
        },
    )
    try:
        result = transcribe_audio_chunk(
            db,
            obj,
            {
                "pcm_s16le_base64": payload.pcm_s16le_base64,
                "sample_rate": payload.sample_rate,
                "channel_count": payload.channel_count,
                "is_final": payload.is_final,
                "speaker": payload.speaker,
            },
        )
    except Exception as exc:
        logger.exception(
            "Realtime audio transcription failed for session=%s stt_profile_id=%s stt_model=%s",
            session_id,
            (stt_profile or {}).get("id", runtime_options.get("stt_profile_id")),
            runtime_options.get("stt_model"),
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    pipeline = attach_transcript_state(db, obj.id, obj.pipeline_payload if isinstance(obj.pipeline_payload, dict) else {})
    evaluation = obj.evaluation_payload if isinstance(obj.evaluation_payload, dict) else {}
    recognized_speaker = str(result.get("speaker", payload.speaker) or payload.speaker)
    normalized_segments = _normalize_segments(result.get("segments"))
    voiceprint_result: dict[str, Any] | None = None
    base_metadata = {
        **(payload.metadata if isinstance(payload.metadata, dict) else {}),
        "transcription_backend": "api_stt",
        "stt_provider": result["provider"],
        "stt_model": result["model"],
        "role_type": 2,
    }
    if str(result.get("sid", "")).strip():
        base_metadata["rtasr_sid"] = str(result.get("sid", "")).strip()
    should_defer_coordination = not bool(payload.is_final)

    if normalized_segments:
        base_timestamp_ms = _timestamp_for_chunk(db, obj, payload.timestamp_ms)
        for index, segment in enumerate(normalized_segments):
            merged_metadata = {
                **base_metadata,
                "seg_id": int(segment.get("seg_id", -1) or -1),
                "rtasr_role_label": str(segment.get("speaker", "")).strip(),
                "rtasr_role_index": int(segment.get("role_index", 0) or 0),
                "feature_id": str(segment.get("feature_id", "")).strip(),
                "speaker_resolution_source": str(segment.get("speaker_resolution_source", "rtasr_role")).strip()
                or "rtasr_role",
            }
            if should_defer_coordination:
                pipeline, evaluation = _buffer_transcript_payload(
                    db,
                    obj,
                    timestamp_ms=base_timestamp_ms + index,
                    text=str(segment.get("text", "")).strip(),
                    speaker=str(segment.get("speaker", payload.speaker) or payload.speaker),
                    is_final=payload.is_final,
                    expected_intent=None,
                    metadata=merged_metadata,
                )
            else:
                _emitted, pipeline, evaluation = _ingest_transcript_payload(
                    db,
                    obj,
                    timestamp_ms=base_timestamp_ms + index,
                    text=str(segment.get("text", "")).strip(),
                    speaker=str(segment.get("speaker", payload.speaker) or payload.speaker),
                    is_final=payload.is_final,
                    expected_intent=None,
                    metadata=merged_metadata,
                )
        db.commit()
        unique_speakers = {
            str(segment.get("speaker", "")).strip()
            for segment in normalized_segments
            if str(segment.get("speaker", "")).strip()
        }
        if len(unique_speakers) == 1:
            recognized_speaker = next(iter(unique_speakers))
        elif unique_speakers:
            recognized_speaker = "multi_speaker"
        voiceprint_result = _role_split_voiceprint_summary(normalized_segments)
    else:
        voiceprint_result = blind_recognize_speaker(
            db,
            stt_profile_id=str((stt_profile or {}).get("id", runtime_options.get("stt_profile_id") or "")),
            profile=stt_profile,
            pcm_s16le_base64=payload.pcm_s16le_base64,
            sample_rate=payload.sample_rate,
            channel_count=payload.channel_count,
            fallback_speaker=payload.speaker,
        )
        if isinstance(voiceprint_result, dict) and voiceprint_result.get("matched"):
            recognized_speaker = str(voiceprint_result.get("speaker_label", payload.speaker) or payload.speaker)
        if result["text"]:
            merged_metadata = dict(base_metadata)
            if voiceprint_result is not None:
                merged_metadata["voiceprint_result"] = voiceprint_result
            if should_defer_coordination:
                pipeline, evaluation = _buffer_transcript_payload(
                    db,
                    obj,
                    timestamp_ms=_timestamp_for_chunk(db, obj, payload.timestamp_ms),
                    text=result["text"],
                    speaker=recognized_speaker,
                    is_final=payload.is_final,
                    expected_intent=None,
                    metadata=merged_metadata,
                )
            else:
                _emitted, pipeline, evaluation = _ingest_transcript_payload(
                    db,
                    obj,
                    timestamp_ms=_timestamp_for_chunk(db, obj, payload.timestamp_ms),
                    text=result["text"],
                    speaker=recognized_speaker,
                    is_final=payload.is_final,
                    expected_intent=None,
                    metadata=merged_metadata,
                )
            db.commit()
    _log_runtime_event(
        "Realtime audio transcription completed",
        {
            "session_id": session_id,
            "provider": result.get("provider"),
            "model": result.get("model"),
            "latency_ms": result.get("latency_ms"),
            "text_chars": len(result.get("text", "") or ""),
            "recognized_speaker": recognized_speaker,
            "segment_count": len(normalized_segments),
            "voiceprint_matched": bool((voiceprint_result or {}).get("matched")) if isinstance(voiceprint_result, dict) else False,
            "gate_state": pipeline.get("gate_state") if isinstance(pipeline, dict) else None,
            "planner_state": pipeline.get("planner_state") if isinstance(pipeline, dict) else None,
        },
    )
    return RealtimeAudioTranscriptionResponse(
        ok=True,
        text=result["text"],
        speaker=recognized_speaker,
        voiceprint=voiceprint_result,
        is_final=payload.is_final,
        provider=result["provider"],
        model=result["model"],
        latency_ms=result["latency_ms"],
        segments=normalized_segments or None,
        pipeline=pipeline,
        evaluation=evaluation,
    )


@router.get("/{session_id}/timeline", response_model=RealtimeTimelineResponse)
def get_timeline(session_id: str, db: Session = Depends(get_db)) -> RealtimeTimelineResponse:
    _get_session_or_404(db, session_id)
    snapshots = db.scalars(
        select(RealtimeSnapshotModel)
        .where(RealtimeSnapshotModel.session_id == session_id)
        .order_by(RealtimeSnapshotModel.created_at.desc())
        .limit(120)
    ).all()
    return RealtimeTimelineResponse(
        session_id=session_id,
        nodes=[_timeline_node_from_snapshot(item) for item in snapshots],
    )


@router.post("/{session_id}/rollback/preview", response_model=RealtimeRollbackPreviewResponse)
def rollback_preview(
    session_id: str,
    req: RealtimeRollbackRequest,
    db: Session = Depends(get_db),
) -> RealtimeRollbackPreviewResponse:
    _get_session_or_404(db, session_id)
    snapshot = db.scalar(
        select(RealtimeSnapshotModel).where(
            RealtimeSnapshotModel.session_id == session_id,
            RealtimeSnapshotModel.id == req.snapshot_id,
        )
    )
    if snapshot is None:
        raise HTTPException(status_code=404, detail="timeline snapshot not found")
    checkpoint = _timeline_checkpoint(snapshot)
    chunks = checkpoint.get("chunks")
    annotations = checkpoint.get("annotations")
    turns = _timeline_preview_turns(snapshot, session_id=session_id, chunks=chunks if isinstance(chunks, list) else None)
    transcript_turn_count = len(chunks) if isinstance(chunks, list) and chunks else len(turns)
    annotation_version = int(annotations.get("version") or 1) if isinstance(annotations, dict) else 1
    return RealtimeRollbackPreviewResponse(
        session_id=session_id,
        snapshot_id=snapshot.id,
        created_at=snapshot.created_at,
        summary=snapshot.summary_json if isinstance(snapshot.summary_json, dict) else {},
        pipeline=snapshot.pipeline_payload if isinstance(snapshot.pipeline_payload, dict) else {},
        evaluation=snapshot.evaluation_payload if isinstance(snapshot.evaluation_payload, dict) else {},
        transcript_turn_count=transcript_turn_count,
        annotation_version=max(1, annotation_version),
        turns=turns,
    )


@router.post("/{session_id}/rollback/apply", response_model=RealtimeRollbackApplyResponse)
def rollback_apply(
    session_id: str,
    req: RealtimeRollbackRequest,
    db: Session = Depends(get_db),
) -> RealtimeRollbackApplyResponse:
    obj = _get_session_or_404(db, session_id)
    if obj.status == "closed":
        raise HTTPException(status_code=409, detail="closed session cannot rollback")
    snapshot = db.scalar(
        select(RealtimeSnapshotModel).where(
            RealtimeSnapshotModel.session_id == session_id,
            RealtimeSnapshotModel.id == req.snapshot_id,
        )
    )
    if snapshot is None:
        raise HTTPException(status_code=404, detail="timeline snapshot not found")

    pipeline = snapshot.pipeline_payload if isinstance(snapshot.pipeline_payload, dict) else {}
    evaluation = snapshot.evaluation_payload if isinstance(snapshot.evaluation_payload, dict) else {}
    summary = snapshot.summary_json if isinstance(snapshot.summary_json, dict) else {}
    checkpoint = _timeline_checkpoint(snapshot)

    obj.pipeline_payload = pipeline
    obj.evaluation_payload = evaluation
    obj.summary_json = summary
    obj.updated_at = utc_now()
    db.add(obj)

    chunks = checkpoint.get("chunks")
    if isinstance(chunks, list):
        db.execute(delete(RealtimeChunk).where(RealtimeChunk.session_id == session_id))
        for index, item in enumerate(chunks):
            if not isinstance(item, dict):
                continue
            db.add(
                RealtimeChunk(
                    session_id=session_id,
                    sequence_no=int(item.get("sequence_no", index)),
                    timestamp_ms=int(item.get("timestamp_ms", 0)),
                    speaker=str(item.get("speaker", "speaker")),
                    text=str(item.get("text", "")),
                    is_final=bool(item.get("is_final", True)),
                    expected_intent=item.get("expected_intent"),
                    meta_json=item.get("metadata", {}) if isinstance(item.get("metadata"), dict) else {},
                )
            )

    events = pipeline.get("events")
    if isinstance(events, list):
        replace_events(db, session_id, events)
    else:
        db.execute(delete(RealtimeEvent).where(RealtimeEvent.session_id == session_id))

    annotations = checkpoint.get("annotations")
    if isinstance(annotations, dict):
        row = db.scalar(select(RealtimeSessionAnnotations).where(RealtimeSessionAnnotations.session_id == session_id))
        next_version = max(1, int(annotations.get("version") or 1))
        next_payload = annotations.get("payload", {})
        normalized_payload = next_payload if isinstance(next_payload, dict) else {}
        if row is None:
            row = RealtimeSessionAnnotations(
                session_id=session_id,
                version=next_version,
                payload_json=normalized_payload,
                created_at=utc_now(),
                updated_at=utc_now(),
            )
            db.add(row)
        else:
            row.version = next_version
            row.payload_json = normalized_payload
            row.updated_at = utc_now()
            db.add(row)

    drop_runtime(session_id)
    runtime = restore_runtime_if_needed(db, obj)
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    db.commit()
    return RealtimeRollbackApplyResponse(
        session_id=session_id,
        restored_from_snapshot_id=snapshot.id,
        pipeline=pipeline,
        evaluation=evaluation,
    )


@router.post("/{session_id}/rollback/edit_apply", response_model=RealtimeRollbackEditApplyResponse)
def rollback_edit_apply(
    session_id: str,
    req: RealtimeRollbackEditRequest,
    db: Session = Depends(get_db),
) -> RealtimeRollbackEditApplyResponse:
    obj = _get_session_or_404(db, session_id)
    if obj.status == "closed":
        raise HTTPException(status_code=409, detail="closed session cannot rollback")
    snapshot = db.scalar(
        select(RealtimeSnapshotModel).where(
            RealtimeSnapshotModel.session_id == session_id,
            RealtimeSnapshotModel.id == req.snapshot_id,
        )
    )
    if snapshot is None:
        raise HTTPException(status_code=404, detail="timeline snapshot not found")

    # Overwrite-future semantics: drop snapshots created after the selected node.
    db.execute(
        delete(RealtimeSnapshotModel).where(
            RealtimeSnapshotModel.session_id == session_id,
            RealtimeSnapshotModel.created_at > snapshot.created_at,
        )
    )

    pipeline = snapshot.pipeline_payload if isinstance(snapshot.pipeline_payload, dict) else {}
    evaluation = snapshot.evaluation_payload if isinstance(snapshot.evaluation_payload, dict) else {}
    summary = snapshot.summary_json if isinstance(snapshot.summary_json, dict) else {}
    graph_state = pipeline.get("graph_state", {}) if isinstance(pipeline.get("graph_state"), dict) else {}
    recompute_seed_pipeline = {
        **pipeline,
        "events": [],
        "graph_state": {
            **graph_state,
            # Force edited turns to be pending so coordination/planner runs again.
            "last_consumed_turn_id": 0,
            "pending_turn_ids": [],
        },
    }

    obj.pipeline_payload = recompute_seed_pipeline
    obj.evaluation_payload = evaluation
    obj.summary_json = summary
    obj.updated_at = utc_now()
    db.add(obj)

    # Replace chunks with manual transcript turns to prevent server-side merging.
    db.execute(delete(RealtimeChunk).where(RealtimeChunk.session_id == session_id))
    base_ts = 0
    for index, turn in enumerate(req.turns):
        speaker = str(turn.speaker or "speaker")
        text = str(turn.text or "").strip()
        if not text:
            continue
        start_ms = turn.start_ms if turn.start_ms is not None else base_ts + index * 450
        is_final = True if turn.is_final is None else bool(turn.is_final)
        db.add(
            RealtimeChunk(
                session_id=session_id,
                sequence_no=index,
                timestamp_ms=int(start_ms),
                speaker=speaker,
                text=text,
                is_final=is_final,
                expected_intent=None,
                meta_json={"input_source": "transcript", "capture_mode": "manual_text"},
            )
        )
    db.flush()

    # Reset runtime + recompute from the restored graph state + edited turns.
    db.execute(delete(RealtimeEvent).where(RealtimeEvent.session_id == session_id))
    drop_runtime(session_id)
    runtime = restore_runtime_if_needed(db, obj)
    # Ensure edited turns are treated as pending input for forced recompute.
    runtime.last_consumed_turn_id = 0
    runtime.pending_turn_ids = [turn.turn_id for turn in runtime.turns]
    runtime.flush(db, obj)
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    if _has_mermaid_render_issue(pipeline):
        # Retry once to reduce occasional unstable render/model failures.
        drop_runtime(session_id)
        runtime = restore_runtime_if_needed(db, obj)
        runtime.last_consumed_turn_id = 0
        runtime.pending_turn_ids = [turn.turn_id for turn in runtime.turns]
        runtime.flush(db, obj)
        pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    if _has_mermaid_render_issue(pipeline):
        raise HTTPException(status_code=409, detail="rollback recompute produced unstable mermaid output; kept previous state")
    db.commit()
    return RealtimeRollbackEditApplyResponse(
        session_id=session_id,
        restored_from_snapshot_id=snapshot.id,
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
    runtime.flush(db, obj)
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    db.commit()
    return RealtimeSnapshot(session_id=session_id, pipeline=pipeline, evaluation=evaluation)


@router.post("/{session_id}/diagram-relayout", response_model=RealtimeSnapshot)
def diagram_relayout(
    session_id: str,
    payload: RealtimeDiagramRelayoutRequest,
    db: Session = Depends(get_db),
) -> RealtimeSnapshot:
    obj = _get_session_or_404(db, session_id)
    runtime = restore_runtime_if_needed(db, obj)
    runtime.relayout_from_drag(db, obj, payload.model_dump())
    pipeline, evaluation = _rebuild_snapshot(db, obj, runtime)
    db.commit()
    return RealtimeSnapshot(session_id=session_id, pipeline=pipeline, evaluation=evaluation)


@router.get("/{session_id}/transcript/download")
def download_transcript(
    session_id: str,
    fmt: str = Query(..., pattern="^(txt|markdown)$"),
    db: Session = Depends(get_db),
) -> Response:
    obj = _get_session_or_404(db, session_id)
    turns = build_transcript_turns(list_session_chunks(db, session_id))
    summary = session_transcript_summary(db, session_id)
    if fmt == "txt":
        content = render_transcript_txt(obj, turns)
        media_type = "text/plain; charset=utf-8"
        filename = f"{session_id}_transcript.txt"
    else:
        content = render_transcript_markdown(obj, turns, summary)
        media_type = "text/markdown; charset=utf-8"
        filename = f"{session_id}_transcript.md"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{session_id}/close", response_model=RealtimeSessionCloseResponse)
def close_session(session_id: str, db: Session = Depends(get_db)) -> RealtimeSessionCloseResponse:
    obj = _get_session_or_404(db, session_id)
    obj.status = "closed"
    obj.closed_at = utc_now()
    obj.updated_at = utc_now()
    db.commit()
    close_rtasr_session_stream(session_id)
    drop_runtime(session_id)
    return RealtimeSessionCloseResponse(
        ok=True,
        session_id=session_id,
        closed=True,
        downloads=build_transcript_download_urls(session_id),
        transcript_summary=session_transcript_summary(db, session_id),
    )


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


@router.post("/{session_id}/graph")
def save_realtime_graph(session_id: str, db: Session = Depends(get_db)) -> dict:
    obj = _get_session_or_404(db, session_id)
    pipeline = obj.pipeline_payload if isinstance(obj.pipeline_payload, dict) else {}
    graph_state = pipeline.get("graph_state", {}) if isinstance(pipeline.get("graph_state"), dict) else {}
    mermaid_state = pipeline.get("mermaid_state", {}) if isinstance(pipeline.get("mermaid_state"), dict) else {}
    current_graph_ir = graph_state.get("current_graph_ir", {}) if isinstance(graph_state.get("current_graph_ir"), dict) else {}
    report = create_report(
        db,
        report_type="realtime_graph",
        title=f"graph_{session_id}",
        summary={
            "diagram_type": str(graph_state.get("diagram_type", "") or ""),
            "node_count": len(current_graph_ir.get("nodes", []) or []),
            "edge_count": len(current_graph_ir.get("edges", []) or []),
            "group_count": len(current_graph_ir.get("groups", []) or []),
        },
        payload={
            "session_id": session_id,
            "title": obj.title,
            "graph_state": graph_state,
            "mermaid_state": mermaid_state,
        },
        related_session_id=session_id,
    )
    db.commit()
    return {"ok": True, "report_id": report.id}
