import { connection } from "next/server";
import { DepthText } from "@/components/depth-text";
import { ScreenerPanel } from "@/components/screener-panel";
import { TerminalShell } from "@/components/terminal-shell";
import { loadScreenerPayload } from "@/lib/screener/payload";

/**
 * The page reads the session and stored screens before it can render, so it is a
 * blocking route rather than a prerendered shell with a spinner. That is the
 * honest shape for a screen whose first paint includes "as of now".
 */
export const instant = false;

/**
 * The screener page (phase 19).
 *
 * The panel is a client component because running a screen, saving it and
 * replaying it are interactions. The data behind it is not: the API route reads
 * stored candles and provider health, and the runner ingests them whether this
 * page is open or not, which is the "no browser required" requirement.
 */
export default async function ScreenerPage() {
  // The session cookie and the stored screens are request-time data; without
  // this the page would try to prerender a clock (“as of now”) that cannot be.
  await connection();
  const payload = await loadScreenerPayload();
  return (
    <TerminalShell active="screener" section="MARKET SCREENER">
      <section className="page-heading" aria-labelledby="screener-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            MARKET INTELLIGENCE <span className="eyebrow-separator">/</span> SCREENER
          </div>
          <h1 id="screener-title"><DepthText text="Market screener" /></h1>
          <p>
            Evaluate a price or RSI-14 condition across the curated USD markets, save the screen, replay it against
            stored candles, and turn its matches into alerts. Informational only; nothing here places an order.
          </p>
        </div>
        <span className="section-state">STORED CANDLES · PUBLIC DATA</span>
      </section>

      <ScreenerPanel initialPayload={payload} />

      <footer className="page-footer">
        <span>PUBLIC COINBASE CANDLES · SHARED INDICATORS</span>
        <a href="/markets">OPEN MARKET CHARTS</a>
      </footer>
    </TerminalShell>
  );
}
