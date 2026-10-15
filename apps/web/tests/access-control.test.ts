import assert from "node:assert/strict";
import test from "node:test";
import { isActiveSitePermissionKey, SITE_PERMISSION_CATALOG } from "../src/lib/auth/access-control";
import { normalizeMainnetAddress, teamSlugFromName } from "../src/lib/auth/access-directory";

test("only implemented site permissions are grantable", () => {
  assert.equal(isActiveSitePermissionKey("admin.data.read"), true);
  assert.equal(isActiveSitePermissionKey("risk.policy.manage"), true);
  assert.equal(isActiveSitePermissionKey("crm.support.manage"), false);
  assert.equal(isActiveSitePermissionKey("payments.operate"), false);
  assert.ok(SITE_PERMISSION_CATALOG.some(({ key, availability }) => key === "payments.operate" && availability === "PLANNED"));
});

test("access management accepts only EVM wallet addresses and normalizes case", () => {
  assert.equal(normalizeMainnetAddress("0x5a407Ff50d55142c36144B390972c51A768eBf8c"), "0x5a407ff50d55142c36144b390972c51a768ebf8c");
  assert.equal(normalizeMainnetAddress("not-a-wallet"), null);
});

test("department names produce normalized bounded slugs", () => {
  assert.deepEqual(teamSlugFromName("Customer Support"), { name: "Customer Support", slug: "customer-support" });
  assert.equal(teamSlugFromName(" "), null);
  assert.equal(teamSlugFromName("A"), null);
});