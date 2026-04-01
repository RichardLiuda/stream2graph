import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

export type CardVariant = "dark" | "light";

const variantClass: Record<CardVariant, string> = {
  dark:
    "rounded-2xl border border-zinc-800/90 bg-zinc-950/70 text-zinc-200 shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset,0_14px_40px_rgba(0,0,0,0.4)]",
  light:
    "rounded-2xl border border-slate-200/70 bg-[rgba(245,246,248,0.94)] text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
}

export function Card({
  className,
  children,
  variant = "dark",
  ...props
}: PropsWithChildren<CardProps>) {
  return (
    <div
      className={cn("flex h-full min-h-0 flex-col p-6 md:p-7", variantClass[variant], className)}
      {...props}
    >
      {children}
    </div>
  );
}
