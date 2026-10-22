import { prisma } from "@/lib/db";

/**
 * A key that may read is not a key that may trade.
 *
 * This is the whole of the refusal, in one place, because it is the sentence the
 * phase's acceptance criteria name: *a read-only key cannot be used to place an
 * order, and the attempt is rejected by name*. The decision is a pure function of the
 * credential's scope, so it can be asserted without a database, an order or a venue —
 * and the route that places an order calls it before anything is validated, reserved
 * or sent, so a refused attempt writes nothing at all.
 *
 * Two refusals live here and they are deliberately different sentences:
 *
 *  - `READ_ONLY_CREDENTIAL` (409) — the key exists, belongs to this account, and is
 *    stored as read-only. The owner can act on this: connect a trading key, or submit
 *    the order without naming one.
 *  - a 404 — the key does not exist, is another account's, or was revoked. Saying
 *    "read-only" about a key the caller cannot see would leak that it exists, so an
 *    unusable reference is reported as absent.
 */

export type CredentialScope = {
  id: string;
  venue: string;
  label: string;
  readOnly: boolean;
};

export const READ_ONLY_CREDENTIAL_CODE = "READ_ONLY_CREDENTIAL";
export const CREDENTIAL_REVOKED_CODE = "CREDENTIAL_REVOKED";

export type CredentialUseDecision =
  | { kind: "allowed"; credential: CredentialScope }
  | { kind: "refused"; status: number; body: { error: string; code?: string } };

/** What a read-only key is for, said the same way wherever it is said. */
export function readOnlyCredentialMessage(credential: Pick<CredentialScope, "venue" | "label">): string {
  return (
    `The ${credential.venue} key "${credential.label}" is stored as read-only, so it cannot be used to place an order. ` +
    "A read-only key is for balances and history: import with it on the account page, or connect a key created for trading."
  );
}

/**
 * Decide whether a credential may be used to place an order.
 *
 * Null means the reference resolved to nothing this account may use, and it is a 404
 * rather than a 403 for the reason above: an unreadable reference is absent, not
 * forbidden.
 */
export function decideCredentialUse(credential: CredentialScope | null): CredentialUseDecision {
  if (!credential) {
    return { kind: "refused", status: 404, body: { error: "That credential was not found on this account." } };
  }
  if (credential.readOnly) {
    return {
      kind: "refused",
      status: 409,
      body: { error: readOnlyCredentialMessage(credential), code: READ_ONLY_CREDENTIAL_CODE },
    };
  }
  return { kind: "allowed", credential };
}

/**
 * Whether a credential row may be used *at all*, whoever is asking (phase 20).
 *
 * Revocation is a decision, not a filter someone remembers to add. A row that is
 * revoked is refused from the one place every credential-using path asks, so "does
 * deleting a key end its use immediately?" is answered by a function rather than by
 * each query's `where` clause — and the answer is asserted without a database.
 *
 * The refusal is a 404 with the same sentence an unknown id gets, for the reason the
 * module's header gives: a revoked key is one the caller may not use, and saying
 * "revoked" about an id that is not theirs would confirm it exists.
 */
export type CredentialAvailability =
  | { available: true }
  | { available: false; status: number; body: { error: string; code?: string } };

export function credentialAvailability(credential: { revokedAt?: Date | null } | null): CredentialAvailability {
  if (!credential) {
    return { available: false, status: 404, body: { error: "That credential was not found on this account." } };
  }
  if (credential.revokedAt) {
    return {
      available: false,
      status: 404,
      body: { error: "That credential was not found on this account.", code: CREDENTIAL_REVOKED_CODE },
    };
  }
  return { available: true };
}

/**
 * The one function here that touches the database: the scope of a credential this
 * account owns and has not revoked. No secret column is selected — a scope decision
 * needs no key material, so none is read.
 */
export async function loadCredentialScope(credentialId: string, userId: string): Promise<CredentialScope | null> {
  const row = await prisma.tradingVenueCredential.findFirst({
    where: { id: credentialId, userId, revokedAt: null },
    select: { id: true, venue: true, label: true, readOnly: true },
  });
  return row ?? null;
}
