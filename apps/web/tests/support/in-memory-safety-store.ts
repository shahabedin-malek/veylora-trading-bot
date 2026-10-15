import type { AdjustableRiskPolicy } from "@/lib/risk-controls/policy";
import type {
  KillSwitchTarget,
  SafetyAuditRecord,
  SafetyPersistence,
} from "@/lib/risk-controls/safety-core";
import type {
  IntegerCentLedgerEntry,
  LedgerPersistence,
} from "@/lib/ledger/integer-cent-ledger";

export class InMemorySafetyStore implements SafetyPersistence, LedgerPersistence {
  readonly auditRecords: SafetyAuditRecord[] = [];
  readonly ledgerEntries: IntegerCentLedgerEntry[] = [];
  private readonly botSwitches = new Set<string>();
  private globalSwitch = false;

  constructor(
    private readonly policy: AdjustableRiskPolicy | null,
    private readonly unavailable = new Set<"policy" | "switch" | "audit">(),
  ) {}

  async readRiskPolicy(): Promise<AdjustableRiskPolicy> {
    if (this.unavailable.has("policy") || !this.policy) throw new Error("Risk policy unavailable.");
    return this.policy;
  }

  async readGlobalKillSwitch(): Promise<boolean> {
    if (this.unavailable.has("switch")) throw new Error("Kill-switch state unavailable.");
    return this.globalSwitch;
  }

  async readBotKillSwitch(botId: string): Promise<boolean> {
    if (this.unavailable.has("switch")) throw new Error("Kill-switch state unavailable.");
    return this.botSwitches.has(botId);
  }

  async recordAudit(record: SafetyAuditRecord): Promise<void> {
    if (this.unavailable.has("audit")) throw new Error("Audit store unavailable.");
    this.auditRecords.push(record);
  }

  async recordOrderAttemptAndDecision(records: readonly SafetyAuditRecord[]): Promise<void> {
    if (this.unavailable.has("audit")) throw new Error("Audit store unavailable.");
    if (records.length !== 2 || records[0]?.action !== "ORDER_ATTEMPT" || records[1]?.action !== "RISK_DECISION") {
      throw new Error("An order attempt and its risk decision must be audited together.");
    }
    this.auditRecords.push(...records);
  }

  async setKillSwitchAndAudit(input: {
    target: KillSwitchTarget;
    engaged: boolean;
    actorUserId: string;
    occurredAt: Date;
  }): Promise<void> {
    if (this.unavailable.has("audit")) throw new Error("Audit store unavailable.");
    if (input.target.scope === "GLOBAL") this.globalSwitch = input.engaged;
    else if (input.engaged) this.botSwitches.add(input.target.botId);
    else this.botSwitches.delete(input.target.botId);
    this.auditRecords.push({
      actorUserId: input.actorUserId,
      action: input.engaged ? "KILL_SWITCH_ENGAGED" : "KILL_SWITCH_DISENGAGED",
      objectType: input.target.scope === "GLOBAL" ? "GlobalKillSwitch" : "BotKillSwitch",
      objectId: input.target.scope === "BOT" ? input.target.botId : null,
      outcome: "SUCCESS",
      occurredAt: input.occurredAt,
      redactedJson: JSON.stringify({ scope: input.target.scope, botId: input.target.scope === "BOT" ? input.target.botId : null, engaged: input.engaged }),
    });
  }

  async appendLedgerEntry(entry: IntegerCentLedgerEntry): Promise<{ applied: boolean }> {
    if (this.ledgerEntries.some((existing) => existing.idempotencyKey === entry.idempotencyKey)) return { applied: false };
    this.ledgerEntries.push(entry);
    return { applied: true };
  }

  async listLedgerEntries(accountId: string): Promise<readonly IntegerCentLedgerEntry[]> {
    return this.ledgerEntries.filter((entry) => entry.accountId === accountId);
  }

  async allBotSwitchesEngaged(): Promise<boolean> {
    return this.globalSwitch;
  }

  async isBotSwitchEngaged(botId: string): Promise<boolean> {
    return this.botSwitches.has(botId);
  }
}