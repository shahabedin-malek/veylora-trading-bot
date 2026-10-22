import { NextRequest } from "next/server";
import { validateMessageDraft } from "@/lib/support/tickets";
import { addTicketMessage } from "@/lib/support/repository";
import {
  readSupportBody,
  requireSameOrigin,
  requireSupportCaller,
  supportFailure,
  supportJson,
} from "@/lib/support/http";

/**
 * Append to a ticket's thread.
 *
 * `visibility` decides who can ever read the row: PUBLIC reaches the account's own
 * endpoint, INTERNAL does not. The message is written with its visibility in the
 * row, so the UI's label is a rendering of the data rather than the rule.
 */

export async function POST(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const origin = await requireSameOrigin(request);
  if (origin) return origin;
  const caller = await requireSupportCaller("crm.support.manage");
  if (!caller.ok) return caller.response;

  const body = await readSupportBody(request);
  if (!body.ok) return body.response;
  const draft = validateMessageDraft(body.value);
  if (!draft.valid) return supportJson({ error: draft.error }, 400);

  const { ticketId } = await params;
  try {
    const ticket = await addTicketMessage({ actorUserId: caller.user.id, ticketId, authorType: "STAFF", draft: draft.value });
    return supportJson({ ticket }, 201);
  } catch (error) {
    return supportFailure(error, "The message could not be written, so the thread is unchanged.");
  }
}
