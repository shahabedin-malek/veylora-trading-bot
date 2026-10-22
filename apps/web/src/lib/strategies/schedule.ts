/**
 * The strategy activation's place on the phase-05 runner.
 *
 * The job lives here rather than in `runner/registry.ts` so the activation module and the
 * runner can both name it without importing each other: the registry registers the job,
 * the activation view reads the job's heartbeat to say when the next pass is due, and both
 * agree because the id and interval are written once.
 *
 * Five minutes is a ceiling, not a promise: the host may deliver the invocation late or
 * not at all (see `runner/claim.ts`). What the phase requires is that the activation is
 * *scheduled* — a due job the next invocation picks up — and that a schedule that stops
 * delivering is visible as a reason rather than as silence.
 */
export const STRATEGY_JOB_ID = "strategy-activation";

export const STRATEGY_JOB_INTERVAL_MINUTES = 5;

export const STRATEGY_JOB_LABEL = "Smart trading activation";

export const STRATEGY_JOB_DESCRIPTION =
  "Evaluates every account whose smart trading is running once per the strategy's own interval, places one order through the phase-06/20/21 path when the entry or exit condition is met, and records a decision with its inputs, conditions and reason when it does not.";

/**
 * The strategies this build can start.
 *
 * One built-in strategy, because phase 24 supplies the decision loop and this phase must
 * not invent strategy logic. The catalog is data the control reads, so the panel and the
 * activation row cannot disagree about what "smart trading" means, and adding a second
 * strategy later is a row here rather than a branch in the control.
 */
export type SmartStrategy = {
  id: string;
  label: string;
  detail: string;
};

export const SMART_STRATEGIES: readonly SmartStrategy[] = [
  {
    id: "rsi-daily-close",
    label: "Smart RSI · daily close",
    detail:
      "The backtested daily-close strategy the bot builder evaluates: buys an oversold close, exits on the overbought close, with the stop-loss and daily-loss halt checked on every pass. Phase 24 writes the decision loop that acts on it.",
  },
];

/** What a start selects when the control does not name one. */
export const DEFAULT_SMART_STRATEGY_ID = "rsi-daily-close";

export function findSmartStrategy(id: string | null | undefined): SmartStrategy | null {
  if (!id) return null;
  return SMART_STRATEGIES.find((strategy) => strategy.id === id) ?? null;
}
