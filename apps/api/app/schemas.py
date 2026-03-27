from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
StudyCondition = Literal["manual", "heuristic", "model_system"]


class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminIdentity(BaseModel):
    username: str
    display_name: str


class DatasetVersionSummary(BaseModel):
    slug: str
    display_name: str
    sample_count: int
    train_count: int
    validation_count: int
    test_count: int
    is_default: bool
    dataset_dir: str
    split_dir: str


class DatasetSplitSummary(BaseModel):
    split: str
    count: int
    example_ids: list[str]


class RuntimeOptionProfile(BaseModel):
    id: str
    label: str
    provider_kind: str
    models: list[str]
    default_model: str


class RuntimeOptionsResponse(BaseModel):
    llm_profiles: list[RuntimeOptionProfile]
    stt_profiles: list[RuntimeOptionProfile]


class RuntimeOptionProfileConfig(BaseModel):
    id: str
    label: str
    provider_kind: str = "openai_compatible"
    endpoint: str
    models: list[str]
    default_model: str = ""
    api_key_env: str | None = None
    api_key: str | None = None


class RuntimeOptionsAdminResponse(BaseModel):
    llm_profiles: list[RuntimeOptionProfileConfig]
    stt_profiles: list[RuntimeOptionProfileConfig]


class RuntimeOptionsAdminUpdateRequest(BaseModel):
    llm_profiles: list[RuntimeOptionProfileConfig] = Field(default_factory=list)
    stt_profiles: list[RuntimeOptionProfileConfig] = Field(default_factory=list)


class RuntimeModelProbeRequest(BaseModel):
    endpoint: str
    provider_kind: str = "openai_compatible"
    api_key: str | None = None
    api_key_env: str | None = None


class RuntimeModelProbeResponse(BaseModel):
    ok: bool
    provider_kind: str
    models_endpoint: str
    models: list[str]


class SampleListItem(BaseModel):
    sample_id: str
    diagram_type: str
    dialogue_turns: int
    compilation_status: str | None = None
    release_version: str | None = None
    license_name: str | None = None


class SampleDetail(BaseModel):
    dataset_version: str
    split: str
    sample_id: str
    diagram_type: str
    code: str
    dialogue: list[dict[str, Any]]
    metadata: dict[str, Any]


class RealtimeSessionCreateRequest(BaseModel):
    title: str = "未命名实时会话"
    dataset_version_slug: str | None = None
    min_wait_k: int = 1
    base_wait_k: int = 2
    max_wait_k: int = 4
    llm_profile_id: str | None = None
    llm_model: str | None = None
    stt_profile_id: str | None = None
    stt_model: str | None = None
    diagram_mode: str = "mermaid_primary"
    client_context: dict[str, Any] = Field(default_factory=dict)


class RealtimeChunkCreateRequest(BaseModel):
    timestamp_ms: int | None = None
    text: str
    speaker: str = "user"
    is_final: bool = True
    expected_intent: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RealtimeChunkEvent(BaseModel):
    update: dict[str, Any]
    render_frame: dict[str, Any]
    gold_intent: str | None = None
    intent_correct: bool | None = None
    render_latency_ms: int
    e2e_latency_ms: float


class RealtimeSession(BaseModel):
    session_id: str
    title: str
    status: str
    dataset_version_slug: str | None = None
    created_at: datetime
    updated_at: datetime
    summary: dict[str, Any]


class RealtimeSnapshot(BaseModel):
    session_id: str
    pipeline: dict[str, Any]
    evaluation: dict[str, Any] | None = None


class RealtimeAudioTranscriptionRequest(BaseModel):
    chunk_id: int = 0
    sample_rate: int
    channel_count: int = 1
    pcm_s16le_base64: str
    timestamp_ms: int | None = None
    is_final: bool = True
    speaker: str = "speaker"
    metadata: dict[str, Any] = Field(default_factory=dict)


class RealtimeAudioTranscriptionResponse(BaseModel):
    ok: bool
    text: str
    is_final: bool
    provider: str
    model: str
    latency_ms: float
    pipeline: dict[str, Any]
    evaluation: dict[str, Any] | None = None


class RunConfigSnapshot(BaseModel):
    provider: str
    model: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)


class CreateSampleCompareRunRequest(BaseModel):
    title: str = "样本对比运行"
    dataset_version_slug: str
    split: str
    sample_id: str
    predictors: list[RunConfigSnapshot]


class CreateBenchmarkRunRequest(BaseModel):
    title: str = "评测套件运行"
    dataset_version_slug: str
    split: str
    config_json: dict[str, Any]


class RunArtifactSummary(BaseModel):
    id: str
    artifact_type: str
    label: str
    path: str
    format: str
    meta: dict[str, Any]


class RunJob(BaseModel):
    run_id: str
    job_type: str
    title: str
    status: RunStatus
    dataset_version_slug: str | None = None
    split: str | None = None
    provider_name: str | None = None
    model_name: str | None = None
    config_snapshot: dict[str, Any]
    progress: dict[str, Any]
    result_payload: dict[str, Any]
    error_message: str | None = None
    artifact_root: str | None = None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None


class StudyTaskCreateRequest(BaseModel):
    title: str
    description: str
    dataset_version_slug: str | None = None
    split: str | None = None
    sample_id: str | None = None
    default_condition: StudyCondition = "manual"
    system_outputs: dict[str, str] = Field(default_factory=dict)


class StudyTask(BaseModel):
    task_id: str
    title: str
    description: str
    dataset_version_slug: str | None = None
    split: str | None = None
    sample_id: str | None = None
    default_condition: StudyCondition
    materials: dict[str, Any]
    system_outputs: dict[str, Any]
    created_at: datetime


class StudySessionCreateRequest(BaseModel):
    participant_id: str
    study_condition: StudyCondition
    participant_code: str | None = None


class StudySession(BaseModel):
    session_id: str
    participant_code: str
    participant_id: str
    task_id: str
    study_condition: StudyCondition
    status: str
    task_title: str
    task_description: str
    materials: dict[str, Any]
    system_output: str | None = None
    draft_output: str | None = None
    final_output: str | None = None
    compile_success: bool | None = None
    auto_metrics: dict[str, Any]
    started_at: datetime | None = None
    last_active_at: datetime | None = None
    ended_at: datetime | None = None


class StudyEventCreateRequest(BaseModel):
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class StudyDraftUpdateRequest(BaseModel):
    draft_output: str
    input_transcript: str | None = None


class StudySubmissionRequest(BaseModel):
    final_output: str
    input_transcript: str | None = None


class SurveyResponseRequest(BaseModel):
    payload: dict[str, Any]


class SurveyResponse(BaseModel):
    study_session_id: str
    payload: dict[str, Any]
    submitted_at: datetime


class ReportSummary(BaseModel):
    report_id: str
    report_type: str
    title: str
    status: str
    summary: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class ReportDetail(BaseModel):
    report_id: str
    report_type: str
    title: str
    status: str
    summary: dict[str, Any]
    payload: dict[str, Any]
    json_path: str | None = None
    csv_path: str | None = None
    markdown_path: str | None = None
    created_at: datetime
    updated_at: datetime
