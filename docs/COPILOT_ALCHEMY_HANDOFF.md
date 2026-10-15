# Alchemy hand-off — confirmation prompt for Copilot

Paste the block below into Copilot Chat (Agent mode) in this workspace. It is the
confirmation that the setup is done, plus the task list.

---

## PROMPT (copy from here)

**Status: Alchemy setup is complete and verified. Proceed with the tasks below.**

### What is already done — do not redo or "verify" by reading secrets

- **157 Alchemy networks** are enabled on the app key, and all **159 variables**
  (the key, the app id, and 157 `ALCHEMY_*_RPC_URL` endpoints) are set in the
  Vercel project `veylora-fintech-ai-trading` under **Development**, type
  **Secret**. Production and Preview were intentionally not touched.
- The key is registered locally in `pass` as `ai/alchemy-api-key`.
- `apps/web/.env` holds the full local copy (mode 600, git-ignored).
- The `alchemy` CLI 0.25.0 is installed and **already authenticated** — it pulls
  the key from `pass` through a wrapper at `~/.local/bin/alchemy`, so it works in
  non-interactive shells without any export. Do not re-authenticate, do not run
  `alchemy config set`, and do not paste a key anywhere.
- The Alchemy hosted MCP endpoint is configured in `.vscode/mcp.json`.
- **`ALCHEMY_API_KEYS` does not exist and must not be created.** The correct
  variable name is `ALCHEMY_ETHEREUM_MAINNET_API_KEY` (plus the per-network
  `ALCHEMY_*_RPC_URL` variables). The older `ALCHEMY_API_KEY` referenced in
  `docs/ALCHEMY_REFERENCE.md` and `docs/REMAINING_TASKS.md` is the **exposed legacy
  key** and must never be used — those docs are stale, fix them.

### Hard rule: do not read, access, copy, or echo environment keys

Do not open, `cat`, `grep`, `rg`, `env`, `printenv`, `pass show`, `vercel env pull`,
or `vercel env ls --json` against any secret-bearing file or store. Never print a
value, never commit one, never add one to `.env.example` (placeholders only), and
never use a `NEXT_PUBLIC_*` / `VITE_*` name for a secret. Refer to variables by
name only. Full list of forbidden paths is in `.github/copilot-instructions.md` §1.

### Task 1 — make the website use all networks, not just Ethereum mainnet

Today `apps/web/src/lib/rpc/ethereum-proxy.ts` hardcodes:

```ts
const ALCHEMY_ORIGIN = "https://eth-mainnet.g.alchemy.com";
```

and reads only `ALCHEMY_ETHEREUM_MAINNET_API_KEY`. Rewrite it so the app can reach
**every enabled network**:

1. Resolve a network to its endpoint — prefer a per-network variable when present
   (`process.env.ALCHEMY_BASE_MAINNET_RPC_URL`), otherwise build the URL from the
   shared key plus that network's hostname.
2. Put the network allowlist in **one** module. Do not scatter `g.alchemy.com`
   literals across the codebase.
3. Expose it as `/api/rpc/[network]` **without weakening** the current posture:
   server-only, same-origin, request-size and rate limited, read-only method
   allowlist, write and transaction-submission methods still rejected.
4. The key must never reach the browser bundle.
5. Add tests next to the existing ones (`apps/web/src/lib/portfolio/ethereum.test.ts`
   shows the pattern): network selection works, an unknown network is rejected, and
   no response body contains a key.

### Task 2 — use the Alchemy CLI for blockchain work and future planning

Always call it as an agent, and trust its live contract over your memory:

```bash
alchemy --json --no-interactive config status
alchemy --json --no-interactive agent-prompt
alchemy --json --no-interactive evm data balance <address> -n <network>
alchemy --json --no-interactive evm block <number> -n <network>
alchemy --json --no-interactive evm gas -n <network>
alchemy --json --no-interactive evm rpc <method> [params] -n <network>
alchemy --json --no-interactive evm network list
```

Never run bare `alchemy` without `--json --no-interactive`. Never pass a key as an
argument. Read-only first: `evm send`, `evm swap`, `evm approve`,
`evm contract call`, `xchain bridge`, `wallet`, and `gas-manager` move value or
grant allowances — do not run them without explicit human approval for that
specific transaction, and check the sender's balance first.

### Task 3 — run these read-only checks, then report back

Use this **public, non-secret** test address (it is the well-known `vitalik.eth`
address; it is not a key and is safe to use):

```
0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

1. **Chain ID** per network:
   `alchemy --json --no-interactive evm rpc eth_chainId -n <network>`
   for `eth-mainnet`, `base-mainnet`, `arb-mainnet`, `opt-mainnet`,
   `polygon-mainnet`, `solana-mainnet`.
2. **Native balance** of the test address on those same networks.
3. **Allowlisted tokens**: use `evm token <SYMBOL> -n <network>` to resolve
   addresses for USDC/USDT/WETH, then read balances through the read-only
   allowlist. Report which symbols resolved on which networks and which did not.

Report the raw JSON results, not a narrative, and state plainly any network that
failed or any command that errored. Do not retry a failing call more than once.

### Expected environment facts

- `apps/web` is the app; run scripts from inside it:
  `cd apps/web && pnpm --config.verify-deps-before-run=false <script>`.
  There is no workspace root — `pnpm-workspace.yaml` and `pnpm-lock.yaml` live in
  `apps/web`. Plain `pnpm <script>` may fail with `[ERR_PNPM_IGNORED_BUILDS]`; the
  `--config.verify-deps-before-run=false` flag avoids it. Do not run
  `pnpm approve-builds` unless a human asks.
- Existing tests must keep passing. Do not delete assertions, add suppressions, or
  skip tests to get green. Run `pnpm scan:secrets` before proposing a change.

## PROMPT (copy to here)

---

## Notes for the human (not part of the prompt)

- **The Alchemy hosted MCP is not OAuth-authenticated.** VS Code will prompt for a
  browser sign-in the first time that server starts. Until you complete it, the MCP
  server will not serve tools. Only complete it if you accept that Alchemy's hosted
  MCP exposes **write-capable wallet and admin tools** and VS Code offers no
  per-server read-only filter. Nothing in the prompt above depends on that MCP
  server — the CLI covers all the read-only work.
- **Do not commit `apps/web/.env`.** It is git-ignored (`apps/web/.gitignore:35`),
  and `.env.example` carries placeholders only.
- If Copilot claims it needs a real key value to proceed, that is the moment to
  stop it: it does not. The CLI and the server route both read the key themselves.
