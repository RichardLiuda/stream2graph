"use client";

// AI辅助生成：豆包（IDE智能编程辅助），2026-04-02

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Globe2, Plus, RefreshCcw, Save, Settings2, Trash2 } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

import { ApiError, api } from "@/lib/api";
import { decodeAudioFileToVoiceprintPayload } from "@/lib/audio";
import {
  LANGUAGE_OPTIONS,
  languageText,
  useLanguagePreference,
  type LanguagePreference,
  type LocalizedText,
} from "@/lib/language";
import { loadRuntimePreferences, resolveRuntimePreferences, saveRuntimePreferences } from "@/lib/runtime-preferences";
import { RealtimeDefaultConfig } from "@/components/realtime-default-config";

type AdminRuntimeOptions = Awaited<ReturnType<typeof api.getAdminRuntimeOptions>>;
type RuntimeConnectionTestResult = Awaited<ReturnType<typeof api.testRuntimeConnection>>;
type ProviderKind = "openai_compatible" | "xfyun_asr";
type VoiceprintProviderKind = "xfyun_isv";
type EndpointRouteMode = "chat_completions" | "custom";
type VoiceprintDraft = {
  enabled: boolean;
  providerKind: VoiceprintProviderKind;
  apiBase: string;
  groupId: string;
  scoreThreshold: string;
  topK: string;
};
type ProfileDraft = {
  id: string;
  label: string;
  endpointBase: string;
  endpointRouteMode: EndpointRouteMode;
  customEndpointPath: string;
  disableThinking: boolean;
  appId: string;
  apiKey: string;
  apiKeyEnv: string;
  apiSecret: string;
  apiSecretEnv: string;
  modelsText: string;
  defaultModel: string;
  providerKind: ProviderKind;
  voiceprint: VoiceprintDraft;
};

const DEFAULT_COMPAT_BASE = "";
const DEFAULT_XFYUN_ASR_ENDPOINT = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";
const DEFAULT_XFYUN_ASR_MODELS = ["rtasr_llm"];
const MODEL_PROVIDER_KIND_OPTIONS: Array<{ value: ProviderKind; label: string }> = [
  { value: "openai_compatible", label: "兼容接口（国内网关/厂商）" },
  { value: "xfyun_asr", label: "讯飞 RTASR LLM" },
];
const DEFAULT_VOICEPRINT_BASE = "https://office-api-personal-dx.iflyaisol.com";
const ENDPOINT_ROUTE_OPTIONS: Record<
  "gate" | "planner" | "stt",
  Array<{ value: EndpointRouteMode; label: string; path: string }>
> = {
  gate: [
    { value: "chat_completions", label: "/v1/chat/completions", path: "/v1/chat/completions" },
    { value: "custom", label: "自定义路径", path: "" },
  ],
  planner: [
    { value: "chat_completions", label: "/v1/chat/completions", path: "/v1/chat/completions" },
    { value: "custom", label: "自定义路径", path: "" },
  ],
  stt: [
    { value: "custom", label: "讯飞固定地址", path: "" },
  ],
};

function selectClassName(disabled = false) {
  return `select-control ${disabled ? "cursor-not-allowed opacity-55" : ""}`;
}

function t(language: LanguagePreference, copy: LocalizedText) {
  return languageText(language, copy);
}

function blankProfile(prefix: "gate" | "planner" | "stt", index: number): ProfileDraft {
  const disableThinking = prefix === "planner";
  return {
    id: `${prefix}-${index}`,
    label: "",
    endpointBase: prefix === "stt" ? DEFAULT_XFYUN_ASR_ENDPOINT : DEFAULT_COMPAT_BASE,
    endpointRouteMode: prefix === "stt" ? "custom" : "chat_completions",
    customEndpointPath: "",
    disableThinking,
    appId: "",
    apiKey: "",
    apiKeyEnv: "",
    apiSecret: "",
    apiSecretEnv: "",
    modelsText: prefix === "stt" ? DEFAULT_XFYUN_ASR_MODELS.join("\n") : "",
    defaultModel: prefix === "stt" ? DEFAULT_XFYUN_ASR_MODELS[0] : "",
    providerKind: prefix === "stt" ? "xfyun_asr" : "openai_compatible",
    voiceprint: {
      enabled: false,
      providerKind: "xfyun_isv",
      apiBase: DEFAULT_VOICEPRINT_BASE,
      groupId: `${prefix}_${index}_group`,
      scoreThreshold: "0.75",
      topK: "3",
    },
  };
}

function shouldDisableThinking(kind: "gate" | "planner" | "stt", extraBodyJson: string | null | undefined) {
  if (kind === "stt") return false;
  const raw = String(extraBodyJson || "").trim();
  if (!raw) {
    return kind === "planner";
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return kind === "planner";
    }
    const extra = parsed as Record<string, unknown>;
    if (extra.enable_thinking === false) return true;
    const reasoning = extra.reasoning;
    return Boolean(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) && (reasoning as Record<string, unknown>).exclude === true);
  } catch {
    return kind === "planner";
  }
}

function normalizeEndpointBase(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return DEFAULT_COMPAT_BASE;
  return trimmed.replace(/\/v1$/i, "") || DEFAULT_COMPAT_BASE;
}

function normalizeCustomEndpointPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function splitEndpointToDraft(kind: "gate" | "planner" | "stt", endpoint: string) {
  const normalized = endpoint.trim().replace(/\/$/, "");
  const matchedOption = ENDPOINT_ROUTE_OPTIONS[kind].find(
    (option) => option.path && normalized.endsWith(option.path),
  );
  if (matchedOption) {
    return {
      endpointBase: normalizeEndpointBase(normalized.slice(0, -matchedOption.path.length)),
      endpointRouteMode: matchedOption.value,
      customEndpointPath: "",
    };
  }

  const v1Index = normalized.indexOf("/v1/");
  if (v1Index >= 0) {
    return {
      endpointBase: normalizeEndpointBase(normalized.slice(0, v1Index)),
      endpointRouteMode: "custom" as const,
      customEndpointPath: normalized.slice(v1Index),
    };
  }

  return {
    endpointBase: normalizeEndpointBase(normalized),
    endpointRouteMode: "custom" as const,
    customEndpointPath: "",
  };
}

function resolveEndpoint(kind: "gate" | "planner" | "stt", draft: ProfileDraft) {
  if (kind === "stt" && draft.providerKind === "xfyun_asr") {
    return DEFAULT_XFYUN_ASR_ENDPOINT;
  }
  const route = ENDPOINT_ROUTE_OPTIONS[kind].find((option) => option.value === draft.endpointRouteMode);
  const base = normalizeEndpointBase(draft.endpointBase);
  const path =
    draft.endpointRouteMode === "custom"
      ? normalizeCustomEndpointPath(draft.customEndpointPath)
      : route?.path || "";
  return `${base}${path}`;
}

function profileToDraft(
  kind: "gate" | "planner" | "stt",
  profile: AdminRuntimeOptions["gate_profiles"][number],
): ProfileDraft {
  const endpointDraft = splitEndpointToDraft(kind, profile.endpoint);
  const voiceprint = profile.voiceprint && typeof profile.voiceprint === "object" ? profile.voiceprint : null;
  const resolvedProviderKind =
    kind === "stt"
      ? profile.provider_kind === "xfyun_asr"
        ? "xfyun_asr"
        : "xfyun_asr"
      : "openai_compatible";
  return {
    id: profile.id,
    label: profile.label,
    endpointBase: kind === "stt" ? DEFAULT_XFYUN_ASR_ENDPOINT : endpointDraft.endpointBase,
    endpointRouteMode: kind === "stt" ? "custom" : endpointDraft.endpointRouteMode,
    customEndpointPath: kind === "stt" ? "" : endpointDraft.customEndpointPath,
    disableThinking: shouldDisableThinking(kind, profile.extra_body_json),
    appId: typeof profile.app_id === "string" ? profile.app_id : "",
    apiKey: profile.api_key || "",
    apiKeyEnv: profile.api_key_env || "",
    apiSecret: typeof profile.api_secret === "string" ? profile.api_secret : "",
    apiSecretEnv: typeof profile.api_secret_env === "string" ? profile.api_secret_env : "",
    modelsText: profile.models.length ? profile.models.join("\n") : kind === "stt" ? DEFAULT_XFYUN_ASR_MODELS.join("\n") : "",
    defaultModel: profile.default_model,
    providerKind: resolvedProviderKind,
    voiceprint: {
      enabled: Boolean(voiceprint?.enabled),
      providerKind: "xfyun_isv",
      apiBase: String(voiceprint?.api_base || DEFAULT_VOICEPRINT_BASE),
      groupId: String(voiceprint?.group_id || `${profile.id}_group`),
      scoreThreshold: String(voiceprint?.score_threshold ?? 0.75),
      topK: String(voiceprint?.top_k ?? 3),
    },
  };
}

function modelOptionsFromDraft(draft: ProfileDraft) {
  return draft.modelsText
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function draftsToPayload(kind: "gate" | "planner" | "stt", drafts: ProfileDraft[]) {
  return drafts
    .map((item) => ({
      id: item.id.trim(),
      label: item.label.trim() || item.id.trim(),
      endpoint: resolveEndpoint(kind, item),
      extra_body_json: kind === "stt" ? "" : item.disableThinking ? '{"enable_thinking": false}' : "",
      app_id: item.appId.trim(),
      api_key: item.apiKey.trim(),
      api_key_env: item.apiKeyEnv.trim(),
      api_secret: item.apiSecret.trim(),
      api_secret_env: item.apiSecretEnv.trim(),
      models: modelOptionsFromDraft(item),
      default_model: item.defaultModel.trim(),
      provider_kind: item.providerKind,
      voiceprint:
        kind !== "stt"
          ? null
          : {
              enabled: item.voiceprint.enabled,
              provider_kind: item.voiceprint.providerKind,
              api_base: item.voiceprint.apiBase.trim() || DEFAULT_VOICEPRINT_BASE,
              group_id: item.voiceprint.groupId.trim() || `${item.id.trim() || "stt"}_group`,
              score_threshold: Number(item.voiceprint.scoreThreshold || 0.75),
              top_k: Number(item.voiceprint.topK || 3),
            },
    }))
    .filter((item) => item.id && item.endpoint && item.models.length);
}

function summarizeDefaults(
  gateLabel: string | null,
  gateModel: string,
  plannerLabel: string | null,
  plannerModel: string,
  sttLabel: string | null,
  sttModel: string,
  diagramMode: "mermaid_primary" | "dual_view",
  language: LanguagePreference,
) {
  const notConfigured = t(language, {
    zh: "未配置",
    en: "Not configured",
    es: "No configurado",
    pt: "Não configurado",
    de: "Nicht konfiguriert",
    ja: "未設定",
  });
  const noModel = t(language, {
    zh: "未选择模型",
    en: "No model selected",
    es: "Sin modelo seleccionado",
    pt: "Nenhum modelo selecionado",
    de: "Kein Modell ausgewählt",
    ja: "モデル未選択",
  });
  return [
    { label: "Gate", value: gateLabel ? `${gateLabel} / ${gateModel || noModel}` : notConfigured },
    { label: "Planner", value: plannerLabel ? `${plannerLabel} / ${plannerModel || noModel}` : notConfigured },
    { label: "STT", value: sttLabel ? `${sttLabel} / ${sttModel || noModel}` : notConfigured },
    {
      label: t(language, { zh: "视图", en: "View", es: "Vista", pt: "Visualização", de: "Ansicht", ja: "表示" }),
      value:
        diagramMode === "dual_view"
          ? t(language, {
              zh: "Mermaid + 结构视图",
              en: "Mermaid + Structure View",
              es: "Mermaid + vista estructural",
              pt: "Mermaid + visualização estrutural",
              de: "Mermaid + Strukturansicht",
              ja: "Mermaid + 構造ビュー",
            })
          : t(language, {
              zh: "Mermaid 主视图",
              en: "Mermaid Main View",
              es: "Vista principal Mermaid",
              pt: "Vista principal Mermaid",
              de: "Mermaid-Hauptansicht",
              ja: "Mermaid メインビュー",
            }),
    },
  ];
}

export function PlatformSettings() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = useLanguagePreference();
  const tr = (copy: LocalizedText) => t(language, copy);
  const authQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    refetchOnMount: "always",
  });
  const runtimeOptions = useQuery({
    queryKey: ["runtime-options"],
    queryFn: api.listRuntimeOptions,
    retry: false,
  });
  const datasetsCatalog = useQuery({
    queryKey: ["datasets"],
    queryFn: api.listDatasets,
    retry: false,
  });
  const adminRuntimeOptions = useQuery({
    queryKey: ["admin-runtime-options"],
    queryFn: api.getAdminRuntimeOptions,
    retry: false,
    enabled: authQuery.isSuccess && authQuery.isFetchedAfterMount,
  });

  const preferenceInitRef = useRef(false);
  const draftsInitRef = useRef(false);
  const [gateProfileId, setGateProfileId] = useState("");
  const [gateModel, setGateModel] = useState("");
  const [plannerProfileId, setPlannerProfileId] = useState("");
  const [plannerModel, setPlannerModel] = useState("");
  const [sttProfileId, setSttProfileId] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [diagramMode, setDiagramMode] = useState<"mermaid_primary" | "dual_view">("mermaid_primary");
  const [gateDrafts, setGateDrafts] = useState<ProfileDraft[]>([]);
  const [plannerDrafts, setPlannerDrafts] = useState<ProfileDraft[]>([]);
  const [sttDrafts, setSttDrafts] = useState<ProfileDraft[]>([]);
  const [probeFeedback, setProbeFeedback] = useState<string | null>(null);
  const [connectionResults, setConnectionResults] = useState<Record<string, RuntimeConnectionTestResult>>({});
  const [voiceprintProfileId, setVoiceprintProfileId] = useState("");
  const [voiceprintFeedback, setVoiceprintFeedback] = useState<string | null>(null);
  const [speakerLabel, setSpeakerLabel] = useState("");
  const [featureInfo, setFeatureInfo] = useState("");
  const [enrollmentFile, setEnrollmentFile] = useState<File | null>(null);

  useEffect(() => {
    if (!runtimeOptions.data || preferenceInitRef.current) return;
    const resolved = resolveRuntimePreferences(runtimeOptions.data, loadRuntimePreferences());
    setGateProfileId(resolved.gateProfileId);
    setGateModel(resolved.gateModel);
    setPlannerProfileId(resolved.plannerProfileId);
    setPlannerModel(resolved.plannerModel);
    setSttProfileId(resolved.sttProfileId);
    setSttModel(resolved.sttModel);
    setDiagramMode(resolved.diagramMode);
    preferenceInitRef.current = true;
  }, [runtimeOptions.data]);

  useEffect(() => {
    if (!adminRuntimeOptions.data || draftsInitRef.current) return;
    setGateDrafts(
      adminRuntimeOptions.data.gate_profiles.length
        ? adminRuntimeOptions.data.gate_profiles.map((profile) => profileToDraft("gate", profile))
        : [blankProfile("gate", 1)],
    );
    setPlannerDrafts(
      adminRuntimeOptions.data.planner_profiles.length
        ? adminRuntimeOptions.data.planner_profiles.map((profile) => profileToDraft("planner", profile))
        : [blankProfile("planner", 1)],
    );
    setSttDrafts(
      adminRuntimeOptions.data.stt_profiles.length
        ? adminRuntimeOptions.data.stt_profiles.map((profile) => profileToDraft("stt", profile))
        : [blankProfile("stt", 1)],
    );
    draftsInitRef.current = true;
  }, [adminRuntimeOptions.data]);

  useEffect(() => {
    if (!adminRuntimeOptions.data?.stt_profiles.length) return;
    const preferred =
      adminRuntimeOptions.data.stt_profiles.find((item) => item.id === voiceprintProfileId) ||
      adminRuntimeOptions.data.stt_profiles.find((item) => item.voiceprint?.enabled) ||
      adminRuntimeOptions.data.stt_profiles[0];
    if (preferred && preferred.id !== voiceprintProfileId) {
      setVoiceprintProfileId(preferred.id);
    }
  }, [adminRuntimeOptions.data, voiceprintProfileId]);

  const selectedGateProfile = runtimeOptions.data?.gate_profiles.find((item) => item.id === gateProfileId) ?? null;
  const selectedPlannerProfile =
    runtimeOptions.data?.planner_profiles.find((item) => item.id === plannerProfileId) ?? null;
  const selectedSttProfile = runtimeOptions.data?.stt_profiles.find((item) => item.id === sttProfileId) ?? null;
  const managedVoiceprintProfile =
    adminRuntimeOptions.data?.stt_profiles.find((item) => item.id === voiceprintProfileId) ?? null;
  const gateModelOptions = selectedGateProfile?.models || [];
  const plannerModelOptions = selectedPlannerProfile?.models || [];
  const sttModelOptions = selectedSttProfile?.models || [];
  const hasGateProfiles = Boolean(runtimeOptions.data?.gate_profiles.length);
  const hasPlannerProfiles = Boolean(runtimeOptions.data?.planner_profiles.length);
  const hasSttProfiles = Boolean(runtimeOptions.data?.stt_profiles.length);
  const adminReady = authQuery.isSuccess && authQuery.isFetchedAfterMount;
  const authError = authQuery.error instanceof ApiError ? authQuery.error : null;
  const adminLoggedOut = authError?.status === 401;

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
    if (!preferenceInitRef.current) return;
    saveRuntimePreferences({
      gateProfileId,
      gateModel,
      plannerProfileId,
      plannerModel,
      sttProfileId,
      sttModel,
      diagramMode,
    });
  }, [diagramMode, gateModel, gateProfileId, plannerModel, plannerProfileId, sttModel, sttProfileId]);

  const saveProfilesMutation = useMutation({
    mutationFn: () =>
      api.saveAdminRuntimeOptions({
        gate_profiles: draftsToPayload("gate", gateDrafts),
        planner_profiles: draftsToPayload("planner", plannerDrafts),
        stt_profiles: draftsToPayload("stt", sttDrafts),
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(["admin-runtime-options"], payload);
      queryClient.invalidateQueries({ queryKey: ["runtime-options"] });
    },
  });

  const probeModelsMutation = useMutation({
    mutationFn: async (payload: { kind: "gate" | "planner" | "stt"; index: number; draft: ProfileDraft }) => {
      const result = await api.probeRuntimeModels({
        endpoint: resolveEndpoint(payload.kind, payload.draft),
        provider_kind: payload.draft.providerKind,
        api_key: payload.draft.apiKey.trim() || null,
        api_key_env: payload.draft.apiKeyEnv.trim() || null,
      });
      return { ...payload, result };
    },
    onSuccess: ({ kind, index, result }) => {
      const modelsText = result.models.join("\n");
      updateDraft(kind, index, (current) => ({
        modelsText,
        defaultModel: result.models.includes(current.defaultModel) ? current.defaultModel : result.models[0] || "",
      }));
      setProbeFeedback(`已探测到 ${result.models.length} 个模型，来源：${result.models_endpoint}`);
    },
    onError: (error) => {
      setProbeFeedback((error as Error).message);
    },
  });

  const testConnectionMutation = useMutation({
    mutationFn: async (payload: { kind: "gate" | "planner" | "stt"; index: number; draft: ProfileDraft }) => {
      const result = await api.testRuntimeConnection({
        endpoint: resolveEndpoint(payload.kind, payload.draft),
        provider_kind: payload.draft.providerKind,
        app_id: payload.draft.appId.trim() || null,
        api_key: payload.draft.apiKey.trim() || null,
        api_key_env: payload.draft.apiKeyEnv.trim() || null,
        api_secret: payload.draft.apiSecret.trim() || null,
        api_secret_env: payload.draft.apiSecretEnv.trim() || null,
        voiceprint:
          payload.kind === "stt"
            ? {
                enabled: payload.draft.voiceprint.enabled,
                provider_kind: payload.draft.voiceprint.providerKind,
                api_base: payload.draft.voiceprint.apiBase.trim() || DEFAULT_VOICEPRINT_BASE,
                group_id: payload.draft.voiceprint.groupId.trim() || `${payload.draft.id.trim() || "stt"}_group`,
                score_threshold: Number(payload.draft.voiceprint.scoreThreshold || 0.75),
                top_k: Number(payload.draft.voiceprint.topK || 3),
              }
            : null,
      });
      return { ...payload, result };
    },
    onSuccess: ({ kind, index, result }) => {
      setConnectionResults((current) => ({ ...current, [`${kind}-${index}`]: result }));
    },
    onError: (error, variables) => {
      setConnectionResults((current) => ({
        ...current,
        [`${variables.kind}-${variables.index}`]: {
          ok: false,
          provider_kind: variables.draft.providerKind,
          summary: (error as Error).message,
          logs: [(error as Error).message],
        },
      }));
    },
  });

  const voiceprintFeaturesQuery = useQuery({
    queryKey: ["voiceprint-features", voiceprintProfileId],
    queryFn: () => api.listVoiceprintFeatures(voiceprintProfileId),
    retry: false,
    enabled: adminReady && Boolean(voiceprintProfileId),
  });

  const syncVoiceprintGroupMutation = useMutation({
    mutationFn: () =>
      api.syncVoiceprintGroup(voiceprintProfileId, {
        display_name: managedVoiceprintProfile?.label || voiceprintProfileId,
        group_info: managedVoiceprintProfile?.label || voiceprintProfileId,
      }),
    onSuccess: (payload) => {
      setVoiceprintFeedback(`已同步声纹组 ${payload.group.group_id}，远端特征数 ${payload.remote_features.length}。`);
      queryClient.invalidateQueries({ queryKey: ["voiceprint-features", voiceprintProfileId] });
    },
    onError: (error) => setVoiceprintFeedback((error as Error).message),
  });

  const createVoiceprintFeatureMutation = useMutation({
    mutationFn: async () => {
      if (!enrollmentFile) {
        throw new Error("请先选择一段说话人样本音频。");
      }
      if (!speakerLabel.trim()) {
        throw new Error("请填写说话人标签。");
      }
      const audioPayload = await decodeAudioFileToVoiceprintPayload(enrollmentFile);
      return api.createVoiceprintFeature(voiceprintProfileId, {
        speaker_label: speakerLabel.trim(),
        feature_info: featureInfo.trim() || speakerLabel.trim(),
        ...audioPayload,
      });
    },
    onSuccess: () => {
      setVoiceprintFeedback(`已为 ${speakerLabel.trim()} 注册声纹特征。`);
      setSpeakerLabel("");
      setFeatureInfo("");
      setEnrollmentFile(null);
      queryClient.invalidateQueries({ queryKey: ["voiceprint-features", voiceprintProfileId] });
    },
    onError: (error) => setVoiceprintFeedback((error as Error).message),
  });

  const deleteVoiceprintFeatureMutation = useMutation({
    mutationFn: (featureId: string) => api.deleteVoiceprintFeature(voiceprintProfileId, featureId),
    onSuccess: () => {
      setVoiceprintFeedback("已删除声纹特征。");
      queryClient.invalidateQueries({ queryKey: ["voiceprint-features", voiceprintProfileId] });
    },
    onError: (error) => setVoiceprintFeedback((error as Error).message),
  });

  const summary = useMemo(
    () =>
      summarizeDefaults(
        selectedGateProfile?.label || null,
        gateModel,
        selectedPlannerProfile?.label || null,
        plannerModel,
        selectedSttProfile?.label || null,
        sttModel,
        diagramMode,
        language,
      ),
    [diagramMode, gateModel, language, plannerModel, selectedGateProfile, selectedPlannerProfile, selectedSttProfile, sttModel],
  );

  function updateDraft(
    kind: "gate" | "planner" | "stt",
    index: number,
    patch: Partial<ProfileDraft> | ((current: ProfileDraft) => Partial<ProfileDraft>),
  ) {
    const setter = kind === "gate" ? setGateDrafts : kind === "planner" ? setPlannerDrafts : setSttDrafts;
    setter((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) } : item,
      ),
    );
  }

  function addDraft(kind: "gate" | "planner" | "stt") {
    const setter = kind === "gate" ? setGateDrafts : kind === "planner" ? setPlannerDrafts : setSttDrafts;
    setter((current) => [...current, blankProfile(kind, current.length + 1)]);
  }

  function removeDraft(kind: "gate" | "planner" | "stt", index: number) {
    const setter = kind === "gate" ? setGateDrafts : kind === "planner" ? setPlannerDrafts : setSttDrafts;
    setter((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      return next.length ? next : [blankProfile(kind, 1)];
    });
  }

  return (
    <div className="space-y-6">
      {/* pr：与实时页「历史会话」同档，并为固定主题按钮留空 */}
      <div className="flex flex-wrap items-center justify-between gap-3 pr-12 sm:pr-14">
        <h1 className="page-title page-title--menu-clearance">
          {tr({ zh: "设置", en: "Settings", es: "Ajustes", pt: "Configurações", de: "Einstellungen", ja: "設定" })}
        </h1>
        <Link href="/app/realtime" className="shrink-0">
          <Button variant="secondary">
            {tr({
              zh: "返回实时工作",
              en: "Back to Realtime",
              es: "Volver a tiempo real",
              pt: "Voltar ao tempo real",
              de: "Zur Echtzeit zurück",
              ja: "リアルタイムへ戻る",
            })}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-theme-subtle bg-surface-muted text-theme-2">
              <Globe2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-semibold text-theme-1">
                {tr({ zh: "界面语言", en: "Language", es: "Idioma", pt: "Idioma", de: "Sprache", ja: "言語" })}
              </div>
              <p className="mt-2 text-sm leading-6 text-theme-4">
                {tr({
                  zh: "选择当前浏览器的界面语言。实时工作台与设置页会立即切换。",
                  en: "Choose the interface language for this browser. Realtime workbench and settings update immediately.",
                  es: "Elige el idioma de la interfaz para este navegador. El banco de trabajo en tiempo real y los ajustes se actualizan al instante.",
                  pt: "Escolha o idioma da interface para este navegador. O ambiente em tempo real e as configurações são atualizados imediatamente.",
                  de: "Wähle die Oberflächensprache für diesen Browser. Echtzeit-Arbeitsfläche und Einstellungen werden sofort aktualisiert.",
                  ja: "このブラウザの表示言語を選択します。リアルタイム作業台と設定はすぐに切り替わります。",
                })}
              </p>
            </div>
          </div>
          <div className="w-full max-w-xs">
            <label className="sr-only" htmlFor="s2g-language-select">
              {tr({ zh: "界面语言", en: "Language", es: "Idioma", pt: "Idioma", de: "Sprache", ja: "言語" })}
            </label>
            <select
              id="s2g-language-select"
              className={selectClassName(false)}
              value={language}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setLanguage(event.target.value as LanguagePreference)
              }
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.nativeLabel}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card className="soft-enter space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-theme-1">
              {tr({
                zh: "服务端模型配置",
                en: "Server Model Configuration",
                es: "Configuración de modelos del servidor",
                pt: "Configuração de modelos do servidor",
                de: "Server-Modellkonfiguration",
                ja: "サーバーモデル設定",
              })}
            </div>
            <p className="mt-2 text-sm leading-6 text-theme-4">
              {tr({
                zh: "保存后直接写入服务端。实时工作与样本页都会用这里的 Gate、Planner 和听写服务。",
                en: "Changes are written to the server. Realtime and sample pages use the Gate, Planner, and STT services configured here.",
                es: "Los cambios se escriben en el servidor. Las páginas de tiempo real y muestras usan aquí Gate, Planner y STT.",
                pt: "As alterações são gravadas no servidor. As páginas em tempo real e de amostras usam Gate, Planner e STT configurados aqui.",
                de: "Änderungen werden auf den Server geschrieben. Echtzeit- und Beispielseiten nutzen die hier konfigurierten Gate-, Planner- und STT-Dienste.",
                ja: "保存後はサーバーへ直接書き込まれます。リアルタイム画面とサンプル画面はここで設定した Gate、Planner、STT を使用します。",
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge>
              {!adminReady
                ? tr({ zh: "身份确认中", en: "Checking identity", es: "Verificando identidad", pt: "Verificando identidade", de: "Identität wird geprüft", ja: "認証確認中" })
                : adminRuntimeOptions.isFetching
                  ? tr({ zh: "读取中", en: "Loading", es: "Cargando", pt: "Carregando", de: "Lädt", ja: "読み込み中" })
                  : tr({ zh: "服务端持久化", en: "Server persisted", es: "Persistido en servidor", pt: "Persistido no servidor", de: "Serverseitig gespeichert", ja: "サーバー保存済み" })}
            </Badge>
            <Button
              onClick={() => saveProfilesMutation.mutate()}
              disabled={!adminReady || saveProfilesMutation.isPending}
            >
              <Save className="h-4 w-4" />
              {saveProfilesMutation.isPending
                ? tr({ zh: "保存中...", en: "Saving...", es: "Guardando...", pt: "Salvando...", de: "Speichert...", ja: "保存中..." })
                : tr({ zh: "保存服务端配置", en: "Save Server Config", es: "Guardar config. del servidor", pt: "Salvar config. do servidor", de: "Serverkonfiguration speichern", ja: "サーバー設定を保存" })}
            </Button>
          </div>
        </div>

        {authQuery.isLoading ? (
          <div className="rounded-lg border border-theme-subtle bg-surface-muted px-4 py-3 text-sm text-theme-4">
            {tr({ zh: "正在确认管理员登录状态…", en: "Checking admin sign-in...", es: "Comprobando inicio de administrador...", pt: "Verificando login de administrador...", de: "Admin-Anmeldung wird geprüft...", ja: "管理者ログインを確認中..." })}
          </div>
        ) : null}
        {adminLoggedOut ? (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/35 px-4 py-3 text-sm leading-relaxed text-amber-100">
            <p>
              {tr({
                zh: "当前还没有管理员登录，无法读写服务端模型配置。",
                en: "No admin is signed in, so server model configuration cannot be read or written.",
                es: "No hay administrador conectado, por lo que no se puede leer ni escribir la configuración.",
                pt: "Nenhum administrador está conectado, então a configuração não pode ser lida nem gravada.",
                de: "Es ist kein Admin angemeldet; die Servermodell-Konfiguration kann nicht gelesen oder geschrieben werden.",
                ja: "管理者がログインしていないため、サーバーモデル設定を読み書きできません。",
              })}
            </p>
            <Link
              href="/login"
              className="mt-2 inline-flex items-center gap-1 font-medium text-amber-200 underline underline-offset-4 theme-light:text-amber-900 hover:text-theme-1"
            >
              {tr({ zh: "前往管理员登录", en: "Go to Admin Login", es: "Ir al inicio de administrador", pt: "Ir para login de administrador", de: "Zur Admin-Anmeldung", ja: "管理者ログインへ" })}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : null}
        {!adminReady && authQuery.isError && !adminLoggedOut ? (
          <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {(authQuery.error as Error).message}
          </div>
        ) : null}
        {!adminReady && authQuery.isSuccess && !adminLoggedOut ? (
          <div className="rounded-lg border border-theme-subtle bg-surface-muted px-4 py-3 text-sm text-theme-4">
            {tr({ zh: "正在启用服务端配置…", en: "Enabling server configuration...", es: "Activando configuración del servidor...", pt: "Ativando configuração do servidor...", de: "Serverkonfiguration wird aktiviert...", ja: "サーバー設定を有効化中..." })}
          </div>
        ) : null}

        {saveProfilesMutation.isError ? (
          <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {(saveProfilesMutation.error as Error).message}
          </div>
        ) : null}
        {probeFeedback ? (
          <div className="rounded-lg border border-theme-subtle bg-surface-muted px-4 py-3 text-sm text-theme-2">
            {probeFeedback}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          {[
            {
              kind: "gate" as const,
              title: tr({ zh: "Gate 配置", en: "Gate Config", es: "Config. Gate", pt: "Config. Gate", de: "Gate-Konfiguration", ja: "Gate 設定" }),
              drafts: gateDrafts,
            },
            {
              kind: "planner" as const,
              title: tr({ zh: "Planner 配置", en: "Planner Config", es: "Config. Planner", pt: "Config. Planner", de: "Planner-Konfiguration", ja: "Planner 設定" }),
              drafts: plannerDrafts,
            },
            {
              kind: "stt" as const,
              title: tr({ zh: "听写服务配置", en: "STT Service Config", es: "Config. servicio STT", pt: "Config. serviço STT", de: "STT-Dienstkonfiguration", ja: "STT サービス設定" }),
              drafts: sttDrafts,
            },
          ].map((group) => (
            <div key={group.kind} className="space-y-4 rounded-xl border border-theme-default bg-surface-muted p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-theme-2">{group.title}</div>
                <Button variant="secondary" onClick={() => addDraft(group.kind)}>
                  <Plus className="h-4 w-4" />
                  {tr({ zh: "添加", en: "Add", es: "Añadir", pt: "Adicionar", de: "Hinzufügen", ja: "追加" })}
                </Button>
              </div>

              <div className="space-y-4">
                {group.drafts.map((draft, index) => (
                  <div key={`${group.kind}-${index}`} className="rounded-xl border border-theme-default bg-surface-muted p-4">
                    {(() => {
                      const resolvedEndpoint = resolveEndpoint(group.kind, draft);
                      const draftModelOptions = modelOptionsFromDraft(draft);
                      const isXfyunStt = group.kind === "stt" && draft.providerKind === "xfyun_asr";
                      const selectedRoute = ENDPOINT_ROUTE_OPTIONS[group.kind].find(
                        (option) => option.value === draft.endpointRouteMode,
                      );
                      const connectionKey = `${group.kind}-${index}`;
                      const connectionResult = connectionResults[connectionKey];
                      const isTestingConnection =
                        testConnectionMutation.isPending &&
                        testConnectionMutation.variables?.kind === group.kind &&
                        testConnectionMutation.variables?.index === index;

                      return (
                    <>
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-theme-1">
                        {draft.label || draft.id || `${group.kind.toUpperCase()} Profile ${index + 1}`}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setProbeFeedback(null);
                            probeModelsMutation.mutate({ kind: group.kind, index, draft });
                          }}
                          disabled={
                            !adminReady ||
                            probeModelsMutation.isPending ||
                            !resolvedEndpoint.trim() ||
                            (!isXfyunStt && !draft.apiKey.trim() && !draft.apiKeyEnv.trim())
                          }
                        >
                          <RefreshCcw className="h-4 w-4" />
                          {probeModelsMutation.isPending
                            ? tr({ zh: "处理中...", en: "Processing...", es: "Procesando...", pt: "Processando...", de: "Wird verarbeitet...", ja: "処理中..." })
                            : isXfyunStt
                              ? tr({ zh: "填充预设", en: "Fill Presets", es: "Rellenar preajustes", pt: "Preencher predefinições", de: "Vorgaben einfügen", ja: "プリセット入力" })
                              : tr({ zh: "探测模型", en: "Probe Models", es: "Detectar modelos", pt: "Detectar modelos", de: "Modelle prüfen", ja: "モデル検出" })}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            testConnectionMutation.mutate({ kind: group.kind, index, draft });
                          }}
                          disabled={
                            !adminReady ||
                            isTestingConnection ||
                            !resolvedEndpoint.trim() ||
                            (isXfyunStt
                              ? !draft.appId.trim() ||
                                (!draft.apiKey.trim() && !draft.apiKeyEnv.trim()) ||
                                (!draft.apiSecret.trim() && !draft.apiSecretEnv.trim())
                              : !draft.apiKey.trim() && !draft.apiKeyEnv.trim())
                          }
                        >
                          <RefreshCcw className="h-4 w-4" />
                          {isTestingConnection
                            ? tr({ zh: "测试中...", en: "Testing...", es: "Probando...", pt: "Testando...", de: "Test läuft...", ja: "テスト中..." })
                            : tr({ zh: "测试连接", en: "Test Connection", es: "Probar conexión", pt: "Testar conexão", de: "Verbindung testen", ja: "接続テスト" })}
                        </Button>
                        <Button variant="ghost" onClick={() => removeDraft(group.kind, index)}>
                          <Trash2 className="h-4 w-4" />
                          {tr({ zh: "删除", en: "Delete", es: "Eliminar", pt: "Excluir", de: "Löschen", ja: "削除" })}
                        </Button>
                      </div>
                    </div>

                    {connectionResult ? (
                      <div
                        className={`mb-4 rounded-xl border px-4 py-3 ${
                          connectionResult.ok
                            ? "border-emerald-800/60 bg-emerald-950/30"
                            : "border-red-900/50 bg-red-950/35"
                        }`}
                      >
                        <div
                          className={`text-sm font-medium ${
                            connectionResult.ok ? "text-emerald-100" : "text-red-100"
                          }`}
                        >
                          {connectionResult.ok
                            ? tr({ zh: "连接测试成功", en: "Connection test succeeded", es: "Prueba de conexión correcta", pt: "Teste de conexão bem-sucedido", de: "Verbindungstest erfolgreich", ja: "接続テスト成功" })
                            : tr({ zh: "连接测试失败", en: "Connection test failed", es: "Prueba de conexión fallida", pt: "Teste de conexão falhou", de: "Verbindungstest fehlgeschlagen", ja: "接続テスト失敗" })}
                        </div>
                        <div className="mt-1 text-sm leading-6 text-zinc-200">{connectionResult.summary}</div>
                        {connectionResult.logs.length ? (
                          <div className="mt-3 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-3">
                            <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                              {tr({ zh: "详细日志", en: "Detailed Logs", es: "Registros detallados", pt: "Logs detalhados", de: "Detailprotokolle", ja: "詳細ログ" })}
                            </div>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-zinc-300">
                              {connectionResult.logs.join("\n")}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-2">Profile ID</label>
                        <Input variant="dark"
                          value={draft.id}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { id: event.target.value })
                          }
                          placeholder={`${group.kind}-profile`}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-2">
                          {tr({ zh: "显示名称", en: "Display Name", es: "Nombre visible", pt: "Nome de exibição", de: "Anzeigename", ja: "表示名" })}
                        </label>
                        <Input variant="dark"
                          value={draft.label}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { label: event.target.value })
                          }
                          placeholder={tr({ zh: "例如 Domestic Primary", en: "e.g. Domestic Primary", es: "p. ej. Domestic Primary", pt: "ex.: Domestic Primary", de: "z. B. Domestic Primary", ja: "例: Domestic Primary" })}
                        />
                      </div>
                      {isXfyunStt ? (
                        <>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">Provider Kind</label>
                            <Input variant="dark" value="xfyun_asr" readOnly />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">App ID</label>
                            <Input variant="dark"
                              value={draft.appId}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { appId: event.target.value })
                              }
                              placeholder="讯飞应用 App ID"
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="space-y-2 md:col-span-2">
                            <label className="text-sm font-medium text-theme-2">Endpoint Base</label>
                            <Input variant="dark"
                              value={draft.endpointBase}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { endpointBase: event.target.value })
                              }
                              placeholder={DEFAULT_COMPAT_BASE || "http://127.0.0.1:9000"}
                            />
                            <p className="text-xs leading-6 text-theme-4">
                              填写兼容接口的基座地址（不含 `/v1`），`/v1` 之后的路径由下方选项自动补全。
                            </p>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">Provider Kind</label>
                            <select
                              className={selectClassName(false)}
                              value={draft.providerKind}
                              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                updateDraft(group.kind, index, {
                                  providerKind: event.target.value as ProviderKind,
                                })
                              }
                            >
                              {MODEL_PROVIDER_KIND_OPTIONS.filter((option) => option.value !== "xfyun_asr").map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">
                              {tr({ zh: "Endpoint 路径", en: "Endpoint Path", es: "Ruta del endpoint", pt: "Caminho do endpoint", de: "Endpoint-Pfad", ja: "Endpoint パス" })}
                            </label>
                            <select
                              className={selectClassName(false)}
                              value={draft.endpointRouteMode}
                              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                updateDraft(group.kind, index, {
                                  endpointRouteMode: event.target.value as EndpointRouteMode,
                                })
                              }
                            >
                              {ENDPOINT_ROUTE_OPTIONS[group.kind].map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <p className="text-xs leading-6 text-theme-4">
                              {selectedRoute?.path
                                ? `${tr({ zh: "当前会自动补全为 ", en: "Automatically appends ", es: "Añade automáticamente ", pt: "Adiciona automaticamente ", de: "Hängt automatisch an: ", ja: "自動で追加: " })}${selectedRoute.path}`
                                : tr({ zh: "当前使用自定义路径。", en: "Using a custom path.", es: "Usando una ruta personalizada.", pt: "Usando um caminho personalizado.", de: "Benutzerdefinierter Pfad wird verwendet.", ja: "カスタムパスを使用中です。" })}
                            </p>
                          </div>
                          {draft.endpointRouteMode === "custom" ? (
                            <div className="space-y-2 md:col-span-2">
                              <label className="text-sm font-medium text-theme-2">
                                {tr({ zh: "自定义路径", en: "Custom Path", es: "Ruta personalizada", pt: "Caminho personalizado", de: "Benutzerdefinierter Pfad", ja: "カスタムパス" })}
                              </label>
                              <Input variant="dark"
                                value={draft.customEndpointPath}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateDraft(group.kind, index, { customEndpointPath: event.target.value })
                                }
                                placeholder="/v1/chat/completions"
                              />
                            </div>
                          ) : null}
                        </>
                      )}
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-sm font-medium text-theme-2">
                          {tr({ zh: "最终 Endpoint", en: "Final Endpoint", es: "Endpoint final", pt: "Endpoint final", de: "Finaler Endpoint", ja: "最終 Endpoint" })}
                        </label>
                        <Input variant="dark" value={resolvedEndpoint} readOnly />
                      </div>
                      {!isXfyunStt ? (
                        <div className="space-y-2 md:col-span-2">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <label className="text-sm font-medium text-theme-2">No Thinking</label>
                            <label className="inline-flex items-center gap-2 text-sm text-theme-3">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-theme-default bg-transparent"
                                checked={draft.disableThinking}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateDraft(group.kind, index, { disableThinking: event.target.checked })
                                }
                              />
                              <span>{tr({ zh: "更快返回", en: "Return faster", es: "Responder más rápido", pt: "Retornar mais rápido", de: "Schneller zurückgeben", ja: "より速く返す" })}</span>
                            </label>
                          </div>
                        </div>
                      ) : null}
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-2">API Key</label>
                        <Input variant="dark"
                          type="password"
                          value={draft.apiKey}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { apiKey: event.target.value })
                          }
                          placeholder={tr({ zh: "直接保存到服务端", en: "Saved directly to server", es: "Guardado directamente en el servidor", pt: "Salvo diretamente no servidor", de: "Direkt auf dem Server gespeichert", ja: "サーバーへ直接保存" })}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-2">API Key Env</label>
                        <Input variant="dark"
                          value={draft.apiKeyEnv}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { apiKeyEnv: event.target.value })
                          }
                          placeholder={
                            isXfyunStt
                              ? tr({ zh: "可选，例如 XFYUN_API_KEY", en: "Optional, e.g. XFYUN_API_KEY", es: "Opcional, p. ej. XFYUN_API_KEY", pt: "Opcional, ex. XFYUN_API_KEY", de: "Optional, z. B. XFYUN_API_KEY", ja: "任意、例: XFYUN_API_KEY" })
                              : tr({ zh: "可选，例如 S2G_DOMESTIC_LLM_API_KEY", en: "Optional, e.g. S2G_DOMESTIC_LLM_API_KEY", es: "Opcional, p. ej. S2G_DOMESTIC_LLM_API_KEY", pt: "Opcional, ex. S2G_DOMESTIC_LLM_API_KEY", de: "Optional, z. B. S2G_DOMESTIC_LLM_API_KEY", ja: "任意、例: S2G_DOMESTIC_LLM_API_KEY" })
                          }
                        />
                      </div>
                      {isXfyunStt ? (
                        <>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">API Secret</label>
                            <Input variant="dark"
                              type="password"
                              value={draft.apiSecret}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { apiSecret: event.target.value })
                              }
                              placeholder={tr({ zh: "讯飞 API Secret", en: "XFYUN API Secret", es: "API Secret de XFYUN", pt: "API Secret da XFYUN", de: "XFYUN API Secret", ja: "XFYUN API Secret" })}
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">API Secret Env</label>
                            <Input variant="dark"
                              value={draft.apiSecretEnv}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { apiSecretEnv: event.target.value })
                              }
                              placeholder={tr({ zh: "可选，例如 XFYUN_API_SECRET", en: "Optional, e.g. XFYUN_API_SECRET", es: "Opcional, p. ej. XFYUN_API_SECRET", pt: "Opcional, ex.: XFYUN_API_SECRET", de: "Optional, z. B. XFYUN_API_SECRET", ja: "任意、例: XFYUN_API_SECRET" })}
                            />
                          </div>
                        </>
                      ) : null}
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-2">
                          {isXfyunStt
                            ? tr({ zh: "默认识别域", en: "Default Recognition Domain", es: "Dominio de reconocimiento predeterminado", pt: "Domínio de reconhecimento padrão", de: "Standard-Erkennungsdomain", ja: "既定認識ドメイン" })
                            : "Default Model"}
                        </label>
                        <select
                          className={selectClassName(!draftModelOptions.length)}
                          value={draft.defaultModel}
                          disabled={!draftModelOptions.length}
                          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                            updateDraft(group.kind, index, { defaultModel: event.target.value })
                          }
                        >
                          {draftModelOptions.length ? (
                            draftModelOptions.map((item) => (
                              <option key={item} value={item}>
                                {item}
                              </option>
                            ))
                          ) : (
                            <option value="">
                              {tr({ zh: "先填写或探测模型列表", en: "Fill or probe models first", es: "Rellena o detecta modelos primero", pt: "Preencha ou detecte modelos primeiro", de: "Zuerst Modelle eintragen oder prüfen", ja: "先にモデルを入力または検出" })}
                            </option>
                          )}
                        </select>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-sm font-medium text-theme-2">
                          {isXfyunStt
                            ? tr({ zh: "识别域列表", en: "Recognition Domains", es: "Dominios de reconocimiento", pt: "Domínios de reconhecimento", de: "Erkennungsdomains", ja: "認識ドメイン一覧" })
                            : tr({ zh: "模型列表", en: "Model List", es: "Lista de modelos", pt: "Lista de modelos", de: "Modellliste", ja: "モデル一覧" })}
                        </label>
                        <Textarea variant="dark"
                          rows={4}
                          value={draft.modelsText}
                          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                            updateDraft(group.kind, index, { modelsText: event.target.value })
                          }
                          placeholder={tr({ zh: "每行一个模型，或用逗号分隔", en: "One model per line, or comma separated", es: "Un modelo por línea o separado por comas", pt: "Um modelo por linha ou separado por vírgulas", de: "Ein Modell pro Zeile oder kommagetrennt", ja: "1行に1モデル、またはカンマ区切り" })}
                        />
                        <p className="text-xs leading-6 text-theme-4">
                          {isXfyunStt
                            ? tr({
                                zh: "默认内置讯飞听写识别域，可直接保存，也可以点“填充预设”恢复默认列表。",
                                en: "The default XFYUN recognition domain is built in. Save directly or restore defaults with Fill Presets.",
                                es: "El dominio de reconocimiento XFYUN predeterminado está incluido. Guarda directamente o restaura con Rellenar preajustes.",
                                pt: "O domínio de reconhecimento XFYUN padrão já vem incluído. Salve diretamente ou restaure com Preencher predefinições.",
                                de: "Die standardmäßige XFYUN-Erkennungsdomain ist integriert. Direkt speichern oder mit Vorgaben einfügen wiederherstellen.",
                                ja: "既定の XFYUN 認識ドメインが組み込まれています。そのまま保存するか、プリセット入力で復元できます。",
                              })
                            : tr({
                                zh: "可以手动填写，也可以先填好 Endpoint 和 API Key，再点“探测模型”自动回填。",
                                en: "Enter models manually, or fill Endpoint and API Key then use Probe Models to backfill automatically.",
                                es: "Introduce modelos manualmente o completa Endpoint y API Key, y usa Detectar modelos para rellenar automáticamente.",
                                pt: "Insira modelos manualmente ou preencha Endpoint e API Key e use Detectar modelos para preencher automaticamente.",
                                de: "Modelle manuell eingeben oder Endpoint und API Key ausfüllen und Modelle prüfen zum automatischen Befüllen nutzen.",
                                ja: "モデルを手入力するか、Endpoint と API Key を入力してからモデル検出で自動補完できます。",
                              })}
                        </p>
                      </div>
                      {group.kind === "stt" ? (
                        <div className="space-y-4 md:col-span-2 rounded-[20px] border border-emerald-900/45 bg-emerald-950/20 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-theme-1">
                                {tr({ zh: "角色分离 / 声纹增强", en: "Speaker Separation / Voiceprint", es: "Separación de hablantes / huella de voz", pt: "Separação de falantes / voz", de: "Sprechertrennung / Stimmabdruck", ja: "話者分離 / 声紋" })}
                              </div>
                              <p className="mt-1 text-xs leading-6 text-theme-4">
                                {tr({
                                  zh: "RTASR 会优先开启角色分离；若已注册声纹特征，会自动写入 `feature_ids` 做声纹分离。",
                                  en: "RTASR prefers speaker separation. Registered voiceprint features are sent as feature_ids.",
                                  es: "RTASR prioriza la separación de hablantes. Las huellas registradas se envían como feature_ids.",
                                  pt: "RTASR prioriza a separação de falantes. Recursos de voz registrados são enviados como feature_ids.",
                                  de: "RTASR bevorzugt Sprechertrennung. Registrierte Stimmabdruck-Merkmale werden als feature_ids gesendet.",
                                  ja: "RTASR は話者分離を優先します。登録済みの声紋特徴は feature_ids として送信されます。",
                                })}
                              </p>
                            </div>
                            <label className="flex items-center gap-2 text-sm font-medium text-theme-2">
                              <input
                                type="checkbox"
                                checked={draft.voiceprint.enabled}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateDraft(group.kind, index, {
                                    voiceprint: { ...draft.voiceprint, enabled: event.target.checked },
                                  })
                                }
                              />
                              {tr({ zh: "启用", en: "Enable", es: "Activar", pt: "Ativar", de: "Aktivieren", ja: "有効化" })}
                            </label>
                          </div>
                          <div className="rounded-[18px] border border-theme-default bg-surface-muted px-4 py-3 text-sm leading-6 text-theme-3">
                            {tr({
                              zh: "开启后会自动复用当前 STT Profile 的讯飞凭证；若声纹库已有特征，实时转写会自动带上 `feature_ids`。",
                              en: "When enabled, the current STT Profile's XFYUN credentials are reused. Realtime transcription will include feature_ids when voiceprint features exist.",
                              es: "Al activarlo, se reutilizan las credenciales XFYUN del perfil STT actual. La transcripción en tiempo real incluirá feature_ids si existen huellas.",
                              pt: "Ao ativar, as credenciais XFYUN do STT Profile atual são reutilizadas. A transcrição em tempo real incluirá feature_ids quando houver vozes.",
                              de: "Bei Aktivierung werden die XFYUN-Zugangsdaten des aktuellen STT-Profils wiederverwendet. Echtzeit-Transkription enthält feature_ids, wenn Merkmale vorhanden sind.",
                              ja: "有効にすると現在の STT Profile の XFYUN 認証情報を再利用します。声紋特徴がある場合、リアルタイム文字起こしに feature_ids が含まれます。",
                            })}
                          </div>
                          <p className="text-[11px] leading-snug text-theme-4">
                            {tr({
                              zh: "与「实时工作台」侧栏同一条配置：在实时页把输入来源选成麦克风/系统音等（不要用纯文本 Transcript）时，左侧会显示一行「声纹分离 / 盲分模式」相关状态，保存后立即生效。",
                              en: "This is the same setting used by the Realtime Workbench sidebar. When the input source is microphone or system audio rather than plain Transcript, the left panel shows the voiceprint separation status and changes apply immediately after saving.",
                              es: "Es la misma configuración usada por la barra lateral del banco en tiempo real. Si la fuente es micrófono o audio del sistema en lugar de Transcript, el panel izquierdo muestra el estado de separación de voz y se aplica al guardar.",
                              pt: "É a mesma configuração usada pela barra lateral do ambiente em tempo real. Quando a fonte é microfone ou áudio do sistema em vez de Transcript, o painel esquerdo mostra o status de separação de voz e aplica ao salvar.",
                              de: "Dies ist dieselbe Einstellung wie in der Seitenleiste der Echtzeit-Arbeitsfläche. Bei Mikrofon- oder Systemaudio statt reinem Transcript zeigt der linke Bereich den Stimmtrennungsstatus; Speichern wirkt sofort.",
                              ja: "リアルタイム作業台のサイドバーと同じ設定です。入力元が純テキスト Transcript ではなくマイクやシステム音声の場合、左側に声紋分離状態が表示され、保存後すぐ反映されます。",
                            })}
                          </p>
                        </div>
                      ) : null}
                    </div>
                    </>
                      );
                    })()}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <RealtimeDefaultConfig
        runtimeOptions={runtimeOptions.data}
        datasetVersions={datasetsCatalog.data ?? []}
        datasetVersion={datasetsCatalog.data?.[0]?.slug || ""}
        setDatasetVersion={() => undefined}
        gateLabel={selectedGateProfile?.label || null}
        gateModel={gateModel}
        plannerLabel={selectedPlannerProfile?.label || null}
        plannerModel={plannerModel}
        sttLabel={selectedSttProfile?.label || null}
        sttModel={sttModel}
        diagramMode={diagramMode}
      />

      <Card className="soft-enter soft-enter-delay-2 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-theme-subtle bg-surface-muted text-theme-2">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold text-theme-1">
              {tr({ zh: "默认运行参数", en: "Default Runtime Parameters", es: "Parámetros predeterminados", pt: "Parâmetros padrão", de: "Standard-Laufzeitparameter", ja: "既定実行パラメータ" })}
            </div>
            <div className="mt-1 text-sm text-theme-4">
              {tr({
                zh: "这些默认值会保存在当前浏览器，用于新建实时会话。",
                en: "These defaults are saved in this browser and used for new realtime sessions.",
                es: "Estos valores se guardan en este navegador y se usan para nuevas sesiones en tiempo real.",
                pt: "Esses padrões são salvos neste navegador e usados em novas sessões em tempo real.",
                de: "Diese Standardwerte werden in diesem Browser gespeichert und für neue Echtzeit-Sitzungen verwendet.",
                ja: "これらの既定値はこのブラウザに保存され、新しいリアルタイムセッションで使用されます。",
              })}
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-7">
          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">Gate Profile</label>
            <select
              className={selectClassName(!hasGateProfiles)}
              value={gateProfileId}
              disabled={!hasGateProfiles}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setGateProfileId(event.target.value)}
            >
              {hasGateProfiles ? (
                (runtimeOptions.data?.gate_profiles || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ) : (
                <option value="">
                  {tr({ zh: "未配置 Gate profile", en: "No Gate profile configured", es: "Sin perfil Gate configurado", pt: "Nenhum perfil Gate configurado", de: "Kein Gate-Profil konfiguriert", ja: "Gate profile 未設定" })}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">Gate Model</label>
            <select
              className={selectClassName(!gateModelOptions.length)}
              value={gateModel}
              disabled={!gateModelOptions.length}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setGateModel(event.target.value)}
            >
              {gateModelOptions.length ? (
                gateModelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))
              ) : (
                <option value="">
                  {hasGateProfiles
                    ? tr({ zh: "当前 profile 无模型", en: "Current profile has no models", es: "El perfil actual no tiene modelos", pt: "O profile atual não tem modelos", de: "Aktuelles Profil hat keine Modelle", ja: "現在の profile にモデルがありません" })
                    : tr({ zh: "等待 Gate profile", en: "Waiting for Gate profile", es: "Esperando perfil Gate", pt: "Aguardando profile Gate", de: "Wartet auf Gate-Profil", ja: "Gate profile 待ち" })}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">Planner Profile</label>
            <select
              className={selectClassName(!hasPlannerProfiles)}
              value={plannerProfileId}
              disabled={!hasPlannerProfiles}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setPlannerProfileId(event.target.value)}
            >
              {hasPlannerProfiles ? (
                (runtimeOptions.data?.planner_profiles || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ) : (
                <option value="">
                  {tr({ zh: "未配置 Planner profile", en: "No Planner profile configured", es: "Sin perfil Planner configurado", pt: "Nenhum perfil Planner configurado", de: "Kein Planner-Profil konfiguriert", ja: "Planner profile 未設定" })}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">Planner Model</label>
            <select
              className={selectClassName(!plannerModelOptions.length)}
              value={plannerModel}
              disabled={!plannerModelOptions.length}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setPlannerModel(event.target.value)}
            >
              {plannerModelOptions.length ? (
                plannerModelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))
              ) : (
                <option value="">
                  {hasPlannerProfiles
                    ? tr({ zh: "当前 profile 无模型", en: "Current profile has no models", es: "El perfil actual no tiene modelos", pt: "O profile atual não tem modelos", de: "Aktuelles Profil hat keine Modelle", ja: "現在の profile にモデルがありません" })
                    : tr({ zh: "等待 Planner profile", en: "Waiting for Planner profile", es: "Esperando perfil Planner", pt: "Aguardando profile Planner", de: "Wartet auf Planner-Profil", ja: "Planner profile 待ち" })}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">STT Profile</label>
            <select
              className={selectClassName(!hasSttProfiles)}
              value={sttProfileId}
              disabled={!hasSttProfiles}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setSttProfileId(event.target.value)}
            >
              {hasSttProfiles ? (
                (runtimeOptions.data?.stt_profiles || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ) : (
                <option value="">
                  {tr({ zh: "未配置 STT profile", en: "No STT profile configured", es: "Sin perfil STT configurado", pt: "Nenhum perfil STT configurado", de: "Kein STT-Profil konfiguriert", ja: "STT profile 未設定" })}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">STT Model</label>
            <select
              className={selectClassName(!sttModelOptions.length)}
              value={sttModel}
              disabled={!sttModelOptions.length}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setSttModel(event.target.value)}
            >
              {sttModelOptions.length ? (
                sttModelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))
              ) : (
                <option value="">
                  {hasSttProfiles
                    ? tr({ zh: "当前 profile 无模型", en: "Current profile has no models", es: "El perfil actual no tiene modelos", pt: "O profile atual não tem modelos", de: "Aktuelles Profil hat keine Modelle", ja: "現在の profile にモデルがありません" })
                    : tr({ zh: "等待 STT profile", en: "Waiting for STT profile", es: "Esperando perfil STT", pt: "Aguardando profile STT", de: "Wartet auf STT-Profil", ja: "STT profile 待ち" })}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">
              {tr({ zh: "视图模式", en: "View Mode", es: "Modo de vista", pt: "Modo de visualização", de: "Ansichtsmodus", ja: "表示モード" })}
            </label>
            <select
              className={selectClassName(false)}
              value={diagramMode}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setDiagramMode(event.target.value === "dual_view" ? "dual_view" : "mermaid_primary")
              }
            >
              <option value="mermaid_primary">
                {tr({ zh: "Mermaid 主视图", en: "Mermaid Main View", es: "Vista principal Mermaid", pt: "Vista principal Mermaid", de: "Mermaid-Hauptansicht", ja: "Mermaid メインビュー" })}
              </option>
              <option value="dual_view">
                {tr({ zh: "Mermaid + 结构视图", en: "Mermaid + Structure View", es: "Mermaid + vista estructural", pt: "Mermaid + visualização estrutural", de: "Mermaid + Strukturansicht", ja: "Mermaid + 構造ビュー" })}
              </option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {summary.map((item) => (
            <div key={item.label} className="rounded-lg border border-theme-default bg-surface-muted px-4 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">{item.label}</div>
              <div className="mt-2 text-sm font-semibold leading-snug text-theme-1">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="soft-enter soft-enter-delay-2 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-theme-1">
              {tr({ zh: "声纹库管理", en: "Voiceprint Library", es: "Biblioteca de huellas de voz", pt: "Biblioteca de voz", de: "Stimmabdruck-Bibliothek", ja: "声紋ライブラリ" })}
            </div>
            <p className="mt-2 text-sm leading-6 text-theme-4">
              {tr({
                zh: "为某个 STT profile 注册多位说话人的声纹特征。实时 API STT 上传时，RTASR 会优先做角色分离，并尽量把角色映射到已注册声纹。",
                en: "Register voiceprint features for speakers under an STT profile. Realtime API STT prefers speaker separation and maps roles to registered voiceprints when possible.",
                es: "Registra huellas de voz de hablantes en un perfil STT. La API STT en tiempo real prioriza separar hablantes y mapear roles a huellas registradas.",
                pt: "Registre características de voz de falantes em um perfil STT. A API STT em tempo real prioriza separar falantes e mapear papéis para vozes registradas.",
                de: "Registriere Stimmabdruck-Merkmale für Sprecher in einem STT-Profil. Die Echtzeit-STT-API bevorzugt Sprechertrennung und ordnet Rollen registrierten Stimmabdrücken zu.",
                ja: "STT profile に話者の声紋特徴を登録します。リアルタイム API STT は話者分離を優先し、可能な場合は登録済み声紋へ役割を対応付けます。",
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className={selectClassName(!adminRuntimeOptions.data?.stt_profiles.length)}
              value={voiceprintProfileId}
              disabled={!adminRuntimeOptions.data?.stt_profiles.length}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setVoiceprintProfileId(event.target.value)}
            >
              {(adminRuntimeOptions.data?.stt_profiles || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              onClick={() => {
                setVoiceprintFeedback(null);
                syncVoiceprintGroupMutation.mutate();
              }}
              disabled={
                !voiceprintProfileId ||
                !managedVoiceprintProfile?.voiceprint?.enabled ||
                syncVoiceprintGroupMutation.isPending
              }
            >
              <RefreshCcw className="h-4 w-4" />
              {syncVoiceprintGroupMutation.isPending
                ? tr({ zh: "同步中...", en: "Syncing...", es: "Sincronizando...", pt: "Sincronizando...", de: "Synchronisiert...", ja: "同期中..." })
                : tr({ zh: "同步 / 创建远端组", en: "Sync / Create Remote Group", es: "Sincronizar / crear grupo remoto", pt: "Sincronizar / criar grupo remoto", de: "Remote-Gruppe synchronisieren / erstellen", ja: "リモートグループ同期 / 作成" })}
            </Button>
          </div>
        </div>

        {voiceprintFeedback ? (
          <div className="rounded-[20px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {voiceprintFeedback}
          </div>
        ) : null}

        {!managedVoiceprintProfile?.voiceprint?.enabled ? (
          <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-5 text-sm text-theme-4">
            {tr({
              zh: "当前选中的 STT profile 还没有启用声纹增强。先在上方 STT Profile 里打开“角色分离 / 声纹增强”，填好讯飞配置并保存。",
              en: "The selected STT profile has not enabled voiceprint enhancement. Enable Speaker Separation / Voiceprint above, fill the XFYUN configuration, and save.",
              es: "El perfil STT seleccionado no tiene huella de voz activada. Activa Separación de hablantes / voz arriba, completa XFYUN y guarda.",
              pt: "O perfil STT selecionado ainda não ativou voz. Ative Separação de falantes / voz acima, preencha XFYUN e salve.",
              de: "Das ausgewählte STT-Profil hat Stimmabdruck noch nicht aktiviert. Aktiviere oben Sprechertrennung / Stimmabdruck, fülle XFYUN aus und speichere.",
              ja: "選択した STT profile は声紋拡張が有効ではありません。上の話者分離 / 声紋を有効にし、XFYUN 設定を入力して保存してください。",
            })}
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-lg border border-theme-default bg-surface-muted px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">Group ID</div>
                <div className="mt-2 text-sm font-semibold text-theme-1">
                  {String(managedVoiceprintProfile.voiceprint?.group_id || "-")}
                </div>
              </div>
              <div className="rounded-lg border border-theme-default bg-surface-muted px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">Threshold</div>
                <div className="mt-2 text-sm font-semibold text-theme-1">
                  {String(managedVoiceprintProfile.voiceprint?.score_threshold ?? 0.75)}
                </div>
              </div>
              <div className="rounded-lg border border-theme-default bg-surface-muted px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">Top K</div>
                <div className="mt-2 text-sm font-semibold text-theme-1">
                  {String(managedVoiceprintProfile.voiceprint?.top_k ?? 3)}
                </div>
              </div>
              <div className="rounded-lg border border-theme-default bg-surface-muted px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">
                  {tr({ zh: "已注册特征", en: "Registered Features", es: "Características registradas", pt: "Recursos registrados", de: "Registrierte Merkmale", ja: "登録済み特徴" })}
                </div>
                <div className="mt-2 text-sm font-semibold text-theme-1">
                  {voiceprintFeaturesQuery.data?.length ?? 0}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-theme-default bg-surface-muted p-4">
              <div className="text-sm font-semibold text-theme-1">
                {tr({ zh: "注册新说话人特征", en: "Register New Speaker Feature", es: "Registrar nueva huella de hablante", pt: "Registrar novo recurso de falante", de: "Neues Sprechermerkmal registrieren", ja: "新しい話者特徴を登録" })}
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-theme-2">Speaker Label</label>
                  <Input variant="dark" value={speakerLabel} onChange={(event: ChangeEvent<HTMLInputElement>) => setSpeakerLabel(event.target.value)} placeholder="例如 张三" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-theme-2">Feature Info</label>
                  <Input variant="dark" value={featureInfo} onChange={(event: ChangeEvent<HTMLInputElement>) => setFeatureInfo(event.target.value)} placeholder="可选，默认同 speaker label" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium text-theme-2">样本音频</label>
                  <Input variant="dark"
                    type="file"
                    accept="audio/*"
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setEnrollmentFile(event.target.files?.[0] || null)
                    }
                  />
                  <p className="text-xs leading-6 text-theme-4">浏览器会先把上传音频转成 16k 单声道 PCM，再由后端转成讯飞要求的 mp3 进行注册。</p>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  onClick={() => {
                    setVoiceprintFeedback(null);
                    createVoiceprintFeatureMutation.mutate();
                  }}
                  disabled={
                    createVoiceprintFeatureMutation.isPending ||
                    !speakerLabel.trim() ||
                    !enrollmentFile ||
                    !voiceprintProfileId
                  }
                >
                  {createVoiceprintFeatureMutation.isPending ? "注册中..." : "注册声纹特征"}
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-theme-default bg-surface-muted p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-theme-1">已注册说话人</div>
                  <div className="mt-1 text-xs leading-6 text-theme-4">删除后不会影响普通 STT，只会停止该说话人的声纹命中。</div>
                </div>
                <Badge>{voiceprintFeaturesQuery.data?.length ?? 0} features</Badge>
              </div>

              <div className="space-y-3">
                {(voiceprintFeaturesQuery.data || []).length ? (
                  (voiceprintFeaturesQuery.data || []).map((item) => (
                    <div key={item.feature_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-theme-default bg-surface-1 px-4 py-3">
                      <div>
                        <div className="text-sm font-semibold text-theme-1">{item.speaker_label}</div>
                        <div className="mt-1 text-xs leading-6 text-theme-4">
                          feature_id: {item.feature_id} · status: {item.status}
                        </div>
                        <div className="text-xs leading-6 text-theme-4">{item.feature_info || "无额外描述"}</div>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setVoiceprintFeedback(null);
                          deleteVoiceprintFeatureMutation.mutate(item.feature_id);
                        }}
                        disabled={deleteVoiceprintFeatureMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                        删除
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-5 text-sm text-theme-4">
                    还没有注册任何声纹特征。先同步远端组，再上传几段说话人样本音频。
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
