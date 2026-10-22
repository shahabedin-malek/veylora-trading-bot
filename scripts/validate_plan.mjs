#!/usr/bin/env node
/**
 * validate_plan.mjs — read-only checker for the Veylora planning deliverables.
 *
 * It answers three questions about `plan/`:
 *   1. Does every `phase-NN-<slug>.md` file carry all ten required sections?
 *   2. Does the phase index in `PROJECT_TODO.md` match the files on disk?
 *   3. Does any phase file smuggle restriction copy back in — an approval or permission
 *      gate, a confirmation step, a control that stays disabled, or language that stops
 *      the owner's work (see RESTRICTION_PATTERNS)?
 *
 * The restriction check errs towards speaking up rather than staying quiet. A phrase that
 * *asserts* a gate is an error. A line that forbids the copy — and so a "Do not do" bullet,
 * since the brief requires phase files to restate those prohibitions — is an exempt note
 * instead: printed, but not counted as a failure. Gate copy that merely *sits* under
 * "Do not do" while reading as an instruction is still an error. Nothing is silently
 * dropped.
 *
 * It never writes, moves, deletes or reformats anything, and it never gates work: it
 * prints what it found and exits non-zero only when something is actually wrong, so the
 * owner can run it when they want a status report.
 *
 * Usage:
 *   node scripts/validate_plan.mjs                # checks ./plan
 *   node scripts/validate_plan.mjs <plan-dir>     # checks another directory
 *   node scripts/validate_plan.mjs --json         # machine-readable output
 *
 * Exit codes: 0 = clean (or plan not written yet), 1 = errors, 2 = nothing to check.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The ten sections every phase file must carry, with the alternative wordings a planner
 * might reasonably use. Each entry is matched case-insensitively against normalised
 * headings and bold labels, so `## Objective`, `### 1. Objective` and
 * `- **Objective** — text` all satisfy the same requirement.
 */
const REQUIRED_SECTIONS = [
  { name: "Objective", aliases: ["objective"] },
  { name: "Scope", aliases: ["scope"] },
  { name: "Files to touch", aliases: ["files to touch", "files to change", "files touched", "files"] },
  { name: "Requirements", aliases: ["requirements", "requirement"] },
  { name: "Acceptance criteria", aliases: ["acceptance criteria", "acceptance"] },
  { name: "Manual verification (owner click-path)", aliases: ["manual verification", "owner click-path", "click-path"] },
  { name: "Automated verification", aliases: ["automated verification", "automated checks", "automated gate"] },
  { name: "Definition of done", aliases: ["definition of done", "done"] },
  { name: "Rollback", aliases: ["rollback"] },
  { name: "Do not do", aliases: ["do not do", "do-not-do", "don't do", "don'ts", "do nots"] },
];

/**
 * Restriction copy the brief forbids in a phase file (§3 rules 1, 2, 4, 5 and 8, and §7):
 * approval gates, consent steps, confirmation prompts, controls left disabled, and
 * language that stops the owner's work. Each group holds literal phrases and the brief
 * rule it enforces, so a planner can see why a line was flagged.
 */
const RESTRICTION_PATTERNS = [
  {
    id: "approval-gate",
    label: "approval or permission gate",
    reason: "§3 rule 1 — the owner's instruction is the authorization; no approval, consent or permission gate",
    phrases: [
      "approval gate",
      "approval step",
      "approval required",
      "requires approval",
      "require approval",
      "requiring approval",
      "needs approval",
      "need approval",
      "must approve",
      "must be approved",
      "owner approval",
      "admin approval",
      "for approval",
      "awaiting approval",
      "pending approval",
      "until approved",
      "once approved",
      "after approval",
      "sign-off",
      "sign off",
      "permission gate",
      "requires permission",
      "without permission",
      "consent layer",
      "consent step",
      "consent prompt",
      "consent required",
      "needs consent",
      "requires consent",
      "human in the loop",
      "human-in-the-loop",
      "human approval",
      "escalate to the owner",
    ],
  },
  {
    id: "confirmation-step",
    label: "confirmation or pause step",
    reason: "§3 rule 5 and §7 — nothing pauses for confirmation, a warning or a dry run",
    phrases: [
      "confirmation prompt",
      "confirmation step",
      "confirmation dialog",
      "confirmation screen",
      "confirm dialog",
      "ask for confirmation",
      "asks for confirmation",
      "asked for confirmation",
      "ask the owner for confirmation",
      "asks the owner for confirmation",
      "prompt for confirmation",
      "prompts for confirmation",
      "waits for confirmation",
      "await confirmation",
      "confirmation from the owner",
      "must be confirmed",
      "until it is confirmed",
      "are you sure",
      "requires confirmation",
      "require confirmation",
      "requiring confirmation",
      "confirm before proceeding",
      "must be confirmed before",
      "dry-run",
      "dry run",
      "warning gate",
      "pre-flight check",
    ],
  },
  {
    id: "deferred-control",
    label: "control left disabled, hidden or dead",
    reason: "§3 rule 2 and §5 — no phase may end with a dead, unreachable or silently disabled control",
    phrases: [
      "stays disabled",
      "stay disabled",
      "remains disabled",
      "remain disabled",
      "left disabled",
      "kept disabled",
      "silently disabled",
      "disabled until phase",
      "disabled until the phase",
      "hidden until phase",
      "unreachable until",
      "locked until phase",
      "coming soon",
      "coming in a later phase",
      "temporarily removed",
      "wired up later",
    ],
  },
  {
    id: "blocking-language",
    label: "language that stops the owner's work",
    reason: "§3 rule 4 — an agent working from this plan never stops the owner's request",
    phrases: [
      "cannot proceed without",
      "can not proceed without",
      "may not proceed",
      "blocked pending",
      "blocks the owner",
      "block the owner",
      "prevents the owner from",
      "prevent the owner from",
      "stops the owner",
      "stop the owner",
      "await owner confirmation",
      "await owner decision",
      "awaiting owner",
      "awaiting the owner",
      "wait for the owner",
      "waits for the owner",
      "wait for owner",
      "must wait for",
    ],
  },
  {
    id: "policy-refusal",
    label: "AI-authored policy or refusal",
    reason: "§3 rules 1, 4 and 8 — policy belongs to the owner, written in the admin panel",
    phrases: [
      "policy file",
      "guard list",
      "policy prose",
      "compliance gate",
      "safety gate",
      "refuse the request",
      "refuses the request",
      "decline the request",
      "refuses the owner",
      "refuse the owner",
    ],
  },
];

/**
 * A matched line that forbids the copy ("do not add an approval gate") is legitimate:
 * the brief requires every phase file to restate these prohibitions. Such hits become
 * exempt notes. Negation cues are deliberately broad — the cost of a false exemption is a
 * line that is still printed for the owner to read, while the cost of a false error is a
 * checker the planner stops trusting.
 */
const PROHIBITION_CUES =
  /\b(?:no|not|never|without|isn'?t|aren'?t|don'?t|doesn'?t|do not|does not|must not|mustn'?t|avoid|avoids|avoided|instead of|rather than|out of scope|exclude|excludes|excluded|free of|absent|none|nothing|besides|apart from|removal of)\b/i;

const PHASE_FILE = /^phase-(\d+)-([a-z0-9][a-z0-9.-]*)\.md$/i;

/** Human output prints this many notes before summarising the rest; --json has them all. */
const NOTES_PRINT_LIMIT = 25;

function escapePhrase(phrase) {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
}

/**
 * Each phrase tolerates a plural "s", so "approval gates" and "guard lists" are caught
 * alongside the singular forms.
 */
const COMPILED_RESTRICTIONS = RESTRICTION_PATTERNS.map((rule) => ({
  ...rule,
  matcher: new RegExp(`\\b(?:${rule.phrases.map((phrase) => `${escapePhrase(phrase)}s?`).join("|")})\\b`, "gi"),
}));

const DO_NOT_DO = REQUIRED_SECTIONS.find((section) => section.name === "Do not do");

/**
 * Restriction copy in one phase file, split into hits that assert a restriction and hits
 * that merely mention one while forbidding it. Fenced code blocks are skipped.
 */
function scanRestrictionCopy(source) {
  const { found, lines } = collectSections(source);
  const blocking = [];
  const exempt = [];
  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // Every distinct phrase on the line is reported, not just the first, so a line listing
    // several restrictions cannot hide one behind another.
    const hits = COMPILED_RESTRICTIONS.flatMap((rule) =>
      [...line.matchAll(rule.matcher)].map((match) => ({ rule, phrase: match[0].replace(/\s+/g, " ") })),
    );
    if (hits.length === 0) return;

    const section = [...found].reverse().find((item) => item.line <= index);
    const sectionKey = section ? normalise(section.label) : "";
    const insideDoNotDo = (DO_NOT_DO?.aliases ?? []).some((alias) => sectionKey.includes(normalise(alias)));
    const statesProhibition = PROHIBITION_CUES.test(line);

    for (const hit of hits) {
      const entry = {
        line: index + 1,
        phrase: hit.phrase,
        rule: hit.rule.id,
        label: hit.rule.label,
        reason: hit.rule.reason,
        section: section?.label ?? "(before any section)",
        text: line.trim().slice(0, 160),
      };

      // A line is exempt only when it actually reads as a prohibition. Being filed under
      // "Do not do" is not enough on its own: gate copy asserted *inside* that section is
      // an instruction wearing an anti-pattern heading, so it is flagged.
      if (statesProhibition) {
        exempt.push({ ...entry, why: insideDoNotDo ? "inside the Do not do section" : "the line forbids this copy" });
      } else if (insideDoNotDo) {
        blocking.push({ ...entry, hint: "sits in the Do not do section but does not read as a prohibition" });
      } else {
        blocking.push(entry);
      }
    }
  });

  return { blocking, exempt };
}

function normalise(text) {
  return text
    .replace(/[`*_#]/g, " ")
    .replace(/[–—]/g, " ")
    .replace(/[^\p{L}\p{N}()\-/ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Collect every candidate section label in a document: markdown headings and bold
 * labels (bare or as the lead of a list item), each with any text that follows it on the
 * same line so inline sections are not reported as empty.
 */
function collectSections(source) {
  const found = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    const bold = line.match(/^\s{0,3}(?:[-*+]\s+)?(?:\d+[.)]\s+)?\*\*(.+?)\*\*\s*(.*)$/);
    if (heading) {
      found.push({ label: heading[2], inline: "", line: index, style: "heading" });
    } else if (bold) {
      found.push({ label: bold[1], inline: bold[2] ?? "", line: index, style: "bold" });
    }
  });
  return { found, lines };
}

/** Body text belonging to a section: the rest of its line plus lines until the next label. */
function sectionBody(source, section) {
  const { found, lines } = collectSections(source);
  const position = found.findIndex((item) => item.line === section.line && item.label === section.label);
  if (position === -1) return "";
  const next = found[position + 1];
  const body = [section.inline, ...lines.slice(section.line + 1, next ? next.line : lines.length)].join("\n");
  return body.replace(/^\s*(?:[-*+]\s*)?\*\*\s*$/, "").trim();
}

/** Which of the ten required sections this document is missing, and which are empty. */
function inspectPhaseFile(source) {
  const { found } = collectSections(source);
  const normalised = found.map((item) => ({ item, key: normalise(item.label) }));
  const missing = [];
  const empty = [];
  const matched = new Set();

  for (const section of REQUIRED_SECTIONS) {
    const aliases = section.aliases.map(normalise);
    const hit = normalised.find(({ key }) => aliases.some((alias) => key === alias || key.includes(alias)));
    if (!hit) {
      missing.push(section.name);
      continue;
    }
    matched.add(hit.key);
    if (!sectionBody(source, hit.item)) empty.push(section.name);
  }

  return { missing, empty, labels: found.map((item) => item.label) };
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const planDirArg = args.find((argument) => !argument.startsWith("-"));
  const planDir = path.resolve(REPO_ROOT, planDirArg ?? "plan");

  const errors = [];
  const warnings = [];
  const notes = [];

  if (!existsSync(planDir)) {
    const message = `plan directory not found: ${planDir}`;
    if (jsonOutput) console.log(JSON.stringify({ planDir, errors: [message], warnings: [] }, null, 2));
    else console.error(`ERROR ${message}`);
    return 2;
  }

  const todoPath = path.join(planDir, "PROJECT_TODO.md");
  const entries = readdirSync(planDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const phaseFiles = entries
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().startsWith("phase-") && name.toLowerCase().endsWith(".md"))
    .sort();

  const malformed = phaseFiles.filter((name) => !PHASE_FILE.test(name));
  for (const name of malformed) errors.push(`${name}: does not match phase-NN-<slug>.md`);

  const numbered = phaseFiles
    .map((name) => ({ name, match: name.match(PHASE_FILE) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ name: entry.name, number: Number(entry.match[1]) }));

  const seenNumbers = new Map();
  for (const { name, number } of numbered) {
    if (seenNumbers.has(number)) errors.push(`phase ${number} appears twice: ${seenNumbers.get(number)} and ${name}`);
    else seenNumbers.set(number, name);
  }

  const numbers = [...seenNumbers.keys()].sort((a, b) => a - b);
  for (let index = 1; index < numbers.length; index += 1) {
    const gap = numbers[index] - numbers[index - 1];
    if (gap > 1) warnings.push(`phase numbers skip ${numbers[index - 1] + 1}..${numbers[index] - 1}`);
  }
  if (numbers.length > 0 && numbers[0] !== 1) warnings.push(`phase numbering starts at ${numbers[0]}, not 1`);

  if (!existsSync(todoPath)) {
    if (phaseFiles.length > 0) {
      errors.push("PROJECT_TODO.md is missing while phase files exist");
    } else {
      notes.push(`plan not written yet: no phase files and no PROJECT_TODO.md in ${planDir}`);
      if (jsonOutput)
        console.log(
          JSON.stringify(
            {
              planDir,
              phaseFiles: 0,
              clean: true,
              restrictions: { blocking: [], exempt: [] },
              notes,
              errors,
              warnings,
            },
            null,
            2,
          ),
        );
      else console.log(notes.join("\n"));
      return 0;
    }
  }

  const incomplete = [];
  const restrictionBlocking = [];
  const restrictionExempt = [];
  for (const { name } of numbered) {
    const source = readFileSync(path.join(planDir, name), "utf8");
    const { missing, empty } = inspectPhaseFile(source);
    if (missing.length > 0) errors.push(`${name}: missing section(s) ${missing.join(", ")}`);
    if (empty.length > 0) warnings.push(`${name}: empty section(s) ${empty.join(", ")}`);
    if (missing.length > 0 || empty.length > 0) incomplete.push({ name, missing, empty });

    const { blocking, exempt } = scanRestrictionCopy(source);
    for (const hit of blocking) {
      restrictionBlocking.push({ file: name, ...hit });
      errors.push(
        `${name}:${hit.line}: restriction copy "${hit.phrase}" (${hit.label}) — ${hit.reason}${
          hit.hint ? ` [${hit.hint}]` : ""
        }`,
      );
    }
    for (const hit of exempt) {
      restrictionExempt.push({ file: name, ...hit });
      notes.push(`${name}:${hit.line}: restriction copy "${hit.phrase}" exempted — ${hit.why}`);
    }
  }

  let indexNames = [];
  if (existsSync(todoPath)) {
    const todo = readFileSync(todoPath, "utf8");
    indexNames = [...new Set(todo.match(/phase-\d+-[a-z0-9][a-z0-9.-]*\.md/gi) ?? [])].sort();
    const onDisk = new Set(numbered.map((entry) => entry.name));
    const inIndex = new Set(indexNames);

    for (const name of indexNames) {
      if (!onDisk.has(name)) errors.push(`PROJECT_TODO.md lists ${name}, which is not on disk`);
    }
    for (const { name } of numbered) {
      if (!inIndex.has(name)) errors.push(`${name} is on disk but absent from the PROJECT_TODO.md phase index`);
    }
    if (numbers.length > 0 && inIndex.size === 0) warnings.push("PROJECT_TODO.md contains no phase index entries");
  }

  const report = {
    planDir,
    phaseFiles: numbered.length,
    phaseNumbers: numbers,
    indexEntries: indexNames.length,
    sectionsRequired: REQUIRED_SECTIONS.map((section) => section.name),
    restrictionRules: RESTRICTION_PATTERNS.map((rule) => rule.id),
    restrictions: { blocking: restrictionBlocking, exempt: restrictionExempt },
    incomplete,
    errors,
    warnings,
    notes,
    clean: errors.length === 0,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Validating ${numbered.length} phase file(s) in ${planDir}`);
    if (phaseFiles.length === 0) notes.push("no phase files yet");
    for (const { name, missing, empty } of incomplete) {
      console.log(`  ${name}: ${missing.length === 0 ? "" : `missing ${missing.join(", ")}`}${missing.length > 0 && empty.length > 0 ? "; " : ""}${empty.length === 0 ? "" : `empty ${empty.join(", ")}`}`);
    }
    for (const note of notes.slice(0, NOTES_PRINT_LIMIT)) console.log(`note: ${note}`);
    if (notes.length > NOTES_PRINT_LIMIT) {
      console.log(`note: …and ${notes.length - NOTES_PRINT_LIMIT} more note(s) — use --json for the full list`);
    }
    for (const warning of warnings) console.log(`warn: ${warning}`);
    for (const error of errors) console.log(`ERROR: ${error}`);
    console.log(
      errors.length === 0
        ? `OK — ${numbered.length} phase file(s), index entries ${indexNames.length}, ${restrictionBlocking.length} restriction hit(s), ${warnings.length} warning(s)`
        : `${errors.length} error(s), ${warnings.length} warning(s), ${restrictionBlocking.length} restriction hit(s)`,
    );
  }

  return errors.length === 0 ? 0 : 1;
}

process.exitCode = main();
