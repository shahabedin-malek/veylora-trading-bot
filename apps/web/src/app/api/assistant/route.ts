import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";
import { authenticationGapResponse, getAccessRefusal } from "@/lib/auth/access-gate";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { loggerFor } from "@/lib/observability/request-context";
import {
  composeAnswer,
  emptyToolRecord,
  withRedactedToolResults,
  type AssistantToolRecord,
} from "@/lib/assistant/citations";
import {
  AssistantProviderError,
  AssistantStreamError,
  type AssistantMessage,
  type AssistantTransport,
  type TokenUsage,
} from "@/lib/assistant/loop";
import {
  ASSISTANT_LIMITS,
  assistantPricingConfigured,
  consumeAssistantRequest,
  readAssistantUsage,
  recordAssistantUsage,
  type AssistantUsageSnapshot,
} from "@/lib/assistant/limits";
import { runMarketAssistant } from "@/lib/assistant/public-market-adapter";
import {
  createRoutedAssistantTransport,
  getAiRoutingSettings,
  planAiRoute,
} from "@/lib/ai/router";
import { createAssistantToolExecutor, describeAssistantTools } from "@/lib/assistant/tools";
import { auditCreate } from "@/lib/audit/record";

/**
 * The assistant endpoint: `GET` reports readiness, `POST` asks a question.
 *
 * What is enforced here, in order, and why the order matters:
 *
 *  1. shape (content type, size, 1–12 messages of at most 2,000 characters) — cheap, and
 *     the same answers a script gets from every other route;
 *  2. the session — every tool runs with *this* account's identity, and there is no
 *     variant of this route in which a tool runs with anyone else's;
 *  3. same-origin — a question spends the account's budget and reaches a paid provider,
 *     so a cross-site page may not ask on the owner's behalf;
 *  4. the model configuration, naming the variables that would fix it;
 *  5. the per-account limit, counted before the provider is asked.
 *
 * The reply is streamed as server-sent events when the caller asks for them and returned
 * as one JSON object otherwise, and both paths run the same loop with the same tools. The
 * citations the answer carries are built from the executor's own record of what ran — not
 * from the model's description of it — so "which data was used" is a fact the server
 * states rather than a sentence the model composes.
 */

const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARACTERS = 2_000;

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal ? json({ error: refusal.error }, refusal.status) : null;
}

export async function GET() {
  // Readiness is the route's readiness, not a single variable's: the question a failed ask
  // has to answer is "which provider will serve this, and if none, what is missing".
  const settings = await getAiRoutingSettings();
  const plan = await planAiRoute("assistant", settings);
  return json({
    adapterEnabled: true,
    target: "Vercel AI Gateway",
    modelConfigured: plan.candidates.length > 0,
    model: plan.candidates[0]?.model ?? null,
    route: plan.candidates.map((candidate) => ({ providerId: candidate.provider.id, model: candidate.model })),
    missingKeys: plan.missingKeys,
    skipped: plan.skipped,
    tools: describeAssistantTools(),
    limits: ASSISTANT_LIMITS,
    pricingConfigured: assistantPricingConfigured(),
    streaming: true,
  });
}

export function parseMessages(value: unknown): AssistantMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages: AssistantMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") return null;
    if (typeof record.content !== "string" || !record.content.trim() || record.content.length > MAX_MESSAGE_CHARACTERS) return null;
    messages.push({ role: record.role, content: record.content });
  }
  return messages;
}

/** A cost figure a person can read, from micro-dollars, or null when unpriced. */
function formatCost(costMicros: number | null): string | null {
  return costMicros === null ? null : `$${(costMicros / 1_000_000).toFixed(6)}`;
}

function consumptionPayload(snapshot: AssistantUsageSnapshot | null) {
  if (!snapshot) return null;
  return {
    hourRequests: snapshot.hourRequests,
    dayRequests: snapshot.dayRequests,
    dayTokens: snapshot.dayTokens,
    dayCostMicros: snapshot.dayCostMicros,
    dayCostUsd: formatCost(snapshot.dayCostMicros),
    hourResetAt: snapshot.hourResetAt,
    dayResetAt: snapshot.dayResetAt,
    limits: snapshot.limits,
  };
}

/**
 * One audit row per question: what ran, what it cost, whether it worked.
 *
 * The prompt is deliberately absent. The trail has to answer "what did the assistant do
 * with this account's data" without becoming a transcript store that could hold a key a
 * person pasted into the chat box, so it records the tools by name, the token counts and
 * the outcome — and never the question, the answer or a tool result.
 */
async function auditAssistantRequest(input: {
  userId: string;
  model: string;
  streamed: boolean;
  toolCalls: readonly string[];
  record: AssistantToolRecord;
  usage: TokenUsage;
  outcome: "SUCCESS" | "FAILED";
  error?: string;
}) {
  try {
    await auditCreate(prisma, {
      data: {
        actorUserId: input.userId,
        action: "ASSISTANT_REQUEST",
        objectType: "AssistantConversation",
        objectId: input.model,
        outcome: input.outcome,
        redactedJson: JSON.stringify({
          streamed: input.streamed,
          model: input.model,
          toolCalls: input.toolCalls,
          sources: input.record.citations.map((citation) => ({ tool: citation.tool, source: citation.source, asOf: citation.asOf })),
          failures: input.record.failures,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          ...(input.error ? { error: input.error } : {}),
        }),
      },
    });
  } catch (error) {
    loggerFor("/api/assistant").error("the assistant request could not be audited", { error });
  }
}

type RunInput = {
  userId: string;
  messages: AssistantMessage[];
  question: string;
  transport: AssistantTransport;
  streamed: boolean;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
};

type RunResult = {
  answer: ReturnType<typeof composeAnswer>;
  toolCalls: string[];
  usage: TokenUsage;
};

/** One question, through the shared loop, with the tools bound to this account. */
async function runQuestion(input: RunInput): Promise<RunResult> {
  const now = new Date();
  const record = emptyToolRecord();
  const runTool = createAssistantToolExecutor({ userId: input.userId, now, record });
  // The second half of "no credential reaches a provider": the tool result is redacted on
  // its way out as well, so even a value this build did not expect to be secret — a venue
  // key echoed by a provider, a pasted token in a memo field — arrives at the model as the
  // marker. The result is what the loop records in the conversation and nothing else.
  const executeTool = withRedactedToolResults(runTool);

  // Both redaction passes live inside the pieces that send: `runMarketAssistant` redacts the
  // conversation on its way out, and the executor below redacts every tool result. The route
  // therefore has no path that reaches a provider unredacted, and no caller of either can
  // forget to ask for it.
  const result = await runMarketAssistant({
    messages: input.messages,
    executeTool,
    transport: input.transport,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  });

  return {
    answer: composeAnswer({ reply: result.reply, record, question: input.question }),
    toolCalls: result.toolCalls,
    usage: result.usage,
  };
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Invalid assistant request." }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "A messages array is required." }, 400);
  }
  const messages = parseMessages((body as Record<string, unknown>).messages);
  if (!messages) return json({ error: `Provide 1–${MAX_MESSAGES} chat messages of up to ${MAX_MESSAGE_CHARACTERS} characters each.` }, 400);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "The assistant is unavailable for this account." }, 503);
  }

  if (!isSameOriginRequest(request, config)) {
    return json({ error: "Request origin is not allowed." }, 403);
  }

  // Read on every request, which is what makes an admin route change take effect without a
  // redeploy. The plan has already dropped anything that cannot serve the assistant (no tool
  // calling, no stream), anything whose key is absent, and anything switched off.
  const settings = await getAiRoutingSettings();
  const plan = await planAiRoute("assistant", settings);
  if (plan.candidates.length === 0) {
    // Names, not a generic sentence: the panel shows this, so a failed ask says which value
    // is missing rather than "the assistant is unavailable".
    return json(
      {
        status: "unconfigured",
        error: plan.missingKeys.length > 0
          ? `Model access is not configured: set ${plan.missingKeys.join(" and ")}.`
          : "No target in the assistant route can answer right now. Open Admin → AI models and choose a tool-capable provider.",
        configuration: { target: "ai-route", route: [], skipped: plan.skipped, missingKeys: plan.missingKeys },
      },
      503,
    );
  }
  // The planned target, for the record of a request that never reached one. It is replaced
  // by the target that actually answered as soon as one does.
  const plannedModel = plan.candidates[0].model ?? plan.candidates[0].provider.id;

  const quota = await consumeAssistantRequest(user.id);
  if (!quota.allowed) {
    return json(
      {
        error: quota.sentence,
        code: quota.code,
        limit: quota.limit,
        observed: quota.observed,
        cap: quota.cap,
        resetAt: quota.resetAt,
        limits: ASSISTANT_LIMITS,
      },
      quota.status,
      quota.resetAt ? { "Retry-After": String(Math.max(1, Math.ceil((Date.parse(quota.resetAt) - Date.now()) / 1_000))) } : {},
    );
  }

  const wantsStream = request.headers.get("accept")?.toLowerCase().includes("text/event-stream") ?? false;
  const question = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  // The answer's own model, once something has answered: a fallback makes the planned target
  // a guess, and the record should say what happened rather than what was intended.
  let answeredModel = plannedModel;
  const transport = createRoutedAssistantTransport({
    plan,
    feature: "assistant",
    userId: user.id,
    settings,
    onAnswered: (target) => {
      answeredModel = target.model ?? target.provider.id;
    },
  });

  if (!wantsStream) {
    try {
      const run = await runQuestion({ userId: user.id, messages, question, transport, streamed: false });
      await recordAssistantUsage(user.id, run.usage);
      await auditAssistantRequest({
        userId: user.id,
        model: answeredModel,
        streamed: false,
        toolCalls: run.toolCalls,
        record: { citations: run.answer.citations, failures: run.answer.failures },
        usage: run.usage,
        outcome: "SUCCESS",
      });
      return json({
        status: "available",
        model: answeredModel,
        reply: run.answer.text,
        text: run.answer.text,
        citations: run.answer.citations,
        failures: run.answer.failures,
        missingTopics: run.answer.missingTopics,
        toolCalls: run.toolCalls,
        usage: run.usage,
        consumption: consumptionPayload(await readAssistantUsage(user.id)),
      });
    } catch (error) {
      return await providerFailure(error, { userId: user.id, model: answeredModel });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const run = await runQuestion({
          userId: user.id,
          messages,
          question,
          transport,
          streamed: true,
          onEvent: (event) => send(event),
        });
        await recordAssistantUsage(user.id, run.usage);
        await auditAssistantRequest({
          userId: user.id,
          model: answeredModel,
          streamed: true,
          toolCalls: run.toolCalls,
          record: { citations: run.answer.citations, failures: run.answer.failures },
          usage: run.usage,
          outcome: "SUCCESS",
        });
        send({
          type: "done",
          model: answeredModel,
          answer: {
            text: run.answer.text,
            citations: run.answer.citations,
            failures: run.answer.failures,
            missingTopics: run.answer.missingTopics,
            toolCalls: run.toolCalls,
          },
          usage: run.usage,
          consumption: consumptionPayload(await readAssistantUsage(user.id)),
        });
      } catch (error) {
        // A provider that died mid-answer has already delivered its text to the browser, so
        // the transcript keeps that text and is told it is incomplete rather than being left
        // with half a sentence that looks finished.
        const streamError = error instanceof AssistantStreamError ? error : null;
        const message = error instanceof Error ? error.message : "The assistant request failed.";
        send({
          type: "error",
          message: streamError
            ? `${message} The answer above is incomplete: it was cut off mid-reply.`
            : message,
          partial: streamError?.partial ?? null,
        });
        await auditAssistantRequest({
          userId: user.id,
          model: answeredModel,
          streamed: true,
          toolCalls: [],
          record: emptyToolRecord(),
          usage: { inputTokens: 0, outputTokens: 0 },
          outcome: "FAILED",
          error: message,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * A provider failure, in the shape the non-streaming caller reads.
 *
 * The failure is audited before the response is returned, with no tool calls and no
 * tokens: nothing was answered, and the record should say exactly that. The code names
 * the class of failure (`UNAVAILABLE`, `INVALID`, `LIMIT`) so a client can tell a dead
 * provider from a stopped loop.
 */
async function providerFailure(error: unknown, context: { userId: string; model: string }) {
  const message = error instanceof Error ? error.message : "The assistant request failed.";
  await auditAssistantRequest({
    userId: context.userId,
    model: context.model,
    streamed: false,
    toolCalls: [],
    record: emptyToolRecord(),
    usage: { inputTokens: 0, outputTokens: 0 },
    outcome: "FAILED",
    error: message,
  });
  return json(
    {
      error: message,
      code: error instanceof AssistantProviderError ? error.kind.toUpperCase() : "ASSISTANT_FAILED",
      ...(error instanceof AssistantStreamError && error.partial ? { partial: error.partial } : {}),
    },
    502,
  );
}
