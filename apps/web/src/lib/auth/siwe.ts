import { SiweMessage } from "siwe";
import { getAddress, recoverMessageAddress, type Hex } from "viem";

export class SiweVerificationError extends Error {
  constructor(message = "SIWE message verification failed") {
    super(message);
    this.name = "SiweVerificationError";
  }
}

export type VerifySiweInput = {
  message: string;
  signature: string;
  expectedNonce: string;
  domain: string;
  uri: string;
  scheme: "http" | "https";
  allowedChainIds: ReadonlySet<number>;
  now?: Date;
};

export async function verifySiweMessage(input: VerifySiweInput) {
  if (input.message.length > 8192 || input.signature.length > 2048) {
    throw new SiweVerificationError("SIWE payload is too large");
  }

  let message: SiweMessage;
  try {
    message = new SiweMessage(input.message);
  } catch {
    throw new SiweVerificationError("SIWE message is malformed");
  }

  if (!input.allowedChainIds.has(message.chainId)) {
    throw new SiweVerificationError("EVM chain is not allowed for authentication");
  }
  if (message.scheme !== input.scheme || message.domain !== input.domain || message.uri !== input.uri) {
    throw new SiweVerificationError("SIWE origin does not match the configured application");
  }
  if (message.nonce !== input.expectedNonce || !message.issuedAt || !message.expirationTime) {
    throw new SiweVerificationError("SIWE nonce or required time bounds are invalid");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) {
    throw new SiweVerificationError("Only 65-byte EVM ECDSA signatures are enabled");
  }

  const now = input.now ?? new Date();
  const issuedAt = Date.parse(message.issuedAt);
  const expirationTime = Date.parse(message.expirationTime);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime() + 30_000 || issuedAt < now.getTime() - 5 * 60_000) {
    throw new SiweVerificationError("SIWE issue time is outside the allowed window");
  }
  if (!Number.isFinite(expirationTime) || expirationTime <= now.getTime() || expirationTime > now.getTime() + 5 * 60_000 + 30_000) {
    throw new SiweVerificationError("SIWE message has expired or exceeds the permitted lifetime");
  }

  let addressDisplay: string;
  try {
    addressDisplay = getAddress(message.address);
  } catch {
    throw new SiweVerificationError("SIWE address is invalid");
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = getAddress(await recoverMessageAddress({ message: message.prepareMessage(), signature: input.signature as Hex }));
  } catch {
    throw new SiweVerificationError();
  }
  if (recoveredAddress.toLowerCase() !== addressDisplay.toLowerCase()) throw new SiweVerificationError();

  return {
    addressCanonical: addressDisplay.toLowerCase(),
    addressDisplay,
    chainId: message.chainId,
  };
}