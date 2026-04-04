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
  | { type: "gate.working" }
  | { type: "gate.success" }
  | { type: "gate.error"; message: string }
  | { type: "planner.working" }
  | { type: "planner.success" }
  | { type: "planner.error"; message: string }
  | { type: "mermaid.success"; updatedAt: string | null }
  | { type: "mermaid.error"; message: string; updatedAt: string | null }
  | { type: "error.clear" };

export const realtimeStudioMachine = setup({
  types: {} as {
    context: {
      selectedInputSource: InputSource;
      recognitionBackend: RecognitionBackend;
      captureStatus: CaptureStatus;
      sttStatus: BackendStatus;
      gateStatus: BackendStatus;
      plannerStatus: BackendStatus;
      mermaidStatus: BackendStatus;
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
    selectedInputSource: "demo_mode",
    recognitionBackend: "manual",
    captureStatus: "idle",
    sttStatus: "idle",
    gateStatus: "idle",
    plannerStatus: "idle",
    mermaidStatus: "idle",
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
        gateStatus: "idle",
        plannerStatus: "idle",
        mermaidStatus: "idle",
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
        gateStatus: "idle",
        plannerStatus: "idle",
        mermaidStatus: "idle",
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
        gateStatus: "idle",
        plannerStatus: "idle",
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
    "gate.working": {
      actions: assign({
        gateStatus: "working",
      }),
    },
    "gate.success": {
      actions: assign({
        gateStatus: "success",
        error: null,
      }),
    },
    "gate.error": {
      actions: assign({
        gateStatus: "error",
        error: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "gate.error" }> }) => event.message,
      }),
    },
    "planner.working": {
      actions: assign({
        plannerStatus: "working",
      }),
    },
    "planner.success": {
      actions: assign({
        plannerStatus: "success",
        error: null,
      }),
    },
    "planner.error": {
      actions: assign({
        plannerStatus: "error",
        error: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "planner.error" }> }) => event.message,
      }),
    },
    "mermaid.success": {
      actions: assign({
        mermaidStatus: "success",
        error: null,
        lastMermaidUpdatedAt: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "mermaid.success" }> }) =>
          event.updatedAt,
      }),
    },
    "mermaid.error": {
      actions: assign({
        mermaidStatus: "error",
        error: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "mermaid.error" }> }) => event.message,
        lastMermaidUpdatedAt: ({ event }: { event: Extract<RealtimeStudioEvent, { type: "mermaid.error" }> }) =>
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
