/**
 * The longest new-address hold this build stores, in minutes.
 *
 * Kept apart from `settings.ts` because the admin form shows the bound and is a
 * client component, while `settings.ts` writes audit rows and therefore pulls in
 * the server-only writer. One number in its own module keeps the browser bundle
 * free of `node:crypto` and `node:async_hooks`.
 */
export const MAX_NEW_ADDRESS_WINDOW_MINUTES = 7 * 24 * 60;
