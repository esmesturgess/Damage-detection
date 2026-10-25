import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The badge sits over the reviewer sign-in; errors still surface without it.
  devIndicators: false,
  // A self-contained server (.next/standalone) for the single Docker image; `next dev` is unaffected.
  output: "standalone",
};

export default nextConfig;
