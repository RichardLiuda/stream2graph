import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[linear-gradient(135deg,var(--accent-strong),var(--accent))] text-white shadow-[0_14px_30px_rgba(109,90,151,0.24)] hover:translate-y-[-1px] hover:shadow-[0_18px_36px_rgba(109,90,151,0.26)]",
  secondary:
    "border border-white/70 bg-white/[0.76] text-slate-900 shadow-[0_10px_24px_rgba(15,23,42,0.04)] backdrop-blur-md hover:border-slate-300 hover:bg-white/[0.92]",
  ghost:
    "border border-white/60 bg-white/[0.46] text-slate-900 backdrop-blur-md hover:bg-white/70",
  danger:
    "bg-[linear-gradient(135deg,#cc4b4b,#b93838)] text-white shadow-[0_14px_30px_rgba(185,56,56,0.22)] hover:translate-y-[-1px] hover:shadow-[0_18px_36px_rgba(185,56,56,0.24)]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, PropsWithChildren {
  variant?: ButtonVariant;
}

export function Button({ className, variant = "primary", children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition duration-300 disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
