"use client";

import { useState } from "react";

import { Card } from "@stream2graph/ui";
import { PanZoomCanvas } from "@/components/pan-zoom-canvas";
import { AnnotationLayer, type AnnotationDoc, type AnnotationTool } from "@/components/annotation-layer";
import { cn } from "@/lib/utils";

type RendererNode = {
  id: string;
  label: string;
  x: number;
  y: number;
};

type RendererEdge = {
  from: string;
  to: string;
};

type RendererGroup = {
  id: string;
  label: string;
  member_ids?: string[];
};

export function GraphStage({
  title,
  nodes,
  edges,
  groups = [],
  embedded = false,
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
  annotationExportHostId = "s2g-annotation-host-structure",
  /** @description 在 Realtime 中固定为浅底+浅色结构图 token，不随站点主题 */
  fixedLightCanvas = false,
}: {
  title: string;
  nodes: RendererNode[];
  edges: RendererEdge[];
  groups?: RendererGroup[];
  /** @description 为 true 时不渲染标题栏与外层 Card，由主舞台统一容器承载 */
  embedded?: boolean;
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
  const [zoomRebuildNonce, setZoomRebuildNonce] = useState(0);
  const isEmpty = nodes.length === 0;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const groupBoxes = groups
    .map((group) => {
      const members = (group.member_ids || [])
        .map((memberId) => nodeMap.get(memberId))
        .filter((node): node is RendererNode => Boolean(node));
      if (!members.length) return null;
      const paddingX = 46;
      const paddingTop = 54;
      const paddingBottom = 34;
      const minX = Math.min(...members.map((node) => node.x)) - paddingX;
      const maxX = Math.max(...members.map((node) => node.x)) + paddingX;
      const minY = Math.min(...members.map((node) => node.y)) - paddingTop;
      const maxY = Math.max(...members.map((node) => node.y)) + paddingBottom;
      return {
        id: group.id,
        label: group.label,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    })
    .filter((group): group is NonNullable<typeof group> => Boolean(group));

  const inner = (
      <div className={embedded ? "flex h-full min-h-0 min-w-0 flex-col bg-transparent" : "bg-transparent p-4"}>
        <PanZoomCanvas
          className={cn(
            embedded
              ? "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-default bg-[var(--mindmap-canvas-bg)] p-2 shadow-[inset_0_1px_0_var(--mindmap-inset-highlight)]"
              : "relative flex h-full min-h-[min(370px,51vh)] min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-theme-default bg-[var(--mindmap-canvas-bg)] p-3 shadow-[inset_0_1px_0_var(--mindmap-inset-highlight)]",
            fixedLightCanvas && "realtime-light-graph-surface",
          )}
          contentClassName="min-h-0 flex-1"
          onZoomEnd={() => setZoomRebuildNonce((n) => n + 1)}
          interactionMode={annotationsEnabled && annotationsTool !== "none" ? "annotate" : "panzoom"}
          minScale={0.55}
          maxScale={2.6}
          initialScale={1}
          initialOffset={{ x: 0, y: 0 }}
        >
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
          {isEmpty ? (
            <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center px-8 text-center">
              <p className="max-w-[560px] text-[12px] leading-relaxed text-theme-4 opacity-80">
                暂无结构节点，发送 Transcript 或开始录音后会自动更新。
              </p>
            </div>
          ) : null}
          <svg
            key={zoomRebuildNonce}
            viewBox="-120 -120 1240 760"
            className="relative z-[1] h-full min-h-0 w-full flex-1"
            shapeRendering="geometricPrecision"
            textRendering="geometricPrecision"
          >
          <defs>
            <marker id="arrowHead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--graph-svg-arrow)" />
            </marker>
          </defs>
          {groupBoxes.map((group) => (
            <g key={group.id}>
              <rect
                x={group.x}
                y={group.y}
                width={group.width}
                height={group.height}
                rx="24"
                fill="var(--graph-svg-group-fill)"
                stroke="var(--graph-svg-group-stroke)"
                strokeWidth="2"
                strokeDasharray="10 8"
              />
              <text x={group.x + 18} y={group.y + 28} fill="var(--graph-svg-group-label)" fontSize="13" fontWeight="700">
                {group.label || group.id}
              </text>
            </g>
          ))}
          {edges.map((edge, index) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={`${edge.from}-${edge.to}-${index}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="var(--graph-svg-edge)"
                strokeWidth="2"
                markerEnd="url(#arrowHead)"
              />
            );
          })}
          {nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
              <circle r="34" fill="var(--graph-svg-node-fill)" stroke="var(--graph-svg-node-stroke)" strokeWidth="2" />
              <text
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--graph-svg-node-text)"
                fontSize="12"
                fontWeight="600"
              >
                {(node.label || node.id).slice(0, 14)}
              </text>
            </g>
          ))}
          </svg>
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
  );

  if (embedded) {
    return <div className="min-h-0 overflow-hidden">{inner}</div>;
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-theme-default px-6 py-5">
        <div className="text-sm font-semibold text-theme-1">{title}</div>
      </div>
      {inner}
    </Card>
  );
}
