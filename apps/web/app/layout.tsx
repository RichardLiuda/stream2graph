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
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body
        className={`${bodyFont.variable} ${displayFont.variable} font-sans text-slate-950`}
        style={{ fontFamily: "var(--font-body), sans-serif" }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
