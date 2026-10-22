/**
 * The words the public pages are allowed to use.
 *
 * One module holds them because the same sentences appear on the landing, in the footer, on the
 * terms page and on the risk page, and a claim that appears in four places in four spellings is
 * a claim nobody has checked. Anything that names a number — a fee, a status, a count — is
 * *not* here: it is read from the code that owns it at request time, so this file cannot go
 * stale about money or health.
 *
 * The operator is the trading name only. The owner chose that wording over a registered entity
 * that does not exist yet, so no jurisdiction or company number is asserted anywhere.
 */

export const OPERATOR_NAME = "Veylora";

/** Where a reader can reach the operator. There is no invented mailbox. */
export const OPERATOR_CONTACT =
  "the support desk inside the application (sign in, then Support), which every account can reach";

/**
 * What this deployment is, in one sentence, used wherever the product is introduced.
 */
export const PRODUCT_SUMMARY =
  "A trading console for crypto markets: you sign in with a wallet, hold a balance in the platform's " +
  "own ledger, place orders through the venue whose key you connect, and read every movement afterwards.";

/**
 * The negative claims. These are the ones a regulator, a competitor and an unhappy user would
 * each check first, so they are stated once and repeated verbatim.
 */
export const NOT_STATEMENTS: readonly string[] = [
  "It is not a bank, a broker, an exchange or an investment adviser, and nothing on these pages is investment advice.",
  "It does not offer insured, segregated or guaranteed custody; balances are entries in this deployment's own ledger.",
  "It does not promise a return, a yield, an uptime figure or a recovery of losses, and no page here implies one.",
  "It does not trade for you unless you start a strategy yourself, and stopping it is one control on the trading page.",
];

/** The navigation a visitor gets. The console's own navigation lives in `terminal-shell`. */
export const PUBLIC_NAVIGATION = [
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Status", href: "/status" },
] as const;

/** The legal and explanatory pages, in the order the footer lists them. */
export const LEGAL_NAVIGATION = [
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Risk disclosure", href: "/risk" },
  { label: "FAQ", href: "/faq" },
] as const;

/** Where a signed-in reader goes next, and where a visitor signs in. */
export const CONSOLE_HREF = "/terminal";
export const SIGN_IN_HREF = "/login";

/**
 * Every legal page carries the date it was written, so a reader can tell a current page from a
 * stale one. It is set when the wording changes, not when the site is deployed.
 */
export const LEGAL_REVIEWED_ON = "2026-10-20";
