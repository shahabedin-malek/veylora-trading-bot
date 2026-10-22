# Phase 37 — End-to-end browser automation

The canonical journey now runs in Chromium against its own seeded server, and the four named refusals fail for the reason a person would read on screen rather than for an anonymous timeout.

## What the runner starts

`apps/web/e2e/server.ts` is the only command Playwright starts as its web server:

- it refuses a port that already answers, so it cannot test a developer's server or database;
- it runs the phase-02 `dev-database.mjs reset` against `prisma/dev.db`, which prints the seeded counts;
- it copies that file to a temporary directory and starts Next against the copy, because Turbopack watches the project tree and a SQLite write during a step rebuilt the page underneath it;
- it generates a scratch self-signed certificate, trusts it only in this process tree through `NODE_EXTRA_CA_CERTS`, and starts a loopback HTTPS JSON-RPC stand-in;
- it seeds 120 deterministic daily BTC-USD candles so the runner does not need Coinbase;
- it preloads a fetch guard into the Next process and routes browser requests so that only loopback is reachable. The trade page's own public market-data read is refused at that boundary and degrades to its unavailable state; no real venue, RSS feed or wallet host is contacted.

The wallet is a published Hardhat test key held in the Node process. The browser receives `window.ethereum` with `personal_sign` delegated to an exposed signing function; the server still recovers the signer from the signature. No extension, real key or real network is involved.

## Readings

`pnpm e2e` with no pre-existing listener:

```
Running 5 tests using 1 worker
✓ failure paths › sign-in step: a rejected signature says nothing was signed (5.2s)
✓ failure paths › deposit step: an unmatched token is recorded and never credited (12.4s)
✓ failure paths › order step: a risk cap refuses the order with the limit and the value it saw (12.2s)
✓ failure paths › withdrawal step: a request above the spendable balance is refused and holds nothing (9.1s)
✓ canonical journey › sign in → deposit credited → balances and history → start smart trading → runner survives a closed browser → withdrawal confirmed (26.4s)
5 passed (1.6m)
```

The journey steps are named with `test.step`. In the runner step the original `BrowserContext` is closed before the cron request and a new context is reopened from the saved storage state, then the test reads a higher `lastPass.runCount` and a non-null `lastPass.at`. That is the browser-closed continuation the phase asks for, asserted rather than inferred.

The four refusal assertions are the visible text, not status codes:

- `The signature request was rejected in your wallet, so nothing was signed and no session was created.` plus `SIGNATURE_REJECTED`;
- `is not the token enabled for deposits` plus `TOKEN NOT ENABLED`;
- `Refused by a limit you set: Max notional per order 250.00 — this order would make it 1000.00.`;
- `The account can spend 0 of 1000000 USDT minor units requested` plus `the withdrawal was refused and nothing was held`.

## Artifacts and a forced failure

Artifacts are written outside the repository (`os.tmpdir()/veylora-e2e-results`, overridable with `E2E_OUTPUT_DIR`) so the dev watcher cannot rebuild the page from a growing video file. The last verification was a deliberately broken selector:

```
✘ 1 [chromium] › e2e/__broken-selector.spec.ts:3:5 › deliberate missing control records a trace (5.6s)
Error: expect(locator).toBeVisible() failed
  ../../../../../tmp/veylora-e2e-results/__broken-selector-…/test-failed-1.png
  ../../../../../tmp/veylora-e2e-results/__broken-selector-…/video.webm
  ../../../../../tmp/veylora-e2e-results/__broken-selector-…/trace.zip
```

The temporary spec was removed after the run; the exit status was 1 and the trace is readable with `pnpm exec playwright show-trace <path>`.

## Gates run

```
typecheck=0
test=0        # 765 tests, 765 pass
lint=0
build=0
plan=0        # 40 phase files, 0 restriction hits
e2e=0         # 5 passed
```

A clean-state check removed `prisma/dev.db` and ran `pnpm db:setup`; it created the file and seeded 2 users, 3 alerts, 14 audit rows and 1 deposit. That run also exposed a pre-existing seed-order defect: `notificationDelivery` was inserted before the alert it references, so a genuinely fresh database failed its foreign key. The delivery is now written after the alert loop in `prisma/seed.ts`.

## CI

`.github/workflows/ci.yml` keeps the existing order — install, Prisma generate, Next typegen, typecheck, tests, build — and then installs Chromium and runs `pnpm e2e`. The step sets `E2E_OUTPUT_DIR` to `${{ runner.temp }}/veylora-e2e-results`; the following failure-only artifact upload points at that same path, so the real exit status and the trace travel together. The workflow was validated by inspection here; GitHub Actions itself was not executed on this machine, so the first hosted run is still the check of that wiring.

## Limits

- The chain, token, deposit and withdrawal confirmations are a loopback stand-in. No real network, order or key is part of the suite; the Node fetch guard and the browser routes refuse every non-loopback host, and the run logs show `E2E network isolation blocked https://api.exchange.coinbase.com/...` as the trade page degrades to its unavailable state.
- The app runs against a temporary copy of the seeded database; the project file is restored by teardown. `E2E_KEEP_DB=1` skips that restore for debugging.
- The all-pass reading above includes a warm Next cache; the suite also passed from a cold server start, but cold compilation is why action waits are 60 seconds rather than the usual 20.
- Playwright's `outputDir` is outside the project on purpose. Moving it back under `apps/web` reintroduces the watcher rebuild.
