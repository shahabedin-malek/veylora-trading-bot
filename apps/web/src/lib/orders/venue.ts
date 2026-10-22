import DecimalJS from "decimal.js";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import type { MarketQuote } from "@/lib/market-data/provider";
import { isDevelopmentMode } from "@/lib/dev-mode/mode";
import type { StoredOrder } from "@/lib/orders/store";

/**
 * The port every venue is reached through, and the paper venue that backs it in
 * development.
 *
 * The state machine never talks to a venue. It decides what is legal and what to
 * record; a venue port answers "what did the venue say?". That split is what
 * makes the lifecycle testable without a network and what lets a real venue
 * (phase 21: Kraken, Coinbase Advanced, Binance) be dropped in behind the same
 * four answers:
 *
 *  - **accepted** — the venue took the order; here is its id and what it has
 *    executed so far.
 *  - **rejected** — the venue refused it, in its own words. A definitive answer.
 *  - **timeout** — no answer arrived. **Not** the same as a rejection: the venue
 *    may hold the order, so the caller must look it up rather than assume, which
 *    is what `process.ts` does.
 *  - **unavailable** — the venue could not be reached at all, so nothing was
 *    accepted.
 *
 * The paper venue below is a simulation and says so: it moves no money, talks to
 * no exchange, and answers `lookup` from wall-clock time and (for a limit order)
 * the real public quote, so an order genuinely can sit open. Its failure modes
 * are selectable in development so the failure paths can be exercised by hand
 * instead of only in a test.
 */

export type VenueSubmitOutcome =
  | {
      kind: "accepted";
      venueOrderId: string;
      /** What the venue has executed right away. Most venues answer "open". */
      reported: VenueOrderState;
      filledQuantity: string;
      providerResponse: unknown;
    }
  | { kind: "rejected"; code: string; reason: string; providerResponse: unknown }
  | { kind: "timeout"; reason: string; providerResponse?: unknown }
  | { kind: "unavailable"; reason: string; providerResponse?: unknown };

/** The venue's own vocabulary, mapped onto the lifecycle by `reconcile.ts`. */
export type VenueOrderState = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED" | "NOT_FOUND" | "UNKNOWN";

export type VenueOrderReport = {
  state: VenueOrderState;
  venueOrderId?: string;
  /** The cumulative executed quantity the venue reports. */
  filledQuantity?: string;
  reason?: string;
  reportedAt: string;
  providerResponse?: unknown;
};

export type VenueCancelOutcome =
  | { kind: "cancelled"; report: VenueOrderReport }
  | { kind: "refused"; reason: string; report?: VenueOrderReport }
  | { kind: "timeout"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * What is behind the port: a simulation, a sandbox, or the real exchange.
 *
 * `paper` says "no money can move"; that is true of a testnet too, and a single
 * boolean therefore cannot tell the owner whether their order went to Binance's
 * testnet or nowhere at all. Phase 21 split the two: `environment` is what a surface
 * reports, and `paper` stays as the narrower claim it always made.
 */
export type VenueEnvironment = "paper" | "testnet" | "live";

export type OrderVenuePort = {
  id: string;
  /** True when this venue moves no real money, so the UI can say so. */
  paper: boolean;
  environment: VenueEnvironment;
  /**
   * Send an order. The idempotency key is required, never optional: it is what
   * makes a repeated submission resolve to the same venue order.
   */
  submit(input: { order: StoredOrder; idempotencyKey: string; attempt: number }): Promise<VenueSubmitOutcome>;
  /**
   * The asset this venue settles a market's quote in, when that differs from the site's
   * USD product id. Binance quotes `BTC/USDT`, so a pre-trade balance check has to ask it
   * for USDT rather than USD; a venue that settles in the quoted asset omits this.
   */
  quoteAssetFor?(market: string): string | null;
  /** The venue's own record. This is the only thing reconciliation trusts. */
  lookup(input: { order: StoredOrder }): Promise<VenueOrderReport>;
  cancel(input: { order: StoredOrder; reason: string }): Promise<VenueCancelOutcome>;
};

const Decimal = DecimalJS.clone({ precision: 40 });

/**
 * Selectable paper-venue behaviour, development only:
 * `PAPER_VENUE_FAILURE=unavailable|timeout|rejected` makes the next submission
 * take that path (a hand-run way to see an order fail with the venue's reason),
 * and `PAPER_VENUE_FILL_DELAY_SECONDS` sets how long a market order takes to
 * fill (default 5 seconds, two steps of half each).
 */
export type PaperVenueFailure = "none" | "unavailable" | "timeout" | "rejected";

export function paperVenueFailure(env: NodeJS.ProcessEnv = process.env): PaperVenueFailure {
  if (!isDevelopmentMode(env)) return "none";
  const configured = env.PAPER_VENUE_FAILURE?.trim().toLowerCase();
  return configured === "unavailable" || configured === "timeout" || configured === "rejected" ? configured : "none";
}

export function paperFillDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.PAPER_VENUE_FILL_DELAY_SECONDS?.trim());
  const seconds = Number.isFinite(configured) && configured >= 0 ? configured : 5;
  return Math.round(seconds * 1_000);
}

export const PAPER_VENUE_ID = "dev-paper";

/** The venue order id a paper order gets: derived from the key, so a retry maps to the same order. */
export function paperVenueOrderId(idempotencyKey: string): string {
  return `paper-${idempotencyKey.slice(0, 24)}`;
}

export type PaperVenueDeps = {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** The public quote reader, injected so a test needs no network. */
  quotes?: (market: string) => Promise<{ price: string | null; reason?: string }>;
  delayMs?: number;
};

async function readQuote(market: string): Promise<{ price: string | null; reason?: string }> {
  try {
    const quotes = await coinbaseMarketData.getQuotes({ instruments: [market] });
    if (quotes.status === "available") {
      const quote: MarketQuote | undefined = quotes.data.find((candidate) => candidate.instrument.symbol === market);
      const price = quote?.last ?? quote?.ask ?? quote?.bid ?? null;
      return price ? { price } : { price: null, reason: `The quote for ${market} carried no price.` };
    }
    return { price: null, reason: `The public quote feed answered ${quotes.reason}.` };
  } catch (error) {
    return { price: null, reason: error instanceof Error ? error.message : "The public quote feed could not be reached." };
  }
}

/**
 * The paper venue.
 *
 * Its rules are deliberately simple enough to state in one breath, because a
 * simulation nobody can explain is worse than none:
 *
 *  1. A submission is accepted and gets a venue order id derived from the
 *     idempotency key — so re-sending the same intent resolves to the same order
 *     rather than a second one.
 *  2. A **market** order executes in two steps of half the quantity, one fill
 *     delay apart, measured from `submittedAt`. After two delays it is complete.
 *  3. A **limit** order only starts executing when the real public quote is at or
 *     through its limit price, and then follows the same two-step schedule; if
 *     the quote never crosses, it stays open — which is what a limit order does.
 *  4. A quote it cannot read is reported as `UNKNOWN` with the reason, never as a
 *     fill: reconciliation leaves an unknown alone and says why.
 *  5. Nothing here is a real order and no funds move; `paper: true` says so to
 *     every caller.
 */
export function createPaperVenue(deps: PaperVenueDeps = {}): OrderVenuePort {
  const clock = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const delayMs = deps.delayMs ?? paperFillDelayMs(env);
  const quotes = deps.quotes ?? readQuote;

  function execution(input: { order: StoredOrder; elapsedMs: number; qualified: boolean }): { state: VenueOrderState; filled: DecimalJS; reason?: string } {
    const requested = new Decimal(input.order.requestedQuantity);
    if (!input.qualified) {
      return { state: "OPEN", filled: new Decimal(0) };
    }
    if (input.elapsedMs >= delayMs * 2) return { state: "FILLED", filled: requested };
    if (input.elapsedMs >= delayMs) return { state: "PARTIALLY_FILLED", filled: requested.div(2).toDecimalPlaces(12) };
    return { state: "OPEN", filled: new Decimal(0) };
  }

  return {
    id: PAPER_VENUE_ID,
    paper: true,
    environment: "paper",

    async submit({ order, idempotencyKey, attempt }) {
      const failure = paperVenueFailure(env);
      const venueOrderId = paperVenueOrderId(idempotencyKey);
      if (failure === "unavailable") {
        return {
          kind: "unavailable",
          reason: `The paper venue is set to refuse connections (PAPER_VENUE_FAILURE=unavailable), so attempt ${attempt} reached nothing.`,
          providerResponse: { simulated: "unavailable", attempt },
        };
      }
      if (failure === "timeout") {
        return {
          kind: "timeout",
          reason: `The paper venue is set to time out (PAPER_VENUE_FAILURE=timeout), so attempt ${attempt} got no answer.`,
          providerResponse: { simulated: "timeout", attempt },
        };
      }
      if (failure === "rejected") {
        return {
          kind: "rejected",
          code: "PAPER_REFUSED",
          reason: "The paper venue is set to refuse orders (PAPER_VENUE_FAILURE=rejected).",
          providerResponse: { simulated: "rejected", attempt },
        };
      }

      if (order.orderType === "LIMIT") {
        const quote = await quotes(order.market);
        if (quote.price === null) {
          return {
            kind: "rejected",
            code: "NO_QUOTE",
            reason: quote.reason ?? `No public quote is available for ${order.market}, so the limit order was not accepted.`,
            providerResponse: { paper: true, quote: quote.price },
          };
        }
        const limit = new Decimal(order.limitPrice ?? "0");
        const price = new Decimal(quote.price);
        const qualifies = order.side === "BUY" ? price.lte(limit) : price.gte(limit);
        if (!qualifies) {
          return {
            kind: "accepted",
            venueOrderId,
            reported: "OPEN",
            filledQuantity: "0",
            providerResponse: { paper: true, accepted: true, quote: quote.price, limit: limit.toString(), qualifies },
          };
        }
      }

      return {
        kind: "accepted",
        venueOrderId,
        reported: "OPEN",
        filledQuantity: "0",
        providerResponse: { paper: true, accepted: true, attempt },
      };
    },

    async lookup({ order }) {
      const reportedAt = clock().toISOString();
      const venueOrderId = order.venueOrderId ?? paperVenueOrderId(order.idempotencyKey ?? order.clientOrderId);
      const submittedAt = order.submittedAt ? Date.parse(order.submittedAt) : null;
      if (submittedAt === null) {
        return { state: "UNKNOWN", venueOrderId, reason: "The order has no submission time, so the paper venue has no schedule to answer from.", reportedAt };
      }
      const elapsedMs = clock().getTime() - submittedAt;

      let qualified = true;
      if (order.orderType === "LIMIT") {
        const quote = await quotes(order.market);
        if (quote.price === null) {
          return {
            state: "UNKNOWN",
            venueOrderId,
            reason: quote.reason ?? `No public quote is available for ${order.market}.`,
            reportedAt,
          };
        }
        const limit = new Decimal(order.limitPrice ?? "0");
        const price = new Decimal(quote.price);
        qualified = order.side === "BUY" ? price.lte(limit) : price.gte(limit);
        if (!qualified) {
          return {
            state: "OPEN",
            venueOrderId,
            filledQuantity: "0",
            reason: `The ${order.market} quote (${price.toString()}) has not reached the ${limit.toString()} limit.`,
            reportedAt,
          };
        }
      }

      const executed = execution({ order, elapsedMs, qualified });
      return {
        state: executed.state,
        venueOrderId,
        filledQuantity: executed.filled.toFixed(),
        reason:
          executed.state === "OPEN"
            ? `The paper venue has executed nothing yet (${Math.max(0, Math.round(elapsedMs))}ms elapsed of a ${delayMs}ms step).`
            : executed.state === "PARTIALLY_FILLED"
              ? "The paper venue has executed half the order so far."
              : "The paper venue reports the order complete.",
        reportedAt,
        providerResponse: { paper: true, elapsedMs, delayMs },
      };
    },

    async cancel({ order, reason }) {
      const report = await this.lookup({ order });
      if (report.state === "FILLED") {
        return { kind: "refused", reason: "The paper venue reports the order already filled, so it cannot be cancelled.", report };
      }
      return {
        kind: "cancelled",
        report: {
          state: "CANCELLED",
          ...(report.venueOrderId ? { venueOrderId: report.venueOrderId } : {}),
          filledQuantity: report.filledQuantity ?? "0",
          reason,
          reportedAt: clock().toISOString(),
          providerResponse: { paper: true, cancelled: true },
        },
      };
    },
  };
}

let sharedVenue: OrderVenuePort | null = null;

/**
 * The development paper venue, as a process-wide default.
 *
 * Phase 21 moved the *choice* of venue out of this module: `process.ts` and
 * `reconcile.ts` ask `resolveOrderVenue` in the registry, which answers with the
 * owner's testnet venue when testnet routing is switched on and with this paper venue
 * otherwise. This function stays for the callers that genuinely want the simulation —
 * the status surface's "nothing is configured" answer, and tests.
 */
export function orderVenue(): OrderVenuePort {
  sharedVenue ??= createPaperVenue();
  return sharedVenue;
}
