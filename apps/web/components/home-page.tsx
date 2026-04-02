"use client";

import Link from "next/link";
import { ArrowRight, BarChart3, BookOpenText, Menu, RadioTower, Rows4, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card } from "@stream2graph/ui";
import { BackgroundPathLayer } from "@/components/ui/background-paths";

const navItems = [
  { href: "/app/realtime", label: "实时工作", icon: RadioTower },
  { href: "/app/samples", label: "样本对照", icon: Rows4 },
  { href: "/app/reports", label: "实验报告", icon: BarChart3 },
  { href: "/app/settings", label: "设置", icon: Settings2 },
  { href: "/", label: "首页", icon: BookOpenText },
];

function Reveal({
  rootRef,
  delayMs = 0,
  children,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  delayMs?: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion) {
      setVisible(true);
      return;
    }

    const root = rootRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { root, threshold: 0.18, rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef, visible]);

  const style = useMemo<React.CSSProperties>(
    () => ({
      transitionDelay: `${delayMs}ms`,
    }),
    [delayMs],
  );

  return (
    <div
      ref={ref}
      style={style}
      className={`transform-gpu transition duration-900 ease-out will-change-transform ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

/** @description 首页：深底 + 侧滑导航，与 /app 壳层视觉一致 */
export function HomePage() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[var(--page-bg)]">
      <button
        type="button"
        aria-expanded={drawerOpen}
        aria-controls="home-nav-drawer"
        aria-label="打开导航"
        className={`fixed left-4 top-4 z-[105] flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--shell-control-border)] bg-[var(--shell-control-bg)] text-[color:var(--shell-control-fg)] shadow-md transition hover:border-[color:var(--shell-control-border-hover)] hover:bg-[var(--shell-control-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--shell-focus-ring)] ${
          drawerOpen ? "opacity-80" : ""
        }`}
        onClick={() => setDrawerOpen(true)}
      >
        <Menu className="h-5 w-5" strokeWidth={2} />
      </button>

      {drawerOpen ? (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-[100] bg-[var(--shell-backdrop)] backdrop-blur-[2px] transition-opacity"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        id="home-nav-drawer"
        aria-hidden={!drawerOpen}
        className={`fixed inset-y-0 left-0 z-[110] flex w-[288px] max-w-[min(288px,88vw)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          drawerOpen
            ? "pointer-events-auto translate-x-0 shadow-[8px_0_40px_rgba(15,23,42,0.12)]"
            : "pointer-events-none -translate-x-full"
        }`}
      >
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-0 bg-surface-1 p-3 shadow-none sm:my-4 sm:ml-4 sm:h-[calc(100vh-2rem)] sm:rounded-2xl sm:border sm:border-theme-default sm:shadow-xl">
          <div className="flex shrink-0 items-center gap-2 pb-3">
            <Button type="button" variant="ghost" className="flex-1 justify-start gap-2 rounded-lg px-3 py-2 text-sm" onClick={() => setDrawerOpen(false)}>
              返回首页
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="rounded-xl border border-theme-default bg-surface-2 px-4 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-theme-4">Stream2Graph</div>
              <div className="font-display mt-1 text-lg font-semibold tracking-tight text-theme-1">正式平台</div>
              <div className="mt-3 rounded-lg border border-theme-subtle bg-surface-1 px-3 py-2 text-xs text-theme-3">当前：首页</div>
            </div>
            <nav className="mt-3 rounded-xl border border-theme-default bg-surface-muted p-1.5" aria-label="导航">
              <div className="drawer-nav-animate flex flex-col gap-0.5">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = item.href === "/";
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                        active ? "bg-surface-3 text-theme-1" : "text-theme-3 hover:bg-surface-muted hover:text-theme-2"
                      }`}
                    >
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded-md border ${
                          active ? "border-theme-default bg-surface-1 text-theme-2" : "border-theme-subtle bg-surface-muted text-theme-4"
                        }`}
                      >
                        <Icon className="h-4 w-4" strokeWidth={2} />
                      </span>
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          </div>
        </Card>
      </aside>

      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_0%,var(--hero-radial-glow),transparent_70%)]" />
        <BackgroundPathLayer />
      </div>

      <div ref={scrollRef} className="relative z-[1] h-[100dvh] overflow-x-hidden overflow-y-auto">
        <section className="soft-enter relative flex min-h-[100dvh] items-center justify-center">
          <div className="relative px-6 py-10 text-center text-theme-1 md:px-10 md:py-12">
            <Badge className="border-theme-default bg-surface-2 text-theme-2 normal-case tracking-normal">
              Stream2Graph 正式平台
            </Badge>
            <h1 className="mt-8">
              <div className="text-center text-6xl font-semibold tracking-tight sm:text-7xl md:text-8xl lg:text-9xl">语流生图</div>
              <div className="mt-4 text-center text-xl font-semibold tracking-[0.12em] text-theme-4 sm:text-2xl md:text-3xl lg:text-4xl">
                STREAM2GRAPH
              </div>
            </h1>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href="/app/realtime">
                <Button variant="primary" className="h-10 rounded-lg px-6 text-sm font-semibold">
                  进入实时工作台
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </Link>
              <Link
                href="/login"
                className="inline-flex h-10 items-center rounded-lg border border-theme-default bg-surface-2 px-4 text-sm font-medium text-theme-2 transition hover:border-theme-strong hover:bg-surface-3"
              >
                管理员登录
              </Link>
              <div className="inline-flex items-center gap-1.5 rounded-md border border-theme-subtle bg-surface-muted px-2.5 py-1 text-[11px] text-theme-4">
                <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-600" aria-hidden />
                实时管线就绪
              </div>
            </div>
          </div>
        </section>

        <section className="relative mx-auto w-full max-w-5xl px-6 pt-12 text-theme-2 md:px-10">
          <div className="mb-6">
            <div className="text-3xl font-semibold tracking-tight text-theme-1 sm:text-4xl md:text-5xl">流程</div>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-theme-4 md:text-base">
              选择样本 → 配置模型 → 在线生成任务与图谱。向下滚动时，卡片会逐个浮现，方便按步骤理解。
            </p>
          </div>

          <div className="rounded-2xl border border-theme-default bg-surface-1/70 p-6 shadow-lg backdrop-blur md:p-10">
            <div className="grid gap-3 lg:grid-cols-3">
              <Reveal rootRef={scrollRef} delayMs={0}>
                <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-theme-4">Step 1</div>
                  <div className="mt-2 text-lg font-semibold text-theme-1">选择样本</div>
                  <div className="mt-1 text-sm leading-7 text-theme-3">
                    左侧选择数据集版本、split 和 sample，准备对照与复现。
                  </div>
                </div>
              </Reveal>
              <Reveal rootRef={scrollRef} delayMs={120}>
                <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-theme-4">Step 2</div>
                  <div className="mt-2 text-lg font-semibold text-theme-1">配置模型</div>
                  <div className="mt-1 text-sm leading-7 text-theme-3">
                    设置 Gate / Planner / STT 组合，保持对比条件清晰。
                  </div>
                </div>
              </Reveal>
              <Reveal rootRef={scrollRef} delayMs={240}>
                <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-theme-4">Step 3</div>
                  <div className="mt-2 text-lg font-semibold text-theme-1">阅读结构</div>
                  <div className="mt-1 text-sm leading-7 text-theme-3">
                    查看主图与结构视图，结合更新记录与运行摘要理解增量结果。
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="relative mx-auto w-full max-w-5xl px-6 pb-24 pt-10 text-theme-2 md:px-10">
          <div className="mb-6">
            <div className="text-3xl font-semibold tracking-tight text-theme-1 sm:text-4xl md:text-5xl">从输入到结果</div>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-theme-4 md:text-base">
              下面是能力概览与示例输入。向下滚动时，每张卡片会依次浮上来。
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-theme-default bg-surface-1/70 p-6 shadow-lg backdrop-blur md:p-10">
              <div className="grid gap-3 sm:grid-cols-2">
                <Reveal rootRef={scrollRef} delayMs={0}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Generate</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">生成主图与结构视图</div>
                    <p className="mt-1 text-sm leading-7 text-theme-3">把 Transcript/语音输入转换为可读的图与节点结构。</p>
                  </div>
                </Reveal>
                <Reveal rootRef={scrollRef} delayMs={120}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Trace</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">追踪增量更新</div>
                    <p className="mt-1 text-sm leading-7 text-theme-3">查看更新记录与运行摘要，定位每一次变化的原因。</p>
                  </div>
                </Reveal>
                <Reveal rootRef={scrollRef} delayMs={240}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Evaluate</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">评测与对照</div>
                    <p className="mt-1 text-sm leading-7 text-theme-3">用延迟、准确率、抖动与好懂度指标辅助对比模型配置。</p>
                  </div>
                </Reveal>
                <Reveal rootRef={scrollRef} delayMs={360}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Reproduce</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">复现与归档</div>
                    <p className="mt-1 text-sm leading-7 text-theme-3">保持同样的样本与配置，复现输出并保存报告用于追溯。</p>
                  </div>
                </Reveal>
              </div>
            </div>

            <div className="rounded-2xl border border-theme-default bg-surface-1/70 p-6 shadow-lg backdrop-blur md:p-10">
              <div className="space-y-3">
                <Reveal rootRef={scrollRef} delayMs={0}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Example 1</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">平台架构梳理</div>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-6 text-theme-2">
expert|We need a platform map from web console to backend services.|structural
expert|Connect admin console to API gateway and session manager.|sequential
expert|Show PostgreSQL storage and worker report generation.|structural
                    </pre>
                  </div>
                </Reveal>
                <Reveal rootRef={scrollRef} delayMs={120}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Example 2</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">故障响应流程</div>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-6 text-theme-2">
operator|We need an incident response flow for a production outage.|sequential
lead|Add a decision: is customer traffic impacted?|conditional
lead|If yes, branch to mitigation, status update, exec notification.|parallel
                    </pre>
                  </div>
                </Reveal>
                <Reveal rootRef={scrollRef} delayMs={240}>
                  <div className="rounded-xl border border-theme-default bg-surface-2/60 p-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Example 3</div>
                    <div className="mt-2 text-base font-semibold text-theme-1">用户研究闭环</div>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-6 text-theme-2">
researcher|Describe study workflow from task creation to report export.|sequential
expert|Participants enter, run session, autosave drafts, then submit.|sequential
expert|After submit, run evaluation and generate aggregate report.|sequential
                    </pre>
                  </div>
                </Reveal>

                <Reveal rootRef={scrollRef} delayMs={360}>
                  <div className="rounded-xl border border-theme-subtle bg-surface-muted p-5 text-sm leading-7 text-theme-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-4">Note</div>
                    <div className="mt-2 text-sm text-theme-2">
                      这是实验平台：输出受输入内容、模型配置与实时状态影响。建议用固定样本做对照，结合更新记录与运行摘要定位差异来源。
                    </div>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
