from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import (
    VoiceprintFeatureCreateRequest,
    VoiceprintFeatureSummary,
    VoiceprintGroupSummary,
    VoiceprintGroupSyncRequest,
    VoiceprintGroupSyncResponse,
)
from app.services.runtime_options import resolve_profile
from app.services.voiceprints import (
    create_voiceprint_feature,
    delete_voiceprint_feature,
    list_voiceprint_features,
    sync_group_and_features,
)


router = APIRouter(prefix="/voiceprints", tags=["voiceprints"])


def _resolve_stt_profile(db: Session, stt_profile_id: str) -> dict:
    profile = resolve_profile(db, "stt", stt_profile_id)
    if profile is None or str(profile.get("id", "")) != stt_profile_id:
        raise HTTPException(status_code=404, detail="stt profile not found")
    return profile


def _feature_summary(row) -> VoiceprintFeatureSummary:
    return VoiceprintFeatureSummary(
        id=row.id,
        stt_profile_id=row.stt_profile_id,
        group_id=row.group_id,
        feature_id=row.feature_id,
        speaker_label=row.speaker_label,
        feature_info=row.feature_info,
        status=row.status,
        remote_payload=row.remote_payload or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _group_summary(row) -> VoiceprintGroupSummary:
    return VoiceprintGroupSummary(
        id=row.id,
        stt_profile_id=row.stt_profile_id,
        group_id=row.group_id,
        display_name=row.display_name,
        provider_kind=row.provider_kind,
        status=row.status,
        remote_payload=row.remote_payload or {},
        last_synced_at=row.last_synced_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/stt-profiles/{stt_profile_id}/features", response_model=list[VoiceprintFeatureSummary])
def get_voiceprint_features(
    stt_profile_id: str,
    db: Session = Depends(get_db),
) -> list[VoiceprintFeatureSummary]:
    _resolve_stt_profile(db, stt_profile_id)
    return [_feature_summary(row) for row in list_voiceprint_features(db, stt_profile_id=stt_profile_id)]


@router.post("/stt-profiles/{stt_profile_id}/features", response_model=VoiceprintFeatureSummary)
def create_feature(
    stt_profile_id: str,
    payload: VoiceprintFeatureCreateRequest,
    db: Session = Depends(get_db),
) -> VoiceprintFeatureSummary:
    profile = _resolve_stt_profile(db, stt_profile_id)
    try:
        row = create_voiceprint_feature(
            db,
            stt_profile_id=stt_profile_id,
            profile=profile,
            speaker_label=payload.speaker_label.strip(),
            feature_info=(payload.feature_info or payload.speaker_label).strip(),
            pcm_s16le_base64=payload.pcm_s16le_base64,
            sample_rate=payload.sample_rate,
            channel_count=payload.channel_count,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    db.commit()
    return _feature_summary(row)


@router.delete("/stt-profiles/{stt_profile_id}/features/{feature_id}")
def remove_feature(
    stt_profile_id: str,
    feature_id: str,
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    profile = _resolve_stt_profile(db, stt_profile_id)
    try:
        row = delete_voiceprint_feature(
            db,
            stt_profile_id=stt_profile_id,
            profile=profile,
            feature_id=feature_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="voiceprint feature not found")
    db.commit()
    return {"ok": True}


@router.post("/stt-profiles/{stt_profile_id}/group/sync", response_model=VoiceprintGroupSyncResponse)
def sync_group(
    stt_profile_id: str,
    payload: VoiceprintGroupSyncRequest,
    db: Session = Depends(get_db),
) -> VoiceprintGroupSyncResponse:
    profile = _resolve_stt_profile(db, stt_profile_id)
    try:
        group, remote_features = sync_group_and_features(
            db,
            stt_profile_id=stt_profile_id,
            profile=profile,
            display_name=payload.display_name,
            group_info=payload.group_info,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    db.commit()
    return VoiceprintGroupSyncResponse(
        ok=True,
        group=_group_summary(group),
        remote_features=remote_features,
    )
