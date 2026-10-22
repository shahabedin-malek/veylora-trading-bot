-- Phase 11: accounts, roles and onboarding.
--
-- Two nullable observation columns on `User`. Both exist because the onboarding
-- checklist and the admin directory have to be honest about *what happened*,
-- and neither fact can be derived from the rows that already exist.
--
--   * `lastBalanceReadAt` — the checklist's four steps are derived from durable
--     records of the four actions rather than from a stored checklist:
--     connecting a wallet is a `WalletIdentity`, placing a paper trade is a
--     `TradeOrder`, setting an alert is a `MarketAlert`. The odd one out was
--     "see a balance": there is no cash-balance table until phases 12/13, and the
--     on-chain portfolio read is the only surface that can put a balance in front
--     of someone. So the read records itself, and null means no balance has been
--     read for this account yet — exactly the state a brand-new account is in.
--
--   * `lastSeenAt` — a repeat sign-in has to be visible on the account. The
--     session table already records every device and every session, but "when did
--     this account last sign in?" is a different question from "when was this
--     browser last used?", and the admin directory answers both. Null means the
--     account has never completed a sign-in (the local seed writes users no
--     sign-in has touched).
--
-- Rollback: drop both columns. The checklist loses its second step's signal and
-- the directory stops showing account recency; the rest of the phase is
-- unaffected.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastBalanceReadAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
