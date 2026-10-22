"use client";

import { Plus, Save, ShieldCheck, Trash, UserMinus, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";

type AccessUser = {
  id: string;
  address: string | null;
  /** "EOA" or "CONTRACT", as proved at sign-in; null when there is no wallet. */
  accountType: string | null;
  /** The same thing as a sentence, worded by the server. */
  accountTypeLabel: string | null;
  role: string;
  /** When this account last signed in, or null if it never has. */
  lastSeenAt: string | null;
  teams: { id: string; name: string; slug: string; role: string }[];
  permissions: string[];
};

type AccessTeam = {
  id: string;
  name: string;
  slug: string;
  members: { address: string | null; role: string }[];
};

type PermissionEntry = { key: string; label: string; availability: "ACTIVE" | "PLANNED" };
type AccessDirectory = {
  scope: { kind: "all" | "teams"; teamNames: string[] };
  viewer: { id: string; role: string };
  users: readonly AccessUser[];
  teams: readonly AccessTeam[];
  permissionCatalog: readonly PermissionEntry[];
  assignableRoles: readonly string[];
};

async function responseError(response: Response): Promise<Error> {
  const result: unknown = await response.json().catch(() => null);
  return new Error(
    result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error
      : "Access update failed.",
  );
}

/** The shortest reason the API accepts, mirrored here so the form can say it first. */
const MIN_REASON_LENGTH = 3;

export function AccessManagementForm({ initialDirectory }: { initialDirectory: AccessDirectory }) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [reason, setReason] = useState("");
  const [roleAddress, setRoleAddress] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [teamName, setTeamName] = useState("");
  const [memberAddress, setMemberAddress] = useState("");
  const [teamSlug, setTeamSlug] = useState(initialDirectory.teams[0]?.slug ?? "");
  const [teamRole, setTeamRole] = useState("MEMBER");
  const [permissionAddress, setPermissionAddress] = useState("");
  const [permissionKeys, setPermissionKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/admin/access", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw await responseError(response);
    setDirectory(await response.json() as AccessDirectory);
  }

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    setError(null);
    // The reason is required by the API for every change, so it is checked here
    // too: a refusal that arrives before the request is one round trip cheaper to
    // read than one that arrives after it.
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setBusy(false);
      setError(`Add a reason of at least ${MIN_REASON_LENGTH} characters; every access change records one.`);
      return;
    }
    try {
      const response = await fetch("/api/admin/access", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, reason }),
      });
      if (!response.ok) throw await responseError(response);
      await refresh();
      setNotice("Access change saved and audited.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access change failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>, payload: Record<string, unknown>) {
    event.preventDefault();
    await send(payload);
  }

  function selectedPermissionUser() {
    return directory.users.find((user) => user.address?.toLowerCase() === permissionAddress.toLowerCase());
  }

  const selectedPermissionRole = selectedPermissionUser()?.role;
  const permissionTargetHoldsEverything = selectedPermissionRole === "OWNER" || selectedPermissionRole === "ADMIN";
  const activePermissions = directory.permissionCatalog.filter((permission) => permission.availability === "ACTIVE");
  const plannedPermissions = directory.permissionCatalog.filter((permission) => permission.availability === "PLANNED");

  return (
    <div className="access-admin-layout">
      <section className="data-section market-history-section" aria-labelledby="access-scope-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">00 / WHAT YOU SEE</div>
            <h2 id="access-scope-title">Directory scope</h2>
          </div>
          <span className="section-state">{directory.scope.kind === "all" ? "EVERY ACCOUNT" : "YOUR TEAMS"}</span>
        </div>
        <p className="admin-data-note">
          {directory.scope.kind === "all"
            ? `Every active account is listed, because your role is ${directory.viewer.role}.`
            : directory.scope.teamNames.length > 0
              ? `Your role is ${directory.viewer.role}, so this directory shows the accounts in ${directory.scope.teamNames.join(", ")} and your own record. A grant of admin.access.read.all widens it to every account.`
              : `Your role is ${directory.viewer.role} and you belong to no team, so this directory shows only your own record. A grant of admin.access.read.all widens it to every account.`}
        </p>
        <label className="risk-policy-field" htmlFor="access-reason">
          <span>REASON FOR EVERY CHANGE BELOW (RECORDED IN THE AUDIT TRAIL)</span>
          <input
            id="access-reason"
            autoComplete="off"
            placeholder="Why this change is being made"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </section>

      <section className="data-section market-history-section" aria-labelledby="roles-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">01 / VERIFIED WALLETS</div>
            <h2 id="roles-title">Global roles</h2>
          </div>
          <span className="section-state">{directory.users.length} ACCOUNTS</span>
        </div>
        <p className="admin-data-note">The owner role comes from the configured owner address completing SIWE, so it is not listed as an assignable role here. This form assigns the other global roles; a wallet appears once it has signed in.</p>
        <form className="access-inline-form" onSubmit={(event) => submit(event, { action: "assign-role", address: roleAddress, role })}>
          <label className="risk-policy-field" htmlFor="access-role-address">
            <span>MAINNET WALLET ADDRESS</span>
            <input id="access-role-address" autoComplete="off" value={roleAddress} onChange={(event) => setRoleAddress(event.target.value)} />
          </label>
          <label className="risk-policy-field" htmlFor="access-global-role">
            <span>GLOBAL ROLE</span>
            <select id="access-global-role" value={role} onChange={(event) => setRole(event.target.value)}>
              {directory.assignableRoles.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <button disabled={busy} type="submit"><ShieldCheck aria-hidden="true" size={14} /> ASSIGN ROLE</button>
        </form>
        <ul className="access-user-list">
          {directory.users.map((user) => (
            <li key={user.id}>
              <span>{user.address ?? "No active EVM wallet"}</span>
              <strong>{user.role}</strong>
              <small>
                {user.accountTypeLabel ? `${user.accountTypeLabel} · ` : ""}
                {user.teams.length} teams · {user.permissions.length} function grants · last signed in{" "}
                {user.lastSeenAt ? user.lastSeenAt.replace("T", " ").slice(0, 16) + " UTC" : "never"}
              </small>
              {user.role === "OWNER" ? (
                <small>The owner role follows the configured owner address and is not revocable here.</small>
              ) : (
                <button
                  className="access-row-button"
                  disabled={busy || !user.address}
                  onClick={() => void send({ action: "revoke-role", address: user.address })}
                  type="button"
                >
                  <UserMinus aria-hidden="true" size={13} /> REVOKE ROLE {user.role}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="data-section market-history-section" aria-labelledby="teams-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">02 / DEPARTMENTS</div>
            <h2 id="teams-title">Teams</h2>
          </div>
          <span className="section-state">{directory.teams.length} TEAMS</span>
        </div>
        <ul className="access-user-list">
          {directory.teams.map((team) => (
            <li key={team.id}>
              <span>{team.name}</span>
              <strong>{team.members.length} members</strong>
              <small>
                {team.slug} · {team.members.map((member) => `${member.address ?? "no wallet"} (${member.role})`).join(", ")}
              </small>
              <button
                className="access-row-button"
                disabled={busy}
                onClick={() => void send({ action: "remove-team", teamSlug: team.slug })}
                type="button"
              >
                <Trash aria-hidden="true" size={13} /> REMOVE TEAM
              </button>
            </li>
          ))}
        </ul>
        <form className="access-inline-form" onSubmit={(event) => submit(event, { action: "create-team", name: teamName })}>
          <label className="risk-policy-field" htmlFor="access-team-name">
            <span>NEW TEAM NAME</span>
            <input id="access-team-name" value={teamName} onChange={(event) => setTeamName(event.target.value)} />
          </label>
          <button disabled={busy} type="submit"><Plus aria-hidden="true" size={14} /> CREATE TEAM</button>
        </form>
        <form className="access-inline-form" onSubmit={(event) => submit(event, { action: "assign-team", address: memberAddress, teamSlug, teamRole })}>
          <label className="risk-policy-field" htmlFor="access-team-member">
            <span>MEMBER WALLET</span>
            <input id="access-team-member" autoComplete="off" value={memberAddress} onChange={(event) => setMemberAddress(event.target.value)} />
          </label>
          <label className="risk-policy-field" htmlFor="access-team-select">
            <span>TEAM</span>
            <select id="access-team-select" value={teamSlug} onChange={(event) => setTeamSlug(event.target.value)}>
              {directory.teams.map((team) => <option key={team.slug} value={team.slug}>{team.name}</option>)}
            </select>
          </label>
          <label className="risk-policy-field" htmlFor="access-team-role">
            <span>TEAM ROLE</span>
            <select id="access-team-role" value={teamRole} onChange={(event) => setTeamRole(event.target.value)}>
              <option value="MEMBER">MEMBER</option>
              <option value="LEAD">LEAD</option>
            </select>
          </label>
          <button disabled={busy || directory.teams.length === 0} type="submit"><UsersRound aria-hidden="true" size={14} /> ASSIGN TEAM</button>
          <button
            disabled={busy || directory.teams.length === 0}
            onClick={() => void send({ action: "revoke-team-membership", address: memberAddress, teamSlug })}
            type="button"
          >
            <UserMinus aria-hidden="true" size={14} /> REVOKE MEMBERSHIP
          </button>
        </form>
      </section>

      <section className="data-section market-history-section" aria-labelledby="permissions-title">
        <div className="section-heading">
          <div>
            <div className="section-kicker">03 / FUNCTION ACCESS</div>
            <h2 id="permissions-title">Per-user grants</h2>
          </div>
          <span className="section-state">DENY BY DEFAULT</span>
        </div>
        <label className="risk-policy-field access-permission-user" htmlFor="permission-wallet">
          <span>ACCOUNT</span>
          <select id="permission-wallet" value={permissionAddress} onChange={(event) => {
            setPermissionAddress(event.target.value);
            const user = directory.users.find((candidate) => candidate.address === event.target.value);
            setPermissionKeys(user?.permissions ?? []);
          }}>
            <option value="">Select a signed-in wallet</option>
            {directory.users.filter((user) => user.address).map((user) => <option key={user.id} value={user.address!}>{user.address} · {user.role}</option>)}
          </select>
        </label>
        {permissionTargetHoldsEverything ? (
          <p className="admin-data-note" role="status">
            {selectedPermissionRole === "OWNER" ? "The owner" : "An administrator"} already holds every site function, so there is
            nothing to grant or revoke for this account. Change the global role above to give one account a narrower set.
          </p>
        ) : (
          <div className="access-permission-list">
            {activePermissions.map((permission) => (
              <label className="access-permission-item" key={permission.key}>
                <input
                  type="checkbox"
                  checked={permissionKeys.includes(permission.key)}
                  onChange={(event) => setPermissionKeys((current) => event.target.checked
                    ? [...current, permission.key]
                    : current.filter((key) => key !== permission.key))}
                />
                <span>{permission.label}</span>
                <small>{permission.key}</small>
              </label>
            ))}
          </div>
        )}
        {plannedPermissions.length > 0 && (
          <ul className="access-planned-list">
            {plannedPermissions.map((permission) => (
              <li key={permission.key}>
                <span>{permission.label}</span>
                <small>{permission.key} · MODULE NOT BUILT, so there is nothing to grant yet</small>
              </li>
            ))}
          </ul>
        )}
        <button
          className="access-save-button"
          disabled={busy || !permissionAddress || permissionTargetHoldsEverything}
          onClick={() => void send({ action: "set-permissions", address: permissionAddress, permissionKeys })}
          type="button"
        ><Save aria-hidden="true" size={14} /> SAVE FUNCTION GRANTS</button>
      </section>

      {notice && <p className="access-result" role="status">{notice}</p>}
      {error && <p className="login-error" role="alert">{error}</p>}
    </div>
  );
}
