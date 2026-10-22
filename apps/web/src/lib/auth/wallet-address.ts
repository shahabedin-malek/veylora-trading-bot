import { getAddress } from "viem";

/**
 * One wallet, one account — so the conversion happens in exactly one place.
 *
 * Every surface that touches an EVM address goes through here: the wallet list,
 * the nonce route (which stores the canonical form), the SIWE verifier (which
 * compares canonical forms), the session cookie echo, and the top bar. Before
 * this module, `getAddress(...)` and `.toLowerCase()` were applied at each call
 * site, and a case difference on one of them is all it would take for the same
 * wallet to become two `WalletIdentity` rows.
 *
 * The two forms are deliberate and mean different things:
 *   - `canonical` — lower-cased, for storage and lookup. Unique-keyed in the
 *     database (`@@unique([chainNamespace, chainReference, addressCanonical])`),
 *     so it must not depend on how a wallet happens to capitalise things.
 *   - `display`   — EIP-55 checksummed, for anything a human reads.
 *
 * An EIP-55 checksum is advisory: a wallet that reports `0xAbC...` with a
 * mistaken capitalisation is still reporting a valid address, and refusing it
 * would lock that user out for a cosmetic reason. Non-checksummed input (all
 * lowercase or all uppercase) is accepted by `getAddress` directly; mixed case
 * that fails its own checksum is re-derived from the lowercase form rather than
 * refused. Returns null only when the input is not a 20-byte hex address.
 */
export type NormalizedWalletAddress = { canonical: string; display: string };

// `0X` as well as `0x`: some callers stringify an address with an uppercased
// prefix, and that is the same address, not a different one.
const EVM_ADDRESS_PATTERN = /^0[xX][0-9a-fA-F]{40}$/;

export function normalizeWalletAddress(value: unknown): NormalizedWalletAddress | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!EVM_ADDRESS_PATTERN.test(trimmed)) return null;

  const checksummed = checksummedOrLowercase(`0x${trimmed.slice(2)}`);
  if (!checksummed) return null;
  return { canonical: checksummed.toLowerCase(), display: checksummed };
}

function checksummedOrLowercase(value: string): string | null {
  try {
    return getAddress(value);
  } catch {
    try {
      // Mixed case whose checksum does not verify: the address itself is fine.
      return getAddress(value.toLowerCase());
    } catch {
      return null;
    }
  }
}

/** The canonical (lookup) form, or null when the value is not an address. */
export function canonicalWalletAddress(value: unknown): string | null {
  return normalizeWalletAddress(value)?.canonical ?? null;
}

/** The EIP-55 display form, or null when the value is not an address. */
export function displayWalletAddress(value: unknown): string | null {
  return normalizeWalletAddress(value)?.display ?? null;
}

/**
 * `0x1234...abcd` for the top bar. Falls back to the input unchanged so a
 * caller that already holds a short label is never given something shorter.
 */
export function shortWalletAddress(value: string, leading = 6, trailing = 4): string {
  const display = displayWalletAddress(value) ?? value;
  return display.length <= leading + trailing ? display : `${display.slice(0, leading)}...${display.slice(-trailing)}`;
}
