import assert from "node:assert/strict";
import test from "node:test";
import {
  accessAuditPayload,
  describePermission,
  isActiveSitePermissionKey,
  missingPermissionMessage,
  readAccessReason,
  SITE_PERMISSION_CATALOG,
  sitePermissionLabel,
} from "../src/lib/auth/access-control";
import { getAccessRefusal } from "../src/lib/auth/access-gate";
import { AuthorizationRequiredError } from "../src/lib/auth/session-store";
import { FULL_DIRECTORY_PERMISSION, normalizeMainnetAddress, resolveAccessScope, teamSlugFromName } from "../src/lib/auth/access-directory";

test("only implemented site permissions are grantable", () => {
  assert.equal(isActiveSitePermissionKey("admin.data.read"), true);
  assert.equal(isActiveSitePermissionKey("risk.policy.manage"), true);
  // Phase 35 implements support, so its two permissions are no longer planned.
  assert.equal(isActiveSitePermissionKey("crm.support.read"), true);
  assert.equal(isActiveSitePermissionKey("crm.support.manage"), true);
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

test("a permission denial names the permission, key and label, in the API body", () => {
  const refusal = getAccessRefusal(new AuthorizationRequiredError(missingPermissionMessage("risk.policy.manage"), "risk.policy.manage"));
  assert.equal(refusal?.status, 403);
  assert.equal(refusal?.permissionKey, "risk.policy.manage");
  assert.match(refusal?.error ?? "", /risk\.policy\.manage/);
  assert.match(refusal?.error ?? "", /Manage global risk policy/);
  // Never a bare refusal: the sentence says what to ask for and where it is granted.
  assert.match(refusal?.error ?? "", /Access/);
});

test("every permission in the catalog can be named the same way", () => {
  for (const permission of SITE_PERMISSION_CATALOG) {
    const message = missingPermissionMessage(permission.key);
    assert.ok(message.includes(permission.key));
    assert.ok(message.includes(sitePermissionLabel(permission.key)));
    assert.equal(describePermission(permission.key), `${permission.key} (${permission.label})`);
  }
  // An unknown key is still named rather than silently dropped.
  assert.match(missingPermissionMessage("not.a.permission"), /not\.a\.permission/);
});

test("the audit payload of an access change carries the reason it was made for", () => {
  // The route normalises with `readAccessReason` first, so the payload holds the
  // sentence the administrator would recognise alongside what changed.
  const reason = readAccessReason("  Covering the   on-call shift ");
  assert.equal(reason, "Covering the on-call shift");
  const payload = JSON.parse(accessAuditPayload(reason!, { address: "0x1", role: "ADMIN" })) as Record<string, unknown>;
  assert.equal(payload.reason, "Covering the on-call shift");
  assert.equal(payload.role, "ADMIN");
});

test("an access change without a usable reason is refused before it is written", () => {
  assert.equal(readAccessReason("Granting reviewer access"), "Granting reviewer access");
  assert.equal(readAccessReason("  spacing   collapsed  "), "spacing collapsed");
  assert.equal(readAccessReason(""), null);
  assert.equal(readAccessReason("  "), null);
  assert.equal(readAccessReason("ab"), null);
  assert.equal(readAccessReason("x".repeat(201)), null);
  assert.equal(readAccessReason({ reason: "not a string" }), null);
});

test("team membership scopes what an administrator sees, unless widened", () => {
  const teams = [{ id: "team-1", name: "dev risk desk" }];
  assert.deepEqual(
    resolveAccessScope({ role: "ADMIN", permissionKeys: [], teams }),
    { kind: "teams", teamIds: ["team-1"], teamNames: ["dev risk desk"] },
  );
  assert.deepEqual(
    resolveAccessScope({ role: "ADMIN", permissionKeys: [FULL_DIRECTORY_PERMISSION], teams }),
    { kind: "all" },
  );
  assert.deepEqual(resolveAccessScope({ role: "OWNER", permissionKeys: [], teams: [] }), { kind: "all" });
  assert.deepEqual(resolveAccessScope({ role: "VIEWER", permissionKeys: [], teams: [] }), {
    kind: "teams",
    teamIds: [],
    teamNames: [],
  });
  // The widening permission is granted like any other active one.
  assert.equal(isActiveSitePermissionKey(FULL_DIRECTORY_PERMISSION), true);
});