import { isDevelopmentMode, type EnvironmentLike } from "@/lib/dev-mode/mode";

/**
 * Raw error text is a development affordance, not a product behaviour.
 *
 * Production keeps the stable, generic sentence callers already relied on. In
 * development the underlying message is appended, because a value that could not
 * be fetched should say why — otherwise the only way to find out is a debugger.
 */
export function developmentDetail(
  error: unknown,
  fallback: string,
  environment: EnvironmentLike = process.env,
): string {
  if (!isDevelopmentMode(environment)) return fallback;

  if (error instanceof Error && error.message.trim()) return `${fallback} — ${error.message.trim()}`;
  if (typeof error === "string" && error.trim()) return `${fallback} — ${error.trim()}`;
  return fallback;
}
