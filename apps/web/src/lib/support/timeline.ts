import { prisma } from "@/lib/db";
import { mergeAdminTimeline, type AdminRecordType, type AdminTimelineItem } from "@/lib/admin/views";
import { minorToDecimal } from "@/lib/fees/amounts";
import { redactSecretMaterial } from "@/lib/support/tickets";

/**
 * One account's whole story, in time order (phase 35).
 *
 * Before this phase the admin timeline knew about ledger entries, strategy
 * decisions, notification deliveries and audit rows. That left out the events an
 * operator actually asks about first: when this person signed in, what money
 * arrived, what they asked to withdraw, what they traded, and what they told
 * support. Those are the rows added here.
 *
 * Two properties matter and both are tested without a database:
 *
 *  - **Every item links to its record.** A sign-in links to its session, a deposit
 *    to the deposit, a trade to the order, a support message to its ticket. The
 *    panel turns that into an Open button, so a timeline is a way into the record
 *    rather than a dead end.
 *  - **Internal material is labelled, and secret material is redacted.** An
 *    internal ticket message appears on the operator's timeline marked INTERNAL;
 *    the account's own endpoint never sees it. Message bodies pass through
 *    {@link redactSecretMaterial} here as a second line of defence behind the
 *    write-time refusal.
 *
 * The queries are bounded: each source is capped, and a timeline is a recent
 * history, not an export.
 */

const MAX_PER_SOURCE = 50;
const SNIPPET = 160;

export type UserTimelineSources = {
  ledger: {
    id: string;
    amountMinor: string;
    asset: string;
    direction: string;
    accountCode: string;
    decimals: number;
    kind: string;
    occurredAt: Date;
    memo: string | null;
  }[];
  sessions: { id: string; deviceLabel: string; createdAt: Date; lastSeenAt: Date; revokedAt: Date | null }[];
  deposits: {
    id: string;
    network: string;
    tokenSymbol: string;
    amount: string;
    status: string;
    txHash: string;
    observedAt: Date;
  }[];
  withdrawals: {
    id: string;
    asset: string;
    decimals: number;
    netMinor: string;
    status: string;
    txHash: string | null;
    createdAt: Date;
  }[];
  orders: {
    id: string;
    market: string;
    side: string;
    status: string;
    notionalUsdCents: number;
    createdAt: Date;
  }[];
  decisions: {
    id: string;
    activationId: string;
    outcome: string;
    reasonCode: string;
    reasonMessage: string;
    market: string | null;
    evaluatedAt: Date;
  }[];
  deliveries: { id: string; channel: string; status: string; subject: string; error: string | null; createdAt: Date }[];
  audits: {
    id: string;
    action: string;
    objectType: string;
    objectId: string | null;
    outcome: string;
    occurredAt: Date;
  }[];
  tickets: { id: string; subject: string; status: string; priority: string }[];
  messages: {
    id: string;
    ticketId: string;
    authorType: string;
    visibility: string;
    body: string;
    createdAt: Date;
  }[];
  notes: { id: string; body: string; authorUserId: string; createdAt: Date }[];
};

export type UserTimelineCounts = {
  ledger: number;
  decisions: number;
  deliveries: number;
  audit: number;
  signins: number;
  deposits: number;
  withdrawals: number;
  trades: number;
  support: number;
};

function snippet(text: string): string {
  const redacted = redactSecretMaterial(text).replace(/\s+/g, " ").trim();
  return redacted.length > SNIPPET ? `${redacted.slice(0, SNIPPET - 1)}…` : redacted;
}

/** The record an audit row points at, when that record is one the console can open. */
export function auditRecordLink(objectType: string, objectId: string | null): { type: AdminRecordType; id: string } | null {
  if (!objectId) return null;
  const map: Record<string, AdminRecordType> = {
    TradeOrder: "order",
    Withdrawal: "withdrawal",
    StrategyActivation: "strategy",
    Deposit: "deposit",
    SupportTicket: "ticket",
    User: "user",
    LedgerTransaction: "ledger-entry",
    WalletIdentity: "wallet",
  };
  const type = map[objectType];
  return type ? { type, id: objectId } : null;
}

export function buildUserTimeline(
  subjectUserId: string,
  sources: UserTimelineSources,
): {
  timeline: AdminTimelineItem[];
  counts: UserTimelineCounts;
} {
  const ticketById = new Map(sources.tickets.map((ticket) => [ticket.id, ticket]));
  const timeline: AdminTimelineItem[] = [
    ...sources.ledger.map((entry) => ({
      id: `ledger:${entry.id}`,
      category: "ledger" as const,
      occurredAt: entry.occurredAt.toISOString(),
      title: `${entry.kind} · ${entry.direction} ${minorToDecimal(BigInt(entry.amountMinor), entry.decimals)} ${entry.asset}`,
      detail: entry.memo ?? entry.accountCode,
      source: entry.accountCode,
      record: { type: "ledger-entry" as const, id: entry.id },
    })),
    ...sources.sessions.map((session) => ({
      id: `signin:${session.id}`,
      category: "signin" as const,
      occurredAt: session.createdAt.toISOString(),
      title: `Signed in · ${session.deviceLabel}`,
      detail: session.revokedAt ? "This session has been revoked." : `Last seen ${session.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      source: "session",
      record: { type: "session" as const, id: session.id },
    })),
    ...sources.deposits.map((deposit) => ({
      id: `deposit:${deposit.id}`,
      category: "deposit" as const,
      occurredAt: deposit.observedAt.toISOString(),
      title: `Deposit · ${deposit.amount} ${deposit.tokenSymbol} · ${deposit.status}`,
      detail: `${deposit.network} · ${deposit.txHash}`,
      source: "chain",
      record: { type: "deposit" as const, id: deposit.id },
    })),
    ...sources.withdrawals.map((withdrawal) => ({
      id: `withdrawal:${withdrawal.id}`,
      category: "withdrawal" as const,
      occurredAt: withdrawal.createdAt.toISOString(),
      title: `Withdrawal · ${minorToDecimal(BigInt(withdrawal.netMinor), withdrawal.decimals)} ${withdrawal.asset} · ${withdrawal.status}`,
      detail: withdrawal.txHash ?? "not broadcast",
      source: "withdrawal",
      record: { type: "withdrawal" as const, id: withdrawal.id },
    })),
    ...sources.orders.map((order) => ({
      id: `trade:${order.id}`,
      category: "trade" as const,
      occurredAt: order.createdAt.toISOString(),
      title: `${order.market} ${order.side} · ${order.status}`,
      detail: `${(order.notionalUsdCents / 100).toFixed(2)} USD notional`,
      source: "order",
      record: { type: "order" as const, id: order.id },
    })),
    ...sources.decisions.map((decision) => ({
      id: `decision:${decision.id}`,
      category: "decision" as const,
      occurredAt: decision.evaluatedAt.toISOString(),
      title: `Strategy ${decision.outcome}${decision.market ? ` · ${decision.market}` : ""}`,
      detail: decision.reasonMessage,
      source: decision.reasonCode,
      record: { type: "strategy" as const, id: decision.activationId },
    })),
    ...sources.deliveries.map((delivery) => ({
      id: `delivery:${delivery.id}`,
      category: "delivery" as const,
      occurredAt: delivery.createdAt.toISOString(),
      title: `${delivery.channel} ${delivery.status}`,
      detail: delivery.error ?? delivery.subject,
      source: "notification",
      record: { type: "delivery" as const, id: delivery.id },
    })),
    ...sources.audits.map((audit) => ({
      id: `audit:${audit.id}`,
      category: "audit" as const,
      occurredAt: audit.occurredAt.toISOString(),
      title: audit.action,
      detail: `${audit.objectType} ${audit.objectId ?? ""} · ${audit.outcome}`,
      source: "audit",
      record: auditRecordLink(audit.objectType, audit.objectId) ?? undefined,
    })),
    ...sources.messages.map((message) => {
      const ticket = ticketById.get(message.ticketId);
      return {
        id: `support:${message.id}`,
        category: "support" as const,
        occurredAt: message.createdAt.toISOString(),
        title: `${message.visibility === "INTERNAL" ? "Internal note" : "Support message"} · ${ticket?.subject ?? message.ticketId}`,
        detail: snippet(message.body),
        source: `${message.authorType} · ${message.visibility}`,
        record: { type: "ticket" as const, id: message.ticketId },
      };
    }),
    ...sources.notes.map((note) => ({
      id: `note:${note.id}`,
      category: "note" as const,
      occurredAt: note.createdAt.toISOString(),
      title: "Internal note on the account",
      detail: snippet(note.body),
      source: `author ${note.authorUserId}`,
      record: { type: "user" as const, id: subjectUserId },
    })),
  ];
  return {
    timeline: mergeAdminTimeline(timeline),
    counts: {
      ledger: sources.ledger.length,
      decisions: sources.decisions.length,
      deliveries: sources.deliveries.length,
      audit: sources.audits.length,
      signins: sources.sessions.length,
      deposits: sources.deposits.length,
      withdrawals: sources.withdrawals.length,
      trades: sources.orders.length,
      support: sources.messages.length + sources.notes.length,
    },
  };
}

/**
 * Read one account's timeline. Each source is capped, and the whole read is one
 * round of parallel queries rather than one per event.
 */
export async function loadUserTimeline(userId: string): Promise<{
  timeline: AdminTimelineItem[];
  counts: UserTimelineCounts;
}> {
  const accounts = await prisma.ledgerAccount.findMany({ where: { userId }, select: { id: true, code: true } });
  const [ledgerEntries, sessions, deposits, withdrawals, orders, decisions, deliveries, audits, tickets, notes] =
    await Promise.all([
      accounts.length === 0
        ? Promise.resolve([])
        : prisma.ledgerEntry.findMany({
            where: { accountId: { in: accounts.map((account) => account.id) } },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: {
              id: true,
              amountMinor: true,
              asset: true,
              direction: true,
              account: { select: { code: true, decimals: true } },
              transaction: { select: { kind: true, occurredAt: true, memo: true } },
            },
          }),
      prisma.authSession.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, deviceLabel: true, createdAt: true, lastSeenAt: true, revokedAt: true },
      }),
      prisma.deposit.findMany({
        where: { userId },
        orderBy: { observedAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, network: true, tokenSymbol: true, amount: true, status: true, txHash: true, observedAt: true },
      }),
      prisma.withdrawal.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, asset: true, decimals: true, netMinor: true, status: true, txHash: true, createdAt: true },
      }),
      prisma.tradeOrder.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, market: true, side: true, status: true, notionalUsdCents: true, createdAt: true },
      }),
      prisma.strategyDecision.findMany({
        where: { userId },
        orderBy: { evaluatedAt: "desc" },
        take: MAX_PER_SOURCE,
        select: {
          id: true,
          activationId: true,
          outcome: true,
          reasonCode: true,
          reasonMessage: true,
          market: true,
          evaluatedAt: true,
        },
      }),
      prisma.notificationDelivery.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, channel: true, status: true, subject: true, error: true, createdAt: true },
      }),
      prisma.auditEvent.findMany({
        where: { OR: [{ actorUserId: userId }, { objectId: userId }, { objectType: "User", objectId: userId }] },
        orderBy: { occurredAt: "desc" },
        take: 100,
        select: { id: true, action: true, objectType: true, objectId: true, outcome: true, occurredAt: true },
      }),
      prisma.supportTicket.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, subject: true, status: true, priority: true },
      }),
      prisma.userNote.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_PER_SOURCE,
        select: { id: true, body: true, authorUserId: true, createdAt: true },
      }),
    ]);

  const ticketIds = tickets.map((ticket) => ticket.id);
  const messages =
    ticketIds.length === 0
      ? []
      : await prisma.ticketMessage.findMany({
          where: { ticketId: { in: ticketIds } },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: { id: true, ticketId: true, authorType: true, visibility: true, body: true, createdAt: true },
        });

  return buildUserTimeline(userId, {
    ledger: ledgerEntries.map((entry) => ({
      id: entry.id,
      amountMinor: entry.amountMinor,
      asset: entry.asset,
      direction: entry.direction,
      accountCode: entry.account.code,
      decimals: entry.account.decimals,
      kind: entry.transaction.kind,
      occurredAt: entry.transaction.occurredAt,
      memo: entry.transaction.memo,
    })),
    sessions,
    deposits,
    withdrawals,
    orders,
    decisions,
    deliveries,
    audits,
    tickets,
    messages,
    notes,
  });
}
