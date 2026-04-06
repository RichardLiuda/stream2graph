import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@stream2graph/ui", "@stream2graph/contracts"],
};

export default nextConfig;
