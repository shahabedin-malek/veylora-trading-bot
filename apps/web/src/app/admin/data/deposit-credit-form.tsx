"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * The one field a manual credit needs: what the arrival is worth in USDT.
 *
 * It posts the pair and refreshes the page on success, so the row leaves the queue by
 * the same read that rendered it. An error is shown in place and nothing is guessed —
 * the amount is the owner's statement about someone else's money.
 */
export function DepositCreditForm({ depositId }: { depositId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/deposits/credit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depositId, usdAmount: amount }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const reason = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error
          : "The credit could not be posted.";
        throw new Error(reason);
      }
      setMessage("Credited and audited.");
      setAmount("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The credit could not be posted.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="deposit-credit-form" onSubmit={submit}>
      <label>
        <span className="sr-only">USDT value</span>
        <input
          aria-label="USDT value of this arrival"
          inputMode="decimal"
          placeholder="USDT value"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      <button className="section-action" disabled={saving} type="submit">
        {saving ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : null}
        {saving ? "CREDITING" : "CREDIT"}
      </button>
      {message && <span role="status">{message}</span>}
      {error && <span className="login-error" role="alert">{error}</span>}
    </form>
  );
}
