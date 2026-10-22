import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireSessionRecord } from "@/lib/auth/session-store";
import {
  revokeOtherSessions,
  revokeSessionById,
  sortSessionsForList,
  summariseSession,
  type SessionRecordStore,
} from "@/lib/auth/session-record";
import { auditCreate } from "@/lib/audit/record";

const MAX_BODY_BYTES = 2_048;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * One device's view of every session, and the two ways to end them.
 *
 * The list and the request path read the same row through the same rule
 * (`sessionIsUsable`), which is the point: a row the list shows as ended is a row
 * a request refuses, so the list can be trusted as an answer to "is that device
 * still signed in?" rather than being a decoration over a cookie that still works.
 *
 * Revocation is deliberately not gated behind a code, even when the funding scope
 * is on. Ending a device is how the owner responds to seeing one they do not
 * recognise; putting a second factor in front of it would be putting a lock on the
 * fire exit.
 */
export async function GET() {
  // A deployment that cannot authenticate anyone says which name is missing,
  // like every other owner route, instead of asking a visitor to sign in to a
  // sign-in that cannot complete.
  if (!getAuthConfig()) return authenticationGapResponse();

  let current;
  try {
    current = await requireSessionRecord();
  } catch {
    return json({ error: "Authentication required." }, 401);
  }

  try {
    const rows = await prisma.authSession.findMany({
      where: { userId: current.session.userId },
      orderBy: { lastSeenAt: "desc" },
      take: 100,
    });
    const now = new Date();
    return json({
      currentSessionId: current.session.id,
      sessions: sortSessionsForList(rows).map((row) => summariseSession(row, { currentSessionId: current.session.id, now })),
    });
  } catch {
    return json({ error: "Sessions could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let current;
  try {
    current = await requireSessionRecord();
  } catch {
    return json({ error: "Authentication required." }, 401);
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: { action?: unknown; sessionId?: unknown; reason?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim().slice(0, 200)
    : "Ended from the session list.";
  const now = new Date();
  const store = (transaction: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]): SessionRecordStore => ({
    findSession: (sessionId) => transaction.authSession.findUnique({ where: { id: sessionId } }),
    listSessions: (userId) => transaction.authSession.findMany({ where: { userId } }),
    revokeSession: async ({ sessionId, at, reason: revocationReason }) => {
      const result = await transaction.authSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: at, revokedReason: revocationReason },
      });
      return result.count === 1;
    },
    revokeSessionsExcept: async ({ userId, keepSessionId, at, reason: revocationReason }) => {
      const targets = await transaction.authSession.findMany({
        where: { userId, revokedAt: null, id: { not: keepSessionId } },
        select: { id: true },
      });
      if (targets.length === 0) return [];
      await transaction.authSession.updateMany({
        where: { id: { in: targets.map(({ id }) => id) } },
        data: { revokedAt: at, revokedReason: revocationReason },
      });
      return targets.map(({ id }) => id);
    },
    recordAudit: async ({ actorUserId, action, objectId, reason: auditReason, detail }) => {
      await auditCreate(transaction, {
        data: {
          actorUserId,
          action,
          objectType: "AuthSession",
          objectId,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ reason: auditReason, ...detail }),
        },
      });
    },
  });

  try {
    if (body.action === "revoke") {
      if (typeof body.sessionId !== "string" || !/^[a-f0-9]{32}$/.test(body.sessionId)) {
        return json({ error: "A session id is required.", code: "SESSION_ID_REQUIRED" }, 400);
      }
      if (body.sessionId === current.session.id) {
        return json(
          {
            error: "That is this device's own session. Use sign out for it, so the cookie is cleared with it.",
            code: "CURRENT_SESSION",
          },
          400,
        );
      }
      const sessionId = body.sessionId;
      const outcome = await prisma.$transaction((transaction) => revokeSessionById({
        store: store(transaction),
        userId: current.session.userId,
        sessionId,
        at: now,
        reason,
      }));
      if (!outcome.revoked) {
        const status = outcome.reason === "NOT_YOURS" ? 403 : outcome.reason === "NOT_FOUND" ? 404 : 409;
        return json({ error: "That session could not be revoked.", code: outcome.reason }, status);
      }
      return json({ revoked: true, sessionId: outcome.sessionId, deviceLabel: outcome.deviceLabel });
    }

    if (body.action === "revoke-others") {
      const outcome = await prisma.$transaction((transaction) => revokeOtherSessions({
        store: store(transaction),
        userId: current.session.userId,
        keepSessionId: current.session.id,
        at: now,
        reason,
      }));
      return json({ revoked: outcome.revokedSessionIds.length, revokedSessionIds: outcome.revokedSessionIds });
    }

    return json({ error: "Unsupported action. Use revoke or revoke-others.", code: "UNSUPPORTED_ACTION" }, 400);
  } catch {
    return json({ error: "The session could not be revoked." }, 503);
  }
}
