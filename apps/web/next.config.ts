import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  distDir: process.env.VEYLORA_NEXT_DIST_DIR ?? ".next",
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["ccxt"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "bitcoinist.com" },
      { protocol: "https", hostname: "cdn.sanity.io" },
      { protocol: "https", hostname: "s3-images.ctmedia.io" },
      { protocol: "https", hostname: "cryptopotato.com" },
      { protocol: "https", hostname: "cryptoslate.com" },
      { protocol: "https", hostname: "img.decrypt.co" },
      { protocol: "https", hostname: "cdn.decrypt.co" },
      { protocol: "https", hostname: "www.newsbtc.com" },
      { protocol: "https", hostname: "static.cryptobriefing.com" },
    ],
  },
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
