import type { TextareaHTMLAttributes } from "react";

import { cn } from "../lib/cn";

const surfaceClass = {
  dark:
    "border-[color:var(--ui-input-border)] bg-[var(--ui-input-bg)] text-[var(--ui-input-text)] placeholder:text-[var(--ui-input-placeholder)] focus:border-[color:var(--ui-input-focus-border)] focus:ring-[var(--ui-input-focus-ring)]",
  light:
    "border-[color:var(--ui-input-border)] bg-[var(--ui-input-bg)] text-[var(--ui-input-text)] placeholder:text-[var(--ui-input-placeholder)] focus:border-[color:var(--ui-input-focus-border)] focus:ring-[var(--ui-input-focus-ring)]",
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
