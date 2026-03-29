"use client";

import Link from "next/link";
import { ArrowRight, Blocks, FlaskConical, Mic2, NotebookTabs } from "lucide-react";

import { Badge, Button, Card, SectionHeading } from "@stream2graph/ui";

const entryCards = [
  {
    title: "实时工作",
    href: "/app/realtime",
    icon: Mic2,
  },
  {
    title: "样本对照",
    href: "/app/samples",
    icon: Blocks,
  },
  {
    title: "实验报告",
    href: "/app/reports",
    icon: NotebookTabs,
  },
  {
    title: "用户研究任务",
    href: "/study/DEMO2026",
    icon: FlaskConical,
  },
];

/**
 * @description 首页：首通栏无描边，依赖全局 PixelBlast + 轻覆层保证可读
 */
export function HomePage() {
  return (
    <main className="mx-auto max-w-[1720px] px-4 py-6 md:px-6 md:py-8">
      <section className="soft-enter relative min-h-[380px] overflow-hidden rounded-[40px] md:min-h-[440px]">
        <div
          className="absolute inset-0 rounded-[40px] bg-[radial-gradient(ellipse_85%_65%_at_50%_-8%,rgba(157,134,255,0.35),transparent_58%)]"
          aria-hidden
        />
        <div
          className="absolute inset-0 rounded-[40px] bg-gradient-to-b from-[#0a0a14]/25 via-transparent to-[#0a0a14]/55"
          aria-hidden
        />
        <div className="relative px-6 py-10 text-white md:px-10 md:py-14">
          <Badge className="border-white/20 bg-white/10 text-white">Stream2Graph 正式平台</Badge>
          <div className="relative mt-7 max-w-4xl">
            <h1 className="max-w-4xl text-4xl font-semibold tracking-[-0.05em] md:text-6xl">Stream2Graph 正式平台</h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-white/[0.82] md:text-lg">
              面向实时成图演示、样本比较、用户研究与结果归档的统一入口。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/login">
                <Button className="bg-white text-slate-950 hover:bg-slate-100">
                  进入管理员工作台
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link href="#modules">
                <Button variant="ghost" className="border-white/25 bg-white/10 text-white hover:bg-white/20">
                  查看页面入口
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section id="modules" className="mt-10 space-y-6">
        <SectionHeading
          tone="onDark"
          eyebrow="Navigation"
          title="页面入口"
          description="按你的使用目标直接进入对应页面。"
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {entryCards.map((item) => {
            const Icon = item.icon;
            return (
              <Card key={item.title} className="lift-hover soft-enter relative overflow-hidden">
                <div className="flex items-start justify-between gap-4">
                  <div className="text-lg font-semibold tracking-[-0.04em] text-slate-950">{item.title}</div>
                  <div className="glass-panel flex h-14 w-14 items-center justify-center rounded-[22px] border border-white/70 text-[var(--accent-strong)]">
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
                <div className="mt-6">
                  <Link href={item.href}>
                    <Button variant="secondary">
                      打开
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      </section>
    </main>
  );
}
