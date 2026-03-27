from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import DatasetVersion
from app.routers.auth import get_current_admin
from app.schemas import (
    AdminIdentity,
    DatasetSplitSummary,
    DatasetVersionSummary,
    RuntimeOptionProfile,
    RuntimeOptionProfileConfig,
    RuntimeModelProbeRequest,
    RuntimeModelProbeResponse,
    RuntimeOptionsAdminResponse,
    RuntimeOptionsAdminUpdateRequest,
    RuntimeOptionsResponse,
    SampleDetail,
    SampleListItem,
)
from app.services import catalog as catalog_service
from app.services.runtime_options import (
    list_persisted_runtime_options,
    list_runtime_options,
    probe_runtime_models,
    save_runtime_options,
)


router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/runtime-options", response_model=RuntimeOptionsResponse)
def get_runtime_options(db: Session = Depends(get_db)) -> RuntimeOptionsResponse:
    payload = list_runtime_options(db)
    return RuntimeOptionsResponse(
        llm_profiles=[RuntimeOptionProfile(**row) for row in payload["llm_profiles"]],
        stt_profiles=[RuntimeOptionProfile(**row) for row in payload["stt_profiles"]],
    )


@router.get("/runtime-options/admin", response_model=RuntimeOptionsAdminResponse)
def get_runtime_options_admin(
    db: Session = Depends(get_db),
    _admin: AdminIdentity = Depends(get_current_admin),
) -> RuntimeOptionsAdminResponse:
    payload = list_persisted_runtime_options(db, include_secrets=True)
    return RuntimeOptionsAdminResponse(
        llm_profiles=[RuntimeOptionProfileConfig(**row) for row in payload["llm_profiles"]],
        stt_profiles=[RuntimeOptionProfileConfig(**row) for row in payload["stt_profiles"]],
    )


@router.put("/runtime-options/admin", response_model=RuntimeOptionsAdminResponse)
def save_runtime_options_admin(
    payload: RuntimeOptionsAdminUpdateRequest,
    db: Session = Depends(get_db),
    _admin: AdminIdentity = Depends(get_current_admin),
) -> RuntimeOptionsAdminResponse:
    saved = save_runtime_options(db, payload.model_dump())
    db.commit()
    return RuntimeOptionsAdminResponse(
        llm_profiles=[RuntimeOptionProfileConfig(**row) for row in saved["llm_profiles"]],
        stt_profiles=[RuntimeOptionProfileConfig(**row) for row in saved["stt_profiles"]],
    )


@router.post("/runtime-options/admin/probe-models", response_model=RuntimeModelProbeResponse)
def probe_runtime_models_admin(
    payload: RuntimeModelProbeRequest,
    _admin: AdminIdentity = Depends(get_current_admin),
) -> RuntimeModelProbeResponse:
    try:
        result = probe_runtime_models(
            endpoint=payload.endpoint,
            provider_kind=payload.provider_kind,
            api_key=payload.api_key,
            api_key_env=payload.api_key_env,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return RuntimeModelProbeResponse(ok=True, **result)


@router.get("/datasets", response_model=list[DatasetVersionSummary])
def list_datasets(db: Session = Depends(get_db)) -> list[DatasetVersionSummary]:
    catalog_service.sync_dataset_versions(db)
    return [
        DatasetVersionSummary(
            slug=item.slug,
            display_name=item.display_name,
            sample_count=item.sample_count,
            train_count=item.train_count,
            validation_count=item.validation_count,
            test_count=item.test_count,
            is_default=item.is_default,
            dataset_dir=item.dataset_dir,
            split_dir=item.split_dir,
        )
        for item in db.scalars(select(DatasetVersion).order_by(DatasetVersion.slug.asc())).all()
    ]


@router.get("/datasets/{slug}/splits", response_model=list[DatasetSplitSummary])
def list_dataset_splits(slug: str, db: Session = Depends(get_db)) -> list[DatasetSplitSummary]:
    try:
        dataset = catalog_service.get_dataset_version_or_404(db, slug)
        rows = catalog_service.list_split_summary(dataset)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [DatasetSplitSummary(**row) for row in rows]


@router.get("/datasets/{slug}/samples", response_model=list[SampleListItem])
def list_samples(
    slug: str,
    split: str = Query(...),
    search: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[SampleListItem]:
    try:
        dataset = catalog_service.get_dataset_version_or_404(db, slug)
        rows = catalog_service.list_samples(dataset, split, search=search, offset=offset, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [SampleListItem(**row) for row in rows]


@router.get("/datasets/{slug}/samples/{sample_id}", response_model=SampleDetail)
def get_sample_detail(slug: str, sample_id: str, split: str = Query(...), db: Session = Depends(get_db)) -> SampleDetail:
    try:
        dataset = catalog_service.get_dataset_version_or_404(db, slug)
        row = catalog_service.get_sample_detail(dataset, split, sample_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return SampleDetail(**row)
