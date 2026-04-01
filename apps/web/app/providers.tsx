"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { QueryProvider } from "@/components/query-provider";
import { Button } from "@stream2graph/ui";

type ThemeMode = "dark" | "light";

function readThemePreference(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem("s2g-theme-mode");
  return stored === "light" ? "light" : "dark";
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const next = readThemePreference();
    setTheme(next);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("s2g-theme-mode", theme);
  }, [ready, theme]);

  return (
    <QueryProvider>
      <div className="pointer-events-none fixed right-4 top-4 z-[30000] max-[380px]:right-3 max-[380px]:top-3">
        <Button
          type="button"
          variant={theme === "dark" ? "secondary" : "secondaryLight"}
          className="pointer-events-auto h-10 w-10 rounded-lg p-0"
          title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
          aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
      <div className="theme-root relative z-10 min-h-[100dvh]">{children}</div>
    </QueryProvider>
  );
}
