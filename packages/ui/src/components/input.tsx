import type { InputHTMLAttributes } from "react";

import { cn } from "../lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-12 w-full rounded-[22px] border border-white/12 bg-white/[0.03] px-4 text-sm text-white/90 outline-none transition placeholder:text-slate-400 focus:border-[var(--accent)] focus:bg-white/[0.04] focus:ring-4 focus:ring-[rgba(185,167,211,0.18)]",
        className,
      )}
      {...props}
    />
  );
}
