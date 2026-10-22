#!/usr/bin/env node
/**
 * Phase 03 route sweep — every page and API route answers, and nothing pretends to.
 *
 * What it does
 * ------------
 * Requests every route in {@link ROUTE_INVENTORY} against a running dev server,
 * records the status, response time and a body fingerprint, and exits non-zero if
 * any row did not answer the way it declared it would.
 *
 * The sweep is **read-only**. It never sends a payload that a route would accept
 * as a write: mutation routes get an intentionally invalid body and must answer
 * with a 4xx refusal. A 2xx on a mutation row is a FAILURE here, because it would
 * mean the probe wrote something.
 *
 * Two environments, two honest readings
 * -------------------------------------
 * - **Sign-in not configured** (the default: no `APP_BASE_URL`, `AUTH_EVM_CHAIN_IDS`
 *   or `SESSION_SECRET`). Owner routes answer HTTP 503 whose body names the missing
 *   value. That is a pass: the route answered, and it says what is missing.
 * - **Sign-in configured.** Owner routes need a session. Pass one with `--cookie`
 *   (or `ROUTE_SWEEP_COOKIE`) and every owner route is expected to serve its real
 *   content. Without a cookie the sweep REFUSES to report a pass for those rows —
 *   it reports them as not swept and exits non-zero, because "I could not check"
 *   must not read as "it works".
 *
 * Usage
 * -----
 *   pnpm routes:sweep
 *   pnpm routes:sweep -- --base-url http://localhost:3100
 *   pnpm routes:sweep -- --cookie "veylora_session=…" --json
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_SOURCE = join(APP_DIR, "src/app");

/** Names that would make wallet sign-in work. The 503 that names one is a pass. */
const AUTH_NAMES = ["AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"];
/** Names that would connect Alchemy RPC or portfolio reads. */
const ALCHEMY_NAMES = ["ALCHEMY_API_KEY", "ALCHEMY_", "AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"];

/**
 * The dev seed's fixed PAPER session id (`src/lib/paper-trading/dev-seed.ts`), so a
 * swept `GET /api/bots` reads the seeded strategies instead of an empty session.
 */
const DEV_PAPER_SESSION_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The inventory. One entry per route (page) or per exported HTTP method (API):
 *
 *   outcomes        what this route may answer when sign-in is not configured
 *   sessionOutcomes what it may answer once a session cookie is supplied
 *   needs           names a 503 body must contain to count as an honest refusal
 *   auth            true when the route needs a session before it can serve
 *   omitCookie      true when the sweep must not send the session cookie
 *   body            the probe payload (invalid on purpose for mutations)
 *
 * Outcome vocabulary:
 *   "serve"  2xx: the route produced a real answer.
 *   "gap"    503 whose body names the missing variable or provider.
 *   "refuse" 4xx: the route answered and rejected the probe without writing.
 */
export const ROUTE_INVENTORY = [
  // ── pages ────────────────────────────────────────────────────────────────────
  { id: "GET /", method: "GET", path: "/", kind: "page", outcomes: ["serve"], note: "public: the landing page, no session and no figure it cannot source" },
  { id: "GET /login", method: "GET", path: "/login", kind: "page", outcomes: ["serve"] },
  { id: "GET /terminal", method: "GET", path: "/terminal", kind: "page", outcomes: ["serve"], auth: true, note: "the console home, moved off / so the landing page could be public" },
  { id: "GET /pricing", method: "GET", path: "/pricing", kind: "page", outcomes: ["serve"], note: "public: the fee table rendered as the one price list" },
  { id: "GET /status", method: "GET", path: "/status", kind: "page", outcomes: ["serve"], note: "public: the phase-04 health snapshot and the runner's heartbeats" },
  { id: "GET /docs", method: "GET", path: "/docs", kind: "page", outcomes: ["serve"], note: "public: links the phase-32 API reference and the MCP entry point" },
  { id: "GET /docs/api", method: "GET", path: "/docs/api", kind: "page", outcomes: ["serve"], note: "public: rendered from the /api/v1 route registry" },
  { id: "GET /terms", method: "GET", path: "/terms", kind: "page", outcomes: ["serve"], note: "public: operator, not-statements, no jurisdiction named" },
  { id: "GET /privacy", method: "GET", path: "/privacy", kind: "page", outcomes: ["serve"], note: "public: what is stored, and the cookie policy" },
  { id: "GET /risk", method: "GET", path: "/risk", kind: "page", outcomes: ["serve"], note: "public: risk disclosure" },
  { id: "GET /faq", method: "GET", path: "/faq", kind: "page", outcomes: ["serve"], note: "public: the questions the not-statements raise" },
  { id: "GET /onboarding", method: "GET", path: "/onboarding", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /trade", method: "GET", path: "/trade", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /account", method: "GET", path: "/account", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /backtest", method: "GET", path: "/backtest", kind: "page", outcomes: ["serve"] },
  { id: "GET /bots", method: "GET", path: "/bots", kind: "page", outcomes: ["serve"] },
  { id: "GET /marketplace", method: "GET", path: "/marketplace", kind: "page", outcomes: ["serve"], note: "public catalog of rules; cloning is the write and it needs a session" },
  { id: "GET /markets", method: "GET", path: "/markets", kind: "page", outcomes: ["serve"] },
  { id: "GET /screener", method: "GET", path: "/screener", kind: "page", outcomes: ["serve"] },
  { id: "GET /research", method: "GET", path: "/research", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /assistant", method: "GET", path: "/assistant", kind: "page", outcomes: ["serve"] },
  { id: "GET /chaingpt", method: "GET", path: "/chaingpt", kind: "page", outcomes: ["serve"] },
  { id: "GET /wundertrading", method: "GET", path: "/wundertrading", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /admin", method: "GET", path: "/admin", kind: "page", outcomes: ["serve"], auth: true, note: "the console shell: sections, search, saved views, drill-downs and the audited correction" },
  { id: "GET /admin/access", method: "GET", path: "/admin/access", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /admin/data", method: "GET", path: "/admin/data", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /admin/risk", method: "GET", path: "/admin/risk", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /admin/fees", method: "GET", path: "/admin/fees", kind: "page", outcomes: ["serve"], auth: true },
  { id: "GET /admin/models", method: "GET", path: "/admin/models", kind: "page", outcomes: ["serve"], auth: true, note: "routing, provider capabilities, this month's spend and provider health" },
  { id: "GET /admin/support", method: "GET", path: "/admin/support", kind: "page", outcomes: ["serve"], auth: true, note: "tickets, internal notes, saved replies and the account's merged timeline" },
  { id: "GET /admin/audit", method: "GET", path: "/admin/audit", kind: "page", outcomes: ["serve"], auth: true, note: "the filtered trail, chain report, exports and retention controls" },
  { id: "GET /docs/api", method: "GET", path: "/docs/api", kind: "page", outcomes: ["serve"], note: "public reference generated from the /api/v1 route registry; placeholders only" },

  // ── admin console (phase 34) ─────────────────────────────────────────────────
  { id: "GET /api/admin/console", method: "GET", path: "/api/admin/console", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "one section, its filters and the chosen columns, all derived from the ledger rather than a stored total" },
  { id: "GET /api/admin/console/search", method: "GET", path: "/api/admin/console/search?q=0x2222", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "cross-entity search; a probe term is a read" },
  { id: "GET /api/admin/console/record", method: "GET", path: "/api/admin/console/record", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, note: "the probe names no record type, so it is refused before any read" },
  { id: "POST /api/admin/console/correction", method: "POST", path: "/api/admin/console/correction", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe correction is empty, so validation refuses it before any ledger entry or audit event is written" },
  { id: "GET /api/admin/views", method: "GET", path: "/api/admin/views", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "the signed-in owner's saved views only" },
  { id: "POST /api/admin/views", method: "POST", path: "/api/admin/views", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no view, so nothing is saved" },
  { id: "DELETE /api/admin/views", method: "DELETE", path: "/api/admin/views", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no view id, so no row is removed" },

  // ── support (phase 35) ───────────────────────────────────────────────────────
  { id: "GET /api/admin/support/tickets", method: "GET", path: "/api/admin/support/tickets", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "the ticket list with its filters; a read" },
  { id: "POST /api/admin/support/tickets", method: "POST", path: "/api/admin/support/tickets", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no account or subject, so validation refuses it before anything is created" },
  { id: "GET /api/admin/support/tickets/[ticketId]", method: "GET", path: "/api/admin/support/tickets/dev-ticket-latency", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "one ticket's thread, internal notes and linked record; a read" },
  { id: "PATCH /api/admin/support/tickets/[ticketId]", method: "PATCH", path: "/api/admin/support/tickets/dev-ticket-latency", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe changes no field, so nothing is written and no status audit is recorded" },
  { id: "POST /api/admin/support/tickets/[ticketId]/messages", method: "POST", path: "/api/admin/support/tickets/dev-ticket-latency/messages", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe body is empty, so no message is appended" },
  { id: "GET /api/admin/support/tickets/[ticketId]/export", method: "GET", path: "/api/admin/support/tickets/dev-ticket-latency/export", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "a markdown export of the thread with credential material redacted; a read" },
  { id: "POST /api/admin/support/notes", method: "POST", path: "/api/admin/support/notes", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no account or body, so no note is written" },
  { id: "GET /api/admin/support/replies", method: "GET", path: "/api/admin/support/replies", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "saved replies and the placeholder vocabulary; a read" },
  { id: "POST /api/admin/support/replies", method: "POST", path: "/api/admin/support/replies", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no name or body, so no reply is saved" },
  { id: "DELETE /api/admin/support/replies/[replyId]", method: "DELETE", path: "/api/admin/support/replies/dev-saved-reply-deposit", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "never carries a session: the probe could delete the seeded reply" },
  { id: "GET /api/admin/support/replies/preview", method: "GET", path: "/api/admin/support/replies/preview", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, note: "the probe names no reply or ticket, so it is refused before rendering" },
  { id: "GET /api/admin/support/search", method: "GET", path: "/api/admin/support/search?q=deposit", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "tickets, messages, notes and timeline content by one term; a read" },
  { id: "GET /api/admin/audit", method: "GET", path: "/api/admin/audit?check=1", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "filtered events, the chain report and the retention setting; a read" },
  { id: "POST /api/admin/audit", method: "POST", path: "/api/admin/audit", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no action, so nothing is verified and no retention is saved" },
  { id: "GET /api/admin/audit/export", method: "GET", path: "/api/admin/audit/export", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "a filtered JSON export whose manifest hash is computed over the events; a read" },
  { id: "GET /api/support/tickets", method: "GET", path: "/api/support/tickets", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "the account's own tickets; PUBLIC messages only, no internal row and no note" },

  // ── admin API: read and write settings ───────────────────────────────────────
  { id: "GET /api/admin/access", method: "GET", path: "/api/admin/access", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/admin/access", method: "POST", path: "/api/admin/access", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "role grants have no probe payload" },
  { id: "GET /api/admin/chaingpt", method: "GET", path: "/api/admin/chaingpt", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "PUT /api/admin/chaingpt", method: "PUT", path: "/api/admin/chaingpt", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "GET /api/admin/health", method: "GET", path: "/api/admin/health", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: [...AUTH_NAMES, "DATABASE_URL"], auth: true, note: "an unreachable provider is reported in the body; an unreachable database is a 503 naming DATABASE_URL" },
  { id: "GET /api/admin/integrations", method: "GET", path: "/api/admin/integrations", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "PUT /api/admin/integrations", method: "PUT", path: "/api/admin/integrations", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "GET /api/admin/notifications", method: "GET", path: "/api/admin/notifications", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true, note: "channel switches, quiet hours and the default cooldown; credentials are named, never returned" },
  { id: "PUT /api/admin/notifications", method: "PUT", path: "/api/admin/notifications", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no settings document, so validation refuses it before anything is saved" },
  { id: "GET /api/admin/risk-policy", method: "GET", path: "/api/admin/risk-policy", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "PUT /api/admin/risk-policy", method: "PUT", path: "/api/admin/risk-policy", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "POST /api/admin/risk-policy/switch", method: "POST", path: "/api/admin/risk-policy/switch", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the kill switches are pressed, not saved; the probe body names no scope, so a signed-in probe is refused before any write" },
  { id: "GET /api/admin/security-policy", method: "GET", path: "/api/admin/security-policy", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true },
  { id: "PUT /api/admin/security-policy", method: "PUT", path: "/api/admin/security-policy", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe policy fails validation before anything is written" },
  { id: "GET /api/admin/withdrawals", method: "GET", path: "/api/admin/withdrawals", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true, note: "the owner's stored new-address window, and which of the two candidates is in force" },
  { id: "PUT /api/admin/withdrawals", method: "PUT", path: "/api/admin/withdrawals", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no window, so the validation refuses it before anything is saved" },
  { id: "POST /api/admin/withdrawals/pause", method: "POST", path: "/api/admin/withdrawals/pause", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the owner's stop switch for outbound money; the probe names no boolean, so it is refused before anything changes" },
  { id: "POST /api/admin/deposits/credit", method: "POST", path: "/api/admin/deposits/credit", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "credits an arrival the network does not configure at a USDT value; the probe names no deposit, so it is refused" },
  { id: "GET /api/admin/fees", method: "GET", path: "/api/admin/fees", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true, note: "the version in force, staged versions, history, and the assets a withdrawal can send" },
  { id: "PUT /api/admin/fees", method: "PUT", path: "/api/admin/fees", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no effective-from time, so validation refuses it before anything is inserted" },
  { id: "GET /api/admin/wundertrading", method: "GET", path: "/api/admin/wundertrading", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "PUT /api/admin/wundertrading", method: "PUT", path: "/api/admin/wundertrading", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "GET /api/admin/models", method: "GET", path: "/api/admin/models", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: [...AUTH_NAMES, "DATABASE_URL"], auth: true, note: "providers, routes in effect, and the period's recorded spend; keys are named, never returned" },
  { id: "PUT /api/admin/models", method: "PUT", path: "/api/admin/models", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no route document, so validation refuses it before anything is saved" },
  { id: "POST /api/admin/models/probe", method: "POST", path: "/api/admin/models/probe", kind: "api", outcomes: ["gap", "refuse", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, body: { question: "probe" }, note: "one short plain-text completion through the admin-probe route; a signed-in probe either answers or names the missing variable" },
  { id: "GET /api/admin/api-keys", method: "GET", path: "/api/admin/api-keys", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true, note: "issued keys by prefix, agent accounts and approval records; no key value or hash is ever returned" },
  { id: "POST /api/admin/api-keys", method: "POST", path: "/api/admin/api-keys", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no action, so no key, agent account or approval decision is written" },

  // ── the account view (phase 15) ───────────────────────────────────────────────
  // Both rows are reads, so a sweep may serve them: the balances are derived from the
  // entries (none, on a fresh database), the positions are built from whatever fills
  // exist (none), and the export is the same rows as text. The external import is
  // *opt-in* — it only runs when `external=1` is asked for — so the probe's own GET
  // reaches no venue, which is why a plain read is the honest reading here.
  { id: "GET /api/account", method: "GET", path: "/api/account", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "balances, positions, P&L, filtered history and the period report; each figure carries its source and as-of" },
  { id: "GET /api/account/export", method: "GET", path: "/api/account/export", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "the same view as a CSV attachment; an export is a read and carries the totals the screen shows" },

  // ── assistant ────────────────────────────────────────────────────────────────
  { id: "GET /api/assistant", method: "GET", path: "/api/assistant", kind: "api", outcomes: ["serve"] },
  { id: "POST /api/assistant", method: "POST", path: "/api/assistant", kind: "api", outcomes: ["refuse"], body: { messages: "not-an-array" }, note: "a valid probe would spend a model call" },

  // ── auth ─────────────────────────────────────────────────────────────────────
  { id: "GET /api/auth/config", method: "GET", path: "/api/auth/config", kind: "api", outcomes: ["serve"] },
  { id: "POST /api/auth/nonce", method: "POST", path: "/api/auth/nonce", kind: "api", outcomes: ["gap", "refuse"], needs: AUTH_NAMES, body: {} },
  { id: "GET /api/auth/session", method: "GET", path: "/api/auth/session", kind: "api", outcomes: ["serve"] },
  { id: "DELETE /api/auth/session", method: "DELETE", path: "/api/auth/session", kind: "api", outcomes: ["serve"], extraStatuses: [403], omitCookie: true, note: "never carries the session: signing out would rotate it" },
  { id: "GET /api/auth/sessions", method: "GET", path: "/api/auth/sessions", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true, note: "the session list: device, IP, last seen, and which one is this device" },
  { id: "POST /api/auth/sessions", method: "POST", path: "/api/auth/sessions", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the probe names no action, so it is refused without ending a session" },
  { id: "GET /api/auth/totp", method: "GET", path: "/api/auth/totp", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/auth/totp", method: "POST", path: "/api/auth/totp", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, omitCookie: true, extraStatuses: [401], body: {}, note: "never carries the session: enrolment would issue a real secret" },
  { id: "DELETE /api/auth/totp", method: "DELETE", path: "/api/auth/totp", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, omitCookie: true, extraStatuses: [401], body: { code: "000000" }, note: "never carries the session: disabling an authenticator is a write" },
  { id: "POST /api/auth/totp/activate", method: "POST", path: "/api/auth/totp/activate", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, omitCookie: true, extraStatuses: [401], body: { code: "000000" }, note: "never carries the session: a wrong code is still a counted attempt" },
  { id: "POST /api/auth/totp/verify", method: "POST", path: "/api/auth/totp/verify", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, omitCookie: true, extraStatuses: [401], body: { code: "000000", scope: "trading" }, note: "never carries the session: a wrong code is still a counted attempt" },
  { id: "POST /api/auth/verify", method: "POST", path: "/api/auth/verify", kind: "api", outcomes: ["gap", "refuse"], needs: AUTH_NAMES, body: {} },

  // ── backtest, bots and the PAPER store ───────────────────────────────────────
  {
    id: "POST /api/backtest", method: "POST", path: "/api/backtest", kind: "api", outcomes: ["serve", "gap"],
    needs: ["Coinbase"],
    body: { symbol: "BTC-USD", initialCapitalUsd: "1000", feeBps: "10", slippageBps: "5", buyRsiBelow: "30", sellRsiAbove: "70" },
  },
  { id: "GET /api/bots", method: "GET", path: `/api/bots?paperSessionId=${DEV_PAPER_SESSION_ID}`, kind: "api", outcomes: ["serve"] },
  { id: "POST /api/bots", method: "POST", path: "/api/bots", kind: "api", outcomes: ["refuse"], body: {}, note: "an accepted draft would mutate the PAPER store" },
  { id: "POST /api/bots/[botId]/kill", method: "POST", path: "/api/bots/dev-draft-route-sweep/kill", kind: "api", outcomes: ["refuse"], body: {}, note: "killing the seeded strategy is a state change" },
  { id: "POST /api/bots/[botId]/paper", method: "POST", path: "/api/bots/dev-draft-route-sweep/paper", kind: "api", outcomes: ["refuse"], body: {} },
  { id: "POST /api/bots/[botId]/paper-cycle", method: "POST", path: "/api/bots/dev-draft-route-sweep/paper-cycle", kind: "api", outcomes: ["refuse"], body: {} },
  // Phase 31: the inbound signal endpoint is authenticated by its own signature, not a
  // session, so the sweep must not send a cookie. An unknown token is a 401 refusal and the
  // probe writes nothing.
  { id: "POST /api/signals/[token]", method: "POST", path: "/api/signals/route-sweep-not-a-token", kind: "api", outcomes: ["refuse"], omitCookie: true, body: {}, note: "an unsigned/unknown signal must be refused" },
  { id: "GET /api/signals", method: "GET", path: "/api/signals", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/signals", method: "POST", path: "/api/signals", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "an accepted token would be a credential write" },
  { id: "PATCH /api/signals", method: "PATCH", path: "/api/signals", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "GET /api/webhooks", method: "GET", path: "/api/webhooks", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/webhooks", method: "POST", path: "/api/webhooks", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "an accepted subscription would be a secret write" },

  // ── alerts, cron and portfolio ───────────────────────────────────────────────
  // The runner's one entry point (phase 05). `/api/cron/all` is what the host's
  // schedule calls; `/api/cron/market-alerts` is the same route asked for one job,
  // kept because it is the path the owner has in their notes and the older
  // schedule used. Neither runs a job in a sweep: with no secret the row is a 503
  // naming CRON_SECRET, and with a configured secret it is a 401.
  { id: "GET /api/cron/all", method: "GET", path: "/api/cron/all", kind: "api", outcomes: ["gap", "refuse"], needs: ["CRON_SECRET"], extraStatuses: [401], note: "the runner's scheduled entry point" },
  { id: "GET /api/cron/market-alerts", method: "GET", path: "/api/cron/market-alerts", kind: "api", outcomes: ["gap", "refuse"], needs: ["CRON_SECRET"], extraStatuses: [401] },
  { id: "GET /api/market-alerts", method: "GET", path: "/api/market-alerts", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/market-alerts", method: "POST", path: "/api/market-alerts", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "an accepted alert would be a database write" },
  { id: "DELETE /api/market-alerts", method: "DELETE", path: "/api/market-alerts", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  // The screener (phase 19). Its GET is public — the watchlist, saved-screen
  // summaries and retained provider health are not account secrets — and its
  // POST evaluates a condition without confirmation. An empty POST body names no
  // action, so a sweep can only observe the refusal.
  { id: "GET /api/screener", method: "GET", path: "/api/screener", kind: "api", outcomes: ["serve"], note: "watchlist, saved-screen summaries and provider health" },
  { id: "POST /api/screener", method: "POST", path: "/api/screener", kind: "api", outcomes: ["gap", "refuse"], needs: AUTH_NAMES, body: {}, note: "an empty body names no action, so nothing is evaluated or saved" },
  { id: "DELETE /api/screener", method: "DELETE", path: "/api/screener", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "deleting a saved screen is a write" },
  // The aggregate read (phase 18). A plain GET asks for the JSON snapshot; the
  // panel asks for `Accept: text/event-stream` and gets one event per settled
  // network. Either way this is a read of the account's own holdings, so a sweep
  // may serve it, and a missing wallet or provider is named in the body rather
  // than guessed at.
  { id: "GET /api/portfolio", method: "GET", path: "/api/portfolio", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve", "gap", "refuse"], needs: ALCHEMY_NAMES, extraStatuses: [409], auth: true, note: "holdings with per-network provenance, the allow-list markers, and a summary that names every network that did not answer" },
  { id: "GET /api/portfolio/ethereum", method: "GET", path: "/api/portfolio/ethereum", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve", "gap", "refuse"], needs: ALCHEMY_NAMES, extraStatuses: [409], auth: true },
  { id: "POST /api/portfolio/ethereum/tokens", method: "POST", path: "/api/portfolio/ethereum/tokens", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "DELETE /api/portfolio/ethereum/tokens", method: "DELETE", path: "/api/portfolio/ethereum/tokens", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "GET /api/portfolio/networks", method: "GET", path: "/api/portfolio/networks", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["serve", "gap", "refuse"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/portfolio/networks", method: "POST", path: "/api/portfolio/networks", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "DELETE /api/portfolio/networks", method: "DELETE", path: "/api/portfolio/networks", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },

  // ── deposits (phase 12) ──────────────────────────────────────────────────────
  // Two of these three rows are worth a word, because both sides of them are
  // deliberate. `GET /api/deposits` *issues* the addresses the account does not
  // have yet as well as reading them, and issuing is what a first read is for: it
  // is keyed by (account, network) so a second read writes nothing. And
  // `POST /api/deposits` is declared here as something a sweep may **serve**, not
  // just refuse, because it takes no input at all — the server reads the chains
  // and records what it finds — and every write it makes is keyed by the chain's
  // own identity for a transfer. A probe therefore cannot make it credit
  // anything, which is exactly the property that lets a person ask for a check
  // from the deposit panel.
  { id: "GET /api/deposits", method: "GET", path: "/api/deposits", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/deposits", method: "POST", path: "/api/deposits", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, body: {}, note: "running the watcher on demand: it takes no input and is idempotent per (txHash, logIndex), so a sweep may ask for a check" },
  {
    id: "GET /api/deposits/[address]", method: "GET",
    path: "/api/deposits/0x0000000000000000000000000000000000000000", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], note: "the probe address was never issued to anyone, so a 404 is the expected refusal",
  },

  // ── the ledger of record (phase 13) ──────────────────────────────────────────
  // `GET /api/ledger` is a read on an empty book, so a sweep may serve it: the
  // balances are derived from whatever entries exist (none, on a fresh database),
  // and the export is the same rows as text. `POST /api/ledger` takes exactly one
  // action and the probe names none, so it must refuse — and it is declared
  // without a session outcome that could serve, because a probe that reversed
  // something would be a probe that wrote.
  { id: "GET /api/ledger", method: "GET", path: "/api/ledger", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "balances and the statement, derived from the entries; a fresh book reads as zero rather than as an error" },
  { id: "POST /api/ledger", method: "POST", path: "/api/ledger", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "the only action is reversing a deposit credit, and the probe names no deposit" },

  // ── withdrawals and their failure paths (phase 14) ───────────────────────────
  // `GET /api/withdrawals` is a read, so a sweep may serve it: what the account can
  // spend, what is already held, the fee on every network it can be sent on, and the
  // owner's own new-address window. A deployment with no sending wallet answers 200
  // with that gap named rather than an error, because an unconfigured seed is
  // configuration and the panel has to explain it.
  // `POST /api/withdrawals` is the one row in this file where the probe must stay
  // empty: a body that named a network, a destination *and* an amount would reserve
  // real money, so the probe is refused for naming none of them.
  { id: "GET /api/withdrawals", method: "GET", path: "/api/withdrawals", kind: "api", outcomes: ["gap", "serve"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true, note: "spendable and held balances, fees, networks and the owner's own hold window; an unconfigured sender reads as a named gap rather than as an error" },
  {
    id: "POST /api/withdrawals", method: "POST", path: "/api/withdrawals", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {},
    note: "the probe names no network, destination or amount, so nothing is reserved and nothing is written",
  },
  {
    id: "GET /api/withdrawals/[id]", method: "GET",
    path: "/api/withdrawals/route-sweep-probe", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], note: "the probe id belongs to no withdrawal, so a 404 is the expected refusal — an account only ever reads rows it owns",
  },
  {
    id: "POST /api/withdrawals/[id]", method: "POST",
    path: "/api/withdrawals/route-sweep-probe", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], body: { action: "cancel" }, note: "the only action is a cancellation attempt, and the probe names no withdrawal, so it is refused by id rather than by its body — which is why the body can carry the real action",
  },

  // ── research, RPC and trading ────────────────────────────────────────────────
  { id: "POST /api/research/tavily/search", method: "POST", path: "/api/research/tavily/search", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  { id: "POST /api/research/tavily/extract", method: "POST", path: "/api/research/tavily/extract", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: { urls: [] } },
  {
    id: "POST /api/rpc/[network]", method: "POST", path: "/api/rpc/ethereum", kind: "api", outcomes: ["serve", "gap"],
    needs: ALCHEMY_NAMES,
    body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  },
  { id: "GET /api/trading/credentials", method: "GET", path: "/api/trading/credentials", kind: "api", outcomes: ["gap"], needs: AUTH_NAMES, auth: true },
  { id: "POST /api/trading/credentials", method: "POST", path: "/api/trading/credentials", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {}, note: "an accepted key would be encrypted into the database" },
  { id: "DELETE /api/trading/credentials", method: "DELETE", path: "/api/trading/credentials", kind: "api", outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {} },
  {
    id: "POST /api/trading/credentials/[credentialId]/verify", method: "POST",
    path: "/api/trading/credentials/route-sweep-probe/verify", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {},
    extraStatuses: [404], note: "the probe id does not exist, so a 404 is the expected refusal",
  },
  { id: "GET /api/trading/orders", method: "GET", path: "/api/trading/orders", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true },
  {
    id: "POST /api/trading/orders", method: "POST", path: "/api/trading/orders", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    body: {}, note: "an accepted submission would place a paper order and write its audit chain",
  },
  {
    id: "POST /api/trading/orders/[orderId]/cancel", method: "POST",
    path: "/api/trading/orders/route-sweep-probe/cancel", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true, body: {},
    extraStatuses: [404], note: "the probe id does not exist, so a 404 is the expected refusal",
  },
  // Phase 22's dry comparison. It is a read of private account state, so it needs a session;
  // the probe names no market, so the validation refuses it with a 400 and nothing is
  // compared, decrypted or placed.
  {
    id: "GET /api/trading/orders/comparison", method: "GET", path: "/api/trading/orders/comparison", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    note: "the probe asks for no market, so the read refuses rather than comparing anything",
  },
  // Phase 23's activation controls. Both reads expose private account state, so they need a
  // session; the mutations are same-origin only and the probes below are shaped so that a
  // signed-in sweep is refused before anything is written.
  { id: "GET /api/strategies/activate", method: "GET", path: "/api/strategies/activate", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve", "gap"], needs: AUTH_NAMES, auth: true },
  {
    id: "POST /api/strategies/activate", method: "POST", path: "/api/strategies/activate", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    body: { strategyId: "route-sweep-probe" },
    note: "the probe names a strategy this build does not publish, so the start is refused before an activation or audit row is written",
  },
  {
    id: "GET /api/strategies/[id]", method: "GET", path: "/api/strategies/route-sweep-probe", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], note: "the probe id belongs to no activation, so a 404 is the expected refusal — an account only ever reads rows it owns",
  },
  {
    id: "DELETE /api/strategies/[id]", method: "DELETE", path: "/api/strategies/route-sweep-probe", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], note: "the probe id belongs to no activation, so the ownership lookup refuses before any stop is written",
  },
  // Phase 28's definition surface. Reads expose private account state, so they need a
  // session; the two mutations are same-origin only and the probes are shaped so that a
  // signed-in sweep is refused before a version is written.
  { id: "GET /api/strategies", method: "GET", path: "/api/strategies", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true, note: "this account's definition versions, newest first" },
  {
    id: "POST /api/strategies", method: "POST", path: "/api/strategies", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    body: {},
    note: "the probe names no mode, so nothing is generated and no version is written",
  },
  {
    id: "PUT /api/strategies", method: "PUT", path: "/api/strategies", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    body: {},
    note: "the probe names no definition id, so the edit is refused before a version is inserted",
  },
  // Phase 30's bot builder and marketplace. Reads are this account's own rows, so they
  // need a session; every mutation probe is refused before a row is written.
  { id: "GET /api/bot-builder", method: "GET", path: "/api/bot-builder", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true, note: "this account's bots, deleted ones included, plus the tier caps in force" },
  {
    id: "POST /api/bot-builder", method: "POST", path: "/api/bot-builder", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    body: {},
    note: "the probe names no configuration, so validation refuses it before a draft exists",
  },
  {
    id: "GET /api/bot-builder/[botId]", method: "GET", path: "/api/bot-builder/route-sweep-probe", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], note: "the probe id belongs to no bot, so ownership refuses it rather than hinting that a row exists",
  },
  {
    id: "PATCH /api/bot-builder/[botId]", method: "PATCH", path: "/api/bot-builder/route-sweep-probe", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], body: {},
    note: "the probe names no configuration and no owned bot, so nothing is edited",
  },
  {
    id: "DELETE /api/bot-builder/[botId]", method: "DELETE", path: "/api/bot-builder/route-sweep-probe", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], note: "the probe id belongs to no bot, so no deletion and no activation stop is written",
  },
  {
    id: "POST /api/bot-builder/[botId]/publish", method: "POST", path: "/api/bot-builder/route-sweep-probe/publish", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], body: {},
    note: "the probe id belongs to no draft, so no definition version is created",
  },
  {
    id: "POST /api/bot-builder/[botId]/share", method: "POST", path: "/api/bot-builder/route-sweep-probe/share", kind: "api",
    outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    extraStatuses: [404], body: {},
    note: "the probe id belongs to no published bot, so no template row is shared",
  },
  { id: "GET /api/marketplace", method: "GET", path: "/api/marketplace", kind: "api", outcomes: ["serve", "gap"], sessionOutcomes: ["serve", "gap"], needs: ["DATABASE_URL"], note: "the catalog of rules; performance comes from stored runs and is absent when there are none" },
  {
    id: "POST /api/marketplace", method: "POST", path: "/api/marketplace", kind: "api",
    outcomes: ["gap", "refuse"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true,
    body: {},
    note: "the probe names no template, so the clone is refused before a draft is created",
  },
  { id: "GET /api/backtest/runs", method: "GET", path: "/api/backtest/runs", kind: "api", outcomes: ["gap"], sessionOutcomes: ["serve"], needs: AUTH_NAMES, auth: true, note: "the stored runs the comparison table reads; a run is history and there is no delete" },
  { id: "GET /api/trading/status", method: "GET", path: "/api/trading/status", kind: "api", outcomes: ["serve"] },
  // Phase 32: the versioned public API is authenticated by a bearer key, not a session, so
  // the sweep must not send a cookie. The probe carries no key and must be refused before a
  // rate row or a read exists.
  { id: "GET /api/v1/[...path]", method: "GET", path: "/api/v1/account", kind: "api", outcomes: ["refuse"], extraStatuses: [401], omitCookie: true, note: "no bearer key: a specific 401, with no data read and no counter for a key the caller does not hold" },
  { id: "POST /api/v1/[...path]", method: "POST", path: "/api/v1/orders", kind: "api", outcomes: ["refuse"], extraStatuses: [401], omitCookie: true, body: {}, note: "no bearer key: the write route refuses before a body is parsed or an approval is created" },
  { id: "GET /api/trading/wundertrading", method: "GET", path: "/api/trading/wundertrading", kind: "api", outcomes: ["gap"], sessionOutcomes: ["refuse"], needs: AUTH_NAMES, auth: true },
];

/** 4xx answers that prove a route rejected the probe without writing. */
const REFUSAL_STATUSES = new Set([400, 403, 409, 413, 415, 422]);

/**
 * Decide one row's verdict. Pure: no I/O, so the sweep's rules are testable
 * without a server, and a planted fault can be classified in a unit test too.
 */
export function classify(entry, result, environment) {
  const { authEnabled, hasCookie } = environment;

  if (result.transportError) {
    return { verdict: "fail", outcome: "no-response", reason: result.transportError };
  }
  if (entry.auth && authEnabled && !hasCookie) {
    return {
      verdict: "skip",
      outcome: "not-swept",
      reason: "sign-in is configured, so this row needs a session: pass --cookie (or ROUTE_SWEEP_COOKIE)",
    };
  }

  const expected = entry.auth && authEnabled && hasCookie
    ? (entry.sessionOutcomes ?? ["serve"])
    : entry.outcomes;
  const { status, body } = result;

  if (status === 404) {
    return expected.includes("refuse") && (entry.extraStatuses ?? []).includes(404)
      ? { verdict: "pass", outcome: "refuse", reason: "answered with the declared 404 refusal" }
      : { verdict: "fail", outcome: "unexpected-404", reason: "the route does not answer at this path" };
  }
  if (status >= 300 && status < 400) {
    return { verdict: "fail", outcome: "redirect", reason: `${status} redirect instead of an answer` };
  }
  if (status === 503) {
    if (!expected.includes("gap")) return { verdict: "fail", outcome: "unexpected-503", reason: "503 is not a declared answer for this row" };
    const named = (entry.needs ?? []).filter((need) => body.includes(need));
    return named.length > 0
      ? { verdict: "pass", outcome: "gap", reason: `names ${named[0]}` }
      : { verdict: "fail", outcome: "unnamed-503", reason: `503 body names none of ${(entry.needs ?? ["(nothing declared)"]).join(", ")}` };
  }
  if (status >= 500) {
    return { verdict: "fail", outcome: "server-error", reason: `${status} server error` };
  }
  if (status >= 200 && status < 300) {
    return expected.includes("serve")
      ? { verdict: "pass", outcome: "serve", reason: "answered" }
      : { verdict: "fail", outcome: "unexpected-2xx", reason: "a read-only sweep must not receive 2xx from a mutation route" };
  }
  if (status >= 400) {
    const allowed = REFUSAL_STATUSES.has(status) || (entry.extraStatuses ?? []).includes(status);
    if (!expected.includes("refuse") || !allowed) {
      return { verdict: "fail", outcome: "unexpected-refusal", reason: `${status} is not a declared answer for this row` };
    }
    return body.trim().length > 0
      ? { verdict: "pass", outcome: "refuse", reason: `${status} refusal` }
      : { verdict: "fail", outcome: "empty-refusal", reason: `${status} with an empty body` };
  }
  return { verdict: "fail", outcome: "unexpected-status", reason: `${status} is not an answer` };
}

/** A short, stable fingerprint of a response body: hash, size and readable head. */
export function fingerprint(body, contentType) {
  const bytes = Buffer.byteLength(body, "utf8");
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const head = (contentType?.includes("json") ? jsonExcerpt(body) : htmlExcerpt(body)) || "";
  return `${hash} ${String(bytes).padStart(6)}B ${head}`;
}

function jsonExcerpt(body, limit = 60) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      for (const key of ["error", "message", "status", "reply"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) return `"${value.trim().slice(0, limit)}"`;
      }
      return `{${Object.keys(parsed).slice(0, 4).join(",")}}`;
    }
  } catch {
    // Not JSON after all: fall through to the raw head.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, limit);
}

function htmlExcerpt(body) {
  const title = /<title[^>]*>([^<]{0,80})<\/title>/i.exec(body);
  if (title) return `<title>${title[1].trim()}>`;
  const heading = /<h1[^>]*>([^<]{0,80})<\/h1>/i.exec(body);
  if (heading) return `<h1>${heading[1].trim()}>`;
  return body.replace(/\s+/g, " ").trim().slice(0, 60);
}

function routeFromFile(relativePath) {
  return `/${relativePath.replace(/\/route\.ts$/, "")}`;
}

/** Every page and every exported HTTP method this app ships, as inventory keys. */
/**
 * The URL a `page.tsx` answers on.
 *
 * Route groups — `(public)` — are a layout device, not a path segment, so they are dropped:
 * `(public)/pricing/page.tsx` is `/pricing`, and `(public)/page.tsx` is `/`. Without this the
 * inventory would have to name the group, and the sweep would probe an address the app never serves.
 */
export function pagePathFromFile(relativePath) {
  const segments = relativePath
    .replace(/\/?page\.tsx$/, "")
    .split("/")
    .filter((segment) => segment.length > 0 && !/^\(.+\)$/.test(segment));
  return `/${segments.join("/")}`;
}

export async function discoverRoutes(appSource = APP_SOURCE) {
  const pages = [];
  const methods = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const relativePath = relative(appSource, full).split("\\").join("/");
      if (entry.name === "page.tsx") {
        pages.push(pagePathFromFile(relativePath));
        continue;
      }
      if (entry.name !== "route.ts") continue;

      const source = await readFile(full, "utf8");
      const routePath = routeFromFile(relativePath);
      for (const match of source.matchAll(/^export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)) {
        methods.push({ method: match[1], path: routePath });
      }
    }
  }

  await walk(appSource);
  return { pages: pages.sort(), methods };
}

/**
 * True when a declared path (which may use a concrete probe value) addresses the
 * same route as a file path (which uses `[param]` segments). Either side may be
 * the dynamic one: the inventory says `/api/bots/dev-draft/kill`, the app says
 * `/api/bots/[botId]/kill`.
 */
function samePath(declaredPath, actualPath) {
  const declared = declaredPath.split("/");
  const actual = actualPath.split("/");
  if (declared.length !== actual.length) return false;
  return declared.every((segment, index) => {
    const other = actual[index];
    if (segment === other) return true;
    const dynamic = (value) => value.startsWith("[") && value.endsWith("]");
    return (dynamic(segment) || dynamic(other)) && segment !== "" && other !== "";
  });
}

/**
 * The inventory must cover every page and every exported method, and must not
 * name a route the app does not ship. This is what makes "a new route must be
 * added to the inventory" true instead of aspirational.
 */
export async function checkInventoryCoverage(inventory = ROUTE_INVENTORY, appSource = APP_SOURCE) {
  const { pages, methods } = await discoverRoutes(appSource);
  const declaredPages = new Set(inventory.filter((entry) => entry.kind === "page").map((entry) => entry.path));
  const declaredMethods = inventory.filter((entry) => entry.kind === "api").map((entry) => ({ method: entry.method, path: entry.path.split("?")[0] }));
  const problems = [];

  for (const page of pages) {
    if (!declaredPages.has(page)) problems.push(`page ${page} is not in the route inventory`);
  }
  for (const { method, path } of methods) {
    if (!declaredMethods.some((row) => row.method === method && samePath(row.path, path))) {
      problems.push(`${method} ${path} is not in the route inventory`);
    }
  }
  for (const entry of inventory) {
    if (entry.kind === "page") {
      if (!pages.includes(entry.path)) problems.push(`inventory entry ${entry.id} names a page the app does not ship`);
      continue;
    }
    const declaredPath = entry.path.split("?")[0];
    if (!methods.some(({ method, path }) => method === entry.method && samePath(declaredPath, path))) {
      problems.push(`inventory entry ${entry.id} names a route the app does not ship`);
    }
  }

  return { pages: pages.length, methods: methods.length, problems };
}

function parseArgs(argv) {
  const options = { baseUrl: process.env.ROUTE_SWEEP_BASE_URL ?? "http://localhost:3000", cookie: process.env.ROUTE_SWEEP_COOKIE ?? "", json: false, timeoutMs: 30_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // `pnpm routes:sweep -- --base-url …` passes the separator through.
    if (argument === "--") continue;
    else if (argument === "--base-url") options.baseUrl = argv[++index] ?? options.baseUrl;
    else if (argument === "--cookie") options.cookie = argv[++index] ?? "";
    else if (argument === "--timeout-ms") options.timeoutMs = Number(argv[++index] ?? options.timeoutMs);
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function cookieHeader(cookie) {
  if (!cookie) return null;
  return cookie.includes("=") ? cookie : `veylora_session=${cookie}`;
}

async function request(entry, options, cookie) {
  const startedAt = performance.now();
  const headers = { origin: options.baseUrl };
  if (cookie && !entry.omitCookie) headers.cookie = cookie;
  const init = { method: entry.method, headers, redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs) };
  if (entry.body !== undefined && entry.method !== "GET" && entry.method !== "HEAD") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(entry.body);
  }

  try {
    const response = await fetch(new URL(entry.path, options.baseUrl), init);
    const body = await response.text();
    return {
      status: response.status,
      body,
      contentType: response.headers.get("content-type") ?? "",
      elapsedMs: performance.now() - startedAt,
    };
  } catch (error) {
    return { transportError: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - startedAt };
  }
}

function authState(configuration, cookie) {
  const enabled = configuration?.enabled === true;
  return { authEnabled: enabled, hasCookie: Boolean(cookie), reason: configuration?.reason ?? null };
}

function printTable(rows) {
  const width = Math.max(...rows.map(({ entry }) => entry.id.length), 10);
  console.log(`${"ROUTE".padEnd(width)}  STATUS  TIME      RESULT   FINGERPRINT`);
  for (const row of rows) {
    const status = row.result.transportError ? "  —" : String(row.result.status).padStart(3);
    const time = `${row.result.elapsedMs.toFixed(0)}ms`.padEnd(8);
    const verdict = row.verdict.verdict === "pass" ? "pass" : row.verdict.verdict === "skip" ? "SKIP" : "FAIL";
    console.log(`${row.entry.id.padEnd(width)}  ${status}     ${time}  ${verdict.padEnd(8)} ${row.result.transportError ?? row.fingerprint}`);
  }
}

function printGaps(rows) {
  const gaps = rows.filter(({ verdict }) => verdict.outcome === "gap");
  console.log(`\nMISSING CONFIGURATION — ${gaps.length} route(s) answered 503 naming what is missing:`);
  const byReason = new Map();
  for (const row of gaps) {
    const reason = jsonExcerpt(row.result.body, 160);
    byReason.set(reason, [...(byReason.get(reason) ?? []), row.entry.id]);
  }
  if (byReason.size === 0) console.log("  none — every configuration this app reads is present");
  for (const [reason, ids] of byReason) {
    console.log(`  ${reason}`);
    console.log(`    needs: ${ids.join(", ")}`);
  }
}

function printRefusals(rows) {
  const refusals = rows.filter(({ verdict }) => verdict.outcome === "refuse");
  console.log(`\nNOT EXECUTED — ${refusals.length} mutation route(s) answered a refusal, so the sweep wrote nothing:`);
  for (const { entry, result } of refusals) {
    console.log(`  ${entry.id} → ${result.status} ${jsonExcerpt(result.body)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/route-sweep.mjs [--base-url URL] [--cookie COOKIE] [--json] [--timeout-ms MS]");
    return 0;
  }

  // In --json mode stdout carries the report alone, so the preamble goes to stderr.
  const log = options.json ? console.error : console.log;
  const coverage = await checkInventoryCoverage();
  log(`Route inventory: ${ROUTE_INVENTORY.length} rows covering ${coverage.pages} pages and ${coverage.methods} exported API methods.`);
  if (coverage.problems.length > 0) {
    console.error("\nThe inventory does not match the app:");
    for (const problem of coverage.problems) console.error(`  - ${problem}`);
    return 1;
  }

  const cookie = cookieHeader(options.cookie);
  const configurationResponse = await request({ id: "GET /api/auth/config", method: "GET", path: "/api/auth/config", kind: "api" }, options, cookie);
  if (configurationResponse.transportError) {
    console.error(`\nNo server at ${options.baseUrl}: ${configurationResponse.transportError}`);
    console.error("Start the dev server first: pnpm dev");
    return 1;
  }
  const environment = authState(JSON.parse(configurationResponse.body || "{}"), cookie);
  log(
    environment.authEnabled
      ? `Sign-in is configured${environment.hasCookie ? " and a session cookie was supplied." : "; owner routes need --cookie."}`
      : `Sign-in is not configured (${environment.reason ?? "no reason reported"}), so owner routes are expected to answer 503 naming the missing value.`,
  );

  const rows = [];
  for (const entry of ROUTE_INVENTORY) {
    const result = await request(entry, options, cookie);
    rows.push({ entry, result, verdict: classify(entry, result, environment), fingerprint: result.transportError ? "" : fingerprint(result.body, result.contentType) });
  }

  const failures = rows.filter(({ verdict }) => verdict.verdict === "fail");
  const skipped = rows.filter(({ verdict }) => verdict.verdict === "skip");
  const passed = rows.filter(({ verdict }) => verdict.verdict === "pass");

  if (options.json) {
    console.log(JSON.stringify({
      baseUrl: options.baseUrl,
      authEnabled: environment.authEnabled,
      hasCookie: environment.hasCookie,
      rows: rows.map(({ entry, result, verdict, fingerprint: print }) => ({
        id: entry.id,
        path: entry.path,
        status: result.transportError ? null : result.status,
        elapsedMs: Number(result.elapsedMs.toFixed(1)),
        verdict: verdict.verdict,
        outcome: verdict.outcome,
        reason: verdict.reason,
        fingerprint: print,
      })),
      summary: { passed: passed.length, skipped: skipped.length, failed: failures.length },
    }, null, 2));
    return failures.length === 0 && skipped.length === 0 ? 0 : 1;
  }

  console.log();
  printTable(rows);
  printGaps(rows);
  printRefusals(rows);

  console.log(`\n${passed.length} passed · ${skipped.length} not swept · ${failures.length} failed (of ${rows.length})`);
  for (const { entry, verdict, result } of failures) {
    console.error(`  FAIL ${entry.id}: ${verdict.outcome} — ${verdict.reason}${result.transportError ? "" : ` (status ${result.status})`}`);
  }
  for (const { entry, verdict } of skipped) {
    console.error(`  SKIP ${entry.id}: ${verdict.reason}`);
  }
  if (failures.length === 0 && skipped.length === 0) {
    console.log(`Healthy report: every route in the inventory answered 2xx, a missing-configuration 503 naming the cause, or a refusal that wrote nothing.`);
  }
  return failures.length === 0 && skipped.length === 0 ? 0 : 1;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
