"use client";

import { assign, setup } from "xstate";

import type { InputSource } from "@/lib/audio-input";

export type RecognitionBackend =
  | "manual"
  | "browser_speech"
  | "browser_display_validation"
  | "local_helper"
  | "api_stt";

export type CaptureStatus = "idle" | "capturing" | "uploading";
export type BackendStatus = "idle" | "working" | "success" | "error";
type RealtimeStudioEvent =
  | { type: "source.select"; source: InputSource; backend: RecognitionBackend }
  | { type: "backend.select"; backend: RecognitionBackend }
  | { type: "capture.start" }
  | { type: "capture.uploading" }
  | { type: "capture.stop" }
  | { type: "audio.level"; level: number }
  | { type: "transcript.preview"; text: string }
  | { type: "stt.working" }
  | { type: "stt.success"; text: string }
  | { type: "stt.error"; message: string }
  | { type: "llm.working" }
  | { type: "llm.success"; updatedAt: string | null }
  | { type: "llm.error"; message: string; updatedAt: string | null }
  | { type: "error.clear" };

export const realtimeStudioMachine = setup({
  types: {} as {
    context: {
      selectedInputSource: InputSource;
      recognitionBackend: RecognitionBackend;
      captureStatus: CaptureStatus;
      sttStatus: BackendStatus;
      llmStatus: BackendStatus;
      inputLevel: number;
      liveTranscript: string;
      error: string | null;
      lastMermaidUpdatedAt: string | null;
    };
    events: RealtimeStudioEvent;
  },
}).createMachine({
  id: "realtimeStudio",
  context: {
    selectedInputSource: "transcript",
    recognitionBackend: "manual",
    captureStatus: "idle",
    sttStatus: "idle",
    llmStatus: "idle",
    inputLevel: 0,
    liveTranscript: "",
    error: null,
    lastMermaidUpdatedAt: null,
  },
  on: {
    "source.select": {
      actions: assign({
        selectedInputSource: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "source.select" }> }) =>
          event.source,
        recognitionBackend: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "source.select" }> }) =>
          event.backend,
        captureStatus: "idle",
        sttStatus: "idle",
        llmStatus: "idle",
        inputLevel: 0,
        liveTranscript: "",
        error: null,
      }),
    },
    "backend.select": {
      actions: assign({
        recognitionBackend: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "backend.select" }> }) =>
          event.backend,
        captureStatus: "idle",
        sttStatus: "idle",
        llmStatus: "idle",
        inputLevel: 0,
        liveTranscript: "",
        error: null,
      }),
    },
    "capture.start": {
      actions: assign({
        captureStatus: "capturing",
        inputLevel: 0,
        error: null,
      }),
    },
    "capture.uploading": {
      actions: assign({
        captureStatus: "uploading",
      }),
    },
    "capture.stop": {
      actions: assign({
        captureStatus: "idle",
        sttStatus: "idle",
        inputLevel: 0,
      }),
    },
    "audio.level": {
      actions: assign({
        inputLevel: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "audio.level" }> }) => event.level,
      }),
    },
    "transcript.preview": {
      actions: assign({
        liveTranscript: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "transcript.preview" }> }) =>
          event.text,
      }),
    },
    "stt.working": {
      actions: assign({
        sttStatus: "working",
        error: null,
      }),
    },
    "stt.success": {
      actions: assign({
        sttStatus: "success",
        liveTranscript: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "stt.success" }> }) => event.text,
        error: null,
      }),
    },
    "stt.error": {
      actions: assign({
        sttStatus: "error",
        error: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "stt.error" }> }) => event.message,
      }),
    },
    "llm.working": {
      actions: assign({
        llmStatus: "working",
      }),
    },
    "llm.success": {
      actions: assign({
        llmStatus: "success",
        error: null,
        lastMermaidUpdatedAt: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "llm.success" }> }) =>
          event.updatedAt,
      }),
    },
    "llm.error": {
      actions: assign({
        llmStatus: "error",
        error: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "llm.error" }> }) => event.message,
        lastMermaidUpdatedAt: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "llm.error" }> }) =>
          event.updatedAt,
      }),
    },
    "error.clear": {
      actions: assign({
        error: null,
      }),
    },
  },
});
