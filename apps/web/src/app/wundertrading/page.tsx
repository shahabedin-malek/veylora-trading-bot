import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { TradingAccounts } from "@/components/trading-accounts";
import { DepthText } from "@/components/depth-text";
import { TerminalShell } from "@/components/terminal-shell";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { getWunderTradingFeatureSettings } from "@/lib/wundertrading/settings";
import { WunderTradingDesk } from "./wundertrading-desk";

async function WunderTradingContent() {
  await connection();
  try {
    await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login");
    notFound();
  }

  const settings = await getWunderTradingFeatureSettings().catch(() => null);
  return (
    <TerminalShell active="wundertrading" section="WUNDERTRADING">
      <section className="page-heading" aria-labelledby="wundertrading-title">
        <div className="page-heading__copy">
          <div className="eyebrow"><span className="eyebrow-line" aria-hidden="true" />ACCOUNT / EXCHANGE TOOLS</div>
          <h1 id="wundertrading-title"><DepthText text="WunderTrading" /></h1>
          <p>Read your connected profiles, live strategies, and recent strategy history. Keys are user-owned and encrypted, and Veylora calls only WunderTrading’s read endpoints.</p>
        </div>
        <span className="section-state">NO ORDER ROUTE</span>
      </section>

      <section className="data-section" aria-labelledby="wundertrading-account-title">
        <div className="section-heading">
          <div><div className="section-kicker">01 / YOUR KEY</div><h2 id="wundertrading-account-title">Connect WunderTrading</h2></div>
          <span className="section-state">ENCRYPTED</span>
        </div>
        <TradingAccounts allowedVenues={["wundertrading"]} />
      </section>

      <section className="data-section" aria-labelledby="wundertrading-data-title">
        <div className="section-heading">
          <div><div className="section-kicker">02 / PRIVATE READS</div><h2 id="wundertrading-data-title">Account data</h2></div>
          <span className="section-state">ADMIN-CONTROLLED</span>
        </div>
        <WunderTradingDesk settings={settings} />
      </section>

      <p className="chaingpt-disclosure">Veylora uses WunderTrading’s documented REST API for API-profile and strategy reads. Each switch in Access &amp; Integrations turns one read on or off; none of them can place an order, and the keys you connect stay encrypted at rest.</p>
    </TerminalShell>
  );
}

export default function WunderTradingPage() {
  return (
    <Suspense fallback={<div className="market-chart-empty" role="status"><strong>Checking account access</strong></div>}>
      <WunderTradingContent />
    </Suspense>
  );
}