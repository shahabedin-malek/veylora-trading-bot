/**
 * What a support ticket is, in one place that has no database.
 *
 * The phase's hard rules live here so they can be tested without a deployment:
 *
 *  - **Visibility is data.** A message is PUBLIC or INTERNAL in its row, and
 *    {@link visibleToUser} is the only function that decides what an account may
 *    read. A user note is a separate table with no visibility column at all, so
 *    there is no flag a bug could flip to reveal one.
 *  - **A status change is audited with before and after.** {@link ticketStatusAuditPayload}
 *    builds that record once, and the repository writes it in the same
 *    transaction as the update.
 *  - **A saved reply only inserts fields a caller has.** The placeholder set is
 *    fixed here, an unknown one is refused when the reply is saved, and
 *    {@link renderSavedReply} is the only renderer, so a customer never receives
 *    `{{user.label}}` literally.
 *  - **No credential material leaves in a thread or an export.** A write that
 *    looks like it carries a key, token or password is refused with the reason;
 *    an export redacts anything that predates that rule rather than trusting it.
 */

export const TICKET_STATUSES = ["OPEN", "PENDING", "RESOLVED", "CLOSED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const MESSAGE_VISIBILITIES = ["PUBLIC", "INTERNAL"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const TICKET_RELATED_TYPES = ["order", "withdrawal", "strategy", "deposit"] as const;
export type TicketRelatedType = (typeof TICKET_RELATED_TYPES)[number];

export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ["RESOLVED", "CLOSED"];

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 140;
const BODY_MIN = 1;
const BODY_MAX = 4_000;
export const SAVED_REPLY_NAME_MAX = 60;

export function normalizeTicketStatus(value: unknown): TicketStatus | null {
  if (typeof value !== "string") return null;
  const status = value.trim().toUpperCase();
  return (TICKET_STATUSES as readonly string[]).includes(status) ? (status as TicketStatus) : null;
}

export function normalizeTicketPriority(value: unknown): TicketPriority | null {
  if (typeof value !== "string") return null;
  const priority = value.trim().toUpperCase();
  return (TICKET_PRIORITIES as readonly string[]).includes(priority) ? (priority as TicketPriority) : null;
}

export function normalizeVisibility(value: unknown): MessageVisibility | null {
  if (value === undefined || value === null) return "PUBLIC";
  if (typeof value !== "string") return null;
  const visibility = value.trim().toUpperCase();
  return (MESSAGE_VISIBILITIES as readonly string[]).includes(visibility) ? (visibility as MessageVisibility) : null;
}

export function isTerminalTicketStatus(status: string): boolean {
  return (TERMINAL_TICKET_STATUSES as readonly string[]).includes(status);
}

/** Trim and collapse whitespace so a stored sentence is a sentence. */
export function normalizeSupportText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ") : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential material: refused on write, redacted on export.
// ─────────────────────────────────────────────────────────────────────────────

type SecretPattern = { kind: string; pattern: RegExp };

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "private key block", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi },
  { kind: "payment key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "cloud access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: "assigned credential",
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|private[_-]?key|password|passphrase|mnemonic|seed[_-]?phrase)\b\s*[:=]\s*["']?[A-Za-z0-9+/_=.-]{4,}/gi,
  },
];

/** The credential-looking material in a piece of text, if any. */
export function findSecretMaterial(text: string): { kind: string; match: string }[] {
  const found: { kind: string; match: string }[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const scan = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(scan)) {
      found.push({ kind, match: match[0] });
    }
  }
  return found;
}

/** The same text with every credential-looking value replaced, for an export. */
export function redactSecretMaterial(text: string): string {
  let redacted = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    redacted = redacted.replace(new RegExp(pattern.source, flags), `[redacted: ${kind}]`);
  }
  return redacted;
}

/**
 * Why a ticket body cannot be stored, or null when it can.
 *
 * A refusal names the kind of material but never echoes it: an error message is
 * not a safe place to repeat a key, and it is shown in a form that a browser may
 * keep.
 */
export function supportTextRefusal(text: string): string | null {
  const found = findSecretMaterial(text);
  if (found.length === 0) return null;
  return `This text looks like it contains a credential (${found
    .map((entry) => entry.kind)
    .join(", ")}). Support records never store keys, tokens or passwords; remove it and save again.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation.
// ─────────────────────────────────────────────────────────────────────────────

export type TicketDraft = {
  userId: string;
  subject: string;
  priority: TicketPriority;
  relatedType: TicketRelatedType | null;
  relatedId: string | null;
};

export type SupportValidation<T> = { valid: true; value: T } | { valid: false; error: string };

export function validateTicketLink(input: { relatedType?: unknown; relatedId?: unknown }): SupportValidation<{
  relatedType: TicketRelatedType | null;
  relatedId: string | null;
}> {
  const hasType = typeof input.relatedType === "string" && input.relatedType.trim().length > 0;
  const hasId = typeof input.relatedId === "string" && input.relatedId.trim().length > 0;
  if (!hasType && !hasId) return { valid: true, value: { relatedType: null, relatedId: null } };
  if (!hasType || !hasId) {
    return { valid: false, error: "A linked record needs both its type (order, withdrawal, strategy or deposit) and its id." };
  }
  const type = String(input.relatedType).trim().toLowerCase();
  if (!(TICKET_RELATED_TYPES as readonly string[]).includes(type)) {
    return { valid: false, error: `A linked record's type is one of ${TICKET_RELATED_TYPES.join(", ")}; ${JSON.stringify(type)} is not.` };
  }
  const id = String(input.relatedId).trim();
  if (!IDENTIFIER.test(id)) {
    return { valid: false, error: "A linked record id is 1–128 letters, digits, dots, dashes, underscores or colons." };
  }
  return { valid: true, value: { relatedType: type as TicketRelatedType, relatedId: id } };
}

export function validateTicketDraft(input: unknown): SupportValidation<TicketDraft> {
  if (typeof input !== "object" || input === null) return { valid: false, error: "A ticket must be an object." };
  const record = input as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  if (!IDENTIFIER.test(userId)) return { valid: false, error: "A target account id is required." };

  const subject = normalizeSupportText(record.subject);
  if (subject.length < SUBJECT_MIN || subject.length > SUBJECT_MAX) {
    return { valid: false, error: `A subject of ${SUBJECT_MIN}–${SUBJECT_MAX} characters is required.` };
  }
  const refusal = supportTextRefusal(subject);
  if (refusal) return { valid: false, error: refusal };

  const priority = record.priority === undefined ? "NORMAL" : normalizeTicketPriority(record.priority);
  if (!priority) {
    return { valid: false, error: `Priority is one of ${TICKET_PRIORITIES.join(", ")}.` };
  }

  const related = validateTicketLink({ relatedType: record.relatedType, relatedId: record.relatedId });
  if (!related.valid) return related;

  return {
    valid: true,
    value: { userId, subject, priority, relatedType: related.value.relatedType, relatedId: related.value.relatedId },
  };
}

export type MessageDraft = { body: string; visibility: MessageVisibility };

export function validateMessageDraft(input: unknown): SupportValidation<MessageDraft> {
  if (typeof input !== "object" || input === null) return { valid: false, error: "A message must be an object." };
  const record = input as Record<string, unknown>;
  const body = normalizeSupportText(record.body);
  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    return { valid: false, error: `A message of 1–${BODY_MAX} characters is required.` };
  }
  const refusal = supportTextRefusal(body);
  if (refusal) return { valid: false, error: refusal };
  const visibility = normalizeVisibility(record.visibility);
  if (!visibility) return { valid: false, error: "Visibility is PUBLIC (the account can read it) or INTERNAL (staff only)." };
  return { valid: true, value: { body, visibility } };
}

export function validateNoteDraft(input: unknown): SupportValidation<{ userId: string; body: string }> {
  if (typeof input !== "object" || input === null) return { valid: false, error: "A note must be an object." };
  const record = input as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  if (!IDENTIFIER.test(userId)) return { valid: false, error: "A note needs the account it is about." };
  const body = normalizeSupportText(record.body);
  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    return { valid: false, error: `A note of 1–${BODY_MAX} characters is required.` };
  }
  const refusal = supportTextRefusal(body);
  if (refusal) return { valid: false, error: refusal };
  return { valid: true, value: { userId, body } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved replies.
// ─────────────────────────────────────────────────────────────────────────────

export const SAVED_REPLY_PLACEHOLDERS = {
  "user.label": "The account's wallet address, or its id when it has no wallet",
  "user.id": "The account id",
  "user.role": "The account's global role",
  "user.wallet": "The account's mainnet wallet address",
  "account.summary": "Each ledger-derived balance, e.g. 25 USDT available / 25 total",
  "ticket.id": "The ticket id",
  "ticket.subject": "The ticket subject",
  "operator.label": "The signed-in operator",
} as const;

export type SavedReplyPlaceholder = keyof typeof SAVED_REPLY_PLACEHOLDERS;
export type SavedReplyContext = Partial<Record<SavedReplyPlaceholder, string>>;

export type SavedReplyDraft = { name: string; body: string };

export function placeholdersIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

export function validateSavedReplyDraft(input: unknown): SupportValidation<SavedReplyDraft> {
  if (typeof input !== "object" || input === null) return { valid: false, error: "A saved reply must be an object." };
  const record = input as Record<string, unknown>;
  const name = normalizeSupportText(record.name).replace(/\s+/g, " ");
  if (name.length < 1 || name.length > SAVED_REPLY_NAME_MAX) {
    return { valid: false, error: `A saved reply's name is 1–${SAVED_REPLY_NAME_MAX} characters.` };
  }
  const body = normalizeSupportText(record.body);
  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    return { valid: false, error: `A saved reply of 1–${BODY_MAX} characters is required.` };
  }
  const refusal = supportTextRefusal(body);
  if (refusal) return { valid: false, error: refusal };
  const unknown = placeholdersIn(body).filter(
    (placeholder) => !(placeholder in SAVED_REPLY_PLACEHOLDERS),
  );
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `Unknown placeholder ${unknown.map((entry) => `{{${entry}}}`).join(", ")}. Available: ${Object.keys(
        SAVED_REPLY_PLACEHOLDERS,
      )
        .map((entry) => `{{${entry}}}`)
        .join(", ")}.`,
    };
  }
  return { valid: true, value: { name, body } };
}

/**
 * A saved reply with its placeholders filled in.
 *
 * A placeholder with no value becomes an em dash rather than an empty string or
 * the literal braces: an operator can see which field the reply expected and the
 * customer never receives template syntax.
 */
export function renderSavedReply(body: string, context: SavedReplyContext): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_whole, name: string) => {
    const value = context[name as SavedReplyPlaceholder];
    return value && value.trim().length > 0 ? value : "—";
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading: what the account may see, and what the export contains.
// ─────────────────────────────────────────────────────────────────────────────

export type TicketMessageRecord = {
  id: string;
  ticketId: string;
  authorType: string;
  authorUserId: string | null;
  visibility: string;
  body: string;
  createdAt: Date;
};

export type TicketRecord = {
  id: string;
  userId: string;
  subject: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  relatedType: string | null;
  relatedId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  closedAt: Date | null;
};

export type UserNoteRecord = {
  id: string;
  userId: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
};

export type UserTicketView = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  messages: { id: string; authorType: string; body: string; createdAt: string }[];
};

/**
 * The only decision about what an account can read.
 *
 * INTERNAL messages are dropped here, before a view is built, and a user note is
 * not accepted by this function at all. `tests/support-crm.test.ts` asserts a
 * mixed thread comes back with the internal row absent.
 */
export function visibleToUser(messages: readonly TicketMessageRecord[]): TicketMessageRecord[] {
  return messages.filter((message) => message.visibility === "PUBLIC");
}

export function userTicketView(ticket: TicketRecord, messages: readonly TicketMessageRecord[]): UserTicketView {
  return {
    id: ticket.id,
    subject: redactSecretMaterial(ticket.subject),
    status: ticket.status,
    priority: ticket.priority,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    messages: visibleToUser(messages).map((message) => ({
      id: message.id,
      authorType: message.authorType,
      body: redactSecretMaterial(message.body),
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export function ticketThreadCounts(messages: readonly TicketMessageRecord[]): { public: number; internal: number } {
  let publicCount = 0;
  let internalCount = 0;
  for (const message of messages) {
    if (message.visibility === "PUBLIC") publicCount += 1;
    else internalCount += 1;
  }
  return { public: publicCount, internal: internalCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit: a status change is a record, not a side effect.
// ─────────────────────────────────────────────────────────────────────────────

export function ticketStatusAuditObject(ticketId: string): { objectType: "SupportTicket"; objectId: string } {
  return { objectType: "SupportTicket", objectId: ticketId };
}

export function ticketStatusAuditPayload(input: {
  actorUserId: string;
  ticketId: string;
  subject: string;
  previousStatus: string;
  nextStatus: string;
  priority: string;
  assigneeUserId: string | null;
  reason?: string | null;
}): string {
  return JSON.stringify({
    actor: { type: "User", id: input.actorUserId },
    target: { type: "SupportTicket", id: input.ticketId, label: input.subject },
    previousStatus: input.previousStatus,
    nextStatus: input.nextStatus,
    priority: input.priority,
    assigneeUserId: input.assigneeUserId,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Export.
// ─────────────────────────────────────────────────────────────────────────────

function stamp(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * A ticket as a plain-text document.
 *
 * Internal messages and notes are included because the export is the operator's
 * own record — but every one is labelled INTERNAL, and every body passes through
 * {@link redactSecretMaterial}, so a secret pasted before the write-time refusal
 * existed cannot leave in the file. The result has no credential material by
 * construction; `tests/support-crm.test.ts` asserts it on a seeded payload that
 * includes one.
 */
export function buildTicketExport(input: {
  ticket: TicketRecord;
  messages: readonly TicketMessageRecord[];
  notes: readonly UserNoteRecord[];
  accountLabel: string;
  assigneeLabel: string | null;
  exportedBy: string;
  exportedAt: Date;
}): string {
  const { ticket } = input;
  const lines: string[] = [
    `# Support ticket ${ticket.id} — ${redactSecretMaterial(ticket.subject)}`,
    "",
    `Account: ${redactSecretMaterial(input.accountLabel)} (${ticket.userId})`,
    `Status: ${ticket.status} · Priority: ${ticket.priority} · Assignee: ${input.assigneeLabel ?? "unassigned"}`,
    `Opened: ${stamp(ticket.createdAt)} · Last message: ${stamp(ticket.lastMessageAt)}`,
    ticket.relatedType && ticket.relatedId
      ? `Linked record: ${ticket.relatedType} ${ticket.relatedId}`
      : "Linked record: none",
    `Exported: ${stamp(input.exportedAt)} by ${input.exportedBy}`,
    "",
  ];

  const messages = [...input.messages].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  lines.push("## Thread", "");
  if (messages.length === 0) {
    lines.push("No message has been written on this ticket.", "");
  }
  for (const message of messages) {
    const marker = message.visibility === "PUBLIC" ? "PUBLIC" : "INTERNAL — not sent to the account";
    lines.push(`### ${stamp(message.createdAt)} · ${message.authorType} · ${marker}`, "", redactSecretMaterial(message.body), "");
  }

  if (input.notes.length > 0) {
    lines.push("## Internal notes (never sent to the account)", "");
    for (const note of [...input.notes].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())) {
      lines.push(`- ${stamp(note.createdAt)} · ${note.authorUserId}: ${redactSecretMaterial(note.body)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function ticketExportFilename(ticket: Pick<TicketRecord, "id" | "subject">): string {
  const slug = redactSecretMaterial(ticket.subject)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `ticket-${ticket.id}${slug ? `-${slug}` : ""}.md`;
}
