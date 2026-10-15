export function resolveDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
) {
  return environment.DATABASE_URL?.trim() || environment.veylora_DATABASE_URL?.trim();
}