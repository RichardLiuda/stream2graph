import type { InputHTMLAttributes } from "react";

import { cn } from "../lib/cn";

const surfaceClass = {
  dark:
    "border-[color:var(--ui-input-border)] bg-[var(--ui-input-bg)] text-[var(--ui-input-text)] placeholder:text-[var(--ui-input-placeholder)] focus:border-[color:var(--ui-input-focus-border)] focus:ring-[var(--ui-input-focus-ring)]",
  light:
    "border-[color:var(--ui-input-border)] bg-[var(--ui-input-bg)] text-[var(--ui-input-text)] placeholder:text-[var(--ui-input-placeholder)] focus:border-[color:var(--ui-input-focus-border)] focus:ring-[var(--ui-input-focus-ring)]",
};

export function Input({
  className,
  variant = "dark",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { variant?: "dark" | "light" }) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-lg border px-3.5 text-sm outline-none transition focus:ring-2",
        surfaceClass[variant],
        className,
      )}
      {...props}
    />
  );
}
