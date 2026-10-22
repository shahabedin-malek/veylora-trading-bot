import { SiweMessage } from "siwe";
import { hashMessage, recoverMessageAddress, type Hex } from "viem";
import {
  describeContractVerificationFailure,
  isRetryableUnverifiableReason,
  type ContractAccountVerifier,
  type AccountType,
} from "@/lib/auth/contract-account";
import { normalizeWalletAddress } from "@/lib/auth/wallet-address";

export class SiweVerificationError extends Error {
  /**
   * Why the message was refused, as a stable name. The routes return it beside
   * the sentence and the login page branches on it, because "you signed with the
   * wrong chain" and "your contract wallet's signature could not be checked" are
   * recovered from differently.
   */
  readonly code: SiweVerificationCode;
  /** Whether the same request could succeed on another attempt. */
  readonly retryable: boolean;

  constructor(code: SiweVerificationCode, message: string, retryable = false) {
    super(message);
    this.name = "SiweVerificationError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Every refusal this module can produce.
 *
 * The last four are the contract-wallet family, and they exist because a
 * signature that has not been *judged* must never be reported as one that was
 * judged and refused, nor as one that was accepted: an unreachable node, a
 * chain with no endpoint, an endpoint answering for the wrong chain and an
 * address with no contract are four different facts about the world.
 */
export type SiweVerificationCode =
  | "PAYLOAD_TOO_LARGE"
  | "MALFORMED_MESSAGE"
  | "CHAIN_NOT_ALLOWED"
  | "ORIGIN_MISMATCH"
  | "NONCE_OR_TIME_INVALID"
  | "ISSUED_AT_OUT_OF_WINDOW"
  | "MESSAGE_EXPIRED"
  | "INVALID_ADDRESS"
  | "SIGNATURE_FORMAT"
  | "SIGNATURE_INVALID"
  | "CONTRACT_SIGNATURE_INVALID"
  | "CONTRACT_ACCOUNT_NOT_DEPLOYED"
  | "CONTRACT_VERIFICATION_UNAVAILABLE"
  | "CONTRACT_CHAIN_MISMATCH";

/**
 * The HTTP status a refusal deserves.
 *
 * Nothing here is ever a success. A refusal the server *decided* is 401, and
 * only the checks it could not *complete* leave that range: an unreachable
 * contract check is a dependency problem, so it is 502 rather than a decision,
 * and an endpoint answering for the wrong chain is 503 — this deployment is
 * misconfigured, and no signature of the user's would have been accepted.
 */
export function statusForSiweVerificationCode(code: SiweVerificationCode): number {
  if (code === "CONTRACT_VERIFICATION_UNAVAILABLE") return 502;
  if (code === "CONTRACT_ACCOUNT_NOT_DEPLOYED" || code === "CONTRACT_CHAIN_MISMATCH") return 503;
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  return 401;
}

/** The EIP-191 hash a wallet signs with `personal_sign` for this message. */
export function siweMessageHash(message: string): Hex {
  return hashMessage(message);
}

/** Whether the bytes are the fixed-size ECDSA signature `ecrecover` can read. */
function isEcdsaSignature(signature: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(signature);
}

/** A hex string of the shapes a contract wallet may produce, at any length. */
function isHexSignature(signature: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(signature);
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
  /**
   * How a signature no EOA produced is checked. Omitted, this module verifies
   * key-based accounts only — and a signature it cannot recover is refused,
   * never passed on. Supplying it is what turns on contract-wallet sign-in; it
   * is handed the chain the message names, so the check happens there and
   * nowhere else.
   */
  contractVerifier?: ContractAccountVerifier;
};

export type VerifiedSiweMessage = {
  addressCanonical: string;
  addressDisplay: string;
  chainId: number;
  /** How the signature was proved. Stored on the identity and shown to admins. */
  accountType: AccountType;
};

export async function verifySiweMessage(input: VerifySiweInput): Promise<VerifiedSiweMessage> {
  if (input.message.length > 8192 || input.signature.length > 2048) {
    throw new SiweVerificationError("PAYLOAD_TOO_LARGE", "SIWE payload is too large");
  }

  let message: SiweMessage;
  try {
    message = new SiweMessage(input.message);
  } catch {
    throw new SiweVerificationError("MALFORMED_MESSAGE", "SIWE message is malformed");
  }

  // The chain is bound into the signed message and checked here, against the
  // chains this deployment accepts. It is also the chain every later step uses —
  // the nonce it was issued under and, for a contract wallet, the RPC the
  // verification call is made through — so a message signed for another chain
  // cannot be replayed against this one.
  if (!input.allowedChainIds.has(message.chainId)) {
    throw new SiweVerificationError(
      "CHAIN_NOT_ALLOWED",
      `This message is bound to chain ${message.chainId}, which this deployment does not accept for sign-in. Nothing was signed in.`,
    );
  }
  if (message.scheme !== input.scheme || message.domain !== input.domain || message.uri !== input.uri) {
    throw new SiweVerificationError("ORIGIN_MISMATCH", "SIWE origin does not match the configured application");
  }
  if (message.nonce !== input.expectedNonce || !message.issuedAt || !message.expirationTime) {
    throw new SiweVerificationError("NONCE_OR_TIME_INVALID", "SIWE nonce or required time bounds are invalid");
  }
  if (!isHexSignature(input.signature)) {
    throw new SiweVerificationError(
      "SIGNATURE_FORMAT",
      "The signature is not a hex string a wallet could have produced, so it was not verified.",
    );
  }

  const now = input.now ?? new Date();
  const issuedAt = Date.parse(message.issuedAt);
  const expirationTime = Date.parse(message.expirationTime);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime() + 30_000 || issuedAt < now.getTime() - 5 * 60_000) {
    throw new SiweVerificationError("ISSUED_AT_OUT_OF_WINDOW", "SIWE issue time is outside the allowed window");
  }
  if (!Number.isFinite(expirationTime) || expirationTime <= now.getTime() || expirationTime > now.getTime() + 5 * 60_000 + 30_000) {
    throw new SiweVerificationError("MESSAGE_EXPIRED", "SIWE message has expired or exceeds the permitted lifetime");
  }

  // Both sides of the comparison go through the one normaliser
  // (`wallet-address.ts`), so the address the message claims is compared in the
  // same canonical form the database stores and the nonce was issued under.
  const claimed = normalizeWalletAddress(message.address);
  if (!claimed) throw new SiweVerificationError("INVALID_ADDRESS", "SIWE address is invalid");

  const prepared = message.prepareMessage();

  // A key-based account first: this is one pure operation on the signature and
  // needs no network, so the overwhelmingly common case never touches an RPC.
  if (isEcdsaSignature(input.signature)) {
    const recovered = await recoverMessageAddress({ message: prepared, signature: input.signature as Hex })
      .then(normalizeWalletAddress)
      .catch(() => null);
    if (recovered?.canonical === claimed.canonical) {
      return {
        addressCanonical: claimed.canonical,
        addressDisplay: claimed.display,
        chainId: message.chainId,
        accountType: "EOA",
      };
    }
  }

  // No key at that address produced this signature. That is exactly the case a
  // contract wallet exists for: the contract at the claimed address decides,
  // using the same message the wallet displayed. An address that is not a
  // contract, a chain with no endpoint and a node that does not answer are all
  // reported as *not checked* — never as accepted, and never flattened into
  // "invalid signature" either, because a user can act on the difference.
  if (!input.contractVerifier) {
    if (!isEcdsaSignature(input.signature)) {
      throw new SiweVerificationError(
        "SIGNATURE_FORMAT",
        "This deployment verifies key-based accounts only, and this signature is not the fixed-size ECDSA signature one produces. Nothing was signed in.",
      );
    }
    throw new SiweVerificationError(
      "SIGNATURE_INVALID",
      "The signature does not belong to the address it claims, so nothing was signed in.",
    );
  }

  const reading = await input.contractVerifier({
    address: claimed.display,
    chainId: message.chainId,
    messageHash: siweMessageHash(prepared),
    signature: input.signature as Hex,
  });

  if (reading.ok) {
    if (reading.valid) {
      return {
        addressCanonical: claimed.canonical,
        addressDisplay: claimed.display,
        chainId: message.chainId,
        accountType: "CONTRACT",
      };
    }
    throw new SiweVerificationError(
      "CONTRACT_SIGNATURE_INVALID",
      `The contract at ${claimed.display} was asked to verify this signature on chain ${message.chainId} and refused it (it answered ${reading.answer}), so nothing was signed in. A different signer for that account, or signing again, is what fixes it.`,
      true,
    );
  }

  const refusal: SiweVerificationCode =
    reading.reason === "not-deployed"
      ? "CONTRACT_ACCOUNT_NOT_DEPLOYED"
      : reading.reason === "chain-mismatch"
        ? "CONTRACT_CHAIN_MISMATCH"
        : "CONTRACT_VERIFICATION_UNAVAILABLE";
  // A contract wallet's signature can only be judged by its contract, so a check
  // that could not be made is a refusal with its own reason — never a pass. An
  // unreachable node is worth another press of the button; a chain with no
  // endpoint, an address with no contract and an endpoint on the wrong network
  // are not, because nothing about the next attempt would differ.
  throw new SiweVerificationError(
    refusal,
    describeContractVerificationFailure(reading.reason, reading.detail),
    isRetryableUnverifiableReason(reading.reason),
  );
}
