import { isDevelopmentMode } from "@/lib/dev-mode/mode";

/**
 * The local development database, mirroring DEFAULT_DEV_DATABASE_URL in
 * `scripts/dev-database.mjs`. A relative SQLite path resolves against the
 * Prisma schema directory, so this is `apps/web/prisma/dev.db`.
 */
export const DEVELOPMENT_DATABASE_URL = "file:./dev.db";

/**
 * The datasource URL, most specific name first.
 *
 * Development falls back to the local SQLite file so a fresh clone reaches a
 * running, seeded app in three commands with no env file at all. Production has
 * no fallback: an unset URL stays unset, and the caller fails closed.
 */
export function resolveDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
) {
  const explicit = environment.DATABASE_URL?.trim() || environment.veylora_DATABASE_URL?.trim();
  if (explicit) return explicit;
  return isDevelopmentMode(environment) ? DEVELOPMENT_DATABASE_URL : undefined;
}
