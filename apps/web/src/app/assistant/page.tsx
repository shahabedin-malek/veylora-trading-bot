import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { MarketAssistant } from "@/components/market-assistant";

export const instant = false;

export default function AssistantPage() {
  return (
    <TerminalShell active="assistant" section="AI ASSISTANT">
      <section className="page-heading" aria-labelledby="assistant-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            MARKET INTELLIGENCE <span className="eyebrow-separator">/</span> ASSISTANT
          </div>
          <h1 id="assistant-page-title"><DepthText text="AI assistant" /></h1>
          <p>
            Answers built from real data through tools: your balances, positions, orders, ledger history and alerts,
            plus public quotes, candles, indicators and web research. Every answer lists the data it used and when it
            was read, and says so when a source could not be read. Order placement and fund movement stay in the
            app&apos;s own authenticated routes.
          </p>
        </div>
        <span className="section-state">TOOL-ENABLED · STREAMED</span>
      </section>
      <MarketAssistant />
    </TerminalShell>
  );
}
