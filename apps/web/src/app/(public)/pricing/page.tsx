import { connection } from "next/server";
import { DepthText } from "@/components/depth-text";
import { isZeroAmount } from "@/lib/fees/amounts";
import { pricingRows, readEffectiveFeeSchedule, type EffectiveFeeSchedule } from "@/lib/fees/table";
import { readWithdrawalPolicy } from "@/lib/withdrawals/policy";

/**
 * The one page that describes what this deployment charges.
 *
 * **It renders from the table, not from a copy of it.** Every withdrawal row comes from
 * {@link pricingRows}, which asks the same `withdrawalFeeFor`/`networkCostFor` the
 * withdrawal request uses; the percentage and the tiers are read from the same version.
 * So a save on `/admin/fees` changes this page with no second edit, and there is no
 * number here that the code does not charge.
 *
 * Three things the page refuses to do:
 *
 *  - **Publish a price it could not read.** If the table is unreachable, the page says
 *    so and prints no figures — falling back to the deployment's environment fee values
 *    would be publishing yesterday's price as today's.
 *  - **Render zero as a blank.** A zero fee prints as `no fee`, which is a price.
 *  - **Hide the network cost.** It is shown beside each asset and marked as paid by the
 *    platform, because a page that showed only the platform fee would understate what a
 *    transfer costs and a page that folded it into the fee would overcharge.
 *
 * This is a public page: it needs no session and reads only configuration.
 */

export const metadata = { title: "Pricing — Veylora" };

// A price list is read at request time from the stored table, so there is nothing to
// prerender: a statically generated pricing page would be a price frozen at build time.
export const instant = false;

function uniqueAssets(policy: ReturnType<typeof readWithdrawalPolicy>): { assets: string[]; decimals: Record<string, number> } {
  const decimals: Record<string, number> = {};
  for (const network of policy.networks) {
    if (decimals[network.token.symbol] === undefined) decimals[network.token.symbol] = network.token.decimals;
  }
  return { assets: Object.keys(decimals), decimals };
}

async function PricingContent() {
  await connection();
  const policy = readWithdrawalPolicy();
  const { assets, decimals } = uniqueAssets(policy);

  let schedule: EffectiveFeeSchedule | null = null;
  let failure: string | null = null;
  try {
    schedule = await readEffectiveFeeSchedule();
  } catch {
    failure = "The fee table could not be read, so this page states no price rather than an old one.";
  }

  const rows = schedule ? pricingRows(schedule, { assets, decimals }) : [];
  const performanceFee = schedule?.performanceFeePercent ?? null;
  const performanceLabel = performanceFee === null ? null : isZeroAmount(performanceFee) ? "no fee" : `${performanceFee}%`;
  const tiers = schedule?.tiers ?? [];

  return (
    <section aria-labelledby="pricing-title">
      <section className="page-heading">
        <div className="page-heading__copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            PRICING <span className="eyebrow-separator">/</span> THE SAME TABLE THE CODE CHARGES
          </div>
          <h1 id="pricing-title"><DepthText text="Pricing" /></h1>
          <p>
            One table decides every figure on this page. The withdrawal path reads it when it prices a
            request, so a price here is a price the code charges — and a change saved on the admin page
            changes this page with nothing else to edit.
          </p>
        </div>
        {schedule && <span className="section-state">{schedule.source === "owner-schedule" ? "OWNER-SET TABLE" : "FREE DEFAULTS"}</span>}
      </section>

      {failure && (
        <section className="data-section" role="status">
          <p className="policy-disclaimer">{failure}</p>
        </section>
      )}

      {schedule && (
        <>
          <section className="data-section" aria-labelledby="pricing-withdrawals-title">
            <div className="section-heading">
              <div>
                <div className="section-kicker">01 / WITHDRAWALS</div>
                <h2 id="pricing-withdrawals-title">What a withdrawal costs</h2>
              </div>
              <span className="section-state">DEDUCTED BEFORE THE WALLET RECEIVES</span>
            </div>
            {rows.length === 0 ? (
              <p className="policy-disclaimer" role="status">
                No withdrawal route is configured in this deployment, so there is no asset to price.
              </p>
            ) : (
              <div className="public-table-wrap">
                <table className="public-table">
                  <thead>
                    <tr>
                      <th scope="col">Asset</th>
                      <th scope="col">Platform fee</th>
                      <th scope="col">Network cost</th>
                      <th scope="col">Arrives from 1.00</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.asset}>
                        <td>{row.asset}</td>
                        <td>{row.feeLabel}</td>
                        <td>
                          {row.networkCostLabel}
                          <small className="fee-table-note"> paid by the platform</small>
                        </td>
                        <td>
                          {row.example
                            ? `${row.example.arriving} ${row.asset}`
                            : `not chargeable at one unit: ${row.feeLabel}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="policy-disclaimer">
              The platform fee is deducted from the amount you authorise. The network cost is what the chain
              charges to send it; it is paid by the platform and never deducted from your amount. There is no
              separate deposit fee, and no subscription.
            </p>
          </section>

          <section className="data-section" aria-labelledby="pricing-performance-title">
            <div className="section-heading">
              <div>
                <div className="section-kicker">02 / STRATEGY RESULTS</div>
                <h2 id="pricing-performance-title">Performance fee</h2>
              </div>
              <span className="section-state">PROFIT ONLY</span>
            </div>
            <p>
              <strong>{performanceLabel === "no fee" ? "No fee." : `${performanceFee}% of a profitable result.`}</strong>{" "}
              A losing or flat result pays nothing, whatever the percentage is. The fee is posted to the ledger
              as its own entry against the platform&apos;s fee account, so it is traceable to the result that
              earned it and reversible. Paper and backtest results are never charged: a fee is posted only
              against a live strategy result, and the runner that produces one is phase 24.
            </p>
          </section>

          <section className="data-section" aria-labelledby="pricing-tiers-title">
            <div className="section-heading">
              <div>
                <div className="section-kicker">03 / ACCOUNT LIMITS</div>
                <h2 id="pricing-tiers-title">Tiers</h2>
              </div>
              <span className="section-state">ONE TABLE</span>
            </div>
            <div className="public-table-wrap">
              <table className="public-table">
                <thead>
                  <tr>
                    <th scope="col">Tier</th>
                    <th scope="col">Bots</th>
                    <th scope="col">Venue connections</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier) => (
                    <tr key={tier.key}>
                      <td>
                        {tier.label} <small className="fee-table-note">{tier.key}</small>
                        {tier.isDefault && <small className="fee-table-note"> · default</small>}
                      </td>
                      <td>{tier.maxBots}</td>
                      <td>{tier.maxVenueConnections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="policy-disclaimer">
              Venue-connection caps are enforced by the credential path today. Bot caps are stored here and are
              enforced by the bot builder when it ships (phase 30). Tiers are not a subscription: there is no
              card payment or recurring billing in this build.
            </p>
          </section>

          <p className="policy-disclaimer">
            Source: {schedule.source === "owner-schedule"
              ? `the stored fee table, version effective ${new Date(schedule.effectiveFrom).toLocaleString()}`
              : "this deployment's free defaults (no fee table version is stored)"}. Read at{" "}
            {new Date().toLocaleString()}.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Public page (phase 40): it sits in the `(public)` group, so the URL is still `/pricing` and the
 * chrome is the public shell. The figures are the same ones the withdrawal path charges.
 */
export default function PricingPage() {
  return <PricingContent />;
}
