-- Phase 38: indexes justified by measurement, not intuition.
--
-- Each one is paired with a before/after number in
-- `proof/phase-38-performance-and-load.md`. They are additive: a rollback may drop
-- them without losing a row, and the down path is the commented block at the end.
--
-- Three candidates were measured and rejected rather than shipped:
--   * `AuditEvent(action, occurredAt)` — the audit filter is a `contains` (LIKE
--     '%…%'), which cannot use a B-tree prefix, so the index is never chosen.
--   * `AuditEvent(source, occurredAt)` — the plan changes from a scan to a search
--     but the page is bounded at 200 rows either way: 4 ms with, 4 ms without.
--   * `StrategyDecision(userId, outcome, evaluatedAt)` — no query filters on
--     `outcome`; the existing `(userId, evaluatedAt)` index already serves the
--     feed, and the planner ignored the wider one.

-- The integrity check reads the whole book in time order: 671 ms to 550 ms for
-- 100k transactions, because the sort no longer needs a temp B-tree.
CREATE INDEX "LedgerTransaction_occurredAt_idx" ON "LedgerTransaction"("occurredAt");

-- A statement walks one account's legs in transaction order and the balance
-- aggregate groups by account: a 30-day range goes 202 ms to 144 ms, a statement
-- page 122 ms to 84 ms, the balance aggregate 130 ms to 101 ms.
CREATE INDEX "LedgerEntry_accountId_transactionId_idx" ON "LedgerEntry"("accountId", "transactionId");

-- The orders list filters by account then status: 4 ms to 3 ms.
CREATE INDEX "TradeOrder_userId_status_createdAt_idx" ON "TradeOrder"("userId", "status", "createdAt");

-- The strategy runner counts one account's open orders in one market once per
-- activation; this is a covering index for that count: 3 ms to 1 ms per call,
-- which is what keeps a 26-strategy pass inside its interval.
CREATE INDEX "TradeOrder_userId_market_status_idx" ON "TradeOrder"("userId", "market", "status");

-- Down path (rollback), kept here because Prisma migrations have no down file:
-- DROP INDEX "TradeOrder_userId_market_status_idx";
-- DROP INDEX "TradeOrder_userId_status_createdAt_idx";
-- DROP INDEX "LedgerEntry_accountId_transactionId_idx";
-- DROP INDEX "LedgerTransaction_occurredAt_idx";
