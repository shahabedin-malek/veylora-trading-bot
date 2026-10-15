# Veylora Web

Next.js 16 App Router foundation. The interface reports unconfigured account and market sources as **Not connected**; it contains no fabricated balances, prices, or activity.

## Local development

From the project root:

```bash
pnpm --dir apps/web dev
```

Run the foundation checks:

```bash
pnpm --dir apps/web lint
pnpm --dir apps/web typecheck
pnpm --dir apps/web test
pnpm --dir apps/web build
```
