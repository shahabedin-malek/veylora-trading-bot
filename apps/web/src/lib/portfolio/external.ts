import { decryptVenueCredentials, type TradingVenue } from "@/lib/trading/credential-vault";
import { fetchVerifiedSpotBalances, type VerifiedSpotBalance } from "@/lib/trading/exchange-balances";
import { importWunderTradingReadOnly } from "@/lib/wundertrading/client";

/**
 * The read-only import path, and the wall between it and the platform's balances.
 *
 * A person who will not hand over a trade key can still connect a key that can only
 * read, and this is what that key buys them: their venue's balances and trades, shown
 * as **external** — a report of somewhere else, kept apart from what this account
 * holds here.
 *
 * Three rules are structural rather than remembered.
 *
 *  - **Only read-labelled keys are imported.** The path runs over the credentials
 *    stored as read-only; a key stored as trade-capable is skipped with a reason that
 *    names it, because a key that can place an order is not what this path is for.
 *  - **An external figure cannot become a balance.** {@link ExternalSource} has
 *    `balances` and the overview has `balances`, and nothing copies between them: the
 *    import's result is a separate value with no field a spendable figure could be
 *    assigned to, and {@link ExternalImport.spendable} says `false` in the type.
 *  - **A failed import is a state, not a zero.** A venue that could not be read is
 *    reported with its own reason, so "you hold nothing at Binance" and "Binance
 *    could not be read" cannot look the same on the page.
 */

/** The credential columns this path needs: no secret is decrypted until a read is attempted. */
export type ExternalCredential = {
  id: string;
  venue: string;
  label: string;
  readOnly: boolean;
  ciphertext: string;
  iv: string;
  authTag: string;
};

export type ExternalSource = {
  credentialId: string;
  venue: string;
  label: string;
  readOnly: true;
  status: "imported" | "failed";
  asOf: string;
  balances: VerifiedSpotBalance[];
  trades: { id: string; summary: string; occurredAt: string | null }[];
  /** The venue's own answer, where the venue's read surface is not a balance report. */
  raw: unknown;
  reason: string | null;
  note: string;
};

export type ExternalImport = {
  /** Every external figure lives here and nowhere else. */
  spendable: false;
  sources: ExternalSource[];
  skipped: { credentialId: string; venue: string; label: string; reason: string }[];
  asOf: string;
  note: string;
};

export const SPOT_VENUES: readonly TradingVenue[] = ["binance", "coinbase-advanced", "kraken"];

export function isSpotVenue(venue: string): venue is TradingVenue {
  return (SPOT_VENUES as readonly string[]).includes(venue);
}

export type ExternalImportDeps = {
  now?: () => Date;
  readBalances?: (venue: TradingVenue, material: ReturnType<typeof decryptVenueCredentials>) => Promise<VerifiedSpotBalance[]>;
  readWundertrading?: typeof importWunderTradingReadOnly;
  decrypt?: typeof decryptVenueCredentials;
};

/**
 * Read every read-only credential this account holds, one source per credential.
 *
 * The whole function is written so a test can state the credentials literally and
 * inject the two readers: no network is reached here unless the caller's readers do
 * it, and no credential value is read unless a read is actually attempted.
 */
export async function importExternalHoldings(
  input: { credentials: readonly ExternalCredential[]; deps?: ExternalImportDeps },
): Promise<ExternalImport> {
  const now = input.deps?.now?.() ?? new Date();
  const readBalances = input.deps?.readBalances ?? fetchVerifiedSpotBalances;
  const readWundertrading = input.deps?.readWundertrading ?? importWunderTradingReadOnly;
  const decrypt = input.deps?.decrypt ?? decryptVenueCredentials;

  const sources: ExternalSource[] = [];
  const skipped: ExternalImport["skipped"] = [];

  for (const credential of input.credentials) {
    if (!credential.readOnly) {
      skipped.push({
        credentialId: credential.id,
        venue: credential.venue,
        label: credential.label,
        reason: `This ${credential.venue} key is stored as trade-capable, and the import path uses read-labelled keys only: a key that can place an order is not one this path will read with.`,
      });
      continue;
    }

    const base = {
      credentialId: credential.id,
      venue: credential.venue,
      label: credential.label,
      readOnly: true as const,
      balances: [] as VerifiedSpotBalance[],
      trades: [] as ExternalSource["trades"],
      raw: null as unknown,
      reason: null as string | null,
    };

    if (!isSpotVenue(credential.venue) && credential.venue !== "wundertrading") {
      sources.push({
        ...base,
        status: "failed",
        asOf: now.toISOString(),
        reason: `${credential.venue} has no read connector in this build, so nothing was imported from it.`,
        note: "An unsupported venue is reported rather than silently omitted.",
      });
      continue;
    }

    try {
      const material = decrypt(credential.venue as TradingVenue, {
        ciphertext: credential.ciphertext,
        iv: credential.iv,
        authTag: credential.authTag,
        fingerprint: "",
      });

      if (credential.venue === "wundertrading") {
        const imported = await readWundertrading(material);
        sources.push({
          ...base,
          status: "imported",
          asOf: now.toISOString(),
          raw: { endpoints: imported.endpoints, live: imported.live, history: imported.history },
          note: imported.note,
        });
        continue;
      }

      const balances = await readBalances(credential.venue as TradingVenue, material);
      sources.push({
        ...base,
        status: "imported",
        asOf: now.toISOString(),
        balances,
        note:
          "Read from the venue's own balance endpoint with a read-labelled key. These are the venue's figures, held at the venue, and this deployment cannot move them.",
      });
    } catch (error) {
      sources.push({
        ...base,
        status: "failed",
        asOf: now.toISOString(),
        reason: error instanceof Error ? error.message : "The venue could not be read.",
        note: "A venue that could not be read is reported as unread, not as a zero balance.",
      });
    }
  }

  return {
    spendable: false,
    sources,
    skipped,
    asOf: now.toISOString(),
    note:
      "Imported figures are external: they are the venue's own record of an account held there. They are not entries in this book and cannot be spent, withdrawn or traded by this deployment.",
  };
}
