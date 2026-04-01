"use client";

import { z } from "zod";

import {
  datasetSplitSummarySchema,
  datasetVersionSummarySchema,
  reportDetailSchema,
  reportSummarySchema,
  realtimeAudioTranscriptionSchema,
  realtimeSessionSchema,
  realtimeSnapshotSchema,
  runtimeOptionsSchema,
  runArtifactSchema,
  runJobSchema,
  sampleDetailSchema,
  sampleListItemSchema,
  studySessionSchema,
  studyTaskSchema,
  voiceprintFeatureSchema,
  voiceprintGroupSyncSchema,
} from "@stream2graph/contracts";

const CONFIGURED_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8000";

function resolveLocalApiBaseUrl(hostname: string) {
  return `http://${hostname}:8000`;
}

const runtimeOptionProfileConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider_kind: z.string(),
  endpoint: z.string(),
  models: z.array(z.string()),
  default_model: z.string(),
  app_id: z.string().nullable().optional(),
  api_key_env: z.string().nullable().optional(),
  api_key: z.string().nullable().optional(),
  api_secret_env: z.string().nullable().optional(),
  api_secret: z.string().nullable().optional(),
  voiceprint: z.record(z.any()).nullable().optional(),
});

const runtimeOptionsAdminSchema = z.object({
  gate_profiles: z.array(runtimeOptionProfileConfigSchema),
  planner_profiles: z.array(runtimeOptionProfileConfigSchema),
  stt_profiles: z.array(runtimeOptionProfileConfigSchema),
});

const runtimeModelProbeSchema = z.object({
  ok: z.boolean(),
  provider_kind: z.string(),
  models_endpoint: z.string(),
  models: z.array(z.string()),
});

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function resolveApiBaseUrl() {
  if (typeof window === "undefined") {
    return CONFIGURED_API_BASE_URL;
  }

  const { hostname, protocol } = window.location;
  const isLocalhost =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".local");

  if (isLocalhost) {
    return resolveLocalApiBaseUrl(hostname);
  }

  if (protocol === "http:" && CONFIGURED_API_BASE_URL.startsWith("https://")) {
    return resolveLocalApiBaseUrl(hostname);
  }

  return CONFIGURED_API_BASE_URL;
}

export function apiUrl(path: string) {
  return `${resolveApiBaseUrl()}${path}`;
}

function logBrowserApiEvent(label: string, payload: Record<string, unknown>, level: "info" | "error" = "info") {
  if (typeof window === "undefined") return;
  const method = level === "error" ? console.error : console.info;
  method(`[S2G][API] ${label}`, payload);
}

/** 解析 FastAPI / Starlette 的 `detail`（字符串、对象数组等） */
function messageFromErrorPayload(raw: Record<string, unknown>): string {
  const d = raw.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d
      .map((item) =>
        typeof item === "object" && item !== null && "msg" in item
          ? String((item as { msg: string }).msg)
          : JSON.stringify(item),
      )
      .join("；");
  }
  if (d != null && typeof d === "object" && "msg" in d) {
    return String((d as { msg: string }).msg);
  }
  const err = raw.error;
  if (typeof err === "string") return err;
  return "请求失败";
}

const REQUEST_TIMEOUT_MS = 25_000;

async function request<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.infer<TSchema>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl(path), {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    let raw: Record<string, unknown> = {};
    try {
      raw = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      raw = { detail: text || response.statusText };
    }
    if (!response.ok) {
      logBrowserApiEvent(
        "request failed",
        {
          path,
          method: init?.method || "GET",
          status: response.status,
          payload: raw,
        },
        "error",
      );
      throw new ApiError(response.status, messageFromErrorPayload(raw), raw);
    }
    return schema.parse(raw);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof ApiError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError(
        0,
        "请求超时。请确认：① API 已启动；② PostgreSQL 可连接（登录会查库，库不可达时会一直卡住）；③ 前端与 `NEXT_PUBLIC_API_BASE_URL` 指向同一套服务。",
        {},
      );
    }
    if (e instanceof TypeError) {
      throw new ApiError(
        0,
        "无法连接 API。请检查服务是否已启动；若用局域网 IP 打开本页，请在 API 的 S2G_CORS_ORIGINS 中加入该前端地址（如 http://192.168.x.x:3000）。",
        {},
      );
    }
    throw e;
  }
}

export const api = {
  health: async () => request("/api/health", z.record(z.any())),
  login: async (payload: { username: string; password: string }) =>
    request(
      "/api/v1/auth/login",
      z.object({
        username: z.string(),
        display_name: z.string().optional().nullable().transform((v) => v ?? ""),
      }),
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  logout: async () => request("/api/v1/auth/logout", z.object({ ok: z.boolean() }), { method: "POST" }),
  me: async () =>
    request("/api/v1/auth/me", z.object({
      username: z.string(),
      display_name: z.string().optional().nullable().transform((v) => v ?? ""),
    })),
  listDatasets: async () => request("/api/v1/catalog/datasets", z.array(datasetVersionSummarySchema)),
  listRuntimeOptions: async () => request("/api/v1/catalog/runtime-options", runtimeOptionsSchema),
  getAdminRuntimeOptions: async () => request("/api/v1/catalog/runtime-options/admin", runtimeOptionsAdminSchema),
  saveAdminRuntimeOptions: async (payload: Record<string, unknown>) =>
    request("/api/v1/catalog/runtime-options/admin", runtimeOptionsAdminSchema, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  probeRuntimeModels: async (payload: Record<string, unknown>) =>
    request("/api/v1/catalog/runtime-options/admin/probe-models", runtimeModelProbeSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listVoiceprintFeatures: async (sttProfileId: string) =>
    request(
      `/api/v1/voiceprints/stt-profiles/${sttProfileId}/features`,
      z.array(voiceprintFeatureSchema),
    ),
  createVoiceprintFeature: async (sttProfileId: string, payload: Record<string, unknown>) =>
    request(
      `/api/v1/voiceprints/stt-profiles/${sttProfileId}/features`,
      voiceprintFeatureSchema,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  deleteVoiceprintFeature: async (sttProfileId: string, featureId: string) =>
    request(
      `/api/v1/voiceprints/stt-profiles/${sttProfileId}/features/${featureId}`,
      z.object({ ok: z.boolean() }),
      {
        method: "DELETE",
      },
    ),
  syncVoiceprintGroup: async (sttProfileId: string, payload: Record<string, unknown>) =>
    request(
      `/api/v1/voiceprints/stt-profiles/${sttProfileId}/group/sync`,
      voiceprintGroupSyncSchema,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  listSplits: async (slug: string) =>
    request(`/api/v1/catalog/datasets/${slug}/splits`, z.array(datasetSplitSummarySchema)),
  listSamples: async (slug: string, split: string, search = "", offset = 0, limit = 25) =>
    request(
      `/api/v1/catalog/datasets/${slug}/samples?split=${split}&search=${encodeURIComponent(search)}&offset=${offset}&limit=${limit}`,
      z.array(sampleListItemSchema),
    ),
  getSample: async (slug: string, split: string, sampleId: string) =>
    request(
      `/api/v1/catalog/datasets/${slug}/samples/${sampleId}?split=${split}`,
      sampleDetailSchema,
    ),
  listRealtimeSessions: async () => request("/api/v1/realtime/sessions", z.array(realtimeSessionSchema)),
  createRealtimeSession: async (payload: Record<string, unknown>) =>
    request("/api/v1/realtime/sessions", realtimeSessionSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getRealtimeSession: async (sessionId: string) =>
    request(`/api/v1/realtime/sessions/${sessionId}`, realtimeSessionSchema),
  addRealtimeChunk: async (sessionId: string, payload: Record<string, unknown>) =>
    request(
      `/api/v1/realtime/sessions/${sessionId}/chunks`,
      z.object({
        ok: z.boolean(),
        session_id: z.string(),
        emitted_events: z.array(z.record(z.any())),
        pipeline: z.record(z.any()),
        evaluation: z.record(z.any()),
      }),
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  addRealtimeChunksBatch: async (sessionId: string, payload: Record<string, unknown>) =>
    request(
      `/api/v1/realtime/sessions/${sessionId}/chunks/batch`,
      z.object({
        ok: z.boolean(),
        session_id: z.string(),
        emitted_events: z.array(z.record(z.any())),
        pipeline: z.record(z.any()),
        evaluation: z.record(z.any()),
      }),
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  transcribeRealtimeAudio: async (sessionId: string, payload: Record<string, unknown>) =>
    request(
      `/api/v1/realtime/sessions/${sessionId}/audio/transcriptions`,
      realtimeAudioTranscriptionSchema,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  snapshotRealtime: async (sessionId: string) =>
    request(`/api/v1/realtime/sessions/${sessionId}/snapshot`, realtimeSnapshotSchema, {
      method: "POST",
    }),
  flushRealtime: async (sessionId: string) =>
    request(`/api/v1/realtime/sessions/${sessionId}/flush`, realtimeSnapshotSchema, {
      method: "POST",
    }),
  closeRealtime: async (sessionId: string) =>
    request(`/api/v1/realtime/sessions/${sessionId}/close`, z.object({ ok: z.boolean(), session_id: z.string(), closed: z.boolean() }), {
      method: "POST",
    }),
  saveRealtimeReport: async (sessionId: string) =>
    request(`/api/v1/realtime/sessions/${sessionId}/report`, z.object({ ok: z.boolean(), report_id: z.string() }), {
      method: "POST",
    }),
  listRuns: async () => request("/api/v1/runs", z.array(runJobSchema)),
  createSampleCompareRun: async (payload: Record<string, unknown>) =>
    request("/api/v1/runs/sample-compare", runJobSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createBenchmarkRun: async (payload: Record<string, unknown>) =>
    request("/api/v1/runs/benchmark-suite", runJobSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getRun: async (runId: string) => request(`/api/v1/runs/${runId}`, runJobSchema),
  listRunArtifacts: async (runId: string) =>
    request(`/api/v1/runs/${runId}/artifacts`, z.array(runArtifactSchema)),
  listStudyTasks: async () => request("/api/v1/studies/tasks", z.array(studyTaskSchema)),
  createStudyTask: async (payload: Record<string, unknown>) =>
    request("/api/v1/studies/tasks", studyTaskSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listStudySessions: async () => request("/api/v1/studies/sessions", z.array(studySessionSchema)),
  createStudySession: async (taskId: string, payload: Record<string, unknown>) =>
    request(`/api/v1/studies/tasks/${taskId}/sessions`, studySessionSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getParticipantSession: async (code: string) =>
    request(`/api/v1/studies/participant/${code}`, studySessionSchema),
  startParticipantSession: async (code: string) =>
    request(`/api/v1/studies/participant/${code}/start`, studySessionSchema, {
      method: "POST",
    }),
  logParticipantEvent: async (code: string, payload: Record<string, unknown>) =>
    request(`/api/v1/studies/participant/${code}/events`, z.object({ ok: z.boolean() }), {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  autosaveParticipant: async (code: string, payload: Record<string, unknown>) =>
    request(`/api/v1/studies/participant/${code}/autosave`, studySessionSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  submitParticipant: async (code: string, payload: Record<string, unknown>) =>
    request(`/api/v1/studies/participant/${code}/submit`, studySessionSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  saveSurvey: async (code: string, payload: Record<string, unknown>) =>
    request(
      `/api/v1/studies/participant/${code}/survey`,
      z.object({ study_session_id: z.string(), payload: z.record(z.any()), submitted_at: z.string() }),
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  listReports: async () => request("/api/v1/reports", z.array(reportSummarySchema)),
  getReport: async (reportId: string) => request(`/api/v1/reports/${reportId}`, reportDetailSchema),
};

export function subscribeRun(runId: string, onMessage: (payload: z.infer<typeof runJobSchema>) => void) {
  const source = new EventSource(apiUrl(`/api/v1/runs/stream/events?run_id=${runId}`), {
    withCredentials: true,
  });
  source.onmessage = (event) => {
    const parsed = runJobSchema.parse(JSON.parse(event.data));
    onMessage(parsed);
    if (parsed.status === "succeeded" || parsed.status === "failed" || parsed.status === "cancelled") {
      source.close();
    }
  };
  return source;
}
