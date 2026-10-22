import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { DepthText } from "@/components/depth-text";
import { isZeroAmount } from "@/lib/fees/amounts";
import { readEffectiveFeeSchedule } from "@/lib/fees/table";
import { getNetworkRegistry } from "@/lib/rpc/networks";
import { getTradingStatus } from "@/lib/trading/status";
import {
  CONSOLE_HREF,
  NOT_STATEMENTS,
  PRODUCT_SUMMARY,
  SIGN_IN_HREF,
} from "@/lib/public/site";

/**
 * The landing page.
 *
 * Three rules, and they are why it is a server component that reads the product rather than a
 * page of copy:
 *
 *  - **Nothing it says about the product is hand-typed.** The trading mode comes from
 *    `getTradingStatus`, the network count from the registry the RPC proxy actually uses, and the
 *    fee line from the same table the withdrawal path prices with. Change the switch or the table
 *    and this page changes with it.
 *  - **A read that fails prints a sentence, never a number.** If the fee table cannot be read the
 *    page says so instead of quoting yesterday's price.
 *  - **The negative claims are stated here, not only in the legal footer.** A visitor should know
 *    what this is not before signing anything.
 */

export const metadata: Metadata = {
  title: "Veylora — trading console for crypto markets",
  description:
    "Wallet sign-in, a ledger of record, venue orders and readable risk controls. Not a broker, exchange, adviser or insured custodian.",
};

export const instant = false;

type LandingState = {
  mode: string;
  venue: string;
  venueAvailable: boolean;
  networks: { configured: number; available: number } | null;
  performanceFee: string | null;
  withdrawalLine: string | null;
};

async function readLandingState(): Promise<LandingState> {
  await connection();

  let mode = "Readiness unavailable";
  let venue = "the deployment is not reporting a venue";
  let venueAvailable = false;
  try {
    const { trading } = await getTradingStatus();
    mode = trading.status;
    venue = `${trading.venue.label} · ${trading.venue.environment}`;
    venueAvailable = trading.venue.available;
  } catch {
    // A database that cannot be read is reported as unavailable rather than guessed at.
  }

  let networks: LandingState["networks"] = null;
  try {
    const registry = getNetworkRegistry();
    networks = { configured: registry.totals.discovered, available: registry.totals.available };
  } catch {
    networks = null;
  }

  let performanceFee: string | null = null;
  let withdrawalLine: string | null = null;
  try {
    const schedule = await readEffectiveFeeSchedule();
    performanceFee = isZeroAmount(schedule.performanceFeePercent)
      ? "no performance fee"
      : `${schedule.performanceFeePercent}% of a profitable result`;
    const priced = Object.keys(schedule.withdrawalFees).length;
    withdrawalLine =
      priced === 0
        ? "no withdrawal asset is priced in this deployment, so there is nothing to quote"
        : `withdrawals priced for ${priced} asset${priced === 1 ? "" : "s"} from the table the code charges`;
  } catch {
    performanceFee = null;
    withdrawalLine = "the fee table could not be read, so no price is quoted here";
  }

  return { mode, venue, venueAvailable, networks, performanceFee, withdrawalLine };
}

export default async function LandingPage() {
  const state = await readLandingState();

  return (
    <>
      <section className="public-hero" aria-labelledby="landing-title">
        <div className="public-hero__copy">
          <p className="eyebrow">TRADING CONSOLE <span className="eyebrow-separator">/</span> ONE LEDGER OF RECORD</p>
          <h1 id="landing-title">
            <DepthText text="Trade with the receipts attached." />
          </h1>
          <p className="public-lede">{PRODUCT_SUMMARY}</p>
          <div className="public-hero__actions">
            <Link className="public-button" href={SIGN_IN_HREF}>
              Sign in with a wallet
            </Link>
            <Link className="public-link-quiet" href="/pricing">
              See what it costs
            </Link>
          </div>
        </div>

        <dl className="public-live" aria-label="What this deployment reports right now">
          <div>
            <dt>Trading mode</dt>
            <dd>{state.mode}</dd>
            <small>{state.venueAvailable ? state.venue : `${state.venue} · not available`}</small>
          </div>
          <div>
            <dt>Networks configured</dt>
            <dd>{state.networks ? state.networks.configured : "Unavailable"}</dd>
            <small>
              {state.networks
                ? `${state.networks.available} usable with the endpoints this deployment holds`
                : "the network registry could not be read"}
            </small>
          </div>
          <div>
            <dt>Strategy fee</dt>
            <dd>{state.performanceFee ?? "Not quoted"}</dd>
            <small>{state.withdrawalLine ?? "the fee table could not be read"}</small>
          </div>
        </dl>
      </section>

      <section className="public-grid" aria-label="What you can do here">
        <article className="public-card">
          <p className="section-kicker">01 / MARKETS</p>
          <h2>Prices with a provider and a time</h2>
          <p>
            Quotes and candles are labelled with where they came from and when they were read. A stale
            figure says it is stale instead of looking live.
          </p>
          <Link href="/docs">How the surfaces fit together</Link>
        </article>
        <article className="public-card">
          <p className="section-kicker">02 / ORDERS</p>
          <h2>Paper first, then the venue you connected</h2>
          <p>
            Every order is a row with a status, an idempotency key and its attempts beside it. Real-money
            execution is reachable only through the owner&apos;s switch, and the current mode is on the
            landing page above.
          </p>
          <Link href={CONSOLE_HREF}>Open the console</Link>
        </article>
        <article className="public-card">
          <p className="section-kicker">03 / MONEY</p>
          <h2>One ledger writes every balance</h2>
          <p>
            A balance is the sum of entries, not a column someone can overwrite. Withdrawals reserve inside the
            same transaction and price from the table on the pricing page.
          </p>
          <Link href="/pricing">Pricing</Link>
        </article>
      </section>

      <section className="public-not" aria-labelledby="landing-not-title">
        <h2 id="landing-not-title">What this is not</h2>
        <ul>
          {NOT_STATEMENTS.map((statement) => (
            <li key={statement}>{statement}</li>
          ))}
        </ul>
        <p className="policy-disclaimer">
          Read the <Link href="/risk">risk disclosure</Link> and the <Link href="/terms">terms</Link> before
          depositing anything. The <Link href="/status">status page</Link> shows what the deployment is
          reporting at this moment.
        </p>
      </section>
    </>
  );
}
