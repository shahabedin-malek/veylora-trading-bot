#!/usr/bin/env python3
"""Validate and summarize path/category-only tree scan reports."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / ".progress/scan_batches"
NAME = re.compile(r"^(old|repo)_(\d{6})_(\d{6})\.md$")
COUNTER = re.compile(r"(Scanned|Candidates|Oversize|Missing|Unreadable)=(\d+)")


def summarize(tree: str) -> tuple[int, dict[str, int]]:
    cursor = 0
    totals = {key: 0 for key in ("scanned", "candidates", "oversize", "missing", "unreadable")}
    report_paths = []
    for path in REPORTS.glob(f"{tree}_*.md"):
        match = NAME.fullmatch(path.name)
        if match:
            report_paths.append((int(match.group(2)), int(match.group(3)), path))
    for start, stop, path in sorted(report_paths):
        if start != cursor or stop <= start:
            raise ValueError(f"non-contiguous report sequence for {tree}: expected {cursor}, got {path.name}")
        cursor = stop
        text = path.read_text(encoding="utf-8")
        summary = next((line for line in text.splitlines() if line.startswith("Scanned=")), None)
        if summary is None:
            summary = next((line for line in text.splitlines() if line.startswith("Results:")), None)
        if summary is None:
            raise ValueError(f"missing counters in {path.name}")
        values = {name.casefold(): int(value) for name, value in COUNTER.findall(summary)}
        for key in totals:
            totals[key] += values.get(key, 0)
        if sum(values.get(key, 0) for key in ("scanned", "candidates", "oversize", "missing", "unreadable")) != stop - start:
            raise ValueError(f"counter total mismatch in {path.name}")
    return cursor, totals


def main() -> int:
    expected = {"old": 235_638, "repo": 305_189}
    if len(sys.argv) in (2, 3):
        old_end = int(sys.argv[1])
        repo_end = int(sys.argv[2]) if len(sys.argv) == 3 else old_end
        expected = {"old": old_end, "repo": repo_end}
    for tree, stop_expected in expected.items():
        stop, totals = summarize(tree)
        if stop != stop_expected:
            raise ValueError(f"{tree}: coverage ends at {stop}, expected {stop_expected}")
        print(
            f"{tree}: offsets=0:{stop}; files={sum(totals.values())}; "
            f"scanned={totals['scanned']}; candidates={totals['candidates']}; "
            f"oversize={totals['oversize']}; missing={totals['missing']}; unreadable={totals['unreadable']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())