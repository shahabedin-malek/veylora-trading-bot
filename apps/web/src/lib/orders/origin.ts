/**
 * Where an order intent came from.
 *
 * Recorded on the row rather than inferred later. A caller already passes a
 * `sourceNote` — a sentence for the audit trail — and a sentence is not something a
 * query can group by. The account page's assistant paper-performance block selects
 * `assistant` rows only, so a fill the owner placed on /trade, an activated strategy
 * or the public trading API cannot be counted as the assistant's result.
 *
 * Four values, one per path that can reach `submitOrder`:
 *
 *  - `manual` — the owner, from the order ticket on /trade.
 *  - `assistant` — the in-app assistant's `place_paper_order` tool, which is
 *    restricted to the paper venue.
 *  - `strategy` — an activated strategy's runner pass or a signed strategy signal.
 *  - `api` — the public trading API's agent path, which resolves to the paper venue.
 *
 * The set is enforced here rather than as a database enum for the same reason the
 * order status set is: development runs the SQLite schema derived from
 * `prisma/schema.prisma`, and `scripts/dev-database.mjs` refuses an enum. The column
 * stores the string and this module is the single source of truth for what it may be.
 */
export const ORDER_ORIGINS = ["manual", "assistant", "strategy", "api"] as const;

export type OrderOrigin = (typeof ORDER_ORIGINS)[number];

/**
 * An order written before this column existed is the owner's own: every path that
 * placed orders at that point was the ticket on /trade, and the column's database
 * default says the same thing.
 */
export const DEFAULT_ORDER_ORIGIN: OrderOrigin = "manual";

export function isOrderOrigin(value: unknown): value is OrderOrigin {
  return typeof value === "string" && (ORDER_ORIGINS as readonly string[]).includes(value);
}

/**
 * A value the build does not understand becomes `manual` rather than rendering an
 * origin nobody can explain, which is the same rule `toStoredOrder` applies to a
 * status it does not know.
 */
export function parseOrderOrigin(value: unknown): OrderOrigin {
  return isOrderOrigin(value) ? value : DEFAULT_ORDER_ORIGIN;
}

/**
 * The opening words of the sentence each path writes as its source note.
 *
 * The call sites compose their notes from these constants, and the backfill below
 * classifies historical notes by them. That is deliberate: the classifier and the
 * writers share one string, so a reworded note cannot quietly stop matching the
 * evidence it was written to be.
 *
 * The strategy runner's sentence begins with the strategy's own label, so its marker
 * is the phrase inside the sentence rather than a prefix.
 */
export const ORDER_NOTE_PREFIX = {
  assistant: "The order intent was submitted by the assistant's place_paper_order tool",
  tradePage: "The order intent was submitted from the trading page",
  signal: "Signed signal ",
  api: "Placed by API key ",
  strategy: " decided this at ",
} as const;

/**
 * Which path a source note came from, or `null` when the note is not one this build
 * writes.
 *
 * `null` is the important answer: notes this build cannot place (the fallback "the
 * intent was recorded locally", a seed row, a sentence from an older version) are
 * reported rather than assigned to the nearest-looking origin. A backfill that
 * guessed would put somebody else's fills in the assistant's paper record.
 */
export function classifyOrderOriginFromNote(note: string): OrderOrigin | null {
  if (note.startsWith(ORDER_NOTE_PREFIX.assistant)) return "assistant";
  if (note.startsWith(ORDER_NOTE_PREFIX.tradePage)) return "manual";
  if (note.startsWith(ORDER_NOTE_PREFIX.signal)) return "strategy";
  if (note.startsWith(ORDER_NOTE_PREFIX.api)) return "api";
  if (note.includes(ORDER_NOTE_PREFIX.strategy)) return "strategy";
  return null;
}

/** What each origin means, in the words the account page uses for it. */
export const ORDER_ORIGIN_DETAIL: Record<OrderOrigin, string> = {
  manual: "Placed by the account owner from the terminal's order ticket.",
  assistant: "Placed by the assistant's place_paper_order tool, which reaches the paper venue only.",
  strategy: "Placed by an activated strategy's runner pass or a signed strategy signal.",
  api: "Placed through the public trading API by an agent key, which resolves to the paper venue.",
};
