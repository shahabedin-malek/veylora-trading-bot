import { prisma } from "@/lib/db";
import {
  evaluateOwnerLimits,
  RISK_POLICY_VERSION,
  type RiskDecision,
  type RiskLimitBreach,
  type RiskOrderInput,
} from "@/lib/risk-controls/policy";
import {
  RISK_LIMIT_FIELDS,
  cooldownRemainingMinutes,
  getRiskPolicySettings,
  startCooldown,
  type RiskPolicySettings,
} from "@/lib/risk-controls/settings";
import { readRiskUsageFacts, type RiskUsageFacts } from "@/lib/risk-controls/usage";
import { auditCreate } from "@/lib/audit/record";

/**
 * The one gate every order passes before it is placed (phase 25).
 *
 * Both surfaces call this: a manual submission from `/trade` and the strategy runner. That
 * is requirement 6 in its strongest form — not "the same checks exist in both places" but
 * one function, so a limit proven in paper is the limit that holds live. What differs
 * between the two callers is only what they can tell it: the runner knows its strategy and
 * its market, a manual order knows only what it is about to send.
 *
 * A refusal is never a silent skip. It returns the evaluator's decision (which names the
 * limit, the value seen and the cap), a sentence built from that decision, and it writes an
 * audit row — `ORDER_REFUSED_BY_RISK_LIMIT` for an order, with the same facts in
 * `redactedJson`. If the row cannot be written the refusal still stands: the order was
 * refused before anything existed that could move money.
 */

const LIMIT_LABELS: Record<string, string> = Object.fromEntries(
  RISK_LIMIT_FIELDS.map((limit) => [limit.field, limit.label]),
);

function limitSentence(breach: RiskLimitBreach): string {
  const label = LIMIT_LABELS[breach.limit] ?? breach.limit;
  switch (breach.reason) {
    case "kill-switch-active":
      return breach.scope === "strategy"
        ? "this strategy's kill switch is engaged"
        : "the global kill switch is engaged";
    case "venue-not-allowed":
      return `${label} — this order would use ${breach.observed}, which is not in the list (${breach.cap ?? "none"})`;
    case "cooldown-active":
      return `a cooldown after a halt is running — ${breach.observed} of ${breach.cap} minute(s)`;
    case "open-positions-exceeded":
      return `${label} ${breach.cap} — ${breach.observed} already open`;
    default:
      return `${label} ${breach.cap} — this order would make it ${breach.observed}`;
  }
}

/** "Refused by a limit you set: Max notional per order 250.00 — this order would make it 1000.00." */
export function describeLimitRefusal(decision: Extract<RiskDecision, { decision: "REFUSE" }>): string {
  if (decision.limits.length === 0) {
    return `The risk policy refused the order (${decision.reasons.join(", ")}), so nothing was sent.`;
  }
  const clauses = decision.limits.map(limitSentence);
  return `Refused by a limit you set: ${clauses.join("; ")}. Nothing was sent; the strategy keeps running and will trade again when conditions allow.`;
}

export type OrderAuthorisation = {
  decision: RiskDecision;
  /** The sentence to show and record; null when the order is allowed. */
  sentence: string | null;
  /** The facts the evaluator saw. Null when the policy could not be read. */
  facts: RiskUsageFacts | null;
  policy: RiskPolicySettings | null;
};

/**
 * Evaluate the owner's controls for one order and audit a refusal.
 *
 * A policy that cannot be read is a refusal, not a pass: `risk-policy-unavailable` is the
 * one state in which the gate does not know what the owner asked for, and guessing "allow"
 * there would make an outage into a permission.
 */
export async function authoriseOrder(input: {
  userId: string;
  symbol: string;
  notionalUsd: string;
  venueId: string | null;
  reducePosition?: boolean;
  source: "manual" | "strategy";
  actorUserId: string | null;
  now?: Date;
}): Promise<OrderAuthorisation> {
  const now = input.now ?? new Date();

  let policy: RiskPolicySettings;
  try {
    policy = await getRiskPolicySettings();
  } catch {
    const decision: Extract<RiskDecision, { decision: "REFUSE" }> = {
      decision: "REFUSE",
      policyVersion: RISK_POLICY_VERSION,
      reasons: ["risk-policy-unavailable"],
      limits: [],
    };
    return {
      decision,
      sentence: "The risk policy could not be read, so no order was sent. This is a configuration gap, not a limit.",
      facts: null,
      policy: null,
    };
  }

  const facts = await readRiskUsageFacts(input.userId, {
    policy,
    market: input.symbol,
    now,
  });

  const riskInput: RiskOrderInput = {
    symbol: input.symbol,
    allowedSymbols: policy.approvedSymbols,
    venueApproved: true,
    liveArmed: true,
    killSwitchActive: policy.killSwitchActive,
    auditAvailable: true,
    hasValidStopLoss: true,
    capitalUsd: input.notionalUsd,
    verifiedAvailableUsd: input.notionalUsd,
    requestedNotionalUsd: input.notionalUsd,
    serverComputedMaxLossUsd: input.notionalUsd,
    currentOpenExposureUsd: facts.openExposureUsd,
    dailyLossUsd: "0",
    tradesToday: facts.tradesToday,
    leverage: "1",
    first24HoursAfterArm: false,
    exposureSinceArmUsd: "0",
    strategyKey: facts.strategy.activationId,
    strategyOpenNotionalUsd: facts.strategyOpenNotionalUsd,
    openPositionCount: facts.openPositions,
    tradesInInterval: facts.tradesInInterval,
    venueId: input.venueId,
    // A cooldown of 0 minutes is no cooldown, even if an earlier clock is still ticking.
    cooldownRemainingMinutes: policy.cooldownMinutes > 0 ? cooldownRemainingMinutes(policy.cooldownUntil, now.getTime()) : 0,
    strategyKillSwitchActive: facts.strategy.switchActive,
  };

  const decision = evaluateOwnerLimits(riskInput, policy);
  if (decision.decision === "ALLOW") {
    return { decision, sentence: null, facts, policy };
  }

  const sentence = describeLimitRefusal(decision);
  await auditRefusal({
    actorUserId: input.actorUserId,
    source: input.source,
    symbol: input.symbol,
    notionalUsd: input.notionalUsd,
    venueId: input.venueId,
    decision,
  });

  // A daily-loss halt starts the post-halt cooldown; the cooldown is what stops the next
  // pass from immediately trying again at the same loss.
  if (decision.reasons.includes("daily-loss-halt") && policy.cooldownMinutes > 0) {
    await startCooldown({ actorUserId: input.actorUserId, reason: "daily-loss-halt", now }).catch(() => null);
  }

  return { decision, sentence, facts, policy };
}

/** One audited row per refusal, carrying the limit, the value seen and the cap. */
export async function auditRefusal(input: {
  actorUserId: string | null;
  source: "manual" | "strategy";
  symbol: string;
  notionalUsd: string;
  venueId: string | null;
  decision: Extract<RiskDecision, { decision: "REFUSE" }>;
}): Promise<void> {
  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: input.actorUserId,
        action: "ORDER_REFUSED_BY_RISK_LIMIT",
        objectType: input.source === "manual" ? "ManualOrder" : "StrategyOrder",
        objectId: `${input.symbol}:${input.notionalUsd}`,
        outcome: "REFUSED",
        redactedJson: JSON.stringify({
          source: input.source,
          symbol: input.symbol,
          notionalUsd: input.notionalUsd,
          venue: input.venueId,
          reasons: input.decision.reasons,
          limits: input.decision.limits,
        }),
      },
    });
  } catch {
    // The refusal stands whether or not it could be filed: it happened before anything that
    // could move money. The caller still returns the sentence to the owner.
  }
}

/** Whether a strategy is stopped by either switch, without evaluating an order. */
export async function readSwitchState(policy: RiskPolicySettings, activationId: string | null) {
  const strategySwitch = activationId
    ? await prisma.strategyKillSwitch.findUnique({ where: { activationId } }).catch(() => null)
    : null;
  return {
    global: policy.killSwitchActive,
    strategy: strategySwitch?.active === true,
    engaged: policy.killSwitchActive || strategySwitch?.active === true,
  };
}
