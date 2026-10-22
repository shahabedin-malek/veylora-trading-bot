import { NextRequest } from "next/server";
import { validateNoteDraft } from "@/lib/support/tickets";
import { addUserNote } from "@/lib/support/repository";
import {
  readSupportBody,
  requireSameOrigin,
  requireSupportCaller,
  supportFailure,
  supportJson,
} from "@/lib/support/http";

/**
 * An internal note on an account.
 *
 * A note is its own table with no visibility column, so there is no value a bug
 * could flip to show it to the account. It appears on the operator's timeline and
 * in a ticket export (marked internal) and nowhere the account can reach.
 */

export async function POST(request: NextRequest) {
  const origin = await requireSameOrigin(request);
  if (origin) return origin;
  const caller = await requireSupportCaller("crm.support.manage");
  if (!caller.ok) return caller.response;

  const body = await readSupportBody(request);
  if (!body.ok) return body.response;
  const note = validateNoteDraft(body.value);
  if (!note.valid) return supportJson({ error: note.error }, 400);

  try {
    return supportJson({ note: await addUserNote({ actorUserId: caller.user.id, note: note.value }) }, 201);
  } catch (error) {
    return supportFailure(error, "The note could not be written, so nothing was added.");
  }
}
