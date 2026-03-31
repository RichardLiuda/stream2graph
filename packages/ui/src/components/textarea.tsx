import type { TextareaHTMLAttributes } from "react";

import { cn } from "../lib/cn";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-[120px] w-full rounded-[24px] border border-white/12 bg-white/[0.03] px-4 py-3.5 text-sm text-white/90 outline-none transition placeholder:text-slate-400 focus:border-[var(--accent)] focus:bg-white/[0.04] focus:ring-4 focus:ring-[rgba(185,167,211,0.18)]",
        className,
      )}
      {...props}
    />
  );
}
