"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Copy,
  Download,
  FileDown,
  FileText,
  GitBranch,
  Layers,
  ListChecks,
  Save,
  Search,
  Settings2,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import type { RealtimeTimelineNode } from "@stream2graph/contracts";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

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
type ManualActionItem = {
  text: string;
  owner: string;
  due: string;
};
type ReportSectionKey = "summary" | "decisions" | "actions" | "risks" | "graph" | "timeline" | "evidence";
type ReportPreset = {
  id: string;
  label: string;
  audience: string;
  tone: string;
  intro: string;
  sections: Partial<Record<ReportSectionKey, boolean>>;
};

const DEBRIEF_REPORT_TYPES = new Set(["realtime_session", "realtime_graph"]);
const DASHBOARD_TABS: Array<[DashboardTab, string]> = [
  ["overview", "复盘中心"],
  ["builder", "报告自定义"],
  ["exports", "导出归档"],
];
const REPORT_SECTIONS: Array<{ key: ReportSectionKey; label: string; description: string }> = [
  { key: "summary", label: "工作摘要", description: "会话摘要与背景。" },
  { key: "decisions", label: "关键决策", description: "从报告字段和图谱版本中提取。" },
  { key: "actions", label: "行动项", description: "待跟进事项与负责人。" },
  { key: "risks", label: "风险关注", description: "阻塞和不确定事项。" },
  { key: "graph", label: "图谱指标", description: "节点、关系、分组数量。" },
  { key: "timeline", label: "版本时间轴", description: "可回放的图谱快照列表。" },
  { key: "evidence", label: "发言证据", description: "发言占比与片段。" },
];
const EXPORT_FORMATS = ["json", "csv", "markdown"] as const;
// 合并为两个实用模板：内部复盘（含全部章节）、对外摘要（隐藏时间轴和发言证据）
const REPORT_PRESETS: ReportPreset[] = [
  {
    id: "internal",
    label: "内部复盘",
    audience: "业务复盘",
    tone: "行动导向",
    intro: "",
    sections: { summary: true, decisions: true, actions: true, risks: true, graph: true, timeline: true, evidence: true },
  },
  {
    id: "external",
    label: "对外摘要",
    audience: "客户汇报",
    tone: "管理层摘要",
    intro: "",
    sections: { summary: true, decisions: true, actions: true, risks: true, graph: false, timeline: false, evidence: false },
  },
];

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
  // 只从报告结构化字段中提取，不用 transcript 文本猜测
  const collected = collectStringList(
    report?.payload,
    (key) => /^(decision|decisions|conclusion|selected_option|final_choice|key_result)$/i.test(key),
    5,
  );
  if (collected.length) return collected;
  const metrics = graphMetrics(report);
  return [
    metrics.nodes || metrics.edges
      ? `当前图谱：${metrics.nodes} 个节点、${metrics.edges} 条关系、${metrics.groups} 个分组。`
      : "暂无结构化决策字段。",
    timelineNodes.length
      ? `保留 ${timelineNodes.length} 个时间节点。`
      : "暂无时间轴快照。",
  ];
}

function deriveActionItems(report: ReportDetail | undefined) {
  // 只从结构化字段提取，不用 transcript 关键词匹配兜底
  const collected = collectStringList(
    report?.payload,
    (key) => /^(action|actions|todo|todos|next_step|next_steps|follow_up)$/i.test(key),
    6,
  );
  return collected.length ? collected : [];
}

function deriveRiskItems(report: ReportDetail | undefined) {
  // 只从结构化字段提取，不用 transcript 关键词匹配兜底
  const collected = collectStringList(
    report?.payload,
    (key) => /^(risk|risks|issue|issues|blocker|blockers|concern|concerns|warning|warnings)$/i.test(key),
    5,
  );
  return collected.length ? collected : [];
}

function manualActionText(item: ManualActionItem) {
  const meta = [item.owner ? `负责人：${item.owner}` : "", item.due ? `截止：${item.due}` : ""]
    .filter(Boolean)
    .join("；");
  return meta ? `${item.text}（${meta}）` : item.text;
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
  riskItems,
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
  riskItems: string[];
  metrics: ReturnType<typeof graphMetrics>;
  timelineNodes: RealtimeTimelineNode[];
  transcriptTurns: TranscriptTurn[];
}) {
  const lines = [
    `# ${title}`,
    "",
    `- 目标读者：${audience}`,
    `- 表达风格：${tone}`,
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
  if (sections.risks) {
    lines.push("## 风险关注", "", ...riskItems.map((item, index) => `${index + 1}. ${item}`), "");
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
  const queryClient = useQueryClient();
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("overview");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [selectedTimelineSnapshotId, setSelectedTimelineSnapshotId] = useState("");
  const [reportSearch, setReportSearch] = useState("");
  const [reportStatusFilter, setReportStatusFilter] = useState("all");
  const [reportTitle, setReportTitle] = useState("实时工作复盘报告");
  const [reportAudience, setReportAudience] = useState("业务复盘");
  const [reportTone, setReportTone] = useState("专业简洁");
  const [reportOwner, setReportOwner] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const [customIntro, setCustomIntro] = useState("");
  const [manualActionTextDraft, setManualActionTextDraft] = useState("");
  const [manualActionOwnerDraft, setManualActionOwnerDraft] = useState("");
  const [manualActionDueDraft, setManualActionDueDraft] = useState("");
  const [manualActions, setManualActions] = useState<ManualActionItem[]>([]);
  const [copyNotice, setCopyNotice] = useState("");
  // notes 编辑状态
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [sections, setSections] = useState<Record<ReportSectionKey, boolean>>({
    summary: true,
    decisions: true,
    actions: true,
    risks: true,
    graph: true,
    timeline: true,
    evidence: true,
  });

  const reports = useQuery({ queryKey: ["reports"], queryFn: api.listReports });
  const debriefReports = useMemo(
    () => (reports.data || []).filter((item) => DEBRIEF_REPORT_TYPES.has(item.report_type)),
    [reports.data],
  );
  const filteredDebriefReports = useMemo(() => {
    const query = reportSearch.trim().toLowerCase();
    return debriefReports.filter((item) => {
      const matchesQuery =
        !query ||
        item.title.toLowerCase().includes(query) ||
        item.report_type.toLowerCase().includes(query) ||
        item.status.toLowerCase().includes(query);
      const matchesStatus = reportStatusFilter === "all" || item.status === reportStatusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [debriefReports, reportSearch, reportStatusFilter]);
  const reportStatuses = useMemo(
    () => Array.from(new Set(debriefReports.map((item) => item.status).filter(Boolean))).sort(),
    [debriefReports],
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

  // 报告切换时同步 notes 草稿
  useEffect(() => {
    setNotesDraft(selectedReport.data?.notes ?? "");
    setNotesSaved(false);
  }, [selectedReport.data?.notes, selectedReport.data?.report_id]);

  const saveNotesMutation = useMutation({
    mutationFn: (notes: string) => api.updateReport(selectedReportId, { notes }),
    onSuccess: () => {
      setNotesSaved(true);
      queryClient.invalidateQueries({ queryKey: ["reports", selectedReportId] });
    },
  });

  const transcriptTurns = useMemo(() => collectTranscriptTurns(selectedReport.data?.payload), [selectedReport.data?.payload]);
  const metrics = useMemo(() => graphMetrics(selectedReport.data), [selectedReport.data]);
  const decisions = useMemo(
    () => deriveDecisionItems(selectedReport.data, timelineNodes),
    [selectedReport.data, timelineNodes],
  );
  const actionItems = useMemo(
    () => deriveActionItems(selectedReport.data),
    [selectedReport.data],
  );
  const riskItems = useMemo(
    () => deriveRiskItems(selectedReport.data),
    [selectedReport.data],
  );
  const summaryText = reportSummaryText(selectedReport.data, transcriptTurns, timelineNodes.length);
  const selectedTimelineNode = timelineNodes.find((node) => node.snapshot_id === selectedTimelineSnapshotId) ?? null;
  const combinedActionItems = useMemo(
    () => [...actionItems, ...manualActions.map((item) => manualActionText(item))],
    [actionItems, manualActions],
  );
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
        actionItems: combinedActionItems,
        riskItems,
        metrics,
        timelineNodes: orderedTimelineNodes,
        transcriptTurns,
      }),
    [
      combinedActionItems,
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
      riskItems,
    ],
  );
  const draftStats = useMemo(() => {
    const lines = markdownDraft.split("\n").filter((line) => line.trim()).length;
    const chars = markdownDraft.replace(/\s/g, "").length;
    return {
      lines,
      chars,
      readMinutes: Math.max(1, Math.ceil(chars / 500)),
      sections: enabledSections.length,
    };
  }, [enabledSections.length, markdownDraft]);

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

  async function copyMarkdownDraft() {
    try {
      await navigator.clipboard.writeText(markdownDraft);
      setCopyNotice("已复制 Markdown 初稿");
    } catch {
      setCopyNotice("复制失败，请直接下载初稿");
    }
  }

  function addManualAction() {
    const text = manualActionTextDraft.trim();
    if (!text) return;
    setManualActions((current) => [
      ...current,
      {
        text,
        owner: manualActionOwnerDraft.trim(),
        due: manualActionDueDraft.trim(),
      },
    ]);
    setManualActionTextDraft("");
    setManualActionOwnerDraft("");
    setManualActionDueDraft("");
  }

  function applyReportPreset(preset: ReportPreset) {
    setReportAudience(preset.audience);
    setReportTone(preset.tone);
    setCustomIntro(preset.intro);
    setSections((current) => ({ ...current, ...preset.sections }));
  }

  return (
    <div className="space-y-5">
      <div className="page-title--menu-clearance flex flex-wrap items-end justify-between gap-3 pr-14">
        <div>
          <h1 className="page-title">实时工作报告</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-theme-4">
            查看实时会话报告，记录复盘备注，自定义并导出 Markdown 初稿。
          </p>
        </div>
        <a href="/app/realtime">
          <Button variant="secondary" className="gap-2">
            <Activity className="h-4 w-4" />
            返回实时工作
          </Button>
        </a>
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
          <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)] items-start">
            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-theme-1">工作报告</div>
                  <div className="mt-1 text-xs text-theme-4">选择一份实时会话报告进入复盘视图</div>
                </div>
                <Badge>{filteredDebriefReports.length} / {debriefReports.length}</Badge>
              </div>
              <div className="space-y-2">
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-5" />
                  <Input
                    className="pl-9"
                    value={reportSearch}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReportSearch(event.target.value)}
                    placeholder="搜索标题、类型或状态"
                  />
                </label>
                <select
                  className="select-control"
                  value={reportStatusFilter}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setReportStatusFilter(event.target.value)}
                >
                  <option value="all">全部状态</option>
                  {reportStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                {filteredDebriefReports.length ? (
                  filteredDebriefReports.slice(0, 14).map((item) => {
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
                    没有匹配的实时工作报告。可调整搜索条件，或先在实时工作台生成并保存报告。
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
                  </div>
                </div>

                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <Activity className="h-4 w-4" />
                    工作摘要
                  </div>
                  <p className="text-sm leading-7 text-theme-3">{summaryText}</p>
                </div>

                {/* 复盘备注：可编辑并保存到后端 */}
                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                      <FileText className="h-4 w-4" />
                      复盘备注
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => saveNotesMutation.mutate(notesDraft)}
                      disabled={!selectedReportId || saveNotesMutation.isPending}
                    >
                      <Save className="h-4 w-4" />
                      {saveNotesMutation.isPending ? "保存中…" : notesSaved ? "已保存" : "保存"}
                    </Button>
                  </div>
                  <Textarea
                    value={notesDraft}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                      setNotesDraft(e.target.value);
                      setNotesSaved(false);
                    }}
                    rows={4}
                    placeholder="在这里记录补充结论、复盘要点或待跟进事项，保存后持久化到报告。"
                  />
                  {saveNotesMutation.isError ? (
                    <div className="text-xs text-red-500">保存失败，请重试。</div>
                  ) : null}
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
          </div>
        </Tabs.Content>

        <Tabs.Content value="builder">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-start">
            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Settings2 className="h-5 w-5" />
                报告模板
              </div>
              <div className="space-y-3">
                <div className="text-sm font-semibold text-theme-1">快捷模板</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {REPORT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3 text-left transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]/5"
                      onClick={() => applyReportPreset(preset)}
                    >
                      <div className="text-sm font-semibold text-theme-2">{preset.label}</div>
                      <div className="mt-1 text-xs leading-5 text-theme-4">
                        {preset.audience} · {preset.tone}
                      </div>
                    </button>
                  ))}
                </div>
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

              <div className="space-y-3 rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                <div className="text-sm font-semibold text-theme-1">补充行动项</div>
                <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]">
                  <Input
                    value={manualActionTextDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setManualActionTextDraft(event.target.value)}
                    placeholder="行动项内容"
                  />
                  <Input
                    value={manualActionOwnerDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setManualActionOwnerDraft(event.target.value)}
                    placeholder="负责人"
                  />
                  <Input
                    value={manualActionDueDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setManualActionDueDraft(event.target.value)}
                    placeholder="截止时间"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-theme-4">
                    已补充 {manualActions.length} 条，会合并进入行动项和 Markdown 初稿。
                  </div>
                  <Button type="button" variant="secondary" onClick={addManualAction} disabled={!manualActionTextDraft.trim()}>
                    <ListChecks className="h-4 w-4" />
                    加入行动项
                  </Button>
                </div>
                {manualActions.length ? (
                  <div className="space-y-2">
                    {manualActions.map((item, index) => (
                      <div key={`${item.text}-${index}`} className="flex items-start justify-between gap-3 rounded-lg border border-theme-subtle bg-surface-1 px-3 py-2">
                        <div className="text-sm leading-6 text-theme-2">{manualActionText(item)}</div>
                        <button
                          type="button"
                          className="shrink-0 text-xs font-medium text-theme-4 hover:text-theme-2"
                          onClick={() => setManualActions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
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
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" onClick={copyMarkdownDraft} disabled={!selectedReport.data}>
                      <Copy className="h-4 w-4" />
                      复制
                    </Button>
                    <Button type="button" onClick={downloadMarkdownDraft} disabled={!selectedReport.data}>
                      <FileDown className="h-4 w-4" />
                      下载初稿
                    </Button>
                  </div>
                </div>
                {copyNotice ? (
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-2 text-xs text-theme-3">
                    {copyNotice}
                  </div>
                ) : null}
                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-theme-4">{reportAudience}</div>
                  <div className="mt-2 text-xl font-semibold text-theme-1">{reportTitle}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge>{reportTone}</Badge>
                    <Badge>{reportOwner || "负责人待补充"}</Badge>
                    <Badge>{reviewDate || "复盘时间待确认"}</Badge>
                  </div>
                  {customIntro.trim() ? (
                    <p className="mt-4 text-sm leading-7 text-theme-3">{customIntro}</p>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">初稿字数</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{draftStats.chars}</div>
                  </div>
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">预计阅读</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{draftStats.readMinutes} 分钟</div>
                  </div>
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">启用章节</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{draftStats.sections}</div>
                  </div>
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">非空行数</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{draftStats.lines}</div>
                  </div>
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
          <Card className="space-y-5">
            <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
              <Download className="h-5 w-5" />
              实时数据导出
            </div>
            <p className="text-sm leading-6 text-theme-3">
              导出实时会话归档数据，用于审计、归档和二次分析。
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
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
