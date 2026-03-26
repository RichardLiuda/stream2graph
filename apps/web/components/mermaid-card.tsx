"use client";

import DOMPurify from "dompurify";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { Badge, Card } from "@stream2graph/ui";

let mermaidReady: Promise<typeof import("mermaid")> | null = null;
let mermaidInitialized = false;

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
    });
    mermaidInitialized = true;
  }
  return mermaidPackage.default;
}

function StatusBadge({ compileOk, updatedAt }: { compileOk?: boolean | null; updatedAt?: string | null }) {
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
  height = 360,
  provider,
  model,
  latencyMs,
  compileOk,
  updatedAt,
}: {
  title: string;
  code: string;
  height?: number;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  compileOk?: boolean | null;
  updatedAt?: string | null;
}) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState("");
  const [lastSuccessfulSvg, setLastSuccessfulSvg] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function render() {
      if (!code.trim()) {
        setSvg("");
        setError("暂无 Mermaid 内容");
        return;
      }
      try {
        const mermaid = await getMermaid();
        const { svg: rendered } = await mermaid.render(`mermaid-${id}`, code);
        if (!active) return;
        const sanitized = DOMPurify.sanitize(rendered, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        setSvg(sanitized);
        setLastSuccessfulSvg(sanitized);
        setError(null);
      } catch (err) {
        if (!active) return;
        setSvg(lastSuccessfulSvg);
        setError(err instanceof Error ? err.message : "渲染失败");
      }
    }
    void render();
    return () => {
      active = false;
    };
  }, [code, id, lastSuccessfulSvg]);

  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-white/70 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="flex flex-wrap items-center gap-2">
            {provider ? <Badge>{provider}</Badge> : null}
            {model ? <Badge>{model}</Badge> : null}
            {typeof latencyMs === "number" ? <Badge>{latencyMs.toFixed(1)} ms</Badge> : null}
            <StatusBadge compileOk={compileOk} updatedAt={updatedAt} />
          </div>
        </div>
      </div>
      <div className="bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(246,249,255,0.84))] p-5">
        {error ? (
          <div className="mb-4 rounded-[24px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
            Mermaid 渲染错误：{error}
            {lastSuccessfulSvg ? " 已保留最近一次成功结果。" : ""}
          </div>
        ) : null}
        <div
          className="overflow-auto rounded-[26px] border border-white/75 bg-white/[0.84] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
          style={{ minHeight: height }}
        >
          {svg ? (
            <div dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <div className="flex min-h-[220px] items-center justify-center text-sm text-slate-500">等待 Mermaid 内容...</div>
          )}
        </div>
        {(provider || model || updatedAt) && (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
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
        )}
      </div>
    </Card>
  );
}

export function MermaidCard(props: {
  title: string;
  code: string;
  height?: number;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  compileOk?: boolean | null;
  updatedAt?: string | null;
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
