import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secretlint = path.join(projectRoot, "apps/web/node_modules/.bin/secretlint");
const patterns = [
  "**/*.md",
  "**/*.mdx",
  "**/*.txt",
  "**/*.json",
  "**/*.yml",
  "**/*.yaml",
  "**/*.toml",
  "**/*.js",
  "**/*.mjs",
  "**/*.ts",
  "**/*.tsx",
  "**/*.css",
  "**/*.py",
  "**/*.sh",
  "**/*.html",
];

const result = spawnSync(
  secretlint,
  [...patterns, "--no-color", "--secretlintignore", ".secretlintignore"],
  { cwd: projectRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);

if (result.error) {
  console.error("Secret scan could not start. Install dependencies in apps/web first.");
  process.exit(2);
}

if (result.status === 0) {
  console.log("Secret scan passed.");
} else {
  console.error("Secret scan failed. Findings are masked; inspect the scanner output locally before proceeding.");
  process.exit(result.status ?? 2);
}