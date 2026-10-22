import { getTradingStatus } from "@/lib/trading/status";

/**
 * `GET /api/trading/status` — what trading can actually do right now.
 *
 * Phase 21 moved the venue half of this answer out of a module-level singleton and into the
 * registry; phase 22 added the third answer. `trading.status` is `PAPER ORDERS`,
 * `TESTNET ORDERS` or `LIVE ORDERS`, `trading.venue` names the venue and says whether the
 * routing settings could be read (`available`), and `liveExecutionEnabled` is the owner's
 * switch as it stands in /admin/risk — read per request, never cached, so a page cannot show
 * yesterday's venue or yesterday's switch.
 */

export async function GET() {
  return Response.json(await getTradingStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}