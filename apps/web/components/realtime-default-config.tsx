import Link from "next/link";
import { type ChangeEvent } from "react";

import type { RuntimeOptions } from "@stream2graph/contracts";
import { Button, Card } from "@stream2graph/ui";

type DiagramMode = "mermaid_primary" | "dual_view";

interface RealtimeDefaultConfigProps {
  runtimeOptions: RuntimeOptions | undefined;
  datasetVersions: Array<{ slug: string }>;
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
    datasetVersions,
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
      <Card className="soft-enter space-y-3">
        <div className="text-sm font-semibold text-theme-2">会话与录音</div>
        <details className="rounded-lg border border-theme-default bg-surface-muted px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wider text-theme-4 marker:content-none [&::-webkit-details-marker]:hidden">
            高级选项
          </summary>
          <div className="mt-3 space-y-2">
            <label className="text-xs font-medium text-theme-3">数据版本</label>
            <div className="relative">
              <select
                className="select-control appearance-none pr-9"
                value={datasetVersion}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setDatasetVersion(event.target.value)}
              >
                {datasetVersions.map((item) => (
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-theme-2">默认设置（只读）</div>
            <p className="mt-1 text-xs leading-snug text-theme-4">
              模型与显示方式在「设置」中修改；此处仅展示当前沿用的默认值。
            </p>
          </div>
          <Link href="/app/settings">
            <Button variant="secondary">打开配置页</Button>
          </Link>
        </div>
        {!hasGateProfiles || !hasPlannerProfiles || !hasSttProfiles ? (
          <div className="rounded-lg border border-amber-900/55 bg-amber-950/40 px-3 py-2.5 text-sm text-amber-100">
            服务端还缺少 Gate / Planner / STT 运行配置。请打开「设置」补全环境变量后重启 API。
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-4">
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
            <div key={item.label} className="rounded-lg border border-theme-default bg-surface-muted px-3 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-theme-4">{item.label}</div>
              <div className="mt-2 text-sm font-medium leading-snug text-theme-1">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
