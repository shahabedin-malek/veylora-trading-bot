/**
 * Email delivery over Resend's HTTP API (phase 29).
 *
 * Chosen because the whole channel is one POST with one API key: no SDK, no template or
 * workflow to keep in sync, and nothing to install in a build that already runs on fetch.
 * The key, sender and recipient are environment variables by name — `RESEND_API_KEY`,
 * `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` — and none of them is ever stored, logged or
 * returned. A missing one is reported by name, so an unconfigured channel reads as
 * unconfigured rather than as a quiet day.
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */

export const EMAIL_PROVIDER_ID = "resend";
const DEFAULT_RESEND_BASE_URL = "https://api.resend.com";

/**
 * The endpoint, with an optional base override for a local stand-in. The override exists so
 * a failure and its retries can be proven against a stub without a real key; it is not a
 * credential and changes nothing about which provider is used.
 */
function resendEndpoint(env: Record<string, string | undefined>): string {
  const base = env.RESEND_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_RESEND_BASE_URL;
  return `${base}/emails`;
}

type Environment = Record<string, string | undefined>;

export type EmailConfiguration = {
  configured: boolean;
  apiKey: string | null;
  from: string | null;
  to: string | null;
  /** Variables that are unset or unusable, by name. Never their values. */
  missing: string[];
  maskedTo: string | null;
};

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function readEmailConfiguration(env: Environment = process.env): EmailConfiguration {
  const apiKey = env.RESEND_API_KEY?.trim() || null;
  const from = env.ALERT_EMAIL_FROM?.trim() || null;
  const to = env.ALERT_EMAIL_TO?.trim() || null;
  const missing: string[] = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from || !ADDRESS.test(from)) missing.push("ALERT_EMAIL_FROM");
  if (!to || !ADDRESS.test(to)) missing.push("ALERT_EMAIL_TO");
  return {
    configured: missing.length === 0,
    apiKey,
    from,
    to,
    missing,
    maskedTo: to && ADDRESS.test(to) ? maskEmail(to) : null,
  };
}

/** `owner@example.com` → `o***@example.com`. Enough to recognise, not enough to harvest. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

type SendResultBody =
  | { ok: true; providerId: string; providerMessageId: string }
  | { ok: false; providerId: string; error: string; retryable: boolean };

export type SendResult = SendResultBody & { durationMs: number };

export type EmailMessage = { subject: string; text: string };

/**
 * Send one email. The provider's own sentence is surfaced (a refused key and a rate limit
 * need different actions) but the request — and therefore the key — never is.
 */
export async function sendEmailNotification(
  message: EmailMessage,
  options: { env?: Environment; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<SendResult> {
  const config = readEmailConfiguration(options.env ?? process.env);
  const started = (options.now ?? Date.now)();
  const finish = (result: SendResultBody): SendResult => ({
    ...result,
    durationMs: Math.max(0, (options.now ?? Date.now)() - started),
  });

  if (!config.configured || !config.apiKey || !config.from || !config.to) {
    return finish({
      ok: false,
      providerId: EMAIL_PROVIDER_ID,
      error: `Email is not configured: ${config.missing.join(", ")} is not set, so nothing was sent.`,
      retryable: false,
    });
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(resendEndpoint(options.env ?? process.env), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [config.to],
        subject: message.subject,
        text: message.text,
      }),
    });
  } catch (cause) {
    return finish({
      ok: false,
      providerId: EMAIL_PROVIDER_ID,
      error: `Resend could not be reached: ${cause instanceof Error ? cause.message : "network error"}`,
      retryable: true,
    });
  }

  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const description = providerMessage(payload) ?? `Resend answered HTTP ${response.status}.`;
    return finish({
      ok: false,
      providerId: EMAIL_PROVIDER_ID,
      error: description,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const id = isRecord(payload) && typeof payload.id === "string" ? payload.id : null;
  if (!id) {
    return finish({
      ok: false,
      providerId: EMAIL_PROVIDER_ID,
      error: "Resend accepted the request but returned no message id, so delivery is unconfirmed.",
      retryable: false,
    });
  }
  return finish({ ok: true, providerId: EMAIL_PROVIDER_ID, providerMessageId: id });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (message && name) return `${name}: ${message}`;
  return message || name || null;
}
