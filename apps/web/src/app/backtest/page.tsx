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
            STRATEGY LAB <span className="eyebrow-separator">/</span> HISTORICAL ANALYSIS
          </div>
          <h1 id="backtest-page-title"><DepthText text="Backtester" /></h1>
          <p>Real Coinbase history, full-period accounting, and explicit cost assumptions. Results are not orders or guarantees.</p>
        </div>
        <span className="section-state">ANALYSIS ONLY</span>
      </section>
      <BacktestPanel />
    </TerminalShell>
  );
}