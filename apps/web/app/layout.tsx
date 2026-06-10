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

const preHydrationScript = `(function(){try{var t=localStorage.getItem("s2g-theme-mode");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light");var attr="data-eusoft-scrollable-element";var cleanup=function(root){if(!root)return;if(root.removeAttribute)root.removeAttribute(attr);if(root.querySelectorAll)root.querySelectorAll("["+attr+"]").forEach(function(el){el.removeAttribute(attr);});};cleanup(document.documentElement);if(typeof MutationObserver!=="undefined"){var observer=new MutationObserver(function(records){records.forEach(function(record){cleanup(record.target);record.addedNodes&&record.addedNodes.forEach(cleanup);});});observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:[attr]});var stop=function(){cleanup(document.documentElement);observer.disconnect();};if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){setTimeout(stop,0);},{once:true});}else{setTimeout(stop,0);}setTimeout(stop,4000);}}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body
        className="font-sans text-theme-2 antialiased"
        style={{ ...fontVariables, fontFamily: "var(--font-body), sans-serif" }}
        suppressHydrationWarning
      >
        <script
          dangerouslySetInnerHTML={{
            __html: preHydrationScript,
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
