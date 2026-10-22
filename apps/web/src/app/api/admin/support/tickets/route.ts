import { NextRequest } from "next/server";
import { TICKET_PRIORITIES, TICKET_STATUSES, validateTicketDraft } from "@/lib/support/tickets";
import { createSupportTicket, listSupportTickets } from "@/lib/support/repository";
import {
  readSupportBody,
  requireSameOrigin,
  requireSupportCaller,
  supportFailure,
  supportJson,
} from "@/lib/support/http";

/**
 * The ticket list and its creation.
 *
 * A filter value outside the model's own set is a 400 naming the set rather than
 * a silently empty list. Creating a ticket is one step: the operator's action is
 * the authorisation, and the ticket, its audit row and its link are validated
 * before either is written.
 */

export async function GET(request: NextRequest) {
  const caller = await requireSupportCaller("crm.support.read");
  if (!caller.ok) return caller.response;

  const search = new URL(request.url).searchParams;
  const status = search.get("status")?.trim().toUpperCase() ?? "";
  const priority = search.get("priority")?.trim().toUpperCase() ?? "";
  if (status && !(TICKET_STATUSES as readonly string[]).includes(status)) {
    return supportJson({ error: `Status is one of ${TICKET_STATUSES.join(", ")}.` }, 400);
  }
  if (priority && !(TICKET_PRIORITIES as readonly string[]).includes(priority)) {
    return supportJson({ error: `Priority is one of ${TICKET_PRIORITIES.join(", ")}.` }, 400);
  }
  const q = (search.get("q") ?? "").slice(0, 160);
  const assignee = (search.get("assignee") ?? "").slice(0, 128);
  try {
    const tickets = await listSupportTickets({
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(assignee ? { assignee } : {}),
    });
    return supportJson({ tickets, count: tickets.length, readAt: new Date().toISOString() });
  } catch {
    return supportJson({ error: "The ticket list could not be read from the database." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const origin = await requireSameOrigin(request);
  if (origin) return origin;
  const caller = await requireSupportCaller("crm.support.manage");
  if (!caller.ok) return caller.response;

  const body = await readSupportBody(request);
  if (!body.ok) return body.response;
  const draft = validateTicketDraft(body.value);
  if (!draft.valid) return supportJson({ error: draft.error }, 400);

  try {
    const ticket = await createSupportTicket({ actorUserId: caller.user.id, value: draft.value });
    return supportJson({ ticket }, 201);
  } catch (error) {
    return supportFailure(error, "The ticket could not be written, so nothing was created.");
  }
}
