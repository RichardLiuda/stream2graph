import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

export type CardVariant = "dark" | "light";

const variantClass: Record<CardVariant, string> = {
  dark:
    "rounded-2xl border text-[var(--ui-card-text)] shadow-[var(--ui-card-shadow)] border-[color:var(--ui-card-border)] bg-[var(--ui-card-bg)]",
  light:
    "rounded-2xl border text-[var(--ui-card-text)] shadow-[var(--ui-card-shadow)] border-[color:var(--ui-card-border)] bg-[var(--ui-card-bg)]",
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
