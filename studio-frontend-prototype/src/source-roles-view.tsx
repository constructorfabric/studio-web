/* What each source is for, on the Sources tab, and which sources a product
 * uses, on the Product page and in the Release step (ADR-0060). The model is
 * source-roles.ts. */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, type Connection, type RepoEntry } from "./api";
import type { ProjectComponent } from "./project-checks";
import { named, type ProjectSource } from "./project-sources";
import {
  componentsIn,
  descriptionHome,
  pinnedCommit,
  protectedReady,
  releaseSources,
  shortCommit,
  sourceWarning,
  withFlag,
  type LockedSource,
  type SourceFlag,
  type SourceUnreadable,
} from "./source-roles";
import { StatusChip } from "./ui-standard";

/** What the Sources tab's role columns read: the config's sources, the
 *  connections they name, the latest revision's lock and the catalogue's
 *  components of the project. */
export interface SourceRoles {
  byDir: Map<string, ProjectSource>;
  home: string | null;
  connections: Map<string, Connection>;
  /** Whether `connections` was read: a source whose connection is missing
   *  from a list that was not read is not called deleted. */
  connectionsRead: boolean;
  lock: LockedSource[] | null;
  components: ProjectComponent[] | null;
  /** The sources the server could not read, and why (the components list). */
  unreadable: SourceUnreadable[] | null;
  saving: string | null;
  failed: string | null;
  toggle: (dir: string, flag: SourceFlag, on: boolean) => Promise<void>;
}

/** The Sources tab's roles, read again whenever `round` changes. */
export function useSourceRoles(
  token: string,
  projectId: string,
  round: unknown,
): SourceRoles {
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [connections, setConnections] = useState<Map<string, Connection>>(
    new Map(),
  );
  const [connectionsRead, setConnectionsRead] = useState(false);
  const [lock, setLock] = useState<LockedSource[] | null>(null);
  const [components, setComponents] = useState<ProjectComponent[] | null>(null);
  const [unreadable, setUnreadable] = useState<SourceUnreadable[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([
      api.projectConfig(token, projectId).catch(() => null),
      api
        .connections(token, projectId)
        .then((p) => p.items)
        .catch((): Connection[] | null => null),
      api
        .productDescription(token, projectId)
        .then((d) => d.latest?.sources_lock ?? [])
        .catch(() => null),
      api.projectComponents(token, projectId).catch(() => null),
    ]).then(([config, conns, l, comps]) => {
      if (!live) return;
      setSources(config?.sources ?? []);
      setConnections(new Map((conns ?? []).map((c) => [c.id, c])));
      setConnectionsRead(conns !== null);
      setLock(l);
      setComponents(comps?.items ?? null);
      setUnreadable(comps ? (comps.unreadable?.sources ?? []) : null);
    });
    return () => {
      live = false;
    };
  }, [token, projectId, round, tick]);

  const toggle = useCallback(
    async (dir: string, flag: SourceFlag, on: boolean) => {
      setSaving(`${dir}:${flag}`);
      setFailed(null);
      try {
        // Read fresh, change the one flag, write back: as share mode does.
        const config = (await api.projectConfig(token, projectId)) ?? {};
        await api.putProjectConfig(token, projectId, {
          ...config,
          sources: withFlag(config.sources, dir, flag, on),
        });
        setTick((t) => t + 1);
      } catch {
        setFailed(`${dir}:${flag}`);
      } finally {
        setSaving(null);
      }
    },
    [token, projectId],
  );

  const byDir = new Map(named(sources).map((n) => [n.dir, n.source]));
  return {
    byDir,
    home: descriptionHome(sources),
    connections,
    connectionsRead,
    lock,
    components,
    unreadable,
    saving,
    failed,
    toggle,
  };
}

/** One flag as a small toggle chip: checked, it marks this source. */
function FlagChip({
  roles,
  row,
  flag,
  text,
  title,
}: {
  roles: SourceRoles;
  row: RepoEntry;
  flag: SourceFlag;
  text: string;
  title: string;
}) {
  const source = roles.byDir.get(row.name);
  const key = `${row.name}:${flag}`;
  const on = !!source?.[flag];
  return (
    <label
      data-source-flag={flag}
      title={roles.failed === key ? `${title} (not saved)` : title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        whiteSpace: "nowrap",
        fontSize: 12,
        opacity: on ? 1 : 0.7,
      }}
    >
      <input
        type="checkbox"
        aria-label={`${title}: ${row.name}`}
        checked={on}
        disabled={!source || roles.saving === key}
        onChange={(e) => void roles.toggle(row.name, flag, e.currentTarget.checked)}
        style={{ margin: 0 }}
      />
      {text}
      {roles.failed === key ? <span className="error"> !</span> : null}
    </label>
  );
}

/** What a source is for, in one cell of the Sources table: the two flags as
 *  toggles, "home" when the description travels with it, and below them the
 *  connection, the commit the latest revision pins and the components found.
 *  One column, wrapping, so the table keeps its width. */
export function sourceRoleColumns(roles: SourceRoles): {
  id: string;
  header: string;
  cell: (r: RepoEntry) => ReactNode;
}[] {
  return [
    {
      id: "use",
      header: "Used for",
      cell: (r) => {
        const s = roles.byDir.get(r.name);
        const c = s?.connection_id ? roles.connections.get(s.connection_id) : undefined;
        const pin = s && roles.lock !== null ? pinnedCommit(roles.lock, s) : undefined;
        const n = s ? componentsIn(roles.components, s) : null;
        const warning = sourceWarning(
          s,
          roles.unreadable,
          roles.connectionsRead ? new Set(roles.connections.keys()) : null,
        );
        const facts = [
          !s?.connection_id ? "no connection" : c ? c.label : "connection not visible",
          pin ? `pinned ${shortCommit(pin)}` : pin === null ? "not pinned" : null,
          n === null ? null : `${n} component${n === 1 ? "" : "s"}`,
        ].filter(Boolean);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <FlagChip roles={roles} row={r} flag="gears_here" text="gears" title='"Create a gear" puts new gears here' />
              <FlagChip roles={roles} row={r} flag="publish_here" text="publish" title="A published product.gdl goes here" />
              {roles.home === r.name ? (
                <span className="sub" title="The description travels with this source: its path(...) sources resolve here">
                  home
                </span>
              ) : null}
            </div>
            <span className="sub" style={{ overflowWrap: "anywhere" }} title={pin ?? undefined}>
              {facts.join(" · ")}
            </span>
            {warning ? (
              <span className="warn" data-source-unreadable={r.name} role="status" style={{ overflowWrap: "anywhere", fontSize: 12 }}>
                ⚠ {warning}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];
}

/** The latest revision's sources: which a product uses, the branch a dev
 *  build takes and the commit a protected environment takes. On the Product
 *  page (`compact`: one line) and in the Release step. */
export function ProductSources({
  token,
  projectId,
  compact,
}: {
  token: string;
  projectId: string;
  compact?: boolean;
}) {
  const [lock, setLock] = useState<LockedSource[] | null | undefined>(undefined);
  const [revision, setRevision] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    api
      .productDescription(token, projectId)
      .then((d) => {
        if (!live) return;
        setLock(d.latest?.sources_lock ?? []);
        setRevision(d.latest?.revision ?? null);
      })
      .catch(() => live && setLock(null));
    return () => {
      live = false;
    };
  }, [token, projectId]);
  if (lock === undefined || lock === null || revision === null) return null;
  const lines = releaseSources(lock);
  const ready = protectedReady(lines);
  const row = { display: "flex", flexWrap: "wrap" as const, gap: 8, alignItems: "center", minWidth: 0 };
  if (compact) {
    return (
      <div data-product-sources className="sub" style={{ ...row, margin: "4px 0" }}>
        <span>Sources:</span>
        {lines.length === 0 ? (
          <span>revision {revision} pins none -- save again to pin them</span>
        ) : (
          lines.map((l) => (
            <span key={l.repository} data-product-source={l.id} title={l.pinned ?? undefined} style={{ whiteSpace: "nowrap" }}>
              <code>{l.repository.split("/").pop()}</code> {l.pinned ? shortCommit(l.pinned) : "not pinned"}
            </span>
          ))
        )}
      </div>
    );
  }
  return (
    <div data-product-sources style={{ display: "flex", flexDirection: "column", gap: 4, margin: "0 0 12px" }}>
      <div style={row}>
        <strong>Sources</strong>
        <StatusChip tone={ready ? "ok" : "warn"}>
          {lines.length === 0
            ? `revision ${revision} pins none`
            : ready
              ? `revision ${revision} pinned`
              : `revision ${revision} not fully pinned`}
        </StatusChip>
        <span className="sub">dev builds each branch; a protected environment builds the pins</span>
      </div>
      {lines.map((l) => (
        <div key={l.repository} data-product-source={l.id} className="sub" style={row}>
          <code>{l.repository}</code>
          <span>dev: {l.branch ?? "—"}</span>
          <span title={l.pinned ?? undefined}>protected: {l.pinned ? shortCommit(l.pinned) : "not pinned"}</span>
          {l.external ? <span>named by the description</span> : null}
        </div>
      ))}
    </div>
  );
}
