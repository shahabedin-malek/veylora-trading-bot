import { prisma } from "@/lib/db";
import { DEFAULT_FEE_TIERS, readEffectiveFeeSchedule } from "@/lib/fees/table";
import { ensureStrategyVersion } from "@/lib/strategies/repository";
import type { SmartStrategy } from "@/lib/strategies/schedule";
import { definitionRules } from "@/lib/strategies/definition";
import { validateStrategyDefinition } from "@/lib/strategies/validate";
import {
  botCapMessage,
  botDefinitionText,
  botStrategyId,
  parseBotStrategyId,
  runnerStrategyForBot,
  validateBotConfig,
  type BotCapKind,
  type BotConfig,
  type BotState,
} from "./publish";
import { auditCreate } from "@/lib/audit/record";

/**
 * The persisted bot (phase 30).
 *
 * Every write in this file is one transaction with its audit row, and every refusal is
 * answered before the write: a cap that is reached creates nothing, and a draft that is not
 * a draft is refused rather than silently rewritten. The row is the owner's; every read is
 * scoped by `userId`, so an id from another account is indistinguishable from one that does
 * not exist.
 */

export type BotCapSettings = {
  maxBots: number;
  maxVenueConnections: number;
  /** The tier the caps came from, so a refusal can name it. */
  tierLabel: string;
};

export type BotBacktestSummary = {
  id: string;
  createdAt: string;
  kind: string;
  initialCapitalUsd: string | null;
  finalCapitalUsd: string | null;
  totalReturnPercent: string | null;
  maxDrawdownPercent: string | null;
  winRatePercent: string | null;
  profitFactor: string | null;
  tradeCount: number | null;
  costAssumptions: string[];
};

export type BotView = {
  id: string;
  name: string;
  description: string;
  state: BotState;
  market: string;
  config: BotConfig;
  definition: { id: string; version: number; text: string; rules: string[] } | null;
  templateSlug: string | null;
  publishedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestBacktest: BotBacktestSummary | null;
};

type BotRow = {
  id: string;
  userId: string;
  name: string;
  description: string;
  state: string;
  market: string;
  configJson: string;
  definitionId: string | null;
  definitionVersion: number | null;
  definitionText: string | null;
  definitionJson: string | null;
  templateSlug: string | null;
  publishedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const BOT_SELECT = {
  id: true,
  userId: true,
  name: true,
  description: true,
  state: true,
  market: true,
  configJson: true,
  definitionId: true,
  definitionVersion: true,
  definitionText: true,
  definitionJson: true,
  templateSlug: true,
  publishedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isBotState(value: string): value is BotState {
  return value === "DRAFT" || value === "PUBLISHED" || value === "DELETED";
}

function decodeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function decodeBotConfig(configJson: string): BotConfig | null {
  const validation = validateBotConfig(decodeJson(configJson));
  return validation.valid ? validation.value : null;
}

function decimalText(value: unknown): string | null {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
}

function parseBacktest(row: {
  id: string;
  createdAt: Date;
  kind: string;
  metricsJson: string;
  costAssumptionsJson: string;
  resultJson: string;
}): BotBacktestSummary {
  const metrics = (decodeJson(row.metricsJson) ?? {}) as Record<string, unknown>;
  const result = (decodeJson(row.resultJson) ?? {}) as Record<string, unknown>;
  const assumptions = decodeJson(row.costAssumptionsJson);
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    kind: row.kind,
    initialCapitalUsd: decimalText(result.initialCapitalUsd),
    finalCapitalUsd: decimalText(metrics.finalCapitalUsd),
    totalReturnPercent: decimalText(metrics.totalReturnPercent),
    maxDrawdownPercent: decimalText(metrics.maxDrawdownPercent),
    winRatePercent: decimalText(metrics.winRatePercent),
    profitFactor: decimalText(metrics.profitFactor),
    tradeCount: typeof metrics.tradeCount === "number" ? metrics.tradeCount : null,
    costAssumptions: Array.isArray(assumptions) ? assumptions.filter((line): line is string => typeof line === "string") : [],
  };
}

async function latestBacktestFor(bot: Pick<BotRow, "userId" | "definitionId">): Promise<BotBacktestSummary | null> {
  if (!bot.definitionId) return null;
  const row = await prisma.backtestRun
    .findFirst({
      where: { userId: bot.userId, definitionId: bot.definitionId },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, kind: true, metricsJson: true, costAssumptionsJson: true, resultJson: true },
    })
    .catch(() => null);
  return row ? parseBacktest(row) : null;
}

export async function botView(row: BotRow, options: { withBacktest?: boolean } = {}): Promise<BotView> {
  const definition = validateStrategyDefinition(decodeJson(row.definitionJson));
  const latestBacktest = options.withBacktest === false ? null : await latestBacktestFor(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: isBotState(row.state) ? row.state : "DRAFT",
    market: row.market,
    config: decodeBotConfig(row.configJson) ?? {
      name: row.name,
      description: row.description,
      market: row.market,
      entryRsiBelow: "30",
      exitRsiAbove: "70",
      sizePercent: "25",
      stopLossPercent: "4",
      dailyLossHaltPercent: "2",
      budgetUsd: "25",
      initialCapitalUsd: "10000",
    },
    definition:
      definition.valid && row.definitionId && row.definitionVersion !== null
        ? {
            id: row.definitionId,
            version: row.definitionVersion,
            text: row.definitionText ?? "",
            rules: definitionRules(definition.definition),
          }
        : null,
    templateSlug: row.templateSlug,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    latestBacktest,
  };
}

// ---------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------

/**
 * The caps this account is under, from the fee schedule's default tier.
 *
 * There is exactly one tier dataset in this build — the owner-editable tiers on
 * `/admin/fees`, whose `maxBots` and `maxVenueConnections` the venue-key path already
 * enforces. Reading them here rather than keeping a second settings row is what makes a
 * cap change take effect in both places at once; two rows would drift and one of them
 * would silently be the real answer. A schedule with no default tier falls back to the
 * shipped tier rather than to no cap at all.
 */
export async function getBotCapSettings(): Promise<BotCapSettings> {
  const schedule = await readEffectiveFeeSchedule().catch(() => null);
  const tiers = schedule?.tiers ?? [...DEFAULT_FEE_TIERS];
  const tier = tiers.find((candidate) => candidate.isDefault) ?? tiers[0];
  if (!tier) return { maxBots: 0, maxVenueConnections: 0, tierLabel: "unconfigured" };
  return { maxBots: tier.maxBots, maxVenueConnections: tier.maxVenueConnections, tierLabel: tier.label };
}

export async function countActiveBots(userId: string): Promise<number> {
  return prisma.bot.count({ where: { userId, state: { not: "DELETED" } } });
}

export async function countVenueConnections(userId: string): Promise<number> {
  return prisma.tradingVenueCredential.count({ where: { userId, revokedAt: null } });
}

export type BotCapacity = { allowed: boolean; cap: number; usage: number; message: string | null };

/**
 * What this account has left, for one kind of cap.
 *
 * The message is built here rather than by each caller so the create route, the clone route
 * and the venue-key route answer with the same sentence: the cap, the usage and where the
 * owner changes it. A cap that cannot be read falls back to the defaults instead of allowing
 * an unbounded create.
 */
export async function readBotCapacity(userId: string, kind: BotCapKind): Promise<BotCapacity> {
  const settings = await getBotCapSettings();
  const cap = kind === "bots" ? settings.maxBots : settings.maxVenueConnections;
  const usage = kind === "bots" ? await countActiveBots(userId) : await countVenueConnections(userId);
  const allowed = usage < cap;
  return {
    allowed,
    cap,
    usage,
    message: allowed ? null : botCapMessage(kind, cap, usage, settings.tierLabel),
  };
}

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

export async function listBots(userId: string): Promise<BotView[]> {
  const rows = await prisma.bot.findMany({
    where: { userId },
    orderBy: [{ state: "asc" }, { createdAt: "desc" }],
    select: BOT_SELECT,
  });
  return Promise.all(rows.map((row) => botView(row)));
}

export async function readBot(userId: string, id: string): Promise<BotView | null> {
  const row = await prisma.bot.findFirst({ where: { id, userId }, select: BOT_SELECT });
  return row ? botView(row) : null;
}

/** The raw row, for the template service which snapshot-copies it. */
export async function readBotRecord(userId: string, id: string): Promise<BotView | null> {
  return readBot(userId, id);
}

/**
 * The published bots as the phase-23 control sees them.
 *
 * A bot that is not PUBLISHED is not startable: a draft has no definition version, and a
 * deleted one is history. The label carries the version so two starts of the same name are
 * distinguishable in the audit trail and in the panel.
 */
export async function listStartableStrategies(userId: string): Promise<SmartStrategy[]> {
  const rows = await prisma.bot.findMany({
    where: { userId, state: "PUBLISHED", deletedAt: null },
    orderBy: { publishedAt: "desc" },
    select: { id: true, name: true, market: true, definitionVersion: true },
    take: 100,
  });
  return rows.map((row) => ({
    id: botStrategyId(row.id),
    label: `${row.name}${row.definitionVersion ? ` · v${row.definitionVersion}` : ""}`,
    detail: `Your published ${row.market} bot. Its last published rules are what the runner evaluates once per UTC day.`,
  }));
}

export async function readBotStrategyLabel(userId: string, strategyId: string | null | undefined): Promise<string | null> {
  const botId = parseBotStrategyId(strategyId);
  if (!botId) return null;
  const row = await prisma.bot
    .findFirst({ where: { id: botId, userId }, select: { name: true, definitionVersion: true, state: true } })
    .catch(() => null);
  if (!row) return null;
  return `${row.name}${row.definitionVersion ? ` · v${row.definitionVersion}` : ""}${row.state === "DELETED" ? " (deleted)" : ""}`;
}

/**
 * The runner's resolver: a published, non-deleted bot owned by the activation's account.
 *
 * Null is an answer, not an error — the loop records `STRATEGY_DISABLED` for that window
 * rather than evaluating an empty market. The same rule is why deleting a bot stops it being
 * scheduled on the next pass: the row is still there for history, but this read refuses it.
 */
export async function resolveBotRunnerStrategy(
  strategyId: string | null | undefined,
  userId: string,
): Promise<ReturnType<typeof runnerStrategyForBot> | null> {
  const botId = parseBotStrategyId(strategyId);
  if (!botId) return null;
  const row = await prisma.bot
    .findFirst({
      where: { id: botId, userId, state: "PUBLISHED", deletedAt: null },
      select: { id: true, name: true, market: true, configJson: true, definitionVersion: true },
    })
    .catch(() => null);
  if (!row) return null;
  const config = decodeBotConfig(row.configJson);
  if (!config) return null;
  return runnerStrategyForBot({ ...row, config });
}

export async function canStartBotStrategy(userId: string, strategyId: string | null | undefined): Promise<boolean> {
  const botId = parseBotStrategyId(strategyId);
  if (!botId) return false;
  const row = await prisma.bot
    .findFirst({ where: { id: botId, userId, state: "PUBLISHED", deletedAt: null }, select: { id: true } })
    .catch(() => null);
  return row !== null;
}

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

export type BotCreateResult =
  | { ok: true; bot: BotView }
  | { ok: false; status: 400 | 403 | 409; error: string; problems?: { field: string; message: string }[] };

export async function createBot(input: {
  userId: string;
  config: unknown;
  templateSlug?: string | null;
  /** A clone records its own audit action; the builder records a create. */
  action?: "BOT_CREATED" | "BOT_CLONED";
}): Promise<BotCreateResult> {
  const validation = validateBotConfig(input.config);
  if (!validation.valid) return { ok: false, status: 400, error: validation.error, problems: validation.problems };
  const capacity = await readBotCapacity(input.userId, "bots");
  if (!capacity.allowed) return { ok: false, status: 409, error: capacity.message ?? "The bot cap is reached." };

  const config = validation.value;
  const row = await prisma.$transaction(async (transaction) => {
    const created = await transaction.bot.create({
      data: {
        userId: input.userId,
        name: config.name,
        description: config.description,
        state: "DRAFT",
        market: config.market,
        configJson: JSON.stringify(config),
        templateSlug: input.templateSlug ?? null,
      },
      select: BOT_SELECT,
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: input.action ?? "BOT_CREATED",
        objectType: "Bot",
        objectId: created.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          name: config.name,
          market: config.market,
          templateSlug: input.templateSlug ?? null,
          state: "DRAFT",
        }),
      },
    });
    return created;
  });
  return { ok: true, bot: await botView(row) };
}

export type BotUpdateResult =
  | { ok: true; bot: BotView }
  | { ok: false; status: 400 | 404 | 409; error: string; problems?: { field: string; message: string }[] };

export async function updateDraftBot(input: {
  userId: string;
  botId: string;
  config: unknown;
}): Promise<BotUpdateResult> {
  const existing = await prisma.bot.findFirst({ where: { id: input.botId, userId: input.userId }, select: BOT_SELECT });
  if (!existing) return { ok: false, status: 404, error: "No bot with that id belongs to this account." };
  if (existing.state !== "DRAFT") {
    return { ok: false, status: 409, error: "Only a draft can be edited. Clone the published bot to change its rules." };
  }
  const validation = validateBotConfig(input.config);
  if (!validation.valid) return { ok: false, status: 400, error: validation.error, problems: validation.problems };
  const config = validation.value;

  const row = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.bot.update({
      where: { id: existing.id },
      data: {
        name: config.name,
        description: config.description,
        market: config.market,
        configJson: JSON.stringify(config),
      },
      select: BOT_SELECT,
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: "BOT_UPDATED",
        objectType: "Bot",
        objectId: updated.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({ name: config.name, market: config.market, state: "DRAFT" }),
      },
    });
    return updated;
  });
  return { ok: true, bot: await botView(row) };
}

export type BotPublishResult =
  | { ok: true; bot: BotView; alreadyPublished: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string; problems?: { field: string; message: string }[] };

/**
 * Publish a draft.
 *
 * Validation runs first — against the same phase-28 schema the runner and backtester use —
 * and nothing is written when it fails. The definition version is created before the bot
 * points at it, so a crash in between leaves an unreferenced version rather than a published
 * bot whose rules do not exist. A second publish of an already-published bot answers
 * `alreadyPublished` without writing a second version.
 */
export async function publishBot(input: { userId: string; botId: string }): Promise<BotPublishResult> {
  const existing = await prisma.bot.findFirst({ where: { id: input.botId, userId: input.userId }, select: BOT_SELECT });
  if (!existing) return { ok: false, status: 404, error: "No bot with that id belongs to this account." };
  if (existing.state === "DELETED") return { ok: false, status: 409, error: "A deleted bot cannot be published." };
  if (existing.state === "PUBLISHED") {
    return { ok: true, bot: await botView(existing), alreadyPublished: true };
  }
  const validation = validateBotConfig(decodeJson(existing.configJson));
  if (!validation.valid) return { ok: false, status: 400, error: validation.error, problems: validation.problems };
  const config = validation.value;

  const definition = await ensureStrategyVersion({
    userId: input.userId,
    text: botDefinitionText(config),
    origin: "manual",
  });

  const row = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.bot.update({
      where: { id: existing.id },
      data: {
        state: "PUBLISHED",
        name: config.name,
        description: config.description,
        market: config.market,
        configJson: JSON.stringify(config),
        definitionId: definition.id,
        definitionVersion: definition.version,
        definitionText: definition.text,
        definitionJson: JSON.stringify(definition.definition),
        publishedAt: new Date(),
        deletedAt: null,
      },
      select: BOT_SELECT,
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: "BOT_PUBLISHED",
        objectType: "Bot",
        objectId: updated.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          name: config.name,
          market: config.market,
          definitionId: definition.id,
          definitionVersion: definition.version,
          templateSlug: existing.templateSlug,
        }),
      },
    });
    return updated;
  });

  return { ok: true, bot: await botView(row), alreadyPublished: false };
}

export type BotDeleteResult =
  | { ok: true; bot: BotView; stoppedActivation: boolean; alreadyDeleted: boolean }
  | { ok: false; status: 404; error: string };

/**
 * Delete a bot, keeping its history.
 *
 * The row is marked DELETED rather than removed: decisions name the activation and orders
 * name the account, so nothing is lost by keeping the bot readable. If the account's running
 * activation names this bot, the same transaction stops it — that is what "stops being
 * scheduled immediately" means, rather than waiting for the next pass to notice.
 */
export async function deleteBot(input: { userId: string; botId: string; reason?: string }): Promise<BotDeleteResult> {
  const existing = await prisma.bot.findFirst({ where: { id: input.botId, userId: input.userId }, select: BOT_SELECT });
  if (!existing) return { ok: false, status: 404, error: "No bot with that id belongs to this account." };
  if (existing.state === "DELETED") {
    return { ok: true, bot: await botView(existing), stoppedActivation: false, alreadyDeleted: true };
  }
  const now = new Date();
  const strategyId = botStrategyId(existing.id);

  const result = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.bot.update({
      where: { id: existing.id },
      data: { state: "DELETED", deletedAt: now },
      select: BOT_SELECT,
    });
    const stopped = await transaction.strategyActivation.updateMany({
      where: { userId: input.userId, status: "RUNNING", strategyId },
      data: {
        status: "STOPPED",
        stoppedAt: now,
        lastChangeReason: input.reason ?? "BOT_DELETED",
        lastChangedByUserId: input.userId,
        lastChangedAt: now,
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: "BOT_DELETED",
        objectType: "Bot",
        objectId: updated.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          name: updated.name,
          stoppedActivation: stopped.count > 0,
          reason: input.reason ?? "OWNER_DELETED",
          at: now.toISOString(),
        }),
      },
    });
    if (stopped.count > 0) {
      const activation = await transaction.strategyActivation.findUnique({ where: { userId: input.userId }, select: { id: true } });
      if (activation) {
        await auditCreate(transaction, {
          data: {
            actorUserId: input.userId,
            action: "STRATEGY_TRADING_STOPPED",
            objectType: "StrategyActivation",
            objectId: activation.id,
            outcome: "SUCCESS",
            redactedJson: JSON.stringify({ from: "RUNNING", to: "STOPPED", strategyId, reason: "BOT_DELETED", at: now.toISOString() }),
          },
        });
      }
    }
    return { updated, stopped: stopped.count > 0 };
  });

  return {
    ok: true,
    bot: await botView(result.updated),
    stoppedActivation: result.stopped,
    alreadyDeleted: false,
  };
}

/** Best-effort label for an audit row without exposing the wallet address. */
export async function accountDisplayLabel(userId: string): Promise<string> {
  const identity = await prisma.walletIdentity
    .findFirst({ where: { userId, revokedAt: null }, orderBy: { verifiedAt: "desc" }, select: { addressDisplay: true } })
    .catch(() => null);
  const address = identity?.addressDisplay ?? null;
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "this account";
}

export { BOT_SELECT };
