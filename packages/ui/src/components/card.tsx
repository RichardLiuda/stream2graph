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
      fillOpacity={0.23}
      glowColor="232 72 74"
      glowIntensity={0.88}
      glowRadius={26}
    >
      <div
        className={cn(
          "surface-panel flex h-full min-h-0 flex-col rounded-[30px] border border-violet-300/27 p-6 shadow-[0_20px_48px_rgba(76,48,160,0.16)] transition-[transform,box-shadow,border-color,background-color] duration-300 md:p-7",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </BorderGlow>
  );
}
