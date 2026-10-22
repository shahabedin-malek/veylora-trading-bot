/**
 * Telegram delivery through the Bot API (phase 29).
 *
 * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are environment variables by name. The token
 * travels in the request URL, which is the one place it could leak into a log line or an
 * error message, so every string this module returns is passed through `redactToken` first.
 * A missing variable is reported by name; the value never appears anywhere.
 *
 * Docs: https://core.telegram.org/bots/api#sendmessage
 */

export const TELEGRAM_PROVIDER_ID = "telegram";
const DEFAULT_TELEGRAM_BASE_URL = "https://api.telegram.org";

/** Optional base override, for proving failures against a local stand-in. */
function telegramEndpoint(env: Record<string, string | undefined>, token: string): string {
  const base = env.TELEGRAM_API_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_TELEGRAM_BASE_URL;
  return `${base}/bot${token}/sendMessage`;
}

type Environment = Record<string, string | undefined>;

export type TelegramConfiguration = {
  configured: boolean;
  token: string | null;
  chatId: string | null;
  missing: string[];
  maskedChatId: string | null;
};

export function readTelegramConfiguration(env: Environment = process.env): TelegramConfiguration {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || null;
  const missing: string[] = [];
  if (!token) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("TELEGRAM_CHAT_ID");
  return {
    configured: missing.length === 0,
    token,
    chatId,
    missing,
    maskedChatId: chatId ? maskChatId(chatId) : null,
  };
}

/**
 * A chat id is not a secret in the way a token is, but it identifies the owner's account,
 * so the log keeps only the last four characters: `***1234`.
 */
export function maskChatId(chatId: string): string {
  const trimmed = chatId.trim();
  return trimmed.length <= 4 ? "***" : `***${trimmed.slice(-4)}`;
}

/** Remove the bot token from any text that might be logged or returned. */
export function redactToken(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

type SendResultBody =
  | { ok: true; providerId: string; providerMessageId: string }
  | { ok: false; providerId: string; error: string; retryable: boolean };

export type SendResult = SendResultBody & { durationMs: number };

export type TelegramMessage = { subject: string; text: string };

export async function sendTelegramNotification(
  message: TelegramMessage,
  options: { env?: Environment; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<SendResult> {
  const config = readTelegramConfiguration(options.env ?? process.env);
  const started = (options.now ?? Date.now)();
  const finish = (result: SendResultBody): SendResult => {
    const durationMs = Math.max(0, (options.now ?? Date.now)() - started);
    return result.ok
      ? { ...result, durationMs }
      : { ...result, error: redactToken(result.error, config.token), durationMs };
  };

  if (!config.configured || !config.token || !config.chatId) {
    return finish({
      ok: false,
      providerId: TELEGRAM_PROVIDER_ID,
      error: `Telegram is not configured: ${config.missing.join(", ")} is not set, so nothing was sent.`,
      retryable: false,
    });
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(telegramEndpoint(options.env ?? process.env, config.token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: `${message.subject}\n\n${message.text}`,
        disable_web_page_preview: true,
      }),
    });
  } catch (cause) {
    return finish({
      ok: false,
      providerId: TELEGRAM_PROVIDER_ID,
      error: `Telegram could not be reached: ${cause instanceof Error ? cause.message : "network error"}`,
      retryable: true,
    });
  }

  const payload = await response.json().catch(() => null) as unknown;
  const ok = isRecord(payload) && payload.ok === true;
  if (!response.ok || !ok) {
    const description = isRecord(payload) && typeof payload.description === "string"
      ? payload.description.trim()
      : `Telegram answered HTTP ${response.status}.`;
    return finish({
      ok: false,
      providerId: TELEGRAM_PROVIDER_ID,
      error: description,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
  const messageId = result && (typeof result.message_id === "number" || typeof result.message_id === "string")
    ? String(result.message_id)
    : null;
  if (!messageId) {
    return finish({
      ok: false,
      providerId: TELEGRAM_PROVIDER_ID,
      error: "Telegram accepted the request but returned no message id, so delivery is unconfirmed.",
      retryable: false,
    });
  }
  return finish({ ok: true, providerId: TELEGRAM_PROVIDER_ID, providerMessageId: messageId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
