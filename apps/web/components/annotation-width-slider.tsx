"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";

type Props = {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  /** diameter at min (px) */
  thumbMinPx: number;
  /** diameter at max (px) */
  thumbMaxPx: number;
  className?: string;
  "aria-label"?: string;
};

/**
 * 可视化锥形轨（细→粗）+ 按当前值缩放滑块直径；交互使用透明原生 range（单行工具栏高度内可用）
 */
export function AnnotationWidthSlider({
  min,
  max,
  value,
  onChange,
  thumbMinPx,
  thumbMaxPx,
  className,
  "aria-label": ariaLabel,
}: Props) {
  const range = max - min;
  const t = range > 0 ? (value - min) / range : 0;
  const thumbPx = thumbMinPx + t * (thumbMaxPx - thumbMinPx);

  const id = useMemo(() => `ann-w-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <div className={cn("relative flex h-full min-w-[76px] max-w-[118px] shrink items-center justify-center", className)}>
      <div className="relative h-5 w-full">
        <svg
          className="pointer-events-none absolute left-0 right-0 top-1/2 h-3.5 w-full -translate-y-1/2 overflow-visible text-theme-3"
          viewBox="0 0 200 20"
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <linearGradient id={`${id}-g`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.12" />
            </linearGradient>
          </defs>
          <polygon
            points="0,9 200,4 200,16 0,11"
            fill={`url(#${id}-g)`}
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="0.6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div
          className="pointer-events-none absolute top-1/2 z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 shadow-sm"
          style={{
            left: `${t * 100}%`,
            width: thumbPx,
            height: thumbPx,
            backgroundColor: "var(--accent)",
            boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent)",
          }}
          aria-hidden
        />
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={ariaLabel ?? "宽度"}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          className="absolute inset-0 z-[2] h-full w-full cursor-pointer opacity-0"
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
