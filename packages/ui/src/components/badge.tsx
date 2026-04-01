import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

const variantClass = {
  dark:
    "rounded-md border border-zinc-600/80 bg-zinc-900/50 text-[11px] font-medium normal-case tracking-normal text-zinc-300",
  light:
    "rounded-md border border-slate-300/90 bg-slate-100 text-[11px] font-medium normal-case tracking-normal text-slate-700",
};

export function Badge({
  className,
  children,
  variant = "dark",
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLSpanElement> & { variant?: "dark" | "light" }>) {
  return (
    <span className={cn("inline-flex items-center px-2.5 py-1", variantClass[variant], className)} {...props}>
      {children}
    </span>
  );
}
