"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useState } from "react";

/**
 * Ask the route a question, and show which provider actually answered.
 *
 * This is the panel's proof rather than its promise: the answer's provider, the target it
 * fell back from and each attempt's outcome come from the same records the usage table is
 * built from. A failed probe shows the variable the deployment is missing, which is the
 * sentence a person can act on.
 */

type ProbeAttempt = { label: string; outcome: string; errorCode: string | null };

type ProbeResult =
  | {
      status: "answered";
      providerId: string;
      model: string | null;
      answer: string;
      fallbackFrom: string | null;
      attempts: ProbeAttempt[];
      costMicrosUsd: number | null;
    }
  | { status: "unavailable"; error: string; missingKeys: string[]; skipped: { providerId: string; reason: string }[] }
  | { status: "failed"; error: string };

export function ProbePanel() {
  const [question, setQuestion] = useState("Reply with one short sentence confirming you received this probe.");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setTransportError(null);
    setResult(null);
    try {
      const response = await fetch("/api/admin/models/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const body = (await response.json()) as ProbeResult & { error?: string };
      if (!response.ok) {
        const error = body.error ?? "The probe was refused.";
        setResult(
          body.status === "unavailable"
            ? { status: "unavailable", error, missingKeys: body.missingKeys ?? [], skipped: body.skipped ?? [] }
            : { status: "failed", error },
        );
        return;
      }
      setResult(body);
    } catch {
      setTransportError("The probe request could not be sent.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="ai-probe">
      <label className="risk-policy-field" htmlFor="ai-probe-question">
        <span>Question</span>
        <input
          id="ai-probe-question"
          maxLength={400}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <small>Runs through the admin-probe route and records its cost like any other request.</small>
      </label>
      <div className="risk-policy-actions">
        <button className="section-action" disabled={running || question.trim().length === 0} onClick={run} type="button">
          {running ? <LoaderCircle aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
          {running ? "Asking" : "Run probe"}
        </button>
      </div>

      {transportError && <p className="form-error" role="alert">{transportError}</p>}

      {result?.status === "answered" && (
        <div className="ai-probe__result" role="status">
          <dl className="policy-grid">
            <div>
              <dt>Answered by</dt>
              <dd>{result.model ? `${result.providerId}:${result.model}` : result.providerId}</dd>
            </div>
            <div>
              <dt>Fallback from</dt>
              <dd>{result.fallbackFrom ?? "none — the primary answered"}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{result.costMicrosUsd === null ? "unpriced" : `$${(result.costMicrosUsd / 1_000_000).toFixed(6)}`}</dd>
            </div>
          </dl>
          <p className="ai-probe__answer">{result.answer}</p>
          <ul className="ai-probe__attempts">
            {result.attempts.map((attempt, index) => (
              <li key={`${attempt.label}-${index}`}>
                <strong>{attempt.label}</strong> {attempt.outcome.toLowerCase()}
                {attempt.errorCode ? ` (${attempt.errorCode})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.status === "unavailable" && (
        <div className="ai-probe__result" role="alert">
          <p className="form-error">{result.error}</p>
          {result.missingKeys.length > 0 && <p className="form-error">Set {result.missingKeys.join(" and ")}.</p>}
          {result.skipped.length > 0 && (
            <ul className="ai-probe__attempts">
              {result.skipped.map((entry) => (
                <li key={entry.providerId}>
                  <strong>{entry.providerId}</strong> skipped: {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result?.status === "failed" && <p className="form-error" role="alert">{result.error}</p>}
    </div>
  );
}
