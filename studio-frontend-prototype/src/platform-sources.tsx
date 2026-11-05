/* The Sources pages (ADR-0046): where a tier's gears come from.
 *
 * Platform › Sources lists the platform's gear repositories. Each is a
 * connection of the `gear-repository` kind in the root tenant -- one
 * repository at one ref, read with its own token or none -- and the Gearbox
 * engine reads them all together, in the order they were added, as the
 * corpus every organization's catalogue, previews and products draw on. Every
 * organization sees the list; a platform administrator changes it. While it
 * is empty, the engine reads the deployment's corpus, and the page says so.
 *
 * Organization › Sources (phase 3) shows the platform's list read-only, then
 * the organization's own gear repositories, which its corpus reads after the
 * platform's. One of them is where "Create a gear" writes. */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  PLATFORM_ROOT_TENANT_ID,
  api,
  type CatalogRepoSource,
  type Connection,
  type GearboxStatus,
  type OrgGearRepositoryState,
} from "./api";
import { ScaffoldModal } from "./documents";
import { gearRepoConnections } from "./org-gear-repository";
import { CreateGearRepository } from "./org-repository-create";
import { type RepositoryRoles, refLabel, repositoryRoles, rolesNote } from "./component-repositories";
import { type Column, DataTable, type EmptySpec, type RowAction } from "./data-table";
import { errText } from "./format";
import { EmptyState, InfoPopover, PageHeader, StatusChip } from "./ui-standard";
import {
  GEAR_REPOSITORY,
  type GearRepositoryRow,
  createTargetOf,
  defaultSourceId,
  deploymentCorpus,
  gearRepositoryRows,
  gearRepositoryRowsFromStatus,
  isSourceId,
  readLine,
  repositoryOf,
} from "./gear-repositories";

export function PlatformSources({
  token,
  isPlatformAdmin,
  catalogueSettings,
}: {
  token: string;
  isPlatformAdmin: boolean;
  catalogueSettings?: ReactNode;
}) {
  return (
    <GearSources
      token={token}
      tier="platform"
      tenantId={PLATFORM_ROOT_TENANT_ID}
      mayManage={isPlatformAdmin}
      catalogueSettings={isPlatformAdmin ? catalogueSettings : undefined}
    />
  );
}

/** Organization › Components › Repositories: who may change the list is who
 *  may manage the organization's registry (`component.registry`). `embedded`
 *  drops the page heading, which the Components page already has. */
export function OrgSources({
  token,
  orgId,
  embedded = false,
  catalogueSettings,
}: {
  token: string;
  orgId?: string;
  embedded?: boolean;
  catalogueSettings?: ReactNode;
}) {
  const [mayManage, setMayManage] = useState(false);
  useEffect(() => {
    api
      .orgGearRepository(token)
      .then((r) => setMayManage(r.may_manage))
      .catch(() => setMayManage(false));
  }, [token]);
  if (!orgId) return <EmptyState title="Open an organization to see its sources." />;
  return (
    <GearSources
      token={token}
      tier="organization"
      tenantId={orgId}
      mayManage={mayManage}
      embedded={embedded}
      catalogueSettings={catalogueSettings}
    />
  );
}

function GearSources({
  token,
  tier,
  tenantId,
  mayManage,
  embedded = false,
  catalogueSettings,
}: {
  token: string;
  tier: "platform" | "organization";
  tenantId: string;
  mayManage: boolean;
  embedded?: boolean;
  /** The catalogue's own settings and sync, drawn under the list. */
  catalogueSettings?: ReactNode;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  // The other role of the same repositories: what the catalogue syncs. The
  // platform's list is a platform administrator's to read; an organization's,
  // its members'.
  const [catalogue, setCatalogue] = useState<CatalogRepoSource[] | null>(null);
  const [cratesIo, setCratesIo] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ url: string; ref: string; at: number } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  // Where Create a gear writes for the organization: the setting the server
  // keeps (ADR-0042 §2), which follows the repository marked here once one is.
  const [writeTarget, setWriteTarget] = useState<OrgGearRepositoryState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newGear, setNewGear] = useState(false);
  const [status, setStatus] = useState<GearboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusRead, setStatusRead] = useState(false);

  const org = tier === "organization";
  // The platform's connections are read by a platform administrator only;
  // every other member sees its list as the engine read it. An
  // organization's own are read by its members.
  const readsConnections = org || mayManage;

  const load = useCallback(
    (refresh = false) => {
      if (readsConnections)
        api
          .connections(token, tenantId)
          .then((r) => setConnections(r.items))
          .catch((e) => {
            setConnections([]);
            setError(errText(e));
          });
      // The engine may be fetching its repositories as it answers: say so
      // rather than "not read yet" while it does.
      setStatusRead(false);
      api
        .gearboxStatus(token, refresh, org ? tenantId : undefined)
        .then(setStatus)
        .catch(() => setStatus(null))
        .finally(() => setStatusRead(true));
      if (org)
        api
          .orgGearRepository(token)
          .then(setWriteTarget)
          .catch(() => setWriteTarget(null));
      if (org)
        api
          .catalogSources(token)
          .then((r) => setCatalogue(r.items ?? []))
          .catch(() => setCatalogue(null));
      else if (mayManage)
        api
          .platformSources(token)
          .then((r) => {
            setCatalogue(r.items ?? []);
            setCratesIo(r.crates_io ?? null);
          })
          .catch(() => setCatalogue(null));
    },
    [token, tenantId, org, readsConnections, mayManage],
  );
  useEffect(() => load(), [load]);

  const own: GearRepositoryRow[] = readsConnections
    ? gearRepositoryRows(connections ?? [], tenantId, status)
    : gearRepositoryRowsFromStatus(status, "platform");
  const platformRows = org ? gearRepositoryRowsFromStatus(status, "platform") : [];
  const loading = readsConnections ? connections === null : !statusRead;
  const fallback = !org && own.length === 0 ? deploymentCorpus(status) : null;
  const target = org ? createTargetOf(own) : null;

  const act = async (c: Connection, what: () => Promise<void>) => {
    setBusy(c.id);
    setError(null);
    setNote(null);
    try {
      await what();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const test = (c: Connection) =>
    act(c, async () => {
      const r = await api.testConnection(token, c.id, tenantId);
      setNote(`${r.account}: ${r.display_name ?? "reachable"}`);
    });
  const remove = (c: Connection) => {
    void act(c, async () => {
      await api.deleteConnection(token, c.id, tenantId);
      load(true);
    });
  };
  const markTarget = (c: Connection) =>
    act(c, async () => {
      await api.patchConnection(token, c.id, { options: { ...(c.options ?? {}), create_target: "true" } }, tenantId);
      setNote(`New gears go into ${repositoryOf(c.base_url) ?? c.label}.`);
      load(false);
    });

  const targetRepo = writeTarget?.gear_repository?.repo ?? null;
  const roles = repositoryRoles(own, catalogue ?? [], fallback);
  if (targetRepo && !roles.some((r) => r.repo.toLowerCase() === targetRepo.toLowerCase()))
    roles.push({ repo: targetRepo, catalogue: [], engine: null, fallback: false });
  const writesHere = (r: RepositoryRoles) =>
    (!!target && r.engine?.connection?.id === target) || (!!targetRepo && r.repo.toLowerCase() === targetRepo.toLowerCase());
  const githubConnections = gearRepoConnections(connections ?? [], tenantId);
  // A repository the organization only lists can take new gears too: through
  // its GitHub connection, as the setting always could.
  const writeTo = (r: RepositoryRoles) => {
    const c = r.engine?.connection;
    if (c) return void markTarget(c);
    const via = githubConnections[0];
    if (!via) return setError("The organization has no GitHub connection to write through: add one under Connections.");
    const gears = r.catalogue.find((x) => (x.mode || "gears") === "gears");
    void api
      .setOrgGearRepository(token, {
        connection_id: gears?.connection_id || via.id,
        repo: r.repo,
        branch: gears?.git_ref && gears.git_ref !== "HEAD" ? gears.git_ref : undefined,
      })
      .then((st) => {
        setWriteTarget(st);
        setNote(`New gears go into ${r.repo}.`);
      })
      .catch((e) => setError(errText(e)));
  };
  const stopWriting = () =>
    void api
      .deleteOrgGearRepository(token)
      .then((st) => {
        setWriteTarget(st);
        setNote("Create a gear writes into each project's own repository again.");
      })
      .catch((e) => setError(errText(e)));
  const platformRoles = repositoryRoles(platformRows, [], platformRows.length === 0 ? deploymentCorpus(status) : null);
  const saveCatalogue = async (items: CatalogRepoSource[], line: string) => {
    setError(null);
    setNote(null);
    try {
      const saved = org
        ? await api.saveCatalogSources(token, items)
        : await api.savePlatformSources(token, items, cratesIo);
      setCatalogue(saved.items);
      setNote(`${line} The catalogue picks it up at its next sync.`);
    } catch (e) {
      setError(errText(e));
    }
  };
  const listIt = (r: RepositoryRoles) =>
    void saveCatalogue(
      [
        ...(catalogue ?? []),
        { tenant: tenantId, connection_id: null, repo: r.repo, git_ref: r.engine?.ref || null, mode: "gears" },
      ],
      `${r.repo} is listed in the catalogue.`,
    );
  const unlist = (c: CatalogRepoSource) => {
    void saveCatalogue(
      (catalogue ?? []).filter((x) => x !== c),
      `${c.repo} (${c.mode || "gears"}) is no longer listed.`,
    );
  };
  const buildFrom = (r: RepositoryRoles) => {
    const gears = r.catalogue.find((c) => (c.mode || "gears") === "gears") ?? r.catalogue[0];
    const ref = gears?.git_ref && gears.git_ref !== "HEAD" ? gears.git_ref : "";
    setPrefill({ url: `https://github.com/${r.repo}`, ref, at: Date.now() });
    addRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const intro = org
    ? "Where this organization's components come from. A repository can be in the catalogue (synced into the Components list) and built from (the Gearbox engine reads it, after the platform's, when it composes a product); one of those is where Create a gear writes."
    : "Where the platform's components come from. A repository can be in the catalogue (synced into the Components list every organization sees) and built from (the Gearbox engine reads it when it composes a product; where two declare the same gear, the first wins).";
  const manager = org
    ? "An organization administrator adds and removes the organization's gear repositories."
    : "A platform administrator adds and removes the platform's gear repositories.";

  return (
    <div className="gear-sources" data-platform-sources={org ? undefined : ""} data-org-sources={org ? "" : undefined}>
      <style>{SOURCES_CSS}</style>
      {embedded ? (
        <p className="hint">
          Where this organization&apos;s components come from <InfoPopover label="About repositories">{intro}</InfoPopover>
        </p>
      ) : (
        <PageHeader
          title="Repositories"
          info={
            <>
              <p>{intro}</p>
              <p>{manager}</p>
            </>
          }
          status={
            !loading && (
              <>
                <StatusChip tone={roles.length > 0 ? "neutral" : "warn"}>
                  {roles.length} {roles.length === 1 ? "repository" : "repositories"}
                </StatusChip>
                {status?.problem && <StatusChip tone="danger">engine cannot read</StatusChip>}
                {!mayManage && <StatusChip tone="info">read-only</StatusChip>}
              </>
            )
          }
        />
      )}
      {error && <div className="error">{error}</div>}
      {note && (
        <div className="hint" data-gear-source-note>
          {note}
        </div>
      )}
      {status?.problem && (
        <div className="error" data-gear-source-problem>
          The engine could not read the corpus: {status.problem}
        </div>
      )}
      {org && (status?.shadowed ?? []).length > 0 && (
        <div className="error" data-gear-source-shadowed>
          Not read: {(status?.shadowed ?? []).join(", ")}. A platform repository has the same source id; give this
          organization&apos;s repository another.
        </div>
      )}
      {loading ? (
        <p className="hint">{readsConnections ? "Loading…" : "Asking the engine what it reads…"}</p>
      ) : (
        <div className="card">
          <RolesTable
            list={org ? "org-repositories" : "platform-repositories"}
            title={org ? "This organization's" : "Repositories"}
            rows={roles}
            empty={{
              title: org ? "No repository of its own yet." : "No repository yet.",
              body: org
                ? "Products here read the platform's gears; a repository added below adds this organization's own."
                : "No gear repository is connected and the deployment names no corpus: the engine has nothing to read.",
            }}
            statusRead={statusRead}
            busy={busy}
            mayManage={mayManage}
            catalogueRead={catalogue !== null}
            onTest={test}
            onRemove={mayManage ? remove : undefined}
            onList={listIt}
            onUnlist={unlist}
            onBuild={buildFrom}
            writesHere={org ? writesHere : undefined}
            onWriteHere={org && mayManage ? writeTo : undefined}
            onStopWriting={org && mayManage && targetRepo && !writeTarget?.gear_repository?.from_sources ? stopWriting : undefined}
            onNewGear={org && mayManage ? () => setNewGear(true) : undefined}
            primary={
              org && mayManage && !creating ? (
                <button type="button" onClick={() => setCreating(true)} data-create-repository>
                  Create a repository…
                </button>
              ) : undefined
            }
          />
        </div>
      )}
      {creating && (
        <CreateGearRepository
          token={token}
          tenantId={tenantId}
          connections={connections ?? []}
          onCancel={() => setCreating(false)}
          onCreated={(st) => {
            setCreating(false);
            setWriteTarget(st);
            setNote(`Created ${st.gear_repository?.repo ?? "the repository"}; new gears go there.`);
          }}
        />
      )}
      {newGear && targetRepo && (
        <ScaffoldModal
          capability="new-gear"
          token={token}
          editable
          lead={`A new gear in ${targetRepo}, with a pull request.`}
          send={(body) => api.scaffoldOrgGear(token, body)}
          onClose={() => setNewGear(false)}
        />
      )}
      {org && (
        <div className="card" data-platform-rows>
          <RolesTable
            list="org-platform-repositories"
            title="The platform's — read first"
            rows={statusRead ? platformRoles : null}
            empty={{ title: "The platform has no gear repository." }}
            statusRead={statusRead}
            busy={null}
            mayManage={false}
            catalogueRead={false}
          />
        </div>
      )}
      {catalogueSettings && (
        <details className="gear-source-catalogue" data-catalogue-settings>
          <summary>Catalogue settings and sync — modes, refs, connections{org ? "" : ", crates.io"}</summary>
          {catalogueSettings}
        </details>
      )}
      {mayManage ? (
        <div ref={addRef}>
          <AddGearRepository
            key={prefill?.at ?? 0}
            token={token}
            ownerTenant={tenantId}
            taken={own.map((r) => r.sourceId)}
            platformIds={platformRows.map((r) => r.sourceId)}
            initialUrl={prefill?.url}
            initialRef={prefill?.ref}
            onAdded={(line) => {
              setNote(line);
              setPrefill(null);
              load(true);
            }}
          />
        </div>
      ) : (
        embedded && <p className="hint">{manager}</p>
      )}
    </div>
  );
}

/** One row per repository, with its two roles side by side, on the shared
 *  list: search, a role filter, Test beside the row, the rest in its menu. */
function RolesTable({
  list,
  title,
  rows,
  empty,
  statusRead,
  busy,
  mayManage,
  catalogueRead,
  onTest,
  onRemove,
  onList,
  onUnlist,
  onBuild,
  writesHere,
  onWriteHere,
  onStopWriting,
  onNewGear,
  primary,
}: {
  list: string;
  title: string;
  rows: RepositoryRoles[] | null;
  empty: EmptySpec;
  statusRead: boolean;
  busy: string | null;
  mayManage: boolean;
  /** Whether the catalogue's list could be read: a member who may not read
   *  the platform's sees only what the engine reads. */
  catalogueRead: boolean;
  onTest?: (c: Connection) => void;
  onRemove?: (c: Connection) => void;
  onList?: (r: RepositoryRoles) => void;
  onUnlist?: (c: CatalogRepoSource) => void;
  onBuild?: (r: RepositoryRoles) => void;
  /** Whether Create a gear writes into a row, on an organization's own list. */
  writesHere?: (r: RepositoryRoles) => boolean;
  onWriteHere?: (r: RepositoryRoles) => void;
  onStopWriting?: () => void;
  onNewGear?: () => void;
  primary?: ReactNode;
}) {
  const own = writesHere !== undefined;
  const note = (r: RepositoryRoles) => (catalogueRead ? rolesNote(r) : null);
  const columns: Column<RepositoryRoles>[] = [
    {
      id: "repo",
      header: "Repository",
      className: "acell-lead",
      compare: (a, b) => a.repo.localeCompare(b.repo),
      cell: (r) => (
        <div>
          <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer">
            {r.repo}
          </a>
          {note(r) && (
            <div className="gear-source-warn" data-roles-note>
              {note(r)}
            </div>
          )}
        </div>
      ),
    },
  ];
  if (catalogueRead)
    columns.push({
      id: "catalogue",
      header: <span title="Synced into the Components list: descriptions, versions, activity">In the catalogue</span>,
      cell: (r) =>
        r.catalogue.length === 0 ? (
          <span className="ing-dash">—</span>
        ) : (
          <span data-role-catalogue>
            {r.catalogue.map((s, i) => (
              <StatusChip key={i} tone={s.shadowed_by_platform ? "warn" : "neutral"} className="gear-role-chip">
                {s.mode || "gears"} · {refLabel(s.git_ref)}
                {s.shadowed_by_platform ? " · the platform lists it too" : ""}
              </StatusChip>
            ))}
          </span>
        ),
    });
  columns.push({
    id: "engine",
    header: <span title="Read by the Gearbox engine when it composes a product">Built from</span>,
    cell: (r) =>
      r.engine ? (
        <div data-role-engine>
          <code>{r.engine.sourceId}</code> <span className="sub">· {refLabel(r.engine.ref)}</span>
          <div className="sub">
            {statusRead ? readLine(r.engine.read) : "reading…"}
            {r.fallback && " · the deployment's corpus, until a repository is added"}
            {r.engine.connection && (r.engine.connection.secret_ref ? " · with a token" : " · public")}
          </div>
        </div>
      ) : (
        <span className="ing-dash">—</span>
      ),
  });
  if (own)
    columns.push({
      id: "target",
      header: "New gears",
      cell: (r) =>
        writesHere?.(r) ? (
          <StatusChip tone="info">Create a gear writes here</StatusChip>
        ) : (
          <span className="ing-dash">—</span>
        ),
    });

  return (
    <DataTable<RepositoryRoles>
      list={list}
      urlPrefix={`${list}.`}
      title={title}
      rows={rows}
      rowKey={(r) => r.repo}
      rowLabel={(r) => r.repo}
      primary={primary}
      search={{ placeholder: "Search repositories" }}
      searchText={(r) => [r.repo, r.engine?.sourceId, ...r.catalogue.map((c) => c.mode)]}
      filters={
        catalogueRead
          ? [
              {
                id: "role",
                allLabel: "Every repository",
                kind: "chips",
                options: [
                  { value: "catalogue", label: "In the catalogue" },
                  { value: "engine", label: "Built from" },
                  { value: "attention", label: "Needs a look" },
                ],
                match: (r, v) =>
                  v === "catalogue" ? r.catalogue.length > 0 : v === "engine" ? r.engine !== null : note(r) !== null,
              },
            ]
          : undefined
      }
      empty={empty}
      columns={columns}
      inline={(r) => {
        const c = r.engine?.connection;
        if (c && onTest)
          return (
            <button type="button" className="ghost" disabled={busy === c.id} onClick={() => onTest(c)}>
              Test
            </button>
          );
        if (!r.engine && mayManage && onBuild)
          return (
            <button type="button" className="ghost" onClick={() => onBuild(r)}>
              Build from it…
            </button>
          );
        return null;
      }}
      actions={(r) => {
        if (!mayManage) return [];
        const c = r.engine?.connection ?? null;
        const out: RowAction[] = [];
        if (!r.engine && onBuild) out.push({ label: "Build from it…", onSelect: () => onBuild(r) });
        // The deployment's corpus is a stopgap nobody chose: the way out is
        // building from a listed repository, not listing the stopgap.
        if (catalogueRead && r.catalogue.length === 0 && !r.fallback && onList)
          out.push({ label: "List it in the catalogue", onSelect: () => onList(r) });
        if (own && writesHere?.(r) && onNewGear) out.push({ label: "New gear…", onSelect: onNewGear });
        if (own && !writesHere?.(r) && !r.fallback && onWriteHere) out.push({ label: "Write new gears here", onSelect: () => onWriteHere(r) });
        if (own && writesHere?.(r) && !r.engine?.connection && onStopWriting)
          out.push({
            label: "Stop writing new gears here",
            onSelect: onStopWriting,
            danger: {
              title: `Stop writing new gears into ${r.repo}?`,
              body: "Create a gear writes into each project's own repository again. The repository itself is not touched.",
              confirmLabel: "Stop writing here",
            },
          });
        for (const s of r.catalogue)
          if (onUnlist)
            out.push({
              label: `Stop listing it (${s.mode || "gears"})`,
              onSelect: () => onUnlist(s),
              danger: {
                title: `Stop listing ${s.repo} (${s.mode || "gears"})?`,
                body: "Its components leave the Components list at the next sync. Products built from it are not affected.",
                confirmLabel: "Stop listing",
              },
            });
        if (c && onRemove)
          out.push({
            label: "Stop building from it",
            onSelect: () => onRemove(c),
            danger: {
              title: `Stop building from ${r.repo}?`,
              body: "Its gears leave the corpus the engine composes products from. The catalogue keeps listing it.",
              confirmLabel: "Stop building",
            },
          });
        return out;
      }}
    />
  );
}

function AddGearRepository({
  token,
  ownerTenant,
  taken,
  platformIds,
  initialUrl,
  initialRef,
  onAdded,
}: {
  token: string;
  ownerTenant: string;
  taken: string[];
  /** On an organization's page: the platform's source ids, which its own
   *  repositories cannot share (the engine names a root by it). */
  platformIds: string[];
  /** Filled in from a catalogue row's "Build from it". */
  initialUrl?: string;
  initialRef?: string;
  onAdded: (line: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [ref, setRef] = useState(initialRef ?? "");
  const [sourceId, setSourceId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repositoryOf(url);
  const id = sourceId.trim() || defaultSourceId(url);
  const problem = !url.trim()
    ? null
    : !repo
      ? "Give the repository as https://github.com/<owner>/<repo>."
      : !isSourceId(id)
        ? `"${id}" is not a source id: lowercase letters, digits and single hyphens, starting with a letter.`
        : taken.includes(id)
          ? `The source id "${id}" is taken; give this repository another.`
          : platformIds.includes(id)
            ? `The platform has a repository with the source id "${id}"; give this one another.`
            : null;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createConnection(token, {
        provider: GEAR_REPOSITORY,
        label: id,
        base_url: url.trim(),
        token: secret.trim(),
        scope: "organization",
        owner_tenant_id: ownerTenant,
        options: { source_id: id, ...(ref.trim() ? { ref: ref.trim() } : {}) },
      });
      setUrl("");
      setRef("");
      setSourceId("");
      setSecret("");
      onAdded(`Added ${r.account}: ${r.display_name ?? "reachable"}.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card gear-source-add" data-gear-source-add>
      <h3>
        Add a gear repository{" "}
        <InfoPopover label="About adding a gear repository">
          Studio checks that the repository is there at that ref, and counts its <code>gear.gdl</code> files, before it
          adds it. Create a gear and Publish need a token that may write.
        </InfoPopover>
      </h3>
      <div className="gear-source-form">
        <label>
          Repository
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/constructorfabric/gears-rust"
          />
        </label>
        <label>
          Branch or tag
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="default branch" />
        </label>
        <label>
          Source id
          <input
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            placeholder={defaultSourceId(url) || "gears-rust"}
          />
        </label>
        <label>
          Read token
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="blank for a public repository"
          />
        </label>
      </div>
      {(problem || error) && <div className="error">{problem ?? error}</div>}
      <button type="button" className="primary" disabled={busy || !repo || !!problem} onClick={() => void add()}>
        {busy ? "Testing…" : "Test & add"}
      </button>
    </section>
  );
}

const SOURCES_CSS = `
.gear-sources .sub { color:var(--muted-foreground); font-size:12px; }
.gear-sources .gear-source-actions { display:flex; gap:6px; justify-content:flex-end; }
.gear-sources .gear-source-add { margin-top:16px; display:grid; gap:10px; }
.gear-sources .gear-source-form { display:grid; gap:10px; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); }
.gear-sources .gear-source-form label { display:grid; gap:4px; font-size:13px; }
.gear-sources h3 { margin:16px 0 8px; }
.gear-sources .gear-role-chip { margin:0 6px 4px 0; }
.gear-sources .gear-source-warn { margin-top:4px; font-size:12px; color:#b45309; white-space:normal; overflow-wrap:anywhere; max-width:48ch; }
.gear-sources .gear-source-catalogue { margin-top:16px; }
.gear-sources .gear-source-catalogue summary { cursor:pointer; font-weight:600; margin-bottom:8px; }
`;
