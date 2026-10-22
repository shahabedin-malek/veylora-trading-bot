import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { AUTH_COOKIE_NAME, getAuthConfig, getSessionSigningSecret, isSameOriginRequest } from "@/lib/auth/config";
import { isAccountType } from "@/lib/auth/contract-account";
import { getCurrentSession } from "@/lib/auth/session-store";
import { revokeSession, type SessionRevocation } from "@/lib/auth/session-revocation";
import { verifySessionCookieValue } from "@/lib/auth/session-token";
import { normalizeWalletAddress } from "@/lib/auth/wallet-address";
import { auditCreate } from "@/lib/audit/record";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const current = await getCurrentSession();
  if (!current) return json({ authenticated: false });

  const storedAccountType = current.walletIdentity?.accountType;
  return json({
    authenticated: true,
    user: {
      role: current.role,
      // Checksummed, from the canonical column: the same wallet reads the same
      // way here as it does in the top bar and in the audit trail.
      address: normalizeWalletAddress(current.walletIdentity?.addressCanonical)?.display ?? null,
      chainNamespace: current.walletIdentity?.chainNamespace ?? null,
      chainReference: current.walletIdentity?.chainReference ?? null,
      // Which kind of account this is — a key-based account, or a contract
      // wallet that verified through EIP-1271. Everything above is identical for
      // both, because the session is: no permission or role depends on it. Read
      // through `isAccountType`, so a value this build does not know reads as a
      // key-based account instead of being passed on as if it meant something.
      accountType: isAccountType(storedAccountType) ? storedAccountType : ("EOA" as const),
      // So a client can say when this session ends instead of guessing.
      expiresAt: new Date(current.claims.expiresAt * 1000).toISOString(),
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
  let revoked: SessionRevocation | null = null;
  if (signingSecret && cookieValue) {
    const claims = verifySessionCookieValue(cookieValue, signingSecret);
    if (claims) {
      try {
        revoked = await prisma.$transaction((transaction) => revokeSession({
          claims,
          now: new Date(),
          store: {
            findUser: (userId) => transaction.user.findUnique({ where: { id: userId } }),
            incrementSessionVersion: async (userId) => {
              const updated = await transaction.user.update({
                where: { id: userId },
                data: { sessionVersion: { increment: 1 } },
              });
              return updated.sessionVersion;
            },
            recordSignOut: async ({ userId, sessionVersion, at }) => {
              await auditCreate(transaction, {
                data: {
                  actorUserId: userId,
                  action: "AUTH_SIGN_OUT",
                  objectType: "User",
                  objectId: userId,
                  outcome: "SUCCESS",
                  redactedJson: JSON.stringify({ sessionVersion, scope: "account-wide" }),
                },
              });
              // Signing out bumps the account's session version, which ends every
              // cookie the account has, so every session row is marked ended too.
              // A row left ACTIVE here would make the session list claim a device
              // is signed in when its cookie has already stopped working.
              await transaction.authSession.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: at, revokedReason: "SIGN_OUT" },
              });
            },
          },
        }));
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

  return json({
    signedOut: true,
    // Says which of the two things happened: the session was ended on the
    // server, or the cookie presented was already past being usable.
    session: revoked?.revoked ? "REVOKED" : revoked ? revoked.reason : "NO_SESSION",
  });
}
