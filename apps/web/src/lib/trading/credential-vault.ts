import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type TradingVenue = "binance" | "coinbase-advanced" | "kraken" | "wundertrading";

export type VenueCredentialMaterial = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

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
      (typeof material.passphrase !== "string" || material.passphrase.length > MAX_CREDENTIAL_FIELD_LENGTH))
  ) {
    throw new Error("Invalid venue credentials.");
  }
  return {
    apiKey: material.apiKey,
    apiSecret: material.apiSecret,
    ...(typeof material.passphrase === "string" ? { passphrase: material.passphrase } : {}),
  };
}

export function encryptVenueCredentials(
  venue: TradingVenue,
  input: VenueCredentialMaterial,
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