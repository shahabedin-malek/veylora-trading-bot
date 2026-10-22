import assert from "node:assert/strict";
import test from "node:test";
import { planSignInProvisioning, type SignInProvisioningInput } from "../src/lib/auth/sign-in-provisioning";

/**
 * The sign-in acceptance criterion, as a counted plan.
 *
 * "A user record is created on first successful sign-in … repeat sign-ins update
 * last-seen and never duplicate the wallet" is a claim about rows written, so it
 * is asserted as rows written. The database still does the writing, but what it
 * is told to write is decided here, which is what makes these counts checkable
 * without a live database.
 */

/** Facts for a wallet nobody has signed in with, in a deployment that has an owner. */
const freshWallet: SignInProvisioningInput = {
  identity: null,
  account: null,
  provedAccountType: "EOA",
  currentRole: null,
  activeOwnerExists: true,
  ownerBootstrapApplies: false,
};

const knownWallet: SignInProvisioningInput = {
  identity: { id: "wallet-1", userId: "user-1", accountType: "EOA", revokedAt: null },
  account: { id: "user-1", status: "ACTIVE" },
  provedAccountType: "EOA",
  currentRole: "TRADER",
  activeOwnerExists: true,
  ownerBootstrapApplies: false,
};

test("a first sign-in creates exactly one account and exactly one wallet identity", () => {
  const plan = planSignInProvisioning(freshWallet);
  assert.equal(plan.outcome, "accepted");
  assert.ok(plan.outcome === "accepted");
  assert.deepEqual(plan.creates, { users: 1, walletIdentities: 1 });
  assert.equal(plan.newAccount, true);
  assert.equal(plan.role, "VIEWER");
  assert.equal(plan.assignRole, true);
});

test("a repeat sign-in creates nothing, keeps the wallet, and refreshes last-seen", () => {
  const plan = planSignInProvisioning(knownWallet);
  assert.ok(plan.outcome === "accepted");
  // Zero of each: the wallet is not duplicated, and no second account appears.
  assert.deepEqual(plan.creates, { users: 0, walletIdentities: 0 });
  assert.equal(plan.newAccount, false);
  assert.equal(plan.refreshLastSeen, true);
  // The role it already had is the role it runs as — no new assignment is written.
  assert.equal(plan.role, "TRADER");
  assert.equal(plan.assignRole, false);
});

test("a revoked wallet and an inactive account are refused without creating anything", () => {
  const revoked = planSignInProvisioning({
    ...knownWallet,
    identity: { ...knownWallet.identity!, revokedAt: new Date("2026-01-02T00:00:00.000Z") },
  });
  assert.equal(revoked.outcome, "refused");
  assert.ok(revoked.outcome === "refused");
  assert.equal(revoked.status, 403);
  assert.match(revoked.message, /revoked/);

  const inactive = planSignInProvisioning({ ...knownWallet, account: { id: "user-1", status: "SUSPENDED" } });
  assert.equal(inactive.outcome, "refused");
  assert.ok(inactive.outcome === "refused");
  assert.match(inactive.message, /not active/);
});

test("the development owner wallet is granted OWNER only while no owner exists", () => {
  const bootstrap = planSignInProvisioning({ ...freshWallet, activeOwnerExists: false, ownerBootstrapApplies: true });
  assert.ok(bootstrap.outcome === "accepted");
  assert.equal(bootstrap.role, "OWNER");
  assert.equal(bootstrap.bootstrapOwner, true);
  // The bootstrap is what assigns the role, so no second role row is needed.
  assert.equal(bootstrap.assignRole, true);

  const alreadyOwned = planSignInProvisioning({ ...freshWallet, activeOwnerExists: true, ownerBootstrapApplies: true });
  assert.ok(alreadyOwned.outcome === "accepted");
  assert.equal(alreadyOwned.role, "VIEWER");
  assert.equal(alreadyOwned.bootstrapOwner, false);
});

test("how the signature was proved is rewritten only when it changed", () => {
  const contractNow = planSignInProvisioning({ ...knownWallet, provedAccountType: "CONTRACT" });
  assert.ok(contractNow.outcome === "accepted");
  assert.equal(contractNow.rewriteAccountType, "CONTRACT");

  const unchanged = planSignInProvisioning(knownWallet);
  assert.ok(unchanged.outcome === "accepted");
  assert.equal(unchanged.rewriteAccountType, null);

  // A stored value this build does not know is replaced by what was just proved,
  // rather than being preserved as something nothing can interpret.
  const unknownStored = planSignInProvisioning({
    ...knownWallet,
    identity: { ...knownWallet.identity!, accountType: "SOMETHING_ELSE" },
  });
  assert.ok(unknownStored.outcome === "accepted");
  assert.equal(unknownStored.rewriteAccountType, "EOA");
});
