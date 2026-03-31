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

/** @description 已登录 /app 区工作区侧滑导航壳层 */
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
    <div className="relative z-0 mx-auto min-h-screen max-w-[min(1720px,100%)] px-4 py-6 pl-20 pt-16 md:px-8 md:py-8 md:pl-24 lg:px-10 xl:px-12">
      <button
        type="button"
        aria-expanded={drawerOpen}
        aria-controls="workspace-nav-drawer"
        aria-label="打开工作区导航"
        className={`group fixed left-4 top-4 z-[105] flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white shadow-[0_12px_40px_rgba(15,23,42,0.55)] backdrop-blur-xl transition duration-300 ease-out hover:bg-white/16 hover:border-white/40 hover:text-white active:scale-[0.94] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(185,167,211,0.4)] ${
          drawerOpen ? "pointer-events-none scale-[0.96] opacity-0" : "opacity-100 hover:scale-[1.05] hover:-translate-y-[1px]"
        } before:pointer-events-none before:absolute before:-z-10 before:h-16 before:w-16 before:rounded-full before:bg-[radial-gradient(circle,rgba(167,139,250,0.55),transparent_62%)] before:opacity-40 before:blur-[1px] before:transition before:duration-700 before:ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:before:opacity-70`}
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
        <Card className="m-0 flex h-full w-full flex-col overflow-hidden rounded-none border-0 p-3 shadow-none sm:my-4 sm:ml-4 sm:h-[calc(100vh-2rem)] sm:rounded-[28px] sm:border sm:border-white/12 !ring-0">
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
            <div className="rounded-[24px] bg-[linear-gradient(155deg,rgba(40,32,54,0.96),rgba(109,90,151,0.86)_58%,rgba(96,48,86,0.78))] px-5 py-5 text-white shadow-[0_18px_42px_rgba(185,167,211,0.16)] ring-1 ring-white/15">
              <div className="text-[11px] font-medium uppercase tracking-[0.28em] text-white/[0.72]">Stream2Graph</div>
              <div className="font-display mt-2 text-[1.5rem] font-semibold leading-tight tracking-[-0.06em] text-violet-200">
                正式平台
              </div>
              {currentItem ? (
                <div className="mt-3 rounded-[16px] border border-white/20 bg-white/10 px-3 py-2.5 text-sm text-white/90">
                  当前：{currentItem.label}
                </div>
              ) : null}
            </div>
            <div className="mt-4 relative overflow-hidden rounded-[22px] border border-white/15 bg-white/9 p-2 backdrop-blur-md shadow-[0_18px_50px_rgba(15,23,42,0.30),inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.18)] ring-1 ring-white/12 before:pointer-events-none before:absolute before:inset-x-4 before:top-[1px] before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent)] before:opacity-80 after:pointer-events-none after:absolute after:inset-[1px] after:rounded-[21px] after:border after:border-white/10 after:content-['']">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_90%_at_20%_0%,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.05)_35%,rgba(255,255,255,0)_70%),radial-gradient(120%_100%_at_80%_120%,rgba(167,139,250,0.16)_0%,rgba(167,139,250,0.06)_38%,rgba(167,139,250,0)_72%)] opacity-90"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(2,6,23,0.32)_0%,rgba(2,6,23,0.08)_45%,rgba(2,6,23,0.20)_100%)] opacity-80"
              />
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
                          ? "bg-[rgba(185,167,211,0.16)] text-violet-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]"
                          : "text-white/75 hover:bg-white/10 hover:text-white/95"
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-2xl transition duration-200 group-hover:scale-[1.04] ${
                          active ? "bg-white/10 text-violet-200 ring-1 ring-white/15" : "bg-white/7 text-white/70 ring-1 ring-white/10 group-hover:bg-white/12 group-hover:text-white/90"
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
            <div className="mt-5 pb-1 text-xs text-white/60">当前环境为公开访问模式，无需登录。</div>
          </div>
        </Card>
      </aside>

      <div className="soft-enter soft-enter-delay-1 relative z-[1] min-w-0">{children}</div>
    </div>
  );
}
