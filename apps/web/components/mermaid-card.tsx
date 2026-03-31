"use client";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Card } from "@stream2graph/ui";

let mermaidReady: Promise<typeof import("mermaid")> | null = null;
let mermaidInitialized = false;
const GRAPH_HEADER_PATTERN = /^(graph|flowchart)(?:\s+([A-Za-z]{2}))?(?:\s*;\s*(.+))?$/i;
const GRAPH_CONTROL_PREFIXES = ["subgraph ", "end", "class ", "classdef ", "style ", "linkstyle ", "click "];
const GRAPH_NODE_PATTERN = String.raw`[A-Za-z][A-Za-z0-9_]{0,63}(?:\s*(?:\[[^\]\n]*\]|\([^\)\n]*\)|\{[^}\n]*\}|>[^<\n]*\]))?`;
const GRAPH_LABELED_EDGE_PATTERN = new RegExp(
  String.raw`^(?<lhs>${GRAPH_NODE_PATTERN})\s+--\s+(?<label>.+?)\s+--\s+(?<rhs>${GRAPH_NODE_PATTERN})$`,
);
const GRAPH_DOTTED_LABELED_EDGE_PATTERN = new RegExp(
  String.raw`^(?<lhs>${GRAPH_NODE_PATTERN})\s+-\.\s+(?<label>.+?)\s+\.-\s+(?<rhs>${GRAPH_NODE_PATTERN})$`,
);
const GRAPH_BOUNDARY_PATTERNS = [
  /(?<=[\]\)\}])\s+(?=[A-Za-z][A-Za-z0-9_]{0,63}\s*(?:\[|\(|\{|>|-->|==>|-.->|->>|-->>|<<--|<--|<->|---|--\s))/g,
  /(?<=[A-Za-z0-9_])\s+(?=[A-Za-z][A-Za-z0-9_]{0,63}\s*(?:-->|==>|-.->|->>|-->>|<<--|<--|<->|---|--\s))/g,
];

function extractMermaidCandidate(text: string) {
  const raw = (text || "").trim();
  const fenceMatch = raw.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1]?.trim() || "";
  }
  return raw.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "").trim();
}

function leadingDiagramType(lines: string[]) {
  for (const line of lines) {
    const lower = line.trim().toLowerCase();
    if (!lower) continue;
    if (lower === "---" || lower.startsWith("title:") || lower.startsWith("%%{") || lower.startsWith("%%")) {
      continue;
    }
    const token = lower.split(/\s+/, 1)[0];
    if (token === "graph" || token === "flowchart") return "flowchart";
    return token;
  }
  return "unknown";
}

function splitTopLevelStatements(line: string) {
  const parts: string[] = [];
  let buffer = "";
  let squareDepth = 0;
  let roundDepth = 0;
  let curlyDepth = 0;
  let quote: string | null = null;

  for (const char of line) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(0, curlyDepth - 1);
    else if (char === ";" && squareDepth === 0 && roundDepth === 0 && curlyDepth === 0) {
      const chunk = buffer.trim();
      if (chunk) parts.push(chunk);
      buffer = "";
      continue;
    }
    buffer += char;
  }

  const chunk = buffer.trim();
  if (chunk) parts.push(chunk);
  return parts;
}

function normalizeGraphStatement(statement: string) {
  let repaired = statement.trim();
  if (!repaired) return [];
  if (!/(-->|==>|-.->|->>|-->>|<<--|<--|<->)/.test(repaired)) {
    const labeledEdge = repaired.match(GRAPH_LABELED_EDGE_PATTERN);
    if (labeledEdge?.groups) {
      const label = labeledEdge.groups.label.trim().replace(/\s+/g, " ");
      return [`${labeledEdge.groups.lhs} -- ${label} --> ${labeledEdge.groups.rhs}`];
    }
    const dottedLabeledEdge = repaired.match(GRAPH_DOTTED_LABELED_EDGE_PATTERN);
    if (dottedLabeledEdge?.groups) {
      const label = dottedLabeledEdge.groups.label.trim().replace(/\s+/g, " ");
      return [`${dottedLabeledEdge.groups.lhs} -. ${label} .-> ${dottedLabeledEdge.groups.rhs}`];
    }
  }
  repaired = repaired.replace(
    /([A-Za-z][A-Za-z0-9_]{0,63}(?:\s*(?:\[[^\]\n]*\]|\([^\)\n]*\)|\{[^}\n]*\}|>[^<\n]*\]))?)\s+--\s+([A-Za-z][A-Za-z0-9_]{0,63}(?:\s*(?:\[[^\]\n]*\]|\([^\)\n]*\)|\{[^}\n]*\}|>[^<\n]*\]))?)(?=$|\s+[A-Za-z])/g,
    "$1 --> $2",
  );
  let previous: string | null = null;
  while (repaired !== previous) {
    previous = repaired;
    for (const pattern of GRAPH_BOUNDARY_PATTERNS) {
      repaired = repaired.replace(pattern, "\n");
    }
  }
  return repaired
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeMermaidForRender(code: string) {
  const lines = extractMermaidCandidate(code)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim());
  if (leadingDiagramType(lines) !== "flowchart") {
    return lines.join("\n").trim();
  }

  const normalized: string[] = [];
  let headerProcessed = false;

  for (const line of lines) {
    const stripped = line.trim();
    const lower = stripped.toLowerCase();

    if (!headerProcessed && (lower === "---" || lower.startsWith("title:") || lower.startsWith("%%{") || lower.startsWith("%%"))) {
      normalized.push(stripped);
      continue;
    }

    if (!headerProcessed) {
      const match = stripped.match(GRAPH_HEADER_PATTERN);
      if (match) {
        normalized.push(`flowchart ${(match[2] || "TD").toUpperCase()}`);
        headerProcessed = true;
        const remainder = (match[3] || "").trim();
        if (remainder) {
          for (const chunk of splitTopLevelStatements(remainder)) {
            normalized.push(...normalizeGraphStatement(chunk));
          }
        }
        continue;
      }
      normalized.push(stripped);
      headerProcessed = true;
      continue;
    }

    if (GRAPH_CONTROL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      normalized.push(stripped);
      continue;
    }

    for (const chunk of splitTopLevelStatements(stripped)) {
      normalized.push(...normalizeGraphStatement(chunk));
    }
  }

  return normalized.join("\n").trim();
}

function summarizeMermaid(code: string, maxLength = 800) {
  const value = (code || "").trim();
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... [truncated ${value.length - maxLength} chars]`;
}

async function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid");
  }
  const mermaidPackage = await mermaidReady;
  if (!mermaidInitialized) {
    mermaidPackage.default.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "neutral",
      flowchart: {
        htmlLabels: false,
      },
    });
    mermaidInitialized = true;
  }
  return mermaidPackage.default;
}

/** @description Mermaid 编译/就绪状态徽章，供主舞台顶栏与卡片内复用 */
export function MermaidCompileStatusBadge({
  compileOk,
  updatedAt,
}: {
  compileOk?: boolean | null;
  updatedAt?: string | null;
}) {
  if (compileOk === false) {
    return (
      <Badge className="border-amber-200 bg-amber-50 text-amber-700">
        <AlertTriangle className="mr-1 h-3.5 w-3.5" />
        compile failed
      </Badge>
    );
  }
  if (updatedAt) {
    return (
      <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
        latest ready
      </Badge>
    );
  }
  return (
    <Badge>
      <Clock3 className="mr-1 h-3.5 w-3.5" />
      waiting
    </Badge>
  );
}

function MermaidCardBody({
  title,
  code,
  rawOutputText,
  repairRawOutputText,
  height = 360,
  provider,
  model,
  latencyMs,
  compileOk,
  updatedAt,
  headerExtra,
  embedded = false,
}: {
  title: string;
  code: string;
  rawOutputText?: string | null;
  repairRawOutputText?: string | null;
  height?: number;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  compileOk?: boolean | null;
  updatedAt?: string | null;
  /** @description 标题行右侧、与 latest ready 同排的附加徽章等 */
  headerExtra?: ReactNode;
  /** @description 为 true 时不渲染顶栏与外层 Card，由外层主舞台承载 */
  embedded?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState("");
  const [lastSuccessfulSvg, setLastSuccessfulSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lastLoggedRawOutputRef = useRef("");
  const lastLoggedRepairRawOutputRef = useRef("");
  const lastSuccessfulSvgRef = useRef("");
  const renderSequenceRef = useRef(0);

  useEffect(() => {
    const raw = (rawOutputText || "").trim();
    if (raw && raw !== lastLoggedRawOutputRef.current) {
      console.log(`[MermaidRawOutput]\n${raw}`);
      lastLoggedRawOutputRef.current = raw;
    }

    const repairRaw = (repairRawOutputText || "").trim();
    if (repairRaw && repairRaw !== lastLoggedRepairRawOutputRef.current) {
      console.log(`[MermaidRepairRawOutput]\n${repairRaw}`);
      lastLoggedRepairRawOutputRef.current = repairRaw;
    }
  }, [rawOutputText, repairRawOutputText]);

  useEffect(() => {
    let active = true;
    async function render() {
      const candidate = normalizeMermaidForRender(code);
      console.groupCollapsed("[MermaidCard] render start");
      console.info("[MermaidCard] card meta", { title, height, compileOk, updatedAt, provider, model, latencyMs });
      console.debug("[MermaidCard] raw code", summarizeMermaid(code));
      console.debug("[MermaidCard] render candidate", summarizeMermaid(candidate));
      if (!candidate) {
        setSvg("");
        setError("暂无 Mermaid 内容");
        console.warn("[MermaidCard] skipped: empty Mermaid content");
        console.groupEnd();
        return;
      }
      try {
        const mermaid = await getMermaid();
        renderSequenceRef.current += 1;
        const renderId = `mermaid-${id}-${renderSequenceRef.current}`;
        console.info("[MermaidCard] trying candidate", {
          length: candidate.length,
          preview: summarizeMermaid(candidate, 240),
        });
        const { svg: rendered } = await mermaid.render(renderId, candidate);
        const renderedSvg = rendered;

        if (!active) return;
        setSvg(renderedSvg);
        lastSuccessfulSvgRef.current = renderedSvg;
        setLastSuccessfulSvg(renderedSvg);
        setError(null);
        console.info("[MermaidCard] render success", {
          candidateLength: candidate.length,
          svgLength: renderedSvg.length,
        });
        console.groupEnd();
      } catch (err) {
        if (!active) return;
        setSvg(lastSuccessfulSvgRef.current);
        setError(err instanceof Error ? err.message : "渲染失败");
        console.warn("[MermaidCard] render failed", err);
        console.groupEnd();
      }
    }
    void render();
    return () => {
      active = false;
    };
  }, [code, id, compileOk, height, latencyMs, model, provider, title, updatedAt]);

  const body = (
    <div
      className={`bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(246,249,255,0.84))] p-4 ${
        embedded ? "flex h-full min-h-0 flex-col" : ""
      }`}
    >
        {error ? (
          <div className="mb-4 rounded-[24px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
            Mermaid 渲染错误：{error}
            {lastSuccessfulSvg ? " 已保留最近一次成功结果。" : ""}
          </div>
        ) : null}
        <div
          className={`overflow-auto rounded-[24px] border border-slate-400/20 bg-white/[0.84] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ${
            embedded ? "min-h-0 flex-1" : ""
          }`}
          style={embedded ? undefined : { minHeight: height }}
        >
          {svg ? (
            <div
              className="overflow-hidden rounded-[24px] [&_svg]:block [&_svg]:max-w-full [&_svg]:rounded-[24px]"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
          <div className="flex min-h-[160px] items-center justify-center text-sm text-slate-500">等待 Mermaid 内容...</div>
          )}
        </div>
        {!embedded && (provider || model || updatedAt) ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-200">
            {updatedAt ? <span>Updated at: {updatedAt}</span> : null}
            {compileOk === false ? (
              <Tooltip.Provider delayDuration={150}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <span className="cursor-help underline decoration-dotted">compile warning</span>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content sideOffset={8} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-lg">
                      服务端已检测到 Mermaid 编译失败，并保留了最近一次可用图。
                      <Tooltip.Arrow className="fill-white" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            ) : null}
          </div>
        ) : null}
        {embedded && compileOk === false ? (
          <div className="mt-4 text-xs text-slate-200">
            <Tooltip.Provider delayDuration={150}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span className="cursor-help underline decoration-dotted">compile warning</span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content sideOffset={8} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-lg">
                    服务端已检测到 Mermaid 编译失败，并保留了最近一次可用图。
                    <Tooltip.Arrow className="fill-white" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        ) : null}
      </div>
  );

  if (embedded) {
    return <div className="h-full min-h-0 overflow-hidden">{body}</div>;
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-slate-400/20 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-white/90">{title}</div>
          <div className="flex max-w-[min(100%,720px)] flex-wrap items-center justify-end gap-1.5">
            {provider ? <Badge>{provider}</Badge> : null}
            {model ? <Badge>{model}</Badge> : null}
            {typeof latencyMs === "number" ? <Badge>{latencyMs.toFixed(1)} ms</Badge> : null}
            <MermaidCompileStatusBadge compileOk={compileOk} updatedAt={updatedAt} />
            {headerExtra}
          </div>
        </div>
      </div>
      {body}
    </Card>
  );
}

export function MermaidCard(props: {
  title: string;
  code: string;
  rawOutputText?: string | null;
  repairRawOutputText?: string | null;
  height?: number;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  compileOk?: boolean | null;
  updatedAt?: string | null;
  headerExtra?: ReactNode;
  embedded?: boolean;
}) {
  return (
    <ErrorBoundary
      fallbackRender={({ error }: FallbackProps) => (
        <Card className="rounded-[26px] border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          Mermaid 面板异常：{error.message}
        </Card>
      )}
    >
      <MermaidCardBody {...props} />
    </ErrorBoundary>
  );
}
