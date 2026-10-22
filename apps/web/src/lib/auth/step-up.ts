import { prisma } from "@/lib/db";
import { AuthenticationRequiredError, StepUpRequiredError, getCurrentSession } from "@/lib/auth/session-store";
import {
  decideStepUp,
  isScopeRequired,
  loadSecurityPolicyForEnforcement,
  type SecurityPolicy,
  type SecurityScope,
  type StepUpDecision,
} from "@/lib/auth/security-policy";

/**
 * The question a gated action asks before it runs: is a code needed, and is there
 * an authenticator that could produce one?
 *
 * This is the only place that reads the policy *and* the credential *and* this
 * session's last accepted code, because a step-up decided from any two of those
 * would be wrong:
 *   * policy alone would refuse a scope the owner turned on before enrolling;
 *   * credential alone would ignore the switch;
 *   * the account's last code would let a verification on one device unlock
 *     another, since the cookie points at the row and the row is per device.
 *
 * So the answer is computed per request, from data. There is nothing cached and
 * nothing pushed, which is what makes "changing a scope affects the gated action
 * immediately" true without a deploy, a restart or a socket.
 */

export type StepUpState = {
  scope: SecurityScope;
  policy: SecurityPolicy;
  enrolled: boolean;
  /** Null when there is no session to attach a verification to — callers refuse first. */
  sessionId: string | null;
  verifiedAt: Date | null;
  decision: StepUpDecision;
};

/** Whether this account has an authenticator that can actually produce codes. */
export async function hasActivatedTotp(userId: string): Promise<boolean> {
  const credential = await prisma.totpCredential.findUnique({
    where: { userId },
    select: { activatedAt: true, revokedAt: true },
  });
  return Boolean(credential && credential.activatedAt && !credential.revokedAt);
}

/**
 * The guard a gated route calls. Throws when a code is owed, and returns quietly
 * in the three cases where nothing is owed: the scope is off, there is no
 * authenticator to enforce it with, or this session proved a code recently.
 */
export async function assertScopeVerified(scope: SecurityScope, input: { now?: Date } = {}): Promise<StepUpState> {
  const state = await getStepUpState(scope, input);
  if (state.decision.required) throw new StepUpRequiredError(scope, state.decision.message);
  return state;
}

export async function getStepUpState(scope: SecurityScope, input: { now?: Date } = {}): Promise<StepUpState> {
  const session = await getCurrentSession();
  if (!session) throw new AuthenticationRequiredError();
  return getStepUpStateFor({
    scope,
    userId: session.user.id,
    sessionId: session.session.id,
    totpVerifiedAt: session.session.totpVerifiedAt,
    now: input.now ?? new Date(),
  });
}

/** The same computation with the session supplied, for callers that already have it. */
export async function getStepUpStateFor(input: {
  scope: SecurityScope;
  userId: string;
  sessionId: string;
  totpVerifiedAt: Date | null;
  now: Date;
}): Promise<StepUpState> {
  const { policy } = await loadSecurityPolicyForEnforcement();
  const enrolled = isScopeRequired(policy, input.scope) ? await hasActivatedTotp(input.userId) : false;
  return {
    scope: input.scope,
    policy,
    enrolled,
    sessionId: input.sessionId,
    verifiedAt: input.totpVerifiedAt,
    decision: decideStepUp({
      policy,
      scope: input.scope,
      enrolled,
      totpVerifiedAt: input.totpVerifiedAt,
      now: input.now,
    }),
  };
}

/**
 * A sentence for the admin panel, for a scope that is on with no authenticator.
 *
 * The mismatch is the owner's to fix, and it has to be reported where they can
 * fix it. Enforcing it instead would be a locked door with no key in it.
 */
export function describeUnenforcedScope(policy: SecurityPolicy, enrolled: boolean, scope: SecurityScope): string | null {
  if (!isScopeRequired(policy, scope) || enrolled) return null;
  return "This scope is on, but no authenticator is activated on this account, so it is not being enforced yet. Enrol an authenticator for it to take effect.";
}
