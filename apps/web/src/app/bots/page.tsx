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
          <p>Configure, backtest, and monitor paper RSI strategies at Coinbase public prices. Live execution remains disabled.</p>
        </div>
        <span className="section-state">NO LIVE EXECUTION</span>
      </section>
      <BotBuilderPanel />
    </TerminalShell>
  );
}