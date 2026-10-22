/**
 * Fee amounts, as exact decimal strings, with no database and no server-only imports.
 *
 * This module exists so the withdrawal panel can subtract a fee from an amount while
 * the owner types, using the *same* arithmetic and the *same* "no fee" wording the
 * server uses. The alternative — the panel doing `Number(amount) - Number(fee)` —
 * is how a screen ends up promising a receiving figure a few minor units different
 * from the one the ledger records, and the phase's whole subject is figures that
 * cannot contradict each other.
 *
 * Three rules, all of them load-bearing:
 *
 *  - **A fee of zero is "no fee".** Zero is a valid configuration, not a missing
 *    value, so every surface renders it in words rather than as `0` or a blank.
 *  - **The fee is deducted; the network cost is disclosed.** The owner authorises a
 *    gross amount, the platform keeps its fee out of it, and the chain's gas is paid
 *    by the platform — so the amount that arrives is gross minus fee, and the network
 *    cost is printed beside it as what the transfer costs us. Reporting it as a
 *    deduction the owner never authorised would be a second price.
 *  - **A decimal string is parsed at the asset's own scale.** Nothing here goes
 *    through a float; an unparseable amount is `null`/`invalid`, never a rounded
 *    number wearing the same name.
 */

/** `123`, `0.5`, `12.345678` — a non-negative decimal with no exponent or sign. */
export function isDecimalAmount(value: string): boolean {
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$/.test(trimmed);
}

/** A decimal string as exact minor units, or null when it cannot be read at this scale. */
export function decimalToMinor(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!isDecimalAmount(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  const padded = fraction.padEnd(decimals, "0");
  try {
    return BigInt(`${whole.replace(/^0+(?=\d)/, "")}${padded}`);
  } catch {
    return null;
  }
}

/** Minor units at an asset's scale, with no trailing zeros and no signed zero. */
export function minorToDecimal(value: bigint, decimals: number): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString();
  if (decimals === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}

/** Is this configured amount exactly zero? An unreadable amount is not zero. */
export function isZeroAmount(value: string): boolean {
  return isDecimalAmount(value) && decimalToMinor(value, 18) === BigInt(0);
}

/**
 * A configured amount in words: `1 USDT`, `0.5 USDT`, or `no fee`.
 *
 * The zero case is deliberately not `0 USDT`. "Free" is an answer an owner can read,
 * and a pricing page or a withdrawal panel that printed `0` would leave the reader
 * wondering whether the number failed to load.
 */
export function formatFeeAmount(amount: string, asset: string): string {
  const trimmed = amount.trim();
  if (trimmed === "" || isZeroAmount(trimmed)) return "no fee";
  return `${trimmed} ${asset}`;
}

/** What a withdrawal of one size at one fee actually does to the owner's money. */
export type WithdrawalQuote = {
  asset: string;
  decimals: number;
  /** What the owner typed, as entered. */
  gross: string;
  /** The platform's cut, in the asset. */
  fee: string;
  /** What the chain charges to send it, paid by the platform and never deducted. */
  networkCost: string;
  /** gross minus fee: the figure the destination wallet receives. */
  arriving: string;
  /** The fee in words, so a zero reads as "no fee". */
  feeLabel: string;
  /** The network cost in words; disclosed, never deducted. */
  networkCostLabel: string;
  arrivingMinor: string;
};

export type WithdrawalQuoteOutcome =
  | { valid: true; quote: WithdrawalQuote }
  | { valid: false; reason: string };

/**
 * Price one withdrawal from the very strings the panel holds.
 *
 * A fee at or above the gross amount is refused *here*, as a sentence, rather than
 * discovered at settlement: a request whose fee eats the whole amount leaves nothing
 * to send, and the phase's failure case is exactly that request being rejected before
 * anything is reserved. The server applies the same rule before it inserts a row.
 */
export function quoteWithdrawal(input: {
  amount: string;
  fee: string;
  networkCost: string;
  asset: string;
  decimals: number;
}): WithdrawalQuoteOutcome {
  const grossMinor = decimalToMinor(input.amount, input.decimals);
  if (grossMinor === null) {
    return {
      valid: false,
      reason: `${input.amount || "The amount"} is not an amount of ${input.asset} at ${input.decimals} decimals.`,
    };
  }
  if (grossMinor === BigInt(0)) {
    return { valid: false, reason: "A withdrawal of zero moves nothing." };
  }
  const feeMinor = decimalToMinor(input.fee, input.decimals);
  if (feeMinor === null) {
    return {
      valid: false,
      reason: `The configured fee ${JSON.stringify(input.fee)} cannot be read at ${input.decimals} decimals, so this withdrawal cannot be priced.`,
    };
  }
  const networkCostMinor = decimalToMinor(input.networkCost, input.decimals);
  if (networkCostMinor === null) {
    return {
      valid: false,
      reason: `The configured network cost ${JSON.stringify(input.networkCost)} cannot be read at ${input.decimals} decimals, so this withdrawal cannot be priced.`,
    };
  }
  if (feeMinor >= grossMinor) {
    return {
      valid: false,
      reason:
        `The withdrawal fee of ${input.fee} ${input.asset} leaves nothing of ${input.amount} to send. ` +
        "Withdraw a larger amount or lower the fee.",
    };
  }

  const arrivingMinor = grossMinor - feeMinor;
  return {
    valid: true,
    quote: {
      asset: input.asset,
      decimals: input.decimals,
      gross: input.amount.trim(),
      fee: minorToDecimal(feeMinor, input.decimals),
      networkCost: minorToDecimal(networkCostMinor, input.decimals),
      arriving: minorToDecimal(arrivingMinor, input.decimals),
      feeLabel: formatFeeAmount(input.fee, input.asset),
      networkCostLabel: formatFeeAmount(input.networkCost, input.asset),
      arrivingMinor: arrivingMinor.toString(),
    },
  };
}

/**
 * A percentage of a profit, in basis points, from a decimal percentage string.
 *
 * Basis points rather than a float so `12.5%` is exactly 1250 and a percentage cannot
 * be rounded on the way into a money computation. `null` means the string is not a
 * percentage this build can read.
 */
export function percentToBasisPoints(value: string): bigint | null {
  const trimmed = value.trim();
  if (!isDecimalAmount(trimmed)) return null;
  const basisPoints = decimalToMinor(trimmed, 2);
  return basisPoints === null ? null : basisPoints;
}
