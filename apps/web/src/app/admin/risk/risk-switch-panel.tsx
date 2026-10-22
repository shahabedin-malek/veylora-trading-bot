"use client";

import { LoaderCircle, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The two kill switches, as things you press rather than things you save (phase 25).
 *
 * Each switch shows what it is, what it is currently doing, who last moved it and when, and
 * — requirement 5 — what pressing it *now* would do, in a sentence, before it is pressed.
 * Pressing it posts immediately: a stop that waited for a form save would be a stop that is
 * not one.
 */
export type SwitchState = {
  active: boolean;
  changedAt: string | null;
  changedBy: string | null;
};

export function RiskSwitchPanel({
  globalSwitch,
  strategySwitch,
  strategyLabel,
  effect,
}: {
  globalSwitch: SwitchState;
  strategySwitch: SwitchState & { activationId: string | null };
  strategyLabel: string | null;
  effect: string;
}) {
  const router = useRouter();
  const [global, setGlobal] = useState(globalSwitch);
  const [strategy, setStrategy] = useState(strategySwitch);
  const [busy, setBusy] = useState<"global" | "strategy" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(scope: "global" | "strategy") {
    setBusy(scope);
    setMessage(null);
    setError(null);
    const next = scope === "global" ? !global.active : !strategy.active;
    try {
      const response = await fetch("/api/admin/risk-policy/switch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "global"
            ? { scope, active: next }
            : { scope, active: next, activationId: strategy.activationId },
        ),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "The switch could not be changed.";
        throw new Error(reason);
      }
      const saved = result as { active: boolean; changedAt?: string | null; changedByUserId?: string | null; cooldownUntil?: string | null };
      const state = {
        active: saved.active,
        changedAt: saved.changedAt ?? new Date().toISOString(),
        changedBy: saved.changedByUserId ?? null,
      };
      if (scope === "global") {
        setGlobal(state);
        setMessage(
          saved.active
            ? "Global kill switch engaged: every strategy is stopped and every new order, manual or automatic, is refused until it is released."
            : `Global kill switch released${saved.cooldownUntil ? `; new orders are held back by the cooldown until ${saved.cooldownUntil}` : ""}.`,
        );
      } else {
        setStrategy((current) => ({ ...current, ...state }));
        setMessage(saved.active ? "This strategy is stopped; other orders are unaffected." : "This strategy may trade again, subject to the limits above.");
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The switch could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="risk-switch-panel">
      <p className="policy-note" role="status">{effect}</p>

      <div className="risk-switch-grid">
        <div className={`risk-switch-card${global.active ? " risk-switch-card--engaged" : ""}`}>
          <div className="section-kicker">GLOBAL KILL SWITCH</div>
          <strong>{global.active ? "ENGAGED — ALL TRADING REFUSED" : "RELEASED — TRADING EVALUATED"}</strong>
          <p>
            {global.active
              ? "Every strategy stops placing orders at its next pass, and a manual order is refused with this switch named as the reason."
              : "Engaging it refuses every new order at once and records who pressed it; the owner can always turn it back off."}
          </p>
          <small>
            {global.changedAt
              ? `Last changed ${global.changedAt}${global.changedBy ? ` by ${global.changedBy}` : ""}.`
              : "Never changed since the policy row was created; every change is audited with its actor and time."}
          </small>
          <button className="section-action" disabled={busy !== null} onClick={() => toggle("global")} type="button">
            {busy === "global" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Power aria-hidden="true" size={14} />}
            {global.active ? "RELEASE GLOBAL SWITCH" : "ENGAGE GLOBAL SWITCH"}
          </button>
        </div>

        <div className={`risk-switch-card${strategy.active ? " risk-switch-card--engaged" : ""}`}>
          <div className="section-kicker">THIS STRATEGY&apos;S SWITCH</div>
          <strong>
            {strategy.activationId === null
              ? "NO STRATEGY ACTIVATION"
              : strategy.active
                ? "ENGAGED — THIS STRATEGY IS STOPPED"
                : "RELEASED — THIS STRATEGY MAY TRADE"}
          </strong>
          <p>
            {strategy.activationId === null
              ? "Nothing is running, so there is nothing to stop. Start smart trading and this switch appears here."
              : strategy.active
                ? `${strategyLabel ?? "This strategy"} will not place an order until the switch is released; other strategies and manual orders are unaffected.`
                : `Stops only ${strategyLabel ?? "this strategy"}: its next pass records the refusal and the run keeps going, so releasing the switch needs no restart.`}
          </p>
          <small>
            {strategy.changedAt
              ? `Last changed ${strategy.changedAt}${strategy.changedBy ? ` by ${strategy.changedBy}` : ""}.`
              : "This switch has not been pressed."}
          </small>
          <button
            className="section-action"
            disabled={busy !== null || strategy.activationId === null}
            onClick={() => toggle("strategy")}
            type="button"
          >
            {busy === "strategy" ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Power aria-hidden="true" size={14} />}
            {strategy.active ? "RELEASE THIS STRATEGY" : "STOP THIS STRATEGY"}
          </button>
        </div>
      </div>

      {message && <span role="status">{message}</span>}
      {error && <span className="login-error" role="alert">{error}</span>}
    </div>
  );
}
