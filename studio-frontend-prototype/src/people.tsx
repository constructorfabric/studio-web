/* ── People & Team ────────────────────────────────────────────────────────────
 *
 * Two surfaces, one component:
 *
 *   mode="org"  — the organization's PEOPLE. Every account owned by the org
 *                 tenant. Inviting here creates the account IN the organization
 *                 (its home tenant) — real and backend-backed.
 *
 *   mode="team" — a project's TEAM. Membership is now REAL: it is the set of
 *                 role grants in the organization's access config (AM tenant
 *                 metadata) scoped to this project. Adding/removing a member or
 *                 changing their role writes that config — the same store the
 *                 Studio PDP reads to enforce access. Only meaningful when the
 *                 org's access model is "roles"; under "tenant" access everyone
 *                 in scope can work, so there is no per-project team to manage.
 */

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, type User } from "./api";
import { DataTable } from "./data-table";
import { errText, initials } from "./format";
import {
  normalizeAccessConfig,
  type AccessConfig,
  type GrantDef,
  type RoleDef,
} from "./access";
import type { RootProject } from "./projects";

interface Person {
  user: User;
  /** True when this account is owned by the organization tenant itself. */
  homeIsOrg: boolean;
  /** Project tenants this person is a member of (AM tenant users). */
  rootIds: string[];
}

import { OnlineDot, useOnline } from "./presence";
import { ColleaguesCard } from "./people-profile";

export function PeopleView({
  token,
  org,
  roots,
  mode,
  onOpenProject,
}: {
  token: string;
  /** Organization these accounts belong to. */
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
  const online = useOnline(token);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [username, setUsername] = useState("");
  const [addPick, setAddPick] = useState("");
  const [addRole, setAddRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orgId = org?.id ?? null;
  const teamRoot = mode === "team" ? roots[0] ?? null : null;
  const ids = roots.map((r) => r.id).join(",");

  const load = useCallback(async () => {
    setError(null);
    const list = ids ? ids.split(",") : [];
    try {
      const [perRoot, orgUsers, access, catalogue] = await Promise.all([
        Promise.all(
          list.map(async (id) => {
            const users = await api.tenantUsersAll(token, id).then(
              (p) => p.items ?? [],
              () => [] as User[],
            );
            return { id, users };
          }),
        ),
        orgId
          ? api.tenantUsersAll(token, orgId).then(
              (p) => p.items ?? [],
              () => [] as User[],
            )
          : Promise.resolve([] as User[]),
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

      const merged = new Map<string, Person>();
      const upsert = (u: User): Person => {
        let cur = merged.get(u.id);
        if (!cur) {
          cur = { user: u, homeIsOrg: false, rootIds: [] };
          merged.set(u.id, cur);
        }
        return cur;
      };
      for (const u of orgUsers) upsert(u).homeIsOrg = true;
      for (const r of perRoot) {
        for (const u of r.users) {
          const person = upsert(u);
          if (!person.rootIds.includes(r.id)) person.rootIds.push(r.id);
        }
      }
      setPeople([...merged.values()]);
      setCfg(normalizeAccessConfig(access, catalogue));
    } catch (e) {
      setError(errText(e));
      setPeople([]);
    }
  }, [token, ids, orgId]);

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

  /** Projects a person is on: owning-tenant membership + project role grants. */
  function projectsOf(p: Person): { id: string; name: string; role?: string }[] {
    const out: { id: string; name: string; role?: string }[] = p.rootIds.map((id) => ({
      id,
      name: rootName(id),
    }));
    for (const g of cfg?.grants ?? []) {
      if (g.subjectType !== "member" || g.subjectId !== p.user.id) continue;
      if (g.scopeType !== "project") continue;
      if (out.some((o) => o.id === g.scopeId)) continue;
      out.push({ id: g.scopeId, name: g.scopeName || rootName(g.scopeId), role: roleName(g.roleKey) });
    }
    return out;
  }

  /* ── Organization invite (real) ── */
  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!orgId || !username.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.inviteUser(token, orgId, {
        username: username.trim(),
        email: `${username.trim()}@example.com`,
        display_name: username.trim(),
      });
      setUsername("");
      await load();
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
    const subj = (people ?? []).find((p) => p.user.id === addPick);
    const grant: GrantDef = {
      id: `g_${Date.now().toString(36)}_${cfg.grants.length}`,
      subjectType: "member",
      subjectId: addPick,
      subjectName: subj ? subj.user.display_name ?? subj.user.username : addPick.slice(0, 8),
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
  const nameOf = (p: Person) => p.user.display_name ?? p.user.username;
  const byName = [...all].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const personName = (g: GrantDef) => {
    const person = all.find((p) => p.user.id === g.subjectId);
    return person ? nameOf(person) : g.subjectName;
  };

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

        <div className="card">
          {!org && people !== null ? (
            <p className="empty">No organization in context.</p>
          ) : (
            <>
            {/* A dot that never lights cannot be told apart from an empty
                office, so the one case where the join could be wrong says so
                rather than showing nothing. */}
            {online.reported > 0 && !all.some((p) => online.ids.has(p.user.id)) && (
              <p className="hint">
                {online.reported} {online.reported === 1 ? "person is" : "people are"} in Studio
                right now, but none of them matched this list — presence is keyed by the sign-in
                subject and these rows by account id.
              </p>
            )}
            <DataTable<Person>
              list="people"
              rows={people === null ? null : byName}
              error={people === null ? error : null}
              onRetry={() => void load()}
              rowKey={(p) => p.user.id}
              rowLabel={nameOf}
              search={{ placeholder: "Search people" }}
              searchText={(p) => [p.user.display_name, p.user.username, p.user.email]}
              empty={{ title: "Nobody here yet.", body: "Invite the first person below." }}
              columns={[
                {
                  id: "name",
                  header: "Person",
                  compare: (a, b) => nameOf(a).localeCompare(nameOf(b)),
                  cell: (p) => (
                    <div className="pcell">
                      <span className="account-avatar small">{initials(nameOf(p))}</span>
                      <div>
                        <div className="pname plain">
                          {nameOf(p)}
                          <OnlineDot online={online.ids.has(p.user.id)} />
                        </div>
                        <div className="sub">{p.user.email ?? p.user.username}</div>
                      </div>
                    </div>
                  ),
                },
                {
                  id: "home",
                  header: "Belongs to",
                  cell: (p) => <span className="sub">{p.homeIsOrg ? org?.name : rootName(p.rootIds[0] ?? "")}</span>,
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
                            title={o.role ? `${o.role} · open` : "Open this project"}
                            onClick={() => onOpenProject(o.id)}
                          >
                            {o.name}
                            {o.role ? ` · ${o.role}` : ""}
                          </button>
                        ))}
                        {on.length === 0 && <span className="sub">not on a project</span>}
                      </div>
                    );
                  },
                },
              ]}
            />
            </>
          )}

          <form className="inline" onSubmit={invite} style={{ marginTop: 14 }}>
            <input
              placeholder="username to invite"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <button className="primary" disabled={busy || !username.trim() || !org}>
              {busy ? "Inviting…" : "Invite to organization"}
            </button>
          </form>
          <p className="hint">
            The person is created in {org?.name ?? "the organization"} — that becomes their home
            tenant. Assign them to projects from each project's Team tab.
          </p>
        </div>
      </>
    );
  }

  /* ── Project Team ── */
  const roleBased = cfg?.model === "roles";
  const teamGrants = teamRoot ? grantsForProject(teamRoot.id) : [];
  const grantedIds = new Set(teamGrants.map((g) => g.subjectId));
  const candidates = all
    .filter((p) => !grantedIds.has(p.user.id))
    .sort((a, b) =>
      (a.user.display_name ?? a.user.username).localeCompare(b.user.display_name ?? b.user.username),
    );

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
                  const person = all.find((p) => p.user.id === g.subjectId);
                  return (
                    <div className="pcell">
                      <span className="account-avatar small">{initials(personName(g))}</span>
                      <div>
                        <div className="pname plain">
                          {personName(g)}
                          <OnlineDot online={online.ids.has(g.subjectId)} />
                        </div>
                        <div className="sub">{person?.user.email ?? ""}</div>
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
                <option key={p.user.id} value={p.user.id}>
                  {p.user.display_name ?? p.user.username}
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
            the same store the Studio PDP enforces. Invite new accounts on the People page first.
          </p>
        </div>
      )}
    </>
  );
}
