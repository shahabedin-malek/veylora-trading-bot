"""Read-only SQLite access for corpus and project databases.

Opening a SQLite database with ``sqlite3.connect(path)`` requests **read-write**
access even when the caller only reads. On a WAL-mode database that creates empty
``-wal`` and 32 KiB ``-shm`` sidecar files next to the database. Inside the
extracted corpus that is harmful: it mutates an output tree that reconciliation
treats as fixed. See ``docs/CORPUS-0005_SIDECAR_INVESTIGATION.md``.

Use :func:`open_readonly` for every inspection that must not write. Pass
``immutable=True`` for extracted corpus files, which are never modified in place;
this also lets SQLite read a WAL-mode database without creating sidecars.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from urllib.parse import quote

__all__ = ["readonly_uri", "open_readonly"]


def readonly_uri(path: Path | str, *, immutable: bool = False) -> str:
    """Return a SQLite ``mode=ro`` URI for *path*."""
    path = Path(path)
    suffix = "&immutable=1" if immutable else ""
    return f"file:{quote(str(path), safe='/')}?mode=ro{suffix}"


def open_readonly(path: Path | str, *, immutable: bool = False) -> sqlite3.Connection:
    """Open *path* read-only.

    Never creates ``-wal``/``-shm`` sidecars when ``immutable=True``. Any write
    attempt raises ``sqlite3.OperationalError``.
    """
    connection = sqlite3.connect(readonly_uri(path, immutable=immutable), uri=True)
    connection.row_factory = sqlite3.Row
    return connection
