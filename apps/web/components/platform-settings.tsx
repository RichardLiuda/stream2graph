"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Plus, RefreshCcw, Save, Settings2, Trash2 } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Input, SectionHeading, Textarea } from "@stream2graph/ui";

import { api } from "@/lib/api";
import {
  loadRuntimePreferences,
  resolveRuntimePreferences,
  saveRuntimePreferences,
} from "@/lib/runtime-preferences";

type AdminRuntimeOptions = Awaited<ReturnType<typeof api.getAdminRuntimeOptions>>;
type ProviderKind = "openai_compatible";
type EndpointRouteMode = "chat_completions" | "audio_transcriptions" | "custom";
type ProfileDraft = {
  id: string;
  label: string;
  endpointBase: string;
  endpointRouteMode: EndpointRouteMode;
  customEndpointPath: string;
  apiKey: string;
  apiKeyEnv: string;
  modelsText: string;
  defaultModel: string;
  providerKind: ProviderKind;
};

const DEFAULT_OPENAI_BASE = "https://api.openai.com";
const PROVIDER_KIND_OPTIONS: Array<{ value: ProviderKind; label: string }> = [
  { value: "openai_compatible", label: "OpenAI Compatible" },
];
const ENDPOINT_ROUTE_OPTIONS: Record<
  "llm" | "stt",
  Array<{ value: EndpointRouteMode; label: string; path: string }>
> = {
  llm: [
    { value: "chat_completions", label: "/v1/chat/completions", path: "/v1/chat/completions" },
    { value: "custom", label: "自定义路径", path: "" },
  ],
  stt: [
    { value: "audio_transcriptions", label: "/v1/audio/transcriptions", path: "/v1/audio/transcriptions" },
    { value: "custom", label: "自定义路径", path: "" },
  ],
};

function selectClassName(disabled = false) {
  return `h-12 w-full rounded-[22px] border border-white/70 bg-white/[0.72] px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[rgba(77,124,255,0.12)] ${
    disabled ? "cursor-not-allowed opacity-55" : ""
  }`;
}

function blankProfile(prefix: "llm" | "stt", index: number): ProfileDraft {
  return {
    id: `${prefix}-${index}`,
    label: "",
    endpointBase: DEFAULT_OPENAI_BASE,
    endpointRouteMode: prefix === "llm" ? "chat_completions" : "audio_transcriptions",
    customEndpointPath: "",
    apiKey: "",
    apiKeyEnv: "",
    modelsText: "",
    defaultModel: "",
    providerKind: "openai_compatible",
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

function splitEndpointToDraft(kind: "llm" | "stt", endpoint: string) {
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

function resolveEndpoint(kind: "llm" | "stt", draft: ProfileDraft) {
  const route = ENDPOINT_ROUTE_OPTIONS[kind].find((option) => option.value === draft.endpointRouteMode);
  const base = normalizeEndpointBase(draft.endpointBase);
  const path =
    draft.endpointRouteMode === "custom"
      ? normalizeCustomEndpointPath(draft.customEndpointPath)
      : route?.path || "";
  return `${base}${path}`;
}

function profileToDraft(
  kind: "llm" | "stt",
  profile: AdminRuntimeOptions["llm_profiles"][number],
): ProfileDraft {
  const endpointDraft = splitEndpointToDraft(kind, profile.endpoint);
  return {
    id: profile.id,
    label: profile.label,
    endpointBase: endpointDraft.endpointBase,
    endpointRouteMode: endpointDraft.endpointRouteMode,
    customEndpointPath: endpointDraft.customEndpointPath,
    apiKey: profile.api_key || "",
    apiKeyEnv: profile.api_key_env || "",
    modelsText: profile.models.join("\n"),
    defaultModel: profile.default_model,
    providerKind: profile.provider_kind === "openai_compatible" ? "openai_compatible" : "openai_compatible",
  };
}

function modelOptionsFromDraft(draft: ProfileDraft) {
  return draft.modelsText
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function draftsToPayload(kind: "llm" | "stt", drafts: ProfileDraft[]) {
  return drafts
    .map((item) => ({
      id: item.id.trim(),
      label: item.label.trim() || item.id.trim(),
      endpoint: resolveEndpoint(kind, item),
      api_key: item.apiKey.trim(),
      api_key_env: item.apiKeyEnv.trim(),
      models: modelOptionsFromDraft(item),
      default_model: item.defaultModel.trim(),
      provider_kind: item.providerKind,
    }))
    .filter((item) => item.id && item.endpoint && item.models.length);
}

function summarizeDefaults(
  llmLabel: string | null,
  llmModel: string,
  sttLabel: string | null,
  sttModel: string,
  diagramMode: "mermaid_primary" | "dual_view",
) {
  return [
    { label: "LLM", value: llmLabel ? `${llmLabel} / ${llmModel || "未选择模型"}` : "未配置" },
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
  const adminRuntimeOptions = useQuery({
    queryKey: ["admin-runtime-options"],
    queryFn: api.getAdminRuntimeOptions,
    retry: false,
    enabled: authQuery.isSuccess && authQuery.isFetchedAfterMount,
  });

  const preferenceInitRef = useRef(false);
  const draftsInitRef = useRef(false);
  const [llmProfileId, setLlmProfileId] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [sttProfileId, setSttProfileId] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [diagramMode, setDiagramMode] = useState<"mermaid_primary" | "dual_view">("mermaid_primary");
  const [llmDrafts, setLlmDrafts] = useState<ProfileDraft[]>([]);
  const [sttDrafts, setSttDrafts] = useState<ProfileDraft[]>([]);
  const [probeFeedback, setProbeFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!runtimeOptions.data || preferenceInitRef.current) return;
    const resolved = resolveRuntimePreferences(runtimeOptions.data, loadRuntimePreferences());
    setLlmProfileId(resolved.llmProfileId);
    setLlmModel(resolved.llmModel);
    setSttProfileId(resolved.sttProfileId);
    setSttModel(resolved.sttModel);
    setDiagramMode(resolved.diagramMode);
    preferenceInitRef.current = true;
  }, [runtimeOptions.data]);

  useEffect(() => {
    if (!adminRuntimeOptions.data || draftsInitRef.current) return;
    setLlmDrafts(
      adminRuntimeOptions.data.llm_profiles.length
        ? adminRuntimeOptions.data.llm_profiles.map((profile) => profileToDraft("llm", profile))
        : [blankProfile("llm", 1)],
    );
    setSttDrafts(
      adminRuntimeOptions.data.stt_profiles.length
        ? adminRuntimeOptions.data.stt_profiles.map((profile) => profileToDraft("stt", profile))
        : [blankProfile("stt", 1)],
    );
    draftsInitRef.current = true;
  }, [adminRuntimeOptions.data]);

  const selectedLlmProfile = runtimeOptions.data?.llm_profiles.find((item) => item.id === llmProfileId) ?? null;
  const selectedSttProfile = runtimeOptions.data?.stt_profiles.find((item) => item.id === sttProfileId) ?? null;
  const llmModelOptions = selectedLlmProfile?.models || [];
  const sttModelOptions = selectedSttProfile?.models || [];
  const hasLlmProfiles = Boolean(runtimeOptions.data?.llm_profiles.length);
  const hasSttProfiles = Boolean(runtimeOptions.data?.stt_profiles.length);
  const adminReady = authQuery.isSuccess && authQuery.isFetchedAfterMount;

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
    if (!preferenceInitRef.current) return;
    saveRuntimePreferences({
      llmProfileId,
      llmModel,
      sttProfileId,
      sttModel,
      diagramMode,
    });
  }, [diagramMode, llmModel, llmProfileId, sttModel, sttProfileId]);

  const saveProfilesMutation = useMutation({
    mutationFn: () =>
      api.saveAdminRuntimeOptions({
        llm_profiles: draftsToPayload("llm", llmDrafts),
        stt_profiles: draftsToPayload("stt", sttDrafts),
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(["admin-runtime-options"], payload);
      queryClient.invalidateQueries({ queryKey: ["runtime-options"] });
      setLlmDrafts(
        payload.llm_profiles.length
          ? payload.llm_profiles.map((profile) => profileToDraft("llm", profile))
          : [blankProfile("llm", 1)],
      );
      setSttDrafts(
        payload.stt_profiles.length
          ? payload.stt_profiles.map((profile) => profileToDraft("stt", profile))
          : [blankProfile("stt", 1)],
      );
    },
  });

  const probeModelsMutation = useMutation({
    mutationFn: async (payload: { kind: "llm" | "stt"; index: number; draft: ProfileDraft }) => {
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

  const summary = useMemo(
    () =>
      summarizeDefaults(
        selectedLlmProfile?.label || null,
        llmModel,
        selectedSttProfile?.label || null,
        sttModel,
        diagramMode,
      ),
    [diagramMode, llmModel, selectedLlmProfile, selectedSttProfile, sttModel],
  );

  function updateDraft(
    kind: "llm" | "stt",
    index: number,
    patch: Partial<ProfileDraft> | ((current: ProfileDraft) => Partial<ProfileDraft>),
  ) {
    const setter = kind === "llm" ? setLlmDrafts : setSttDrafts;
    setter((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) } : item,
      ),
    );
  }

  function addDraft(kind: "llm" | "stt") {
    const setter = kind === "llm" ? setLlmDrafts : setSttDrafts;
    setter((current) => [...current, blankProfile(kind, current.length + 1)]);
  }

  function removeDraft(kind: "llm" | "stt", index: number) {
    const setter = kind === "llm" ? setLlmDrafts : setSttDrafts;
    setter((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      return next.length ? next : [blankProfile(kind, 1)];
    });
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Settings"
        title="平台配置"
        description="在这里直接维护服务端 LLM / STT 配置，并设置当前浏览器里的默认运行偏好。"
        actions={
          <Link href="/app/realtime">
            <Button variant="secondary">
              返回实时工作台
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        }
      />

      <Card className="soft-enter space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-950">服务端模型配置</div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              这里配置的是平台自己的 LLM / STT profile。保存后会直接写入服务端持久化设置，实时工作台和样本页都会读这套配置。
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

        {!adminReady ? (
          <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            正在确认管理员登录状态。确认完成后才会启用服务端配置的读取、保存和模型探测。
          </div>
        ) : null}

        {saveProfilesMutation.isError ? (
          <div className="rounded-[20px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {(saveProfilesMutation.error as Error).message}
          </div>
        ) : null}
        {probeFeedback ? (
          <div className="rounded-[20px] border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
            {probeFeedback}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          {[
            { kind: "llm" as const, title: "LLM Profiles", drafts: llmDrafts },
            { kind: "stt" as const, title: "STT Profiles", drafts: sttDrafts },
          ].map((group) => (
            <div key={group.kind} className="space-y-4 rounded-[24px] border border-white/70 bg-white/[0.52] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-950">{group.title}</div>
                <Button variant="secondary" onClick={() => addDraft(group.kind)}>
                  <Plus className="h-4 w-4" />
                  添加
                </Button>
              </div>

              <div className="space-y-4">
                {group.drafts.map((draft, index) => (
                  <div key={`${group.kind}-${index}`} className="rounded-[22px] border border-white/70 bg-white/[0.72] p-4">
                    {(() => {
                      const resolvedEndpoint = resolveEndpoint(group.kind, draft);
                      const draftModelOptions = modelOptionsFromDraft(draft);
                      const selectedRoute = ENDPOINT_ROUTE_OPTIONS[group.kind].find(
                        (option) => option.value === draft.endpointRouteMode,
                      );

                      return (
                    <>
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-900">
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
                            (!draft.apiKey.trim() && !draft.apiKeyEnv.trim())
                          }
                        >
                          <RefreshCcw className="h-4 w-4" />
                          {probeModelsMutation.isPending ? "探测中..." : "探测模型"}
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
                        <Input
                          value={draft.id}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { id: event.target.value })
                          }
                          placeholder={`${group.kind}-profile`}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">显示名称</label>
                        <Input
                          value={draft.label}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { label: event.target.value })
                          }
                          placeholder="例如 OpenAI Primary"
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-sm font-medium text-slate-700">Endpoint Base</label>
                        <Input
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
                          {PROVIDER_KIND_OPTIONS.map((option) => (
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
                          <Input
                            value={draft.customEndpointPath}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                              updateDraft(group.kind, index, { customEndpointPath: event.target.value })
                            }
                            placeholder={
                              group.kind === "llm" ? "/v1/chat/completions" : "/v1/audio/transcriptions"
                            }
                          />
                        </div>
                      ) : null}
                      <div className="space-y-2 md:col-span-2">
                        <label className="text-sm font-medium text-slate-700">最终 Endpoint</label>
                        <Input value={resolvedEndpoint} readOnly />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">API Key</label>
                        <Input
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
                        <Input
                          value={draft.apiKeyEnv}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateDraft(group.kind, index, { apiKeyEnv: event.target.value })
                          }
                          placeholder="可选，例如 OPENAI_API_KEY"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-700">Default Model</label>
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
                        <label className="text-sm font-medium text-slate-700">模型列表</label>
                        <Textarea
                          rows={4}
                          value={draft.modelsText}
                          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                            updateDraft(group.kind, index, { modelsText: event.target.value })
                          }
                          placeholder="每行一个模型，或用逗号分隔"
                        />
                        <p className="text-xs leading-6 text-slate-500">
                          可以手动填写，也可以先填好 Endpoint 和 API Key，再点“探测模型”自动回填。
                        </p>
                      </div>
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

      <Card className="soft-enter soft-enter-delay-1 space-y-4">
        <div className="flex items-center gap-3">
          <div className="glass-panel flex h-11 w-11 items-center justify-center rounded-[18px] border border-white/70 text-[var(--accent-strong)]">
            <Settings2 className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold text-slate-950">默认运行参数</div>
            <div className="mt-1 text-sm text-slate-500">这些默认值会保存在当前浏览器，用于新建实时会话。</div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">LLM Profile</label>
            <select
              className={selectClassName(!hasLlmProfiles)}
              value={llmProfileId}
              disabled={!hasLlmProfiles}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setLlmProfileId(event.target.value)}
            >
              {hasLlmProfiles ? (
                (runtimeOptions.data?.llm_profiles || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ) : (
                <option value="">未配置 LLM profile</option>
              )}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">LLM Model</label>
            <select
              className={selectClassName(!llmModelOptions.length)}
              value={llmModel}
              disabled={!llmModelOptions.length}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setLlmModel(event.target.value)}
            >
              {llmModelOptions.length ? (
                llmModelOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))
              ) : (
                <option value="">{hasLlmProfiles ? "当前 profile 无模型" : "等待 LLM profile"}</option>
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
            <div key={item.label} className="rounded-[22px] border border-white/70 bg-white/[0.58] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
              <div className="mt-3 text-sm font-semibold leading-6 text-slate-900">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
