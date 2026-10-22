import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTicketExport,
  findSecretMaterial,
  redactSecretMaterial,
  renderSavedReply,
  ticketExportFilename,
  ticketStatusAuditPayload,
  userTicketView,
  validateMessageDraft,
  validateSavedReplyDraft,
  validateTicketDraft,
  validateTicketLink,
  visibleToUser,
  type TicketMessageRecord,
  type TicketRecord,
  type UserNoteRecord,
} from "../src/lib/support/tickets";
import { buildUserTimeline, type UserTimelineSources } from "../src/lib/support/timeline";

/**
 * The phase-35 claims, tested without a database or a browser:
 *
 *  - an internal message never reaches the account's view;
 *  - a saved reply inserts that account's real details;
 *  - a status change carries before and after;
 *  - an export contains the thread and no credential material;
 *  - the merged timeline orders a sign-in, deposit, trade, withdrawal and support
 *    message by time and links each one to its record.
 */

const AT = (hour: number, minute = 0) => new Date(Date.UTC(2026, 0, 1, hour, minute));

const TICKET: TicketRecord = {
  id: "dev-ticket-latency",
  userId: "dev-test-account",
  subject: "Deposit did not arrive",
  status: "OPEN",
  priority: "HIGH",
  assigneeUserId: "dev-owner-user",
  relatedType: "deposit",
  relatedId: "dev-deposit-seed",
  createdAt: AT(13),
  updatedAt: AT(13, 10),
  lastMessageAt: AT(13, 10),
  closedAt: null,
};

function message(overrides: Partial<TicketMessageRecord>): TicketMessageRecord {
  return {
    id: "msg-1",
    ticketId: TICKET.id,
    authorType: "USER",
    authorUserId: "dev-test-account",
    visibility: "PUBLIC",
    body: "My 25 USDT deposit is not showing.",
    createdAt: AT(13),
    ...overrides,
  };
}

test("an internal message is absent from the account's view, and notes are never even passed to it", () => {
  const messages = [
    message({ id: "public-1", visibility: "PUBLIC", body: "My deposit is missing." }),
    message({ id: "internal-1", visibility: "INTERNAL", authorType: "STAFF", body: "Checked with the watcher; the operator should re-run the scan." }),
    message({ id: "public-2", visibility: "PUBLIC", authorType: "STAFF", body: "We are checking the watcher now." }),
  ];
  const visible = visibleToUser(messages);
  assert.deepEqual(visible.map((entry) => entry.id), ["public-1", "public-2"]);

  const view = userTicketView(TICKET, messages);
  const serialised = JSON.stringify(view);
  assert.equal(serialised.includes("re-run the scan"), false);
  assert.equal(serialised.includes("internal-1"), false);
  assert.equal(view.messages.length, 2);
});

test("a saved reply inserts the account's real details and an unknown placeholder is refused", () => {
  const rendered = renderSavedReply(
    "Hi {{user.label}} ({{user.id}}, {{user.role}}): {{account.summary}}. Ticket {{ticket.id}} — {{ticket.subject}}. — {{operator.label}}",
    {
      "user.label": "0x2222222222222222222222222222222222222222",
      "user.id": "dev-test-account",
      "user.role": "TRADER",
      "account.summary": "25 USDT available / 25 total",
      "ticket.id": "dev-ticket-latency",
      "ticket.subject": "Deposit did not arrive",
      "operator.label": "0x1111111111111111111111111111111111111111",
    },
  );
  assert.match(rendered, /0x2222222222222222222222222222222222222222 \(dev-test-account, TRADER\)/);
  assert.match(rendered, /25 USDT available \/ 25 total/);
  assert.match(rendered, /Ticket dev-ticket-latency — Deposit did not arrive/);
  assert.equal(rendered.includes("{{"), false);

  // A field the caller does not have is visibly missing, never literal braces.
  assert.equal(renderSavedReply("Hi {{user.label}}", {}), "Hi —");

  const unknown = validateSavedReplyDraft({ name: "Deposit reply", body: "Hi {{user.nickname}}" });
  assert.equal(unknown.valid, false);
  if (!unknown.valid) assert.match(unknown.error, /Unknown placeholder \{\{user\.nickname\}\}/);

  const valid = validateSavedReplyDraft({
    name: "Deposit received",
    body: "Hi {{user.label}}, {{account.summary}} is on the account. Ticket {{ticket.id}}.",
  });
  assert.equal(valid.valid, true);
});

test("a status change is audited with actor, ticket, previous and next status", () => {
  const payload = JSON.parse(
    ticketStatusAuditPayload({
      actorUserId: "dev-owner-user",
      ticketId: TICKET.id,
      subject: TICKET.subject,
      previousStatus: "OPEN",
      nextStatus: "RESOLVED",
      priority: "HIGH",
      assigneeUserId: "dev-owner-user",
      reason: "Deposit credited and confirmed with the account",
    }),
  ) as Record<string, unknown>;
  assert.deepEqual(payload.actor, { type: "User", id: "dev-owner-user" });
  assert.deepEqual(payload.target, { type: "SupportTicket", id: TICKET.id, label: TICKET.subject });
  assert.equal(payload.previousStatus, "OPEN");
  assert.equal(payload.nextStatus, "RESOLVED");
  assert.equal(payload.reason, "Deposit credited and confirmed with the account");
});

test("a credential is refused on write and redacted out of an export", () => {
  const secretBody = "Here is the API key: sk_live_51H8xQ2abcdefghijklmnop and password: hunter2hunter2";
  assert.ok(findSecretMaterial(secretBody).length > 0);
  const refusal = validateMessageDraft({ body: secretBody, visibility: "PUBLIC" });
  assert.equal(refusal.valid, false);
  if (!refusal.valid) {
    assert.match(refusal.error, /credential/);
    assert.equal(refusal.error.includes("sk_live_51H8xQ2abcdefghijklmnop"), false, "the refusal must not echo the key");
  }

  const content = buildTicketExport({
    ticket: TICKET,
    messages: [
      message({ id: "public-1", body: "My deposit is missing." }),
      message({ id: "internal-1", visibility: "INTERNAL", authorType: "STAFF", body: secretBody }),
    ],
    notes: [{ id: "note-1", userId: TICKET.userId, authorUserId: "dev-owner-user", body: `Seen: ${secretBody}`, createdAt: AT(14) } satisfies UserNoteRecord],
    accountLabel: "0x2222222222222222222222222222222222222222",
    assigneeLabel: "0x1111111111111111111111111111111111111111",
    exportedBy: "0x1111111111111111111111111111111111111111",
    exportedAt: AT(15),
  });
  assert.match(content, /## Thread/);
  assert.match(content, /My deposit is missing\./);
  assert.match(content, /INTERNAL — not sent to the account/);
  assert.match(content, /## Internal notes \(never sent to the account\)/);
  assert.equal(content.includes("sk_live_51H8xQ2abcdefghijklmnop"), false);
  assert.equal(content.includes("hunter2hunter2"), false);
  assert.match(content, /\[redacted: payment key\]/);
  assert.match(content, /\[redacted: assigned credential\]/);
  assert.equal(redactSecretMaterial("Bearer abcdefghijklmnopqrstuvwxyz012345"), "[redacted: bearer token]");
  // A short password is still a credential: an export from a row written before
  // the refusal existed must not carry it just because it is seven characters.
  assert.equal(redactSecretMaterial("password=hunter2").includes("hunter2"), false);
  assert.equal(ticketExportFilename(TICKET).startsWith("ticket-dev-ticket-latency-deposit-did-not-arrive"), true);
});

test("a ticket draft names its account, priority and linked record, and a half link is refused", () => {
  const valid = validateTicketDraft({
    userId: "dev-test-account",
    subject: "  Deposit did not arrive  ",
    priority: "high",
    relatedType: "deposit",
    relatedId: "dev-deposit-seed",
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.value.subject, "Deposit did not arrive");
    assert.equal(valid.value.priority, "HIGH");
    assert.equal(valid.value.relatedType, "deposit");
  }
  const half = validateTicketLink({ relatedType: "deposit" });
  assert.equal(half.valid, false);
  if (!half.valid) assert.match(half.error, /both its type/);
  assert.equal(validateTicketLink({ relatedType: "wallet", relatedId: "x" }).valid, false);
  assert.equal(validateTicketDraft({ userId: "dev-test-account", subject: "hi" }).valid, false);
});

test("the account timeline orders sign-in, deposit, trade, withdrawal and support by time and links each record", () => {
  const sources: UserTimelineSources = {
    ledger: [
      {
        id: "entry-1",
        amountMinor: "25000000",
        asset: "USDT",
        direction: "CREDIT",
        accountCode: "user:dev-test-account:USDT:available",
        decimals: 6,
        kind: "DEPOSIT_CREDITED",
        occurredAt: AT(9, 1),
        memo: "Seed deposit",
      },
    ],
    sessions: [{ id: "dev-session-seed", deviceLabel: "MetaMask · Chrome on Linux", createdAt: AT(8), lastSeenAt: AT(13), revokedAt: null }],
    deposits: [
      {
        id: "dev-deposit-seed",
        network: "ethereum",
        tokenSymbol: "USDT",
        amount: "25",
        status: "CREDITED",
        txHash: `0x${"a".repeat(64)}`,
        observedAt: AT(9),
      },
    ],
    withdrawals: [
      {
        id: "dev-withdrawal-seed",
        asset: "USDT",
        decimals: 6,
        netMinor: "5000000",
        status: "QUEUED",
        txHash: null,
        createdAt: AT(12),
      },
    ],
    orders: [
      { id: "dev-order-0001", market: "BTC-USD", side: "BUY", status: "FILLED", notionalUsdCents: 50_000, createdAt: AT(10) },
    ],
    decisions: [
      {
        id: "dev-decision-seed",
        activationId: "dev-strategy-activation",
        outcome: "NO_ACTION",
        reasonCode: "RSI_NOT_CROSSED",
        reasonMessage: "RSI 48.2 is below the 55 entry threshold.",
        market: "BTC-USD",
        evaluatedAt: AT(10, 30),
      },
    ],
    deliveries: [
      { id: "dev-delivery-seed", channel: "EMAIL", status: "DELIVERED", subject: "BTC-USD alert", error: null, createdAt: AT(11) },
    ],
    audits: [
      {
        id: "dev-audit-order-0001-created",
        action: "ORDER_CREATED",
        objectType: "TradeOrder",
        objectId: "dev-order-0001",
        outcome: "SUCCESS",
        occurredAt: AT(10),
      },
    ],
    tickets: [{ id: TICKET.id, subject: TICKET.subject, status: TICKET.status, priority: TICKET.priority }],
    messages: [
      {
        id: "support-msg-1",
        ticketId: TICKET.id,
        authorType: "USER",
        visibility: "PUBLIC",
        body: "My deposit is missing.",
        createdAt: AT(13),
      },
      {
        id: "support-msg-2",
        ticketId: TICKET.id,
        authorType: "STAFF",
        visibility: "INTERNAL",
        body: "Watcher re-run needed.",
        createdAt: AT(13, 5),
      },
    ],
    notes: [{ id: "note-1", body: "Known watcher lag.", authorUserId: "dev-owner-user", createdAt: AT(13, 10) }],
  };

  const { timeline, counts } = buildUserTimeline("dev-test-account", sources);
  const order = timeline.map((item) => item.category);
  // Newest first, and every source appears.
  assert.deepEqual(order, [
    "note",
    "support",
    "support",
    "withdrawal",
    "delivery",
    "decision",
    "trade",
    "audit",
    "ledger",
    "deposit",
    "signin",
  ]);
  assert.deepEqual(
    timeline.map((item) => item.record),
    [
      { type: "user", id: "dev-test-account" },
      { type: "ticket", id: TICKET.id },
      { type: "ticket", id: TICKET.id },
      { type: "withdrawal", id: "dev-withdrawal-seed" },
      { type: "delivery", id: "dev-delivery-seed" },
      { type: "strategy", id: "dev-strategy-activation" },
      { type: "order", id: "dev-order-0001" },
      { type: "order", id: "dev-order-0001" },
      { type: "ledger-entry", id: "entry-1" },
      { type: "deposit", id: "dev-deposit-seed" },
      { type: "session", id: "dev-session-seed" },
    ],
  );
  assert.equal(timeline.filter((item) => item.category === "support")[0]!.title.startsWith("Internal note"), true);
  assert.equal(counts.signins, 1);
  assert.equal(counts.deposits, 1);
  assert.equal(counts.withdrawals, 1);
  assert.equal(counts.trades, 1);
  assert.equal(counts.support, 3);
});
