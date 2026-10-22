/**
 * Refuse every outbound HTTP(S) request that is not loopback.
 *
 * The suite runs the real app, and the app reads public market data on its own.
 * That is not something a spec asked for, and an offline CI runner must not
 * depend on it, so this preload replaces the server's `fetch` with one that only
 * reaches the mock chain and the app's own loopback origin. Load it with
 * `NODE_OPTIONS=--require …/network-isolation.cjs` in the e2e web server.
 */
const originalFetch = globalThis.fetch;

globalThis.fetch = function isolatedFetch(input, init) {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : input && typeof input === "object" && "url" in input ? String(input.url) : "";
  let hostname = "";
  try {
    hostname = new URL(href).hostname;
  } catch {
    hostname = "";
  }
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
    return originalFetch.call(this, input, init);
  }
  return Promise.reject(new TypeError(`E2E network isolation blocked ${href || "a request with no URL"}`));
};
