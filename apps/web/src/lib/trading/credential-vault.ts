import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Every venue a key can be stored for, including the one that moves no money.
 *
 * `binance-testnet` is here because a testnet key is a key like any other: it is
 * encrypted with the same AAD (which names the venue, so testnet material cannot be
 * decrypted as live material), stored in the same table, and revoked the same way. A
 * separate `TradingVenue` union for sandboxes would be a second place to keep in step
 * with `VENUE_IDS` in `src/lib/venues/types.ts`.
 */
export type TradingVenue = "binance" | "coinbase-advanced" | "kraken" | "wundertrading" | "binance-testnet";

/**
 * A venue key, decrypted — including the owner's own statement about its scope.
 *
 * `readOnly` is part of the material rather than only a column because it is a claim
 * about *this key*, and a claim of that kind belongs inside the authenticated
 * ciphertext: tampering with the stored bytes cannot turn a read-only key into a
 * trade-capable one without breaking the authentication tag. The column on
 * `TradingVenueCredential` is the queryable mirror of the same claim, so a listing or
 * an order refusal reads it without decrypting anything.
 *
 * It is always present on the way *out* — a credential stored before the flag existed
 * decrypts as `false`, which is what every key connected before this phase meant —
 * and optional on the way *in*, so a caller states it only when it is true.
 */
export type VenueCredentialMaterial = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  readOnly: boolean;
};

/** What a caller hands in to be encrypted: `readOnly` is stated only when it is true. */
export type VenueCredentialInput = Omit<VenueCredentialMaterial, "readOnly"> & { readOnly?: boolean };

export type EncryptedVenueCredentials = {
  ciphertext: string;
  iv: string;
  authTag: string;
  fingerprint: string;
};

const MAX_CREDENTIAL_FIELD_LENGTH = 4_096;

function encryptionKey(): Buffer {
  const value = process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("TRADING_CREDENTIAL_ENCRYPTION_KEY must be configured as 32 bytes of hex.");
  }
  return Buffer.from(value, "hex");
}

function validateMaterial(value: unknown): VenueCredentialMaterial {
  if (typeof value !== "object" || value === null) throw new Error("Invalid venue credentials.");
  const material = value as Record<string, unknown>;
  if (
    typeof material.apiKey !== "string" ||
    typeof material.apiSecret !== "string" ||
    !material.apiKey.trim() ||
    !material.apiSecret.trim() ||
    material.apiKey.length > MAX_CREDENTIAL_FIELD_LENGTH ||
    material.apiSecret.length > MAX_CREDENTIAL_FIELD_LENGTH ||
    (material.passphrase !== undefined &&
      (typeof material.passphrase !== "string" || material.passphrase.length > MAX_CREDENTIAL_FIELD_LENGTH)) ||
    // A scope that is not a boolean is refused rather than coerced: `"false"` is
    // truthy in a hundred ways to get this wrong, and a key's scope is not a value
    // to be generous about.
    (material.readOnly !== undefined && typeof material.readOnly !== "boolean")
  ) {
    throw new Error("Invalid venue credentials.");
  }
  return {
    apiKey: material.apiKey,
    apiSecret: material.apiSecret,
    ...(typeof material.passphrase === "string" ? { passphrase: material.passphrase } : {}),
    readOnly: material.readOnly === true,
  };
}

export function encryptVenueCredentials(
  venue: TradingVenue,
  input: VenueCredentialInput,
): EncryptedVenueCredentials {
  const key = encryptionKey();
  const material = validateMaterial(input);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`veylora:venue-credential:v1:${venue}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(material), "utf8"),
    cipher.final(),
  ]);
  const fingerprint = createHmac("sha256", key)
    .update(`${venue}\0${material.apiKey}`, "utf8")
    .digest("hex");

  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    fingerprint,
  };
}

export function decryptVenueCredentials(
  venue: TradingVenue,
  encrypted: EncryptedVenueCredentials,
): VenueCredentialMaterial {
  const key = encryptionKey();
  const iv = Buffer.from(encrypted.iv, "base64url");
  const authTag = Buffer.from(encrypted.authTag, "base64url");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64url");
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length > 16_384) {
    throw new Error("Invalid encrypted credential record.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(`veylora:venue-credential:v1:${venue}`, "utf8"));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return validateMaterial(JSON.parse(plaintext));
}