"use client";

// AI辅助生成：豆包（IDE智能编程辅助），2026-04-06
// 说明：事后补注（复现实录）。该文件在实时工作台 UI 迭代、布局与交互细节打磨阶段参考了智能编程辅助给出的组件拆分与样式建议。

import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import Link from "next/link";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Eraser,
  Fingerprint,
  Headphones,
  Mic,
  MicOff,
  Pause,
  PanelRight,
  Pencil,
  Download,
  Save,
  Send,
  Square,
  StopCircle,
  Trash2,
  Type,
  WandSparkles,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Button, Card, Input, StatCard, Textarea } from "@stream2graph/ui";
import type {
  RealtimeSession,
  RealtimeTimelineNode,
  RealtimeTranscriptTurn,
  RealtimeTranscriptTurnEditable,
} from "@stream2graph/contracts";

import { ApiError, api, apiUrl } from "@/lib/api";
import { encodeFloat32ToBase64Pcm16 } from "@/lib/audio";
import {
  audioHelper,
  type helperCapabilitiesSchema,
  subscribeAudioHelperEvents,
} from "@/lib/audio-helper";
import {
  buildRealtimeClientContext,
  detectClientAudioContext,
  getDisplayAudioErrorMessage,
  getInputSourceOptions,
  getSpeechRecognitionErrorMessage,
  supportsHelperSystemAudioUi,
  supportsSystemAudioExperimentalUi,
  type CaptureMode,
  type ClientAudioContext,
  type InputSource,
  type InputSourceOption,
} from "@/lib/audio-input";
import { translate, useLanguagePreference, type I18nKey, type LanguagePreference } from "@/lib/language";
import { type RecognitionBackend, realtimeStudioMachine } from "@/lib/realtime-machine";
import {
  loadRuntimePreferences,
  resolveRuntimePreferences,
  saveRuntimePreferences,
} from "@/lib/runtime-preferences";
import type { AnnotationDoc, AnnotationTool } from "@/components/annotation-layer";
import { normalizeMaskStrokes } from "@/components/annotation-layer";
import {
  normalizeSessionAnnotationsPayload,
  type SessionAnnotationsPayload,
} from "@/lib/session-annotations-payload";
import { AnnotationColorPopover } from "@/components/annotation-color-popover";
import { AnnotationWidthSlider } from "@/components/annotation-width-slider";
import { GraphStage } from "@/components/graph-stage";
import { MermaidCard, type MermaidNodeRelayoutPayload } from "@/components/mermaid-card";

const LOCAL_SESSION_KEY = "s2g:last-realtime-session";

const DEFAULT_VOICEPRINT_BASE = "https://api.xf-yun.com";

type AdminRuntimeOptionsPayload = Awaited<ReturnType<typeof api.getAdminRuntimeOptions>>;
type RealtimeRollbackPreviewPayload = Awaited<ReturnType<typeof api.previewRealtimeRollback>>;

/** 浅色画布上的笔触预设（原「浅」模式色板） */
const ANNOTATION_SWATCHES_LIGHT_CANVAS = [
  "#111827",
  "#374151",
  "#1D4ED8",
  "#0F766E",
  "#6D28D9",
  "#BE185D",
  "#9A3412",
  "#B45309",
] as const;

const DEFAULT_ANNOTATION_COLOR = ANNOTATION_SWATCHES_LIGHT_CANVAS[0];

/** 橡皮：小圆→大圆为精准擦宽度；叉为对象擦 */
const ERASER_WIDTH_PRESETS = [
  { w: 6, dot: 5 },
  { w: 10, dot: 6 },
  { w: 14, dot: 7 },
  { w: 20, dot: 8 },
  { w: 28, dot: 10 },
  { w: 36, dot: 12 },
] as const;

function nearestEraserPresetWidth(width: number): number {
  const ws = ERASER_WIDTH_PRESETS.map((p) => p.w);
  return ws.reduce((best, p) => (Math.abs(p - width) < Math.abs(best - width) ? p : best), ws[0]!);
}

function voiceprintPayloadForSave(
  profile: AdminRuntimeOptionsPayload["stt_profiles"][number],
  enabled: boolean,
) {
  const raw =
    profile.voiceprint && typeof profile.voiceprint === "object"
      ? (profile.voiceprint as Record<string, unknown>)
      : null;
  return {
    enabled,
    provider_kind: typeof raw?.provider_kind === "string" ? raw.provider_kind : "xfyun_isv",
    api_base:
      typeof raw?.api_base === "string" && raw.api_base.trim()
        ? raw.api_base.trim()
        : DEFAULT_VOICEPRINT_BASE,
    group_id:
      typeof raw?.group_id === "string" && raw.group_id.trim()
        ? raw.group_id.trim()
        : `${profile.id}_group`,
    score_threshold:
      typeof raw?.score_threshold === "number"
        ? raw.score_threshold
        : Number(raw?.score_threshold ?? 0.75) || 0.75,
    top_k: typeof raw?.top_k === "number" ? raw.top_k : Number(raw?.top_k ?? 3) || 3,
  };
}

function readVoiceprintEnabledFromCatalog(profile: { voiceprint?: unknown } | null | undefined) {
  const v = profile?.voiceprint;
  if (!v || typeof v !== "object") return false;
  return Boolean((v as { enabled?: boolean }).enabled);
}

type TranscriptRow = {
  text: string;
  speaker: string;
  expected_intent?: string | null;
};

type TranscriptPreset = {
  id: string;
  labelKey: I18nKey;
  descriptionKey: I18nKey;
  valueKey: I18nKey;
};

type BackendOption = {
  value: RecognitionBackend;
  label: string;
  disabled?: boolean;
};

type TranscriptStateView = {
  latestFinalTurn: RealtimeTranscriptTurn | null;
  currentTurn: RealtimeTranscriptTurn | null;
  archivedRecentTurns: RealtimeTranscriptTurn[];
  recentTurns: RealtimeTranscriptTurn[];
  turnCount: number;
  speakerCount: number;
  chunkCount: number;
};

type TranscriptHistoryItem = RealtimeTranscriptTurn & {
  key: string;
  origin: "server" | "event" | "local";
  observedAt: number;
};

type TranscriptDisplayState = {
  activeTurn: TranscriptHistoryItem | null;
  archivedTurns: TranscriptHistoryItem[];
};

type NoticeTone = "info" | "success" | "warning";

const TRANSCRIPT_PRESETS: TranscriptPreset[] = [
  {
    id: "platform_architecture",
    labelKey: "realtimeStudio.preset.platformArchitecture.label",
    descriptionKey: "realtimeStudio.preset.platformArchitecture.description",
    valueKey: "realtimeStudio.preset.platformArchitecture.value",
  },
  {
    id: "incident_response",
    labelKey: "realtimeStudio.preset.incidentResponse.label",
    descriptionKey: "realtimeStudio.preset.incidentResponse.description",
    valueKey: "realtimeStudio.preset.incidentResponse.value",
  },
  {
    id: "research_workflow",
    labelKey: "realtimeStudio.preset.researchWorkflow.label",
    descriptionKey: "realtimeStudio.preset.researchWorkflow.description",
    valueKey: "realtimeStudio.preset.researchWorkflow.value",
  },
  {
    id: "data_pipeline",
    labelKey: "realtimeStudio.preset.dataPipeline.label",
    descriptionKey: "realtimeStudio.preset.dataPipeline.description",
    valueKey: "realtimeStudio.preset.dataPipeline.value",
  },
];

function parseTranscriptInput(raw: string): TranscriptRow[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      if (parts.length === 1) return { speaker: "user", text: parts[0] };
      if (parts.length === 2) return { speaker: parts[0] || "user", text: parts[1] };
      return { speaker: parts[0] || "user", text: parts[1], expected_intent: parts[2] || null };
    });
}

function getNoticeClassName(tone: NoticeTone) {
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (tone === "warning") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-theme-default bg-surface-2 text-theme-2";
}

function t(language: LanguagePreference, key: I18nKey, params?: Record<string, string | number>) {
  return translate(language, key, params);
}

function dateLocale(language: LanguagePreference) {
  switch (language) {
    case "en-US":
      return "en-US";
    case "es-ES":
      return "es-ES";
    case "pt-BR":
      return "pt-BR";
    case "de-DE":
      return "de-DE";
    case "ja-JP":
      return "ja-JP";
    default:
      return "zh-CN";
  }
}

function getSourceBadgeLabel(source: InputSource | null, language: LanguagePreference = "zh-CN") {
  switch (source) {
    case "microphone_browser":
      return t(language, "realtimeStudio.text001");
    case "system_audio_browser_experimental":
      return t(language, "realtimeStudio.text002");
    case "system_audio_helper":
      return t(language, "realtimeStudio.text003");
    default:
      return t(language, "realtimeStudio.text004");
  }
}

function getBrowserFamilyLabel(context: ClientAudioContext | null) {
  return context?.browser_family || "other";
}

type HelperCapabilities = typeof helperCapabilitiesSchema._type;
type RuntimeOptions = Awaited<ReturnType<typeof api.listRuntimeOptions>>;
const HELPER_TARGET_SAMPLE_RATE = 16_000;
const AUDIO_SEGMENT_MAX_MS = 6_000;
const AUDIO_SEGMENT_END_SILENCE_MS = 520;
const AUDIO_SEGMENT_MIN_SPEECH_MS = 320;
const AUDIO_SEGMENT_PREROLL_MS = 180;
const AUDIO_LEVEL_START_THRESHOLD = 0.08;
const AUDIO_LEVEL_CONTINUE_THRESHOLD = 0.045;
const ASR_DIAG_HEARTBEAT_MS = 5_000;

type AudioSegmentState = {
  activeFrames: Float32Array[];
  activeSampleCount: number;
  speechSampleCount: number;
  silenceSampleCount: number;
  preRollFrames: Float32Array[];
  preRollSampleCount: number;
  hasSpeech: boolean;
};

function createAudioSegmentState(): AudioSegmentState {
  return {
    activeFrames: [],
    activeSampleCount: 0,
    speechSampleCount: 0,
    silenceSampleCount: 0,
    preRollFrames: [],
    preRollSampleCount: 0,
    hasSpeech: false,
  };
}

function appendSegmentFrame(target: Float32Array[], frame: Float32Array) {
  target.push(frame);
}

function trimSegmentFrames(frames: Float32Array[], sampleLimit: number) {
  if (sampleLimit <= 0) return { frames: [] as Float32Array[], sampleCount: 0 };
  let retained = 0;
  const kept: Float32Array[] = [];
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    kept.unshift(frame);
    retained += frame.length;
    if (retained >= sampleLimit) break;
  }
  return { frames: kept, sampleCount: retained };
}

function mergeSegmentFrames(frames: Float32Array[], sampleCount: number) {
  const merged = new Float32Array(sampleCount);
  let offset = 0;
  for (const frame of frames) {
    merged.set(frame, offset);
    offset += frame.length;
  }
  return merged;
}

function pushAudioSegmentFrame(
  state: AudioSegmentState,
  frame: Float32Array,
  level: number,
  sampleRate: number,
): "none" | "soft_flush" | "final_flush" {
  const startThreshold = AUDIO_LEVEL_START_THRESHOLD;
  const continueThreshold = state.hasSpeech ? AUDIO_LEVEL_CONTINUE_THRESHOLD : AUDIO_LEVEL_START_THRESHOLD;
  const maxChunkSamples = Math.round((sampleRate * AUDIO_SEGMENT_MAX_MS) / 1000);
  const endSilenceSamples = Math.round((sampleRate * AUDIO_SEGMENT_END_SILENCE_MS) / 1000);
  const minSpeechSamples = Math.round((sampleRate * AUDIO_SEGMENT_MIN_SPEECH_MS) / 1000);
  const preRollSamples = Math.round((sampleRate * AUDIO_SEGMENT_PREROLL_MS) / 1000);
  const isSpeechFrame = level >= continueThreshold;

  if (!state.hasSpeech) {
    appendSegmentFrame(state.preRollFrames, frame);
    state.preRollSampleCount += frame.length;
    if (state.preRollSampleCount > preRollSamples) {
      const trimmed = trimSegmentFrames(state.preRollFrames, preRollSamples);
      state.preRollFrames = trimmed.frames;
      state.preRollSampleCount = trimmed.sampleCount;
    }
    if (level >= startThreshold) {
      state.hasSpeech = true;
      state.activeFrames = [...state.preRollFrames];
      state.activeSampleCount = state.preRollSampleCount;
      state.speechSampleCount = 0;
      state.silenceSampleCount = 0;
      state.preRollFrames = [];
      state.preRollSampleCount = 0;
    } else {
      return "none";
    }
  }

  if (state.activeFrames[state.activeFrames.length - 1] !== frame) {
    appendSegmentFrame(state.activeFrames, frame);
    state.activeSampleCount += frame.length;
  }

  if (isSpeechFrame) {
    state.speechSampleCount += frame.length;
    state.silenceSampleCount = 0;
  } else {
    state.silenceSampleCount += frame.length;
  }

  if (state.activeSampleCount >= maxChunkSamples) {
    return state.speechSampleCount >= minSpeechSamples ? "soft_flush" : "none";
  }
  if (state.silenceSampleCount >= endSilenceSamples && state.speechSampleCount >= minSpeechSamples) {
    return "final_flush";
  }
  return "none";
}

function calculateAudioLevel(samples: Float32Array) {
  if (!samples.length) return 0;
  let squareSum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    squareSum += samples[index] * samples[index];
  }
  const rms = Math.sqrt(squareSum / samples.length);
  return Math.max(0, Math.min(1, rms * 5));
}

function audioSegmentDiag(state: AudioSegmentState, sampleRate: number) {
  return {
    has_speech: state.hasSpeech,
    active_ms: Math.round((state.activeSampleCount / sampleRate) * 1000),
    speech_ms: Math.round((state.speechSampleCount / sampleRate) * 1000),
    silence_ms: Math.round((state.silenceSampleCount / sampleRate) * 1000),
    preroll_ms: Math.round((state.preRollSampleCount / sampleRate) * 1000),
    active_frame_count: state.activeFrames.length,
  };
}

function formatLiveTranscript(text: string, language: LanguagePreference = "zh-CN") {
  return text.trim() || t(language, "realtimeStudio.text005");
}

function makeTranscriptTurn(
  turn: Omit<
    RealtimeTranscriptTurn,
    "speaker_slot_key" | "speaker_identity" | "raw_role_label" | "speaker_resolution_source"
  > &
    Partial<
      Pick<
        RealtimeTranscriptTurn,
        "speaker_slot_key" | "speaker_identity" | "raw_role_label" | "speaker_resolution_source"
      >
    >,
): RealtimeTranscriptTurn {
  return {
    ...turn,
    capture_mode: turn.capture_mode || "",
    speaker_slot_key: turn.speaker_slot_key || "",
    speaker_identity: turn.speaker_identity || "",
    raw_role_label: turn.raw_role_label || "",
    speaker_resolution_source: turn.speaker_resolution_source || "",
  };
}

function normalizeTranscriptTurn(value: unknown): RealtimeTranscriptTurn | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.speaker !== "string" ||
    typeof row.text !== "string" ||
    typeof row.start_ms !== "number" ||
    typeof row.end_ms !== "number" ||
    typeof row.is_final !== "boolean" ||
    typeof row.source !== "string"
  ) {
    return null;
  }
  return makeTranscriptTurn({
    speaker: row.speaker,
    text: row.text,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    is_final: row.is_final,
    source: row.source,
    capture_mode: typeof row.capture_mode === "string" ? row.capture_mode : "",
    speaker_slot_key: typeof row.speaker_slot_key === "string" ? row.speaker_slot_key : "",
    speaker_identity: typeof row.speaker_identity === "string" ? row.speaker_identity : "",
    raw_role_label: typeof row.raw_role_label === "string" ? row.raw_role_label : "",
    speaker_resolution_source:
      typeof row.speaker_resolution_source === "string" ? row.speaker_resolution_source : "",
  });
}

function readTranscriptState(pipeline: Record<string, any> | null | undefined): TranscriptStateView {
  const payload =
    pipeline?.transcript_state && typeof pipeline.transcript_state === "object"
      ? (pipeline.transcript_state as Record<string, unknown>)
      : null;
  const archivedRecentTurns = Array.isArray(payload?.archived_recent_turns)
    ? payload?.archived_recent_turns
        .map(normalizeTranscriptTurn)
        .filter((row): row is RealtimeTranscriptTurn => Boolean(row))
    : [];
  const recentTurns = Array.isArray(payload?.recent_turns)
    ? payload?.recent_turns.map(normalizeTranscriptTurn).filter((row): row is RealtimeTranscriptTurn => Boolean(row))
    : [];
  return {
    latestFinalTurn: normalizeTranscriptTurn(payload?.latest_final_turn ?? null),
    currentTurn: normalizeTranscriptTurn(payload?.current_turn ?? null),
    archivedRecentTurns,
    recentTurns,
    turnCount: typeof payload?.turn_count === "number" ? payload.turn_count : 0,
    speakerCount: typeof payload?.speaker_count === "number" ? payload.speaker_count : 0,
    chunkCount: typeof payload?.chunk_count === "number" ? payload.chunk_count : 0,
  };
}

function formatRelativeTranscriptTime(ms: number) {
  const totalMs = Math.max(0, Math.floor(ms || 0));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function makeTranscriptHistoryItem(
  turn: RealtimeTranscriptTurn,
  origin: TranscriptHistoryItem["origin"],
  keySeed: string,
  observedAt?: number,
): TranscriptHistoryItem {
  const stableObservedAt =
    typeof observedAt === "number" && Number.isFinite(observedAt)
      ? observedAt
      : Math.max(turn.end_ms || 0, turn.start_ms || 0, Date.now());
  return {
    ...turn,
    key: [
      origin,
      keySeed,
      turn.speaker,
      turn.text,
      turn.start_ms,
      turn.end_ms,
      turn.source,
      turn.capture_mode,
    ].join("|"),
    origin,
    observedAt: stableObservedAt,
  };
}

function deriveTranscriptTurnsFromEvents(events: Array<Record<string, any>> | null | undefined): TranscriptHistoryItem[] {
  if (!Array.isArray(events) || !events.length) return [];
  const rows: TranscriptHistoryItem[] = [];
  events
    .slice(-10)
    .reverse()
    .forEach((event, eventIndex) => {
      const pendingTurns = Array.isArray(event?.pending_turns) ? event.pending_turns : [];
      if (pendingTurns.length) {
        pendingTurns.forEach((turn: Record<string, unknown>, turnIndex: number) => {
          const speaker = typeof turn.speaker === "string" ? turn.speaker : "speaker";
          const text = typeof turn.content === "string" ? turn.content.trim() : "";
          if (!text) return;
          const startMs = typeof turn.timestamp_ms === "number" ? turn.timestamp_ms : Number(event?.update?.start_ms ?? 0);
          const endMs = typeof turn.timestamp_ms === "number" ? turn.timestamp_ms : Number(event?.update?.end_ms ?? startMs);
          rows.push(
            makeTranscriptHistoryItem(
              makeTranscriptTurn({
                speaker,
                text,
                start_ms: Number.isFinite(startMs) ? startMs : 0,
                end_ms: Number.isFinite(endMs) ? endMs : 0,
                is_final: true,
                source: "event_fallback",
                capture_mode: `event_${eventIndex}_${turnIndex}`,
              }),
              "event",
              `${eventIndex}_${turnIndex}`,
              Number.isFinite(endMs) ? endMs : Number.isFinite(startMs) ? startMs : undefined,
            ),
          );
        });
        return;
      }

      const transcriptText = typeof event?.update?.transcript_text === "string" ? event.update.transcript_text.trim() : "";
      if (!transcriptText) {
        return;
      }
      const startMs = Number(event?.update?.start_ms ?? 0) || 0;
      const endMs = Number(event?.update?.end_ms ?? event?.update?.start_ms ?? 0) || 0;
      rows.push(
        makeTranscriptHistoryItem(
          makeTranscriptTurn({
            speaker: "speaker",
            text: transcriptText,
            start_ms: startMs,
            end_ms: endMs,
            is_final: true,
            source: "event_fallback",
            capture_mode: `event_${eventIndex}`,
          }),
          "event",
          `${eventIndex}`,
          endMs || startMs || undefined,
        ),
      );
    });
  return rows.slice(0, 10);
}

function buildTranscriptHistoryFeed(params: {
  serverTurns: RealtimeTranscriptTurn[];
  eventTurns: TranscriptHistoryItem[];
  localTurns: TranscriptHistoryItem[];
}): TranscriptHistoryItem[] {
  const serverTurns = params.serverTurns.map((turn, index) =>
    makeTranscriptHistoryItem(turn, "server", `${index}`, turn.end_ms || turn.start_ms || undefined),
  );
  const merged = [...serverTurns, ...params.eventTurns, ...params.localTurns];
  const seen = new Set<string>();
  return merged
    .sort((left, right) => {
      if (right.observedAt !== left.observedAt) return right.observedAt - left.observedAt;
      if (right.end_ms !== left.end_ms) return right.end_ms - left.end_ms;
      return right.start_ms - left.start_ms;
    })
    .filter((item) => {
      const dedupeKey = [item.speaker, item.text, item.start_ms, item.end_ms].join("|");
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .slice(0, 10);
}

function buildTranscriptDisplayState(params: {
  liveTranscript: string;
  serverCurrentTurn: RealtimeTranscriptTurn | null;
  serverArchivedTurns: RealtimeTranscriptTurn[];
  fallbackTurns: TranscriptHistoryItem[];
  localTurns: TranscriptHistoryItem[];
}): TranscriptDisplayState {
  const hasLivePreview = Boolean(params.liveTranscript.trim());
  const stableTurns = buildTranscriptHistoryFeed({
    serverTurns: params.serverCurrentTurn
      ? [params.serverCurrentTurn, ...params.serverArchivedTurns]
      : params.serverArchivedTurns,
    eventTurns: params.fallbackTurns,
    localTurns: params.localTurns,
  });
  const activeTurn = hasLivePreview ? null : stableTurns[0] ?? null;

  return {
    activeTurn,
    archivedTurns: hasLivePreview ? stableTurns.slice(0, 10) : stableTurns.slice(1, 11),
  };
}

function buildTranscriptDownloadUrls(sessionId: string) {
  return {
    txt_url: apiUrl(`/api/v1/realtime/sessions/${sessionId}/transcript/download?fmt=txt`),
    markdown_url: apiUrl(`/api/v1/realtime/sessions/${sessionId}/transcript/download?fmt=markdown`),
  };
}

function sanitizeDownloadFileName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function downloadTextBlob(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

function downloadCurrentMermaidSvg(exportRootId: string, filename: string, missingMessage: string) {
  const root = document.querySelector<HTMLElement>(`[data-mermaid-export-root="${exportRootId}"]`);
  const svgElement = root?.querySelector("svg");
  if (!(svgElement instanceof SVGSVGElement)) {
    throw new Error(missingMessage);
  }
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  const serialized = new XMLSerializer().serializeToString(clone);
  const svgSource = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
  downloadTextBlob(filename, svgSource, "image/svg+xml");
}

function downloadAnnotationsSvg(filename: string, exportHostId: string, missingMessage: string) {
  const host = document.getElementById(exportHostId);
  const svg = host?.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error(missingMessage);
  }
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  // Strip pointer events to make it a clean asset.
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  const serialized = new XMLSerializer().serializeToString(clone);
  const svgSource = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
  downloadTextBlob(filename, svgSource, "image/svg+xml");
}

function formatApiTranscriptSegments(segments: Array<Record<string, any>> | null | undefined) {
  if (!segments?.length) return "";
  return segments
    .map((item) => {
      const text = String(item?.text || "").trim();
      if (!text) return "";
      const speaker = String(item?.speaker || "").trim();
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join("\n");
}

function preserveCoordinationSnapshot(
  nextPipeline: Record<string, any> | null | undefined,
  previousPipeline: Record<string, any> | null | undefined,
) {
  if (!nextPipeline) return previousPipeline ?? null;
  if (!previousPipeline) return nextPipeline;
  return {
    ...nextPipeline,
    gate_state: previousPipeline.gate_state ?? nextPipeline.gate_state ?? null,
    planner_state: previousPipeline.planner_state ?? nextPipeline.planner_state ?? null,
    mermaid_state: previousPipeline.mermaid_state ?? nextPipeline.mermaid_state ?? null,
    summary: previousPipeline.summary ?? nextPipeline.summary ?? null,
    coordination_summary: previousPipeline.coordination_summary ?? nextPipeline.coordination_summary ?? null,
  };
}

function backendLabel(backend: RecognitionBackend, language: LanguagePreference = "zh-CN") {
  switch (backend) {
    case "browser_speech":
      return t(language, "realtimeStudio.text006");
    case "browser_display_validation":
      return t(language, "realtimeStudio.text007");
    case "local_helper":
      return t(language, "realtimeStudio.text008");
    case "api_stt":
      return t(language, "realtimeStudio.backend.xfyunRtasr");
    default:
      return t(language, "realtimeStudio.text009");
  }
}

function backendStatusLabel(status: "idle" | "working" | "success" | "error", language: LanguagePreference = "zh-CN") {
  if (status === "working") return t(language, "realtimeStudio.text010");
  if (status === "success") return t(language, "realtimeStudio.text011");
  if (status === "error") return t(language, "realtimeStudio.text012");
  return t(language, "realtimeStudio.text013");
}

function backendStatusTone(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return "working";
  if (status === "idle") return "idle";
  if (status === "error") return "error";
  return "success";
}

function toLocalDateTimeLabel(value: string | null, language: LanguagePreference = "zh-CN") {
  if (!value) return t(language, "realtimeStudio.datetime.notGenerated");
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber).toLocaleString();
  }
  return value;
}

function logBrowserRuntime(label: string, payload: Record<string, unknown>, level: "info" | "warn" | "error" = "info") {
  if (typeof window === "undefined") return;
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  method(`[S2G][Realtime] ${label}`, payload);
}

function logAsrDiag(label: string, payload: Record<string, unknown>, level: "info" | "warn" | "error" = "info") {
  if (typeof window === "undefined") return;
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  method(`[S2G][ASR_DIAG] ${label}`, {
    at: new Date().toISOString(),
    ...payload,
  });
}

function summarizeAsrDiagnostics(diagnostics: Record<string, unknown> | null | undefined) {
  const diag = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const requestTotalMs = Number(diag.request_total_ms ?? 0) || 0;
  const sttWallMs = Number(diag.stt_wall_ms ?? 0) || 0;
  const sttReportedLatencyMs = Number(diag.stt_reported_latency_ms ?? 0) || 0;
  const postSttMs = Number(diag.pre_response_post_stt_ms ?? 0) || 0;
  const voiceprintMs = Number(diag.voiceprint_ms ?? 0) || 0;
  const ingestMs = Number(diag.ingest_ms ?? 0) || 0;
  const commitMs = Number(diag.commit_ms ?? 0) || 0;
  return {
    request_total_ms: requestTotalMs,
    stt_wall_ms: sttWallMs,
    stt_reported_latency_ms: sttReportedLatencyMs,
    post_stt_ms: postSttMs,
    voiceprint_ms: voiceprintMs,
    ingest_ms: ingestMs,
    commit_ms: commitMs,
    result_text_chars: Number(diag.result_text_chars ?? 0) || 0,
    result_segment_count: Number(diag.result_segment_count ?? 0) || 0,
    deferred_coordination: Boolean(diag.deferred_coordination),
    payload_audio_ms: Number(diag.payload_audio_ms ?? 0) || 0,
    stream_final: Boolean(diag.stream_final),
  };
}

function buildBackendOptions(
  source: InputSource,
  helperCapabilities: HelperCapabilities | null,
  language: LanguagePreference = "zh-CN",
): BackendOption[] {
  if (source === "transcript") {
    return [{ value: "manual" as const, label: t(language, "realtimeStudio.backendOption.manual") }];
  }
  if (source === "microphone_browser") {
    return [
      { value: "api_stt" as const, label: t(language, "realtimeStudio.backendOption.apiStt") },
      { value: "browser_speech" as const, label: t(language, "realtimeStudio.backendOption.browserSpeech") },
    ];
  }
  if (source === "system_audio_browser_experimental") {
    return [{ value: "browser_display_validation" as const, label: t(language, "realtimeStudio.backendOption.displayValidation") }];
  }
  const options = [
    { value: "api_stt" as const, label: t(language, "realtimeStudio.backendOption.apiStt") },
    {
      value: "local_helper" as const,
      label: t(language, "realtimeStudio.backendOption.localHelper"),
      disabled: helperCapabilities?.capability_status !== "supported",
    },
  ];
  return options;
}

function captureStatusLabel(status: "idle" | "capturing" | "uploading", language: LanguagePreference = "zh-CN") {
  if (status === "capturing") return t(language, "realtimeStudio.text014");
  if (status === "uploading") return t(language, "realtimeStudio.text015");
  return t(language, "realtimeStudio.text013");
}

function capabilityBadgeTone(status: string) {
  if (status === "supported") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "limited") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "unsupported") return "border-red-200 bg-red-50 text-red-700";
  return "";
}

function transcriptSpeakerCardTone(speaker: string | undefined) {
  const key = (speaker || "speaker").toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 9973;
  }
  const tones = [
    {
      card: "border-[#a7b3b0] bg-[#e8ecea]",
      speaker: "text-[#55615e]",
      body: "text-slate-800",
      style: { borderColor: "rgb(167 179 176 / 0.92)", backgroundColor: "rgb(232 236 234 / 0.95)" },
      contentStyle: { backgroundColor: "rgb(219 226 223 / 0.86)" },
      speakerTagStyle: { backgroundColor: "rgb(209 218 214 / 0.94)", borderColor: "rgb(156 170 165 / 0.88)" },
    },
    {
      card: "border-[#b7ad9f] bg-[#efe8dd]",
      speaker: "text-[#6a6055]",
      body: "text-slate-800",
      style: { borderColor: "rgb(183 173 159 / 0.92)", backgroundColor: "rgb(239 232 221 / 0.95)" },
      contentStyle: { backgroundColor: "rgb(229 220 206 / 0.86)" },
      speakerTagStyle: { backgroundColor: "rgb(220 209 194 / 0.94)", borderColor: "rgb(170 158 143 / 0.88)" },
    },
    {
      card: "border-[#aab0bf] bg-[#e7eaf1]",
      speaker: "text-[#575f73]",
      body: "text-slate-800",
      style: { borderColor: "rgb(170 176 191 / 0.92)", backgroundColor: "rgb(231 234 241 / 0.95)" },
      contentStyle: { backgroundColor: "rgb(218 223 235 / 0.86)" },
      speakerTagStyle: { backgroundColor: "rgb(206 213 228 / 0.94)", borderColor: "rgb(158 166 184 / 0.88)" },
    },
    {
      card: "border-[#b9a4aa] bg-[#efe5e8]",
      speaker: "text-[#6c565c]",
      body: "text-slate-800",
      style: { borderColor: "rgb(185 164 170 / 0.92)", backgroundColor: "rgb(239 229 232 / 0.95)" },
      contentStyle: { backgroundColor: "rgb(229 216 220 / 0.86)" },
      speakerTagStyle: { backgroundColor: "rgb(220 204 209 / 0.94)", borderColor: "rgb(173 149 156 / 0.88)" },
    },
    {
      card: "border-[#a9aba3] bg-[#eceee8]",
      speaker: "text-[#5c5f57]",
      body: "text-slate-800",
      style: { borderColor: "rgb(169 171 163 / 0.92)", backgroundColor: "rgb(236 238 232 / 0.95)" },
      contentStyle: { backgroundColor: "rgb(224 227 218 / 0.86)" },
      speakerTagStyle: { backgroundColor: "rgb(213 217 207 / 0.94)", borderColor: "rgb(157 160 150 / 0.88)" },
    },
  ] as const;
  return tones[hash % tones.length] ?? tones[0];
}

export function RealtimeStudio() {
  const queryClient = useQueryClient();
  const [language] = useLanguagePreference();
  const tr = (key: I18nKey, params?: Record<string, string | number>) => t(language, key, params);
  const currentDateLocale = dateLocale(language);
  const defaultSessionTitle = tr("realtimeStudio.session.defaultTitle");
  const defaultDemoTranscript = tr("realtimeStudio.demo.defaultTranscript");
  const [studioState, studioSend] = useMachine(realtimeStudioMachine);
  const [title, setTitle] = useState(defaultSessionTitle);
  const [titleDraft, setTitleDraft] = useState(defaultSessionTitle);
  const [isTitleEditing, setIsTitleEditing] = useState(false);
  const [datasetVersion, setDatasetVersion] = useState("");
  const [selectedTranscriptPresetId, setSelectedTranscriptPresetId] = useState("");
  const [transcriptText, setTranscriptText] = useState(defaultDemoTranscript);
  const previousDefaultTitleRef = useRef(defaultSessionTitle);
  const previousDefaultTranscriptRef = useRef(defaultDemoTranscript);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(null);
  const [localCommittedTranscriptTurns, setLocalCommittedTranscriptTurns] = useState<TranscriptHistoryItem[]>([]);
  const [closedSessionMeta, setClosedSessionMeta] = useState<{
    sessionId: string;
    downloads: { txt_url: string; markdown_url: string };
    transcriptSummary: Record<string, unknown>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  /** @description 历史侧栏内删除会话前的确认（替代原生 confirm） */
  const [deleteSessionConfirmId, setDeleteSessionConfirmId] = useState<string | null>(null);
  const [inputSourceMenuOpen, setInputSourceMenuOpen] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    setTitle((current) => (current === previousDefaultTitleRef.current ? defaultSessionTitle : current));
    setTitleDraft((current) => (current === previousDefaultTitleRef.current ? defaultSessionTitle : current));
    previousDefaultTitleRef.current = defaultSessionTitle;
    setTranscriptText((current) =>
      current === previousDefaultTranscriptRef.current ? defaultDemoTranscript : current,
    );
    previousDefaultTranscriptRef.current = defaultDemoTranscript;
  }, [defaultDemoTranscript, defaultSessionTitle]);
  useEffect(() => {
    if (!inputSourceMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!inputSourceMenuRef.current) return;
      if (!inputSourceMenuRef.current.contains(event.target as Node)) {
        setInputSourceMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [inputSourceMenuOpen]);
  /** @description 客户端挂载后再 portal，避免 SSR 访问 `document` */
  const [detailDrawerPortalReady, setDetailDrawerPortalReady] = useState(false);
  /** @description 主舞台 Tab，用于顶栏与「主图」徽章联动 */
  const [stageTab, setStageTab] = useState("mermaid");
  /** @description 实时转写面板内 Tab：当前字幕 / 历史转写 */
  const [transcriptPanelTab, setTranscriptPanelTab] = useState<"live" | "history">("live");
  const [annotationsEnabled, setAnnotationsEnabled] = useState(false);
  const [annotationsTool, setAnnotationsTool] = useState<AnnotationTool>("pen");
  const [activeAnnotationPanel, setActiveAnnotationPanel] = useState<"pen" | "rect" | "text" | "eraser" | null>(null);
  const [annotationPenWidth, setAnnotationPenWidth] = useState(2);
  const [annotationPenColor, setAnnotationPenColor] = useState<string>(DEFAULT_ANNOTATION_COLOR);
  const [annotationRectColor, setAnnotationRectColor] = useState<string>(DEFAULT_ANNOTATION_COLOR);
  const [annotationRectStrokeWidth, setAnnotationRectStrokeWidth] = useState(2);
  const [annotationTextColor, setAnnotationTextColor] = useState<string>(DEFAULT_ANNOTATION_COLOR);
  const [annotationEraserWidth, setAnnotationEraserWidth] = useState(12);
  const [annotationsState, setAnnotationsState] = useState<{
    version: number;
    payload: SessionAnnotationsPayload;
  }>({
    version: 1,
    payload: normalizeSessionAnnotationsPayload(null),
  });
  const annotationsUndoRef = useRef<Array<{ version: number; payload: SessionAnnotationsPayload }>>([]);
  const lastSavedAnnotationsRef = useRef<string>("");
  const lastLoadedSessionIdRef = useRef<string | null>(null);
  /** @description 工作台两页：第 1 页（输入来源 + 主图），第 2 页（会话与录音设置 + 默认设置） */
  const [studioPage] = useState<1 | 2>(1);
  const [selectedTimelineSnapshotId, setSelectedTimelineSnapshotId] = useState<string | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<RealtimeRollbackPreviewPayload | null>(null);
  const [autoFollowLatestTimelineNode, setAutoFollowLatestTimelineNode] = useState(true);
  const lastTimelineHeadSnapshotIdRef = useRef<string | null>(null);
  const timelineScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [timelineHoverTooltip, setTimelineHoverTooltip] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const timelinePreviewRequestRef = useRef<string | null>(null);
  const [listening, setListening] = useState(false);
  const [audioContext, setAudioContext] = useState<ClientAudioContext | null>(null);
  const recognitionRef = useRef<any>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const helperEventSourceRef = useRef<EventSource | null>(null);
  const helperChunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const microphoneMuteNodeRef = useRef<GainNode | null>(null);
  const helperStreamRef = useRef<MediaStream | null>(null);
  const helperAudioContextRef = useRef<AudioContext | null>(null);
  const helperSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const helperProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const helperMuteNodeRef = useRef<GainNode | null>(null);
  const helperUploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const helperSessionIdRef = useRef<string | null>(null);
  const helperChunkIdRef = useRef(0);
  const helperSegmentStateRef = useRef<AudioSegmentState>(createAudioSegmentState());
  const apiCaptureStreamRef = useRef<MediaStream | null>(null);
  const apiCaptureAudioContextRef = useRef<AudioContext | null>(null);
  const apiCaptureSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const apiCaptureProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const apiCaptureMuteNodeRef = useRef<GainNode | null>(null);
  const apiCaptureUploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const apiCaptureFlushPromiseRef = useRef<Promise<void> | null>(null);
  const apiCaptureFlushQueuedRef = useRef(false);
  const apiCaptureFlushTimeoutRef = useRef<number | null>(null);
  const apiCaptureChunkIdRef = useRef(0);
  const apiCaptureSegmentStateRef = useRef<AudioSegmentState>(createAudioSegmentState());
  const apiCaptureDiagRef = useRef({
    startedAtMs: 0,
    lastHeartbeatAtMs: 0,
    frameCount: 0,
    maxLevel: 0,
    uploadCount: 0,
  });
  const apiCaptureContextRef = useRef<{
    sessionId: string;
    source: InputSource;
    captureMode: CaptureMode;
    speaker: string;
  } | null>(null);
  const apiCaptureStopRequestedRef = useRef(false);
  const inputSourceMenuRef = useRef<HTMLDivElement | null>(null);
  const historyFeedKeysRef = useRef<string[]>([]);

  const selectedInputSource = studioState.context.selectedInputSource;
  const selectedRecognitionBackend = studioState.context.recognitionBackend;
  const activeCaptureSource = studioState.context.captureStatus !== "idle" ? selectedInputSource : null;
  const inputLevel = studioState.context.inputLevel;
  const liveTranscript = studioState.context.liveTranscript;
  const captureStatus = studioState.context.captureStatus;
  const sttStatus = studioState.context.sttStatus;
  const gateStatus = studioState.context.gateStatus;
  const plannerStatus = studioState.context.plannerStatus;
  const mermaidStatus = studioState.context.mermaidStatus;
  const machineError = studioState.context.error;
  const lastMermaidUpdatedAt = studioState.context.lastMermaidUpdatedAt;
  const stageTabs = useMemo(
    () =>
      [
        ["mermaid", tr("realtimeStudio.text016")],
        ["structure", tr("realtimeStudio.text017")],
        ["events", tr("realtimeStudio.text018")],
      ] as const,
    [language],
  );
  const activeStageTabIndex = Math.max(
    0,
    stageTabs.findIndex(([value]) => value === stageTab),
  );
  const stageTabCount = stageTabs.length;

  const authQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
  });
  const isAdmin = authQuery.isSuccess;
  const isUnauthorizedGuest =
    authQuery.isFetched &&
    authQuery.isError &&
    authQuery.error instanceof ApiError &&
    authQuery.error.status === 401;
  const workbenchDataReady = authQuery.isFetched && (isAdmin || isUnauthorizedGuest);

  const annotationsQuery = useQuery({
    queryKey: ["realtime-annotations", currentSessionId],
    enabled: Boolean(currentSessionId),
    queryFn: () => api.getRealtimeSessionAnnotations(currentSessionId as string),
    retry: false,
  });

  const saveAnnotationsMutation = useMutation({
    mutationFn: async (payload: { sessionId: string; doc: AnnotationDoc }) => {
      return api.putRealtimeSessionAnnotations(payload.sessionId, {
        version: payload.doc.version,
        payload: payload.doc.payload as unknown as Record<string, unknown>,
      });
    },
  });

  useEffect(() => {
    if (!currentSessionId) {
      lastLoadedSessionIdRef.current = null;
      return;
    }
    if (!annotationsQuery.isSuccess) return;
    if (lastLoadedSessionIdRef.current === currentSessionId) return;

    const nextPayload = normalizeSessionAnnotationsPayload(annotationsQuery.data.payload);
    const nextState = {
      version: typeof annotationsQuery.data.version === "number" ? annotationsQuery.data.version : 1,
      payload: nextPayload,
    };
    setAnnotationsState(nextState);
    annotationsUndoRef.current = [];
    lastSavedAnnotationsRef.current = JSON.stringify(nextPayload);
    lastLoadedSessionIdRef.current = currentSessionId;
  }, [annotationsQuery.data, annotationsQuery.isSuccess, currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) return;
    const payloadKey = JSON.stringify(annotationsState.payload || {});
    if (!payloadKey || payloadKey === lastSavedAnnotationsRef.current) return;

    const t = window.setTimeout(async () => {
      try {
        const res = await saveAnnotationsMutation.mutateAsync({
          sessionId: currentSessionId,
          doc: { version: annotationsState.version, payload: annotationsState.payload } as unknown as AnnotationDoc,
        });
        const savedPayload = normalizeSessionAnnotationsPayload((res as any).payload);
        lastSavedAnnotationsRef.current = JSON.stringify(savedPayload);
        setAnnotationsState((prev) => ({
          version: typeof (res as any).version === "number" ? (res as any).version : prev.version,
          payload: savedPayload,
        }));
      } catch {
        // keep local edits; error feedback is handled elsewhere
      }
    }, 900);

    return () => window.clearTimeout(t);
  }, [annotationsState, currentSessionId, saveAnnotationsMutation]);

  const onMermaidAnnotationsChange = (next: AnnotationDoc) => {
    setAnnotationsState((prev) => {
      annotationsUndoRef.current.push(structuredClone(prev));
      if (annotationsUndoRef.current.length > 40) annotationsUndoRef.current.shift();
      return {
        version: prev.version + 1,
        payload: { ...prev.payload, mermaid: next.payload },
      };
    });
  };

  const onStructureAnnotationsChange = (next: AnnotationDoc) => {
    setAnnotationsState((prev) => {
      annotationsUndoRef.current.push(structuredClone(prev));
      if (annotationsUndoRef.current.length > 40) annotationsUndoRef.current.shift();
      return {
        version: prev.version + 1,
        payload: { ...prev.payload, structure: next.payload },
      };
    });
  };

  const undoAnnotations = () => {
    const prev = annotationsUndoRef.current.pop();
    if (!prev) return;
    setAnnotationsState({ version: prev.version + 1, payload: prev.payload });
  };

  const clearAnnotations = () => {
    setAnnotationsState((prev) => {
      annotationsUndoRef.current.push(structuredClone(prev));
      if (annotationsUndoRef.current.length > 40) annotationsUndoRef.current.shift();
      const key = stageTab === "structure" ? "structure" : "mermaid";
      return {
        version: prev.version + 1,
        payload: {
          ...prev.payload,
          [key]: { items: [], maskStrokes: [] },
        },
      };
    });
  };

  const mermaidAnnotationsDoc = useMemo(
    (): AnnotationDoc => ({
      version: annotationsState.version,
      payload: annotationsState.payload.mermaid,
    }),
    [annotationsState.version, annotationsState.payload.mermaid],
  );

  const structureAnnotationsDoc = useMemo(
    (): AnnotationDoc => ({
      version: annotationsState.version,
      payload: annotationsState.payload.structure,
    }),
    [annotationsState.version, annotationsState.payload.structure],
  );

  const activeAnnotationPayload =
    stageTab === "structure" ? annotationsState.payload.structure : annotationsState.payload.mermaid;
  const activeAnnotationEmpty =
    (activeAnnotationPayload.items?.length ?? 0) === 0 &&
    normalizeMaskStrokes(activeAnnotationPayload).length === 0;

  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: api.listDatasets,
    enabled: workbenchDataReady,
    retry: false,
  });
  const runtimeOptions = useQuery({
    queryKey: ["runtime-options"],
    queryFn: api.listRuntimeOptions,
    enabled: workbenchDataReady,
    retry: false,
  });
  const adminRuntimeOptions = useQuery({
    queryKey: ["admin-runtime-options"],
    queryFn: api.getAdminRuntimeOptions,
    enabled: isAdmin,
    retry: false,
  });
  const sessions = useQuery({
    queryKey: ["realtime-sessions"],
    queryFn: api.listRealtimeSessions,
    enabled: workbenchDataReady,
    retry: false,
  });
  const helperCapabilitiesQuery = useQuery({
    queryKey: ["audio-helper-capabilities"],
    queryFn: audioHelper.capabilities,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: supportsHelperSystemAudioUi(audioContext),
  });

  useEffect(() => {
    setAudioContext(detectClientAudioContext());
  }, []);

  useEffect(() => {
    setDetailDrawerPortalReady(true);
  }, []);

  useEffect(() => {
    if (!detailDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (deleteSessionConfirmId) return;
      setDetailDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailDrawerOpen, deleteSessionConfirmId]);

  useEffect(() => {
    if (!deleteSessionConfirmId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDeleteSessionConfirmId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSessionConfirmId]);

  useEffect(() => {
    if (!datasetVersion && datasets.data?.length) {
      setDatasetVersion(datasets.data.find((item) => item.is_default)?.slug || datasets.data[0].slug);
    }
  }, [datasetVersion, datasets.data]);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCAL_SESSION_KEY);
    if (stored) setCurrentSessionId(stored);
  }, []);

  const inputOptions = useMemo(() => getInputSourceOptions(audioContext, language), [audioContext, language]);
  const selectedOption = useMemo<InputSourceOption>(() => {
    return inputOptions.find((item) => item.source === selectedInputSource) || inputOptions[0];
  }, [inputOptions, selectedInputSource]);
  const helperCapabilities = helperCapabilitiesQuery.data ?? null;
  const helperAvailable = Boolean(helperCapabilities);
  const backendOptions = useMemo(
    () => buildBackendOptions(selectedInputSource, helperCapabilities, language),
    [helperCapabilities, language, selectedInputSource],
  );
  const [gateProfileId, setGateProfileId] = useState("");
  const [gateModel, setGateModel] = useState("");
  const [plannerProfileId, setPlannerProfileId] = useState("");
  const [plannerModel, setPlannerModel] = useState("");
  const [sttProfileId, setSttProfileId] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [diagramMode, setDiagramMode] = useState("mermaid_primary");
  const preferencesInitializedRef = useRef(false);
  const selectedGateProfile = runtimeOptions.data?.gate_profiles.find((item) => item.id === gateProfileId) ?? null;
  const selectedPlannerProfile =
    runtimeOptions.data?.planner_profiles.find((item) => item.id === plannerProfileId) ?? null;
  const selectedSttProfile = runtimeOptions.data?.stt_profiles.find((item) => item.id === sttProfileId) ?? null;
  const effectiveError = error ?? machineError;
  const currentSession = useMemo(
    () => sessions.data?.find((item) => item.session_id === currentSessionId) ?? null,
    [currentSessionId, sessions.data],
  );
  const timelineQuery = useQuery({
    queryKey: ["realtime-timeline", currentSessionId],
    queryFn: () => api.listRealtimeTimeline(currentSessionId || ""),
    enabled: Boolean(currentSessionId),
    staleTime: 5_000,
    retry: false,
  });
  const timelineNodes = timelineQuery.data?.session_id === currentSessionId ? timelineQuery.data.nodes : [];
  const orderedTimelineNodes = useMemo(() => [...timelineNodes].reverse(), [timelineNodes]);
  const selectedTimelineNode = useMemo(
    () => timelineNodes.find((node) => node.snapshot_id === selectedTimelineSnapshotId) ?? null,
    [selectedTimelineSnapshotId, timelineNodes],
  );
  const selectedTimelineOrderedIndex = useMemo(
    () => orderedTimelineNodes.findIndex((node) => node.snapshot_id === selectedTimelineSnapshotId),
    [orderedTimelineNodes, selectedTimelineSnapshotId],
  );
  const TIMELINE_MAX_VISIBLE_NODES = 7;
  const TIMELINE_DRAG_THRESHOLD = 8;
  const isTimelineScrollable = orderedTimelineNodes.length >= TIMELINE_DRAG_THRESHOLD;
  const timelineScrollStep =
    timelineViewportWidth > 0
      ? Math.max(34, (timelineViewportWidth - 12) / Math.max(1, TIMELINE_MAX_VISIBLE_NODES - 1))
      : 42;
  const timelineScrollableTrackWidth = Math.max(
    timelineViewportWidth,
    12 + timelineScrollStep * Math.max(0, orderedTimelineNodes.length - 1),
  );
  const timelineScrollableSelectedLeft =
    selectedTimelineOrderedIndex >= 0 ? 6 + selectedTimelineOrderedIndex * timelineScrollStep : null;
  const rollbackPreviewMermaidCode = useMemo(() => {
    if (!rollbackPreview?.pipeline || typeof rollbackPreview.pipeline !== "object") return "";
    const mermaidState = rollbackPreview.pipeline.mermaid_state;
    if (!mermaidState || typeof mermaidState !== "object") return "";
    const code =
      typeof (mermaidState as Record<string, unknown>).code === "string"
        ? String((mermaidState as Record<string, unknown>).code)
        : typeof (mermaidState as Record<string, unknown>).normalized_code === "string"
          ? String((mermaidState as Record<string, unknown>).normalized_code)
          : "";
    return code.trim();
  }, [rollbackPreview]);
  const currentSessionClosed =
    currentSession?.status === "closed" || closedSessionMeta?.sessionId === currentSessionId;

  useEffect(() => {
    const latestSnapshotId = timelineNodes[0]?.snapshot_id ?? null;
    if (!latestSnapshotId) {
      setSelectedTimelineSnapshotId(null);
      setRollbackPreview(null);
      lastTimelineHeadSnapshotIdRef.current = null;
      return;
    }
    const latestChanged = latestSnapshotId !== lastTimelineHeadSnapshotIdRef.current;
    lastTimelineHeadSnapshotIdRef.current = latestSnapshotId;
    if (!selectedTimelineSnapshotId || !timelineNodes.some((node) => node.snapshot_id === selectedTimelineSnapshotId)) {
      setSelectedTimelineSnapshotId(latestSnapshotId);
      setAutoFollowLatestTimelineNode(true);
      return;
    }
    if (autoFollowLatestTimelineNode && latestChanged && selectedTimelineSnapshotId !== latestSnapshotId) {
      setSelectedTimelineSnapshotId(latestSnapshotId);
    }
  }, [autoFollowLatestTimelineNode, selectedTimelineSnapshotId, timelineNodes]);

  useEffect(() => {
    if (!currentSessionId || !selectedTimelineSnapshotId) return;
    if (!timelineNodes.some((node) => node.snapshot_id === selectedTimelineSnapshotId)) return;
    rollbackPreviewMutation.mutate({ sessionId: currentSessionId, snapshotId: selectedTimelineSnapshotId });
  }, [currentSessionId, selectedTimelineSnapshotId, timelineNodes]);

  useEffect(() => {
    const target = timelineScrollViewportRef.current;
    if (!target) return;
    const update = () => setTimelineViewportWidth(target.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [isTimelineScrollable]);

  useEffect(() => {
    if (!isTimelineScrollable) return;
    const target = timelineScrollViewportRef.current;
    if (!target) return;
    const onScroll = () => setTimelineScrollLeft(target.scrollLeft);
    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [isTimelineScrollable]);

  useEffect(() => {
    if (!effectiveError) return;
    const t = window.setTimeout(() => {
      setError(null);
      studioSend({ type: "error.clear" });
    }, 3500);
    return () => window.clearTimeout(t);
  }, [effectiveError, studioSend]);

  useEffect(() => {
    if (!inputOptions.some((item) => item.source === selectedInputSource)) {
      studioSend({ type: "source.select", source: "transcript", backend: "manual" });
    }
  }, [inputOptions, selectedInputSource, studioSend]);

  useEffect(() => {
    if (!backendOptions.some((item) => item.value === selectedRecognitionBackend && !item.disabled)) {
      const fallback = backendOptions.find((item) => !item.disabled) || backendOptions[0];
      studioSend({ type: "backend.select", backend: fallback.value });
    }
  }, [backendOptions, selectedRecognitionBackend, studioSend]);

  useEffect(() => {
    const payload = runtimeOptions.data;
    if (!payload || preferencesInitializedRef.current) return;
    const resolved = resolveRuntimePreferences(payload, loadRuntimePreferences());
    setGateProfileId(resolved.gateProfileId);
    setGateModel(resolved.gateModel);
    setPlannerProfileId(resolved.plannerProfileId);
    setPlannerModel(resolved.plannerModel);
    setSttProfileId(resolved.sttProfileId);
    setSttModel(resolved.sttModel);
    setDiagramMode(resolved.diagramMode);
    preferencesInitializedRef.current = true;
  }, [runtimeOptions.data]);

  useEffect(() => {
    if (!selectedGateProfile) return;
    if (!selectedGateProfile.models.includes(gateModel)) {
      setGateModel(selectedGateProfile.default_model || selectedGateProfile.models[0] || "");
    }
  }, [gateModel, selectedGateProfile]);

  useEffect(() => {
    if (!runtimeOptions.data?.gate_profiles.length) return;
    if (!selectedGateProfile) {
      const fallback = runtimeOptions.data.gate_profiles[0];
      setGateProfileId(fallback.id);
      setGateModel(fallback.default_model || fallback.models[0] || "");
    }
  }, [runtimeOptions.data, selectedGateProfile]);

  useEffect(() => {
    if (!selectedPlannerProfile) return;
    if (!selectedPlannerProfile.models.includes(plannerModel)) {
      setPlannerModel(selectedPlannerProfile.default_model || selectedPlannerProfile.models[0] || "");
    }
  }, [plannerModel, selectedPlannerProfile]);

  useEffect(() => {
    if (!runtimeOptions.data?.planner_profiles.length) return;
    if (!selectedPlannerProfile) {
      const fallback = runtimeOptions.data.planner_profiles[0];
      setPlannerProfileId(fallback.id);
      setPlannerModel(fallback.default_model || fallback.models[0] || "");
    }
  }, [runtimeOptions.data, selectedPlannerProfile]);

  useEffect(() => {
    if (!selectedSttProfile) return;
    if (!selectedSttProfile.models.includes(sttModel)) {
      setSttModel(selectedSttProfile.default_model || selectedSttProfile.models[0] || "");
    }
  }, [selectedSttProfile, sttModel]);

  useEffect(() => {
    if (!runtimeOptions.data?.stt_profiles.length) return;
    if (!selectedSttProfile) {
      const fallback = runtimeOptions.data.stt_profiles[0];
      setSttProfileId(fallback.id);
      setSttModel(fallback.default_model || fallback.models[0] || "");
    }
  }, [runtimeOptions.data, selectedSttProfile]);

  useEffect(() => {
    if (!preferencesInitializedRef.current) return;
    saveRuntimePreferences({
      gateProfileId,
      gateModel,
      plannerProfileId,
      plannerModel,
      sttProfileId,
      sttModel,
      diagramMode: diagramMode === "dual_view" ? "dual_view" : "mermaid_primary",
    });
  }, [diagramMode, gateModel, gateProfileId, plannerModel, plannerProfileId, sttModel, sttProfileId]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop?.();
      void teardownMicrophoneAudioGraph();
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      helperEventSourceRef.current?.close();
      void teardownHelperAudioGraph();
      void teardownApiCaptureGraph();
      void audioHelper.stopCapture().catch(() => undefined);
    };
    // Cleanup only on unmount; teardown helpers are intentionally not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedInputSource !== "microphone_browser" || selectedRecognitionBackend !== "browser_speech") {
      recognitionRef.current?.stop?.();
      setListening(false);
      void teardownMicrophoneAudioGraph();
    }
    if (
      selectedInputSource !== "system_audio_browser_experimental" ||
      selectedRecognitionBackend !== "browser_display_validation"
    ) {
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      displayStreamRef.current = null;
      if (activeCaptureSource === "system_audio_browser_experimental") {
        studioSend({ type: "capture.stop" });
      }
    }
    if (
      (selectedInputSource !== "system_audio_helper" || selectedRecognitionBackend !== "local_helper") &&
      activeCaptureSource === "system_audio_helper" &&
      apiCaptureContextRef.current?.source !== "system_audio_helper"
    ) {
      helperEventSourceRef.current?.close();
      helperEventSourceRef.current = null;
      void teardownHelperAudioGraph();
      void audioHelper.stopCapture().catch(() => undefined);
      studioSend({ type: "capture.stop" });
    }
    if (
      selectedRecognitionBackend !== "api_stt" ||
      (selectedInputSource !== "microphone_browser" && selectedInputSource !== "system_audio_helper")
    ) {
      void teardownApiCaptureGraph();
    }
    // Runtime capture cleanup only depends on input mode transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCaptureSource, selectedInputSource, selectedRecognitionBackend]);

  function clearFeedback() {
    setError(null);
    setNotice(null);
    studioSend({ type: "error.clear" });
  }

  function currentClientContext() {
    return buildRealtimeClientContext({
      selectedSource: selectedInputSource,
      context: audioContext,
      capabilityStatus:
        selectedInputSource === "system_audio_helper" && helperCapabilities
          ? helperCapabilities.capability_status
          : selectedOption.capability_status,
      capabilityReason:
        selectedInputSource === "system_audio_helper" && helperCapabilities
          ? helperCapabilities.capability_reason
          : selectedOption.capability_reason,
      helperAvailable,
    });
  }

  function buildChunkMetadata(source: InputSource, captureMode: CaptureMode) {
    return {
      ...currentClientContext(),
      input_source: source,
      capture_mode: captureMode,
      helper_url: audioHelper.baseUrl,
      transcription_backend: selectedRecognitionBackend,
      gate_profile_id: gateProfileId,
      gate_model: gateModel,
      planner_profile_id: plannerProfileId,
      planner_model: plannerModel,
      stt_profile_id: sttProfileId,
      stt_model: sttModel,
    };
  }

  function resetHelperAudioBuffers() {
    helperSegmentStateRef.current = createAudioSegmentState();
    helperChunkIdRef.current = 0;
  }

  async function teardownMicrophoneAudioGraph() {
    microphoneProcessorNodeRef.current?.disconnect();
    microphoneSourceNodeRef.current?.disconnect();
    microphoneMuteNodeRef.current?.disconnect();
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneProcessorNodeRef.current = null;
    microphoneSourceNodeRef.current = null;
    microphoneMuteNodeRef.current = null;
    microphoneStreamRef.current = null;
    if (microphoneAudioContextRef.current) {
      await microphoneAudioContextRef.current.close().catch(() => undefined);
      microphoneAudioContextRef.current = null;
    }
    studioSend({ type: "audio.level", level: 0 });
  }

  async function startMicrophoneAudioGraph() {
    const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new window.AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(2048, sourceNode.channelCount || 1, 1);
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      const level = calculateAudioLevel(channel);
      studioSend({ type: "audio.level", level });
    };

    sourceNode.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);

    microphoneStreamRef.current = stream;
    microphoneAudioContextRef.current = audioContext;
    microphoneSourceNodeRef.current = sourceNode;
    microphoneProcessorNodeRef.current = processor;
    microphoneMuteNodeRef.current = muteNode;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  async function uploadHelperAudioFrame(samples: Float32Array, isFinal = true) {
    if (!helperSessionIdRef.current || !samples.length) return;

    const payload = {
      source_type: "system_audio_helper",
      session_id: helperSessionIdRef.current,
      chunk_id: helperChunkIdRef.current,
      sample_rate: HELPER_TARGET_SAMPLE_RATE,
      channel_count: 1,
      pcm_s16le_base64: encodeFloat32ToBase64Pcm16(samples),
      timestamp_ms: Date.now(),
      is_final: isFinal,
    };
    helperChunkIdRef.current += 1;
    helperUploadQueueRef.current = helperUploadQueueRef.current.then(async () => {
      await audioHelper.uploadAudioChunk(payload);
    });
    await helperUploadQueueRef.current;
  }

  function syncPipelineStatus(pipeline: Record<string, any> | null | undefined) {
    logBrowserRuntime("pipeline snapshot", {
      coordination_summary: pipeline?.coordination_summary ?? null,
      gate_state: pipeline?.gate_state ?? null,
      planner_state: pipeline?.planner_state ?? null,
      mermaid_state: pipeline?.mermaid_state
        ? {
            provider: pipeline.mermaid_state.provider,
            model: pipeline.mermaid_state.model,
            updated_at: pipeline.mermaid_state.updated_at,
            error_message: pipeline.mermaid_state.error_message,
          }
        : null,
      event_count: Array.isArray(pipeline?.events) ? pipeline.events.length : 0,
    });
    const gateState = pipeline?.gate_state ?? null;
    if (!gateState) {
      studioSend({ type: "gate.error", message: tr("realtimeStudio.pipeline.noGateState") });
    } else if (gateState.error_message) {
      studioSend({ type: "gate.error", message: String(gateState.error_message) });
    } else {
      studioSend({ type: "gate.success" });
    }

    const plannerState = pipeline?.planner_state ?? null;
    if (!plannerState) {
      studioSend({ type: "planner.error", message: tr("realtimeStudio.pipeline.noPlannerState") });
    } else if (plannerState.error_message) {
      studioSend({ type: "planner.error", message: String(plannerState.error_message) });
    } else {
      studioSend({ type: "planner.success" });
    }

    const mermaidState = pipeline?.mermaid_state ?? null;
    const updatedAt = mermaidState?.updated_at ? toLocalDateTimeLabel(String(mermaidState.updated_at), language) : null;
    if (!mermaidState) {
      studioSend({ type: "mermaid.error", message: tr("realtimeStudio.pipeline.noMermaidState"), updatedAt });
      return;
    }
    if (mermaidState.error_message) {
      studioSend({ type: "mermaid.error", message: String(mermaidState.error_message), updatedAt });
      return;
    }
    studioSend({ type: "mermaid.success", updatedAt });
  }

  async function flushHelperAudioBuffer(isFinal = true) {
    const state = helperSegmentStateRef.current;
    if (!state.activeSampleCount) return;
    const merged = mergeSegmentFrames(state.activeFrames, state.activeSampleCount);
    helperSegmentStateRef.current = createAudioSegmentState();
    await uploadHelperAudioFrame(merged, isFinal);
  }

  async function teardownHelperAudioGraph({ flush = false }: { flush?: boolean } = {}) {
    if (flush) {
      try {
        await flushHelperAudioBuffer(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : tr("realtimeStudio.error.finalAudioSendFailed"));
      }
    } else {
      resetHelperAudioBuffers();
    }

    helperProcessorNodeRef.current?.disconnect();
    helperSourceNodeRef.current?.disconnect();
    helperMuteNodeRef.current?.disconnect();
    helperStreamRef.current?.getTracks().forEach((track) => track.stop());
    helperProcessorNodeRef.current = null;
    helperSourceNodeRef.current = null;
    helperMuteNodeRef.current = null;
    helperStreamRef.current = null;
    helperSessionIdRef.current = null;
    studioSend({ type: "audio.level", level: 0 });

    if (helperAudioContextRef.current) {
      await helperAudioContextRef.current.close().catch(() => undefined);
      helperAudioContextRef.current = null;
    }
  }

  async function startHelperAudioBridge(stream: MediaStream, sessionId: string) {
    helperSessionIdRef.current = sessionId;
    resetHelperAudioBuffers();

    const audioContext = new window.AudioContext({ sampleRate: HELPER_TARGET_SAMPLE_RATE });
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, sourceNode.channelCount || 2, 1);
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const frameCount = input.length;
      const merged = new Float32Array(frameCount);
      const channelCount = Math.max(1, input.numberOfChannels);
      for (let frame = 0; frame < frameCount; frame += 1) {
        let total = 0;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          total += input.getChannelData(channelIndex)[frame] || 0;
        }
        merged[frame] = total / channelCount;
      }

      const level = calculateAudioLevel(merged);
      studioSend({ type: "audio.level", level });
      const action = pushAudioSegmentFrame(helperSegmentStateRef.current, merged, level, HELPER_TARGET_SAMPLE_RATE);
      if (action === "soft_flush") {
        void flushHelperAudioBuffer(false);
      } else if (action === "final_flush") {
        void flushHelperAudioBuffer(true);
      }
    };

    const handleEnded = () => {
      void stopHelperCapture(tr("realtimeStudio.notice.helperShareEnded"));
    };
    stream.getTracks().forEach((track) => track.addEventListener("ended", handleEnded));

    sourceNode.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);

    helperAudioContextRef.current = audioContext;
    helperSourceNodeRef.current = sourceNode;
    helperProcessorNodeRef.current = processor;
    helperMuteNodeRef.current = muteNode;
    helperStreamRef.current = stream;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  function resetApiCaptureBuffers() {
    apiCaptureSegmentStateRef.current = createAudioSegmentState();
    apiCaptureChunkIdRef.current = 0;
    apiCaptureDiagRef.current.frameCount = 0;
    apiCaptureDiagRef.current.maxLevel = 0;
    apiCaptureDiagRef.current.uploadCount = 0;
  }

  async function uploadApiAudioFrame(samples: Float32Array, isFinal = true) {
    const context = apiCaptureContextRef.current;
    if (!context || !samples.length) return;

    const uploadStartedAt = performance.now();
    studioSend({ type: "capture.uploading" });
    studioSend({ type: "stt.working" });

    const chunkId = apiCaptureChunkIdRef.current;
    apiCaptureChunkIdRef.current += 1;
    apiCaptureDiagRef.current.uploadCount += 1;

    try {
      logAsrDiag("upload request started", {
        session_id: context.sessionId,
        source: context.source,
        capture_mode: context.captureMode,
        chunk_id: chunkId,
        upload_index: apiCaptureDiagRef.current.uploadCount,
        sample_count: samples.length,
        audio_ms: Math.round((samples.length / HELPER_TARGET_SAMPLE_RATE) * 1000),
        is_final: isFinal,
      });
      logBrowserRuntime("api_stt upload started", {
        session_id: context.sessionId,
        source: context.source,
        capture_mode: context.captureMode,
        chunk_id: chunkId,
        sample_count: samples.length,
        is_final: isFinal,
      });
      const response = await api.transcribeRealtimeAudio(context.sessionId, {
        chunk_id: chunkId,
        sample_rate: HELPER_TARGET_SAMPLE_RATE,
        channel_count: 1,
        pcm_s16le_base64: encodeFloat32ToBase64Pcm16(samples),
        timestamp_ms: Date.now(),
        is_final: isFinal,
        speaker: context.speaker,
        metadata: buildChunkMetadata(context.source, context.captureMode),
      });
      const shouldPreserveCoordination = !isFinal;
      setSnapshot((previous) => ({
        session_id: context.sessionId,
        pipeline: shouldPreserveCoordination
          ? preserveCoordinationSnapshot(response.pipeline, previous?.pipeline)
          : response.pipeline,
        evaluation: response.evaluation,
      }));
      const segmentedPreview = formatApiTranscriptSegments(response.segments);
      const previewText = segmentedPreview || response.text.trim();
      if (previewText) {
        const labeledText =
          segmentedPreview || (response.speaker ? `${response.speaker}: ${response.text.trim()}` : response.text.trim());
        studioSend({ type: "transcript.preview", text: labeledText });
        studioSend({ type: "stt.success", text: labeledText });
      }
      if (isFinal) {
        const segmentTurns =
          Array.isArray(response.segments) && response.segments.length
            ? response.segments
                .map((segment) => {
                  const text = String(segment?.text || "").trim();
                  if (!text) return null;
                  return makeTranscriptTurn({
                    speaker: String(segment?.speaker || response.speaker || context.speaker || "speaker"),
                    text,
                    start_ms: Number(segment?.start_ms ?? 0) || 0,
                    end_ms: Number(segment?.end_ms ?? segment?.start_ms ?? 0) || 0,
                    is_final: true,
                    source: context.source,
                    capture_mode: context.captureMode,
                  });
                })
                .filter((row): row is RealtimeTranscriptTurn => Boolean(row))
            : [];
        if (segmentTurns.length) {
          pushLocalCommittedTurns(segmentTurns.reverse());
        } else if (response.text.trim()) {
          pushLocalCommittedTurns([
            makeTranscriptTurn({
              speaker: response.speaker || context.speaker || "speaker",
              text: response.text.trim(),
              start_ms: 0,
              end_ms: 0,
              is_final: true,
              source: context.source,
              capture_mode: context.captureMode,
            }),
          ]);
        }
      }
      logBrowserRuntime("api_stt upload completed", {
        session_id: context.sessionId,
        provider: response.provider,
        model: response.model,
        latency_ms: response.latency_ms,
        speaker: response.speaker,
        text: response.text,
        segments: response.segments ?? null,
        voiceprint: response.voiceprint ?? null,
      });
      const responseHasText = Boolean(response.text.trim()) || (response.segments?.length ?? 0) > 0;
      const diagSummary = summarizeAsrDiagnostics(response.diagnostics);
      const requestMs = Math.round(performance.now() - uploadStartedAt);
      logAsrDiag(
        responseHasText ? "upload response with text" : "upload response empty",
        {
          session_id: context.sessionId,
          chunk_id: chunkId,
          request_ms: requestMs,
          backend_latency_ms: response.latency_ms,
          provider: response.provider,
          model: response.model,
          is_final: isFinal,
          text_chars: response.text.trim().length,
          segment_count: response.segments?.length ?? 0,
          speaker: response.speaker,
          voiceprint_mode: response.voiceprint?.mode ?? null,
          request_url: apiUrl(`/api/v1/realtime/sessions/${context.sessionId}/audio/transcriptions`),
          browser_proxy_mode: process.env.NEXT_PUBLIC_API_BROWSER_PROXY === "0" ? "direct_api" : "next_rewrite_proxy",
          backend_request_total_ms: diagSummary.request_total_ms,
          backend_stt_wall_ms: diagSummary.stt_wall_ms,
          backend_stt_reported_latency_ms: diagSummary.stt_reported_latency_ms,
          backend_post_stt_ms: diagSummary.post_stt_ms,
          backend_voiceprint_ms: diagSummary.voiceprint_ms,
          backend_ingest_ms: diagSummary.ingest_ms,
          backend_commit_ms: diagSummary.commit_ms,
          browser_minus_backend_ms:
            diagSummary.request_total_ms > 0 ? Math.max(0, requestMs - diagSummary.request_total_ms) : null,
          backend_minus_stt_ms:
            diagSummary.request_total_ms > 0
              ? Math.max(0, diagSummary.request_total_ms - diagSummary.stt_reported_latency_ms)
              : null,
          diagnostics_json: JSON.stringify(diagSummary),
          diagnostics: response.diagnostics ?? {},
        },
        responseHasText ? "info" : "warn",
      );
      if (response.voiceprint?.mode === "feature_split") {
        setNotice({
          tone: "success",
          text: tr("realtimeStudio.notice.voiceprintFeatureSplit"),
        });
      } else if (response.voiceprint?.mode === "blind_split") {
        setNotice({
          tone: "info",
          text: tr("realtimeStudio.notice.voiceprintBlindSplit"),
        });
      } else if (response.voiceprint?.matched) {
        setNotice({
          tone: "success",
          text: tr("realtimeStudio.notice.voiceprintMatched", { speaker: response.speaker || "" }),
        });
      } else if (response.voiceprint?.error_message) {
        setNotice({
          tone: "warning",
          text: tr("realtimeStudio.notice.voiceprintFailed", { message: response.voiceprint.error_message }),
        });
      }
      if (isFinal) {
        syncPipelineStatus(response.pipeline);
      }
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      if (!isFinal && chunkId % 2 === 1) {
        requestApiCaptureFlush(context.sessionId);
      }
      if (apiCaptureStopRequestedRef.current || apiCaptureContextRef.current !== context) {
        return;
      }
      studioSend({ type: "capture.start" });
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : tr("realtimeStudio.error.apiSttUploadFailed");
      logAsrDiag(
        "upload request failed",
        {
          session_id: context.sessionId,
          source: context.source,
          capture_mode: context.captureMode,
          chunk_id: chunkId,
          request_ms: Math.round(performance.now() - uploadStartedAt),
          error: message,
        },
        "error",
      );
      logBrowserRuntime(
        "api_stt upload failed",
        {
          session_id: context.sessionId,
          source: context.source,
          capture_mode: context.captureMode,
          error: message,
        },
        "error",
      );
      studioSend({ type: "stt.error", message });
      setError(message);
      studioSend({ type: "capture.stop" });
      throw err;
    }
  }

  async function flushApiCaptureBuffer(isFinal = true, reason = "manual") {
    const state = apiCaptureSegmentStateRef.current;
    if (!state.activeSampleCount) {
      logAsrDiag(
        "flush skipped empty buffer",
        {
          reason,
          is_final: isFinal,
        },
        "warn",
      );
      return;
    }
    const merged = mergeSegmentFrames(state.activeFrames, state.activeSampleCount);
    logAsrDiag("flush queued", {
      reason,
      is_final: isFinal,
      sample_count: merged.length,
      audio_ms: Math.round((merged.length / HELPER_TARGET_SAMPLE_RATE) * 1000),
      ...audioSegmentDiag(state, HELPER_TARGET_SAMPLE_RATE),
    });
    apiCaptureSegmentStateRef.current = createAudioSegmentState();
    apiCaptureUploadQueueRef.current = apiCaptureUploadQueueRef.current.then(() => uploadApiAudioFrame(merged, isFinal));
    await apiCaptureUploadQueueRef.current;
  }

  async function teardownApiCaptureGraph({ flush = false }: { flush?: boolean } = {}) {
    apiCaptureStopRequestedRef.current = true;
    if (apiCaptureFlushTimeoutRef.current !== null) {
      window.clearTimeout(apiCaptureFlushTimeoutRef.current);
      apiCaptureFlushTimeoutRef.current = null;
    }
    apiCaptureFlushQueuedRef.current = false;
    if (flush) {
      try {
        await flushApiCaptureBuffer(true, "teardown");
      } catch {
        // keep last surfaced STT error
      }
    } else {
      resetApiCaptureBuffers();
    }

    apiCaptureProcessorNodeRef.current?.disconnect();
    apiCaptureSourceNodeRef.current?.disconnect();
    apiCaptureMuteNodeRef.current?.disconnect();
    apiCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
    apiCaptureProcessorNodeRef.current = null;
    apiCaptureSourceNodeRef.current = null;
    apiCaptureMuteNodeRef.current = null;
    apiCaptureStreamRef.current = null;
    apiCaptureContextRef.current = null;
    studioSend({ type: "audio.level", level: 0 });

    if (apiCaptureAudioContextRef.current) {
      await apiCaptureAudioContextRef.current.close().catch(() => undefined);
      apiCaptureAudioContextRef.current = null;
    }
  }

  async function startApiCaptureBridge(
    stream: MediaStream,
    payload: {
      sessionId: string;
      source: InputSource;
      captureMode: CaptureMode;
      speaker: string;
    },
  ) {
    apiCaptureStopRequestedRef.current = false;
    apiCaptureContextRef.current = payload;
    resetApiCaptureBuffers();
    apiCaptureDiagRef.current.startedAtMs = performance.now();
    apiCaptureDiagRef.current.lastHeartbeatAtMs = apiCaptureDiagRef.current.startedAtMs;
    apiCaptureUploadQueueRef.current = Promise.resolve();
    apiCaptureFlushPromiseRef.current = null;
    apiCaptureFlushQueuedRef.current = false;
    if (apiCaptureFlushTimeoutRef.current !== null) {
      window.clearTimeout(apiCaptureFlushTimeoutRef.current);
      apiCaptureFlushTimeoutRef.current = null;
    }

    const audioContext = new window.AudioContext({ sampleRate: HELPER_TARGET_SAMPLE_RATE });
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, sourceNode.channelCount || 2, 1);
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;
    logAsrDiag("capture bridge started", {
      session_id: payload.sessionId,
      source: payload.source,
      capture_mode: payload.captureMode,
      audio_context_sample_rate: audioContext.sampleRate,
      target_sample_rate: HELPER_TARGET_SAMPLE_RATE,
      input_channel_count: sourceNode.channelCount || null,
      processor_buffer_size: 4096,
      start_threshold: AUDIO_LEVEL_START_THRESHOLD,
      continue_threshold: AUDIO_LEVEL_CONTINUE_THRESHOLD,
      segment_max_ms: AUDIO_SEGMENT_MAX_MS,
      end_silence_ms: AUDIO_SEGMENT_END_SILENCE_MS,
      min_speech_ms: AUDIO_SEGMENT_MIN_SPEECH_MS,
    });

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const frameCount = input.length;
      const merged = new Float32Array(frameCount);
      const channelCount = Math.max(1, input.numberOfChannels);
      for (let frame = 0; frame < frameCount; frame += 1) {
        let total = 0;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          total += input.getChannelData(channelIndex)[frame] || 0;
        }
        merged[frame] = total / channelCount;
      }

      const level = calculateAudioLevel(merged);
      const diag = apiCaptureDiagRef.current;
      const now = performance.now();
      diag.frameCount += 1;
      diag.maxLevel = Math.max(diag.maxLevel, level);
      studioSend({ type: "audio.level", level });
      const action = pushAudioSegmentFrame(apiCaptureSegmentStateRef.current, merged, level, HELPER_TARGET_SAMPLE_RATE);
      if (now - diag.lastHeartbeatAtMs >= ASR_DIAG_HEARTBEAT_MS) {
        const segmentState = apiCaptureSegmentStateRef.current;
        logAsrDiag("capture heartbeat", {
          session_id: payload.sessionId,
          source: payload.source,
          elapsed_ms: Math.round(now - diag.startedAtMs),
          frame_count: diag.frameCount,
          current_level: Number(level.toFixed(4)),
          max_level_since_last: Number(diag.maxLevel.toFixed(4)),
          chunk_id_next: apiCaptureChunkIdRef.current,
          ...audioSegmentDiag(segmentState, HELPER_TARGET_SAMPLE_RATE),
        });
        diag.lastHeartbeatAtMs = now;
        diag.maxLevel = 0;
      }
      if (action === "soft_flush") {
        logAsrDiag("vad action soft_flush", {
          session_id: payload.sessionId,
          level: Number(level.toFixed(4)),
          chunk_id_next: apiCaptureChunkIdRef.current,
          ...audioSegmentDiag(apiCaptureSegmentStateRef.current, HELPER_TARGET_SAMPLE_RATE),
        });
        void flushApiCaptureBuffer(false, "vad_soft_flush");
      } else if (action === "final_flush") {
        logAsrDiag("vad action final_flush", {
          session_id: payload.sessionId,
          level: Number(level.toFixed(4)),
          chunk_id_next: apiCaptureChunkIdRef.current,
          ...audioSegmentDiag(apiCaptureSegmentStateRef.current, HELPER_TARGET_SAMPLE_RATE),
        });
        void flushApiCaptureBuffer(true, "vad_final_flush");
      }
    };

    const handleEnded = () => {
      void stopApiCapture(tr("realtimeStudio.notice.apiShareEnded"));
    };
    stream.getTracks().forEach((track) => track.addEventListener("ended", handleEnded));

    sourceNode.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);

    apiCaptureAudioContextRef.current = audioContext;
    apiCaptureSourceNodeRef.current = sourceNode;
    apiCaptureProcessorNodeRef.current = processor;
    apiCaptureMuteNodeRef.current = muteNode;
    apiCaptureStreamRef.current = stream;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  async function startApiCapture() {
    clearFeedback();
    const source = selectedInputSource;
    if (source !== "microphone_browser" && source !== "system_audio_helper") {
      setError(tr("realtimeStudio.error.apiSttUnsupportedSource"));
      return;
    }

    if (selectedRecognitionBackend !== "api_stt") {
      setError(tr("realtimeStudio.error.apiSttUnsupportedBackend"));
      return;
    }

    if (currentSessionClosed) {
      setNotice({ tone: "warning", text: tr("realtimeStudio.notice.sessionClosedRebuild") });
      return;
    }

    const sessionId = await ensureSession();
    logAsrDiag("start requested", {
      session_id: sessionId,
      source,
      backend: selectedRecognitionBackend,
      stt_profile_id: sttProfileId || null,
      stt_model: sttModel || null,
    });

    let stream: MediaStream;
    try {
      if (source === "microphone_browser") {
        stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        stream = await window.navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((track) => track.stop());
          setError(tr("realtimeStudio.error.noSharedAudioTrack"));
          return;
        }
      }
      logAsrDiag("media stream acquired", {
        session_id: sessionId,
        source,
        audio_track_count: stream.getAudioTracks().length,
        video_track_count: stream.getVideoTracks().length,
        audio_tracks: stream.getAudioTracks().map((track) => ({
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          ready_state: track.readyState,
        })),
      });
    } catch (err) {
      logAsrDiag(
        "media stream failed",
        {
          session_id: sessionId,
          source,
          error: err instanceof Error ? err.message : String(err),
        },
        "error",
      );
      setError(
        source === "microphone_browser"
          ? err instanceof Error
            ? err.message
            : tr("realtimeStudio.error.microphoneOpenFailed")
          : getDisplayAudioErrorMessage(err instanceof DOMException ? err.name : undefined, language),
      );
      return;
    }

    try {
      studioSend({ type: "transcript.preview", text: "" });
      studioSend({ type: "capture.start" });
      studioSend({ type: "stt.working" });
      await startApiCaptureBridge(stream, {
        sessionId,
        source,
        captureMode: source === "microphone_browser" ? "browser_speech" : "browser_display_audio",
        speaker: source === "microphone_browser" ? "speaker" : "system_audio",
      });
      setNotice({
        tone: "success",
        text:
          source === "microphone_browser"
            ? tr("realtimeStudio.notice.apiMicStarted")
            : tr("realtimeStudio.notice.apiShareStarted"),
      });
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      studioSend({ type: "stt.error", message: err instanceof Error ? err.message : tr("realtimeStudio.error.apiSttStartFailed") });
      setError(err instanceof Error ? err.message : tr("realtimeStudio.error.apiSttStartFailed"));
      await teardownApiCaptureGraph();
    }
  }

  async function stopApiCapture(message = tr("realtimeStudio.notice.apiSttStopped")) {
    logAsrDiag("stop requested", {
      session_id: apiCaptureContextRef.current?.sessionId ?? null,
      source: apiCaptureContextRef.current?.source ?? null,
      next_chunk_id: apiCaptureChunkIdRef.current,
      ...audioSegmentDiag(apiCaptureSegmentStateRef.current, HELPER_TARGET_SAMPLE_RATE),
    });
    await teardownApiCaptureGraph({ flush: true });
    studioSend({ type: "capture.stop" });
    setNotice({ tone: "info", text: message });
  }

  const createSession = useMutation({
    mutationFn: () =>
      api.createRealtimeSession({
        title,
        dataset_version_slug: datasetVersion || null,
        min_wait_k: 1,
        base_wait_k: 2,
        max_wait_k: 4,
        gate_profile_id: gateProfileId || null,
        gate_model: gateModel || null,
        planner_profile_id: plannerProfileId || null,
        planner_model: plannerModel || null,
        stt_profile_id: sttProfileId || null,
        stt_model: sttModel || null,
        diagram_mode: diagramMode,
        client_context: currentClientContext(),
      }),
    onSuccess: (data) => {
      setCurrentSessionId(data.session_id);
      setClosedSessionMeta(null);
      setSnapshot(null);
      setLocalCommittedTranscriptTurns([]);
      historyFeedKeysRef.current = [];
      window.localStorage.setItem(LOCAL_SESSION_KEY, data.session_id);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const renameSessionMutation = useMutation({
    mutationFn: ({ sessionId, title: nextTitle }: { sessionId: string; title: string }) =>
      api.patchRealtimeSession(sessionId, { title: nextTitle }),
    onSuccess: (data) => {
      queryClient.setQueryData<RealtimeSession[]>(["realtime-sessions"], (old) => {
        if (!old) return old;
        return old.map((row) =>
          row.session_id === data.session_id ? { ...row, title: data.title, updated_at: data.updated_at } : row,
        );
      });
      void queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const snapshotMutation = useMutation({
    mutationFn: (sessionId: string) => {
      studioSend({ type: "gate.working" });
      studioSend({ type: "planner.working" });
      return api.snapshotRealtime(sessionId);
    },
    onSuccess: (data) => {
      setSnapshot(data);
      setError(null);
      syncPipelineStatus(data.pipeline);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
    },
    onError: (err) => setError((err as Error).message),
  });

  function requestApiCaptureFlush(sessionId: string, delayMs = 500) {
    apiCaptureFlushQueuedRef.current = true;
    if (apiCaptureFlushTimeoutRef.current !== null) {
      window.clearTimeout(apiCaptureFlushTimeoutRef.current);
    }
    apiCaptureFlushTimeoutRef.current = window.setTimeout(() => {
      apiCaptureFlushTimeoutRef.current = null;
      void runApiCaptureFlush(sessionId);
    }, delayMs);
  }

  async function runApiCaptureFlush(sessionId: string) {
    if (apiCaptureFlushPromiseRef.current || !apiCaptureFlushQueuedRef.current) return;
    apiCaptureFlushQueuedRef.current = false;
    studioSend({ type: "gate.working" });
    studioSend({ type: "planner.working" });
    const promise = api
      .flushRealtime(sessionId)
      .then((data) => {
        setSnapshot(data);
        setError(null);
        syncPipelineStatus(data.pipeline);
        queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
        queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
      })
      .catch((err) => {
        logBrowserRuntime(
          "api_stt flush failed",
          {
            session_id: sessionId,
            error: err instanceof Error ? err.message : "flush failed",
          },
          "warn",
        );
      })
      .finally(() => {
        apiCaptureFlushPromiseRef.current = null;
        if (apiCaptureFlushQueuedRef.current) {
          void runApiCaptureFlush(sessionId);
        }
      });
    apiCaptureFlushPromiseRef.current = promise;
    await promise;
  }

  useEffect(() => {
    if (!currentSessionId) return;
    // Avoid creating a new timeline node on every page refresh.
    // Only bootstrap a snapshot when timeline data has loaded and is truly empty.
    if (!timelineQuery.isSuccess) return;
    if (timelineNodes.length > 0) return;
      snapshotMutation.mutate(currentSessionId);
    // `useMutation()` returns a new object identity per render; this effect is driven by timeline state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, timelineNodes.length, timelineQuery.isSuccess]);

  useEffect(() => {
    setLocalCommittedTranscriptTurns([]);
  }, [currentSessionId]);

  useEffect(() => {
    historyFeedKeysRef.current = [];
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) {
      setSnapshot(null);
      return;
    }
    if (snapshot && snapshot.session_id !== currentSessionId) {
      setSnapshot(null);
    }
  }, [currentSessionId, snapshot]);

  function pushLocalCommittedTurns(turns: RealtimeTranscriptTurn[]) {
    if (!turns.length) return;
    setLocalCommittedTranscriptTurns((previous) => {
      const next = [
        ...turns.map((turn, index) =>
          makeTranscriptHistoryItem(turn, "local", `${currentSessionId || "draft"}_${Date.now()}_${index}`, Date.now()),
        ),
        ...previous,
      ];
      const seen = new Set<string>();
      return next
        .filter((turn) => {
          const key = [turn.speaker, turn.text, turn.start_ms, turn.end_ms, turn.source, turn.capture_mode].join("|");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 10);
    });
  }

  async function ensureSession() {
    if (currentSessionId && !currentSessionClosed) return currentSessionId;
    if (currentSessionId && currentSessionClosed) {
      throw new Error(tr("realtimeStudio.error.closedSessionRecreate"));
    }
    const created = await createSession.mutateAsync();
    return created.session_id;
  }

  async function pushRealtimeTextChunk(source: InputSource, captureMode: CaptureMode, text: string, isFinal = true) {
    const sessionId = await ensureSession();
    logBrowserRuntime("text chunk ingest started", {
      session_id: sessionId,
      source,
      capture_mode: captureMode,
      is_final: isFinal,
      text,
    });
    studioSend({ type: "gate.working" });
    studioSend({ type: "planner.working" });
    const data = await api.addRealtimeChunk(sessionId, {
      text,
      speaker: source === "system_audio_helper" ? "system_audio" : "speaker",
      is_final: isFinal,
      metadata: buildChunkMetadata(source, captureMode),
    });
    if (isFinal && text.trim()) {
      pushLocalCommittedTurns([
        makeTranscriptTurn({
          speaker: source === "system_audio_helper" ? "system_audio" : "speaker",
          text: text.trim(),
          start_ms: 0,
          end_ms: 0,
          is_final: true,
          source,
          capture_mode: captureMode,
        }),
      ]);
    }
    setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
    logBrowserRuntime("text chunk ingest completed", {
      session_id: data.session_id,
      emitted_event_count: data.emitted_events.length,
      gate_state: data.pipeline?.gate_state ?? null,
      planner_state: data.pipeline?.planner_state ?? null,
      coordination_summary: data.pipeline?.coordination_summary ?? null,
    });
    syncPipelineStatus(data.pipeline);
    queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
  }

  const sendTranscript = useMutation({
    onMutate: () => {
      studioSend({ type: "gate.working" });
      studioSend({ type: "planner.working" });
    },
    mutationFn: async () => {
      const sessionId = await ensureSession();
      const rows = parseTranscriptInput(transcriptText);
      logBrowserRuntime("transcript send started", {
        session_id: sessionId,
        row_count: rows.length,
        rows,
      });
      return api.addRealtimeChunksBatch(sessionId, {
        chunks: rows.map((row, index) => ({
          timestamp_ms: index * 450,
          text: row.text,
          speaker: row.speaker,
          expected_intent: row.expected_intent || null,
          metadata: buildChunkMetadata("transcript", "manual_text"),
        })),
      });
    },
    onSuccess: (data) => {
      const rows = parseTranscriptInput(transcriptText);
      pushLocalCommittedTurns(
        rows
          .map((row, index) => ({
            ...makeTranscriptTurn({
            speaker: row.speaker,
            text: row.text.trim(),
            start_ms: index * 450,
            end_ms: index * 450,
            is_final: true,
            source: "transcript",
            capture_mode: "manual_text",
            }),
          }))
          .filter((row) => row.text),
      );
      if (data) setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
      setError(null);
      logBrowserRuntime("transcript send completed", {
        session_id: data?.session_id ?? null,
        gate_state: data?.pipeline?.gate_state ?? null,
        planner_state: data?.pipeline?.planner_state ?? null,
        coordination_summary: data?.pipeline?.coordination_summary ?? null,
      });
      syncPipelineStatus(data?.pipeline);
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.transcriptSent") });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      if (data?.session_id) {
        queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
      }
    },
    onError: (err) => {
      logBrowserRuntime("transcript send failed", { error: (err as Error).message }, "error");
      setError((err as Error).message);
    },
  });

  const flushMutation = useMutation({
    mutationFn: (sessionId: string) => {
      studioSend({ type: "gate.working" });
      studioSend({ type: "planner.working" });
      return api.flushRealtime(sessionId);
    },
    onSuccess: (data) => {
      setSnapshot(data);
      syncPipelineStatus(data.pipeline);
      queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const relayoutMutation = useMutation({
    mutationFn: ({ sessionId, payload }: { sessionId: string; payload: MermaidNodeRelayoutPayload }) => {
      studioSend({ type: "planner.working" });
      return api.relayoutRealtimeDiagram(sessionId, payload as unknown as Record<string, unknown>);
    },
    onSuccess: (data) => {
      setSnapshot(data);
      setError(null);
      syncPipelineStatus(data.pipeline);
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.diagramRelayout") });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
    },
    onError: (err) => {
      logBrowserRuntime("diagram relayout failed", { error: (err as Error).message }, "error");
      setError((err as Error).message);
    },
  });

  const rollbackPreviewMutation = useMutation({
    mutationFn: ({ sessionId, snapshotId }: { sessionId: string; snapshotId: string }) =>
      api.previewRealtimeRollback(sessionId, { snapshot_id: snapshotId }),
    onMutate: ({ snapshotId }) => {
      timelinePreviewRequestRef.current = snapshotId;
    },
    onSuccess: (data) => {
      const requestedSnapshotId = timelinePreviewRequestRef.current;
      if (!requestedSnapshotId || data.snapshot_id !== requestedSnapshotId) {
        return;
      }
      setRollbackPreview(data);
      setError(null);
    },
    onError: (err, variables) => {
      setRollbackPreview(null);
      if (err instanceof ApiError && err.status === 404) {
        if (selectedTimelineSnapshotId === variables.snapshotId) {
          setSelectedTimelineSnapshotId(null);
        }
        timelinePreviewRequestRef.current = null;
        queryClient.invalidateQueries({ queryKey: ["realtime-timeline", variables.sessionId] });
        setNotice({ tone: "info", text: tr("realtimeStudio.notice.timelineMissing") });
        return;
      }
      setError((err as Error).message);
    },
  });

  const rollbackApplyMutation = useMutation({
    mutationFn: ({ sessionId, snapshotId }: { sessionId: string; snapshotId: string }) =>
      api.applyRealtimeRollback(sessionId, { snapshot_id: snapshotId }),
    onSuccess: (data) => {
      setSnapshot({
        session_id: data.session_id,
        pipeline: data.pipeline,
        evaluation: data.evaluation || {},
      });
      syncPipelineStatus(data.pipeline);
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.rollbackApplied") });
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
      queryClient.invalidateQueries({ queryKey: ["realtime-annotations", data.session_id] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const [rollbackEditOpen, setRollbackEditOpen] = useState(false);
  const [rollbackEditTurns, setRollbackEditTurns] = useState<RealtimeTranscriptTurnEditable[]>([]);

  const rollbackEditApplyMutation = useMutation({
    mutationFn: ({
      sessionId,
      snapshotId,
      turns,
    }: {
      sessionId: string;
      snapshotId: string;
      turns: RealtimeTranscriptTurnEditable[];
    }) =>
      api.editApplyRealtimeRollback(sessionId, {
        snapshot_id: snapshotId,
        turns,
      }),
    onMutate: () => {
      // Close editor immediately so users are not blocked while recompute runs.
      setRollbackEditOpen(false);
      setNotice({ tone: "info", text: tr("realtimeStudio.notice.recomputeQueued") });
    },
    onSuccess: (data) => {
      const mermaidState =
        data.pipeline?.mermaid_state && typeof data.pipeline.mermaid_state === "object"
          ? (data.pipeline.mermaid_state as Record<string, unknown>)
          : null;
      const hasRenderIssue = Boolean(
        mermaidState &&
          (mermaidState.error_message ||
            mermaidState.compile_ok === false ||
            mermaidState.render_ok === false),
      );
      if (!hasRenderIssue) {
        setSnapshot({
          session_id: data.session_id,
          pipeline: data.pipeline,
          evaluation: data.evaluation || {},
        });
        syncPipelineStatus(data.pipeline);
      }
      setRollbackPreview(null);
      setRollbackEditOpen(false);
      setNotice(
        hasRenderIssue
          ? { tone: "warning", text: tr("realtimeStudio.notice.recomputeRenderIssue") }
          : { tone: "success", text: tr("realtimeStudio.notice.recomputeSaved") },
      );
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["realtime-timeline", data.session_id] });
      queryClient.invalidateQueries({ queryKey: ["realtime-annotations", data.session_id] });
    },
    onError: (err) => {
      setError((err as Error).message);
      setNotice({ tone: "warning", text: tr("realtimeStudio.notice.recomputeFailed") });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: string) => api.closeRealtime(sessionId),
    onSuccess: (data) => {
      setClosedSessionMeta({
        sessionId: data.session_id,
        downloads: {
          txt_url: apiUrl(data.downloads.txt_url),
          markdown_url: apiUrl(data.downloads.markdown_url),
        },
        transcriptSummary: data.transcript_summary,
      });
      studioSend({ type: "capture.stop" });
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.sessionClosedDownload") });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (sessionId: string) => api.deleteRealtimeSession(sessionId),
    onSuccess: (_data, deletedId) => {
      queryClient.setQueryData<RealtimeSession[]>(["realtime-sessions"], (old) =>
        old ? old.filter((row) => row.session_id !== deletedId) : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const handleDeleteHistorySession = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteSessionConfirmId(sessionId);
  };

  const confirmDeleteHistorySession = async () => {
    if (!deleteSessionConfirmId) return;
    const sessionId = deleteSessionConfirmId;
    try {
      await deleteSessionMutation.mutateAsync(sessionId);
      if (currentSessionId === sessionId) {
        window.localStorage.removeItem(LOCAL_SESSION_KEY);
        setCurrentSessionId(null);
        setSnapshot(null);
        setClosedSessionMeta(null);
        studioSend({ type: "capture.stop" });
        setTitle(defaultSessionTitle);
        setTitleDraft(defaultSessionTitle);
      }
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.sessionDeleted") });
      setDeleteSessionConfirmId(null);
    } catch {
      /* deleteSessionMutation onError */
    }
  };

  const saveReportMutation = useMutation({
    mutationFn: (sessionId: string) => api.saveRealtimeReport(sessionId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.reportSaved", { reportId: data.report_id }) });
    },
    onError: (err) => setError((err as Error).message),
  });

  const updateSttVoiceprintMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const admin = await api.getAdminRuntimeOptions();
      if (!admin.stt_profiles.some((p) => p.id === sttProfileId)) {
        throw new Error(tr("realtimeStudio.error.sttProfileMissing"));
      }
      const stt_profiles = admin.stt_profiles.map((p) =>
        p.id === sttProfileId ? { ...p, voiceprint: voiceprintPayloadForSave(p, enabled) } : p,
      );
      return api.saveAdminRuntimeOptions({
        gate_profiles: admin.gate_profiles,
        planner_profiles: admin.planner_profiles,
        stt_profiles,
      });
    },
    onSuccess: (data, enabled) => {
      queryClient.setQueryData(["admin-runtime-options"], data);
      queryClient.invalidateQueries({ queryKey: ["runtime-options"] });
      setNotice({
        tone: "success",
        text: enabled ? tr("realtimeStudio.notice.voiceprintEnabled") : tr("realtimeStudio.notice.voiceprintDisabled"),
      });
    },
    onError: (err) => {
      setNotice({
        tone: "warning",
        text: err instanceof Error ? err.message : tr("realtimeStudio.error.voiceprintSaveFailed"),
      });
    },
  });

  async function startRecognition() {
    clearFeedback();
    const sessionId = await ensureSession();
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setError(tr("realtimeStudio.error.webSpeechUnsupported"));
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    let finalTranscript = "";
    recognition.onresult = async (event: any) => {
      studioSend({ type: "stt.working" });
      let interimTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) {
          finalTranscript = finalTranscript ? `${finalTranscript} ${text}` : text;
          studioSend({ type: "gate.working" });
          studioSend({ type: "planner.working" });
          const data = await api.addRealtimeChunk(sessionId, {
            text,
            speaker: "speaker",
            is_final: true,
            metadata: buildChunkMetadata("microphone_browser", "browser_speech"),
          });
          pushLocalCommittedTurns([
            makeTranscriptTurn({
              speaker: "speaker",
              text,
              start_ms: 0,
              end_ms: 0,
              is_final: true,
              source: "microphone_browser",
              capture_mode: "browser_speech",
            }),
          ]);
          setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
          studioSend({ type: "stt.success", text });
          syncPipelineStatus(data.pipeline);
          setNotice({ tone: "success", text: tr("realtimeStudio.notice.browserSpeechChunkWritten") });
        } else {
          interimTranscript = text;
        }
      }
      studioSend({ type: "transcript.preview", text: [finalTranscript, interimTranscript].filter(Boolean).join(" ") });
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      void teardownMicrophoneAudioGraph();
      if (activeCaptureSource === "microphone_browser") studioSend({ type: "capture.stop" });
    };
    recognition.onerror = (evt: any) => {
      recognitionRef.current = null;
      setListening(false);
      void teardownMicrophoneAudioGraph();
      if (activeCaptureSource === "microphone_browser") studioSend({ type: "capture.stop" });
      studioSend({ type: "stt.error", message: getSpeechRecognitionErrorMessage(evt?.error, language) });
      setError(getSpeechRecognitionErrorMessage(evt?.error, language));
    };
    try {
      await startMicrophoneAudioGraph();
      recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      setListening(false);
      await teardownMicrophoneAudioGraph();
      setError(err instanceof Error ? err.message : tr("realtimeStudio.error.speechStartFailed"));
      return;
    }
    recognitionRef.current = recognition;
    setListening(true);
    studioSend({ type: "capture.start" });
    studioSend({ type: "transcript.preview", text: "" });
    setNotice({ tone: "info", text: tr("realtimeStudio.notice.browserSpeechStarted") });
  }

  function stopRecognition() {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    setListening(false);
    void teardownMicrophoneAudioGraph();
    if (activeCaptureSource === "microphone_browser") studioSend({ type: "capture.stop" });
  }

  async function startBrowserDisplayAudioValidation() {
    clearFeedback();
    if (!window.navigator.mediaDevices?.getDisplayMedia) {
      setError(tr("realtimeStudio.error.displayAudioUnsupported"));
      return;
    }
    try {
      const stream = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      displayStreamRef.current = stream;
      const audioTracks = stream.getAudioTracks();
      const handleEnded = () => {
        displayStreamRef.current = null;
        if (activeCaptureSource === "system_audio_browser_experimental") studioSend({ type: "capture.stop" });
      };
      stream.getTracks().forEach((track) => track.addEventListener("ended", handleEnded));
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        setError(tr("realtimeStudio.error.displayAudioNoTrack"));
        return;
      }
      studioSend({ type: "capture.start" });
      setNotice({
        tone: "warning",
        text: tr("realtimeStudio.notice.displayAudioValidationStarted"),
      });
    } catch (err) {
      setError(getDisplayAudioErrorMessage(err instanceof DOMException ? err.name : undefined, language));
    }
  }

  function stopBrowserDisplayAudioValidation() {
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    if (activeCaptureSource === "system_audio_browser_experimental") studioSend({ type: "capture.stop" });
    setNotice({ tone: "info", text: tr("realtimeStudio.notice.displayAudioValidationStopped") });
  }

  async function startHelperCapture() {
    clearFeedback();
    const caps = helperCapabilities;
    if (!caps) {
      setError(tr("realtimeStudio.error.localHelperMissing"));
      return;
    }
    if (caps.capability_status !== "supported") {
      setError(caps.capability_reason);
      return;
    }
    if (!window.navigator.mediaDevices?.getDisplayMedia) {
      setError(tr("realtimeStudio.error.displayAudioUnavailable"));
      return;
    }
    const sessionId = await ensureSession();
    let stream: MediaStream | null = null;
    try {
      stream = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        setError(tr("realtimeStudio.error.noSharedAudioTrack"));
        return;
      }
    } catch (err) {
      setError(getDisplayAudioErrorMessage(err instanceof DOMException ? err.name : undefined, language));
      return;
    }

    helperEventSourceRef.current?.close();
    helperEventSourceRef.current = subscribeAudioHelperEvents(
      (payload: any) => {
        if (payload.error_message) {
          studioSend({ type: "stt.error", message: payload.error_message });
          setError(payload.error_message);
        }
        if (payload.status === "running") {
          studioSend({ type: "capture.start" });
          studioSend({ type: "stt.working" });
          setNotice({ tone: "success", text: tr("realtimeStudio.notice.helperStartedWaiting") });
        }
        if (payload.status === "stopped") {
          studioSend({ type: "capture.stop" });
          setNotice({ tone: "info", text: tr("realtimeStudio.notice.helperStopped") });
        }
        if (payload.text?.trim()) {
          studioSend({ type: "transcript.preview", text: payload.text.trim() });
          studioSend({ type: "stt.success", text: payload.text.trim() });
          helperChunkQueueRef.current = helperChunkQueueRef.current.then(async () => {
            await pushRealtimeTextChunk(
              "system_audio_helper",
              "helper_native_capture",
              payload.text || "",
              payload.is_final ?? true,
            );
          });
        }
      },
      () => {
        void teardownHelperAudioGraph();
        studioSend({ type: "capture.stop" });
        studioSend({ type: "stt.error", message: tr("realtimeStudio.error.helperStreamDisconnected") });
        setError(tr("realtimeStudio.error.helperStreamDisconnected"));
      },
    );
    try {
      const result = await audioHelper.startCapture({
        source_type: "system_audio_helper",
        session_id: sessionId,
        language: "zh",
      });
      if (!result.ok) {
        stream.getTracks().forEach((track) => track.stop());
        setError(result.message);
        return;
      }
      studioSend({ type: "transcript.preview", text: "" });
      await startHelperAudioBridge(stream, sessionId);
      studioSend({ type: "capture.start" });
      setNotice({ tone: "success", text: tr("realtimeStudio.notice.helperStarted") });
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      helperEventSourceRef.current?.close();
      helperEventSourceRef.current = null;
      await audioHelper.stopCapture().catch(() => undefined);
      studioSend({ type: "stt.error", message: err instanceof Error ? err.message : tr("realtimeStudio.error.helperStartFailed") });
      setError(err instanceof Error ? err.message : tr("realtimeStudio.error.helperStartFailed"));
    }
  }

  async function stopHelperCapture(message = tr("realtimeStudio.notice.helperStopRequested")) {
    helperEventSourceRef.current?.close();
    helperEventSourceRef.current = null;
    await teardownHelperAudioGraph({ flush: true });
    try {
      await audioHelper.stopCapture();
    } catch {
      // ignore local helper shutdown errors
    }
    studioSend({ type: "capture.stop" });
    setNotice({ tone: "info", text: message });
  }

  const activeSnapshot = snapshot?.session_id === currentSessionId ? snapshot : null;
  const rendererState = activeSnapshot?.pipeline?.renderer_state || {};
  const events = useMemo<Array<Record<string, any>>>(() => {
    return Array.isArray(activeSnapshot?.pipeline?.events) ? activeSnapshot.pipeline.events : [];
  }, [activeSnapshot?.pipeline?.events]);
  const mermaidState = activeSnapshot?.pipeline?.mermaid_state ?? null;
  const isSelectedTimelinePreviewReady = Boolean(
    rollbackPreviewMermaidCode &&
      selectedTimelineSnapshotId &&
      rollbackPreview?.snapshot_id === selectedTimelineSnapshotId,
  );
  const isTimelinePreviewActive = isSelectedTimelinePreviewReady;
  const displayedMermaidCode = isTimelinePreviewActive
    ? rollbackPreviewMermaidCode
    : mermaidState?.code || mermaidState?.normalized_code || "";
  const rendererGroups =
    rendererState.groups || activeSnapshot?.pipeline?.graph_state?.current_graph_ir?.groups || [];
  const currentGraphPayload = activeSnapshot?.pipeline?.graph_state?.current_graph_ir ?? null;
  const mermaidExportRootId = "realtime-mermaid-export";
  const transcriptState = useMemo(() => readTranscriptState(activeSnapshot?.pipeline), [activeSnapshot?.pipeline]);
  const transcriptDownloads = useMemo(() => {
    if (!currentSessionId) return null;
    if (closedSessionMeta?.sessionId === currentSessionId) {
      return closedSessionMeta.downloads;
    }
    if (currentSessionClosed) {
      return buildTranscriptDownloadUrls(currentSessionId);
    }
    return null;
  }, [closedSessionMeta, currentSessionClosed, currentSessionId]);
  const eventFallbackTurns = useMemo(() => deriveTranscriptTurnsFromEvents(events), [events]);
  const transcriptDisplayState = useMemo(
    () =>
      buildTranscriptDisplayState({
        liveTranscript,
        serverCurrentTurn: transcriptState.currentTurn,
        serverArchivedTurns: transcriptState.archivedRecentTurns,
        fallbackTurns: eventFallbackTurns,
        localTurns: localCommittedTranscriptTurns,
      }),
    [
      eventFallbackTurns,
      liveTranscript,
      localCommittedTranscriptTurns,
      transcriptState.archivedRecentTurns,
      transcriptState.currentTurn,
    ],
  );
  const activeTranscriptTurn = transcriptDisplayState.activeTurn;
  const archivedTranscriptTurns = transcriptDisplayState.archivedTurns;
  const previewArchivedTranscriptTurns = useMemo(() => {
    if (selectedInputSource !== "transcript") return archivedTranscriptTurns;
    const rows = parseTranscriptInput(transcriptText).filter((row) => row.text.trim());
    const uniqueSpeakers = new Set(rows.map((row) => (row.speaker || "speaker").trim().toLowerCase()));
    const shouldForceDraftPreview = uniqueSpeakers.size >= 2;
    if (!rows.length) return archivedTranscriptTurns;
    const now = Date.now();
    const draftTurns = rows
      .map((row, index) => ({
        key: `draft_${index}`,
        speaker: row.speaker || "speaker",
        text: row.text.trim(),
        start_ms: index * 450,
        end_ms: index * 450,
        is_final: true,
        source: "transcript" as const,
        capture_mode: "manual_text" as const,
        origin: "local" as const,
        observedAt: now - index,
      }))
      .reverse();
    if (shouldForceDraftPreview) return draftTurns;
    return archivedTranscriptTurns.length ? archivedTranscriptTurns : draftTurns;
  }, [archivedTranscriptTurns, selectedInputSource, transcriptText]);
  const currentSubtitleText = useMemo(() => {
    const live = liveTranscript.trim();
    if (live) return live;
    return activeTranscriptTurn?.text?.trim() || transcriptState.latestFinalTurn?.text?.trim() || formatLiveTranscript("", language);
  }, [activeTranscriptTurn, language, liveTranscript, transcriptState.latestFinalTurn]);

  function downloadCurrentGraph() {
    if (!currentSessionId) {
      setError(tr("realtimeStudio.error.noDownloadableGraph"));
      return;
    }
    try {
      const base = sanitizeDownloadFileName(titleDisplay || currentSessionId);
      const fileName = `${base}_graph.svg`;
      downloadCurrentMermaidSvg(mermaidExportRootId, fileName, tr("realtimeStudio.error.noDownloadableGraph"));
      const p = annotationsState.payload;
      const hasMermaidAnn =
        (p.mermaid.items?.length ?? 0) > 0 || normalizeMaskStrokes(p.mermaid).length > 0;
      const hasStructureAnn =
        (p.structure.items?.length ?? 0) > 0 || normalizeMaskStrokes(p.structure).length > 0;
      if (hasMermaidAnn || hasStructureAnn) {
        try {
          const parts: string[] = [];
          if (hasMermaidAnn && document.getElementById("s2g-annotation-host-mermaid")) {
            downloadAnnotationsSvg(
              `${base}_annotations_mermaid.svg`,
              "s2g-annotation-host-mermaid",
              tr("realtimeStudio.error.noDownloadableAnnotations"),
            );
            parts.push(tr("realtimeStudio.annotation.mermaid"));
          }
          if (hasStructureAnn && document.getElementById("s2g-annotation-host-structure")) {
            downloadAnnotationsSvg(
              `${base}_annotations_structure.svg`,
              "s2g-annotation-host-structure",
              tr("realtimeStudio.error.noDownloadableAnnotations"),
            );
            parts.push(tr("realtimeStudio.annotation.structure"));
          }
          if (!parts.length) {
            setNotice({ tone: "warning", text: tr("realtimeStudio.notice.graphDownloadedNoLayer") });
          } else {
            setNotice({
              tone: "warning",
              text: tr("realtimeStudio.notice.graphDownloadedWithAnnotations", { parts: parts.join(" / ") }),
            });
          }
        } catch {
          setNotice({ tone: "warning", text: tr("realtimeStudio.notice.graphAnnotationExportFailed") });
        }
      } else {
        setNotice({ tone: "success", text: tr("realtimeStudio.notice.graphDownloaded") });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("realtimeStudio.error.noDownloadableGraph"));
    }
  }

  async function handleCloseSession() {
    if (!currentSessionId || currentSessionClosed || closeMutation.isPending) return;
    await stageStopCapture();
    await closeMutation.mutateAsync(currentSessionId);
  }

  useEffect(() => {
    const previousKeys = new Set(historyFeedKeysRef.current);
    const currentKeys = archivedTranscriptTurns.map((item) => item.key);
    const newlyVisibleItems = archivedTranscriptTurns.filter((item) => !previousKeys.has(item.key));

    if (newlyVisibleItems.length) {
      newlyVisibleItems.forEach((item, index) => {
        logBrowserRuntime("transcript entered archive", {
          session_id: currentSessionId,
          index,
          origin: item.origin,
          speaker: item.speaker,
          source: item.source,
          capture_mode: item.capture_mode,
          start_ms: item.start_ms,
          end_ms: item.end_ms,
          text: item.text,
          archive_size: archivedTranscriptTurns.length,
        });
      });
    }

    historyFeedKeysRef.current = currentKeys;
  }, [archivedTranscriptTurns, currentSessionId]);

  function handleMermaidNodeRelayout(payload: MermaidNodeRelayoutPayload) {
    if (!currentSessionId || relayoutMutation.isPending) return;
    relayoutMutation.mutate({ sessionId: currentSessionId, payload });
  }

  const hasGateProfiles = Boolean(runtimeOptions.data?.gate_profiles.length);
  const hasPlannerProfiles = Boolean(runtimeOptions.data?.planner_profiles.length);
  const hasSttProfiles = Boolean(runtimeOptions.data?.stt_profiles.length);

  const summaryCards = useMemo(() => {
    const metrics = snapshot?.evaluation?.metrics ?? {};
    return [
      {
        label: tr("realtimeStudio.text019"),
        value: metrics.e2e_latency_p95_ms ?? "-",
      },
      {
        label: tr("realtimeStudio.text020"),
        value: metrics.intent_accuracy ?? "-",
      },
      {
        label: tr("realtimeStudio.text021"),
        value: metrics.flicker_mean ?? "-",
      },
      {
        label: tr("realtimeStudio.text022"),
        value: metrics.mental_map_mean ?? "-",
      },
    ];
  }, [language, snapshot?.evaluation?.metrics]);

  /** @description 主舞台顶栏：CAP/STT/GATE/PLAN/MER/model 步骤徽章（空闲=灰色，失败=红色） */
  const pipelineStages = useMemo(() => {
    // CAP 本身没有 success/error，由后续转写状态推断结果；capturing/uploading 期间视为进行中。
    const capTone: "idle" | "working" | "success" | "error" =
      captureStatus === "idle"
        ? sttStatus === "success"
          ? "success"
          : sttStatus === "error"
            ? "error"
            : "idle"
        : "working";

    const sttTone = backendStatusTone(sttStatus);
    const gateTone = backendStatusTone(gateStatus);
    const plannerTone = backendStatusTone(plannerStatus);

    // MER：优先用 mermaid_state 的 compile/error 信号定色；没有信号时用 mermaidStatus/更新时间兜底。
    let merTone: "idle" | "working" | "success" | "error" = "idle";
    if (mermaidState?.error_message) {
      merTone = "error";
    } else if (typeof mermaidState?.compile_ok === "boolean") {
      merTone = mermaidState.compile_ok ? "success" : "error";
    } else if (mermaidStatus === "working") {
      merTone = "working";
    } else if (lastMermaidUpdatedAt) {
      merTone = "success";
    }

    const modelBusy =
      sendTranscript.isPending ||
      snapshotMutation.isPending ||
      flushMutation.isPending ||
      relayoutMutation.isPending ||
      gateStatus === "working" ||
      plannerStatus === "working";
    const modelStatus: "idle" | "working" | "success" | "error" =
      gateStatus === "error" || plannerStatus === "error"
        ? "error"
        : modelBusy
          ? "working"
          : gateStatus === "success" || plannerStatus === "success"
            ? "success"
            : "idle";

    const noModelLabel = tr("realtimeDefaultConfig.text011");
    const graphWaitingLabel = tr("realtimeStudio.text023");

    return [
      {
        abbr: "CAP",
        label: tr("realtimeStudio.text024"),
        value: captureStatusLabel(captureStatus, language),
        tone: capTone,
        help: tr("realtimeStudio.text025"),
      },
      {
        abbr: "STT",
        label: tr("realtimeStudio.text026"),
        value: backendStatusLabel(sttStatus, language),
        tone: sttTone,
        help: `${tr("realtimeStudio.text027")}${backendLabel(selectedRecognitionBackend, language)}`,
      },
      {
        abbr: "GATE",
        label: "Gate",
        value: backendStatusLabel(gateStatus, language),
        tone: gateTone,
        help: selectedGateProfile
          ? `${selectedGateProfile.label} / ${gateModel || noModelLabel}`
          : tr("realtimeStudio.text028"),
      },
      {
        abbr: "PLAN",
        label: "Planner",
        value: backendStatusLabel(plannerStatus, language),
        tone: plannerTone,
        help: selectedPlannerProfile
          ? `${selectedPlannerProfile.label} / ${plannerModel || noModelLabel}`
          : tr("realtimeStudio.text029"),
      },
      {
        abbr: "MER",
        label: tr("realtimeStudio.text030"),
        value: lastMermaidUpdatedAt
          ? tr("realtimeStudio.text031")
          : graphWaitingLabel,
        tone: merTone,
        help:
          lastMermaidUpdatedAt ||
          tr("realtimeStudio.text032"),
      },
      {
        abbr: "MODEL",
        label: tr("realtimeStudio.text033"),
        value:
          modelStatus === "working"
            ? tr("realtimeStudio.text034")
            : modelStatus === "error"
              ? tr("realtimeStudio.text012")
              : modelStatus === "success"
                ? tr("realtimeStudio.text035")
                : tr("realtimeStudio.text036"),
        tone: backendStatusTone(modelStatus),
        help:
          modelStatus === "working"
            ? tr("realtimeStudio.text037")
            : tr("realtimeStudio.text038"),
      },
    ];
  }, [
    captureStatus,
    sttStatus,
    gateStatus,
    plannerStatus,
    mermaidStatus,
    lastMermaidUpdatedAt,
    language,
    mermaidState?.error_message,
    mermaidState?.compile_ok,
    selectedRecognitionBackend,
    selectedGateProfile,
    gateModel,
    selectedPlannerProfile,
    plannerModel,
    sendTranscript.isPending,
    snapshotMutation.isPending,
    flushMutation.isPending,
    relayoutMutation.isPending,
  ]);

  const pipelineAllIdle = useMemo(() => pipelineStages.every((step) => step.tone === "idle"), [pipelineStages]);

  const systemAudioExperimentalVisible = supportsSystemAudioExperimentalUi(audioContext);
  const canStartCapture =
    currentSessionClosed
      ? false
      : selectedRecognitionBackend === "browser_speech"
        ? !listening
        : selectedRecognitionBackend === "browser_display_validation"
          ? activeCaptureSource !== "system_audio_browser_experimental"
          : selectedRecognitionBackend === "local_helper"
            ? activeCaptureSource !== "system_audio_helper"
            : selectedRecognitionBackend === "api_stt"
              ? captureStatus === "idle"
              : false;
  const canStopCapture =
    currentSessionClosed
      ? false
      : selectedRecognitionBackend === "browser_speech"
        ? listening
        : selectedRecognitionBackend === "browser_display_validation"
          ? activeCaptureSource === "system_audio_browser_experimental"
          : selectedRecognitionBackend === "local_helper"
            ? activeCaptureSource === "system_audio_helper"
            : selectedRecognitionBackend === "api_stt"
              ? captureStatus !== "idle"
              : false;

  /** @description 主舞台顶栏：与抽屉内相同的开始/暂停（停止）采集逻辑 */
  async function stageStartCapture() {
    if (currentSessionClosed) {
      setNotice({ tone: "warning", text: tr("realtimeStudio.notice.sessionClosedRebuild") });
      return;
    }
    if (selectedInputSource === "transcript") return;
    if (selectedInputSource === "microphone_browser") {
      if (selectedRecognitionBackend === "browser_speech") return startRecognition();
      if (selectedRecognitionBackend === "api_stt") return startApiCapture();
      return;
    }
    if (selectedInputSource === "system_audio_browser_experimental") {
      return startBrowserDisplayAudioValidation();
    }
    if (selectedInputSource === "system_audio_helper") {
      if (selectedRecognitionBackend === "local_helper") return startHelperCapture();
      if (selectedRecognitionBackend === "api_stt") return startApiCapture();
    }
  }

  async function stageStopCapture() {
    if (currentSessionClosed) return;
    if (selectedInputSource === "transcript") return;
    if (selectedInputSource === "microphone_browser") {
      if (selectedRecognitionBackend === "browser_speech") {
        stopRecognition();
        return;
      }
      if (selectedRecognitionBackend === "api_stt") {
        await stopApiCapture();
        return;
      }
      return;
    }
    if (selectedInputSource === "system_audio_browser_experimental") {
      stopBrowserDisplayAudioValidation();
      return;
    }
    if (selectedInputSource === "system_audio_helper") {
      if (selectedRecognitionBackend === "local_helper") {
        await stopHelperCapture();
        return;
      }
      if (selectedRecognitionBackend === "api_stt") {
        await stopApiCapture();
        return;
      }
    }
  }

  const canStartStageCapture = selectedInputSource !== "transcript" && canStartCapture;
  const canStopStageCapture = selectedInputSource !== "transcript" && canStopCapture;
  const titleDisplay =
    title.trim() ||
    tr("realtimeStudio.text039");

  function startTitleEdit() {
    setTitleDraft(titleDisplay);
    setIsTitleEditing(true);
  }

  async function commitTitleEdit() {
    const nextTitle = titleDraft.trim();
    if (!nextTitle) return;
    if (currentSessionId) {
      try {
        await renameSessionMutation.mutateAsync({ sessionId: currentSessionId, title: nextTitle });
        setTitle(nextTitle);
        setIsTitleEditing(false);
        await queryClient.refetchQueries({ queryKey: ["realtime-sessions"] });
        setNotice({ tone: "success", text: tr("realtimeStudio.notice.titleSavedSynced") });
      } catch {
        /* setError 已由 mutation.onError 处理 */
      }
      return;
    }
    setTitle(nextTitle);
    setIsTitleEditing(false);
    setNotice({
      tone: "success",
      text: tr("realtimeStudio.notice.titleSavedLocal"),
    });
  }

  function cancelTitleEdit() {
    setTitleDraft(titleDisplay);
    setIsTitleEditing(false);
  }

  if (authQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4 text-sm text-theme-4">
        {tr("realtimeStudio.text040")}
      </div>
    );
  }

  if (authQuery.isError) {
    const err = authQuery.error;
    if (!(err instanceof ApiError && err.status === 401)) {
      return (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="max-w-md text-sm text-red-400 theme-light:text-red-700">{(err as Error).message}</p>
          <Button type="button" variant="secondary" onClick={() => void authQuery.refetch()}>
            {tr("realtimeStudio.common.retry")}
          </Button>
        </div>
      );
    }
  }

  return (
  <div className="h-[100dvh] overflow-hidden text-theme-2 selection:bg-[rgba(124,111,154,0.22)] selection:text-theme-1">
      {effectiveError ? (
        <div className="soft-enter fixed left-1/2 top-16 z-[19000] w-[min(720px,92vw)] -translate-x-1/2 rounded-[24px] border border-red-200 bg-red-50/95 px-4 py-3 text-sm text-red-700">
          {effectiveError}
        </div>
      ) : null}
      {notice ? (
        <div
          className={`soft-enter fixed left-1/2 top-4 z-[20000] w-[min(720px,92vw)] -translate-x-1/2 rounded-[24px] border px-4 py-3 text-sm ${getNoticeClassName(notice.tone)}`}
        >
          {notice.text}
        </div>
      ) : null}
      {timelineHoverTooltip && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[24050] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-theme-default bg-surface-1 px-1.5 py-0.5 text-[10px] text-theme-2 shadow-sm"
              style={{
                left: `${timelineHoverTooltip.x}px`,
                top: `${timelineHoverTooltip.y}px`,
              }}
            >
              {timelineHoverTooltip.text}
            </div>,
            document.body,
          )
        : null}
      {rollbackEditOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-[22000] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
              <Card className="w-full max-w-[min(920px,96vw)] overflow-hidden rounded-[22px] border border-theme-default bg-surface-1 p-0 shadow-2xl">
                <div className="flex items-center justify-between gap-3 border-b border-theme-subtle px-5 py-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-theme-1">
                      {tr("realtimeStudio.rollback.editTitle")}
                    </div>
                    <div className="mt-1 text-[11px] text-theme-4">
                      {tr("realtimeStudio.rollback.editDescription")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 shrink-0 px-3 text-xs font-semibold"
                    onClick={() => setRollbackEditOpen(false)}
                    disabled={rollbackEditApplyMutation.isPending}
                  >
                    {tr("realtimeStudio.common.close")}
                  </Button>
                </div>
                <div className="max-h-[min(70vh,560px)] overflow-auto px-5 py-4">
                  <div className="flex flex-col gap-2">
                    {rollbackEditTurns.length ? (
                      rollbackEditTurns.map((turn, index) => (
                        (() => {
                          const tone = transcriptSpeakerCardTone(turn.speaker);
                          return (
                        <div
                          key={index}
                          className={`grid grid-cols-[140px_minmax(0,1fr)_auto] items-start gap-2 rounded-xl border p-3 ${tone.card}`}
                          style={tone.style}
                        >
                          <Input
                            value={turn.speaker}
                            onChange={(e) => {
                              const next = e.target.value;
                              setRollbackEditTurns((prev) =>
                                prev.map((t, i) => (i === index ? { ...t, speaker: next } : t)),
                              );
                            }}
                            className={`h-8 rounded-lg border text-xs ${tone.speaker} ${tone.body}`}
                            style={tone.speakerTagStyle}
                            placeholder="speaker"
                          />
                          <Textarea
                            value={turn.text}
                            onChange={(e) => {
                              const next = e.target.value;
                              setRollbackEditTurns((prev) =>
                                prev.map((t, i) => (i === index ? { ...t, text: next } : t)),
                              );
                            }}
                            className={`min-h-[2.5rem] resize-y rounded-lg border text-xs ${tone.body}`}
                            style={{ ...tone.contentStyle, ...tone.style }}
                            placeholder={tr("realtimeStudio.rollback.turnPlaceholder")}
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-8 shrink-0 px-2 text-xs"
                            onClick={() => setRollbackEditTurns((prev) => prev.filter((_, i) => i !== index))}
                            disabled={rollbackEditApplyMutation.isPending}
                            title={tr("realtimeStudio.rollback.deleteTurnTitle")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                          );
                        })()
                      ))
                    ) : (
                      <div className="rounded-xl border border-dashed border-theme-default bg-surface-2 px-4 py-6 text-center text-xs text-theme-3">
                        {tr("realtimeStudio.rollback.emptyTurns")}
                      </div>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 px-3 text-xs font-semibold"
                      onClick={() =>
                        setRollbackEditTurns((prev) => [...prev, { speaker: "speaker", text: "" }])
                      }
                      disabled={rollbackEditApplyMutation.isPending}
                    >
                      {tr("realtimeStudio.rollback.addTurn")}
                    </Button>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-8 px-3 text-xs font-semibold"
                        onClick={() => setRollbackEditOpen(false)}
                        disabled={rollbackEditApplyMutation.isPending}
                      >
                        {tr("realtimeStudio.common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        className="h-8 px-3 text-xs font-semibold"
                        onClick={() => {
                          if (!currentSessionId || !selectedTimelineSnapshotId) return;
                          setRollbackEditOpen(false);
                          rollbackEditApplyMutation.mutate({
                            sessionId: currentSessionId,
                            snapshotId: selectedTimelineSnapshotId,
                            turns: rollbackEditTurns
                              .map((t) => ({ speaker: String(t.speaker || "speaker"), text: String(t.text || "") }))
                              .filter((t) => t.text.trim().length > 0),
                          });
                        }}
                        disabled={
                          !currentSessionId ||
                          !selectedTimelineSnapshotId ||
                          rollbackEditApplyMutation.isPending ||
                          currentSessionClosed
                        }
                      >
                        {rollbackEditApplyMutation.isPending
                          ? tr("realtimeStudio.rollback.saving")
                          : tr("realtimeStudio.rollback.saveAndRecompute")}
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            </div>,
            document.body,
          )
        : null}

      <div className="flex min-h-[calc(100vh-5.5rem)] flex-col space-y-4">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 pl-3 md:gap-3 md:pl-6 lg:pl-8">
            <h1 className="page-title">
              {tr("realtimeStudio.text041")}
            </h1>
            {isUnauthorizedGuest ? (
              <Badge className="border-amber-800/50 bg-amber-950/35 text-[10px] font-medium normal-case tracking-normal text-amber-100 theme-light:border-amber-200/60 theme-light:bg-amber-50 theme-light:text-amber-900">
                {tr("realtimeStudio.text042")}
              </Badge>
            ) : null}
            <p className="hidden max-w-md text-[11px] leading-snug text-theme-4 md:block">
              {tr("realtimeStudio.text043")}
            </p>
          </div>
          <div className="ml-auto flex min-w-0 items-center justify-end gap-2 pr-12 sm:pr-14">
            <div className="group relative">
              <Badge
                className="cursor-default border-theme-default bg-surface-2 px-2.5 py-1 text-xs font-medium normal-case tracking-normal text-theme-2"
                title={tr("realtimeStudio.text044")}
              >
                {tr("realtimeStudio.text045")}
              </Badge>
              <div className="pointer-events-none invisible absolute right-0 top-[calc(100%+8px)] z-[120] w-[min(460px,82vw)] rounded-xl border border-theme-subtle bg-surface-1 p-3 opacity-0 shadow-xl transition duration-200 group-hover:visible group-hover:pointer-events-auto group-hover:opacity-100">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-theme-4">
                  {tr("realtimeStudio.text046")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    className="text-[10px] font-normal normal-case tracking-normal text-theme-2"
                    title={currentSessionId || undefined}
                  >
                    <span className="block max-w-[180px] min-w-0 truncate">
                      {currentSessionId
                        ? `${tr("realtimeStudio.text047")} ${currentSessionId}`
                        : tr("realtimeStudio.text048")}
                    </span>
                  </Badge>
                  {mermaidState?.provider || selectedPlannerProfile?.label ? (
                    <Badge>{mermaidState?.provider || selectedPlannerProfile?.label}</Badge>
                  ) : null}
                  {mermaidState?.model || plannerModel ? <Badge>{mermaidState?.model || plannerModel}</Badge> : null}
                  {typeof mermaidState?.latency_ms === "number" ? <Badge>{mermaidState.latency_ms.toFixed(1)} ms</Badge> : null}
                  <Badge
                    className={`text-[10px] font-normal normal-case tracking-normal ${
                      gateStatus === "error" || plannerStatus === "error"
                        ? "border-red-900/60 bg-red-950/50 text-red-200"
                        : gateStatus === "working" || plannerStatus === "working"
                          ? "border-amber-900/55 bg-amber-950/40 text-amber-100"
                          : gateStatus === "success" || plannerStatus === "success"
                            ? "border-emerald-900/55 bg-emerald-950/40 text-emerald-100"
                            : "border-theme-default bg-surface-2 text-theme-3"
                    }`}
                  >
                    {gateStatus === "error" || plannerStatus === "error"
                      ? tr("realtimeStudio.text049")
                      : gateStatus === "working" || plannerStatus === "working"
                        ? tr("realtimeStudio.text050")
                        : gateStatus === "success" || plannerStatus === "success"
                          ? tr("realtimeStudio.text051")
                          : tr("realtimeStudio.text052")}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    {tr("realtimeStudio.text053")}{getSourceBadgeLabel(activeCaptureSource, language)}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    {tr("realtimeStudio.text054")}{backendLabel(selectedRecognitionBackend, language)}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    {tr("realtimeStudio.text055")}
                    {typeof mermaidState?.compile_ok === "boolean"
                      ? mermaidState.compile_ok
                        ? tr("realtimeStudio.text056")
                        : tr("realtimeStudio.text057")
                      : tr("realtimeStudio.text023")}
                  </Badge>
                  {snapshot?.evaluation?.realtime_eval_pass === true ? (
                    <Badge className="border-emerald-900/55 bg-emerald-950/40 text-[10px] font-normal normal-case tracking-normal text-emerald-200">
                      {tr("realtimeStudio.text058")}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="min-h-0 pb-0 grid grid-cols-1 gap-4 xl:flex-1 xl:overflow-hidden xl:grid-cols-[minmax(300px,3fr)_minmax(0,7fr)] xl:grid-rows-[auto_1fr] xl:items-stretch xl:min-h-0">
        {studioPage === 1 ? (
          <Card className="soft-enter relative order-1 flex min-h-0 min-w-0 flex-col space-y-3 text-[13px] leading-snug xl:col-start-1 xl:row-start-2 xl:order-none">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[3px] bg-gradient-to-r from-[color:var(--accent)]/0 via-[color:var(--accent)]/45 to-[color:var(--accent)]/0"
            aria-hidden
          />
          <div className={`relative shrink-0 space-y-2 ${inputSourceMenuOpen ? "z-[100]" : "z-[2]"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm font-semibold text-theme-1">
                {tr("realtimeStudio.text059")}
              </label>
              <Badge className="shrink-0 text-[10px]">
                {audioContext
                  ? `${audioContext.platform} / ${getBrowserFamilyLabel(audioContext)}`
                  : tr("realtimeStudio.text060")}
              </Badge>
            </div>
            <div ref={inputSourceMenuRef} className="relative">
              <button
                type="button"
                className="flex h-10 w-full items-center justify-between rounded-lg border border-theme-default bg-surface-2 px-3.5 pr-3 text-left text-sm font-medium text-theme-1 outline-none transition hover:border-theme-strong hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-theme-focus"
                aria-haspopup="listbox"
                aria-expanded={inputSourceMenuOpen}
                onClick={() => setInputSourceMenuOpen((open) => !open)}
              >
                <span className="truncate">
                  {selectedOption.label} · {selectedOption.capability_status}
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-theme-4 transition-transform duration-200 ${inputSourceMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              {inputSourceMenuOpen ? (
                <div className="absolute z-10 mt-2 w-full rounded-lg border border-theme-subtle bg-surface-1 p-1.5 shadow-xl">
                  <div
                    className="space-y-0.5"
                    role="listbox"
                    aria-label={tr("realtimeStudio.text059")}
                  >
                    {inputOptions.map((option) => {
                      const active = option.source === selectedInputSource;
                      return (
                        <button
                          key={option.source}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                  clearFeedback();
                            const opts = buildBackendOptions(option.source, helperCapabilities, language);
                  const nextBackend = opts.find((item) => !item.disabled)?.value ?? opts[0].value;
                            studioSend({ type: "source.select", source: option.source, backend: nextBackend });
                            setInputSourceMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition ${
                            active
                              ? "border-theme-strong bg-surface-3 text-theme-1"
                              : "border-transparent bg-transparent text-theme-2 hover:bg-surface-3"
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={`inline-flex h-4 w-4 items-center justify-center ${active ? "text-theme-2" : "text-theme-5"}`}>
                              {active ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
                            </span>
                            <span className="truncate">{option.label}</span>
            </div>
                          <span className="ml-2 shrink-0 text-xs text-theme-4">{option.capability_status}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-theme-3">
              {selectedOption.description}
            </p>
            {/* 声纹盲认仅与语音/STT 相关；纯文本 Transcript 输入时不展示 */}
            {selectedInputSource !== "transcript" ? (
              <div className="flex min-h-[2rem] items-center justify-between gap-2 rounded-lg border border-theme-subtle bg-surface-muted px-2 py-1">
                {!isAdmin ? (
                  <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-theme-3">
                    {tr("realtimeStudio.text061")}
                    <Link href="/login" className="link-accent">
                      {tr("realtimeStudio.text062")}
                    </Link>
                    {tr("realtimeStudio.text063")}
                  </p>
                ) : !hasSttProfiles ? (
                  <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-theme-3">
                    {tr("realtimeStudio.text064")}
                    <Link href="/app/settings" className="link-accent">
                      {tr("realtimeStudio.text065")}
                    </Link>
                  </p>
                ) : !selectedSttProfile ? (
                  <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-theme-3">
                    {tr("realtimeStudio.text066")}
                    <Link href="/app/settings" className="link-accent">
                      {tr("platformSettings.text004")}
                    </Link>
                  </p>
                ) : (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-theme-2">
                      <Fingerprint className="h-3.5 w-3.5 shrink-0 text-theme-4" strokeWidth={2} aria-hidden />
                      <span className="truncate" title={`${selectedSttProfile.label} · ${tr("realtimeStudio.voiceprint.blindTitle")}`}>
                        {tr("realtimeStudio.text067")} · {selectedSttProfile.label}
                      </span>
                    </span>
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] font-medium text-theme-2">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-theme-default"
                        checked={readVoiceprintEnabledFromCatalog(selectedSttProfile)}
                        disabled={
                          updateSttVoiceprintMutation.isPending ||
                          adminRuntimeOptions.isLoading ||
                          adminRuntimeOptions.isError ||
                          !sttProfileId
                        }
                        title={
                          adminRuntimeOptions.isError
                            ? tr("realtimeStudio.text068")
                            : undefined
                        }
                        onChange={(event: ChangeEvent<HTMLInputElement>) => {
                          if (adminRuntimeOptions.isError) return;
                          updateSttVoiceprintMutation.mutate(event.target.checked);
                        }}
                      />
                      {updateSttVoiceprintMutation.isPending
                        ? "…"
                        : tr("platformSettings.text054")}
                    </label>
                  </>
                )}
              </div>
            ) : null}
            {!audioContext?.is_desktop ? (
              <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-2 text-[11px] leading-relaxed text-theme-4">
                {tr("realtimeStudio.text069")}
              </div>
            ) : !systemAudioExperimentalVisible ? (
              <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-2 text-[11px] leading-relaxed text-theme-4">
                {tr("realtimeStudio.text070")}
              </div>
            ) : null}
          </div>

          <div
            className={`relative z-[2] flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border px-2.5 py-2 transition-[border-color,box-shadow,background] ${
              activeCaptureSource
                ? "border-[color:var(--accent)]/55 bg-surface-muted ring-1 ring-[color:var(--accent)]/20"
                : "border-theme-subtle bg-gradient-to-b from-[color:var(--accent)]/[0.06] to-surface-muted"
            }`}
          >
            <div className="flex shrink-0 items-end justify-between gap-2 border-b border-theme-subtle pb-1.5">
              <div className="inline-flex items-center gap-5">
                <button
                  type="button"
                  onClick={() => setTranscriptPanelTab("live")}
                  className={`border-b-2 px-0.5 py-1 text-[12px] font-semibold tracking-[0.02em] transition ${
                    transcriptPanelTab === "live"
                      ? "border-[color:var(--accent)] text-theme-1"
                      : "border-transparent text-theme-4 hover:text-theme-2"
                  }`}
                >
                  {tr("realtimeStudio.text071")}
                </button>
                <button
                  type="button"
                  onClick={() => setTranscriptPanelTab("history")}
                  className={`border-b-2 px-0.5 py-1 text-[12px] font-semibold tracking-[0.02em] transition ${
                    transcriptPanelTab === "history"
                      ? "border-[color:var(--accent)] text-theme-1"
                      : "border-transparent text-theme-4 hover:text-theme-2"
                  }`}
                >
                  {tr("realtimeStudio.text072")}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                {currentSessionClosed ? (
                  <Badge className="text-[9px]">{tr("realtimeStudio.text073")}</Badge>
                ) : null}
                <Badge className="text-[9px]">{backendLabel(selectedRecognitionBackend, language)}</Badge>
              </div>
            </div>
            <div className="mt-1.5 flex shrink-0 flex-wrap gap-1.5">
              <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                {tr("realtimeStudio.text074")}{transcriptState.turnCount}
              </Badge>
              <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                {tr("realtimeStudio.text075")}{transcriptState.speakerCount}
              </Badge>
              <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                Chunk: {transcriptState.chunkCount}
              </Badge>
            </div>
            <p className="mt-1.5 shrink-0 text-[9px] leading-snug text-theme-4">
              {currentSessionClosed
                ? tr("realtimeStudio.text076")
                : selectedInputSource === "transcript"
                  ? tr("realtimeStudio.text077")
                  : tr("realtimeStudio.text078")}
            </p>
            <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-subtle bg-surface-muted/88">
                <div className="flex shrink-0 items-center justify-end gap-2 border-b border-theme-subtle px-3 py-2">
                  <div className="text-[10px] text-theme-4">
                    {transcriptPanelTab === "history"
                      ? previewArchivedTranscriptTurns.length
                        ? `${previewArchivedTranscriptTurns.length} / 10`
                        : tr("realtimeStudio.text079")
                      : activeTranscriptTurn?.speaker
                        ? tr("realtimeStudio.transcript.currentSpeaker", { speaker: activeTranscriptTurn.speaker })
                        : tr("realtimeStudio.transcript.livePreview")}
                </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
                  {transcriptPanelTab === "live" ? (
                    selectedInputSource === "transcript" ? (
                      <div className="flex h-full min-h-[10rem] flex-col gap-2">
                        <Textarea
                          className="min-h-[8rem] flex-1 resize-y text-[12px] leading-relaxed"
                          rows={8}
                          value={transcriptText}
                          disabled={currentSessionClosed}
                          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                            const next = event.target.value;
                            setTranscriptText(next);
                            studioSend({ type: "transcript.preview", text: next });
                          }}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          className="shrink-0 border-violet-900/50 bg-violet-950/45 py-2 text-xs text-violet-100 shadow-sm hover:border-violet-700/60 hover:bg-violet-950/65 hover:text-violet-50 focus-visible:ring-2 focus-visible:ring-violet-700"
                          onClick={() => sendTranscript.mutate()}
                          disabled={sendTranscript.isPending || !transcriptText.trim() || currentSessionClosed}
                        >
                          <Send className="h-3.5 w-3.5" />
                          {currentSessionClosed
                            ? tr("realtimeStudio.text080")
                            : tr("realtimeStudio.text081")}
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-[color:var(--accent)]/25 bg-[color:var(--accent)]/[0.05] px-3 py-3">
                <div className="max-h-[min(12rem,38vh)] min-h-[4.5rem] overflow-y-auto whitespace-pre-wrap text-[15px] leading-7 text-theme-1 sm:max-h-[min(18rem,42vh)] sm:min-h-[6.5rem] sm:text-[16px] md:max-h-none md:overflow-visible md:min-h-[7.5rem]">
                  {currentSubtitleText}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-theme-4">
                  <span>
                    {liveTranscript.trim()
                      ? tr("realtimeStudio.transcript.localPreviewPriority")
                      : currentSessionClosed
                        ? tr("realtimeStudio.transcript.closedHelp")
                        : tr("realtimeStudio.transcript.stableHelp")}
                  </span>
                </div>
              </div>
                    )
                  ) : previewArchivedTranscriptTurns.length ? (
                    <div className="space-y-2.5">
                      {previewArchivedTranscriptTurns.map((turn, index) => {
                        const tone = transcriptSpeakerCardTone(turn.speaker);
                        return (
                        <div
                          key={turn.key || `${turn.speaker}-${turn.start_ms}-${index}`}
                            className={`rounded-lg border px-3 py-2 ${tone.card}`}
                            style={tone.style}
                        >
                          <div className="flex items-center justify-between gap-2 text-[10px] text-theme-4">
                            <span
                              className={`truncate rounded-md border px-1.5 py-0.5 font-semibold ${tone.speaker}`}
                              style={tone.speakerTagStyle}
                            >
                              {turn.speaker || "speaker"}
                            </span>
                            <span className="shrink-0">
                              {formatRelativeTranscriptTime(turn.start_ms)} - {formatRelativeTranscriptTime(turn.end_ms)}
                            </span>
                          </div>
                          <div
                            className={`mt-1 rounded-md px-2 py-1.5 whitespace-pre-wrap text-[12px] leading-6 ${tone.body}`}
                            style={tone.contentStyle}
                          >
                            {turn.text}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-theme-4">
                            <span>
                              {turn.origin === "server"
                                ? "server transcript"
                                : turn.origin === "event"
                                  ? "event fallback"
                                  : "local instant"}
                            </span>
                            <span>{turn.is_final ? "final" : "pending"}</span>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex h-full min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-[color:var(--accent)]/30 bg-[color:var(--accent)]/[0.04] px-3 py-3 text-center text-[12px] leading-relaxed text-theme-3">
                      {currentSessionClosed
                        ? tr("realtimeStudio.text082")
                        : tr("realtimeStudio.text083")}
                    </div>
                  )}
                </div>
              </div>

            </div>

            <div
              className={`mt-2 shrink-0 border-t pt-2.5 ${
                activeCaptureSource ? "border-theme-subtle" : "border-dashed border-[color:var(--accent)]/22"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-theme-1">
                  {tr("realtimeStudio.text084")}
                </div>
                <Badge className="text-[10px]">{Math.round(inputLevel * 100)}%</Badge>
              </div>
              <div className="mt-2 flex h-5 items-center gap-1.5">
                {Array.from({ length: 16 }).map((_, index) => {
                  const level = Math.max(0, Math.min(1, inputLevel));
                  const threshold = (index + 1) / 16;
                  const isActive = level >= threshold;
                  const showActive = Boolean(activeCaptureSource) && isActive;
                  return (
                    <span
                      key={index}
                      className={`h-3 flex-1 rounded-sm border transition-colors duration-150 ${
                        showActive
                          ? "border-violet-800/70 bg-violet-700/80"
                          : "border-theme-subtle bg-surface-muted"
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
                ) : null}

        <div
          className={`order-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overscroll-x-contain xl:row-start-2 xl:min-h-0 ${
            studioPage === 1 ? "xl:col-start-2" : "xl:col-start-1 xl:col-span-2"
          }`}
        >
        {studioPage === 1 ? (
        <ErrorBoundary
          fallbackRender={({ error: boundaryError }: FallbackProps) => (
            <Card className="rounded-[26px] border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              {tr("realtimeStudio.error.boundaryPrefix")}{boundaryError.message}
            </Card>
          )}
        >
          <div className="soft-enter soft-enter-delay-1 flex min-h-0 min-w-0 flex-1 flex-col">
            <Tabs.Root value={stageTab} onValueChange={setStageTab} className="flex min-h-0 flex-1 flex-col">
            <Card className="flex min-h-0 min-w-[960px] flex-1 flex-col overflow-hidden rounded-xl border border-theme-default bg-surface-1 p-0 shadow-lg">
              <div
                className="pointer-events-none h-px w-full shrink-0 bg-gradient-to-r from-transparent via-[color:var(--accent)]/30 to-transparent"
                aria-hidden
              />
              <div className="relative flex shrink-0 flex-wrap items-start justify-between gap-3 px-4 pb-0 pt-0.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Tabs.List className="workspace-tab-list w-full max-w-[460px] grid-cols-3 self-start">
              <span
                aria-hidden
                className="workspace-tab-indicator"
                style={{
                  left: "0.25rem",
                  width: `calc((100% - 0.5rem) / ${stageTabCount})`,
                  transform: `translateX(calc(${activeStageTabIndex} * 100%))`,
                }}
              />
              {stageTabs.map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="workspace-tab-trigger px-2 py-2"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
                  <Tooltip.Provider delayDuration={120}>
                    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 pt-0.5 [-webkit-overflow-scrolling:touch] sm:flex-wrap sm:overflow-x-visible sm:pb-0">
                      {pipelineStages.map((step) => (
                        <Tooltip.Root key={step.abbr}>
                          <Tooltip.Trigger asChild>
                            <button
                              type="button"
                              className={`inline-flex items-center gap-1.5 rounded-md border bg-surface-2 px-2 py-1 text-[11px] font-medium text-theme-2 transition-[box-shadow,border-color] ${
                                pipelineAllIdle && step.abbr === "CAP"
                                  ? "border-[color:var(--accent)]/40 ring-1 ring-[color:var(--accent)]/25"
                                  : "border-theme-default"
                              }`}
                              aria-label={`${step.label}：${step.value}`}
                            >
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  step.tone === "working"
                                    ? "bg-[color:var(--accent)]"
                                    : step.tone === "success"
                                      ? "bg-emerald-500"
                                      : step.tone === "error"
                                        ? "bg-red-500"
                                        : "bg-surface-3"
                                }`}
                                aria-hidden
                              />
                              {step.label}
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              side="bottom"
                              align="center"
                              sideOffset={8}
                              collisionPadding={12}
                              className="z-[24000] w-[220px] rounded-lg border border-theme-default bg-surface-2 px-2.5 py-2 text-left shadow-xl"
                            >
                              <div className="text-[10px] font-semibold tracking-wide text-theme-2">{step.label}</div>
                              <div className="mt-1 text-[11px] font-medium text-theme-1">{step.value}</div>
                              <div className="mt-1.5 text-[10px] leading-4 text-theme-4">{step.help}</div>
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      ))}
                    </div>
                  </Tooltip.Provider>
                  <div className="min-w-0 overflow-x-auto pt-1 pr-1 xl:absolute xl:right-4 xl:top-[3.2rem] xl:z-10 xl:max-w-[min(680px,calc(100%_-_31rem))] xl:overflow-visible xl:pr-0 xl:pt-0">
                    <div className="relative inline-flex items-center rounded-lg border border-[#4f3a86]/90 bg-[#d9d0ef]/95 px-2 py-0.5 shadow-[0_12px_26px_-18px_rgba(83,67,126,0.55)] backdrop-blur-sm">
                      <div className="flex min-w-0 flex-nowrap items-center gap-1.5">

                      <button
                        type="button"
                        disabled={!currentSessionId}
                      className={`inline-flex h-7 w-[64px] shrink-0 items-center justify-center gap-1 rounded-md border border-[#8fa79b] px-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                        activeAnnotationPanel === "pen"
                          ? "bg-white text-[#111827] shadow-[0_0_0_2px_rgba(143,167,155,0.22)]"
                          : "bg-white text-[#111827] hover:bg-white/95"
                      }`}
                        onClick={() => {
                          if (!currentSessionId) return;
                          if (activeAnnotationPanel === "pen") {
                            setActiveAnnotationPanel(null);
                            return;
                          }
                          setAnnotationsEnabled(true);
                          setAnnotationsTool("pen");
                          setActiveAnnotationPanel("pen");
                        }}
                        title={
                          !currentSessionId
                            ? tr("realtimeStudio.text085")
                            : tr("realtimeStudio.text086")
                        }
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0" />
                        <span className="leading-none">{tr("realtimeStudio.text086")}</span>
                      </button>

                      <button
                        type="button"
                        disabled={!currentSessionId}
                      className={`inline-flex h-7 w-[64px] shrink-0 items-center justify-center gap-1 rounded-md border border-[#bba98d] px-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                        activeAnnotationPanel === "rect"
                          ? "bg-white text-[#111827] shadow-[0_0_0_2px_rgba(187,169,141,0.22)]"
                          : "bg-white text-[#111827] hover:bg-white/95"
                      }`}
                        onClick={() => {
                          if (!currentSessionId) return;
                          if (activeAnnotationPanel === "rect") {
                            setActiveAnnotationPanel(null);
                            return;
                          }
                          setAnnotationsEnabled(true);
                          setAnnotationsTool("rect");
                          setActiveAnnotationPanel("rect");
                        }}
                        title={
                          !currentSessionId
                            ? tr("realtimeStudio.text085")
                            : tr("realtimeStudio.text087")
                        }
                      >
                        <Square className="h-3.5 w-3.5 shrink-0" />
                        <span className="leading-none">{tr("realtimeStudio.text088")}</span>
                      </button>

                      <button
                        type="button"
                        disabled={!currentSessionId}
                      className={`inline-flex h-7 w-[64px] shrink-0 items-center justify-center gap-1 rounded-md border border-[#9fb2c4] px-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                        activeAnnotationPanel === "text"
                          ? "bg-white text-[#111827] shadow-[0_0_0_2px_rgba(159,178,196,0.22)]"
                          : "bg-white text-[#111827] hover:bg-white/95"
                      }`}
                        onClick={() => {
                          if (!currentSessionId) return;
                          if (activeAnnotationPanel === "text") {
                            setActiveAnnotationPanel(null);
                            return;
                          }
                          setAnnotationsEnabled(true);
                          setAnnotationsTool("text");
                          setActiveAnnotationPanel("text");
                        }}
                        title={
                          !currentSessionId
                            ? tr("realtimeStudio.text085")
                            : tr("realtimeStudio.text089")
                        }
                      >
                        <Type className="h-3.5 w-3.5 shrink-0" />
                        <span className="leading-none">{tr("realtimeStudio.text090")}</span>
                      </button>

                      <button
                        type="button"
                        disabled={!currentSessionId}
                      className={`inline-flex h-7 w-[64px] shrink-0 items-center justify-center gap-1 rounded-md border border-[#887bb1] px-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                        activeAnnotationPanel === "eraser"
                          ? "bg-white text-[#111827] shadow-[0_0_0_2px_rgba(136,123,177,0.22)]"
                          : "bg-white text-[#111827] hover:bg-white/95"
                      }`}
                        onClick={() => {
                          if (!currentSessionId) return;
                          if (activeAnnotationPanel === "eraser") {
                            setActiveAnnotationPanel(null);
                            return;
                          }
                          setAnnotationsEnabled(true);
                          setAnnotationsTool(
                            annotationsTool === "erase_object" || annotationsTool === "erase_precise"
                              ? annotationsTool
                              : "erase_object",
                          );
                          setActiveAnnotationPanel("eraser");
                        }}
                        title={
                          !currentSessionId
                            ? tr("realtimeStudio.text085")
                            : tr("realtimeStudio.text091")
                        }
                      >
                        <Eraser className="h-3.5 w-3.5 shrink-0" />
                        <span className="leading-none">{tr("realtimeStudio.text091")}</span>
                      </button>

                    {activeAnnotationPanel ? (
                      <div
                        className="absolute left-2 right-2 top-full z-30 mt-2 rounded-2xl border border-[#887bb1] bg-[#d9d2ea]/95 px-3 py-2 shadow-lg backdrop-blur-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                            {activeAnnotationPanel === "pen" ? (
                              <>
                                <div className="flex min-w-[220px] flex-1 items-center gap-2">
                                  <AnnotationWidthSlider
                                    min={1}
                                    max={24}
                                    value={annotationPenWidth}
                                    onChange={setAnnotationPenWidth}
                                    thumbMinPx={5}
                                    thumbMaxPx={15}
                                    aria-label={tr("realtimeStudio.text092")}
                                  />
                                  <AnnotationColorPopover
                                    swatches={ANNOTATION_SWATCHES_LIGHT_CANVAS}
                                    value={annotationPenColor}
                                    onChange={setAnnotationPenColor}
                                  />
                                </div>
                              </>
                            ) : null}

                            {activeAnnotationPanel === "rect" ? (
                              <div className="flex min-w-[220px] flex-1 items-center gap-2">
                                <AnnotationWidthSlider
                                  min={1}
                                  max={16}
                                  value={annotationRectStrokeWidth}
                                  onChange={setAnnotationRectStrokeWidth}
                                  thumbMinPx={5}
                                  thumbMaxPx={14}
                                  aria-label={tr("realtimeStudio.text093")}
                                />
                                <AnnotationColorPopover
                                  swatches={ANNOTATION_SWATCHES_LIGHT_CANVAS}
                                  value={annotationRectColor}
                                  onChange={setAnnotationRectColor}
                                />
                              </div>
                            ) : null}

                            {activeAnnotationPanel === "text" ? (
                              <div className="flex items-center gap-2">
                                <AnnotationColorPopover
                                  swatches={ANNOTATION_SWATCHES_LIGHT_CANVAS}
                                  value={annotationTextColor}
                                  onChange={setAnnotationTextColor}
                                />
                                <span className="text-[10px] font-medium text-theme-3">
                                  {tr("realtimeStudio.text094")}
                                </span>
                              </div>
                            ) : null}

                            {activeAnnotationPanel === "eraser" ? (
                              <div className="flex flex-wrap items-center gap-1.5">
                            {ERASER_WIDTH_PRESETS.map(({ w, dot }) => {
                              const active =
                                annotationsTool === "erase_precise" &&
                                nearestEraserPresetWidth(annotationEraserWidth) === w;
                              return (
                                <button
                                  key={w}
                                  type="button"
                                  title={`${tr("realtimeStudio.text095")} ${w}px`}
                                  aria-label={`${tr("realtimeStudio.text096")} ${w}`}
                                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
                                        active
                                          ? "border-[#887bb1] bg-[#cec6e5] text-[#2d2545]"
                                          : "border-[#9a8bc2] bg-[#ebe6f6] text-[#4a3f6b] hover:bg-[#ddd4ef]"
                                  }`}
                                  onClick={() => {
                                    setAnnotationsEnabled(true);
                                    setAnnotationsTool("erase_precise");
                                    setAnnotationEraserWidth(w);
                                  }}
                                >
                                  <span
                                    className="shrink-0 rounded-full bg-current opacity-90"
                                    style={{ width: dot, height: dot }}
                                    aria-hidden
                                  />
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              title={tr("realtimeStudio.text097")}
                              aria-label={tr("realtimeStudio.text098")}
                                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
                                annotationsTool === "erase_object"
                                      ? "border-[#887bb1] bg-[#cec6e5] text-[#2d2545]"
                                      : "border-[#9a8bc2] bg-[#ebe6f6] text-[#4a3f6b] hover:bg-[#ddd4ef]"
                              }`}
                              onClick={() => {
                                setAnnotationsEnabled(true);
                                setAnnotationsTool("erase_object");
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
                                <path
                                  d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.75"
                                  strokeLinecap="round"
                                />
                              </svg>
                            </button>
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-[#887bb1] bg-[#cec6e5] px-2 text-[11px] font-semibold text-[#2d2545] hover:bg-[#c1b7df]"
                            onClick={() => {
                              setAnnotationsEnabled(false);
                              setActiveAnnotationPanel(null);
                            }}
                          >
                            {tr("realtimeStudio.text099")}
                          </button>
                      </div>
                    </div>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 min-w-[54px] whitespace-nowrap rounded-md border border-[#887bb1] bg-[#d9d2ea] px-2 text-[11px] font-semibold text-[#111827] shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] hover:bg-[#cec6e5]"
                      onClick={undoAnnotations}
                      disabled={!currentSessionId || annotationsUndoRef.current.length === 0}
                    >
                      {tr("realtimeStudio.text100")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 min-w-[54px] whitespace-nowrap rounded-md border border-[#b0737d] bg-[#e6c8ce] px-2 text-[11px] font-semibold text-[#111827] shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] hover:bg-[#ddb7bf]"
                      onClick={clearAnnotations}
                      disabled={!currentSessionId || activeAnnotationEmpty}
                    >
                      {tr("realtimeStudio.text101")}
                    </Button>
                    {!currentSessionId || saveAnnotationsMutation.isPending ? (
                      <span className="ml-1 text-[10px] text-[#6a627b]">
                        {!currentSessionId
                          ? tr("realtimeStudio.text102")
                          : tr("realtimeStudio.text103")}
                    </span>
                    ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                <Tooltip.Provider delayDuration={200}>
                  <div className="ml-auto flex w-auto shrink-0 flex-nowrap items-start justify-end gap-2 sm:gap-3 xl:-mt-2">
                    <div className="flex shrink-0 flex-col items-center">
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <span className="inline-flex">
                            <button
                              type="button"
                              onClick={() => void stageStartCapture()}
                              disabled={!canStartStageCapture}
                              className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 sm:h-12 sm:w-12 ${
                                canStartStageCapture
                                  ? "border-[rgb(76_29_149_/_0.5)] bg-[rgb(46_16_100_/_0.45)] text-white shadow-[0_1px_0_rgb(255_255_255_/_0.42)_inset,0_10px_22px_rgb(109_40_217_/_0.24)] hover:border-[rgb(76_29_149_/_0.62)] hover:bg-[rgb(46_16_100_/_0.55)] focus-visible:ring-[rgb(167_139_250_/_0.45)]"
                                  : "border-violet-900/50 bg-violet-950/45 text-violet-200 focus-visible:ring-violet-700"
                              }`}
                              aria-label={tr("realtimeStudio.text104")}
                            >
                              <Mic className="h-5 w-5 sm:h-6 sm:w-6" />
                            </button>
                          </span>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="bottom"
                            align="center"
                            sideOffset={8}
                            collisionPadding={12}
                            className="z-[24000] max-w-[240px] rounded-lg border border-theme-default bg-surface-2 px-2.5 py-1.5 text-center text-xs font-medium text-theme-1 shadow-xl"
                          >
                            {selectedInputSource === "transcript"
                              ? tr("realtimeStudio.text105")
                              : tr("realtimeStudio.text104")}
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    </div>

                    <div className="flex shrink-0 flex-col items-center">
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <span className="inline-flex">
                            <button
                              type="button"
                              onClick={() => void stageStopCapture()}
                              disabled={!canStopStageCapture}
                              className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 sm:h-12 sm:w-12 ${
                                canStopStageCapture
                                  ? "border-red-200/90 bg-red-700/70 text-red-50 shadow-[0_0_0_1px_rgba(239,68,68,0.30)_inset,0_10px_22px_rgba(220,38,38,0.32)] hover:border-red-200/95 hover:bg-red-700/75 focus-visible:ring-red-200/80"
                                  : "border-red-900/50 bg-red-950/40 text-red-200 focus-visible:ring-red-800"
                              }`}
                              aria-label={tr("realtimeStudio.text106")}
                            >
                              <Pause className="h-5 w-5 sm:h-6 sm:w-6" />
                            </button>
                          </span>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="bottom"
                            align="center"
                            sideOffset={8}
                            collisionPadding={12}
                            className="z-[24000] max-w-[240px] rounded-lg border border-theme-default bg-surface-2 px-2.5 py-1.5 text-center text-xs font-medium text-theme-1 shadow-xl"
                          >
                            {selectedInputSource === "transcript"
                              ? tr("realtimeStudio.text105")
                              : tr("realtimeStudio.text106")}
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    </div>

                    <div className="flex shrink-0 flex-col items-center">
                      <Button
                        type="button"
                        variant="secondary"
                        className="inline-flex h-10 shrink-0 gap-2 rounded-xl px-3 text-xs shadow-sm sm:h-12 sm:px-3.5 sm:text-sm"
                        onClick={() => setDetailDrawerOpen(true)}
                      >
                        <PanelRight className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                        {tr("realtimeStudio.text107")}
                      </Button>
                    </div>
                  </div>
                </Tooltip.Provider>
              </div>

            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Tabs.Content value="mermaid" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-0 pt-3.5 sm:px-3">
                <MermaidCard
                  title=""
                  embedded
                  fixedLightCanvas
                  code={displayedMermaidCode}
                  rawOutputText={typeof mermaidState?.raw_output_text === "string" ? mermaidState.raw_output_text : null}
                  repairRawOutputText={
                    typeof mermaidState?.repair_raw_output_text === "string" ? mermaidState.repair_raw_output_text : null
                  }
                  provider={mermaidState?.provider || selectedPlannerProfile?.label || null}
                  model={mermaidState?.model || plannerModel || null}
                  latencyMs={typeof mermaidState?.latency_ms === "number" ? mermaidState.latency_ms : null}
                  compileOk={typeof mermaidState?.compile_ok === "boolean" ? mermaidState.compile_ok : null}
                  updatedAt={lastMermaidUpdatedAt || toLocalDateTimeLabel(mermaidState?.updated_at ? String(mermaidState.updated_at) : null, language)}
                  graphPayload={currentGraphPayload}
                  onNodeRelayout={handleMermaidNodeRelayout}
                  relayoutBusy={relayoutMutation.isPending}
                  exportRootId={mermaidExportRootId}
                  annotationsEnabled={annotationsEnabled}
                  annotationsTool={annotationsTool}
                  annotationPenWidth={annotationPenWidth}
                  annotationPenColor={annotationPenColor}
                  annotationRectColor={annotationRectColor}
                  annotationRectStrokeWidth={annotationRectStrokeWidth}
                  annotationTextColor={annotationTextColor}
                  annotationEraserWidth={annotationEraserWidth}
                  annotationsDoc={mermaidAnnotationsDoc}
                  onAnnotationsChange={onMermaidAnnotationsChange}
                  panZoomControlsOffsetTop={activeAnnotationPanel ? 72 : 12}
                />
              </div>
            </Tabs.Content>

            <Tabs.Content value="structure" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-0 pt-3.5 sm:px-3">
                <GraphStage
                  embedded
                  fixedLightCanvas
                  title={tr("realtimeStudio.text108")}
                  nodes={rendererState.nodes || []}
                  edges={rendererState.edges || []}
                  groups={rendererGroups}
                  annotationsEnabled={annotationsEnabled}
                  annotationsTool={annotationsTool}
                  annotationPenWidth={annotationPenWidth}
                  annotationPenColor={annotationPenColor}
                  annotationRectColor={annotationRectColor}
                  annotationRectStrokeWidth={annotationRectStrokeWidth}
                  annotationTextColor={annotationTextColor}
                  annotationEraserWidth={annotationEraserWidth}
                  annotationsDoc={structureAnnotationsDoc}
                  onAnnotationsChange={onStructureAnnotationsChange}
                  panZoomControlsOffsetTop={activeAnnotationPanel ? 72 : 12}
                />
              </div>
            </Tabs.Content>

            <Tabs.Content value="events" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="mb-4 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-theme-1">
                      {tr("realtimeStudio.text109")}
                    </div>
                    <p className="mt-1 text-xs leading-6 text-theme-2">
                      {tr("realtimeStudio.text110")}
                    </p>
                  </div>
                  <Badge>{timelineNodes.length} snapshots</Badge>
                </div>
                <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
                  <div className="min-h-0 overflow-auto rounded-xl border border-theme-default bg-surface-2/70 p-2">
                    {timelineNodes.length ? (
                      <div className="space-y-2">
                        {timelineNodes.map((node: RealtimeTimelineNode) => {
                          const active = node.snapshot_id === selectedTimelineSnapshotId;
                          return (
                            <button
                              key={node.snapshot_id}
                              type="button"
                              onClick={() => setSelectedTimelineSnapshotId(node.snapshot_id)}
                              className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                                active
                                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/[0.08]"
                                  : "border-theme-default bg-surface-1 hover:border-theme-strong"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-semibold text-theme-1">
                                  {node.label || tr("realtimeStudio.text111")}
                                </div>
                                <div className="text-[10px] text-theme-4">
                                  {new Date(node.created_at).toLocaleTimeString(currentDateLocale, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                  })}
                          </div>
                          </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-theme-3">
                                <span>{node.chunk_count} chunks</span>
                                <span>{node.event_count} events</span>
                        </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-theme-default px-3 py-4 text-xs text-theme-3">
                        {tr("realtimeStudio.text112")}
                      </div>
                    )}
                  </div>
                  <div className="min-h-0 overflow-auto rounded-xl border border-theme-default bg-surface-2/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-theme-1">
                        {tr("realtimeStudio.text113")}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          className="h-7 px-2 text-[11px]"
                          onClick={() =>
                            currentSessionId && selectedTimelineSnapshotId
                              ? rollbackPreviewMutation.mutate({
                                  sessionId: currentSessionId,
                                  snapshotId: selectedTimelineSnapshotId,
                                })
                              : null
                          }
                          disabled={!currentSessionId || !selectedTimelineSnapshotId || rollbackPreviewMutation.isPending}
                        >
                          {tr("realtimeStudio.text114")}
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          className="h-7 px-2 text-[11px]"
                          onClick={() =>
                            currentSessionId && selectedTimelineSnapshotId
                              ? rollbackApplyMutation.mutate({
                                  sessionId: currentSessionId,
                                  snapshotId: selectedTimelineSnapshotId,
                                })
                              : null
                          }
                          disabled={
                            !currentSessionId ||
                            !selectedTimelineSnapshotId ||
                            rollbackApplyMutation.isPending ||
                            currentSessionClosed
                          }
                        >
                          {rollbackApplyMutation.isPending
                            ? tr("realtimeStudio.text115")
                            : tr("realtimeStudio.text116")}
                        </Button>
                      </div>
                    </div>
                    {rollbackPreview ? (
                      <div className="mt-3 space-y-2 text-xs text-theme-2">
                        <div className="rounded-lg border border-theme-default bg-surface-1 px-3 py-2">
                          <div className="font-medium text-theme-1">{tr("realtimeStudio.text117")}</div>
                          <div className="mt-1 text-theme-3">{new Date(rollbackPreview.created_at).toLocaleString(currentDateLocale)}</div>
                        </div>
                        <div className="rounded-lg border border-theme-default bg-surface-1 px-3 py-2">
                          <div className="font-medium text-theme-1">{tr("realtimeStudio.text118")}</div>
                          <div className="mt-1 text-theme-3">
                            {tr("realtimeStudio.text119")} ({rollbackPreview.transcript_turn_count} {tr("realtimeStudio.text120")}) + {tr("realtimeStudio.text121")} v{rollbackPreview.annotation_version}
                          </div>
                        </div>
                        <div className="rounded-lg border border-theme-default bg-surface-1 px-3 py-2">
                          <div className="font-medium text-theme-1">{tr("realtimeStudio.text122")}</div>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-theme-3">
                            {JSON.stringify(rollbackPreview.summary || {}, null, 2)}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg border border-dashed border-theme-default px-3 py-4 text-xs text-theme-3">
                        {selectedTimelineNode
                          ? tr("realtimeStudio.text123")
                          : tr("realtimeStudio.text124")}
                      </div>
                    )}
                    <div className="mt-4 border-t border-theme-subtle pt-3">
                      <div className="mb-2 text-xs font-semibold text-theme-1">
                        {tr("realtimeStudio.text125")}
                      </div>
                      <div className="space-y-2">
                        {events.length ? (
                          events.slice(-6).map((event: Record<string, any>, index: number) => (
                            <div key={`${event.update?.update_id}-${index}`} className="rounded-lg border border-theme-default bg-surface-1 px-3 py-2">
                              <div className="text-xs font-semibold text-theme-1">
                                Update #{event.update?.update_id} · {event.gate?.action || event.update?.intent_type}
                              </div>
                              <div className="mt-1 text-[11px] text-theme-3">
                                {event.update?.transcript_text ||
                                  (Array.isArray(event.pending_turns)
                            ? event.pending_turns
                                .map((turn: Record<string, any>) => `${turn.speaker || "speaker"}: ${turn.content || ""}`)
                                        .join(" / ")
                                    : "-")}
                        </div>
                      </div>
                    ))
                  ) : (
                          <div className="rounded-lg border border-dashed border-theme-default px-3 py-3 text-xs text-theme-3">
                            {tr("realtimeStudio.timeline.emptyEvents")}
                    </div>
                  )}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </Tabs.Content>

            </div>
            <div className="relative z-0 shrink-0 translate-y-3.5 border-t border-theme-subtle px-4 py-1.5">
              <div className="px-1 py-0.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold text-theme-1">
                    {tr("realtimeStudio.text126")}
                  </div>
                  <div className="text-[10px] text-theme-4">{orderedTimelineNodes.length} snapshots</div>
                </div>
                {isTimelineScrollable ? (
                  <div className="mt-1.5">
                    <div className="relative">
                      <div ref={timelineScrollViewportRef} className="overflow-x-auto pb-1 [scrollbar-width:thin]">
                        <div
                          className="relative mx-1 h-8 px-2 py-1"
                          style={{ width: `${timelineScrollableTrackWidth}px` }}
                        >
                          <div className="pointer-events-none absolute left-2 right-2 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-[#d6ccf0]/85" />
                          <div className="relative h-full">
                            {orderedTimelineNodes.length ? (
                              orderedTimelineNodes.map((node: RealtimeTimelineNode, index: number) => {
                                const active = node.snapshot_id === selectedTimelineSnapshotId;
                                const nodeName =
                                  node.label ||
                                  `${tr("realtimeStudio.text127")} ${new Date(node.created_at).toLocaleTimeString(currentDateLocale, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                  })}`;
                                return (
                                  <button
                                    key={node.snapshot_id}
                                    type="button"
                                    title={nodeName}
                                    onClick={() => {
                                      setSelectedTimelineSnapshotId(node.snapshot_id);
                                      setAutoFollowLatestTimelineNode(node.snapshot_id === timelineNodes[0]?.snapshot_id);
                                    }}
                                  onMouseEnter={(e) => {
                                    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                    setTimelineHoverTooltip({
                                      text: nodeName,
                                      x: rect.left + rect.width / 2,
                                      y: rect.top - 6,
                                    });
                                  }}
                                  onMouseMove={(e) => {
                                    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                    setTimelineHoverTooltip({
                                      text: nodeName,
                                      x: rect.left + rect.width / 2,
                                      y: rect.top - 6,
                                    });
                                  }}
                                  onMouseLeave={() => setTimelineHoverTooltip(null)}
                                    className={`group absolute top-1/2 z-[0] -translate-y-1/2 transition-all duration-300 ease-out ${
                                      active
                                        ? "h-3 w-8 rounded-full bg-[color:var(--accent)] shadow-[0_0_0_2px_rgba(167,139,250,0.16)]"
                                        : "h-3 w-3 rounded-full bg-[#b7bdd0] hover:bg-[#a58bd4]"
                                    }`}
                                    style={{ left: `${6 + index * timelineScrollStep}px` }}
                                    aria-label={nodeName}
                                  >
                                    <span className="hidden">{nodeName}</span>
                                  </button>
                                );
                              })
                            ) : (
                              <div className="text-[10px] text-theme-3">
                                {tr("realtimeStudio.text128")}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      {isTimelinePreviewActive && timelineScrollableSelectedLeft != null ? (
                        <div
                          className="pointer-events-none absolute z-[3]"
                          style={{
                            left: `${timelineScrollableSelectedLeft - timelineScrollLeft + 8}px`,
                            top: "-0.35rem",
                            transform: "translate(-50%, -100%)",
                          }}
                        >
                          <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[color:var(--accent)]/35 bg-surface-1/95 px-2 py-1 shadow-sm backdrop-blur-sm whitespace-nowrap">
                            <div className="flex flex-nowrap items-center gap-1">
                              <Button
                                type="button"
                                variant="secondary"
                                className="h-5 px-1.5 text-[10px] leading-none whitespace-nowrap"
                                onClick={() => setRollbackPreview(null)}
                              >
                                {tr("realtimeStudio.text129")}
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                className="h-5 px-1.5 text-[10px] leading-none whitespace-nowrap"
                                onClick={() => {
                                  if (!selectedTimelineSnapshotId || rollbackPreview?.snapshot_id !== selectedTimelineSnapshotId) {
                                    setNotice({ tone: "info", text: tr("realtimeStudio.notice.timelinePreviewLoading") });
                                    return;
                                  }
                                  const turns = rollbackPreview?.turns;
                                  if (!Array.isArray(turns) || !turns.length) {
                                    setRollbackEditTurns([]);
                                  } else {
                                    setRollbackEditTurns(
                                      turns.map((t) => ({
                                        speaker: String(t.speaker || "speaker"),
                                        text: String(t.text || ""),
                                      })),
                                    );
                                  }
                                  setRollbackEditOpen(true);
                                }}
                                disabled={!currentSessionId || !selectedTimelineSnapshotId || currentSessionClosed}
                              >
                                {tr("realtimeStudio.text130")}
                              </Button>
                              <Button
                                type="button"
                                variant="danger"
                                className="h-5 px-1.5 text-[10px] leading-none whitespace-nowrap"
                                onClick={() =>
                                  currentSessionId && selectedTimelineSnapshotId
                                    ? rollbackApplyMutation.mutate({
                                        sessionId: currentSessionId,
                                        snapshotId: selectedTimelineSnapshotId,
                                      })
                                    : null
                                }
                                disabled={
                                  !currentSessionId ||
                                  !selectedTimelineSnapshotId ||
                                  rollbackPreview?.snapshot_id !== selectedTimelineSnapshotId ||
                                  rollbackApplyMutation.isPending ||
                                  currentSessionClosed
                                }
                              >
                                {rollbackApplyMutation.isPending
                                  ? tr("realtimeStudio.text131")
                                  : tr("realtimeStudio.text132")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-theme-4">
                      {tr("realtimeStudio.text133")}
                    </div>
                  </div>
                ) : (
                  <div className="relative mt-1.5 px-0.5">
                    <div className="pointer-events-none absolute left-[6px] right-[6px] top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-[#d6ccf0]/85" />
                    <div className="relative flex items-center justify-between gap-1">
                      {orderedTimelineNodes.length ? (
                        orderedTimelineNodes.map((node: RealtimeTimelineNode) => {
                          const active = node.snapshot_id === selectedTimelineSnapshotId;
                          const nodeName =
                            node.label ||
                            `${tr("realtimeStudio.text127")} ${new Date(node.created_at).toLocaleTimeString(currentDateLocale, {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}`;
                          return (
                            <button
                              key={node.snapshot_id}
                              type="button"
                              title={nodeName}
                              onClick={() => {
                                setSelectedTimelineSnapshotId(node.snapshot_id);
                                setAutoFollowLatestTimelineNode(node.snapshot_id === timelineNodes[0]?.snapshot_id);
                              }}
                              onMouseEnter={(e) => {
                                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                setTimelineHoverTooltip({
                                  text: nodeName,
                                  x: rect.left + rect.width / 2,
                                  y: rect.top - 6,
                                });
                              }}
                              onMouseMove={(e) => {
                                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                setTimelineHoverTooltip({
                                  text: nodeName,
                                  x: rect.left + rect.width / 2,
                                  y: rect.top - 6,
                                });
                              }}
                              onMouseLeave={() => setTimelineHoverTooltip(null)}
                              className={`group relative z-[1] shrink-0 transition-all duration-300 ease-out ${
                                active
                                  ? "h-3 w-8 rounded-full bg-[color:var(--accent)] shadow-[0_0_0_2px_rgba(167,139,250,0.16)]"
                                  : "h-3 w-3 rounded-full bg-[#b7bdd0] hover:bg-[#a58bd4]"
                              }`}
                              aria-label={nodeName}
                            >
                              <span className="hidden">{nodeName}</span>
                            </button>
                          );
                        })
                      ) : (
                        <div className="text-[10px] text-theme-3">
                          {tr("realtimeStudio.text128")}
                        </div>
                      )}
                    </div>
                    {isTimelinePreviewActive && selectedTimelineOrderedIndex >= 0 ? (
                      <div
                        className="pointer-events-none absolute z-[3]"
                        style={{
                          left:
                            orderedTimelineNodes.length > 1
                              ? `calc(6px + ((100% - 12px) * ${selectedTimelineOrderedIndex}) / ${orderedTimelineNodes.length - 1})`
                              : "50%",
                          top: "-0.35rem",
                          transform: "translate(-50%, -100%)",
                        }}
                      >
                        <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[color:var(--accent)]/35 bg-surface-1/95 px-2 py-1 shadow-sm backdrop-blur-sm whitespace-nowrap">
                          <div className="flex flex-nowrap items-center gap-1">
                            <Button
                              type="button"
                              variant="secondary"
                              className="h-5 px-1.5 text-[10px] leading-none whitespace-nowrap"
                              onClick={() => setRollbackPreview(null)}
                            >
                                {tr("realtimeStudio.text129")}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              className="h-5 px-1.5 text-[10px] leading-none whitespace-nowrap"
                              onClick={() => {
                                if (
                                  !selectedTimelineSnapshotId ||
                                  rollbackPreview?.snapshot_id !== selectedTimelineSnapshotId
                                ) {
                                  setNotice({ tone: "info", text: tr("realtimeStudio.notice.timelinePreviewLoading") });
                                  return;
                                }
                                const turns = rollbackPreview?.turns;
                                if (!Array.isArray(turns) || !turns.length) {
                                  setRollbackEditTurns([]);
                                } else {
                                  setRollbackEditTurns(
                                    turns.map((t) => ({
                                      speaker: String(t.speaker || "speaker"),
                                      text: String(t.text || ""),
                                    })),
                                  );
                                }
                                setRollbackEditOpen(true);
                              }}
                              disabled={!currentSessionId || !selectedTimelineSnapshotId || currentSessionClosed}
                            >
                                {tr("realtimeStudio.text130")}
                            </Button>
                            <Button
                              type="button"
                              variant="danger"
                              className="h-5 px-1.5 text-[10px] leading-none whitespace-nowrap"
                              onClick={() =>
                                currentSessionId && selectedTimelineSnapshotId
                                  ? rollbackApplyMutation.mutate({
                                      sessionId: currentSessionId,
                                      snapshotId: selectedTimelineSnapshotId,
                                    })
                                  : null
                              }
                              disabled={
                                !currentSessionId ||
                                !selectedTimelineSnapshotId ||
                                rollbackPreview?.snapshot_id !== selectedTimelineSnapshotId ||
                                rollbackApplyMutation.isPending ||
                                currentSessionClosed
                              }
                            >
                                {rollbackApplyMutation.isPending
                                  ? tr("realtimeStudio.text131")
                                  : tr("realtimeStudio.text132")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
            <div className="flex shrink-0 translate-y-3.5 flex-wrap items-end justify-between gap-3 px-4 py-2.5">
              <div className="flex w-full max-w-[min(100%,30rem)] flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={currentSessionId ? "secondary" : "primary"}
                  className="s2g-cta-create-session h-8 shrink-0 gap-1 px-3 text-xs font-semibold shadow-none"
                  onClick={() => createSession.mutate()}
                  disabled={createSession.isPending}
                >
                  <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {currentSessionId
                      ? tr("realtimeStudio.text134")
                      : tr("realtimeStudio.text135")}
                  </span>
                </Button>
                {isTitleEditing ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Input
                      value={titleDraft}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setTitleDraft(event.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-theme-default bg-surface-2 text-sm text-theme-1"
                      placeholder={tr("realtimeStudio.text136")}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 shrink-0 gap-1 px-2 text-xs font-semibold"
                      onClick={() => void commitTitleEdit()}
                      disabled={!titleDraft.trim() || renameSessionMutation.isPending || currentSessionClosed}
                    >
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      {tr("realtimeStudio.text137")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 shrink-0 px-2 text-xs font-semibold"
                      onClick={cancelTitleEdit}
                    >
                      {tr("realtimeStudio.text129")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <div className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-theme-default bg-surface-2 px-2.5 text-sm font-medium text-theme-1">
                      <span className="min-w-0 flex-1 truncate pl-0.5">{titleDisplay}</span>
                      <button
                        type="button"
                        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-theme-default bg-surface-3 px-2 text-[11px] font-medium text-theme-2 transition hover:bg-surface-3"
                        onClick={startTitleEdit}
                        disabled={currentSessionClosed}
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0" />
                        {tr("realtimeStudio.text138")}
                      </button>
                    </div>
                  </div>
                )}
                {currentSessionClosed && transcriptDownloads ? (
                  <div className="flex w-full flex-wrap gap-2 text-xs">
                    <a
                      href={transcriptDownloads.txt_url}
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-theme-default bg-surface-2 px-3 font-semibold text-theme-2 transition hover:border-theme-strong hover:bg-surface-3"
                    >
                      {tr("realtimeStudio.text139")}
                    </a>
                    <a
                      href={transcriptDownloads.markdown_url}
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-theme-default bg-surface-2 px-3 font-semibold text-theme-2 transition hover:border-theme-strong hover:bg-surface-3"
                    >
                      {tr("realtimeStudio.text140")}
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="grid w-[min(100%,20rem)] grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  title={tr("realtimeStudio.text141")}
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => (currentSessionId ? saveReportMutation.mutate(currentSessionId) : null)}
                  disabled={!currentSessionId || saveReportMutation.isPending}
                >
                  <Save className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {saveReportMutation.isPending
                      ? tr("realtimeStudio.text142")
                      : tr("realtimeStudio.text143")}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  title={tr("realtimeStudio.text144")}
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={downloadCurrentGraph}
                  disabled={!currentSessionId || !currentGraphPayload}
                >
                  <Download className="h-3 w-3 shrink-0" />
                  <span className="truncate">{tr("realtimeStudio.text145")}</span>
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  title={tr("realtimeStudio.text146")}
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => void handleCloseSession()}
                  disabled={!currentSessionId || currentSessionClosed || closeMutation.isPending}
                >
                  <StopCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {currentSessionClosed
                      ? tr("realtimeStudio.text073")
                      : tr("realtimeStudio.text147")}
                  </span>
                </Button>
              </div>
            </div>
            </Card>
            </Tabs.Root>
          </div>
        </ErrorBoundary>
        ) : null}
        </div>
      </div>

        {studioPage === 2 ? null : null}
      </div>

      {detailDrawerPortalReady
        ? createPortal(
            <>
              {detailDrawerOpen ? (
                <button
                  type="button"
                  aria-label={tr("realtimeStudio.text148")}
                  className="fixed inset-0 z-[100] bg-surface-muted backdrop-blur-[5px] transition-opacity"
                  onClick={() => setDetailDrawerOpen(false)}
                />
              ) : null}
              <aside
                aria-hidden={!detailDrawerOpen}
                className={`fixed inset-y-0 right-0 z-[110] flex w-[min(420px,92vw)] max-w-full transition-transform duration-300 ease-out ${
                  detailDrawerOpen ? "translate-x-0 shadow-[0_0_40px_rgba(15,23,42,0.12)]" : "pointer-events-none translate-x-full"
                }`}
              >
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-y-0 border-r-0 border-l border-theme-default bg-surface-1 p-3 shadow-none sm:my-4 sm:mr-4 sm:h-[calc(100vh-2rem)] sm:rounded-2xl sm:border sm:border-theme-default sm:shadow-xl">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-default bg-surface-1">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-default px-2 py-2">
              <div className="text-sm font-semibold text-theme-1">
                {tr("realtimeStudio.text149")}
              </div>
                  <Button
              type="button"
                    variant="ghost"
              className="h-9 shrink-0 gap-2 rounded-lg px-3 text-xs"
              onClick={() => setDetailDrawerOpen(false)}
              aria-label={tr("realtimeStudio.text150")}
                  >
              {tr("realtimeStudio.text151")}
              <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2 pt-3">
              {sessions.data?.map((item) => {
                const sessionSelected = currentSessionId === item.session_id;
                return (
                  <div
                    key={item.session_id}
                    className={`group flex w-full items-stretch gap-0 overflow-hidden rounded-lg border text-sm transition duration-200 ease-out ${
                      sessionSelected
                        ? "border-[color:var(--shell-nav-active-border)] bg-[var(--shell-nav-active-bg)] shadow-[var(--shell-nav-active-shadow)]"
                        : "border-theme-default bg-surface-muted hover:border-theme-default hover:bg-surface-muted"
                    }`}
                  >
                    <button
                      type="button"
                      className={`min-w-0 flex-1 px-3 py-3 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-[color:var(--shell-nav-active-icon-border)] focus-visible:ring-offset-2 ${
                        sessionSelected
                          ? "focus-visible:ring-offset-[var(--shell-nav-active-bg)]"
                          : "focus-visible:ring-offset-surface-muted"
                      }`}
                      onClick={() => {
                        setCurrentSessionId(item.session_id);
                        setTitle(item.title || defaultSessionTitle);
                        setTitleDraft(item.title || defaultSessionTitle);
                        setIsTitleEditing(false);
                        window.localStorage.setItem(LOCAL_SESSION_KEY, item.session_id);
                        setDetailDrawerOpen(false);
                      }}
                    >
                      <div
                        className={`font-semibold ${
                          sessionSelected ? "text-[color:var(--shell-nav-active-fg)]" : "text-theme-3"
                        }`}
                      >
                        {item.title}
                      </div>
                      <div className={`mt-1 text-xs ${sessionSelected ? "text-white/80" : "text-theme-4"}`}>
                        {item.session_id}
                      </div>
                      <div className={`mt-1 text-xs ${sessionSelected ? "text-white/70" : "text-theme-4"}`}>
                        {tr("realtimeStudio.text152")}
                        {item.status === "closed"
                          ? tr("realtimeStudio.text153")
                          : tr("realtimeStudio.text154")}
                      </div>
                      {item.summary?.input_runtime?.input_source ? (
                        <div className={`mt-2 text-xs ${sessionSelected ? "text-white/70" : "text-theme-4"}`}>
                          {tr("realtimeStudio.text155")}{String(item.summary.input_runtime.input_source)}
                        </div>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className={`shrink-0 border-l px-2 transition disabled:pointer-events-none disabled:opacity-40 ${
                        sessionSelected
                          ? "border-white/25 text-red-200 hover:bg-red-950/40 hover:text-red-100"
                          : "border-theme-default text-red-500 hover:bg-red-500/10 hover:text-red-400"
                      }`}
                      aria-label={tr("realtimeStudio.text156")}
                      disabled={deleteSessionMutation.isPending}
                      onClick={(e) => handleDeleteHistorySession(e, item.session_id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
              </aside>
            </>,
            document.body
          )
        : null}

      {detailDrawerPortalReady && deleteSessionConfirmId
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center p-4"
              role="presentation"
            >
              <button
                type="button"
                className="absolute inset-0 bg-[var(--shell-backdrop)] backdrop-blur-[2px] transition-opacity"
                aria-label={tr("realtimeStudio.text157")}
                onClick={() => setDeleteSessionConfirmId(null)}
              />
              <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-session-dialog-title"
                aria-describedby="delete-session-dialog-desc"
                className="relative z-[1] w-full max-w-[min(400px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-theme-default bg-surface-1 text-left shadow-[var(--shadow-lift)]"
              >
                <div className="border-b border-theme-default bg-surface-muted/80 px-6 pb-6 pt-6 theme-dark:bg-surface-2/90 theme-light:bg-surface-2/70">
                  <div className="flex gap-3.5">
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-red-500/25 theme-dark:bg-red-950/45 theme-dark:text-red-300 theme-light:bg-red-50 theme-light:text-red-600"
                      aria-hidden
                    >
                      <Trash2 className="h-6 w-6" strokeWidth={2} />
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <h2 id="delete-session-dialog-title" className="text-lg font-semibold tracking-tight text-theme-1">
                        {tr("realtimeStudio.text158")}
                      </h2>
                      <p id="delete-session-dialog-desc" className="mt-3 text-base leading-relaxed text-theme-3">
                        {tr("realtimeStudio.text159")}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col-reverse gap-1.5 px-5 py-2.5 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 min-h-0 w-full px-3 py-1 text-xs font-semibold sm:w-auto"
                    disabled={deleteSessionMutation.isPending}
                    onClick={() => setDeleteSessionConfirmId(null)}
                  >
                    {tr("realtimeStudio.text129")}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    className="h-8 min-h-0 w-full px-3 py-1 text-xs font-semibold sm:w-auto"
                    disabled={deleteSessionMutation.isPending}
                    onClick={() => void confirmDeleteHistorySession()}
                  >
                    {deleteSessionMutation.isPending
                      ? tr("realtimeStudio.text160")
                      : tr("realtimeStudio.text158")}
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
