/* ── People & Team ────────────────────────────────────────────────────────────
 *
 * Two surfaces, one component:
 *
 *   mode="org"  — the organization's PEOPLE: its members, as studio-user
 *                 records them (ADR-0037 §1). Inviting here creates a Studio
 *                 invitation the person accepts when they sign in with the
 *                 address; nothing is created in the identity provider.
 *
 *   mode="team" — a project's TEAM: the role grants in the organization's
 *                 access config (AM tenant metadata) scoped to this project.
 *                 Adding/removing a member or changing their role writes that
 *                 config — the same store the Studio PDP reads to enforce
 *                 access. Only meaningful when the org's access model is
 *                 "roles"; under "tenant" access everyone in the organization
 *                 can work, so there is no per-project team to manage.
 *
 * Every person here is the canonical person id, and every grant written here
 * names it (ADR-0037 §5). Account-management's `/tenants/{id}/users` is not
 * read: it lists each account's single home tenant in the identity provider,
 * which is not membership.
 */

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";
import { DataTable } from "./data-table";
import { errText, initials } from "./format";
import {
  normalizeAccessConfig,
  type AccessConfig,
  type GrantDef,
  type RoleDef,
} from "./access";
import type { RootProject } from "./projects";
import { holderName, orgPeople, projectGrantsOf, type Member } from "./org-people";
import { ColleaguesCard } from "./people-profile";

export function PeopleView({
  token,
  org,
  roots,
  mode,
  onOpenProject,
}: {
  token: string;
  /** Organization these people belong to. */
  org: { id: string; name: string } | null;
  /** Projects in scope. In team mode this is the single current project. */
  roots: RootProject[];
  mode: "org" | "team";
  /** The shell's side-panel query. Not read: the list has its own search
   *  (docs/list-standard.md), and one query across sections searched the
   *  wrong list as often as the right one. */
  query?: string;
  onOpenProject: (rootId: string) => void;
}) {
  const [people, setPeople] = useState<Member[] | null>(null);
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [email, setEmail] = useState("");
  const [addPick, setAddPick] = useState("");
  const [addRole, setAddRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orgId = org?.id ?? null;
  const teamRoot = mode === "team" ? roots[0] ?? null : null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [members, access, catalogue] = await Promise.all([
        orgId ? orgPeople(token, orgId) : Promise.resolve([] as Member[]),
        orgId
          ? api.accessConfig(token, orgId).then(
              (v) => v,
              () => null,
            )
          : Promise.resolve(null),
        // The ladder a fresh organization is seeded with, from the side that
        // seeds it. Best-effort like the rest: an empty ladder renders a role
        // key rather than its name, which is better than not rendering at all.
        api.accessCatalogue(token).then(
          (c) => c.default_roles,
          () => [] as RoleDef[],
        ),
      ]);
      setPeople(members);
      setCfg(normalizeAccessConfig(access, catalogue));
    } catch (e) {
      setError(errText(e));
      setPeople([]);
    }
  }, [token, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rootName = (id: string): string => roots.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  const roleName = (key: string): string => cfg?.roles.find((r) => r.key === key)?.name ?? key;

  /** Member grants that apply to a project: those scoped to it, plus org-wide. */
  function grantsForProject(projectId: string): GrantDef[] {
    if (!cfg) return [];
    return cfg.grants.filter(
      (g) =>
        g.subjectType === "member" &&
        (g.scopeType === "org" || (g.scopeType === "project" && g.scopeId === projectId)),
    );
  }

  /** Projects a member holds a project role on. */
  function projectsOf(m: Member): { id: string; name: string; role: string }[] {
    return projectGrantsOf(m.id, cfg?.grants ?? []).map((g) => ({
      id: g.scopeId,
      name: g.scopeName || rootName(g.scopeId),
      role: roleName(g.roleKey),
    }));
  }

  /* ── Organization invite: a Studio invitation, accepted by the person ── */
  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!orgId || !email.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.inviteToOrg(token, orgId, { email: email.trim(), role: "member" });
      setNotice(`Invited ${email.trim()}. They join when they sign in with that address and accept.`);
      setEmail("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── Team grants (real, written to the org access config) ── */
  async function saveConfig(next: AccessConfig) {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    try {
      await api.putAccessConfig(token, orgId, next);
      setCfg(next);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function addToTeam() {
    if (!cfg || !teamRoot || !addPick) return;
    const role = addRole || cfg.roles.find((r) => r.key === "editor")?.key || cfg.roles[0]?.key;
    if (!role) return;
    const subj = (people ?? []).find((p) => p.id === addPick);
    const grant: GrantDef = {
      id: `g_${Date.now().toString(36)}_${cfg.grants.length}`,
      subjectType: "member",
      // The person id: what every grant names (ADR-0037 §5).
      subjectId: addPick,
      subjectName: subj ? subj.name : addPick.slice(0, 8),
      roleKey: role,
      scopeType: "project",
      scopeId: teamRoot.id,
      scopeName: teamRoot.name,
    };
    setAddPick("");
    void saveConfig({ ...cfg, grants: [...cfg.grants, grant] });
  }

  async function removeGrantNow(id: string) {
    if (!cfg || !orgId) return;
    const next = { ...cfg, grants: cfg.grants.filter((g) => g.id !== id) };
    await api.putAccessConfig(token, orgId, next);
    setCfg(next);
  }

  function setGrantRole(id: string, roleKey: string) {
    if (!cfg) return;
    void saveConfig({
      ...cfg,
      grants: cfg.grants.map((g) => (g.id === id ? { ...g, roleKey } : g)),
    });
  }

  const all = people ?? [];
  const personName = (g: GrantDef) => holderName(g, all);

  /* ── Organization People ── */
  if (mode === "org") {
    return (
      <>
        <div className="topbar">
          <div>
            <h1>People</h1>
            <p className="subtitle" style={{ margin: 0 }}>
              Everyone in {org?.name ?? "your organization"}. Invite a person to add them to the
              organization; put them on specific projects from a project's Team tab.
            </p>
          </div>
        </div>

        <ColleaguesCard token={token} orgId={orgId} />

        {error && <div className="error">{error}</div>}
        {notice && <div className="hint">{notice}</div>}

        <div className="card">
          {!org && people !== null ? (
            <p className="empty">No organization in context.</p>
          ) : (
            <DataTable<Member>
              list="people"
              rows={people === null ? null : all}
              error={people === null ? error : null}
              onRetry={() => void load()}
              rowKey={(p) => p.id}
              rowLabel={(p) => p.name}
              search={{ placeholder: "Search people" }}
              searchText={(p) => [p.name, p.email]}
              empty={{ title: "Nobody here yet.", body: "Invite the first person below." }}
              columns={[
                {
                  id: "name",
                  header: "Person",
                  compare: (a, b) => a.name.localeCompare(b.name),
                  cell: (p) => (
                    <div className="pcell">
                      <span className="account-avatar small">{initials(p.name)}</span>
                      <div>
                        <div className="pname plain">{p.name}</div>
                        {p.email && <div className="sub">{p.email}</div>}
                      </div>
                    </div>
                  ),
                },
                {
                  id: "role",
                  header: "Role",
                  cell: (p) => <span className="sub">{p.role}</span>,
                },
                {
                  id: "projects",
                  header: "On projects",
                  cell: (p) => {
                    const on = projectsOf(p);
                    return (
                      <div className="chips">
                        {on.map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            className="chip on"
                            title={`${o.role} · open`}
                            onClick={() => onOpenProject(o.id)}
                          >
                            {o.name} · {o.role}
                          </button>
                        ))}
                        {on.length === 0 && (
                          <span className="sub">
                            {cfg?.model === "roles" ? "not on a project" : "every project"}
                          </span>
                        )}
                      </div>
                    );
                  },
                },
              ]}
            />
          )}

          <form className="inline" onSubmit={invite} style={{ marginTop: 14 }}>
            <input
              type="email"
              placeholder="address to invite"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="primary" disabled={busy || !email.trim() || !org}>
              {busy ? "Inviting…" : "Invite to organization"}
            </button>
          </form>
          <p className="hint">
            The person sees the invitation when they sign in with this address, and becomes a
            member of {org?.name ?? "the organization"} when they accept it. Put them on projects
            from each project's Team tab.
          </p>
        </div>
      </>
    );
  }

  /* ── Project Team ── */
  const roleBased = cfg?.model === "roles";
  const teamGrants = teamRoot ? grantsForProject(teamRoot.id) : [];
  const grantedIds = new Set(teamGrants.map((g) => g.subjectId));
  const candidates = all.filter((p) => !grantedIds.has(p.id));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Team</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            People working on {teamRoot?.name ?? "this project"} — a subset of{" "}
            {org?.name ?? "the organization"}.
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {people === null || cfg === null ? (
        <p className="hint">Loading team…</p>
      ) : !teamRoot ? (
        <p className="empty">No project in context.</p>
      ) : !roleBased ? (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            <b>{org?.name ?? "This organization"} uses tenant access.</b> Everyone in the
            organization can work in this project, so there's no per-project team to manage. Switch
            to <b>Role-based access</b> in Admin → Access to grant roles to specific people here.
          </p>
        </div>
      ) : (
        <div className="card">
          <DataTable<GrantDef>
            list="team"
            rows={teamGrants}
            rowKey={(g) => g.id}
            rowLabel={(g) => personName(g)}
            empty={{ title: "Nobody on the team yet.", body: "Add someone from the organization below." }}
            columns={[
              {
                id: "name",
                header: "Person",
                compare: (a, b) => personName(a).localeCompare(personName(b)),
                cell: (g) => {
                  const person = all.find((p) => p.id === g.subjectId);
                  return (
                    <div className="pcell">
                      <span className="account-avatar small">{initials(personName(g))}</span>
                      <div>
                        <div className="pname plain">{personName(g)}</div>
                        <div className="sub">{person?.email ?? ""}</div>
                      </div>
                    </div>
                  );
                },
              },
              {
                id: "role",
                header: "Role",
                cell: (g) => (
                  <select
                    aria-label={`Role of ${personName(g)}`}
                    value={g.roleKey}
                    disabled={busy || g.scopeType === "org"}
                    onChange={(e) => setGrantRole(g.id, e.target.value)}
                  >
                    {cfg.roles.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                id: "scope",
                header: "Scope",
                cell: (g) => <span className="sub">{g.scopeType === "org" ? "organization-wide" : "this project"}</span>,
              },
            ]}
            inline={(g) =>
              g.scopeType === "org" ? (
                <span className="sub" title="Managed on the organization's Access screen">
                  in Access
                </span>
              ) : null
            }
            actions={(g) =>
              g.scopeType === "org"
                ? []
                : [
                    {
                      label: "Remove from team",
                      danger: {
                        title: `Remove ${personName(g)} from ${teamRoot.name}?`,
                        body: "Their role on this project goes. They stay in the organization, and can be added back.",
                        confirmLabel: "Remove",
                      },
                      onSelect: () => removeGrantNow(g.id),
                    },
                  ]
            }
          />

          <div className="inline" style={{ marginTop: 14, gap: 8 }}>
            <select value={addPick} onChange={(e) => setAddPick(e.target.value)}>
              <option value="">
                {candidates.length ? "Add from organization…" : "Everyone is already on the team"}
              </option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select value={addRole} onChange={(e) => setAddRole(e.target.value)}>
              <option value="">Role…</option>
              {cfg.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
            <button className="primary" disabled={busy || !addPick} onClick={addToTeam}>
              Add to team
            </button>
          </div>
          <p className="hint">
            Adding someone writes a role grant to {org?.name ?? "the organization"}'s access config —
            the same store the Studio PDP enforces. Invite new people on the People page first.
          </p>
        </div>
      )}
    </>
  );
}
