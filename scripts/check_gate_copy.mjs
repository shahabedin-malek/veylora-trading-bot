import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copyRoot = path.join(projectRoot, "apps/web/src");
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

/**
 * User-facing restriction copy that must not appear in the app. Each entry is a
 * plain, case-insensitive substring, so ordinary vocabulary is never caught by
 * accident (`gated` would match `aggregated`, `delegated`; none of these do).
 *
 * Adding a phrase here is a claim that the copy must stay out of the product. If
 * a hit is genuinely wanted as new product policy, change the copy or amend this
 * list deliberately.
 */
export const GATE_PHRASES = [
  // chain + auth gate
  "not approved for authentication",
  "separately approved",
  // Also covers "requires separate approval".
  "requires separate",
  // Sign-in must not describe a single approved chain.
  "single approved",
  "approved authentication chain",
  "approved mainnet authentication chain",
  "approved evm mainnet chain",
  "approved evm wallet provider",

  // venue / endpoint / permission gate copy
  "owner approval",
  "board decision",
  "read only",
  "all off by default",

  // assistant scope claims
  "no tools available",
  "no tools are available",
  "only public market data",
  "only discuss",
  "advisory-only",

  // single-network claim
  "only ethereum",

  // withdrawal + execution gate copy
  "withdrawals remain disabled",
  "withdrawals are not enabled",
  "arm live trading",
  "execution: off",
  "wallet connection alone cannot enable orders",
];

/** Test files may quote removed copy on purpose (e.g. to assert it is gone). */
export function isTestFile(relativePath) {
  return /\.(?:test|spec)\.[^.]+$/i.test(relativePath);
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every distinct gate phrase present anywhere in `source`. */
export function findGateCopy(source) {
  const flat = normalize(source);
  return GATE_PHRASES.filter((phrase) => flat.includes(phrase));
}

/**
 * Gate phrases with the first line they appear on. Each line is matched together
 * with its successor so copy wrapped across JSX lines is still caught.
 */
export function findGateCopyLines(source) {
  const lines = source.split("\n");
  const hits = new Map();

  lines.forEach((line, index) => {
    const window = normalize(`${line} ${lines[index + 1] ?? ""}`);
    for (const phrase of GATE_PHRASES) {
      if (!window.includes(phrase)) continue;
      hits.set(`${index + 1}:${phrase}`, { line: index + 1, phrase, text: line.trim() });
    }
  });

  return [...hits.values()];
}

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

export async function scanAppCopy(root = copyRoot) {
  const files = await listSourceFiles(root);
  const failures = [];

  for (const file of files) {
    const relativePath = path.relative(projectRoot, file);
    if (isTestFile(relativePath)) continue;

    const source = await readFile(file, "utf8");
    for (const { line, phrase, text } of findGateCopyLines(source)) {
      failures.push({ file: relativePath, line, phrase, text });
    }
    // Catch copy split across more than two lines.
    for (const phrase of findGateCopy(source)) {
      if (!failures.some((failure) => failure.file === relativePath && failure.phrase === phrase)) {
        failures.push({ file: relativePath, line: null, phrase, text: "" });
      }
    }
  }

  return failures;
}

async function main() {
  const failures = await scanAppCopy();

  if (failures.length > 0) {
    console.error("Gate-copy check failed — removed restriction copy reappeared:");
    for (const { file, line, phrase } of failures) {
      console.error(`- ${file}${line ? `:${line}` : ""}: "${phrase}"`);
    }
    console.error(
      "\nReword the copy, or amend GATE_PHRASES in scripts/check_gate_copy.mjs.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Gate-copy check passed (${GATE_PHRASES.length} phrases; no removed restriction copy in app sources).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
