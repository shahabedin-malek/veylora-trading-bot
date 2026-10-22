import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { resolveRequestContext } from "@/lib/observability/request-context";

/**
 * The one writer for the audit trail (phase 36).
 *
 * Every subsystem in this application records through {@link auditCreate}; no
 * module calls `auditEvent.create` itself. That is not a style preference — the
 * writer is what makes the four phase-36 promises true:
 *
 *  - **One shape.** Actor, target, action, outcome, before, after, source and a
 *    correlation id are normalised here. A subsystem cannot invent a second row
 *    shape by passing a different set of fields.
 *  - **One chain.** The new row's `chainIndex` follows the current tip and its
 *    `previousHash` is the tip's hash. `chainIndex` and `hash` are unique in the
 *    database, so two writers cannot silently fork the chain.
 *  - **No secrets.** The payload is the caller's already-redacted JSON; this
 *    module never reads a credential to build one, and the export/read paths
 *    apply the shared redaction pass as a second line.
 *  - **Append-only.** There is no update or delete function here. The only
 *    deletion in the codebase is the retention job, which writes a marker event
 *    before it removes a range, so a verified gap is explainable.
 *
 * Rows written before this phase have null chain fields. The writer starts the
 * chain at index 1 on the first row it writes and never back-dates a hash onto an
 * older row; {@link verifyAuditChain} treats those rows as the legacy prefix.
 */

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export type AuditJson = string | Record<string, unknown> | null;

export type AuditCreateData = Omit<
  Prisma.AuditEventUncheckedCreateInput,
  "id" | "chainIndex" | "previousHash" | "hash" | "source" | "correlationId" | "beforeJson" | "afterJson"
> & {
  id?: string;
  source?: string | null;
  correlationId?: string | null;
  beforeJson?: AuditJson;
  afterJson?: AuditJson;
};

type AuditDb = Pick<Prisma.TransactionClient, "auditEvent">;

export type AuditChainRecord = {
  id: string;
  chainIndex: number;
  previousHash: string;
  hash: string;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  redactedJson: string;
  beforeJson: string | null;
  afterJson: string | null;
  source: string | null;
  correlationId: string | null;
};

function jsonString(value: AuditJson | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  return JSON.stringify(value);
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Which part of the system wrote the row.
 *
 * The action is the source of truth because it is the one field every writer
 * already sets. An explicit `source` wins where a caller knows better (a runner
 * job, a webhook retry), so the classification is a default and not a guess that
 * can be wrong silently.
 */
export function auditSourceFor(action: string, objectType: string): string {
  const value = `${action} ${objectType}`.toUpperCase();
  if (/^(AUTH|SESSION|NONCE|TOTP|SECURITY|PERMISSION|ROLE|ACCESS)_/.test(action.toUpperCase())) return "auth";
  if (/(DEPOSIT|WITHDRAWAL|LEDGER|ORDER|TRADE|BALANCE|FEE)/.test(value)) return "money";
  if (/(STRATEGY|BACKTEST|SIGNAL|DECISION|BOT)/.test(value)) return "strategy";
  if (/(CREDENTIAL|VENUE|WUNDERTRADING|API_KEY|AGENT|CHAINGPT|INTEGRATION)/.test(value)) return "credential";
  if (/(RISK|LIMIT|KILL_SWITCH)/.test(value)) return "limit";
  if (/FEE/.test(value)) return "fee";
  if (/(SUPPORT|TICKET|NOTE)/.test(value)) return "support";
  return "admin";
}

/** The state before the action, when the caller's payload names it. */
export function auditBeforeJson(data: AuditCreateData): string | null {
  const explicit = jsonString(data.beforeJson);
  if (explicit) return explicit;
  const payload = parseJsonObject(typeof data.redactedJson === "string" ? data.redactedJson : null);
  return payload && "before" in payload ? JSON.stringify(payload.before) : null;
}

/** The state after the action: explicit, or the whole redacted payload. */
export function auditAfterJson(data: AuditCreateData): string | null {
  const explicit = jsonString(data.afterJson);
  if (explicit) return explicit;
  const payload = parseJsonObject(typeof data.redactedJson === "string" ? data.redactedJson : null);
  if (payload && "after" in payload) return JSON.stringify(payload.after);
  return typeof data.redactedJson === "string" && data.redactedJson !== "{}" ? data.redactedJson : null;
}

/** The canonical bytes a hash is computed over. Key order is fixed here, not by JSON.stringify. */
export type AuditHashInput = Omit<AuditChainRecord, "hash">;

export function canonicalAuditPayload(record: AuditHashInput): string {
  return JSON.stringify({
    id: record.id,
    chainIndex: record.chainIndex,
    occurredAt: record.occurredAt.toISOString(),
    actorUserId: record.actorUserId,
    action: record.action,
    objectType: record.objectType,
    objectId: record.objectId,
    outcome: record.outcome,
    redactedJson: record.redactedJson,
    beforeJson: record.beforeJson,
    afterJson: record.afterJson,
    source: record.source,
    correlationId: record.correlationId,
    previousHash: record.previousHash,
  });
}

export function computeAuditHash(record: AuditHashInput): string {
  return createHash("sha256").update(canonicalAuditPayload(record), "utf8").digest("hex");
}

/**
 * Append one row to the chain.
 *
 * The caller passes the same `{data}` shape Prisma's `create` takes, so migrating
 * an existing site is a one-token change (`tx.auditEvent.create(` →
 * `auditCreate(tx, `). The extra `beforeJson`, `afterJson`, `source` and
 * `correlationId` fields are optional and are filled from the payload and the
 * request context when absent.
 *
 * This function deliberately takes the transaction client the caller is already
 * using: a status change and its audit row must commit or roll back together, and
 * a writer that used a separate connection could leave one without the other.
 */
export async function auditCreate(db: AuditDb, args: { data: AuditCreateData }) {
  const data = args.data;
  const tip = await db.auditEvent.findFirst({
    where: { hash: { not: null } },
    orderBy: { chainIndex: "desc" },
    select: { chainIndex: true, hash: true },
  });
  const chainIndex = (tip?.chainIndex ?? 0) + 1;
  const previousHash = tip?.hash ?? AUDIT_GENESIS_HASH;
  const occurredAt = data.occurredAt instanceof Date ? data.occurredAt : new Date();
  const id = data.id ?? randomUUID();
  const redactedJson = typeof data.redactedJson === "string" ? data.redactedJson : "{}";
  const source = data.source ?? auditSourceFor(data.action, data.objectType);
  // A caller inside one action passes the id explicitly; otherwise the middleware's
  // request id is this event's correlation id, which is what makes one withdrawal
  // traceable across the ledger, the order path and this trail.
  const correlationId =
    data.correlationId === undefined ? ((await resolveRequestContext())?.requestId ?? null) : data.correlationId;
  const beforeJson = auditBeforeJson({ ...data, redactedJson });
  const afterJson = auditAfterJson({ ...data, redactedJson });

  const record: AuditHashInput = {
    id,
    chainIndex,
    occurredAt,
    actorUserId: data.actorUserId ?? null,
    action: data.action,
    objectType: data.objectType,
    objectId: data.objectId ?? null,
    outcome: data.outcome,
    redactedJson,
    beforeJson,
    afterJson,
    source,
    correlationId,
    previousHash,
  };
  const hash = computeAuditHash(record);

  return db.auditEvent.create({
    data: {
      ...data,
      id,
      occurredAt,
      redactedJson,
      chainIndex,
      previousHash,
      hash,
      source,
      correlationId,
      beforeJson,
      afterJson,
    },
  });
}

/**
 * A convenience for code that is not already inside a transaction.
 *
 * It is the same writer; the name exists so a new call site can read naturally
 * without importing the Prisma type. Existing transactional call sites keep using
 * `auditCreate`.
 */
export async function recordAudit(db: AuditDb, data: AuditCreateData) {
  return auditCreate(db, { data });
}
