import { NextRequest } from "next/server";
import { readSupportTicket, updateSupportTicket } from "@/lib/support/repository";
import {
  readSupportBody,
  requireSameOrigin,
  requireSupportCaller,
  supportFailure,
  supportJson,
} from "@/lib/support/http";

/**
 * One ticket: its whole thread, its internal notes and its linked record.
 *
 * `PATCH` changes status, priority, assignee or link. A status change writes its
 * audit row with the previous and next value in the same transaction; the reply
 * says which status it moved to so the caller does not have to re-read to know.
 */

export async function GET(_request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const caller = await requireSupportCaller("crm.support.read");
  if (!caller.ok) return caller.response;
  const { ticketId } = await params;
  try {
    const ticket = await readSupportTicket(ticketId);
    return ticket ? supportJson({ ticket }) : supportJson({ error: `No ticket ${ticketId}.` }, 404);
  } catch {
    return supportJson({ error: "The ticket could not be read from the database." }, 503);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const origin = await requireSameOrigin(request);
  if (origin) return origin;
  const caller = await requireSupportCaller("crm.support.manage");
  if (!caller.ok) return caller.response;

  const body = await readSupportBody(request);
  if (!body.ok) return body.response;
  const record = typeof body.value === "object" && body.value !== null ? (body.value as Record<string, unknown>) : {};
  const { ticketId } = await params;
  try {
    const ticket = await updateSupportTicket({
      actorUserId: caller.user.id,
      ticketId,
      update: {
        status: record.status,
        priority: record.priority,
        assigneeUserId: record.assigneeUserId,
        relatedType: record.relatedType,
        relatedId: record.relatedId,
        reason: record.reason,
      },
    });
    return supportJson({ ticket });
  } catch (error) {
    return supportFailure(error, "The ticket could not be updated, so nothing was changed.");
  }
}
