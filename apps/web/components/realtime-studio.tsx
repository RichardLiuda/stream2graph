"use client";

import * as Tabs from "@radix-ui/react-tabs";
import * as Progress from "@radix-ui/react-progress";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import Link from "next/link";
import {
  AudioLines,
  ChevronDown,
  Headphones,
  Mic,
  MicOff,
  Pause,
  PanelRight,
  Play,
  RefreshCcw,
  Save,
  Send,
  StopCircle,
  WandSparkles,
  X,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Button, Card, Input, StatCard, Textarea } from "@stream2graph/ui";

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
  supportsHelperSystemAudioUi,
  supportsSystemAudioExperimentalUi,
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
import { MermaidCard, MermaidCompileStatusBadge } from "@/components/mermaid-card";

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
      return "浏览器听写";
    case "browser_display_validation":
      return "试共享声音";
    case "local_helper":
      return "本机助手";
    case "api_stt":
      return "云端听写";
    default:
      return "手动输入";
  }
}

function backendStatusLabel(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return "进行中";
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  return "空闲";
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
    return [{ value: "manual" as const, label: "打字输入" }];
  }
  if (source === "microphone_browser") {
    return [
      { value: "browser_speech" as const, label: "浏览器听写" },
      { value: "api_stt" as const, label: "云端听写" },
    ];
  }
  if (source === "system_audio_browser_experimental") {
    return [{ value: "browser_display_validation" as const, label: "试共享声音" }];
  }
  const options = [
    { value: "local_helper" as const, label: "本机助手", disabled: helperCapabilities?.capability_status !== "supported" },
    { value: "api_stt" as const, label: "云端听写" },
  ];
  return options;
}

function captureStatusLabel(status: "idle" | "capturing" | "uploading") {
  if (status === "capturing") return "采集中";
  if (status === "uploading") return "上传中";
  return "空闲";
}

function capabilityBadgeTone(status: string) {
  if (status === "supported") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "limited") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "unsupported") return "border-red-200 bg-red-50 text-red-700";
  return "";
}

/** @description 快捷操作「拉取快照」按钮：随输入来源略变 */
function snapshotLabelForSource(_source: InputSource): string {
  return "更新";
}

/** @description 快捷操作「冲刷」按钮：随输入来源略变 */
function flushLabelForSource(source: InputSource): string {
  return source === "system_audio_helper" ? "清空" : "刷新";
}

export function RealtimeStudio() {
  const queryClient = useQueryClient();
  const [studioState, studioSend] = useMachine(realtimeStudioMachine);
  const [title, setTitle] = useState("研究演示会话");
  const [datasetVersion, setDatasetVersion] = useState("");
  const [selectedTranscriptPresetId, setSelectedTranscriptPresetId] = useState("");
  const [transcriptText, setTranscriptText] = useState("");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);
  /** @description 客户端挂载后再 portal，避免 SSR 访问 `document` */
  const [detailDrawerPortalReady, setDetailDrawerPortalReady] = useState(false);
  /** @description 主舞台 Tab，用于顶栏与「主图」徽章联动 */
  const [stageTab, setStageTab] = useState("mermaid");
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
      if (e.key === "Escape") setDetailDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailDrawerOpen]);

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
      { label: "端到端延迟", value: metrics.e2e_latency_p95_ms ?? "-" },
      { label: "意图准确率", value: metrics.intent_accuracy ?? "-" },
      { label: "画面抖动", value: metrics.flicker_mean ?? "-" },
      { label: "结构好懂度", value: metrics.mental_map_mean ?? "-" },
    ];
  }, [snapshot?.evaluation?.metrics]);

  /** @description 主舞台顶栏：CAP/STT/LLM/MER 步骤徽章（4 色：空闲/进行中/成功/失败） */
  const pipelineStages = useMemo(() => {
    const mapBackendTone = (status: BackendStatus) => {
      if (status === "working") return "working";
      if (status === "success") return "success";
      if (status === "error") return "error";
      return "idle";
    };

    // CAP 本身没有 success/error，由后续转写状态推断结果；capturing/uploading 期间视为进行中。
    const capTone =
      captureStatus === "idle"
        ? sttStatus === "success"
          ? "success"
          : sttStatus === "error"
            ? "error"
            : "idle"
        : "working";

    const sttTone = mapBackendTone(sttStatus);
    const llmTone = mapBackendTone(llmStatus);

    // MER：优先用 mermaid_state 的 compile/error 信号定色；没有信号时用 llmStatus/更新时间兜底。
    let merTone: "idle" | "working" | "success" | "error" = "idle";
    if (mermaidState?.error_message) {
      merTone = "error";
    } else if (typeof mermaidState?.compile_ok === "boolean") {
      merTone = mermaidState.compile_ok ? "success" : "error";
    } else if (llmStatus === "working") {
      merTone = "working";
    } else if (lastMermaidUpdatedAt) {
      merTone = "success";
    }

    return [
      {
        abbr: "CAP",
        label: "采集",
        value: captureStatusLabel(captureStatus),
        tone: capTone,
        help: "是否在录音或上传声音。",
      },
      {
        abbr: "STT",
        label: "转写",
        value: backendStatusLabel(sttStatus),
        tone: sttTone,
        help: `转写方式：${backendLabel(selectedRecognitionBackend)}`,
      },
      {
        abbr: "LLM",
        label: "对话",
        value: backendStatusLabel(llmStatus),
        tone: llmTone,
        help: selectedLlmProfile ? `${selectedLlmProfile.label} / ${llmModel || "未选择模型"}` : "尚未配置对话模型。",
      },
      {
        abbr: "MER",
        label: "出图",
        value: lastMermaidUpdatedAt ? "已更新" : "等待中",
        tone: merTone,
        help: lastMermaidUpdatedAt || "还没有生成流程图。",
      },
    ];
  }, [
    captureStatus,
    sttStatus,
    llmStatus,
    lastMermaidUpdatedAt,
    mermaidState?.error_message,
    mermaidState?.compile_ok,
    selectedRecognitionBackend,
    selectedLlmProfile,
    llmModel,
  ]);

  const systemAudioExperimentalVisible = supportsSystemAudioExperimentalUi(audioContext);
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

  /** @description 主舞台顶栏：与抽屉内相同的开始/暂停（停止）采集逻辑 */
  async function stageStartCapture() {
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

  function stageStopCapture() {
    if (selectedInputSource === "transcript") return;
    if (selectedInputSource === "microphone_browser") {
      if (selectedRecognitionBackend === "browser_speech") return void stopRecognition();
      if (selectedRecognitionBackend === "api_stt") return void stopApiCapture();
      return;
    }
    if (selectedInputSource === "system_audio_browser_experimental") {
      return void stopBrowserDisplayAudioValidation();
    }
    if (selectedInputSource === "system_audio_helper") {
      if (selectedRecognitionBackend === "local_helper") return void stopHelperCapture();
      if (selectedRecognitionBackend === "api_stt") return void stopApiCapture();
    }
  }

  const canStartStageCapture = selectedInputSource !== "transcript" && canStartCapture;
  const canStopStageCapture = selectedInputSource !== "transcript" && canStopCapture;

  return (
    <div>
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

      <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:items-stretch xl:min-h-0">
        <Card className="soft-enter order-1 flex h-full min-h-0 min-w-0 flex-col space-y-3 overflow-hidden text-[13px] leading-snug xl:col-start-1 xl:row-start-2 xl:order-none">
          <div className="shrink-0 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-medium text-slate-700">声音从哪来</label>
              <Badge className="shrink-0 text-[10px]">{audioContext ? `${audioContext.platform} / ${getBrowserFamilyLabel(audioContext)}` : "检测中"}</Badge>
            </div>
            <div className="relative">
              <select
                className="h-10 w-full appearance-none rounded-full border border-violet-200/50 bg-violet-50/92 px-3.5 pr-9 text-sm font-medium text-slate-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(77,124,255,0.12)]"
                value={selectedInputSource}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const nextSource = event.target.value as InputSource;
                  clearFeedback();
                  const opts = buildBackendOptions(nextSource, helperCapabilities);
                  const nextBackend = opts.find((item) => !item.disabled)?.value ?? opts[0].value;
                  studioSend({ type: "source.select", source: nextSource, backend: nextBackend });
                }}
              >
                {inputOptions.map((option) => (
                  <option key={option.source} value={option.source}>
                    {option.label} · {option.capability_status}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">{selectedOption.description}</p>
            {!audioContext?.is_desktop ? (
              <div className="rounded-[14px] border border-violet-200/50 bg-violet-100/38 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                移动端不提供系统声音相关采集入口。
              </div>
            ) : !systemAudioExperimentalVisible ? (
              <div className="rounded-[14px] border border-violet-200/50 bg-violet-100/38 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                实验性「共享屏幕音频」仅 Chrome/Edge；可用「增强模式」+ 本机 audio helper。
              </div>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-[12px] border border-violet-200/50 bg-violet-100/46 px-2.5 py-2">
            <div className="flex shrink-0 items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-slate-800">实时转写</div>
              <Badge className="text-[9px]">{backendLabel(selectedRecognitionBackend)}</Badge>
            </div>
            {selectedInputSource === "transcript" ? (
              <div className="mt-1.5 flex min-h-[4rem] flex-1 flex-col gap-1.5">
                <Textarea
                  className="min-h-[7rem] flex-1 resize-y rounded-[10px] border border-violet-200/55 bg-violet-50/80 px-2 py-2 text-[12px] leading-relaxed text-slate-800"
                  rows={8}
                  value={transcriptText}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                    const next = event.target.value;
                    setTranscriptText(next);
                    studioSend({ type: "transcript.preview", text: next });
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0 py-2 text-xs"
                  onClick={() => sendTranscript.mutate()}
                  disabled={sendTranscript.isPending || !transcriptText.trim()}
                >
                  <Send className="h-3.5 w-3.5" />
                  发送文本
                </Button>
              </div>
            ) : (
              <div className="mt-1.5 min-h-[4rem] flex-1 overflow-auto whitespace-pre-wrap rounded-[10px] bg-violet-50/80 px-2 py-2 text-[12px] leading-relaxed text-slate-800">
                {formatLiveTranscript(liveTranscript)}
              </div>
            )}
            <p className="mt-1.5 shrink-0 text-[9px] leading-snug text-slate-500">
              {selectedInputSource === "transcript"
                ? "与侧栏同一输入；发送后写入会话。"
                : "浏览器听写多为临时内容；本机助手 / 云端听写会写回这里。"}
            </p>
          </div>

          <div className="shrink-0 rounded-[12px] border border-violet-200/50 bg-violet-100/44 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-slate-800">输入音量</div>
              <Badge className="text-[10px]">{Math.round(inputLevel * 100)}%</Badge>
            </div>
            <Progress.Root className="mt-2 h-2 overflow-hidden rounded-full bg-violet-200/50" value={Math.max(0, Math.round(inputLevel * 100))}>
              <Progress.Indicator
                className="h-full bg-[linear-gradient(90deg,#66b1ff,#6d89ff,#34c38f)] transition-transform duration-150"
                style={{ transform: `translateX(-${100 - Math.max(0, Math.round(inputLevel * 100))}%)` }}
              />
            </Progress.Root>
            <p className="mt-1.5 text-[9px] leading-snug text-slate-500">
              {activeCaptureSource ? "采集中刷新。" : "开始采集后显示音量。"}
            </p>
          </div>
        </Card>

        <div className="order-2 flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 xl:col-span-2 xl:row-start-1 xl:order-none">
          {stageTab === "mermaid" ? (
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                {mermaidState?.provider || selectedLlmProfile?.label ? (
                  <Badge>{mermaidState?.provider || selectedLlmProfile?.label}</Badge>
                ) : null}
                {mermaidState?.model || llmModel ? <Badge>{mermaidState?.model || llmModel}</Badge> : null}
                {typeof mermaidState?.latency_ms === "number" ? (
                  <Badge>{mermaidState.latency_ms.toFixed(1)} ms</Badge>
                ) : null}
                <MermaidCompileStatusBadge
                  compileOk={typeof mermaidState?.compile_ok === "boolean" ? mermaidState.compile_ok : null}
                  updatedAt={
                    lastMermaidUpdatedAt ||
                    toLocalDateTimeLabel(mermaidState?.updated_at ? String(mermaidState.updated_at) : null)
                  }
                />
                <Badge
                  className="border-violet-200/50 bg-violet-100/50 text-[10px] font-normal text-slate-700"
                  title={currentSessionId || undefined}
                >
                  <span className="block max-w-[140px] min-w-0 truncate">
                    {currentSessionId ? `Session ${currentSessionId}` : "未创建会话"}
                  </span>
                </Badge>
                <Badge className="border-violet-200/50 bg-violet-100/50 text-[10px] font-normal text-slate-700">
                  {getSourceBadgeLabel(activeCaptureSource)}
                </Badge>
                <Badge className="border-violet-200/50 bg-violet-100/50 text-[10px] font-normal text-slate-700">
                  {backendLabel(selectedRecognitionBackend)}
                </Badge>
                {snapshot?.evaluation?.realtime_eval_pass === true ? (
                  <Badge className="border-emerald-200 bg-emerald-50 text-[10px] font-normal text-emerald-700">评测通过</Badge>
                ) : null}
            </div>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="shrink-0 gap-2 text-sm"
            onClick={() => setDetailDrawerOpen(true)}
          >
            <PanelRight className="h-4 w-4" />
            会话与录音设置
          </Button>
        </div>

        <div className="order-3 flex min-h-0 min-w-0 flex-1 flex-col xl:col-start-2 xl:row-start-2 xl:min-h-0">
        <ErrorBoundary
          fallbackRender={({ error: boundaryError }: FallbackProps) => (
            <Card className="rounded-[26px] border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              本页异常：{boundaryError.message}
            </Card>
          )}
        >
          <div className="soft-enter soft-enter-delay-1 flex min-h-0 min-w-0 flex-1 flex-col">
            <Tabs.Root value={stageTab} onValueChange={setStageTab} className="flex min-h-0 flex-1 flex-col">
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[26px] border border-violet-200/50 bg-[linear-gradient(180deg,rgba(242,240,255,0.94),rgba(226,222,250,0.82))] p-0 shadow-[0_18px_46px_rgba(36,80,198,0.08)] backdrop-blur-md">
              <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-violet-200/50 px-4 pb-2 pt-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Tabs.List className="glass-panel inline-flex w-fit min-w-0 max-w-full shrink-0 flex-wrap gap-1.5 self-start rounded-full border border-violet-200/50 p-1.5 sm:gap-2">
              {[
                ["mermaid", "主图"],
                ["structure", "结构视图"],
                ["events", "更新记录"],
                ["metrics", "评测指标"],
                ["pipeline", "运行摘要"],
              ].map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="rounded-full border border-transparent bg-transparent px-3 py-2 text-sm font-medium text-slate-600 transition data-[state=active]:border-violet-200/55 data-[state=active]:bg-violet-50/92 data-[state=active]:text-slate-950 sm:px-3.5"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
                <Tooltip.Provider delayDuration={200}>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {pipelineStages.map((step) => (
                    <Tooltip.Root key={step.abbr}>
                      <Tooltip.Trigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded-full border border-violet-200/55 bg-violet-50/95 px-2 py-1 text-[11px] font-medium text-slate-600 shadow-[0_1px_3px_rgba(91,64,180,0.08)] transition hover:shadow-[0_2px_6px_rgba(91,64,180,0.1)]"
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              step.tone === "working"
                                ? "bg-sky-500"
                                : step.tone === "success"
                                  ? "bg-emerald-500"
                                  : step.tone === "error"
                                    ? "bg-red-500"
                                    : "bg-slate-300"
                            }`}
                            aria-hidden
                          />
                          {step.label}
                        </button>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          sideOffset={6}
                          className="max-w-[280px] rounded-xl border border-violet-200/60 bg-violet-50 px-3 py-2 text-xs leading-relaxed text-slate-700 shadow-lg z-[9999]"
                        >
                          <div className="font-semibold text-slate-900">
                            {step.label}
                            <span className="ml-1.5 font-normal text-slate-500">({step.abbr})</span>
                          </div>
                          <div className="mt-1 text-slate-600">状态：{step.value}</div>
                          <p className="mt-1.5 text-slate-500">{step.help}</p>
                          <Tooltip.Arrow className="fill-white" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  ))}
                  </div>
                </Tooltip.Provider>
                </div>
                <div className="grid w-full max-w-[min(100%,260px)] shrink-0 grid-cols-2 gap-1 sm:ml-auto">
                  <Button
                    type="button"
                    variant="secondary"
                    title={
                      selectedInputSource === "transcript"
                        ? "请先在左侧栏选择麦克风或系统音输入"
                        : "开始录音"
                    }
                    className="h-7 min-w-0 justify-center gap-0.5 px-1 py-0 text-[10px] font-medium"
                    onClick={() => void stageStartCapture()}
                    disabled={!canStartStageCapture}
                  >
                    <Mic className="h-3 w-3 shrink-0" />
                    <span className="truncate">开始录音</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    title={
                      selectedInputSource === "transcript"
                        ? "请先在左侧栏选择麦克风或系统音输入"
                        : "暂停录音（停止当前采集）"
                    }
                    className="h-7 min-w-0 justify-center gap-0.5 px-1 py-0 text-[10px] font-medium"
                    onClick={() => void stageStopCapture()}
                    disabled={!canStopStageCapture}
                  >
                    <Pause className="h-3 w-3 shrink-0" />
                    <span className="truncate">暂停录音</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    title={`${snapshotLabelForSource(selectedInputSource)}（拉取快照）`}
                    className="h-7 min-w-0 justify-center gap-0.5 px-1 py-0 text-[10px] font-medium"
                    onClick={() => (currentSessionId ? snapshotMutation.mutate(currentSessionId) : null)}
                    disabled={!currentSessionId}
                  >
                    <RefreshCcw className="h-3 w-3 shrink-0" />
                    <span className="truncate">{snapshotLabelForSource(selectedInputSource)}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    title={`${flushLabelForSource(selectedInputSource)}（冲刷/刷新）`}
                    className="h-7 min-w-0 justify-center gap-0.5 px-1 py-0 text-[10px] font-medium"
                    onClick={() => (currentSessionId ? flushMutation.mutate(currentSessionId) : null)}
                    disabled={!currentSessionId}
                  >
                    <Play className="h-3 w-3 shrink-0" />
                    <span className="truncate">{flushLabelForSource(selectedInputSource)}</span>
                  </Button>
                </div>
              </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <Tabs.Content value="mermaid" className="outline-none">
              <MermaidCard
                title=""
                embedded
                height={440}
                code={mermaidState?.code || mermaidState?.normalized_code || ""}
                rawOutputText={typeof mermaidState?.raw_output_text === "string" ? mermaidState.raw_output_text : null}
                repairRawOutputText={
                  typeof mermaidState?.repair_raw_output_text === "string" ? mermaidState.repair_raw_output_text : null
                }
                provider={mermaidState?.provider || selectedLlmProfile?.label || null}
                model={mermaidState?.model || llmModel || null}
                latencyMs={typeof mermaidState?.latency_ms === "number" ? mermaidState.latency_ms : null}
                compileOk={typeof mermaidState?.compile_ok === "boolean" ? mermaidState.compile_ok : null}
                updatedAt={lastMermaidUpdatedAt || toLocalDateTimeLabel(mermaidState?.updated_at ? String(mermaidState.updated_at) : null)}
              />
            </Tabs.Content>

            <Tabs.Content value="structure">
              <GraphStage embedded title="结构图" nodes={rendererState.nodes || []} edges={rendererState.edges || []} />
            </Tabs.Content>

            <Tabs.Content value="events">
              <Card>
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">更新记录</div>
                    <p className="mt-1 text-xs leading-6 text-slate-500">只看最近几条，方便判断图有没有按预期变化。</p>
                  </div>
                  <Badge>{events.length} updates</Badge>
                </div>
                <div className="max-h-[460px] space-y-3 overflow-auto pr-2">
                  {events.length ? (
                    events.slice(-12).map((event: Record<string, any>, index: number) => (
                      <div
                        key={`${event.update?.update_id}-${index}`}
                        className="glass-panel rounded-[24px] border border-violet-200/50 p-4"
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
                  <div className="mb-4 text-sm font-semibold text-slate-900">效果数据</div>
                  <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                    {JSON.stringify(snapshot?.evaluation || {}, null, 2)}
                  </pre>
                </Card>
              </div>
            </Tabs.Content>

            <Tabs.Content value="pipeline">
              <Card>
                <div className="mb-4 text-sm font-semibold text-slate-900">处理步骤摘要</div>
                <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                  {JSON.stringify(snapshot?.pipeline?.summary || {}, null, 2)}
                </pre>
              </Card>
            </Tabs.Content>
            </div>
            <div className="flex shrink-0 justify-end border-t border-violet-200/50 px-4 py-2.5">
              <div className="grid w-[min(100%,22rem)] grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => createSession.mutate()}
                  disabled={createSession.isPending}
                >
                  <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{currentSessionId ? "重建会话" : "创建会话"}</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  title="保存报告"
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => (currentSessionId ? saveReportMutation.mutate(currentSessionId) : null)}
                  disabled={!currentSessionId}
                >
                  <Save className="h-3 w-3 shrink-0" />
                  <span className="truncate">保存</span>
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  title="关闭会话"
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => (currentSessionId ? closeMutation.mutate(currentSessionId) : null)}
                  disabled={!currentSessionId}
                >
                  <StopCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">关闭</span>
                </Button>
              </div>
            </div>
            </Card>
            </Tabs.Root>
          </div>
        </ErrorBoundary>
        </div>
      </div>

        <Card className="soft-enter space-y-3">
          <div className="text-sm font-semibold text-slate-900">最近会话</div>
          <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
            {sessions.data?.map((item) => (
              <button
                key={item.session_id}
                type="button"
                className={`lift-hover w-full rounded-[22px] border px-4 py-3.5 text-left text-sm ${
                  currentSessionId === item.session_id
                    ? "border-[var(--accent)] bg-[rgba(77,124,255,0.08)]"
                    : "border-violet-200/50 bg-violet-100/52"
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
        </Card>

        <Card className="soft-enter space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-base font-semibold text-slate-950">默认设置（只读）</div>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                详细模型与显示方式请在「设置」里改。这里只显示当前会话会沿用的默认值。
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
              服务端还缺少语言模型或听写服务配置。请打开「设置」按提示补全环境变量后重启 API。
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                label: "默认对话模型",
                value: hasLlmProfiles ? `${selectedLlmProfile?.label || "未选择"} / ${llmModel || "未选择模型"}` : "未配置",
              },
              {
                label: "默认听写服务",
                value: hasSttProfiles ? `${selectedSttProfile?.label || "未选择"} / ${sttModel || "未选择模型"}` : "未配置",
              },
              {
                label: "显示方式",
                value: diagramMode === "dual_view" ? "流程图+结构图" : "仅流程图",
              },
            ].map((item) => (
              <div key={item.label} className="rounded-[22px] border border-violet-200/50 bg-violet-100/46 px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
                <div className="mt-3 text-sm font-semibold leading-6 text-slate-900">{item.value}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {detailDrawerPortalReady
        ? createPortal(
            <>
              {detailDrawerOpen ? (
                <button
                  type="button"
                  aria-label="关闭侧栏"
                  className="fixed inset-0 z-[100] bg-slate-900/35 backdrop-blur-[2px] transition-opacity"
                  onClick={() => setDetailDrawerOpen(false)}
                />
              ) : null}
              <aside
                aria-hidden={!detailDrawerOpen}
                className={`fixed inset-y-0 right-0 z-[110] flex w-[min(420px,92vw)] max-w-full transition-transform duration-300 ease-out ${
                  detailDrawerOpen ? "translate-x-0 shadow-[0_0_40px_rgba(15,23,42,0.12)]" : "pointer-events-none translate-x-full"
                }`}
              >
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-y-0 border-r-0 border-l border-violet-200/45 sm:my-4 sm:mr-4 sm:h-[calc(100vh-2rem)] sm:rounded-[26px] sm:border sm:border-violet-200/50">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-violet-200/50 px-4 py-3">
            <div className="text-sm font-semibold text-slate-900">会话与录音设置</div>
            <Button type="button" variant="ghost" className="h-9 w-9 shrink-0 p-0" onClick={() => setDetailDrawerOpen(false)} aria-label="关闭">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">会话标题</label>
              <Input value={title} onChange={(event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)} />
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">数据版本</label>
              <div className="relative">
                <select
                  className="h-11 w-full appearance-none rounded-full border border-violet-200/50 bg-violet-50/88 px-4 pr-10 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-violet-50 focus:ring-4 focus:ring-[rgba(77,124,255,0.12)]"
                  value={datasetVersion}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setDatasetVersion(event.target.value)}
                >
                  {datasets.data?.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.slug}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">转写方式</label>
              <div className="relative">
                <select
                  className="h-10 w-full appearance-none rounded-full border border-violet-200/50 bg-violet-50/92 px-3.5 pr-9 text-sm font-medium text-slate-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(77,124,255,0.12)] disabled:opacity-50"
                  value={selectedRecognitionBackend}
                  disabled={backendOptions.every((o) => o.disabled)}
                  onChange={(event) => {
                    clearFeedback();
                    studioSend({ type: "backend.select", backend: event.target.value as RecognitionBackend });
                  }}
                >
                  {backendOptions.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabled}>
                      {option.label}
                      {option.value === "api_stt" ? " (service)" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                {selectedRecognitionBackend === "browser_speech"
                  ? "浏览器语音识别，启动快，稳定性受浏览器影响。"
                  : selectedRecognitionBackend === "browser_display_validation"
                    ? "仅验证共享音频轨道可达性。"
                    : selectedRecognitionBackend === "local_helper"
                      ? "本机 helper 采集与转写。"
                      : selectedRecognitionBackend === "api_stt"
                        ? "服务端 OpenAI-compatible STT。"
                        : "手动 transcript。"}
              </p>
            </div>

            {selectedInputSource === "transcript" ? (
              <details className="space-y-3 rounded-[22px] border border-violet-200/50 bg-violet-100/38 p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-slate-800 marker:content-none [&::-webkit-details-marker]:hidden">
                  <span>文字输入与样例</span>
                  <span className="text-xs font-normal text-slate-500">点击展开</span>
                </summary>
                <div className="mt-4 space-y-3">
                  <p className="text-xs leading-6 text-slate-500">支持 `speaker | text | expected_intent`，一行一条，适合演示和快速回放。</p>
                  <div className="rounded-[20px] border border-violet-200/50 bg-violet-100/42 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">样例库</div>
                        <div className="mt-1 text-xs leading-6 text-slate-500">选择一组 richer transcript，直接替换到输入框里。</div>
                      </div>
                      <select
                        className="h-11 min-w-[220px] rounded-[18px] border border-violet-200/50 bg-violet-50/85 px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(77,124,255,0.12)]"
                        value={selectedTranscriptPresetId}
                        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                          const nextId = event.target.value;
                          const nextPreset = TRANSCRIPT_PRESETS.find((item) => item.id === nextId);
                          setSelectedTranscriptPresetId(nextId);
                          if (nextPreset) {
                            setTranscriptText(nextPreset.value);
                          } else {
                            setTranscriptText("");
                          }
                        }}
                      >
                        <option value="">不使用样例</option>
                        {TRANSCRIPT_PRESETS.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-3 text-xs leading-6 text-slate-600">
                      {TRANSCRIPT_PRESETS.find((preset) => preset.id === selectedTranscriptPresetId)?.description ??
                        "需要演示内容时再从上面选一个样例。"}
                    </div>
                  </div>
                  <Textarea
                    rows={12}
                    value={transcriptText}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTranscriptText(event.target.value)}
                  />
                  <Button className="py-3" variant="secondary" onClick={() => sendTranscript.mutate()} disabled={sendTranscript.isPending}>
                    <Send className="h-4 w-4" />
                    发送文本
                  </Button>
                </div>
              </details>
            ) : null}

            {selectedInputSource === "microphone_browser" ? (
              <div className="space-y-3">
                <div className="rounded-[20px] border border-violet-200/50 bg-violet-100/42 px-4 py-3 text-xs leading-6 text-slate-500">
                  {selectedRecognitionBackend === "browser_speech"
                    ? "浏览器麦克风依赖 Web Speech 服务。如果提示网络或服务不可用，通常不是项目后端报错，先用 Transcript 输入会更稳定。"
                    : "API STT 路径会直接把麦克风音频分段上传到服务端转写，再回写当前会话。"}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {selectedRecognitionBackend === "browser_speech" ? (
                    <>
                      <Button className="py-3" variant="ghost" onClick={() => void startRecognition()} disabled={!canStartCapture}>
                        <Mic className="h-4 w-4" />
                        开始说话
                      </Button>
                      <Button className="py-3" variant="ghost" onClick={stopRecognition} disabled={!canStopCapture}>
                        <MicOff className="h-4 w-4" />
                        停止
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button className="py-3" variant="secondary" onClick={() => void startApiCapture()} disabled={!canStartCapture}>
                        <Mic className="h-4 w-4" />
                        开始识别
                      </Button>
                      <Button className="py-3" variant="ghost" onClick={() => void stopApiCapture()} disabled={!canStopCapture}>
                        <StopCircle className="h-4 w-4" />
                        停止
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
                    检测声音
                  </Button>
                  <Button
                    className="py-3"
                    variant="ghost"
                    onClick={stopBrowserDisplayAudioValidation}
                    disabled={activeCaptureSource !== "system_audio_browser_experimental"}
                  >
                    <StopCircle className="h-4 w-4" />
                    结束
                  </Button>
                </div>
              </div>
            ) : null}

            {selectedInputSource === "system_audio_helper" ? (
              <div className="space-y-3">
                {selectedRecognitionBackend === "local_helper" ? (
                  <>
                    <div className="rounded-[20px] border border-violet-200/50 bg-violet-100/42 px-4 py-3 text-xs leading-6 text-slate-500">
                      增强模式会连接本机 `audio helper`，由浏览器提供共享音频流，再由辅助层在本机完成分段转写。当前辅助层地址：
                      <span className="ml-1 font-medium text-slate-700">{audioHelper.baseUrl}</span>
                    </div>
                    <div className="rounded-[20px] border border-violet-200/50 bg-violet-100/46 px-4 py-4 text-sm">
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
                        开始采集
                      </Button>
                      <Button className="py-3" variant="ghost" onClick={() => void stopHelperCapture()} disabled={!canStopCapture}>
                        <StopCircle className="h-4 w-4" />
                        停止
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-[20px] border border-violet-200/50 bg-violet-100/42 px-4 py-3 text-xs leading-6 text-slate-500">
                      API STT 路径会复用浏览器共享音频流，把系统声音分段上传到服务端转写。Windows 请勾选共享音频；macOS 请优先选择标签页音频。
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button className="py-3" variant="secondary" onClick={() => void startApiCapture()} disabled={!canStartCapture}>
                        <Headphones className="h-4 w-4" />
                        开始识别
                      </Button>
                      <Button className="py-3" variant="ghost" onClick={() => void stopApiCapture()} disabled={!canStopCapture}>
                        <StopCircle className="h-4 w-4" />
                        停止
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

          </div>
        </Card>
              </aside>
            </>,
            document.body
          )
        : null}
    </div>
  );
}
