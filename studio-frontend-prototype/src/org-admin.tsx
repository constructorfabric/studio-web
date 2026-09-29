/* ── Organization administration: which organizations, and who is in each ──
 *
 * Membership is the authority for who belongs to an organization (ADR-0011
 * §2), and studio-user holds it. Both screens here read and write it there:
 *
 *   OrganizationsTable — every organization this admin can manage, with what
 *     tells two of the same name apart: its id, its workspaces, its owners and
 *     how many members it has. Picking a row opens the organization below.
 *
 *   OrgMembersView — one organization's members: role, standing, how they
 *     joined. An owner or platform admin changes a role, suspends, resumes or
 *     removes; a platform admin adds anyone who has an identity, an owner
 *     invites by e-mail. "Owner" here is the real thing: the backend keeps the
 *     access-config owner grant in step with an active owner membership.
 *
 * Not the AM tenant-user list the People screen used to show: that is a
 * Keycloak group projection and a person can be in it without belonging.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  type MembershipRole,
  type OrgInvitation,
  type OrgMember,
  type PlatformIdentity,
} from "./api";
import { errText, initials, matches } from "./format";

const ROLES: { value: MembershipRole; label: string; hint: string }[] = [
  { value: "owner", label: "Owner", hint: "Administers the organization: people, access, integrations" },
  { value: "admin", label: "Admin", hint: "A member an owner may later grant more to" },
  { value: "member", label: "Member", hint: "Works in the organization's projects" },
];

const shortId = (id: string) => id.slice(0, 8);

/** What a member is called: their name, else their address, else their id. */
export function memberName(m: Pick<OrgMember, "display_name" | "email" | "user_id">): string {
  return m.display_name?.trim() || m.email?.trim() || `Person ${shortId(m.user_id)}`;
}

const SOURCE_LABEL: Record<string, string> = {
  creation: "created it",
  assignment: "assigned",
  invitation: "invited",
  bootstrap: "platform bootstrap",
  first_login: "first sign-in",
  manual: "added",
};

/* ── Organizations ─────────────────────────────────────────────────────── */

export interface OrgRow {
  id: string;
  name: string;
}

export function OrganizationsTable({
  token,
  orgs,
  workspaces,
  selectedId,
  onSelect,
  onMembers,
  query,
}: {
  token: string;
  orgs: OrgRow[];
  /** Root projects, tagged with the organization they belong to. */
  workspaces: { id: string; name: string; orgId?: string }[];
  selectedId: string | null;
  onSelect: (orgId: string) => void;
  onMembers: (orgId: string) => void;
  query: string;
}) {
  const [members, setMembers] = useState<Record<string, OrgMember[] | "denied">>({});

  useEffect(() => {
    let alive = true;
    void Promise.all(
      orgs.map(async (org) => {
        try {
          return [org.id, await api.orgMembers(token, org.id)] as const;
        } catch {
          // Not an owner of this one: its room is not ours to see.
          return [org.id, "denied" as const] as const;
        }
      }),
    ).then((pairs) => {
      if (alive) setMembers(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [token, orgs]);

  // Same-named organizations are the reason this table exists; flag them.
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>();
    for (const o of orgs) seen.set(o.name.trim().toLowerCase(), (seen.get(o.name.trim().toLowerCase()) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
  }, [orgs]);

  const rows = orgs.filter((o) =>
    matches(query, o.name, o.id, ...workspaces.filter((w) => w.orgId === o.id).map((w) => w.name)),
  );

  return (
    <div className="card">
      <div className="card-head">
        <h2>All organizations</h2>
        <span className="sub">{orgs.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{orgs.length === 0 ? "No organizations yet." : "No organizations match the filter."}</p>
      ) : (
        <table className="ptable people">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Workspaces</th>
              <th>Owners</th>
              <th>Members</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((org) => {
              const room = members[org.id];
              const list = room && room !== "denied" ? room : null;
              const owners = list?.filter((m) => m.role === "owner" && m.status === "active") ?? [];
              const ws = workspaces.filter((w) => w.orgId === org.id);
              const dup = duplicates.has(org.name.trim().toLowerCase());
              return (
                <tr key={org.id} className="prow" style={selectedId === org.id ? { boxShadow: "inset 3px 0 0 var(--primary)" } : undefined}>
                  <td>
                    <div className="pname plain">
                      {org.name} {dup && <span className="badge warn" title="Another organization has the same name">same name</span>}
                    </div>
                    <div className="sub" style={{ fontFamily: "var(--font-mono)" }} title={org.id}>{shortId(org.id)}</div>
                  </td>
                  <td className="sub">{ws.length ? ws.map((w) => w.name).join(", ") : "—"}</td>
                  <td className="sub">
                    {room === undefined
                      ? "…"
                      : room === "denied"
                        ? "not yours to see"
                        : owners.length
                          ? owners.map(memberName).join(", ")
                          : <span className="badge warn">no owner</span>}
                  </td>
                  <td className="sub">{list ? list.length : room === "denied" ? "—" : "…"}</td>
                  <td>
                    <div className="inline" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <button onClick={() => onMembers(org.id)}>Members</button>
                      <button className={selectedId === org.id ? "primary" : ""} onClick={() => onSelect(org.id)}>
                        Manage
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Members ───────────────────────────────────────────────────────────── */

export function OrgMembersView({
  token,
  org,
  isPlatformAdmin,
  query,
}: {
  token: string;
  org: OrgRow | null;
  /** May add anyone with an identity, not only invite by e-mail. */
  isPlatformAdmin: boolean;
  query: string;
}) {
  const orgId = org?.id ?? null;
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [identities, setIdentities] = useState<PlatformIdentity[]>([]);
  /** Why the directory of people cannot be offered, when it cannot. */
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [pickRole, setPickRole] = useState<MembershipRole>("member");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");

  const load = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    try {
      const [list, invited] = await Promise.all([
        api.orgMembers(token, orgId),
        api.orgInvitations(token, orgId).then((r) => r.items).catch(() => [] as OrgInvitation[]),
      ]);
      setMembers(list);
      setInvitations(invited);
    } catch (e) {
      setMembers([]);
      setError(errText(e));
    }
  }, [token, orgId]);

  useEffect(() => {
    setMembers(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    api
      .platformIdentities(token)
      .then((r) => {
        setIdentities(r.items);
        setDirectoryError(null);
      })
      .catch((e) => {
        setIdentities([]);
        setDirectoryError(errText(e));
      });
  }, [token, isPlatformAdmin]);

  /** One write, then the room as the server now has it. */
  const act = async (key: string, write: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await write();
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const setStanding = (m: OrgMember, role: MembershipRole, status: "active" | "suspended") =>
    act(m.user_id, () => api.putMembership(token, m.user_id, orgId!, { role, status }));

  const remove = (m: OrgMember) => {
    if (!window.confirm(`Remove ${memberName(m)} from ${org?.name}? Their personal connections here go with them.`)) return;
    void act(m.user_id, () => api.removeMembership(token, m.user_id, orgId!));
  };

  const addIdentity = async (e: FormEvent) => {
    e.preventDefault();
    const who = identities.find((i) => i.id === pick);
    if (!who || !orgId) return;
    await act("add", async () => {
      const { user_id } = await api.resolvePerson(token, {
        provider: "keycloak",
        subject: who.id,
        display_name: who.display_name || who.username,
        email: who.email,
      });
      await api.putMembership(token, user_id, orgId, { role: pickRole, source: "assignment" });
    });
    setPick("");
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !orgId) return;
    await act("invite", () => api.inviteToOrg(token, orgId, { email: email.trim(), role: inviteRole }));
    setEmail("");
  };

  if (!org) return <p className="empty">Pick an organization to see its members.</p>;

  const rows = (members ?? []).filter((m) => matches(query, m.display_name, m.email, m.role, m.status));
  const known = new Set((members ?? []).flatMap((m) => [m.email?.toLowerCase(), m.display_name?.toLowerCase()]).filter(Boolean));
  const addable = identities.filter(
    (i) => !known.has(i.email?.toLowerCase()) && !known.has((i.display_name || i.username).toLowerCase()),
  );
  const pending = invitations.filter((i) => !i.accepted_at_epoch_ms && i.expires_at_epoch_ms > Date.now());
  const activeOwners = (members ?? []).filter((m) => m.role === "owner" && m.status === "active").length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Members · {org.name}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Who belongs to this organization and in what role. Only an active owner administers it;
            the last one cannot be demoted, suspended or removed.{" "}
            <span className="sub" style={{ fontFamily: "var(--font-mono)" }} title={org.id}>{shortId(org.id)}</span>
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        {members === null ? (
          <p className="hint">Loading members…</p>
        ) : rows.length === 0 ? (
          <p className="empty">
            {members.length === 0 ? "Nobody belongs to this organization yet — add or invite someone below." : "No members match the filter."}
          </p>
        ) : (
          <table className="ptable people">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Standing</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const name = memberName(m);
                const suspended = m.status === "suspended";
                const onlyOwner = m.role === "owner" && !suspended && activeOwners <= 1;
                return (
                  <tr key={m.user_id} className="prow">
                    <td>
                      <div className="pcell">
                        <span className="account-avatar small">{initials(name)}</span>
                        <div>
                          <div className="pname plain">{name}</div>
                          <div className="sub">{m.email && m.email !== name ? m.email : shortId(m.user_id)}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select
                        aria-label={`Role of ${name}`}
                        value={m.role}
                        disabled={busy !== null || onlyOwner}
                        title={onlyOwner ? "The only active owner: add another owner first" : undefined}
                        onChange={(e) => void setStanding(m, e.target.value as MembershipRole, m.status)}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value} title={r.hint}>
                            {r.label}
                          </option>
                        ))}
                        {!ROLES.some((r) => r.value === m.role) && <option value={m.role}>{m.role}</option>}
                      </select>
                    </td>
                    <td>
                      <span className={`badge ${suspended ? "warn" : "ok"}`}>{suspended ? "Suspended" : "Active"}</span>
                    </td>
                    <td className="sub">
                      {SOURCE_LABEL[m.source] ?? m.source} · {new Date(m.created_at_epoch_ms).toLocaleDateString()}
                    </td>
                    <td>
                      <div className="inline" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <button
                          disabled={busy !== null || (onlyOwner && !suspended)}
                          onClick={() => void setStanding(m, m.role as MembershipRole, suspended ? "active" : "suspended")}
                        >
                          {busy === m.user_id ? "…" : suspended ? "Resume" : "Suspend"}
                        </button>
                        <button className="danger" disabled={busy !== null || onlyOwner} onClick={() => remove(m)}>
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Add people</h2>
        </div>
        {isPlatformAdmin && (
          <form className="inline" onSubmit={(e) => void addIdentity(e)} style={{ marginBottom: 12 }}>
            <select aria-label="Person to add" value={pick} onChange={(e) => setPick(e.target.value)} style={{ minWidth: 280 }}>
              <option value="">Someone with an identity…</option>
              {addable.map((i) => (
                <option key={i.id} value={i.id}>
                  {(i.display_name || i.username) + (i.email ? ` · ${i.email}` : "")}
                </option>
              ))}
            </select>
            <select aria-label="Role" value={pickRole} onChange={(e) => setPickRole(e.target.value as MembershipRole)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button className="primary" disabled={!pick || busy !== null}>
              {busy === "add" ? "Adding…" : "Add"}
            </button>
            <span className="hint">Platform admin: adds them now, whether or not they have signed in yet.</span>
          </form>
        )}
        {isPlatformAdmin && directoryError && (
          <p className="hint" style={{ marginTop: -4, marginBottom: 12 }}>
            The directory of people is not available on this Studio ({directoryError}) — invite them by e-mail instead.
          </p>
        )}
        <form className="inline" onSubmit={(e) => void invite(e)}>
          <input
            type="email"
            aria-label="E-mail to invite"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ minWidth: 280 }}
          />
          <select aria-label="Invited role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button className="primary" disabled={!email.trim() || busy !== null}>
            {busy === "invite" ? "Inviting…" : "Invite"}
          </button>
          <span className="hint">They see it when they sign in with this address, and accept it themselves.</span>
        </form>

        {pending.length > 0 && (
          <>
            <h3 style={{ marginTop: 16 }}>Waiting to be accepted</h3>
            <ul className="rows">
              {pending.map((i) => (
                <li key={i.id}>
                  <div className="grow">
                    <div className="name">{i.email}</div>
                    <div className="sub">
                      {i.role} · expires {new Date(i.expires_at_epoch_ms).toLocaleDateString()}
                    </div>
                  </div>
                  <button disabled={busy !== null} onClick={() => void act(i.id, () => api.revokeInvitation(token, org.id, i.id))}>
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
