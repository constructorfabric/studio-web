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
  withFlag,
  type LockedSource,
  type SourceFlag,
} from "./source-roles";
import { StatusChip } from "./ui-standard";

/** What the Sources tab's role columns read: the config's sources, the
 *  connections they name, the latest revision's lock and the catalogue's
 *  components of the project. */
export interface SourceRoles {
  byDir: Map<string, ProjectSource>;
  home: string | null;
  connections: Map<string, Connection>;
  lock: LockedSource[] | null;
  components: ProjectComponent[] | null;
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
  const [lock, setLock] = useState<LockedSource[] | null>(null);
  const [components, setComponents] = useState<ProjectComponent[] | null>(null);
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
        .catch((): Connection[] => []),
      api
        .productDescription(token, projectId)
        .then((d) => d.latest?.sources_lock ?? [])
        .catch(() => null),
      api
        .projectComponents(token, projectId)
        .then((p) => p.items)
        .catch(() => null),
    ]).then(([config, conns, l, comps]) => {
      if (!live) return;
      setSources(config?.sources ?? []);
      setConnections(new Map(conns.map((c) => [c.id, c])));
      setLock(l);
      setComponents(comps);
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
    lock,
    components,
    saving,
    failed,
    toggle,
  };
}

function FlagBox({
  roles,
  row,
  flag,
  label,
}: {
  roles: SourceRoles;
  row: RepoEntry;
  flag: SourceFlag;
  label: string;
}) {
  const source = roles.byDir.get(row.name);
  const key = `${row.name}:${flag}`;
  return (
    <label className="src-flag" data-source-flag={flag}>
      <input
        type="checkbox"
        aria-label={`${label}: ${row.name}`}
        checked={!!source?.[flag]}
        disabled={!source || roles.saving === key}
        onChange={(e) =>
          void roles.toggle(row.name, flag, e.currentTarget.checked)
        }
      />
      {roles.failed === key ? <span className="sub"> not saved</span> : null}
    </label>
  );
}

/** The role columns of the Sources tab's table: connection, "gears here",
 *  "publish product.gdl here", the commit the latest revision pins, and the
 *  components found. */
export function sourceRoleColumns(roles: SourceRoles): {
  id: string;
  header: string;
  num?: boolean;
  cell: (r: RepoEntry) => ReactNode;
}[] {
  return [
    {
      id: "connection",
      header: "Connection",
      cell: (r) => {
        const s = roles.byDir.get(r.name);
        const c = s?.connection_id
          ? roles.connections.get(s.connection_id)
          : undefined;
        if (!s?.connection_id)
          return <span className="sub">none: cloned without credentials</span>;
        return c ? (
          <span title={c.account}>
            {c.label} <span className="sub">· {c.scope}</span>
          </span>
        ) : (
          <span className="sub">not visible from here</span>
        );
      },
    },
    {
      id: "gears_here",
      header: "Gears here",
      cell: (r) => (
        <FlagBox
          roles={roles}
          row={r}
          flag="gears_here"
          label='"Create a gear" puts new gears here'
        />
      ),
    },
    {
      id: "publish_here",
      header: "Publish product.gdl here",
      cell: (r) => (
        <>
          <FlagBox
            roles={roles}
            row={r}
            flag="publish_here"
            label="A published product.gdl goes here"
          />
          {roles.home === r.name ? (
            <span
              className="sub"
              title="The description travels with this source: its path(...) sources resolve here"
            >
              {" "}
              home
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: "pinned",
      header: "Pinned by the latest revision",
      cell: (r) => {
        const s = roles.byDir.get(r.name);
        if (!s || roles.lock === null)
          return <span className="ing-dash">—</span>;
        const pin = pinnedCommit(roles.lock, s);
        if (pin === undefined) return <span className="sub">not used</span>;
        return pin ? (
          <code title={pin}>{shortCommit(pin)}</code>
        ) : (
          <span className="sub">not pinned</span>
        );
      },
    },
    {
      id: "components",
      header: "Components",
      num: true,
      cell: (r) => {
        const s = roles.byDir.get(r.name);
        const n = s ? componentsIn(roles.components, s) : null;
        return n === null ? <span className="ing-dash">—</span> : n;
      },
    },
  ];
}

/** The latest revision's sources: which a product uses, the branch a dev
 *  build takes and the commit a protected environment takes. On the Product
 *  page (`compact`) and in the Release step. */
export function ProductSources({
  token,
  projectId,
  compact,
}: {
  token: string;
  projectId: string;
  compact?: boolean;
}) {
  const [lock, setLock] = useState<LockedSource[] | null | undefined>(
    undefined,
  );
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
  if (lines.length === 0) {
    return (
      <div className="card" data-product-sources>
        <h3>Sources</h3>
        <p className="sub">
          Revision {revision} pins no source: save the product again so Studio
          records each source's commit. A protected environment builds only a
          pinned revision.
        </p>
      </div>
    );
  }
  const ready = protectedReady(lines);
  return (
    <div className="card" data-product-sources>
      <h3>
        Sources{" "}
        <StatusChip tone={ready ? "ok" : "warn"}>
          {ready
            ? `revision ${revision} pinned`
            : `revision ${revision} not fully pinned`}
        </StatusChip>
      </h3>
      {compact ? null : (
        <p className="sub">
          A dev build takes each source at its branch and records the commit it
          got; a protected environment builds only the commits revision{" "}
          {revision} pinned when it was saved.
        </p>
      )}
      <table className="src-pins">
        <thead>
          <tr>
            <th>Source</th>
            <th>Repository</th>
            <th>Dev: branch</th>
            <th>Protected: pinned</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.repository} data-product-source={l.id}>
              <td>
                <code>{l.id}</code>{" "}
                <span className="sub">
                  {l.kind === "path" ? "path" : "git"}
                </span>
              </td>
              <td>
                {l.repository}
                {l.external ? (
                  <span className="sub"> · named by the description</span>
                ) : null}
              </td>
              <td>{l.branch ?? <span className="sub">—</span>}</td>
              <td>
                {l.pinned ? (
                  <code title={l.pinned}>{shortCommit(l.pinned)}</code>
                ) : (
                  <span className="sub">not pinned</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
