"use client";

import { GlobalPixelBackground } from "@/components/global-pixel-background";
import { QueryProvider } from "@/components/query-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <GlobalPixelBackground />
      <div className="relative z-10 min-h-[100dvh]">{children}</div>
    </QueryProvider>
  );
}
