import { NextRequest } from "next/server";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { requireSitePermission } from "@/lib/auth/session-store";
import { readAdminRecord } from "@/lib/admin/queries";
import type { AdminRecordType } from "@/lib/admin/views";

const RECORD_TYPES: readonly AdminRecordType[] = [
  "user",
  "wallet",
  "balance",
  "ledger-entry",
  "deposit",
  "withdrawal",
  "order",
  "strategy",
  "venue-key",
  "fee",
  "limit",
  "switch",
  "audit",
  "ticket",
  "session",
  "delivery",
];

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** The full record and its one timeline: ledger, decisions, deliveries, audit. */
export async function GET(request: NextRequest) {
  try {
    await requireSitePermission("admin.console.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }

  const search = new URL(request.url).searchParams;
  const type = search.get("type") ?? "";
  const id = search.get("id") ?? "";
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    return json({ error: `Unknown record type ${JSON.stringify(type)}. Types: ${RECORD_TYPES.join(", ")}.` }, 400);
  }
  if (!id.trim()) return json({ error: "A record id is required." }, 400);

  try {
    const record = await readAdminRecord(type as AdminRecordType, id.trim());
    return record ? json(record) : json({ error: `No ${type} record ${id}.` }, 404);
  } catch {
    return json({ error: `The ${type} record could not be read.` }, 503);
  }
}
