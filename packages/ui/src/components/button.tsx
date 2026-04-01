import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

type ButtonVariant = "primary" | "secondary" | "secondaryLight" | "ghost" | "danger";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent-strong)] text-white shadow-sm hover:bg-[#50446d] hover:shadow-md active:translate-y-px",
  secondary:
    "border shadow-sm active:translate-y-px border-[color:var(--ui-btn-secondary-border)] bg-[var(--ui-btn-secondary-bg)] text-[var(--ui-btn-secondary-text)] hover:border-[color:var(--ui-btn-secondary-border-hover)] hover:bg-[var(--ui-btn-secondary-bg-hover)]",
  secondaryLight:
    "border border-[color:var(--ui-btn-secondary-border)] bg-[var(--ui-btn-secondary-bg)] text-[var(--ui-btn-secondary-text)] shadow-sm hover:border-[color:var(--ui-btn-secondary-border-hover)] hover:bg-[var(--ui-btn-secondary-bg-hover)] active:translate-y-px",
  ghost: "border bg-transparent border-[color:var(--ui-btn-ghost-border)] text-[var(--ui-btn-ghost-text)] hover:border-[color:var(--ui-btn-ghost-border-hover)] hover:bg-[var(--ui-btn-ghost-bg-hover)]",
  danger: "bg-red-700 text-white shadow-sm hover:bg-red-800 active:translate-y-px",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, PropsWithChildren {
  variant?: ButtonVariant;
}

export function Button({ className, variant = "primary", children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition duration-200 disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
