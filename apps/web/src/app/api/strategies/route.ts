import { NextRequest } from "next/server";
import { accessRefusalPayload, authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { definitionRules, MAX_DEFINITION_TEXT_LENGTH, renderStrategyText, type StrategyDefinition } from "@/lib/strategies/definition";
import { AiRouteUnavailableError, generateStrategyFromDescription, type GenerationTrace } from "@/lib/strategies/generate";
import {
  createStrategyVersion,
  editStrategyDefinition,
  latestByStrategy,
  listStrategyDefinitions,
  type StrategyDefinitionRow,
} from "@/lib/strategies/repository";
import { validateStrategyText } from "@/lib/strategies/validate";

/**
 * The strategy definition surface.
 *
 * `GET` lists this account's versions, newest first and grouped by name. `POST` either
 * generates a definition from a plain-English description or saves text the owner wrote by
 * hand. `PUT` edits an existing strategy, which *inserts* the next version rather than
 * mutating the old one — so a version that was backtested stays readable exactly as it was
 * tested.
 *
 * Three properties are deliberate:
 *
 *  - **Generation keeps its receipts.** The response, the stored version and a later trace
 *    all carry the prompt and the model's raw output, so a rule can be traced to what
 *    produced it. Nothing about the generated strategy is hidden behind a summary.
 *  - **A refusal names the problem.** An answer that fails validation returns 422 with the
 *    parser's own sentences and the raw output beside them; a missing provider key returns
 *    503 naming the environment variable, never a generic failure.
 *  - **No confirmation step.** There is no approval in front of generating, saving or
 *    editing: the owner's press is the authorisation, and the version history is the record.
 */

const MAX_BODY_BYTES = 16_384;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json(accessRefusalPayload(refusal), refusal.status) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viewOf(row: StrategyDefinitionRow) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    market: row.market,
    timeframe: row.timeframe,
    text: row.text,
    rules: definitionRules(row.definition),
    origin: row.origin,
    createdAt: row.createdAt,
    trace: row.trace,
  };
}

type TextRead = { valid: true; text: string } | { valid: false; error: string };

function readText(value: unknown): TextRead {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, error: "A strategy definition is required as text." };
  }
  if (value.length > MAX_DEFINITION_TEXT_LENGTH) {
    return { valid: false, error: `A definition is at most ${MAX_DEFINITION_TEXT_LENGTH} characters.` };
  }
  return { valid: true, text: value };
}

async function readJsonBody(request: NextRequest): Promise<{ body: unknown } | { response: Response }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { response: json({ error: "Content-Type must be application/json." }, 415) };
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { response: json({ error: "Invalid request body." }, 400) };
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return { response: json({ error: "Request is too large." }, 413) };
  }
  try {
    return { body: JSON.parse(rawBody) as unknown };
  } catch {
    return { response: json({ error: "Invalid JSON request." }, 400) };
  }
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "The strategy list is unavailable." }, 503);
  }
  try {
    const rows = await listStrategyDefinitions(user.id);
    return json({ definitions: rows.map(viewOf), latest: latestByStrategy(rows).map(viewOf) });
  } catch {
    return json({ error: "The strategy list could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  const parsedBody = await readJsonBody(request);
  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  if (!isRecord(body) || typeof body.mode !== "string") {
    return json({ error: "Choose a mode: generate, manual or validate." }, 400);
  }

  let description = "";
  let text = "";
  let definition: StrategyDefinition | null = null;

  if (body.mode === "generate") {
    if (typeof body.description !== "string") {
      return json({ error: "A plain-English description is required." }, 400);
    }
    description = body.description;
  } else if (body.mode === "manual" || body.mode === "validate") {
    const read = readText(body.text);
    if (!read.valid) return json({ error: read.error }, 400);
    const validation = validateStrategyText(read.text);
    if (!validation.valid) {
      // Answered before authorization, so a malformed definition is refused with its own
      // problem rather than hidden behind an authentication error.
      return json({ valid: false, error: "The definition cannot run as written.", issues: validation.issues }, 422);
    }
    text = renderStrategyText(validation.definition);
    definition = validation.definition;
  } else {
    return json({ error: "Choose a mode: generate, manual or validate." }, 400);
  }

  if (body.mode === "validate" && definition) {
    return json({ valid: true, text, rules: definitionRules(definition) });
  }

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  if (body.mode === "generate") {
    return generate(request, user.id, description);
  }

  try {
    const row = await createStrategyVersion({
      userId: user.id,
      definition: definition as StrategyDefinition,
      origin: "manual",
    });
    return json({ definition: viewOf(row) }, 201);
  } catch {
    return json({ error: "The definition could not be saved as a version." }, 503);
  }
}

async function generate(_request: NextRequest, userId: string, description: string): Promise<Response> {
  let generation;
  try {
    generation = await generateStrategyFromDescription({ description, userId });
  } catch (error) {
    if (error instanceof AiRouteUnavailableError) {
      return json(
        {
          error: error.message,
          missingKeys: error.missingKeys,
          skipped: error.skipped.map((target) => ({ providerId: target.providerId, reason: target.reason })),
        },
        503,
      );
    }
    return json({ error: "The model could not be reached, so no definition was produced." }, 503);
  }

  if (!generation.ok) {
    const trace: GenerationTrace | null = generation.trace;
    return json(
      {
        error: "The model's answer is not a definition this build can run. Nothing was saved.",
        issues: generation.issues,
        rawOutput: trace?.rawOutput ?? null,
        prompt: trace ? { system: trace.system, user: trace.user, version: trace.promptVersion } : null,
        providerId: trace?.providerId ?? null,
        model: trace?.model ?? null,
        fallbackFrom: trace?.fallbackFrom ?? null,
      },
      422,
    );
  }

  try {
    const row = await createStrategyVersion({
      userId,
      definition: generation.definition,
      origin: "generated",
      trace: generation.trace,
    });
    return json(
      {
        definition: viewOf(row),
        trace: {
          promptVersion: generation.trace.promptVersion,
          prompt: { system: generation.trace.system, user: generation.trace.user },
          rawOutput: generation.trace.rawOutput,
          providerId: generation.trace.providerId,
          model: generation.trace.model,
          fallbackFrom: generation.trace.fallbackFrom,
        },
      },
      201,
    );
  } catch {
    return json({ error: "The definition was produced but could not be saved as a version." }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  const parsedBody = await readJsonBody(request);
  if ("response" in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  if (!isRecord(body) || typeof body.id !== "string" || !body.id.trim()) {
    return json({ error: "The id of the definition to edit is required." }, 400);
  }
  const read = readText(body.text);
  if (!read.valid) return json({ error: read.error }, 400);
  const validation = validateStrategyText(read.text);
  if (!validation.valid) {
    return json({ valid: false, error: "The definition cannot run as written.", issues: validation.issues }, 422);
  }

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  try {
    const result = await editStrategyDefinition({ userId: user.id, id: body.id, text: read.text });
    if (!result) return json({ error: "No definition with that id belongs to this account." }, 404);
    return json({
      changed: result.changed,
      definition: viewOf(result.row),
      previous: viewOf(result.previous),
      message: result.changed
        ? `Saved as version ${result.row.version}. Version ${result.previous.version} remains readable.`
        : "These rules are identical to the newest version, so no new version was written.",
    });
  } catch {
    return json({ error: "The edit could not be saved as a new version." }, 503);
  }
}
