import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { AUTH_COOKIE_NAME, getAuthConfig } from "@/lib/auth/config";
import { isAccountType } from "@/lib/auth/contract-account";
import { sessionMatchesUser, verifySessionCookieValue } from "@/lib/auth/session-token";
import { sessionIsUsable, type SessionRecordRow } from "@/lib/auth/session-record";
import { normalizeWalletAddress } from "@/lib/auth/wallet-address";
import { missingPermissionMessage, type SitePermissionKey } from "@/lib/auth/access-control";

/**
 * How stale "last seen" is allowed to get before a request writes it.
 *
 * The column answers "was this device used recently?" — a question whose answer
 * does not change second by second — so writing it on every request would be a
 * write per page view for nothing. A conditional update that matches only when
 * the stored value is older than this keeps the column honest and the hot path
 * free of writes.
 */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export async function getCurrentSession() {
  const config = getAuthConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!cookieValue) return null;

  const claims = verifySessionCookieValue(cookieValue, config.sessionSecret);
  if (!claims || !config.allowedChainIds.has(Number(claims.chainReference))) return null;

  const [user, walletIdentity, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id: claims.userId },
      include: {
        roles: {
          where: { scope: "global", revokedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    }),
    prisma.walletIdentity.findUnique({ where: { id: claims.walletIdentityId } }),
    prisma.authSession.findUnique({ where: { id: claims.sessionId } }),
  ]);

  // One shared rule with the sign-out route (`sessionMatchesUser`), so the
  // cookie that sign-out invalidates is exactly the cookie pages accept.
  if (!user || !sessionMatchesUser(claims, user)) return null;
  if (!walletIdentity || walletIdentity.userId !== user.id || walletIdentity.revokedAt) return null;
  if (walletIdentity.chainNamespace !== claims.chainNamespace || walletIdentity.chainReference !== claims.chainReference) return null;

  // The second rule, and the one that makes the session list real: the row this
  // cookie names must still be live. A row revoked a moment ago fails here on the
  // very next request, for that device only — which is what "revocation is
  // effective on the next request" means, and why nothing has to be pushed to a
  // browser for it to take effect.
  const now = new Date();
  if (sessionIsUsable(session, { userId: user.id, now }) !== "active") return null;

  await touchSessionLastSeen(session as SessionRecordRow, now);

  return {
    claims,
    user,
    walletIdentity,
    session: session as SessionRecordRow,
    role: user.roles[0]?.role ?? "VIEWER",
  };
}

/** Best-effort and bounded: one conditional UPDATE at most every five minutes. */
async function touchSessionLastSeen(session: SessionRecordRow, now: Date): Promise<void> {
  if (now.getTime() - session.lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS) return;
  try {
    await prisma.authSession.updateMany({
      where: { id: session.id, revokedAt: null, lastSeenAt: { lt: new Date(now.getTime() - LAST_SEEN_REFRESH_MS) } },
      data: { lastSeenAt: now },
    });
  } catch {
    // Last-seen is an observation, not part of deciding whether the session is
    // valid: a failure to record it must never fail the request that observed it.
  }
}

export class AuthenticationRequiredError extends Error {
  readonly status = 401;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

export class AuthorizationRequiredError extends Error {
  readonly status = 403;

  /**
   * The permission this account lacked, when the refusal was about one.
   *
   * Carried as a field, not only inside the prose: a caller that wants to react
   * (the admin UI offering the grant that fixes it, a test asserting the exact
   * key) reads the key instead of parsing the message.
   */
  constructor(
    message = "Administrator role required: this surface needs the ADMIN or OWNER role.",
    readonly permissionKey?: SitePermissionKey,
  ) {
    super(message);
    this.name = "AuthorizationRequiredError";
  }
}

/**
 * A session that is signed in but has not proved a code for the action at hand.
 *
 * Not an authorization failure and not an authentication failure: the account may
 * do this, it just has to prove the code first. 428 says exactly that, and the
 * `scope` in the body is what lets one prompt serve every gated surface instead
 * of each page inventing its own.
 */
export class StepUpRequiredError extends Error {
  readonly status = 428;
  readonly code = "TOTP_REQUIRED";

  constructor(readonly scope: string, message: string) {
    super(message);
    this.name = "StepUpRequiredError";
  }
}

export async function getCurrentUser() {
  const current = await getCurrentSession();
  return current ? toCurrentUser(current) : null;
}

/** One shape for "who is this", so the two readers cannot describe it differently. */
function toCurrentUser(current: NonNullable<Awaited<ReturnType<typeof getCurrentSession>>>) {
  const storedAccountType = current.walletIdentity?.accountType;
  return {
    id: current.user.id,
    role: current.role,
    // The checksummed form, derived from the stored canonical address rather
    // than from whatever casing the row happens to carry.
    address: normalizeWalletAddress(current.walletIdentity?.addressCanonical)?.display ?? null,
    chainNamespace: current.walletIdentity?.chainNamespace ?? null,
    chainReference: current.walletIdentity?.chainReference ?? null,
    // How this account's signature was proved. Read through `isAccountType`, so
    // a value this build does not know reads as a key-based account rather than
    // being passed on as if it meant something.
    accountType: isAccountType(storedAccountType) ? storedAccountType : ("EOA" as const),
    sessionExpiresAt: new Date(current.claims.expiresAt * 1000).toISOString(),
    // Which device this is, so the session list can say so instead of making the
    // owner guess which row is theirs.
    sessionId: current.session.id,
    // The two observations the account itself carries, surfaced here because the
    // pages that need them (the onboarding checklist and the admin directory)
    // already have this session in hand: re-reading the user row to ask when it
    // last signed in or last read a balance would be a second query for a fact
    // this one just loaded.
    lastSeenAt: current.user.lastSeenAt,
    lastBalanceReadAt: current.user.lastBalanceReadAt,
  };
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationRequiredError();
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN" && user.role !== "OWNER") throw new AuthorizationRequiredError();
  return user;
}

export async function requireSitePermission(permissionKey: SitePermissionKey) {
  const user = await requireUser();
  if (user.role === "ADMIN" || user.role === "OWNER") return user;

  const grant = await prisma.userPermissionGrant.findUnique({
    where: { userId_permissionKey: { userId: user.id, permissionKey } },
  });
  if (!grant || grant.revokedAt) {
    throw new AuthorizationRequiredError(missingPermissionMessage(permissionKey), permissionKey);
  }
  return user;
}

/**
 * The current session's own row, with the time a code was last accepted in it.
 *
 * Read by the routes that decide a step-up, and by nothing else: the value is a
 * fact about *this* session, so it must come from the row the cookie names rather
 * than from the account — a code entered on a phone must not unlock a laptop.
 */
export async function requireSessionRecord() {
  const current = await getCurrentSession();
  if (!current) throw new AuthenticationRequiredError();
  return { user: toCurrentUser(current), session: current.session };
}
