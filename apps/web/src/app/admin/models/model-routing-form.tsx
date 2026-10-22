"use client";

import { ArrowDown, ArrowUp, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { AiFeature, AiRoutingSettings, AiTarget } from "@/lib/ai/router";
import type { AiProviderReadiness, AiRequirement } from "@/lib/ai/provider";

/**
 * The routing editor.
 *
 * Each feature is an ordered list, because the order *is* the fallback: the first target
 * that can answer does, and a retryable failure moves down the list. A provider that cannot
 * serve a feature is not offered for it, so the panel cannot be used to save a route the
 * router would only skip.
 *
 * The whole document is sent on save. A partial save would let a form erase a route it
 * never showed, which is the failure mode a settings panel cannot afford.
 */

const FEATURE_LABELS: Record<AiFeature, { title: string; detail: string; requirements: AiRequirement[] }> = {
  assistant: {
    title: "Assistant",
    detail: "Tool calling and a streamed answer. Only a provider that declares both can be used.",
    requirements: ["text", "tools", "stream"],
  },
  research: {
    title: "Research",
    detail: "Keyless web search and page extraction.",
    requirements: ["search"],
  },
  strategy: {
    title: "Strategy generation",
    detail: "Plain text; no tools. Phase 28 asks for the plan here.",
    requirements: ["text"],
  },
  "admin-probe": {
    title: "Admin probe",
    detail: "A one-line question used to prove a route end to end without spending a strategy run.",
    requirements: ["text"],
  },
};

function eligible(providers: readonly AiProviderReadiness[], requirements: readonly AiRequirement[]) {
  return providers.filter((provider) => requirements.every((requirement) => provider.capabilities.includes(requirement)));
}

export function ModelRoutingForm({
  initialSettings,
  providers,
}: {
  initialSettings: AiRoutingSettings;
  providers: readonly AiProviderReadiness[];
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<AiRoutingSettings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setRoutes(feature: AiFeature, targets: AiTarget[]) {
    setSettings((current) => ({ ...current, routes: { ...current.routes, [feature]: targets } }));
  }

  function addTarget(feature: AiFeature) {
    const options = eligible(providers, FEATURE_LABELS[feature].requirements);
    const used = new Set(settings.routes[feature].map((target) => target.providerId));
    const next = options.find((provider) => !used.has(provider.id)) ?? options[0];
    if (!next || settings.routes[feature].length >= 3) return;
    setRoutes(feature, [...settings.routes[feature], { providerId: next.id, model: next.id === "tavily" ? null : "" }]);
  }

  function move(feature: AiFeature, index: number, direction: -1 | 1) {
    const targets = [...settings.routes[feature]];
    const swap = index + direction;
    if (swap < 0 || swap >= targets.length) return;
    [targets[index], targets[swap]] = [targets[swap], targets[index]];
    setRoutes(feature, targets);
  }

  function updateTarget(feature: AiFeature, index: number, patch: Partial<AiTarget>) {
    setRoutes(
      feature,
      settings.routes[feature].map((target, position) => (position === index ? { ...target, ...patch } : target)),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "The routing change was refused.");
        return;
      }
      setMessage("Saved. The next request uses this route; no redeploy is needed.");
      router.refresh();
    } catch {
      setError("The routing change could not be sent.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="risk-policy-form" onSubmit={submit}>
      <div className="ai-routing-grid">
        <label className="risk-policy-field" htmlFor="ai-currency">
          <span>Display currency</span>
          <input
            id="ai-currency"
            maxLength={3}
            value={settings.currency}
            onChange={(event) => setSettings((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}
          />
          <small>A three-letter code. Costs are recorded in USD and shown in this currency.</small>
        </label>
        <label className="risk-policy-field" htmlFor="ai-rate">
          <span>Units per US dollar</span>
          <input
            id="ai-rate"
            inputMode="decimal"
            value={settings.usdPerCurrencyUnit}
            onChange={(event) => setSettings((current) => ({ ...current, usdPerCurrencyUnit: event.target.value }))}
          />
          <small>How many units of that currency one dollar buys. It only changes the display.</small>
        </label>
        <label className="risk-policy-field" htmlFor="ai-budget">
          <span>Monthly budget signal (USD)</span>
          <input
            id="ai-budget"
            inputMode="decimal"
            placeholder="No budget set"
            value={settings.monthlyBudgetUsd ?? ""}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                monthlyBudgetUsd: event.target.value.trim() === "" ? null : event.target.value,
              }))
            }
          />
          <small>A signal only. Exceeding it is reported, never enforced as a hidden cap.</small>
        </label>
      </div>

      {(Object.keys(FEATURE_LABELS) as AiFeature[]).map((feature) => {
        const options = eligible(providers, FEATURE_LABELS[feature].requirements);
        return (
          <section className="ai-route-block" key={feature} aria-labelledby={`route-${feature}`}>
            <div className="ai-route-block__head">
              <div>
                <h3 id={`route-${feature}`}>{FEATURE_LABELS[feature].title}</h3>
                <p>{FEATURE_LABELS[feature].detail}</p>
              </div>
              <button
                className="section-action"
                disabled={settings.routes[feature].length >= 3 || options.length === 0}
                onClick={() => addTarget(feature)}
                type="button"
              >
                <Plus aria-hidden="true" size={14} /> Add fallback
              </button>
            </div>

            {settings.routes[feature].length === 0 && (
              <p className="policy-disclaimer" role="status">
                No target. Requests for this feature are refused with the variable that would fix it, not answered
                generically.
              </p>
            )}

            <ol className="ai-route-list">
              {settings.routes[feature].map((target, index) => {
                const selected = options.find((provider) => provider.id === target.providerId);
                return (
                  <li className="ai-route-row" key={`${feature}-${index}`}>
                    <span className="ai-route-row__index">{index === 0 ? "PRIMARY" : `FALLBACK ${index}`}</span>
                    <label>
                      <span>Provider</span>
                      <select
                        value={target.providerId}
                        onChange={(event) => {
                          const provider = options.find((entry) => entry.id === event.target.value);
                          if (!provider) return;
                          updateTarget(feature, index, {
                            providerId: provider.id,
                            model: provider.id === "tavily" ? null : target.model ?? "",
                          });
                        }}
                      >
                        {options.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                            {provider.configured ? "" : ` — ${provider.keyEnv} not set`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Model</span>
                      <input
                        disabled={selected?.id === "tavily"}
                        placeholder={selected?.id === "tavily" ? "Not applicable" : "model id"}
                        value={target.model ?? ""}
                        onChange={(event) => updateTarget(feature, index, { model: event.target.value })}
                      />
                    </label>
                    <div className="ai-route-row__actions">
                      <button
                        aria-label={`Move ${FEATURE_LABELS[feature].title} target up`}
                        className="ai-icon-action"
                        disabled={index === 0}
                        onClick={() => move(feature, index, -1)}
                        type="button"
                      >
                        <ArrowUp aria-hidden="true" size={14} />
                      </button>
                      <button
                        aria-label={`Move ${FEATURE_LABELS[feature].title} target down`}
                        className="ai-icon-action"
                        disabled={index === settings.routes[feature].length - 1}
                        onClick={() => move(feature, index, 1)}
                        type="button"
                      >
                        <ArrowDown aria-hidden="true" size={14} />
                      </button>
                      <button
                        aria-label={`Remove ${FEATURE_LABELS[feature].title} target`}
                        className="ai-icon-action"
                        onClick={() => setRoutes(feature, settings.routes[feature].filter((_, position) => position !== index))}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}

      <div className="risk-policy-actions">
        <button className="section-action" disabled={saving} type="submit">
          {saving ? <LoaderCircle aria-hidden="true" size={14} /> : <Save aria-hidden="true" size={14} />}
          {saving ? "Saving" : "Save routing"}
        </button>
        {message && <p className="form-message" role="status">{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </form>
  );
}
