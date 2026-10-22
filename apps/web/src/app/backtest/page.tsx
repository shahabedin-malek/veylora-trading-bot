import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { BacktestPanel } from "@/components/backtest-panel";

export const instant = false;

export default function BacktestPage() {
  return (
    <TerminalShell active="backtest" section="BACKTEST">
      <section className="page-heading" aria-labelledby="backtest-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            STRATEGY LAB <span className="eyebrow-separator">/</span> NATURAL LANGUAGE, COSTED ANALYSIS
          </div>
          <h1 id="backtest-page-title"><DepthText text="Backtester" /></h1>
          <p>
            Describe a strategy in plain English and get rules you can read, edit and version. Every run applies the fee,
            spread, slippage and funding assumptions from /admin/fees and prints them with the result. Historical
            analysis only — no order is placed and no result is a promise.
          </p>
        </div>
        <span className="section-state">ANALYSIS ONLY</span>
      </section>
      <BacktestPanel />
    </TerminalShell>
  );
}
