import { prisma } from "@/lib/db";
import { ledgerStore } from "@/lib/ledger/store";
import { balancesForUser } from "@/lib/ledger/statements";
import { userBalances } from "@/lib/ledger/accounts";
import { assetBalanceViews } from "@/lib/portfolio/pnl";
import {
  buildTicketExport,
  redactSecretMaterial,
  renderSavedReply,
  ticketExportFilename,
  ticketStatusAuditObject,
  ticketStatusAuditPayload,
  ticketThreadCounts,
  userTicketView,
  validateTicketLink,
  normalizeTicketPriority,
  normalizeTicketStatus,
  type MessageDraft,
  type SavedReplyContext,
  type SavedReplyDraft,
  type TicketDraft,
  type TicketMessageRecord,
  type TicketRecord,
  type TicketRelatedType,
  type UserTicketView,
} from "@/lib/support/tickets";
import { auditCreate } from "@/lib/audit/record";

/**
 * The database half of support (phase 35).
 *
 * Every write that changes a ticket's state writes its audit row in the same
 * transaction. Every read that reaches an account passes through
 * {@link userTicketView}, which drops INTERNAL messages; the account's own query
 * additionally selects `visibility: "PUBLIC"` in SQL. Notes are a separate table
 * and are never selected by that path at all.
 *
 * Bodies are redacted on the way out as well as refused on the way in, so a row
 * written before the refusal existed cannot leak a credential through a ticket,
 * a timeline or an export.
 */

const MAX_TICKETS = 250;
const MAX_SEARCH = 20;

export class SupportRefusal extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "SupportRefusal";
  }
}

const USER_LABEL = {
  select: {
    id: true,
    walletIdentity: {
      where: { revokedAt: null },
      orderBy: { verifiedAt: "desc" as const },
      take: 1,
      select: { addressDisplay: true },
    },
    roles: {
      where: { scope: "global", revokedAt: null },
      orderBy: { createdAt: "desc" as const },
      take: 1,
      select: { role: true },
    },
  },
} as const;

type LabelRow = {
  id: string;
  walletIdentity: { addressDisplay: string }[];
  roles?: { role: string }[];
};

function label(user: LabelRow | null | undefined): string {
  return user?.walletIdentity[0]?.addressDisplay ?? user?.id ?? "unknown account";
}

export type SupportTicketRow = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  userId: string;
  accountLabel: string;
  assigneeUserId: string | null;
  assigneeLabel: string | null;
  relatedType: string | null;
  relatedId: string | null;
  messageCount: number;
  lastMessageAt: string;
  updatedAt: string;
};

export type SupportTicketFilters = { q?: string; status?: string; priority?: string; assignee?: string };

export async function listSupportTickets(filters: SupportTicketFilters): Promise<SupportTicketRow[]> {
  const tickets = await prisma.supportTicket.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.assignee ? { assigneeUserId: filters.assignee } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_TICKETS,
    select: {
      id: true,
      subject: true,
      status: true,
      priority: true,
      userId: true,
      assigneeUserId: true,
      relatedType: true,
      relatedId: true,
      lastMessageAt: true,
      updatedAt: true,
      user: { select: USER_LABEL.select },
      assignee: { select: USER_LABEL.select },
      _count: { select: { messages: true } },
    },
  });
  const needle = filters.q?.trim().toLowerCase();
  return tickets
    .map((ticket) => ({
      id: ticket.id,
      subject: redactSecretMaterial(ticket.subject),
      status: ticket.status,
      priority: ticket.priority,
      userId: ticket.userId,
      accountLabel: label(ticket.user),
      assigneeUserId: ticket.assigneeUserId,
      assigneeLabel: ticket.assignee ? label(ticket.assignee) : null,
      relatedType: ticket.relatedType,
      relatedId: ticket.relatedId,
      messageCount: ticket._count.messages,
      lastMessageAt: ticket.lastMessageAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
    }))
    .filter((ticket) => {
      if (!needle) return true;
      return [ticket.id, ticket.subject, ticket.userId, ticket.accountLabel, ticket.assigneeUserId ?? "", ticket.assigneeLabel ?? "", ticket.relatedId ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
}

export type SupportMessageView = {
  id: string;
  authorType: string;
  authorUserId: string | null;
  authorLabel: string;
  visibility: string;
  body: string;
  createdAt: string;
};

export type SupportNoteView = {
  id: string;
  authorUserId: string;
  authorLabel: string;
  body: string;
  createdAt: string;
};

export type SupportTicketDetail = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  userId: string;
  accountLabel: string;
  accountRole: string;
  assigneeUserId: string | null;
  assigneeLabel: string | null;
  relatedType: string | null;
  relatedId: string | null;
  relatedLabel: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  closedAt: string | null;
  messages: SupportMessageView[];
  notes: SupportNoteView[];
  counts: { public: number; internal: number };
  tickets: { id: string; subject: string; status: string }[];
};

export async function readSupportTicket(ticketId: string): Promise<SupportTicketDetail | null> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      subject: true,
      status: true,
      priority: true,
      userId: true,
      assigneeUserId: true,
      relatedType: true,
      relatedId: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      closedAt: true,
      user: { select: USER_LABEL.select },
      assignee: { select: USER_LABEL.select },
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          authorType: true,
          authorUserId: true,
          visibility: true,
          body: true,
          createdAt: true,
          author: { select: USER_LABEL.select },
        },
      },
    },
  });
  if (!ticket) return null;

  const notes = await prisma.userNote.findMany({
    where: { userId: ticket.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      authorUserId: true,
      body: true,
      createdAt: true,
      author: { select: USER_LABEL.select },
    },
  });
  const related = await relatedRecord(ticket.relatedType, ticket.relatedId);
  const siblings = await prisma.supportTicket.findMany({
    where: { userId: ticket.userId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, subject: true, status: true },
  });

  const records: TicketMessageRecord[] = ticket.messages.map((message) => ({
    id: message.id,
    ticketId: ticket.id,
    authorType: message.authorType,
    authorUserId: message.authorUserId,
    visibility: message.visibility,
    body: message.body,
    createdAt: message.createdAt,
  }));

  return {
    id: ticket.id,
    subject: redactSecretMaterial(ticket.subject),
    status: ticket.status,
    priority: ticket.priority,
    userId: ticket.userId,
    accountLabel: label(ticket.user),
    accountRole: ticket.user?.roles?.[0]?.role ?? "VIEWER",
    assigneeUserId: ticket.assigneeUserId,
    assigneeLabel: ticket.assignee ? label(ticket.assignee) : null,
    relatedType: ticket.relatedType,
    relatedId: ticket.relatedId,
    relatedLabel: related?.label ?? null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    closedAt: ticket.closedAt?.toISOString() ?? null,
    messages: ticket.messages.map((message) => ({
      id: message.id,
      authorType: message.authorType,
      authorUserId: message.authorUserId,
      authorLabel: message.authorUserId ? label(message.author) : message.authorType,
      visibility: message.visibility,
      body: redactSecretMaterial(message.body),
      createdAt: message.createdAt.toISOString(),
    })),
    notes: notes.map((note) => ({
      id: note.id,
      authorUserId: note.authorUserId,
      authorLabel: label(note.author),
      body: redactSecretMaterial(note.body),
      createdAt: note.createdAt.toISOString(),
    })),
    counts: ticketThreadCounts(records),
    tickets: siblings,
  };
}

async function relatedRecord(
  type: string | null,
  id: string | null,
): Promise<{ type: string; id: string; label: string } | null> {
  if (!type || !id) return null;
  if (type === "order") {
    const order = await prisma.tradeOrder.findUnique({ where: { id }, select: { market: true, side: true, status: true } });
    return order ? { type, id, label: `${order.market} ${order.side} · ${order.status}` } : null;
  }
  if (type === "withdrawal") {
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id }, select: { status: true, asset: true } });
    return withdrawal ? { type, id, label: `${withdrawal.asset} withdrawal · ${withdrawal.status}` } : null;
  }
  if (type === "strategy") {
    const activation = await prisma.strategyActivation.findUnique({
      where: { id },
      select: { status: true, strategyId: true },
    });
    return activation ? { type, id, label: `${activation.strategyId ?? "strategy"} · ${activation.status}` } : null;
  }
  if (type === "deposit") {
    const deposit = await prisma.deposit.findUnique({ where: { id }, select: { amount: true, tokenSymbol: true, status: true } });
    return deposit ? { type, id, label: `${deposit.amount} ${deposit.tokenSymbol} · ${deposit.status}` } : null;
  }
  return null;
}

async function requireRelated(type: TicketRelatedType | null, id: string | null): Promise<void> {
  if (!type || !id) return;
  const related = await relatedRecord(type, id);
  if (!related) throw new SupportRefusal(`No ${type} record ${id} exists, so the ticket cannot be linked to it.`, 404);
}

export async function createSupportTicket(input: { actorUserId: string; value: TicketDraft }): Promise<SupportTicketDetail> {
  const draft = input.value;
  const account = await prisma.user.findUnique({ where: { id: draft.userId }, select: { id: true } });
  if (!account) throw new SupportRefusal(`No account ${draft.userId} exists.`, 404);
  await requireRelated(draft.relatedType, draft.relatedId);

  const created = await prisma.$transaction(async (transaction) => {
    const ticket = await transaction.supportTicket.create({
      data: {
        userId: draft.userId,
        subject: draft.subject,
        priority: draft.priority,
        relatedType: draft.relatedType,
        relatedId: draft.relatedId,
        createdByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.actorUserId,
        action: "SUPPORT_TICKET_CREATED",
        objectType: "SupportTicket",
        objectId: ticket.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          actor: { type: "User", id: input.actorUserId },
          target: { type: "User", id: draft.userId },
          subject: draft.subject,
          priority: draft.priority,
          related: draft.relatedType && draft.relatedId ? { type: draft.relatedType, id: draft.relatedId } : null,
        }),
      },
    });
    return ticket;
  });

  const detail = await readSupportTicket(created.id);
  if (!detail) throw new SupportRefusal("The ticket was written but could not be read back.", 503);
  return detail;
}

export async function addTicketMessage(input: {
  actorUserId: string;
  ticketId: string;
  authorType: "STAFF" | "USER" | "SYSTEM";
  draft: MessageDraft;
}): Promise<SupportTicketDetail> {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: input.ticketId }, select: { id: true } });
  if (!ticket) throw new SupportRefusal(`No ticket ${input.ticketId} exists.`, 404);
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: {
        ticketId: input.ticketId,
        authorType: input.authorType,
        authorUserId: input.actorUserId,
        visibility: input.draft.visibility,
        body: input.draft.body,
      },
    }),
    prisma.supportTicket.update({
      where: { id: input.ticketId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    }),
  ]);
  const detail = await readSupportTicket(input.ticketId);
  if (!detail) throw new SupportRefusal("The message was written but the ticket could not be read back.", 503);
  return detail;
}

export async function addUserNote(input: {
  actorUserId: string;
  note: { userId: string; body: string };
}): Promise<SupportNoteView> {
  const account = await prisma.user.findUnique({ where: { id: input.note.userId }, select: { id: true } });
  if (!account) throw new SupportRefusal(`No account ${input.note.userId} exists.`, 404);
  const note = await prisma.userNote.create({
    data: { userId: input.note.userId, authorUserId: input.actorUserId, body: input.note.body },
    select: { id: true, authorUserId: true, body: true, createdAt: true, author: { select: USER_LABEL.select } },
  });
  return {
    id: note.id,
    authorUserId: note.authorUserId,
    authorLabel: label(note.author),
    body: redactSecretMaterial(note.body),
    createdAt: note.createdAt.toISOString(),
  };
}

export type SupportTicketUpdate = {
  status?: unknown;
  priority?: unknown;
  assigneeUserId?: unknown;
  relatedType?: unknown;
  relatedId?: unknown;
  reason?: unknown;
};

export async function updateSupportTicket(input: {
  actorUserId: string;
  ticketId: string;
  update: SupportTicketUpdate;
}): Promise<SupportTicketDetail> {
  const before = await prisma.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: { id: true, subject: true, status: true, priority: true, assigneeUserId: true, relatedType: true, relatedId: true },
  });
  if (!before) throw new SupportRefusal(`No ticket ${input.ticketId} exists.`, 404);

  const data: {
    status?: string;
    priority?: string;
    assigneeUserId?: string | null;
    relatedType?: string | null;
    relatedId?: string | null;
    closedAt?: Date | null;
    updatedAt?: Date;
  } = {};

  let nextStatus = before.status;
  let nextAssignee = before.assigneeUserId;
  if (input.update.status !== undefined) {
    const status = normalizeTicketStatus(input.update.status);
    if (!status) throw new SupportRefusal("Status must be OPEN, PENDING, RESOLVED or CLOSED.");
    nextStatus = status;
    data.status = status;
    data.closedAt = status === "RESOLVED" || status === "CLOSED" ? new Date() : null;
  }
  if (input.update.priority !== undefined) {
    const priority = normalizeTicketPriority(input.update.priority);
    if (!priority) throw new SupportRefusal("Priority must be LOW, NORMAL, HIGH or URGENT.");
    data.priority = priority;
  }
  if (input.update.assigneeUserId !== undefined) {
    const value = input.update.assigneeUserId;
    if (value === null || value === "") {
      data.assigneeUserId = null;
      nextAssignee = null;
    } else if (typeof value === "string") {
      const assignee = await prisma.user.findUnique({ where: { id: value }, select: { id: true } });
      if (!assignee) throw new SupportRefusal(`No account ${value} exists to assign the ticket to.`, 404);
      data.assigneeUserId = value;
      nextAssignee = value;
    } else {
      throw new SupportRefusal("An assignee is an account id, or null to unassign.");
    }
  }
  if (input.update.relatedType !== undefined || input.update.relatedId !== undefined) {
    const link = validateTicketLink({ relatedType: input.update.relatedType, relatedId: input.update.relatedId });
    if (!link.valid) throw new SupportRefusal(link.error);
    await requireRelated(link.value.relatedType, link.value.relatedId);
    data.relatedType = link.value.relatedType;
    data.relatedId = link.value.relatedId;
  }
  const reason = typeof input.update.reason === "string" ? input.update.reason.trim().slice(0, 200) : null;

  if (Object.keys(data).length === 0) {
    throw new SupportRefusal("Nothing to change: send a status, priority, assignee or linked record.");
  }
  data.updatedAt = new Date();

  await prisma.$transaction(async (transaction) => {
    await transaction.supportTicket.update({ where: { id: input.ticketId }, data });
    if (nextStatus !== before.status) {
      await auditCreate(transaction, {
        data: {
          actorUserId: input.actorUserId,
          action: "SUPPORT_TICKET_STATUS_CHANGED",
          ...ticketStatusAuditObject(input.ticketId),
          outcome: "SUCCESS",
          redactedJson: ticketStatusAuditPayload({
            actorUserId: input.actorUserId,
            ticketId: input.ticketId,
            subject: before.subject,
            previousStatus: before.status,
            nextStatus,
            priority: (data.priority ?? before.priority) as string,
            assigneeUserId: nextAssignee,
            reason,
          }),
        },
      });
    }
  });

  const detail = await readSupportTicket(input.ticketId);
  if (!detail) throw new SupportRefusal("The ticket was updated but could not be read back.", 503);
  return detail;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved replies.
// ─────────────────────────────────────────────────────────────────────────────

export type SavedReplyView = { id: string; name: string; body: string; updatedAt: string };

export async function listSavedReplies(): Promise<SavedReplyView[]> {
  const replies = await prisma.savedReply.findMany({
    orderBy: { name: "asc" },
    take: 100,
    select: { id: true, name: true, body: true, updatedAt: true },
  });
  return replies.map((reply) => ({ ...reply, updatedAt: reply.updatedAt.toISOString() }));
}

export async function saveSavedReply(input: { actorUserId: string; draft: SavedReplyDraft }): Promise<SavedReplyView> {
  const reply = await prisma.savedReply.upsert({
    where: { name: input.draft.name },
    create: { name: input.draft.name, body: input.draft.body, createdByUserId: input.actorUserId },
    update: { body: input.draft.body, createdByUserId: input.actorUserId },
    select: { id: true, name: true, body: true, updatedAt: true },
  });
  return { ...reply, updatedAt: reply.updatedAt.toISOString() };
}

export async function deleteSavedReply(id: string): Promise<boolean> {
  const result = await prisma.savedReply.deleteMany({ where: { id } });
  return result.count > 0;
}

/**
 * A saved reply rendered for one ticket.
 *
 * The values come from the ticket's account, the ledger's own derived balance and
 * the signed-in operator — never from the request body — so an operator cannot
 * type a different account's details into a reply that claims to describe this
 * one. `tests/support-crm.test.ts` asserts each placeholder arrives with the
 * account's real values.
 */
export async function renderReplyForTicket(input: {
  replyId: string;
  ticketId: string;
  operatorUserId: string;
}): Promise<{ rendered: string; context: SavedReplyContext }> {
  const [reply, ticket] = await Promise.all([
    prisma.savedReply.findUnique({ where: { id: input.replyId }, select: { body: true, name: true } }),
    prisma.supportTicket.findUnique({
      where: { id: input.ticketId },
      select: {
        id: true,
        subject: true,
        userId: true,
        user: { select: USER_LABEL.select },
      },
    }),
  ]);
  if (!reply) throw new SupportRefusal("No saved reply has that id.", 404);
  if (!ticket) throw new SupportRefusal(`No ticket ${input.ticketId} exists.`, 404);

  const [balances, operator] = await Promise.all([
    balancesForUser(ledgerStore, ticket.userId).catch(() => []),
    prisma.user.findUnique({ where: { id: input.operatorUserId }, select: USER_LABEL.select }),
  ]);
  const summary = assetBalanceViews(userBalances(balances))
    .map((balance) => `${balance.available} ${balance.asset} available / ${balance.total} total`)
    .join("; ");

  const context: SavedReplyContext = {
    "user.label": label(ticket.user),
    "user.id": ticket.userId,
    "user.role": ticket.user?.roles?.[0]?.role ?? "VIEWER",
    "user.wallet": ticket.user?.walletIdentity?.[0]?.addressDisplay ?? "no mainnet wallet",
    "account.summary": summary.length > 0 ? summary : "no ledger balance yet",
    "ticket.id": ticket.id,
    "ticket.subject": redactSecretMaterial(ticket.subject),
    "operator.label": label(operator),
  };
  return { rendered: renderSavedReply(reply.body, context), context };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search and export.
// ─────────────────────────────────────────────────────────────────────────────

export type SupportSearchResult = {
  q: string;
  count: number;
  groups: {
    tickets: { id: string; subject: string; status: string; userId: string; accountLabel: string }[];
    messages: { id: string; ticketId: string; subject: string; visibility: string; excerpt: string; createdAt: string }[];
    notes: { id: string; userId: string; accountLabel: string; excerpt: string; createdAt: string }[];
    timeline: { id: string; action: string; objectType: string; objectId: string | null; occurredAt: string }[];
  };
};

export async function searchSupport(term: string): Promise<SupportSearchResult> {
  const q = term.trim().slice(0, 160);
  const needle = q.toLowerCase();
  const [tickets, messages, notes, audits] = await Promise.all([
    prisma.supportTicket.findMany({
      orderBy: { updatedAt: "desc" },
      take: MAX_TICKETS,
      select: {
        id: true,
        subject: true,
        status: true,
        userId: true,
        user: { select: USER_LABEL.select },
      },
    }),
    prisma.ticketMessage.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        ticketId: true,
        visibility: true,
        body: true,
        createdAt: true,
        ticket: { select: { subject: true } },
      },
    }),
    prisma.userNote.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        userId: true,
        body: true,
        createdAt: true,
        user: { select: USER_LABEL.select },
      },
    }),
    prisma.auditEvent.findMany({
      orderBy: { occurredAt: "desc" },
      take: 400,
      select: { id: true, action: true, objectType: true, objectId: true, occurredAt: true, redactedJson: true },
    }),
  ]);

  const ticketMatches = tickets
    .filter((ticket) =>
      [ticket.id, ticket.subject, ticket.userId, label(ticket.user)].join(" ").toLowerCase().includes(needle),
    )
    .slice(0, MAX_SEARCH)
    .map((ticket) => ({
      id: ticket.id,
      subject: redactSecretMaterial(ticket.subject),
      status: ticket.status,
      userId: ticket.userId,
      accountLabel: label(ticket.user),
    }));
  const messageMatches = messages
    .filter((message) => message.body.toLowerCase().includes(needle))
    .slice(0, MAX_SEARCH)
    .map((message) => ({
      id: message.id,
      ticketId: message.ticketId,
      subject: redactSecretMaterial(message.ticket.subject),
      visibility: message.visibility,
      excerpt: excerpt(message.body, needle),
      createdAt: message.createdAt.toISOString(),
    }));
  const noteMatches = notes
    .filter((note) => note.body.toLowerCase().includes(needle))
    .slice(0, MAX_SEARCH)
    .map((note) => ({
      id: note.id,
      userId: note.userId,
      accountLabel: label(note.user),
      excerpt: excerpt(note.body, needle),
      createdAt: note.createdAt.toISOString(),
    }));
  const timelineMatches = audits
    .filter((audit) => `${audit.action} ${audit.redactedJson}`.toLowerCase().includes(needle))
    .slice(0, MAX_SEARCH)
    .map((audit) => ({
      id: audit.id,
      action: audit.action,
      objectType: audit.objectType,
      objectId: audit.objectId,
      occurredAt: audit.occurredAt.toISOString(),
    }));

  return {
    q,
    count: ticketMatches.length + messageMatches.length + noteMatches.length + timelineMatches.length,
    groups: { tickets: ticketMatches, messages: messageMatches, notes: noteMatches, timeline: timelineMatches },
  };
}

function excerpt(text: string, needle: string): string {
  const redacted = redactSecretMaterial(text).replace(/\s+/g, " ").trim();
  const index = redacted.toLowerCase().indexOf(needle);
  if (index < 0) return redacted.slice(0, 160);
  const start = Math.max(0, index - 60);
  return `${start > 0 ? "…" : ""}${redacted.slice(start, start + 160)}${start + 160 < redacted.length ? "…" : ""}`;
}

export async function exportSupportTicket(input: {
  ticketId: string;
  exportedByUserId: string;
}): Promise<{ filename: string; content: string; bytes: number }> {
  const [ticket, exportedBy] = await Promise.all([
    prisma.supportTicket.findUnique({
      where: { id: input.ticketId },
      select: {
        id: true,
        userId: true,
        subject: true,
        status: true,
        priority: true,
        assigneeUserId: true,
        relatedType: true,
        relatedId: true,
        createdAt: true,
        updatedAt: true,
        lastMessageAt: true,
        closedAt: true,
        user: { select: USER_LABEL.select },
        assignee: { select: USER_LABEL.select },
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            ticketId: true,
            authorType: true,
            authorUserId: true,
            visibility: true,
            body: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.user.findUnique({ where: { id: input.exportedByUserId }, select: USER_LABEL.select }),
  ]);
  if (!ticket) throw new SupportRefusal(`No ticket ${input.ticketId} exists.`, 404);
  const notes = await prisma.userNote.findMany({
    where: { userId: ticket.userId },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, userId: true, authorUserId: true, body: true, createdAt: true },
  });
  const record: TicketRecord = {
    id: ticket.id,
    userId: ticket.userId,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    assigneeUserId: ticket.assigneeUserId,
    relatedType: ticket.relatedType,
    relatedId: ticket.relatedId,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    lastMessageAt: ticket.lastMessageAt,
    closedAt: ticket.closedAt,
  };
  const content = buildTicketExport({
    ticket: record,
    messages: ticket.messages,
    notes,
    accountLabel: label(ticket.user),
    assigneeLabel: ticket.assignee ? label(ticket.assignee) : null,
    exportedBy: label(exportedBy),
    exportedAt: new Date(),
  });
  return { filename: ticketExportFilename(record), content, bytes: Buffer.byteLength(content, "utf8") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain links and the account's own read.
// ─────────────────────────────────────────────────────────────────────────────

export async function linkedTicketsFor(
  type: string,
  id: string,
): Promise<{ id: string; subject: string; status: string; priority: string }[]> {
  const tickets = await prisma.supportTicket.findMany({
    where: { relatedType: type, relatedId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, subject: true, status: true, priority: true },
  });
  return tickets.map((ticket) => ({ ...ticket, subject: redactSecretMaterial(ticket.subject) }));
}

/**
 * The account's own view.
 *
 * Two filters, deliberately: SQL selects only PUBLIC messages and
 * {@link userTicketView} drops anything else again before it is serialised.
 * Notes are not queried. This is the function the user-facing route calls; the
 * test asserts a mixed thread comes back without its internal row.
 */
export async function listTicketsForUser(userId: string): Promise<UserTicketView[]> {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      userId: true,
      subject: true,
      status: true,
      priority: true,
      assigneeUserId: true,
      relatedType: true,
      relatedId: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      closedAt: true,
      messages: {
        where: { visibility: "PUBLIC" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          ticketId: true,
          authorType: true,
          authorUserId: true,
          visibility: true,
          body: true,
          createdAt: true,
        },
      },
    },
  });
  return tickets.map((ticket) => userTicketView(ticket, ticket.messages));
}
