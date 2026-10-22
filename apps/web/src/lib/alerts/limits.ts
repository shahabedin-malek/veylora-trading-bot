/**
 * The one active-alert ceiling, shared by the alert route and the screener's
 * "create alerts from this screen" action. Two copies of this number would let
 * the screener create a row the alert endpoint then refuses to create, which is
 * exactly the kind of drift the shared condition model exists to prevent.
 */
export const MAX_ACTIVE_ALERTS_PER_USER = 50;
