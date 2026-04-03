import type { InputHTMLAttributes } from "react";

import { cn } from "../lib/cn";

const surfaceClass = {
  dark:
    "border-[color:var(--ui-input-border)] bg-[var(--ui-input-bg)] text-[var(--ui-input-text)] placeholder:text-[var(--ui-input-placeholder)] focus-visible:border-[color:var(--ui-input-focus-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--page-bg)]",
  light:
    "border-[color:var(--ui-input-border)] bg-[var(--ui-input-bg)] text-[var(--ui-input-text)] placeholder:text-[var(--ui-input-placeholder)] focus-visible:border-[color:var(--ui-input-focus-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--page-bg)]",
};

export function Input({
  className,
  variant = "dark",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { variant?: "dark" | "light" }) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-lg border px-3.5 text-sm transition",
        surfaceClass[variant],
        className,
      )}
      {...props}
    />
  );
}
