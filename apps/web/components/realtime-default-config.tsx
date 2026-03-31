import Link from "next/link";
import { type ChangeEvent } from "react";

import { Button, Card } from "@stream2graph/ui";

import type { RuntimeOptions } from "@/lib/api";

type DiagramMode = "mermaid_primary" | "dual_view";

interface RealtimeDefaultConfigProps {
  runtimeOptions: RuntimeOptions | undefined;
  datasetVersion: string;
  setDatasetVersion: (value: string) => void;
  gateLabel: string | null;
  gateModel: string;
  plannerLabel: string | null;
  plannerModel: string;
  sttLabel: string | null;
  sttModel: string;
  diagramMode: DiagramMode;
}

export function RealtimeDefaultConfig(props: RealtimeDefaultConfigProps) {
  const {
    runtimeOptions,
    datasetVersion,
    setDatasetVersion,
    gateLabel,
    gateModel,
    plannerLabel,
    plannerModel,
    sttLabel,
    sttModel,
    diagramMode,
  } = props;

  const hasGateProfiles = Boolean(runtimeOptions?.gate_profiles.length);
  const hasPlannerProfiles = Boolean(runtimeOptions?.planner_profiles.length);
  const hasSttProfiles = Boolean(runtimeOptions?.stt_profiles.length);

  return (
    <div className="space-y-4">
      <Card className="soft-enter space-y-4">
        <div className="text-sm font-semibold text-slate-100">会话与录音设置</div>
        <details className="rounded-[20px] border border-violet-200/45 bg-violet-100/35 px-4 py-3">
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 marker:content-none [&::-webkit-details-marker]:hidden">
            高级选项
          </summary>
          <div className="mt-3 space-y-3">
            <label className="text-sm font-medium text-slate-700">数据版本</label>
            <div className="relative">
              <select
                className="h-11 w-full appearance-none rounded-full border border-violet-200/50 bg-violet-50/88 px-4 pr-10 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-violet-50 focus:ring-4 focus:ring-[rgba(185,167,211,0.18)]"
                value={datasetVersion}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setDatasetVersion(event.target.value)}
              >
                {(runtimeOptions?.datasets ?? []).map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.slug}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </details>
      </Card>

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-100">默认设置（只读）</div>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              详细模型与显示方式请在「设置」里改。这里只显示当前会话会沿用的默认值。
            </p>
          </div>
          <Link href="/app/settings">
            <Button variant="secondary">
              打开配置页
            </Button>
          </Link>
        </div>
        {!hasGateProfiles || !hasPlannerProfiles || !hasSttProfiles ? (
          <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            服务端还缺少 Gate / Planner / STT 运行配置。请打开「设置」按提示补全环境变量后重启 API。
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-4">
          {[
            {
              label: "默认 Gate 模型",
              value: hasGateProfiles ? `${gateLabel || "未选择"} / ${gateModel || "未选择模型"}` : "未配置",
            },
            {
              label: "默认 Planner 模型",
              value: hasPlannerProfiles ? `${plannerLabel || "未选择"} / ${plannerModel || "未选择模型"}` : "未配置",
            },
            {
              label: "默认听写服务",
              value: hasSttProfiles ? `${sttLabel || "未选择"} / ${sttModel || "未选择模型"}` : "未配置",
            },
            {
              label: "显示方式",
              value: diagramMode === "dual_view" ? "流程图+结构图" : "仅流程图",
            },
          ].map((item) => (
            <div key={item.label} className="rounded-[22px] border border-violet-200/50 bg-violet-100/46 px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
              <div className="mt-3 text-sm font-semibold leading-6 text-slate-100">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

