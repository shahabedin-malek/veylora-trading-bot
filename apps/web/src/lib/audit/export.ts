import { createHash } from "node:crypto";
import { redactValue } from "@/lib/observability/logger";

/**
 * Audit export with a manifest (phase 36).
 *
 * A file that leaves the building is only useful as evidence if a later reader can
 * tell whether it changed. Every export therefore carries a manifest naming the
 * filter range, the row count, the first and last chain positions, the head hash
 * and a SHA-256 of the exported content itself. `verifyAuditExport` recomputes that
 * hash from the file; a byte changed after export fails it.
 *
 * Payloads are passed through the observability redaction pass before they are
 * serialised. The audit trail should never have stored a secret in the first place,
 * but an export is a second chance to keep one out of a downloaded file.
 */

export type AuditFilterRange = {
  actor?: string;
  target?: string;
  action?: string;
  correlationId?: string;
  source?: string;
  from?: string;
  to?: string;
};

export type AuditExportEvent = {
  id: string;
  chainIndex: number | null;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  source: string | null;
  correlationId: string | null;
  hash: string | null;
  previousHash: string | null;
  before: unknown;
  after: unknown;
  payload: unknown;
};

export type AuditExportManifest = {
  version: 1;
  generatedAt: string;
  format: "json" | "csv";
  range: AuditFilterRange;
  count: number;
  firstChainIndex: number | null;
  lastChainIndex: number | null;
  headHash: string | null;
  algorithm: "sha256";
  contentHash: string;
};

export type AuditExportResult = {
  content: string;
  manifest: AuditExportManifest;
  contentType: string;
  filename: string;
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The row shape the route reads; kept structural so tests can build one. */
export type AuditExportSourceRow = {
  id: string;
  chainIndex: number | null;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  source: string | null;
  correlationId: string | null;
  hash: string | null;
  previousHash: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  redactedJson: string;
};

export function auditExportEvents(rows: readonly AuditExportSourceRow[]): AuditExportEvent[] {
  return rows.map((row) => ({
    id: row.id,
    chainIndex: row.chainIndex,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    outcome: row.outcome,
    source: row.source,
    correlationId: row.correlationId,
    hash: row.hash,
    previousHash: row.previousHash,
    before: redactValue(parse(row.beforeJson)),
    after: redactValue(parse(row.afterJson)),
    payload: redactValue(parse(row.redactedJson)),
  }));
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function auditCsv(events: readonly AuditExportEvent[]): string {
  const header = [
    "chainIndex",
    "occurredAt",
    "actorUserId",
    "action",
    "objectType",
    "objectId",
    "outcome",
    "source",
    "correlationId",
    "hash",
    "previousHash",
    "before",
    "after",
    "payload",
  ];
  const rows = events.map((event) =>
    [
      event.chainIndex,
      event.occurredAt,
      event.actorUserId,
      event.action,
      event.objectType,
      event.objectId,
      event.outcome,
      event.source,
      event.correlationId,
      event.hash,
      event.previousHash,
      event.before,
      event.after,
      event.payload,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

export function buildAuditExport(input: {
  rows: readonly AuditExportSourceRow[];
  range: AuditFilterRange;
  format: "json" | "csv";
  generatedAt?: Date;
}): AuditExportResult {
  const generatedAt = input.generatedAt ?? new Date();
  // An export is the trail in its own order, not the view's newest-first order:
  // legacy rows first in time, then the chained rows by index. The manifest's
  // first/last are then the low and high link of the range it names.
  const events = auditExportEvents(input.rows).sort((left, right) => {
    if (left.chainIndex === null && right.chainIndex === null) {
      return Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    }
    if (left.chainIndex === null) return -1;
    if (right.chainIndex === null) return 1;
    return left.chainIndex - right.chainIndex;
  });
  const chain = events.filter((event) => event.chainIndex !== null);

  if (input.format === "csv") {
    const content = auditCsv(events);
    const manifest: AuditExportManifest = {
      version: 1,
      generatedAt: generatedAt.toISOString(),
      format: "csv",
      range: input.range,
      count: events.length,
      firstChainIndex: chain[0]?.chainIndex ?? null,
      lastChainIndex: chain.length > 0 ? chain[chain.length - 1]!.chainIndex : null,
      headHash: chain.length > 0 ? chain[chain.length - 1]!.hash : null,
      algorithm: "sha256",
      contentHash: sha256Hex(content),
    };
    return {
      content,
      manifest,
      contentType: "text/csv; charset=utf-8",
      filename: `audit-${generatedAt.toISOString().slice(0, 10)}.csv`,
    };
  }

  const eventsJson = JSON.stringify(events);
  const manifest: AuditExportManifest = {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    format: "json",
    range: input.range,
    count: events.length,
    firstChainIndex: chain[0]?.chainIndex ?? null,
    lastChainIndex: chain.length > 0 ? chain[chain.length - 1]!.chainIndex : null,
    headHash: chain.length > 0 ? chain[chain.length - 1]!.hash : null,
    algorithm: "sha256",
    contentHash: sha256Hex(eventsJson),
  };
  return {
    content: JSON.stringify({ manifest, events }, null, 2),
    manifest,
    contentType: "application/json; charset=utf-8",
    filename: `audit-${generatedAt.toISOString().slice(0, 10)}.json`,
  };
}

/**
 * The streamed export (phase 38).
 *
 * An export is a file about a range, not an array about a range: at fifty thousand
 * events, reading the range into memory and then serialising it holds it twice.
 * The read therefore happens twice and the memory holds a page — first to count,
 * to link the chain and to hash exactly the bytes the file will carry, then again
 * to write those bytes to a stream. The manifest is known before the first byte,
 * which is what lets its hash travel in a response header while the body is still
 * being produced.
 */
export type AuditExportSource = () => AsyncIterable<AuditExportSourceRow>;

const CSV_FIELDS = [
  "chainIndex",
  "occurredAt",
  "actorUserId",
  "action",
  "objectType",
  "objectId",
  "outcome",
  "source",
  "correlationId",
  "hash",
  "previousHash",
  "before",
  "after",
  "payload",
] as const;

function csvFieldsOf(event: AuditExportEvent): string {
  return [
    event.chainIndex,
    event.occurredAt,
    event.actorUserId,
    event.action,
    event.objectType,
    event.objectId,
    event.outcome,
    event.source,
    event.correlationId,
    event.hash,
    event.previousHash,
    event.before,
    event.after,
    event.payload,
  ]
    .map(csvCell)
    .join(",");
}

async function forEachExportEvent(
  iterate: AuditExportSource,
  visit: (event: AuditExportEvent, index: number) => void,
): Promise<void> {
  let index = 0;
  // One row at a time: the source pages the database, so the memory here is the
  // event being written and nothing behind it.
  for await (const row of iterate()) {
    for (const event of auditExportEvents([row])) visit(event, index++);
  }
}

/** The manifest for a range, computed without holding the range. */
export async function auditExportManifest(input: {
  format: "json" | "csv";
  range: AuditFilterRange;
  iterate: AuditExportSource;
  generatedAt?: Date;
}): Promise<AuditExportManifest> {
  const generatedAt = input.generatedAt ?? new Date();
  const hash = createHash("sha256");
  let count = 0;
  let firstChainIndex: number | null = null;
  let lastChainIndex: number | null = null;
  let headHash: string | null = null;

  if (input.format === "csv") hash.update(`${CSV_FIELDS.join(",")}\n`, "utf8");
  else hash.update("[", "utf8");

  await forEachExportEvent(input.iterate, (event, index) => {
    count += 1;
    if (input.format === "csv") {
      if (index > 0) hash.update("\n", "utf8");
      hash.update(csvFieldsOf(event), "utf8");
    } else {
      if (index > 0) hash.update(",", "utf8");
      hash.update(JSON.stringify(event), "utf8");
    }
    if (event.chainIndex !== null) {
      firstChainIndex ??= event.chainIndex;
      lastChainIndex = event.chainIndex;
      headHash = event.hash;
    }
  });
  if (input.format === "csv") {
    if (count > 0) hash.update("\n", "utf8");
  } else {
    hash.update("]", "utf8");
  }

  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    format: input.format,
    range: input.range,
    count,
    firstChainIndex,
    lastChainIndex,
    headHash,
    algorithm: "sha256",
    contentHash: hash.digest("hex"),
  };
}

/** The file's bytes, a page at a time, matching `auditExportManifest`'s hash. */
export async function* auditExportChunks(input: {
  manifest: AuditExportManifest;
  iterate: AuditExportSource;
}): AsyncGenerator<string> {
  // Chunks of a few hundred rows, not one chunk per row: the response body is
  // pulled per chunk, so a per-row chunk would make the export a hundred thousand
  // awaits. The concatenation is byte-for-byte the content the manifest hashed.
  const CHUNK_ROWS = 500;
  if (input.manifest.format === "csv") {
    yield `${CSV_FIELDS.join(",")}\n`;
    let written = 0;
    let buffer: string[] = [];
    for await (const row of input.iterate()) {
      for (const event of auditExportEvents([row])) buffer.push(csvFieldsOf(event));
      if (buffer.length >= CHUNK_ROWS) {
        yield `${written > 0 ? "\n" : ""}${buffer.join("\n")}`;
        written += buffer.length;
        buffer = [];
      }
    }
    if (buffer.length > 0) yield `${written > 0 ? "\n" : ""}${buffer.join("\n")}`;
    if (written + buffer.length > 0) yield "\n";
    return;
  }

  yield `{"manifest":${JSON.stringify(input.manifest)},"events":[`;
  let written = 0;
  let buffer: string[] = [];
  for await (const row of input.iterate()) {
    for (const event of auditExportEvents([row])) buffer.push(JSON.stringify(event));
    if (buffer.length >= CHUNK_ROWS) {
      yield `${written > 0 ? "," : ""}${buffer.join(",")}`;
      written += buffer.length;
      buffer = [];
    }
  }
  if (buffer.length > 0) yield `${written > 0 ? "," : ""}${buffer.join(",")}`;
  yield "]}";
}

/**
 * Recompute the manifest hash from a downloaded file.
 *
 * A JSON export is verified over the `events` array alone, because the manifest
 * itself is one of the bytes it protects and hashing the whole document would be
 * circular. A CSV export is verified over the entire file. That difference is
 * stated here once so a reader does not have to infer it from the file shape.
 */
export function verifyAuditExport(input: {
  content: string;
  manifest: AuditExportManifest;
}): { ok: true; contentHash: string } | { ok: false; reason: string; expected: string; actual: string } {
  let contentToHash = input.content;
  if (input.manifest.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch {
      return {
        ok: false,
        reason: "The exported JSON file is not valid JSON.",
        expected: input.manifest.contentHash,
        actual: "",
      };
    }
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { events?: unknown }).events)) {
      return {
        ok: false,
        reason: "The exported JSON file has no events array to verify.",
        expected: input.manifest.contentHash,
        actual: "",
      };
    }
    contentToHash = JSON.stringify((parsed as { events: unknown[] }).events);
  }
  const actual = sha256Hex(contentToHash);
  if (actual !== input.manifest.contentHash) {
    return {
      ok: false,
      reason: "The exported content does not match its manifest hash.",
      expected: input.manifest.contentHash,
      actual,
    };
  }
  return { ok: true, contentHash: actual };
}
