import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

type ButtonVariant = "primary" | "secondary" | "secondaryLight" | "ghost" | "danger";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent-strong)] text-white shadow-sm hover:bg-[#50446d] hover:shadow-md active:translate-y-px",
  secondary:
    "border border-zinc-600/90 bg-zinc-900/70 text-zinc-100 shadow-sm hover:border-zinc-500 hover:bg-zinc-800 active:translate-y-px",
  secondaryLight:
    "border border-slate-300/90 bg-slate-100 text-slate-900 shadow-sm hover:border-slate-400 hover:bg-white active:translate-y-px",
  ghost: "border border-zinc-600/80 bg-transparent text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900/60",
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
