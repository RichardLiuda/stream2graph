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
    voiceprint: dict[str, Any] | None = None


class RuntimeOptionsResponse(BaseModel):
    gate_profiles: list[RuntimeOptionProfile]
    planner_profiles: list[RuntimeOptionProfile]
    stt_profiles: list[RuntimeOptionProfile]


class RuntimeOptionProfileConfig(BaseModel):
    id: str
    label: str
    provider_kind: str = "openai_compatible"
    endpoint: str
    models: list[str]
    default_model: str = ""
    extra_body_json: str | None = None
    app_id: str | None = None
    api_key_env: str | None = None
    api_key: str | None = None
    api_secret_env: str | None = None
    api_secret: str | None = None
    voiceprint: dict[str, Any] | None = None


class RuntimeOptionsAdminResponse(BaseModel):
    gate_profiles: list[RuntimeOptionProfileConfig]
    planner_profiles: list[RuntimeOptionProfileConfig]
    stt_profiles: list[RuntimeOptionProfileConfig]


class RuntimeOptionsAdminUpdateRequest(BaseModel):
    gate_profiles: list[RuntimeOptionProfileConfig] = Field(default_factory=list)
    planner_profiles: list[RuntimeOptionProfileConfig] = Field(default_factory=list)
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


class RuntimeConnectionTestRequest(BaseModel):
    endpoint: str
    provider_kind: str = "openai_compatible"
    app_id: str | None = None
    api_key: str | None = None
    api_key_env: str | None = None
    api_secret: str | None = None
    api_secret_env: str | None = None
    voiceprint: dict[str, Any] | None = None


class RuntimeConnectionTestResponse(BaseModel):
    ok: bool
    provider_kind: str
    summary: str
    logs: list[str] = Field(default_factory=list)


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


class RealtimeSessionUpdateRequest(BaseModel):
    """更新会话元数据（当前仅支持标题）。"""
    title: str = Field(..., min_length=1, max_length=255)


class RealtimeSessionCreateRequest(BaseModel):
    title: str = "未命名实时会话"
    dataset_version_slug: str | None = None
    min_wait_k: int = 1
    base_wait_k: int = 2
    max_wait_k: int = 4
    diagram_type: str = "flowchart"
    gate_profile_id: str | None = None
    gate_model: str | None = None
    planner_profile_id: str | None = None
    planner_model: str | None = None
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


class RealtimeChunkBatchCreateRequest(BaseModel):
    chunks: list[RealtimeChunkCreateRequest] = Field(default_factory=list)


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


class RealtimeTimelineNode(BaseModel):
    snapshot_id: str
    created_at: datetime
    summary: dict[str, Any] = Field(default_factory=dict)
    event_count: int = 0
    chunk_count: int = 0
    label: str | None = None


class RealtimeTimelineResponse(BaseModel):
    session_id: str
    nodes: list[RealtimeTimelineNode] = Field(default_factory=list)


class RealtimeRollbackRequest(BaseModel):
    snapshot_id: str


class RealtimeRollbackPreviewResponse(BaseModel):
    session_id: str
    snapshot_id: str
    created_at: datetime
    summary: dict[str, Any] = Field(default_factory=dict)
    pipeline: dict[str, Any] = Field(default_factory=dict)
    evaluation: dict[str, Any] | None = None
    transcript_turn_count: int = 0
    annotation_version: int = 1
    turns: list["RealtimeTranscriptTurn"] = Field(default_factory=list)


class RealtimeRollbackApplyResponse(BaseModel):
    session_id: str
    restored_from_snapshot_id: str
    pipeline: dict[str, Any] = Field(default_factory=dict)
    evaluation: dict[str, Any] | None = None


class RealtimeTranscriptTurnEditable(BaseModel):
    speaker: str
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    is_final: bool | None = None


class RealtimeRollbackEditRequest(BaseModel):
    snapshot_id: str
    turns: list[RealtimeTranscriptTurnEditable] = Field(default_factory=list)


class RealtimeRollbackEditApplyResponse(BaseModel):
    session_id: str
    restored_from_snapshot_id: str
    pipeline: dict[str, Any] = Field(default_factory=dict)
    evaluation: dict[str, Any] | None = None


class RealtimeSessionAnnotations(BaseModel):
    session_id: str
    version: int = 1
    payload: dict[str, Any] = Field(default_factory=dict)


class RealtimeSessionAnnotationsUpdateRequest(BaseModel):
    version: int = 1
    payload: dict[str, Any] = Field(default_factory=dict)


class RealtimeTranscriptTurn(BaseModel):
    speaker: str
    text: str
    start_ms: int
    end_ms: int
    is_final: bool = True
    source: str = ""
    capture_mode: str = ""


class RealtimeSessionCloseDownloads(BaseModel):
    txt_url: str
    markdown_url: str


class RealtimeSessionCloseResponse(BaseModel):
    ok: bool
    session_id: str
    closed: bool
    downloads: RealtimeSessionCloseDownloads
    transcript_summary: dict[str, Any]


class RealtimeDiagramPoint(BaseModel):
    x: float
    y: float


class RealtimeDiagramEntityPosition(BaseModel):
    id: str
    label: str
    kind: Literal["node", "group"] = "node"
    x: float
    y: float
    width: float
    height: float


class RealtimeDiagramRelayoutRequest(BaseModel):
    node_id: str
    node_label: str
    from_position: RealtimeDiagramPoint
    to_position: RealtimeDiagramPoint
    delta: RealtimeDiagramPoint
    relation_hint: str | None = None
    nearest_anchor_id: str | None = None
    nearest_anchor_label: str | None = None
    target_group_id: str | None = None
    target_group_label: str | None = None
    node_positions: list[RealtimeDiagramEntityPosition] = Field(default_factory=list)
    group_positions: list[RealtimeDiagramEntityPosition] = Field(default_factory=list)
    spatial_summary: str = ""


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
    speaker: str
    segments: list[dict[str, Any]] | None = None
    voiceprint: dict[str, Any] | None = None
    is_final: bool
    provider: str
    model: str
    latency_ms: float
    pipeline: dict[str, Any]
    evaluation: dict[str, Any] | None = None


class VoiceprintFeatureCreateRequest(BaseModel):
    speaker_label: str
    feature_info: str | None = None
    sample_rate: int
    channel_count: int = 1
    pcm_s16le_base64: str


class VoiceprintFeatureSummary(BaseModel):
    id: str
    stt_profile_id: str
    group_id: str
    feature_id: str
    speaker_label: str
    feature_info: str
    status: str
    remote_payload: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class VoiceprintGroupSyncRequest(BaseModel):
    display_name: str | None = None
    group_info: str | None = None


class VoiceprintGroupSummary(BaseModel):
    id: str
    stt_profile_id: str
    group_id: str
    display_name: str
    provider_kind: str
    status: str
    remote_payload: dict[str, Any]
    last_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class VoiceprintGroupSyncResponse(BaseModel):
    ok: bool
    group: VoiceprintGroupSummary
    remote_features: list[dict[str, Any]] = Field(default_factory=list)


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
