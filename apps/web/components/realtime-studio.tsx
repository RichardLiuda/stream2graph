"use client";

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
  StopCircle,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Button, Card, Input, StatCard, Textarea } from "@stream2graph/ui";
import type { RealtimeSession, RealtimeTranscriptTurn } from "@stream2graph/contracts";

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
import { type RecognitionBackend, realtimeStudioMachine } from "@/lib/realtime-machine";
import {
  loadRuntimePreferences,
  resolveRuntimePreferences,
  saveRuntimePreferences,
} from "@/lib/runtime-preferences";
import { GraphStage } from "@/components/graph-stage";
import { MermaidCard, type MermaidNodeRelayoutPayload } from "@/components/mermaid-card";

const LOCAL_SESSION_KEY = "s2g:last-realtime-session";

const DEFAULT_VOICEPRINT_BASE = "https://api.xf-yun.com";

type AdminRuntimeOptionsPayload = Awaited<ReturnType<typeof api.getAdminRuntimeOptions>>;

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
  label: string;
  description: string;
  value: string;
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
    id: "demo_mindmap_public_culture",
    label: "演示思维导图",
    description: "基于公开访谈整理，适合展示中心主题、一级分支和延展细节。",
    value: [
      "主持人|我们今天围绕公共文化服务提升来做一张思维导图，中心主题就叫公共文化服务提升。|structural",
      "嘉宾|中心主题下面先分成四个一级分支，分别是空间建设、数字服务、社会参与和文旅融合。|structural",
      "主持人|空间建设这一支继续展开，放角楼图书馆、红楼藏书楼和腾退空间改造。|structural",
      "嘉宾|数字服务这一支补充线上阅读、数字资源下沉和家门口文化服务。|structural",
      "主持人|社会参与这一支体现政府引导、社会力量参与、街道社区联动和企业合作。|structural",
      "嘉宾|文旅融合这一支展开成以文塑旅、以旅彰文、老工业厂区更新和阅读空间拓展。|structural",
      "主持人|最后再加一个成果分支，连到群众文化获得感提升、城市品质提升和北京故事传播。|structural",
    ].join("\n"),
  },
  {
    id: "demo_er_reading_festival",
    label: "演示实体关系图",
    description: "基于高校读书节通知整理，适合展示活动、参与者、作品和奖项关系。",
    value: [
      "图书馆老师|我们按第十一届读书节活动通知来梳理实体，先放总活动实体“读书节”。|structural",
      "学院老师|读书节下面包含征文、摄影大赛、阅读之星评选和书香学院评选四类子活动。|structural",
      "图书馆老师|参与者分成学生、二级学院、图书馆和评委组。|structural",
      "学院老师|学生可以提交作品，作品可能是征文、摄影作品或阅读案例，每件作品都归属于一个学生，也归属于一个学院。|structural",
      "图书馆老师|评委组负责审核作品并给出奖项，奖项既可以关联作品，也可以直接关联学生或学院。|structural",
      "学院老师|图书馆负责发布通知、汇总报名和公示结果，学院负责组织报名和推荐。|structural",
      "图书馆老师|如果是阅读之星这类个人奖，就把学生和奖项直接关联；如果是书香学院，就把学院和奖项直接关联。|structural",
    ].join("\n"),
  },
  {
    id: "demo_flow_transport_service",
    label: "演示流程图",
    description: "基于“开办运输企业一件事”公开资料整理，适合展示办理流程与条件分支。",
    value: [
      "办事人|我要开办道路货物运输企业，请按一件事流程帮我梳理。|sequential",
      "导办员|第一步先进入高效办成一件事专区。|sequential",
      "导办员|第二步一次填写一张表单，并上传一套共享材料。|sequential",
      "办事人|提交之后会经过哪些环节。|structural",
      "导办员|系统受理后会自动流转到营业执照、道路货运经营许可和相关审批环节。|sequential",
      "导办员|如果材料不完整，就退回补正；如果材料齐全，就进入并联审批。|conditional",
      "办事人|审批通过以后怎么结束。|sequential",
      "导办员|最后统一出结果并反馈给企业，实现一次申请、一次办结。|sequential",
    ].join("\n"),
  },
  {
    id: "demo_sequence_online_clinic",
    label: "演示时序图",
    description: "基于公开医疗服务流程整理，适合展示患者、平台、医生和医保之间的时序关系。",
    value: [
      "患者|我想按公开医疗服务流程梳理一次线上复诊结算时序。|sequential",
      "客服|先由患者在医院应用上注册并预约复诊。|sequential",
      "客服|到预约时间后，应用把复诊请求发送给医生。|sequential",
      "医生|我先核验患者身份和既往记录，再进行在线问诊。|sequential",
      "医生|问诊完成后开具电子处方，并把处方发送给药房。|sequential",
      "药房|药房收到处方后配药，同时把费用信息提交给医保结算系统。|sequential",
      "医保专员|医保系统完成审核和实时报销，再把结算结果回传给医院和患者。|sequential",
      "客服|最后药品配送到家，患者在线查看结算结果和配送状态。|sequential",
    ].join("\n"),
  },
  {
    id: "demo_state_student_project",
    label: "演示状态图",
    description: "基于大学生创新创业训练计划工作指南整理，适合展示项目生命周期状态。",
    value: [
      "老师|我们按大学生创新创业训练计划的全生命周期来做一张状态图。|structural",
      "学生|项目最开始是申报中，提交申请书后进入立项评审。|sequential",
      "老师|评审通过转为已立项，评审未通过就进入未立项结束态。|conditional",
      "学生|已立项之后进入执行中，团队开始周记、调研和实验。|sequential",
      "老师|到中期检查时，如果进展正常就继续执行；如果问题严重就进入整改中。|conditional",
      "学生|整改通过回到执行中，整改失败可以转为终止。|conditional",
      "老师|完成研究任务并提交结题材料后，项目进入结题验收。|sequential",
      "老师|验收通过转为已结题，验收未通过可以修改后再次提交。|conditional",
    ].join("\n"),
  },
  {
    id: "demo_arch_government_service",
    label: "演示架构图",
    description: "基于北京市政务服务公开访谈整理，适合展示入口、服务、协同和结果层。",
    value: [
      "主持人|我们按北京市政务服务渠道协同来画一张架构图，中心放政务服务总入口。|structural",
      "嘉宾|总入口上面接首都之窗、北京通、政务服务大厅和自助终端四类入口。|structural",
      "主持人|总入口下面连接事项受理平台、知识库、身份认证和短信通知。|structural",
      "嘉宾|事项受理平台再对接各委办局业务系统，实现数据共享和结果回传。|structural",
      "主持人|12345热线和帮办代办体系也要接入总入口，用于咨询、回访和督办。|structural",
      "嘉宾|结果层再分成办理结果推送、评价反馈、统计分析和效能监管。|structural",
      "主持人|请把入口层、服务层、协同层和结果层的层次关系表达清楚。|structural",
    ].join("\n"),
  },
];

type DemoPreset = {
  id: string;
  label: string;
  description: string;
  value: string;
  diagramType: string;
};

const CURATED_DEMO_PRESETS: DemoPreset[] = [
  {
    id: "demo_mindmap_public_culture",
    label: "演示思维导图",
    description: "基于公开访谈整理，适合展示中心主题和层级展开。",
    value: TRANSCRIPT_PRESETS.find((p) => p.id === "demo_mindmap_public_culture")!.value,
    diagramType: "flowchart",
  },
  {
    id: "demo_er_reading_festival",
    label: "演示实体关系图",
    description: "基于高校活动通知整理，适合展示实体与关系。",
    value: TRANSCRIPT_PRESETS.find((p) => p.id === "demo_er_reading_festival")!.value,
    diagramType: "er",
  },
  {
    id: "demo_flow_transport_service",
    label: "演示流程图",
    description: "基于政务服务公开资料整理，适合展示条件分支和办理闭环。",
    value: TRANSCRIPT_PRESETS.find((p) => p.id === "demo_flow_transport_service")!.value,
    diagramType: "flowchart",
  },
  {
    id: "demo_sequence_online_clinic",
    label: "演示时序图",
    description: "基于公开医疗服务流程整理，适合展示角色之间的消息往返。",
    value: TRANSCRIPT_PRESETS.find((p) => p.id === "demo_sequence_online_clinic")!.value,
    diagramType: "sequence",
  },
  {
    id: "demo_state_student_project",
    label: "演示状态图",
    description: "基于项目指南整理，适合展示状态流转与回退。",
    value: TRANSCRIPT_PRESETS.find((p) => p.id === "demo_state_student_project")!.value,
    diagramType: "state",
  },
  {
    id: "demo_arch_government_service",
    label: "演示架构图",
    description: "基于公开访谈整理，适合展示多层服务协同。",
    value: TRANSCRIPT_PRESETS.find((p) => p.id === "demo_arch_government_service")!.value,
    diagramType: "flowchart",
  },
];

const DEFAULT_DEMO_PRESET_ID = CURATED_DEMO_PRESETS[0].id;

function mapDiagramHintToMermaidType(hint?: string): string {
  if (!hint) return "flowchart";
  const map: Record<string, string> = {
    flowchart: "flowchart",
    sequence: "sequence",
    class: "class",
    state: "state",
    er: "er",
    requirement: "requirement",
    architecture: "flowchart",
  };
  return map[hint] || "flowchart";
}

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
const AUDIO_SEGMENT_MAX_MS = 6_000;
const AUDIO_SEGMENT_END_SILENCE_MS = 520;
const AUDIO_SEGMENT_MIN_SPEECH_MS = 320;
const AUDIO_SEGMENT_PREROLL_MS = 180;
const AUDIO_LEVEL_START_THRESHOLD = 0.08;
const AUDIO_LEVEL_CONTINUE_THRESHOLD = 0.045;

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

function formatLiveTranscript(text: string) {
  return text.trim() || "等待识别结果...";
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
  return {
    speaker: row.speaker,
    text: row.text,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    is_final: row.is_final,
    source: row.source,
    capture_mode: typeof row.capture_mode === "string" ? row.capture_mode : "",
  };
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
              {
                speaker,
                text,
                start_ms: Number.isFinite(startMs) ? startMs : 0,
                end_ms: Number.isFinite(endMs) ? endMs : 0,
                is_final: true,
                source: "event_fallback",
                capture_mode: `event_${eventIndex}_${turnIndex}`,
              },
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
          {
            speaker: "speaker",
            text: transcriptText,
            start_ms: startMs,
            end_ms: endMs,
            is_final: true,
            source: "event_fallback",
            capture_mode: `event_${eventIndex}`,
          },
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

function downloadCurrentMermaidSvg(exportRootId: string, filename: string) {
  const root = document.querySelector<HTMLElement>(`[data-mermaid-export-root="${exportRootId}"]`);
  const svgElement = root?.querySelector("svg");
  if (!(svgElement instanceof SVGSVGElement)) {
    throw new Error("当前没有可下载的图表。");
  }
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
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

function backendLabel(backend: RecognitionBackend) {
  switch (backend) {
    case "browser_speech":
      return "浏览器听写";
    case "browser_display_validation":
      return "试共享声音";
    case "local_helper":
      return "本机处理";
    case "api_stt":
      return "讯飞 RTASR";
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

function backendStatusTone(status: "idle" | "working" | "success" | "error") {
  if (status === "working") return "working";
  if (status === "idle") return "idle";
  if (status === "error") return "error";
  return "success";
}

function toLocalDateTimeLabel(value: string | null) {
  if (!value) return "尚未生成";
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

function buildBackendOptions(source: InputSource, helperCapabilities: HelperCapabilities | null): BackendOption[] {
  if (source === "transcript" || source === "demo_mode") {
    return [{ value: "manual" as const, label: "文本输入" }];
  }
  if (source === "microphone_browser") {
    return [
      { value: "api_stt" as const, label: "讯飞 RTASR（支持角色分离）" },
      { value: "browser_speech" as const, label: "浏览器听写（不支持多人声纹）" },
    ];
  }
  if (source === "system_audio_browser_experimental") {
    return [{ value: "browser_display_validation" as const, label: "试共享声音" }];
  }
  const options = [
    { value: "api_stt" as const, label: "讯飞 RTASR（支持角色分离）" },
    {
      value: "local_helper" as const,
      label: "本机处理（不支持多人声纹）",
      disabled: helperCapabilities?.capability_status !== "supported",
    },
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

function capabilityStatusLabel(status: string) {
  if (status === "supported") return "可用";
  if (status === "limited") return "受限";
  if (status === "unsupported") return "不可用";
  return status;
}

function shouldShowCapabilityStatus(source: InputSource) {
  return source !== "demo_mode" && source !== "transcript";
}

const STAGE_TABS: ReadonlyArray<readonly [string, string]> = [
  ["mermaid", "主图"],
  ["structure", "结构视图"],
  ["events", "更新记录"],
  ["metrics", "评测指标"],
  ["pipeline", "运行摘要"],
] as const;

export function RealtimeStudio() {
  const queryClient = useQueryClient();
  const [studioState, studioSend] = useMachine(realtimeStudioMachine);
  const [title, setTitle] = useState("研究演示会话");
  const [titleDraft, setTitleDraft] = useState("研究演示会话");
  const [isTitleEditing, setIsTitleEditing] = useState(false);
  const [datasetVersion, setDatasetVersion] = useState("");
  const [selectedTranscriptPresetId, setSelectedTranscriptPresetId] = useState(
    () => TRANSCRIPT_PRESETS[0]?.id ?? "",
  );
  const [transcriptText, setTranscriptText] = useState("");
  const [transcriptSidebarTab, setTranscriptSidebarTab] = useState("panel-input");
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
  /** @description 工作台两页：第 1 页（输入来源 + 主图），第 2 页（会话与录音设置 + 默认设置） */
  const [studioPage] = useState<1 | 2>(1);
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
  const apiCaptureContextRef = useRef<{
    sessionId: string;
    source: InputSource;
    captureMode: CaptureMode;
    speaker: string;
  } | null>(null);
  const apiCaptureStopRequestedRef = useRef(false);
  const inputSourceMenuRef = useRef<HTMLDivElement | null>(null);
  const historyFeedKeysRef = useRef<string[]>([]);

  const demoTranscriptSeed = useMemo(() => {
    const presetId = selectedTranscriptPresetId || DEFAULT_DEMO_PRESET_ID;
    const preset = CURATED_DEMO_PRESETS.find((item) => item.id === presetId) || CURATED_DEMO_PRESETS[0];
    return preset;
  }, [selectedTranscriptPresetId]);

  const switchDemoPreset = (presetId: string) => {
    const preset = CURATED_DEMO_PRESETS.find((item) => item.id === presetId) || CURATED_DEMO_PRESETS[0];
    setSelectedTranscriptPresetId(presetId);
    setTranscriptText(preset.value);
    setTitle(preset.label);
    setTitleDraft(preset.label);
  };

  const selectedInputSource = studioState.context.selectedInputSource;
  const isTextOnlySource = selectedInputSource === "demo_mode" || selectedInputSource === "transcript";
  const selectedRecognitionBackend = studioState.context.recognitionBackend;
  const activeCaptureSource = studioState.context.captureStatus !== "idle" ? selectedInputSource : null;
  const inputLevel = studioState.context.inputLevel;
  const liveTranscript = studioState.context.liveTranscript;
  const captureStatus = studioState.context.captureStatus;
  const sttStatus = studioState.context.sttStatus;
  const gateStatus = studioState.context.gateStatus;

  useEffect(() => {
    if (selectedInputSource !== "demo_mode" || selectedTranscriptPresetId) return;
    const preset = CURATED_DEMO_PRESETS[0];
    setSelectedTranscriptPresetId(preset.id);
    setTranscriptText((current) => (current.trim() ? current : preset.value));
    setTitle((current) => (current === "研究演示会话" ? preset.label : current));
    setTitleDraft((current) => (current === "研究演示会话" ? preset.label : current));
  }, [selectedInputSource, selectedTranscriptPresetId]);
  const plannerStatus = studioState.context.plannerStatus;
  const mermaidStatus = studioState.context.mermaidStatus;
  const machineError = studioState.context.error;
  const lastMermaidUpdatedAt = studioState.context.lastMermaidUpdatedAt;
  const activeStageTabIndex = Math.max(
    0,
    STAGE_TABS.findIndex(([value]) => value === stageTab),
  );

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
  const currentSessionClosed =
    currentSession?.status === "closed" || closedSessionMeta?.sessionId === currentSessionId;

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
    if (selectedInputSource !== "demo_mode") return;
    const preset =
      TRANSCRIPT_PRESETS.find((item) => item.id === selectedTranscriptPresetId) ?? TRANSCRIPT_PRESETS[0];
    if (!preset) return;
    setTranscriptText(preset.value);
    studioSend({ type: "transcript.preview", text: preset.value });
  }, [selectedInputSource, selectedTranscriptPresetId, studioSend]);

  useEffect(() => {
    if (selectedInputSource !== "transcript") return;
    setTranscriptText("");
    studioSend({ type: "transcript.preview", text: "" });
  }, [selectedInputSource, studioSend]);

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
      studioSend({ type: "gate.error", message: "当前还没有 Gate 状态。" });
    } else if (gateState.error_message) {
      studioSend({ type: "gate.error", message: String(gateState.error_message) });
    } else {
      studioSend({ type: "gate.success" });
    }

    const plannerState = pipeline?.planner_state ?? null;
    if (!plannerState) {
      studioSend({ type: "planner.error", message: "当前还没有 Planner 状态。" });
    } else if (plannerState.error_message) {
      studioSend({ type: "planner.error", message: String(plannerState.error_message) });
    } else {
      studioSend({ type: "planner.success" });
    }

    const mermaidState = pipeline?.mermaid_state ?? null;
    const updatedAt = mermaidState?.updated_at ? toLocalDateTimeLabel(String(mermaidState.updated_at)) : null;
    if (!mermaidState) {
      studioSend({ type: "mermaid.error", message: "当前还没有 Mermaid 结果。", updatedAt });
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
      const action = pushAudioSegmentFrame(helperSegmentStateRef.current, merged, level, HELPER_TARGET_SAMPLE_RATE);
      if (action === "soft_flush") {
        void flushHelperAudioBuffer(false);
      } else if (action === "final_flush") {
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
    apiCaptureSegmentStateRef.current = createAudioSegmentState();
    apiCaptureChunkIdRef.current = 0;
  }

  async function uploadApiAudioFrame(samples: Float32Array, isFinal = true) {
    const context = apiCaptureContextRef.current;
    if (!context || !samples.length) return;

    studioSend({ type: "capture.uploading" });
    studioSend({ type: "stt.working" });

    const chunkId = apiCaptureChunkIdRef.current;
    apiCaptureChunkIdRef.current += 1;

    try {
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
                  return {
                    speaker: String(segment?.speaker || response.speaker || context.speaker || "speaker"),
                    text,
                    start_ms: Number(segment?.start_ms ?? 0) || 0,
                    end_ms: Number(segment?.end_ms ?? segment?.start_ms ?? 0) || 0,
                    is_final: true,
                    source: context.source,
                    capture_mode: context.captureMode,
                  } as RealtimeTranscriptTurn | null;
                })
                .filter((row): row is RealtimeTranscriptTurn => Boolean(row))
            : [];
        if (segmentTurns.length) {
          pushLocalCommittedTurns(segmentTurns.reverse());
        } else if (response.text.trim()) {
          pushLocalCommittedTurns([
            {
              speaker: response.speaker || context.speaker || "speaker",
              text: response.text.trim(),
              start_ms: 0,
              end_ms: 0,
              is_final: true,
              source: context.source,
              capture_mode: context.captureMode,
            },
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
      if (response.voiceprint?.mode === "feature_split") {
        setNotice({
          tone: "success",
          text: "RTASR 声纹分离中：角色已优先映射到已注册说话人。",
        });
      } else if (response.voiceprint?.mode === "blind_split") {
        setNotice({
          tone: "info",
          text: "RTASR 角色分离中：当前为盲分模式，未命中已注册声纹。",
        });
      } else if (response.voiceprint?.matched) {
        setNotice({
          tone: "success",
          text: `声纹盲认命中：本段音频归属于 ${response.speaker}。`,
        });
      } else if (response.voiceprint?.error_message) {
        setNotice({
          tone: "warning",
          text: `声纹盲认未生效：${response.voiceprint.error_message}`,
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
      const message = err instanceof Error ? err.message : "API STT 上传失败。";
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

  async function flushApiCaptureBuffer(isFinal = true) {
    const state = apiCaptureSegmentStateRef.current;
    if (!state.activeSampleCount) return;
    const merged = mergeSegmentFrames(state.activeFrames, state.activeSampleCount);
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
    apiCaptureStopRequestedRef.current = false;
    apiCaptureContextRef.current = payload;
    resetApiCaptureBuffers();
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
      const action = pushAudioSegmentFrame(apiCaptureSegmentStateRef.current, merged, level, HELPER_TARGET_SAMPLE_RATE);
      if (action === "soft_flush") {
        void flushApiCaptureBuffer(false);
      } else if (action === "final_flush") {
        void flushApiCaptureBuffer(true);
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
    if (source !== "microphone_browser" && source !== "system_audio_helper") {
      setError("当前输入源不支持 API STT 采集。");
      return;
    }

    if (selectedRecognitionBackend !== "api_stt") {
      setError("当前识别后端不支持 API STT 采集。");
      return;
    }

    if (currentSessionClosed) {
      setNotice({ tone: "warning", text: "当前会话已结束，请重建会话后继续采集。" });
      return;
    }

    const sessionId = await ensureSession();

    let stream: MediaStream;
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
    mutationFn: async () => {
      // Auto-detect diagram type for manual sessions with existing text input
      let detectedDiagramType = "flowchart";
      if (selectedInputSource !== "demo_mode" && transcriptText.trim()) {
        try {
          const detected = await api.detectDiagramType(transcriptText.trim());
          detectedDiagramType = detected.diagram_type;
        } catch {
          // Fallback to flowchart; Planner will correct on first update
        }
      }
      return api.createRealtimeSession({
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
        diagram_type:
          selectedInputSource === "demo_mode"
            ? mapDiagramHintToMermaidType(demoTranscriptSeed?.diagramType)
            : detectedDiagramType,
        client_context: currentClientContext(),
      });
    },
    onSuccess: (data) => {
      setCurrentSessionId(data.session_id);
      setClosedSessionMeta(null);
      setSnapshot(null);
      setLocalCommittedTranscriptTurns([]);
      historyFeedKeysRef.current = [];
      window.localStorage.setItem(LOCAL_SESSION_KEY, data.session_id);
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
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
    if (currentSessionId) {
      snapshotMutation.mutate(currentSessionId);
    }
    // `useMutation()` returns a new object identity per render; only auto-snapshot when session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

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
      throw new Error("当前会话已结束，请点击“重建会话”后继续。");
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
        {
          speaker: source === "system_audio_helper" ? "system_audio" : "speaker",
          text: text.trim(),
          start_ms: 0,
          end_ms: 0,
          is_final: true,
          source,
          capture_mode: captureMode,
        },
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
  }

  const sendTranscript = useMutation({
    onMutate: () => {
      studioSend({ type: "gate.working" });
      studioSend({ type: "planner.working" });
    },
    mutationFn: async () => {
      const sessionId = await ensureSession();
      const rows = parseTranscriptInput(transcriptText);
      const manualSource: InputSource =
        selectedInputSource === "demo_mode" ? "demo_mode" : "transcript";
      logBrowserRuntime("transcript send started", {
        session_id: sessionId,
        row_count: rows.length,
        rows,
        input_source: manualSource,
      });
      return api.addRealtimeChunksBatch(sessionId, {
        chunks: rows.map((row, index) => ({
          timestamp_ms: index * 450,
          text: row.text,
          speaker: row.speaker,
          expected_intent: row.expected_intent || null,
          metadata: buildChunkMetadata(manualSource, "manual_text"),
        })),
      });
    },
    onSuccess: (data) => {
      const rows = parseTranscriptInput(transcriptText);
      const manualSource: InputSource =
        selectedInputSource === "demo_mode" ? "demo_mode" : "transcript";
      pushLocalCommittedTurns(
        rows
          .map((row, index) => ({
            speaker: row.speaker,
            text: row.text.trim(),
            start_ms: index * 450,
            end_ms: index * 450,
            is_final: true,
            source: manualSource,
            capture_mode: "manual_text",
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
      setNotice({ tone: "success", text: "Transcript 已写入当前会话。" });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
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
      setNotice({ tone: "success", text: "已按节点拖动结果重组 Mermaid 关系。" });
      queryClient.invalidateQueries({ queryKey: ["realtime-sessions"] });
    },
    onError: (err) => {
      logBrowserRuntime("diagram relayout failed", { error: (err as Error).message }, "error");
      setError((err as Error).message);
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
      setNotice({ tone: "success", text: "会话已结束，转写文本可直接下载。" });
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
        setTitle("研究演示会话");
        setTitleDraft("研究演示会话");
      }
      setNotice({ tone: "success", text: "已删除该会话。" });
      setDeleteSessionConfirmId(null);
    } catch {
      /* deleteSessionMutation onError */
    }
  };

  const saveReportMutation = useMutation({
    mutationFn: (sessionId: string) => api.saveRealtimeReport(sessionId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      setNotice({ tone: "success", text: `已生成会话报告 ${data.report_id}。` });
    },
    onError: (err) => setError((err as Error).message),
  });

  const updateSttVoiceprintMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const admin = await api.getAdminRuntimeOptions();
      if (!admin.stt_profiles.some((p) => p.id === sttProfileId)) {
        throw new Error("未找到当前 STT Profile。");
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
        text: enabled ? "已开启声纹盲认增强（当前 STT Profile）。" : "已关闭声纹盲认增强。",
      });
    },
    onError: (err) => {
      setNotice({
        tone: "warning",
        text: err instanceof Error ? err.message : "保存声纹设置失败",
      });
    },
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
          studioSend({ type: "gate.working" });
          studioSend({ type: "planner.working" });
          const data = await api.addRealtimeChunk(sessionId, {
            text,
            speaker: "speaker",
            is_final: true,
            metadata: buildChunkMetadata("microphone_browser", "browser_speech"),
          });
          pushLocalCommittedTurns([
            {
              speaker: "speaker",
              text,
              start_ms: 0,
              end_ms: 0,
              is_final: true,
              source: "microphone_browser",
              capture_mode: "browser_speech",
            },
          ]);
          setSnapshot({ session_id: data.session_id, pipeline: data.pipeline, evaluation: data.evaluation });
          studioSend({ type: "stt.success", text });
          syncPipelineStatus(data.pipeline);
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

  const activeSnapshot = snapshot?.session_id === currentSessionId ? snapshot : null;
  const rendererState = activeSnapshot?.pipeline?.renderer_state || {};
  const events = useMemo<Array<Record<string, any>>>(() => {
    return Array.isArray(activeSnapshot?.pipeline?.events) ? activeSnapshot.pipeline.events : [];
  }, [activeSnapshot?.pipeline?.events]);
  const mermaidState = activeSnapshot?.pipeline?.mermaid_state ?? null;
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
  const currentSubtitleText = useMemo(() => {
    const live = liveTranscript.trim();
    if (live) return live;
    return activeTranscriptTurn?.text?.trim() || transcriptState.latestFinalTurn?.text?.trim() || "等待识别结果...";
  }, [activeTranscriptTurn, liveTranscript, transcriptState.latestFinalTurn]);

  function downloadCurrentGraph() {
    if (!currentSessionId) {
      setError("当前没有可下载的图表。");
      return;
    }
    try {
      const fileName = `${sanitizeDownloadFileName(titleDisplay || currentSessionId)}_graph.svg`;
      downloadCurrentMermaidSvg(mermaidExportRootId, fileName);
      setNotice({ tone: "success", text: "图表 SVG 已开始下载。" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "当前没有可下载的图表。");
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
      { label: "端到端延迟", value: metrics.e2e_latency_p95_ms ?? "-" },
      { label: "意图准确率", value: metrics.intent_accuracy ?? "-" },
      { label: "画面抖动", value: metrics.flicker_mean ?? "-" },
      { label: "结构好懂度", value: metrics.mental_map_mean ?? "-" },
    ];
  }, [snapshot?.evaluation?.metrics]);

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
        abbr: "GATE",
        label: "Gate",
        value: backendStatusLabel(gateStatus),
        tone: gateTone,
        help: selectedGateProfile ? `${selectedGateProfile.label} / ${gateModel || "未选择模型"}` : "尚未配置 Gate 模型。",
      },
      {
        abbr: "PLAN",
        label: "Planner",
        value: backendStatusLabel(plannerStatus),
        tone: plannerTone,
        help: selectedPlannerProfile
          ? `${selectedPlannerProfile.label} / ${plannerModel || "未选择模型"}`
          : "尚未配置 Planner 模型。",
      },
      {
        abbr: "MER",
        label: "出图",
        value: lastMermaidUpdatedAt ? "已更新" : "等待中",
        tone: merTone,
        help: lastMermaidUpdatedAt || "还没有生成流程图。",
      },
      {
        abbr: "MODEL",
        label: "模型",
        value:
          modelStatus === "working"
            ? "加载中"
            : modelStatus === "error"
              ? "失败"
              : modelStatus === "success"
                ? "已返回"
                : "空闲",
        tone: backendStatusTone(modelStatus),
        help: modelStatus === "working" ? "当前正在等待远端模型返回结果。" : "显示当前 Gate / Planner 的整体推理状态。",
      },
    ];
  }, [
    captureStatus,
    sttStatus,
    gateStatus,
    plannerStatus,
    mermaidStatus,
    lastMermaidUpdatedAt,
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
      setNotice({ tone: "warning", text: "当前会话已结束，请重建会话后继续采集。" });
      return;
    }
    if (selectedInputSource === "transcript" || selectedInputSource === "demo_mode") return;
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
    if (selectedInputSource === "transcript" || selectedInputSource === "demo_mode") return;
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

  const canStartStageCapture = !isTextOnlySource && canStartCapture;
  const canStopStageCapture = !isTextOnlySource && canStopCapture;
  const startRecordingPrimaryStyle = canStartStageCapture;
  const titleDisplay = title.trim() || "未命名会话";

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
        setNotice({ tone: "success", text: "会话名称已保存，历史列表将同步更新。" });
      } catch {
        /* setError 已由 mutation.onError 处理 */
      }
      return;
    }
    setTitle(nextTitle);
    setIsTitleEditing(false);
    setNotice({
      tone: "success",
      text: "会话名称已保存，创建会话时会使用该名称。",
    });
  }

  function cancelTitleEdit() {
    setTitleDraft(titleDisplay);
    setIsTitleEditing(false);
  }

  if (authQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4 text-sm text-theme-4">
        正在加载工作台…
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
            重试
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

      <div className="flex h-full flex-col overflow-hidden space-y-4">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 pl-3 md:gap-3 md:pl-6 lg:pl-8">
            <h1 className="page-title">实时工作台</h1>
            {isUnauthorizedGuest ? (
              <Badge className="border-amber-800/50 bg-amber-950/35 text-[10px] font-medium normal-case tracking-normal text-amber-100 theme-light:border-amber-200/60 theme-light:bg-amber-50 theme-light:text-amber-900">
                访客体验 · 平台设置与声纹持久化需登录
              </Badge>
            ) : null}
            <p className="hidden max-w-md text-[11px] leading-snug text-theme-4 md:block">
              开麦或发送 Transcript 后，主图与结构视图会更新。
            </p>
          </div>
          <div className="ml-auto flex min-w-0 items-center justify-end gap-2 pr-12 sm:pr-14">
            <div className="group relative">
              <Badge
                className="cursor-default border-theme-default bg-surface-2 px-2.5 py-1 text-xs font-medium normal-case tracking-normal text-theme-2"
                title="运行状态"
              >
                运行状态
              </Badge>
              <div className="pointer-events-none invisible absolute right-0 top-[calc(100%+8px)] z-[120] w-[min(460px,82vw)] rounded-xl border border-theme-subtle bg-surface-1 p-3 opacity-0 shadow-xl transition duration-200 group-hover:visible group-hover:pointer-events-auto group-hover:opacity-100">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-theme-4">状态速览</div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    className="text-[10px] font-normal normal-case tracking-normal text-theme-2"
                    title={currentSessionId || undefined}
                  >
                    <span className="block max-w-[180px] min-w-0 truncate">
                      {currentSessionId ? `Session ${currentSessionId}` : "未创建会话"}
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
                      ? "模型：失败"
                      : gateStatus === "working" || plannerStatus === "working"
                        ? "模型：加载中"
                        : gateStatus === "success" || plannerStatus === "success"
                          ? "模型：已返回"
                          : "模型：空闲"}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    来源：{getSourceBadgeLabel(activeCaptureSource)}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    转写：{backendLabel(selectedRecognitionBackend)}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    出图：
                    {typeof mermaidState?.compile_ok === "boolean"
                      ? mermaidState.compile_ok
                        ? "编译通过"
                        : "编译失败"
                      : "等待中"}
                  </Badge>
                  {snapshot?.evaluation?.realtime_eval_pass === true ? (
                    <Badge className="border-emerald-900/55 bg-emerald-950/40 text-[10px] font-normal normal-case tracking-normal text-emerald-200">
                      评测通过
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden pb-0 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,3fr)_minmax(0,7fr)] xl:grid-rows-[auto_1fr] xl:items-stretch xl:min-h-0">
        {studioPage === 1 ? (
          <Card className="soft-enter relative order-1 flex min-h-0 min-w-0 flex-col space-y-3 text-[13px] leading-snug xl:col-start-1 xl:row-start-2 xl:order-none">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[3px] bg-gradient-to-r from-[color:var(--accent)]/0 via-[color:var(--accent)]/45 to-[color:var(--accent)]/0"
            aria-hidden
          />
          <div className={`relative shrink-0 space-y-2 ${inputSourceMenuOpen ? "z-[100]" : "z-[2]"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm font-semibold text-theme-1">输入来源</label>
              <Badge className="shrink-0 text-[10px]">{audioContext ? `${audioContext.platform} / ${getBrowserFamilyLabel(audioContext)}` : "检测中"}</Badge>
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
                  {selectedOption.label}
                  {shouldShowCapabilityStatus(selectedOption.source)
                    ? ` · ${capabilityStatusLabel(selectedOption.capability_status)}`
                    : ""}
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-theme-4 transition-transform duration-200 ${inputSourceMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              {inputSourceMenuOpen ? (
                <div className="absolute z-10 mt-2 w-full rounded-lg border border-theme-subtle bg-surface-1 p-1.5 shadow-xl">
                  <div className="space-y-0.5" role="listbox" aria-label="输入来源">
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
                            const opts = buildBackendOptions(option.source, helperCapabilities);
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
                          {shouldShowCapabilityStatus(option.source) ? (
                            <span className="ml-2 shrink-0 text-xs text-theme-4">
                              {capabilityStatusLabel(option.capability_status)}
                            </span>
                          ) : null}
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
            {/* 声纹盲认仅与语音/STT 相关；演示和文本模式不展示 */}
            {!isTextOnlySource ? (
              <div className="flex min-h-[2rem] items-center justify-between gap-2 rounded-lg border border-theme-subtle bg-surface-muted px-2 py-1">
                {!isAdmin ? (
                  <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-theme-3">
                    声纹盲认与服务端 Profile 微调需{" "}
                    <Link href="/login" className="link-accent">
                      管理员登录
                    </Link>
                    后在平台设置中配置。
                  </p>
                ) : !hasSttProfiles ? (
                  <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-theme-3">
                    声纹盲认需先配置 STT，{" "}
                    <Link href="/app/settings" className="link-accent">
                      平台设置
                    </Link>
                  </p>
                ) : !selectedSttProfile ? (
                  <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-theme-3">
                    声纹盲认：STT 未同步，请刷新或{" "}
                    <Link href="/app/settings" className="link-accent">
                      设置
                    </Link>
                  </p>
                ) : (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-theme-2">
                      <Fingerprint className="h-3.5 w-3.5 shrink-0 text-theme-4" strokeWidth={2} aria-hidden />
                      <span className="truncate" title={`${selectedSttProfile.label} · 讯飞声纹 1:N 盲认`}>
                        声纹盲认 · {selectedSttProfile.label}
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
                          adminRuntimeOptions.isError ? "当前账号无法保存，请到平台设置修改" : undefined
                        }
                        onChange={(event: ChangeEvent<HTMLInputElement>) => {
                          if (adminRuntimeOptions.isError) return;
                          updateSttVoiceprintMutation.mutate(event.target.checked);
                        }}
                      />
                      {updateSttVoiceprintMutation.isPending ? "…" : "启用"}
                    </label>
                  </>
                )}
              </div>
            ) : null}
            {selectedInputSource !== "demo_mode" ? (
              !audioContext?.is_desktop ? (
                <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-2 text-[11px] leading-relaxed text-theme-4">
                  移动端不提供系统声音相关采集入口。
                </div>
              ) : !systemAudioExperimentalVisible ? (
                <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-2 text-[11px] leading-relaxed text-theme-4">
                  实验性「共享屏幕音频」仅 Chrome/Edge；可用「增强模式」+ 本机 audio helper。
                </div>
              ) : null
            ) : null}
          </div>

          {/* 纯文本输入：简单文本框 + 预设选择器 */}
          {(selectedInputSource === "demo_mode" || selectedInputSource === "transcript") && (
            <div className="relative z-[2] flex min-h-0 flex-1 flex-col space-y-3">
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                {selectedInputSource === "demo_mode" && (
                  <label className="text-[12px] font-medium text-theme-2">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.1em] text-theme-4">演示类型</span>
                    <select
                      className="flex h-9 w-full items-center justify-between rounded-md border border-theme-default bg-surface-2 px-3 text-sm text-theme-1 outline-none transition hover:border-theme-strong focus-visible:ring-2 focus-visible:ring-theme-focus"
                      value={selectedTranscriptPresetId || DEFAULT_DEMO_PRESET_ID}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        switchDemoPreset(event.target.value);
                      }}
                    >
                      {CURATED_DEMO_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selectedInputSource === "transcript" && (
                  <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-theme-4">文本输入</div>
                )}
                <Textarea
                  className="min-h-[10rem] flex-1 resize-y text-[12px] leading-relaxed"
                  rows={10}
                  value={transcriptText}
                  disabled={currentSessionClosed}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                    const next = event.target.value;
                    setTranscriptText(next);
                    studioSend({ type: "transcript.preview", text: next });
                  }}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0 border-violet-900/50 bg-violet-950/45 py-2 text-xs text-violet-100 shadow-sm hover:border-violet-700/60 hover:bg-violet-950/65 hover:text-violet-50 focus-visible:ring-2 focus-visible:ring-violet-700"
                onClick={() => {
                  sendTranscript.mutate();
                }}
                disabled={
                  sendTranscript.isPending ||
                  !transcriptText.trim() ||
                  currentSessionClosed
                }
              >
                <Send className="h-3.5 w-3.5" />
                {currentSessionClosed
                  ? "会话已结束"
                  : selectedInputSource === "demo_mode"
                    ? "生成演示图表"
                    : "发送文本"}
              </Button>
              <p className="text-[10px] leading-snug text-theme-4">
                {selectedInputSource === "demo_mode"
                  ? "切换演示类型后点击生成即可。"
                  : "按「说话人|内容|意图」格式输入，纯文本则视为单一发言者。"}
              </p>
            </div>
          )}

          {/* 语音输入：实时转写 UI */}
          {selectedInputSource !== "demo_mode" && selectedInputSource !== "transcript" && (
          <div
            className={`relative z-[2] flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border px-2.5 py-2 transition-[border-color,box-shadow,background] ${
              activeCaptureSource
                ? "border-[color:var(--accent)]/55 bg-surface-muted ring-1 ring-[color:var(--accent)]/20"
                : "border-theme-subtle bg-gradient-to-b from-[color:var(--accent)]/[0.06] to-surface-muted"
            }`}
          >
            <Tabs.Root
              value={transcriptSidebarTab}
              onValueChange={setTranscriptSidebarTab}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-3 gap-y-2 border-b border-theme-subtle">
                <Tabs.List className="flex min-w-0 gap-1 sm:gap-5" aria-label="实时转写">
                  <Tabs.Trigger
                    value="panel-input"
                    className="-mb-px border-b-2 border-transparent px-0.5 py-2 text-left text-sm font-semibold text-theme-3 outline-none transition-colors data-[state=active]:border-[color:var(--accent)] data-[state=active]:text-theme-1 data-[state=inactive]:hover:text-theme-2 focus-visible:ring-2 focus-visible:ring-theme-focus focus-visible:ring-offset-2"
                  >
                    当前字幕
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="panel-history"
                    className="-mb-px border-b-2 border-transparent px-0.5 py-2 text-left text-sm font-semibold text-theme-3 outline-none transition-colors data-[state=active]:border-[color:var(--accent)] data-[state=active]:text-theme-1 data-[state=inactive]:hover:text-theme-2 focus-visible:ring-2 focus-visible:ring-theme-focus focus-visible:ring-offset-2"
                  >
                    历史转写
                  </Tabs.Trigger>
                </Tabs.List>
                <div className="flex flex-wrap items-center justify-end gap-1.5 pb-2">
                  {currentSessionClosed ? <Badge className="text-[9px]">已结束</Badge> : null}
                  <Badge className="text-[9px]">{backendLabel(selectedRecognitionBackend)}</Badge>
                </div>
              </div>
              <div className="mt-1.5 flex shrink-0 flex-wrap gap-1.5">
                <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                  轮次：{transcriptState.turnCount}
                </Badge>
                <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                  说话人：{transcriptState.speakerCount}
                </Badge>
                <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                  Chunk：{transcriptState.chunkCount}
                </Badge>
              </div>

              <Tabs.Content
                value="panel-input"
                className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden outline-none data-[state=inactive]:hidden"
              >
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[color:var(--accent)]/25 bg-[color:var(--accent)]/[0.05] px-3 py-3">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent-strong)]/90">
                    当前字幕
                  </div>
                  <div className="max-h-[min(12rem,38vh)] min-h-[4.5rem] flex-1 overflow-y-auto whitespace-pre-wrap text-[15px] leading-7 text-theme-1 sm:max-h-[min(18rem,42vh)] sm:min-h-[6.5rem] sm:text-[16px] md:max-h-none md:min-h-0 md:overflow-visible md:min-h-[7.5rem]">
                    {currentSubtitleText}
                  </div>
                  <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-[color:var(--accent)]/15 pt-2 text-[10px] text-theme-4">
                    <span>
                      {liveTranscript.trim()
                        ? "优先显示本地实时预览"
                        : currentSessionClosed
                          ? "当前会话已结束，可切换到「历史转写」查看"
                          : "开麦后此处显示当前一句；多条轮次在「历史转写」"}
                    </span>
                    {activeTranscriptTurn?.speaker ? (
                      <span className="truncate">发言：{activeTranscriptTurn.speaker}</span>
                    ) : null}
                  </div>
                </div>
              </Tabs.Content>

              <Tabs.Content
                value="panel-history"
                className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden outline-none data-[state=inactive]:hidden"
              >
                <div className="flex min-h-[9rem] flex-1 flex-col overflow-hidden rounded-xl border border-theme-subtle bg-surface-muted/88">
                  <div className="flex shrink-0 justify-end border-b border-theme-subtle px-3 py-1.5">
                    <div className="text-[10px] text-theme-4">
                      {archivedTranscriptTurns.length ? `${archivedTranscriptTurns.length} / 10` : "等待归档"}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
                    {archivedTranscriptTurns.length ? (
                      <div className="space-y-2.5">
                        {archivedTranscriptTurns.map((turn, index) => (
                          <div
                            key={turn.key || `${turn.speaker}-${turn.start_ms}-${index}`}
                            className="rounded-lg border border-theme-subtle bg-surface-1/70 px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2 text-[10px] text-theme-4">
                              <span className="truncate font-semibold text-theme-2">{turn.speaker || "speaker"}</span>
                              <span className="shrink-0">
                                {formatRelativeTranscriptTime(turn.start_ms)} -{" "}
                                {formatRelativeTranscriptTime(turn.end_ms)}
                              </span>
                            </div>
                            <div className="mt-1 whitespace-pre-wrap text-[12px] leading-6 text-theme-2">{turn.text}</div>
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
                        ))}
                      </div>
                    ) : (
                      <div className="flex h-full min-h-[6rem] items-center justify-center rounded-lg border border-dashed border-[color:var(--accent)]/30 bg-[color:var(--accent)]/[0.04] px-3 py-3 text-center text-[12px] leading-relaxed text-theme-3">
                        {currentSessionClosed
                          ? "当前会话没有可回看的历史转写。"
                          : "稳定轮次会出现在这里；也可在「当前字幕」查看正在识别的一行。"}
                      </div>
                    )}
                  </div>
                </div>
              </Tabs.Content>
            </Tabs.Root>
            <p className="mt-1.5 shrink-0 text-[9px] leading-snug text-theme-4">
              {currentSessionClosed
                ? "会话结束后保留只读字幕和下载入口；如需继续，请重建会话。"
                : "开麦后「当前字幕」为大字预览；稳定轮次归档在「历史转写」。"}
            </p>
            <div
              className={`mt-2 shrink-0 border-t pt-2.5 ${
                activeCaptureSource ? "border-theme-subtle" : "border-dashed border-[color:var(--accent)]/22"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-theme-1">输入音量</div>
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
          )}
        </Card>
        ) : null}

        <div
          className={`order-3 flex min-h-0 min-w-0 flex-1 flex-col xl:row-start-2 xl:min-h-0 ${
            studioPage === 1 ? "xl:col-start-2" : "xl:col-start-1 xl:col-span-2"
          }`}
        >
        {studioPage === 1 ? (
        <ErrorBoundary
          fallbackRender={({ error: boundaryError }: FallbackProps) => (
            <Card className="rounded-[26px] border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              本页异常：{boundaryError.message}
            </Card>
          )}
        >
          <div className="soft-enter soft-enter-delay-1 flex min-h-0 min-w-0 flex-1 flex-col">
            <Tabs.Root value={stageTab} onValueChange={setStageTab} className="flex min-h-0 flex-1 flex-col">
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-default bg-surface-1 p-0 shadow-lg">
              <div
                className="pointer-events-none h-px w-full shrink-0 bg-gradient-to-r from-transparent via-[color:var(--accent)]/30 to-transparent"
                aria-hidden
              />
              <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-4 pb-2 pt-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Tabs.List className="workspace-tab-list w-full max-w-[760px] grid-cols-5 self-start">
              <span
                aria-hidden
                className="workspace-tab-indicator"
                style={{
                  left: "0.25rem",
                  width: "calc((100% - 0.5rem) / 5)",
                  transform: `translateX(calc(${activeStageTabIndex} * 100%))`,
                }}
              />
              {STAGE_TABS.map(([value, label]) => (
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
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
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
                </div>
                <Tooltip.Provider delayDuration={200}>
                  <div className="flex w-full min-w-0 shrink-0 flex-nowrap items-start justify-end gap-4 sm:ml-auto sm:max-w-md sm:gap-6 sm:pr-1">
                    <div className="flex shrink-0 flex-col items-center">
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <span className="inline-flex">
                            <button
                              type="button"
                              onClick={() => void stageStartCapture()}
                              disabled={!canStartStageCapture}
                              className={`inline-flex h-12 w-12 items-center justify-center rounded-xl border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 sm:h-14 sm:w-14 ${
                                startRecordingPrimaryStyle
                                  ? "border-violet-200/90 bg-violet-700/70 text-violet-50 shadow-[0_0_0_1px_rgba(139,92,246,0.32)_inset,0_10px_22px_rgba(109,40,217,0.36)] hover:border-violet-200/95 hover:bg-violet-700/75 focus-visible:ring-violet-200/80"
                                  : "border-violet-900/50 bg-violet-950/45 text-violet-200 focus-visible:ring-violet-700"
                              }`}
                              aria-label="开始录音"
                            >
                              <Mic className="h-6 w-6 sm:h-7 sm:w-7" />
                            </button>
                          </span>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="bottom"
                            align="center"
                            sideOffset={8}
                            collisionPadding={12}
                            className="z-[24000] rounded-lg border border-theme-default bg-surface-2 px-2.5 py-1.5 text-left shadow-xl"
                          >
                            <div className="text-[11px] font-medium text-theme-1">开始录音</div>
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
                              className={`inline-flex h-12 w-12 items-center justify-center rounded-xl border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 sm:h-14 sm:w-14 ${
                                canStopStageCapture
                                  ? "border-red-200/90 bg-red-700/70 text-red-50 shadow-[0_0_0_1px_rgba(239,68,68,0.30)_inset,0_10px_22px_rgba(220,38,38,0.32)] hover:border-red-200/95 hover:bg-red-700/75 focus-visible:ring-red-200/80"
                                  : "border-red-900/50 bg-red-950/40 text-red-200 focus-visible:ring-red-800"
                              }`}
                              aria-label="暂停录音"
                            >
                              <Pause className="h-6 w-6 sm:h-7 sm:w-7" />
                            </button>
                          </span>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="bottom"
                            align="center"
                            sideOffset={8}
                            collisionPadding={12}
                            className="z-[24000] rounded-lg border border-theme-default bg-surface-2 px-2.5 py-1.5 text-left shadow-xl"
                          >
                            <div className="text-[11px] font-medium text-theme-1">暂停录音</div>
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    </div>

                    <div className="flex shrink-0 flex-col items-center">
                      <Button
                        type="button"
                        variant="secondary"
                        className="inline-flex h-12 shrink-0 gap-2 rounded-xl px-3 text-xs shadow-sm sm:h-14 sm:px-3.5 sm:text-sm"
                        onClick={() => setDetailDrawerOpen(true)}
                      >
                        <PanelRight className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                        历史会话
                      </Button>
                    </div>
                  </div>
                </Tooltip.Provider>
              </div>

            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Tabs.Content value="mermaid" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-3 pt-1 sm:px-3">
                <MermaidCard
                  title=""
                  embedded
                  code={mermaidState?.code || mermaidState?.normalized_code || ""}
                  rawOutputText={typeof mermaidState?.raw_output_text === "string" ? mermaidState.raw_output_text : null}
                  repairRawOutputText={
                    typeof mermaidState?.repair_raw_output_text === "string" ? mermaidState.repair_raw_output_text : null
                  }
                  provider={mermaidState?.provider || selectedPlannerProfile?.label || null}
                  model={mermaidState?.model || plannerModel || null}
                  latencyMs={typeof mermaidState?.latency_ms === "number" ? mermaidState.latency_ms : null}
                  compileOk={typeof mermaidState?.compile_ok === "boolean" ? mermaidState.compile_ok : null}
                  updatedAt={lastMermaidUpdatedAt || toLocalDateTimeLabel(mermaidState?.updated_at ? String(mermaidState.updated_at) : null)}
                  graphPayload={currentGraphPayload}
                  onNodeRelayout={handleMermaidNodeRelayout}
                  relayoutBusy={relayoutMutation.isPending}
                  exportRootId={mermaidExportRootId}
                />
              </div>
            </Tabs.Content>

            <Tabs.Content value="structure" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <div className="flex min-h-0 flex-1 px-4 py-2">
                <Card className="flex-1 min-h-0 rounded-xl border border-theme-default bg-surface-muted p-2">
                  <div className="flex-1 min-h-0 overflow-hidden rounded-lg">
                    <GraphStage
                      embedded
                      title="结构图"
                      nodes={rendererState.nodes || []}
                      edges={rendererState.edges || []}
                      groups={rendererGroups}
                    />
                  </div>
                </Card>
              </div>
            </Tabs.Content>

            <Tabs.Content value="events" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-theme-1">更新记录</div>
                    <p className="mt-1 text-xs leading-6 text-theme-2">只看最近几条，方便判断图有没有按预期变化。</p>
                  </div>
                  <Badge>{events.length} updates</Badge>
                </div>
                <div className="flex-1 min-h-0 space-y-3 overflow-auto pr-2">
                  {events.length ? (
                    events.slice(-12).map((event: Record<string, any>, index: number) => (
                      <div
                        key={`${event.update?.update_id}-${index}`}
                        className="glass-panel p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-theme-1">
                            Update #{event.update?.update_id} · {event.gate?.action || event.update?.intent_type}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{event.e2e_latency_ms} ms</Badge>
                            <Badge>{(event.planner?.delta_ops || []).length} delta ops</Badge>
                          </div>
                        </div>
                        <div className="mt-2 text-xs leading-6 text-theme-2">
                          {Array.isArray(event.pending_turns) && event.pending_turns.length
                            ? event.pending_turns
                                .map((turn: Record<string, any>) => `${turn.speaker || "speaker"}: ${turn.content || ""}`)
                                .join("\n")
                            : event.update?.transcript_text}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-theme-2">
                          <span>Gate: {event.gate?.reason || "-"}</span>
                          <span>Planner: {event.planner?.notes || "-"}</span>
                          <span>
                            Graph: {event.graph_after?.node_count ?? 0} nodes / {event.graph_after?.edge_count ?? 0} edges
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[22px] border border-dashed border-theme-default p-5 text-sm text-theme-2">
                      还没有增量事件。创建会话后发送 transcript、启动浏览器麦克风，或接入增强模式。
                    </div>
                  )}
                </div>
              </Card>
            </Tabs.Content>

            <Tabs.Content value="metrics" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-2">
                <div className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {summaryCards.map((item) => (
                      <StatCard key={item.label} label={item.label} value={String(item.value)} />
                    ))}
                  </div>
                  <Card>
                    <div className="mb-4 text-sm font-semibold text-theme-1">效果数据</div>
                    <pre className="rounded-[24px] bg-surface-1 p-5 text-xs leading-6 text-theme-1">
                      {JSON.stringify(snapshot?.evaluation || {}, null, 2)}
                    </pre>
                  </Card>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="pipeline" className="absolute inset-0 flex min-h-0 flex-col outline-none">
              <div className="flex min-h-0 flex-1 flex-col">
                <Card className="flex-1 min-h-0 overflow-hidden">
                  <div className="mb-4 text-sm font-semibold text-theme-1 px-5 pt-5">处理步骤摘要</div>
                  <pre className="max-h-full overflow-auto rounded-[24px] bg-surface-1 p-5 text-xs leading-6 text-theme-1">
                    {JSON.stringify(snapshot?.pipeline?.summary || {}, null, 2)}
                  </pre>
                </Card>
              </div>
            </Tabs.Content>
            </div>
            <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 px-4 py-2.5">
              <div className="flex w-full max-w-[min(100%,30rem)] flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={currentSessionId ? "secondary" : "primary"}
                  className={
                    currentSessionId
                      ? "h-8 shrink-0 gap-1 px-3 text-xs font-semibold"
                      : "s2g-cta-create-session h-8 shrink-0 gap-1 px-3 text-xs font-semibold shadow-none"
                  }
                  onClick={() => createSession.mutate()}
                  disabled={createSession.isPending}
                >
                  <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{currentSessionId ? "重建会话" : "创建会话"}</span>
                </Button>
                {isTitleEditing ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Input
                      value={titleDraft}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setTitleDraft(event.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-theme-default bg-surface-2 text-sm text-theme-1"
                      placeholder="输入会话名称"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 shrink-0 gap-1 px-2 text-xs font-semibold"
                      onClick={() => void commitTitleEdit()}
                      disabled={!titleDraft.trim() || renameSessionMutation.isPending || currentSessionClosed}
                    >
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      保存
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 shrink-0 px-2 text-xs font-semibold"
                      onClick={cancelTitleEdit}
                    >
                      取消
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
                        重命名
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
                      下载 TXT
                    </a>
                    <a
                      href={transcriptDownloads.markdown_url}
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-theme-default bg-surface-2 px-3 font-semibold text-theme-2 transition hover:border-theme-strong hover:bg-surface-3"
                    >
                      下载 Markdown
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="grid w-[min(100%,20rem)] grid-cols-3 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  title="生成并保存报告"
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => (currentSessionId ? saveReportMutation.mutate(currentSessionId) : null)}
                  disabled={!currentSessionId || saveReportMutation.isPending}
                >
                  <Save className="h-3 w-3 shrink-0" />
                  <span className="truncate">{saveReportMutation.isPending ? "生成中..." : "生成报告"}</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  title="下载当前图表"
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={downloadCurrentGraph}
                  disabled={!currentSessionId || !currentGraphPayload}
                >
                  <Download className="h-3 w-3 shrink-0" />
                  <span className="truncate">下载图表</span>
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  title="关闭会话"
                  className="h-8 min-w-0 gap-1 px-2 text-xs font-semibold"
                  onClick={() => void handleCloseSession()}
                  disabled={!currentSessionId || currentSessionClosed || closeMutation.isPending}
                >
                  <StopCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">{currentSessionClosed ? "已结束" : "关闭"}</span>
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
                  aria-label="关闭侧栏"
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
              <div className="text-sm font-semibold text-theme-1">历史会话</div>
                  <Button
              type="button"
                    variant="ghost"
              className="h-9 shrink-0 gap-2 rounded-lg px-3 text-xs"
              onClick={() => setDetailDrawerOpen(false)}
              aria-label="收起历史记录"
                  >
              收起历史记录
              <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2 pt-3">
              <div className="rounded-lg border border-theme-default bg-surface-muted px-3 py-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-theme-4">运行详情</div>
                <div className="flex flex-wrap gap-1.5">
                  {mermaidState?.provider || selectedPlannerProfile?.label ? (
                    <Badge>{mermaidState?.provider || selectedPlannerProfile?.label}</Badge>
            ) : null}
                  {mermaidState?.model || plannerModel ? <Badge>{mermaidState?.model || plannerModel}</Badge> : null}
                  {typeof mermaidState?.latency_ms === "number" ? <Badge>{mermaidState.latency_ms.toFixed(1)} ms</Badge> : null}
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    出图：
                    {typeof mermaidState?.compile_ok === "boolean"
                      ? mermaidState.compile_ok
                        ? "编译通过"
                        : "编译失败"
                      : "等待中"}
                        </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    来源：{getSourceBadgeLabel(activeCaptureSource)}
                  </Badge>
                  <Badge className="text-[10px] font-normal normal-case tracking-normal text-theme-3">
                    转写：{backendLabel(selectedRecognitionBackend)}
                  </Badge>
                  {snapshot?.evaluation?.realtime_eval_pass === true ? (
                    <Badge className="border-emerald-900/55 bg-emerald-950/40 text-[10px] font-normal normal-case tracking-normal text-emerald-200">
                      评测通过
                    </Badge>
                  ) : null}
                      </div>
                      </div>
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
                        setTitle(item.title || "研究演示会话");
                        setTitleDraft(item.title || "研究演示会话");
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
                        状态：{item.status === "closed" ? "closed" : "active"}
                      </div>
                      {item.summary?.input_runtime?.input_source ? (
                        <div className={`mt-2 text-xs ${sessionSelected ? "text-white/70" : "text-theme-4"}`}>
                          输入源：{String(item.summary.input_runtime.input_source)}
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
                      aria-label="删除该会话"
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
                aria-label="取消删除"
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
                        删除会话
                      </h2>
                      <p id="delete-session-dialog-desc" className="mt-3 text-base leading-relaxed text-theme-3">
                        确定删除该会话？此操作不可恢复。
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
                    取消
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    className="h-8 min-h-0 w-full px-3 py-1 text-xs font-semibold sm:w-auto"
                    disabled={deleteSessionMutation.isPending}
                    onClick={() => void confirmDeleteHistorySession()}
                  >
                    {deleteSessionMutation.isPending ? "删除中…" : "删除会话"}
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
