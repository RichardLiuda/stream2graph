from __future__ import annotations

import csv
import json
import logging
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utc_now
from app.models import Report, RealtimeSession, RunJob, StudySession
from app.services.runtime_options import resolve_profile

logger = logging.getLogger(__name__)


def _report_dir(report_type: str) -> Path:
    settings = get_settings()
    path = settings.artifact_root / "reports" / report_type
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_markdown(path: Path, lines: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def create_report(
    db: Session,
    *,
    report_type: str,
    title: str,
    summary: dict[str, Any],
    payload: dict[str, Any],
    related_run_id: str | None = None,
    related_session_id: str | None = None,
    csv_rows: list[dict[str, Any]] | None = None,
) -> Report:
    directory = _report_dir(report_type)
    stamp = utc_now().strftime("%Y%m%d_%H%M%S")
    stem = f"{stamp}_{title.replace(' ', '_')[:40]}"
    json_path = directory / f"{stem}.json"
    md_path = directory / f"{stem}.md"
    csv_path = directory / f"{stem}.csv" if csv_rows is not None else None

    _write_json(json_path, payload)
    _write_markdown(
        md_path,
        [
            f"# {title}",
            "",
            f"- Report Type: {report_type}",
            f"- Created At (UTC): {utc_now().isoformat()}",
            "",
            "## Summary",
            "",
            *[f"- {key}: {value}" for key, value in summary.items()],
        ],
    )
    if csv_rows is not None and csv_path is not None:
        _write_csv(csv_path, csv_rows)

    report = Report(
        report_type=report_type,
        title=title,
        status="ready",
        summary_json=summary,
        payload=payload,
        related_run_id=related_run_id,
        related_session_id=related_session_id,
        json_path=str(json_path),
        markdown_path=str(md_path),
        csv_path=str(csv_path) if csv_path is not None else None,
    )
    db.add(report)
    db.flush()
    return report


def list_reports(db: Session) -> list[Report]:
    return db.scalars(select(Report).order_by(Report.created_at.desc())).all()


def get_report_or_404(db: Session, report_id: str) -> Report:
    report = db.get(Report, report_id)
    if report is None:
        raise ValueError(f"report not found: {report_id}")
    return report


def update_report(db: Session, report: Report, *, title: str | None, notes: str | None) -> Report:
    if title is not None:
        report.title = title.strip() or report.title
    if notes is not None:
        report.notes = notes.strip() or None
    db.flush()
    return report


def export_rows_for_target(db: Session, target: str) -> tuple[str, list[dict[str, Any]]]:
    if target == "runs":
        rows = [
            {
                "run_id": item.id,
                "job_type": item.job_type,
                "title": item.title,
                "status": item.status,
                "dataset_version": item.dataset_version_slug,
                "split": item.split,
                "provider": item.provider_name,
                "model_name": item.model_name,
                "created_at": item.created_at.isoformat(),
                "updated_at": item.updated_at.isoformat(),
            }
            for item in db.scalars(select(RunJob).order_by(RunJob.created_at.desc())).all()
        ]
        return "运行导出", rows
    if target == "studies":
        rows = [
            {
                "session_id": item.id,
                "participant_code": item.participant_code,
                "participant_id": item.participant_id,
                "condition": item.study_condition,
                "status": item.status,
                "compile_success": item.compile_success,
                "created_at": item.created_at.isoformat(),
                "updated_at": item.updated_at.isoformat(),
            }
            for item in db.scalars(select(StudySession).order_by(StudySession.created_at.desc())).all()
        ]
        return "用户研究导出", rows
    if target == "realtime":
        rows = [
            {
                "session_id": item.id,
                "title": item.title,
                "status": item.status,
                "dataset_version": item.dataset_version_slug,
                "created_at": item.created_at.isoformat(),
                "updated_at": item.updated_at.isoformat(),
            }
            for item in db.scalars(select(RealtimeSession).order_by(RealtimeSession.created_at.desc())).all()
        ]
        return "实时会话导出", rows
    raise ValueError(f"unsupported export target: {target}")


def _extract_transcript_text(payload: dict[str, Any]) -> list[str]:
    """Extract all transcript turn texts from a report payload."""
    turns: list[str] = []
    seen: set[str] = set()

    def _walk(node: Any, depth: int) -> None:
        if depth > 7 or len(turns) >= 200:
            return
        if isinstance(node, list):
            for item in node:
                _walk(item, depth + 1)
            return
        if not isinstance(node, dict):
            return
        speaker = ""
        for key in ("speaker", "role", "participant"):
            val = node.get(key)
            if isinstance(val, str) and val.strip():
                speaker = val.strip()
                break
        text = ""
        for key in ("text", "content", "transcript_text"):
            val = node.get(key)
            if isinstance(val, str) and val.strip():
                text = val.strip()
                break
        if text and (speaker or "transcript_text" in node or "speaker" in node):
            cleaned = " ".join(text.split())
            entry = f"{speaker or 'speaker'}: {cleaned}"
            if entry not in seen:
                seen.add(entry)
                turns.append(entry)
        for key, child in node.items():
            if key in ("code", "normalized_code", "mermaid_code"):
                continue
            _walk(child, depth + 1)

    _walk(payload, 0)
    return turns


SUMMARY_SYSTEM_PROMPT = (
    "You are a professional meeting analyst. "
    "Given a list of dialogue turns from a realtime collaborative session, "
    "produce a concise structured summary in the same language as the dialogue. "
    "Cover: (1) main topics discussed, (2) key decisions made, (3) action items or next steps, "
    "(4) risks or open questions. "
    "Keep the summary under 500 words. Use bullet points where appropriate. "
    "Do not include any preamble or explanation — return only the summary text."
)


def summarize_report_transcript(db: Session, report_id: str) -> str:
    """Call the Planner model to summarize all transcript turns in a report."""
    report = get_report_or_404(db, report_id)
    payload = report.payload or {}
    turns = _extract_transcript_text(payload)
    if not turns:
        return ""

    dialogue_text = "\n".join(turns[:200])

    # Resolve planner profile
    planner_profiles = resolve_profile(db, "planner", None)
    if not planner_profiles:
        raise RuntimeError("未配置 Planner profile，无法执行 AI 总结。")

    profile = planner_profiles
    model = str(profile.get("default_model") or "")
    if not model:
        models = profile.get("models") or []
        if models:
            model = models[0]
    if not model:
        raise RuntimeError("Planner profile 未配置模型，无法执行 AI 总结。")

    # Import here to avoid circular imports
    from app.services.realtime_coordination import build_chat_client
    from tools.eval.common import strip_think_traces

    client = build_chat_client(profile, model, timeout_sec=120)
    messages = [
        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"以下是本次实时工作会话的全部对话内容（共 {len(turns)} 条）：\n\n"
                f"{dialogue_text}\n\n"
                "请对以上对话内容进行结构化总结。"
            ),
        },
    ]

    logger.info("Summarizing report %s with %d turns using model %s", report_id, len(turns), model)
    result = client.chat(messages)
    summary = strip_think_traces(result.text or "").strip()

    # Persist summary into the report
    if summary:
        existing_summary = report.summary_json or {}
        existing_summary["ai_summary"] = summary
        report.summary_json = existing_summary
        db.flush()

    return summary
