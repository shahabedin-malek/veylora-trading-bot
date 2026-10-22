import type { Reason } from "@/lib/observability/reason";
import { reason } from "@/lib/observability/reason";
import { isTerminalOrderStatus, type OrderStatus } from "@/lib/orders/state-machine";

/**
 * Retry policy for order operations, and the record of every attempt.
 *
 * Two rules make this safe rather than optimistic:
 *
 *  - **Bounded.** The delay grows geometrically between attempts and is capped,
 *    and the attempt count has a ceiling. There is no unbounded loop against a
 *    venue that is refusing.
 *  - **Never a blind retry of a money operation.** A retry is only ever taken
 *    with the same idempotency key, so a repeated submission resolves to the
 *    same venue order (`src/lib/orders/process.ts`). A timeout — where the venue
 *    may or may not have accepted — is resolved by *looking the order up*, not by
 *    sending it again on faith.
 *
 * Every attempt writes down what happened: the attempt number, what the venue
 * answered, the reason, and the redacted provider response. That record is what
 * lets "why did this order fail?" be answered from the row rather than guessed.
 */

export type OrderRetryPolicy = {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Delay before the second attempt. */
  baseDelayMs: number;
  /** Ceiling for a single delay. */
  maxDelayMs: number;
  /** How much each further delay grows. */
  multiplier: number;
};

export const DEFAULT_ORDER_RETRY_POLICY: OrderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  multiplier: 4,
};

/** What a submission attempt produced, as the policy sees it. */
export type AttemptOutcome = "accepted" | "rejected" | "timeout" | "unavailable" | "not-found";

export type AttemptRecord = {
  attempt: number;
  at: string;
  outcome: AttemptOutcome;
  /** Why this attempt ended the way it did, in one sentence. */
  reason: string;
  /** The venue's own answer, redacted before it is stored. */
  providerResponse: unknown;
  /** The reason code this attempt maps to in the shared reason type. */
  reasonCode: Reason["code"];
};

export type RetryDecision =
  | { retry: true; delayMs: number; reason: string }
  | { retry: false; reason: string };

/**
 * The delay before `attempt` (1-based next attempt number). Geometric, capped,
 * and deliberately jitter-free: a jittered delay is untestable, and the venue's
 * own rate limits are what the cap protects.
 */
export function delayForAttempt(attempt: number, policy: OrderRetryPolicy = DEFAULT_ORDER_RETRY_POLICY): number {
  if (attempt <= 1) return 0;
  const steps = attempt - 2;
  const raw = policy.baseDelayMs * policy.multiplier ** steps;
  return Math.min(Math.max(0, Math.round(raw)), policy.maxDelayMs);
}

export function attemptsRemain(attempt: number, policy: OrderRetryPolicy = DEFAULT_ORDER_RETRY_POLICY): boolean {
  return attempt < policy.maxAttempts;
}

/**
 * Should this attempt be repeated? A terminal state never retries, and neither
 * does an accepted submission or a venue refusal (a refusal is an answer, not a
 * failure to get one).
 */
export function decideRetry(input: {
  attempt: number;
  outcome: AttemptOutcome;
  status: OrderStatus;
  policy?: OrderRetryPolicy;
}): RetryDecision {
  const policy = input.policy ?? DEFAULT_ORDER_RETRY_POLICY;
  if (isTerminalOrderStatus(input.status)) {
    return { retry: false, reason: `${input.status} is terminal, so no further attempt is made.` };
  }
  if (input.outcome === "accepted") {
    return { retry: false, reason: "The venue accepted the order, so no further attempt is made." };
  }
  if (input.outcome === "rejected") {
    return { retry: false, reason: "The venue refused the order; a refusal is an answer, not a failure to reach it." };
  }
  if (!attemptsRemain(input.attempt, policy)) {
    return {
      retry: false,
      reason: `Attempt ${input.attempt} of ${policy.maxAttempts} was the last one this policy allows.`,
    };
  }
  const next = input.attempt + 1;
  return {
    retry: true,
    delayMs: delayForAttempt(next, policy),
    reason: `Attempt ${next} of ${policy.maxAttempts} will run after ${delayForAttempt(next, policy)}ms.`,
  };
}

/** The shared reason for an attempt outcome. */
export function reasonForAttemptOutcome(outcome: AttemptOutcome, input: { detail?: string; providerId?: string } = {}): Reason {
  const base = {
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
  };
  switch (outcome) {
    case "rejected":
      return reason("ORDER_REJECTED", base);
    case "timeout":
      return reason("VENUE_UNAVAILABLE", { ...base, detail: input.detail ?? "The submission timed out before the venue answered." });
    case "unavailable":
      return reason("VENUE_UNAVAILABLE", base);
    case "not-found":
      return reason("PROVIDER_NOT_CONNECTED", {
        ...base,
        message: "The venue holds no record of this order, so it cannot be reconciled against one.",
        retryable: false,
      });
    case "accepted":
      return reason("NO_ENTRY_CONDITION", { ...base, message: "The venue accepted the order; nothing further was needed." });
  }
}

/**
 * How many attempts are allowed in total, for the UI sentence. Kept next to the
 * policy so a page cannot state a different number than the code uses.
 */
export function describeRetryPolicy(policy: OrderRetryPolicy = DEFAULT_ORDER_RETRY_POLICY): string {
  return `Up to ${policy.maxAttempts} attempts, with ${policy.baseDelayMs}ms–${policy.maxDelayMs}ms between them, each carrying the same idempotency key.`;
}
