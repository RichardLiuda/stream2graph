from __future__ import annotations

import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, utc_now


def _id() -> str:
    return uuid.uuid4().hex


class AdminUser(Base):
    __tablename__ = "admin_users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    username: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    setting_key: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    value_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    slug: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(255))
    dataset_dir: Mapped[str] = mapped_column(Text)
    split_dir: Mapped[str] = mapped_column(Text)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    train_count: Mapped[int] = mapped_column(Integer, default=0)
    validation_count: Mapped[int] = mapped_column(Integer, default=0)
    test_count: Mapped[int] = mapped_column(Integer, default=0)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    meta_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class RunJob(Base):
    __tablename__ = "run_jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    job_type: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), index=True)
    dataset_version_slug: Mapped[str | None] = mapped_column(String(255), nullable=True)
    split: Mapped[str | None] = mapped_column(String(32), nullable=True)
    provider_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    config_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    progress_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    artifact_root: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    started_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RunArtifact(Base):
    __tablename__ = "run_artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run_jobs.id", ondelete="CASCADE"), index=True)
    artifact_type: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(255))
    path: Mapped[str] = mapped_column(Text)
    format: Mapped[str] = mapped_column(String(32))
    meta_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class RealtimeSession(Base):
    __tablename__ = "realtime_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), index=True)
    dataset_version_slug: Mapped[str | None] = mapped_column(String(255), nullable=True)
    config_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    pipeline_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    evaluation_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    closed_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RealtimeSessionAnnotations(Base):
    __tablename__ = "realtime_session_annotations"
    __table_args__ = (
        UniqueConstraint("session_id", name="uq_realtime_session_annotations_session_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    session_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("realtime_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class RealtimeChunk(Base):
    __tablename__ = "realtime_chunks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    session_id: Mapped[str] = mapped_column(String(32), ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True)
    sequence_no: Mapped[int] = mapped_column(Integer)
    timestamp_ms: Mapped[int] = mapped_column(Integer)
    speaker: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    is_final: Mapped[bool] = mapped_column(Boolean, default=True)
    expected_intent: Mapped[str | None] = mapped_column(String(64), nullable=True)
    meta_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class RealtimeEvent(Base):
    __tablename__ = "realtime_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    session_id: Mapped[str] = mapped_column(String(32), ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True)
    event_index: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class RealtimeSnapshot(Base):
    __tablename__ = "realtime_snapshots"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    session_id: Mapped[str] = mapped_column(String(32), ForeignKey("realtime_sessions.id", ondelete="CASCADE"), index=True)
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    pipeline_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    evaluation_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class VoiceprintGroup(Base):
    __tablename__ = "voiceprint_groups"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    stt_profile_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    group_id: Mapped[str] = mapped_column(String(64), index=True)
    display_name: Mapped[str] = mapped_column(String(255))
    provider_kind: Mapped[str] = mapped_column(String(64), default="xfyun_isv")
    status: Mapped[str] = mapped_column(String(32), default="active")
    remote_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    last_synced_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class VoiceprintFeature(Base):
    __tablename__ = "voiceprint_features"
    __table_args__ = (
        UniqueConstraint("stt_profile_id", "feature_id", name="uq_voiceprint_features_profile_feature"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    stt_profile_id: Mapped[str] = mapped_column(String(64), index=True)
    group_id: Mapped[str] = mapped_column(String(64), index=True)
    feature_id: Mapped[str] = mapped_column(String(64), index=True)
    speaker_label: Mapped[str] = mapped_column(String(255))
    feature_info: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(32), default="active")
    remote_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class StudyTask(Base):
    __tablename__ = "study_tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    dataset_version_slug: Mapped[str | None] = mapped_column(String(255), nullable=True)
    split: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sample_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    materials_json: Mapped[dict] = mapped_column(JSON, default=dict)
    system_outputs_json: Mapped[dict] = mapped_column(JSON, default=dict)
    default_condition: Mapped[str] = mapped_column(String(32), default="manual")
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class StudySession(Base):
    __tablename__ = "study_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    participant_code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    task_id: Mapped[str] = mapped_column(String(32), ForeignKey("study_tasks.id", ondelete="CASCADE"), index=True)
    participant_id: Mapped[str] = mapped_column(String(255))
    study_condition: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), index=True)
    started_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_active_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    input_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    draft_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    compile_success: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    auto_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class StudyEvent(Base):
    __tablename__ = "study_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    study_session_id: Mapped[str] = mapped_column(String(32), ForeignKey("study_sessions.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class StudySubmission(Base):
    __tablename__ = "study_submissions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    study_session_id: Mapped[str] = mapped_column(String(32), ForeignKey("study_sessions.id", ondelete="CASCADE"), unique=True, index=True)
    final_output: Mapped[str] = mapped_column(Text)
    compile_success: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    auto_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    submitted_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class SurveyResponse(Base):
    __tablename__ = "survey_responses"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    study_session_id: Mapped[str] = mapped_column(String(32), ForeignKey("study_sessions.id", ondelete="CASCADE"), unique=True, index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    submitted_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    report_type: Mapped[str] = mapped_column(String(64), index=True)
    related_run_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("run_jobs.id", ondelete="SET NULL"), nullable=True)
    related_session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), index=True)
    summary_json: Mapped[dict] = mapped_column(JSON, default=dict)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    json_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    csv_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    markdown_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
