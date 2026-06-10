from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utc_now
from app.models import Report, RealtimeSession, RunJob, StudySession


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
