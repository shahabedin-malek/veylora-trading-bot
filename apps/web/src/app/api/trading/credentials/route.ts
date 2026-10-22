import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { assertScopeVerified } from "@/lib/auth/step-up";
import { prisma } from "@/lib/db";
import { isDevelopmentMode } from "@/lib/dev-mode/mode";
import { readBotCapacity } from "@/lib/bot-builder/repository";
import { encryptVenueCredentials, type TradingVenue } from "@/lib/trading/credential-vault";
import {
  connectionHealth,
  isVenueId,
  parsePermissions,
  VENUE_DESCRIPTORS,
  VENUE_IDS,
  validateRequestedPermissions,
} from "@/lib/venues/types";
import { auditCreate } from "@/lib/audit/record";

const MAX_BODY_BYTES = 16_384;
// Derived from the vocabulary rather than restated, so a venue added to the table above
// (phase 21's testnet) is accepted by the save path without a second list to edit.
const VENUES = new Set<TradingVenue>(VENUE_IDS as readonly TradingVenue[]);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function authErrorResponse(error: unknown) {
  const refusal = getAccessRefusal(error);
  return refusal
    ? json(
        { error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}), ...(refusal.scope ? { scope: refusal.scope } : {}) },
        refusal.status,
      )
    : null;
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

/**
 * The tier's venue-connection cap, as a refusal sentence or null.
 *
 * Phase 30 moved the cap read into the bot-builder's capacity service, so this path and the
 * create/clone path answer with the same sentence — the cap, the tier and the current
 * usage — instead of two paraphrases of the same limit. The number itself is still the
 * default tier's from the fee table `/pricing` renders. A table that cannot be read does
 * not block a connection: this is a plan limit, not a security control, and refusing a key
 * because a price list is down would be the wrong failure.
 */
async function venueCapacityRefusal(userId: string): Promise<string | null> {
  try {
    const capacity = await readBotCapacity(userId, "venue connections");
    return capacity.allowed ? null : capacity.message;
  } catch {
    return null;
  }
}

/**
 * One shape for a credential, wherever one is returned.
 *
 * A saved key and a listed key are the same object to the client, and the panel proves
 * why that matters: it inserts the credential a save returns straight into the list it
 * renders, so a save response missing `capabilities` crashed the page the first time
 * the phase-20 click-path pressed the button. Sharing the projection is the fix, and
 * it is the reason this is a function rather than two literals that happen to agree.
 */
type CredentialRow = {
  id: string;
  venue: string;
  label: string;
  readOnly: boolean;
  requestedPermissions: string;
  reportedPermissions: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckLatencyMs: number | null;
  lastCheckError: string | null;
  createdAt: Date;
  fingerprint?: string;
};

function credentialView(row: CredentialRow, options: { showFingerprint: boolean }) {
  const { fingerprint, createdAt, verifiedAt, ...rest } = row;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    verifiedAt: verifiedAt ? verifiedAt.toISOString() : null,
    // What this connection can be asked to do, from the descriptor the server enforces
    // against — the panel does not keep its own copy of the list.
    capabilities: isVenueId(row.venue) ? VENUE_DESCRIPTORS[row.venue].capabilities : [],
    permissionReport: isVenueId(row.venue) ? VENUE_DESCRIPTORS[row.venue].permissionReport : "none",
    requestedPermissions: parsePermissions(row.requestedPermissions),
    // Null is "the venue was not asked or does not report", which is not the same
    // answer as an empty list, and the panel says so in words.
    reportedPermissions: row.reportedPermissions === null ? null : parsePermissions(row.reportedPermissions),
    health: connectionHealth(row),
    ...(options.showFingerprint && fingerprint ? { fingerprintLastFour: fingerprint.slice(-4) } : {}),
  };
}

export async function GET() {
  try {
    const user = await requireUser();
    // Development shows the owner their own key's last four characters so a wrong
    // key is identifiable without re-entering it. The fingerprint is an HMAC, not
    // the key, and it is only ever the last four. Production does not select it.
    const showFingerprint = isDevelopmentMode();
    const credentials = await prisma.tradingVenueCredential.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        venue: true,
        label: true,
        // The scope is part of what a connected account *is*, so the list carries it
        // for every credential: the owner has to be able to see which of their keys
        // can only read before they try to place an order with one.
        readOnly: true,
        // Phase 20: what was asked for, what the venue reported, and how the last
        // check went. All four are statements about the connection rather than key
        // material, so the list answers "is this one usable, and can it trade?"
        // without a second request and without a decryption.
        requestedPermissions: true,
        reportedPermissions: true,
        verifiedAt: true,
        lastCheckedAt: true,
        lastCheckLatencyMs: true,
        lastCheckError: true,
        createdAt: true,
        ...(showFingerprint ? { fingerprint: true } : {}),
      },
    });
    return json({ credentials: credentials.map((row) => credentialView(row, { showFingerprint })) });
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "Credential directory is unavailable." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
    // Saving a venue key is a funding action: this is the credential that can move
    // money at the venue, so it is the one the funding scope guards. Checked before
    // the body is read, so an unpaid code leaves nothing encrypted and nothing
    // stored.
    await assertScopeVerified("funding");
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
    (body.passphrase !== undefined && typeof body.passphrase !== "string") ||
    // State it or leave it out; anything else is refused rather than read as truthy,
    // because a key's scope decides whether it can place an order.
    (body.readOnly !== undefined && typeof body.readOnly !== "boolean")
  ) {
    return json({ error: "Venue credentials are incomplete." }, 400);
  }
  const venue = body.venue as TradingVenue;
  const readOnly = body.readOnly === true;
  // A key that may withdraw is refused here, before anything is encrypted: the
  // platform cannot withdraw from a venue, so storing such a key would be holding a
  // capability the product has no use for. The refusal names withdrawal, because that
  // is the thing the owner has to switch off at the venue.
  const permissions = validateRequestedPermissions(body.permissions, readOnly);
  if (!permissions.valid) {
    return json({ error: permissions.error, code: permissions.code }, 400);
  }
  const label = typeof body.label === "string" ? body.label.trim() : venue;
  if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) {
    return json({ error: "Credential label must be 1–64 printable characters." }, 400);
  }

  const capacity = await venueCapacityRefusal(user.id);
  if (capacity) return json({ error: capacity }, 409);

  try {
    const encrypted = encryptVenueCredentials(venue, {
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
      ...(typeof body.passphrase === "string" ? { passphrase: body.passphrase } : {}),
      readOnly,
    });
    const credential = await prisma.$transaction(async (transaction) => {
      const saved = await transaction.tradingVenueCredential.create({
        data: {
          userId: user.id,
          venue,
          label,
          readOnly,
          requestedPermissions: JSON.stringify(permissions.permissions),
          credentialCiphertext: encrypted.ciphertext,
          credentialIv: encrypted.iv,
          credentialAuthTag: encrypted.authTag,
          fingerprint: encrypted.fingerprint,
        },
        // The same projection the list returns, selected at creation: a brand-new key
        // has no check yet and no venue-reported permissions, and saying so from the
        // start is what keeps the panel from rendering one shape for a save and
        // another for a reload.
        select: {
          id: true,
          venue: true,
          label: true,
          readOnly: true,
          requestedPermissions: true,
          reportedPermissions: true,
          verifiedAt: true,
          lastCheckedAt: true,
          lastCheckLatencyMs: true,
          lastCheckError: true,
          createdAt: true,
          ...(isDevelopmentMode() ? { fingerprint: true } : {}),
        },
      });
      await auditCreate(transaction, {
        data: {
          actorUserId: user.id,
          action: "TRADING_CREDENTIAL_ADDED",
          objectType: "TradingVenueCredential",
          objectId: saved.id,
          outcome: "SUCCESS",
          redactedJson: JSON.stringify({ venue, label, readOnly, requestedPermissions: permissions.permissions }),
        },
      });
      return saved;
    });
    return json({ credential: credentialView(credential, { showFingerprint: isDevelopmentMode() }) }, 201);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return json({ error: "This venue key is already connected to your account." }, 409);
    }
    return json({ error: "Encrypted credential storage is unavailable." }, 503);
  }
}

export async function DELETE(request: NextRequest) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
    // Removing a key is as consequential as saving one, so it is guarded the same
    // way and by the same scope.
    await assertScopeVerified("funding");
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
      await auditCreate(transaction, {
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