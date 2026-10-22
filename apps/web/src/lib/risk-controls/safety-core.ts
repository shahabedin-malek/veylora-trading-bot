import {
  evaluateRiskOrder,
  type AdjustableRiskPolicy,
  type RiskDecision,
  type RiskOrderInput,
} from "@/lib/risk-controls/policy";

export type KillSwitchTarget =
  | { scope: "GLOBAL" }
  | { scope: "BOT"; botId: string };

export type SafetyAuditAction =
  | "RISK_DECISION"
  | "PAPER_TRADE_ATTEMPT"
  | "PAPER_RISK_DECISION"
  | "PAPER_STATE_CHANGED"
  | "PAPER_KILL_SWITCH_ENGAGED"
  | "KILL_SWITCH_ENGAGED"
  | "KILL_SWITCH_DISENGAGED"
  | "RISK_CAPS_CHANGED"
  | "ORDER_ATTEMPT";

export type SafetyAuditRecord = {
  actorUserId: string;
  action: SafetyAuditAction;
  objectType: string;
  objectId: string | null;
  outcome: "SUCCESS" | "REFUSED";
  occurredAt: Date;
  redactedJson: string;
};

export interface SafetyPersistence {
  readRiskPolicy(): Promise<AdjustableRiskPolicy>;
  readGlobalKillSwitch(): Promise<boolean>;
  readBotKillSwitch(botId: string): Promise<boolean>;
  recordAudit(record: SafetyAuditRecord): Promise<void>;
  recordOrderAttemptAndDecision(records: readonly SafetyAuditRecord[]): Promise<void>;
  setKillSwitchAndAudit(input: {
    target: KillSwitchTarget;
    engaged: boolean;
    actorUserId: string;
    occurredAt: Date;
  }): Promise<void>;
}

export type OrderAttemptContext = {
  actorUserId: string;
  attemptId: string;
  botId?: string;
};

function refuse(reason: "risk-policy-unavailable" | "risk-state-unavailable" | "audit-unavailable"): RiskDecision {
  return { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: [reason], limits: [] };
}

function auditAttemptAndDecisionRecords(
  input: RiskOrderInput,
  context: OrderAttemptContext,
  decision: RiskDecision,
  occurredAt: Date,
): SafetyAuditRecord[] {
  const outcome = decision.decision === "ALLOW" ? "SUCCESS" : "REFUSED";
  const objectId = context.attemptId;
  return [
    {
      actorUserId: context.actorUserId,
      action: "ORDER_ATTEMPT",
      objectType: "OrderAttempt",
      objectId,
      outcome,
      occurredAt,
      redactedJson: JSON.stringify({
        symbol: input.symbol,
        requestedNotionalUsd: input.requestedNotionalUsd,
        serverComputedMaxLossUsd: input.serverComputedMaxLossUsd,
        venueApproved: input.venueApproved,
        botId: context.botId ?? null,
      }),
    },
    {
      actorUserId: context.actorUserId,
      action: "RISK_DECISION",
      objectType: "OrderAttempt",
      objectId,
      outcome,
      occurredAt,
      redactedJson: JSON.stringify({ decision: decision.decision, reasons: decision.reasons, botId: context.botId ?? null }),
    },
  ];
}

export async function evaluateAndAuditOrderAttempt(
  persistence: SafetyPersistence,
  input: RiskOrderInput,
  context: OrderAttemptContext,
  occurredAt = new Date(),
): Promise<RiskDecision> {
  if (!context.actorUserId.trim() || !context.attemptId.trim()) return refuse("audit-unavailable");

  let policy: AdjustableRiskPolicy;
  try {
    policy = await persistence.readRiskPolicy();
  } catch {
    const decision = refuse("risk-policy-unavailable");
    try {
      await persistence.recordOrderAttemptAndDecision(auditAttemptAndDecisionRecords(input, context, decision, occurredAt));
    } catch {
      return refuse("audit-unavailable");
    }
    return decision;
  }

  let switchEngaged: boolean;
  try {
    const [globalEngaged, botEngaged] = await Promise.all([
      persistence.readGlobalKillSwitch(),
      context.botId ? persistence.readBotKillSwitch(context.botId) : Promise.resolve(false),
    ]);
    switchEngaged = globalEngaged || botEngaged;
  } catch {
    const decision = refuse("risk-state-unavailable");
    try {
      await persistence.recordOrderAttemptAndDecision(auditAttemptAndDecisionRecords(input, context, decision, occurredAt));
    } catch {
      return refuse("audit-unavailable");
    }
    return decision;
  }

  const decision = evaluateRiskOrder({ ...input, killSwitchActive: input.killSwitchActive || switchEngaged }, policy);
  try {
    await persistence.recordOrderAttemptAndDecision(auditAttemptAndDecisionRecords(input, context, decision, occurredAt));
    return decision;
  } catch {
    return refuse("audit-unavailable");
  }
}

export async function evaluateAndAuditPaperAttempt(
  persistence: SafetyPersistence,
  input: RiskOrderInput,
  context: OrderAttemptContext & {
    side: "BUY" | "SELL";
    paperNotionalCents: number;
    paperFillPrice: string;
    paperFeeCents: number;
    paperSlippageBps: string;
  },
  occurredAt = new Date(),
): Promise<RiskDecision> {
  const paperRecords = (decision: RiskDecision): SafetyAuditRecord[] => {
    const outcome = decision.decision === "ALLOW" ? "SUCCESS" : "REFUSED";
    const common = {
      actorUserId: context.actorUserId,
      objectType: "PaperOrderAttempt",
      objectId: context.attemptId,
      outcome,
      occurredAt,
    } as const;
    return [
      {
        ...common,
        action: "PAPER_TRADE_ATTEMPT",
        redactedJson: JSON.stringify({
          paperMode: "PAPER",
          paperSide: context.side,
          paperSymbol: input.symbol,
          paperNotionalCents: context.paperNotionalCents,
          paperFillPrice: context.paperFillPrice,
          paperFeeCents: context.paperFeeCents,
          paperSlippageBps: context.paperSlippageBps,
          paperBotId: context.botId ?? null,
        }),
      },
      {
        ...common,
        action: "PAPER_RISK_DECISION",
        redactedJson: JSON.stringify({
          paperMode: "PAPER",
          paperDecision: decision.decision,
          paperReasons: decision.reasons,
          paperBotId: context.botId ?? null,
        }),
      },
    ];
  };

  if (!context.actorUserId.trim() || !context.attemptId.trim() || !context.botId?.trim()) return refuse("audit-unavailable");

  let policy: AdjustableRiskPolicy;
  try {
    policy = await persistence.readRiskPolicy();
  } catch {
    const decision: RiskDecision = { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: ["risk-policy-unavailable"], limits: [] };
    try {
      await persistence.recordOrderAttemptAndDecision(paperRecords(decision));
    } catch {
      return refuse("audit-unavailable");
    }
    return decision;
  }

  let switchEngaged: boolean;
  try {
    const [globalEngaged, botEngaged] = await Promise.all([
      persistence.readGlobalKillSwitch(),
      persistence.readBotKillSwitch(context.botId),
    ]);
    switchEngaged = globalEngaged || botEngaged;
  } catch {
    const decision: RiskDecision = { decision: "REFUSE", policyVersion: "veylora-risk-v1", reasons: ["risk-state-unavailable"], limits: [] };
    try {
      await persistence.recordOrderAttemptAndDecision(paperRecords(decision));
    } catch {
      return refuse("audit-unavailable");
    }
    return decision;
  }

  const decision = evaluateRiskOrder({
    ...input,
    executionMode: "PAPER",
    killSwitchActive: input.killSwitchActive || switchEngaged,
  }, policy);
  try {
    await persistence.recordOrderAttemptAndDecision(paperRecords(decision));
    return decision;
  } catch {
    return refuse("audit-unavailable");
  }
}

export async function setKillSwitch(
  persistence: SafetyPersistence,
  target: KillSwitchTarget,
  engaged: boolean,
  actorUserId: string,
  occurredAt = new Date(),
): Promise<void> {
  if (!actorUserId.trim()) throw new Error("An authenticated actor is required.");
  if (target.scope === "BOT" && !target.botId.trim()) throw new Error("A bot ID is required.");
  await persistence.setKillSwitchAndAudit({ target, engaged, actorUserId, occurredAt });
}

export async function recordRiskCapsChanged(
  persistence: Pick<SafetyPersistence, "recordAudit">,
  actorUserId: string,
  before: AdjustableRiskPolicy,
  after: AdjustableRiskPolicy,
  occurredAt = new Date(),
): Promise<void> {
  if (!actorUserId.trim()) throw new Error("An authenticated actor is required.");
  await persistence.recordAudit({
    actorUserId,
    action: "RISK_CAPS_CHANGED",
    objectType: "RiskPolicy",
    objectId: null,
    outcome: "SUCCESS",
    occurredAt,
    redactedJson: JSON.stringify({ before, after }),
  });
}