from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, utc_now
from app.legacy import evaluate_payload
from app.models import RealtimeChunk, RealtimeSession
from app.schemas import (
    RealtimeAudioTranscriptionRequest,
    RealtimeAudioTranscriptionResponse,
    RealtimeChunkBatchCreateRequest,
    RealtimeChunkCreateRequest,
    RealtimeDiagramRelayoutRequest,
    RealtimeSessionCloseResponse,
    RealtimeSession as RealtimeSessionSchema,
    RealtimeSessionCreateRequest,
    RealtimeSessionUpdateRequest,
    RealtimeSnapshot,
)
from app.services.realtime_ai import transcribe_audio_chunk
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
