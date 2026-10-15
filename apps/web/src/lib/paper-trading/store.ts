import { randomUUID } from "node:crypto";
import DecimalJS from "decimal.js";
import type { BotConfiguration, BotState } from "@/lib/bot-builder/state-machine";
import { DEFAULT_RISK_POLICY, type AdjustableRiskPolicy } from "@/lib/risk-controls/policy";
import type { SafetyAuditRecord, SafetyPersistence, KillSwitchTarget } from "@/lib/risk-controls/safety-core";
import type { IntegerCentLedgerEntry, LedgerPersistence } from "@/lib/ledger/integer-cent-ledger";
import { USD_WATCHLIST } from "@/lib/market-data/watchlist";

const Decimal = DecimalJS.clone({ precision: 40 });

export type PaperPosition = {
  paperQuantity: string;
  paperEntryNotionalCents: number;
  paperEntryFeeCents: number;
  paperEntryFillPrice: string;
  paperOpenedAt: string;
};

export type PaperBotRecord = {
  paperBotId: string;
  paperSessionId: string;
  paperConfig: BotConfiguration;
  paperState: Extract<BotState, "DRAFT" | "PAPER" | "KILLED">;
  paperInitialCapitalCents: number;
  paperStartedAt: string | null;
  paperPosition: PaperPosition | null;
  paperLastMarkPrice: string | null;
  paperCreatedAt: string;
  paperUpdatedAt: string;
  paperLastCycleAt: string | null;
  paperLastProcessedCandleAt: string | null;
  paperTradesToday: number;
  paperDayKey: string | null;
  paperDayStartEquityCents: number | null;
  paperHaltedDate: string | null;
};

export type PaperBotSnapshot = Omit<PaperBotRecord, "paperSessionId">;

export function usdToIntegerCents(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const cents = new Decimal(value).mul(100);
  const integerCents = cents.toNumber();
  if (!cents.isInteger() || !Number.isSafeInteger(integerCents)) return null;
  return integerCents;
}

function snapshot(bot: PaperBotRecord): PaperBotSnapshot {
  const visible = { ...bot };
  delete (visible as Partial<PaperBotRecord>).paperSessionId;
  return { ...visible, paperConfig: { ...bot.paperConfig }, paperPosition: bot.paperPosition ? { ...bot.paperPosition } : null };
}

export class InMemoryPaperTradingStore implements SafetyPersistence, LedgerPersistence {
  private readonly bots = new Map<string, PaperBotRecord>();
  private readonly ledgerEntries: IntegerCentLedgerEntry[] = [];
  private readonly auditRecords: SafetyAuditRecord[] = [];
  private readonly botKillSwitches = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  private globalKillSwitch = false;
  private readonly policy: AdjustableRiskPolicy = {
    ...DEFAULT_RISK_POLICY,
    approvedSymbols: USD_WATCHLIST.map(({ productId }) => productId),
  };

  async createPaperBot(paperSessionId: string, paperConfig: BotConfiguration, now = new Date()): Promise<PaperBotSnapshot> {
    const paperInitialCapitalCents = usdToIntegerCents(paperConfig.budgetCapUsd);
    if (!paperSessionId.trim() || paperInitialCapitalCents === null || paperInitialCapitalCents <= 0) {
      throw new Error("PAPER bot identity and a whole-cent paper budget are required.");
    }
    const paperBotId = randomUUID();
    const bot: PaperBotRecord = {
      paperBotId,
      paperSessionId,
      paperConfig: { ...paperConfig },
      paperState: "DRAFT",
      paperInitialCapitalCents,
      paperStartedAt: null,
      paperPosition: null,
      paperLastMarkPrice: null,
      paperCreatedAt: now.toISOString(),
      paperUpdatedAt: now.toISOString(),
      paperLastCycleAt: null,
      paperLastProcessedCandleAt: null,
      paperTradesToday: 0,
      paperDayKey: null,
      paperDayStartEquityCents: null,
      paperHaltedDate: null,
    };
    this.bots.set(paperBotId, bot);
    return snapshot(bot);
  }

  async getPaperBot(paperSessionId: string, paperBotId: string): Promise<PaperBotSnapshot | null> {
    const bot = this.bots.get(paperBotId);
    return !bot || bot.paperSessionId !== paperSessionId ? null : snapshot(bot);
  }

  async listPaperBots(paperSessionId: string): Promise<PaperBotSnapshot[]> {
    return [...this.bots.values()]
      .filter((bot) => bot.paperSessionId === paperSessionId)
      .sort((left, right) => right.paperCreatedAt.localeCompare(left.paperCreatedAt))
      .map(snapshot);
  }

  async withPaperBot<T>(paperSessionId: string, paperBotId: string, operation: (bot: PaperBotRecord) => Promise<T>): Promise<T | null> {
    const previous = this.locks.get(paperBotId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(paperBotId, current);
    await previous;
    try {
      const bot = this.bots.get(paperBotId);
      if (!bot || bot.paperSessionId !== paperSessionId) return null;
      return await operation(bot);
    } finally {
      release();
      if (this.locks.get(paperBotId) === current) this.locks.delete(paperBotId);
    }
  }

  async activatePaperBot(paperSessionId: string, paperBotId: string, now = new Date()): Promise<PaperBotSnapshot | null> {
    return this.withPaperBot(paperSessionId, paperBotId, async (bot) => {
      if (bot.paperState !== "DRAFT") throw new Error("Only a draft bot can enter PAPER state.");
      const applied = await this.appendLedgerEntry({
        idempotencyKey: `paper:${paperBotId}:initial-cash`,
        accountId: paperBotId,
        actorUserId: paperSessionId,
        type: "CASH",
        amountCents: bot.paperInitialCapitalCents,
        occurredAt: now,
      });
      if (!applied.applied) throw new Error("PAPER starting balance was already initialized.");
      bot.paperState = "PAPER";
      bot.paperStartedAt = now.toISOString();
      bot.paperUpdatedAt = now.toISOString();
      await this.recordAudit({
        actorUserId: paperSessionId,
        action: "PAPER_STATE_CHANGED",
        objectType: "PaperBot",
        objectId: paperBotId,
        outcome: "SUCCESS",
        occurredAt: now,
        redactedJson: JSON.stringify({ paperMode: "PAPER", paperState: "PAPER", paperInitialCapitalCents: bot.paperInitialCapitalCents }),
      });
      return snapshot(bot);
    });
  }

  async killPaperBot(paperSessionId: string, paperBotId: string, now = new Date()): Promise<PaperBotSnapshot | null> {
    return this.withPaperBot(paperSessionId, paperBotId, async (bot) => {
      if (bot.paperState === "KILLED") return snapshot(bot);
      bot.paperState = "KILLED";
      bot.paperUpdatedAt = now.toISOString();
      this.botKillSwitches.add(paperBotId);
      await this.recordAudit({
        actorUserId: paperSessionId,
        action: "PAPER_KILL_SWITCH_ENGAGED",
        objectType: "PaperBotKillSwitch",
        objectId: paperBotId,
        outcome: "SUCCESS",
        occurredAt: now,
        redactedJson: JSON.stringify({ paperMode: "PAPER", paperBotId, paperKillSwitchEngaged: true, paperState: "KILLED" }),
      });
      return snapshot(bot);
    });
  }

  async getPaperAudit(paperSessionId: string, paperBotId: string): Promise<SafetyAuditRecord[]> {
    const bot = this.bots.get(paperBotId);
    if (!bot || bot.paperSessionId !== paperSessionId) return [];
    return this.auditRecords.filter((record) => record.objectId === paperBotId).map((record) => ({ ...record }));
  }

  async readRiskPolicy(): Promise<AdjustableRiskPolicy> {
    return { ...this.policy, approvedSymbols: [...this.policy.approvedSymbols] };
  }

  async readGlobalKillSwitch(): Promise<boolean> {
    return this.globalKillSwitch;
  }

  async readBotKillSwitch(botId: string): Promise<boolean> {
    return this.botKillSwitches.has(botId);
  }

  async recordAudit(record: SafetyAuditRecord): Promise<void> {
    this.auditRecords.push({ ...record });
  }

  async recordOrderAttemptAndDecision(records: readonly SafetyAuditRecord[]): Promise<void> {
    const paper = records[0]?.action === "PAPER_TRADE_ATTEMPT" && records[1]?.action === "PAPER_RISK_DECISION";
    const live = records[0]?.action === "ORDER_ATTEMPT" && records[1]?.action === "RISK_DECISION";
    if (records.length !== 2 || (!paper && !live)) throw new Error("An audited attempt and its risk decision must be recorded together.");
    if (paper && records.some((record) => record.objectType !== "PaperOrderAttempt" || !record.redactedJson.includes('"paperMode":"PAPER"'))) {
      throw new Error("Paper audit records must remain explicitly labeled PAPER.");
    }
    this.auditRecords.push(...records.map((record) => ({ ...record })));
  }

  async setKillSwitchAndAudit(input: {
    target: KillSwitchTarget;
    engaged: boolean;
    actorUserId: string;
    occurredAt: Date;
  }): Promise<void> {
    if (input.target.scope === "GLOBAL") this.globalKillSwitch = input.engaged;
    else if (input.engaged) this.botKillSwitches.add(input.target.botId);
    else this.botKillSwitches.delete(input.target.botId);
    await this.recordAudit({
      actorUserId: input.actorUserId,
      action: input.engaged ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_DISENGAGED",
      objectType: input.target.scope === "GLOBAL" ? "GlobalKillSwitch" : "PaperBotKillSwitch",
      objectId: input.target.scope === "BOT" ? input.target.botId : null,
      outcome: "SUCCESS",
      occurredAt: input.occurredAt,
      redactedJson: JSON.stringify({ paperMode: "PAPER", paperScope: input.target.scope, paperKillSwitchEngaged: input.engaged }),
    });
  }

  async appendLedgerEntry(entry: IntegerCentLedgerEntry): Promise<{ applied: boolean }> {
    if (this.ledgerEntries.some((existing) => existing.idempotencyKey === entry.idempotencyKey)) return { applied: false };
    this.ledgerEntries.push({ ...entry });
    return { applied: true };
  }

  async listLedgerEntries(accountId: string): Promise<readonly IntegerCentLedgerEntry[]> {
    return this.ledgerEntries.filter((entry) => entry.accountId === accountId).map((entry) => ({ ...entry }));
  }
}

const runtimeGlobal = globalThis as typeof globalThis & { __veyloraPaperTradingStore?: InMemoryPaperTradingStore };
export const paperTradingStore = runtimeGlobal.__veyloraPaperTradingStore ??= new InMemoryPaperTradingStore();