#!/usr/bin/env python3
"""Inspect SQLite schema only; never prints row data or opens a writable connection."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from readonly_db import open_readonly


def inspect(path: Path) -> dict[str, list[str]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    connection = open_readonly(path, immutable=True)
    try:
        names = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        return {
            table: [row[1] for row in connection.execute(f'PRAGMA table_info("{table.replace(chr(34), chr(34)*2)}")')]
            for table in names
        }
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="SQLite database path (opened read-only)")
    args = parser.parse_args()
    try:
        schema = inspect(args.database.expanduser().resolve())
    except (OSError, ValueError) as exc:
        parser.error(f"cannot inspect database: {type(exc).__name__}")
    print(json.dumps(schema, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
