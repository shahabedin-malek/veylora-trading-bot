import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SiweMessage } from "siwe";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pairingHostProblem } from "../src/lib/auth/config";
import { signInWithEvmWallet } from "../src/lib/auth/evm-wallet-sign-in";
import { toHexChainId, type Eip1193Provider } from "../src/lib/auth/eip1193";
import { verifySiweMessage } from "../src/lib/auth/siwe";
import {
  advancePairingStage,
  classifyPairingFailure,
  PAIRING_STAGE_COPY,
  pairedChainFailure,
  pairingExpiredFailure,
  pairingIsBusy,
  pairingLinks,
  pairingShowsUri,
  pairingUriExpiry,
  pairingUriIsExpired,
  pairingUriProblem,
  redactedPairingUri,
  resolveWalletConnectProjectId,
  WALLET_CONNECT_PROJECT_ID_VARIABLES,
  walletConnectMetadata,
  type PairingEvent,
  type PairingStage,
} from "../src/lib/auth/wallet-connect";

/**
 * Pairing, tested without a phone and without a relay.
 *
 * Everything here is decided by the pure module: which variable holds the
 * project id, what each pairing stage is called, what a failure is called, what
 * goes into the QR and what may be logged. The last test drives the *real*
 * sign-in flow with a paired-wallet provider and checks that the signature it
 * produces is one the production SIWE verifier accepts — because "mobile sign-in
 * uses the phase 07 path" is a claim about code, not about intent, and a fork of
 * the authentication path would fail it.
 */

const account = privateKeyToAccount(keccak256(stringToHex("Phase 08 pairing fixture only")));
const ORIGIN = "http://localhost:3000";
const DOMAIN = "localhost:3000";
const ALLOWED = [1];

/** A real `wc:` pairing URI, as the relay issues one. */
const PAIRING_URI =
  "wc:8a5e5bdc-a0e4-47b0-a5b9-2a5a4f3c1d2e@2?relay-protocol=irn&symKey=6a4b1c8d9e0f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b3c4d5e6f7081a2b3c4d&expiryTimestamp=1790000000";
/** Something that parses as nothing at all. */
const NOT_AN_ORIGIN = "not-an-origin";

// ─── the project id ──────────────────────────────────────────────────────────

test("the project id is read from the Reown name first, and the missing variable is named", () => {
  assert.deepEqual([...WALLET_CONNECT_PROJECT_ID_VARIABLES], [
    "NEXT_PUBLIC_REOWN_PROJECT_ID",
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  ]);

  const reown = resolveWalletConnectProjectId({ NEXT_PUBLIC_REOWN_PROJECT_ID: "reown-id", NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "legacy-id" });
  assert.deepEqual(reown, { configured: true, projectId: "reown-id", variable: "NEXT_PUBLIC_REOWN_PROJECT_ID" });

  const fallback = resolveWalletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "legacy-id" });
  assert.deepEqual(fallback, { configured: true, projectId: "legacy-id", variable: "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID" });

  // Whitespace is not a value, and a placeholder is not a value either: a
  // half-filled environment reports the variable rather than failing at the relay.
  for (const value of ["", "   ", "replace-with-a-project-id", "YOUR_PROJECT_ID", "example-id", "TODO"]) {
    const missing = resolveWalletConnectProjectId({ NEXT_PUBLIC_REOWN_PROJECT_ID: value });
    assert.equal(missing.configured, false, `${value} should not be usable`);
    assert.ok(missing.configured === false && /NEXT_PUBLIC_REOWN_PROJECT_ID/.test(missing.reason), "the reason names the variable");
    assert.ok(
      missing.configured === false && missing.variables.every((name) => missing.reason.includes(name)),
      "the reason names both variables",
    );
  }
});

// ─── the pairing states ──────────────────────────────────────────────────────

test("the pairing stages are the five the phase names, and every one has copy", () => {
  const stages: PairingStage[] = ["idle", "preparing", "waiting", "paired", "signing", "signed", "failed"];
  assert.deepEqual(Object.keys(PAIRING_STAGE_COPY).sort(), [...stages].sort());
  for (const stage of stages) {
    assert.ok(PAIRING_STAGE_COPY[stage].label.length > 0, stage);
    assert.ok(PAIRING_STAGE_COPY[stage].detail.length > 20, stage);
  }

  // The five states the phase asks to be visible are named the way it names them,
  // so "waiting, paired, signing, signed, failed" is what is on screen.
  assert.deepEqual(
    [PAIRING_STAGE_COPY.waiting.label, PAIRING_STAGE_COPY.paired.label, PAIRING_STAGE_COPY.signing.label, PAIRING_STAGE_COPY.signed.label, PAIRING_STAGE_COPY.failed.label],
    ["WAITING FOR THE WALLET", "PAIRED", "SIGNING IN", "SIGNED IN", "PAIRING FAILED"],
  );
});

test("a pairing walks waiting → paired → signing → signed, and a failure is retryable in place", () => {
  let stage: PairingStage = "idle";
  assert.equal(pairingIsBusy(stage), false);
  assert.equal(pairingShowsUri(stage), false);

  stage = advancePairingStage(stage, { type: "START" });
  assert.equal(stage, "preparing");
  assert.equal(pairingShowsUri(stage), true, "a pairing under way is somewhere a QR can appear");

  stage = advancePairingStage(stage, { type: "URI_READY" });
  assert.equal(stage, "waiting");
  assert.equal(pairingIsBusy(stage), true);

  stage = advancePairingStage(stage, { type: "PAIRED" });
  assert.equal(stage, "paired");
  stage = advancePairingStage(stage, { type: "SIGN_REQUESTED" });
  assert.equal(stage, "signing");
  stage = advancePairingStage(stage, { type: "SIGNED" });
  assert.equal(stage, "signed");

  // Every way a pairing can stall reaches `failed`, and a failure always accepts
  // the in-place retry — the phase 07 bug was a path that left no way forward.
  for (const start of ["preparing", "waiting", "paired", "signing"] as PairingStage[]) {
    const failed = advancePairingStage(start, { type: "FAILED" });
    assert.equal(failed, "failed", `${start} must be able to fail`);
    assert.equal(advancePairingStage(failed, { type: "START" }), "preparing", `${start} → failed must be retryable`);
  }

  // An event that does not apply leaves the stage alone: a late URI after a
  // cancel, or a signature after the fact, cannot drag the surface backwards.
  const strayEvents: PairingEvent[] = [{ type: "URI_READY" }, { type: "PAIRED" }, { type: "SIGNED" }, { type: "SIGN_REQUESTED" }];
  for (const stage of ["idle", "signed", "failed"] as PairingStage[]) {
    for (const event of strayEvents) {
      assert.equal(advancePairingStage(stage, event), stage, `${stage} must ignore ${event.type}`);
    }
  }
  assert.equal(advancePairingStage("signed", { type: "RESET" }), "idle");
  assert.equal(advancePairingStage("failed", { type: "RESET" }), "idle");
});

// ─── the failures ────────────────────────────────────────────────────────────

test("expiry, rejection, a refused project id and a dead relay are four different answers", () => {
  const expired = classifyPairingFailure(new Error("Pairing expired"));
  const expiredByTimeout = classifyPairingFailure(new Error("timed out waiting for the session"));
  const declined = classifyPairingFailure(new Error("User rejected the session proposal"));
  const projectId = classifyPairingFailure(new Error("Missing or invalid projectId provided"));
  const relay = classifyPairingFailure(new Error("WebSocket connection closed"));
  const unknown = classifyPairingFailure(new Error("something else entirely"));

  assert.deepEqual(
    [expired.code, declined.code, projectId.code, relay.code, unknown.code],
    ["PAIRING_EXPIRED", "PAIRING_DECLINED", "PROJECT_ID_REJECTED", "RELAY_UNAVAILABLE", "PAIRING_FAILED"],
  );
  assert.equal(expiredByTimeout.code, "PAIRING_EXPIRED");

  // Five situations, five sentences, and every one of them says what happened to
  // the session so the user knows there is nothing to undo.
  const messages = [expired, declined, projectId, relay, unknown].map((failure) => failure.message);
  assert.equal(new Set(messages).size, 5, messages.join(" / "));
  for (const failure of [expired, declined, projectId, relay, unknown]) {
    assert.equal(failure.retryable, true, `${failure.code} is retryable`);
    assert.match(failure.message, /nothing was signed|no pairing code|nothing was signed in/i, failure.message);
  }

  // The page's own countdown and the relay's own error report the same thing.
  assert.equal(expired.message, pairingExpiredFailure().message);
  assert.equal(expired.code, pairingExpiredFailure().code);

  // A failure that already knows what it is passes through untouched.
  const known = pairingExpiredFailure();
  assert.equal(classifyPairingFailure(known), known);
});

test("a paired wallet on an unsupported chain is told which networks are accepted", () => {
  const refused = pairedChainFailure({ chainId: 8453, acceptedChainIds: [1] });
  assert.equal(refused.code, "UNSUPPORTED_CHAIN");
  assert.equal(refused.retryable, true);
  assert.match(refused.message, /Base \(chain 8453\)/);
  assert.match(refused.message, /Sign-in accepts Ethereum Mainnet\./);
  assert.match(refused.message, /Nothing was signed\./);
});

// ─── the URI: three ways to the same pairing ─────────────────────────────────

test("the QR, the deep link and the copy link all carry the identical pairing URI", () => {
  const links = pairingLinks(PAIRING_URI);
  assert.equal(links.uri, PAIRING_URI);
  assert.equal(links.qrValue, PAIRING_URI, "the QR encodes the raw URI, which is what a scanner expects");
  assert.equal(links.deepLink, PAIRING_URI, "the deep link opens the same URI instead of being rewritten");
  assert.equal(links.copyValue, PAIRING_URI, "the copy button copies the same URI");
  assert.equal(new Set([links.qrValue, links.deepLink, links.copyValue]).size, 1);

  // Surrounding whitespace is trimmed, and nothing else is altered: a rewritten
  // URI is a different pairing.
  assert.deepEqual(pairingLinks(`  ${PAIRING_URI}  `), links);
  assert.equal(pairingLinks(PAIRING_URI).qrValue.includes("expiryTimestamp=1790000000"), true);
});

test("the pairing's own expiry is read from the URI when it states one, and never invented", () => {
  const links = pairingLinks(PAIRING_URI);
  assert.ok(links.expiresAt instanceof Date);
  assert.equal(links.expiresAt?.getTime(), 1790000000 * 1000);
  assert.equal(pairingUriExpiry(PAIRING_URI)?.getTime(), 1790000000 * 1000);

  assert.equal(pairingUriIsExpired(PAIRING_URI, new Date(1789999999000)), false);
  assert.equal(pairingUriIsExpired(PAIRING_URI, new Date(1790000000000)), true);
  assert.equal(pairingUriIsExpired(PAIRING_URI, new Date(1790000001000)), true);

  // No parameter, no claim: the page keeps showing the code rather than
  // inventing a countdown it cannot back up.
  const withoutExpiry = "wc:topic@2?relay-protocol=irn&symKey=abc";
  assert.equal(pairingUriExpiry(withoutExpiry), null);
  assert.equal(pairingUriIsExpired(withoutExpiry, new Date(1790000001000)), false);
  assert.equal(pairingLinks(withoutExpiry).expiresAt, null);
});

test("a value that is not a pairing URI is refused rather than rendered as a QR", () => {
  assert.equal(pairingUriProblem(PAIRING_URI), null);
  assert.match(pairingUriProblem("https://example.com") ?? "", /did not look like/);
  assert.match(pairingUriProblem({ error: "bad project id" }) ?? "", /not a string/);
  assert.match(pairingUriProblem(`wc:${"a".repeat(5000)}`) ?? "", /implausibly long/);
});

// ─── nothing secret is logged ────────────────────────────────────────────────

test("a pairing URI is redacted before it could be logged, and the key is never printable", () => {
  const redacted = redactedPairingUri(PAIRING_URI);
  assert.ok(!redacted.includes("6a4b1c8d9e0f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b3c4d5e6f7081a2b3c4d"), "the symmetric key is gone");
  assert.match(redacted, /symKey=redacted/);
  assert.match(redacted, /expiryTimestamp=1790000000/, "the non-secret parameters survive, so a log is still useful");
  assert.match(redacted, /^wc:/);

  assert.equal(redactedPairingUri("https://example.com"), "(not a pairing URI)");
  assert.equal(redactedPairingUri(undefined), "(not a pairing URI)");
});

test("the pairing modules do not log at all, so no URI can reach a log by accident", async () => {
  // The requirement is about what is *written somewhere*: the URI itself has to
  // be rendered (it is the QR), and the only way a pairing secret escapes is a
  // log line or a telemetry call. There is none in these files.
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, "../src/lib/auth/wallet-connect.ts"),
    join(here, "../src/lib/auth/wallet-connect-client.ts"),
    join(here, "../src/components/wallet-connect-pairing.tsx"),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.equal(/\bconsole\s*\./.test(source), false, `${file} must not log`);
    assert.equal(/\btrack\s*\(|sendBeacon|navigator\.sendBeacon/.test(source), false, `${file} must not report telemetry`);
  }
});

// ─── the origin a wallet is asked to trust ───────────────────────────────────

test("a pairing only starts on the host the deployment is configured for", () => {
  assert.equal(pairingHostProblem({ configuredOrigin: ORIGIN, requestHost: "localhost:3000" }), null);
  assert.equal(pairingHostProblem({ configuredOrigin: ORIGIN, requestHost: "LOCALHOST:3000" }), null);

  const wrongHost = pairingHostProblem({ configuredOrigin: ORIGIN, requestHost: "veylora.example" });
  assert.ok(wrongHost !== null);
  assert.match(wrongHost ?? "", /served from veylora\.example/);
  assert.match(wrongHost ?? "", /configured for localhost:3000/);
  assert.match(wrongHost ?? "", /pairing is refused/);

  assert.match(pairingHostProblem({ configuredOrigin: "", requestHost: "localhost:3000" }) ?? "", /APP_BASE_URL is not configured/);
  assert.match(pairingHostProblem({ configuredOrigin: NOT_AN_ORIGIN, requestHost: "localhost:3000" }) ?? "", /not a usable APP_BASE_URL/);
  assert.match(pairingHostProblem({ configuredOrigin: ORIGIN, requestHost: null }) ?? "", /no Host header/);
  assert.match(pairingHostProblem({ configuredOrigin: ORIGIN, requestHost: "   " }) ?? "", /no Host header/);
});

test("the metadata a wallet displays comes from the configured origin and nothing else", () => {
  const metadata = walletConnectMetadata({ origin: `${ORIGIN}/` });
  assert.equal(metadata.url, ORIGIN);
  assert.equal(metadata.name, "Veylora");
  assert.deepEqual(metadata.icons, []);

  const withIcon = walletConnectMetadata({ origin: ORIGIN, iconUrl: `${ORIGIN}/icon.png` });
  assert.deepEqual(withIcon.icons, [`${ORIGIN}/icon.png`]);

  // It cannot be talked into naming another site by being handed one: the value
  // it returns is the value it was given, and the caller gives it APP_BASE_URL.
  assert.equal(walletConnectMetadata({ origin: ORIGIN }).url.includes("example.com"), false);
});

// ─── the same sign-in path, not a second one ─────────────────────────────────

test("a paired wallet signs in through the phase 07 flow, and its signature verifies server-side", async () => {
  const calls: string[] = [];
  const paired: Eip1193Provider = {
    async request({ method, params }: { method: string; params?: readonly unknown[] | Record<string, unknown> }) {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          return toHexChainId(1);
        case "eth_requestAccounts":
          return [account.address];
        case "personal_sign": {
          const [message] = params as [string, string];
          return account.signMessage({ message });
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };

  const nonceMessages: string[] = [];
  const captured: { message?: string; signature?: string } = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? "{}")) as { address?: string; message?: string; signature?: string };
    if (url.endsWith("/api/auth/nonce")) {
      // The same fields the nonce route builds, including the statement and the
      // expiry `verifySiweMessage` requires — otherwise this test would pass
      // against a laxer verifier than the one that runs in production.
      const issuedAt = new Date();
      const message = new SiweMessage({
        scheme: "http",
        domain: DOMAIN,
        address: body.address ?? account.address,
        statement: "Sign in to Veylora. This does not authorize a transaction.",
        uri: `${ORIGIN}/login`,
        version: "1",
        chainId: 1,
        nonce: "0123456789abcdef",
        issuedAt: issuedAt.toISOString(),
        expirationTime: new Date(issuedAt.getTime() + 5 * 60 * 1000).toISOString(),
      }).prepareMessage();
      nonceMessages.push(message);
      return Response.json({ message });
    }
    if (url.endsWith("/api/auth/verify")) {
      captured.message = body.message;
      captured.signature = body.signature;
      return Response.json({ authenticated: true, role: "OWNER" });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;

  const result = await signInWithEvmWallet({
    scope: {},
    walletKind: "walletconnect",
    walletName: "Trust Wallet",
    provider: paired,
    allowedChainIds: ALLOWED,
    fetchImpl,
  });

  // The same two routes, in the same order, as an injected wallet: the chain
  // before anything is asked, then the account, then the nonce, then the
  // signature. There is no second authentication path for mobile.
  assert.deepEqual(calls, ["eth_chainId", "eth_requestAccounts", "personal_sign"]);
  assert.equal(nonceMessages.length, 1);
  assert.equal(result.address, account.address);
  assert.equal(result.role, "OWNER");
  assert.equal(result.chainId, 1);

  // And the signature is one the production verifier accepts: the pairing only
  // changed how the wallet was reached, not what was verified.
  const verified = await verifySiweMessage({
    message: captured.message as string,
    signature: captured.signature as string,
    expectedNonce: "0123456789abcdef",
    domain: DOMAIN,
    uri: `${ORIGIN}/login`,
    scheme: "http",
    allowedChainIds: new Set(ALLOWED),
  });
  assert.equal(verified.addressCanonical, account.address.toLowerCase());
});

test("a paired wallet that is gone, or on the wrong chain, fails before anything is signed", async () => {
  // No provider: the session was dropped between pairing and signing.
  await assert.rejects(
    signInWithEvmWallet({ scope: {}, walletKind: "walletconnect", walletName: "Trust Wallet", allowedChainIds: ALLOWED }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /paired wallet is not connected/);
      return true;
    },
  );

  const calls: string[] = [];
  const onBase: Eip1193Provider = {
    async request({ method }: { method: string }) {
      calls.push(method);
      if (method === "eth_chainId") return toHexChainId(8453);
      return [];
    },
  };
  await assert.rejects(
    signInWithEvmWallet({
      scope: {},
      walletKind: "walletconnect",
      walletName: "Trust Wallet",
      provider: onBase,
      allowedChainIds: ALLOWED,
    }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Sign-in accepts Ethereum Mainnet\./);
      return true;
    },
  );
  // The chain was read, and nothing else was asked of the wallet.
  assert.deepEqual(calls, ["eth_chainId"]);
});
