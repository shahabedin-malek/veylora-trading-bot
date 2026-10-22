import type { NextConfig } from "next";

/**
 * The response headers that constrain what a page may load and where it may send data.
 *
 * They are configured here rather than in a middleware so they are attached by the server for
 * every route, including the pages and the exports, without a per-request hop. The policy is
 * written against what this application actually loads, so it can stay enforced rather than
 * reported: fonts and images are same-origin (or one of the news hosts the market pages show),
 * the live ticker opens one Coinbase feed, mobile pairing talks to the WalletConnect relay, and
 * no third-party script is loaded at all.
 *
 * `script-src 'unsafe-inline'` is the one concession: Next's own bootstrap and the JSON it
 * serialises into the document are inline, and a nonce would require a middleware that rewrites
 * every response (and would disable the static rendering the terminal pages rely on). `eval` is
 * still refused in production, which is what the concession would otherwise have allowed.
 */
const NEWS_IMAGE_HOSTS = [
  "bitcoinist.com",
  "cdn.sanity.io",
  "s3-images.ctmedia.io",
  "cryptopotato.com",
  "cryptoslate.com",
  "img.decrypt.co",
  "cdn.decrypt.co",
  "www.newsbtc.com",
  "static.cryptobriefing.com",
];

const WALLET_CONNECT_ORIGINS = [
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "https://*.reown.com",
  "https://api.web3modal.com",
  "https://pulse.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  "wss://relay.walletconnect.com",
];

function contentSecurityPolicy(isProduction: boolean): string {
  const scriptSources = isProduction
    ? ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]
    : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];
  const connectSources = [
    "'self'",
    "https://api.exchange.coinbase.com",
    "wss://ws-feed.exchange.coinbase.com",
    ...WALLET_CONNECT_ORIGINS,
    ...(isProduction ? [] : ["ws://localhost:*", "http://localhost:*", "http://127.0.0.1:*"]),
  ];
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${NEWS_IMAGE_HOSTS.map((host) => `https://${host}`).join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * The commit the running deployment was built from, when the host knows it.
 *
 * It rides on every response so the hosted smoke check can prove it is testing the
 * build it was asked to test, rather than whichever deployment happens to be behind
 * the URL. `unknown` is a complete answer: a locally started build has no commit.
 */
function deployedCommit(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GIT_COMMIT?.trim() ||
    process.env.COMMIT_SHA?.trim() ||
    "unknown"
  );
}

function securityHeaders(isProduction: boolean): { key: string; value: string }[] {
  return [
    { key: "X-Veylora-Commit", value: deployedCommit() },
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isProduction) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: [
        "camera=()",
        "microphone=()",
        "geolocation=()",
        "payment=()",
        "usb=()",
        "serial=()",
        "bluetooth=()",
        "magnetometer=()",
        "gyroscope=()",
        "accelerometer=()",
      ].join(", "),
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    // HSTS only where it can be honoured: a browser on http://localhost would otherwise pin
    // localhost to https for six months, which is a development trap rather than a protection.
    ...(isProduction
      ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
      : []),
  ];
}

const nextConfig: NextConfig = {
  /* config options here */
  distDir: process.env.VEYLORA_NEXT_DIST_DIR ?? ".next",
  // The framework banner names the stack in every response for no benefit to a reader.
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["ccxt"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NODE_ENV === "production"),
      },
    ];
  },
  images: {
    remotePatterns: NEWS_IMAGE_HOSTS.map((hostname) => ({ protocol: "https" as const, hostname })),
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
