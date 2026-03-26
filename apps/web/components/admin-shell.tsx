"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, BookOpenText, LogOut, RadioTower, Rows4, Settings2 } from "lucide-react";

import { Button, Card } from "@stream2graph/ui";

import { clearAuthPending } from "@/lib/auth-session";
import { api } from "@/lib/api";

const navItems = [
  { href: "/app/realtime", label: "实时工作台", icon: RadioTower },
  { href: "/app/samples", label: "样本对比", icon: Rows4 },
  { href: "/app/reports", label: "实验与报告", icon: BarChart3 },
  { href: "/app/settings", label: "平台配置", icon: Settings2 },
  { href: "/", label: "项目首页", icon: BookOpenText },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const currentItem = navItems.find((item) => pathname === item.href);

  return (
    <div className="mx-auto min-h-screen max-w-[1720px] px-4 py-6 md:px-6 md:py-8">
      <div className="soft-enter mb-6 lg:hidden">
        <Card className="overflow-hidden p-3">
          <div className="rounded-[26px] bg-[linear-gradient(150deg,rgba(22,65,179,0.94),rgba(77,124,255,0.88)_58%,rgba(69,151,137,0.78))] px-5 py-5 text-white shadow-[0_18px_44px_rgba(36,80,198,0.16)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-white/[0.68]">Stream2Graph</div>
                <div className="mt-2 text-2xl font-semibold tracking-[-0.05em]">Formal Platform</div>
                {currentItem ? (
                  <div className="mt-3 text-sm text-white/84">当前页面：{currentItem.label}</div>
                ) : null}
              </div>
              <Button
                variant="secondary"
                className="border-white/20 bg-white/14 px-4 py-2 text-white hover:bg-white/20"
                onClick={async () => {
                  await api.logout();
                  clearAuthPending();
                  router.replace("/login");
                }}
              >
                <LogOut className="h-4 w-4" />
                退出
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium transition ${
                    active
                      ? "border-[rgba(77,124,255,0.24)] bg-[rgba(77,124,255,0.12)] text-[var(--accent-strong)]"
                      : "border-white/70 bg-white/[0.58] text-slate-600 hover:bg-white/78 hover:text-slate-900"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[288px_minmax(0,1fr)]">
        <Card className="soft-enter sticky top-6 hidden h-fit overflow-hidden p-3 lg:block">
          <div className="rounded-[24px] bg-[linear-gradient(155deg,rgba(22,65,179,0.96),rgba(77,124,255,0.9)_58%,rgba(69,151,137,0.82))] px-5 py-5 text-white shadow-[0_18px_42px_rgba(36,80,198,0.16)]">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/[0.68]">Stream2Graph</div>
            <div className="mt-2 text-[1.45rem] font-semibold tracking-[-0.05em]">Formal Platform</div>
            {currentItem ? (
              <div className="mt-3 rounded-[16px] border border-white/18 bg-white/10 px-3 py-2.5 text-sm text-white/84">
                当前页面：{currentItem.label}
              </div>
            ) : null}
          </div>
          <div className="mt-4 rounded-[22px] bg-white/[0.42] p-2 backdrop-blur-md">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`mb-1 flex items-center gap-3 rounded-[18px] px-4 py-3 text-sm font-medium transition ${
                    active
                      ? "bg-[rgba(77,124,255,0.14)] text-[var(--accent-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]"
                      : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-2xl transition ${
                      active ? "bg-white/[0.85] text-[var(--accent-strong)]" : "bg-white/[0.55] text-slate-500"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
          <div className="mt-5">
            <Button
              variant="secondary"
              className="w-full justify-center py-3"
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
        </Card>
        <div className="soft-enter soft-enter-delay-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
