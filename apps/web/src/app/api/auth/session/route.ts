import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { AUTH_COOKIE_NAME, getAuthConfig, getSessionSigningSecret, isSameOriginRequest } from "@/lib/auth/config";
import { getCurrentSession } from "@/lib/auth/session-store";
import { verifySessionCookieValue } from "@/lib/auth/session-token";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const current = await getCurrentSession();
  if (!current) return json({ authenticated: false });

  return json({
    authenticated: true,
    user: {
      role: current.role,
      address: current.walletIdentity?.addressDisplay ?? null,
      chainNamespace: current.walletIdentity?.chainNamespace ?? null,
      chainReference: current.walletIdentity?.chainReference ?? null,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  const origin = request.headers.get("origin");
  const expectedOrigin = config?.origin ?? new URL(request.url).origin;
  if (!origin || origin !== expectedOrigin || (config && !isSameOriginRequest(request, config))) {
    return json({ error: "Request origin is not allowed." }, 403);
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const signingSecret = getSessionSigningSecret();
  if (signingSecret && cookieValue) {
    const claims = verifySessionCookieValue(cookieValue, signingSecret);
    if (claims) {
      try {
        await prisma.$transaction(async (transaction) => {
          const user = await transaction.user.findUnique({ where: { id: claims.userId } });
          if (!user || user.sessionVersion !== claims.sessionVersion) return;
          await transaction.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
          await transaction.auditEvent.create({
            data: {
              actorUserId: user.id,
              action: "AUTH_SIGN_OUT",
              objectType: "User",
              objectId: user.id,
              outcome: "SUCCESS",
            },
          });
        });
      } catch {
        return json({ error: "Sign-out could not be recorded." }, 503);
      }
    }
  }

  cookieStore.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: config?.secureCookies ?? process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });

  return json({ signedOut: true });
}
