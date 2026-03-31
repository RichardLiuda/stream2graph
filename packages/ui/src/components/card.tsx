import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

export function Card({ className, children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col rounded-[30px] border border-slate-400/20 bg-white/[0.02] p-6 text-white/90 backdrop-blur-md shadow-[0_18px_60px_rgba(0,0,0,0.60),inset_0_1px_0_rgba(255,255,255,0.04)] md:p-7",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
