"use client";

import { z } from "zod";

const HELPER_BASE_URL =
  process.env.NEXT_PUBLIC_AUDIO_HELPER_BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8765";

export const helperHealthSchema = z.object({
  ok: z.boolean(),
  service: z.literal("stream2graph-audio-helper"),
  platform: z.string(),
});

export const helperCapabilitiesSchema = z.object({
  source_type: z.literal("system_audio_helper"),
  platform: z.string(),
  capability_status: z.enum(["supported", "limited", "unsupported"]),
  capability_reason: z.string(),
  native_engine: z.string(),
  supported_sources: z.array(z.string()),
});

export const helperCaptureResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["idle", "starting", "running", "stopped", "failed"]),
  source_type: z.string(),
  message: z.string(),
});

export const helperEventSchema = z.object({
  source_type: z.string(),
  platform: z.string(),
  status: z.string(),
  text: z.string().nullable().optional(),
  timestamp_ms: z.number().nullable().optional(),
  is_final: z.boolean().nullable().optional(),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
});

async function helperRequest<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<z.infer<TSchema>> {
  const response = await fetch(`${HELPER_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  const raw = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(raw.detail || raw.error || `HTTP ${response.status}`);
  }
  return schema.parse(raw);
}

export const audioHelper = {
  baseUrl: HELPER_BASE_URL,
  health: async () => helperRequest("/health", helperHealthSchema),
  capabilities: async () => helperRequest("/capabilities", helperCapabilitiesSchema),
  startCapture: async (payload: { source_type: string; session_id?: string | null }) =>
    helperRequest("/capture/start", helperCaptureResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  stopCapture: async () =>
    helperRequest("/capture/stop", helperCaptureResponseSchema, {
      method: "POST",
    }),
};

export function subscribeAudioHelperEvents(
  onMessage: (payload: z.infer<typeof helperEventSchema>) => void,
  onError?: () => void,
) {
  const source = new EventSource(`${HELPER_BASE_URL}/stream/events`);
  source.onmessage = (event) => {
    const parsed = helperEventSchema.parse(JSON.parse(event.data));
    onMessage(parsed);
  };
  source.onerror = () => {
    onError?.();
  };
  return source;
}
