"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Download,
  FileDown,
  FileText,
  GitBranch,
  Layers,
  ListChecks,
  PieChart,
  PlayCircle,
  Settings2,
  Users,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import type { RealtimeTimelineNode } from "@stream2graph/contracts";

import { Badge, Button, Card, Input, StatCard, Textarea } from "@stream2graph/ui";

import { api, apiUrl } from "@/lib/api";

type DashboardTab = "overview" | "builder" | "exports";
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
type ReportSectionKey = "summary" | "decisions" | "actions" | "graph" | "timeline" | "evidence";

const DEBRIEF_REPORT_TYPES = new Set(["realtime_session", "realtime_graph"]);
const DASHBOARD_TABS: Array<[DashboardTab, string]> = [
  ["overview", "复盘中心"],
  ["builder", "报告自定义"],
  ["exports", "导出归档"],
];
const REPORT_SECTIONS: Array<{ key: ReportSectionKey; label: string; description: string }> = [
  { key: "summary", label: "工作摘要", description: "会话背景、最终结论和复盘口径。" },
  { key: "decisions", label: "关键决策", description: "从报告字段和图谱版本中提取决策。" },
  { key: "actions", label: "行动项", description: "待跟进事项、负责人线索和交付物。" },
  { key: "graph", label: "图谱指标", description: "节点、关系、分组和结构变化。" },
  { key: "timeline", label: "版本时间轴", description: "关键快照和可回放证据。" },
  { key: "evidence", label: "发言证据", description: "参与者占比与代表性发言片段。" },
];
const EXPORT_FORMATS = ["json", "csv", "markdown"] as const;

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
  if (!report) return "请选择一份实时工作报告，系统会在这里生成会后复盘视图。";
  const summary = report.summary ?? {};
  const direct =
    asString(summary.meeting_summary) ||
    asString(summary.summary_text) ||
    asString(report.payload?.summary) ||
    asString(findRecordByKey(report.payload, "coordination_summary")?.summary);
  if (direct) return direct;
  const metrics = graphMetrics(report);
  const speakers = new Set(turns.map((turn) => turn.speaker)).size;
  return `本次实时工作沉淀了 ${turns.length} 条可追踪发言、${speakers} 位参与者、${metrics.nodes} 个图谱节点和 ${metrics.edges} 条关系，并保留了 ${versions} 个可回放版本。`;
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
      : "已将实时工作内容固化为结构化报告，可继续补充人工结论。",
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

function safeFileName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "stream2graph-report";
}

function buildMarkdownDraft({
  title,
  audience,
  tone,
  intro,
  owner,
  reviewDate,
  report,
  summaryText,
  sections,
  decisions,
  actionItems,
  metrics,
  timelineNodes,
  transcriptTurns,
}: {
  title: string;
  audience: string;
  tone: string;
  intro: string;
  owner: string;
  reviewDate: string;
  report: ReportDetail | undefined;
  summaryText: string;
  sections: Record<ReportSectionKey, boolean>;
  decisions: string[];
  actionItems: string[];
  metrics: ReturnType<typeof graphMetrics>;
  timelineNodes: RealtimeTimelineNode[];
  transcriptTurns: TranscriptTurn[];
}) {
  const lines = [
    `# ${title}`,
    "",
    `- 目标读者：${audience}`,
    `- 语气模板：${tone}`,
    `- 报告来源：${report?.title || "未选择实时工作报告"}`,
    `- 负责人：${owner || "待补充"}`,
    `- 下次复盘：${reviewDate || "待确认"}`,
    "",
  ];

  if (intro.trim()) {
    lines.push("## 编者说明", "", intro.trim(), "");
  }
  if (sections.summary) {
    lines.push("## 工作摘要", "", summaryText, "");
  }
  if (sections.decisions) {
    lines.push("## 关键决策", "", ...decisions.map((item, index) => `${index + 1}. ${item}`), "");
  }
  if (sections.actions) {
    lines.push("## 行动项", "", ...actionItems.map((item, index) => `${index + 1}. ${item}`), "");
  }
  if (sections.graph) {
    lines.push(
      "## 图谱指标",
      "",
      `- 节点：${metrics.nodes}`,
      `- 关系：${metrics.edges}`,
      `- 分组：${metrics.groups}`,
      "",
    );
  }
  if (sections.timeline) {
    lines.push(
      "## 版本时间轴",
      "",
      ...(timelineNodes.length
        ? timelineNodes
            .slice(0, 8)
            .map((node, index) => `${index + 1}. ${node.label || "自动快照"} · ${formatDateTime(node.created_at)}`)
        : ["暂无可回放时间轴。"]),
      "",
    );
  }
  if (sections.evidence) {
    lines.push(
      "## 发言证据",
      "",
      ...(transcriptTurns.length
        ? transcriptTurns.slice(0, 8).map((turn) => `- ${turn.speaker}：${turn.text}`)
        : ["暂无可提取的发言证据。"]),
      "",
    );
  }
  return lines.join("\n");
}

export function ReportsDashboard() {
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("overview");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [selectedTimelineSnapshotId, setSelectedTimelineSnapshotId] = useState("");
  const [reportTitle, setReportTitle] = useState("实时工作复盘报告");
  const [reportAudience, setReportAudience] = useState("业务复盘");
  const [reportTone, setReportTone] = useState("专业简洁");
  const [reportOwner, setReportOwner] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const [customIntro, setCustomIntro] = useState("本报告基于实时工作台生成的转写、图谱版本和时间轴快照整理。");
  const [sections, setSections] = useState<Record<ReportSectionKey, boolean>>({
    summary: true,
    decisions: true,
    actions: true,
    graph: true,
    timeline: true,
    evidence: true,
  });

  const realtimeSessions = useQuery({ queryKey: ["realtime-sessions"], queryFn: api.listRealtimeSessions });
  const reports = useQuery({ queryKey: ["reports"], queryFn: api.listReports });
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
  const timelineNodes = useMemo(() => timeline.data?.nodes ?? [], [timeline.data?.nodes]);
  const orderedTimelineNodes = useMemo(() => [...timelineNodes].reverse(), [timelineNodes]);
  const timelinePreview = useQuery({
    queryKey: ["realtime-timeline-preview", selectedSessionId, selectedTimelineSnapshotId],
    queryFn: () => api.previewRealtimeRollback(selectedSessionId, { snapshot_id: selectedTimelineSnapshotId }),
    enabled: Boolean(selectedSessionId && selectedTimelineSnapshotId),
    retry: false,
  });

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

  useEffect(() => {
    if (selectedReport.data?.title) {
      setReportTitle(`${selectedReport.data.title} · 工作复盘`);
    }
  }, [selectedReport.data?.title]);

  const transcriptTurns = useMemo(() => collectTranscriptTurns(selectedReport.data?.payload), [selectedReport.data?.payload]);
  const shares = useMemo(() => speakerShares(transcriptTurns), [transcriptTurns]);
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
  const enabledSections = REPORT_SECTIONS.filter((section) => sections[section.key]);
  const markdownDraft = useMemo(
    () =>
      buildMarkdownDraft({
        title: reportTitle,
        audience: reportAudience,
        tone: reportTone,
        intro: customIntro,
        owner: reportOwner,
        reviewDate,
        report: selectedReport.data,
        summaryText,
        sections,
        decisions,
        actionItems,
        metrics,
        timelineNodes: orderedTimelineNodes,
        transcriptTurns,
      }),
    [
      actionItems,
      customIntro,
      decisions,
      metrics,
      orderedTimelineNodes,
      reportAudience,
      reportOwner,
      reportTitle,
      reportTone,
      reviewDate,
      sections,
      selectedReport.data,
      summaryText,
      transcriptTurns,
    ],
  );

  const stats = [
    { label: "实时会话", value: realtimeSessions.data?.length ?? 0 },
    { label: "工作报告", value: debriefReports.length },
    { label: "图谱版本", value: timelineNodes.length || 0 },
    { label: "行动项", value: actionItems.length },
  ];

  function downloadMarkdownDraft() {
    const blob = new Blob([markdownDraft], { type: "text/markdown;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(reportTitle)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="page-title--menu-clearance flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">实时工作报告</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-theme-4">
            围绕实时工作台生成的会话、图谱、时间轴和行动项做复盘，面向工作交付、评审归档和后续跟进。
          </p>
        </div>
        <a href="/app/realtime">
          <Button variant="secondary" className="gap-2">
            <Activity className="h-4 w-4" />
            返回实时工作
          </Button>
        </a>
      </div>

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

        <Tabs.Content value="overview">
          <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-theme-1">工作报告</div>
                  <div className="mt-1 text-xs text-theme-4">选择一份实时会话报告进入复盘视图</div>
                </div>
                <Badge>{debriefReports.length}</Badge>
              </div>
              <div className="space-y-2">
                {debriefReports.length ? (
                  debriefReports.slice(0, 14).map((item) => {
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
                    暂无实时工作报告。请先在实时工作台生成并保存报告。
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
                      复盘摘要
                    </div>
                    <div className="mt-1 text-sm text-theme-4">
                      {selectedReport.data?.title || "实时工作报告会在这里转成可复盘的工作面板"}
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
                    工作摘要
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
                      <div className="text-sm text-theme-4">正在载入该时间点预览...</div>
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

        <Tabs.Content value="builder">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Settings2 className="h-5 w-5" />
                报告模板
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-theme-2">报告标题</span>
                  <Input
                    value={reportTitle}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReportTitle(event.target.value)}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">目标读者</span>
                  <select
                    className="select-control"
                    value={reportAudience}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => setReportAudience(event.target.value)}
                  >
                    {["业务复盘", "产品评审", "技术交接", "上线验收", "客户汇报"].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">表达风格</span>
                  <select
                    className="select-control"
                    value={reportTone}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => setReportTone(event.target.value)}
                  >
                    {["专业简洁", "管理层摘要", "交付验收", "问题复盘", "行动导向"].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">负责人</span>
                  <Input
                    value={reportOwner}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReportOwner(event.target.value)}
                    placeholder="例如：产品负责人 / 项目经理"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">下次复盘时间</span>
                  <Input
                    value={reviewDate}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReviewDate(event.target.value)}
                    placeholder="例如：2026-06-10 10:00"
                  />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-theme-2">编者说明</span>
                  <Textarea
                    value={customIntro}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setCustomIntro(event.target.value)}
                    rows={4}
                  />
                </label>
              </div>

              <div className="space-y-3">
                <div className="text-sm font-semibold text-theme-1">报告章节</div>
                <div className="grid gap-2 md:grid-cols-2">
                  {REPORT_SECTIONS.map((section) => (
                    <label
                      key={section.key}
                      className="flex items-start gap-3 rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 accent-[color:var(--accent)]"
                        checked={sections[section.key]}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            [section.key]: event.target.checked,
                          }))
                        }
                      />
                      <span>
                        <span className="block text-sm font-semibold text-theme-2">{section.label}</span>
                        <span className="mt-1 block text-xs leading-5 text-theme-4">{section.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </Card>

            <div className="space-y-5">
              <Card className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                      <Layers className="h-5 w-5" />
                      报告预览
                    </div>
                    <div className="mt-1 text-sm text-theme-4">根据当前报告和模板配置生成 Markdown 初稿。</div>
                  </div>
                  <Button type="button" onClick={downloadMarkdownDraft} disabled={!selectedReport.data}>
                    <FileDown className="h-4 w-4" />
                    下载初稿
                  </Button>
                </div>
                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-theme-4">{reportAudience}</div>
                  <div className="mt-2 text-xl font-semibold text-theme-1">{reportTitle}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge>{reportTone}</Badge>
                    <Badge>{reportOwner || "负责人待补充"}</Badge>
                    <Badge>{reviewDate || "复盘时间待确认"}</Badge>
                  </div>
                  <p className="mt-4 text-sm leading-7 text-theme-3">{customIntro}</p>
                </div>
                <div className="space-y-3">
                  {enabledSections.map((section) => (
                    <div key={section.key} className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                      <div className="text-sm font-semibold text-theme-1">{section.label}</div>
                      <div className="mt-1 text-xs leading-5 text-theme-4">{section.description}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="space-y-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                  <FileText className="h-4 w-4" />
                  Markdown 初稿
                </div>
                <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border border-theme-subtle bg-surface-muted px-4 py-3 text-xs leading-6 text-theme-3">
                  {markdownDraft}
                </pre>
              </Card>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="exports">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Download className="h-5 w-5" />
                实时数据导出
              </div>
              <p className="text-sm leading-6 text-theme-3">
                从云端后端导出实时会话归档数据，可用于审计、归档、复盘整理和二次分析。
              </p>
              <div className="flex flex-wrap gap-2">
                {EXPORT_FORMATS.map((fmt) => (
                  <a key={fmt} href={apiUrl(`/api/v1/reports/exports/download?target=realtime&fmt=${fmt}`)}>
                    <Button variant="secondary">
                      <Download className="h-4 w-4" />
                      {fmt.toUpperCase()}
                    </Button>
                  </a>
                ))}
              </div>
            </Card>

            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <ListChecks className="h-5 w-5" />
                交付检查
              </div>
              <div className="space-y-3">
                {[
                  ["已选择报告", Boolean(selectedReport.data), selectedReport.data?.title || "请选择一份实时工作报告"],
                  ["包含核心章节", enabledSections.length >= 3, `${enabledSections.length} 个章节已启用`],
                  ["图谱证据", metrics.nodes > 0 || metrics.edges > 0, `${metrics.nodes} 节点 / ${metrics.edges} 关系`],
                  ["时间轴", timelineNodes.length > 0, `${timelineNodes.length} 个快照`],
                ].map(([label, ok, detail]) => (
                  <div key={String(label)} className="flex items-start gap-3 rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${ok ? "text-emerald-500" : "text-theme-5"}`} />
                    <div>
                      <div className="text-sm font-semibold text-theme-2">{label}</div>
                      <div className="mt-1 text-xs text-theme-4">{detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
