import type { NextConfig } from "next";

/** 由 Next 服务端转发到 FastAPI；浏览器只请求同源 `/api/*`，避免局域网/穿透下的跨域与 Cookie 问题 */
const apiProxyTarget = (
  process.env.API_PROXY_TARGET ||
  process.env.NEXT_PUBLIC_API_PROXY_TARGET ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  transpilePackages: ["@stream2graph/ui", "@stream2graph/contracts"],
  async rewrites() {
    if (process.env.NEXT_PUBLIC_API_BROWSER_PROXY === "0") {
      return [];
    }
    return [
      { source: "/api/health", destination: `${apiProxyTarget}/api/health` },
      { source: "/api/v1/:path*", destination: `${apiProxyTarget}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;
