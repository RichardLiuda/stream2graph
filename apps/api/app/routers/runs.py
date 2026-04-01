from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import CreateBenchmarkRunRequest, CreateSampleCompareRunRequest, RunArtifactSummary, RunJob
from app.services.runs import create_benchmark_job, create_sample_compare_job, get_run_or_404, list_run_artifacts, list_runs


router = APIRouter(prefix="/runs", tags=["runs"])


def _serialize_job(job) -> RunJob:
    return RunJob(
        run_id=job.id,
        job_type=job.job_type,
        title=job.title,
        status=job.status,
        dataset_version_slug=job.dataset_version_slug,
        split=job.split,
        provider_name=job.provider_name,
        model_name=job.model_name,
        config_snapshot=job.config_snapshot,
        progress=job.progress_json,
        result_payload=job.result_payload,
        error_message=job.error_message,
        artifact_root=job.artifact_root,
        created_at=job.created_at,
        updated_at=job.updated_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


@router.get("", response_model=list[RunJob])
def get_runs(db: Session = Depends(get_db)) -> list[RunJob]:
    return [_serialize_job(item) for item in list_runs(db)]


@router.post("/sample-compare", response_model=RunJob)
def enqueue_sample_compare(payload: CreateSampleCompareRunRequest, db: Session = Depends(get_db)) -> RunJob:
    job = create_sample_compare_job(
        db,
        title=payload.title,
        dataset_version_slug=payload.dataset_version_slug,
        split=payload.split,
        sample_id=payload.sample_id,
        predictors=[item.model_dump() for item in payload.predictors],
    )
    db.commit()
    return _serialize_job(job)


@router.post("/benchmark-suite", response_model=RunJob)
def enqueue_benchmark_suite(payload: CreateBenchmarkRunRequest, db: Session = Depends(get_db)) -> RunJob:
    job = create_benchmark_job(
        db,
        title=payload.title,
        dataset_version_slug=payload.dataset_version_slug,
        split=payload.split,
        config_json=payload.config_json,
    )
    db.commit()
    return _serialize_job(job)


@router.get("/{run_id}", response_model=RunJob)
def get_run(run_id: str, db: Session = Depends(get_db)) -> RunJob:
    try:
        return _serialize_job(get_run_or_404(db, run_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}/artifacts", response_model=list[RunArtifactSummary])
def get_artifacts(run_id: str, db: Session = Depends(get_db)) -> list[RunArtifactSummary]:
    return [
        RunArtifactSummary(
            id=item.id,
            artifact_type=item.artifact_type,
            label=item.label,
            path=item.path,
            format=item.format,
            meta=item.meta_json,
        )
        for item in list_run_artifacts(db, run_id)
    ]


@router.get("/{run_id}/artifacts/download")
def download_artifact(path: str = Query(...)) -> FileResponse:
    artifact_path = Path(path)
    if not artifact_path.exists():
        raise HTTPException(status_code=404, detail="artifact not found")
    return FileResponse(artifact_path)


@router.get("/stream/events")
async def stream_run_updates(run_id: str, db: Session = Depends(get_db)) -> StreamingResponse:
    async def event_gen():
        last_payload = None
        while True:
            fresh = get_run_or_404(db, run_id)
            payload = json.dumps(_serialize_job(fresh).model_dump(mode="json"), ensure_ascii=False)
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            if fresh.status in {"succeeded", "failed", "cancelled"}:
                break
            await asyncio.sleep(1.0)

    return StreamingResponse(event_gen(), media_type="text/event-stream")
