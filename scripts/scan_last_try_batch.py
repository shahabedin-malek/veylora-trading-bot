#!/usr/bin/env python3
"""Secret-safe scan of a bounded FILE-record slice from LAST_TRY_TREE.txt.gz.

Only paths, generic secret categories and inferred service names are emitted. Matched
bytes are never returned from workers, printed, or written to disk. File contents are
read in bounded chunks; manifest order defines idempotent batches.
"""
from __future__ import annotations

import argparse
import gzip
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/LAST_TRY_TREE.txt.gz"
OUTPUT_DIR = ROOT / "docs/last_try_secret_batches"
CHUNK = 256 * 1024
MAX_BYTES = 64 * 1024 * 1024

PATTERNS = (
    ("private-key material", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("seed/mnemonic reference or material", re.compile(rb"(?i)\b(?:mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase)\b")),
    ("bearer/access token assignment", re.compile(rb"(?i)\b(?:bearer\s+[A-Za-z0-9._~+/-]{16,}|access[_ -]?token\s*[:=]\s*[\"']?[A-Za-z0-9._~+/-]{16,})")),
    ("credential assignment", re.compile(rb"(?i)\b(?:api[_ -]?key|client[_ -]?secret|private[_ -]?key|wallet[_ -]?secret|password|passwd|secret[_ -]?key)\b\s*[\"']?\s*[:=]\s*[\"']?[^\s\"'`,;<>]{12,}")),
    ("provider token signature", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,})\b")),
    ("JWT token", re.compile(rb"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("URL user/password credentials", re.compile(rb"https?://[^:/@\s]+:[^@/\s]+@")),
)
SERVICE_MARKS = {
    "Alchemy": (b"alchemy", b"alchemyapi"),
    "Coinbase CDP": (b"coinbase", b"cdp_api", b"cdp-wallet"),
    "Etherscan": (b"etherscan",),
    "Reown/WalletConnect": (b"reown", b"walletconnect"),
    "Tiger Cloud/TigerData": (b"tigerdata", b"tiger-cloud"),
    "Vercel": (b"vercel",),
    "GitHub": (b"github", b"ghp_", b"github_pat_"),
    "Google": (b"google", b"AIza"),
    "PostgreSQL/database": (b"postgres", b"database_url", b"pg_service"),
    "RPC provider": (b"rpc_url", b"quicknode", b"infura"),
}


def get_paths(start: int, count: int) -> list[str]:
    result: list[str] = []
    file_index = 0
    stop = start + count
    with gzip.open(MANIFEST, "rt", encoding="utf-8", errors="surrogateescape") as stream:
        next(stream, None)
        for line in stream:
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 3 or fields[0] != "FILE":
                continue
            if start <= file_index < stop:
                result.append(fields[1])
            file_index += 1
            if file_index >= stop:
                break
    if len(result) != count:
        raise ValueError(f"requested FILE slice [{start},{stop}); found {len(result)} records")
    return result


def scan_one(rel: str) -> tuple[str, str, tuple[str, ...], tuple[str, ...]]:
    path = ROOT / rel
    try:
        if not path.is_file():
            return rel, "missing", (), ()
        size = path.stat().st_size
        if size > MAX_BYTES:
            return rel, "oversize_skipped", (), ()
        tails = [b""] * len(PATTERNS)
        found: set[str] = set()
        service_hits: set[str] = set()
        path_low = rel.casefold().encode("utf-8", "ignore")
        for name, marks in SERVICE_MARKS.items():
            if any(mark in path_low for mark in marks):
                service_hits.add(name)
        with path.open("rb") as stream:
            while True:
                block = stream.read(CHUNK)
                if not block:
                    break
                for i, (label, pattern) in enumerate(PATTERNS):
                    data = tails[i] + block
                    if pattern.search(data):
                        found.add(label)
                    tails[i] = data[-4096:]
                lower_block = block.lower()
                for name, marks in SERVICE_MARKS.items():
                    if any(mark in lower_block for mark in marks):
                        service_hits.add(name)
        if not found:
            return rel, "scanned", (), tuple(sorted(service_hits))
        return rel, "candidate", tuple(sorted(found)), tuple(sorted(service_hits))
    except OSError:
        return rel, "unreadable", (), ()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=int, required=True, help="0-based FILE-record offset in the manifest")
    parser.add_argument("--count", type=int, default=10000, help="number of FILE records; maximum 10000")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    args = parser.parse_args()
    if args.start < 0 or not 1 <= args.count <= 10000 or args.workers < 1:
        parser.error("start must be >=0; count 1..10000; workers >=1")
    paths = get_paths(args.start, args.count)
    batch_id = f"{args.start:06d}_{args.start + args.count:06d}"
    out = OUTPUT_DIR / f"batch_{batch_id}.md"
    if out.exists():
        print(f"already complete: {out.relative_to(ROOT)}")
        return 0
    rows = []
    totals = {"scanned": 0, "candidate": 0, "missing": 0, "unreadable": 0, "oversize_skipped": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(scan_one, rel) for rel in paths]
        for future in as_completed(futures):
            rel, state, categories, services = future.result()
            totals[state] = totals.get(state, 0) + 1
            if state == "candidate":
                rows.append((rel, categories, services))
    rows.sort(key=lambda row: row[0].casefold())
    lines = [
        f"# Secret scan batch {batch_id}", "",
        f"Manifest FILE-record slice: [{args.start}, {args.start + args.count}) — {args.count} paths.",
        f"Results: scanned={totals['scanned']}; candidates={totals['candidate']}; missing={totals['missing']}; unreadable={totals['unreadable']}; oversize_skipped={totals['oversize_skipped']}.",
        "Output policy: path/category/service only; no matched bytes, lines, or values are emitted or stored.",
        "Heuristics include documentation examples and generic schema fields; candidates require redacted classification.",
        "", "| Relative path | Potential secret type | Inferred service |", "|---|---|---|",
    ]
    for rel, categories, services in rows:
        lines.append(f"| `{rel}` | {', '.join(categories)} | {', '.join(services) if services else 'not inferred'} |")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}; scanned={totals['scanned']}, candidates={totals['candidate']}, skipped={totals['oversize_skipped']}, errors={totals['missing']+totals['unreadable']}")
    return 1 if totals["missing"] or totals["unreadable"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
