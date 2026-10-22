import { prisma } from "@/lib/db";
import { auditCreate } from "@/lib/audit/record";

/**
 * What this account demands, as data.
 *
 * Three scopes — sign-in, trading, funding — each with its own switch, plus the
 * two numbers that make the lockout: how many wrong codes are tolerated and how
 * long the lock lasts. Nothing here is a constant in code and nothing here is
 * enforced unless the owner turned it on, because the alternative is a
 * requirement the owner cannot turn off, which is the thing this phase is
 * explicitly not allowed to add.
 *
 * Two rules are worth stating plainly, because both are about not locking the
 * owner out:
 *
 *   1. A scope with no *activated* authenticator is not enforceable, so it is
 *      reported as not enforced rather than refused. Turning trading on before
 *      enrolling is therefore a no-op with a sentence explaining it, never a
 *      trading page nobody can use.
 *   2. A missing policy row means "nothing is demanded", which is exactly what
 *      the seed writes. A deployment that has not been seeded yet demands
 *      nothing; it does not fail closed into a state the owner cannot leave.
 */

export const SECURITY_SCOPES = ["sign-in", "trading", "funding"] as const;
export type SecurityScope = (typeof SECURITY_SCOPES)[number];

/** What each scope guards, in the words the admin panel and the refusals use. */
export const SECURITY_SCOPE_CATALOG = [
  {
    key: "sign-in",
    label: "Sign-in",
    requirement: "A code from the authenticator app is required to finish signing in.",
    gatedAction: "signing in",
  },
  {
    key: "trading",
    label: "Trading",
    requirement: "A code from the authenticator app is required within the step-up window before an order is placed or cancelled.",
    gatedAction: "placing or cancelling an order",
  },
  {
    key: "funding",
    label: "Funding",
    requirement: "A code from the authenticator app is required within the step-up window before a venue key is saved, verified or removed.",
    gatedAction: "saving, verifying or removing a venue key",
  },
] as const satisfies readonly { key: SecurityScope; label: string; requirement: string; gatedAction: string }[];

export type SecurityPolicy = {
  requireTotpForSignIn: boolean;
  requireTotpForTrading: boolean;
  requireTotpForFunding: boolean;
  /** How long a step-up verification stays good for before a gated action asks again. */
  stepUpMinutes: number;
  maxFailedAttempts: number;
  lockoutMinutes: number;
};

export type SecurityPolicyValidation =
  | { valid: true; value: SecurityPolicy }
  | { valid: false; error: string };

/** Every scope off: the seeded state, and what an unseeded deployment reads as. */
export function defaultSecurityPolicy(): SecurityPolicy {
  return {
    requireTotpForSignIn: false,
    requireTotpForTrading: false,
    requireTotpForFunding: false,
    stepUpMinutes: 15,
    maxFailedAttempts: 5,
    lockoutMinutes: 15,
  };
}

const SCOPE_FIELD: Record<SecurityScope, keyof SecurityPolicy> = {
  "sign-in": "requireTotpForSignIn",
  trading: "requireTotpForTrading",
  funding: "requireTotpForFunding",
};

export const STEP_UP_MINUTES_RANGE = { min: 1, max: 120 } as const;
export const MAX_FAILED_ATTEMPTS_RANGE = { min: 1, max: 20 } as const;
export const LOCKOUT_MINUTES_RANGE = { min: 1, max: 1_440 } as const;

/** The six fields a policy is made of, in one place, so the shape is stated once. */
const POLICY_FIELDS = [
  "requireTotpForSignIn",
  "requireTotpForTrading",
  "requireTotpForFunding",
  "stepUpMinutes",
  "maxFailedAttempts",
  "lockoutMinutes",
] as const;

const ALLOWED_KEYS = new Set<string>(POLICY_FIELDS);

/**
 * Project anything down to the six policy fields.
 *
 * A *submitted* payload is validated strictly, so an unknown key there is a
 * refusal. A *stored row* is a different thing: it carries its storage columns
 * (`id`, `updatedByUserId`, `updatedAt`) beside the policy fields, and those are
 * not part of the policy — so a row is projected to the six fields before it is
 * validated, exactly as the integration and risk-policy readers do.
 */
export function selectSecurityPolicyFields(value: Record<string, unknown>): SecurityPolicy {
  return Object.fromEntries(POLICY_FIELDS.map((field) => [field, value[field]])) as SecurityPolicy;
}

function wholeNumberInRange(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= range.min && value <= range.max;
}

/**
 * The numbers are validated for *form*, not for tightness. How strict the owner
 * wants their own lockout is configuration, not something this module decides:
 * the panel is the control, `evaluateTotpAttempt` is the enforcement, and every
 * change is audited with the before and after.
 */
export function validateSecurityPolicyUpdate(value: unknown): SecurityPolicyValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, error: "Security policy must be an object." };
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !ALLOWED_KEYS.has(key))) {
    return { valid: false, error: "One or more submitted fields are unsupported." };
  }
  for (const key of ["requireTotpForSignIn", "requireTotpForTrading", "requireTotpForFunding"] as const) {
    if (typeof candidate[key] !== "boolean") {
      return { valid: false, error: "Each scope must be either on or off." };
    }
  }
  if (!wholeNumberInRange(candidate.stepUpMinutes, STEP_UP_MINUTES_RANGE)) {
    return {
      valid: false,
      error: `The step-up window must be a whole number of minutes between ${STEP_UP_MINUTES_RANGE.min} and ${STEP_UP_MINUTES_RANGE.max}.`,
    };
  }
  if (!wholeNumberInRange(candidate.maxFailedAttempts, MAX_FAILED_ATTEMPTS_RANGE)) {
    return {
      valid: false,
      error: `Failed attempts before lockout must be a whole number between ${MAX_FAILED_ATTEMPTS_RANGE.min} and ${MAX_FAILED_ATTEMPTS_RANGE.max}.`,
    };
  }
  if (!wholeNumberInRange(candidate.lockoutMinutes, LOCKOUT_MINUTES_RANGE)) {
    return {
      valid: false,
      error: `Lockout duration must be a whole number of minutes between ${LOCKOUT_MINUTES_RANGE.min} and ${LOCKOUT_MINUTES_RANGE.max}.`,
    };
  }
  return {
    valid: true,
    value: {
      requireTotpForSignIn: candidate.requireTotpForSignIn as boolean,
      requireTotpForTrading: candidate.requireTotpForTrading as boolean,
      requireTotpForFunding: candidate.requireTotpForFunding as boolean,
      stepUpMinutes: candidate.stepUpMinutes,
      maxFailedAttempts: candidate.maxFailedAttempts,
      lockoutMinutes: candidate.lockoutMinutes,
    },
  };
}

export function isSecurityScope(value: unknown): value is SecurityScope {
  return typeof value === "string" && (SECURITY_SCOPES as readonly string[]).includes(value);
}

/** Whether this scope is turned on. The one place that mapping lives. */
export function isScopeRequired(policy: SecurityPolicy, scope: SecurityScope): boolean {
  return policy[SCOPE_FIELD[scope]] === true;
}

/** Turn the stored row into a policy, or throw if a stored value is unusable. */
export function readSecurityPolicyRow(row: (SecurityPolicy & object) | null): SecurityPolicy {
  if (!row) return defaultSecurityPolicy();
  const validation = validateSecurityPolicyUpdate(selectSecurityPolicyFields(row as unknown as Record<string, unknown>));
  if (!validation.valid) throw new Error("Stored security policy failed validation.");
  return validation.value;
}

export type LoadedSecurityPolicy = {
  policy: SecurityPolicy;
  /** False when the deployment has no seeded row yet, so nothing was edited by anyone. */
  persisted: boolean;
};

export async function loadSecurityPolicy(): Promise<LoadedSecurityPolicy> {
  const row = await prisma.securityPolicySettings.findUnique({ where: { id: "global" } });
  return { policy: readSecurityPolicyRow(row), persisted: Boolean(row) };
}

export async function saveSecurityPolicy(
  policy: SecurityPolicy,
  input: { actorUserId: string; reason?: string },
): Promise<SecurityPolicy> {
  const validation = validateSecurityPolicyUpdate(policy);
  if (!validation.valid) throw new Error("Security policy update failed validation.");
  const safePolicy = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.securityPolicySettings.findUnique({ where: { id: "global" } });
    const data = { ...safePolicy, updatedByUserId: input.actorUserId };
    const saved = await transaction.securityPolicySettings.upsert({
      where: { id: "global" },
      create: { id: "global", ...data },
      update: data,
    });
    // Before and after, with the fields that were actually reachable by the
    // change: a scope flip is only reviewable if the trail says what it flipped
    // from. No secret can appear here — this table holds switches and numbers.
    const changed = before
      ? Object.fromEntries(
          Object.entries(safePolicy).filter(([key]) => before[key as keyof typeof before] !== safePolicy[key as keyof SecurityPolicy]),
        )
      : safePolicy;
    await auditCreate(transaction, {
      data: {
        actorUserId: input.actorUserId,
        action: "SECURITY_POLICY_UPDATED",
        objectType: "SecurityPolicySettings",
        objectId: "global",
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          reason: input.reason ?? "Security policy edited in the admin panel.",
          before: before ? readSecurityPolicyRow(before) : null,
          after: safePolicy,
          changed: before ? changed : "created",
        }),
      },
    });
    return readSecurityPolicyRow(saved);
  });
}

/** A read for the enforcement path, which must not throw on a missing row. */
export async function loadSecurityPolicyForEnforcement(): Promise<LoadedSecurityPolicy> {
  try {
    return await loadSecurityPolicy();
  } catch {
    return { policy: defaultSecurityPolicy(), persisted: false };
  }
}

export type StepUpDecision =
  | { required: false; reason: "SCOPE_OFF" | "NOT_ENROLLED" | "FRESH_VERIFICATION" }
  | { required: true; scope: SecurityScope; message: string };

/**
 * Whether a gated action needs a fresh code, and what to say when it does.
 *
 * `enrolled` is whether the account has an *activated* authenticator. A scope
 * turned on without one is the case that must not become a locked door: it is
 * reported as not enforced, in the same sentence the admin panel shows, so the
 * owner sees the mismatch where they can fix it (by enrolling) rather than at a
 * trading button they cannot use.
 */
export function decideStepUp(input: {
  policy: SecurityPolicy;
  scope: SecurityScope;
  enrolled: boolean;
  totpVerifiedAt: Date | null;
  now: Date;
}): StepUpDecision {
  if (!isScopeRequired(input.policy, input.scope)) return { required: false, reason: "SCOPE_OFF" };
  if (!input.enrolled) return { required: false, reason: "NOT_ENROLLED" };
  const windowMs = input.policy.stepUpMinutes * 60_000;
  if (input.totpVerifiedAt && input.now.getTime() - input.totpVerifiedAt.getTime() < windowMs) {
    return { required: false, reason: "FRESH_VERIFICATION" };
  }
  const scope = SECURITY_SCOPE_CATALOG.find((entry) => entry.key === input.scope)!;
  const minutes = describeStepUpWindow(input.policy.stepUpMinutes);
  return {
    required: true,
    scope: input.scope,
    message:
      `${scope.label} needs a code from your authenticator app before ${scope.gatedAction}. ` +
      `The last accepted code for this session is older than ${minutes}, so one is asked for again.`,
  };
}

export function describeStepUpWindow(minutes: number): string {
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
