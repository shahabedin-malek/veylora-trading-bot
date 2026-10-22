import { NextRequest } from "next/server";
import { getAuthConfig, isSameOriginRequest } from "@/lib/auth/config";
import { getAccessRefusal, authenticationGapResponse } from "@/lib/auth/access-gate";
import { requireUser } from "@/lib/auth/session-store";
import { assertScopeVerified } from "@/lib/auth/step-up";
import { prisma } from "@/lib/db";
import { credentialAvailability } from "@/lib/trading/read-only-credentials";
import { decryptVenueCredentials } from "@/lib/trading/credential-vault";
import { createVenue, venueAccessRefusal } from "@/lib/venues/registry";
import { isVenueId, VENUE_CUSTODY_STATEMENT, verificationRecord } from "@/lib/venues/types";

/**
 * The connection check: one real read at the venue, recorded either way.
 *
 * Phase 20 replaced the venue-by-venue branches this route used to carry with a single
 * call into the registry, so the route asks "may this venue be used?" and "did it
 * answer?" and never learns which venue it is asking about. What it keeps is the part
 * that was already right: a check is a *read* (it never places, cancels or withdraws
 * anything), and its result is written to the credential rather than only returned, so
 * a failure the owner is not looking at is still on the row the next time they open
 * the page.
 *
 * A failed check is answered `200` with `health.ok: false`, not an error status. The
 * check itself succeeded — it successfully discovered that the key does not work — and
 * the panel needs the venue's own sentence to show. Only a configuration problem
 * (unknown venue, switched-off venue, unreadable ciphertext) is an error response.
 */
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ credentialId: string }> },
) {
  const config = getAuthConfig();
  if (!config) return authenticationGapResponse();
  if (!isSameOriginRequest(request, config)) return json({ error: "Request origin is not allowed." }, 403);

  let user;
  try {
    user = await requireUser();
    // Reading a venue's balances with a stored key is how a key's reach is proved,
    // so it sits behind the funding scope with the key itself.
    await assertScopeVerified("funding");
  } catch (error) {
    return authErrorResponse(error) ?? json({ error: "User authorization is unavailable." }, 503);
  }

  const { credentialId } = await params;
  // No `revokedAt: null` in the filter: revocation is decided by
  // `credentialAvailability` below, which is the one place every credential-using path
  // asks, so a revoked key cannot be used here even if this query were edited later.
  const credential = await prisma.tradingVenueCredential.findFirst({
    where: { id: credentialId, userId: user.id },
    select: {
      id: true,
      venue: true,
      readOnly: true,
      verifiedAt: true,
      revokedAt: true,
      credentialCiphertext: true,
      credentialIv: true,
      credentialAuthTag: true,
    },
  });
  if (!credential) return json({ error: "That credential was not found on this account." }, 404);
  // The revoked case goes through the same function the rest of the credential paths
  // ask, so "deleting a key ends its use" is one decision rather than a `where` clause
  // each route has to remember.
  const availability = credentialAvailability(credential);
  if (!availability.available) return json(availability.body, availability.status);
  if (!isVenueId(credential.venue)) {
    return json({ error: "Credential venue is unsupported." }, 400);
  }

  const access = await venueAccessRefusal(credential.venue);
  if (access) return json({ error: access.error }, access.status);

  let material;
  try {
    material = decryptVenueCredentials(credential.venue, {
      ciphertext: credential.credentialCiphertext,
      iv: credential.credentialIv,
      authTag: credential.credentialAuthTag,
      fingerprint: "",
    });
  } catch {
    return json({ error: "The stored key could not be read. Connect the venue again to replace it." }, 503);
  }

  const venue = createVenue(credential.venue, material);
  const health = await venue.checkHealth();
  const record = verificationRecord(health);

  try {
    await prisma.tradingVenueCredential.update({ where: { id: credential.id }, data: record });
  } catch {
    return json({ error: "The check ran but its result could not be recorded." }, 503);
  }

  return json({
    health,
    note: `${health.evidence} Nothing was placed, cancelled or withdrawn. ${VENUE_CUSTODY_STATEMENT}`,
  });
}
