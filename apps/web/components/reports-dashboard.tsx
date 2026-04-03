"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, Users } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, Input, StatCard, Textarea } from "@stream2graph/ui";

import { api, apiUrl } from "@/lib/api";

export function ReportsDashboard() {
  const DASHBOARD_TABS: Array<[string, string]> = [
    ["overview", "总览"],
    ["study", "用户研究配置"],
    ["exports", "导出"],
  ];
  const queryClient = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("基线比较任务");
  const [taskDescription, setTaskDescription] = useState("请根据给定对话材料产出或修订 Mermaid 图。");
  const [taskDataset, setTaskDataset] = useState("");
  const [taskSplit, setTaskSplit] = useState("test");
  const [taskSampleId, setTaskSampleId] = useState("");
  const [taskSystemOutputs, setTaskSystemOutputs] = useState(
    JSON.stringify(
      {
        manual: "",
        heuristic: "flowchart TD\n  A[Heuristic Draft]\n  B[Please Refine]\n  A --> B",
        model_system: "flowchart TD\n  Start[Model Draft]\n  Review[Human Review]\n  Start --> Review",
      },
      null,
      2,
    ),
  );
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [participantId, setParticipantId] = useState("P-001");
  const [participantCondition, setParticipantCondition] = useState("manual");
  const [creationError, setCreationError] = useState<string | null>(null);
  const [dashboardTab, setDashboardTab] = useState<(typeof DASHBOARD_TABS)[number][0]>("overview");

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.listDatasets });
  const samples = useQuery({
    queryKey: ["report-samples", taskDataset, taskSplit],
    queryFn: () => api.listSamples(taskDataset, taskSplit, "", 0, 20),
    enabled: Boolean(taskDataset),
  });
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.listRuns });
  const realtimeSessions = useQuery({ queryKey: ["realtime-sessions"], queryFn: api.listRealtimeSessions });
  const reports = useQuery({ queryKey: ["reports"], queryFn: api.listReports });
  const studyTasks = useQuery({ queryKey: ["study-tasks"], queryFn: api.listStudyTasks });
  const studySessions = useQuery({ queryKey: ["study-sessions"], queryFn: api.listStudySessions });

  useEffect(() => {
    if (!taskDataset && datasets.data?.length) {
      const defaultSlug = datasets.data.find((item) => item.is_default)?.slug || datasets.data[0].slug;
      setTaskDataset(defaultSlug);
    }
  }, [datasets.data, taskDataset]);

  useEffect(() => {
    if (!taskSampleId && samples.data?.length) {
      setTaskSampleId(samples.data[0].sample_id);
    }
  }, [samples.data, taskSampleId]);

  const stats = useMemo(
    () => [
      { label: "运行任务", value: runs.data?.length ?? 0 },
      { label: "实时会话", value: realtimeSessions.data?.length ?? 0 },
      { label: "研究任务", value: studyTasks.data?.length ?? 0 },
      { label: "导出报告", value: reports.data?.length ?? 0 },
    ],
    [reports.data?.length, realtimeSessions.data?.length, runs.data?.length, studyTasks.data?.length],
  );

  const createTask = useMutation({
    mutationFn: () =>
      api.createStudyTask({
        title: taskTitle,
        description: taskDescription,
        dataset_version_slug: taskDataset || null,
        split: taskSplit || null,
        sample_id: taskSampleId || null,
        default_condition: "manual",
        system_outputs: JSON.parse(taskSystemOutputs || "{}"),
      }),
    onSuccess: (task) => {
      setSelectedTaskId(task.task_id);
      setCreationError(null);
      queryClient.invalidateQueries({ queryKey: ["study-tasks"] });
    },
    onError: (error) => setCreationError((error as Error).message),
  });

  const createParticipant = useMutation({
    mutationFn: () =>
      api.createStudySession(selectedTaskId, {
        participant_id: participantId,
        study_condition: participantCondition,
      }),
    onSuccess: () => {
      setCreationError(null);
      queryClient.invalidateQueries({ queryKey: ["study-sessions"] });
    },
    onError: (error) => setCreationError((error as Error).message),
  });

  return (
    <div className="space-y-5">
      <h1 className="page-title page-title--menu-clearance">实验、用户研究与报告</h1>

      {creationError ? (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-200">{creationError}</div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((item) => (
          <StatCard key={item.label} label={item.label} value={String(item.value)} />
        ))}
      </div>

      <Tabs.Root
        value={dashboardTab}
        onValueChange={(value) => setDashboardTab(value as typeof dashboardTab)}
        className="space-y-4"
      >
        <Tabs.List className="workspace-tab-list max-w-[560px] grid-cols-3">
          <span
            aria-hidden
            className="workspace-tab-indicator"
            style={{
              left: "0.25rem",
              width: "calc((100% - 0.5rem) / 3)",
              transform: `translateX(calc(${Math.max(
                0,
                DASHBOARD_TABS.findIndex(([value]) => value === dashboardTab),
              )} * 100%))`,
            }}
          />
          {DASHBOARD_TABS.map(([value, label]) => (
            <Tabs.Trigger key={value} value={value} className="workspace-tab-trigger px-4 py-2">
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="overview">
          <div className="grid gap-6 xl:grid-cols-3">
            <Card>
              <div className="mb-5 flex items-center justify-between">
                <div className="text-sm font-semibold text-theme-1">最近运行</div>
                <Badge>{runs.data?.length ?? 0}</Badge>
              </div>
              <div className="space-y-4">
                {runs.data?.slice(0, 6).map((item) => (
                  <div key={item.run_id} className="glass-panel p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-theme-1">{item.title}</div>
                      <Badge>{item.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-theme-4">
                      {item.job_type} · {item.dataset_version_slug || "-"}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <div className="mb-5 flex items-center justify-between">
                <div className="text-sm font-semibold text-theme-1">研究会话</div>
                <Badge>{studySessions.data?.length ?? 0}</Badge>
              </div>
              <div className="space-y-4">
                {studySessions.data?.slice(0, 6).map((item) => (
                  <div key={item.session_id} className="glass-panel p-3">
                    <div className="font-semibold text-theme-1">{item.participant_code}</div>
                    <div className="mt-1 text-xs text-theme-4">
                      {item.study_condition} · {item.task_title}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <div className="mb-5 flex items-center justify-between">
                <div className="text-sm font-semibold text-theme-1">报告归档</div>
                <Badge>{reports.data?.length ?? 0}</Badge>
              </div>
              <div className="space-y-4">
                {reports.data?.slice(0, 6).map((item) => (
                  <div key={item.report_id} className="glass-panel p-3">
                    <div className="font-semibold text-theme-1">{item.title}</div>
                    <div className="mt-1 text-xs text-theme-4">
                      {item.report_type} · {item.status}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </Tabs.Content>

        <Tabs.Content value="study">
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Plus className="h-5 w-5" />
                创建研究任务
              </div>
              <Input
                value={taskTitle}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTitle(event.target.value)}
                placeholder="任务标题"
              />
              <Textarea
                value={taskDescription}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTaskDescription(event.target.value)}
                rows={4}
              />
              <select
                className="select-control"
                value={taskDataset}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setTaskDataset(event.target.value)}
              >
                {datasets.data?.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.slug}
                  </option>
                ))}
              </select>
              <div className="grid gap-3 md:grid-cols-2">
                <select
                  className="select-control"
                  value={taskSplit}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setTaskSplit(event.target.value)}
                >
                  {["train", "validation", "test"].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <select
                  className="select-control"
                  value={taskSampleId}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setTaskSampleId(event.target.value)}
                >
                  {samples.data?.map((item) => (
                    <option key={item.sample_id} value={item.sample_id}>
                      {item.sample_id}
                    </option>
                  ))}
                </select>
              </div>
              <Textarea
                value={taskSystemOutputs}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTaskSystemOutputs(event.target.value)}
                rows={10}
              />
              <Button className="py-3" onClick={() => createTask.mutate()} disabled={createTask.isPending}>
                创建任务
              </Button>
            </Card>

            <Card className="space-y-5">
              <div className="flex items-center gap-2 text-lg font-semibold text-theme-1">
                <Users className="h-5 w-5" />
                发放 Participant Code
              </div>
              <select
                className="select-control"
                value={selectedTaskId}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedTaskId(event.target.value)}
              >
                <option value="">选择研究任务</option>
                {studyTasks.data?.map((task) => (
                  <option key={task.task_id} value={task.task_id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <Input
                value={participantId}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setParticipantId(event.target.value)}
                placeholder="participant id"
              />
              <select
                className="select-control"
                value={participantCondition}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setParticipantCondition(event.target.value)}
              >
                {["manual", "heuristic", "model_system"].map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <Button
                className="py-3"
                onClick={() => createParticipant.mutate()}
                disabled={!selectedTaskId || createParticipant.isPending}
              >
                创建 Participant Session
              </Button>
              <div className="space-y-4">
                {studySessions.data?.slice(0, 8).map((item) => (
                  <div key={item.session_id} className="glass-panel p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-theme-1">{item.participant_code}</div>
                      <a
                        className="text-sm font-medium text-[var(--accent-strong)]"
                        href={`/study/${item.participant_code}`}
                        target="_blank"
                      >
                        打开任务页
                      </a>
                    </div>
                    <div className="mt-1 text-xs text-theme-4">
                      {item.participant_id} · {item.study_condition}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </Tabs.Content>

        <Tabs.Content value="exports">
          <div className="grid gap-6 xl:grid-cols-3">
            {[
              ["runs", "运行记录"],
              ["studies", "用户研究"],
              ["realtime", "实时会话"],
            ].map(([target, label]) => (
              <Card key={target} className="lift-hover space-y-5">
                <div className="text-lg font-semibold text-theme-1">{label}</div>
                <p className="text-sm leading-6 text-theme-3">
                  导出为 JSON、CSV 或 Markdown，支持实验复现、论文整理和归档审计。
                </p>
                <div className="flex flex-wrap gap-2">
                  {["json", "csv", "markdown"].map((fmt) => (
                    <a key={fmt} href={apiUrl(`/api/v1/reports/exports/download?target=${target}&fmt=${fmt}`)}>
                      <Button variant="secondary">
                        <Download className="h-4 w-4" />
                        {fmt.toUpperCase()}
                      </Button>
                    </a>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
