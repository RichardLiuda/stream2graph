import type { HTMLAttributes, PropsWithChildren } from "react";

import { cn } from "../lib/cn";

export function Card({ className, children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col rounded-[30px] border !border-white/12 !bg-white/[0.02] p-6 text-white/90 backdrop-blur-md !shadow-[0_28px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(185,167,211,0.16)] !ring-1 !ring-[#b9a7d3]/14 !ring-inset md:p-7",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
