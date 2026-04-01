"use client";

import { QueryProvider } from "@/components/query-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <div className="relative z-10 min-h-[100dvh]">{children}</div>
    </QueryProvider>
  );
}
