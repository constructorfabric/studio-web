/* ── People & Team ────────────────────────────────────────────────────────────
 *
 * Two surfaces, one component:
 *
 *   mode="org"  — the organization's PEOPLE: its members, as studio-user
 *                 records them (ADR-0040 §1). Inviting here creates a Studio
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
 * names it (ADR-0040 §5). Account-management's `/tenants/{id}/users` is not
 * read: it lists each account's single home tenant in the identity provider,
 * which is not membership.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api, type Colleague } from "./api";
import { DataTable, When } from "./data-table";
import { errText, initials } from "./format";
import { Modal } from "./modal";
import { EmptyState, PageHeader, StatusChip } from "./ui-standard";
import {
  normalizeAccessConfig,
  type AccessConfig,
  type GrantDef,
  type RoleDef,
} from "./access";
import type { RootProject } from "./projects";
import { holderName, orgPeople, withColleagues, type Member, type PersonRow } from "./org-people";
import { PersonPhoto, directoryLine } from "./people-profile";
import { accessOf, gitHandles, lastSeenOf, onlineNow, personProjects, projectStack, type OrgProject } from "./people-activity";
import { PeopleMatrix, PersonPanel, ProjectLegend, ProjectStackCell, openTeam, useOrgActivity } from "./people-org";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** When somebody was last seen, as a date the list can sort and show. */
const seen = (ms: number | undefined) => (ms == null ? null : new Date(ms).toISOString());

/** How many project marks a row shows before "+N". */
const STACK_MAX = 4;

/** The org list's layout, remembered for the tab. */
type Layout = "list" | "matrix";
const LAYOUT_KEY = "people.layout";
function storedLayout(): Layout {
  try {
    return sessionStorage.getItem(LAYOUT_KEY) === "matrix" ? "matrix" : "list";
  } catch {
    return "list";
  }
}

export function PeopleView({
  token,
  org,
  roots,
  mode,
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
  /** Photos, descriptions and last-seen, joined to the members by person id. */
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  /** The person whose side panel is open. */
  const [contact, setContact] = useState<PersonRow | null>(null);
  const [layout, setLayoutState] = useState<Layout>(storedLayout);
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      sessionStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* the choice just is not remembered */
    }
  };
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [addPick, setAddPick] = useState("");
  const [addRole, setAddRole] = useState("");
  /** The Team's add dialog. */
  const [adding, setAdding] = useState(false);
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
      // Best effort: without it the list still has names, addresses and roles.
      setColleagues(orgId ? await api.myColleagues(token).catch(() => [] as Colleague[]) : []);
    } catch (e) {
      setError(errText(e));
      setPeople([]);
    }
  }, [token, orgId]);

  useEffect(() => {
    void load();
  }, [load]);


  /** Member grants that apply to a project: those scoped to it, plus org-wide. */
  function grantsForProject(projectId: string): GrantDef[] {
    if (!cfg) return [];
    return cfg.grants.filter(
      (g) =>
        g.subjectType === "member" &&
        (g.scopeType === "org" || (g.scopeType === "project" && g.scopeId === projectId)),
    );
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
      setInviting(false);
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
      // The person id: what every grant names (ADR-0040 §5).
      subjectId: addPick,
      subjectName: subj ? subj.name : addPick.slice(0, 8),
      roleKey: role,
      scopeType: "project",
      scopeId: teamRoot.id,
      scopeName: teamRoot.name,
    };
    setAddPick("");
    setAdding(false);
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
  const rows = useMemo(
    () => (orgId ? withColleagues(people ?? [], colleagues, orgId) : (people ?? [])),
    [people, colleagues, orgId],
  );
  /* Where each person works: only the org page reads it. */
  const activity = useOrgActivity(
    token,
    mode === "org" ? orgId : null,
    roots,
    mode === "org" && people !== null ? rows : null,
  );
  const model = cfg?.model ?? "tenant";
  const orgProjects: OrgProject[] = activity.projects ?? [];
  const projectRowsOf = (p: PersonRow) =>
    personProjects(orgProjects, accessOf(p.id, p.role, cfg, orgProjects), activity.index.get(p.id));
  const online = onlineNow(activity.dir, activity.presence);
  const lastSeen = (p: PersonRow) => lastSeenOf(p.id, p.lastSeenMs, activity.dir, activity.presence, activity.desktops);
  /** Last seen is a column only when some source has it for somebody. */
  const anySeen = rows.some((p) => lastSeen(p) !== undefined);
  const openProject = (project: OrgProject) => {
    setContact(null);
    openTeam(project, orgId);
  };
  /** How the organization describes a person: title, department, company, manager. */
  const describe = (p: PersonRow) =>
    directoryLine(p.directory, (id) => all.find((m) => m.id === id)?.name);

  /* ── Organization People ── */
  if (mode === "org") {
    return (
      <>
        <PageHeader
          title="People"
          status={
            people === null ? undefined : (
              <>
                <StatusChip tone="neutral">
                  {rows.length} {rows.length === 1 ? "person" : "people"}
                </StatusChip>
                {activity.projects && (
                  <StatusChip tone="neutral">
                    {activity.projects.length} {activity.projects.length === 1 ? "project" : "projects"}
                  </StatusChip>
                )}
                {cfg && (
                  <StatusChip tone="info" title={model === "roles" ? "Grants say who can access which project" : "Everyone can access every project"}>
                    {model === "roles" ? "role-based access" : "tenant access"}
                  </StatusChip>
                )}
                {activity.loading && people.length > 0 && <StatusChip tone="running">reading activity</StatusChip>}
                {!activity.loading && activity.missing.length > 0 && (
                  <StatusChip tone="warn" title={`Could not read: ${activity.missing.join(", ")}`}>
                    some sources unread
                  </StatusChip>
                )}
                {org && <span>in {org.name}</span>}
              </>
            )
          }
          info={
            <>
              <p>
                Everyone in {org?.name ?? "your organization"}, and where they work: the projects each person can access,
                with their role, and the ones they were seen active in. The matrix shows the same for everyone at once.
              </p>
              <p>
                Invite a person to add them to the organization; put them on specific projects from a project&apos;s
                Team tab.
              </p>
            </>
          }
          actions={
            <button type="button" className="primary" disabled={!org} onClick={() => setInviting(true)} data-invite-open>
              Invite
            </button>
          }
        />

        {error && <div className="error">{error}</div>}
        {notice && <div className="hint">{notice}</div>}

        <div className="pp-bar">
          <div className="pp-toggle" role="group" aria-label="Layout">
            <button type="button" className={layout === "list" ? "on" : ""} aria-pressed={layout === "list"} onClick={() => setLayout("list")} data-people-layout="list">
              List
            </button>
            <button type="button" className={layout === "matrix" ? "on" : ""} aria-pressed={layout === "matrix"} onClick={() => setLayout("matrix")} data-people-layout="matrix">
              Matrix
            </button>
          </div>
          <ProjectLegend model={model} />
        </div>

        <div className="card">
          {!org && people !== null ? (
            <p className="empty">No organization in context.</p>
          ) : layout === "matrix" ? (
            people === null || activity.projects === null ? (
              <p className="hint">Loading…</p>
            ) : (
              <PeopleMatrix
                token={token}
                people={rows}
                projects={orgProjects}
                model={model}
                rowsOf={(id) => {
                  const p = rows.find((r) => r.id === id);
                  return p ? projectRowsOf(p) : [];
                }}
                onCell={(project) => openTeam(project, orgId)}
                onPerson={(p) => setContact(p)}
              />
            )
          ) : (
            <DataTable<PersonRow>
              list="people"
              rows={people === null ? null : rows}
              error={people === null ? error : null}
              onRetry={() => void load()}
              rowKey={(p) => p.id}
              rowLabel={(p) => p.name}
              onOpen={(p) => setContact(p)}
              search={{ placeholder: "Search people" }}
              searchText={(p) => [p.name, p.email, describe(p)]}
              empty={{
                title: "Nobody here yet.",
                action: (
                  <button type="button" className="primary" disabled={!org} onClick={() => setInviting(true)}>
                    Invite
                  </button>
                ),
              }}
              columns={[
                {
                  id: "name",
                  header: "Person",
                  compare: (a, b) => a.name.localeCompare(b.name),
                  cell: (p) => (
                    <div className="pcell">
                      <PersonPhoto name={p.name} url={p.avatarUrl} />
                      <div>
                        <div className="pname plain">{p.name}</div>
                        <div className="sub">{[p.email, describe(p)].filter(Boolean).join(" · ")}</div>
                      </div>
                    </div>
                  ),
                },
                {
                  id: "role",
                  header: "Membership",
                  cell: (p) => <span className="sub">{ROLE_LABEL[p.role] ?? p.role}</span>,
                },
                {
                  id: "projects",
                  header: model === "roles" ? "Projects · can access / active in" : "Projects · active in",
                  cell: (p) => (
                    <ProjectStackCell
                      token={token}
                      stack={projectStack(projectRowsOf(p), model, STACK_MAX)}
                      model={model}
                      projectCount={orgProjects.length}
                      hasHandle={gitHandles(activity.identities.get(p.id)?.aliases ?? []).length > 0}
                      loading={activity.loading}
                      onOpen={(r) => openProject(r.project)}
                      onMore={() => setContact(p)}
                    />
                  ),
                },
                ...(anySeen
                  ? [
                      {
                        id: "seen",
                        header: "Last seen",
                        compare: (a: PersonRow, b: PersonRow) => (lastSeen(b) ?? 0) - (lastSeen(a) ?? 0),
                        cell: (p: PersonRow) =>
                          online.has(p.id) ? (
                            <StatusChip tone="ok">online now</StatusChip>
                          ) : (
                            <When iso={seen(lastSeen(p))} className="sub" />
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {contact && (
            <PersonPanel
              token={token}
              person={contact}
              describe={describe(contact)}
              membershipLabel={ROLE_LABEL[contact.role] ?? contact.role}
              model={model}
              rows={projectRowsOf(contact)}
              activity={activity}
              lastSeenMs={lastSeen(contact)}
              online={online.has(contact.id)}
              onOpenProject={openProject}
              onClose={() => setContact(null)}
            />
          )}

          {inviting && (
          <Modal label="Invite to the organization" onClose={() => setInviting(false)}>
            <form onSubmit={(e) => void invite(e)} style={{ display: "flex", flexDirection: "column", gap: 10 }} data-invite-dialog>
              <h2 style={{ margin: 0 }}>Invite to {org?.name ?? "the organization"}</h2>
              <input
                autoFocus
                type="email"
                aria-label="Address to invite"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="hint" style={{ margin: 0 }}>
                They see the invitation when they sign in with this address, and become a member when they accept it.
                Put them on projects from each project&apos;s Team tab.
              </p>
              {error && <div className="error">{error}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="ghost" onClick={() => setInviting(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={busy || !email.trim() || !org}>
                  {busy ? "Inviting…" : "Invite"}
                </button>
              </div>
            </form>
          </Modal>
        )}
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
      {/* One header: who is on the team, in a chip; adding someone is its
          action, in a dialog, rather than a form and a paragraph open under
          the table on every visit. */}
      <PageHeader
        title="Team"
        info={
          <>
            <p>
              Choose who works here: the people working on {teamRoot?.name ?? "this project"}, a subset of{" "}
              {org?.name ?? "the organization"}, each with a role on this project.
            </p>
            <p>
              Adding someone writes a role grant to {org?.name ?? "the organization"}&apos;s access config -- the same
              store the Studio PDP enforces. New people are invited on the organization&apos;s People page first.
            </p>
          </>
        }
        status={
          people !== null &&
          cfg !== null &&
          teamRoot &&
          (roleBased ? (
            <StatusChip tone={teamGrants.length > 0 ? "neutral" : "warn"} data-team-count>
              {teamGrants.length} {teamGrants.length === 1 ? "person" : "people"}
            </StatusChip>
          ) : (
            <StatusChip tone="info" title="Switch to role-based access in Admin → Access to grant roles here">
              tenant access
            </StatusChip>
          ))
        }
        actions={
          roleBased &&
          teamRoot && (
            <button
              type="button"
              className="primary"
              disabled={busy || candidates.length === 0}
              title={candidates.length === 0 ? "Everyone in the organization is on the team" : undefined}
              onClick={() => setAdding(true)}
              data-team-add-open
            >
              Add to team
            </button>
          )
        }
      />

      {error && <div className="error">{error}</div>}

      {people === null || cfg === null ? (
        <p className="hint">Loading team…</p>
      ) : !teamRoot ? (
        <p className="empty">No project in context.</p>
      ) : !roleBased ? (
        <div className="card">
          <EmptyState
            title={`${org?.name ?? "This organization"} uses tenant access: there is no per-project team to manage.`}
            body="Switch to Role-based access in Admin → Access to grant roles to specific people here."
          />
        </div>
      ) : (
        <div className="card">
          <DataTable<GrantDef>
            list="team"
            rows={teamGrants}
            rowKey={(g) => g.id}
            rowLabel={(g) => personName(g)}
            empty={{
              title: "Nobody on the team yet.",
              action: (
                <button type="button" className="primary" disabled={candidates.length === 0} onClick={() => setAdding(true)}>
                  Add to team
                </button>
              ),
            }}
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

        </div>
      )}

      {adding && cfg && teamRoot && (
        <Modal label="Add to the team" onClose={() => setAdding(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addToTeam();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
            data-team-add-dialog
          >
            <h2 style={{ margin: 0 }}>Add to {teamRoot.name}</h2>
            <select aria-label="Person" value={addPick} onChange={(e) => setAddPick(e.target.value)} autoFocus>
              <option value="">Someone from {org?.name ?? "the organization"}…</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label="Role" value={addRole} onChange={(e) => setAddRole(e.target.value)}>
              <option value="">Role: {cfg.roles.find((r) => r.key === "editor")?.name ?? cfg.roles[0]?.name ?? "default"}</option>
              {cfg.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !addPick}>
                Add to team
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
