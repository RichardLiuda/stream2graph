import type { Metadata } from "next";
import { Noto_Sans_SC, Plus_Jakarta_Sans } from "next/font/google";

import { Providers } from "./providers";
import "./globals.css";

const bodyFont = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

const displayFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Stream2Graph Platform",
  description: "Formal platform for realtime dialogue-to-diagram research and evaluation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body
        className={`${bodyFont.variable} ${displayFont.variable} font-sans text-theme-2 antialiased`}
        style={{ fontFamily: "var(--font-body), sans-serif" }}
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("s2g-theme-mode");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark");}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`,
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
