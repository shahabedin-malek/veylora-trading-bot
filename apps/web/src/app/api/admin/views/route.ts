import { NextRequest } from "next/server";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireSitePermission } from "@/lib/auth/session-store";
import { deleteAdminView, listAdminViews, saveAdminView, adminSection } from "@/lib/admin/views";
import { prismaAdminViews } from "@/lib/admin/queries";

/**
 * Saved views, scoped to the signed-in owner.
 *
 * `GET` lists only this account's views; `POST` saves the section, filters and
 * columns under a name (the same name updates that view); `DELETE` removes one
 * that belongs to this account. The owner id comes from the session, never from
 * the body, so one owner cannot read or overwrite another's views.
 */

const MAX_BODY_BYTES = 16_384;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: NextRequest): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, error: "Content-Type must be application/json." };
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { ok: false, error: "Request is too large." };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
}

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireSitePermission("admin.console.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }
  const section = new URL(request.url).searchParams.get("section");
  const parsed = section ? adminSection(section) : null;
  if (section && !parsed) return json({ error: `Unknown section ${JSON.stringify(section)}.` }, 400);
  try {
    return json({ views: await listAdminViews(prismaAdminViews, user.id, parsed?.id) });
  } catch {
    return json({ error: "Saved views could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireSitePermission("admin.console.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }

  const body = await readBody(request);
  if (!body.ok) return json({ error: body.error }, body.error === "Request is too large." ? 413 : 400);
  const record = typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : {};
  const result = await saveAdminView(prismaAdminViews, {
    ownerUserId: user.id,
    name: record.name,
    section: record.section,
    filters: record.filters,
    columns: record.columns,
  });
  if (!result.ok) return json({ error: result.error }, 400);
  return json({ view: result.view }, 201);
}

export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireSitePermission("admin.console.read");
  } catch (error) {
    const refusal = getAccessRefusal(error);
    return refusal ? json(accessRefusalPayload(refusal), refusal.status) : authenticationGapResponse();
  }

  const id = new URL(request.url).searchParams.get("id");
  try {
    const result = await deleteAdminView(prismaAdminViews, user.id, id);
    if (result.error) return json({ error: result.error }, 400);
    if (!result.deleted) return json({ error: "No saved view with that id belongs to this account." }, 404);
    return json({ deleted: true });
  } catch {
    return json({ error: "The saved view could not be deleted." }, 503);
  }
}
