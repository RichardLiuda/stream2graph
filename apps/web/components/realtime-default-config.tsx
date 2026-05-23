"use client";

import Link from "next/link";
import { type ChangeEvent } from "react";

import type { RuntimeOptions } from "@stream2graph/contracts";
import { Button, Card } from "@stream2graph/ui";

import { languageText, useLanguagePreference, type LocalizedText } from "@/lib/language";

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
  const t = (copy: LocalizedText) => languageText(language, copy);

  return (
    <div className="space-y-4">
      <Card className="soft-enter space-y-3">
        <div className="text-sm font-semibold text-theme-2">
          {t({ zh: "会话与录音", en: "Session & Recording", es: "Sesión y grabación", pt: "Sessão e gravação", de: "Sitzung & Aufnahme", ja: "セッションと録音" })}
        </div>
        <details className="rounded-lg border border-theme-default bg-surface-muted px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wider text-theme-4 marker:content-none [&::-webkit-details-marker]:hidden">
            {t({ zh: "高级选项", en: "Advanced Options", es: "Opciones avanzadas", pt: "Opções avançadas", de: "Erweiterte Optionen", ja: "詳細オプション" })}
          </summary>
          <div className="mt-3 space-y-2">
            <label className="text-xs font-medium text-theme-3">
              {t({ zh: "数据版本", en: "Dataset Version", es: "Versión de datos", pt: "Versão dos dados", de: "Datensatzversion", ja: "データセット版" })}
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
                    {t({ zh: "跟随会话默认", en: "Use session default", es: "Usar valor predeterminado", pt: "Usar padrão da sessão", de: "Sitzungsstandard verwenden", ja: "セッション既定値を使用" })}
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
              {t({ zh: "默认设置（只读）", en: "Default Settings (read-only)", es: "Ajustes predeterminados (solo lectura)", pt: "Configurações padrão (somente leitura)", de: "Standardeinstellungen (nur Lesen)", ja: "既定設定（読み取り専用）" })}
            </div>
            <p className="mt-1 text-xs leading-snug text-theme-4">
              {t({
                zh: "模型与显示方式在「设置」中修改；此处仅展示当前沿用的默认值。",
                en: "Models and display mode are edited in Settings. This panel only shows the defaults currently in use.",
                es: "Los modelos y el modo de visualización se editan en Ajustes. Este panel solo muestra los valores actuales.",
                pt: "Modelos e modo de exibição são editados em Configurações. Este painel mostra apenas os padrões em uso.",
                de: "Modelle und Anzeigemodus werden in den Einstellungen geändert. Dieses Panel zeigt nur die aktuellen Standardwerte.",
                ja: "モデルと表示方式は設定で変更します。このパネルには現在使用中の既定値だけを表示します。",
              })}
            </p>
          </div>
          <Link href="/app/settings">
            <Button variant="secondary">
              {t({ zh: "打开配置页", en: "Open Settings", es: "Abrir ajustes", pt: "Abrir configurações", de: "Einstellungen öffnen", ja: "設定を開く" })}
            </Button>
          </Link>
        </div>
        {!hasGateProfiles || !hasPlannerProfiles || !hasSttProfiles ? (
          <div className="rounded-lg border border-amber-900/55 bg-amber-950/40 px-3 py-2.5 text-sm text-amber-100">
            {t({
              zh: "服务端还缺少 Gate / Planner / STT 运行配置。请打开「设置」补全环境变量后重启 API。",
              en: "The server is missing Gate / Planner / STT runtime configuration. Complete the environment settings and restart the API.",
              es: "Falta la configuración de ejecución Gate / Planner / STT en el servidor. Complétala y reinicia la API.",
              pt: "Falta a configuração de execução Gate / Planner / STT no servidor. Complete-a e reinicie a API.",
              de: "Dem Server fehlt die Gate-/Planner-/STT-Laufzeitkonfiguration. Ergänze sie und starte die API neu.",
              ja: "サーバーに Gate / Planner / STT の実行設定が不足しています。設定を補完して API を再起動してください。",
            })}
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-4">
          {[
            {
              label: t({ zh: "默认 Gate 模型", en: "Default Gate Model", es: "Modelo Gate predeterminado", pt: "Modelo Gate padrão", de: "Standard-Gate-Modell", ja: "既定 Gate モデル" }),
              value: hasGateProfiles
                ? `${gateLabel || t({ zh: "未选择", en: "Not selected", es: "No seleccionado", pt: "Não selecionado", de: "Nicht ausgewählt", ja: "未選択" })} / ${gateModel || t({ zh: "未选择模型", en: "No model selected", es: "Sin modelo seleccionado", pt: "Nenhum modelo selecionado", de: "Kein Modell ausgewählt", ja: "モデル未選択" })}`
                : t({ zh: "未配置", en: "Not configured", es: "No configurado", pt: "Não configurado", de: "Nicht konfiguriert", ja: "未設定" }),
            },
            {
              label: t({ zh: "默认 Planner 模型", en: "Default Planner Model", es: "Modelo Planner predeterminado", pt: "Modelo Planner padrão", de: "Standard-Planner-Modell", ja: "既定 Planner モデル" }),
              value: hasPlannerProfiles
                ? `${plannerLabel || t({ zh: "未选择", en: "Not selected", es: "No seleccionado", pt: "Não selecionado", de: "Nicht ausgewählt", ja: "未選択" })} / ${plannerModel || t({ zh: "未选择模型", en: "No model selected", es: "Sin modelo seleccionado", pt: "Nenhum modelo selecionado", de: "Kein Modell ausgewählt", ja: "モデル未選択" })}`
                : t({ zh: "未配置", en: "Not configured", es: "No configurado", pt: "Não configurado", de: "Nicht konfiguriert", ja: "未設定" }),
            },
            {
              label: t({ zh: "默认听写服务", en: "Default STT Service", es: "Servicio STT predeterminado", pt: "Serviço STT padrão", de: "Standard-STT-Dienst", ja: "既定 STT サービス" }),
              value: hasSttProfiles
                ? `${sttLabel || t({ zh: "未选择", en: "Not selected", es: "No seleccionado", pt: "Não selecionado", de: "Nicht ausgewählt", ja: "未選択" })} / ${sttModel || t({ zh: "未选择模型", en: "No model selected", es: "Sin modelo seleccionado", pt: "Nenhum modelo selecionado", de: "Kein Modell ausgewählt", ja: "モデル未選択" })}`
                : t({ zh: "未配置", en: "Not configured", es: "No configurado", pt: "Não configurado", de: "Nicht konfiguriert", ja: "未設定" }),
            },
            {
              label: t({ zh: "显示方式", en: "Display Mode", es: "Modo de visualización", pt: "Modo de exibição", de: "Anzeigemodus", ja: "表示モード" }),
              value: diagramMode === "dual_view"
                ? t({ zh: "流程图+结构图", en: "Flow + Structure", es: "Flujo + estructura", pt: "Fluxo + estrutura", de: "Fluss + Struktur", ja: "フロー + 構造" })
                : t({ zh: "仅流程图", en: "Flow only", es: "Solo flujo", pt: "Somente fluxo", de: "Nur Fluss", ja: "フローのみ" }),
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
