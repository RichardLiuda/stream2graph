import type { Metadata } from "next";
import type { CSSProperties } from "react";

import { Providers } from "./providers";
import "./globals.css";

const fontVariables = {
  "--font-body":
    '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--font-display":
    '"Plus Jakarta Sans", Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as CSSProperties;

export const metadata: Metadata = {
  title: "Stream2Graph Platform",
  description: "Formal platform for realtime dialogue-to-diagram research and evaluation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body
        className="font-sans text-theme-2 antialiased"
        style={{ ...fontVariables, fontFamily: "var(--font-body), sans-serif" }}
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("s2g-theme-mode");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`,
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
