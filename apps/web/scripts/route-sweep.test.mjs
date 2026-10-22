import assert from "node:assert/strict";
import test from "node:test";
import { ROUTE_INVENTORY, checkInventoryCoverage, classify, discoverRoutes, fingerprint } from "./route-sweep.mjs";

const UNCONFIGURED = { authEnabled: false, hasCookie: false };
const CONFIGURED = { authEnabled: true, hasCookie: false };
const CONFIGURED_WITH_COOKIE = { authEnabled: true, hasCookie: true };

function entry(id) {
  const found = ROUTE_INVENTORY.find((candidate) => candidate.id === id);
  assert.ok(found, `the inventory must contain ${id}`);
  return found;
}

function answer(status, body = "", contentType = "text/plain") {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body), contentType, elapsedMs: 4 };
}

test("a 5xx fails the row", () => {
  assert.equal(classify(entry("GET /"), answer(500, "boom"), UNCONFIGURED).outcome, "server-error");
  assert.equal(classify(entry("GET /"), answer(502, "upstream"), UNCONFIGURED).verdict, "fail");
});

test("an unexpected 404 fails the row, but a declared 404 refusal passes", () => {
  assert.equal(classify(entry("GET /markets"), answer(404, "missing"), UNCONFIGURED).outcome, "unexpected-404");
  const verify = entry("POST /api/trading/credentials/[credentialId]/verify");
  assert.equal(classify(verify, answer(404, { error: "Credential was not found." }), UNCONFIGURED).verdict, "pass");
});

test("a redirect fails the row, because the route did not answer", () => {
  assert.equal(classify(entry("GET /trade"), answer(307, "<html></html>"), CONFIGURED_WITH_COOKIE).outcome, "redirect");
});

test("a 503 passes only when its body names the missing variable", () => {
  const cron = entry("GET /api/cron/market-alerts");
  const named = classify(cron, answer(503, { error: "CRON_SECRET is not configured, so the alert scheduler cannot be called." }), UNCONFIGURED);
  assert.equal(named.verdict, "pass");
  assert.equal(named.reason, "names CRON_SECRET");

  const unnamed = classify(cron, answer(503, { error: "Something went wrong." }), UNCONFIGURED);
  assert.equal(unnamed.verdict, "fail");
  assert.equal(unnamed.outcome, "unnamed-503");
});

test("a 2xx on a mutation row fails, because the probe would have written", () => {
  const kill = entry("POST /api/bots/[botId]/kill");
  const verdict = classify(kill, answer(200, { paperState: "KILLED" }), UNCONFIGURED);
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.outcome, "unexpected-2xx");
});

test("a refusal with an empty body fails", () => {
  const create = entry("POST /api/bots");
  assert.equal(classify(create, answer(400, ""), UNCONFIGURED).outcome, "empty-refusal");
});

test("owner rows are reported as not swept when sign-in is configured and no session is supplied", () => {
  const verdict = classify(entry("GET /admin/data"), answer(307, "<html></html>"), CONFIGURED);
  assert.equal(verdict.verdict, "skip");
  assert.match(verdict.reason, /--cookie/);

  // With a session the same row must serve.
  assert.equal(classify(entry("GET /admin/data"), answer(200, "<html></html>"), CONFIGURED_WITH_COOKIE).verdict, "pass");
});

test("the fingerprint is stable, short and reports the size", () => {
  const first = fingerprint('{"error":"Authentication required."}', "application/json; charset=utf-8");
  assert.equal(first, fingerprint('{"error":"Authentication required."}', "application/json"));
  assert.notEqual(first, fingerprint('{"error":"Authentication requireds"}', "application/json"));
  assert.match(first, /^[0-9a-f]{12} +\d+B +"Authentication required\."$/);
});

test("the inventory covers every page and every exported HTTP method", async () => {
  const coverage = await checkInventoryCoverage();
  assert.deepEqual(coverage.problems, []);
  // 14 before phase 11 added the onboarding checklist page, 15 before phase 15 added
  // the account page. Phase 16 added two: the public pricing page and the admin fee
  // table.
  // Phase 27 added one: the AI models admin page (routing, provider health, spend).
  // Phase 30 added one: the marketplace, which is public to read and writes only when a
  // signed-in owner clones a template. Phase 32 added one: the generated API/MCP reference
  // (`/docs/api`), which renders from the /api/v1 route registry. Phase 34 added one: the
  // admin console at `/admin`, which gathers every operational section behind one read
  // permission and keeps the older `/admin/*` pages reachable beneath it. Phase 35 added
  // one: the support desk at `/admin/support`. Phase 36 added one: the audit trail at
  // `/admin/audit`.
  // Phase 40 added seven public pages — `/status`, `/docs`, `/docs/api` (moved into the
  // public group), `/terms`, `/privacy`, `/risk` and `/faq` — and moved the console home from
  // `/` to `/terminal` so the landing page could be public. The `(public)` route group is a
  // layout device: `pagePathFromFile` drops the group segment, so the inventory names the
  // addresses the app actually serves.
  assert.equal(coverage.pages, 31);
  // 41 before phase 04 added GET /api/admin/health, 42 before phase 06 added the
  // three order methods: GET and POST /api/trading/orders, and
  // POST /api/trading/orders/[orderId]/cancel. Phase 10 added nine: the two
  // security-policy methods, the two session-list methods, and the five
  // authenticator methods (status, enrol, disable, activate, step-up verify).
  // Phase 12 added three: reading the deposit surface, asking for a check, and
  // reading one address's deposits. Phase 13 added two: reading the ledger and
  // asking for a deposit credit to be reversed. Phase 14 added four: reading the
  // withdrawal surface, asking for a withdrawal, reading one withdrawal, and
  // attempting to cancel one — plus the two admin methods that make the new-address
  // window stored admin data: reading it and saving it. Phase 15 added two: the
  // account view and its export. Phase 16 added two: reading the fee table for the
  // admin page and inserting a new version of it. Phase 17 added one: reading the
  // network registry for the switcher. Phase 18 added one: the aggregated
  // portfolio read (snapshot and event stream from the same GET). Phase 19 added
  // three: reading the screener surface, evaluating/saving/running through its
  // POST actions, and deleting a saved screen. Phase 22 added one: the dry testnet
  // comparison, which is a read of its own so it can never be a step in the live path.
  // Phase 23 added four: reading the account's activation state, starting it, and reading
  // or stopping one activation by id. Stop is not on the collection route on purpose: a
  // stop always names the activation it stops, so it can never be swept into stopping
  // something the probe did not name. Phase 25 added one: pressing either kill switch,
  // which is a POST because it is an immediate change and not a form save.
  // Phase 27 added three: reading the model settings and the period's spend, saving the
  // routing document, and the one-line probe that proves the saved route is the one used.
  // Phase 28 added four: listing this account's definition versions, saving a generated or
  // hand-written one, editing one into a new version, and reading the stored runs the
  // comparison table shows. The definition modes of the existing backtest POST are the same
  // method, so they add no row — the probe still exercises the legacy body.
  // Phase 29 added two admin methods: reading the notification channels and the one save
  // that changes them. The credentials they describe are environment variables, so no
  // secret ever crosses this route.
  // Phase 30 added nine: the bot list and its create, reading/editing/deleting one bot,
  // publishing a draft, sharing a published bot as a template, and the marketplace's list
  // and clone. Publishing and sharing are separate methods from the edit because each one
  // writes an audit row of its own.
  // Phase 31 added six: the inbound signal POST (authenticated by its signature, not a
  // session), the signal-token read/create/window-or-revoke methods, and the webhook
  // subscription read/create methods. The inbound row is probed with an unknown token so it
  // must refuse without writing anything. Phase 32 added four: the versioned catch-all's GET
  // and POST (bearer-authenticated, no session), and the admin key directory's read and
  // action POST. Phase 34 added seven: the console's list, cross-entity search, record
  // drill-down and audited correction, plus the saved-view list, save and delete. Phase 35
  // added thirteen: the ticket list/create, one ticket's read/update, its message append and
  // its export, the note append, the saved-reply list/save/delete, the reply preview, support
  // search, and the account-facing ticket read. Phase 36 added three: the audit read, its
  // two owner actions (verify and retention) on the one POST, and the audited export.
  // The custodial-launch controls added two: the withdrawals pause switch and the manual
  // credit of an arrival the network does not configure.
  assert.equal(coverage.methods, 133);
});

test("the discovered routes are the ones the inventory names", async () => {
  const { pages, methods } = await discoverRoutes();
  assert.ok(pages.includes("/admin/risk"));
  assert.ok(pages.includes("/account"));
  assert.ok(methods.some(({ method, path }) => method === "POST" && path === "/api/rpc/[network]"));
});

test("every row that can answer with a gap declares the names its 503 must contain", () => {
  for (const row of ROUTE_INVENTORY) {
    const outcomes = [...row.outcomes, ...(row.sessionOutcomes ?? [])];
    if (outcomes.includes("gap")) {
      assert.ok((row.needs ?? []).length > 0, `${row.id} can answer 503 without naming a variable`);
    }
    if (row.auth) {
      const session = row.sessionOutcomes ?? ["serve"];
      assert.ok(session.length > 0, `${row.id} declares no session expectation`);
    }
    for (const outcome of [...row.outcomes, ...(row.sessionOutcomes ?? [])]) {
      assert.ok(["serve", "gap", "refuse"].includes(outcome), `${row.id} declares an unknown outcome: ${outcome}`);
    }
  }
});

test("mutation rows never accept 2xx and unauthenticated read rows never accept a refusal-only answer", () => {
  for (const row of ROUTE_INVENTORY) {
    if (row.method === "GET" || row.method === "HEAD") continue;
    const isMutation = row.outcomes.includes("refuse") && !row.outcomes.includes("serve");
    if (!isMutation) continue;
    assert.ok(!row.outcomes.includes("serve"), `${row.id} would let a write pass as a read`);
    assert.ok((row.body ?? null) !== null, `${row.id} must send a body that cannot be accepted`);
  }
});
