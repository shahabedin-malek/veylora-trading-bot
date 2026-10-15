#!/usr/bin/env python3
"""Write a complete path-only inventory of last-try/ without opening file contents.

Run from the workspace root: python3 scripts/inventory_last_try.py
Outputs docs/LAST_TRY_TREE.txt.gz; each decompressed line is
TYPE<TAB>relative-path<TAB>size-bytes-or-dash. No secret values are read or emitted.
"""
from __future__ import annotations

import gzip
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Legacy reference trees live beside the project, not inside it.
EXTERNAL_DATA = Path(os.environ.get("VEYLORA_EXTERNAL_DATA", "/mnt/private-ai-data/trading"))
SOURCE = EXTERNAL_DATA / "last-try"
OUTPUT = ROOT / "docs/LAST_TRY_TREE.txt.gz"


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit("last-try/ directory not found")
    entries = sorted(SOURCE.rglob("*"), key=lambda path: path.relative_to(SOURCE).as_posix().casefold())
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    directories = files = symlinks = 0
    with OUTPUT.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as stream:
        stream.write(b"# TYPE\tPATH\tSIZE_BYTES\n")
        for path in entries:
            relative = path.relative_to(SOURCE).as_posix()
            if path.is_symlink():
                kind, size = "SYMLINK", "-"
                symlinks += 1
            elif path.is_dir():
                kind, size = "DIR", "-"
                directories += 1
            elif path.is_file():
                kind, size = "FILE", str(path.stat().st_size)
                files += 1
            else:
                kind, size = "OTHER", "-"
            stream.write(f"{kind}\t{relative}\t{size}\n".encode("utf-8", "surrogateescape"))
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")
    print(f"Entries: {len(entries)}; directories: {directories}; files: {files}; symlinks: {symlinks}")
    print("File contents were not read; manifest contains paths and sizes only.")


if __name__ == "__main__":
    main()
