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
          <p>A tool-using assistant for public market data. Order placement and fund movement stay in the app&apos;s authenticated routes.</p>
        </div>
        <span className="section-state">TOOL-ENABLED</span>
      </section>
      <MarketAssistant />
    </TerminalShell>
  );
}
