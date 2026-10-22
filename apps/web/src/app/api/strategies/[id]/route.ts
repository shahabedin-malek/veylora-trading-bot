import { NextRequest } from "next/server";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import {
  ActivationNotFoundError,
  getStrategyActivationView,
  stopStrategyActivation,
} from "@/lib/strategies/activation";

/**
 * One activation: read it, or stop it.
 *
 * The id is the activation's id rather than the account's, so this route can grow into
 * several strategies per account without changing its shape. Ownership is part of the
 * lookup, not a check after it: another account's id is a 404 and never a hint that the
 * row exists.
 *
 * `DELETE` is idempotent by design — stopping an already stopped activation answers 200
 * and writes nothing — and it never touches an order. An order already at a venue keeps
 * its lifecycle and is reconciled by the order-reconciliation job.
 */

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal
    ? json(
        {
          error: refusal.error,
          ...(refusal.code ? { code: refusal.code } : {}),
          ...(refusal.scope ? { scope: refusal.scope } : {}),
        },
        refusal.status,
      )
    : null;
}

async function ownedActivation(userId: string, activationId: string) {
  return prisma.strategyActivation.findFirst({
    where: { id: activationId, userId },
    select: { id: true },
  });
}

export async function GET(_request: NextRequest, { params }: RouteContext<"/api/strategies/[id]">) {
  const { id } = await params;
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "The activation state is unavailable." }, 503);
  }

  try {
    if (!(await ownedActivation(user.id, id))) {
      return json({ error: "No activation with that id belongs to this account." }, 404);
    }
    return json({ view: await getStrategyActivationView(user.id) });
  } catch {
    return json({ error: "The activation state could not be read." }, 503);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext<"/api/strategies/[id]">) {
  const { id } = await params;
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  try {
    if (!(await ownedActivation(user.id, id))) {
      return json({ error: "No activation with that id belongs to this account." }, 404);
    }
    const result = await stopStrategyActivation({ userId: user.id, activationId: id });
    return json({
      view: result.view,
      changed: result.changed,
      message: result.message,
      auditAction: result.auditAction,
    });
  } catch (error) {
    if (error instanceof ActivationNotFoundError) {
      return json({ error: error.message, code: "ACTIVATION_NOT_FOUND" }, 404);
    }
    return json({ error: "The stop could not be saved and audited." }, 503);
  }
}
