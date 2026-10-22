import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

/**
 * The account-facing support read fails closed.
 *
 * There is no path here where a missing authentication configuration answers with
 * an empty ticket list: an empty list is a true statement about some accounts, so
 * it would disguise a deployment that cannot check who is asking. The refusal names
 * the missing variable, exactly as `/account` does.
 *
 * The visibility rule itself is asserted on the pure view in
 * `tests/support-crm.test.ts`, where an internal message is present in the input
 * and absent from the output.
 */

const AUTH_NAMES = ["AUTH_EVM_CHAIN_IDS", "APP_BASE_URL", "SESSION_SECRET"] as const;

function withoutAuthConfig<T>(run: () => Promise<T>): Promise<T> {
  const previous = AUTH_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of AUTH_NAMES) delete process.env[name];
  return run().finally(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("the account's support read fails closed when authentication is not configured", async () => {
  const response = await withoutAuthConfig(() => GET());
  assert.equal(response.status, 503);
  assert.match(((await response.json()) as { error: string }).error, /APP_BASE_URL|AUTH_EVM_CHAIN_IDS|SESSION_SECRET/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});
