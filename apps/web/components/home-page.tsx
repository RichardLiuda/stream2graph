"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Archive,
  ArrowRight,
  BarChart3,
  BookOpenText,
  Cpu,
  Gauge,
  GitBranch,
  LayoutGrid,
  Menu,
  Mic,
  RadioTower,
  Rows4,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card } from "@stream2graph/ui";
import { BackgroundPathLayer } from "@/components/ui/background-paths";
import { ScrollLinkedCardsBlockSection, type ScrollLinkedCardsBlock } from "@/components/scroll-linked-cards";
import { api } from "@/lib/api";

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
      /* 略放宽底部收缩，避免上滑回程时太晚 intersect；不用过大负边距以免首屏误触 */
      { root, threshold: 0.06, rootMargin: "0px 0px -12% 0px" },
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
      className={`origin-[50%_65%] transform-gpu transition-transform duration-[1100ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none ${
        visible
          ? "translate-y-0 scale-100 opacity-100"
          : "translate-y-12 scale-[0.96] opacity-0 sm:translate-y-14"
      }`}
    >
      {children}
    </div>
  );
}

/** 首屏底部：扁折线，略窄于上一版 */
function ScrollZigzagHint({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 102 36" fill="none" aria-hidden className={className}>
      <polyline
        points="15,9 51,16 87,9"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="15,23 51,30 87,23"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FlowPipelineOrnament() {
  const labels = ["输入", "结构", "对照"];
  const toneDots = ["bg-sky-300/90", "bg-emerald-300/90", "bg-amber-300/90"];
  return (
    <div className="mx-auto w-full max-w-[17rem] shrink-0 md:mx-0" aria-hidden>
      <div className="rounded-2xl border border-sky-400/48 bg-surface-1/95 p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md">
        <div className="flex items-center gap-1.5">
          {labels.map((l, i) => (
            <Fragment key={l}>
                <span
                  className={`grid min-h-[2.35rem] min-w-[2.75rem] place-items-center rounded-xl border bg-surface-2/95 px-2 text-center text-[11px] font-semibold uppercase tracking-wider text-theme-2 ${
                    i === 0 ? "border-sky-300/60" : i === 1 ? "border-emerald-300/60" : "border-amber-300/62"
                  }`}
                >
                <span className="mb-1 flex items-center justify-center">
                  <span className={`h-1.5 w-1.5 rounded-full ${toneDots[i] ?? "bg-sky-100/95"}`} />
                </span>
                {l}
              </span>
              {i < labels.length - 1 ? (
                <span className={`h-0.5 min-w-[0.75rem] flex-1 rounded-full ${i === 0 ? "bg-sky-300/55" : "bg-emerald-300/55"}`} />
              ) : null}
            </Fragment>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-theme-4">
          <span className="h-1 w-1 shrink-0 rounded-full bg-sky-400/85" />
          语流 → 图
          <span className="h-1 w-1 shrink-0 rounded-full bg-amber-400/85" />
        </div>
        <div className="mt-3 flex items-center justify-center gap-1.5">
          <span className="h-1.5 w-4 rounded-full bg-sky-300/80" />
          <span className="h-1.5 w-4 rounded-full bg-emerald-300/80" />
          <span className="h-1.5 w-4 rounded-full bg-amber-300/82" />
        </div>
      </div>
    </div>
  );
}

function ShowcaseStepCard({
  n,
  tag,
  title,
  body,
  icon: Icon,
  align,
}: {
  n: string;
  tag: string;
  title: string;
  body: string;
  icon: LucideIcon;
  align: "left" | "right";
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-3xl border border-theme-default bg-surface-1/80 p-6 shadow-[0_24px_80px_-32px_rgba(0,0,0,0.45)] backdrop-blur-md transition-[border-color,box-shadow] duration-500 hover:border-theme-strong hover:shadow-[0_28px_90px_-28px_rgba(124,111,154,0.18)] md:p-9 ${
        align === "right" ? "md:ml-10 md:max-w-[calc(100%-2.5rem)]" : "md:mr-10 md:max-w-[calc(100%-2.5rem)]"
      }`}
    >
      <div
        className="pointer-events-none absolute -right-2 -top-10 select-none font-display text-[clamp(3.5rem,12vw,7rem)] font-black leading-none tracking-tighter text-theme-1/[0.06] transition-opacity group-hover:text-theme-1/[0.09]"
        aria-hidden
      >
        {n}
      </div>
      <div className="pointer-events-none absolute inset-0 bg-sky-50/35 opacity-85 transition-opacity group-hover:opacity-100" />
      <div className="relative flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--accent-muted)] bg-[color:var(--accent)]/14 text-[color:var(--accent-strong)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)]">
          <Icon className="h-7 w-7" strokeWidth={1.65} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-theme-4">{tag}</div>
          <h3 className="font-display mt-2 text-2xl font-semibold tracking-tight text-theme-1 md:text-3xl">{title}</h3>
          <p className="mt-3 text-base leading-relaxed text-theme-3 md:text-lg md:leading-relaxed">{body}</p>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-6 right-6 h-px bg-theme-subtle opacity-80" />
    </div>
  );
}

function FeatureSpotlightCard({
  mark,
  kind,
  title,
  body,
  icon: Icon,
}: {
  mark: string;
  kind: string;
  title: string;
  body: string;
  icon: LucideIcon;
}) {
  return (
    <div className="group relative overflow-hidden rounded-3xl border border-theme-default bg-surface-1/75 p-6 shadow-lg backdrop-blur-md transition-[transform,border-color] duration-300 hover:-translate-y-0.5 hover:border-theme-strong md:p-8">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-[color:var(--accent)]/35 opacity-90" aria-hidden />
      <div
        className="pointer-events-none absolute bottom-4 right-3 font-display text-5xl font-bold tabular-nums text-theme-1/[0.05] sm:text-6xl"
        aria-hidden
      >
        {mark}
      </div>
      <div className="relative flex gap-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-theme-subtle bg-surface-2/80 text-[color:var(--accent-strong)] transition-colors group-hover:border-[color:var(--accent-muted)]">
          <Icon className="h-6 w-6" strokeWidth={1.65} />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-theme-4">{kind}</div>
          <h3 className="font-display mt-2 text-xl font-semibold tracking-tight text-theme-1 md:text-2xl">{title}</h3>
          <p className="mt-3 text-base leading-relaxed text-theme-3 md:text-lg md:leading-relaxed">{body}</p>
        </div>
      </div>
    </div>
  );
}

const FLOW_STEPS: Array<{
  n: string;
  tag: string;
  title: string;
  body: string;
  icon: LucideIcon;
  align: "left" | "right";
}> = [
  {
    n: "01",
    tag: "Step 1",
    title: "准备输入",
    body: "语音或 Transcript；也可以用固定样本做对照。",
    icon: Mic,
    align: "left",
  },
  {
    n: "02",
    tag: "Step 2",
    title: "生成结构",
    body: "Gate 过滤 → Planner 增量改图 → Mermaid 渲染。",
    icon: Cpu,
    align: "right",
  },
  {
    n: "03",
    tag: "Step 3",
    title: "追踪与对照",
    body: "看结构视图、更新记录、运行摘要和评测指标。",
    icon: Activity,
    align: "left",
  },
];

const FEATURE_SPOTS: Array<{
  mark: string;
  kind: string;
  title: string;
  body: string;
  icon: LucideIcon;
}> = [
  {
    mark: "A",
    kind: "Feature",
    title: "主图 + 结构视图",
    body: "同一份输入，同时得到可读流程图与节点结构。",
    icon: LayoutGrid,
  },
  {
    mark: "B",
    kind: "Feature",
    title: "增量可追踪",
    body: "更新记录 + 运行摘要，解释每次图结构变化。",
    icon: GitBranch,
  },
  {
    mark: "C",
    kind: "Method",
    title: "对照评测",
    body: "延迟、准确率、抖动、好懂度，用数据对比配置。",
    icon: Gauge,
  },
  {
    mark: "D",
    kind: "Method",
    title: "复现与归档",
    body: "固定样本与配置，保存报告，便于追溯与回归。",
    icon: Archive,
  },
];

const LINKED_BLOCKS: ScrollLinkedCardsBlock[] = [
  {
    id: "block-core-flow",
    kicker: "Block · 快速流程",
    title: "把想法快速整理成清晰卡片图",
    description:
      "保留最核心四步：输入内容、整理重点、生成卡片图、保存分享。流程更短，上手更轻松。",
    direction: "right",
    cards: [
      {
        id: "core-input",
        eyebrow: "Step 1",
        title: "输入内容",
        description: "可以直接说，也可以粘贴文本，先把内容放进来。",
        tone: "chip",
        meta: "先输入，后处理",
        branches: [
          { id: "core-input-br1", label: "语音", hint: "边说边记" },
          { id: "core-input-br2", label: "文本", hint: "粘贴即用" },
        ],
      },
      {
        id: "core-clean",
        eyebrow: "Step 2",
        title: "整理重点",
        description: "自动去重、分段，把长文本整理成更清楚的结构。",
        tone: "paper",
        meta: "重点一眼可见",
      },
      {
        id: "core-graph",
        eyebrow: "Step 3",
        title: "生成并微调",
        description: "先出第一版卡片图，再拖拽调整到你满意为止。",
        tone: "code",
        meta: "边看边改",
      },
      {
        id: "core-share",
        eyebrow: "Step 4",
        title: "保存与分享",
        description: "一键保存当前版本，也可以直接发给团队一起看。",
        tone: "note",
        meta: "结果马上可用",
      },
    ],
  },
];

/** @description 首页：深底 + 侧滑导航，与 /app 壳层视觉一致 */
export function HomePage() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nextSectionRef = useRef<HTMLElement | null>(null);
  const [scrollHintVisible, setScrollHintVisible] = useState(true);

  const authMeQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });

  const startHref = authMeQuery.isSuccess ? "/app/realtime" : "/login";

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = () => {
      const y = root.scrollTop || 0;
      setScrollHintVisible(y < 80);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);

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
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium transition-[background-color,color,border-color,box-shadow] duration-200 ease-out ${
                        active
                          ? "border-[color:var(--shell-nav-active-border)] bg-[var(--shell-nav-active-bg)] text-[var(--shell-nav-active-fg)] shadow-[var(--shell-nav-active-shadow)]"
                          : "border-transparent text-theme-3 hover:bg-[var(--shell-nav-hover-bg)] hover:text-theme-2"
                      }`}
                    >
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded-md border transition-[background-color,border-color,color] duration-200 ease-out ${
                          active
                            ? "border-[color:var(--shell-nav-active-icon-border)] bg-[var(--shell-nav-active-icon-bg)] text-[var(--shell-nav-active-icon-fg)]"
                            : "border-theme-subtle bg-surface-muted text-theme-4"
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
        <div className="absolute inset-0 bg-[var(--hero-radial-glow)]/20" />
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
              {authMeQuery.isLoading ? (
                <Button variant="primary" className="h-10 rounded-lg px-6 text-sm font-semibold" disabled aria-busy>
                  正在检测登录…
                </Button>
              ) : (
                <Link href={startHref}>
                  <Button variant="primary" className="h-10 rounded-lg px-6 text-sm font-semibold">
                    开始使用
                    <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
                  </Button>
                </Link>
              )}
              <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/56 bg-surface-muted px-2.5 py-1 text-[11px] text-theme-4">
                <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400/90" aria-hidden />
                实时管线就绪
              </div>
              <div className="inline-flex items-center gap-2 rounded-md border border-sky-100/65 bg-surface-1/80 px-2.5 py-1 text-[11px] text-theme-4">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-100/95" aria-hidden />
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-100/95" aria-hidden />
                <span className="h-1.5 w-1.5 rounded-full bg-amber-100/95" aria-hidden />
                低饱和配色
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => nextSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className={`absolute bottom-8 left-1/2 z-[2] -translate-x-1/2 text-theme-3 transition hover:text-theme-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--shell-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--page-bg)] ${
              scrollHintVisible ? "opacity-90" : "pointer-events-none opacity-0"
            }`}
            aria-label="向下滚动查看更多"
          >
            <ScrollZigzagHint className="home-scroll-hint-motion h-9 w-[5.125rem] text-theme-3 sm:h-10 sm:w-[6.625rem]" />
          </button>
        </section>

        <section
          ref={nextSectionRef}
          className="relative mx-auto w-full max-w-5xl px-6 py-16 text-theme-2 md:px-10 md:py-20"
        >
          <Reveal rootRef={scrollRef} delayMs={0}>
            <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-14 lg:gap-20">
              <div className="relative min-w-0">
                <div
                  className="absolute -left-4 top-1 hidden h-[4.5rem] w-1 rounded-full bg-[color:var(--accent)]/45 md:block"
                  aria-hidden
                />
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-[color:var(--accent-strong)]">Pipeline</p>
                <h2 className="font-display mt-3 text-4xl font-semibold tracking-tight text-theme-1 sm:text-5xl md:text-6xl">
                  从语流到结构图
                </h2>
                <p className="mt-5 max-w-2xl text-lg leading-relaxed text-theme-3 md:text-xl md:leading-relaxed">
                  选择输入 → 生成与调整 → 对照与追踪。三步跑通实时管线，把口述内容落成可读的图与可追踪的变更。
                </p>
                <div className="mt-7 flex flex-wrap gap-2">
                  {["实时语流", "增量 Planner", "报告归档"].map((t, i) => (
                    <span
                      key={t}
                      className={`rounded-full border bg-surface-2/78 px-3.5 py-1.5 text-xs font-medium text-theme-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] ${
                        i === 0 ? "border-sky-300/58" : i === 1 ? "border-emerald-300/56" : "border-amber-300/58"
                      }`}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <FlowPipelineOrnament />
            </div>
          </Reveal>
        </section>

        {LINKED_BLOCKS.map((block) => (
          <ScrollLinkedCardsBlockSection key={block.id} rootRef={scrollRef} block={block} />
        ))}

        <div className="py-6 md:py-8" />

        <section className="relative mx-auto w-full max-w-5xl px-6 py-14 text-theme-2 md:px-10 md:py-16">
          <Reveal rootRef={scrollRef} delayMs={0}>
            <div className="relative overflow-hidden rounded-[2rem] border border-theme-default bg-surface-1/90 p-7 shadow-[0_28px_100px_-40px_rgba(124,111,154,0.35)] backdrop-blur-md md:p-10">
              <div className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-[color:var(--accent)]/12 blur-3xl" aria-hidden />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 max-w-2xl lg:max-w-none lg:flex-1 lg:pr-8">
                  <div className="inline-flex items-center gap-2 rounded-full border border-theme-subtle bg-surface-muted/60 px-3 py-1 text-xs font-medium text-theme-3">
                    <Sparkles className="h-3.5 w-3.5 text-[color:var(--accent-strong)]" aria-hidden />
                    能力与原理
                  </div>
                  <h2 className="font-display mt-4 text-balance break-keep text-4xl font-semibold tracking-tight text-theme-1 sm:text-5xl md:text-6xl">
                    语流成图，为什么从这里开始
                  </h2>
                  <p className="mt-4 max-w-2xl text-lg leading-relaxed text-theme-3 md:text-xl">
                    把复杂管线拆成你能点得到、看得懂的模块：视图、追踪、评测、归档，一整条链路都在工作台里。
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
                  {[
                    { t: "双视图", d: "主图 & 结构" },
                    { t: "可观测", d: "摘要与记录" },
                    { t: "可量化", d: "指标对照" },
                  ].map((x, i) => (
                    <div
                      key={x.t}
                      className={`min-w-[5.5rem] rounded-xl border bg-surface-2/70 px-3 py-2 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] ${
                        i === 0
                          ? "border-sky-100/60"
                          : i === 1
                            ? "border-emerald-100/60"
                            : "border-amber-100/65"
                      }`}
                    >
                      <div className="flex items-center justify-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-theme-4">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            i === 0
                              ? "bg-sky-100/90"
                              : i === 1
                                ? "bg-emerald-100/90"
                                : "bg-amber-100/95"
                          }`}
                          aria-hidden
                        />
                        {x.t}
                      </div>
                      <div className="mt-0.5 text-xs font-medium text-theme-2">{x.d}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* 原本 FeatureSpotlightCard 是纵向 reveal；现在让 block 链表承担“分块叙事”，后续内容保持原节奏即可。 */}

        <section className="relative mx-auto w-full max-w-5xl px-6 py-10 text-theme-2 md:px-10 md:py-12">
          <Reveal rootRef={scrollRef} delayMs={0}>
            <div className="relative overflow-hidden rounded-3xl border border-theme-default bg-surface-1/75 p-7 shadow-lg backdrop-blur-md md:p-9">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-theme-4">How to</div>
              <h3 className="font-display mt-2 text-2xl font-semibold tracking-tight text-theme-1 md:text-3xl">三分钟上手路径</h3>
              <ol className="mt-6 space-y-5">
                {[
                  "在实时工作台开麦或粘贴 Transcript",
                  "对照主图 / 结构视图，确认节点关系",
                  "用更新记录与运行摘要锁定每一次改动",
                ].map((text, i) => (
                  <li key={text} className="flex gap-4">
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-bold tabular-nums ${
                        i === 0
                          ? "border-sky-300/65 bg-sky-100/55 text-sky-800/85"
                          : i === 1
                            ? "border-emerald-300/65 bg-emerald-100/55 text-emerald-800/85"
                            : "border-amber-300/68 bg-amber-100/55 text-amber-800/85"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="pt-1.5 text-base leading-relaxed text-theme-3 md:text-lg">{text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </Reveal>
        </section>

        <section className="relative mx-auto w-full max-w-5xl px-6 py-6 text-theme-2 md:px-10 md:py-8">
          <Reveal rootRef={scrollRef} delayMs={0}>
            <div className="rounded-3xl border border-theme-default bg-surface-1/70 p-7 shadow-lg backdrop-blur-md md:p-9">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-theme-4">Principle</div>
              <h3 className="font-display mt-2 text-2xl font-semibold tracking-tight text-theme-1 md:text-3xl">三条骨架</h3>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                {[
                  { k: "Gate", v: "过滤与归类输入片段" },
                  { k: "Planner", v: "增量修改图结构" },
                  { k: "Renderer", v: "Mermaid + 结构节点" },
                ].map((row, i) => (
                  <div
                    key={row.k}
                    className={`rounded-2xl border bg-surface-2/60 px-4 py-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] ${
                      i === 0 ? "border-sky-300/54" : i === 1 ? "border-emerald-300/52" : "border-amber-300/56"
                    }`}
                  >
                    <div
                      className={`font-mono text-[11px] font-semibold uppercase tracking-wider ${
                        i === 0 ? "text-sky-800/85" : i === 1 ? "text-emerald-800/85" : "text-amber-800/85"
                      }`}
                    >
                      {row.k}
                    </div>
                    <div className="mt-1.5 text-sm leading-relaxed text-theme-2 md:text-base">{row.v}</div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </section>

        <section className="relative mx-auto w-full max-w-5xl px-6 pb-24 pt-6 text-theme-2 md:px-10 md:pb-28 md:pt-8">
          <Reveal rootRef={scrollRef} delayMs={0}>
            <div className="relative overflow-hidden rounded-3xl border border-[color:var(--accent-muted)] bg-surface-muted p-8 md:p-10">
              <span
                className="pointer-events-none absolute left-2 top-0 translate-y-2 font-display text-[6.5rem] leading-none text-[color:var(--accent)] opacity-20"
                aria-hidden
              >
                &ldquo;
              </span>
              <div className="relative text-xs font-semibold uppercase tracking-[0.2em] text-theme-4">Tip</div>
              <p className="font-display relative mt-4 pl-6 text-lg font-medium leading-relaxed text-theme-2 md:pl-8 md:text-xl">
                想严谨对照：用固定样本与配置跑两次，再用评测指标对比差异——偏差会自己说话。
              </p>
            </div>
          </Reveal>
        </section>
      </div>
    </main>
  );
}
