import DecimalJS from "decimal.js";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveBotRunnerStrategy } from "@/lib/bot-builder/repository";
import { strategyDefinition } from "@/lib/strategies/decide";
import { strategyRunnerStore } from "@/lib/strategies/runner";
import { describeRiskRefusal } from "@/lib/strategies/reasons";
import { describeLimitRefusal } from "@/lib/risk-controls/enforcement";
import { evaluateRiskOrder } from "@/lib/risk-controls/policy";
import { getRiskPolicySettings, readStrategyKillSwitch } from "@/lib/risk-controls/settings";
import { readRiskUsageFacts } from "@/lib/risk-controls/usage";
import { submitOrder } from "@/lib/orders/process";
import { ORDER_NOTE_PREFIX } from "@/lib/orders/origin";
import { orderVenueSummary } from "@/lib/venues/registry";
import { coinbaseMarketData } from "@/lib/market-data/coinbase-service";
import { loggerFor } from "@/lib/observability/request-context";
import {
  claimSignalAttempt,
  recordSignalEvent,
  resolveSignalAttempt,
  type SignalReasonCode,
} from "@/lib/signals/log";
import { mapSignal, signalRiskInput, type SignalBounds } from "@/lib/signals/map";
import {
  hashSignalBody,
  hashSignalToken,
  openSecret,
  SIGNAL_SIGNATURE_HEADER,
  SIGNAL_SOURCE_HEADER,
  SIGNAL_TIMESTAMP_HEADER,
  verifySignal,
} from "@/lib/signals/verify";
import { publishWebhookEvent } from "@/lib/webhooks/dispatch";

/**
 * The inbound signal endpoint (phase 31): `POST /api/signals/[token]`.
 *
 * This is the only unauthenticated-by-session write in the app, and the order of its steps is
 * the security design:
 *
 *  1. **The token is looked up by hash.** The URL segment is never stored, so the table cannot
 *     be turned back into working endpoints.
 *  2. **The signature is verified over the raw bytes, before parsing.** Nothing reads the JSON
 *     until the HMAC over `${timestamp}.${body}` matches, so a malformed or hostile body never
 *     reaches a parser.
 *  3. **The signal id is claimed.** The unique `dedupeKey` makes a replay a duplicate, not a
 *     second action, and the claim happens before the order path.
 *  4. **The mapping and the owner's bounds run.** A refusal names the bound that refused it.
 *  5. **The phase-25 risk policy runs.** A signal is not a privileged path around the caps.
 *  6. **The order path submits.** With a client key derived from the signal id, so even a
 *     retry that somehow reached submission replays rather than places twice.
 *
 * Every attempt that belongs to an account writes a `SignalEvent` row — accepted, refused or
 * duplicate. An unknown token has no account to show a log entry to, so it is answered 401 and
 * recorded only in the server log (without the token).
 */

const Decimal = DecimalJS.clone({ precision: 40 });
const MAX_BODY_BYTES = 32_768;
const SIGNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_FIELDS = new Set(["signalId", "strategyId", "action", "market", "sizeUsd"]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function sourceOf(request: NextRequest): string {
  const header = request.headers.get(SIGNAL_SOURCE_HEADER)?.trim();
  if (header) return header.slice(0, 80);
  return "api";
}

/**
 * The price a signal's size is converted at.
 *
 * The public quote first, because a signal arrives *now* and the stored daily close may be a day
 * old — an order sized against yesterday's price is not the order the signal asked for. The
 * stored candle is the fallback when the feed will not answer, and a refusal (PRICE_UNAVAILABLE)
 * is the answer when neither exists; nothing is guessed.
 */
async function readSignalPrice(market: string): Promise<string | null> {
  const quotes = await coinbaseMarketData.getQuotes({ instruments: [market] }).catch(() => null);
  if (quotes?.status === "available" && quotes.data.length > 0) {
    const quote = quotes.data[0];
    const candidates = [quote.last, quote.bid, quote.ask].filter((value): value is string => Boolean(value));
    for (const value of candidates) {
      const parsed = new Decimal(value);
      if (parsed.isFinite() && parsed.gt(0)) return parsed.toFixed();
    }
  }
  const candle = await prisma.marketCandleRecord
    .findFirst({
      where: { symbol: market },
      orderBy: { closeTime: "desc" },
      select: { close: true },
    })
    .catch(() => null);
  if (!candle) return null;
  const stored = new Decimal(candle.close);
  return stored.isFinite() && stored.gt(0) ? stored.toFixed() : null;
}

type ResolvedStrategy = { id: string; label: string; market: string; budgetUsd: string; stopLossPercent: string };

async function resolveSignalStrategy(strategyId: string | null, userId: string): Promise<ResolvedStrategy | null> {
  if (!strategyId) return null;
  const builtIn = strategyDefinition(strategyId);
  const definition = builtIn ?? (await resolveBotRunnerStrategy(strategyId, userId).catch(() => null));
  if (!definition) return null;
  return {
    id: definition.id,
    label: definition.label,
    market: definition.market,
    budgetUsd: definition.budgetUsd,
    stopLossPercent: definition.stopLossPercent,
  };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const logger = loggerFor("/api/signals/[token]");
  const { token: tokenSegment } = await params;
  const rawToken = (tokenSegment ?? "").trim();
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "The signal body is too large.", code: "BODY_TOO_LARGE" }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "The signal body could not be read.", code: "SIGNAL_INVALID" }, 400);
  }
  const bodyHash = hashSignalBody(rawBody);
  const source = sourceOf(request);
  const receivedAt = new Date();

  const tokenRow = rawToken
    ? await prisma.signalToken
        .findUnique({
          where: { tokenHash: hashSignalToken(rawToken) },
          select: {
            id: true,
            userId: true,
            status: true,
            replayWindowSeconds: true,
            secretCiphertext: true,
            secretIv: true,
            secretAuthTag: true,
          },
        })
        .catch(() => null)
    : null;

  if (!tokenRow) {
    logger.warn("signal refused: token not recognised", { source, bodyHash: bodyHash.slice(0, 16) });
    return json({ error: "The signal token is not recognised.", code: "TOKEN_UNKNOWN" }, 401);
  }

  const record = async (input: {
    decision: "ACCEPTED" | "REJECTED" | "DUPLICATE";
    code: SignalReasonCode;
    message: string;
    signatureStatus: "valid" | "invalid" | "missing";
    signalId?: string | null;
    action?: string | null;
    market?: string | null;
    notionalUsd?: string | null;
    orderId?: string | null;
    duplicateOfId?: string | null;
  }) =>
    recordSignalEvent({
      userId: tokenRow.userId,
      tokenId: tokenRow.id,
      signalId: input.signalId ?? null,
      source,
      signatureStatus: input.signatureStatus,
      decision: input.decision,
      reasonCode: input.code,
      reasonMessage: input.message,
      action: input.action ?? null,
      market: input.market ?? null,
      notionalUsd: input.notionalUsd ?? null,
      bodyHash,
      orderId: input.orderId ?? null,
      duplicateOfId: input.duplicateOfId ?? null,
    });

  if (tokenRow.status !== "ACTIVE") {
    await record({
      decision: "REJECTED",
      code: "TOKEN_REVOKED",
      message: "This signal token has been revoked; nothing was read and nothing was sent.",
      signatureStatus: "missing",
    });
    return json({ error: "This signal token has been revoked.", code: "TOKEN_REVOKED" }, 401);
  }

  let secret: string;
  try {
    secret = openSecret("signal", {
      ciphertext: tokenRow.secretCiphertext,
      iv: tokenRow.secretIv,
      authTag: tokenRow.secretAuthTag,
    });
  } catch {
    logger.error("signal refused: the token's signing secret could not be opened", { source });
    return json(
      {
        error: "The endpoint's signing secret could not be opened, so no signal was read.",
        code: "SIGNAL_UNAVAILABLE",
      },
      503,
    );
  }

  const verification = verifySignal({
    rawBody,
    signature: request.headers.get(SIGNAL_SIGNATURE_HEADER),
    timestamp: request.headers.get(SIGNAL_TIMESTAMP_HEADER),
    secret,
    replayWindowSeconds: tokenRow.replayWindowSeconds,
    now: receivedAt,
  });

  if (!verification.ok) {
    const signatureStatus = verification.code === "SIGNATURE_MISSING" ? "missing" : verification.code === "SIGNATURE_INVALID" ? "invalid" : "valid";
    await record({
      decision: "REJECTED",
      code: verification.code,
      message: verification.message,
      signatureStatus,
    });
    await prisma.signalToken.update({ where: { id: tokenRow.id }, data: { lastUsedAt: receivedAt } }).catch(() => null);
    return json(
      { error: verification.message, code: verification.code, windowSeconds: tokenRow.replayWindowSeconds },
      verification.status,
    );
  }

  await prisma.signalToken.update({ where: { id: tokenRow.id }, data: { lastUsedAt: receivedAt } }).catch(() => null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    await record({
      decision: "REJECTED",
      code: "SIGNAL_INVALID",
      message: "The body was signed correctly but is not valid JSON, so nothing was read.",
      signatureStatus: "valid",
    });
    return json({ error: "The signal body is not valid JSON.", code: "SIGNAL_INVALID" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    await record({
      decision: "REJECTED",
      code: "SIGNAL_INVALID",
      message: "The signal body must be a JSON object.",
      signatureStatus: "valid",
    });
    return json({ error: "The signal body must be a JSON object.", code: "SIGNAL_INVALID" }, 400);
  }
  const body = parsed as Record<string, unknown>;
  const unsupported = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unsupported.length > 0) {
    await record({
      decision: "REJECTED",
      code: "SIGNAL_INVALID",
      message: `The signal carried unsupported field(s): ${unsupported.join(", ")}.`,
      signatureStatus: "valid",
    });
    return json(
      { error: `Unsupported field(s): ${unsupported.join(", ")}.`, code: "SIGNAL_INVALID" },
      400,
    );
  }
  const signalId = typeof body.signalId === "string" ? body.signalId.trim() : "";
  if (!SIGNAL_ID_PATTERN.test(signalId)) {
    const message = "signalId is required: 1–128 characters of letters, digits, . _ : or -.";
    await record({
      decision: "REJECTED",
      code: "SIGNAL_INVALID",
      message,
      signatureStatus: "valid",
    });
    return json({ error: message, code: "SIGNAL_INVALID", bound: "signalId" }, 400);
  }
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : body.action;
  const market = typeof body.market === "string" ? body.market.trim().toUpperCase() : body.market;
  const notionalText = typeof body.sizeUsd === "number" || typeof body.sizeUsd === "string" ? String(body.sizeUsd) : null;

  // ---- The claim: one signal id, one action. -------------------------------------------
  const claim = await claimSignalAttempt({
    userId: tokenRow.userId,
    tokenId: tokenRow.id,
    signalId,
    source,
    signatureStatus: "valid",
    action: typeof action === "string" ? action : null,
    market: typeof market === "string" ? market : null,
    notionalUsd: notionalText,
    bodyHash,
  }).catch((error: unknown) => {
    logger.error("signal could not be claimed", { error, source });
    return null;
  });

  if (!claim) {
    return json({ error: "The signal could not be recorded, so nothing was sent.", code: "SIGNAL_UNAVAILABLE" }, 503);
  }
  if (!claim.claimed) {
    const message = `Signal ${signalId} was already received at ${claim.original.receivedAt.toISOString()}; a signal id is acted on once.`;
    const duplicate = await record({
      decision: "DUPLICATE",
      code: "SIGNAL_DUPLICATE",
      message,
      signatureStatus: "valid",
      signalId,
      action: typeof action === "string" ? action : null,
      market: typeof market === "string" ? market : null,
      notionalUsd: notionalText,
      duplicateOfId: claim.original.id,
    });
    logger.info("signal refused as a duplicate", { source, signalId, originalEventId: claim.original.id });
    return json(
      {
        error: message,
        code: "SIGNAL_DUPLICATE",
        duplicate: true,
        eventId: duplicate.id,
        originalEventId: claim.original.id,
        originalReceivedAt: claim.original.receivedAt.toISOString(),
      },
      409,
    );
  }

  const refuse = async (code: SignalReasonCode, message: string, status: number, bound?: string) => {
    await resolveSignalAttempt(claim.id, {
      decision: "REJECTED",
      reasonCode: code,
      reasonMessage: message,
      notionalUsd: notionalText,
    }).catch(() => null);
    await publishWebhookEvent({
      userId: tokenRow.userId,
      eventType: "strategy.decision",
      payload: {
        signalId,
        action: typeof action === "string" ? action : null,
        market: typeof market === "string" ? market : null,
        accepted: false,
        code,
        reason: message,
        orderId: null,
      },
    }).catch(() => null);
    return json({ error: message, code, ...(bound ? { bound } : {}), eventId: claim.id, accepted: false }, status);
  };

  try {
    const activation = await prisma.strategyActivation
      .findUnique({ where: { userId: tokenRow.userId }, select: { id: true, status: true, strategyId: true } })
      .catch(() => null);
    const requestedStrategyId = typeof body.strategyId === "string" ? body.strategyId.trim() : null;
    if (requestedStrategyId && activation?.strategyId && requestedStrategyId !== activation.strategyId) {
      return await refuse(
        "STRATEGY_NOT_FOUND",
        `The signal named strategy ${requestedStrategyId}, but this account's activation is for ${activation.strategyId}.`,
        422,
        "strategyId",
      );
    }
    const strategyId = activation?.strategyId ?? requestedStrategyId;
    const strategy = await resolveSignalStrategy(strategyId, tokenRow.userId);
    const running = activation?.status === "RUNNING" && Boolean(strategy);

    const [policy, price, positionView, routing] = await Promise.all([
      getRiskPolicySettings().catch(() => null),
      typeof market === "string" ? readSignalPrice(market) : Promise.resolve(null),
      typeof market === "string" ? strategyRunnerStore().position(tokenRow.userId, market).catch(() => null) : Promise.resolve(null),
      orderVenueSummary()
        .then((summary) => summary.environment)
        .catch(() => "paper" as const),
    ]);
    if (!policy) {
      return await refuse(
        "RISK_LIMIT_REACHED",
        "The owner's risk policy could not be read, so the signal was refused rather than sent unchecked.",
        503,
      );
    }
    const strategySwitchActive = activation
      ? await readStrategyKillSwitch(activation.id).then((state) => state?.active === true).catch(() => true)
      : true;
    // The measured open notional is the risk policy's own figure, so the signal's budget and
    // strategy-cap checks use it too rather than a second, differently-rounded opinion.
    const usage = typeof market === "string"
      ? await readRiskUsageFacts(tokenRow.userId, { policy, market, now: receivedAt }).catch(() => null)
      : null;

    const priceText = price ?? "0";
    const positionQuantity = positionView ? new Decimal(positionView.quantity) : null;
    const positionNotional = positionQuantity && new Decimal(priceText).gt(0)
      ? positionQuantity.mul(new Decimal(priceText)).toFixed(2)
      : "0";
    const bounds: SignalBounds = {
      strategy: strategy
        ? {
            id: strategy.id,
            label: strategy.label,
            market: strategy.market,
            budgetUsd: strategy.budgetUsd,
            stopLossPercent: strategy.stopLossPercent,
          }
        : null,
      strategyRunning: running,
      position: positionQuantity && positionQuantity.gt(0) ? { quantity: positionQuantity.toFixed(8), notionalUsd: positionNotional } : null,
      strategyOpenNotionalUsd: usage?.strategyOpenNotionalUsd ?? positionNotional,
      price: priceText,
      policy: {
        approvedSymbols: policy.approvedSymbols,
        maxOrderNotionalUsd: policy.maxOrderNotionalUsd,
        maxStrategyNotionalUsd: policy.maxStrategyNotionalUsd,
        killSwitchActive: policy.killSwitchActive,
      },
    };

    const mapping = mapSignal({ action, market, sizeUsd: body.sizeUsd }, bounds);
    if (!mapping.ok) {
      return await refuse(mapping.code, mapping.message, mapping.status, mapping.bound);
    }
    if (!strategy || !bounds.strategy) {
      return await refuse("STRATEGY_NOT_FOUND", "The signal does not name a strategy this account owns.", 422, "strategyId");
    }
    if (strategySwitchActive) {
      return await refuse(
        "KILL_SWITCH_ENGAGED",
        `${strategy.label}'s own kill switch is engaged, so the signal was recorded and refused.`,
        422,
        "activation.killSwitch",
      );
    }

    const tradesToday = await strategyRunnerStore().tradesToday(tokenRow.userId, receivedAt.getTime()).catch(() => 0);
    const riskInput = signalRiskInput({
      mapping: mapping.intent,
      bounds: { ...bounds, strategy: bounds.strategy },
      facts: {
        routing,
        venueId: routing === "paper" ? "dev-paper" : routing === "testnet" ? "binance-testnet" : "binance",
        tradesToday,
        openPositions: usage?.openPositions ?? 0,
        tradesInInterval: usage?.tradesInInterval ?? 0,
        cooldownRemainingMinutes: usage?.cooldownRemainingMinutes ?? 0,
        killSwitchActive: policy.killSwitchActive,
        strategyKillSwitchActive: strategySwitchActive,
      },
    });
    const riskDecision = evaluateRiskOrder(riskInput, policy);
    if (riskDecision.decision === "REFUSE") {
      const limits = Array.isArray(riskDecision.limits) ? riskDecision.limits : [];
      const message = limits.length > 0 ? describeLimitRefusal({ ...riskDecision, limits }) : describeRiskRefusal(riskDecision.reasons);
      return await refuse("RISK_LIMIT_REACHED", message, 422, limits[0]?.limit ?? "policy");
    }

    const venueId = riskInput.venueId ?? "dev-paper";
    const outcome = await submitOrder({
      intent: {
        userId: tokenRow.userId,
        venue: venueId,
        market: bounds.strategy.market,
        side: mapping.intent.side,
        orderType: "MARKET",
        quantity: mapping.intent.quantity,
        limitPrice: null,
        stopLossPrice: mapping.intent.stopLossPrice,
        notionalUsdCents: mapping.intent.notionalUsdCents,
        verifiedBalanceCents: mapping.intent.notionalUsdCents,
        clientKey: `signal.${tokenRow.id}.${signalId}`,
      },
      actorUserId: tokenRow.userId,
      origin: "strategy",
      sourceNote: `${ORDER_NOTE_PREFIX.signal}${signalId} from ${source}: ${mapping.intent.narrative}`,
    });

    const orderId = "order" in outcome && outcome.order ? outcome.order.id : null;
    const accepted = outcome.kind === "submitted" || outcome.kind === "replayed" || outcome.kind === "in-flight";
    const reasonCode: SignalReasonCode = accepted
      ? "SIGNAL_ACCEPTED"
      : outcome.kind === "failed" || outcome.kind === "unresolved"
        ? "ORDER_FAILED"
        : "ORDER_REFUSED";
    const message = accepted
      ? `${mapping.intent.narrative} The order path answered "${outcome.kind}"${orderId ? ` with order ${orderId}` : ""}.`
      : "reason" in outcome
        ? outcome.reason.message
        : "The order path refused the signal.";

    await resolveSignalAttempt(claim.id, {
      decision: accepted ? "ACCEPTED" : "REJECTED",
      reasonCode,
      reasonMessage: message,
      notionalUsd: mapping.intent.notionalUsd,
      orderId,
    });

    await publishWebhookEvent({
      userId: tokenRow.userId,
      eventType: "strategy.decision",
      payload: {
        signalId,
        action,
        market: bounds.strategy.market,
        accepted,
        code: reasonCode,
        reason: message,
        notionalUsd: mapping.intent.notionalUsd,
        orderId,
      },
    }).catch(() => null);
    if (accepted) {
      await publishWebhookEvent({
        userId: tokenRow.userId,
        eventType: "trade.placed",
        payload: {
          signalId,
          orderId,
          market: bounds.strategy.market,
          side: mapping.intent.side,
          quantity: mapping.intent.quantity,
          notionalUsd: mapping.intent.notionalUsd,
          routing,
        },
      }).catch(() => null);
    }

    const status = accepted ? (outcome.kind === "in-flight" ? 202 : 200) : outcome.kind === "unresolved" ? 503 : 422;
    return json(
      {
        accepted,
        code: reasonCode,
        eventId: claim.id,
        orderId,
        decision: mapping.intent.narrative,
        routing,
      },
      status,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The signal failed before it could be resolved.";
    await resolveSignalAttempt(claim.id, {
      decision: "REJECTED",
      reasonCode: "ORDER_FAILED",
      reasonMessage: message,
      notionalUsd: notionalText,
    }).catch(() => null);
    logger.error("signal failed", { error, source, signalId });
    return json({ error: "The signal was recorded as failed before an order could be placed.", code: "ORDER_FAILED", eventId: claim.id }, 500);
  }
}
