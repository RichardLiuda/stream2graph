"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { GraphStage } from "@/components/graph-stage";

const LOCAL_SESSION_KEY = "s2g:last-realtime-session";

type TranscriptRow = {
  text: string;
  speaker: string;
  expected_intent?: string | null;
};

type NoticeTone = "info" | "success" | "warning";

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

export function RealtimeStudio() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("研究演示会话");
  const [datasetVersion, setDatasetVersion] = useState("");
  const [transcriptText, setTranscriptText] = useState(
    [
      "expert|First define ingestion flow and source node.|sequential",
      "expert|Then route events to parser and validation service.|sequential",
      "expert|The gateway module connects auth service and data service.|structural",
    ].join("\n"),
  );
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [audioContext, setAudioContext] = useState<ClientAudioContext | null>(null);
  const [selectedInputSource, setSelectedInputSource] = useState<InputSource>("transcript");
  const [activeCaptureSource, setActiveCaptureSource] = useState<InputSource | null>(null);
  const recognitionRef = useRef<any>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const helperEventSourceRef = useRef<EventSource | null>(null);
  const helperChunkQueueRef = useRef<Promise<void>>(Promise.resolve());

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.listDatasets });
  const sessions = useQuery({ queryKey: ["realtime-sessions"], queryFn: api.listRealtimeSessions });
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

  useEffect(() => {
    if (!inputOptions.some((item) => item.source === selectedInputSource)) {
      setSelectedInputSource("transcript");
    }
  }, [inputOptions, selectedInputSource]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop?.();
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      helperEventSourceRef.current?.close();
      void audioHelper.stopCapture().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (selectedInputSource !== "microphone_browser") {
      recognitionRef.current?.stop?.();
      setListening(false);
    }
    if (selectedInputSource !== "system_audio_browser_experimental") {
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      displayStreamRef.current = null;
      if (activeCaptureSource === "system_audio_browser_experimental") {
        setActiveCaptureSource(null);
      }
    }
    if (selectedInputSource !== "system_audio_helper" && activeCaptureSource === "system_audio_helper") {
      helperEventSourceRef.current?.close();
      helperEventSourceRef.current = null;
      void audioHelper.stopCapture().catch(() => undefined);
      setActiveCaptureSource(null);
    }
  }, [activeCaptureSource, selectedInputSource]);

  function clearFeedback() {
    setError(null);
    setNotice(null);
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
    };
  }

  const createSession = useMutation({
    mutationFn: () =>
      api.createRealtimeSession({
        title,
        dataset_version_slug: datasetVersion || null,
        min_wait_k: 1,
        base_wait_k: 2,
        max_wait_k: 4,
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
    mutationFn: (sessionId: string) => api.snapshotRealtime(sessionId),
    onSuccess: (data) => {
      setSnapshot(data);
      setError(null);
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
    const data = await api.addRealtimeChunk(sessionId, {
      text,
      speaker: source === "system_audio_helper" ? "system_audio" : "speaker",
      is_final: isFinal,
      metadata: buildChunkMetadata(source, captureMode),
    });
    setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
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
      setNotice({ tone: "success", text: "Transcript 已写入当前会话。" });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const flushMutation = useMutation({
    mutationFn: (sessionId: string) => api.flushRealtime(sessionId),
    onSuccess: (data) => setSnapshot(data),
    onError: (err) => setError((err as Error).message),
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: string) => api.closeRealtime(sessionId),
    onSuccess: () => {
      if (currentSessionId) window.localStorage.removeItem(LOCAL_SESSION_KEY);
      setCurrentSessionId(null);
      setSnapshot(null);
      setActiveCaptureSource(null);
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
    recognition.interimResults = false;
    recognition.onresult = async (event: any) => {
      const lastResult = event.results[event.results.length - 1];
      const text = lastResult[0].transcript;
      const data = await api.addRealtimeChunk(sessionId, {
        text,
        speaker: "speaker",
        is_final: true,
        metadata: buildChunkMetadata("microphone_browser", "browser_speech"),
      });
      setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
      setNotice({ tone: "success", text: "已写入一段浏览器麦克风识别文本。" });
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      if (activeCaptureSource === "microphone_browser") setActiveCaptureSource(null);
    };
    recognition.onerror = (evt: any) => {
      recognitionRef.current = null;
      setListening(false);
      if (activeCaptureSource === "microphone_browser") setActiveCaptureSource(null);
      setError(getSpeechRecognitionErrorMessage(evt?.error));
    };
    try {
      recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      setListening(false);
      setError(err instanceof Error ? err.message : "语音识别启动失败");
      return;
    }
    recognitionRef.current = recognition;
    setListening(true);
    setActiveCaptureSource("microphone_browser");
    setNotice({ tone: "info", text: "浏览器麦克风识别已启动，后续识别结果会直接写入当前会话。" });
  }

  function stopRecognition() {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    setListening(false);
    if (activeCaptureSource === "microphone_browser") setActiveCaptureSource(null);
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
        if (activeCaptureSource === "system_audio_browser_experimental") setActiveCaptureSource(null);
      };
      stream.getTracks().forEach((track) => track.addEventListener("ended", handleEnded));
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        setError("浏览器已开始共享，但当前没有拿到音频轨道。Windows 请确认勾选共享音频；macOS 请优先尝试标签页音频。");
        return;
      }
      setActiveCaptureSource("system_audio_browser_experimental");
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
    if (activeCaptureSource === "system_audio_browser_experimental") setActiveCaptureSource(null);
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
    const sessionId = await ensureSession();
    helperEventSourceRef.current?.close();
    helperEventSourceRef.current = subscribeAudioHelperEvents(
      (payload) => {
        if (payload.error_message) {
          setError(payload.error_message);
        }
        if (payload.status === "running") {
          setActiveCaptureSource("system_audio_helper");
          setNotice({ tone: "success", text: "增强模式已启动，等待本地辅助层推送识别结果。" });
        }
        if (payload.status === "stopped") {
          setActiveCaptureSource(null);
          setNotice({ tone: "info", text: "增强模式已停止。" });
        }
        if (payload.text?.trim()) {
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
        setError("audio helper 事件流已断开。请检查本机辅助层服务。");
        setActiveCaptureSource(null);
      },
    );
    const result = await audioHelper.startCapture({
      source_type: "system_audio_helper",
      session_id: sessionId,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setActiveCaptureSource("system_audio_helper");
  }

  async function stopHelperCapture() {
    helperEventSourceRef.current?.close();
    helperEventSourceRef.current = null;
    try {
      await audioHelper.stopCapture();
    } catch {
      // ignore local helper shutdown errors
    }
    setActiveCaptureSource(null);
    setNotice({ tone: "info", text: "已请求停止增强模式采集。" });
  }

  const rendererState = snapshot?.pipeline?.renderer_state || {};
  const events = snapshot?.pipeline?.events || [];

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
            {snapshot?.evaluation?.realtime_eval_pass === true ? (
              <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">评测通过</Badge>
            ) : null}
          </div>
        }
      />

      {error ? (
        <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}
      {notice ? (
        <div className={`rounded-[24px] border px-4 py-3 text-sm ${getNoticeClassName(notice.tone)}`}>{notice.text}</div>
      ) : null}

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-950">推荐流程</div>
            <p className="mt-2 text-sm leading-6 text-slate-600">先创建会话，再选择输入源并写入文本，最后在右侧查看增量图和评测结果。</p>
          </div>
          <Badge>{selectedOption.label}</Badge>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["1", "创建会话", "设置标题、数据集和输入源，上下文会一起保存。"],
            ["2", "写入内容", "Transcript 最稳定；浏览器系统声音只做验证；增强模式依赖本地辅助层。"],
            ["3", "查看结果", "在图舞台、事件流、评测指标和运行摘要之间切换查看。"],
          ].map(([step, titleText, desc]) => (
            <div key={step} className="rounded-[22px] border border-white/70 bg-white/[0.56] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-strong)]">Step {step}</div>
              <div className="mt-2 text-sm font-semibold text-slate-900">{titleText}</div>
              <div className="mt-2 text-sm leading-6 text-slate-600">{desc}</div>
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
                    setSelectedInputSource(option.source);
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-900">{option.label}</div>
                    <Badge>{option.capability_status}</Badge>
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

          {selectedInputSource === "transcript" ? (
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-slate-700">Transcript 输入</label>
                <p className="mt-2 text-xs leading-6 text-slate-500">支持 `speaker | text | expected_intent`，一行一条，适合演示和快速回放。</p>
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
                浏览器麦克风依赖 Web Speech 服务。如果提示网络或服务不可用，通常不是项目后端报错，先用 Transcript 输入会更稳定。
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button className="py-3" variant="ghost" onClick={() => void startRecognition()} disabled={listening}>
                  <Mic className="h-4 w-4" />
                  麦克风开始
                </Button>
                <Button className="py-3" variant="ghost" onClick={stopRecognition} disabled={!listening}>
                  <MicOff className="h-4 w-4" />
                  麦克风停止
                </Button>
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
              <div className="rounded-[20px] border border-white/70 bg-white/[0.52] px-4 py-3 text-xs leading-6 text-slate-500">
                增强模式会连接本机 `audio helper`，由辅助层负责系统声音采集和文本桥接。当前辅助层地址：
                <span className="ml-1 font-medium text-slate-700">{audioHelper.baseUrl}</span>
              </div>
              <div className="rounded-[20px] border border-white/70 bg-white/[0.58] px-4 py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-semibold text-slate-900">辅助层状态</div>
                  <Badge>{helperCapabilities?.capability_status || "offline"}</Badge>
                </div>
                <div className="mt-2 text-sm leading-6 text-slate-600">
                  {helperCapabilities?.capability_reason || "未检测到本地 audio helper。请先运行 `pnpm audio-helper:dev`。"}
                </div>
                <div className="mt-2 text-xs leading-6 text-slate-500">
                  native engine: {helperCapabilities?.native_engine || "unavailable"}
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
                  disabled={!helperCapabilities || helperCapabilities.capability_status !== "supported"}
                >
                  <AudioLines className="h-4 w-4" />
                  启动增强模式
                </Button>
                <Button
                  className="py-3"
                  variant="ghost"
                  onClick={() => void stopHelperCapture()}
                  disabled={activeCaptureSource !== "system_audio_helper"}
                >
                  <StopCircle className="h-4 w-4" />
                  停止增强模式
                </Button>
              </div>
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

        <div className="soft-enter soft-enter-delay-1 space-y-6">
          <GraphStage title="增量图舞台" nodes={rendererState.nodes || []} edges={rendererState.edges || []} />
          <Tabs.Root defaultValue="events" className="space-y-5">
            <Tabs.List className="glass-panel inline-flex flex-wrap gap-2 rounded-full border border-white/70 p-1.5">
              {[
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
      </div>
    </div>
  );
}
