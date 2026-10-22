/**
 * A failing browser test needs the console that explains it.
 *
 * Playwright already keeps a trace, a screenshot and video on failure; this
 * fixture adds the one artifact traces bury — the plain console and page-error
 * stream, timestamped and attached to the report under `console.log`.
 */
import { test as base } from "@playwright/test";

export const test = base.extend<{ consoleLogs: string[] }>({
  consoleLogs: [
    async ({ page }, use, testInfo) => {
      // The suite owns every network edge: loopback is the app and its mock
      // chain, and anything else is refused rather than read from the real
      // internet (the trade page's own public market feed included).
      const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (loopback.has(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") {
          await route.continue();
          return;
        }
        await route.abort("blockedbyclient");
      });
      await page.routeWebSocket(
        (url) => !loopback.has(url.hostname),
        (socket) => socket.close(),
      );

      const lines: string[] = [];
      page.on("console", (message) => {
        const location = message.location();
        lines.push(
          `[${new Date().toISOString()}] ${message.type()}: ${message.text()}${
            location.url ? ` (${location.url}:${location.lineNumber ?? 0})` : ""
          }`,
        );
      });
      page.on("pageerror", (error) => {
        lines.push(`[${new Date().toISOString()}] pageerror: ${error.stack ?? error.message}`);
      });

      await use(lines);

      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("console.log", {
          body: lines.join("\n") || "(no console output)",
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
