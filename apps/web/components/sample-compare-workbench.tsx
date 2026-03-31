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
            <div key={step} className="rounded-[22px] border border-white/70 bg-white/[0.56] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-strong)]">Step {step}</div>
              <div className="mt-2 text-sm font-semibold text-slate-100">{titleText}</div>
              <div className="mt-2 text-sm leading-6 text-slate-400">{desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[390px_minmax(0,1fr)]">
        <Card className="soft-enter space-y-6">
          <div className="grid gap-5">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">数据集版本</label>
              <select
                className="h-12 w-full rounded-[22px] border border-white/70 bg-white/[0.72] px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[rgba(185,167,211,0.18)]"
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
              <label className="text-sm font-medium text-slate-300">Split</label>
              <select
                className="h-12 w-full rounded-[22px] border border-white/70 bg-white/[0.72] px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[rgba(185,167,211,0.18)]"
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
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">样本检索</label>
              <Input
                value={search}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
                placeholder="按 sample id 过滤"
              />
            </div>
            <div className="max-h-[500px] space-y-2 overflow-auto pr-1">
              {samples.data?.map((item) => (
                <button
                  key={item.sample_id}
                  className={`lift-hover w-full rounded-[22px] border px-4 py-3.5 text-left ${
                    item.sample_id === sampleId ? "border-[var(--accent)] bg-[rgba(185,167,211,0.10)]" : "border-white/70 bg-white/[0.64]"
                  }`}
                  onClick={() => setSampleId(item.sample_id)}
                >
                  <div className="font-semibold text-slate-100">{item.sample_id}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {item.diagram_type} · {item.dialogue_turns} turns
                  </div>
                </button>
              ))}
            </div>
          </div>
        </Card>

        <div className="soft-enter soft-enter-delay-1 space-y-6">
          <Card className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xl font-semibold tracking-[-0.04em] text-slate-50">{sampleId || "选择一个样本"}</div>
                <div className="mt-2 text-sm text-slate-500">当前版本：{datasetVersion || "-"}</div>
              </div>
              {run ? <Badge>{run.status}</Badge> : null}
            </div>

            <div className="rounded-[24px] border border-white/70 bg-white/[0.58] px-5 py-4 text-sm leading-6 text-slate-400">
              左侧面板负责“选什么样本”，这里负责“怎么比较”和“查看结果”。如果只想快速体验，保持默认两个预测器，直接运行即可。
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              {[
                { label: "左侧预测器", value: leftPredictor, setValue: setLeftPredictor },
                { label: "右侧预测器", value: rightPredictor, setValue: setRightPredictor },
              ].map((item) => (
                <div key={item.label} className="glass-panel rounded-[26px] border border-white/70 p-5">
                  <div className="text-sm font-semibold text-slate-100">{item.label}</div>
                  <div className="mt-4 space-y-3">
                    <Input
                      value={item.value.provider}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        item.setValue({ ...item.value, provider: event.target.value })
                      }
                      placeholder="provider"
                    />
                    <Input
                      value={item.value.model}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        item.setValue({ ...item.value, model: event.target.value })
                      }
                      placeholder="model"
                    />
                    <Textarea
                      rows={4}
                      value={item.value.optionsText}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                        item.setValue({ ...item.value, optionsText: event.target.value })
                      }
                      placeholder='{"temperature": 0}'
                    />
                  </div>
                </div>
              ))}
            </div>

            <Button className="py-3" onClick={() => compareMutation.mutate()} disabled={!sampleId || compareMutation.isPending}>
              <Sparkles className="h-4 w-4" />
              {compareMutation.isPending ? "创建对比运行..." : "运行双模型对比"}
            </Button>
          </Card>

          <Tabs.Root defaultValue="reference" className="space-y-5">
            <Tabs.List className="glass-panel inline-flex flex-wrap gap-2 rounded-full border border-white/70 p-1.5">
              {[
                ["reference", "参考样本"],
                ["results", "预测结果"],
                ["dialogue", "对话材料"],
                ["metadata", "元数据"],
              ].map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="rounded-full border border-transparent bg-transparent px-4 py-2.5 text-sm font-medium text-slate-400 transition data-[state=active]:border-white/80 data-[state=active]:bg-white/[0.88] data-[state=active]:text-slate-50"
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
                    <div key={turn.turn_id} className="glass-panel rounded-[22px] border border-white/70 p-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Turn {turn.turn_id} · {turn.role} · {turn.action_type}
                      </div>
                      <div className="mt-2 text-sm leading-6 text-slate-300">{turn.utterance}</div>
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
        </div>
      </div>
    </div>
  );
}
