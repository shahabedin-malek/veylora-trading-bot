import { createVenue } from "@/lib/venues/registry";
import type { VerifiedSpotBalance } from "@/lib/venues/ccxt-adapter";
import type { TradingVenue, VenueCredentialMaterial } from "@/lib/trading/credential-vault";

/**
 * The balance read, kept as the name the rest of the build already calls.
 *
 * Phase 20 moved the actual client into `src/lib/venues/ccxt-adapter.ts`, where every
 * venue is one adapter behind one interface. This module stays because the call site
 * and the imports it already had (`normalizeSpotBalances` in the credential tests, the
 * import path's balance read) should not churn for an internal move — and because the
 * normalisation must have exactly one implementation. Re-exporting it is the whole
 * point: a second copy of "which balances count" is how two panels start disagreeing.
 */
export { normalizeSpotBalances, type VerifiedSpotBalance } from "@/lib/venues/ccxt-adapter";

export async function fetchVerifiedSpotBalances(
  venue: TradingVenue,
  credentials: VenueCredentialMaterial,
): Promise<VerifiedSpotBalance[]> {
  return createVenue(venue, credentials).readBalances();
}
