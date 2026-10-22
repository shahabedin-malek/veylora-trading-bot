import { NextRequest } from "next/server";
import { getAccessRefusal } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { describeTestnetComparison, orderVenueSummary } from "@/lib/venues/registry";

/**
 * `GET /api/trading/orders/comparison?market=BTC-USD` — the dry comparison, as a report.
 *
 * Phase 22 asks for the same order evaluated against the testnet configuration, displayed
 * to the owner, and explicitly *not* inserted into the live path. So it lives on its own
 * read route: the live submission never calls it, it decrypts nothing, it contacts no
 * exchange and it places nothing. It answers what the testnet would have been asked, which
 * key would have backed it and whether that key exists — the three facts that make a live
 * order's routing legible.
 *
 * A read of private account state, so it is `no-store` and requires the signed-in user.
 */

const MARKET_PATTERN = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, refusal.status) : null;
}

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Session is unavailable." }, 503);
  }

  const market = (new URL(request.url).searchParams.get("market") ?? "").trim().toUpperCase();
  if (!MARKET_PATTERN.test(market)) {
    return json({ error: "market must be an uppercase BASE-QUOTE product id, for example BTC-USD." }, 400);
  }

  try {
    const [report, venue] = await Promise.all([
      describeTestnetComparison(user.id, market),
      orderVenueSummary(),
    ]);
    return json({
      report,
      venue: {
        environment: venue.environment,
        venueId: venue.venueId,
        label: venue.label,
        testnetRoutingEnabled: venue.testnetRoutingEnabled,
        liveExecutionEnabled: venue.liveExecutionEnabled,
        available: venue.available,
        detail: venue.detail,
      },
      /**
       * Said in words rather than implied: this answer is a comparison, and the order the
       * owner is looking at was not affected by it.
       */
      note: "A comparison only: nothing was decrypted, no venue was contacted and no order was placed.",
    });
  } catch {
    return json({ error: "The comparison could not be built." }, 503);
  }
}
