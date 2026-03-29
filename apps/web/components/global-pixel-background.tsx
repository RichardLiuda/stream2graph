"use client";

import PixelBlast from "@/components/pixel-blast";

/**
 * @description 全站固定底层：PixelBlast + 不透明白点由 body 底色承担
 */
export function GlobalPixelBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 h-[100dvh] w-full" aria-hidden>
      <PixelBlast
        antialias
        autoPauseOffscreen
        animate={false}
        className="absolute inset-0 h-full w-full"
        color="#c7b8ff"
        edgeFade={0.5}
        enableRipples={false}
        patternDensity={1.05}
        patternScale={2.1}
        pixelSize={3}
        speed={0}
        variant="square"
      />
    </div>
  );
}
