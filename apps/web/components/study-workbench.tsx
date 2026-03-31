"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Send, ShieldCheck } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, Textarea } from "@stream2graph/ui";

import { api } from "@/lib/api";
import { MermaidCard } from "@/components/mermaid-card";

export function StudyWorkbench({ participantCode }: { participantCode: string }) {
  const [draft, setDraft] = useState("");
  const [surveyUsefulness, setSurveyUsefulness] = useState("5");
  const [surveyConfidence, setSurveyConfidence] = useState("5");
  const [surveyWorkload, setSurveyWorkload] = useState("4");
  const [surveyNotes, setSurveyNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const session = useQuery({
    queryKey: ["study-session", participantCode],
    queryFn: () => api.getParticipantSession(participantCode),
  });

  const startMutation = useMutation({
    mutationFn: () => api.startParticipantSession(participantCode),
    onSuccess: (data) => {
      setDraft(data.draft_output || data.final_output || data.system_output || "");
      session.refetch();
      setError(null);
    },
    onError: (err) => setError((err as Error).message),
  });

  const autosaveMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.autosaveParticipant(participantCode, payload),
    onSuccess: (data) => {
      window.localStorage.setItem(`s2g:study-draft:${participantCode}`, data.draft_output || "");
    },
    onError: (err) => setError((err as Error).message),
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const submission = await api.submitParticipant(participantCode, {
        final_output: draft,
        input_transcript: session.data?.materials?.input_transcript || "",
      });
      await api.saveSurvey(participantCode, {
        payload: {
          usefulness: Number(surveyUsefulness),
          confidence: Number(surveyConfidence),
          workload: Number(surveyWorkload),
          notes: surveyNotes,
        },
      });
      return submission;
    },
    onSuccess: () => {
      session.refetch();
      setError(null);
    },
    onError: (err) => setError((err as Error).message),
  });

  useEffect(() => {
    if (session.data && !session.data.started_at) {
      startMutation.mutate();
      return;
    }
    if (session.data) {
      const localDraft = window.localStorage.getItem(`s2g:study-draft:${participantCode}`);
      setDraft(localDraft || session.data.draft_output || session.data.final_output || session.data.system_output || "");
    }
    // `useMutation()` object identity is not stable enough for an effect dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantCode, session.data]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (session.data && session.data.status !== "submitted" && draft) {
        autosaveMutation.mutate({
          draft_output: draft,
          input_transcript: session.data.materials?.input_transcript || "",
        });
      }
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [autosaveMutation, draft, participantCode, session.data]);

  const transcript = useMemo(() => session.data?.materials?.input_transcript || "", [session.data]);
  const systemOutput = session.data?.system_output || "";
  const statusBadge = session.data?.status || "loading";

  return (
    <div className="mx-auto max-w-[1680px] px-4 py-6 md:px-6 md:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="pl-8 text-[2rem] font-semibold tracking-[-0.04em] text-violet-200">
          {session.data?.task_title || "参与者任务"}
        </div>
        <Badge>{statusBadge}</Badge>
      </div>

      {error ? (
        <div className="mt-5 rounded-[24px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <Card className="soft-enter mt-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-50">完成方式</div>
            <p className="mt-2 text-sm leading-6 text-slate-400">先阅读左侧任务材料，再在中间编辑最终 Mermaid，最后填写右侧问卷并提交。草稿会自动保存。</p>
          </div>
          <Badge>{session.data?.study_condition ? `条件：${session.data.study_condition}` : "正在加载任务条件"}</Badge>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ["1", "阅读材料", "先看输入对话和系统初稿，理解当前任务。"],
            ["2", "编辑与预览", "在编辑区修改 Mermaid，并随时查看实时预览。"],
            ["3", "提交问卷", "确认最终结果后，填写主观评分并提交。"],
          ].map(([step, titleText, desc]) => (
            <div key={step} className="rounded-[22px] border border-white/70 bg-white/[0.56] px-4 py-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-strong)]">Step {step}</div>
              <div className="mt-2 text-sm font-semibold text-slate-100">{titleText}</div>
              <div className="mt-2 text-sm leading-6 text-slate-400">{desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 2xl:grid-cols-[360px_minmax(0,1fr)_360px]">
        <Card className="soft-enter space-y-5">
          <div>
            <div className="text-sm font-semibold text-slate-100">任务材料</div>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              条件：{session.data?.study_condition || "-"}。请阅读对话并在右侧编辑器中产出最终 Mermaid。
            </p>
          </div>
          <Textarea value={transcript} readOnly rows={18} />
          {systemOutput ? (
            <>
              <div className="text-sm font-semibold text-slate-100">系统初稿</div>
              <Textarea value={systemOutput} readOnly rows={12} />
            </>
          ) : null}
        </Card>

        <div className="soft-enter soft-enter-delay-1 space-y-6">
          <Card>
            <div className="mb-4 text-sm font-semibold text-slate-100">编辑最终 Mermaid</div>
            <Textarea
              value={draft}
              rows={18}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
              placeholder="请在这里编辑最终 Mermaid 图代码"
            />
          </Card>
          <MermaidCard title="实时预览" code={draft} height={420} />
        </div>

        <div className="soft-enter soft-enter-delay-2 space-y-6">
          <Card className="space-y-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <ShieldCheck className="h-4 w-4" />
              提交与问卷
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["有用性", surveyUsefulness, setSurveyUsefulness],
                ["信心", surveyConfidence, setSurveyConfidence],
                ["负担", surveyWorkload, setSurveyWorkload],
              ].map(([label, value, setter]) => (
                <div key={label as string} className="space-y-2">
                  <label className="text-xs font-medium text-slate-400">{label as string}</label>
                  <select
                    className="h-11 w-full rounded-[20px] border border-white/70 bg-white/[0.72] px-3 text-sm outline-none transition focus:border-[var(--accent)] focus:bg-white focus:ring-4 focus:ring-[rgba(185,167,211,0.18)]"
                    value={value as string}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => (setter as (value: string) => void)(event.target.value)}
                  >
                    {["1", "2", "3", "4", "5", "6", "7"].map((score) => (
                      <option key={score} value={score}>
                        {score}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <Textarea
              rows={6}
              value={surveyNotes}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setSurveyNotes(event.target.value)}
              placeholder="可以补充说明系统体验、困难点或建议。"
            />
            <Button className="py-3" onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending || !draft.trim()}>
              <Send className="h-4 w-4" />
              {submitMutation.isPending ? "提交中..." : "提交最终答案"}
            </Button>
            <div className="text-xs leading-6 text-slate-500">提交后会同时保存最终答案和问卷。若继续修改，请在提交前完成。</div>
          </Card>

          <Card>
            <div className="mb-4 text-sm font-semibold text-slate-100">自动评测状态</div>
            <pre className="rounded-[24px] bg-slate-950 p-5 text-xs leading-6 text-slate-100">
              {JSON.stringify(
                {
                  compile_success: session.data?.compile_success ?? null,
                  auto_metrics: session.data?.auto_metrics || {},
                },
                null,
                2,
              )}
            </pre>
          </Card>
        </div>
      </div>
    </div>
  );
}
