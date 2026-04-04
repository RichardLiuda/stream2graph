"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Play } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

import { api, subscribeRun } from "@/lib/api";
import { MermaidCard } from "@/components/mermaid-card";

type PredictorDraft = {
  provider: string;
  model: string;
  optionsText: string;
};

/** 与 realtime 页「输入来源」下拉同一套触发器 / 浮层样式 */
const STUDIO_SELECT_TRIGGER =
  "flex h-10 w-full items-center justify-between rounded-lg border border-theme-default bg-surface-2 px-3.5 pr-3 text-left text-sm font-medium text-theme-1 outline-none transition hover:border-theme-strong hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-theme-focus";
const STUDIO_SELECT_MENU =
  "absolute z-[21000] mt-2 w-full rounded-lg border border-theme-subtle bg-surface-1 p-1.5 shadow-xl";

/** 左侧卡片内下拉/输入/列表统一略窄于卡片全宽，避免贴满右缘 */
const SIDEBAR_CONTROL_MAX = "max-w-[min(100%,21rem)]";

/** 结果区二级面板：默认收起，与 `MermaidCard` 可折叠样式一致 */
function CollapsibleResultPanel({
  title,
  summaryCollapsed,
  children,
}: {
  title: string;
  summaryCollapsed?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 border-0 border-b border-theme-default bg-transparent px-5 py-4 text-left hover:bg-surface-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--ring-focus)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="text-sm font-semibold text-theme-1">{title}</div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-theme-3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="p-4">{children}</div>
      ) : (
        <div className="border-b border-theme-default px-5 py-3 text-xs leading-snug text-theme-4">
          {summaryCollapsed ?? "内容已收起，点击标题栏可展开。"}
        </div>
      )}
    </Card>
  );
}

export function SampleCompareWorkbench() {
  const RESULT_TABS: Array<[string, string]> = [
    ["reference", "参考样本"],
    ["results", "预测结果"],
    ["dialogue", "对话材料"],
    ["metadata", "元数据"],
  ];
  const queryClient = useQueryClient();
  const [datasetVersion, setDatasetVersion] = useState("");
  const [split, setSplit] = useState("test");
  const [search, setSearch] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [leftPredictor, setLeftPredictor] = useState<PredictorDraft>({
    provider: "gold_reference",
    model: "gold_reference",
    optionsText: "{}",
  });
  const [rightPredictor, setRightPredictor] = useState<PredictorDraft>({
    provider: "traditional_rule_based",
    model: "heuristic_baseline",
    optionsText: "{}",
  });
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [resultTab, setResultTab] = useState<(typeof RESULT_TABS)[number][0]>("reference");
  const [run, setRun] = useState<any | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [datasetMenuOpen, setDatasetMenuOpen] = useState(false);
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const datasetMenuRef = useRef<HTMLDivElement | null>(null);
  const splitMenuRef = useRef<HTMLDivElement | null>(null);

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.listDatasets });
  const splits = useQuery({
    queryKey: ["splits", datasetVersion],
    queryFn: () => api.listSplits(datasetVersion),
    enabled: Boolean(datasetVersion),
  });
  const samples = useQuery({
    queryKey: ["samples", datasetVersion, split, search],
    queryFn: () => api.listSamples(datasetVersion, split, search, 0, 40),
    enabled: Boolean(datasetVersion),
  });
  const sample = useQuery({
    queryKey: ["sample", datasetVersion, split, sampleId],
    queryFn: () => api.getSample(datasetVersion, split, sampleId),
    enabled: Boolean(datasetVersion && sampleId),
  });

  useEffect(() => {
    if (!datasetVersion && datasets.data?.length) {
      setDatasetVersion(datasets.data.find((item) => item.is_default)?.slug || datasets.data[0].slug);
    }
  }, [datasetVersion, datasets.data]);

  useEffect(() => {
    if (!sampleId && samples.data?.length) {
      setSampleId(samples.data[0].sample_id);
    }
  }, [sampleId, samples.data]);

  useEffect(() => {
    if (!datasetMenuOpen && !splitMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const t = event.target as Node;
      if (datasetMenuRef.current?.contains(t)) return;
      if (splitMenuRef.current?.contains(t)) return;
      setDatasetMenuOpen(false);
      setSplitMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [datasetMenuOpen, splitMenuOpen]);

  const splitRow = useMemo(
    () => splits.data?.find((item) => item.split === split),
    [splits.data, split],
  );

  const compareMutation = useMutation({
    mutationFn: async () => {
      const predictors = [leftPredictor, rightPredictor].map((item) => ({
        provider: item.provider,
        model: item.model,
        options: JSON.parse(item.optionsText || "{}"),
      }));
      return api.createSampleCompareRun({
        title: `样本对比_${sampleId}`,
        dataset_version_slug: datasetVersion,
        split,
        sample_id: sampleId,
        predictors,
      });
    },
    onSuccess: (job) => {
      setRun(job);
      setRunError(null);
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (error) => setRunError((error as Error).message),
  });

  useEffect(() => {
    if (!run?.run_id) return;
    const source = subscribeRun(run.run_id, (payload) => {
      setRun(payload);
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    });
    return () => source.close();
  }, [queryClient, run?.run_id]);

  const predictions = run?.result_payload?.predictions || [];
  const sampleMeta = useMemo(() => sample.data?.metadata || {}, [sample.data]);

  return (
    <div className="space-y-5">
      <h1 className="page-title page-title--menu-clearance">静态样本浏览与对比</h1>

      {runError ? (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-200">{runError}</div>
      ) : null}

      <Card className="soft-enter space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-theme-2">流程</div>
            <p className="mt-1 text-xs leading-snug text-theme-4">选样本 → 配双预测器 → 在结果区看参考与预测。</p>
          </div>
          {run ? <Badge>{run.status}</Badge> : <Badge>未运行</Badge>}
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {[
            ["1", "选择样本", "左侧筛选数据集、split 和 sample。"],
            ["2", "配置模型", "设置左右预测器，保持对比条件清楚。"],
            ["3", "阅读结果", "在标签页里切换参考样本、对话材料和预测结果。"],
          ].map(([step, titleText, desc]) => (
            <div key={step} className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">Step {step}</div>
              <div className="mt-1 text-sm font-medium text-theme-2">{titleText}</div>
              <div className="mt-1 text-xs leading-snug text-theme-4">{desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[390px_minmax(0,1fr)]">
        <Card className="soft-enter h-auto space-y-6 self-start">
          <div className="grid gap-5">
            <div className="space-y-3">
              <label className="text-sm font-semibold text-theme-1">数据集版本</label>
              <div ref={datasetMenuRef} className={`relative ${SIDEBAR_CONTROL_MAX}`}>
                <button
                  type="button"
                  className={STUDIO_SELECT_TRIGGER}
                  aria-haspopup="listbox"
                  aria-expanded={datasetMenuOpen}
                  disabled={!datasets.data?.length}
                  onClick={() => {
                    setSplitMenuOpen(false);
                    setDatasetMenuOpen((open) => !open);
                  }}
                >
                  <span className="truncate">
                    {datasets.isLoading
                      ? "加载中…"
                      : datasetVersion
                        ? datasetVersion
                        : "暂无数据集"}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-theme-4 transition-transform duration-200 ${datasetMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {datasetMenuOpen && datasets.data?.length ? (
                  <div className={STUDIO_SELECT_MENU} role="listbox" aria-label="数据集版本">
                    <div className="space-y-0.5">
                      {datasets.data.map((item) => {
                        const active = item.slug === datasetVersion;
                        return (
                          <button
                            key={item.slug}
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              setDatasetVersion(item.slug);
                              setDatasetMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition ${
                              active
                                ? "border-theme-strong bg-surface-3 text-theme-1"
                                : "border-transparent bg-transparent text-theme-2 hover:bg-surface-3"
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={`inline-flex h-4 w-4 items-center justify-center ${active ? "text-theme-2" : "text-theme-5"}`}
                              >
                                {active ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
                              </span>
                              <span className="truncate">{item.slug}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-sm font-semibold text-theme-1">Split</label>
              <div ref={splitMenuRef} className={`relative ${SIDEBAR_CONTROL_MAX}`}>
                <button
                  type="button"
                  className={STUDIO_SELECT_TRIGGER}
                  aria-haspopup="listbox"
                  aria-expanded={splitMenuOpen}
                  disabled={!datasetVersion || splits.isLoading || !splits.data?.length}
                  onClick={() => {
                    setDatasetMenuOpen(false);
                    setSplitMenuOpen((open) => !open);
                  }}
                >
                  <span className="truncate">
                    {!datasetVersion
                      ? "先选择数据集"
                      : splits.isLoading
                        ? "加载中…"
                        : splitRow
                          ? `${splitRow.split} (${splitRow.count})`
                          : split}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-theme-4 transition-transform duration-200 ${splitMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {splitMenuOpen && datasetVersion && splits.data?.length ? (
                  <div className={STUDIO_SELECT_MENU} role="listbox" aria-label="Split">
                    <div className="space-y-0.5">
                      {splits.data.map((item) => {
                        const active = item.split === split;
                        return (
                          <button
                            key={item.split}
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              setSplit(item.split);
                              setSplitMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition ${
                              active
                                ? "border-theme-strong bg-surface-3 text-theme-1"
                                : "border-transparent bg-transparent text-theme-2 hover:bg-surface-3"
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={`inline-flex h-4 w-4 items-center justify-center ${active ? "text-theme-2" : "text-theme-5"}`}
                              >
                                {active ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
                              </span>
                              <span className="truncate">
                                {item.split} ({item.count})
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className={`space-y-3 ${SIDEBAR_CONTROL_MAX}`}>
              <label className="text-sm font-medium text-theme-2">样本检索</label>
              <Input
                value={search}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
                placeholder="按 sample id 过滤"
              />
            </div>
            <div
              className={`max-h-[min(52vh,420px)] overflow-y-auto rounded-lg border border-theme-subtle bg-surface-muted p-2 pr-1 [scrollbar-gutter:stable] ${SIDEBAR_CONTROL_MAX}`}
            >
              <div className="space-y-2 pb-1">
                {samples.data?.map((item) => (
                  <button
                    key={item.sample_id}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                      item.sample_id === sampleId
                        ? "border-theme-strong bg-surface-3"
                        : "border-theme-default bg-surface-muted hover:border-theme-default hover:bg-surface-3/50"
                    }`}
                    onClick={() => setSampleId(item.sample_id)}
                  >
                    <div className="font-medium text-theme-2">{item.sample_id}</div>
                    <div className="mt-0.5 text-[11px] text-theme-4">
                      {item.diagram_type} · {item.dialogue_turns} turns
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <div className="soft-enter soft-enter-delay-1 space-y-4">
          <Card className="h-auto space-y-4 self-start">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xl font-semibold tracking-[-0.04em] text-theme-1">{sampleId || "选择一个样本"}</div>
                <div className="mt-2 text-sm text-theme-4">当前版本：{datasetVersion || "-"}</div>
              </div>
              {run ? <Badge>{run.status}</Badge> : null}
            </div>

            <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-2.5 text-xs leading-snug text-theme-3">
              左侧选样本；此处配置对比并查看结果。默认预测器可直接运行。
            </div>

            <div className="grid items-stretch gap-3 lg:grid-cols-2">
              {[
                { label: "左侧预测器", value: leftPredictor, setValue: setLeftPredictor },
                { label: "右侧预测器", value: rightPredictor, setValue: setRightPredictor },
              ].map((item) => (
                <div key={item.label} className="glass-panel h-full min-h-[120px] p-3">
                  <div className="text-sm font-medium text-theme-2">{item.label}</div>
                  <div className="mt-2 grid gap-2">
                    <Input
                      className="h-10 rounded-[12px]"
                      value={item.value.provider}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        item.setValue({ ...item.value, provider: event.target.value })
                      }
                      placeholder="provider"
                    />
                    <Input
                      className="h-10 rounded-[12px]"
                      value={item.value.model}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        item.setValue({ ...item.value, model: event.target.value })
                      }
                      placeholder="model"
                    />
                    {showAdvancedOptions ? (
                      <Textarea
                        rows={2}
                        className="min-h-[64px] rounded-[12px] text-xs"
                        value={item.value.optionsText}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                          item.setValue({ ...item.value, optionsText: event.target.value })
                        }
                        placeholder='{"temperature": 0}'
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                className="h-8 rounded-full px-3 text-xs text-theme-3 hover:text-theme-1"
                onClick={() => setShowAdvancedOptions((prev) => !prev)}
              >
                {showAdvancedOptions ? "收起高级参数" : "显示高级参数"}
              </Button>
            </div>

            <Button className="py-2.5" onClick={() => compareMutation.mutate()} disabled={!sampleId || compareMutation.isPending}>
              <Play className="h-4 w-4" strokeWidth={2} />
              {compareMutation.isPending ? "创建对比运行..." : "运行双模型对比"}
            </Button>
          </Card>

          {run || sample.data ? (
            <Tabs.Root value={resultTab} onValueChange={(value) => setResultTab(value as typeof resultTab)} className="space-y-5">
              <Tabs.List className="workspace-tab-list grid-cols-4">
                <span
                  aria-hidden
                  className="workspace-tab-indicator"
                  style={{
                    left: "0.25rem",
                    width: "calc((100% - 0.5rem) / 4)",
                    transform: `translateX(calc(${Math.max(
                      0,
                      RESULT_TABS.findIndex(([value]) => value === resultTab),
                    )} * 100%))`,
                  }}
                />
                {RESULT_TABS.map(([value, label]) => (
                  <Tabs.Trigger key={value} value={value} className="workspace-tab-trigger px-3 py-2">
                    {label}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <Tabs.Content value="reference">
                <MermaidCard
                  title="参考 Mermaid"
                  code={sample.data?.code || ""}
                  height={252}
                  collapsible
                  defaultDiagramExpanded={false}
                />
              </Tabs.Content>

              <Tabs.Content value="results">
                <Card>
                  <div className="mb-5 text-sm font-semibold text-theme-1">预测结果</div>
                  {predictions.length ? (
                    <div className="space-y-5">
                      {predictions.map((row: Record<string, any>, index: number) => (
                        <div key={`${row.provider}-${index}`} className="glass-panel p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{row.provider}</Badge>
                            <Badge>{row.model_name}</Badge>
                            <Badge>line_f1 {row.metrics?.line_f1 ?? "-"}</Badge>
                            <Badge>compile {String(row.metrics?.compile_success ?? "n/a")}</Badge>
                          </div>
                          <div className="mt-4 grid gap-5 xl:grid-cols-2">
                            <MermaidCard title="预测 Mermaid" code={row.generated_code || ""} height={280} />
                            <pre className="rounded-[24px] bg-surface-1 p-5 text-xs leading-6 text-theme-1">
                              {JSON.stringify(row.metrics || {}, null, 2)}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[22px] border border-dashed border-theme-default p-5 text-sm text-theme-4">
                      对比运行完成后，这里会展示双模型输出、离线指标和编译状态。
                    </div>
                  )}
                </Card>
              </Tabs.Content>

              <Tabs.Content value="dialogue">
                <CollapsibleResultPanel
                  title="参考对话"
                  summaryCollapsed="对话材料已收起，点击标题栏可展开。"
                >
                  <div className="space-y-4">
                    {sample.data?.dialogue?.map((turn: Record<string, any>) => (
                      <div key={turn.turn_id} className="glass-panel p-3">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">
                          Turn {turn.turn_id} · {turn.role} · {turn.action_type}
                        </div>
                        <div className="mt-1.5 text-sm leading-snug text-theme-2">{turn.utterance}</div>
                      </div>
                    ))}
                  </div>
                </CollapsibleResultPanel>
              </Tabs.Content>

              <Tabs.Content value="metadata">
                <CollapsibleResultPanel
                  title="样本元数据"
                  summaryCollapsed="元数据已收起，点击标题栏可展开。"
                >
                  <pre className="rounded-[24px] bg-surface-1 p-5 text-xs leading-6 text-theme-1">
                    {JSON.stringify(sampleMeta, null, 2)}
                  </pre>
                </CollapsibleResultPanel>
              </Tabs.Content>
            </Tabs.Root>
          ) : (
            <Card className="rounded-lg border border-theme-default bg-surface-muted p-3 text-xs leading-snug text-theme-4">
              运行对比后在此查看参考图、预测、对话与元数据。
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
