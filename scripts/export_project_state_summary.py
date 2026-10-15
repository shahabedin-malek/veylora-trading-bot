#!/usr/bin/env python3
"""Refresh a redacted, aggregate-only snapshot for the private admin page."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# The existing project-state database lives beside the project, not inside it.
EXTERNAL_DATA = Path(os.environ.get("VEYLORA_EXTERNAL_DATA", "/mnt/private-ai-data/trading"))
sys.path.insert(0, str(ROOT / "scripts"))

from readonly_db import open_readonly

SOURCE_DB = EXTERNAL_DATA / "data/project_state.db"
OUTPUT = ROOT / "apps/web/src/lib/admin/project-state-summary.json"
TABLES = {
    "data_sources": "dataSources",
    "rss_feeds": "rssFeeds",
    "tasks": "tasks",
    "checkpoints": "checkpoints",
    "decisions": "decisions",
}


def main() -> None:
    with open_readonly(SOURCE_DB, immutable=False) as connection:
        available = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        missing = set(TABLES) - available
        if missing:
            raise RuntimeError(f"Project state is missing expected aggregate tables: {', '.join(sorted(missing))}")

        counts = {
            output_key: connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            for table, output_key in TABLES.items()
        }

    payload = {
        "snapshotDate": datetime.now(timezone.utc).date().isoformat(),
        "counts": counts,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("Updated aggregate-only admin snapshot; no row values were read or exported.")


if __name__ == "__main__":
    main()