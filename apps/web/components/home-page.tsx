"use client";

import Link from "next/link";
import { ArrowRight, BarChart3, BookOpenText, Menu, RadioTower, Rows4, Settings2 } from "lucide-react";
import { useState } from "react";

import { Badge, Button, Card } from "@stream2graph/ui";
import { BackgroundPathLayer } from "@/components/ui/background-paths";

const navItems = [
  { href: "/app/realtime", label: "实时工作", icon: RadioTower },
  { href: "/app/samples", label: "样本对照", icon: Rows4 },
  { href: "/app/reports", label: "实验报告", icon: BarChart3 },
  { href: "/app/settings", label: "设置", icon: Settings2 },
  { href: "/", label: "首页", icon: BookOpenText },
];

/** @description 首页：深底 + 侧滑导航，与 /app 壳层视觉一致 */
export function HomePage() {
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      <section className="soft-enter relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-[var(--page-bg)]">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_0%,var(--hero-radial-glow),transparent_70%)]"
          aria-hidden
        />
        <BackgroundPathLayer />
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
    </main>
  );
}
