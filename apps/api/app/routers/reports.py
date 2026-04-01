from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import ReportDetail, ReportSummary
from app.services.reports import create_report, export_rows_for_target, get_report_or_404, list_reports


router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("", response_model=list[ReportSummary])
def get_reports(db: Session = Depends(get_db)) -> list[ReportSummary]:
    return [
        ReportSummary(
            report_id=item.id,
            report_type=item.report_type,
            title=item.title,
            status=item.status,
            summary=item.summary_json,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )
        for item in list_reports(db)
    ]


@router.get("/{report_id}", response_model=ReportDetail)
def get_report(report_id: str, db: Session = Depends(get_db)) -> ReportDetail:
    try:
        item = get_report_or_404(db, report_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return ReportDetail(
        report_id=item.id,
        report_type=item.report_type,
        title=item.title,
        status=item.status,
        summary=item.summary_json,
        payload=item.payload,
        json_path=item.json_path,
        csv_path=item.csv_path,
        markdown_path=item.markdown_path,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


@router.get("/exports/download")
def export_reports(
    target: str = Query(..., pattern="^(runs|studies|realtime)$"),
    fmt: str = Query(..., pattern="^(json|csv|markdown)$"),
    db: Session = Depends(get_db),
) -> FileResponse:
    title, rows = export_rows_for_target(db, target)
    report = create_report(
        db,
        report_type=f"export_{target}",
        title=title,
        summary={"row_count": len(rows), "format": fmt},
        payload={"rows": rows},
        csv_rows=rows,
    )
    db.commit()

    if fmt == "json":
        path = Path(report.json_path or "")
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    elif fmt == "markdown":
        path = Path(report.markdown_path or "")
    else:
        path = Path(report.csv_path or "")
    if not path.exists():
        raise HTTPException(status_code=500, detail="export artifact missing")
    return FileResponse(path)
