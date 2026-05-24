"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  GitBranch,
  ListChecks,
  PieChart,
  PlayCircle,
  Plus,
  Users,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import type { RealtimeTimelineNode } from "@stream2graph/contracts";

import { Badge, Button, Card, Input, StatCard, Textarea } from "@stream2graph/ui";

import { api, apiUrl } from "@/lib/api";

type DashboardTab = "debrief" | "study" | "exports";
type ReportDetail = Awaited<ReturnType<typeof api.getReport>>;
type SpeakerShare = {
  speaker: string;
  chars: number;
  turns: number;
  percent: number;
};
type TranscriptTurn = {
  speaker: string;
  text: string;
};

const DEBRIEF_REPORT_TYPES = new Set(["realtime_session", "realtime_graph"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function compactText(value: unknown) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function collectStringList(value: unknown, keyMatcher: (key: string) => boolean, limit = 8) {
  const results: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (results.length >= limit || depth > 5) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    Object.entries(node).forEach(([key, child]) => {
      if (results.length >= limit) return;
      if (keyMatcher(key)) {
        if (Array.isArray(child)) {
          child.forEach((item) => {
            const text = compactText(item);
            if (text && !seen.has(text)) {
              seen.add(text);
              results.push(text);
            }
          });
        } else {
          const text = compactText(child);
          if (text && !seen.has(text)) {
            seen.add(text);
            results.push(text);
          }
        }
      }
      walk(child, depth + 1);
    });
  };
  walk(value, 0);
  return results;
}

function collectTranscriptTurns(value: unknown) {
  const turns: TranscriptTurn[] = [];
  const seen = new Set<string>();
  const pushTurn = (speaker: string, text: string) => {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    const normalizedSpeaker = speaker.replace(/\s+/g, " ").trim() || "speaker";
    const key = `${normalizedSpeaker}|${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    turns.push({ speaker: normalizedSpeaker, text: cleaned });
  };
  const walk = (node: unknown, depth: number) => {
    if (depth > 7) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    const speaker = asString(node.speaker) || asString(node.role) || asString(node.participant);
    const text = asString(node.text) || asString(node.content) || asString(node.transcript_text);
    if (text && (speaker || "transcript_text" in node || "speaker" in node)) {
      pushTurn(speaker || "speaker", text);
    }
    Object.entries(node).forEach(([key, child]) => {
      if (key === "code" || key === "normalized_code" || key === "mermaid_code") return;
      walk(child, depth + 1);
    });
  };
  walk(value, 0);
  return turns;
}

function speakerShares(turns: TranscriptTurn[]): SpeakerShare[] {
  const totals = new Map<string, { chars: number; turns: number }>();
  turns.forEach((turn) => {
    const current = totals.get(turn.speaker) ?? { chars: 0, turns: 0 };
    current.chars += turn.text.length;
    current.turns += 1;
    totals.set(turn.speaker, current);
  });
  const totalChars = Array.from(totals.values()).reduce((sum, item) => sum + item.chars, 0) || 1;
  return Array.from(totals.entries())
    .map(([speaker, item]) => ({
      speaker,
      chars: item.chars,
      turns: item.turns,
      percent: Math.round((item.chars / totalChars) * 100),
    }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 8);
}

function findRecordByKey(value: unknown, wantedKey: string, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordByKey(item, wantedKey, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const direct = value[wantedKey];
  if (isRecord(direct)) return direct;
  for (const child of Object.values(value)) {
    const found = findRecordByKey(child, wantedKey, depth + 1);
    if (found) return found;
  }
  return null;
}

function graphMetrics(report: ReportDetail | undefined) {
  const summary = report?.summary ?? {};
  const graphIr = findRecordByKey(report?.payload, "current_graph_ir");
  const nodes = Array.isArray(graphIr?.nodes) ? graphIr.nodes.length : Number(summary.node_count ?? 0) || 0;
  const edges = Array.isArray(graphIr?.edges) ? graphIr.edges.length : Number(summary.edge_count ?? 0) || 0;
  const groups = Array.isArray(graphIr?.groups) ? graphIr.groups.length : Number(summary.group_count ?? 0) || 0;
  return { nodes, edges, groups };
}

function reportSessionId(report: ReportDetail | undefined) {
  return asString(report?.payload?.session_id) || asString(report?.summary?.session_id);
}

function reportSummaryText(report: ReportDetail | undefined, turns: TranscriptTurn[], versions: number) {
  if (!report) return "请选择一份实时会话报告，系统会在这里生成会后复盘视图。";
  const direct =
    asString(report.summary.meeting_summary) ||
    asString(report.summary.summary_text) ||
    asString(report.payload?.summary) ||
    asString(findRecordByKey(report.payload, "coordination_summary")?.summary);
  if (direct) return direct;
  const metrics = graphMetrics(report);
  const speakers = new Set(turns.map((turn) => turn.speaker)).size;
  return `本次会话沉淀了 ${turns.length} 条可追踪发言、${speakers} 位参与者、${metrics.nodes} 个图谱节点和 ${metrics.edges} 条关系，并保留了 ${versions} 个可回放版本。`;
}

function deriveDecisionItems(report: ReportDetail | undefined, timelineNodes: RealtimeTimelineNode[]) {
  const collected = collectStringList(
    report,
    (key) => /decision|decisions|conclusion|selected_option|final_choice|key_result/i.test(key),
    5,
  );
  if (collected.length) return collected;
  const metrics = graphMetrics(report);
  return [
    metrics.nodes || metrics.edges
      ? `形成当前图谱版本：${metrics.nodes} 个节点、${metrics.edges} 条关系、${metrics.groups} 个分组。`
      : "已将会话内容固化为结构化报告，可继续补充人工结论。",
    timelineNodes.length
      ? `保留 ${timelineNodes.length} 个时间节点，可回看关键版本变化。`
      : "当前报告暂无时间轴快照，可在实时工作台继续生成版本记录。",
  ];
}

function deriveActionItems(report: ReportDetail | undefined, turns: TranscriptTurn[]) {
  const collected = collectStringList(
    report,
    (key) => /action|todo|next_step|follow|owner|deadline/i.test(key),
    6,
  );
  if (collected.length) return collected;
  const inferred = turns
    .map((turn) => turn.text)
    .filter((text) => /需要|后续|确认|跟进|检查|记录|发布|导出|review|follow|todo|next/i.test(text))
    .slice(0, 5);
  return inferred.length ? inferred : ["暂无明确行动项，可在复盘后手动补充负责人、截止时间和交付物。"];
}

export function ReportsDashboard() {
  const DASHBOARD_TABS: Array<[string, string]> = [
    ["debrief", "会后复盘"],
    ["study", "用户研究配置"],
    ["exports", "导出"],
  ];
  const queryClient = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("基线比较任务");
  const [taskDescription, setTaskDescription] = useState("请根据给定对话材料产出或修订 Mermaid 图。");
  const [taskDataset, setTaskDataset] = useState("");
  const [taskSplit, setTaskSplit] = useState("test");
  const [taskSampleId, setTaskSampleId] = useState("");
  const [taskSystemOutputs, setTaskSystemOutputs] = useState(
    JSON.stringify(
      {
        manual: "",
        heuristic: "flowchart TD\n  A[Heuristic Draft]\n  B[Please Refine]\n  A --> B",
        model_system: "flowchart TD\n  Start[Model Draft]\n  Review[Human Review]\n  Start --> Review",
      },
      null,
      2,
    ),
  );
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [participantId, setParticipantId] = useState("P-001");
  const [participantCondition, setParticipantCondition] = useState("manual");
  const [creationError, setCreationError] = useState<string | null>(null);
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("debrief");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [selectedTimelineSnapshotId, setSelectedTimelineSnapshotId] = useState("");

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.listDatasets });
  const samples = useQuery({
    queryKey: ["report-samples", taskDataset, taskSplit],
    queryFn: () => api.listSamples(taskDataset, taskSplit, "", 0, 20),
    enabled: Boolean(taskDataset),
  });
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.listRuns });
  const realtimeSessions = useQuery({ queryKey: ["realtime-sessions"], queryFn: api.listRealtimeSessions });
  const reports = useQuery({ queryKey: ["reports"], queryFn: api.listReports });
  const studyTasks = useQuery({ queryKey: ["study-tasks"], queryFn: api.listStudyTasks });
  const studySessions = useQuery({ queryKey: ["study-sessions"], queryFn: api.listStudySessions });
  const debriefReports = useMemo(
    () => (reports.data || []).filter((item) => DEBRIEF_REPORT_TYPES.has(item.report_type)),
    [reports.data],
  );
  const selectedReport = useQuery({
    queryKey: ["reports", selectedReportId],
    queryFn: () => api.getReport(selectedReportId),
    enabled: Boolean(selectedReportId),
  });
  const selectedSessionId = reportSessionId(selectedReport.data);
  const timeline = useQuery({
    queryKey: ["realtime-timeline", selectedSessionId],
    queryFn: () => api.listRealtimeTimeline(selectedSessionId),
    enabled: Boolean(selectedSessionId),
    retry: false,
  });
  const timelinePreview = useQuery({
    queryKey: ["realtime-timeline-preview", selectedSessionId, selectedTimelineSnapshotId],
    queryFn: () => api.previewRealtimeRollback(selectedSessionId, { snapshot_id: selectedTimelineSnapshotId }),
    enabled: Boolean(selectedSessionId && selectedTimelineSnapshotId),
    retry: false,
  });

  useEffect(() => {
    if (!taskDataset && datasets.data?.length) {
      const defaultSlug = datasets.data.find((item) => item.is_default)?.slug || datasets.data[0].slug;
      setTaskDataset(defaultSlug);
    }
  }, [datasets.data, taskDataset]);

  useEffect(() => {
    if (!taskSampleId && samples.data?.length) {
      setTaskSampleId(samples.data[0].sample_id);
    }
  }, [samples.data, taskSampleId]);

  useEffect(() => {
    if (!selectedReportId && debriefReports.length) {
      setSelectedReportId(debriefReports[0].report_id);
    }
  }, [debriefReports, selectedReportId]);

  useEffect(() => {
    const latestSnapshotId = timeline.data?.nodes[0]?.snapshot_id || "";
    if (!selectedTimelineSnapshotId && latestSnapshotId) {
      setSelectedTimelineSnapshotId(latestSnapshotId);
    }
  }, [selectedTimelineSnapshotId, timeline.data?.nodes]);

  const stats = useMemo(
    () => [
      { label: "运行任务", value: runs.data?.length ?? 0 },
      { label: "实时会话", value: realtimeSessions.data?.length ?? 0 },
      { label: "研究任务", value: studyTasks.data?.length ?? 0 },
      { label: "复盘报告", value: debriefReports.length },
    ],
    [debriefReports.length, realtimeSessions.data?.length, runs.data?.length, studyTasks.data?.length],
  );
  const transcriptTurns = useMemo(() => collectTranscriptTurns(selectedReport.data?.payload), [selectedReport.data?.payload]);
  const shares = useMemo(() => speakerShares(transcriptTurns), [transcriptTurns]);
  const timelineNodes = timeline.data?.nodes ?? [];
  const orderedTimelineNodes = useMemo(() => [...timelineNodes].reverse(), [timelineNodes]);
  const metrics = graphMetrics(selectedReport.data);
  const decisions = useMemo(
    () => deriveDecisionItems(selectedReport.data, timelineNodes),
    [selectedReport.data, timelineNodes],
  );
  const actionItems = useMemo(
    () => deriveActionItems(selectedReport.data, transcriptTurns),
    [selectedReport.data, transcriptTurns],
  );
  const summaryText = reportSummaryText(selectedReport.data, transcriptTurns, timelineNodes.length);
  const selectedTimelineNode = timelineNodes.find((node) => node.snapshot_id === selectedTimelineSnapshotId) ?? null;

  const createTask = useMutation({
    mutationFn: () =>
      api.createStudyTask({
        title: taskTitle,
        description: taskDescription,
        dataset_version_slug: taskDataset || null,
        split: taskSplit || null,
        sample_id: taskSampleId || null,
        default_condition: "manual",
        system_outputs: JSON.parse(taskSystemOutputs || "{}"),
      }),
    onSuccess: (task) => {
      setSelectedTaskId(task.task_id);
      setCreationError(null);
      queryClient.invalidateQueries({ queryKey: ["study-tasks"] });
    },
    onError: (error) => setCreationError((error as Error).message),
  });

  const createParticipant = useMutation({
    mutationFn: () =>
      api.createStudySession(selectedTaskId, {
        participant_id: participantId,
        study_condition: participantCondition,
      }),
    onSuccess: () => {
      setCreationError(null);
      queryClient.invalidateQueries({ queryKey: ["study-sessions"] });
    },
    onError: (error) => setCreationError((error as Error).message),
  });

  return (
    <div className="space-y-5">
      <h1 className="page-title page-title--menu-clearance">实验、用户研究与报告</h1>

      {creationError ? (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-200">{creationError}</div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((item) => (
          <StatCard key={item.label} label={item.label} value={String(item.value)} />
        ))}
      </div>

      <Tabs.Root
        value={dashboardTab}
        onValueChange={(value) => setDashboardTab(value as DashboardTab)}
        className="space-y-4"
      >
        <Tabs.List className="workspace-tab-list max-w-[560px] grid-cols-3">
          <span
            aria-hidden
            className="workspace-tab-indicator"
            style={{
              left: "0.25rem",
              width: "calc((100% - 0.5rem) / 3)",
              transform: `translateX(calc(${Math.max(
                0,
                DASHBOARD_TABS.findIndex(([value]) => value === dashboardTab),
              )} * 100%))`,
            }}
          />
          {DASHBOARD_TABS.map(([value, label]) => (
            <Tabs.Trigger key={value} value={value} className="workspace-tab-trigger px-4 py-2">
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="debrief">
          <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-theme-1">复盘报告</div>
                  <div className="mt-1 text-xs text-theme-4">选择实时会话报告进入会后复盘视图</div>
                </div>
                <Badge>{debriefReports.length}</Badge>
              </div>
              <div className="space-y-2">
                {debriefReports.length ? (
                  debriefReports.slice(0, 12).map((item) => {
                    const active = item.report_id === selectedReportId;
                    return (
                      <button
                        key={item.report_id}
                        type="button"
                        onClick={() => {
                          setSelectedReportId(item.report_id);
                          setSelectedTimelineSnapshotId("");
                        }}
                        className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                          active
                            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/[0.08] text-theme-1"
                            : "border-theme-subtle bg-surface-muted text-theme-2 hover:border-theme-default hover:bg-surface-2"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 truncate text-sm font-semibold">{item.title}</div>
                          <Badge className="shrink-0 text-[10px]">{item.report_type}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-theme-4">{formatDateTime(item.created_at)}</div>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-6 text-sm text-theme-4">
                    暂无实时会话报告。请先在实时工作台生成并保存报告。
                  </div>
                )}
              </div>
            </Card>

            <div className="space-y-5">
              <Card className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                      <FileText className="h-5 w-5" />
                      会后复盘中心
                    </div>
                    <div className="mt-1 text-sm text-theme-4">
                      {selectedReport.data?.title || "实时会话报告会在这里转成可复盘的工作面板"}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge>{selectedReport.data?.status || "waiting"}</Badge>
                    {selectedSessionId ? <Badge>session: {selectedSessionId.slice(0, 8)}</Badge> : null}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  {[
                    { label: "参与者", value: shares.length, icon: Users },
                    { label: "关键决策", value: decisions.length, icon: CheckCircle2 },
                    { label: "行动项", value: actionItems.length, icon: ListChecks },
                    { label: "图谱版本", value: timelineNodes.length || 1, icon: GitBranch },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.label} className="rounded-lg border border-theme-default bg-surface-muted px-4 py-3">
                        <div className="flex items-center justify-between gap-2 text-xs text-theme-4">
                          <span>{item.label}</span>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="mt-2 text-2xl font-semibold text-theme-1">{item.value}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <Activity className="h-4 w-4" />
                    会议摘要
                  </div>
                  <p className="text-sm leading-7 text-theme-3">{summaryText}</p>
                </div>
              </Card>

              <div className="grid gap-5 xl:grid-cols-2">
                <Card className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <CheckCircle2 className="h-4 w-4" />
                    关键决策
                  </div>
                  <div className="space-y-3">
                    {decisions.map((item, index) => (
                      <div key={`${item}-${index}`} className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                        <div className="text-xs font-semibold text-theme-4">Decision {index + 1}</div>
                        <div className="mt-1 text-sm leading-6 text-theme-2">{item}</div>
                      </div>
                    ))}
                  </div>
                </Card>

                <Card className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <ListChecks className="h-4 w-4" />
                    行动项
                  </div>
                  <div className="space-y-3">
                    {actionItems.map((item, index) => (
                      <div key={`${item}-${index}`} className="flex gap-3 rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)]/15 text-xs font-semibold text-[color:var(--accent-strong)]">
                          {index + 1}
                        </span>
                        <div className="text-sm leading-6 text-theme-2">{item}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <Card className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                      <PieChart className="h-4 w-4" />
                      参与者发言占比
                    </div>
                    <Badge>{transcriptTurns.length} turns</Badge>
                  </div>
                  <div className="space-y-3">
                    {shares.length ? (
                      shares.map((item) => (
                        <div key={item.speaker} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="font-medium text-theme-2">{item.speaker}</span>
                            <span className="text-xs text-theme-4">
                              {item.percent}% · {item.turns} 次
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                            <div className="h-full rounded-full bg-[color:var(--accent)]" style={{ width: `${Math.max(4, item.percent)}%` }} />
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-6 text-sm text-theme-4">
                        当前报告里还没有可统计的发言文本。
                      </div>
                    )}
                  </div>
                </Card>

                <Card className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                      <GitBranch className="h-4 w-4" />
                      图谱版本变化
                    </div>
                    <Badge>
                      {metrics.nodes} nodes / {metrics.edges} edges
                    </Badge>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {[
                      ["节点", metrics.nodes],
                      ["关系", metrics.edges],
                      ["分组", metrics.groups],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                        <div className="text-xs text-theme-4">{label}</div>
                        <div className="mt-1 text-xl font-semibold text-theme-1">{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {orderedTimelineNodes.slice(-6).map((node, index) => (
                      <button
                        key={node.snapshot_id}
                        type="button"
                        onClick={() => setSelectedTimelineSnapshotId(node.snapshot_id)}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${
                          node.snapshot_id === selectedTimelineSnapshotId
                            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/[0.08]"
                            : "border-theme-subtle bg-surface-muted hover:border-theme-default"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-theme-2">
                            v{index + 1} · {node.label || "自动快照"}
                          </div>
                          <div className="mt-1 text-xs text-theme-4">{formatDateTime(node.created_at)}</div>
                        </div>
                        <Badge className="shrink-0">{node.chunk_count} chunks</Badge>
                      </button>
                    ))}
                    {!orderedTimelineNodes.length ? (
                      <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-5 text-sm text-theme-4">
                        暂无可回放时间轴。
                      </div>
                    ) : null}
                  </div>
                </Card>
              </div>

              <Card className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <PlayCircle className="h-4 w-4" />
                    可回放时间轴
                  </div>
                  <Badge>{selectedTimelineNode ? formatDateTime(selectedTimelineNode.created_at) : "未选择"}</Badge>
                </div>
                <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                  <div className="max-h-[22rem] space-y-2 overflow-auto pr-1">
                    {orderedTimelineNodes.map((node, index) => (
                      <button
                        key={node.snapshot_id}
                        type="button"
                        onClick={() => setSelectedTimelineSnapshotId(node.snapshot_id)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                          node.snapshot_id === selectedTimelineSnapshotId
                            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/[0.08] text-theme-1"
                            : "border-theme-subtle bg-surface-muted text-theme-2 hover:border-theme-default"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium">Step {index + 1}</span>
                          <Clock3 className="h-3.5 w-3.5 text-theme-4" />
                        </div>
                        <div className="mt-1 text-xs text-theme-4">{node.label || formatDateTime(node.created_at)}</div>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                    {timelinePreview.isLoading ? (
                      <div className="text-sm text-theme-4">正在载入该时间点预览…</div>
                    ) : timelinePreview.data ? (
                      <div className="space-y-4">
                        <div>
                          <div className="text-xs font-semibold text-theme-4">回放摘要</div>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-1 px-3 py-2 text-xs leading-5 text-theme-3">
                            {JSON.stringify(timelinePreview.data.summary || {}, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-theme-4">当时发言</div>
                          <div className="mt-2 space-y-2">
                            {(timelinePreview.data.turns || []).slice(0, 5).map((turn, index) => (
                              <div key={`${turn.speaker}-${index}`} className="rounded-lg border border-theme-subtle bg-surface-1 px-3 py-2">
                                <div className="text-xs font-semibold text-theme-2">{turn.speaker}</div>
                                <div className="mt-1 text-sm leading-6 text-theme-3">{turn.text}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-theme-4">选择左侧时间点后，可以预览当时的摘要、发言和图谱状态。</div>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="study">
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Plus className="h-5 w-5" />
                创建研究任务
              </div>
              <Input
                value={taskTitle}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTitle(event.target.value)}
                placeholder="任务标题"
              />
              <Textarea
                value={taskDescription}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTaskDescription(event.target.value)}
                rows={4}
              />
              <select
                className="select-control"
                value={taskDataset}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setTaskDataset(event.target.value)}
              >
                {datasets.data?.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.slug}
                  </option>
                ))}
              </select>
              <div className="grid gap-3 md:grid-cols-2">
                <select
                  className="select-control"
                  value={taskSplit}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setTaskSplit(event.target.value)}
                >
                  {["train", "validation", "test"].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <select
                  className="select-control"
                  value={taskSampleId}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setTaskSampleId(event.target.value)}
                >
                  {samples.data?.map((item) => (
                    <option key={item.sample_id} value={item.sample_id}>
                      {item.sample_id}
                    </option>
                  ))}
                </select>
              </div>
              <Textarea
                value={taskSystemOutputs}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTaskSystemOutputs(event.target.value)}
                rows={10}
              />
              <Button className="py-3" onClick={() => createTask.mutate()} disabled={createTask.isPending}>
                创建任务
              </Button>
            </Card>

            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Users className="h-5 w-5" />
                发放 Participant Code
              </div>
              <select
                className="select-control"
                value={selectedTaskId}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedTaskId(event.target.value)}
              >
                <option value="">选择研究任务</option>
                {studyTasks.data?.map((task) => (
                  <option key={task.task_id} value={task.task_id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <Input
                value={participantId}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setParticipantId(event.target.value)}
                placeholder="participant id"
              />
              <select
                className="select-control"
                value={participantCondition}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setParticipantCondition(event.target.value)}
              >
                {["manual", "heuristic", "model_system"].map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <Button
                className="py-3"
                onClick={() => createParticipant.mutate()}
                disabled={!selectedTaskId || createParticipant.isPending}
              >
                创建 Participant Session
              </Button>
              <div className="space-y-4">
                {studySessions.data?.slice(0, 8).map((item) => (
                  <div key={item.session_id} className="glass-panel p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-theme-1">{item.participant_code}</div>
                      <a
                        className="text-sm font-medium text-[var(--accent-strong)]"
                        href={`/study/${item.participant_code}`}
                        target="_blank"
                      >
                        打开任务页
                      </a>
                    </div>
                    <div className="mt-1 text-xs text-theme-4">
                      {item.participant_id} · {item.study_condition}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </Tabs.Content>

        <Tabs.Content value="exports">
          <div className="grid gap-6 xl:grid-cols-3">
            {[
              ["runs", "运行记录"],
              ["studies", "用户研究"],
              ["realtime", "实时会话"],
            ].map(([target, label]) => (
              <Card key={target} className="lift-hover space-y-5">
                <div className="text-lg font-semibold text-theme-1">{label}</div>
                <p className="text-sm leading-6 text-theme-3">
                  导出为 JSON、CSV 或 Markdown，支持实验复现、论文整理和归档审计。
                </p>
                <div className="flex flex-wrap gap-2">
                  {["json", "csv", "markdown"].map((fmt) => (
                    <a key={fmt} href={apiUrl(`/api/v1/reports/exports/download?target=${target}&fmt=${fmt}`)}>
                      <Button variant="secondary">
                        <Download className="h-4 w-4" />
                        {fmt.toUpperCase()}
                      </Button>
                    </a>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
