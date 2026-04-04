from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import RealtimeChunk, RealtimeSession


RECENT_TURN_LIMIT = 10
STT_MERGE_GAP_MS = 2_000
SENTENCE_ENDINGS = tuple("。！？.!?;；")


def list_session_chunks(db: Session, session_id: str) -> list[RealtimeChunk]:
    return db.scalars(
        select(RealtimeChunk).where(RealtimeChunk.session_id == session_id).order_by(RealtimeChunk.sequence_no.asc())
    ).all()


def _chunk_metadata(row: RealtimeChunk) -> dict[str, Any]:
    return row.meta_json if isinstance(row.meta_json, dict) else {}


def _normalize_source(row: RealtimeChunk) -> tuple[str, str]:
    metadata = _chunk_metadata(row)
    source = str(metadata.get("input_source", "") or "").strip()
    capture_mode = str(metadata.get("capture_mode", "") or "").strip()
    return source, capture_mode


def _join_turn_text(left: str, right: str) -> str:
    left_value = (left or "").strip()
    right_value = (right or "").strip()
    if not left_value:
        return right_value
    if not right_value:
        return left_value
    if left_value[-1].isascii() and left_value[-1].isalnum() and right_value[0].isascii() and right_value[0].isalnum():
        return f"{left_value} {right_value}"
    return f"{left_value}{right_value}"


def _is_manual_transcript_turn(source: str, capture_mode: str) -> bool:
    return source == "transcript" and capture_mode == "manual_text"


def _has_clear_turn_boundary(text: str, gap_ms: int) -> bool:
    value = (text or "").strip()
    if gap_ms > 1_200:
        return True
    return bool(value) and value.endswith(SENTENCE_ENDINGS)


def _can_merge_turn(
    current: dict[str, Any],
    row: RealtimeChunk,
    *,
    source: str,
    capture_mode: str,
) -> bool:
    if current.get("speaker") != row.speaker:
        return False
    if current.get("source") != source or current.get("capture_mode") != capture_mode:
        return False
    gap_ms = max(0, int(row.timestamp_ms) - int(current.get("end_ms", row.timestamp_ms)))
    if gap_ms > STT_MERGE_GAP_MS:
        return False
    if _is_manual_transcript_turn(source, capture_mode):
        return False
    if bool(current.get("is_final")) and bool(row.is_final) and _has_clear_turn_boundary(str(current.get("text", "")), gap_ms):
        return False
    return True


def build_transcript_turns(rows: list[RealtimeChunk]) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for row in rows:
        text = str(row.text or "").strip()
        if not text:
            continue
        source, capture_mode = _normalize_source(row)
        if current is not None and _can_merge_turn(current, row, source=source, capture_mode=capture_mode):
            current["text"] = _join_turn_text(str(current.get("text", "")), text)
            current["end_ms"] = int(row.timestamp_ms)
            current["is_final"] = bool(row.is_final)
            current["chunk_count"] = int(current.get("chunk_count", 1)) + 1
            continue

        current = {
            "speaker": str(row.speaker or "speaker"),
            "text": text,
            "start_ms": int(row.timestamp_ms),
            "end_ms": int(row.timestamp_ms),
            "is_final": bool(row.is_final),
            "source": source,
            "capture_mode": capture_mode,
            "chunk_count": 1,
        }
        turns.append(current)
    return turns


def build_transcript_state(rows: list[RealtimeChunk]) -> dict[str, Any]:
    turns = build_transcript_turns(rows)
    latest_final_turn = None
    for turn in reversed(turns):
        if bool(turn.get("is_final")):
            latest_final_turn = dict(turn)
            break

    current_turn = dict(turns[-1]) if turns else None
    archived_recent_turns = [dict(turn) for turn in reversed(turns[:-1][-RECENT_TURN_LIMIT:])] if len(turns) > 1 else []
    recent_turns = [dict(turn) for turn in reversed(turns[-RECENT_TURN_LIMIT:])]
    speakers = {str(turn.get("speaker", "")).strip() for turn in turns if str(turn.get("speaker", "")).strip()}
    return {
        "latest_final_turn": latest_final_turn,
        "current_turn": current_turn,
        "archived_recent_turns": archived_recent_turns,
        "recent_turns": recent_turns,
        "turn_count": len(turns),
        "speaker_count": len(speakers),
        "chunk_count": len(rows),
    }


def attach_transcript_state(db: Session, session_id: str, pipeline: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(pipeline or {})
    rows = list_session_chunks(db, session_id)
    payload["transcript_state"] = build_transcript_state(rows)
    return payload


def session_transcript_summary(db: Session, session_id: str) -> dict[str, Any]:
    rows = list_session_chunks(db, session_id)
    state = build_transcript_state(rows)
    return {
        "turn_count": state["turn_count"],
        "speaker_count": state["speaker_count"],
        "chunk_count": state["chunk_count"],
    }


def build_transcript_download_urls(session_id: str) -> dict[str, str]:
    return {
        "txt_url": f"/api/v1/realtime/sessions/{session_id}/transcript/download?fmt=txt",
        "markdown_url": f"/api/v1/realtime/sessions/{session_id}/transcript/download?fmt=markdown",
    }


def _format_relative_timestamp(ms: int) -> str:
    total_ms = max(0, int(ms))
    minutes, remainder = divmod(total_ms, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{minutes:02d}:{seconds:02d}.{millis:03d}"


def render_transcript_txt(session_obj: RealtimeSession, turns: list[dict[str, Any]]) -> str:
    lines = []
    for turn in turns:
        speaker = str(turn.get("speaker", "speaker") or "speaker")
        text = str(turn.get("text", "")).strip()
        if not text:
            continue
        start_ms = _format_relative_timestamp(int(turn.get("start_ms", 0) or 0))
        end_ms = _format_relative_timestamp(int(turn.get("end_ms", 0) or 0))
        lines.append(f"[{start_ms} - {end_ms}] {speaker}: {text}")
    if not lines:
        lines.append(f"[00:00.000 - 00:00.000] system: {session_obj.title} 当前还没有可下载的转写内容。")
    return "\n".join(lines) + "\n"


def render_transcript_markdown(session_obj: RealtimeSession, turns: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    created_at = session_obj.created_at.isoformat() if isinstance(session_obj.created_at, datetime) else str(session_obj.created_at)
    closed_at = session_obj.closed_at.isoformat() if isinstance(session_obj.closed_at, datetime) else "active"
    lines = [
        f"# {session_obj.title}",
        "",
        f"- Session ID: {session_obj.id}",
        f"- Status: {session_obj.status}",
        f"- Created At: {created_at}",
        f"- Closed At: {closed_at}",
        f"- Turn Count: {summary.get('turn_count', 0)}",
        f"- Speaker Count: {summary.get('speaker_count', 0)}",
        f"- Chunk Count: {summary.get('chunk_count', 0)}",
        "",
        "## Transcript",
        "",
    ]
    if not turns:
        lines.append("- 当前还没有可下载的转写内容。")
    else:
        for turn in turns:
            speaker = str(turn.get("speaker", "speaker") or "speaker")
            text = str(turn.get("text", "")).strip()
            if not text:
                continue
            start_ms = _format_relative_timestamp(int(turn.get("start_ms", 0) or 0))
            end_ms = _format_relative_timestamp(int(turn.get("end_ms", 0) or 0))
            lines.extend(
                [
                    f"### [{start_ms} - {end_ms}] {speaker}",
                    "",
                    text,
                    "",
                ]
            )
    return "\n".join(lines).rstrip() + "\n"
