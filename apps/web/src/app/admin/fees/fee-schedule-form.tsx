"use client";

import { LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { FeeSchedulePayload } from "@/lib/fees/admin";
import { formatFeeAmount } from "@/lib/fees/amounts";
import type { FeeTier } from "@/lib/fees/table";

/**
 * The fee table's editor.
 *
 * Three behaviours are deliberate, and they are the phase's requirements made visible:
 *
 *  - **Saving inserts a version.** The effective-from field is part of the form, so a
 *    change can be applied now or staged for later; the page it saves is the same table
 *    the pricing page and the withdrawal path read.
 *  - **Zero is shown as a value.** Every amount's hint reads `no fee` at zero, because a
 *    blank or `0` would leave the owner unsure whether the field failed to load.
 *  - **Nothing here approves a fee.** There is no confirmation step in front of a charge:
 *    a fee applies when the table says it does, and this form only edits the table.
 */

function localInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function dateFromLocalInput(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function AmountField({
  id,
  label,
  value,
  asset,
  detail,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  asset: string;
  detail: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="risk-policy-field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" min="0" step="0.000001" value={value} onChange={(event) => onChange(event.target.value)} />
      <small>
        {detail} {formatFeeAmount(value, asset)}.
      </small>
    </label>
  );
}

export function FeeScheduleForm({ initial }: { initial: FeeSchedulePayload }) {
  const inForce = initial.inForce;
  const [effectiveFrom, setEffectiveFrom] = useState(() => localInputValue(new Date()));
  const [withdrawalFees, setWithdrawalFees] = useState<Record<string, string>>({ ...inForce.withdrawalFees });
  const [networkCosts, setNetworkCosts] = useState<Record<string, string>>({ ...inForce.networkCosts });
  const [performanceFeePercent, setPerformanceFeePercent] = useState(inForce.performanceFeePercent);
  const [tradingFeeBps, setTradingFeeBps] = useState(inForce.tradingFeeBps);
  const [spreadBps, setSpreadBps] = useState(inForce.spreadBps);
  const [slippageBps, setSlippageBps] = useState(inForce.slippageBps);
  const [fundingBpsPerDay, setFundingBpsPerDay] = useState(inForce.fundingBpsPerDay);
  const [tiers, setTiers] = useState<FeeTier[]>(inForce.tiers.map((tier) => ({ ...tier })));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function feeFor(asset: string): string {
    return withdrawalFees[asset] ?? "0";
  }

  function networkCostFor(asset: string): string {
    return networkCosts[asset] ?? "0";
  }

  function updateTier(index: number, patch: Partial<FeeTier>) {
    setTiers((current) => current.map((tier, position) => (position === index ? { ...tier, ...patch } : tier)));
  }

  function makeTierDefault(index: number) {
    setTiers((current) => current.map((tier, position) => ({ ...tier, isDefault: position === index })));
  }

  function addTier() {
    setTiers((current) => [
      ...current,
      {
        key: `TIER_${current.length + 1}`,
        label: `Tier ${current.length + 1}`,
        maxBots: 0,
        maxVenueConnections: 0,
        isDefault: false,
      },
    ]);
  }

  function removeTier(index: number) {
    setTiers((current) => {
      if (current.length === 1) return current;
      const next = current.filter((_, position) => position !== index);
      // Removing the default would leave no tier in force for anyone; the first
      // remaining tier becomes the default rather than the save being refused.
      if (!next.some((tier) => tier.isDefault)) next[0] = { ...next[0]!, isDefault: true };
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/admin/fees", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effectiveFrom: dateFromLocalInput(effectiveFrom),
          withdrawalFees,
          networkCosts,
          performanceFeePercent,
          tradingFeeBps,
          spreadBps,
          slippageBps,
          fundingBpsPerDay,
          tiers,
        }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason =
          result && typeof result === "object" && "error" in result && typeof result.error === "string"
            ? result.error
            : "The fee table could not be saved.";
        throw new Error(reason);
      }
      const saved = result as FeeSchedulePayload;
      setWithdrawalFees({ ...saved.inForce.withdrawalFees });
      setNetworkCosts({ ...saved.inForce.networkCosts });
      setPerformanceFeePercent(saved.inForce.performanceFeePercent);
      setTradingFeeBps(saved.inForce.tradingFeeBps);
      setSpreadBps(saved.inForce.spreadBps);
      setSlippageBps(saved.inForce.slippageBps);
      setFundingBpsPerDay(saved.inForce.fundingBpsPerDay);
      setTiers(saved.inForce.tiers.map((tier) => ({ ...tier })));
      setMessage(
        saved.pending.length > 0
          ? "Fee table saved and audited. The version you saved is staged; the version in force has not changed yet."
          : "Fee table saved and audited. Withdrawals and /pricing now read this version.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fee table could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="risk-policy-form" onSubmit={save}>
      <label className="risk-policy-field" htmlFor="fee-effective-from">
        <span>EFFECTIVE FROM</span>
        <input
          id="fee-effective-from"
          type="datetime-local"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
        />
        <small>
          A save inserts a version; it never edits one.{" "}
          {inForce.source === "owner-schedule" && inForce.appliedFrom
            ? `In force now: the version dated ${new Date(inForce.appliedFrom).toLocaleString()}.`
            : "In force now: this build's free defaults."}
        </small>
      </label>

      <div className="section-kicker">WITHDRAWAL FEES AND NETWORK COST</div>
      <div className="risk-settings-grid">
        {initial.assets.map(({ asset, decimals }) => (
          <div className="fee-asset-pair" key={asset}>
            <AmountField
              id={`fee-${asset}`}
              label={`${asset} FEE`}
              value={feeFor(asset)}
              asset={asset}
              detail={`Deducted from the amount. ${decimals}-decimal asset.`}
              onChange={(value) => setWithdrawalFees((current) => ({ ...current, [asset]: value }))}
            />
            <AmountField
              id={`network-cost-${asset}`}
              label={`${asset} NETWORK COST`}
              value={networkCostFor(asset)}
              asset={asset}
              detail="Paid by the platform and disclosed; never deducted."
              onChange={(value) => setNetworkCosts((current) => ({ ...current, [asset]: value }))}
            />
          </div>
        ))}
        {initial.assets.length === 0 && (
          <p className="policy-disclaimer" role="status">
            No withdrawal route is configured, so there is no asset to price yet. The table still saves the
            percentage and tiers below.
          </p>
        )}
      </div>

      <div className="risk-settings-grid">
        <label className="risk-policy-field" htmlFor="fee-performance-percent">
          <span>PERFORMANCE FEE (% OF PROFIT)</span>
          <input
            id="fee-performance-percent"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={performanceFeePercent}
            onChange={(event) => setPerformanceFeePercent(event.target.value)}
          />
          <small>
            Charged on a profitable result only. A loss or a flat result pays{" "}
            {formatFeeAmount("0", "the asset")}, whatever this percentage is.
          </small>
        </label>
      </div>

      <div className="section-kicker">BACKTEST COST ASSUMPTIONS</div>
      <p className="policy-disclaimer">
        These are the assumptions every backtest prices its fills with — they are not charges and no order or ledger
        entry is debited by them. Change one and re-run a backtest: the result changes and the run states which
        assumptions it used.
      </p>
      <div className="risk-settings-grid">
        <label className="risk-policy-field" htmlFor="fee-trading-bps">
          <span>TRADING FEE (BPS / SIDE)</span>
          <input
            id="fee-trading-bps"
            type="number"
            min="0"
            max="10000"
            step="0.1"
            value={tradingFeeBps}
            onChange={(event) => setTradingFeeBps(event.target.value)}
          />
          <small>Charged on the traded notional of each fill a backtest models.</small>
        </label>
        <label className="risk-policy-field" htmlFor="fee-spread-bps">
          <span>SPREAD (BPS / SIDE)</span>
          <input
            id="fee-spread-bps"
            type="number"
            min="0"
            max="10000"
            step="0.1"
            value={spreadBps}
            onChange={(event) => setSpreadBps(event.target.value)}
          />
          <small>Applied against the position on entry and exit, like the quoted spread being crossed.</small>
        </label>
        <label className="risk-policy-field" htmlFor="fee-slippage-bps">
          <span>SLIPPAGE (BPS / SIDE)</span>
          <input
            id="fee-slippage-bps"
            type="number"
            min="0"
            max="10000"
            step="0.1"
            value={slippageBps}
            onChange={(event) => setSlippageBps(event.target.value)}
          />
          <small>Adverse price movement assumed on each side of a trade.</small>
        </label>
        <label className="risk-policy-field" htmlFor="fee-funding-bps">
          <span>FUNDING (BPS / DAY)</span>
          <input
            id="fee-funding-bps"
            type="number"
            min="0"
            max="10000"
            step="0.1"
            value={fundingBpsPerDay}
            onChange={(event) => setFundingBpsPerDay(event.target.value)}
          />
          <small>
            Charged per day held, and only when a definition is leveraged above 1x. A 1x position is funded by nothing
            and pays nothing.
          </small>
        </label>
      </div>

      <div className="section-kicker">TIER CAPS</div>
      <p className="policy-disclaimer">
        Venue-connection caps are enforced by the credential path. Bot caps are enforced by the bot builder
        (phase 30). Exactly one tier is the default every account starts on.
      </p>
      <div className="fee-tier-rows">
        {tiers.map((tier, index) => (
          <div className="fee-tier-row" key={`${tier.key}-${index}`}>
            <label className="risk-policy-field" htmlFor={`tier-key-${index}`}>
              <span>KEY</span>
              <input
                id={`tier-key-${index}`}
                value={tier.key}
                onChange={(event) => updateTier(index, { key: event.target.value.toUpperCase() })}
              />
            </label>
            <label className="risk-policy-field" htmlFor={`tier-label-${index}`}>
              <span>LABEL</span>
              <input
                id={`tier-label-${index}`}
                value={tier.label}
                onChange={(event) => updateTier(index, { label: event.target.value })}
              />
            </label>
            <label className="risk-policy-field" htmlFor={`tier-bots-${index}`}>
              <span>MAX BOTS</span>
              <input
                id={`tier-bots-${index}`}
                type="number"
                min="0"
                max="1000"
                step="1"
                value={tier.maxBots}
                onChange={(event) => updateTier(index, { maxBots: Number(event.target.value) })}
              />
            </label>
            <label className="risk-policy-field" htmlFor={`tier-venues-${index}`}>
              <span>MAX VENUES</span>
              <input
                id={`tier-venues-${index}`}
                type="number"
                min="0"
                max="100"
                step="1"
                value={tier.maxVenueConnections}
                onChange={(event) => updateTier(index, { maxVenueConnections: Number(event.target.value) })}
              />
            </label>
            <label className="risk-kill-switch fee-tier-default">
              <input
                checked={tier.isDefault}
                name="fee-default-tier"
                onChange={() => makeTierDefault(index)}
                type="radio"
              />
              <span>DEFAULT</span>
            </label>
            <button
              className="section-action"
              disabled={tiers.length === 1}
              onClick={() => removeTier(index)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />
              REMOVE
            </button>
          </div>
        ))}
      </div>
      <button className="section-action" disabled={tiers.length >= 8} onClick={addTier} type="button">
        <Plus aria-hidden="true" size={14} />
        ADD TIER
      </button>

      <div className="risk-policy-actions">
        <button className="section-action" disabled={saving} type="submit">
          {saving ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <Save aria-hidden="true" size={14} />}
          {saving ? "SAVING" : "SAVE FEE TABLE"}
        </button>
        {message && <span role="status">{message}</span>}
        {error && <span className="login-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
