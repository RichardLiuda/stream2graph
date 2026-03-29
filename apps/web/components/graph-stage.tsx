"use client";

import { Card } from "@stream2graph/ui";

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

export function GraphStage({
  title,
  nodes,
  edges,
  embedded = false,
}: {
  title: string;
  nodes: RendererNode[];
  edges: RendererEdge[];
  /** @description 为 true 时不渲染标题栏与外层 Card，由主舞台统一容器承载 */
  embedded?: boolean;
}) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const inner = (
      <div className="bg-[linear-gradient(180deg,rgba(248,251,255,0.9),rgba(239,244,255,0.86))] p-5">
        <svg
          viewBox="-120 -120 1240 760"
          className="h-[440px] w-full rounded-[26px] border border-white/75 bg-white/[0.82] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]"
        >
          <defs>
            <marker id="arrowHead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="#6d88d7" />
            </marker>
          </defs>
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
                stroke="#7b92d8"
                strokeWidth="2"
                markerEnd="url(#arrowHead)"
              />
            );
          })}
          {nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
              <circle r="34" fill="#f3f7ff" stroke="#5b79d8" strokeWidth="2" />
              <text
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#0f172a"
                fontSize="12"
                fontWeight="600"
              >
                {(node.label || node.id).slice(0, 14)}
              </text>
            </g>
          ))}
        </svg>
      </div>
  );

  if (embedded) {
    return <div className="min-h-0 overflow-hidden">{inner}</div>;
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-white/70 px-6 py-5">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
      </div>
      {inner}
    </Card>
  );
}
