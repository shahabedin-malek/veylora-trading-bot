/**
 * The one command Playwright runs as its web server.
 *
 * It performs the phase-02 setup rather than assuming it: a reset of the local
 * SQLite file, the deterministic candle fixture, a loopback chain with a
 * self-signed certificate, and then `next dev` bound to loopback. The
 * certificate is generated here and trusted only by this process tree through
 * `NODE_EXTRA_CA_CERTS`, so no insecure TLS flag is involved.
 *
 * A port that already answers is refused before anything is reset. Reusing a
 * developer's server would mean running a destructive test against a database
 * this process did not seed, which is the one thing the suite must never do.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_BASE_URL, E2E_CONTROL_PORT, E2E_PORT, E2E_RPC_PORT, e2eEnvironment } from "./config";
import { startMockChain } from "./mock-chain";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(APP_DIR, "node_modules", ".bin");

function binary(name: string): string {
  return join(BIN, process.platform === "win32" ? `${name}.cmd` : name);
}

async function portAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`${E2E_BASE_URL}/api/auth/config`, { signal: AbortSignal.timeout(800) });
    return response.status > 0;
  } catch {
    return false;
  }
}

function makeCertificate(directory: string): { certPath: string; keyPath: string } {
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    throw new Error(
      `The e2e chain needs a self-signed certificate and openssl could not create one: ${
        error instanceof Error ? error.message : "unknown error"
      }. Install openssl and run \`pnpm e2e\` again.`,
    );
  }
  return { certPath, keyPath };
}

async function main() {
  if (await portAnswers()) {
    console.error(
      `E2E refuses to start: something already answers at ${E2E_BASE_URL}. ` +
        "Stop the running dev server (or set E2E_PORT to a free port) so the suite can seed the database it tests.",
    );
    process.exit(2);
  }

  const tlsDirectory = mkdtempSync(join(tmpdir(), "veylora-e2e-"));
  const { certPath, keyPath } = makeCertificate(tlsDirectory);
  const environment = e2eEnvironment({ NODE_EXTRA_CA_CERTS: certPath });

  let chain: Awaited<ReturnType<typeof startMockChain>> | null = null;
  let next: ReturnType<typeof spawn> | null = null;
  let stopping = false;

  const cleanUp = () => {
    if (tlsDirectory) rmSync(tlsDirectory, { recursive: true, force: true });
  };

  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    if (next && next.exitCode === null) next.kill("SIGTERM");
    if (chain) {
      void chain.close().finally(() => {
        cleanUp();
        process.exit(code);
      });
    } else {
      cleanUp();
      process.exit(code);
    }
  };

  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));

  console.log(`E2E: starting mock chain on 127.0.0.1:${E2E_RPC_PORT} (control ${E2E_CONTROL_PORT}).`);
  chain = await startMockChain({ certPath, keyPath, rpcPort: E2E_RPC_PORT, controlPort: E2E_CONTROL_PORT });

  console.log("E2E: resetting the local database with its deterministic seed.");
  const reset = spawnSync(process.execPath, [join(APP_DIR, "scripts", "dev-database.mjs"), "reset"], {
    cwd: APP_DIR,
    env: environment,
    stdio: "inherit",
  });
  if (reset.error || reset.status !== 0) {
    console.error("E2E: the database reset failed, so the server was not started.");
    stop(reset.status ?? 1);
    return;
  }

  // The reset wrote the project's development file. Run the app against a copy
  // in the temporary directory: Turbopack watches everything under the project,
  // and a SQLite write during a step would otherwise rebuild the page mid-click.
  const runDatabasePath = join(tlsDirectory, "e2e.db");
  copyFileSync(join(APP_DIR, "prisma", "dev.db"), runDatabasePath);
  const runDatabaseUrl = `file:${runDatabasePath}`;
  const isolationPreload = `--require=${join(APP_DIR, "e2e", "network-isolation.cjs")}`;
  const appEnvironment = {
    ...environment,
    DATABASE_URL: runDatabaseUrl,
    DATABASE_URL_UNPOOLED: runDatabaseUrl,
    veylora_DATABASE_URL: runDatabaseUrl,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, isolationPreload].filter(Boolean).join(" "),
  };

  console.log("E2E: seeding offline daily candles for the strategy runner.");
  const candles = spawnSync(binary("tsx"), [join(APP_DIR, "e2e", "fixtures", "seed-market.ts")], {
    cwd: APP_DIR,
    env: appEnvironment,
    stdio: "inherit",
  });
  if (candles.error || candles.status !== 0) {
    console.error("E2E: the candle fixture failed, so the server was not started.");
    stop(candles.status ?? 1);
    return;
  }

  // Throw away the previous run's dev build before starting.
  //
  // `.next/dev` is a cache of the sources that were compiled last time this suite ran. Reusing it
  // after an edit — or beside the production output `pnpm build` writes into `.next` — served the
  // first `/login` a manifest that disagreed with the page, and the browser reloaded it over and
  // over: the click never resolved and all five specs failed at sign-in with "waiting for
  // navigation to finish". Deleting only the dev cache keeps the production build intact and makes
  // every run start from the sources on disk.
  rmSync(join(APP_DIR, ".next", "dev"), { recursive: true, force: true });

  console.log(`E2E: starting Next on ${E2E_BASE_URL}.`);
  next = spawn(binary("next"), ["dev", "-p", String(E2E_PORT), "-H", "127.0.0.1"], {
    cwd: APP_DIR,
    env: appEnvironment,
    stdio: "inherit",
  });

  next.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`E2E: Next exited unexpectedly (${code ?? signal ?? "unknown"}).`);
      stop(code ?? 1);
    }
  });
  next.on("error", (error) => {
    console.error(`E2E: Next could not start: ${error.message}`);
    stop(1);
  });
}

main().catch((error: unknown) => {
  console.error(`E2E: the server harness failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
