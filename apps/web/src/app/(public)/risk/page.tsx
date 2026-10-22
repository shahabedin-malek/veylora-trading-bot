import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_REVIEWED_ON, OPERATOR_NAME } from "@/lib/public/site";

/**
 * Risk disclosure.
 *
 * Each section names a risk the code has a control for, and says what the control does *not* do.
 * That pairing is the point: a disclosure that only says "trading is risky" tells a reader nothing
 * they did not know, while "the runner can place orders while your browser is closed, and the
 * kill switch is a switch you have to press" is a fact they can act on.
 */

export const metadata: Metadata = {
  title: "Risk disclosure",
  description: "Market, venue, network, custody, automation and key risk in this trading console.",
};

export default function RiskPage() {
  return (
    <article className="public-prose">
      <p className="eyebrow">LEGAL <span className="eyebrow-separator">/</span> RISK DISCLOSURE</p>
      <h1>Risk disclosure</h1>
      <p className="public-meta">
        <span>{OPERATOR_NAME}</span>
        <span>Reviewed {LEGAL_REVIEWED_ON}</span>
      </p>

      <p>
        You can lose money here, including all of it. Nothing in this console — a price, a strategy, a
        backtest, an assistant answer — is advice, and no result you see is a forecast. What follows is
        what can go wrong, and what the deployment does and does not do about each case.
      </p>

      <h2>Market risk</h2>
      <p>
        Crypto prices move quickly and can gap through any level. An order can fill far from the price
        you watched, a stop can be skipped, and a market that looked liquid can stop being liquid. The
        console shows quotes with their provider and the time they were read precisely so a stale
        price is not mistaken for a live one; it cannot make the market behave.
      </p>

      <h2>Venue risk</h2>
      <p>
        Orders are executed by a venue, not by this console. A venue can be down, reject an order,
        delay it, change its rules, or fail entirely. A rejected or failed order keeps the venue&apos;s
        own reason on its row — and an order recorded as failed has not moved any money. Funds held at
        a venue are exposed to that venue&apos;s solvency, which the operator does not control and does
        not insure.
      </p>

      <h2>Automation risk</h2>
      <p>
        A strategy you start keeps running while your browser is closed, and it places orders on its
        own schedule. The deployment bounds that: per-order and daily caps, an allowed-venue list, and
        two kill switches — a global one and one per strategy — are admin data the operator sets and
        can press. A kill switch stops new orders; it does not cancel an order the venue already
        accepted, and it cannot undo a fill. Paper and testnet results say nothing about how a
        strategy will behave with real money.
      </p>

      <h2>Network and smart-contract risk</h2>
      <p>
        Deposits and withdrawals move on public blockchains. A transfer can be delayed by congestion,
        cost more than expected when fees spike, or be reorganised after it appeared confirmed. A
        token contract can be malicious or upgradeable, which is why tokens outside the operator&apos;s
        allow-list are marked rather than treated as holdings. On-chain transfers are irreversible:
        an address typed wrongly cannot be recalled.
      </p>

      <h2>Custody risk</h2>
      <p>
        Balances here are entries in this deployment&apos;s own ledger. They are not bank deposits, they
        are not insured, and they are not held in a segregated account at a bank or broker. The ledger
        is the record of what you are owed by the operator, and its invariants — every movement
        balanced, no overdrawn holder without a credit line — are checked continuously and reported on
        the status page. A ledger that balances is not a promise that the operator can pay; the
        operator&apos;s solvency is the risk behind the entry, and it is not insured against.
      </p>

      <h2>Key and account risk</h2>
      <p>
        Your wallet signature is the credential. There is no password reset: lose the wallet and you
        lose access, with no recovery path. A compromised device can act as you until its session is
        revoked, which is why sessions can be ended per device, two-factor scopes can be required for
        money actions, and API keys can be revoked. A venue key you connect carries whatever
        permissions it has at that venue; the operator recommends read-only where the venue allows it,
        and a trade-capable key can trade.
      </p>

      <h2>Operational and legal risk</h2>
      <p>
        The service can be unavailable, changed or withdrawn. Fees can change, and the table on{" "}
        <Link href="/pricing">the pricing page</Link> is the current one. Rules where you live may
        restrict or prohibit what you are doing, and that is your responsibility. The operator has not
        registered an entity and these pages name no jurisdiction, which is stated on the{" "}
        <Link href="/terms">terms page</Link> rather than papered over.
      </p>

      <p className="policy-disclaimer">
        If any of this is unclear, do not deposit. The <Link href="/faq">FAQ</Link> answers the
        practical questions, and <Link href="/status">status</Link> shows what the deployment is
        reporting right now.
      </p>
    </article>
  );
}
