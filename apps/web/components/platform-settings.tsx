"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Plus, RefreshCcw, Save, Settings2, Trash2 } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

import { ApiError, api } from "@/lib/api";
import { decodeAudioFileToVoiceprintPayload } from "@/lib/audio";
import { loadRuntimePreferences, resolveRuntimePreferences, saveRuntimePreferences } from "@/lib/runtime-preferences";
import { RealtimeDefaultConfig } from "@/components/realtime-default-config";

type AdminRuntimeOptions = Awaited<ReturnType<typeof api.getAdminRuntimeOptions>>;
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

const DEFAULT_OPENAI_BASE = "https://api.openai.com";
const DEFAULT_XFYUN_ASR_ENDPOINT = "wss://iat-api.xfyun.cn/v2/iat";
const DEFAULT_XFYUN_ASR_MODELS = ["iat", "xfime-mianqie"];
const MODEL_PROVIDER_KIND_OPTIONS: Array<{ value: ProviderKind; label: string }> = [
  { value: "openai_compatible", label: "OpenAI Compatible" },
  { value: "xfyun_asr", label: "讯飞语音听写" },
];
const DEFAULT_VOICEPRINT_BASE = "https://api.xf-yun.com";
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
  return `h-10 w-full rounded-lg border border-slate-300 bg-[rgba(245,246,248,0.96)] px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 ${
    disabled ? "cursor-not-allowed opacity-55" : ""
  }`;
}

function blankProfile(prefix: "gate" | "planner" | "stt", index: number): ProfileDraft {
  return {
    id: `${prefix}-${index}`,
    label: "",
    endpointBase: prefix === "stt" ? DEFAULT_XFYUN_ASR_ENDPOINT : DEFAULT_OPENAI_BASE,
    endpointRouteMode: prefix === "stt" ? "custom" : "chat_completions",
    customEndpointPath: "",
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

function normalizeEndpointBase(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return DEFAULT_OPENAI_BASE;
  return trimmed.replace(/\/v1$/i, "") || DEFAULT_OPENAI_BASE;
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
) {
  return [
    { label: "Gate", value: gateLabel ? `${gateLabel} / ${gateModel || "未选择模型"}` : "未配置" },
    { label: "Planner", value: plannerLabel ? `${plannerLabel} / ${plannerModel || "未选择模型"}` : "未配置" },
    { label: "STT", value: sttLabel ? `${sttLabel} / ${sttModel || "未选择模型"}` : "未配置" },
    { label: "视图", value: diagramMode === "dual_view" ? "Mermaid + 结构视图" : "Mermaid 主视图" },
  ];
}

export function PlatformSettings() {
  const queryClient = useQueryClient();
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
  const authUnauthorized = authQuery.error instanceof ApiError && authQuery.error.status === 401;

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
      setGateDrafts(
        payload.gate_profiles.length
          ? payload.gate_profiles.map((profile) => profileToDraft("gate", profile))
          : [blankProfile("gate", 1)],
      );
      setPlannerDrafts(
        payload.planner_profiles.length
          ? payload.planner_profiles.map((profile) => profileToDraft("planner", profile))
          : [blankProfile("planner", 1)],
      );
      setSttDrafts(
        payload.stt_profiles.length
          ? payload.stt_profiles.map((profile) => profileToDraft("stt", profile))
          : [blankProfile("stt", 1)],
      );
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
      ),
    [diagramMode, gateModel, plannerModel, selectedGateProfile, selectedPlannerProfile, selectedSttProfile, sttModel],
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">设置</h1>
        <Link href="/app/realtime">
          <Button variant="secondary">
            返回实时工作
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>

      <Card className="soft-enter space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-zinc-100">服务端模型配置</div>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              保存后直接写入服务端。实时工作与样本页都会用这里的 Gate、Planner 和听写服务。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge>
              {!adminReady ? "身份确认中" : adminRuntimeOptions.isFetching ? "读取中" : "服务端持久化"}
            </Badge>
            <Button
              onClick={() => saveProfilesMutation.mutate()}
              disabled={!adminReady || saveProfilesMutation.isPending}
            >
              <Save className="h-4 w-4" />
              {saveProfilesMutation.isPending ? "保存中..." : "保存服务端配置"}
            </Button>
          </div>
        </div>

        {authQuery.isLoading ? (
          <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-500">
            正在确认管理员登录状态…
          </div>
        ) : null}
        {authUnauthorized ? (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/35 px-4 py-3 text-sm leading-relaxed text-amber-100">
            <p>未登录或会话已过期，无法读写服务端模型配置。</p>
            <Link
              href="/login"
              className="mt-2 inline-flex items-center gap-1 font-medium text-amber-50 underline underline-offset-4 hover:text-white"
            >
              前往管理员登录
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : null}
        {!adminReady && authQuery.isError && !authUnauthorized ? (
          <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {(authQuery.error as Error).message}
          </div>
        ) : null}
        {!adminReady && authQuery.isSuccess && !authUnauthorized ? (
          <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-500">
            正在启用服务端配置…
          </div>
        ) : null}

        {saveProfilesMutation.isError ? (
          <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {(saveProfilesMutation.error as Error).message}
          </div>
        ) : null}
        {probeFeedback ? (
          <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-300">
            {probeFeedback}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          {[
            { kind: "gate" as const, title: "Gate 配置", drafts: gateDrafts },
            { kind: "planner" as const, title: "Planner 配置", drafts: plannerDrafts },
            { kind: "stt" as const, title: "听写服务配置", drafts: sttDrafts },
          ].map((group) => (
            <div key={group.kind} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-zinc-200">{group.title}</div>
                <Button variant="secondary" onClick={() => addDraft(group.kind)}>
                  <Plus className="h-4 w-4" />
                  添加
                </Button>
              </div>

              <div className="space-y-4">
                {group.drafts.map((draft, index) => (
                  <div key={`${group.kind}-${index}`} className="rounded-xl border border-zinc-800 bg-zinc-950/55 p-4">
                    {(() => {
                      const resolvedEndpoint = resolveEndpoint(group.kind, draft);
                      const draftModelOptions = modelOptionsFromDraft(draft);
                      const isXfyunStt = group.kind === "stt" && draft.providerKind === "xfyun_asr";
                      const selectedRoute = ENDPOINT_ROUTE_OPTIONS[group.kind].find(
                        (option) => option.value === draft.endpointRouteMode,
                      );

                      return (
                    <>
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-zinc-100">
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
                          {probeModelsMutation.isPending ? "处理中..." : isXfyunStt ? "填充预设" : "探测模型"}
                        </Button>
                        <Button variant="ghost" onClick={() => removeDraft(group.kind, index)}>
                          <Trash2 className="h-4 w-4" />
                          删除
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">Profile ID</label>
                        <Input variant="light"
                          value={draft.id}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { id: event.target.value })
                          }
                          placeholder={`${group.kind}-profile`}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">显示名称</label>
                        <Input variant="light"
                          value={draft.label}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { label: event.target.value })
                          }
                          placeholder="例如 OpenAI Primary"
                        />
                      </div>
                      {isXfyunStt ? (
                        <>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700">Provider Kind</label>
                            <Input variant="light" value="xfyun_asr" readOnly />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700">App ID</label>
                            <Input variant="light"
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
                            <label className="text-sm font-medium text-slate-700">Endpoint Base</label>
                            <Input variant="light"
                              value={draft.endpointBase}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { endpointBase: event.target.value })
                              }
                              placeholder={DEFAULT_OPENAI_BASE}
                            />
                            <p className="text-xs leading-6 text-slate-500">
                              默认使用 OpenAI 基座地址，`/v1` 之后的路径由下方选项自动补全。
                            </p>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700">Provider Kind</label>
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
                            <label className="text-sm font-medium text-slate-700">Endpoint 路径</label>
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
                            <p className="text-xs leading-6 text-slate-500">
                              {selectedRoute?.path
                                ? `当前会自动补全为 ${selectedRoute.path}`
                                : "当前使用自定义路径。"}
                            </p>
                          </div>
                          {draft.endpointRouteMode === "custom" ? (
                            <div className="space-y-2 md:col-span-2">
                              <label className="text-sm font-medium text-slate-700">自定义路径</label>
                              <Input variant="light"
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
                        <label className="text-sm font-medium text-slate-700">最终 Endpoint</label>
                        <Input variant="light" value={resolvedEndpoint} readOnly />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">API Key</label>
                        <Input variant="light"
                          type="password"
                          value={draft.apiKey}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { apiKey: event.target.value })
                          }
                          placeholder="直接保存到服务端"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">API Key Env</label>
                        <Input variant="light"
                          value={draft.apiKeyEnv}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { apiKeyEnv: event.target.value })
                          }
                          placeholder={isXfyunStt ? "可选，例如 XFYUN_API_KEY" : "可选，例如 OPENAI_API_KEY"}
                        />
                      </div>
                      {isXfyunStt ? (
                        <>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700">API Secret</label>
                            <Input variant="light"
                              type="password"
                              value={draft.apiSecret}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { apiSecret: event.target.value })
                              }
                              placeholder="讯飞 API Secret"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-700">API Secret Env</label>
                            <Input variant="light"
                              value={draft.apiSecretEnv}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateDraft(group.kind, index, { apiSecretEnv: event.target.value })
                              }
                              placeholder="可选，例如 XFYUN_API_SECRET"
                            />
                          </div>
                        </>
                      ) : null}
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">
                          {isXfyunStt ? "默认识别域" : "Default Model"}
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
                            <option value="">先填写或探测模型列表</option>
                          )}
                        </select>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-sm font-medium text-slate-700">
                          {isXfyunStt ? "识别域列表" : "模型列表"}
                        </label>
                        <Textarea variant="light"
                          rows={4}
                          value={draft.modelsText}
                          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                            updateDraft(group.kind, index, { modelsText: event.target.value })
                          }
                          placeholder="每行一个模型，或用逗号分隔"
                        />
                        <p className="text-xs leading-6 text-slate-500">
                          {isXfyunStt
                            ? "默认内置讯飞听写识别域，可直接保存，也可以点“填充预设”恢复默认列表。"
                            : "可以手动填写，也可以先填好 Endpoint 和 API Key，再点“探测模型”自动回填。"}
                        </p>
                      </div>
                      {group.kind === "stt" ? (
                        <div className="space-y-4 md:col-span-2 rounded-[20px] border border-emerald-100 bg-emerald-50/70 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">声纹盲认增强</div>
                              <p className="mt-1 text-xs leading-6 text-slate-500">
                                对 STT 音频块额外调用讯飞声纹 1:N 盲认，命中后自动回写 speaker。
                              </p>
                            </div>
                            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                              <input
                                type="checkbox"
                                checked={draft.voiceprint.enabled}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateDraft(group.kind, index, {
                                    voiceprint: { ...draft.voiceprint, enabled: event.target.checked },
                                  })
                                }
                              />
                              启用
                            </label>
                          </div>
                          <div className="rounded-[18px] border border-emerald-100 bg-white/70 px-4 py-3 text-sm leading-6 text-slate-600">
                            开启后会自动复用当前 STT Profile 的讯飞凭证，并使用内置默认参数完成多人声纹盲认。
                          </div>
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
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900/50 text-zinc-300">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold text-zinc-100">默认运行参数</div>
            <div className="mt-1 text-sm text-zinc-500">这些默认值会保存在当前浏览器，用于新建实时会话。</div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-7">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Gate Profile</label>
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
                <option value="">未配置 Gate profile</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Gate Model</label>
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
                <option value="">{hasGateProfiles ? "当前 profile 无模型" : "等待 Gate profile"}</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Planner Profile</label>
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
                <option value="">未配置 Planner profile</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Planner Model</label>
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
                <option value="">{hasPlannerProfiles ? "当前 profile 无模型" : "等待 Planner profile"}</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">STT Profile</label>
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
                <option value="">未配置 STT profile</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">STT Model</label>
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
                <option value="">{hasSttProfiles ? "当前 profile 无模型" : "等待 STT profile"}</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">视图模式</label>
            <select
              className={selectClassName(false)}
              value={diagramMode}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setDiagramMode(event.target.value === "dual_view" ? "dual_view" : "mermaid_primary")
              }
            >
              <option value="mermaid_primary">Mermaid 主视图</option>
              <option value="dual_view">Mermaid + 结构视图</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {summary.map((item) => (
            <div key={item.label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{item.label}</div>
              <div className="mt-2 text-sm font-semibold leading-snug text-zinc-100">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="soft-enter soft-enter-delay-2 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-zinc-100">声纹库管理</div>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              为某个 STT profile 注册多位说话人的声纹特征。实时 API STT 上传后会先转写，再做 1:N 盲认并回写 speaker。
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
              {syncVoiceprintGroupMutation.isPending ? "同步中..." : "同步 / 创建远端组"}
            </Button>
          </div>
        </div>

        {voiceprintFeedback ? (
          <div className="rounded-[20px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {voiceprintFeedback}
          </div>
        ) : null}

        {!managedVoiceprintProfile?.voiceprint?.enabled ? (
          <div className="rounded-lg border border-dashed border-zinc-700 px-4 py-5 text-sm text-zinc-500">
            当前选中的 STT profile 还没有启用声纹盲认。先在上方 STT Profile 里打开“声纹盲认增强”，填好讯飞配置并保存。
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Group ID</div>
                <div className="mt-2 text-sm font-semibold text-zinc-100">
                  {String(managedVoiceprintProfile.voiceprint?.group_id || "-")}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Threshold</div>
                <div className="mt-2 text-sm font-semibold text-zinc-100">
                  {String(managedVoiceprintProfile.voiceprint?.score_threshold ?? 0.75)}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Top K</div>
                <div className="mt-2 text-sm font-semibold text-zinc-100">
                  {String(managedVoiceprintProfile.voiceprint?.top_k ?? 3)}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">已注册特征</div>
                <div className="mt-2 text-sm font-semibold text-zinc-100">
                  {voiceprintFeaturesQuery.data?.length ?? 0}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
              <div className="text-sm font-semibold text-zinc-100">注册新说话人特征</div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Speaker Label</label>
                  <Input variant="light" value={speakerLabel} onChange={(event: ChangeEvent<HTMLInputElement>) => setSpeakerLabel(event.target.value)} placeholder="例如 张三" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Feature Info</label>
                  <Input variant="light" value={featureInfo} onChange={(event: ChangeEvent<HTMLInputElement>) => setFeatureInfo(event.target.value)} placeholder="可选，默认同 speaker label" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium text-zinc-300">样本音频</label>
                  <Input variant="light"
                    type="file"
                    accept="audio/*"
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setEnrollmentFile(event.target.files?.[0] || null)
                    }
                  />
                  <p className="text-xs leading-6 text-zinc-500">浏览器会先把上传音频转成 16k 单声道 PCM，再由后端转成讯飞要求的 mp3 进行注册。</p>
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

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">已注册说话人</div>
                  <div className="mt-1 text-xs leading-6 text-zinc-500">删除后不会影响普通 STT，只会停止该说话人的声纹命中。</div>
                </div>
                <Badge>{voiceprintFeaturesQuery.data?.length ?? 0} features</Badge>
              </div>

              <div className="space-y-3">
                {(voiceprintFeaturesQuery.data || []).length ? (
                  (voiceprintFeaturesQuery.data || []).map((item) => (
                    <div key={item.feature_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-slate-200 bg-white px-4 py-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{item.speaker_label}</div>
                        <div className="mt-1 text-xs leading-6 text-slate-500">
                          feature_id: {item.feature_id} · status: {item.status}
                        </div>
                        <div className="text-xs leading-6 text-slate-500">{item.feature_info || "无额外描述"}</div>
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
                  <div className="rounded-lg border border-dashed border-zinc-700 px-4 py-5 text-sm text-zinc-500">
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
