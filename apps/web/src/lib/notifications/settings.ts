import { prisma } from "@/lib/db";
import { readEmailConfiguration } from "./email";
import { readTelegramConfiguration } from "./telegram";
import { auditCreate } from "@/lib/audit/record";

type Environment = Record<string, string | undefined>;

/**
 * The notification switchboard (phase 29).
 *
 * Three channels, each switched independently, plus quiet hours and the cooldown a new rule
 * starts with. The switches are data because turning email on is the owner's statement that
 * their own credentials are in place; the credentials themselves are environment variables
 * and are never stored, returned or rendered here.
 */

export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL", "TELEGRAM"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const MAX_DEFAULT_COOLDOWN_MINUTES = 10_080;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type NotificationSettings = {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  telegramEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  defaultCooldownMinutes: number;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  inAppEnabled: true,
  emailEnabled: false,
  telegramEnabled: false,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  defaultCooldownMinutes: 60,
};

export type NotificationSettingsValidation =
  | { valid: true; value: NotificationSettings }
  | { valid: false; error: string };

const SETTING_KEYS = Object.keys(DEFAULT_NOTIFICATION_SETTINGS) as (keyof NotificationSettings)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectNotificationSettings(row: Record<string, unknown>): NotificationSettings {
  return {
    inAppEnabled: row.inAppEnabled === true,
    emailEnabled: row.emailEnabled === true,
    telegramEnabled: row.telegramEnabled === true,
    quietHoursEnabled: row.quietHoursEnabled === true,
    quietHoursStart: typeof row.quietHoursStart === "string" ? row.quietHoursStart : DEFAULT_NOTIFICATION_SETTINGS.quietHoursStart,
    quietHoursEnd: typeof row.quietHoursEnd === "string" ? row.quietHoursEnd : DEFAULT_NOTIFICATION_SETTINGS.quietHoursEnd,
    defaultCooldownMinutes:
      typeof row.defaultCooldownMinutes === "number" ? row.defaultCooldownMinutes : DEFAULT_NOTIFICATION_SETTINGS.defaultCooldownMinutes,
  };
}

/**
 * A closed set of booleans, two 24-hour clock times and a bounded whole number. Anything
 * else is refused, rather than ignored: a string `"true"` read as enabled is exactly how a
 * channel ends up somewhere nobody chose.
 */
export function validateNotificationSettings(value: unknown): NotificationSettingsValidation {
  if (!isRecord(value)) return { valid: false, error: "Notification settings must be an object." };
  if (Object.keys(value).some((key) => !SETTING_KEYS.includes(key as keyof NotificationSettings))) {
    return { valid: false, error: "One or more notification settings are unsupported." };
  }
  for (const key of ["inAppEnabled", "emailEnabled", "telegramEnabled", "quietHoursEnabled"] as const) {
    if (typeof value[key] !== "boolean") return { valid: false, error: `${key} must be enabled or disabled.` };
  }
  for (const key of ["quietHoursStart", "quietHoursEnd"] as const) {
    if (typeof value[key] !== "string" || !HHMM.test(value[key] as string)) {
      return { valid: false, error: `${key} must be a 24-hour UTC time such as 22:00.` };
    }
  }
  const cooldown = value.defaultCooldownMinutes;
  if (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 1 || cooldown > MAX_DEFAULT_COOLDOWN_MINUTES) {
    return { valid: false, error: `defaultCooldownMinutes must be a whole number between 1 and ${MAX_DEFAULT_COOLDOWN_MINUTES}.` };
  }
  return {
    valid: true,
    value: selectNotificationSettings(value),
  };
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await prisma.notificationChannelSettings.findUnique({ where: { id: "global" } });
  if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  return selectNotificationSettings(row as unknown as Record<string, unknown>);
}

export async function saveNotificationSettings(
  settings: NotificationSettings,
  actorUserId: string,
): Promise<NotificationSettings> {
  const validation = validateNotificationSettings(settings);
  if (!validation.valid) throw new Error("Notification settings failed validation.");
  const safe = validation.value;

  return prisma.$transaction(async (transaction) => {
    const before = await transaction.notificationChannelSettings.findUnique({ where: { id: "global" } });
    const saved = await transaction.notificationChannelSettings.upsert({
      where: { id: "global" },
      create: { id: "global", ...safe, updatedByUserId: actorUserId },
      update: { ...safe, updatedByUserId: actorUserId },
    });
    await auditCreate(transaction, {
      data: {
        actorUserId,
        action: "NOTIFICATION_SETTINGS_UPDATED",
        objectType: "NotificationChannelSettings",
        objectId: "global",
        outcome: "SUCCESS",
        redactedJson: JSON.stringify({
          before: before ? selectNotificationSettings(before as unknown as Record<string, unknown>) : null,
          after: safe,
        }),
      },
    });
    return selectNotificationSettings(saved as unknown as Record<string, unknown>);
  });
}

/**
 * What each channel can do right now, as the panel and the admin form show it.
 *
 * A disabled channel is shown as OFF, not hidden. An enabled channel whose credentials are
 * missing is shown as NOT CONFIGURED with the exact variable names to set — the same refusal
 * shape every other surface in this app uses, and the reason a misconfiguration cannot look
 * like a quiet day.
 */
export type NotificationChannelView = {
  id: NotificationChannel;
  label: string;
  enabled: boolean;
  configured: boolean;
  missingVariables: string[];
  state: "READY" | "OFF" | "NOT_CONFIGURED";
  message: string;
};

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: "In-app",
  EMAIL: "Email",
  TELEGRAM: "Telegram",
};

export function notificationChannelViews(
  settings: NotificationSettings,
  env: Environment = process.env,
): NotificationChannelView[] {
  const email = readEmailConfiguration(env);
  const telegram = readTelegramConfiguration(env);
  const enabled: Record<NotificationChannel, boolean> = {
    IN_APP: settings.inAppEnabled,
    EMAIL: settings.emailEnabled,
    TELEGRAM: settings.telegramEnabled,
  };
  const configuration: Record<NotificationChannel, { configured: boolean; missing: string[]; ready: string }> = {
    IN_APP: { configured: true, missing: [], ready: "Alerts appear in this panel and stay until deleted." },
    EMAIL: {
      configured: email.configured,
      missing: email.missing,
      ready: `Email is sent through Resend to ${email.maskedTo ?? "the configured address"}.`,
    },
    TELEGRAM: {
      configured: telegram.configured,
      missing: telegram.missing,
      ready: telegram.maskedChatId ? `Telegram messages the configured chat ${telegram.maskedChatId}.` : "Telegram is ready.",
    },
  };

  return NOTIFICATION_CHANNELS.map((id) => {
    const channel = configuration[id];
    const isEnabled = enabled[id];
    const state = !isEnabled ? "OFF" : channel.configured ? "READY" : "NOT_CONFIGURED";
    const message = state === "OFF"
      ? `${NOTIFICATION_CHANNEL_LABELS[id]} delivery is switched off in the admin channel settings.`
      : state === "NOT_CONFIGURED"
        ? `${NOTIFICATION_CHANNEL_LABELS[id]} is enabled but ${channel.missing.join(", ") || "its configuration"} is not set, so nothing can be delivered on it.`
        : channel.ready;
    return {
      id,
      label: NOTIFICATION_CHANNEL_LABELS[id],
      enabled: isEnabled,
      configured: channel.configured,
      missingVariables: channel.configured ? [] : channel.missing,
      state,
      message,
    };
  });
}
