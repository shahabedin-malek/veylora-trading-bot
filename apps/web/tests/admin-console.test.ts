import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_SECTIONS,
  ADMIN_SECTIONS_CONFIG,
  adminBalanceRows,
  assetBalance,
  classifyAdminSearch,
  deleteAdminView,
  ledgerCorrectionAuditObject,
  ledgerCorrectionAuditPayload,
  ledgerCorrectionEffectText,
  ledgerCorrectionPostings,
  listAdminViews,
  mergeAdminTimeline,
  parseAdminConsoleQuery,
  reconcileAdminBalances,
  saveAdminView,
  savedViewQuery,
  validateLedgerCorrection,
  type SavedAdminView,
  type SavedViewPersistence,
} from "../src/lib/admin/views";
import {
  ensurePlatformAccounts,
  ensureUserAccount,
  platformAccountCode,
  userAccountCode,
  userBalances,
} from "../src/lib/ledger/accounts";
import { postLedgerTransaction } from "../src/lib/ledger/integer-cent-ledger";
import { balancesForUser } from "../src/lib/ledger/statements";
import { assetBalanceViews } from "../src/lib/portfolio/pnl";
import { InMemoryLedgerStore } from "./support/in-memory-ledger-store";

/**
 * The phase-34 claims, tested where they can be tested without a browser:
 * the section vocabulary, a saved view's round trip and owner isolation, a
 * correction's balance and audit payload, and the console's balance arithmetic
 * being the account page's own.
 */

function memoryViews(): SavedViewPersistence & { rows: SavedAdminView[] } {
  const rows: SavedAdminView[] = [];
  let clock = 0;
  return {
    rows,
    async list(ownerUserId) {
      return rows.filter((row) => row.ownerUserId === ownerUserId).map((row) => ({ ...row }));
    },
    async upsert(input) {
      clock += 1;
      const now = new Date(Date.UTC(2026, 9, 19, 12, 0, clock)).toISOString();
      const existing = rows.find(
        (row) => row.ownerUserId === input.ownerUserId && row.section === input.section && row.name === input.name,
      );
      if (existing) {
        existing.filters = { ...input.filters };
        existing.columns = [...input.columns];
        existing.updatedAt = now;
        return { ...existing };
      }
      const view: SavedAdminView = {
        id: `view-${clock}`,
        ownerUserId: input.ownerUserId,
        name: input.name,
        section: input.section,
        filters: { ...input.filters },
        columns: [...input.columns],
        createdAt: now,
        updatedAt: now,
      };
      rows.push(view);
      return { ...view };
    },
    async delete(ownerUserId, id) {
      const index = rows.findIndex((row) => row.id === id && row.ownerUserId === ownerUserId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

test("every console section exists once and its default columns and filters are real", () => {
  assert.equal(ADMIN_SECTIONS_CONFIG.length, ADMIN_SECTIONS.length);
  assert.equal(new Set(ADMIN_SECTIONS).size, ADMIN_SECTIONS.length);
  for (const section of ADMIN_SECTIONS_CONFIG) {
    assert.ok(section.columns.length > 0, `${section.id} has columns`);
    assert.ok(section.defaultColumns.length > 0, `${section.id} shows something by default`);
    const known = new Set(section.columns.map((column) => column.key));
    for (const column of section.defaultColumns) assert.ok(known.has(column), `${section.id}.${column} is a column`);
    assert.equal(new Set(section.filters.map((filter) => filter.key)).size, section.filters.length);
  }
});

test("an unknown section or column is refused by name, not shown as an empty table", () => {
  const section = parseAdminConsoleQuery({ section: "nope" });
  assert.equal(section.valid, false);
  if (!section.valid) assert.match(section.error, /Unknown section "nope"/);

  const column = parseAdminConsoleQuery({ section: "orders", columns: "market,secret" });
  assert.equal(column.valid, false);
  if (!column.valid) assert.match(column.error, /no column "secret"/);

  const empty = parseAdminConsoleQuery({ section: "orders", columns: "" });
  assert.equal(empty.valid, false);
});

test("a saved view round-trips its filters and columns and is isolated per owner", async () => {
  const persistence = memoryViews();
  const first = await saveAdminView(persistence, {
    ownerUserId: "owner-a",
    name: "Corrections this month",
    section: "ledger",
    filters: { q: "0xabc", asset: "usdt", kind: "admin_correction", from: "2026-10-01", to: "2026-10-19", junk: "dropped" },
    columns: ["occurredAt", "user", "kind", "asset", "amount"],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.view.filters, {
    q: "0xabc",
    asset: "USDT",
    kind: "ADMIN_CORRECTION",
    from: "2026-10-01",
    to: "2026-10-19",
  });
  assert.deepEqual(first.view.columns, ["occurredAt", "user", "kind", "asset", "amount"]);

  const second = await saveAdminView(persistence, {
    ownerUserId: "owner-b",
    name: "Corrections this month",
    section: "ledger",
    filters: { kind: "DEPOSIT_CREDITED" },
    columns: ["occurredAt", "kind"],
  });
  assert.equal(second.ok, true);

  const a = await listAdminViews(persistence, "owner-a", "ledger");
  const b = await listAdminViews(persistence, "owner-b", "ledger");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]!.filters.kind, "ADMIN_CORRECTION");
  assert.equal(b[0]!.filters.kind, "DEPOSIT_CREDITED");
  assert.notEqual(a[0]!.id, b[0]!.id);

  // Saving the same name again updates that view instead of creating a second.
  const updated = await saveAdminView(persistence, {
    ownerUserId: "owner-a",
    name: "  Corrections   this month ",
    section: "ledger",
    filters: { kind: "PERFORMANCE_FEE" },
    columns: ["occurredAt", "kind"],
  });
  assert.equal(updated.ok, true);
  assert.equal((await listAdminViews(persistence, "owner-a")).length, 1);

  const restored = savedViewQuery(a[0]!);
  const parsed = parseAdminConsoleQuery(Object.fromEntries(new URLSearchParams(restored).entries()));
  assert.equal(parsed.valid, true);
  if (parsed.valid) {
    assert.equal(parsed.section.id, "ledger");
    assert.deepEqual(parsed.filters, {
      q: "0xabc",
      asset: "USDT",
      kind: "ADMIN_CORRECTION",
      from: "2026-10-01",
      to: "2026-10-19",
    });
    assert.deepEqual(parsed.columns, ["occurredAt", "user", "kind", "asset", "amount"]);
  }

  assert.equal((await deleteAdminView(persistence, "owner-b", a[0]!.id)).deleted, false);
  assert.equal((await deleteAdminView(persistence, "owner-a", a[0]!.id)).deleted, true);
  assert.equal((await listAdminViews(persistence, "owner-a")).length, 0);
});

test("a correction validates amount, direction, reason and idempotency before anything posts", () => {
  const base = {
    userId: "dev-test-account",
    asset: "usdt",
    decimals: 6,
    amount: "10.5",
    direction: "CREDIT",
    reason: "Correcting a mispriced deposit",
    idempotencyKey: "admin-correction:00000001",
  };
  const valid = validateLedgerCorrection(base);
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.value.asset, "USDT");
    assert.equal(valid.value.amountMinor, "10500000");
  }
  assert.equal(validateLedgerCorrection({ ...base, amount: "0" }).valid, false);
  assert.equal(validateLedgerCorrection({ ...base, amount: "-1" }).valid, false);
  assert.equal(validateLedgerCorrection({ ...base, amount: "1e6" }).valid, false);
  assert.equal(validateLedgerCorrection({ ...base, amount: "1.1234567" }).valid, false);
  assert.equal(validateLedgerCorrection({ ...base, direction: "TRANSFER" }).valid, false);
  assert.equal(validateLedgerCorrection({ ...base, reason: "ab" }).valid, false);
  assert.equal(validateLedgerCorrection({ ...base, idempotencyKey: "short" }).valid, false);
});

test("a correction's two legs balance and its audit payload names actor, target and before/after", () => {
  const postings = ledgerCorrectionPostings({
    direction: "DEBIT",
    amountMinor: "2500000",
    availableAccountId: "available-1",
    treasuryAccountId: "treasury-1",
  });
  assert.deepEqual(postings, [
    { accountId: "available-1", direction: "DEBIT", amountMinor: "2500000" },
    { accountId: "treasury-1", direction: "CREDIT", amountMinor: "2500000" },
  ]);

  const payload = JSON.parse(
    ledgerCorrectionAuditPayload({
      actorUserId: "dev-owner-user",
      targetUserId: "dev-test-account",
      userLabel: "0x2222222222222222222222222222222222222222",
      asset: "USDT",
      amount: "2.5",
      amountMinor: "2500000",
      direction: "DEBIT",
      reason: "Correcting a mispriced deposit",
      transactionId: "tx-1",
      availableAccountCode: "user:dev-test-account:USDT:available",
      treasuryAccountCode: "platform:treasury:USDT",
      before: { available: "10", total: "10" },
      after: { available: "7.5", total: "7.5" },
    }),
  ) as Record<string, unknown>;
  assert.equal((payload.actor as { id: string }).id, "dev-owner-user");
  assert.equal((payload.target as { id: string }).id, "dev-test-account");
  assert.equal((payload.before as { available: string }).available, "10");
  assert.equal((payload.after as { available: string }).available, "7.5");
  assert.equal(payload.reason, "Correcting a mispriced deposit");

  // The event points at the account, which is what puts it on that account's
  // timeline; the ledger transaction it posted is in the payload instead.
  assert.deepEqual(ledgerCorrectionAuditObject("dev-test-account"), {
    objectType: "User",
    objectId: "dev-test-account",
  });

  const effect = ledgerCorrectionEffectText({
    value: {
      userId: "dev-test-account",
      asset: "USDT",
      decimals: 6,
      amount: "2.5",
      amountMinor: "2500000",
      direction: "DEBIT",
      reason: "Correcting a mispriced deposit",
      idempotencyKey: "admin-correction:00000001",
    },
    userLabel: "0x2222…2222",
    beforeAvailable: "10",
    beforeTotal: "10",
  });
  assert.match(effect, /ADMIN_CORRECTION/);
  assert.match(effect, /10 USDT/);
  assert.match(effect, /audit/);
});

test("console balances are the account page's derived balances and reconcile after a correction", async () => {
  const store = new InMemoryLedgerStore();
  await ensureUserAccount(store, { userId: "user-1", asset: "USDT", decimals: 6 });
  await ensurePlatformAccounts(store, { asset: "USDT", decimals: 6 });
  const available = await store.findAccountByCode(userAccountCode("user-1", "USDT"));
  const treasury = await store.findAccountByCode(platformAccountCode("TREASURY", "USDT"));
  assert.ok(available && treasury);

  await postLedgerTransaction(store, {
    kind: "DEPOSIT_CREDITED",
    idempotencyKey: "test:deposit",
    occurredAt: new Date("2026-10-19T10:00:00.000Z"),
    postings: [
      { accountId: available.id, direction: "CREDIT", amountMinor: "10000000" },
      { accountId: treasury.id, direction: "DEBIT", amountMinor: "10000000" },
    ],
  });
  await postLedgerTransaction(store, {
    kind: "ADMIN_CORRECTION",
    idempotencyKey: "test:correction",
    occurredAt: new Date("2026-10-19T11:00:00.000Z"),
    postings: ledgerCorrectionPostings({
      direction: "DEBIT",
      amountMinor: "2500000",
      availableAccountId: available.id,
      treasuryAccountId: treasury.id,
    }),
  });

  const balances = await balancesForUser(store, "user-1");
  const consoleRows = adminBalanceRows({ userId: "user-1", userLabel: "0x1111…1111", balances });
  const reconciliation = reconcileAdminBalances({ consoleRows, accountBalances: balances });
  assert.equal(reconciliation.ok, true, reconciliation.differences.join(" "));
  assert.equal(consoleRows.length, 1);
  assert.equal(consoleRows[0]!.asset, "USDT");
  assert.equal(consoleRows[0]!.available, "7.5");
  assert.equal(consoleRows[0]!.total, "7.5");

  // The same rows `/account` renders, from the same derived balances.
  const accountRows = assetBalanceViews(userBalances(balances));
  assert.deepEqual(
    accountRows.map((row) => [row.asset, row.availableMinor, row.heldMinor, row.totalMinor]),
    consoleRows.map((row) => [row.asset, row.availableMinor, row.heldMinor, row.totalMinor]),
  );
  assert.deepEqual(assetBalance(balances, "USDT"), {
    available: "7.5",
    availableMinor: "7500000",
    total: "7.5",
    totalMinor: "7500000",
  });
});

test("search describes the term it was given, and the timeline merges newest first", () => {
  assert.deepEqual(classifyAdminSearch("0x2222222222222222222222222222222222222222"), {
    kind: "wallet",
    value: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(classifyAdminSearch(`0x${"a".repeat(64)}`).kind, "transaction");
  assert.equal(classifyAdminSearch("dev-order-0001").kind, "order");
  assert.equal(classifyAdminSearch("dev-test-account").kind, "identifier");

  const merged = mergeAdminTimeline([
    { id: "a", category: "audit", occurredAt: "2026-10-19T10:00:00.000Z", title: "A", detail: "", source: "" },
    { id: "b", category: "ledger", occurredAt: "2026-10-19T12:00:00.000Z", title: "B", detail: "", source: "" },
    { id: "c", category: "decision", occurredAt: "2026-10-19T11:00:00.000Z", title: "C", detail: "", source: "" },
  ]);
  assert.deepEqual(merged.map((item) => item.id), ["b", "c", "a"]);
});
