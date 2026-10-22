import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { SiweMessage } from "siwe";
import { prisma } from "@/lib/db";
import {
  AUTH_COOKIE_NAME,
  AUTH_SESSION_TTL_SECONDS,
  getAuthConfig,
  isSameOriginRequest,
  shouldBootstrapInitialAdmin,
} from "@/lib/auth/config";
import { authenticationGapResponse } from "@/lib/auth/access-gate";
import { createContractAccountVerifier } from "@/lib/auth/contract-account";
import { hashAuthNonce, inspectAuthNonce } from "@/lib/auth/nonce";
import { createSessionId, describeDevice } from "@/lib/auth/session-record";
import { createSessionCookieValue } from "@/lib/auth/session-token";
import { isScopeRequired, loadSecurityPolicyForEnforcement } from "@/lib/auth/security-policy";
import { planSignInProvisioning } from "@/lib/auth/sign-in-provisioning";
import { hasActivatedTotp } from "@/lib/auth/step-up";
import { verifyCode } from "@/lib/auth/totp-service";
import { classifySubmittedCode } from "@/lib/auth/totp";
import { issueDepositAddressesForSignIn } from "@/lib/deposits/sign-in";
import { clientAddress, consumeRateLimit, RATE_LIMITS, rateLimitResponse } from "@/lib/security/rate-limit";
import { totpStore } from "@/lib/auth/totp-store";
import { SiweVerificationError, statusForSiweVerificationCode, verifySiweMessage } from "@/lib/auth/siwe";
import { auditCreate } from "@/lib/audit/record";

class AuthFlowError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/**
 * Every refusal carries a machine-readable `code` next to its sentence, so the
 * login page can name the situation (an expired nonce is a slow user, a reused
 * one is a replay, an unreachable contract check is "try again") instead of
 * showing whichever wall of text came back.
 *
 * `retryable` is sent when the refusal has an opinion about whether the same
 * request could succeed later — a contract wallet whose chain could not be asked
 * is the case that needs it. The client honours it rather than guessing from the
 * status code, which is what keeps "we could not check this" from reading as
 * "this is permanently refused".
 */
function jsonError(error: string, status: number, code?: string, retryable?: boolean, extra?: Record<string, unknown>) {
  return Response.json(
    { error, ...(code ? { code } : {}), ...(retryable === undefined ? {} : { retryable }), ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Where the device observations come from.
 *
 * Both are observations, never authorization: the session list shows them so a
 * surprising device can be recognised, and neither is ever consulted to decide
 * whether a request may proceed. The address is taken from the proxy headers the
 * deployment sits behind, so it is only as trustworthy as that proxy — which is
 * exactly why nothing depends on it.
 */
function observeRequestDevice(request: NextRequest) {
  const userAgent = request.headers.get("user-agent");
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ipAddress = forwarded || request.headers.get("x-real-ip")?.trim() || null;
  return { userAgent, ipAddress, deviceLabel: describeDevice(userAgent).label };
}

/**
 * The account a repeat sign-in belongs to.
 *
 * The provisioning plan only says "create nothing" when a wallet identity was
 * found, and an identity always names its account — so this states that
 * invariant instead of asserting it away.
 */
function requireAccountId(account: { id: string } | null): string {
  if (!account) throw new AuthFlowError(500, "The account for this sign-in could not be resolved.");
  return account.id;
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return jsonError("Request origin is not allowed.", 403);

  // Verifying a signature recovers an address (and, for a smart account, makes an RPC call).
  // The ceiling is per caller and applies before the body is read, so a flood of bad
  // signatures cannot be turned into unbounded recovery work.
  const limit = consumeRateLimit(`auth.verify:${clientAddress(request)}`, RATE_LIMITS.authVerifyPerMinute);
  if (!limit.allowed) {
    return rateLimitResponse(
      limit,
      `Too many sign-in attempts from this address: ${limit.limit} per minute. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError("Invalid request body.", 400);
  }
  if (Buffer.byteLength(rawBody, "utf8") > 12_288) return jsonError("Request is too large.", 413);

  let body: { message?: unknown; signature?: unknown; code?: unknown; backupCode?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  if (typeof body.message !== "string" || typeof body.signature !== "string") {
    return jsonError("A SIWE message and signature are required.", 400);
  }

  let parsedMessage: SiweMessage;
  try {
    parsedMessage = new SiweMessage(body.message);
  } catch {
    return jsonError("SIWE message is malformed.", 401, "MALFORMED_MESSAGE");
  }

  const nonceHash = hashAuthNonce(parsedMessage.nonce);
  const now = new Date();
  let nonceRecord;
  try {
    nonceRecord = await prisma.authNonce.findUnique({ where: { nonceHash } });
  } catch {
    return jsonError("Authentication storage is unavailable.", 503);
  }
  const nonce = inspectAuthNonce(nonceRecord, now);
  if (!nonce.ok) return jsonError(nonce.error, 401, nonce.code);

  let verified;
  try {
    verified = await verifySiweMessage({
      message: body.message,
      signature: body.signature,
      expectedNonce: parsedMessage.nonce,
      domain: config.domain,
      uri: config.loginUri,
      scheme: config.scheme,
      allowedChainIds: config.allowedChainIds,
      now,
      // A signature no key produced is put to the contract that claims it, on
      // the chain the message names, with a bounded timeout. It is the only way
      // a smart account can sign in — and a check that cannot be completed
      // returns as its own coded refusal, never as an accepted signature.
      contractVerifier: createContractAccountVerifier(),
    });
  } catch (error) {
    if (error instanceof SiweVerificationError) {
      return jsonError(error.message, statusForSiweVerificationCode(error.code), error.code, error.retryable);
    }
    return jsonError("SIWE verification failed.", 401, "SIGNATURE_INVALID", false);
  }

  if (
    nonce.record.addressCanonical !== verified.addressCanonical ||
    nonce.record.chainId !== verified.chainId ||
    nonce.record.domain !== config.domain ||
    nonce.record.uri !== config.loginUri
  ) {
    return jsonError("SIWE request does not match its issued nonce.", 401);
  }

  const sessionExpiresAt = new Date(now.getTime() + AUTH_SESSION_TTL_SECONDS * 1000);
  const identityKey = {
    chainNamespace_chainReference_addressCanonical: {
      chainNamespace: "eip155",
      chainReference: String(verified.chainId),
      addressCanonical: verified.addressCanonical,
    },
  };
  const device = observeRequestDevice(request);
  const sessionId = createSessionId();

  // The sign-in second factor, checked *before* the exchange rather than inside
  // it. Two reasons, and both matter:
  //   * a wrong code has to be counted even though no session is created, so the
  //     lockout cannot be escaped by never finishing a sign-in;
  //   * the code is not spent on a sign-in that then fails for another reason.
  // What it costs is one extra code check on an account that has 2FA on for
  // sign-in, which is the point of having it on.
  const { policy } = await loadSecurityPolicyForEnforcement();
  let totpVerifiedAt: Date | null = null;
  let totpStep: number | null = null;
  if (isScopeRequired(policy, "sign-in")) {
    const existingIdentity = await prisma.walletIdentity.findUnique({ where: identityKey, select: { userId: true } });
    // A brand-new wallet has no credential and cannot be asked for a code: the
    // requirement is not enforceable until there is an authenticator behind it,
    // and enforcing it anyway would make a new sign-in impossible to complete.
    if (existingIdentity && (await hasActivatedTotp(existingIdentity.userId))) {
      if (body.code === undefined && body.backupCode === undefined) {
        return jsonError(
          "Sign-in needs a code from your authenticator app, because the sign-in scope is switched on for this account.",
          428,
          "TOTP_REQUIRED",
          false,
          { scope: "sign-in" },
        );
      }
      // One input, two kinds of code: whatever the person typed is sorted by its
      // own shape, so a backup code typed into the code field still recovers the
      // account. Nothing here decides *whether* two-factor is required — the
      // policy above does — only which kind of code arrived.
      const submitted = classifySubmittedCode(body.code ?? body.backupCode);
      const checked = await prisma.$transaction((transaction) => verifyCode({
        store: totpStore(transaction),
        userId: existingIdentity.userId,
        code: submitted.kind === "totp" ? submitted.normalized : undefined,
        backupCode: submitted.kind === "backup" ? submitted.normalized : undefined,
        now,
        purpose: "step-up",
        policy: { maxFailedAttempts: policy.maxFailedAttempts, lockoutMinutes: policy.lockoutMinutes },
      }));
      if (!checked.ok) {
        return jsonError(checked.error, checked.status, checked.code, false, {
          scope: "sign-in",
          failedAttempts: checked.failedAttempts,
          lockedUntil: checked.lockedUntil,
        });
      }
      totpVerifiedAt = now;
      totpStep = checked.method === "TOTP" ? checked.step ?? null : null;
    }
  }

  try {
    const sessionInfo = await prisma.$transaction(async (transaction) => {
      const consumed = await transaction.authNonce.updateMany({
        where: {
          nonceHash,
          addressCanonical: verified.addressCanonical,
          chainId: verified.chainId,
          domain: config.domain,
          uri: config.loginUri,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new AuthFlowError(401, "This sign-in request was already exchanged for a session, so it cannot be used again. Start sign-in again.", "NONCE_REUSED");

      // What this sign-in writes to the account is decided *before* it is
      // written, by a pure function, so "a first sign-in creates exactly one
      // account and one wallet identity, and a repeat sign-in creates neither"
      // is a rule with a name and a test rather than a shape of branches.
      let identity = await transaction.walletIdentity.findUnique({ where: identityKey });
      const account = identity
        ? await transaction.user.findUnique({
            where: { id: identity.userId },
            include: {
              roles: { where: { scope: "global", revokedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
            },
          })
        : null;
      const activeOwner = await transaction.roleAssignment.findFirst({
        where: { role: "OWNER", scope: "global", revokedAt: null },
        select: { id: true },
      });
      const plan = planSignInProvisioning({
        identity: identity
          ? { id: identity.id, userId: identity.userId, accountType: identity.accountType, revokedAt: identity.revokedAt }
          : null,
        account: account ? { id: account.id, status: account.status } : null,
        provedAccountType: verified.accountType,
        currentRole: account?.roles[0]?.role ?? null,
        activeOwnerExists: !!activeOwner,
        ownerBootstrapApplies: shouldBootstrapInitialAdmin({
          addressCanonical: verified.addressCanonical,
          chainId: verified.chainId,
          activeOwnerExists: !!activeOwner,
        }),
      });
      if (plan.outcome === "refused") throw new AuthFlowError(plan.status, plan.message);

      // A first sign-in inserts the account; every later one moves its last-seen
      // forward and touches nothing else. Which is why a repeat sign-in can be
      // seen on the record without the wallet ever being duplicated.
      const user = plan.creates.users === 1
        ? await transaction.user.create({ data: { status: "ACTIVE", lastSeenAt: now } })
        : await transaction.user.update({ where: { id: requireAccountId(account) }, data: { lastSeenAt: now } });

      if (plan.creates.walletIdentities === 1) {
        identity = await transaction.walletIdentity.create({
          data: {
            userId: user.id,
            chainNamespace: "eip155",
            chainReference: String(verified.chainId),
            addressCanonical: verified.addressCanonical,
            addressDisplay: verified.addressDisplay,
            proofType: "SIWE_EIP4361",
            accountType: verified.accountType,
          },
        });
      } else if (identity && plan.rewriteAccountType) {
        // How this identity's last proof was made is a fact about the account,
        // not about the session: an address whose contract answers for it now is
        // recorded as a contract wallet, so what an administrator sees is how
        // the sign-in in front of them was verified rather than what was true
        // when the row was first created.
        identity = await transaction.walletIdentity.update({
          where: { id: identity.id },
          data: { accountType: plan.rewriteAccountType },
        });
      }
      if (!identity) throw new AuthFlowError(500, "The wallet identity for this sign-in could not be resolved.");

      let roleValue = plan.role;
      if (plan.bootstrapOwner) {
        await transaction.roleAssignment.updateMany({
          where: { userId: user.id, scope: "global", revokedAt: null },
          data: { revokedAt: now },
        });
      }
      if (plan.assignRole) {
        const assignment = await transaction.roleAssignment.create({
          data: { userId: user.id, role: plan.role, scope: "global" },
        });
        roleValue = assignment.role;
        if (plan.bootstrapOwner) {
          await auditCreate(transaction, {
            data: {
              actorUserId: user.id,
              action: "INITIAL_OWNER_BOOTSTRAP",
              objectType: "RoleAssignment",
              objectId: assignment.id,
              outcome: "SUCCESS",
              redactedJson: JSON.stringify({
                chainNamespace: "eip155",
                chainReference: "1",
                proofType: "SIWE_EIP4361",
                accountType: verified.accountType,
              }),
            },
          });
        }
      }

      // One row per device, created with the session it belongs to. The id is in
      // the cookie as well, so "which device is this?" is answerable from the
      // request itself rather than inferred, and "end that device" has something
      // to end. `totpVerifiedAt` is only set when a code was accepted a moment
      // ago, so the step-up window of the session that just started is honest.
      const session = await transaction.authSession.create({
        data: {
          id: sessionId,
          userId: user.id,
          walletIdentityId: identity.id,
          chainNamespace: "eip155",
          chainReference: String(verified.chainId),
          deviceLabel: device.deviceLabel,
          userAgent: device.userAgent,
          ipAddress: device.ipAddress,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: sessionExpiresAt,
          totpVerifiedAt,
          totpLastStep: totpStep,
        },
      });

      await auditCreate(transaction, {
        data: {
          actorUserId: user.id,
          action: "AUTH_SIGN_IN",
          objectType: "WalletIdentity",
          objectId: identity.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({
            chainNamespace: "eip155",
            chainReference: String(verified.chainId),
            // How the signature was proved, in the audit trail: `ecrecover` for
            // a key-based account, or the account's own contract answering
            // through EIP-1271.
            accountType: verified.accountType,
            // Whether this sign-in also carried a code, and which device it
            // opened — the two facts the session list is built on.
            secondFactor: totpVerifiedAt ? "TOTP" : null,
            sessionId: session.id,
            deviceLabel: session.deviceLabel,
            // What this sign-in created, written down: zero accounts and zero
            // wallet identities on a repeat sign-in is the invariant, and the
            // audit row is where it can be checked afterwards.
            created: plan.creates,
            newAccount: plan.newAccount,
            role: roleValue,
            ownerBootstrap: plan.bootstrapOwner,
          }),
        },
      });

      return {
        address: identity.addressDisplay,
        role: roleValue,
        // The login page uses this to open the onboarding checklist for a
        // brand-new account instead of dropping the person on an overview full
        // of surfaces they have not set up yet.
        newAccount: plan.newAccount,
        // The same session for both account kinds, plus which kind it was: the
        // cookie, the role resolution and the permission model are untouched by
        // an account being a contract.
        accountType: identity.accountType,
        userId: user.id,
        walletIdentityId: identity.id,
        sessionVersion: user.sessionVersion,
        sessionId: session.id,
      };
    });

    // The deposit addresses for this account, issued with the sign-in that found
    // or created it. This runs *after* the session transaction has committed and
    // can never refuse the sign-in: an unconfigured `DEPOSIT_ADDRESS_MNEMONIC` is
    // a skip that names the variable, a storage failure is logged and reported as
    // `failed`, and neither costs the person their session. The address itself is
    // a pure function of (seed, account id, network), so a sign-in that skipped
    // issuance still shows the same address the next time it runs — or the first
    // time the deposit surface is read, which issues it too.
    const deposits = await issueDepositAddressesForSignIn({ userId: sessionInfo.userId, now });

    const cookieValue = createSessionCookieValue(
      {
        userId: sessionInfo.userId,
        walletIdentityId: sessionInfo.walletIdentityId,
        sessionId: sessionInfo.sessionId,
        chainNamespace: "eip155",
        chainReference: String(verified.chainId),
        sessionVersion: sessionInfo.sessionVersion,
        issuedAt: Math.floor(now.getTime() / 1000),
        expiresAt: Math.floor(sessionExpiresAt.getTime() / 1000),
      },
      config.sessionSecret,
    );

    const cookieStore = await cookies();
    cookieStore.set(AUTH_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "strict",
      path: "/",
      expires: sessionExpiresAt,
      maxAge: AUTH_SESSION_TTL_SECONDS,
    });

    // `twoFactor` says which of the two sign-in paths this session was created
    // by, so the page can tell the person their code was part of what signed them
    // in rather than leaving them to wonder whether it counted. `deposits`
    // reports what this sign-in issued, and names the networks it could not — the
    // sign-in is unaffected either way.
    return Response.json(
      {
        authenticated: true,
        twoFactor: totpVerifiedAt !== null,
        ...sessionInfo,
        deposits: {
          issued: deposits.issued,
          existing: deposits.existing,
          failed: deposits.failed,
          unavailable: deposits.skipped.map((entry) => ({
            network: entry.network,
            code: entry.reason.code,
            message: entry.reason.message,
            variable: entry.reason.variable ?? null,
          })),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthFlowError) return jsonError(error.message, error.status, error.code);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return jsonError("This wallet is already linked to another account.", 409);
    }
    return jsonError("Sign-in could not be completed.", 500);
  }
}