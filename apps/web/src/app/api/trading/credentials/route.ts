import { NextRequest } from "next/server";
import { getAuthConfig, getAuthUnavailableReason, isSameOriginRequest } from "@/lib/auth/config";
import { AuthenticationRequiredError, requireUser } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { encryptVenueCredentials, type TradingVenue } from "@/lib/trading/credential-vault";

const MAX_BODY_BYTES = 16_384;
const VENUES = new Set<TradingVenue>(["binance", "coinbase-advanced", "kraken", "wundertrading"]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError) return json({ error: "Authentication required." }, 401);
  return null;
}

async function readJson(request: NextRequest): Promise<{ body: unknown } | { response: Response }> {
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
    return { response: json({ error: "Invalid JSON body." }, 400) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET() {
  try {
    const user = await requireUser();
    const credentials = await prisma.tradingVenueCredential.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        venue: true,
        label: true,
        verifiedAt: true,
        createdAt: true,
      },
    });
    return json({ credentials });
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Credential directory is unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body) || typeof body.venue !== "string" || !VENUES.has(body.venue as TradingVenue)) {
    return json({ error: "A supported spot venue is required." }, 400);
  }
  if (
    typeof body.apiKey !== "string" ||
    typeof body.apiSecret !== "string" ||
    (body.passphrase !== undefined && typeof body.passphrase !== "string")
  ) {
    return json({ error: "Venue credentials are incomplete." }, 400);
  }
  const venue = body.venue as TradingVenue;
  const label = typeof body.label === "string" ? body.label.trim() : venue;
  if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) {
    return json({ error: "Credential label must be 1–64 printable characters." }, 400);
  }

  try {
    const encrypted = encryptVenueCredentials(venue, {
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
      ...(typeof body.passphrase === "string" ? { passphrase: body.passphrase } : {}),
    });
    const credential = await prisma.$transaction(async (transaction) => {
      const saved = await transaction.tradingVenueCredential.create({
        data: {
          userId: user.id,
          venue,
          label,
          credentialCiphertext: encrypted.ciphertext,
          credentialIv: encrypted.iv,
          credentialAuthTag: encrypted.authTag,
          fingerprint: encrypted.fingerprint,
        },
        select: {
          id: true,
          venue: true,
          label: true,
          createdAt: true,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: "TRADING_CREDENTIAL_ADDED",
          objectType: "TradingVenueCredential",
          objectId: saved.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ venue, label }),
        },
      });
      return saved;
    });
    return json({ credential }, 201);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return json({ error: "This venue key is already connected to your account." }, 409);
    }
    return json({ error: "Encrypted credential storage is unavailable." }, 503);
  }
}

export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return json({ error: getAuthUnavailableReason() ?? "Authentication is unavailable." }, 503);
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const parsed = await readJson(request);
  if ("response" in parsed) return parsed.response;
  if (!isRecord(parsed.body) || typeof parsed.body.credentialId !== "string" || !parsed.body.credentialId.trim()) {
    return json({ error: "A credential ID is required." }, 400);
  }
  const credentialId = parsed.body.credentialId;

  try {
    const revoked = await prisma.$transaction(async (transaction) => {
      const result = await transaction.tradingVenueCredential.updateMany({
        where: { id: credentialId, userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) return false;
      await transaction.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: "TRADING_CREDENTIAL_REVOKED",
          objectType: "TradingVenueCredential",
          objectId: credentialId,
          outcome: "SUCCESS",
          redactedJson: "{}",
        },
      });
      return true;
    });
    return revoked ? json({ revoked: true }) : json({ error: "Credential was not found." }, 404);
  } catch {
    return json({ error: "Credential revocation could not be audited." }, 503);
  }
}