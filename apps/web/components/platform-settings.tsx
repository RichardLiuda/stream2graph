"use client";

// 平台设置组件：管理API密钥、模型配置、语音识别等系统设置

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Globe2, Plus, RefreshCcw, Save, Settings2, Trash2 } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

import { ApiError, api } from "@/lib/api";
import { decodeAudioFileToVoiceprintPayload } from "@/lib/audio";
import {
  LANGUAGE_OPTIONS,
  translate,
  useLanguagePreference,
  type I18nKey,
  type LanguagePreference,
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
const MODEL_PROVIDER_KIND_OPTIONS: Array<{ value: ProviderKind; labelKey: I18nKey }> = [
  { value: "openai_compatible", labelKey: "platformSettings.modelProvider.openaiCompatible" },
  { value: "xfyun_asr", labelKey: "platformSettings.modelProvider.xfyunRtasrLlm" },
];
const DEFAULT_VOICEPRINT_BASE = "https://office-api-personal-dx.iflyaisol.com";
const ENDPOINT_ROUTE_OPTIONS: Record<
  "gate" | "planner" | "stt",
  Array<{ value: EndpointRouteMode; label?: string; labelKey?: I18nKey; path: string }>
> = {
  gate: [
    { value: "chat_completions", label: "/v1/chat/completions", path: "/v1/chat/completions" },
    { value: "custom", labelKey: "platformSettings.endpointRoute.customPath", path: "" },
  ],
  planner: [
    { value: "chat_completions", label: "/v1/chat/completions", path: "/v1/chat/completions" },
    { value: "custom", labelKey: "platformSettings.endpointRoute.customPath", path: "" },
  ],
  stt: [
    { value: "custom", labelKey: "platformSettings.endpointRoute.xfyunFixedAddress", path: "" },
  ],
};

function selectClassName(disabled = false) {
  return `select-control ${disabled ? "cursor-not-allowed opacity-55" : ""}`;
}

function t(language: LanguagePreference, key: I18nKey, params?: Record<string, string | number>) {
  return translate(language, key, params);
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
  const notConfigured = t(language, "realtimeDefaultConfig.text012");
  const noModel = t(language, "realtimeDefaultConfig.text011");
  return [
    { label: "Gate", value: gateLabel ? `${gateLabel} / ${gateModel || noModel}` : notConfigured },
    { label: "Planner", value: plannerLabel ? `${plannerLabel} / ${plannerModel || noModel}` : notConfigured },
    { label: "STT", value: sttLabel ? `${sttLabel} / ${sttModel || noModel}` : notConfigured },
    {
      label: t(language, "platformSettings.text001"),
      value:
        diagramMode === "dual_view"
          ? t(language, "platformSettings.text002")
          : t(language, "platformSettings.text003"),
    },
  ];
}

export function PlatformSettings() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = useLanguagePreference();
  const tr = (key: I18nKey, params?: Record<string, string | number>) => t(language, key, params);
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
      setProbeFeedback(
        tr("platformSettings.feedback.modelsProbed", {
          count: result.models.length,
          endpoint: result.models_endpoint,
        }),
      );
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
      setVoiceprintFeedback(
        tr("platformSettings.voiceprint.groupSynced", {
          groupId: payload.group.group_id,
          count: payload.remote_features.length,
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["voiceprint-features", voiceprintProfileId] });
    },
    onError: (error) => setVoiceprintFeedback((error as Error).message),
  });

  const createVoiceprintFeatureMutation = useMutation({
    mutationFn: async () => {
      if (!enrollmentFile) {
        throw new Error(tr("platformSettings.voiceprint.selectSampleError"));
      }
      if (!speakerLabel.trim()) {
        throw new Error(tr("platformSettings.voiceprint.speakerRequiredError"));
      }
      const audioPayload = await decodeAudioFileToVoiceprintPayload(enrollmentFile);
      return api.createVoiceprintFeature(voiceprintProfileId, {
        speaker_label: speakerLabel.trim(),
        feature_info: featureInfo.trim() || speakerLabel.trim(),
        ...audioPayload,
      });
    },
    onSuccess: () => {
      setVoiceprintFeedback(tr("platformSettings.voiceprint.featureRegistered", { speaker: speakerLabel.trim() }));
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
      setVoiceprintFeedback(tr("platformSettings.voiceprint.featureDeleted"));
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
          {tr("platformSettings.text004")}
        </h1>
        <Link href="/app/realtime" className="shrink-0">
          <Button variant="secondary">
            {tr("platformSettings.text005")}
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
                {tr("platformSettings.text006")}
              </div>
              <p className="mt-2 text-sm leading-6 text-theme-4">
                {tr("platformSettings.text007")}
              </p>
            </div>
          </div>
          <div className="w-full max-w-xs">
            <label className="sr-only" htmlFor="s2g-language-select">
              {tr("platformSettings.text006")}
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
              {tr("platformSettings.text008")}
            </div>
            <p className="mt-2 text-sm leading-6 text-theme-4">
              {tr("platformSettings.text009")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge>
              {!adminReady
                ? tr("platformSettings.text010")
                : adminRuntimeOptions.isFetching
                  ? tr("platformSettings.text011")
                  : tr("platformSettings.text012")}
            </Badge>
            <Button
              onClick={() => saveProfilesMutation.mutate()}
              disabled={!adminReady || saveProfilesMutation.isPending}
            >
              <Save className="h-4 w-4" />
              {saveProfilesMutation.isPending
                ? tr("platformSettings.text013")
                : tr("platformSettings.text014")}
            </Button>
          </div>
        </div>

        {authQuery.isLoading ? (
          <div className="rounded-lg border border-theme-subtle bg-surface-muted px-4 py-3 text-sm text-theme-4">
            {tr("platformSettings.text015")}
          </div>
        ) : null}
        {adminLoggedOut ? (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/35 px-4 py-3 text-sm leading-relaxed text-amber-100">
            <p>
              {tr("platformSettings.text016")}
            </p>
            <Link
              href="/login"
              className="mt-2 inline-flex items-center gap-1 font-medium text-amber-200 underline underline-offset-4 theme-light:text-amber-900 hover:text-theme-1"
            >
              {tr("platformSettings.text017")}
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
            {tr("platformSettings.text018")}
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
              title: tr("platformSettings.text019"),
              drafts: gateDrafts,
            },
            {
              kind: "planner" as const,
              title: tr("platformSettings.text020"),
              drafts: plannerDrafts,
            },
            {
              kind: "stt" as const,
              title: tr("platformSettings.text021"),
              drafts: sttDrafts,
            },
          ].map((group) => (
            <div key={group.kind} className="space-y-4 rounded-xl border border-theme-default bg-surface-muted p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-theme-2">{group.title}</div>
                <Button variant="secondary" onClick={() => addDraft(group.kind)}>
                  <Plus className="h-4 w-4" />
                  {tr("platformSettings.text022")}
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
                            ? tr("platformSettings.text023")
                            : isXfyunStt
                              ? tr("platformSettings.text024")
                              : tr("platformSettings.text025")}
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
                            ? tr("platformSettings.text026")
                            : tr("platformSettings.text027")}
                        </Button>
                        <Button variant="ghost" onClick={() => removeDraft(group.kind, index)}>
                          <Trash2 className="h-4 w-4" />
                          {tr("platformSettings.text028")}
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
                            ? tr("platformSettings.text029")
                            : tr("platformSettings.text030")}
                        </div>
                        <div className="mt-1 text-sm leading-6 text-zinc-200">{connectionResult.summary}</div>
                        {connectionResult.logs.length ? (
                          <div className="mt-3 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-3">
                            <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                              {tr("platformSettings.text031")}
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
                          {tr("platformSettings.text032")}
                        </label>
                        <Input variant="dark"
                          value={draft.label}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { label: event.target.value })
                          }
                          placeholder={tr("platformSettings.text033")}
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
                              placeholder={tr("platformSettings.voiceprint.xfyunAppIdPlaceholder")}
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
                              {tr("platformSettings.endpointBaseHelp")}
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
                                  {tr(option.labelKey)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">
                              {tr("platformSettings.text034")}
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
                                  {option.labelKey ? tr(option.labelKey) : option.label}
                                </option>
                              ))}
                            </select>
                            <p className="text-xs leading-6 text-theme-4">
                              {selectedRoute?.path
                                ? `${tr("platformSettings.text035")}${selectedRoute.path}`
                                : tr("platformSettings.text036")}
                            </p>
                          </div>
                          {draft.endpointRouteMode === "custom" ? (
                            <div className="space-y-2 md:col-span-2">
                              <label className="text-sm font-medium text-theme-2">
                                {tr("platformSettings.text037")}
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
                          {tr("platformSettings.text038")}
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
                              <span>{tr("platformSettings.text039")}</span>
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
                          placeholder={tr("platformSettings.text040")}
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
                              ? tr("platformSettings.text041")
                              : tr("platformSettings.text042")
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
                              placeholder={tr("platformSettings.text043")}
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-theme-2">API Secret Env</label>
                            <Input variant="dark"
                              value={draft.apiSecretEnv}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { apiSecretEnv: event.target.value })
                              }
                              placeholder={tr("platformSettings.text044")}
                            />
                          </div>
                        </>
                      ) : null}
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-theme-2">
                          {isXfyunStt
                            ? tr("platformSettings.text045")
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
                              {tr("platformSettings.text046")}
                            </option>
                          )}
                        </select>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-sm font-medium text-theme-2">
                          {isXfyunStt
                            ? tr("platformSettings.text047")
                            : tr("platformSettings.text048")}
                        </label>
                        <Textarea variant="dark"
                          rows={4}
                          value={draft.modelsText}
                          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                            updateDraft(group.kind, index, { modelsText: event.target.value })
                          }
                          placeholder={tr("platformSettings.text049")}
                        />
                        <p className="text-xs leading-6 text-theme-4">
                          {isXfyunStt
                            ? tr("platformSettings.text050")
                            : tr("platformSettings.text051")}
                        </p>
                      </div>
                      {group.kind === "stt" ? (
                        <div className="space-y-4 md:col-span-2 rounded-[20px] border border-emerald-900/45 bg-emerald-950/20 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-theme-1">
                                {tr("platformSettings.text052")}
                              </div>
                              <p className="mt-1 text-xs leading-6 text-theme-4">
                                {tr("platformSettings.text053")}
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
                              {tr("platformSettings.text054")}
                            </label>
                          </div>
                          <div className="rounded-[18px] border border-theme-default bg-surface-muted px-4 py-3 text-sm leading-6 text-theme-3">
                            {tr("platformSettings.text055")}
                          </div>
                          <p className="text-[11px] leading-snug text-theme-4">
                            {tr("platformSettings.text056")}
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
              {tr("platformSettings.text057")}
            </div>
            <div className="mt-1 text-sm text-theme-4">
              {tr("platformSettings.text058")}
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
                  {tr("platformSettings.text059")}
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
                    ? tr("platformSettings.text060")
                    : tr("platformSettings.text061")}
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
                  {tr("platformSettings.text062")}
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
                    ? tr("platformSettings.text060")
                    : tr("platformSettings.text063")}
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
                  {tr("platformSettings.text064")}
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
                    ? tr("platformSettings.text060")
                    : tr("platformSettings.text065")}
                </option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-theme-2">
              {tr("platformSettings.text066")}
            </label>
            <select
              className={selectClassName(false)}
              value={diagramMode}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setDiagramMode(event.target.value === "dual_view" ? "dual_view" : "mermaid_primary")
              }
            >
              <option value="mermaid_primary">
                {tr("platformSettings.text003")}
              </option>
              <option value="dual_view">
                {tr("platformSettings.text002")}
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
              {tr("platformSettings.text067")}
            </div>
            <p className="mt-2 text-sm leading-6 text-theme-4">
              {tr("platformSettings.text068")}
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
                ? tr("platformSettings.text069")
                : tr("platformSettings.text070")}
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
            {tr("platformSettings.text071")}
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
                  {tr("platformSettings.text072")}
                </div>
                <div className="mt-2 text-sm font-semibold text-theme-1">
                  {voiceprintFeaturesQuery.data?.length ?? 0}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-theme-default bg-surface-muted p-4">
              <div className="text-sm font-semibold text-theme-1">
                {tr("platformSettings.text073")}
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-theme-2">Speaker Label</label>
                  <Input
                    variant="dark"
                    value={speakerLabel}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setSpeakerLabel(event.target.value)}
                    placeholder={tr("platformSettings.voiceprint.speakerPlaceholder")}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-theme-2">Feature Info</label>
                  <Input
                    variant="dark"
                    value={featureInfo}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setFeatureInfo(event.target.value)}
                    placeholder={tr("platformSettings.voiceprint.featureInfoPlaceholder")}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium text-theme-2">
                    {tr("platformSettings.voiceprint.sampleAudio")}
                  </label>
                  <Input variant="dark"
                    type="file"
                    accept="audio/*"
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setEnrollmentFile(event.target.files?.[0] || null)
                    }
                  />
                  <p className="text-xs leading-6 text-theme-4">
                    {tr("platformSettings.voiceprint.uploadHelp")}
                  </p>
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
                  {createVoiceprintFeatureMutation.isPending
                    ? tr("platformSettings.voiceprint.registering")
                    : tr("platformSettings.voiceprint.registerFeature")}
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-theme-default bg-surface-muted p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-theme-1">
                    {tr("platformSettings.voiceprint.registeredSpeakers")}
                  </div>
                  <div className="mt-1 text-xs leading-6 text-theme-4">
                    {tr("platformSettings.voiceprint.deleteHelp")}
                  </div>
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
                        <div className="text-xs leading-6 text-theme-4">
                          {item.feature_info || tr("platformSettings.voiceprint.noExtraDescription")}
                        </div>
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
                        {tr("platformSettings.text028")}
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-5 text-sm text-theme-4">
                    {tr("platformSettings.voiceprint.emptyFeatures")}
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
