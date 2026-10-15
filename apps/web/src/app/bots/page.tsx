import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { BotBuilderPanel } from "@/components/bot-builder-panel";

export const instant = false;

export default function BotsPage() {
  return (
    <TerminalShell active="bots" section="BOT BUILDER">
      <section className="page-heading" aria-labelledby="bots-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow"><span className="eyebrow-line" aria-hidden="true" />STRATEGY LAB <span className="eyebrow-separator">/</span> NO-CODE BUILDER</div>
          <h1 id="bots-page-title"><DepthText text="Bot builder" /></h1>
          <p>Configure, backtest, and monitor paper RSI strategies at Coinbase public prices. Paper accounting runs server-side; nothing on this page places a live order.</p>
        </div>
        <span className="section-state">PAPER ONLY</span>
      </section>
      <BotBuilderPanel />
    </TerminalShell>
  );
}