"use client";

import { useQuery } from "@tanstack/react-query";
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

import { ApiError, api } from "@/lib/api";

const allNavItems = [
  { href: "/app/realtime", label: "实时工作", icon: RadioTower, guest: true },
  { href: "/app/samples", label: "样本对照", icon: Rows4, guest: false },
  { href: "/app/reports", label: "实验报告", icon: BarChart3, guest: false },
  { href: "/app/settings", label: "设置", icon: Settings2, guest: false },
  { href: "/", label: "首页", icon: BookOpenText, guest: true },
] as const;

/** @description /app 区：统一内容宽度 + 侧滑导航（浮层保留轻微 blur） */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const authQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });
  const isGuest =
    authQuery.isFetched &&
    authQuery.isError &&
    authQuery.error instanceof ApiError &&
    authQuery.error.status === 401;
  const navItems = isGuest ? allNavItems.filter((item) => item.guest) : [...allNavItems];
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
        className={`fixed left-4 top-4 z-[105] flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--shell-control-border)] bg-[var(--shell-control-bg)] text-[color:var(--shell-control-fg)] shadow-md transition hover:border-[color:var(--shell-control-border-hover)] hover:bg-[var(--shell-control-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--shell-focus-ring)] ${
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
          className="fixed inset-0 z-[100] bg-[var(--shell-backdrop)] backdrop-blur-[2px] transition-opacity"
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
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-0 bg-surface-1 p-3 shadow-none sm:my-4 sm:ml-4 sm:h-[calc(100vh-2rem)] sm:rounded-2xl sm:border sm:border-theme-default sm:shadow-xl">
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
            <div className="rounded-xl border border-theme-default bg-surface-2 px-4 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-theme-4">Stream2Graph</div>
              <div className="font-display mt-1 text-lg font-semibold tracking-tight text-theme-1">正式平台</div>
              {currentItem ? (
                <div className="mt-3 rounded-lg border border-theme-subtle bg-surface-1 px-3 py-2 text-xs text-theme-3">
                  当前：{currentItem.label}
                </div>
              ) : null}
            </div>
            <nav className="mt-3 rounded-xl border border-theme-default bg-surface-muted p-1.5" aria-label="工作区">
              <div className="drawer-nav-animate flex flex-col gap-0.5">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href;
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
            <p className="mt-4 px-1 text-[11px] leading-relaxed text-theme-5">
              {isGuest ? (
                <>
                  访客模式仅开放实时工作台；样本、报告与平台设置需
                  <Link href="/login" className="link-accent mx-1 font-medium">
                    管理员登录
                  </Link>
                  。
                </>
              ) : (
                <>
                  已登录管理员，可使用全部工作区功能。
                  <Link href="/" className="link-accent ml-1 font-medium">
                    返回首页
                  </Link>
                </>
              )}
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
