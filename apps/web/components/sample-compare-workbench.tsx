"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

import { api, subscribeRun } from "@/lib/api";
import { MermaidCard } from "@/components/mermaid-card";

type PredictorDraft = {
  provider: string;
  model: string;
  optionsText: string;
};

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
    <div className="space-y-6">
      <div className="pl-8 text-[2rem] font-semibold tracking-[-0.04em] text-violet-200">静态样本浏览与对比</div>

      {runError ? (
        <div className="rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{runError}</div>
      ) : null}

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-50">推荐流程</div>
            <p className="mt-2 text-sm leading-6 text-slate-400">先选数据集和样本，再配置左右两个预测器，最后在结果区查看参考图、预测图和指标。</p>
          </div>
          {run ? <Badge>{run.status}</Badge> : <Badge>等待创建对比运行</Badge>}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["1", "选择样本", "左侧筛选数据集、split 和 sample。"],
            ["2", "配置模型", "设置左右预测器，保持对比条件清楚。"],
            ["3", "阅读结果", "在标签页里切换参考样本、对话材料和预测结果。"],
          ].map(([step, titleText, desc]) => (
            <div key={step} className="rounded-[22px] border border-white/70 bg-white/[0.66] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-strong)]">Step {step}</div>
              <div className="mt-2 text-sm font-semibold text-slate-800">{titleText}</div>
              <div className="mt-2 text-sm leading-6 text-slate-600">{desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[390px_minmax(0,1fr)]">
        <Card className="soft-enter h-auto space-y-6 self-start">
          <div className="grid gap-5">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">数据集版本</label>
              <div className="mx-auto w-[96%]">
                <select
                  className="h-10 w-full rounded-full border border-violet-200/80 bg-violet-50/95 px-3.5 pr-9 text-sm font-medium text-slate-900 outline-none transition hover:border-violet-300/85 hover:bg-violet-100/95 focus-visible:ring-4 focus-visible:ring-[rgba(196,181,253,0.35)]"
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
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">Split</label>
              <div className="mx-auto w-[96%]">
                <select
                  className="h-10 w-full rounded-full border border-violet-200/80 bg-violet-50/95 px-3.5 pr-9 text-sm font-medium text-slate-900 outline-none transition hover:border-violet-300/85 hover:bg-violet-100/95 focus-visible:ring-4 focus-visible:ring-[rgba(196,181,253,0.35)]"
                  value={split}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setSplit(event.target.value)}
                >
                  {splits.data?.map((item) => (
                    <option key={item.split} value={item.split}>
                      {item.split} ({item.count})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">样本检索</label>
              <Input
                value={search}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
                placeholder="按 sample id 过滤"
              />
            </div>
            <div className="max-h-[min(52vh,420px)] overflow-y-auto rounded-[20px] border border-white/60 bg-white/[0.22] p-2 pr-1 [scrollbar-gutter:stable]">
              <div className="space-y-2 pb-1">
                {samples.data?.map((item) => (
                  <button
                    key={item.sample_id}
                    className={`lift-hover w-full rounded-[20px] border px-4 py-3 text-left transition ${
                      item.sample_id === sampleId
                        ? "border-violet-300 bg-[linear-gradient(135deg,rgba(243,232,255,0.96),rgba(233,213,255,0.9))] shadow-[0_8px_20px_rgba(124,58,237,0.16)]"
                        : "border-white/70 bg-white/[0.64] hover:border-violet-200/80 hover:bg-white/[0.78]"
                    }`}
                    onClick={() => setSampleId(item.sample_id)}
                  >
                    <div className="font-semibold text-slate-800">{item.sample_id}</div>
                    <div className="mt-1 text-xs text-slate-500">
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
                <div className="text-xl font-semibold tracking-[-0.04em] text-slate-50">{sampleId || "选择一个样本"}</div>
                <div className="mt-2 text-sm text-slate-500">当前版本：{datasetVersion || "-"}</div>
              </div>
              {run ? <Badge>{run.status}</Badge> : null}
            </div>

            <div className="rounded-[24px] border border-white/70 bg-white/[0.68] px-5 py-4 text-sm leading-6 text-slate-700">
              左侧面板负责“选什么样本”，这里负责“怎么比较”和“查看结果”。如果只想快速体验，保持默认两个预测器，直接运行即可。
            </div>

            <div className="grid items-stretch gap-3 lg:grid-cols-2">
              {[
                { label: "左侧预测器", value: leftPredictor, setValue: setLeftPredictor },
                { label: "右侧预测器", value: rightPredictor, setValue: setRightPredictor },
              ].map((item) => (
                <div key={item.label} className="glass-panel h-full min-h-[128px] rounded-[20px] border border-white/70 bg-white/[0.62] p-3">
                  <div className="text-sm font-semibold text-slate-800">{item.label}</div>
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
                className="h-8 rounded-full px-3 text-xs text-white/75 hover:text-white"
                onClick={() => setShowAdvancedOptions((prev) => !prev)}
              >
                {showAdvancedOptions ? "收起高级参数" : "显示高级参数"}
              </Button>
            </div>

            <Button className="py-2.5" onClick={() => compareMutation.mutate()} disabled={!sampleId || compareMutation.isPending}>
              <Sparkles className="h-4 w-4" />
              {compareMutation.isPending ? "创建对比运行..." : "运行双模型对比"}
            </Button>
          </Card>

          {run || sample.data ? (
            <Tabs.Root value={resultTab} onValueChange={(value) => setResultTab(value as typeof resultTab)} className="space-y-5">
              <Tabs.List className="glass-panel relative grid w-full grid-cols-4 rounded-full border border-violet-200/55 p-1">
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-1 rounded-full border border-violet-300/85 bg-violet-300 shadow-[0_8px_24px_rgba(124,58,237,0.28)] transition-transform duration-300 ease-out"
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
                  <Tabs.Trigger
                    key={value}
                    value={value}
                    className="relative z-[1] rounded-full border border-transparent px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors data-[state=active]:text-violet-950"
                  >
                    {label}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <Tabs.Content value="reference">
                <MermaidCard title="参考 Mermaid" code={sample.data?.code || ""} />
              </Tabs.Content>

              <Tabs.Content value="results">
                <Card>
                  <div className="mb-5 text-sm font-semibold text-slate-100">预测结果</div>
                  {predictions.length ? (
                    <div className="space-y-5">
                      {predictions.map((row: Record<string, any>, index: number) => (
                        <div key={`${row.provider}-${index}`} className="glass-panel rounded-[24px] border border-white/70 p-5">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{row.provider}</Badge>
                            <Badge>{row.model_name}</Badge>
                            <Badge>line_f1 {row.metrics?.line_f1 ?? "-"}</Badge>
                            <Badge>compile {String(row.metrics?.compile_success ?? "n/a")}</Badge>
                          </div>
                          <div className="mt-4 grid gap-5 xl:grid-cols-2">
                            <MermaidCard title="预测 Mermaid" code={row.generated_code || ""} height={280} />
                            <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                              {JSON.stringify(row.metrics || {}, null, 2)}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[22px] border border-dashed border-slate-300 p-5 text-sm text-slate-500">
                      对比运行完成后，这里会展示双模型输出、离线指标和编译状态。
                    </div>
                  )}
                </Card>
              </Tabs.Content>

              <Tabs.Content value="dialogue">
                <Card>
                  <div className="mb-4 text-sm font-semibold text-slate-100">参考对话</div>
                  <div className="space-y-4">
                    {sample.data?.dialogue?.map((turn: Record<string, any>) => (
                      <div key={turn.turn_id} className="glass-panel rounded-[22px] border border-white/70 bg-white/[0.62] p-4">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Turn {turn.turn_id} · {turn.role} · {turn.action_type}
                        </div>
                        <div className="mt-2 text-sm leading-6 text-slate-700">{turn.utterance}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              </Tabs.Content>

              <Tabs.Content value="metadata">
                <Card>
                  <div className="mb-4 text-sm font-semibold text-slate-100">样本元数据</div>
                  <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                    {JSON.stringify(sampleMeta, null, 2)}
                  </pre>
                </Card>
              </Tabs.Content>
            </Tabs.Root>
          ) : (
            <Card className="rounded-[24px] border border-white/65 bg-white/[0.52] p-4 text-sm text-slate-700">
              这里是结果区：运行对比后会显示参考图、预测结果、对话和元数据。当前未加载到可展示内容，所以先折叠为紧凑提示。
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
