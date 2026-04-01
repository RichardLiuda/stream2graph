"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  BookOpenText,
  ChevronLeft,
  Menu,
  RadioTower,
  Rows4,
  Settings2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Card } from "@stream2graph/ui";

const navItems = [
  { href: "/app/realtime", label: "实时工作", icon: RadioTower },
  { href: "/app/samples", label: "样本对照", icon: Rows4 },
  { href: "/app/reports", label: "实验报告", icon: BarChart3 },
  { href: "/app/settings", label: "设置", icon: Settings2 },
  { href: "/", label: "首页", icon: BookOpenText },
];

/** @description /app 区：统一内容宽度 + 侧滑导航（浮层保留轻微 blur） */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const currentItem = navItems.find((item) => pathname === item.href);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="relative z-0 min-h-screen">
      <button
        type="button"
        aria-expanded={drawerOpen}
        aria-controls="workspace-nav-drawer"
        aria-label="打开工作区导航"
        className={`fixed left-4 top-4 z-[105] flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-zinc-600/90 bg-zinc-900/95 text-zinc-200 shadow-md transition hover:border-zinc-500 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 ${
          drawerOpen ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        onClick={() => setDrawerOpen(true)}
      >
        <Menu className="h-5 w-5" strokeWidth={2} />
      </button>

      {drawerOpen ? (
        <button
          type="button"
          aria-label="关闭工作区导航"
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[2px] transition-opacity"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        id="workspace-nav-drawer"
        aria-hidden={!drawerOpen}
        className={`fixed inset-y-0 left-0 z-[110] flex w-[280px] max-w-[min(280px,88vw)] transition-transform duration-300 ease-out ${
          drawerOpen ? "pointer-events-auto translate-x-0" : "pointer-events-none -translate-x-full"
        }`}
      >
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-0 bg-zinc-950 p-3 shadow-none sm:my-4 sm:ml-4 sm:h-[calc(100vh-2rem)] sm:rounded-2xl sm:border sm:border-zinc-800 sm:shadow-xl">
          <div className="flex shrink-0 items-center gap-2 pb-3">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 justify-start gap-2 rounded-lg px-3 py-2 text-sm"
              onClick={() => setDrawerOpen(false)}
            >
              <ChevronLeft className="h-4 w-4 shrink-0" />
              收起导航
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 px-4 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">Stream2Graph</div>
              <div className="font-display mt-1 text-lg font-semibold tracking-tight text-zinc-100">正式平台</div>
              {currentItem ? (
                <div className="mt-3 rounded-lg border border-zinc-700/80 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                  当前：{currentItem.label}
                </div>
              ) : null}
            </div>
            <nav className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1.5" aria-label="工作区">
              <div className="drawer-nav-animate flex flex-col gap-0.5">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                        active
                          ? "bg-zinc-800 text-zinc-100"
                          : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                      }`}
                    >
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded-md border ${
                          active
                            ? "border-zinc-600 bg-zinc-950 text-zinc-200"
                            : "border-zinc-700/80 bg-zinc-950/50 text-zinc-500"
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
            <p className="mt-4 px-1 text-[11px] leading-relaxed text-zinc-600">
              浏览与试用可匿名访问。
              <Link href="/login" className="ml-1 text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
                管理员登录
              </Link>
            </p>
          </div>
        </Card>
      </aside>

      <div className="soft-enter soft-enter-delay-1 relative z-[1] min-w-0 px-4 py-5 pl-[calc(1rem+2.75rem+1.25rem)] pt-4 md:px-8 md:py-7 md:pl-[calc(1rem+2.75rem+2.25rem)] md:pt-6 lg:px-10 xl:px-12">
        <div className="workspace-content">{children}</div>
      </div>
    </div>
  );
}
