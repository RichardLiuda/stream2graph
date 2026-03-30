import type { HTMLAttributes, PropsWithChildren } from "react";

import { BorderGlow } from "./border-glow";
import { cn } from "../lib/cn";

export function Card({ className, children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <BorderGlow
      embed
      backgroundColor="transparent"
      borderRadius={30}
      className="min-w-0"
      colors={["#9cb0ff", "#c7b8ff", "#8fd4f5"]}
      coneSpread={22}
      edgeSensitivity={26}
      fillOpacity={0.38}
      glowColor="232 72 74"
      glowIntensity={0.88}
      glowRadius={26}
    >
      <div
        className={cn(
          "flex h-full min-h-0 flex-col rounded-[30px] border !border-white/25 !bg-white/[0.03] text-white/90 backdrop-blur-md p-6 !shadow-[0_28px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(143,212,245,0.22)] !ring-1 !ring-[#8fd4f5]/25 !ring-inset transition-[transform,box-shadow,border-color,background-color,ring-color] duration-300 hover:!border-white/12 hover:!shadow-none hover:!ring-0 hover:!ring-inset md:p-7",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </BorderGlow>
  );
}
