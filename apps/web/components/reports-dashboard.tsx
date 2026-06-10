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
  Sparkles,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import type { RealtimeTimelineNode } from "@stream2graph/contracts";

import { Badge, Button, Card, Input, Textarea } from "@stream2graph/ui";

import { api, apiUrl } from "@/lib/api";
import { translate, useLanguagePreference, type I18nKey } from "@/lib/language";
import { loadRuntimePreferences } from "@/lib/runtime-preferences";

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
function getDashboardTabs(tr: (key: I18nKey) => string): Array<[DashboardTab, string]> {
  return [
    ["overview", tr("reportsDashboard.tab.overview")],
    ["builder", tr("reportsDashboard.tab.builder")],
    ["exports", tr("reportsDashboard.tab.exports")],
  ];
}
function getReportSections(tr: (key: I18nKey) => string) {
  return [
    { key: "summary" as ReportSectionKey, label: tr("reportsDashboard.section.summary"), description: tr("reportsDashboard.section.summaryDesc") },
    { key: "decisions" as ReportSectionKey, label: tr("reportsDashboard.section.decisions"), description: tr("reportsDashboard.section.decisionsDesc") },
    { key: "actions" as ReportSectionKey, label: tr("reportsDashboard.section.actions"), description: tr("reportsDashboard.section.actionsDesc") },
    { key: "risks" as ReportSectionKey, label: tr("reportsDashboard.section.risks"), description: tr("reportsDashboard.section.risksDesc") },
    { key: "graph" as ReportSectionKey, label: tr("reportsDashboard.section.graph"), description: tr("reportsDashboard.section.graphDesc") },
    { key: "timeline" as ReportSectionKey, label: tr("reportsDashboard.section.timeline"), description: tr("reportsDashboard.section.timelineDesc") },
    { key: "evidence" as ReportSectionKey, label: tr("reportsDashboard.section.evidence"), description: tr("reportsDashboard.section.evidenceDesc") },
  ];
}
const EXPORT_FORMATS = ["markdown", "json", "csv"] as const;
// 合并为两个实用模板：内部复盘（含全部章节）、对外摘要（隐藏时间轴和发言证据）
function getReportPresets(tr: (key: I18nKey) => string): ReportPreset[] {
  return [
    {
      id: "internal",
      label: tr("reportsDashboard.builder.internal"),
      audience: tr("reportsDashboard.audience.business"),
      tone: tr("reportsDashboard.tone.action"),
      intro: "",
      sections: { summary: true, decisions: true, actions: true, risks: true, graph: true, timeline: true, evidence: true },
    },
    {
      id: "external",
      label: tr("reportsDashboard.builder.external"),
      audience: tr("reportsDashboard.audience.client"),
      tone: tr("reportsDashboard.tone.executive"),
      intro: "",
      sections: { summary: true, decisions: true, actions: true, risks: true, graph: false, timeline: false, evidence: false },
    },
  ];
}

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

function reportSummaryText(report: ReportDetail | undefined, turns: TranscriptTurn[], versions: number, tr: (key: I18nKey, params?: Record<string, string | number>) => string) {
  if (!report) return tr("reportsDashboard.overview.selectReportHint");
  const summary = report.summary ?? {};
  const direct =
    asString(summary.meeting_summary) ||
    asString(summary.summary_text) ||
    asString(report.payload?.summary) ||
    asString(findRecordByKey(report.payload, "coordination_summary")?.summary);
  if (direct) return direct;
  const metrics = graphMetrics(report);
  const speakers = new Set(turns.map((turn) => turn.speaker)).size;
  return tr("reportsDashboard.overview.defaultSummary", { turns: turns.length, speakers, nodes: metrics.nodes, edges: metrics.edges, versions });
}

function deriveDecisionItems(report: ReportDetail | undefined, timelineNodes: RealtimeTimelineNode[], tr: (key: I18nKey, params?: Record<string, string | number>) => string) {
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
      ? tr("reportsDashboard.section.currentGraph", { nodes: metrics.nodes, edges: metrics.edges, groups: metrics.groups })
      : tr("reportsDashboard.section.noDecisions"),
    timelineNodes.length
      ? tr("reportsDashboard.section.timelineVersions", { count: timelineNodes.length })
      : tr("reportsDashboard.section.noTimeline"),
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

function manualActionText(item: ManualActionItem, tr: (key: I18nKey) => string) {
  const meta = [item.owner ? `${tr("reportsDashboard.builder.actionOwner")}：${item.owner}` : "", item.due ? `${tr("reportsDashboard.builder.actionDue")}：${item.due}` : ""]
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
  tr,
  aiSummary,
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
  tr: (key: I18nKey, params?: Record<string, string | number>) => string;
  aiSummary?: string;
}) {
  const lines = [
    `# ${title}`,
    "",
    `- ${tr("reportsDashboard.builder.audience")}：${audience}`,
    `- ${tr("reportsDashboard.builder.tone")}：${tone}`,
    `- ${tr("reportsDashboard.builder.reportTitle")}：${report?.title || tr("reportsDashboard.overview.noReportSelected")}`,
    `- ${tr("reportsDashboard.builder.owner")}：${owner || "—"}`,
    `- ${tr("reportsDashboard.builder.reviewDate")}：${reviewDate || "—"}`,
    "",
  ];

  if (intro.trim()) {
    lines.push(`## ${tr("reportsDashboard.builder.intro")}`, "", intro.trim(), "");
  }
  if (sections.summary) {
    lines.push(`## ${tr("reportsDashboard.section.summary")}`, "", summaryText, "");
  }
  if (sections.decisions) {
    lines.push(`## ${tr("reportsDashboard.section.decisions")}`, "", ...decisions.map((item, index) => `${index + 1}. ${item}`), "");
  }
  if (sections.actions) {
    lines.push(`## ${tr("reportsDashboard.section.actions")}`, "", ...actionItems.map((item, index) => `${index + 1}. ${item}`), "");
  }
  if (sections.risks) {
    lines.push(`## ${tr("reportsDashboard.section.risks")}`, "", ...riskItems.map((item, index) => `${index + 1}. ${item}`), "");
  }
  if (sections.graph) {
    lines.push(
      `## ${tr("reportsDashboard.section.graph")}`,
      "",
      `- ${tr("reportsDashboard.overview.nodes")}：${metrics.nodes}`,
      `- ${tr("reportsDashboard.overview.edges")}：${metrics.edges}`,
      `- ${tr("reportsDashboard.overview.groups")}：${metrics.groups}`,
      "",
    );
  }
  if (sections.timeline) {
    lines.push(
      `## ${tr("reportsDashboard.section.timeline")}`,
      "",
      ...(timelineNodes.length
        ? timelineNodes
            .slice(0, 8)
            .map((node, index) => `${index + 1}. ${node.label || "—"} · ${formatDateTime(node.created_at)}`)
        : [tr("reportsDashboard.section.noTimelineData")]),
      "",
    );
  }
  if (sections.evidence) {
    lines.push(
      `## ${tr("reportsDashboard.section.evidence")}`,
      "",
      ...(transcriptTurns.length
        ? transcriptTurns.slice(0, 8).map((turn) => `- ${turn.speaker}：${turn.text}`)
        : [tr("reportsDashboard.section.noEvidence")]),
      "",
    );
  }
  if (aiSummary) {
    lines.push(`## ${tr("reportsDashboard.aiSummary.title")}`, "", aiSummary, "");
  }
  return lines.join("\n");
}

export function ReportsDashboard() {
  const queryClient = useQueryClient();
  const [language] = useLanguagePreference();
  const tr = (key: I18nKey, params?: Record<string, string | number>) => translate(language, key, params);
  const dashboardTabs = getDashboardTabs(tr);
  const reportSections = getReportSections(tr);
  const reportPresets = getReportPresets(tr);
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("overview");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [selectedTimelineSnapshotId, setSelectedTimelineSnapshotId] = useState("");
  const [reportSearch, setReportSearch] = useState("");
  const [reportStatusFilter, setReportStatusFilter] = useState("all");
  const [reportTitle, setReportTitle] = useState(() => translate(language, "reportsDashboard.title"));
  const [reportAudience, setReportAudience] = useState(() => translate(language, "reportsDashboard.audience.business"));
  const [reportTone, setReportTone] = useState(() => translate(language, "reportsDashboard.tone.professional"));
  const [reportOwner, setReportOwner] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const [customIntro, setCustomIntro] = useState("");
  const [manualActionTextDraft, setManualActionTextDraft] = useState("");
  const [manualActionOwnerDraft, setManualActionOwnerDraft] = useState("");
  const [manualActionDueDraft, setManualActionDueDraft] = useState("");
  const [manualActions, setManualActions] = useState<ManualActionItem[]>([]);
  const [copyNotice, setCopyNotice] = useState("");
  const [aiSummaryText, setAiSummaryText] = useState("");
  const enableReportAiSummary = loadRuntimePreferences()?.enableReportAiSummary ?? false;

  const aiSummaryMutation = useMutation({
    mutationFn: () => api.summarizeReport(selectedReportId),
    onSuccess: (data) => {
      setAiSummaryText(data.summary);
      queryClient.invalidateQueries({ queryKey: ["reports", selectedReportId] });
    },
  });

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

  // Load existing AI summary from report data
  useEffect(() => {
    const existing = selectedReport.data?.summary?.ai_summary;
    if (typeof existing === "string" && existing.trim()) {
      setAiSummaryText(existing);
    } else {
      setAiSummaryText("");
    }
  }, [selectedReport.data?.summary, selectedReport.data?.report_id]);
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
      setReportTitle(`${selectedReport.data.title} · ${tr("reportsDashboard.overview.debriefSummary")}`);
    }
  }, [selectedReport.data?.title, tr]);

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
    () => deriveDecisionItems(selectedReport.data, timelineNodes, tr),
    [selectedReport.data, timelineNodes, tr],
  );
  const actionItems = useMemo(
    () => deriveActionItems(selectedReport.data),
    [selectedReport.data],
  );
  const riskItems = useMemo(
    () => deriveRiskItems(selectedReport.data),
    [selectedReport.data],
  );
  const summaryText = reportSummaryText(selectedReport.data, transcriptTurns, timelineNodes.length, tr);
  const selectedTimelineNode = timelineNodes.find((node) => node.snapshot_id === selectedTimelineSnapshotId) ?? null;
  const combinedActionItems = useMemo(
    () => [...actionItems, ...manualActions.map((item) => manualActionText(item, tr))],
    [actionItems, manualActions, tr],
  );
  const enabledSections = reportSections.filter((section) => sections[section.key]);
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
        tr,
        aiSummary: aiSummaryText || undefined,
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
      tr,
      aiSummaryText,
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
      setCopyNotice(tr("reportsDashboard.builder.copied"));
    } catch {
      setCopyNotice(tr("reportsDashboard.builder.copyFailed"));
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
          <h1 className="page-title">{tr("reportsDashboard.title")}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-theme-4">
            {tr("reportsDashboard.subtitle")}
          </p>
        </div>
        <a href="/app/realtime">
          <Button variant="secondary" className="gap-2">
            <Activity className="h-4 w-4" />
            {tr("reportsDashboard.backToRealtime")}
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
                dashboardTabs.findIndex(([value]) => value === dashboardTab),
              )} * 100%))`,
            }}
          />
          {dashboardTabs.map(([value, label]) => (
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
                  <div className="text-sm font-semibold text-theme-1">{tr("reportsDashboard.overview.reports")}</div>
                  <div className="mt-1 text-xs text-theme-4">{tr("reportsDashboard.overview.selectHint")}</div>
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
                    placeholder={tr("reportsDashboard.overview.search")}
                  />
                </label>
                <select
                  className="select-control"
                  value={reportStatusFilter}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setReportStatusFilter(event.target.value)}
                >
                  <option value="all">{tr("reportsDashboard.overview.allStatus")}</option>
                  {reportStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                {reports.isLoading ? (
                  <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-6 text-sm text-theme-4">
                    {tr("reportsDashboard.overview.loading")}
                  </div>
                ) : reports.isError ? (
                  <div className="rounded-lg border border-red-300/40 bg-red-500/5 px-4 py-6 text-sm text-red-400">
                    {tr("reportsDashboard.overview.loadError", { message: reports.error instanceof Error ? reports.error.message : "—" })}
                  </div>
                ) : filteredDebriefReports.length ? (
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
                    {tr("reportsDashboard.overview.noMatch")}
                  </div>
                )}
              </div>
            </Card>

            <div className="space-y-5">
              {selectedReport.isError ? (
                <Card className="px-4 py-6 text-sm text-red-400">
                  {tr("reportsDashboard.overview.loadError", { message: selectedReport.error instanceof Error ? selectedReport.error.message : "—" })}
                </Card>
              ) : null}
              <Card className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                      <FileText className="h-5 w-5" />
                      {tr("reportsDashboard.overview.debriefSummary")}
                    </div>
                    <div className="mt-1 text-sm text-theme-4">
                      {selectedReport.data?.title || tr("reportsDashboard.overview.defaultHint")}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge>{selectedReport.data?.status || "waiting"}</Badge>
                  </div>
                </div>

                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <Activity className="h-4 w-4" />
                    {tr("reportsDashboard.overview.workSummary")}
                  </div>
                  <p className="text-sm leading-7 text-theme-3">{summaryText}</p>
                  {enableReportAiSummary && selectedReportId ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => aiSummaryMutation.mutate()}
                        disabled={aiSummaryMutation.isPending || !selectedReport.data}
                      >
                        <Sparkles className="h-4 w-4" />
                        {aiSummaryMutation.isPending ? tr("reportsDashboard.aiSummary.summarizing") : tr("reportsDashboard.aiSummary.button")}
                      </Button>
                      {aiSummaryMutation.isError ? (
                        <span className="text-xs text-red-500">{tr("reportsDashboard.aiSummary.error")}</span>
                      ) : null}
                      {aiSummaryMutation.isSuccess && !aiSummaryText ? (
                        <span className="text-xs text-theme-4">{tr("reportsDashboard.aiSummary.success")}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {aiSummaryText ? (
                    <div className="mt-3 rounded-lg border border-[color:var(--accent-muted)] bg-[color:var(--accent)]/5 px-3 py-3">
                      <div className="mb-1 text-xs font-semibold text-[color:var(--accent-strong)]">{tr("reportsDashboard.aiSummary.title")}</div>
                      <p className="text-sm leading-7 text-theme-3 whitespace-pre-wrap">{aiSummaryText}</p>
                    </div>
                  ) : null}
                </div>

                {/* 复盘备注：可编辑并保存到后端 */}
                <div className="rounded-xl border border-theme-default bg-surface-muted px-4 py-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                      <FileText className="h-4 w-4" />
                      {tr("reportsDashboard.overview.notes")}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => saveNotesMutation.mutate(notesDraft)}
                      disabled={!selectedReportId || saveNotesMutation.isPending}
                    >
                      <Save className="h-4 w-4" />
                      {saveNotesMutation.isPending ? tr("reportsDashboard.overview.saving") : notesSaved ? tr("reportsDashboard.overview.saved") : tr("reportsDashboard.overview.save")}
                    </Button>
                  </div>
                  <Textarea
                    value={notesDraft}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                      setNotesDraft(e.target.value);
                      setNotesSaved(false);
                    }}
                    rows={4}
                    placeholder={tr("reportsDashboard.overview.notesPlaceholder")}
                  />
                  {saveNotesMutation.isError ? (
                    <div className="text-xs text-red-500">{tr("reportsDashboard.overview.saveFailed")}</div>
                  ) : null}
                </div>
              </Card>

              <Card className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-theme-1">
                    <GitBranch className="h-4 w-4" />
                    {tr("reportsDashboard.overview.graphChanges")}
                  </div>
                  <Badge>
                    {metrics.nodes} nodes / {metrics.edges} edges
                  </Badge>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {[
                    [tr("reportsDashboard.overview.nodes"), metrics.nodes],
                    [tr("reportsDashboard.overview.edges"), metrics.edges],
                    [tr("reportsDashboard.overview.groups"), metrics.groups],
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
                          v{index + 1} · {node.label || "—"}
                        </div>
                        <div className="mt-1 text-xs text-theme-4">{formatDateTime(node.created_at)}</div>
                      </div>
                      <Badge className="shrink-0">{node.chunk_count} chunks</Badge>
                    </button>
                  ))}
                  {!orderedTimelineNodes.length ? (
                    <div className="rounded-lg border border-dashed border-theme-subtle px-4 py-5 text-sm text-theme-4">
                      {tr("reportsDashboard.overview.noTimeline")}
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
                {tr("reportsDashboard.builder.template")}
              </div>
              <div className="space-y-3">
                <div className="text-sm font-semibold text-theme-1">{tr("reportsDashboard.builder.quickTemplate")}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {reportPresets.map((preset) => (
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
                  <span className="text-sm font-medium text-theme-2">{tr("reportsDashboard.builder.reportTitle")}</span>
                  <Input
                    value={reportTitle}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReportTitle(event.target.value)}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">{tr("reportsDashboard.builder.audience")}</span>
                  <select
                    className="select-control"
                    value={reportAudience}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => setReportAudience(event.target.value)}
                  >
                    {[tr("reportsDashboard.audience.business"), tr("reportsDashboard.audience.product"), tr("reportsDashboard.audience.tech"), tr("reportsDashboard.audience.acceptance"), tr("reportsDashboard.audience.client")].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">{tr("reportsDashboard.builder.tone")}</span>
                  <select
                    className="select-control"
                    value={reportTone}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => setReportTone(event.target.value)}
                  >
                    {[tr("reportsDashboard.tone.professional"), tr("reportsDashboard.tone.executive"), tr("reportsDashboard.tone.delivery"), tr("reportsDashboard.tone.review"), tr("reportsDashboard.tone.action")].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">{tr("reportsDashboard.builder.owner")}</span>
                  <Input
                    value={reportOwner}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReportOwner(event.target.value)}
                    placeholder={tr("reportsDashboard.builder.ownerPlaceholder")}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-theme-2">{tr("reportsDashboard.builder.reviewDate")}</span>
                  <Input
                    value={reviewDate}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setReviewDate(event.target.value)}
                    placeholder={tr("reportsDashboard.builder.reviewDatePlaceholder")}
                  />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-theme-2">{tr("reportsDashboard.builder.intro")}</span>
                  <Textarea
                    value={customIntro}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setCustomIntro(event.target.value)}
                    rows={4}
                  />
                </label>
              </div>

              <div className="space-y-3">
                <div className="text-sm font-semibold text-theme-1">{tr("reportsDashboard.builder.sections")}</div>
                <div className="grid gap-2 md:grid-cols-2">
                  {reportSections.map((section) => (
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
                <div className="text-sm font-semibold text-theme-1">{tr("reportsDashboard.builder.actionItems")}</div>
                <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]">
                  <Input
                    value={manualActionTextDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setManualActionTextDraft(event.target.value)}
                    placeholder={tr("reportsDashboard.builder.actionContent")}
                  />
                  <Input
                    value={manualActionOwnerDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setManualActionOwnerDraft(event.target.value)}
                    placeholder={tr("reportsDashboard.builder.actionOwner")}
                  />
                  <Input
                    value={manualActionDueDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setManualActionDueDraft(event.target.value)}
                    placeholder={tr("reportsDashboard.builder.actionDue")}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-theme-4">
                    {tr("reportsDashboard.builder.addedCount", { count: manualActions.length })}
                  </div>
                  <Button type="button" variant="secondary" onClick={addManualAction} disabled={!manualActionTextDraft.trim()}>
                    <ListChecks className="h-4 w-4" />
                    {tr("reportsDashboard.builder.addAction")}
                  </Button>
                </div>
                {manualActions.length ? (
                  <div className="space-y-2">
                    {manualActions.map((item, index) => (
                      <div key={`${item.text}-${index}`} className="flex items-start justify-between gap-3 rounded-lg border border-theme-subtle bg-surface-1 px-3 py-2">
                        <div className="text-sm leading-6 text-theme-2">{manualActionText(item, tr)}</div>
                        <button
                          type="button"
                          className="shrink-0 text-xs font-medium text-theme-4 hover:text-theme-2"
                          onClick={() => setManualActions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          {tr("reportsDashboard.builder.remove")}
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
                      {tr("reportsDashboard.builder.preview")}
                    </div>
                    <div className="mt-1 text-sm text-theme-4">{tr("reportsDashboard.builder.previewHint")}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" onClick={copyMarkdownDraft} disabled={!selectedReport.data}>
                      <Copy className="h-4 w-4" />
                      {tr("reportsDashboard.builder.copy")}
                    </Button>
                    <Button type="button" onClick={downloadMarkdownDraft} disabled={!selectedReport.data}>
                      <FileDown className="h-4 w-4" />
                      {tr("reportsDashboard.builder.downloadDraft")}
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
                    <Badge>{reportOwner || "—"}</Badge>
                    <Badge>{reviewDate || "—"}</Badge>
                  </div>
                  {customIntro.trim() ? (
                    <p className="mt-4 text-sm leading-7 text-theme-3">{customIntro}</p>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">{tr("reportsDashboard.builder.draftChars")}</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{draftStats.chars}</div>
                  </div>
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">{tr("reportsDashboard.builder.readTime")}</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{tr("reportsDashboard.builder.readTimeUnit", { minutes: draftStats.readMinutes })}</div>
                  </div>
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">{tr("reportsDashboard.builder.enabledSections")}</div>
                    <div className="mt-1 text-lg font-semibold text-theme-1">{draftStats.sections}</div>
                  </div>
                  <div className="rounded-lg border border-theme-subtle bg-surface-muted px-3 py-3">
                    <div className="text-xs text-theme-4">{tr("reportsDashboard.builder.nonEmptyLines")}</div>
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
                  {tr("reportsDashboard.builder.markdownDraft")}
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
              {tr("reportsDashboard.exports.title")}
            </div>
            <p className="text-sm leading-6 text-theme-3">
              {tr("reportsDashboard.exports.description")}
            </p>
            <div className="flex flex-wrap gap-2">
              {EXPORT_FORMATS.map((fmt) => (
                <a key={fmt} href={apiUrl(`/api/v1/reports/exports/download?target=realtime&fmt=${fmt}`)}>
                  <Button variant={fmt === "markdown" ? "primary" : "secondary"}>
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
