#!/usr/bin/env python3
"""Generate a value-redacted read-only triage of old-scripts/ sources."""
from __future__ import annotations

import ast
import math
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Legacy reference trees live beside the project, not inside it.
EXTERNAL_DATA = Path(os.environ.get("VEYLORA_EXTERNAL_DATA", "/mnt/private-ai-data/trading"))
SOURCE = EXTERNAL_DATA / "old-scripts"
OUTPUT = ROOT / "docs/SCRIPTS_TRIAGE.md"
EXTENSIONS = {".py", ".sh", ".ps1"}
SECRET_NAME = re.compile(r"(?i)(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|wallet[_-]?secret|mnemonic|seed[_-]?phrase|credential|auth[_-]?token)")
PLACEHOLDER = re.compile(r"(?i)(your[_ -]|example|placeholder|redacted|change.?me|\$\{|\{\{|<[^>]+>|xxxxx|dummy|fake|test[_ -]?)")
KNOWN_SECRET_SHAPES = re.compile(rb"(?i)(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,})\b)")
DESTRUCTIVE = re.compile(r"(?i)(?:shutil\.rmtree|\.unlink\(|os\.remove|os\.rename|os\.replace|\brm\s+-rf\b|Remove-Item.{0,80}-Recurse|DROP\s+TABLE|TRUNCATE\s+TABLE|\.reset\s+--hard|git\s+clean\s+-fd)")
SHELL_EXEC = re.compile(r"(?i)(?:subprocess\.(?:run|Popen|call)|os\.system|shell\s*=\s*True|Invoke-Expression|\beval\()")


def likely_secret_value(value: str) -> bool:
    value = value.strip().strip("\"'` ")
    if len(value) < 18 or PLACEHOLDER.search(value):
        return False
    if value.startswith(("os.getenv(", "os.environ", "process.env", "${", "$env:")):
        return False
    if not re.search(r"[A-Za-z]", value) or not re.search(r"[0-9+/=_-]", value):
        return False
    entropy = -sum((value.count(ch) / len(value)) * math.log2(value.count(ch) / len(value)) for ch in set(value))
    return entropy >= 3.0


def secret_indicators(path: Path, text: str) -> list[str]:
    indicators: set[str] = set()
    if KNOWN_SECRET_SHAPES.search(text.encode("utf-8", "ignore")):
        indicators.add("high-confidence token/private-key signature; manual review required")
    try:
        tree = ast.parse(text) if path.suffix.lower() == ".py" else None
    except SyntaxError:
        tree = None
    if tree is not None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                names = [target.id for target in node.targets if isinstance(target, ast.Name)]
                if any(SECRET_NAME.search(name) for name in names) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str) and likely_secret_value(node.value.value):
                    indicators.add("credential-named literal assignment; manual review required")
            elif isinstance(node, ast.Dict):
                keys = [key.value for key in node.keys if isinstance(key, ast.Constant) and isinstance(key.value, str)]
                if any(SECRET_NAME.search(key) for key in keys):
                    for key, value in zip(node.keys, node.values):
                        if isinstance(key, ast.Constant) and isinstance(key.value, str) and SECRET_NAME.search(key.value) and isinstance(value, ast.Constant) and isinstance(value.value, str) and likely_secret_value(value.value):
                            indicators.add("credential-named mapping literal; manual review required")
    # Assignment-shaped markers are reported only as a category; values/lines are never emitted.
    if re.search(r"(?i)(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|private[_-]?key|wallet[_-]?secret)\s*[:=]\s*(?:[\"'][A-Za-z0-9_./+=:-]{18,}|[A-Za-z0-9_./+=:-]{24,})", text):
        indicators.add("credential assignment pattern; manual review required")
    return sorted(indicators)


def purpose_and_action(path: Path, text: str) -> tuple[str, str]:
    if path.suffix.lower() == ".py":
        try:
            doc = ast.get_docstring(ast.parse(text)) or ""
        except SyntaxError:
            doc = ""
    else:
        doc = "\n".join(line.lstrip("# ") for line in text.splitlines()[:12] if line.lstrip().startswith(("#", "REM ")))
    sentences = [re.sub(r"\s+", " ", item.strip()) for item in re.split(r"(?<=[.!?])\s+|\n+", doc) if item.strip()]
    summary = sentences[0] if sentences else path.stem.replace("_", " ").replace("-", " ").capitalize()
    action = sentences[1] if len(sentences) > 1 else summary
    # Scrub token-like runs and credential assignments defensively; no source line is shown.
    def scrub(value: str) -> str:
        value = re.sub(r"(?i)(api[_ -]?key|secret|token|password|private[_ -]?key)\s*[:=]\s*\S+", r"\1=[REDACTED]", value)
        return re.sub(r"\b[A-Za-z0-9_-]{32,}\b", "[LONG_TOKEN_REDACTED]", value)

    return scrub(summary)[:180], scrub(action)[:220]


def disposition(path: Path, flags: list[str], destructive: bool, shell_exec: bool) -> tuple[str, str]:
    if flags:
        return "LEAVE — security review required", "possible credential/private-key material; never move before redacted human review"
    if path.name == "readonly_db.py":
        return "USEFUL — move candidate", "small read-only SQLite URI helper; useful for safe schema/metadata inspection"
    if destructive:
        return "LEAVE — risky / legacy-specific", "can delete/overwrite/reset data or outputs; not safe to relocate or run for Veylora"
    if path.name == "inspect_zip_safely.py":
        return "REFERENCE ONLY — do not move yet", "read-only archive helper, but it prints archive text and its redaction coverage is not exhaustive"
    if shell_exec:
        return "LEAVE — legacy-specific execution", "invokes commands or external workflows tied to old corpus/control-plane paths"
    return "REFERENCE ONLY — not selected", "legacy DataSeek/OCR/corpus or unrelated hook utility; no current Veylora task requires it"


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit("old-scripts/ directory not found")
    files = sorted((p for p in SOURCE.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS and "__pycache__" not in p.parts), key=lambda p: p.relative_to(SOURCE).as_posix().casefold())
    rows = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        purpose, action = purpose_and_action(path, text)
        flags = secret_indicators(path, text)
        destructive = bool(DESTRUCTIVE.search(text))
        shell_exec = bool(SHELL_EXEC.search(text))
        proposal, reason = disposition(path, flags, destructive, shell_exec)
        risk = []
        risk.extend(flags)
        if destructive: risk.append("destructive filesystem/DB operation marker")
        if shell_exec: risk.append("shell/process execution marker")
        if not risk: risk.append("no static credential/destructive/shell marker found; not a guarantee of safety")
        rows.append((path.relative_to(SOURCE).as_posix(), purpose, action, proposal, reason, "; ".join(risk)))
    lines = [
        "# `old-scripts/` Read-only Triage",
        "",
        "**Status:** static source inventory only; no old script has been run or moved by this generator. `old-scripts/` is outside `last-try/` in the current workspace, but remains legacy reference material. Script descriptions are inferred from module docstrings and path names. Credential scanning is heuristic; absence of a marker is not proof that a file has no secrets.",
        "",
        f"Source scripts enumerated (Python/shell/PowerShell; bytecode caches excluded): **{len(rows)}**.",
        "",
        "| Old path | Purpose | What it does | Usefulness / proposed disposition | Risk (static; no values) |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append("| " + " | ".join(value.replace("|", "\\|").replace("\n", " ") for value in row) + " |")
    lines.extend([
        "",
        "## Move proposal",
        "",
        "Only `old-scripts/readonly_db.py` is currently selected as a useful move candidate: propose `old-scripts/readonly_db.py` → `scripts/readonly_db.py`. Its implementation was read directly; it builds a SQLite `mode=ro` URI and does not mutate databases. It should only be moved after this triage is presented, and then wired into a schema-only inspection task. All remaining scripts stay in place because they are legacy-specific, can invoke shell/external tasks, may mutate legacy data, emit source content, or require additional secret review.",
        "",
        "Do not run any legacy script solely because it is listed here. In particular, do not run `coinbase_extract.py`: it reads a mixed credential/docs export and recursively removes/recreates a docs output directory. Do not run database/corpus scripts until their effects and target paths are separately reviewed.",
    ])
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)} with {len(rows)} source-script rows; no source contents or secret values were printed.")
    print(f"Credential-marker candidates: {sum('manual review required' in row[5] for row in rows)}; potential move candidates: {sum('move candidate' in row[3] for row in rows)}")


if __name__ == "__main__":
    main()
