"use client";

import { LoaderCircle, LockKeyhole, X } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

/**
 * The step-up prompt, in one place, for every gated action.
 *
 * The server owns the whole decision: a route answers **428** with
 * `code: "TOTP_REQUIRED"` and the scope it wants proved, and that is the only
 * thing that makes this dialog appear. Nothing here decides whether a code is
 * needed — if the owner switches a scope off, the 428 stops arriving and the
 * prompt stops existing, without a deploy and without a second source of truth
 * about the policy.
 *
 * What happens when it does appear:
 *   1. the code is proved once, at `/api/auth/totp/verify`, which records it
 *      against *this session's row* — so the window is this device's, not the
 *      account's;
 *   2. the original request is replayed, unchanged, with the same idempotency
 *      header. That matters more than it looks: the gated action never ran the
 *      first time (the route refuses before it reads the body), so replaying it
 *      is the first attempt, not a second one.
 *
 * A refusal from the code itself — wrong code, locked account — is shown inside
 * the dialog with the server's own sentence, and the dialog stays open, because
 * the answer to "that code was wrong" is another code, not a closed dialog.
 */

export type StepUpPrompt = {
  scope: string;
  message: string;
};

export type StepUpCancelled = { cancelled: true };

export function isStepUpCancelled(value: unknown): value is StepUpCancelled {
  return typeof value === "object" && value !== null && (value as StepUpCancelled).cancelled === true;
}

export type StepUpController = {
  /** `fetch`, with the step-up round-trip handled when the server asks for it. */
  send: (url: string, init?: RequestInit) => Promise<Response>;
  /** Render this: it is null until a scope actually demands a code. */
  prompt: ReactNode;
};

export function useStepUp(): StepUpController {
  const [prompt, setPrompt] = useState<StepUpPrompt | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The promise the dialog settles: `send` awaits it, so the caller's code reads
  // as a single await whether or not a code was ever asked for.
  const pending = useRef<{ resolve: () => void; reject: (reason: unknown) => void } | null>(null);

  const settle = useCallback((outcome: "verified" | "cancelled") => {
    const waiting = pending.current;
    pending.current = null;
    setPrompt(null);
    setCode("");
    setFailure(null);
    if (!waiting) return;
    if (outcome === "verified") waiting.resolve();
    else waiting.reject({ cancelled: true } satisfies StepUpCancelled);
  }, []);

  const send = useCallback(async (url: string, init?: RequestInit): Promise<Response> => {
    const first = await fetch(url, init);
    if (first.status !== 428) return first;

    let asked: StepUpPrompt;
    try {
      const body = (await first.json()) as { scope?: unknown; error?: unknown };
      asked = {
        scope: typeof body.scope === "string" ? body.scope : "trading",
        message: typeof body.error === "string" ? body.error : "This action needs a code from your authenticator app.",
      };
    } catch {
      asked = { scope: "trading", message: "This action needs a code from your authenticator app." };
    }

    setFailure(null);
    setCode("");
    await new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setPrompt(asked);
    });

    // Same method, same body, same headers — including an idempotency key, which
    // is still the first use of that key because nothing was written before.
    return fetch(url, init);
  }, []);

  async function submit() {
    if (!prompt) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/auth/totp/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, scope: prompt.scope }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string; required?: boolean } | null;
      if (!response.ok) throw new Error(result?.error ?? "That code was not accepted.");
      settle("verified");
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "That code was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  return {
    send,
    prompt: prompt ? (
      <div className="step-up-backdrop" role="presentation">
        <form
          className="step-up-dialog"
          aria-labelledby="step-up-title"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="step-up-head">
            <LockKeyhole aria-hidden="true" size={15} />
            <h3 id="step-up-title">A code is required</h3>
            <button className="step-up-close" aria-label="Cancel this action" disabled={busy} onClick={() => settle("cancelled")} type="button">
              <X aria-hidden="true" size={14} />
            </button>
          </div>
          <p>{prompt.message}</p>
          <label className="risk-policy-field" htmlFor="step-up-code">
            <span>AUTHENTICATOR OR BACKUP CODE</span>
            <input
              id="step-up-code"
              autoComplete="one-time-code"
              autoFocus
              maxLength={16}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <small>A backup code works here too. Nothing was submitted: the action runs once the code is accepted.</small>
          </label>
          {failure && <p className="login-error" role="alert">{failure}</p>}
          <div className="risk-policy-actions">
            <button className="section-action" disabled={busy || code.trim().length < 6} type="submit">
              {busy ? <LoaderCircle aria-hidden="true" className="login-spinner" size={14} /> : <LockKeyhole aria-hidden="true" size={14} />}
              {busy ? "CHECKING" : "VERIFY AND CONTINUE"}
            </button>
            <button className="section-action step-up-cancel" disabled={busy} onClick={() => settle("cancelled")} type="button">
              CANCEL
            </button>
          </div>
        </form>
      </div>
    ) : null,
  };
}
