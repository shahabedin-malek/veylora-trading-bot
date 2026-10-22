/**
 * Server startup hook.
 *
 * The PAPER strategy store is process-local, so its development seed has to run
 * when the server boots rather than from a script.
 *
 * The `NEXT_RUNTIME` check comes first and is deliberately not decorative: Next
 * substitutes the literal per bundle, so the Edge compilation drops the branch
 * and never traces `paper-trading/store.ts` (which imports `node:crypto`). Only
 * Node builds reach the imports below.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Provider call records are kept wherever the app actually serves, in every
  // environment, so the admin surface has a history to read. Registering the
  // sink here — and only here — is what keeps a script or a unit test from
  // writing rows it never intended to.
  const { registerPrismaProviderCallSink } = await import("@/lib/observability/provider-call");
  registerPrismaProviderCallSink();

  // Validate the RPC registry once, at startup: one malformed variable marks
  // that network unavailable with the variable named, and every other network
  // keeps serving. Only names and reasons are logged, never a value.
  const { validateNetworkRegistry } = await import("@/lib/rpc/networks");
  const { registry, problems } = validateNetworkRegistry();
  console.log(
    `[rpc] ${registry.totals.available}/${registry.totals.discovered} configured network(s) usable ` +
      `(${registry.totals.evm} EVM, ${registry.totals.listedForPortfolio} in the portfolio allow-list)`,
  );
  for (const problem of problems) console.warn(`[rpc] ${problem}`);

  const { isDevelopmentMode } = await import("@/lib/dev-mode/mode");
  if (!isDevelopmentMode()) return;

  const { getDevelopmentDatabaseDescription } = await import("@/lib/dev-mode/database-target");
  const { seedDevPaperSession } = await import("@/lib/paper-trading/dev-seed");

  const database = getDevelopmentDatabaseDescription();
  const result = await seedDevPaperSession();

  const balance = result.snapshot === null
    ? "no funded account"
    : `$${(result.snapshot.cashBalanceCents / 100).toFixed(2)} cash · ` +
      `$${(result.snapshot.pnlCents / 100).toFixed(2)} P&L · $${(result.snapshot.feesCents / 100).toFixed(2)} fees`;

  console.log(
    `[dev] database: ${database ? `${database.kind} (${database.label}) from ${database.source}` : "unconfigured"} · ` +
      `paper seed ${result.seeded ? "applied" : "already present"}: ` +
      `${result.strategies.map((strategy) => `${strategy.name}=${strategy.state}`).join(", ") || "none"} · ` +
      `${result.ledgerEntries} ledger entries · ${balance}`,
  );
}
