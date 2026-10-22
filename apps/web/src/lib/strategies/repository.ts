import { prisma } from "@/lib/db";
import { renderStrategyText, type StrategyDefinition } from "./definition";
import { validateStrategyDefinition, validateStrategyText } from "./validate";

/**
 * Definitions are stored as versions, and a save inserts rather than edits.
 *
 * That is the whole versioning requirement in one decision: a backtest or a paper run names
 * the version it tested, so editing a strategy afterwards cannot change what a recorded
 * result was produced from. The previous version stays readable because nothing ever
 * updates it, and `(userId, name, version)` is unique, so "the next version" is a fact the
 * database enforces rather than a number the client promises.
 *
 * A definition is grouped by its `name`, which is the STRATEGY line the owner reads. A
 * rename therefore starts a new series rather than rewriting an old one — which is honest:
 * the rules that were backtested under the old name keep that name.
 */

export type DefinitionTextTrace = {
  promptVersion?: string | null;
  system: string;
  user: string;
  rawOutput: string;
  providerId: string | null;
  model: string | null;
  fallbackFrom: string | null;
};

export type StrategyDefinitionRow = {
  id: string;
  name: string;
  version: number;
  market: string;
  timeframe: string;
  text: string;
  definition: StrategyDefinition;
  origin: string;
  trace: DefinitionTextTrace | null;
  createdAt: string;
};

type PrismaDefinitionRow = {
  id: string;
  name: string;
  version: number;
  market: string;
  timeframe: string;
  text: string;
  definitionJson: string;
  origin: string;
  promptJson: string | null;
  modelOutput: string | null;
  providerId: string | null;
  model: string | null;
  fallbackFrom: string | null;
  createdAt: Date;
};

function decodeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toRow(row: PrismaDefinitionRow): StrategyDefinitionRow {
  const definition = validateStrategyDefinition(decodeJson(row.definitionJson));
  if (!definition.valid) {
    throw new Error(`Stored strategy definition ${row.id} failed validation: ${definition.issues.join(" ")}`);
  }
  const prompt = decodeJson(row.promptJson);
  const hasPrompt =
    typeof prompt === "object" && prompt !== null && typeof (prompt as { system?: unknown }).system === "string";
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    market: row.market,
    timeframe: row.timeframe,
    text: row.text,
    definition: definition.definition,
    origin: row.origin,
    trace: hasPrompt
      ? {
          system: (prompt as { system: string }).system,
          user: typeof (prompt as { user?: unknown }).user === "string" ? (prompt as { user: string }).user : "",
          rawOutput: row.modelOutput ?? "",
          providerId: row.providerId,
          model: row.model,
          fallbackFrom: row.fallbackFrom,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listStrategyDefinitions(userId: string, limit = 100): Promise<StrategyDefinitionRow[]> {
  const rows = await prisma.strategyDefinition.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map((row) => toRow(row));
}

export async function readStrategyDefinition(userId: string, id: string): Promise<StrategyDefinitionRow | null> {
  const row = await prisma.strategyDefinition.findFirst({ where: { id, userId } });
  return row ? toRow(row) : null;
}

/** The newest version of each name, which is the list the panel shows first. */
export function latestByStrategy(rows: readonly StrategyDefinitionRow[]): StrategyDefinitionRow[] {
  const latest = new Map<string, StrategyDefinitionRow>();
  for (const row of rows) {
    const current = latest.get(row.name);
    if (!current || row.version > current.version) latest.set(row.name, row);
  }
  return [...latest.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function nextVersion(userId: string, name: string, fallback: number): Promise<number> {
  const latest = await prisma.strategyDefinition.findFirst({
    where: { userId, name },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (latest?.version ?? fallback) + 1;
}

export async function createStrategyVersion(input: {
  userId: string;
  definition: StrategyDefinition;
  origin: "generated" | "manual" | "edit";
  trace?: DefinitionTextTrace | null;
}): Promise<StrategyDefinitionRow> {
  const validation = validateStrategyDefinition(input.definition);
  if (!validation.valid) throw new Error(`Refused to store an invalid definition: ${validation.issues.join(" ")}`);
  const definition = validation.definition;
  const text = renderStrategyText(definition);

  const row = await prisma.$transaction(async (transaction) => {
    const version = await nextVersion(input.userId, definition.name, 0);
    return transaction.strategyDefinition.create({
      data: {
        userId: input.userId,
        name: definition.name,
        version,
        market: definition.market,
        timeframe: definition.timeframe,
        text,
        definitionJson: JSON.stringify(definition),
        origin: input.origin,
        promptJson: input.trace ? JSON.stringify({ system: input.trace.system, user: input.trace.user }) : null,
        modelOutput: input.trace?.rawOutput ?? null,
        providerId: input.trace?.providerId ?? null,
        model: input.trace?.model ?? null,
        fallbackFrom: input.trace?.fallbackFrom ?? null,
      },
    });
  });
  return toRow(row);
}

/**
 * The version a run should be tied to.
 *
 * If the owner submits text identical to the newest version of the same strategy, that row
 * is reused rather than a duplicate version written — running the same rules twice does not
 * invent an edit. If the text differs, the change becomes a new version, which is what
 * makes "a strategy is versioned on every edit" true even for an edit that is only run and
 * never explicitly saved.
 */
export async function ensureStrategyVersion(input: {
  userId: string;
  text: string;
  origin: "generated" | "manual" | "edit";
}): Promise<StrategyDefinitionRow> {
  const validation = validateStrategyText(input.text);
  if (!validation.valid) throw new Error(`Refused to store an invalid definition: ${validation.issues.join(" ")}`);
  const definition = validation.definition;
  const latest = await prisma.strategyDefinition.findFirst({
    where: { userId: input.userId, name: definition.name },
    orderBy: { version: "desc" },
  });
  if (latest && latest.text.trim() === renderStrategyText(definition)) return toRow(latest);
  return createStrategyVersion({ userId: input.userId, definition, origin: latest ? "edit" : input.origin });
}

export type EditStrategyResult =
  | { changed: true; row: StrategyDefinitionRow; previous: StrategyDefinitionRow }
  | { changed: false; row: StrategyDefinitionRow; previous: StrategyDefinitionRow };

/**
 * An explicit edit. The previous version is returned beside the new one so the caller — and
 * the panel — can show both without a second read.
 */
export async function editStrategyDefinition(input: {
  userId: string;
  id: string;
  text: string;
}): Promise<EditStrategyResult | null> {
  const existing = await readStrategyDefinition(input.userId, input.id);
  if (!existing) return null;
  const validation = validateStrategyText(input.text);
  if (!validation.valid) throw new Error(validation.issues.join(" "));

  const definition = validation.definition;
  if (renderStrategyText(definition) === existing.text.trim()) {
    return { changed: false, row: existing, previous: existing };
  }
  // The edit keeps the series it was opened from, even if the STRATEGY line was retyped:
  // the owner edited *this* strategy, and continuing its numbering is what makes a later
  // result traceable to the version it followed.
  const row = await createStrategyVersion({
    userId: input.userId,
    origin: "edit",
    definition: { ...definition, name: existing.name },
  });
  return { changed: true, row, previous: existing };
}
