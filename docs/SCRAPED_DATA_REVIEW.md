# Scraped Data Review

Reviewed `last-try/data/scraped/` and its manifest as 
## What is present

- 144 numbered scraped folders correspond to 146 manifest rows and 145 unique archive hashes; one manifest row duplicates another archive.
- The per-file Markdown entries are parsed metadata (path, size, SHA-256, detected language, imports, identifiers, constants, and URLs), not complete source files or market-data datasets.
- The 3.6 GB `last-try/data/database/trading_ai_corpus.sqlite` was not opened. No credential values or source database row values were read.

## Best fit

- `REPO-0133` (`trade-journal-main`) has the strongest longer-term fit: its reviewed MIT TypeScript core covers completed-trade round trips and performance analytics, with focused tests. It depends on actual recorded fills, which Veylora does - `REPO-0051` (`ai-hedge-fund-crypto-main`) includes technical-indicator and strategy modules, but the repository also couples to a Binance gateway, LLM decisions, risk logic, and execution. No strategy or execution source was reused.
- `REPO-0043` (`Vibe-Research-main`) is primarily equity 
## Added to Veylora

The immediately useful, 
The local `data/project_state.db` is represented on `/admin/data` by a date-stamped aggregate-only snapshot. Refresh it with `pnpm --dir apps/web admin-data:refresh`; the exporter uses a 
The wider reuse and licensing decisions in `docs/REUSE_PLAN.md` remain controlling. No archive was extracted, installed, or run, and no source project was added as a dependency.