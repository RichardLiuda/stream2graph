"use client";

import { z } from "zod";

import { isPrivateLanIPv4Hostname } from "@/lib/hostname";

import {
  datasetSplitSummarySchema,
  datasetVersionSummarySchema,
  reportDetailSchema,
  reportSummarySchema,
  realtimeAudioTranscriptionSchema,
  realtimeSessionCloseSchema,
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

function resolveDirectApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return CONFIGURED_API_BASE_URL;
  }

  const { hostname, protocol } = window.location;
  const isLocalhost = hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".local");

  if (isLocalhost || isPrivateLanIPv4Hostname(hostname)) {
    return resolveLocalApiBaseUrl(hostname);
  }

  if (protocol === "http:" && CONFIGURED_API_BASE_URL.startsWith("https://")) {
    return resolveLocalApiBaseUrl(hostname);
  }

  return CONFIGURED_API_BASE_URL;
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

const runtimeConnectionTestSchema = z.object({
  ok: z.boolean(),
  provider_kind: z.string(),
  summary: z.string(),
  logs: z.array(z.string()),
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

/**
 * 默认走 Next `rewrites` 同源代理（见 `next.config.ts`），浏览器请求 `/api/*` 即可，无需直连 :8000。
 * 设置 `NEXT_PUBLIC_API_BROWSER_PROXY=0` 时改回直连（需后端 CORS、与页面同协议等）。
 */
function resolveApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return CONFIGURED_API_BASE_URL;
  }

  if (process.env.NEXT_PUBLIC_API_BROWSER_PROXY === "0") {
    const { hostname, protocol } = window.location;
    const isLocalhost =
      hostname === "127.0.0.1" || hostname === "localhost" || hostname.endsWith(".local");

    if (isLocalhost || isPrivateLanIPv4Hostname(hostname)) {
      return resolveLocalApiBaseUrl(hostname);
    }

    if (protocol === "http:" && CONFIGURED_API_BASE_URL.startsWith("https://")) {
      return resolveLocalApiBaseUrl(hostname);
    }

    return CONFIGURED_API_BASE_URL;
  }

  return "";
}

export function apiUrl(path: string): string {
  const base = resolveApiBaseUrl();
  if (!base) {
    return path.startsWith("/") ? path : `/${path}`;
  }
  const clean = base.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${clean}${p}`;
}

export function directApiUrl(path: string): string {
  const clean = resolveDirectApiBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${clean}${p}`;
}

function logBrowserApiEvent(label: string, payload: Record<string, unknown>, level: "info" | "error" = "info") {
  if (typeof window === "undefined") return;
  const method = level === "error" ? console.error : console.info;
  method(`[S2G][API] ${label}`, payload);
}

function apiErrorLogLevel(path: string, status: number) {
  // `/auth/me` returning 401 is part of the normal boot flow before redirecting to `/login`.
  if (path === "/api/v1/auth/me" && status === 401) {
    return "info" as const;
  }
  return "error" as const;
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

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const REALTIME_AUDIO_TRANSCRIPTION_TIMEOUT_MS = 90_000;
const REALTIME_PIPELINE_TIMEOUT_MS = 240_000;

function isRealtimePipelinePath(path: string) {
  return (
    /^\/api\/v1\/realtime\/sessions\/[^/]+\/chunks(?:\/batch)?$/.test(path) ||
    /^\/api\/v1\/realtime\/sessions\/[^/]+\/(?:snapshot|flush|diagram-relayout)$/.test(path)
  );
}

function timeoutMessageForPath(path: string, timeoutMs: number) {
  if (isRealtimePipelinePath(path)) {
    return `请求超时（前端等待 ${Math.round(timeoutMs / 1000)} 秒）。实时成图、重排或快照在重型样本下可能仍在后端继续执行，这不一定表示 API 或 PostgreSQL 异常；可稍后刷新当前会话查看结果。`;
  }
  return "请求超时。请确认：① API 已启动；② PostgreSQL 可连接（登录会查库，库不可达时会一直卡住）；③ 前端与 `NEXT_PUBLIC_API_BASE_URL` 指向同一套服务。";
}

function shouldLogAsInfo(path: string, response: Response, raw: unknown) {
  return (
    path === "/api/v1/auth/me" &&
    response.status === 401 &&
    typeof raw === "object" &&
    raw !== null &&
    "detail" in raw &&
    (raw as { detail?: unknown }).detail === "not authenticated"
  );
}
async function request<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init?: RequestInit,
  options?: {
    timeoutMs?: number;
  },
): Promise<z.infer<TSchema>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
      const logLevel = shouldLogAsInfo(path, response, raw) ? "info" : "error";
      logBrowserApiEvent(
        "request failed",
        {
          path,
          method: init?.method || "GET",
          status: response.status,
          payload: raw,
        },
        apiErrorLogLevel(path, response.status),
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
      const tried = apiUrl(path);
      throw new ApiError(
        0,
        `无法连接 API（请求：${tried}）。请确认：① API 已在运行；② 若使用「直连模式」（NEXT_PUBLIC_API_BROWSER_PROXY=0），同一台机须监听 0.0.0.0:8000 且防火墙放行；③ 默认「同源代理」时，Next 会将 /api/* 转到 API_PROXY_TARGET / NEXT_PUBLIC_API_BASE_URL（见 apps/web/next.config.ts），请保证该地址在运行 Next 的机器上可访问。`,
        {},
      );
    }
    throw e;
  }
}

async function requestRealtime<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.infer<TSchema>> {
  const timeoutMs = REALTIME_PIPELINE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const requestUrl = directApiUrl(path);
  try {
    const response = await fetch(requestUrl, {
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
          url: requestUrl,
          method: init?.method || "GET",
          status: response.status,
          payload: raw,
        },
        apiErrorLogLevel(path, response.status),
      );
      throw new ApiError(response.status, messageFromErrorPayload(raw), raw);
    }
    return schema.parse(raw);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof ApiError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError(0, timeoutMessageForPath(path, timeoutMs), {});
    }
    if (e instanceof TypeError) {
      throw new ApiError(
        0,
        `无法直连实时 API（请求：${requestUrl}）。请确认：① API 已在 8000 端口运行；② 浏览器可直接访问 ${requestUrl}; ③ 后端 CORS 允许当前页面来源。`,
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
  testRuntimeConnection: async (payload: Record<string, unknown>) =>
    request("/api/v1/catalog/runtime-options/admin/test-connection", runtimeConnectionTestSchema, {
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
  /** 更新会话标题（后端提供 PUT，与 PATCH 等价；统一用 PUT 避免部分环境对 PATCH 支持异常） */
  patchRealtimeSession: async (sessionId: string, payload: { title: string }) =>
    request(`/api/v1/realtime/sessions/${sessionId}`, realtimeSessionSchema, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteRealtimeSession: async (sessionId: string) =>
    request(
      `/api/v1/realtime/sessions/${sessionId}`,
      z.object({ ok: z.boolean(), session_id: z.string() }),
      { method: "DELETE" },
    ),
  addRealtimeChunk: async (sessionId: string, payload: Record<string, unknown>) =>
    requestRealtime(
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
    requestRealtime(
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
      {
        timeoutMs: REALTIME_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
      },
    ),
  snapshotRealtime: async (sessionId: string) =>
    requestRealtime(`/api/v1/realtime/sessions/${sessionId}/snapshot`, realtimeSnapshotSchema, {
      method: "POST",
    }),
  flushRealtime: async (sessionId: string) =>
    requestRealtime(`/api/v1/realtime/sessions/${sessionId}/flush`, realtimeSnapshotSchema, {
      method: "POST",
    }),
  relayoutRealtimeDiagram: async (sessionId: string, payload: Record<string, unknown>) =>
    requestRealtime(`/api/v1/realtime/sessions/${sessionId}/diagram-relayout`, realtimeSnapshotSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  closeRealtime: async (sessionId: string) =>
    request(`/api/v1/realtime/sessions/${sessionId}/close`, realtimeSessionCloseSchema, {
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
