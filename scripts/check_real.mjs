import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "apps/web/src");
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".css"]);
// Fabricated-data markers. Honest, self-labeled usages are intentionally allowed:
// "paper trading" and "simulated" describe the sandbox engine features, and
// "placeholder" is a standard HTML form attribute.
const bannedPattern = /\b(?:fake|mock|dummy|sample|sandbox|testnet|demo)\b/gi;
const urlPattern = /\b(?:https?|wss?):\/\/[^\s"'`<>]+/g;

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

export function findBannedTerms(source) {
  return [...source.matchAll(bannedPattern)].map((match) => match[0].toLowerCase());
}

export function validateProductionUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid endpoint URL";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") {
    return "endpoint must use HTTPS or secure WebSocket";
  }

  if (/testnet|sandbox|paper|localhost|127\.0\.0\.1/i.test(`${parsed.hostname}${parsed.pathname}`)) {
    return "endpoint targets a non-production network";
  }

  return null;
}

async function main() {
  const files = await listSourceFiles(sourceRoot);
  const failures = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relativePath = path.relative(projectRoot, file);

    if (findBannedTerms(source).length > 0) {
      failures.push(`${relativePath}: prohibited demo/fabricated-data marker`);
    }

    if (!/\.(?:test|spec)\.[^.]+$/i.test(relativePath)) {
      for (const endpoint of source.match(urlPattern) ?? []) {
        const error = validateProductionUrl(endpoint);
        if (error) failures.push(`${relativePath}: ${error}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Realness check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Realness check passed (${files.length} application source files; no non-production or insecure URLs).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}