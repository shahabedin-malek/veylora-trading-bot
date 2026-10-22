import { NextRequest } from "next/server";
import { deleteSavedReply } from "@/lib/support/repository";
import { requireSameOrigin, requireSupportCaller, supportFailure, supportJson } from "@/lib/support/http";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ replyId: string }> }) {
  const origin = await requireSameOrigin(request);
  if (origin) return origin;
  const caller = await requireSupportCaller("crm.support.manage");
  if (!caller.ok) return caller.response;
  const { replyId } = await params;
  try {
    const deleted = await deleteSavedReply(replyId);
    return deleted ? supportJson({ deleted: true }) : supportJson({ error: `No saved reply ${replyId}.` }, 404);
  } catch (error) {
    return supportFailure(error, "The saved reply could not be deleted.");
  }
}
