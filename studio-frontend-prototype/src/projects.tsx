/* ── Workspaces portfolio ─────────────────────────────────────────────────────
 *
 * Level 1 of Org → Workspace → Project. This screen lists the WORKSPACES of the
 * organization in context — each an AM tenant of type `workspace`. Opening one
 * drills into its projects (see WorkspaceProjects in App.tsx); a project is its
 * own AM tenant and owns the code context (sources, IDE, artifacts, people).
 *
 * On the wire:
 *   workspace = AM tenant of type `workspace` (api.tenantChildren of the org)
 * The organization tenant above still exists and still owns the connector
 * catalogue — it is simply not a place you navigate to.
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { api, TENANT_TYPES, type OrgOverview, type OrgWorkspace, type User } from "./api";
import { money } from "./costs";
import { DataTable } from "./data-table";
import { errText } from "./format";
import { Modal } from "./modal";
import { growthText, quietText, workspaceDescription, workspaceLine, workspaceStatus } from "./org-dashboard-model";
import { portfolioRollups, rollupText, type WorkspaceRollup } from "./rollups";
import { TenantMark } from "./tenant-icon-view";
import { PageHeader, StatusChip } from "./ui-standard";
import { Tile } from "./view-mode";

/** Initials + a stable hue from a name — the mockups' colored member discs. */
function initials(name: string): string {
  const parts = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
/** Overlapping member avatars (real users from tenantUsers), +N overflow. */
function Avatars({ users }: { users?: User[] }) {
  if (!users) return <span className="sub">…</span>;
  if (users.length === 0) return <span className="sub">—</span>;
  return (
    <span className="avatars">
      {users.slice(0, 3).map((u) => {
        const label = u.display_name || u.username;
        return (
          <span
            key={u.id}
            className="avatar"
            style={{ "--hue": hueOf(label) } as CSSProperties}
            title={label}
          >
            {initials(label)}
          </span>
        );
      })}
      {users.length > 3 && <span className="avatars-more">+{users.length - 3}</span>}
    </span>
  );
}

/** The AM tenant behind a workspace — structurally what App.tsx holds. */
export interface RootProject {
  id: string;
  name: string;
  /** Implicit organization owning it. Hidden in the UI, kept in the model. */
  orgId: string;
  orgName: string;
  self_managed: boolean;
}

export function ProjectsPortfolio({
  token,
  roots,
  homeOrgId,
  org,
  onOpen,
  onOpenProject,
  onChanged,
}: {
  token: string;
  roots: RootProject[];
  /** The organization these workspaces belong to — chosen in the sidebar
   *  switcher; shown here only as breadcrumb/footer context. */
  org: { id: string; name: string } | null;
  /** The side panel's search, filter and sort. Not read: the list has its own
   *  (docs/list-standard.md) — a search box in one place and a filter in
   *  another, both for the same list, was the inconsistency. */
  query?: string;
  selfManagedOnly?: boolean;
  sort?: "name-asc" | "name-desc";
  /** Where a new workspace is created — the hidden organization. */
  homeOrgId: string | null;
  onOpen: (root: RootProject) => void;
  /** Not offered here any more: the IDE opens from a project, where its
   *  sources are; a workspace only groups projects. Kept so callers compile. */
  onOpenStudio?: (root: RootProject) => void;
  /** Open a nested project (from the expandable tree under a workspace). */
  onOpenProject?: (wsId: string, p: { id: string; name: string }) => void;
  onChanged: () => void;
}) {
  const [people, setPeople] = useState<Record<string, User[]>>({});
  /** What each workspace contains. Absent until counted — see rollups.ts on
   *  why an uncounted workspace must not render as 0. */
  const [rollups, setRollups] = useState<Record<string, WorkspaceRollup>>({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The workspace being renamed, and the name being typed. */
  const [renaming, setRenaming] = useState<RootProject | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const saveRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const next = renameTo.trim();
    if (!next || next === renaming.name) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setRenameError(null);
    try {
      await api.updateTenant(token, renaming.id, { name: next });
      setRenaming(null);
      onChanged();
    } catch (err) {
      setRenameError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  // Nested projects per workspace, read the first time a row is expanded.
  const [children, setChildren] = useState<Record<string, { id: string; name: string }[]>>({});
  const loadChildren = useCallback(
    async (wsId: string) => {
      try {
        const page = await api.tenantChildrenAll(token, wsId);
        const kids = (page.items ?? [])
          .filter((t) => t.tenant_type === TENANT_TYPES.project)
          .map((t) => ({ id: t.id, name: t.name }));
        setChildren((c) => ({ ...c, [wsId]: kids }));
      } catch {
        setChildren((c) => ({ ...c, [wsId]: [] }));
      }
    },
    [token],
  );

  const ids = roots.map((r) => r.id).join(",");

  const load = useCallback(async () => {
    if (!ids) {
      setPeople({});
      setRollups({});
      return;
    }
    const list = ids.split(",");
    // Per workspace, and tolerant: a self-managed tenant answers 404 from
    // outside its subtree, which is tenant isolation working — not a reason to
    // blank the page.
    const entries = await Promise.all(
      list.map(async (id) => {
        const users = await api.tenantUsersAll(token, id).then(
          (p) => p.items ?? [],
          () => [] as User[],
        );
        return [id, users] as const;
      }),
    );
    setPeople(Object.fromEntries(entries));
    // The project counts, and the children they counted — ONE request for the
    // whole table now, not one per workspace. Kept as a second pass rather than
    // folded into the one above so the table paints with names and people
    // first: a count arriving a moment later is a cell changing from "—" to a
    // number, which is much better than a blank page while it is fetched.
    const { workspaces, projects } = await portfolioRollups(token);
    setRollups(
      Object.fromEntries(list.map((id) => [id, { projects: workspaces.get(id)?.projects ?? null }])),
    );
    // The same answer carries the parentage, so the tree expands without
    // asking again.
    setChildren((c) => {
      const next = { ...c };
      for (const id of list) {
        const kids = [...projects.entries()]
          .filter(([, p]) => p.parentId === id)
          .map(([pid, p]) => ({ id: pid, name: p.name }));
        if (kids.length) next[id] = kids;
      }
      return next;
    });
  }, [token, ids]);

  useEffect(() => {
    void load();
  }, [load]);

  // Spend, failing specs, stuck pull requests and quiet days per workspace:
  // the organization overview's numbers, shown where the workspaces are.
  const [overview, setOverview] = useState<OrgOverview | null>(null);
  useEffect(() => {
    if (!org) return;
    let live = true;
    api
      .orgOverview(token, org.id)
      .then((o) => live && setOverview(o))
      .catch(() => live && setOverview(null));
    return () => {
      live = false;
    };
  }, [token, org?.id]);
  const health = (id: string): OrgWorkspace | undefined => overview?.workspaces.find((w) => w.id === id);
  const stuckDays = overview?.stuck_days ?? 7;
  const cash = (n: number) => money(n, overview?.spend?.currency || "USD");
  const describe = (r: RootProject) => {
    const h = health(r.id);
    if (h && h.projects.some((p) => p.reasons.length > 0)) return workspaceLine(h, stuckDays);
    const kids = children[r.id] ?? (rollups[r.id]?.projects === 0 ? [] : undefined);
    return workspaceDescription(kids?.map((p) => p.name), r.self_managed);
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!homeOrgId || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, {
        name: name.trim(),
        parent_id: homeOrgId,
        tenant_type: TENANT_TYPES.workspace,
      });
      setName("");
      setCreating(false);
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const byName = [...roots].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title="Workspaces"
        status={
          <>
            <StatusChip tone="neutral">
              {roots.length} {roots.length === 1 ? "workspace" : "workspaces"}
            </StatusChip>
            {org && <span>in {org.name}</span>}
          </>
        }
        info="A workspace groups related projects. Open one to see its projects — each project owns its connectors, artifacts and people, and its own IDE sessions."
      />

      {creating && (
        <div className="card">
          <form className="inline" onSubmit={create}>
            <input
              autoFocus
              style={{ flex: 1 }}
              placeholder="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create"}
            </button>
            <button type="button" className="ghost" onClick={() => setCreating(false)}>
              cancel
            </button>
          </form>
          <p className="hint">
            Created inside your organization — which stays out of the UI on purpose: it owns the
            shared connector catalogue and nothing you need to navigate.
          </p>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {renaming && (
        <Modal label={`Rename workspace “${renaming.name}”`} onClose={() => setRenaming(null)}>
          <form onSubmit={(e) => void saveRename(e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 style={{ margin: 0 }}>Rename workspace</h2>
            <input
              autoFocus
              aria-label="Workspace name"
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
            />
            {renameError && <div className="error">{renameError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy || !renameTo.trim()}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div className="card">
        <DataTable<RootProject>
          list="workspaces"
          title="Workspaces"
          rows={roots === null ? null : byName}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.name}
          onOpen={(r) => onOpen(r)}
          search={{ placeholder: "Search workspaces" }}
          searchText={(r) => [r.name]}
          filters={[
            {
              id: "managed",
              allLabel: "All workspaces",
              kind: "chips",
              options: [
                { value: "self", label: "Self-managed" },
                { value: "org", label: "Managed by the organization" },
              ],
              match: (r, v) => (v === "self" ? !!r.self_managed : !r.self_managed),
            },
          ]}
          primary={
            <button className="primary" disabled={!homeOrgId} onClick={() => setCreating((v) => !v)}>
              New workspace
            </button>
          }
          empty={{ title: "No workspaces yet.", body: "“New workspace” starts the first one." }}
          columns={[
            {
              id: "name",
              header: "Workspace",
              compare: (a, b) => a.name.localeCompare(b.name),
              cell: (r) => (
                <div className="pcell">
                  <TenantMark token={token} level="workspace" id={r.id} name={r.name} className="pico ticon-mark" />
                  <div>
                    <div className="pname">{r.name}</div>
                    <div className="sub" data-workspace-description>
                      {describe(r)}
                    </div>
                  </div>
                </div>
              ),
            },
            {
              id: "projects",
              header: "Projects",
              num: true,
              compare: (a, b) => (rollups[a.id]?.projects ?? -1) - (rollups[b.id]?.projects ?? -1),
              cell: (r) => rollupText(rollups[r.id]?.projects ?? null),
            },
            { id: "people", header: "People", cell: (r) => <Avatars users={people[r.id]} /> },
            {
              id: "spend",
              header: "Spend, 30 d",
              num: true,
              cell: (r) => {
                const h = health(r.id);
                return h?.spend == null ? "—" : cash(h.spend);
              },
              compare: (a, b) => (health(a.id)?.spend ?? 0) - (health(b.id)?.spend ?? 0),
            },
            {
              id: "delta",
              header: "Δ",
              num: true,
              cell: (r) => {
                const h = health(r.id);
                return h?.spend == null || h.previous === null ? "—" : growthText(h.spend, h.previous);
              },
            },
            {
              id: "failing",
              header: "Failing specs",
              num: true,
              cell: (r) => health(r.id)?.specs_failing || "—",
              compare: (a, b) => (health(a.id)?.specs_failing ?? 0) - (health(b.id)?.specs_failing ?? 0),
            },
            {
              id: "stuck",
              header: `PRs > ${stuckDays} d`,
              num: true,
              cell: (r) => health(r.id)?.stuck || "—",
              compare: (a, b) => (health(a.id)?.stuck ?? 0) - (health(b.id)?.stuck ?? 0),
            },
            {
              id: "quiet",
              header: "Quiet",
              num: true,
              cell: (r) => quietText(health(r.id)?.quiet_days ?? null),
              compare: (a, b) => (health(a.id)?.quiet_days ?? -1) - (health(b.id)?.quiet_days ?? -1),
            },
          ]}
          expand={(r) => <NestedProjects kids={children[r.id]} load={() => loadChildren(r.id)} onOpen={(p) => onOpenProject?.(r.id, p)} />}
          actions={(r) => [
            { label: "Open", onSelect: () => onOpen(r) },
            {
              label: "Rename",
              onSelect: () => {
                setRenameTo(r.name);
                setRenameError(null);
                setRenaming(r);
              },
            },
            {
              label: "Delete",
              danger: {
                title: `Delete workspace “${r.name}”?`,
                body: "The workspace goes, and the account system may refuse while it still has projects — delete those first.",
                confirmLabel: "Delete",
              },
              onSelect: async () => {
                await api.deleteTenant(token, r.id);
                onChanged();
              },
            },
          ]}
          tile={(r, open) => (
            /* The tree does not come with: a card that unfolds into other
               cards is a table with extra steps. */
            <Tile
              icon={<TenantMark token={token} level="workspace" id={r.id} name={r.name} />}
              title={r.name}
              subtitle={describe(r)}
              onClick={open}
              /* People come from the avatar list, not the rollup, and `?? null`
                 keeps "not read yet" a dash instead of nobody. */
              stats={[
                { label: "projects", value: rollupText(rollups[r.id]?.projects ?? null) },
                { label: "people", value: rollupText(people[r.id]?.length ?? null) },
              ]}
              footer={<Avatars users={people[r.id]} />}
            />
          )}
        />
      </div>
    </>
  );
}

/** A workspace's projects, under its row: read on first open. */
function NestedProjects({
  kids,
  load,
  onOpen,
}: {
  kids: { id: string; name: string }[] | undefined;
  load: () => void;
  onOpen: (p: { id: string; name: string }) => void;
}) {
  useEffect(() => {
    if (kids === undefined) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (kids === undefined) return <div className="nested-projects nested-note">Loading projects…</div>;
  if (kids.length === 0) return <div className="nested-projects nested-note">No projects in this workspace yet.</div>;
  return (
    <ul className="nested-projects" aria-label="Projects in this workspace">
      {kids.map((p) => (
        <li key={p.id}>
          <button type="button" className="nested-project" onClick={() => onOpen(p)}>
            <ProjectGlyph />
            <span className="nested-name">{p.name}</span>
            <span className="nested-open" aria-hidden>
              Open ›
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A small project glyph: a document with a fold, beside the folder of its
 *  workspace. */
function ProjectGlyph() {
  return (
    <svg className="nested-glyph" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 1.8h5.2L12.4 5v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.9V5h3.3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** A workspace page's line under its name: what it holds -- its projects by
 *  name and "3 projects · 213 findings" -- read once, in one request. */
export function WorkspaceStatusLine({ token, workspaceId, selfManaged }: { token: string; workspaceId: string; selfManaged: boolean }) {
  const [read, setRead] = useState<{ names: string[]; projects: number | null; findings: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    setRead(null);
    portfolioRollups(token, workspaceId)
      .then(({ workspaces, projects }) => {
        if (!live) return;
        const mine = [...projects.values()].filter((p) => p.parentId === workspaceId);
        const counted = mine.filter((p) => p.findings !== null);
        setRead({
          names: mine.map((p) => p.name),
          projects: workspaces.get(workspaceId)?.projects ?? mine.length,
          findings: counted.length ? counted.reduce((n, p) => n + (p.findings ?? 0), 0) : null,
        });
      })
      .catch(() => live && setRead({ names: [], projects: null, findings: null }));
    return () => {
      live = false;
    };
  }, [token, workspaceId]);
  if (!read) return <span className="sub">…</span>;
  const status = workspaceStatus(read.projects, read.findings);
  const description = workspaceDescription(read.projects === null ? undefined : read.names, selfManaged);
  return (
    <span className="ws-status" data-workspace-status>
      {description && <span>{description}</span>}
      {description && status && <span aria-hidden> · </span>}
      {status && <b>{status}</b>}
    </span>
  );
}
