import { prisma } from "@/lib/db";
import type { TokenUsage } from "@/lib/assistant/loop";

/**
 * The assistant's own limits, and what one question cost.
 *
 * A model request is spending, so the limit is enforced per signed-in account, stored in
 * the database rather than in a module variable, and checked *before* the provider is
 * asked. Counting happens first and the decision second, in one transaction: two
 * requests arriving together cannot both read "29 of 30" and both proceed. An attempt
 * that is refused has already been counted — the cap counts attempts, and the window
 * resets on the hour, which is stated in the sentence the owner reads.
 *
 * A window that cannot be read is a refusal, not an allowance: "we could not check your
 * limit" must not become "you may spend".
 */

export const ASSISTANT_LIMITS = {
  requestsPerHour: 30,
  requestsPerDay: 200,
  tokensPerDay: 150_000,
} as const;

export type AssistantWindowKind = "HOUR" | "DAY";

export type AssistantWindow = {
  kind: AssistantWindowKind;
  start: Date;
  end: Date;
};

/** The UTC window a moment falls in: the hour's floor, or the day's floor. */
export function windowFor(kind: AssistantWindowKind, now: Date): AssistantWindow {
  const start = new Date(now.getTime());
  start.setUTCMinutes(0, 0, 0);
  if (kind === "DAY") start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + (kind === "DAY" ? 86_400_000 : 3_600_000));
  return { kind, start, end };
}

export type AssistantUsageFacts = {
  hourRequests: number;
  dayRequests: number;
  dayTokens: number;
};

export type AssistantUsageSnapshot = AssistantUsageFacts & {
  /** Micro-dollars spent in this UTC day, or null when no price is configured. */
  dayCostMicros: number | null;
  hourResetAt: string;
  dayResetAt: string;
  limits: typeof ASSISTANT_LIMITS;
};

export type AssistantQuotaRefusal = {
  allowed: false;
  code: "RATE_LIMITED" | "LIMIT_UNAVAILABLE";
  limit: string;
  observed: number;
  cap: number;
  resetAt: string | null;
  status: number;
  sentence: string;
};

export type AssistantQuotaDecision = { allowed: true } | AssistantQuotaRefusal;

/**
 * The decision, from counted facts.
 *
 * Pure, so the boundaries are testable without a database: the cap is inclusive (the
 * 30th request in an hour is allowed, the 31st is not), and the reset time is the end of
 * the window that refused, which is what a person needs to know.
 */
export function evaluateAssistantQuota(facts: AssistantUsageFacts, now: Date): AssistantQuotaDecision {
  const hour = windowFor("HOUR", now);
  const day = windowFor("DAY", now);

  if (facts.hourRequests > ASSISTANT_LIMITS.requestsPerHour) {
    return {
      allowed: false,
      code: "RATE_LIMITED",
      limit: "requestsPerHour",
      observed: facts.hourRequests,
      cap: ASSISTANT_LIMITS.requestsPerHour,
      resetAt: hour.end.toISOString(),
      status: 429,
      sentence:
        `Assistant rate limit reached: ${ASSISTANT_LIMITS.requestsPerHour} questions per hour, and this attempt is number ${facts.hourRequests}. ` +
        `The window resets at ${hour.end.toISOString()}.`,
    };
  }

  if (facts.dayRequests > ASSISTANT_LIMITS.requestsPerDay) {
    return {
      allowed: false,
      code: "RATE_LIMITED",
      limit: "requestsPerDay",
      observed: facts.dayRequests,
      cap: ASSISTANT_LIMITS.requestsPerDay,
      resetAt: day.end.toISOString(),
      status: 429,
      sentence:
        `Assistant daily limit reached: ${ASSISTANT_LIMITS.requestsPerDay} questions per day, and this attempt is number ${facts.dayRequests}. ` +
        `The window resets at ${day.end.toISOString()}.`,
    };
  }

  if (facts.dayTokens > ASSISTANT_LIMITS.tokensPerDay) {
    return {
      allowed: false,
      code: "RATE_LIMITED",
      limit: "tokensPerDay",
      observed: facts.dayTokens,
      cap: ASSISTANT_LIMITS.tokensPerDay,
      resetAt: day.end.toISOString(),
      status: 429,
      sentence:
        `Assistant daily token budget reached: ${ASSISTANT_LIMITS.tokensPerDay} tokens, and ${facts.dayTokens} have been used. ` +
        `The budget resets at ${day.end.toISOString()}.`,
    };
  }

  return { allowed: true };
}

function unavailable(): AssistantQuotaRefusal {
  return {
    allowed: false,
    code: "LIMIT_UNAVAILABLE",
    limit: "assistantUsage",
    observed: 0,
    cap: ASSISTANT_LIMITS.requestsPerHour,
    resetAt: null,
    status: 503,
    sentence:
      "The assistant's own usage record could not be read, so no question was sent. An unreadable limit is not permission to spend.",
  };
}

/** Which rows to add to, and by how much. */
type UsageIncrement = {
  windowKind: AssistantWindowKind;
  windowStart: Date;
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
};

async function applyIncrements(userId: string, increments: readonly UsageIncrement[]): Promise<void> {
  for (const increment of increments) {
    await prisma.assistantUsageWindow.upsert({
      where: {
        userId_windowKind_windowStart: {
          userId,
          windowKind: increment.windowKind,
          windowStart: increment.windowStart,
        },
      },
      create: {
        userId,
        windowKind: increment.windowKind,
        windowStart: increment.windowStart,
        requests: increment.requests ?? 0,
        inputTokens: increment.inputTokens ?? 0,
        outputTokens: increment.outputTokens ?? 0,
      },
      update: {
        requests: increment.requests ? { increment: increment.requests } : undefined,
        inputTokens: increment.inputTokens ? { increment: increment.inputTokens } : undefined,
        outputTokens: increment.outputTokens ? { increment: increment.outputTokens } : undefined,
      },
    });
  }
}

/**
 * Count this question and decide whether it may be sent.
 *
 * The count is written first, inside a transaction with the read that decides: the two
 * windows this request touches are incremented, and the *counted* values are what the
 * decision is made from, so "29 of 30" cannot be read twice by two requests arriving in
 * the same instant.
 */
export async function consumeAssistantRequest(userId: string, now: Date = new Date()): Promise<AssistantQuotaDecision> {
  const hour = windowFor("HOUR", now);
  const day = windowFor("DAY", now);
  try {
    // Sequential inside the transaction: one after the other is what makes the pair
    // atomic, and the second upsert sees the row the first wrote.
    const [hourRow, dayRow] = await prisma.$transaction(async (transaction) => {
      const hourTouched = await transaction.assistantUsageWindow.upsert({
        where: { userId_windowKind_windowStart: { userId, windowKind: hour.kind, windowStart: hour.start } },
        create: { userId, windowKind: hour.kind, windowStart: hour.start, requests: 1 },
        update: { requests: { increment: 1 } },
      });
      const dayTouched = await transaction.assistantUsageWindow.upsert({
        where: { userId_windowKind_windowStart: { userId, windowKind: day.kind, windowStart: day.start } },
        create: { userId, windowKind: day.kind, windowStart: day.start, requests: 1 },
        update: { requests: { increment: 1 } },
      });
      return [hourTouched, dayTouched] as const;
    });

    return evaluateAssistantQuota(
      {
        hourRequests: hourRow.requests,
        dayRequests: dayRow.requests,
        dayTokens: dayRow.inputTokens + dayRow.outputTokens,
      },
      now,
    );
  } catch {
    return unavailable();
  }
}

/** What has been used this hour and this day, without counting anything. */
export async function readAssistantUsage(userId: string, now: Date = new Date()): Promise<AssistantUsageSnapshot | null> {
  const hour = windowFor("HOUR", now);
  const day = windowFor("DAY", now);
  try {
    const [hourRow, dayRow] = await Promise.all([
      prisma.assistantUsageWindow.findUnique({
        where: { userId_windowKind_windowStart: { userId, windowKind: hour.kind, windowStart: hour.start } },
      }),
      prisma.assistantUsageWindow.findUnique({
        where: { userId_windowKind_windowStart: { userId, windowKind: day.kind, windowStart: day.start } },
      }),
    ]);
    const dayTokens = (dayRow?.inputTokens ?? 0) + (dayRow?.outputTokens ?? 0);
    const cost = assistantCostMicros({ inputTokens: dayRow?.inputTokens ?? 0, outputTokens: dayRow?.outputTokens ?? 0 });
    return {
      hourRequests: hourRow?.requests ?? 0,
      dayRequests: dayRow?.requests ?? 0,
      dayTokens,
      dayCostMicros: cost,
      hourResetAt: hour.end.toISOString(),
      dayResetAt: day.end.toISOString(),
      limits: ASSISTANT_LIMITS,
    };
  } catch {
    return null;
  }
}

/**
 * What the provider reported, written after the answer.
 *
 * Tokens are recorded whether or not the answer was completed: a request that failed
 * halfway still spent them, and a budget that only counted successful answers would not
 * be a budget.
 */
export async function recordAssistantUsage(
  userId: string,
  usage: TokenUsage,
  now: Date = new Date(),
): Promise<void> {
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return;
  const day = windowFor("DAY", now);
  try {
    await applyIncrements(userId, [
      { windowKind: day.kind, windowStart: day.start, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    ]);
    const cost = assistantCostMicros(usage);
    if (cost !== null && cost > 0) {
      await prisma.assistantUsageWindow.update({
        where: { userId_windowKind_windowStart: { userId, windowKind: day.kind, windowStart: day.start } },
        data: { costMicros: { increment: cost } },
      });
    }
  } catch {
    // The answer is already delivered. Failing to record it must not fail the request —
    // the next read reports the tokens it can see rather than inventing the ones it cannot.
  }
}

/**
 * Estimated cost in micro-dollars, from the configured prices.
 *
 * Both prices come from the environment and there is no default: a cost figure invented
 * from a remembered price list would be a made-up number on a metering panel. With no
 * price configured this returns null and the panel shows the tokens it does know.
 */
export function assistantCostMicros(
  usage: TokenUsage,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const inputPrice = pricePerMillionTokens(env.AI_GATEWAY_INPUT_USD_PER_MTOK);
  const outputPrice = pricePerMillionTokens(env.AI_GATEWAY_OUTPUT_USD_PER_MTOK);
  if (inputPrice === null && outputPrice === null) return null;
  // A price is micro-dollars per million tokens, so the cost is tokens × price ÷ 1e6.
  const micros =
    (usage.inputTokens * (inputPrice ?? 0)) / 1_000_000 +
    (usage.outputTokens * (outputPrice ?? 0)) / 1_000_000;
  if (!Number.isFinite(micros)) return null;
  return Math.round(micros);
}

/** A price in micro-dollars per million tokens, from dollars per million tokens. */
function pricePerMillionTokens(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric * 1_000_000;
}

/** Whether any price is configured, for a panel that must not imply one exists. */
export function assistantPricingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return pricePerMillionTokens(env.AI_GATEWAY_INPUT_USD_PER_MTOK) !== null ||
    pricePerMillionTokens(env.AI_GATEWAY_OUTPUT_USD_PER_MTOK) !== null;
}
