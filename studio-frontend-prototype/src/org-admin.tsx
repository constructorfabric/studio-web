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
  type MemberIdentities,
  type MembershipRole,
  type OrgInvitation,
  type OrgMember,
  type PlatformIdentity,
} from "./api";
import { DataTable, When, useConfirm } from "./data-table";
import { errText, initials } from "./format";

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

const CONFIDENCE: Record<string, { label: string; badge: string; hint: string }> = {
  confirmed: { label: "Confirmed", badge: "ok", hint: "Proved by the provider; activity on it counts as theirs" },
  claimed: { label: "Claimed", badge: "info", hint: "They say it is theirs; not proved yet, so nothing is attributed" },
  suggested: { label: "Suggested", badge: "neutral", hint: "Studio guessed it; nobody has confirmed it" },
};

const DIRECTORY_STATUS: Record<PlatformIdentity["status"], string> = {
  platform_admin: "Platform admin",
  assigned: "Assigned",
  unassigned: "Waiting for access",
};

const when = (ms: number) => <When iso={new Date(ms).toISOString()} />;

/** Everything one member is known by, opened under their row: each way they
 *  sign in, and each external account attributed to them. A platform admin
 *  also sees what the IdP says about each realm login — the directory is
 *  theirs alone, so an owner sees Studio's own records and nothing more. */
function MemberIdentitiesPanel({
  token,
  orgId,
  member,
  directory,
}: {
  token: string;
  orgId: string;
  member: OrgMember;
  /** The identity directory, keyed by Keycloak subject; empty for an owner. */
  directory: Map<string, PlatformIdentity>;
}) {
  const [ids, setIds] = useState<MemberIdentities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setIds(null);
    setError(null);
    api
      .memberIdentities(token, orgId, member.user_id)
      .then((r) => live && setIds(r))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, orgId, member.user_id]);

  if (error) return <div className="member-ids sub">Could not read their identities: {error}</div>;
  if (!ids) return <div className="member-ids sub">Reading their identities…</div>;

  return (
    <div className="member-ids">
      <div className="member-ids-head">
        <span className="sub">Studio person</span>
        <code title="The canonical person id every membership and grant keys on">{ids.user_id}</code>
        <span className="sub">· in this organization since {when(member.created_at_epoch_ms)}</span>
      </div>

      <h4>
        Sign-in identities <span className="dt-count">{ids.logins.length}</span>
      </h4>
      {ids.logins.length === 0 ? (
        <p className="sub">No sign-in method resolves to this person — they were added before anyone signed in as them.</p>
      ) : (
        <table className="member-ids-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Account</th>
              <th>Subject</th>
              <th>Verified</th>
              {directory.size > 0 && <th>Directory</th>}
              <th>Linked</th>
            </tr>
          </thead>
          <tbody>
            {ids.logins.map((l) => {
              const idp = l.provider === "keycloak" ? directory.get(l.subject) : undefined;
              return (
                <tr key={`${l.provider}:${l.subject}`}>
                  <td>
                    {l.provider === "keycloak" ? "Studio Keycloak" : l.provider}
                    {idp && <div className="sub">via {idp.identity_provider || "password"}</div>}
                  </td>
                  <td>
                    {idp ? (
                      <>
                        <div>{idp.display_name || idp.username}</div>
                        <div className="sub">{[idp.username, idp.email].filter(Boolean).join(" · ")}</div>
                      </>
                    ) : (
                      <span className="sub">—</span>
                    )}
                  </td>
                  <td>
                    <code title={l.subject}>{l.subject}</code>
                  </td>
                  <td>
                    <span className={`badge ${l.verified ? "ok" : "warn"}`}>{l.verified ? "Verified" : "Unverified"}</span>
                  </td>
                  {directory.size > 0 && (
                    <td>
                      {idp ? (
                        <>
                          <div>{DIRECTORY_STATUS[idp.status]}</div>
                          {idp.home_tenant_name && (
                            <div className="sub">
                              home: {idp.home_tenant_name}
                              {idp.organization_role ? ` · ${idp.organization_role}` : ""}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="sub">not in the directory</span>
                      )}
                    </td>
                  )}
                  <td className="sub">{when(l.linked_at_epoch_ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h4>
        Attributed accounts <span className="dt-count">{ids.aliases.length}</span>
      </h4>
      {ids.aliases.length === 0 ? (
        <p className="sub">No external account is attributed to this person yet.</p>
      ) : (
        <table className="member-ids-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Account</th>
              <th>Confidence</th>
              <th>Counts as theirs</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {ids.aliases.map((a) => {
              const c = CONFIDENCE[a.confidence];
              return (
                <tr key={`${a.kind}:${a.external_id}`}>
                  <td>{a.kind}</td>
                  <td>
                    <code>{a.external_id}</code>
                  </td>
                  <td>
                    <span className={`badge ${c?.badge ?? "neutral"}`} title={c?.hint}>
                      {c?.label ?? a.confidence}
                    </span>
                  </td>
                  <td>{a.attributes ? "Yes" : <span className="sub">No</span>}</td>
                  <td className="sub">{when(a.added_at_epoch_ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

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
}: {
  token: string;
  orgs: OrgRow[];
  /** Root projects, tagged with the organization they belong to. */
  workspaces: { id: string; name: string; orgId?: string }[];
  selectedId: string | null;
  onSelect: (orgId: string) => void;
  onMembers: (orgId: string) => void;
  /** The side panel's query. Not read: the list searches itself. */
  query?: string;
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

  const wsOf = (o: OrgRow) => workspaces.filter((w) => w.orgId === o.id);

  return (
    <div className="card">
      <DataTable<OrgRow>
        list="orgs"
        title="All organizations"
        rows={orgs}
        rowKey={(o) => o.id}
        rowLabel={(o) => o.name}
        onOpen={(o) => onSelect(o.id)}
        search={{ placeholder: "Search organizations" }}
        searchText={(o) => [o.name, o.id, ...wsOf(o).map((w) => w.name)]}
        empty={{ title: "No organizations yet." }}
        columns={[
          {
            id: "name",
            header: "Organization",
            compare: (a, b) => a.name.localeCompare(b.name),
            cell: (org) => (
              <div style={selectedId === org.id ? { boxShadow: "inset 3px 0 0 var(--primary)", paddingLeft: 8 } : undefined}>
                <div className="pname plain">
                  {org.name}{" "}
                  {duplicates.has(org.name.trim().toLowerCase()) && (
                    <span className="badge warn" title="Another organization has the same name">
                      same name
                    </span>
                  )}
                </div>
                <div className="sub" style={{ fontFamily: "var(--font-mono)" }} title={org.id}>
                  {shortId(org.id)}
                </div>
              </div>
            ),
          },
          {
            id: "workspaces",
            header: "Workspaces",
            cell: (org) => <span className="sub">{wsOf(org).length ? wsOf(org).map((w) => w.name).join(", ") : "—"}</span>,
          },
          {
            id: "owners",
            header: "Owners",
            cell: (org) => {
              const room = members[org.id];
              const list = room && room !== "denied" ? room : null;
              const owners = list?.filter((m) => m.role === "owner" && m.status === "active") ?? [];
              return (
                <span className="sub">
                  {room === undefined ? (
                    "…"
                  ) : room === "denied" ? (
                    "not yours to see"
                  ) : owners.length ? (
                    owners.map(memberName).join(", ")
                  ) : (
                    <span className="badge warn">no owner</span>
                  )}
                </span>
              );
            },
          },
          {
            id: "members",
            header: "Members",
            num: true,
            cell: (org) => {
              const room = members[org.id];
              return room && room !== "denied" ? room.length : room === "denied" ? "—" : "…";
            },
          },
        ]}
        actions={(org) => [
          { label: "Manage", onSelect: () => onSelect(org.id) },
          { label: "Members", onSelect: () => onMembers(org.id) },
        ]}
      />
    </div>
  );
}

/* ── Members ───────────────────────────────────────────────────────────── */

export function OrgMembersView({
  token,
  org,
  isPlatformAdmin,
}: {
  token: string;
  org: OrgRow | null;
  /** May add anyone with an identity, not only invite by e-mail. */
  isPlatformAdmin: boolean;
  /** The side panel's query. Not read: the list searches itself. */
  query?: string;
}) {
  const [ask, confirmDialog] = useConfirm();
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

  const known = new Set((members ?? []).flatMap((m) => [m.email?.toLowerCase(), m.display_name?.toLowerCase()]).filter(Boolean));
  const addable = identities.filter(
    (i) => !known.has(i.email?.toLowerCase()) && !known.has((i.display_name || i.username).toLowerCase()),
  );
  const directory = new Map(identities.map((i) => [i.id, i]));
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

      {/* A failed read is the table's to show, with Retry; this is for a failed action on rows that are there. */}
      {error && (members?.length ?? 0) > 0 && <div className="error">{error}</div>}

      <div className="card">
        <DataTable<OrgMember>
          list="members"
          rows={members}
          error={members !== null && members.length === 0 ? error : null}
          onRetry={() => void load()}
          rowKey={(m) => m.user_id}
          rowLabel={memberName}
          search={{ placeholder: "Search members" }}
          searchText={(m) => [m.display_name, m.email, m.role, m.status]}
          filters={[
            {
              id: "standing",
              allLabel: "Everyone",
              kind: "chips",
              options: [
                { value: "active", label: "Active" },
                { value: "suspended", label: "Suspended" },
              ],
              match: (m, v) => m.status === v,
            },
          ]}
          empty={{ title: "Nobody belongs to this organization yet.", body: "Add or invite someone below." }}
          expand={(m) => <MemberIdentitiesPanel token={token} orgId={org.id} member={m} directory={directory} />}
          columns={[
            {
              id: "name",
              header: "Person",
              compare: (a, b) => memberName(a).localeCompare(memberName(b)),
              cell: (m) => (
                <div className="pcell">
                  <span className="account-avatar small">{initials(memberName(m))}</span>
                  <div>
                    <div className="pname plain">{memberName(m)}</div>
                    <div className="sub">{m.email && m.email !== memberName(m) ? m.email : shortId(m.user_id)}</div>
                  </div>
                </div>
              ),
            },
            {
              id: "role",
              header: "Role",
              cell: (m) => {
                const onlyOwner = m.role === "owner" && m.status !== "suspended" && activeOwners <= 1;
                return (
                  <select
                    aria-label={`Role of ${memberName(m)}`}
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
                );
              },
            },
            {
              id: "standing",
              header: "Standing",
              cell: (m) => (
                <span className={`badge ${m.status === "suspended" ? "warn" : "ok"}`}>
                  {m.status === "suspended" ? "Suspended" : "Active"}
                </span>
              ),
            },
            {
              id: "joined",
              header: "Joined",
              compare: (a, b) => a.created_at_epoch_ms - b.created_at_epoch_ms,
              cell: (m) => (
                <span className="sub">
                  {SOURCE_LABEL[m.source] ?? m.source} · <When iso={new Date(m.created_at_epoch_ms).toISOString()} />
                </span>
              ),
            },
          ]}
          actions={(m) => {
            const suspended = m.status === "suspended";
            const onlyOwner = m.role === "owner" && !suspended && activeOwners <= 1;
            return [
              {
                label: suspended ? "Resume" : "Suspend",
                disabled: busy !== null || (onlyOwner && !suspended),
                onSelect: () => setStanding(m, m.role as MembershipRole, suspended ? "active" : "suspended"),
              },
              {
                label: "Remove",
                disabled: busy !== null || onlyOwner,
                danger: {
                  title: `Remove ${memberName(m)} from ${org.name}?`,
                  body: "They leave the organization, and their personal connections here go with them.",
                  confirmLabel: "Remove",
                },
                onSelect: async () => {
                  await api.removeMembership(token, m.user_id, org.id);
                  await load();
                },
              },
            ];
          }}
        />
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
                  <button
                    disabled={busy !== null}
                    onClick={() =>
                      ask(
                        {
                          title: `Withdraw the invitation to ${i.email}?`,
                          body: "The link stops working. They can be invited again.",
                          confirmLabel: "Withdraw",
                        },
                        async () => {
                          await api.revokeInvitation(token, org.id, i.id);
                          await load();
                        },
                      )
                    }
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {confirmDialog}
    </>
  );
}
