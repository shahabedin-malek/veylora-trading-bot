import { prisma } from "@/lib/db";
import { DEFAULT_BOT_CONFIG, botDefinitionText, slugifyTemplateName, validateBotConfig, type BotConfig } from "./publish";
import {
  accountDisplayLabel,
  createBot,
  readBot,
  type BotView,
} from "./repository";
import { auditCreate } from "@/lib/audit/record";

/**
 * Templates and the marketplace (phase 30).
 *
 * A template is a snapshot of a bot's rules, not a pointer to a live bot. The built-in ones
 * are constants because they ship with the product and must exist on a fresh deployment; a
 * template an account shares is a row, because it carries an author. Both are cloned through
 * the same path, so "clone" cannot behave differently depending on where the template came
 * from.
 *
 * Performance is read from `BacktestRun` — the phase-28 rows — and never computed or
 * invented here. A template with no recorded run says so rather than showing a zero, which
 * is the difference between "not measured" and "measured at zero".
 */

export type TemplatePerformance = {
  runId: string;
  ranAt: string;
  initialCapitalUsd: string | null;
  finalCapitalUsd: string | null;
  returnPercent: string | null;
  maxDrawdownPercent: string | null;
  winRatePercent: string | null;
  tradeCount: number | null;
};

export type MarketplaceTemplate = {
  id: string;
  name: string;
  description: string;
  author: string;
  market: string;
  builtIn: boolean;
  config: BotConfig;
  performance: TemplatePerformance | null;
  performanceNote: string;
};

type TemplateSeed = {
  slug: string;
  name: string;
  description: string;
  config: BotConfig;
};

function seed(slug: string, name: string, description: string, config: Partial<BotConfig>): TemplateSeed {
  return {
    slug,
    name,
    description,
    config: { ...DEFAULT_BOT_CONFIG, ...config, name, description },
  };
}

export const BUILT_IN_TEMPLATES: readonly TemplateSeed[] = [
  seed(
    "btc-oversold-bounce",
    "BTC oversold bounce",
    "Buys a deeply oversold daily BTC close and exits on the overbought close, with a 4% stop and a 2% daily halt.",
    { market: "BTC-USD", entryRsiBelow: "30", exitRsiAbove: "70", sizePercent: "25", stopLossPercent: "4", budgetUsd: "25" },
  ),
  seed(
    "eth-daily-reversion",
    "ETH daily reversion",
    "A wider ETH band: enters below RSI 35 and exits above 65, committing a fifth of equity per entry.",
    { market: "ETH-USD", entryRsiBelow: "35", exitRsiAbove: "65", sizePercent: "20", stopLossPercent: "5", budgetUsd: "25" },
  ),
  seed(
    "sol-deep-value",
    "SOL deep value",
    "Waits for a rare SOL oversold close below 25 and exits above 75, with a 6% stop and smaller size.",
    { market: "SOL-USD", entryRsiBelow: "25", exitRsiAbove: "75", sizePercent: "15", stopLossPercent: "6", budgetUsd: "20" },
  ),
];

function decimal(value: unknown): string | null {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
}

/**
 * Performance from the newest recorded backtest of this template's exact rules.
 *
 * `authorUserId` scopes a shared template to its author's own run when one exists; the
 * built-ins have no author, so the newest matching run in this deployment is shown with its
 * date. Either way the figures are the stored run's, and the note names that.
 */
async function performanceFor(text: string, authorUserId: string | null): Promise<{ performance: TemplatePerformance | null; note: string }> {
  const rows = await prisma.backtestRun
    .findMany({
      where: {
        strategyText: text,
        kind: "BACKTEST",
        ...(authorUserId ? { userId: authorUserId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { id: true, createdAt: true, metricsJson: true, resultJson: true },
    })
    .catch(() => []);
  const row = rows[0];
  if (!row) {
    return {
      performance: null,
      note: "No real backtest has been recorded for these rules yet, so no performance figure is shown.",
    };
  }
  try {
    const metrics = JSON.parse(row.metricsJson) as Record<string, unknown>;
    const result = JSON.parse(row.resultJson) as Record<string, unknown>;
    return {
      performance: {
        runId: row.id,
        ranAt: row.createdAt.toISOString(),
        initialCapitalUsd: decimal(result.initialCapitalUsd),
        finalCapitalUsd: decimal(metrics.finalCapitalUsd),
        returnPercent: decimal(metrics.totalReturnPercent),
        maxDrawdownPercent: decimal(metrics.maxDrawdownPercent),
        winRatePercent: decimal(metrics.winRatePercent),
        tradeCount: typeof metrics.tradeCount === "number" ? metrics.tradeCount : null,
      },
      note: `Measured by a recorded backtest on ${row.createdAt.toISOString().slice(0, 10)}; past results are not evidence of future returns.`,
    };
  } catch {
    return {
      performance: null,
      note: "The recorded run for these rules could not be read, so no performance figure is shown.",
    };
  }
}

type TemplateRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  authorUserId: string | null;
  authorLabel: string;
  market: string;
  configJson: string;
  definitionText: string;
  createdAt: Date;
};

async function sharedTemplates(): Promise<TemplateRow[]> {
  return prisma.strategyTemplate
    .findMany({ orderBy: { createdAt: "desc" }, take: 100 })
    .catch(() => []);
}

export async function listMarketplaceTemplates(): Promise<MarketplaceTemplate[]> {
  const shared = await sharedTemplates();
  const builtIns = await Promise.all(
    BUILT_IN_TEMPLATES.map(async (template) => {
      const measured = await performanceFor(botDefinitionText(template.config), null);
      return {
        id: template.slug,
        name: template.name,
        description: template.description,
        author: "Veylora",
        market: template.config.market,
        builtIn: true,
        config: template.config,
        performance: measured.performance,
        performanceNote: measured.note,
      } satisfies MarketplaceTemplate;
    }),
  );

  const sharedViews = await Promise.all(
    shared.map(async (row) => {
      const parsed = validateBotConfig(JSON.parse(row.configJson) as unknown);
      const config = parsed.valid ? parsed.value : { ...DEFAULT_BOT_CONFIG, name: row.name, market: row.market };
      const measured = await performanceFor(row.definitionText, row.authorUserId);
      return {
        id: row.slug,
        name: row.name,
        description: row.description,
        author: row.authorLabel,
        market: row.market,
        builtIn: false,
        config,
        performance: measured.performance,
        performanceNote: measured.note,
      } satisfies MarketplaceTemplate;
    }),
  );

  return [...builtIns, ...sharedViews];
}

export async function findTemplate(slug: string): Promise<MarketplaceTemplate | null> {
  const builtIn = BUILT_IN_TEMPLATES.find((template) => template.slug === slug);
  if (builtIn) {
    const measured = await performanceFor(botDefinitionText(builtIn.config), null);
    return {
      id: builtIn.slug,
      name: builtIn.name,
      description: builtIn.description,
      author: "Veylora",
      market: builtIn.config.market,
      builtIn: true,
      config: builtIn.config,
      performance: measured.performance,
      performanceNote: measured.note,
    };
  }
  const row = await prisma.strategyTemplate.findUnique({ where: { slug } }).catch(() => null);
  if (!row) return null;
  const parsed = validateBotConfig(JSON.parse(row.configJson) as unknown);
  if (!parsed.valid) return null;
  const measured = await performanceFor(row.definitionText, row.authorUserId);
  return {
    id: row.slug,
    name: row.name,
    description: row.description,
    author: row.authorLabel,
    market: row.market,
    builtIn: false,
    config: parsed.value,
    performance: measured.performance,
    performanceNote: measured.note,
  };
}

export type CloneResult =
  | { ok: true; bot: BotView; template: MarketplaceTemplate }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; problems?: { field: string; message: string }[] };

/**
 * Clone a template into a new draft owned by the caller.
 *
 * The clone copies the template's config and records the template slug on the bot, so its
 * origin survives. It does not copy the template's name: a clone that kept the name would
 * become "version 2" of the original's definition series on publish, which is exactly the
 * history confusion phase 28 avoids. The default name is the template name plus "copy", and
 * the caller may supply another.
 */
export async function cloneTemplate(input: {
  userId: string;
  templateId: string;
  name?: string;
}): Promise<CloneResult> {
  const template = await findTemplate(input.templateId);
  if (!template) return { ok: false, status: 404, error: "No template with that id exists." };
  const name = input.name?.trim() || `${template.name} copy`;
  const config: BotConfig = { ...template.config, name };
  const validation = validateBotConfig(config);
  if (!validation.valid) {
    return { ok: false, status: 400, error: validation.error, problems: validation.problems };
  }
  const created = await createBot({
    userId: input.userId,
    config: validation.value,
    templateSlug: template.id,
    action: "BOT_CLONED",
  });
  if (!created.ok) return created;
  return { ok: true, bot: created.bot, template };
}

export type ShareResult =
  | { ok: true; template: MarketplaceTemplate; changed: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Share a published bot as a template.
 *
 * Only a published bot can be shared: a draft's rules are still being edited, and the
 * marketplace's performance comes from a real run of the published text. The row is a
 * snapshot, so later edits to the bot do not rewrite what was shared.
 */
export async function shareBotAsTemplate(input: { userId: string; botId: string }): Promise<ShareResult> {
  const bot = await readBot(input.userId, input.botId);
  if (!bot) return { ok: false, status: 404, error: "No bot with that id belongs to this account." };
  if (bot.state !== "PUBLISHED" || !bot.definition) {
    return { ok: false, status: 409, error: "Only a published bot can be shared to the marketplace." };
  }
  const existing = await prisma.strategyTemplate.findFirst({
    where: { authorUserId: input.userId, sourceBotId: bot.id, definitionText: bot.definition.text },
    orderBy: { createdAt: "desc" },
  }).catch(() => null);
  if (existing) {
    const template = await findTemplate(existing.slug);
    if (template) return { ok: true, template, changed: false };
  }

  const base = slugifyTemplateName(bot.name);
  let slug = base;
  for (let attempt = 2; attempt <= 50; attempt += 1) {
    const taken = await prisma.strategyTemplate.findUnique({ where: { slug }, select: { id: true } }).catch(() => null);
    if (!taken) break;
    slug = `${base}-${attempt}`;
  }

  const author = await accountDisplayLabel(input.userId);
  const row = await prisma.$transaction(async (transaction) => {
    const created = await transaction.strategyTemplate.create({
      data: {
        slug,
        name: bot.name,
        description: bot.description || `Shared from a published ${bot.market} bot.`,
        authorUserId: input.userId,
        authorLabel: author,
        market: bot.market,
        configJson: JSON.stringify(bot.config),
        definitionText: bot.definition!.text,
        definitionJson: JSON.stringify(bot.config),
        sourceBotId: bot.id,
      },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId: input.userId,
        action: "BOT_SHARED_TO_MARKETPLACE",
        objectType: "Bot",
        objectId: bot.id,
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({ slug: created.slug, name: created.name, definitionVersion: bot.definition!.version }),
      },
    });
    return created;
  });

  const template = await findTemplate(row.slug);
  if (!template) return { ok: false, status: 409, error: "The template was shared but could not be read back." };
  return { ok: true, template, changed: true };
}
