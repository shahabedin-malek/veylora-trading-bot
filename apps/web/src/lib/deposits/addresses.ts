import { keccak256, toBytes } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { reason, type Reason } from "@/lib/observability/reason";
import { depositAvailabilityReason, type DepositNetworkPolicy, type DepositPolicy } from "./policy";

/**
 * Deposit addresses: derived, then stored once.
 *
 * A deposit address has to satisfy two things that pull in opposite directions.
 * It must be *derivable*, because the deployment has to be able to spend from it
 * later (withdrawals are phase 14) without keeping a private key per user in the
 * database. And it must be *stable*, because an owner who was shown an address
 * must be able to receive to it next month — a re-derived different address is
 * money sent to nowhere.
 *
 * So the address is a pure function of (seed, index), and the index is a pure
 * function of (userId, network):
 *
 *   index   = first 4 bytes of keccak256("<userId>:<network>") mod 2^31
 *   address = BIP-44 m/44'/60'/0'/0/<index> from DEPOSIT_ADDRESS_MNEMONIC
 *
 * Nothing is allocated by a counter, so there is no allocation to lose: the same
 * account and network derive the same index on every machine, forever. The row in
 * `DepositAddress` is the *record* of that derivation — it is what the watcher
 * looks transfers up by — not the source of it. Deleting the row would not change
 * the address, which is exactly what makes the two properties compatible.
 *
 * Two honest boundaries:
 *
 *  - **EVM only.** The derivation is BIP-44 at `m/44'/60'/...`, which is the
 *    Ethereum path. A non-EVM chain needs its own curve and path and is not
 *    claimed here.
 *  - **A collision is surfaced, not hidden.** Two accounts landing on the same
 *    index would produce the same address; the unique constraint on
 *    (network, address) refuses the second row, and the issuance reports it
 *    rather than silently re-deriving a different address that would break the
 *    first account's stability.
 */

/**
 * The index space: 2_147_483_648 addresses per seed.
 *
 * One bit short of the full 32 bits, and deliberately so. In BIP-32 a child
 * number with its top bit set is a *hardened* child, so `m/44'/60'/0'/0/<index>` —
 * a non-hardened level — only addresses `0x00000000`–`0x7fffffff`, and a library
 * asked for a larger one refuses rather than deriving something else. Taking the
 * hash modulo this bound keeps every account on a path that can actually be spent
 * from, which matters because withdrawals are derived from the same paths.
 */
const MAX_DERIVATION_INDEX = 0x7fff_ffff;

export type DepositAddressRow = {
  id: string;
  userId: string;
  network: string;
  chainId: number;
  address: string;
  derivationIndex: number;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  createdAt: Date;
};

export type NewDepositAddress = {
  userId: string;
  network: string;
  chainId: number;
  address: string;
  derivationIndex: number;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
};

export type DepositAuditEntry = {
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: "SUCCESS" | "REFUSED";
  payload: Record<string, unknown>;
};

/**
 * The store slice address issuance needs. Narrowed to these five calls so the
 * whole issuance — including the "exactly once" claim — is exercised in a test
 * against an in-memory implementation rather than against a database.
 */
export type DepositAddressStore = {
  listAddressesForUser(userId: string): Promise<DepositAddressRow[]>;
  findAddressByNetworkAndAddress(network: string, address: string): Promise<DepositAddressRow | null>;
  insertAddressOnce(row: NewDepositAddress): Promise<{ created: boolean; row: DepositAddressRow }>;
  recordAudit(entry: DepositAuditEntry): Promise<void>;
  transaction<T>(work: (store: DepositAddressStore) => Promise<T>): Promise<T>;
};

/**
 * The derivation index for one account on one network.
 *
 * `userId` is the account's own id (a cuid minted at sign-in), so the mapping is
 * stable for the life of the account, and it is not guessable from the address
 * list alone. The network is part of the hash so the same account does not reuse
 * one index on every chain.
 */
export function depositAddressIndexFor(userId: string, network: string): number {
  const digest = keccak256(toBytes(`${userId}:${network}`));
  const slice = digest.slice(2, 10);
  // Modulo the *count* of usable indices (2^31), not the largest one: taking the
  // high bit off with a mask would send every index above 0x7fffffff to the same
  // low value, while the modulo spreads them across the whole usable space.
  return Number.parseInt(slice, 16) % (MAX_DERIVATION_INDEX + 1);
}

export function depositDerivationPath(index: number): string {
  return `m/44'/60'/0'/0/${index}`;
}

export type DerivedDepositAddress = {
  address: string;
  path: string;
  index: number;
};

/**
 * Derive one address. Throws only for a seed that is not a usable BIP-39
 * mnemonic; callers turn that into {@link depositSeedReason} rather than
 * inventing a fallback address.
 */
export function deriveDepositAddress(mnemonic: string, index: number): DerivedDepositAddress {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_DERIVATION_INDEX) {
    throw new Error(`Derivation index ${index} is outside the BIP-44 address range.`);
  }
  const account = mnemonicToAccount(mnemonic, { addressIndex: index });
  return { address: account.address, path: depositDerivationPath(index), index };
}

/** The address one account always sees on one network. Pure, no store involved. */
export function deriveDepositAddressFor(mnemonic: string, userId: string, network: string): DerivedDepositAddress {
  return deriveDepositAddress(mnemonic, depositAddressIndexFor(userId, network));
}

/** A BIP-39 mnemonic is 12–24 words, in multiples of three. */
export function isUsableMnemonic(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length);
}

/**
 * Why the seed cannot be used, or null when it can. Kept separate from
 * {@link depositAvailabilityReason} so a *malformed* seed is reported as such
 * instead of being reported as absent.
 */
export function depositSeedReason(policy: DepositPolicy): Reason | null {
  if (!policy.mnemonic) return depositAvailabilityReason(policy);
  if (!isUsableMnemonic(policy.mnemonic)) {
    return reason("MISSING_CONFIGURATION", {
      variable: "DEPOSIT_ADDRESS_MNEMONIC",
      message: "DEPOSIT_ADDRESS_MNEMONIC is set but is not a BIP-39 mnemonic: 12, 15, 18, 21 or 24 words are required.",
    });
  }
  return null;
}

export type IssuanceOutcome = {
  /** Addresses this call created. */
  created: DepositAddressRow[];
  /** Addresses that already existed — the same account sees the same value. */
  existing: DepositAddressRow[];
  /** Networks that were not issued, each with the reason. */
  skipped: { network: string; reason: Reason }[];
};

/**
 * Issue every enabled network's address for one account, exactly once.
 *
 * Called on a successful sign-in and on the first read of the deposit surface, so
 * both orderings are safe: whichever runs first creates the rows, and the other
 * finds them. The audit event is written in the same transaction as the row, so
 * an address that exists without its issuance record cannot happen.
 */
export async function ensureDepositAddressesForUser(input: {
  userId: string;
  store: DepositAddressStore;
  policy: DepositPolicy;
  networks?: readonly DepositNetworkPolicy[];
  now?: Date;
}): Promise<IssuanceOutcome> {
  const { userId, store, policy } = input;
  const now = input.now ?? new Date();
  const outcome: IssuanceOutcome = { created: [], existing: [], skipped: [] };

  const seedReason = depositSeedReason(policy);
  if (seedReason) {
    for (const network of input.networks ?? policy.enabledNetworks) {
      outcome.skipped.push({ network: network.slug, reason: seedReason });
    }
    return outcome;
  }
  const mnemonic = policy.mnemonic!;

  const targets = (input.networks ?? policy.enabledNetworks).filter((network) => network.token !== null);
  for (const network of input.networks ?? policy.enabledNetworks) {
    if (network.token === null) {
      outcome.skipped.push({
        network: network.slug,
        reason: reason("MISSING_CONFIGURATION", {
          variable: network.missing[0] ?? `DEPOSIT_TOKEN_ADDRESS_${network.slug.toUpperCase().replace(/-/g, "_")}`,
          message: `No deposit token is configured for ${network.displayName}, so no address was issued for it.`,
        }),
      });
    }
  }

  const existing = await store.listAddressesForUser(userId);
  const byNetwork = new Map(existing.map((row) => [row.network, row]));

  for (const network of targets) {
    const alreadyThere = byNetwork.get(network.slug);
    if (alreadyThere) {
      outcome.existing.push(alreadyThere);
      continue;
    }

    const derived = deriveDepositAddressFor(mnemonic, userId, network.slug);
    const inserted = await store.transaction(async (transaction) => {
      const result = await transaction.insertAddressOnce({
        userId,
        network: network.slug,
        chainId: network.chainId,
        address: derived.address,
        derivationIndex: derived.index,
        tokenSymbol: network.token?.symbol ?? null,
        tokenAddress: network.token?.address ?? null,
        tokenDecimals: network.token?.decimals ?? null,
      });
      if (!result.created) return result;
      await transaction.recordAudit({
        actorUserId: userId,
        action: "DEPOSIT_ADDRESS_ISSUED",
        objectType: "DepositAddress",
        objectId: result.row.id,
        outcome: "SUCCESS",
        payload: {
          network: network.slug,
          chainId: network.chainId,
          address: result.row.address,
          derivationIndex: result.row.derivationIndex,
          derivationPath: derived.path,
          token: network.token ? { symbol: network.token.symbol, address: network.token.address, decimals: network.token.decimals } : null,
          issuedAt: now.toISOString(),
        },
      });
      return result;
    });

    if (inserted.created) {
      outcome.created.push(inserted.row);
      continue;
    }
    // The row already existed — another request created it between the read and
    // the insert. Same account, same derived address, so this is a success.
    outcome.existing.push(inserted.row);
  }

  return outcome;
}
