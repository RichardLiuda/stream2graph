"use client";

import * as Tabs from "@radix-ui/react-tabs";
import * as Progress from "@radix-ui/react-progress";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import Link from "next/link";
import {
  AudioLines,
  Headphones,
  Mic,
  MicOff,
  Play,
  RefreshCcw,
  Save,
  Send,
  StopCircle,
  WandSparkles,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Button, Card, Input, SectionHeading, StatCard, Textarea } from "@stream2graph/ui";

import { api } from "@/lib/api";
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
  getSystemAudioUnavailableReason,
  supportsSystemAudioUi,
  type CaptureMode,
  type ClientAudioContext,
  type InputSource,
  type InputSourceOption,
} from "@/lib/audio-input";
import { type RecognitionBackend, realtimeStudioMachine } from "@/lib/realtime-machine";
import {
  loadRuntimePreferences,
  resolveRuntimePreferences,
  saveRuntimePreferences,
} from "@/lib/runtime-preferences";
import { GraphStage } from "@/components/graph-stage";
import { MermaidCard } from "@/components/mermaid-card";

const LOCAL_SESSION_KEY = "s2g:last-realtime-session";

type TranscriptRow = {
  text: string;
  speaker: string;
  expected_intent?: string | null;
};

type TranscriptPreset = {
  id: string;
  label: string;
  description: string;
  value: string;
};

type BackendOption = {
  value: RecognitionBackend;
  label: string;
  disabled?: boolean;
};

type NoticeTone = "info" | "success" | "warning";

const TRANSCRIPT_PRESETS: TranscriptPreset[] = [
  {
    id: "platform_architecture",
    label: "平台架构梳理",
    description: "适合生成服务依赖、数据流和后台管理关系图。",
    value: [
      "host|We need a platform map that starts from the web console and reaches the backend services.|structural",
      "expert|Put the admin console on the left because every workflow begins there.|structural",
      "expert|From the admin console, connect to the API gateway that handles auth, runtime control, and report export.|sequential",
      "expert|The API gateway talks to the session manager for realtime runs and to the study manager for participant workflows.|structural",
      "expert|The session manager writes state into PostgreSQL and artifacts into object storage.|structural",
      "expert|A worker service reads queued jobs from PostgreSQL and produces reports and evaluation artifacts.|sequential",
      "expert|The audio helper is optional and only feeds transcript chunks back into the API gateway.|structural",
      "host|Please show that the runtime options service configures both the LLM path and the STT path.|structural",
      "expert|Add a runtime settings module above the API gateway and connect it to LLM provider, STT provider, and model probe capability.|structural",
    ].join("\n"),
  },
  {
    id: "incident_response",
    label: "故障响应流程",
    description: "适合展示顺序步骤、分支决策和回滚路径。",
    value: [
      "operator|We need an incident response flow for a production outage.|sequential",
      "lead|Start with alert ingestion from monitoring and paging into the on-call engineer.|sequential",
      "lead|After triage, add a decision node: is customer traffic impacted?|structural",
      "lead|If yes, branch to mitigation, status page update, and executive notification in parallel.|parallel",
      "lead|If no, branch to deeper diagnosis without public communication.|conditional",
      "operator|Mitigation should route to rollback, traffic shift, or feature flag disable depending on root cause.|conditional",
      "lead|Once mitigation is stable, move into root-cause analysis, action items, and follow-up review.|sequential",
      "operator|Close the loop by feeding action items back into backlog and runbooks.|feedback_loop",
    ].join("\n"),
  },
  {
    id: "research_workflow",
    label: "用户研究闭环",
    description: "适合演示 participant session、提交、评测和报告产出。",
    value: [
      "researcher|Describe the study workflow from task creation to report export.|sequential",
      "expert|First create a study task with materials, condition setup, and participant codes.|sequential",
      "expert|Participants enter through the participant page, review materials, and start a timed session.|sequential",
      "expert|During the session, autosave keeps draft Mermaid output and transcript notes in progress storage.|structural",
      "expert|Submission sends final Mermaid, compile result, and survey answers into the study session record.|sequential",
      "researcher|Add automatic evaluation after submit so the system compares final output with reference and computes metrics.|sequential",
      "expert|The study manager writes all session data into PostgreSQL and triggers report generation for aggregate analysis.|structural",
      "researcher|End with a report dashboard that exports JSON, CSV, and markdown summaries for the whole study.|sequential",
    ].join("\n"),
  },
  {
    id: "data_pipeline",
    label: "数据处理管线",
    description: "适合演示 ingest、校验、富化、分发和监控。",
    value: [
      "architect|Map the event processing pipeline for partner data ingestion.|sequential",
      "architect|Source systems push files and webhooks into an ingestion gateway.|sequential",
      "architect|The ingestion gateway forwards payloads to schema validation and deduplication.|sequential",
      "architect|Validated records go into an enrichment stage that joins account metadata and policy rules.|sequential",
      "architect|After enrichment, split the flow into analytics warehouse, operational database, and search index.|parallel",
      "architect|Any failed validation or policy conflict should go into a quarantine queue with manual review.|conditional",
      "architect|Monitoring watches latency, failure rate, and backlog depth, then alerts ops when thresholds are exceeded.|structural",
      "architect|Manual review can either release records back into enrichment or permanently reject them.|feedback_loop",
    ].join("\n"),
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
  return "border-sky-200 bg-sky-50 text-sky-700";
}

function getSourceBadgeLabel(source: InputSource | null) {
  switch (source) {
    case "microphone_browser":
      return "浏览器麦克风采集中";
    case "system_audio_browser_experimental":
      return "共享音频验证中";
    case "system_audio_helper":
      return "增强模式运行中";
    default:
      return "当前未进行实时采集";
  }
}

function getBrowserFamilyLabel(context: ClientAudioContext | null) {
  return context?.browser_family || "other";
}

type HelperCapabilities = typeof helperCapabilitiesSchema._type;
type RuntimeOptions = Awaited<ReturnType<typeof api.listRuntimeOptions>>;
const HELPER_TARGET_SAMPLE_RATE = 16_000;
const HELPER_UPLOAD_CHUNK_SECONDS = 4;

function encodeFloat32ToBase64Pcm16(samples: Float32Array) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }

  let binary = "";
  const bytes = new Uint8Array(pcm.buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
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

function formatLiveTranscript(text: string) {
  return text.trim() || "等待识别结果...";
}

function backendLabel(backend: RecognitionBackend) {
  switch (backend) {
    case "browser_speech":
      return "浏览器识别";
    case "browser_display_validation":
      return "浏览器共享验证";
    case "local_helper":
      return "本地 helper";
    case "api_stt":
      return "API STT";
    default:
      return "Manual";
  }
}

function backendStatusLabel(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return "进行中";
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  return "空闲";
}

function backendStatusTone(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "error") return "border-red-200 bg-red-50 text-red-700";
  return "border-white/70 bg-white/[0.58] text-slate-600";
}

function toLocalDateTimeLabel(value: string | null) {
  if (!value) return "尚未生成";
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber).toLocaleString();
  }
  return value;
}

function buildBackendOptions(source: InputSource, helperCapabilities: HelperCapabilities | null): BackendOption[] {
  if (source === "transcript") {
    return [{ value: "manual" as const, label: "Transcript" }];
  }
  if (source === "microphone_browser") {
    return [
      { value: "browser_speech" as const, label: "浏览器识别" },
      { value: "api_stt" as const, label: "API STT" },
    ];
  }
  if (source === "system_audio_browser_experimental") {
    return [{ value: "browser_display_validation" as const, label: "浏览器共享验证" }];
  }
  const options = [
    { value: "local_helper" as const, label: "本地 helper", disabled: helperCapabilities?.capability_status !== "supported" },
    { value: "api_stt" as const, label: "API STT" },
  ];
  return options;
}

function captureStatusLabel(status: "idle" | "capturing" | "uploading") {
  if (status === "capturing") return "采集中";
  if (status === "uploading") return "上传中";
  return "空闲";
}

function statusProgressValue(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return 64;
  if (status === "success") return 100;
  if (status === "error") return 100;
  return 10;
}

function statusProgressTone(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return "bg-[linear-gradient(90deg,#6aa4ff,#7a89ff)]";
  if (status === "success") return "bg-[linear-gradient(90deg,#1fb67d,#3bc892)]";
  if (status === "error") return "bg-[linear-gradient(90deg,#e56a6a,#d14d4d)]";
  return "bg-slate-300";
}

function capabilityBadgeTone(status: string) {
  if (status === "supported") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "limited") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "unsupported") return "border-red-200 bg-red-50 text-red-700";
  return "";
}

export function RealtimeStudio() {
  const queryClient = useQueryClient();
  const [studioState, studioSend] = useMachine(realtimeStudioMachine);
  const [title, setTitle] = useState("研究演示会话");
  const [datasetVersion, setDatasetVersion] = useState("");
  const [selectedTranscriptPresetId, setSelectedTranscriptPresetId] = useState(TRANSCRIPT_PRESETS[0]?.id ?? "");
  const [transcriptText, setTranscriptText] = useState(TRANSCRIPT_PRESETS[0]?.value ?? "");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
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
  const helperPendingFramesRef = useRef<Float32Array[]>([]);
  const helperPendingSampleCountRef = useRef(0);
  const apiCaptureStreamRef = useRef<MediaStream | null>(null);
  const apiCaptureAudioContextRef = useRef<AudioContext | null>(null);
  const apiCaptureSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const apiCaptureProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const apiCaptureMuteNodeRef = useRef<GainNode | null>(null);
  const apiCaptureUploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const apiCaptureChunkIdRef = useRef(0);
  const apiCapturePendingFramesRef = useRef<Float32Array[]>([]);
  const apiCapturePendingSampleCountRef = useRef(0);
  const apiCaptureContextRef = useRef<{
    sessionId: string;
    source: InputSource;
    captureMode: CaptureMode;
    speaker: string;
  } | null>(null);

  const selectedInputSource = studioState.context.selectedInputSource;
  const selectedRecognitionBackend = studioState.context.recognitionBackend;
  const activeCaptureSource = studioState.context.captureStatus !== "idle" ? selectedInputSource : null;
  const inputLevel = studioState.context.inputLevel;
  const liveTranscript = studioState.context.liveTranscript;
  const captureStatus = studioState.context.captureStatus;
  const sttStatus = studioState.context.sttStatus;
  const llmStatus = studioState.context.llmStatus;
  const machineError = studioState.context.error;
  const lastMermaidUpdatedAt = studioState.context.lastMermaidUpdatedAt;

  const authQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
  });
  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: api.listDatasets,
    enabled: authQuery.isSuccess,
    retry: false,
  });
  const runtimeOptions = useQuery({
    queryKey: ["runtime-options"],
    queryFn: api.listRuntimeOptions,
    enabled: authQuery.isSuccess,
    retry: false,
  });
  const sessions = useQuery({
    queryKey: ["realtime-sessions"],
    queryFn: api.listRealtimeSessions,
    enabled: authQuery.isSuccess,
    retry: false,
  });
  const helperCapabilitiesQuery = useQuery({
    queryKey: ["audio-helper-capabilities"],
    queryFn: audioHelper.capabilities,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: supportsSystemAudioUi(audioContext),
  });

  useEffect(() => {
    setAudioContext(detectClientAudioContext());
  }, []);

  useEffect(() => {
    if (!datasetVersion && datasets.data?.length) {
      setDatasetVersion(datasets.data.find((item) => item.is_default)?.slug || datasets.data[0].slug);
    }
  }, [datasetVersion, datasets.data]);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCAL_SESSION_KEY);
    if (stored) setCurrentSessionId(stored);
  }, []);

  const inputOptions = useMemo(() => getInputSourceOptions(audioContext), [audioContext]);
  const selectedOption = useMemo<InputSourceOption>(() => {
    return inputOptions.find((item) => item.source === selectedInputSource) || inputOptions[0];
  }, [inputOptions, selectedInputSource]);
  const helperCapabilities = helperCapabilitiesQuery.data ?? null;
  const helperAvailable = Boolean(helperCapabilities);
  const backendOptions = useMemo(
    () => buildBackendOptions(selectedInputSource, helperCapabilities),
    [helperCapabilities, selectedInputSource],
  );
  const [llmProfileId, setLlmProfileId] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [sttProfileId, setSttProfileId] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [diagramMode, setDiagramMode] = useState("mermaid_primary");
  const preferencesInitializedRef = useRef(false);
  const selectedLlmProfile = runtimeOptions.data?.llm_profiles.find((item) => item.id === llmProfileId) ?? null;
  const selectedSttProfile = runtimeOptions.data?.stt_profiles.find((item) => item.id === sttProfileId) ?? null;
  const effectiveError = error ?? machineError;

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
    setLlmProfileId(resolved.llmProfileId);
    setLlmModel(resolved.llmModel);
    setSttProfileId(resolved.sttProfileId);
    setSttModel(resolved.sttModel);
    setDiagramMode(resolved.diagramMode);
    preferencesInitializedRef.current = true;
  }, [runtimeOptions.data]);

  useEffect(() => {
    if (!selectedLlmProfile) return;
    if (!selectedLlmProfile.models.includes(llmModel)) {
      setLlmModel(selectedLlmProfile.default_model || selectedLlmProfile.models[0] || "");
    }
  }, [llmModel, selectedLlmProfile]);

  useEffect(() => {
    if (!runtimeOptions.data?.llm_profiles.length) return;
    if (!selectedLlmProfile) {
      const fallback = runtimeOptions.data.llm_profiles[0];
      setLlmProfileId(fallback.id);
      setLlmModel(fallback.default_model || fallback.models[0] || "");
    }
  }, [runtimeOptions.data, selectedLlmProfile]);

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
      llmProfileId,
      llmModel,
      sttProfileId,
      sttModel,
      diagramMode: diagramMode === "dual_view" ? "dual_view" : "mermaid_primary",
    });
  }, [diagramMode, llmModel, llmProfileId, sttModel, sttProfileId]);

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
      llm_profile_id: llmProfileId,
      llm_model: llmModel,
      stt_profile_id: sttProfileId,
      stt_model: sttModel,
    };
  }

  function resetHelperAudioBuffers() {
    helperPendingFramesRef.current = [];
    helperPendingSampleCountRef.current = 0;
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

  function syncMermaidStatus(pipeline: Record<string, any> | null | undefined) {
    const mermaidState = pipeline?.mermaid_state ?? null;
    const updatedAt = mermaidState?.updated_at ? toLocalDateTimeLabel(String(mermaidState.updated_at)) : null;
    if (!mermaidState) {
      studioSend({ type: "llm.error", message: "当前还没有 Mermaid 结果。", updatedAt });
      return;
    }
    if (mermaidState.error_message) {
      studioSend({ type: "llm.error", message: String(mermaidState.error_message), updatedAt });
      return;
    }
    studioSend({ type: "llm.success", updatedAt });
  }

  async function flushHelperAudioBuffer(isFinal = true) {
    if (!helperPendingSampleCountRef.current) return;

    const merged = new Float32Array(helperPendingSampleCountRef.current);
    let offset = 0;
    for (const frame of helperPendingFramesRef.current) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    resetHelperAudioBuffers();
    await uploadHelperAudioFrame(merged, isFinal);
  }

  async function teardownHelperAudioGraph({ flush = false }: { flush?: boolean } = {}) {
    if (flush) {
      try {
        await flushHelperAudioBuffer(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "发送最后一段音频时失败。");
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

      helperPendingFramesRef.current.push(merged);
      helperPendingSampleCountRef.current += merged.length;
      if (helperPendingSampleCountRef.current >= HELPER_TARGET_SAMPLE_RATE * HELPER_UPLOAD_CHUNK_SECONDS) {
        void flushHelperAudioBuffer(true);
      }
    };

    const handleEnded = () => {
      void stopHelperCapture("系统声音共享已结束。你可以重新开始增强模式，或切回 Transcript 输入。");
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
    apiCapturePendingFramesRef.current = [];
    apiCapturePendingSampleCountRef.current = 0;
    apiCaptureChunkIdRef.current = 0;
  }

  async function uploadApiAudioFrame(samples: Float32Array, isFinal = true) {
    const context = apiCaptureContextRef.current;
    if (!context || !samples.length) return;

    studioSend({ type: "capture.uploading" });
    studioSend({ type: "stt.working" });

    try {
      const response = await api.transcribeRealtimeAudio(context.sessionId, {
        chunk_id: apiCaptureChunkIdRef.current,
        sample_rate: HELPER_TARGET_SAMPLE_RATE,
        channel_count: 1,
        pcm_s16le_base64: encodeFloat32ToBase64Pcm16(samples),
        timestamp_ms: Date.now(),
        is_final: isFinal,
        speaker: context.speaker,
        metadata: buildChunkMetadata(context.source, context.captureMode),
      });
      apiCaptureChunkIdRef.current += 1;
      setSnapshot({
        session_id: context.sessionId,
        pipeline: response.pipeline,
        evaluation: response.evaluation,
      });
      if (response.text.trim()) {
        studioSend({ type: "transcript.preview", text: response.text.trim() });
        studioSend({ type: "stt.success", text: response.text.trim() });
      }
      syncMermaidStatus(response.pipeline);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
      studioSend({ type: "capture.start" });
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "API STT 上传失败。";
      studioSend({ type: "stt.error", message });
      setError(message);
      studioSend({ type: "capture.stop" });
      throw err;
    }
  }

  async function flushApiCaptureBuffer(isFinal = true) {
    if (!apiCapturePendingSampleCountRef.current) return;

    const merged = new Float32Array(apiCapturePendingSampleCountRef.current);
    let offset = 0;
    for (const frame of apiCapturePendingFramesRef.current) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    resetApiCaptureBuffers();
    await uploadApiAudioFrame(merged, isFinal);
  }

  async function teardownApiCaptureGraph({ flush = false }: { flush?: boolean } = {}) {
    if (flush) {
      try {
        await flushApiCaptureBuffer(true);
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
    apiCaptureContextRef.current = payload;
    resetApiCaptureBuffers();

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

      studioSend({ type: "audio.level", level: calculateAudioLevel(merged) });
      apiCapturePendingFramesRef.current.push(merged);
      apiCapturePendingSampleCountRef.current += merged.length;
      if (apiCapturePendingSampleCountRef.current >= HELPER_TARGET_SAMPLE_RATE * HELPER_UPLOAD_CHUNK_SECONDS) {
        void flushApiCaptureBuffer(false);
      }
    };

    const handleEnded = () => {
      void stopApiCapture("共享音频已结束。你可以重新开始 API STT 采集，或切回 Transcript 输入。");
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
    if (selectedRecognitionBackend !== "api_stt") {
      setError("当前识别后端不是 API STT。");
      return;
    }
    if (source !== "microphone_browser" && source !== "system_audio_helper") {
      setError("当前输入源不支持 API STT 采集。");
      return;
    }

    const sessionId = await ensureSession();
    let stream: MediaStream | null = null;
    try {
      if (source === "microphone_browser") {
        stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        stream = await window.navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((track) => track.stop());
          setError("当前共享对象没有音频轨道。Windows 请确认勾选共享音频；macOS 请优先选择标签页音频。");
          return;
        }
      }
    } catch (err) {
      setError(
        source === "microphone_browser"
          ? err instanceof Error
            ? err.message
            : "无法开启麦克风。"
          : getDisplayAudioErrorMessage(err instanceof DOMException ? err.name : undefined),
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
            ? "API STT 已开始接收麦克风音频，识别结果会直接写入当前会话。"
            : "API STT 已开始接收共享音频，识别结果会直接写入当前会话。",
      });
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      studioSend({ type: "stt.error", message: err instanceof Error ? err.message : "API STT 启动失败。" });
      setError(err instanceof Error ? err.message : "API STT 启动失败。");
      await teardownApiCaptureGraph();
    }
  }

  async function stopApiCapture(message = "已停止 API STT 采集。") {
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
        llm_profile_id: llmProfileId || null,
        llm_model: llmModel || null,
        stt_profile_id: sttProfileId || null,
        stt_model: sttModel || null,
        diagram_mode: diagramMode,
        client_context: currentClientContext(),
      }),
    onSuccess: (data) => {
      setCurrentSessionId(data.session_id);
      window.localStorage.setItem(LOCAL_SESSION_KEY, data.session_id);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const snapshotMutation = useMutation({
    mutationFn: (sessionId: string) => {
      studioSend({ type: "llm.working" });
      return api.snapshotRealtime(sessionId);
    },
    onSuccess: (data) => {
      setSnapshot(data);
      setError(null);
      syncMermaidStatus(data.pipeline);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  useEffect(() => {
    if (currentSessionId) {
      snapshotMutation.mutate(currentSessionId);
    }
    // `useMutation()` returns a new object identity per render; only auto-snapshot when session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  async function ensureSession() {
    if (currentSessionId) return currentSessionId;
    const created = await createSession.mutateAsync();
    return created.session_id;
  }

  async function pushRealtimeTextChunk(source: InputSource, captureMode: CaptureMode, text: string, isFinal = true) {
    const sessionId = await ensureSession();
    studioSend({ type: "llm.working" });
    const data = await api.addRealtimeChunk(sessionId, {
      text,
      speaker: source === "system_audio_helper" ? "system_audio" : "speaker",
      is_final: isFinal,
      metadata: buildChunkMetadata(source, captureMode),
    });
    setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
    syncMermaidStatus(data.pipeline);
    queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
  }

  const sendTranscript = useMutation({
    mutationFn: async () => {
      const sessionId = await ensureSession();
      const rows = parseTranscriptInput(transcriptText);
      let last = null;
      for (let i = 0; i < rows.length; i += 1) {
        last = await api.addRealtimeChunk(sessionId, {
          timestamp_ms: i * 450,
          text: rows[i].text,
          speaker: rows[i].speaker,
          expected_intent: rows[i].expected_intent || null,
          metadata: buildChunkMetadata("transcript", "manual_text"),
        });
      }
      return last;
    },
    onSuccess: (data) => {
      if (data) setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
      setError(null);
      syncMermaidStatus(data?.pipeline);
      setNotice({ tone: "success", text: "Transcript 已写入当前会话。" });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const flushMutation = useMutation({
    mutationFn: (sessionId: string) => {
      studioSend({ type: "llm.working" });
      return api.flushRealtime(sessionId);
    },
    onSuccess: (data) => {
      setSnapshot(data);
      syncMermaidStatus(data.pipeline);
    },
    onError: (err) => setError((err as Error).message),
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: string) => api.closeRealtime(sessionId),
    onSuccess: () => {
      if (currentSessionId) window.localStorage.removeItem(LOCAL_SESSION_KEY);
      setCurrentSessionId(null);
      setSnapshot(null);
      studioSend({ type: "capture.stop" });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const saveReportMutation = useMutation({
    mutationFn: (sessionId: string) => api.saveRealtimeReport(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] }),
    onError: (err) => setError((err as Error).message),
  });

  async function startRecognition() {
    clearFeedback();
    const sessionId = await ensureSession();
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setError("当前浏览器不支持 Web Speech API。请改用 Transcript 输入。");
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
          const data = await api.addRealtimeChunk(sessionId, {
            text,
            speaker: "speaker",
            is_final: true,
            metadata: buildChunkMetadata("microphone_browser", "browser_speech"),
          });
          setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
          studioSend({ type: "stt.success", text });
          syncMermaidStatus(data.pipeline);
          setNotice({ tone: "success", text: "已写入一段浏览器麦克风识别文本。" });
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
      studioSend({ type: "stt.error", message: getSpeechRecognitionErrorMessage(evt?.error) });
      setError(getSpeechRecognitionErrorMessage(evt?.error));
    };
    try {
      await startMicrophoneAudioGraph();
      recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      setListening(false);
      await teardownMicrophoneAudioGraph();
      setError(err instanceof Error ? err.message : "语音识别启动失败");
      return;
    }
    recognitionRef.current = recognition;
    setListening(true);
    studioSend({ type: "capture.start" });
    studioSend({ type: "transcript.preview", text: "" });
    setNotice({ tone: "info", text: "浏览器麦克风识别已启动，后续识别结果会直接写入当前会话。" });
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
      setError("当前浏览器不支持共享音频采集。请改用 Transcript 输入或增强模式。");
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
        setError("浏览器已开始共享，但当前没有拿到音频轨道。Windows 请确认勾选共享音频；macOS 请优先尝试标签页音频。");
        return;
      }
      studioSend({ type: "capture.start" });
      setNotice({
        tone: "warning",
        text: "浏览器已成功提供共享音频轨道，但当前版本只做能力验证，尚未把共享音频直接转成文本 chunk。请改用增强模式或 Transcript 输入。",
      });
    } catch (err) {
      setError(getDisplayAudioErrorMessage(err instanceof DOMException ? err.name : undefined));
    }
  }

  function stopBrowserDisplayAudioValidation() {
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    if (activeCaptureSource === "system_audio_browser_experimental") studioSend({ type: "capture.stop" });
    setNotice({ tone: "info", text: "已停止共享音频验证。" });
  }

  async function startHelperCapture() {
    clearFeedback();
    const caps = helperCapabilities;
    if (!caps) {
      setError("未检测到本地 audio helper。请先在本机启动 `pnpm audio-helper:dev`。");
      return;
    }
    if (caps.capability_status !== "supported") {
      setError(caps.capability_reason);
      return;
    }
    if (!window.navigator.mediaDevices?.getDisplayMedia) {
      setError("当前浏览器无法提供共享音频流。请改用 Transcript 输入，或切换到桌面版 Chrome/Edge。");
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
        setError("当前共享对象没有音频轨道。Windows 请确认勾选共享音频；macOS 请优先选择标签页音频。");
        return;
      }
    } catch (err) {
      setError(getDisplayAudioErrorMessage(err instanceof DOMException ? err.name : undefined));
      return;
    }

    helperEventSourceRef.current?.close();
    helperEventSourceRef.current = subscribeAudioHelperEvents(
      (payload) => {
        if (payload.error_message) {
          studioSend({ type: "stt.error", message: payload.error_message });
          setError(payload.error_message);
        }
        if (payload.status === "running") {
          studioSend({ type: "capture.start" });
          studioSend({ type: "stt.working" });
          setNotice({ tone: "success", text: "增强模式已启动，等待本地辅助层推送识别结果。" });
        }
        if (payload.status === "stopped") {
          studioSend({ type: "capture.stop" });
          setNotice({ tone: "info", text: "增强模式已停止。" });
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
        studioSend({ type: "stt.error", message: "audio helper 事件流已断开。请检查本机辅助层服务。" });
        setError("audio helper 事件流已断开。请检查本机辅助层服务。");
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
      setNotice({ tone: "success", text: "增强模式已启动，正在把共享音频分段转写并写入当前会话。" });
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      helperEventSourceRef.current?.close();
      helperEventSourceRef.current = null;
      await audioHelper.stopCapture().catch(() => undefined);
      studioSend({ type: "stt.error", message: err instanceof Error ? err.message : "增强模式启动失败" });
      setError(err instanceof Error ? err.message : "增强模式启动失败");
    }
  }

  async function stopHelperCapture(message = "已请求停止增强模式采集。") {
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

  const rendererState = snapshot?.pipeline?.renderer_state || {};
  const events = snapshot?.pipeline?.events || [];
  const mermaidState = snapshot?.pipeline?.mermaid_state ?? null;
  const hasLlmProfiles = Boolean(runtimeOptions.data?.llm_profiles.length);
  const hasSttProfiles = Boolean(runtimeOptions.data?.stt_profiles.length);

  const summaryCards = useMemo(() => {
    const metrics = snapshot?.evaluation?.metrics ?? {};
    return [
      { label: "E2E P95", value: metrics.e2e_latency_p95_ms ?? "-" },
      { label: "Intent Acc", value: metrics.intent_accuracy ?? "-" },
      { label: "Flicker", value: metrics.flicker_mean ?? "-" },
      { label: "Mental Map", value: metrics.mental_map_mean ?? "-" },
    ];
  }, [snapshot?.evaluation?.metrics]);

  const systemAudioUiVisible = supportsSystemAudioUi(audioContext);
  const canStartCapture =
    selectedRecognitionBackend === "browser_speech"
      ? !listening
      : selectedRecognitionBackend === "browser_display_validation"
        ? activeCaptureSource !== "system_audio_browser_experimental"
        : selectedRecognitionBackend === "local_helper"
          ? activeCaptureSource !== "system_audio_helper"
          : selectedRecognitionBackend === "api_stt"
            ? captureStatus === "idle"
            : false;
  const canStopCapture =
    selectedRecognitionBackend === "browser_speech"
      ? listening
      : selectedRecognitionBackend === "browser_display_validation"
        ? activeCaptureSource === "system_audio_browser_experimental"
        : selectedRecognitionBackend === "local_helper"
          ? activeCaptureSource === "system_audio_helper"
          : selectedRecognitionBackend === "api_stt"
            ? captureStatus !== "idle"
            : false;

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Realtime Studio"
        title="实时成图工作台"
        description="用正式平台方式管理会话、事件流、增量图和实时评测结果。刷新页面后会优先恢复最近一次活动会话。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{currentSessionId ? `Session ${currentSessionId}` : "未创建会话"}</Badge>
            <Badge>{getSourceBadgeLabel(activeCaptureSource)}</Badge>
            <Badge>{backendLabel(selectedRecognitionBackend)}</Badge>
            {snapshot?.evaluation?.realtime_eval_pass === true ? (
              <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">评测通过</Badge>
            ) : null}
          </div>
        }
      />

      {effectiveError ? (
        <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {effectiveError}
        </div>
      ) : null}
      {notice ? (
        <div className={`rounded-[24px] border px-4 py-3 text-sm ${getNoticeClassName(notice.tone)}`}>{notice.text}</div>
      ) : null}

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-slate-950">实时采集状态</div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              这里会显示输入电平、识别文本和 LLM 生成状态。无论走浏览器、本地 helper 还是 API STT，这里都是统一观测面板。
            </p>
          </div>
          <Badge>{getSourceBadgeLabel(activeCaptureSource)}</Badge>
        </div>
        <Tooltip.Provider delayDuration={120}>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <div className="space-y-4 rounded-[22px] border border-white/70 bg-white/[0.58] px-4 py-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    label: "Capture",
                    value: captureStatusLabel(captureStatus),
                    status: captureStatus === "idle" ? "idle" : "working",
                    help: "显示当前是否正在采集或上传音频。",
                  },
                  {
                    label: "STT",
                    value: backendStatusLabel(sttStatus),
                    status: sttStatus,
                    help: `当前识别后端：${backendLabel(selectedRecognitionBackend)}`,
                  },
                  {
                    label: "LLM",
                    value: backendStatusLabel(llmStatus),
                    status: llmStatus,
                    help: selectedLlmProfile ? `${selectedLlmProfile.label} / ${llmModel || "未选择模型"}` : "尚未配置 LLM profile。",
                  },
                  {
                    label: "Mermaid",
                    value: lastMermaidUpdatedAt ? "已更新" : "等待中",
                    status: lastMermaidUpdatedAt ? "success" : llmStatus,
                    help: lastMermaidUpdatedAt || "当前还没有可展示的 Mermaid 结果。",
                  },
                ].map((item) => (
                  <Tooltip.Root key={item.label}>
                    <Tooltip.Trigger asChild>
                      <div className="rounded-[20px] border border-white/70 bg-white/[0.78] px-4 py-4 text-left">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
                          <Badge className={backendStatusTone(item.status as "idle" | "working" | "success" | "error")}>
                            {item.value}
                          </Badge>
                        </div>
                        <Progress.Root className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100" value={statusProgressValue(item.status as "idle" | "working" | "success" | "error")}>
                          <Progress.Indicator
                            className={`h-full transition-transform duration-300 ${statusProgressTone(item.status as "idle" | "working" | "success" | "error")}`}
                            style={{
                              transform: `translateX(-${100 - statusProgressValue(item.status as "idle" | "working" | "success" | "error")}%)`,
                            }}
                          />
                        </Progress.Root>
                        <div className="mt-3 text-xs leading-6 text-slate-500">{item.help}</div>
                      </div>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content sideOffset={8} className="max-w-[280px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs leading-6 text-slate-700 shadow-xl">
                        {item.help}
                        <Tooltip.Arrow className="fill-white" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                ))}
              </div>

              <div className="rounded-[20px] border border-white/70 bg-white/[0.72] px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Input Gain</div>
                  <Badge>{Math.round(inputLevel * 100)}%</Badge>
                </div>
                <Progress.Root className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100" value={Math.max(0, Math.round(inputLevel * 100))}>
                  <Progress.Indicator
                    className="h-full bg-[linear-gradient(90deg,#66b1ff,#6d89ff,#34c38f)] transition-transform duration-150"
                    style={{ transform: `translateX(-${100 - Math.max(0, Math.round(inputLevel * 100))}%)` }}
                  />
                </Progress.Root>
                <div className="mt-3 text-xs leading-6 text-slate-500">
                  {activeCaptureSource ? "采集中会持续刷新。" : "开始麦克风或系统声音采集后，这里会显示实时音量。"}
                </div>
              </div>
            </div>

            <div className="rounded-[22px] border border-white/70 bg-white/[0.58] px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Live Transcript</div>
                <Badge>{backendLabel(selectedRecognitionBackend)}</Badge>
              </div>
              <div className="mt-3 min-h-[208px] whitespace-pre-wrap rounded-[18px] bg-white/[0.76] px-4 py-4 text-sm leading-7 text-slate-700">
                {formatLiveTranscript(liveTranscript)}
              </div>
              <div className="mt-3 text-xs leading-6 text-slate-500">
                浏览器识别会显示临时字串；本地 helper 和 API STT 会显示最近一次回写到会话的文本。
              </div>
            </div>
          </div>
        </Tooltip.Provider>
      </Card>

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-950">默认运行配置</div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              模型与视图模式已经移到独立配置页。这里仅显示当前会话会继承的默认值，避免工作台首屏被配置项挤占。
            </p>
          </div>
          <Link href="/app/settings">
            <Button variant="secondary">
              打开配置页
              <WandSparkles className="h-4 w-4" />
            </Button>
          </Link>
        </div>
        {!hasLlmProfiles || !hasSttProfiles ? (
          <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            当前服务端还没有提供完整的 LLM / STT profile，可先进入配置页查看缺失项，再补齐 `.env` 后重启 API。
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              label: "LLM 默认值",
              value: hasLlmProfiles ? `${selectedLlmProfile?.label || "未选择"} / ${llmModel || "未选择模型"}` : "未配置",
            },
            {
              label: "STT 默认值",
              value: hasSttProfiles ? `${selectedSttProfile?.label || "未选择"} / ${sttModel || "未选择模型"}` : "未配置",
            },
            {
              label: "视图模式",
              value: diagramMode === "dual_view" ? "Mermaid + 结构视图" : "Mermaid 主视图",
            },
          ].map((item) => (
            <div key={item.label} className="rounded-[22px] border border-white/70 bg-white/[0.58] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
              <div className="mt-3 text-sm font-semibold leading-6 text-slate-900">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <Card className="soft-enter space-y-6">
          <div className="space-y-3">
            <label className="text-sm font-medium text-slate-700">会话标题</label>
            <Input value={title} onChange={(event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)} />
          </div>

          <div className="space-y-3">
            <label className="text-sm font-medium text-slate-700">数据集版本</label>
            <select
              className="h-12 w-full rounded-[22px] border border-white/70 bg-white/[0.72] px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[rgba(77,124,255,0.12)]"
              value={datasetVersion}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setDatasetVersion(event.target.value)}
            >
              {datasets.data?.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.slug}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium text-slate-700">输入来源</label>
              <Badge>{audioContext ? `${audioContext.platform} / ${getBrowserFamilyLabel(audioContext)}` : "检测中"}</Badge>
            </div>
            <div className="grid gap-3">
              {inputOptions.map((option) => (
                <button
                  key={option.source}
                  className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${
                    selectedInputSource === option.source
                      ? "border-[var(--accent)] bg-[rgba(77,124,255,0.08)]"
                      : "border-white/70 bg-white/[0.58]"
                  }`}
                  onClick={() => {
                    clearFeedback();
                    const nextBackend =
                      buildBackendOptions(option.source, helperCapabilities).find((item) => !item.disabled)?.value ||
                      buildBackendOptions(option.source, helperCapabilities)[0].value;
                    studioSend({ type: "source.select", source: option.source, backend: nextBackend });
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-900">{option.label}</div>
                    <Badge className={capabilityBadgeTone(option.capability_status)}>{option.capability_status}</Badge>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-slate-600">{option.description}</div>
                  <div className="mt-2 text-xs leading-6 text-slate-500">{option.capability_reason}</div>
                </button>
              ))}
            </div>
            {!systemAudioUiVisible ? (
              <div className="rounded-[20px] border border-white/70 bg-white/[0.52] px-4 py-3 text-xs leading-6 text-slate-500">
                系统声音采集未在当前浏览器中开放：{getSystemAudioUnavailableReason(audioContext)}
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium text-slate-700">识别后端</label>
              <Badge>{backendLabel(selectedRecognitionBackend)}</Badge>
            </div>
            <div className="grid gap-3">
              {backendOptions.map((option) => (
                <button
                  key={option.value}
                  className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${
                    selectedRecognitionBackend === option.value
                      ? "border-[var(--accent)] bg-[rgba(77,124,255,0.08)]"
                      : "border-white/70 bg-white/[0.58]"
                  } ${option.disabled ? "opacity-50" : ""}`}
                  disabled={option.disabled}
                  onClick={() => {
                    clearFeedback();
                    studioSend({ type: "backend.select", backend: option.value });
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-900">{option.label}</div>
                    {option.value === "api_stt" ? <Badge>service</Badge> : null}
                  </div>
                  <div className="mt-2 text-xs leading-6 text-slate-500">
                    {option.value === "browser_speech"
                      ? "直接使用浏览器语音识别，启动快，但稳定性受浏览器服务影响。"
                      : option.value === "browser_display_validation"
                        ? "只验证浏览器是否能提供共享音频轨道，不作为正式识别链路。"
                        : option.value === "local_helper"
                          ? "通过本机 helper 完成系统声音采集和本地转写。"
                          : option.value === "api_stt"
                            ? "前端负责采音，服务端调用 OpenAI-compatible STT API 做转写。"
                            : "手动输入 transcript。"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {selectedInputSource === "transcript" ? (
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-slate-700">Transcript 输入</label>
                <p className="mt-2 text-xs leading-6 text-slate-500">支持 `speaker | text | expected_intent`，一行一条，适合演示和快速回放。</p>
              </div>
              <div className="rounded-[20px] border border-white/70 bg-white/[0.52] p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">样例库</div>
                    <div className="mt-1 text-xs leading-6 text-slate-500">
                      选择一组 richer transcript，直接替换到输入框里。
                    </div>
                  </div>
                  <select
                    className="h-11 min-w-[220px] rounded-[18px] border border-white/70 bg-white/[0.8] px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(77,124,255,0.12)]"
                    value={selectedTranscriptPresetId}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                      const nextId = event.target.value;
                      const nextPreset = TRANSCRIPT_PRESETS.find((item) => item.id === nextId);
                      setSelectedTranscriptPresetId(nextId);
                      if (nextPreset) {
                        setTranscriptText(nextPreset.value);
                      }
                    }}
                  >
                    {TRANSCRIPT_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-3 text-xs leading-6 text-slate-600">
                  {TRANSCRIPT_PRESETS.find((preset) => preset.id === selectedTranscriptPresetId)?.description}
                </div>
              </div>
              <Textarea
                rows={15}
                value={transcriptText}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTranscriptText(event.target.value)}
              />
              <Button className="py-3" variant="secondary" onClick={() => sendTranscript.mutate()} disabled={sendTranscript.isPending}>
                <Send className="h-4 w-4" />
                发送当前 Transcript
              </Button>
            </div>
          ) : null}

          {selectedInputSource === "microphone_browser" ? (
            <div className="space-y-3">
              <div className="rounded-[20px] border border-white/70 bg-white/[0.52] px-4 py-3 text-xs leading-6 text-slate-500">
                {selectedRecognitionBackend === "browser_speech"
                  ? "浏览器麦克风依赖 Web Speech 服务。如果提示网络或服务不可用，通常不是项目后端报错，先用 Transcript 输入会更稳定。"
                  : "API STT 路径会直接把麦克风音频分段上传到服务端转写，再回写当前会话。"}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {selectedRecognitionBackend === "browser_speech" ? (
                  <>
                    <Button className="py-3" variant="ghost" onClick={() => void startRecognition()} disabled={!canStartCapture}>
                      <Mic className="h-4 w-4" />
                      麦克风开始
                    </Button>
                    <Button className="py-3" variant="ghost" onClick={stopRecognition} disabled={!canStopCapture}>
                      <MicOff className="h-4 w-4" />
                      麦克风停止
                    </Button>
                  </>
                ) : (
                  <>
                    <Button className="py-3" variant="secondary" onClick={() => void startApiCapture()} disabled={!canStartCapture}>
                      <Mic className="h-4 w-4" />
                      启动 API STT
                    </Button>
                    <Button className="py-3" variant="ghost" onClick={() => void stopApiCapture()} disabled={!canStopCapture}>
                      <StopCircle className="h-4 w-4" />
                      停止 API STT
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : null}

          {selectedInputSource === "system_audio_browser_experimental" ? (
            <div className="space-y-3">
              <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-700">
                该模式只验证浏览器能否拿到共享音频轨道，不承诺直接转成文本 chunk，也不视为正式支持能力。
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  className="py-3"
                  variant="secondary"
                  onClick={() => void startBrowserDisplayAudioValidation()}
                  disabled={activeCaptureSource === "system_audio_browser_experimental"}
                >
                  <Headphones className="h-4 w-4" />
                  开始共享音频验证
                </Button>
                <Button
                  className="py-3"
                  variant="ghost"
                  onClick={stopBrowserDisplayAudioValidation}
                  disabled={activeCaptureSource !== "system_audio_browser_experimental"}
                >
                  <StopCircle className="h-4 w-4" />
                  停止验证
                </Button>
              </div>
            </div>
          ) : null}

          {selectedInputSource === "system_audio_helper" ? (
            <div className="space-y-3">
              {selectedRecognitionBackend === "local_helper" ? (
                <>
                  <div className="rounded-[20px] border border-white/70 bg-white/[0.52] px-4 py-3 text-xs leading-6 text-slate-500">
                    增强模式会连接本机 `audio helper`，由浏览器提供共享音频流，再由辅助层在本机完成分段转写。当前辅助层地址：
                    <span className="ml-1 font-medium text-slate-700">{audioHelper.baseUrl}</span>
                  </div>
                  <div className="rounded-[20px] border border-white/70 bg-white/[0.58] px-4 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="font-semibold text-slate-900">辅助层状态</div>
                      <Badge className={capabilityBadgeTone(helperCapabilities?.capability_status || "offline")}>
                        {helperCapabilities?.capability_status || "offline"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-sm leading-6 text-slate-600">
                      {helperCapabilities?.capability_reason || "未检测到本地 audio helper。请先运行 `pnpm audio-helper:dev`。"}
                    </div>
                    <div className="mt-2 text-xs leading-6 text-slate-500">
                      engine: {helperCapabilities?.native_engine || "unavailable"} / {helperCapabilities?.transcriber_backend || "unavailable"}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Button className="py-3" variant="secondary" onClick={() => void helperCapabilitiesQuery.refetch()}>
                      <RefreshCcw className="h-4 w-4" />
                      重新检测
                    </Button>
                    <Button
                      className="py-3"
                      onClick={() => void startHelperCapture()}
                      disabled={!helperCapabilities || helperCapabilities.capability_status !== "supported" || !canStartCapture}
                    >
                      <AudioLines className="h-4 w-4" />
                      启动增强模式
                    </Button>
                    <Button
                      className="py-3"
                      variant="ghost"
                      onClick={() => void stopHelperCapture()}
                      disabled={!canStopCapture}
                    >
                      <StopCircle className="h-4 w-4" />
                      停止增强模式
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-[20px] border border-white/70 bg-white/[0.52] px-4 py-3 text-xs leading-6 text-slate-500">
                    API STT 路径会复用浏览器共享音频流，把系统声音分段上传到服务端转写。Windows 请勾选共享音频；macOS 请优先选择标签页音频。
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button className="py-3" variant="secondary" onClick={() => void startApiCapture()} disabled={!canStartCapture}>
                      <Headphones className="h-4 w-4" />
                      启动 API STT
                    </Button>
                    <Button className="py-3" variant="ghost" onClick={() => void stopApiCapture()} disabled={!canStopCapture}>
                      <StopCircle className="h-4 w-4" />
                      停止 API STT
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          <div className="grid gap-3">
            <Button className="py-3" onClick={() => createSession.mutate()} disabled={createSession.isPending}>
              <WandSparkles className="h-4 w-4" />
              {currentSessionId ? "重新创建会话" : "创建会话"}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                className="py-3"
                onClick={() => (currentSessionId ? snapshotMutation.mutate(currentSessionId) : null)}
                disabled={!currentSessionId}
              >
                <RefreshCcw className="h-4 w-4" />
                快照
              </Button>
              <Button
                variant="secondary"
                className="py-3"
                onClick={() => (currentSessionId ? flushMutation.mutate(currentSessionId) : null)}
                disabled={!currentSessionId}
              >
                <Play className="h-4 w-4" />
                Flush
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                className="py-3"
                onClick={() => (currentSessionId ? saveReportMutation.mutate(currentSessionId) : null)}
                disabled={!currentSessionId}
              >
                <Save className="h-4 w-4" />
                保存报告
              </Button>
              <Button
                variant="danger"
                className="py-3"
                onClick={() => (currentSessionId ? closeMutation.mutate(currentSessionId) : null)}
                disabled={!currentSessionId}
              >
                <StopCircle className="h-4 w-4" />
                关闭会话
              </Button>
            </div>
          </div>

          <div className="space-y-3 border-t border-white/[0.65] pt-2">
            <div className="text-sm font-medium text-slate-700">最近会话</div>
            <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
              {sessions.data?.map((item) => (
                <button
                  key={item.session_id}
                  className={`lift-hover w-full rounded-[22px] border px-4 py-3.5 text-left text-sm ${
                    currentSessionId === item.session_id
                      ? "border-[var(--accent)] bg-[rgba(77,124,255,0.08)]"
                      : "border-white/70 bg-white/[0.64]"
                  }`}
                  onClick={() => {
                    setCurrentSessionId(item.session_id);
                    window.localStorage.setItem(LOCAL_SESSION_KEY, item.session_id);
                  }}
                >
                  <div className="font-semibold text-slate-900">{item.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{item.session_id}</div>
                  {item.summary?.input_runtime?.input_source ? (
                    <div className="mt-2 text-xs text-slate-500">输入源：{String(item.summary.input_runtime.input_source)}</div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <ErrorBoundary
          fallbackRender={({ error: boundaryError }: FallbackProps) => (
            <Card className="rounded-[26px] border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              实时工作台主舞台异常：{boundaryError.message}
            </Card>
          )}
        >
          <div className="soft-enter soft-enter-delay-1 space-y-6">
            <Tabs.Root defaultValue="mermaid" className="space-y-5">
            <Tabs.List className="glass-panel inline-flex flex-wrap gap-2 rounded-full border border-white/70 p-1.5">
              {[
                ["mermaid", "Mermaid"],
                ["structure", "结构视图"],
                ["events", "事件流"],
                ["metrics", "评测指标"],
                ["pipeline", "运行摘要"],
              ].map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="rounded-full border border-transparent bg-transparent px-4 py-2.5 text-sm font-medium text-slate-600 transition data-[state=active]:border-white/80 data-[state=active]:bg-white/[0.88] data-[state=active]:text-slate-950"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <Tabs.Content value="mermaid">
              <MermaidCard
                title="Mermaid 主舞台"
                code={mermaidState?.normalized_code || mermaidState?.code || ""}
                provider={mermaidState?.provider || selectedLlmProfile?.label || null}
                model={mermaidState?.model || llmModel || null}
                latencyMs={typeof mermaidState?.latency_ms === "number" ? mermaidState.latency_ms : null}
                compileOk={typeof mermaidState?.compile_ok === "boolean" ? mermaidState.compile_ok : null}
                updatedAt={lastMermaidUpdatedAt || toLocalDateTimeLabel(mermaidState?.updated_at ? String(mermaidState.updated_at) : null)}
              />
            </Tabs.Content>

            <Tabs.Content value="structure">
              <GraphStage title="旧结构视图" nodes={rendererState.nodes || []} edges={rendererState.edges || []} />
            </Tabs.Content>

            <Tabs.Content value="events">
              <Card>
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">事件流</div>
                    <p className="mt-1 text-xs leading-6 text-slate-500">这里只保留最近更新，帮助你快速判断图是否按预期演进。</p>
                  </div>
                  <Badge>{events.length} updates</Badge>
                </div>
                <div className="max-h-[460px] space-y-3 overflow-auto pr-2">
                  {events.length ? (
                    events.slice(-12).map((event: Record<string, any>, index: number) => (
                      <div
                        key={`${event.update?.update_id}-${index}`}
                        className="glass-panel rounded-[24px] border border-white/70 p-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-slate-900">
                            Update #{event.update?.update_id} · {event.update?.intent_type}
                          </div>
                          <Badge>{event.e2e_latency_ms} ms</Badge>
                        </div>
                        <div className="mt-2 text-xs leading-6 text-slate-600">{event.update?.transcript_text}</div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[22px] border border-dashed border-slate-300 p-5 text-sm text-slate-500">
                      还没有增量事件。创建会话后发送 transcript、启动浏览器麦克风，或接入增强模式。
                    </div>
                  )}
                </div>
              </Card>
            </Tabs.Content>

            <Tabs.Content value="metrics">
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {summaryCards.map((item) => (
                    <StatCard key={item.label} label={item.label} value={String(item.value)} />
                  ))}
                </div>
                <Card>
                  <div className="mb-4 text-sm font-semibold text-slate-900">实时评测</div>
                  <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                    {JSON.stringify(snapshot?.evaluation || {}, null, 2)}
                  </pre>
                </Card>
              </div>
            </Tabs.Content>

            <Tabs.Content value="pipeline">
              <Card>
                <div className="mb-4 text-sm font-semibold text-slate-900">Pipeline 摘要</div>
                <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                  {JSON.stringify(snapshot?.pipeline?.summary || {}, null, 2)}
                </pre>
              </Card>
            </Tabs.Content>
            </Tabs.Root>
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
