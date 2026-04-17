import { z } from "zod";

export const datasetVersionSummarySchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  sample_count: z.number(),
  train_count: z.number(),
  validation_count: z.number(),
  test_count: z.number(),
  is_default: z.boolean(),
  dataset_dir: z.string(),
  split_dir: z.string(),
});

export const datasetSplitSummarySchema = z.object({
  split: z.string(),
  count: z.number(),
  example_ids: z.array(z.string()),
});

export const runtimeOptionProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider_kind: z.string(),
  models: z.array(z.string()),
  default_model: z.string(),
  voiceprint: z.record(z.any()).nullable().optional(),
});

export const runtimeOptionsSchema = z.object({
  gate_profiles: z.array(runtimeOptionProfileSchema),
  planner_profiles: z.array(runtimeOptionProfileSchema),
  stt_profiles: z.array(runtimeOptionProfileSchema),
});

export const sampleListItemSchema = z.object({
  sample_id: z.string(),
  diagram_type: z.string(),
  dialogue_turns: z.number(),
  compilation_status: z.string().nullable().optional(),
  release_version: z.string().nullable().optional(),
  license_name: z.string().nullable().optional(),
});

export const sampleDetailSchema = z.object({
  dataset_version: z.string(),
  split: z.string(),
  sample_id: z.string(),
  diagram_type: z.string(),
  code: z.string(),
  dialogue: z.array(z.record(z.any())),
  metadata: z.record(z.any()),
});

export const realtimeSessionSchema = z.object({
  session_id: z.string(),
  title: z.string(),
  status: z.string(),
  dataset_version_slug: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  summary: z.record(z.any()),
});

export const realtimeSnapshotSchema = z.object({
  session_id: z.string(),
  pipeline: z.record(z.any()),
  evaluation: z.record(z.any()).nullable().optional(),
});

// Realtime session annotations (canvas/world coordinates)
export const annotationPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const annotationPenPathSchema = z.object({
  kind: z.literal("pen"),
  id: z.string(),
  points: z.array(annotationPointSchema),
  color: z.string().optional().default("#e5e7eb"),
  width: z.number().optional().default(2),
  opacity: z.number().optional().default(1),
});

export const annotationRectSchema = z.object({
  kind: z.literal("rect"),
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  mode: z.enum(["highlight", "outline"]).optional().default("outline"),
  stroke: z.string().optional().default("#e5e7eb"),
  fill: z.string().optional().default("transparent"),
  strokeWidth: z.number().optional().default(2),
  opacity: z.number().optional().default(1),
  radius: z.number().optional().default(8),
});

export const annotationTextSchema = z.object({
  kind: z.literal("text"),
  id: z.string(),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  fontSize: z.number().optional().default(14),
  color: z.string().optional().default("#e5e7eb"),
  align: z.enum(["left", "center", "right"]).optional().default("left"),
});

export const annotationItemSchema = z.discriminatedUnion("kind", [
  annotationPenPathSchema,
  annotationRectSchema,
  annotationTextSchema,
]);

export const realtimeSessionAnnotationsSchema = z.object({
  session_id: z.string(),
  version: z.number().int().nonnegative().default(1),
  payload: z.object({
    items: z.array(annotationItemSchema).default([]),
  }).default({ items: [] }),
});

export const realtimeTranscriptTurnSchema = z.object({
  speaker: z.string(),
  text: z.string(),
  start_ms: z.number(),
  end_ms: z.number(),
  is_final: z.boolean(),
  source: z.string(),
  capture_mode: z.string().optional().default(""),
});

export const realtimeSessionCloseSchema = z.object({
  ok: z.boolean(),
  session_id: z.string(),
  closed: z.boolean(),
  downloads: z.object({
    txt_url: z.string(),
    markdown_url: z.string(),
  }),
  transcript_summary: z.record(z.any()),
});

export const realtimeAudioTranscriptionSchema = z.object({
  ok: z.boolean(),
  text: z.string(),
  speaker: z.string(),
  segments: z.array(z.record(z.any())).nullable().optional(),
  voiceprint: z.record(z.any()).nullable().optional(),
  is_final: z.boolean(),
  provider: z.string(),
  model: z.string(),
  latency_ms: z.number(),
  pipeline: z.record(z.any()),
  evaluation: z.record(z.any()).nullable().optional(),
});

export const voiceprintFeatureSchema = z.object({
  id: z.string(),
  stt_profile_id: z.string(),
  group_id: z.string(),
  feature_id: z.string(),
  speaker_label: z.string(),
  feature_info: z.string(),
  status: z.string(),
  remote_payload: z.record(z.any()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const voiceprintGroupSchema = z.object({
  id: z.string(),
  stt_profile_id: z.string(),
  group_id: z.string(),
  display_name: z.string(),
  provider_kind: z.string(),
  status: z.string(),
  remote_payload: z.record(z.any()),
  last_synced_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const voiceprintGroupSyncSchema = z.object({
  ok: z.boolean(),
  group: voiceprintGroupSchema,
  remote_features: z.array(z.record(z.any())),
});

export const runJobSchema = z.object({
  run_id: z.string(),
  job_type: z.string(),
  title: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  dataset_version_slug: z.string().nullable().optional(),
  split: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  model_name: z.string().nullable().optional(),
  config_snapshot: z.record(z.any()),
  progress: z.record(z.any()),
  result_payload: z.record(z.any()),
  error_message: z.string().nullable().optional(),
  artifact_root: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

export const runArtifactSchema = z.object({
  id: z.string(),
  artifact_type: z.string(),
  label: z.string(),
  path: z.string(),
  format: z.string(),
  meta: z.record(z.any()),
});

export const studyTaskSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  description: z.string(),
  dataset_version_slug: z.string().nullable().optional(),
  split: z.string().nullable().optional(),
  sample_id: z.string().nullable().optional(),
  default_condition: z.enum(["manual", "heuristic", "model_system"]),
  materials: z.record(z.any()),
  system_outputs: z.record(z.any()),
  created_at: z.string(),
});

export const studySessionSchema = z.object({
  session_id: z.string(),
  participant_code: z.string(),
  participant_id: z.string(),
  task_id: z.string(),
  study_condition: z.enum(["manual", "heuristic", "model_system"]),
  status: z.string(),
  task_title: z.string(),
  task_description: z.string(),
  materials: z.record(z.any()),
  system_output: z.string().nullable().optional(),
  draft_output: z.string().nullable().optional(),
  final_output: z.string().nullable().optional(),
  compile_success: z.boolean().nullable().optional(),
  auto_metrics: z.record(z.any()),
  started_at: z.string().nullable().optional(),
  last_active_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
});

export const reportSummarySchema = z.object({
  report_id: z.string(),
  report_type: z.string(),
  title: z.string(),
  status: z.string(),
  summary: z.record(z.any()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const reportDetailSchema = reportSummarySchema.extend({
  payload: z.record(z.any()),
  json_path: z.string().nullable().optional(),
  csv_path: z.string().nullable().optional(),
  markdown_path: z.string().nullable().optional(),
});

export type DatasetVersionSummary = z.infer<typeof datasetVersionSummarySchema>;
export type DatasetSplitSummary = z.infer<typeof datasetSplitSummarySchema>;
export type RuntimeOptionProfile = z.infer<typeof runtimeOptionProfileSchema>;
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;
export type SampleListItem = z.infer<typeof sampleListItemSchema>;
export type SampleDetail = z.infer<typeof sampleDetailSchema>;
export type RealtimeSession = z.infer<typeof realtimeSessionSchema>;
export type RealtimeSnapshot = z.infer<typeof realtimeSnapshotSchema>;
export type RealtimeTranscriptTurn = z.infer<typeof realtimeTranscriptTurnSchema>;
export type RealtimeSessionClose = z.infer<typeof realtimeSessionCloseSchema>;
export type RealtimeAudioTranscription = z.infer<typeof realtimeAudioTranscriptionSchema>;
export type VoiceprintFeature = z.infer<typeof voiceprintFeatureSchema>;
export type VoiceprintGroup = z.infer<typeof voiceprintGroupSchema>;
export type VoiceprintGroupSync = z.infer<typeof voiceprintGroupSyncSchema>;
export type RunJob = z.infer<typeof runJobSchema>;
export type RunArtifact = z.infer<typeof runArtifactSchema>;
export type StudyTask = z.infer<typeof studyTaskSchema>;
export type StudySession = z.infer<typeof studySessionSchema>;
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type ReportDetail = z.infer<typeof reportDetailSchema>;
