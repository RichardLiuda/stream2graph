"use client";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3 } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Card } from "@stream2graph/ui";
import { PanZoomCanvas } from "@/components/pan-zoom-canvas";
import { AnnotationLayer, type AnnotationDoc, type AnnotationTool } from "@/components/annotation-layer";
import { cn } from "@/lib/utils";

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
const RICH_TEXT_TAG_PATTERN = /<\/?(?:span|b|strong|i|em|u|small|sub|sup|code|br)\b/i;
const MERMAID_THEME_CSS = `
.label p,
.nodeLabel p,
.edgeLabel p,
.cluster-label p {
  margin: 0;
}

.label strong,
.nodeLabel strong,
.edgeLabel strong,
.cluster-label strong {
  font-weight: 700;
}

.label em,
.nodeLabel em,
.edgeLabel em,
.cluster-label em {
  font-style: italic;
}

.label u,
.nodeLabel u,
.edgeLabel u,
.cluster-label u {
  text-decoration: underline;
}

.label code,
.nodeLabel code,
.edgeLabel code,
.cluster-label code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.92em;
}

.label small,
.nodeLabel small,
.edgeLabel small,
.cluster-label small {
  font-size: 0.82em;
}

/* 矢量锐化：高分屏与缩放时文字/线条更清晰 */
svg {
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;
}
svg .edgePath path.path,
svg path.flowchart-link {
  shape-rendering: geometricPrecision;
}
`;

type MermaidGraphNode = {
  id: string;
  label: string;
  kind?: string;
  metadata?: Record<string, unknown>;
};

type MermaidGraphGroup = {
  id: string;
  label: string;
  metadata?: Record<string, unknown>;
};

type MermaidGraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind?: string;
  source_index?: number;
  metadata?: Record<string, unknown>;
};

export type MermaidGraphPayload = {
  nodes?: MermaidGraphNode[];
  groups?: MermaidGraphGroup[];
  edges?: MermaidGraphEdge[];
  metadata?: Record<string, unknown>;
} | null;

export type MermaidDiagramEntityPosition = {
  id: string;
  label: string;
  kind: "node" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MermaidNodeRelayoutPayload = {
  node_id: string;
  node_label: string;
  from_position: { x: number; y: number };
  to_position: { x: number; y: number };
  delta: { x: number; y: number };
  relation_hint: string | null;
  nearest_anchor_id: string | null;
  nearest_anchor_label: string | null;
  target_group_id: string | null;
  target_group_label: string | null;
  node_positions: MermaidDiagramEntityPosition[];
  group_positions: MermaidDiagramEntityPosition[];
  spatial_summary: string;
};

type MermaidInteractiveEntity = MermaidDiagramEntityPosition & {
  element: SVGGElement;
};

type MermaidRenderedEdge = {
  edge: MermaidGraphEdge;
  path: SVGPathElement;
  container: SVGGElement | SVGPathElement;
  relationType: string;
  crossLane: boolean;
};

type SvgPoint = {
  x: number;
  y: number;
};

function roundCoordinate(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeLabelText(value: string | null | undefined) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string, fallback = "") {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string, fallback = 0) {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string, fallback = false) {
  const value = metadata?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
  }
  return fallback;
}

function fallbackLaneColor(index: number) {
  const palette = ["#eff6ff", "#fef3c7", "#ecfccb", "#fce7f3", "#ede9fe", "#cffafe"];
  return palette[index % palette.length] || "#eff6ff";
}

function buildLabelToIdMap(items: Array<{ id: string; label: string }> | undefined) {
  const counts = new Map<string, number>();
  for (const item of items || []) {
    const label = normalizeLabelText(item.label);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const mapping = new Map<string, string>();
  for (const item of items || []) {
    const label = normalizeLabelText(item.label);
    if (!label || counts.get(label) !== 1) continue;
    mapping.set(label, item.id);
  }
  return mapping;
}

function resolveSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): SvgPoint | null {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const resolved = point.matrixTransform(matrix.inverse());
  return {
    x: roundCoordinate(resolved.x),
    y: roundCoordinate(resolved.y),
  };
}

function measureEntity(svg: SVGSVGElement, element: SVGGElement) {
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const topLeft = resolveSvgPoint(svg, rect.left, rect.top);
  const bottomRight = resolveSvgPoint(svg, rect.right, rect.bottom);
  if (!topLeft || !bottomRight) return null;
  const width = Math.abs(bottomRight.x - topLeft.x);
  const height = Math.abs(bottomRight.y - topLeft.y);
  return {
    x: roundCoordinate((topLeft.x + bottomRight.x) / 2),
    y: roundCoordinate((topLeft.y + bottomRight.y) / 2),
    width: roundCoordinate(width),
    height: roundCoordinate(height),
  };
}

function resolveFlowchartEntityId(
  rawId: string,
  kind: "node" | "group",
  knownIds: string[],
  label: string,
  labelToId: Map<string, string>,
) {
  const candidates = [...knownIds].sort((left, right) => right.length - left.length);
  if (kind === "node") {
    const matched = candidates.find((item) => rawId.includes(`flowchart-${item}-`));
    if (matched) return matched;
  } else {
    const matched = candidates.find((item) => rawId.endsWith(`-${item}`));
    if (matched) return matched;
  }
  return labelToId.get(label) || null;
}

function collectInteractiveEntities(
  svg: SVGSVGElement,
  graphPayload: MermaidGraphPayload,
): { nodes: MermaidInteractiveEntity[]; groups: MermaidInteractiveEntity[] } {
  const graphNodes = graphPayload?.nodes || [];
  const graphGroups = graphPayload?.groups || [];
  const nodeLabelToId = buildLabelToIdMap(graphNodes);
  const groupLabelToId = buildLabelToIdMap(graphGroups);

  const nodes: MermaidInteractiveEntity[] = [];
  for (const element of Array.from(svg.querySelectorAll<SVGGElement>("g.node"))) {
    const label = normalizeLabelText(element.textContent);
    const id = resolveFlowchartEntityId(
      element.getAttribute("id") || "",
      "node",
      graphNodes.map((item) => item.id),
      label,
      nodeLabelToId,
    );
    if (!id) continue;
    const measured = measureEntity(svg, element);
    if (!measured) continue;
    const matchedNode = graphNodes.find((item) => item.id === id);
    nodes.push({
      element,
      id,
      label: matchedNode?.label || label || id,
      kind: "node",
      ...measured,
    });
  }

  const groups: MermaidInteractiveEntity[] = [];
  for (const element of Array.from(svg.querySelectorAll<SVGGElement>("g.cluster"))) {
    const label = normalizeLabelText(element.textContent);
    const id = resolveFlowchartEntityId(
      element.getAttribute("id") || "",
      "group",
      graphGroups.map((item) => item.id),
      label,
      groupLabelToId,
    );
    if (!id) continue;
    const measured = measureEntity(svg, element);
    if (!measured) continue;
    const matchedGroup = graphGroups.find((item) => item.id === id);
    groups.push({
      element,
      id,
      label: matchedGroup?.label || label || id,
      kind: "group",
      ...measured,
    });
  }

  return { nodes, groups };
}

function collectRenderedEdges(svg: SVGSVGElement, graphPayload: MermaidGraphPayload): MermaidRenderedEdge[] {
  const graphEdges = [...(graphPayload?.edges || [])].sort(
    (left, right) => (left.source_index || 0) - (right.source_index || 0) || left.id.localeCompare(right.id),
  );
  const fallbackPaths = Array.from(svg.querySelectorAll<SVGPathElement>("path.flowchart-link"));

  return graphEdges
    .map((edge, index) => {
      const metadata = edge.metadata || {};
      const mermaidSourceId = metadataString(metadata, "mermaid_source_id");
      const mermaidTargetId = metadataString(metadata, "mermaid_target_id");
      const selector =
        mermaidSourceId && mermaidTargetId ? `[id^="L_${mermaidSourceId}_${mermaidTargetId}_"]` : "";
      const matchedElement = selector ? svg.querySelector<SVGElement>(selector) : null;
      const candidatePath =
        (matchedElement?.closest?.("g.edgePath")?.querySelector("path.path, path.flowchart-link") as SVGPathElement | null) ||
        (matchedElement instanceof SVGPathElement ? matchedElement : null) ||
        fallbackPaths[index] ||
        null;
      if (!(candidatePath instanceof SVGPathElement)) return null;
      const container = candidatePath.closest("g.edgePath");
      return {
        edge,
        path: candidatePath,
        container: container instanceof SVGGElement ? container : candidatePath,
        relationType: metadataString(metadata, "relation_type", edge.kind || "reply"),
        crossLane: metadataBoolean(metadata, "cross_lane"),
      };
    })
    .filter((item): item is MermaidRenderedEdge => Boolean(item));
}

function collectHighlightPath(startNodeId: string, edges: MermaidRenderedEdge[], maxDepth = 2) {
  const edgesByNode = new Map<string, MermaidRenderedEdge[]>();
  for (const edge of edges) {
    const current = edgesByNode.get(edge.edge.source) || [];
    current.push(edge);
    edgesByNode.set(edge.edge.source, current);
    const reverse = edgesByNode.get(edge.edge.target) || [];
    reverse.push(edge);
    edgesByNode.set(edge.edge.target, reverse);
  }

  const activeNodeIds = new Set<string>([startNodeId]);
  const activeEdgeIds = new Set<string>();
  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth >= maxDepth) continue;
    for (const edge of edgesByNode.get(current.nodeId) || []) {
      activeEdgeIds.add(edge.edge.id);
      const neighbor = edge.edge.source === current.nodeId ? edge.edge.target : edge.edge.source;
      if (!activeNodeIds.has(neighbor)) {
        activeNodeIds.add(neighbor);
        queue.push({ nodeId: neighbor, depth: current.depth + 1 });
      }
    }
  }

  return { activeNodeIds, activeEdgeIds };
}

function relationHintBetween(source: SvgPoint, target: SvgPoint | null) {
  if (!target) return null;
  const dx = roundCoordinate(source.x - target.x);
  const dy = roundCoordinate(source.y - target.y);
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX <= 12 && absY <= 12) return "overlapping";
  if (absX > absY * 1.25) return dx >= 0 ? "right_of" : "left_of";
  if (absY > absX * 1.25) return dy >= 0 ? "below" : "above";
  if (dx >= 0 && dy >= 0) return "lower_right_of";
  if (dx >= 0) return "upper_right_of";
  if (dy >= 0) return "lower_left_of";
  return "upper_left_of";
}

function pointInsideEntity(point: SvgPoint, entity: MermaidDiagramEntityPosition) {
  return (
    point.x >= entity.x - entity.width / 2 &&
    point.x <= entity.x + entity.width / 2 &&
    point.y >= entity.y - entity.height / 2 &&
    point.y <= entity.y + entity.height / 2
  );
}

function svgTransformWithDelta(originalTransform: string, delta: SvgPoint) {
  const prefix = originalTransform.trim();
  const extra = `translate(${delta.x} ${delta.y})`;
  return prefix ? `${prefix} ${extra}` : extra;
}

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

function shouldBypassFlowchartRepair(source: string) {
  if (RICH_TEXT_TAG_PATTERN.test(source)) {
    return true;
  }

  let squareDepth = 0;
  let roundDepth = 0;
  let curlyDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const char of source) {
    if (char === "\n" && (quote || squareDepth > 0 || roundDepth > 0 || curlyDepth > 0)) {
      return true;
    }

    if (quote) {
      if (!escaped && char === "\\") {
        escaped = true;
        continue;
      }
      if (!escaped && char === quote) {
        quote = null;
      }
      escaped = false;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      escaped = false;
      continue;
    }

    if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(0, curlyDepth - 1);
  }

  return false;
}

function normalizeMermaidForRender(code: string) {
  const source = extractMermaidCandidate(code).replace(/\r\n/g, "\n");
  if (shouldBypassFlowchartRepair(source)) {
    return source.trim();
  }

  const lines = source
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
      suppressErrorRendering: true,
      theme: "base",
      // Use SVG-native labels to avoid `foreignObject` blur when the canvas is pan/zoomed.
      htmlLabels: false,
      themeCSS: MERMAID_THEME_CSS,
      /** 系统 UI 字体 + 更大字号，减少「小图被放大」时的糊感 */
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC", "Helvetica Neue", Arial, sans-serif',
      themeVariables: {
        fontSize: "18px",
      },
      flowchart: {
        padding: 14,
        nodeSpacing: 58,
        rankSpacing: 58,
        diagramPadding: 14,
        useMaxWidth: true,
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
      <Badge className="border-amber-900/60 bg-amber-950/45 text-amber-200/95 normal-case tracking-normal">
        <AlertTriangle className="mr-1 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        编译失败
      </Badge>
    );
  }
  if (updatedAt) {
    return (
      <Badge className="border-emerald-900/55 bg-emerald-950/35 text-emerald-200/90 normal-case tracking-normal">
        <CheckCircle2 className="mr-1 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        已就绪
      </Badge>
    );
  }
  return (
    <Badge className="normal-case tracking-normal text-theme-3">
      <Clock3 className="mr-1 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      等待内容
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
  collapsible = false,
  defaultDiagramExpanded = true,
  graphPayload = null,
  onNodeRelayout,
  relayoutBusy = false,
  exportRootId,
  annotationsEnabled = false,
  annotationsTool = "none",
  annotationPenWidth = 2,
  annotationPenColor = "rgba(229,231,235,0.92)",
  annotationRectColor = "rgba(229,231,235,0.92)",
  annotationRectStrokeWidth = 2,
  annotationTextColor = "rgba(229,231,235,0.92)",
  annotationEraserWidth = 12,
  annotationsDoc,
  onAnnotationsChange,
  annotationExportHostId = "s2g-annotation-host-mermaid",
  /** @description Realtime 嵌入时固定浅色画布 token */
  fixedLightCanvas = false,
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
  /** @description 为 true 时标题栏可折叠画布区域（非 embedded 时生效） */
  collapsible?: boolean;
  defaultDiagramExpanded?: boolean;
  graphPayload?: MermaidGraphPayload;
  onNodeRelayout?: ((payload: MermaidNodeRelayoutPayload) => void) | null;
  relayoutBusy?: boolean;
  exportRootId?: string | null;
  annotationsEnabled?: boolean;
  annotationsTool?: AnnotationTool;
  annotationPenWidth?: number;
  annotationPenColor?: string;
  annotationRectColor?: string;
  annotationRectStrokeWidth?: number;
  annotationTextColor?: string;
  annotationEraserWidth?: number;
  annotationsDoc?: AnnotationDoc;
  onAnnotationsChange?: (next: AnnotationDoc) => void;
  annotationExportHostId?: string;
  fixedLightCanvas?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const [diagramExpanded, setDiagramExpanded] = useState(defaultDiagramExpanded);
  const [svg, setSvg] = useState("");
  const [lastSuccessfulSvg, setLastSuccessfulSvg] = useState("");
  const [zoomRebuildNonce, setZoomRebuildNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const lastLoggedRawOutputRef = useRef("");
  const lastLoggedRepairRawOutputRef = useRef("");
  const lastSuccessfulSvgRef = useRef("");
  const renderSequenceRef = useRef(0);
  const renderSurfaceRef = useRef<HTMLDivElement | null>(null);
  const interactiveRelayoutEnabled = Boolean(onNodeRelayout && graphPayload?.nodes?.length);

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
        console.info("[MermaidCard] skipped: empty Mermaid content");
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
  }, [code, id, compileOk, height, latencyMs, model, provider, title, updatedAt, zoomRebuildNonce]);

  useEffect(() => {
    const host = renderSurfaceRef.current;
    if (!host || !svg || !graphPayload) return;
    const svgElement = host.querySelector("svg");
    if (!(svgElement instanceof SVGSVGElement)) return;

    const groupPayloadById = new Map((graphPayload.groups || []).map((group) => [group.id, group]));
    const nodePayloadById = new Map((graphPayload.nodes || []).map((node) => [node.id, node]));
    const collected = collectInteractiveEntities(svgElement, graphPayload);
    const renderedEdges = collectRenderedEdges(svgElement, graphPayload);
    const laneGroups = collected.groups.filter((group) => {
      const payload = groupPayloadById.get(group.id);
      return metadataString(payload?.metadata, "group_type") === "speaker_lane";
    });

    const svgNs = "http://www.w3.org/2000/svg";
    const overlayRoot = document.createElementNS(svgNs, "g");
    overlayRoot.setAttribute("data-s2g-overlay-layer", "lane-underlay");
    overlayRoot.setAttribute("pointer-events", "none");

    const firstRenderableChild =
      Array.from(svgElement.children).find((child) => {
        const tag = child.tagName.toLowerCase();
        return tag !== "defs" && tag !== "style";
      }) || svgElement.firstChild;
    if (laneGroups.length) {
      svgElement.insertBefore(overlayRoot, firstRenderableChild);
    }

    laneGroups.forEach((group, index) => {
      const payload = groupPayloadById.get(group.id);
      const rect = document.createElementNS(svgNs, "rect");
      const laneColor = metadataString(payload?.metadata, "lane_color", fallbackLaneColor(index));
      rect.setAttribute("data-s2g-lane-underlay", "true");
      rect.setAttribute("x", `${group.x - group.width / 2 - 16}`);
      rect.setAttribute("y", `${group.y - group.height / 2 - 18}`);
      rect.setAttribute("width", `${group.width + 32}`);
      rect.setAttribute("height", `${group.height + 36}`);
      rect.setAttribute("rx", "18");
      rect.setAttribute("ry", "18");
      rect.setAttribute("fill", laneColor);
      rect.setAttribute("fill-opacity", "0.32");
      rect.setAttribute("stroke", "#cbd5e1");
      rect.setAttribute("stroke-width", "1.5");
      overlayRoot.appendChild(rect);
    });

    const nodeElementById = new Map(collected.nodes.map((entity) => [entity.id, entity]));
    const groupElementById = new Map(collected.groups.map((entity) => [entity.id, entity]));

    const clearVisualState = () => {
      for (const entity of collected.nodes) {
        entity.element.style.opacity = "";
        entity.element.style.filter = "";
      }
      for (const entity of collected.groups) {
        entity.element.style.opacity = "";
        entity.element.style.filter = "";
      }
      for (const renderedEdge of renderedEdges) {
        renderedEdge.path.style.opacity = "";
        renderedEdge.path.style.filter = "";
        renderedEdge.path.style.strokeLinecap = "round";
        renderedEdge.path.style.transition = "opacity 120ms ease, filter 120ms ease, stroke-width 120ms ease";
        renderedEdge.container.style.opacity = "";
      }
    };

    const applyBaseStyles = () => {
      clearVisualState();
      laneGroups.forEach((group, index) => {
        const payload = groupPayloadById.get(group.id);
        const laneColor = metadataString(payload?.metadata, "lane_color", fallbackLaneColor(index));
        for (const shape of Array.from(group.element.querySelectorAll<SVGElement>("rect,polygon,path"))) {
          shape.style.stroke = "#334155";
          shape.style.strokeWidth = "2.2px";
          shape.style.fill = laneColor;
          shape.style.fillOpacity = "0.15";
        }
        for (const label of Array.from(group.element.querySelectorAll<SVGElement>("text,tspan"))) {
          label.style.fontWeight = "700";
          label.style.fill = "#0f172a";
        }
      });
      renderedEdges.forEach((renderedEdge) => {
        if (renderedEdge.relationType === "attack") {
          renderedEdge.path.style.stroke = "#dc2626";
          renderedEdge.path.style.strokeWidth = "2.8px";
        } else if (renderedEdge.relationType === "support") {
          renderedEdge.path.style.stroke = "#16a34a";
          renderedEdge.path.style.strokeWidth = "2.6px";
        } else if (renderedEdge.relationType === "reference") {
          renderedEdge.path.style.stroke = "#2563eb";
          renderedEdge.path.style.strokeWidth = "2.4px";
        } else if (renderedEdge.relationType === "elaborate") {
          renderedEdge.path.style.stroke = "#7c3aed";
          renderedEdge.path.style.strokeWidth = "2.3px";
        } else if (renderedEdge.crossLane) {
          renderedEdge.path.style.stroke = "#0f172a";
          renderedEdge.path.style.strokeWidth = "2.2px";
        } else {
          renderedEdge.path.style.strokeWidth = "2.1px";
        }
      });
    };

    const dimEverything = () => {
      collected.nodes.forEach((entity) => {
        entity.element.style.opacity = "0.18";
      });
      collected.groups.forEach((entity) => {
        entity.element.style.opacity = "0.18";
      });
      renderedEdges.forEach((renderedEdge) => {
        renderedEdge.path.style.opacity = "0.14";
        renderedEdge.container.style.opacity = "0.14";
      });
    };

    const highlightLaneIds = (laneIds: Set<string>) => {
      laneIds.forEach((laneId) => {
        const group = groupElementById.get(laneId);
        if (!group) return;
        group.element.style.opacity = "1";
        group.element.style.filter = "drop-shadow(0 0 12px rgba(15,23,42,0.12))";
      });
    };

    const activateNodePath = (nodeId: string) => {
      applyBaseStyles();
      dimEverything();
      const { activeNodeIds, activeEdgeIds } = collectHighlightPath(nodeId, renderedEdges, 2);
      const laneIds = new Set<string>();

      activeNodeIds.forEach((activeNodeId) => {
        const activeNode = nodeElementById.get(activeNodeId);
        const payload = nodePayloadById.get(activeNodeId);
        const laneId = metadataString(payload?.metadata, "lane_id");
        if (laneId) laneIds.add(laneId);
        if (!activeNode) return;
        activeNode.element.style.opacity = "1";
        activeNode.element.style.filter = "drop-shadow(0 0 12px rgba(37,99,235,0.22))";
      });

      highlightLaneIds(laneIds);

      renderedEdges.forEach((renderedEdge) => {
        if (!activeEdgeIds.has(renderedEdge.edge.id)) return;
        renderedEdge.container.style.opacity = "1";
        renderedEdge.path.style.opacity = "1";
        renderedEdge.path.style.filter = "drop-shadow(0 0 10px rgba(15,23,42,0.16))";
        renderedEdge.path.style.strokeWidth = renderedEdge.relationType === "attack" ? "3.6px" : "3.2px";
      });
    };

    const activateEdgeFocus = (targetEdge: MermaidRenderedEdge) => {
      applyBaseStyles();
      dimEverything();
      targetEdge.container.style.opacity = "1";
      targetEdge.path.style.opacity = "1";
      targetEdge.path.style.filter = "drop-shadow(0 0 12px rgba(15,23,42,0.18))";
      targetEdge.path.style.strokeWidth = targetEdge.relationType === "attack" ? "3.6px" : "3.2px";

      const sourceNode = nodeElementById.get(targetEdge.edge.source);
      const targetNode = nodeElementById.get(targetEdge.edge.target);
      const sourceLaneId = metadataString(nodePayloadById.get(targetEdge.edge.source)?.metadata, "lane_id");
      const targetLaneId = metadataString(nodePayloadById.get(targetEdge.edge.target)?.metadata, "lane_id");
      if (sourceNode) {
        sourceNode.element.style.opacity = "1";
        sourceNode.element.style.filter = "drop-shadow(0 0 12px rgba(37,99,235,0.22))";
      }
      if (targetNode) {
        targetNode.element.style.opacity = "1";
        targetNode.element.style.filter = "drop-shadow(0 0 12px rgba(37,99,235,0.22))";
      }
      highlightLaneIds(new Set([sourceLaneId, targetLaneId].filter(Boolean)));
    };

    applyBaseStyles();

    const cleanupFns: Array<() => void> = [];
    for (const entity of collected.nodes) {
      const handleEnter = () => activateNodePath(entity.id);
      const handleLeave = () => applyBaseStyles();
      entity.element.addEventListener("pointerenter", handleEnter);
      entity.element.addEventListener("pointerleave", handleLeave);
      cleanupFns.push(() => {
        entity.element.removeEventListener("pointerenter", handleEnter);
        entity.element.removeEventListener("pointerleave", handleLeave);
      });
    }

    for (const renderedEdge of renderedEdges) {
      if (!["attack", "support"].includes(renderedEdge.relationType)) continue;
      const handleEnter = () => activateEdgeFocus(renderedEdge);
      const handleLeave = () => applyBaseStyles();
      renderedEdge.container.addEventListener("pointerenter", handleEnter);
      renderedEdge.container.addEventListener("pointerleave", handleLeave);
      cleanupFns.push(() => {
        renderedEdge.container.removeEventListener("pointerenter", handleEnter);
        renderedEdge.container.removeEventListener("pointerleave", handleLeave);
      });
    }

    return () => {
      cleanupFns.forEach((cleanup) => cleanup());
      clearVisualState();
      if (overlayRoot.parentNode) {
        overlayRoot.parentNode.removeChild(overlayRoot);
      }
    };
  }, [graphPayload, svg, zoomRebuildNonce]);

  useEffect(() => {
    const host = renderSurfaceRef.current;
    if (!host || !svg || !interactiveRelayoutEnabled || !onNodeRelayout) return;
    const svgElement = host.querySelector("svg");
    if (!(svgElement instanceof SVGSVGElement)) return;

    const collected = collectInteractiveEntities(svgElement, graphPayload);
    if (!collected.nodes.length) return;

    const nodeEntities = collected.nodes.map(({ element, ...entity }) => entity);
    const groupEntities = collected.groups.map(({ element, ...entity }) => entity);
    const entityByElement = new Map<SVGGElement, MermaidInteractiveEntity>();

    for (const entity of collected.nodes) {
      entity.element.setAttribute("data-panzoom-no-pan", "true");
      entity.element.style.cursor = relayoutBusy ? "wait" : "grab";
      entityByElement.set(entity.element, entity);
    }

    type DragState = {
      pointerId: number;
      element: SVGGElement;
      entity: MermaidInteractiveEntity;
      startPoint: SvgPoint;
      originalTransform: string;
      currentDelta: SvgPoint;
    };

    let dragState: DragState | null = null;

    const resetTransform = (state: DragState) => {
      if (state.originalTransform.trim()) {
        state.element.setAttribute("transform", state.originalTransform);
      } else {
        state.element.removeAttribute("transform");
      }
      state.element.style.cursor = relayoutBusy ? "wait" : "grab";
    };

    const commitDrag = (state: DragState) => {
      const movedDistance = Math.hypot(state.currentDelta.x, state.currentDelta.y);
      if (movedDistance < 18) return;

      const movedNodes = nodeEntities.map((entity) =>
        entity.id === state.entity.id
          ? {
              ...entity,
              x: roundCoordinate(entity.x + state.currentDelta.x),
              y: roundCoordinate(entity.y + state.currentDelta.y),
            }
          : entity,
      );
      const movedNode = movedNodes.find((entity) => entity.id === state.entity.id);
      if (!movedNode) return;

      const nearestAnchor =
        movedNodes
          .filter((entity) => entity.id !== movedNode.id)
          .sort((left, right) => {
            const leftDistance = Math.hypot(left.x - movedNode.x, left.y - movedNode.y);
            const rightDistance = Math.hypot(right.x - movedNode.x, right.y - movedNode.y);
            return leftDistance - rightDistance;
          })[0] || null;
      const targetGroup =
        groupEntities
          .filter((entity) => pointInsideEntity({ x: movedNode.x, y: movedNode.y }, entity))
          .sort((left, right) => left.width * left.height - right.width * right.height)[0] || null;
      const relationHint = relationHintBetween(
        { x: movedNode.x, y: movedNode.y },
        nearestAnchor ? { x: nearestAnchor.x, y: nearestAnchor.y } : null,
      );

      onNodeRelayout({
        node_id: movedNode.id,
        node_label: movedNode.label,
        from_position: {
          x: state.entity.x,
          y: state.entity.y,
        },
        to_position: {
          x: movedNode.x,
          y: movedNode.y,
        },
        delta: {
          x: state.currentDelta.x,
          y: state.currentDelta.y,
        },
        relation_hint: relationHint,
        nearest_anchor_id: nearestAnchor?.id || null,
        nearest_anchor_label: nearestAnchor?.label || null,
        target_group_id: targetGroup?.id || null,
        target_group_label: targetGroup?.label || null,
        node_positions: movedNodes,
        group_positions: groupEntities,
        spatial_summary: [
          `Moved node "${movedNode.label}" (${movedNode.id}) from (${state.entity.x}, ${state.entity.y}) to (${movedNode.x}, ${movedNode.y}).`,
          nearestAnchor
            ? `Nearest anchor after drop: "${nearestAnchor.label}" (${nearestAnchor.id}); relation_hint=${relationHint || "unknown"}.`
            : "No nearby anchor node after drop.",
          targetGroup ? `Dropped inside group "${targetGroup.label}" (${targetGroup.id}).` : "Dropped outside any group.",
        ].join(" "),
      });
    };

    const finishDrag = (pointerId: number, commit: boolean) => {
      if (!dragState || dragState.pointerId !== pointerId) return;
      const completedDrag = dragState;
      dragState = null;
      try {
        if (host.hasPointerCapture(pointerId)) {
          host.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore stale capture cleanup.
      }
      resetTransform(completedDrag);
      if (commit) {
        commitDrag(completedDrag);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (relayoutBusy || (event.pointerType === "mouse" && event.button !== 0)) return;
      const target = event.target as Element | null;
      const nodeElement = target?.closest?.("g.node");
      if (!(nodeElement instanceof SVGGElement)) return;
      const entity = entityByElement.get(nodeElement);
      if (!entity) return;
      const startPoint = resolveSvgPoint(svgElement, event.clientX, event.clientY);
      if (!startPoint) return;

      event.preventDefault();
      event.stopPropagation();
      host.setPointerCapture(event.pointerId);
      nodeElement.style.cursor = "grabbing";
      dragState = {
        pointerId: event.pointerId,
        element: nodeElement,
        entity,
        startPoint,
        originalTransform: nodeElement.getAttribute("transform") || "",
        currentDelta: { x: 0, y: 0 },
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const currentPoint = resolveSvgPoint(svgElement, event.clientX, event.clientY);
      if (!currentPoint) return;
      dragState.currentDelta = {
        x: roundCoordinate(currentPoint.x - dragState.startPoint.x),
        y: roundCoordinate(currentPoint.y - dragState.startPoint.y),
      };
      dragState.element.setAttribute(
        "transform",
        svgTransformWithDelta(dragState.originalTransform, dragState.currentDelta),
      );
      event.preventDefault();
      event.stopPropagation();
    };

    const handlePointerUp = (event: PointerEvent) => {
      finishDrag(event.pointerId, true);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      finishDrag(event.pointerId, false);
    };

    host.addEventListener("pointerdown", handlePointerDown);
    host.addEventListener("pointermove", handlePointerMove);
    host.addEventListener("pointerup", handlePointerUp);
    host.addEventListener("pointercancel", handlePointerCancel);

    return () => {
      host.removeEventListener("pointerdown", handlePointerDown);
      host.removeEventListener("pointermove", handlePointerMove);
      host.removeEventListener("pointerup", handlePointerUp);
      host.removeEventListener("pointercancel", handlePointerCancel);
      if (dragState) {
        resetTransform(dragState);
        dragState = null;
      }
    };
  }, [graphPayload, interactiveRelayoutEnabled, onNodeRelayout, relayoutBusy, svg, zoomRebuildNonce]);

  const viewportMinCss = `min(${height}px, 51vh)`;
  const panZoomCanvasStyle = embedded ? { minHeight: 0 } : { minHeight: viewportMinCss };
  const showDiagram = !collapsible || diagramExpanded;

  const panZoomChromeClass = cn(
    embedded
      ? "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-default bg-[var(--mindmap-canvas-bg)] p-2 shadow-[inset_0_1px_0_var(--mindmap-inset-highlight)]"
      : "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-theme-default bg-[var(--mindmap-canvas-bg)] p-3 shadow-[inset_0_1px_0_var(--mindmap-inset-highlight)]",
    fixedLightCanvas && "realtime-light-graph-surface",
  );

  const body = (
    <div
      className={
        embedded ? "flex h-full min-h-0 min-w-0 flex-col bg-transparent" : "bg-surface-muted p-4"
      }
    >
        {error && !embedded ? (
          <div
            className={`rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2.5 text-xs leading-relaxed text-amber-100 ${
              embedded ? "mx-1 mb-2 shrink-0 sm:mx-2" : "mb-3"
            }`}
          >
            渲染错误：{error}
            {lastSuccessfulSvg ? " 已保留最近一次可用图。" : ""}
          </div>
        ) : null}
        <div
          className={
            embedded
              ? "min-h-0 min-w-0 flex-1 overflow-hidden"
              : `overflow-auto rounded-xl border border-theme-subtle bg-surface-1 p-4`
          }
          style={embedded ? undefined : { minHeight: viewportMinCss }}
        >
          <div className={embedded ? "flex h-full min-h-0 min-w-0 flex-1 flex-col" : ""}>
            <PanZoomCanvas
              className={panZoomChromeClass}
              contentClassName="min-h-0 flex-1"
              style={panZoomCanvasStyle}
              onZoomEnd={() => setZoomRebuildNonce((n) => n + 1)}
              interactionMode={annotationsEnabled && annotationsTool !== "none" ? "annotate" : "panzoom"}
              minScale={0.55}
              maxScale={2.6}
              initialScale={1}
              initialOffset={{ x: 0, y: 0 }}
              overlay={
                interactiveRelayoutEnabled ? (
                  <div className="rounded-md border border-theme-default bg-surface-muted px-2.5 py-1.5 text-[11px] leading-snug text-theme-3 shadow-lg backdrop-blur-[2px]">
                    {relayoutBusy ? "Planner 正在重新排布图…" : "拖拽节点即可让当前 Planner 重新组织图结构。"}
                  </div>
                ) : null
              }
            >
              {/* 空画布也要像画布：细网格 + 提示条 */}
              <div
                className={`pointer-events-none absolute rounded-md opacity-[var(--mindmap-grid-opacity)] ${
                  embedded ? "inset-2" : "inset-3"
                }`}
                aria-hidden
                style={{
                  backgroundImage:
                    "linear-gradient(var(--mindmap-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--mindmap-grid-line) 1px, transparent 1px)",
                  backgroundSize: "24px 24px",
                  backgroundPosition: "10px 10px",
                }}
              />
              {embedded && error && error !== "暂无 Mermaid 内容" ? (
                <div className="absolute left-2 right-2 top-2 z-[3] rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
                  渲染错误：{error}
                  {lastSuccessfulSvg ? " 已保留最近一次可用图。" : ""}
                </div>
              ) : null}
              {!svg ? (
                <div
                  className={`absolute z-[2] rounded-lg border border-amber-900/55 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-100 ${
                    embedded
                      ? error && error !== "暂无 Mermaid 内容"
                        ? "left-2 right-2 top-12"
                        : "left-2 right-2 top-2"
                      : "left-3 right-3 top-3"
                  }`}
                >
                  画布已就绪，但目前没有可渲染的 Mermaid。
                  <span className="text-amber-200/80">
                    {" "}
                    你可以：左侧发送 Transcript / 开始录音；会话建立后这里会自动更新。
                  </span>
                </div>
              ) : null}
              {svg ? (
                <div
                  key={zoomRebuildNonce}
                  ref={renderSurfaceRef}
                  data-mermaid-export-root={exportRootId || undefined}
                  className="relative z-[1] min-h-0 flex-1 [&_svg]:block [&_svg]:max-w-none [&_svg]:rounded-md [&_svg]:bg-white/90 [&_svg]:shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              ) : null}
              {annotationsDoc && onAnnotationsChange ? (
                <AnnotationLayer
                  enabled={annotationsEnabled}
                  tool={annotationsTool}
                  exportHostId={annotationExportHostId}
                  penWidth={annotationPenWidth}
                  penColor={annotationPenColor}
                  rectColor={annotationRectColor}
                  rectStrokeWidth={annotationRectStrokeWidth}
                  textColor={annotationTextColor}
                  eraserWidth={annotationEraserWidth}
                  doc={annotationsDoc}
                  onChange={onAnnotationsChange}
                />
              ) : null}
            </PanZoomCanvas>
          </div>
        </div>
        {!embedded && (provider || model || updatedAt) ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-theme-2">
            {updatedAt ? <span>Updated at: {updatedAt}</span> : null}
            {compileOk === false ? (
              <Tooltip.Provider delayDuration={150}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <span className="cursor-help underline decoration-dotted">compile warning</span>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content sideOffset={8} className="rounded-xl border border-theme-default bg-surface-1 px-3 py-2 text-xs text-theme-3 shadow-lg">
                      服务端已检测到 Mermaid 编译失败，并保留了最近一次可用图。
                      <Tooltip.Arrow className="fill-[var(--surface-1)]" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            ) : null}
          </div>
        ) : null}
        {embedded && compileOk === false ? (
          <div className="shrink-0 border-t border-theme-subtle px-3 py-2 text-xs text-theme-2">
            <Tooltip.Provider delayDuration={150}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span className="cursor-help underline decoration-dotted">compile warning</span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content sideOffset={8} className="rounded-xl border border-theme-default bg-surface-1 px-3 py-2 text-xs text-theme-3 shadow-lg">
                    服务端已检测到 Mermaid 编译失败，并保留了最近一次可用图。
                    <Tooltip.Arrow className="fill-[var(--surface-1)]" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        ) : null}
      </div>
  );

  if (embedded) {
    return <div className="h-full min-h-0 min-w-0 overflow-hidden">{body}</div>;
  }

  const headerBadges = (
    <>
      {provider ? <Badge>{provider}</Badge> : null}
      {model ? <Badge>{model}</Badge> : null}
      {typeof latencyMs === "number" ? <Badge>{latencyMs.toFixed(1)} ms</Badge> : null}
      <MermaidCompileStatusBadge compileOk={compileOk} updatedAt={updatedAt} />
      {headerExtra}
    </>
  );

  return (
    <Card className="overflow-hidden p-0">
      {collapsible ? (
        <button
          type="button"
          className="flex w-full flex-wrap items-center justify-between gap-3 border-0 border-b border-theme-default bg-transparent px-5 py-4 text-left hover:bg-surface-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--ring-focus)]"
          aria-expanded={diagramExpanded}
          onClick={() => setDiagramExpanded((open) => !open)}
        >
          <div className="text-sm font-semibold text-theme-2">{title}</div>
          <div className="flex max-w-[min(100%,720px)] flex-wrap items-center justify-end gap-1.5">
            {headerBadges}
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-theme-3 transition-transform ${diagramExpanded ? "rotate-180" : ""}`}
              aria-hidden
            />
          </div>
        </button>
      ) : (
        <div className="border-b border-theme-default px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-theme-2">{title}</div>
            <div className="flex max-w-[min(100%,720px)] flex-wrap items-center justify-end gap-1.5">{headerBadges}</div>
          </div>
        </div>
      )}
      {showDiagram ? (
        body
      ) : (
        <div className="border-b border-theme-default px-5 py-3 text-xs leading-snug text-theme-4">
          图预览已收起，点击标题栏可展开查看（画布内仍可平移与缩放）。
        </div>
      )}
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
  collapsible?: boolean;
  defaultDiagramExpanded?: boolean;
  graphPayload?: MermaidGraphPayload;
  onNodeRelayout?: ((payload: MermaidNodeRelayoutPayload) => void) | null;
  relayoutBusy?: boolean;
  exportRootId?: string | null;
  annotationsEnabled?: boolean;
  annotationsTool?: AnnotationTool;
  annotationPenWidth?: number;
  annotationPenColor?: string;
  annotationRectColor?: string;
  annotationRectStrokeWidth?: number;
  annotationTextColor?: string;
  annotationEraserWidth?: number;
  annotationsDoc?: AnnotationDoc;
  onAnnotationsChange?: (next: AnnotationDoc) => void;
  annotationExportHostId?: string;
  fixedLightCanvas?: boolean;
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
