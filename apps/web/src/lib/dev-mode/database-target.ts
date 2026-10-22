import { resolveDatabaseUrl } from "@/lib/database-config";
import { isDevelopmentMode, type EnvironmentLike } from "@/lib/dev-mode/mode";

export type DatabaseTargetSource =
  | "DATABASE_URL"
  | "veylora_DATABASE_URL"
  | "development-default"
  | "none";

export type DatabaseTargetDescription = {
  /** Which kind of target development mode resolved. */
  kind: "local-sqlite-file" | "remote" | "unconfigured";
  /** Shown to the developer. Never contains a password, key or full connection string. */
  label: string;
  /** Which name the value came from, so a fallback is not mistaken for real config. */
  source: DatabaseTargetSource;
};

const FILE_PREFIX = "file:";
const SCHEMA_DIRECTORY_NOTE = "resolved inside apps/web/prisma";

/**
 * Reduce a datasource URL to something safe to render: the kind of target and
 * enough to identify which database it is. Credentials, query strings and full
 * connection strings are stripped, and an unparseable value is reported as
 * unparseable rather than echoed back.
 */
export function describeDatabaseTarget(url: string | undefined): DatabaseTargetDescription {
  if (!url?.trim()) {
    return { kind: "unconfigured", label: "No database URL is resolved", source: "none" };
  }

  const trimmed = url.trim();
  if (trimmed.startsWith(FILE_PREFIX)) {
    const path = trimmed.slice(FILE_PREFIX.length);
    return {
      kind: "local-sqlite-file",
      label: path ? `${path} (${SCHEMA_DIRECTORY_NOTE})` : `file with no path (${SCHEMA_DIRECTORY_NOTE})`,
      source: "none",
    };
  }

  try {
    const parsed = new URL(trimmed);
    const database = parsed.pathname.replace(/^\//, "");
    const host = parsed.host || parsed.hostname || "<no host>";
    return { kind: "remote", label: `${host}${database ? ` / ${database}` : ""}`, source: "none" };
  } catch {
    return { kind: "remote", label: "an unrecognized database URL", source: "none" };
  }
}

function resolveSource(environment: EnvironmentLike): DatabaseTargetSource {
  if (environment.DATABASE_URL?.trim()) return "DATABASE_URL";
  if (environment.veylora_DATABASE_URL?.trim()) return "veylora_DATABASE_URL";
  return isDevelopmentMode(environment) ? "development-default" : "none";
}

/**
 * The banner's data: only in development, and only a description that cannot
 * carry a secret.
 *
 * The target is resolved exactly the way the application resolves it, so the
 * banner names the database the app is really reading — including the
 * development fallback. Describing the raw environment instead would report
 * "unconfigured" while the app happily used the local file.
 */
export function getDevelopmentDatabaseDescription(
  environment: EnvironmentLike = process.env,
): DatabaseTargetDescription | null {
  if (!isDevelopmentMode(environment)) return null;
  return { ...describeDatabaseTarget(resolveDatabaseUrl(environment)), source: resolveSource(environment) };
}
