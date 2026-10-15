import { getAddress, type Address } from "viem";

export const MAX_ETHEREUM_TOKEN_ALLOWLIST_SIZE = 50;

export function normalizeChecksummedAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value as Address);
  } catch {
    return null;
  }
}

export function isChecksummedAddress(value: unknown): value is Address {
  if (typeof value !== "string") return false;
  return normalizeChecksummedAddress(value) === value;
}