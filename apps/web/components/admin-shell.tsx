"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BookOpenText,
  ChevronLeft,
  LogOut,
  Menu,
  RadioTower,
  Rows4,
  Settings2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Card } from "@stream2graph/ui";

import { clearAuthPending } from "@/lib/auth-session";
import { api } from "@/lib/api";

const navItems = [
  { href: "/app/realtime", label: "实时工作", icon: RadioTower },
  { href: "/app/samples", label: "样本对照", icon: Rows4 },
  { href: "/app/reports", label: "实验报告", icon: BarChart3 },
  { href: "/app/settings", label: "设置", icon: Settings2 },
  { href: "/", label: "首页", icon: BookOpenText },
];

/** @description 已登录 /app 区工作区侧滑导航壳层 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
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
    <div className="relative z-0 mx-auto min-h-screen max-w-[min(1720px,100%)] px-4 py-6 pl-16 pt-16 md:px-8 md:py-8 lg:px-10 xl:px-12">
      <button
        type="button"
        aria-expanded={drawerOpen}
        aria-controls="workspace-nav-drawer"
        aria-label="打开工作区导航"
        className={`fixed left-4 top-4 z-[105] flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/75 bg-white/[0.92] text-slate-700 shadow-[0_8px_28px_rgba(36,80,198,0.18)] backdrop-blur-md transition duration-200 hover:bg-white hover:text-slate-900 active:scale-[0.96] focus-visible:outline focus-visible:ring-4 focus-visible:ring-[rgba(77,124,255,0.2)] ${
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
          className="fixed inset-0 z-[100] bg-slate-900/40 backdrop-blur-[3px] transition-opacity"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        id="workspace-nav-drawer"
        aria-hidden={!drawerOpen}
        className={`fixed inset-y-0 left-0 z-[110] flex w-[288px] max-w-[min(288px,88vw)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          drawerOpen
            ? "pointer-events-auto translate-x-0 shadow-[8px_0_40px_rgba(15,23,42,0.12)]"
            : "pointer-events-none -translate-x-full"
        }`}
      >
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-y-0 border-l-0 border-r border-white/60 p-3 shadow-[inset_1px_0_0_rgba(255,255,255,0.35)] sm:my-4 sm:ml-4 sm:h-[calc(100vh-2rem)] sm:rounded-[28px] sm:border sm:ring-1 sm:ring-white/25">
          <div className="flex shrink-0 items-center gap-2 pb-3">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 justify-start gap-2 rounded-[18px] px-3 py-2.5 text-slate-700 transition hover:bg-white/80"
              onClick={() => setDrawerOpen(false)}
            >
              <ChevronLeft className="h-4 w-4 shrink-0" />
              收起导航
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="rounded-[24px] bg-[linear-gradient(155deg,rgba(22,65,179,0.96),rgba(77,124,255,0.9)_58%,rgba(69,151,137,0.82))] px-5 py-5 text-white shadow-[0_18px_42px_rgba(36,80,198,0.16)] ring-1 ring-white/15">
              <div className="text-[11px] font-medium uppercase tracking-[0.28em] text-white/[0.72]">Stream2Graph</div>
              <div className="font-display mt-2 text-[1.5rem] font-semibold leading-tight tracking-[-0.06em]">Formal Platform</div>
              {currentItem ? (
                <div className="mt-3 rounded-[16px] border border-white/20 bg-white/10 px-3 py-2.5 text-sm text-white/90">
                  当前：{currentItem.label}
                </div>
              ) : null}
            </div>
            <div className="mt-4 rounded-[22px] bg-violet-200/38 p-2 backdrop-blur-md ring-1 ring-violet-300/40">
              <div className="drawer-nav-animate flex flex-col gap-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      className={`group flex items-center gap-3 rounded-[18px] px-4 py-3 text-sm font-medium transition duration-200 ${
                        active
                          ? "bg-[rgba(77,124,255,0.14)] text-[var(--accent-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]"
                          : "text-slate-600 hover:bg-violet-100/55 hover:text-slate-900"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-2xl transition duration-200 group-hover:scale-[1.04] ${
                          active ? "bg-violet-50/95 text-[var(--accent-strong)]" : "bg-violet-100/45 text-slate-500 group-hover:bg-violet-50/85"
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
            <div className="mt-5 pb-1">
              <Button
                variant="secondary"
                className="w-full justify-center py-3 transition active:scale-[0.99]"
                onClick={async () => {
                  await api.logout();
                  clearAuthPending();
                  router.replace("/login");
                }}
              >
                <LogOut className="h-4 w-4" />
                退出管理员
              </Button>
            </div>
          </div>
        </Card>
      </aside>

      <div className="soft-enter soft-enter-delay-1 relative z-[1] min-w-0">{children}</div>
    </div>
  );
}
