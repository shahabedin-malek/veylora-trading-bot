import { NextRequest } from "next/server";
import { authErrorResponse, botJson, readJsonBody, requireBotWrite } from "@/lib/bot-builder/api";
import { requireUser } from "@/lib/auth/session-store";
import {
  listSignalEvents,
  listSignalTokens,
  revokeSignalToken,
  setSignalReplayWindow,
} from "@/lib/signals/log";
import {
  generateSignalToken,
  normalizeReplayWindowSeconds,
  sealSecret,
} from "@/lib/signals/verify";
import { prisma } from "@/lib/db";

/**
 * Signal credentials and their log (phase 31).
 *
 * `GET` is what the settings panel reads: every token as its masked prefix, the effective
 * replay window and the most recent attempts. Nothing here can return a secret — the token is
 * stored as a hash and the signing secret as ciphertext selected by no query in this file.
 *
 * `POST` creates a token and is the only response in the app that carries the credential: the
 * token and its secret are returned once, to be copied into the alert provider, and are never
 * retrievable again. Losing the secret means creating a new token, which is the intended cost.
 *
 * `PATCH` changes the replay window (the phase's configurable bound) or revokes a token.
 * Revoking leaves the log intact: a refused signal still names the token's masked prefix.
 */

const MAX_TOKENS = 10;

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? botJson({ error: "Signal settings are unavailable." }, 503);
  }
  try {
    const [tokens, events] = await Promise.all([listSignalTokens(user.id), listSignalEvents(user.id, 50)]);
    return botJson({
      tokens,
      events,
      /** The path a token is appended to; the full URL is built in the browser. */
      endpointPath: "/api/signals/",
      actions: ["enter", "exit", "adjust"],
      note:
        "The signing secret is shown once at creation. A signal is signed over `<timestamp>.<raw body>` with HMAC-SHA256 and sent with X-Signal-Timestamp and X-Signal-Signature headers.",
    });
  } catch {
    return botJson({ error: "Signal settings could not be read." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;
  const parsed = await readJsonBody(request);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return botJson({ error: "A token configuration is required." }, 400);
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["label", "replayWindowSeconds"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return botJson({ error: "Unsupported field(s) in the token request." }, 400);
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || label.length > 80) {
    return botJson({ error: "Give the token a label of 1–80 characters so the log is readable." }, 400);
  }

  const existing = await prisma.signalToken.count({ where: { userId: session.userId, status: "ACTIVE" } });
  if (existing >= MAX_TOKENS) {
    return botJson(
      {
        error: `This account already has ${existing} of ${MAX_TOKENS} active signal tokens, the cap this build allows. Revoke one to add another.`,
        code: "TOKEN_CAP_REACHED",
      },
      409,
    );
  }

  const generated = generateSignalToken();
  const sealed = sealSecret("signal", generated.secret);
  const replayWindowSeconds = normalizeReplayWindowSeconds(record.replayWindowSeconds);
  try {
    const token = await prisma.signalToken.create({
      data: {
        userId: session.userId,
        label,
        tokenPrefix: generated.tokenPrefix,
        tokenHash: generated.tokenHash,
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretAuthTag: sealed.authTag,
        replayWindowSeconds,
      },
      select: { id: true, label: true, tokenPrefix: true, replayWindowSeconds: true, createdAt: true },
    });
    return botJson(
      {
        token: {
          id: token.id,
          label: token.label,
          tokenPrefix: token.tokenPrefix,
          replayWindowSeconds: token.replayWindowSeconds,
          createdAt: token.createdAt.toISOString(),
          status: "ACTIVE",
          lastUsedAt: null,
        },
        /** Shown once. Never stored in a readable form and never returned again. */
        credential: {
          token: generated.token,
          secret: generated.secret,
          note: "Copy both now. The secret is not stored in a readable form and cannot be shown again.",
        },
      },
      201,
    );
  } catch {
    return botJson({ error: "The signal token could not be created." }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  const session = await requireBotWrite(request);
  if ("response" in session) return session.response;
  const parsed = await readJsonBody(request);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return botJson({ error: "A token change is required." }, 400);
  }
  const record = body as Record<string, unknown>;
  const tokenId = typeof record.tokenId === "string" ? record.tokenId.trim() : "";
  if (!tokenId) return botJson({ error: "tokenId is required." }, 400);

  try {
    if (record.status === "REVOKED") {
      const revoked = await revokeSignalToken(session.userId, tokenId);
      if (!revoked) return botJson({ error: "That active token was not found for this account." }, 404);
      return botJson({ revoked: true });
    }
    if (record.replayWindowSeconds !== undefined) {
      const stored = await setSignalReplayWindow(session.userId, tokenId, record.replayWindowSeconds);
      if (stored === null) return botJson({ error: "That active token was not found for this account." }, 404);
      return botJson({ replayWindowSeconds: stored });
    }
    return botJson({ error: "Send replayWindowSeconds or status REVOKED." }, 400);
  } catch {
    return botJson({ error: "The token could not be changed." }, 503);
  }
}
