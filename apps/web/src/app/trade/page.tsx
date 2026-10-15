import { ArrowLeftRight, ShieldCheck } from "lucide-react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { TerminalShell } from "@/components/terminal-shell";
import { TradingAccounts } from "@/components/trading-accounts";
import { getCurrentUser } from "@/lib/auth/session-store";

export const instant = false;

export default async function TradePage() {
  await connection();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <TerminalShell active="trade" section="TRADE">
      <section className="page-heading" aria-labelledby="trade-page-title">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            ACCOUNT ACCESS <span className="eyebrow-separator">/</span> SPOT
          </div>
          <h1 id="trade-page-title">Trading accounts</h1>
          <p>Connect your own exchange accounts and verify balances. Each key is encrypted at rest, scoped to your signed-in account, and never returned to the browser after saving.</p>
        </div>
      </section>

      <section className="data-section trading-accounts-section" aria-labelledby="account-connections-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / EXCHANGE ACCESS</div>
            <h2 id="account-connections-title">Your connected accounts</h2>
          </div>
          <span className="section-state">BALANCE READS ONLY</span>
        </div>
        <p className="trading-security-note">Supported now: Coinbase Advanced, Kraken, and Binance. Other exchanges require a reviewed connector before keys can be added. Use keys with read-only permissions; withdrawals and trading permissions must remain disabled.</p>
        <TradingAccounts />
      </section>

      <section className="data-section trading-orders-state" aria-labelledby="order-state-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / EXECUTION</div>
            <h2 id="order-state-title">Live orders</h2>
          </div>
          <span className="section-state">NOT AVAILABLE</span>
        </div>
        <div className="trading-orders-state__body">
          <ArrowLeftRight aria-hidden="true" size={18} />
          <div>
            <strong>Order placement is not available in this build.</strong>
            <p><ShieldCheck aria-hidden="true" size={13} /> Accounts can be verified, but this page does not submit trades or withdrawals.</p>
          </div>
        </div>
      </section>
    </TerminalShell>
  );
}