import type { TextareaHTMLAttributes } from "react";

import { cn } from "../lib/cn";

const surfaceClass = {
  dark:
    "border-zinc-700/90 bg-zinc-950/40 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:ring-zinc-600/40",
  light:
    "border-slate-300/90 bg-[rgba(245,246,248,0.96)] text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:ring-slate-300/50",
};

export function Textarea({
  className,
  variant = "dark",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { variant?: "dark" | "light" }) {
  return (
    <textarea
      className={cn(
        "min-h-[120px] w-full rounded-xl border px-3.5 py-3 text-sm outline-none transition focus:ring-2",
        surfaceClass[variant],
        className,
      )}
      {...props}
    />
  );
}
