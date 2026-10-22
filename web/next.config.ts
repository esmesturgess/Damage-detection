import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The badge sits over the reviewer sign-in; errors still surface without it.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
