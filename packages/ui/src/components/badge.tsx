import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

const variantClass = {
  dark:
    "rounded-md border text-[11px] font-medium normal-case tracking-normal border-[color:var(--ui-badge-border)] bg-[var(--ui-badge-bg)] text-[var(--ui-badge-text)]",
  light:
    "rounded-md border border-[color:var(--ui-badge-border)] bg-[var(--ui-badge-bg)] text-[11px] font-medium normal-case tracking-normal text-[var(--ui-badge-text)]",
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
