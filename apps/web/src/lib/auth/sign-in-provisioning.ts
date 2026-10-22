/**
 * What a successful sign-in does to the account, decided before anything is
 * written.
 *
 * The sign-in route has one job that is easy to get subtly wrong: a first
 * sign-in creates exactly one account and exactly one wallet identity, and every
 * later sign-in creates neither — it only moves the account's recency forward.
 * That rule used to live as branches inside a database transaction, where the
 * only way to check it was to run the whole flow against a live database.
 *
 * So it lives here instead, as a pure function over four facts the caller has
 * already read. The transaction still does the writing (and stays atomic); this
 * decides *what* to write, and a test can assert the counts without a database:
 *
 *   * a wallet nobody has signed in with → one account, one wallet identity
 *   * the same wallet again → zero of each, and a refreshed last-seen
 *   * a revoked wallet or an inactive account → refused, with nothing written
 *
 * The role resolution is here for the same reason: the development bootstrap
 * ("the configured owner wallet gets OWNER while no owner exists") is a rule
 * about the *plan*, and stating it in one place is what keeps it from being true
 * in the route and false in the seed.
 */
import { isAccountType, type AccountType } from "@/lib/auth/contract-account";

export type ExistingWalletIdentity = {
  id: string;
  userId: string;
  /** How this identity's last proof was made; a stored value this build does not know reads as "EOA". */
  accountType: string;
  revokedAt: Date | null;
};

export type ExistingAccount = { id: string; status: string } | null;

export type SignInProvisioningInput = {
  /** The wallet identity for this exact chain + address, or null if it is new. */
  identity: ExistingWalletIdentity | null;
  /** The account the identity belongs to, read only when an identity exists. */
  account: ExistingAccount;
  /** How this sign-in's signature was proved: a key recovered the address, or a contract accepted it. */
  provedAccountType: AccountType;
  /** The account's current active global role, or null when it holds none. */
  currentRole: string | null;
  /** Whether any account in this deployment already holds OWNER. */
  activeOwnerExists: boolean;
  /** Whether the wallet signing in is the configured development owner address. */
  ownerBootstrapApplies: boolean;
};

/** How many rows this sign-in creates. One or zero of each, never more. */
export type ProvisioningWrites = {
  users: 0 | 1;
  walletIdentities: 0 | 1;
};

export type SignInProvisioningRefusal = {
  outcome: "refused";
  status: 403;
  message: string;
};

export type SignInProvisioningAcceptance = {
  outcome: "accepted";
  /** Exactly what the transaction will insert. */
  creates: ProvisioningWrites;
  /** True when the stored account type has to be rewritten to what was just proved. */
  rewriteAccountType: AccountType | null;
  /** The global role this session runs as. */
  role: string;
  /** True when the role has to be written (a new account, or the bootstrap). */
  assignRole: boolean;
  /** True when this sign-in is what grants OWNER to the development owner. */
  bootstrapOwner: boolean;
  /**
   * True on an account's very first sign-in, which is the signal the login page
   * uses to send someone to the onboarding checklist instead of the overview.
   */
  newAccount: boolean;
  /**
   * Every accepted sign-in refreshes the account's last-seen. Recorded in the
   * plan rather than left implicit, because "a repeat sign-in updates last-seen"
   * is a requirement, not a side effect.
   */
  refreshLastSeen: true;
};

export type SignInProvisioning = SignInProvisioningAcceptance | SignInProvisioningRefusal;

export function planSignInProvisioning(input: SignInProvisioningInput): SignInProvisioning {
  if (input.identity) {
    if (input.identity.revokedAt) {
      return { outcome: "refused", status: 403, message: "This wallet identity is revoked." };
    }
    if (!input.account || input.account.status !== "ACTIVE") {
      return { outcome: "refused", status: 403, message: "This account is not active." };
    }
  }

  // The bootstrap is only reachable while no owner exists, so it can never take
  // OWNER away from an account that already holds it.
  const bootstrapOwner = input.ownerBootstrapApplies &&
    !input.activeOwnerExists &&
    input.currentRole !== "OWNER";
  const role = bootstrapOwner ? "OWNER" : input.currentRole ?? "VIEWER";

  const storedAccountType = input.identity?.accountType;
  const rewriteAccountType = input.identity && (!isAccountType(storedAccountType) || storedAccountType !== input.provedAccountType)
    ? input.provedAccountType
    : null;

  return {
    outcome: "accepted",
    creates: input.identity ? { users: 0, walletIdentities: 0 } : { users: 1, walletIdentities: 1 },
    rewriteAccountType,
    role,
    assignRole: !input.identity || bootstrapOwner || input.currentRole === null,
    bootstrapOwner,
    newAccount: !input.identity,
    refreshLastSeen: true,
  };
}
