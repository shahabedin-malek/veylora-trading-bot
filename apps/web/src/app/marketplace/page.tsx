import { DepthText } from "@/components/depth-text";
import { MarketplacePanel } from "@/components/marketplace-panel";
import { TerminalShell } from "@/components/terminal-shell";

export const instant = false;

/**
 * The strategy marketplace (phase 30).
 *
 * Public to read: the catalog is a list of rules, not account data. Cloning is the write and
 * it requires a session, which the panel's clone request enforces server-side. Performance
 * shown here is always a recorded backtest — a template without one says so rather than
 * showing a zero or an estimate.
 */
export default function MarketplacePage() {
  return (
    <TerminalShell active="marketplace" section="MARKETPLACE">
      <section className="page-heading" aria-labelledby="marketplace-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />STRATEGY LAB <span className="eyebrow-separator">/</span> SHARED TEMPLATES
          </div>
          <h1 id="marketplace-title"><DepthText text="Strategy marketplace" /></h1>
          <p>
            Clone a template into your own draft, edit it, and publish it. A clone starts its own version history and
            records the template it came from. Every figure below belongs to a recorded backtest of the template&apos;s
            exact rules; where none exists, the card says so.
          </p>
        </div>
        <span className="section-state">REAL BACKTESTS ONLY</span>
      </section>

      <MarketplacePanel />

      <footer className="page-footer">
        <span>PAST BACKTESTS ARE NOT EVIDENCE OF FUTURE RETURNS</span>
        <a href="/bots">OPEN THE BOT BUILDER</a>
      </footer>
    </TerminalShell>
  );
}
