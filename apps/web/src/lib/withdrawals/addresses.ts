import { getAddress } from "viem";
import { reason, type Reason } from "@/lib/observability/reason";

/**
 * The destinations this account has withdrawn to before.
 *
 * The book exists for exactly one reason: the owner's own new-address control has
 * to be able to ask "has this account ever sent to this address?" and get a fact
 * rather than an impression. So a row is an **observation** — "this account has sent
 * to this address" — and never an approval step of this code's invention. The
 * phase-14 brief is explicit that the only hold in front of a withdrawal the owner
 * asks for is the window the owner configured themselves, and this file is the side
 * of that control that remembers the addresses.
 *
 * Two consequences worth stating, because both are deliberate:
 *
 *  - **A refused request still teaches the book nothing.** The row is written when a
 *    withdrawal is *accepted*, not when it is merely attempted, so a mistyped address
 *    that was refused never becomes a "known" address that a later withdrawal skips
 *    the window for.
 *  - **The book is per account and per network.** The same address on another chain
 *    is a different destination with a different token behind it, and an address a
 *    *different* account has used says nothing about this one.
 *
 * Addresses are stored twice on purpose: `address` is the lowercased form and is the dedup
 * key, `addressDisplay` is the EIP-55 checksummed form and is what a person reads. Two
 * spellings of one address are one row, so the window cannot be defeated by pasting the same
 * address with different capitalisation — and the checksum is the only defence a reader has
 * against a transposed character.
 *
 * **What is accepted, and what is refused, follows EIP-55 rather than a library default.**
 * An all-lowercase or all-uppercase address carries no checksum and is accepted as written;
 * a *mixed-case* address is accepted only when its capitalisation is the correct checksum, so
 * a transposed character in an address copied off a wallet screen is refused instead of being
 * sent into. A library that treats an all-uppercase address as an invalid checksum would
 * refuse a perfectly ordinary way of writing an address, which is a refusal an owner cannot
 * act on, and refusing something that is not wrong is its own kind of dishonesty.
 */

export type WithdrawalAddressRow = {
  id: string;
  userId: string;
  network: string;
  chainId: number;
  /** Lowercased `0x…`: the identity used for lookups and uniqueness. */
  address: string;
  /** EIP-55 checksummed `0x…`: what the owner reads and can verify character by character. */
  addressDisplay: string;
  useCount: number;
  firstSeenAt: Date;
  lastUsedAt: Date;
};

export type NewWithdrawalAddress = {
  userId: string;
  network: string;
  chainId: number;
  address: string;
  addressDisplay: string;
  firstSeenAt: Date;
};

export type WithdrawalAddressStore = {
  findWithdrawalAddress(input: { userId: string; network: string; address: string }): Promise<WithdrawalAddressRow | null>;
  listWithdrawalAddresses(userId: string): Promise<WithdrawalAddressRow[]>;
  /** Create the row, or bump the one that is already there. Idempotent. */
  rememberWithdrawalAddress(row: NewWithdrawalAddress): Promise<WithdrawalAddressRow>;
};

/** The zero address: real, well-formed, and a burn. Never a destination. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type DestinationCheck =
  | { ok: true; address: string; display: string }
  | { ok: false; reason: Reason };

/**
 * Read a destination address, or refuse it with a sentence naming the value.
 *
 * The checks are in the order a mistake is made: it has to be an address at all ("0x" and 40
 * hexadecimal characters), a mixed-case one has to carry the correct EIP-55 checksum, it
 * cannot be the zero address, and `blocked` carries the destinations the caller knows are
 * wrong for *this* deployment — the sending wallet itself, or an address the owner's own
 * new-address window has not cleared.
 *
 * Non-EVM addresses are refused with the same code and their own sentence: a Solana or
 * Bitcoin address is not a bad address, it is an address this route cannot send to, and
 * saying so is more useful than "invalid".
 */
export function checkDestination(
  value: unknown,
  input: { blocked?: readonly { address: string; reason: Reason }[] } = {},
): DestinationCheck {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: reason("INVALID_DESTINATION", { message: "No destination address was given." }) };
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("0x") && !trimmed.startsWith("0X")) {
    return {
      ok: false,
      reason: reason("INVALID_DESTINATION", {
        message:
          `The destination ${JSON.stringify(trimmed.slice(0, 20))} is not an EVM address, and this deployment sends on ` +
          "EVM networks only.",
      }),
    };
  }
  const lower = trimmed.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    return {
      ok: false,
      reason: reason("INVALID_DESTINATION", {
        message:
          `The destination ${JSON.stringify(trimmed)} is not a usable EVM address: it needs 40 hexadecimal characters ` +
          "after 0x.",
      }),
    };
  }
  const allUpper = `0x${lower.slice(2).toUpperCase()}`;
  const carriesNoChecksum = trimmed === lower || trimmed === allUpper;
  if (!carriesNoChecksum && getAddress(trimmed) !== trimmed) {
    return {
      ok: false,
      reason: reason("INVALID_DESTINATION", {
        message:
          `The destination ${JSON.stringify(trimmed)} is written in mixed case and its capitalisation is not a valid ` +
          "EIP-55 checksum, so it may have a transposed character; copy it again from the wallet.",
      }),
    };
  }
  const display = getAddress(lower);
  const address = lower;
  if (address === ZERO_ADDRESS) {
    return {
      ok: false,
      reason: reason("INVALID_DESTINATION", {
        message: "The zero address is a burn, not a destination, so the withdrawal was refused.",
      }),
    };
  }
  for (const entry of input.blocked ?? []) {
    if (entry.address.toLowerCase() === address) return { ok: false, reason: entry.reason };
  }
  return { ok: true, address, display };
}

/**
 * Whether this account has sent to this destination before.
 *
 * The answer is read from the book and nothing else — no cached set, no per-request
 * memory — so two processes reach the same answer, and an address known before a
 * restart is still known after one.
 */
export async function destinationIsKnown(
  store: WithdrawalAddressStore,
  input: { userId: string; network: string; address: string },
): Promise<boolean> {
  return (await store.findWithdrawalAddress(input)) !== null;
}
