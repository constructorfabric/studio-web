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
import { api, TENANT_TYPES, type User } from "./api";
import { errText, matches } from "./format";

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

/** A small folder glyph for the workspace name cell. */
function FolderIcon() {
  return (
    <svg className="folder" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.6 4.4A1.4 1.4 0 0 1 3 3h2.8l1.4 1.4H13A1.4 1.4 0 0 1 14.4 5.8v5.0A1.4 1.4 0 0 1 13 12.2H3A1.4 1.4 0 0 1 1.6 10.8z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
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
  query,
  selfManagedOnly,
  sort,
  homeOrgId,
  org,
  onOpen,
  onOpenStudio,
  onChanged,
}: {
  token: string;
  roots: RootProject[];
  /** The organization these workspaces belong to — chosen in the sidebar
   *  switcher; shown here only as breadcrumb/footer context. */
  org: { id: string; name: string } | null;
  /** Search box from the right-hand filter panel. */
  query: string;
  /** Filter panel: only workspaces whose tenant raised the isolation barrier. */
  selfManagedOnly: boolean;
  sort: "name-asc" | "name-desc";
  /** Where a new workspace is created — the hidden organization. */
  homeOrgId: string | null;
  onOpen: (root: RootProject) => void;
  onOpenStudio: (root: RootProject) => void;
  onChanged: () => void;
}) {
  const [people, setPeople] = useState<Record<string, User[]>>({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = roots.map((r) => r.id).join(",");

  const load = useCallback(async () => {
    if (!ids) {
      setPeople({});
      return;
    }
    const list = ids.split(",");
    // Per workspace, and tolerant: a self-managed tenant answers 404 from
    // outside its subtree, which is tenant isolation working — not a reason to
    // blank the page.
    const entries = await Promise.all(
      list.map(async (id) => {
        const users = await api.tenantUsers(token, id).then(
          (p) => p.items ?? [],
          () => [] as User[],
        );
        return [id, users] as const;
      }),
    );
    setPeople(Object.fromEntries(entries));
  }, [token, ids]);

  useEffect(() => {
    void load();
  }, [load]);

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

  async function remove(root: RootProject) {
    if (!window.confirm(`Delete workspace “${root.name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteTenant(token, root.id);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  const visible = roots
    .filter((r) => matches(query, r.name))
    .filter((r) => !selfManagedOnly || r.self_managed)
    .sort((a, b) => (sort === "name-desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));

  return (
    <>
      <div className="topbar">
        <div>
          {/* The organization is chosen in the sidebar switcher now; the
              portfolio just names where you are. */}
          {org && <div className="eyebrow">{org.name}</div>}
          <h1 style={{ marginTop: 8 }}>Workspaces</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            A workspace groups related projects. Open one to see its projects — each project owns its
            connectors, artifacts and people, and its own IDE sessions.
          </p>
        </div>
        <button className="primary" disabled={!homeOrgId} onClick={() => setCreating((v) => !v)}>
          New workspace
        </button>
      </div>

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

      <div className="card">
        {roots.length === 0 ? (
          <p className="empty">No workspaces yet — “New workspace” starts the first one.</p>
        ) : visible.length === 0 ? (
          <p className="empty">No workspaces match the current filters.</p>
        ) : (
          <table className="ptable">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>People</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((root) => (
                <tr key={root.id} className="prow root">
                  <td>
                    <div className="pcell">
                      <span className="pico" aria-hidden>
                        <FolderIcon />
                      </span>
                      <div>
                        <button type="button" className="pname" onClick={() => onOpen(root)}>
                          {root.name}
                        </button>
                        <div className="sub">{root.self_managed ? "self-managed" : "workspace"}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Avatars users={people[root.id]} />
                  </td>
                  <td className="pactions">
                    <button onClick={() => onOpen(root)}>Open</button>
                    <button className="primary" onClick={() => onOpenStudio(root)}>
                      Open Studio
                    </button>
                    <button className="ghost" title="Delete workspace" onClick={() => void remove(root)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {visible.length > 0 && (
          <div className="ptable-foot">
            <span>
              {visible.length} workspace{visible.length === 1 ? "" : "s"}
            </span>
            {org && <span className="sub">in {org.name}</span>}
          </div>
        )}
      </div>
    </>
  );
}
