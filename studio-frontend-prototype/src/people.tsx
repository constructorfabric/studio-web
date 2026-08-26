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
import { errText, initials, matches } from "./format";
import {
  normalizeAccessConfig,
  type AccessConfig,
  type GrantDef,
} from "./access";
import type { RootProject } from "./projects";

interface Person {
  user: User;
  /** True when this account is owned by the organization tenant itself. */
  homeIsOrg: boolean;
  /** Project tenants this person is a member of (AM tenant users). */
  rootIds: string[];
}

export function PeopleView({
  token,
  org,
  roots,
  mode,
  query,
  onOpenProject,
}: {
  token: string;
  /** Organization these accounts belong to. */
  org: { id: string; name: string } | null;
  /** Projects in scope. In team mode this is the single current project. */
  roots: RootProject[];
  mode: "org" | "team";
  query: string;
  onOpenProject: (rootId: string) => void;
}) {
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
      const [perRoot, orgUsers, access] = await Promise.all([
        Promise.all(
          list.map(async (id) => {
            const users = await api.tenantUsers(token, id).then(
              (p) => p.items ?? [],
              () => [] as User[],
            );
            return { id, users };
          }),
        ),
        orgId
          ? api.tenantUsers(token, orgId).then(
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
      setCfg(normalizeAccessConfig(access));
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

  function removeGrant(id: string) {
    if (!cfg) return;
    void saveConfig({ ...cfg, grants: cfg.grants.filter((g) => g.id !== id) });
  }

  function setGrantRole(id: string, roleKey: string) {
    if (!cfg) return;
    void saveConfig({
      ...cfg,
      grants: cfg.grants.map((g) => (g.id === id ? { ...g, roleKey } : g)),
    });
  }

  const all = people ?? [];
  const filtered = all
    .filter((p) => matches(query, p.user.display_name, p.user.username, p.user.email))
    .sort((a, b) =>
      (a.user.display_name ?? a.user.username).localeCompare(b.user.display_name ?? b.user.username),
    );

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

        {error && <div className="error">{error}</div>}

        <div className="card">
          {people === null ? (
            <p className="hint">Loading people…</p>
          ) : !org ? (
            <p className="empty">No organization in context.</p>
          ) : filtered.length === 0 ? (
            <p className="empty">
              {all.length === 0
                ? "Nobody here yet — invite the first person below."
                : "Nobody matches the current filters."}
            </p>
          ) : (
            <table className="ptable people">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Belongs to</th>
                  <th>On projects</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const name = p.user.display_name ?? p.user.username;
                  const on = projectsOf(p);
                  return (
                    <tr key={p.user.id} className="prow">
                      <td>
                        <div className="pcell">
                          <span className="account-avatar small">{initials(name)}</span>
                          <div>
                            <div className="pname plain">{name}</div>
                            <div className="sub">{p.user.email ?? p.user.username}</div>
                          </div>
                        </div>
                      </td>
                      <td className="sub">
                        {p.homeIsOrg ? org.name : rootName(p.rootIds[0] ?? "")}
                      </td>
                      <td>
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          {teamGrants.length === 0 ? (
            <p className="empty">Nobody on the team yet — add someone from the organization below.</p>
          ) : (
            <table className="ptable people">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Scope</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {teamGrants.map((g) => {
                  const person = all.find((p) => p.user.id === g.subjectId);
                  const name = person
                    ? person.user.display_name ?? person.user.username
                    : g.subjectName;
                  const orgWide = g.scopeType === "org";
                  return (
                    <tr key={g.id} className="prow">
                      <td>
                        <div className="pcell">
                          <span className="account-avatar small">{initials(name)}</span>
                          <div>
                            <div className="pname plain">{name}</div>
                            <div className="sub">{person?.user.email ?? ""}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <select
                          value={g.roleKey}
                          disabled={busy || orgWide}
                          onChange={(e) => setGrantRole(g.id, e.target.value)}
                        >
                          {cfg.roles.map((r) => (
                            <option key={r.key} value={r.key}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="sub">
                        {orgWide ? "organization-wide" : "this project"}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {orgWide ? (
                          <span className="sub" title="Managed on the organization's Access screen">
                            in Access
                          </span>
                        ) : (
                          <button
                            className="ghost"
                            disabled={busy}
                            title="Remove from this project's team"
                            onClick={() => removeGrant(g.id)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

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
