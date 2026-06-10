"use client";

import Link from "next/link";
import { type ChangeEvent } from "react";

import type { RuntimeOptions } from "@stream2graph/contracts";
import { Button, Card } from "@stream2graph/ui";

import { translate, useLanguagePreference, type I18nKey } from "@/lib/language";

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
  const [language] = useLanguagePreference();
  const t = (key: I18nKey) => translate(language, key);

  return (
    <div className="space-y-4">
      <Card className="soft-enter space-y-3">
        <div className="text-sm font-semibold text-theme-2">
          {t("realtimeDefaultConfig.text001")}
        </div>
        <details className="rounded-lg border border-theme-default bg-surface-muted px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wider text-theme-4 marker:content-none [&::-webkit-details-marker]:hidden">
            {t("realtimeDefaultConfig.text002")}
          </summary>
          <div className="mt-3 space-y-2">
            <label className="text-xs font-medium text-theme-3">
              {t("realtimeDefaultConfig.text003")}
            </label>
            <div className="relative">
              <select
                className="select-control appearance-none pr-9"
                value={datasetVersion}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setDatasetVersion(event.target.value)}
              >
                {datasetVersions.length ? datasetVersions.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.slug}
                  </option>
                )) : (
                  <option value="">
                    {t("realtimeDefaultConfig.text004")}
                  </option>
                )}
              </select>
            </div>
          </div>
        </details>
      </Card>

      <Card className="soft-enter space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-theme-2">
              {t("realtimeDefaultConfig.text005")}
            </div>
            <p className="mt-1 text-xs leading-snug text-theme-4">
              {t("realtimeDefaultConfig.text006")}
            </p>
          </div>
          <Link href="/app/settings">
            <Button variant="secondary">
              {t("realtimeDefaultConfig.text007")}
            </Button>
          </Link>
        </div>
        {!hasGateProfiles || !hasPlannerProfiles || !hasSttProfiles ? (
          <div className="rounded-lg border border-amber-900/55 bg-amber-950/40 px-3 py-2.5 text-sm text-amber-100">
            {t("realtimeDefaultConfig.text008")}
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-4">
          {[
            {
              label: t("realtimeDefaultConfig.text009"),
              value: hasGateProfiles
                ? `${gateLabel || t("realtimeDefaultConfig.text010")} / ${gateModel || t("realtimeDefaultConfig.text011")}`
                : t("realtimeDefaultConfig.text012"),
            },
            {
              label: t("realtimeDefaultConfig.text013"),
              value: hasPlannerProfiles
                ? `${plannerLabel || t("realtimeDefaultConfig.text010")} / ${plannerModel || t("realtimeDefaultConfig.text011")}`
                : t("realtimeDefaultConfig.text012"),
            },
            {
              label: t("realtimeDefaultConfig.text014"),
              value: hasSttProfiles
                ? `${sttLabel || t("realtimeDefaultConfig.text010")} / ${sttModel || t("realtimeDefaultConfig.text011")}`
                : t("realtimeDefaultConfig.text012"),
            },
            {
              label: t("realtimeDefaultConfig.text015"),
              value: diagramMode === "dual_view"
                ? t("realtimeDefaultConfig.text016")
                : t("realtimeDefaultConfig.text017"),
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
