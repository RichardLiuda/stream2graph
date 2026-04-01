"use client";

import { Card } from "@stream2graph/ui";
import { PanZoomCanvas } from "@/components/pan-zoom-canvas";

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
}: {
  title: string;
  nodes: RendererNode[];
  edges: RendererEdge[];
  groups?: RendererGroup[];
  /** @description 为 true 时不渲染标题栏与外层 Card，由主舞台统一容器承载 */
  embedded?: boolean;
}) {
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
      <div className="bg-transparent p-4">
        <PanZoomCanvas
          className="relative flex h-full min-h-[min(370px,51vh)] min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-theme-default bg-[var(--mindmap-canvas-bg)] shadow-[inset_0_1px_0_var(--mindmap-inset-highlight)]"
          contentClassName="min-h-0 flex-1"
          minScale={0.55}
          maxScale={2.6}
          initialScale={1}
          initialOffset={{ x: 0, y: 0 }}
        >
          <div
            className="pointer-events-none absolute inset-3 rounded-md opacity-[var(--mindmap-grid-opacity)]"
            aria-hidden
            style={{
              backgroundImage:
                "linear-gradient(var(--mindmap-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--mindmap-grid-line) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
              backgroundPosition: "10px 10px",
            }}
          />
          {isEmpty ? (
            <div className="absolute left-4 top-4 right-4 z-[2] rounded-lg border border-amber-900/55 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
              画布已就绪，但当前会话还没有结构节点。发送 Transcript 或开始录音后，结构视图会自动更新。
            </div>
          ) : null}
          <svg viewBox="-120 -120 1240 760" className="relative z-[1] h-full min-h-0 w-full flex-1">
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
