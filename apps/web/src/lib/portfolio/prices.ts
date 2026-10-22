import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import type { MarkPrice } from "@/lib/portfolio/pnl";

/**
 * The one place a position's mark comes from, and the only place that may fail.
 *
 * A mark is a *reading*, so this returns readings and nothing else: the provider's
 * own name, the endpoint origin, and the time it observed the price (falling back to
 * when it was fetched, because a reading with no observation time is still a reading
 * with a time on it). It never synthesises a price, never carries one forward from a
 * previous call, and never turns a failure into a number:
 *
 *  - a feed that answered `unavailable` returns **no** marks, so every position on
 *    that market is reported as unpriced with the reason rather than marked at an
 *    old figure;
 *  - a quote with no `last`, `ask` or `bid` is skipped rather than approximated;
 *  - a thrown error is caught here and reported, so an unreachable provider cannot
 *    take the whole overview down with it.
 *
 * Phase 19 owns the wider market-data work; this is deliberately the smallest
 * adapter that lets a position say "this is what it was worth, read from here, at
 * this moment" and lets a missing one say nothing at all.
 */

export type MarkPriceReader = (markets: readonly string[]) => Promise<MarkPrice[]>;

/** Why no mark was read, in one sentence, for a surface that has to say so. */
export type MarkReadOutcome = { marks: MarkPrice[]; failure: string | null };

export function createMarkPriceReader(deps: {
  quotes?: (markets: readonly string[]) => Promise<{ status: "available" | "unavailable"; reason?: string } | MarkPrice[]>;
  now?: () => Date;
} = {}): (markets: readonly string[]) => Promise<MarkReadOutcome> {
  return async (markets) => {
    const wanted = [...new Set(markets.map((market) => market.trim()).filter(Boolean))].sort();
    if (wanted.length === 0) return { marks: [], failure: null };
    try {
      if (deps.quotes) {
        const provided = await deps.quotes(wanted);
        if (Array.isArray(provided)) return { marks: provided, failure: null };
        return { marks: [], failure: `The quote source answered ${provided.reason ?? "unavailable"}.` };
      }
      return await readCoinbaseMarks(wanted);
    } catch (error) {
      return {
        marks: [],
        failure: error instanceof Error ? error.message : "The public quote feed could not be reached.",
      };
    }
  };
}

async function readCoinbaseMarks(markets: readonly string[]): Promise<MarkReadOutcome> {
  const result = await coinbaseMarketData.getQuotes({ instruments: markets });
  if (result.status !== "available") {
    return { marks: [], failure: `The public quote feed answered ${result.reason}.` };
  }

  const marks: MarkPrice[] = [];
  for (const quote of result.data) {
    const price = quote.last ?? quote.ask ?? quote.bid ?? null;
    if (price === null) continue;
    marks.push({
      market: quote.instrument.symbol,
      price,
      source: `${quote.provenance.providerName} (${quote.provenance.providerId}) · ${quote.provenance.endpointOrigin}`,
      asOf: quote.provenance.observedAt ?? quote.provenance.fetchedAt,
      freshness: quote.provenance.freshness,
    });
  }
  return { marks, failure: null };
}
