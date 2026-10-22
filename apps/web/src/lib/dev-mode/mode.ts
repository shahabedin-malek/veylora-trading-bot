/**
 * Development mode is an explicit switch, not "not production".
 *
 * Behind `NODE_ENV !== "production"` a test run, a build and a stray script would
 * all count as development and start seeding in-process state or printing raw
 * errors. Requiring the exact value keeps the development-only behaviour pinned
 * to the one mode it is meant for.
 */
/** Anything that can answer `NODE_ENV`, so pure helpers stay easy to test. */
export type EnvironmentLike = Record<string, string | undefined>;

export function isDevelopmentMode(environment: EnvironmentLike = process.env): boolean {
  return environment.NODE_ENV === "development";
}
