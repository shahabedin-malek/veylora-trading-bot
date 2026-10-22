import { getDepositNetwork, isDepositNetworkSlug } from "./registry";

/**
 * The small amount of input validation the deposit routes need, in one place.
 *
 * Both values are refused *before* a store is touched, so a malformed address or
 * an unknown network never becomes a database query — and the refusal names what
 * was wrong rather than answering 404 for a typo, which would send someone
 * looking for a missing row instead of a mistyped one.
 */

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS_PATTERN.test(value.trim());
}

export function requireDepositAddress(value: string | undefined): { error: string; status: number } | null {
  if (!value || !isEvmAddress(value)) {
    return {
      error: "A deposit address must be a 0x-prefixed, 20-byte hexadecimal address.",
      status: 400,
    };
  }
  return null;
}

export function requireDepositNetwork(slug: string | undefined): { error: string; status: number } | null {
  if (!slug || !isDepositNetworkSlug(slug) || !getDepositNetwork(slug)) {
    return {
      error: "That is not a deposit network this deployment knows. See DEPOSIT_ENABLED_NETWORKS for the slugs it does.",
      status: 404,
    };
  }
  return null;
}
