import { useEffect, useState } from "react";

import {
  api,
  PLATFORM_ROOT_TENANT_ID,
  TENANT_TYPES,
  type DirectoryMembership,
  type MembershipRole,
  type PlatformIdentity,
  type Tenant,
} from "./api";
import { DataTable, When } from "./data-table";
import { errText, initials } from "./format";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

/** Their memberships in organizations — the platform root is not one. `null`
 *  when Studio could not say, and the IdP attributes are all there is. */
function orgMemberships(identity: PlatformIdentity): DirectoryMembership[] | null {
  return identity.memberships ? identity.memberships.filter((m) => m.org_id !== PLATFORM_ROOT_TENANT_ID) : null;
}

/** The organization the row's controls start on: where they belong, else
 *  where the IdP says, else nothing — never silently the first in the list. */
function currentOrg(identity: PlatformIdentity): string {
  const held = orgMemberships(identity);
  if (held) return (held.find((m) => m.status === "active") ?? held[0])?.org_id ?? "";
  return identity.home_tenant_id && identity.home_tenant_id !== PLATFORM_ROOT_TENANT_ID ? identity.home_tenant_id : "";
}

/** Their role in `orgId` as it stands, or `undefined` when they have none there. */
function roleIn(identity: PlatformIdentity, orgId: string): string | undefined {
  const held = orgMemberships(identity);
  if (held) return held.find((m) => m.org_id === orgId)?.role;
  return identity.home_tenant_id === orgId ? identity.organization_role : undefined;
}

/** What the IdP's attribute claims that Studio's memberships do not: shown, so
 *  a stale attribute is visible instead of read as the truth. */
function idpDrift(identity: PlatformIdentity): string | null {
  const held = orgMemberships(identity);
  const home = identity.home_tenant_id;
  if (!held || !home || home === PLATFORM_ROOT_TENANT_ID) return null;
  const there = held.find((m) => m.org_id === home && m.status === "active");
  if (!there) return `Keycloak still names ${identity.home_tenant_name ?? "another organization"} as home`;
  if (identity.organization_role && identity.organization_role !== there.role)
    return `Keycloak still says ${roleLabel(identity.organization_role)}`;
  return null;
}

/** `query` is the side panel's search; the list has its own and does not read it. */
export function IdentityDirectory({ token }: { token: string; query?: string }) {
  const [identities, setIdentities] = useState<PlatformIdentity[] | null>(null);
  const [organizations, setOrganizations] = useState<Tenant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, MembershipRole>>({});

  const load = async () => {
    const [{ items }, tenantPage] = await Promise.all([
      api.platformIdentities(token),
      api.tenantChildrenAll(token, PLATFORM_ROOT_TENANT_ID),
    ]);
    setIdentities(items);
    setOrganizations(
      (tenantPage.items ?? []).filter((tenant) => tenant.tenant_type === TENANT_TYPES.organization),
    );
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load().then(
      () => {
        if (cancelled) return;
      },
      (reason) => {
        if (!cancelled) {
          setError(errText(reason));
          setIdentities([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const targetOf = (identity: PlatformIdentity) => targets[identity.id] ?? currentOrg(identity);
  const roleOf = (identity: PlatformIdentity): MembershipRole =>
    roles[identity.id] ?? ((roleIn(identity, targetOf(identity)) as MembershipRole | undefined) || "member");

  async function assign(identity: PlatformIdentity) {
    const tenantId = targetOf(identity);
    if (!tenantId) return;
    setBusyId(identity.id);
    setError(null);
    try {
      await api.assignPlatformIdentity(token, identity.id, { tenant_id: tenantId, role: roleOf(identity) });
      // The row now starts from what the server has, not from the picks.
      setTargets(({ [identity.id]: _target, ...rest }) => rest);
      setRoles(({ [identity.id]: _role, ...rest }) => rest);
      await load();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Identity directory</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Everyone whose identity exists in Studio Keycloak, including people waiting for
            organization access.
          </p>
        </div>
      </div>

      {/* A failed read is the table's to show, with Retry; this is for a failed action on rows that are there. */}
      {error && (identities?.length ?? 0) > 0 && <div className="error">{error}</div>}

      <div className="card">
        <DataTable<PlatformIdentity>
          list="identities"
          rows={identities}
          error={identities !== null && identities.length === 0 ? error : null}
          onRetry={() => void load()}
          rowKey={(i) => i.id}
          rowLabel={(i) => i.display_name || i.username}
          search={{ placeholder: "Search identities" }}
          searchText={(i) => [
            i.display_name,
            i.username,
            i.email,
            i.home_tenant_name,
            i.status,
            ...(i.memberships ?? []).map((m) => m.org_name),
          ]}
          filters={[
            {
              id: "access",
              allLabel: "Everyone",
              kind: "chips",
              options: [
                { value: "unassigned", label: "Waiting for access" },
                { value: "assigned", label: "Assigned" },
                { value: "platform_admin", label: "Platform admin" },
              ],
              match: (i, v) => i.status === v,
            },
          ]}
          empty={{ title: "No identities found." }}
          columns={[
            {
              id: "name",
              header: "Identity",
              compare: (x, y) => (x.display_name || x.username).localeCompare(y.display_name || y.username),
              cell: (identity) => {
                const name = identity.display_name || identity.username;
                return (
                  <div className="pcell">
                    <span className="account-avatar small">{initials(name)}</span>
                    <div>
                      <div className="pname plain">{name}</div>
                      <div className="sub">{identity.email || identity.username}</div>
                    </div>
                  </div>
                );
              },
            },
            { id: "provider", header: "Provider", cell: (i) => <span className="sub">{i.identity_provider || "local"}</span> },
            {
              id: "access",
              header: "Access",
              cell: (identity) => {
                const held = orgMemberships(identity);
                const drift = idpDrift(identity);
                return (
                  <>
                    {identity.status === "platform_admin" && <span className="badge workspace">Platform admin</span>}
                    {held === null ? (
                      /* Studio could not be asked: the IdP's word, labelled as such. */
                      identity.status === "assigned" ? (
                        <>
                          <span className="badge workspace">{identity.home_tenant_name || "Assigned"}</span>
                          <div className="sub" style={{ marginTop: 4 }}>
                            {identity.organization_role ? `${roleLabel(identity.organization_role)} · ` : ""}per Keycloak
                          </div>
                        </>
                      ) : identity.status === "unassigned" ? (
                        <span className="badge warn">Waiting for access</span>
                      ) : null
                    ) : held.length === 0 ? (
                      identity.status !== "platform_admin" && <span className="badge warn">Waiting for access</span>
                    ) : (
                      held.map((m) => (
                        <div key={m.org_id} style={{ marginBottom: 4 }}>
                          <span className={`badge ${m.status === "active" ? "workspace" : "warn"}`} title={m.org_id}>
                            {m.org_name || m.org_id.slice(0, 8)}
                          </span>
                          <div className="sub">
                            {roleLabel(m.role)}
                            {m.status !== "active" ? " · suspended" : ""}
                          </div>
                        </div>
                      ))
                    )}
                    {drift && (
                      <div
                        className="sub"
                        style={{ marginTop: 4 }}
                        title="The IdP attribute is not rewritten when a membership changes"
                      >
                        {drift}
                      </div>
                    )}
                  </>
                );
              },
            },
            {
              id: "assignment",
              header: "Organization assignment",
              cell: (identity) => {
                const name = identity.display_name || identity.username;
                if (identity.status === "platform_admin") {
                  return (
                    <span className="sub">Administers every organization. Add them to one on its People screen.</span>
                  );
                }
                const target = targetOf(identity);
                const role = roleOf(identity);
                const standing = target ? roleIn(identity, target) : undefined;
                const unchanged = standing !== undefined && standing === role;
                return (
                  <div className="inline" style={{ flexWrap: "nowrap" }}>
                    <select
                      aria-label={`Organization for ${name}`}
                      value={target}
                      onChange={(event) => setTargets((current) => ({ ...current, [identity.id]: event.target.value }))}
                    >
                      <option value="" disabled>
                        {organizations.length === 0 ? "No organizations" : "Choose organization…"}
                      </option>
                      {organizations.map((organization) => (
                        <option key={organization.id} value={organization.id}>
                          {organization.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Role for ${name}`}
                      value={role}
                      onChange={(event) =>
                        setRoles((current) => ({ ...current, [identity.id]: event.target.value as MembershipRole }))
                      }
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      className="primary"
                      disabled={busyId !== null || !target || unchanged}
                      title={unchanged ? `Already ${roleLabel(role)} there` : undefined}
                      onClick={() => void assign(identity)}
                    >
                      {busyId === identity.id ? "Saving…" : standing !== undefined ? "Update" : "Assign"}
                    </button>
                  </div>
                );
              },
            },
            {
              id: "seen",
              header: "First seen",
              compare: (x, y) => (x.first_seen_at_epoch_ms ?? 0) - (y.first_seen_at_epoch_ms ?? 0),
              cell: (i) => <When iso={i.first_seen_at_epoch_ms ? new Date(i.first_seen_at_epoch_ms).toISOString() : null} />,
            },
          ]}
        />
        <p className="hint" style={{ marginTop: 14 }}>
          This is an identity directory, not an OAuth failure log. A rejected login that never
          created a Keycloak identity belongs in the security audit instead.
        </p>
      </div>
    </>
  );
}
