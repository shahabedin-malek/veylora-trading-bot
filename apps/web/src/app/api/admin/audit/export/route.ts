import { NextRequest } from "next/server";
import { accessRefusalPayload, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireSitePermission } from "@/lib/auth/session-store";
import { auditExportChunks, auditExportManifest, type AuditFilterRange } from "@/lib/audit/export";
import { iterateAuditEvents, parseAuditFilters } from "@/lib/audit/query";

/**
 * A filtered audit export with a verifiable manifest (phase 36).
 *
 * The manifest travels twice: inside a JSON file, and in the
 * `X-Audit-Manifest` response header for both formats (CSV has nowhere else to
 * put it). Its `contentHash` is SHA-256 over the exported events, so a file
 * edited after download fails `verifyAuditExport`.
 *
 * The export is read-only and bounded by `AUDIT_EXPORT_LIMIT`; asking for more
 * than that is refused rather than silently truncated, because an export that
 * claims to be a range must contain the whole range.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function pickedRange(filters: ReturnType<typeof parseAuditFilters>): AuditFilterRange {
  return {
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.target ? { target: filters.target } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireSitePermission("audit.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal
      ? json(accessRefusalPayload(refusal), refusal.status)
      : json({ error: "The audit export is unavailable." }, 503);
  }

  const search = new URL(request.url).searchParams;
  const format = search.get("format") === "csv" ? "csv" : "json";
  const filters = parseAuditFilters(search);
  // A fresh iterator per pass: one to hash and count, one to write. Each pages the
  // database, so neither holds the range.
  const iterate = () => iterateAuditEvents(filters);

  try {
    // The manifest is computed first, over the same rows the body will stream, so
    // its hash can travel in a header while the file is still being produced.
    const manifest = await auditExportManifest({ format, range: pickedRange(filters), iterate });
    const encoder = new TextEncoder();
    const chunks = auditExportChunks({ manifest, iterate });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-${manifest.generatedAt.slice(0, 10)}.${format}"`,
        "Cache-Control": "no-store",
        "X-Audit-Manifest": Buffer.from(JSON.stringify(manifest), "utf8").toString("base64url"),
        "X-Audit-Content-Hash": manifest.contentHash,
        "X-Audit-Event-Count": String(manifest.count),
      },
    });
  } catch {
    return json({ error: "The audit export could not be produced." }, 503);
  }
}
