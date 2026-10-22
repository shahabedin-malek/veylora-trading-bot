import { NextRequest } from "next/server";
import { SAVED_REPLY_PLACEHOLDERS, validateSavedReplyDraft } from "@/lib/support/tickets";
import { listSavedReplies, saveSavedReply } from "@/lib/support/repository";
import {
  readSupportBody,
  requireSameOrigin,
  requireSupportCaller,
  supportFailure,
  supportJson,
} from "@/lib/support/http";

/** Saved replies and their placeholder vocabulary. */

export async function GET() {
  const caller = await requireSupportCaller("crm.support.read");
  if (!caller.ok) return caller.response;
  try {
    return supportJson({
      replies: await listSavedReplies(),
      placeholders: Object.entries(SAVED_REPLY_PLACEHOLDERS).map(([key, description]) => ({ key, description })),
    });
  } catch {
    return supportJson({ error: "Saved replies could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const origin = await requireSameOrigin(request);
  if (origin) return origin;
  const caller = await requireSupportCaller("crm.support.manage");
  if (!caller.ok) return caller.response;

  const body = await readSupportBody(request);
  if (!body.ok) return body.response;
  const draft = validateSavedReplyDraft(body.value);
  if (!draft.valid) return supportJson({ error: draft.error }, 400);

  try {
    return supportJson({ reply: await saveSavedReply({ actorUserId: caller.user.id, draft: draft.value }) }, 201);
  } catch (error) {
    return supportFailure(error, "The saved reply could not be written.");
  }
}
