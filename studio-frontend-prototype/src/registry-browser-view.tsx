/* A registry of the organization, opened from its place under Organization ›
 * Infrastructure: what its environments do with it, its repositories -- each
 * opened to its versions, read only when it is opened, as a registry may hold
 * thousands -- and, on a tab beside them, the orphans: what is in it that no
 * project or record of Studio accounts for, and what Studio recorded that it
 * no longer has. A version that runs somewhere is not deleted. The words are
 * in registry-browser.ts. */

import { useEffect, useState } from "react";

import { api, type OrgRegistry, type RegistryOrphan, type RegistryRepository, type RegistryTag } from "./api";
import { ConfirmDialog, When } from "./data-table";
import { errText } from "./format";
import { imageRefusalText, shortDigest, sizeText, whereItRuns } from "./images";
import {
  ORPHAN_REASON,
  REGISTRY_KIND,
  orphanGroups,
  orphanSummary,
  repositoryRows,
  roleWords,
  sortTags,
  versionDeletion,
} from "./registry-browser";
import { EmptyState, StatusChip } from "./ui-standard";

export function RegistryBrowser({ token, org, connectionId }: { token: string; org: string; connectionId: string }) {
  const [tab, setTab] = useState<"repositories" | "orphans">("repositories");
  const [registry, setRegistry] = useState<OrgRegistry | null>(null);
  const [repos, setRepos] = useState<RegistryRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<RegistryOrphan[] | null>(null);
  const [orphansError, setOrphansError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .orgRegistries(token, org)
      .then((r) => live && setRegistry(r.items.find((x) => x.connection_id === connectionId) ?? null))
      .catch(() => live && setRegistry(null));
    api
      .registryRepositories(token, org, connectionId)
      .then((r) => {
        if (!live) return;
        setRepos(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setRepos([]);
        setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org, connectionId, round]);

  // The orphans are a walk of the whole registry: asked for only once the
  // tab is opened.
  useEffect(() => {
    if (tab !== "orphans" || orphans !== null) return;
    let live = true;
    api
      .registryOrphans(token, org, connectionId)
      .then((r) => live && setOrphans(r.items))
      .catch((e: unknown) => {
        if (!live) return;
        setOrphans([]);
        setOrphansError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [tab, orphans, token, org, connectionId]);

  return (
    <div data-registry-browser={connectionId}>
      {registry && (
        <p className="sub" data-registry-role>
          {REGISTRY_KIND[registry.kind]} · {roleWords(registry.role)}
          {registry.prefixes.length > 0 && (
            <>
              {" "}
              · under {registry.prefixes.map((p) => <code key={p}>{p} </code>)}
            </>
          )}
        </p>
      )}
      <div className="infra-tabs" role="tablist" aria-label="The registry">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "repositories"}
          className={tab === "repositories" ? "on" : ""}
          onClick={() => setTab("repositories")}
          data-registry-tab="repositories"
        >
          Repositories
          {repos && repos.length > 0 && <span className="badge">{repos.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "orphans"}
          className={tab === "orphans" ? "on" : ""}
          onClick={() => setTab("orphans")}
          data-registry-tab="orphans"
        >
          Orphans
          {orphans && orphans.length > 0 && <span className="badge warn">{orphans.length}</span>}
        </button>
      </div>
      {tab === "repositories" ? (
        <>
          {error && <div className="error">{error}</div>}
          {repos === null ? (
            <p className="hint">Reading the registry…</p>
          ) : repos.length === 0 && !error ? (
            <EmptyState title="Nothing in it yet." body="A build in Studio pushes the product's images and chart here." />
          ) : (
            <ul className="env-list" data-registry-repositories>
              {repositoryRows(repos).map((r) => (
                <li key={r.name} data-registry-repository={r.name}>
                  <button
                    type="button"
                    className="linklike"
                    aria-expanded={open === r.name}
                    onClick={() => setOpen(open === r.name ? null : r.name)}
                  >
                    {open === r.name ? "▾" : "▸"} <code>{r.name}</code>
                  </button>{" "}
                  <span className="sub">
                    {r.owner} · {r.recorded} recorded
                  </span>
                  {open === r.name && (
                    <RepositoryTags
                      token={token}
                      org={org}
                      connectionId={connectionId}
                      repository={r.name}
                      onDeleted={() => setRound((n) => n + 1)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div data-registry-orphans>
          {orphansError && <div className="error">{orphansError}</div>}
          {orphans === null ? (
            <p className="hint">Walking the registry…</p>
          ) : (
            <>
              <p className="sub" data-registry-orphans-summary>
                {orphanSummary(orphans)}
              </p>
              {orphanGroups(orphans).map((g) => (
                <div key={g.reason} data-orphan-reason={g.reason}>
                  <h4 className="env-sub">
                    {ORPHAN_REASON[g.reason].title} · {g.items.length}
                  </h4>
                  <p className="sub">{ORPHAN_REASON[g.reason].next}</p>
                  <ul className="env-list">
                    {g.items.map((o) => (
                      <li key={`${o.repository}@${o.digest ?? o.tags.join(",")}`}>
                        <code>{o.repository}</code>
                        {o.tags.length > 0 && <span className="sub"> · {o.tags.join(", ")}</span>}
                        {o.digest && <span className="sub"> · {shortDigest(o.digest)}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One repository's versions, read when it is opened, newest first. */
function RepositoryTags({
  token,
  org,
  connectionId,
  repository,
  onDeleted,
}: {
  token: string;
  org: string;
  connectionId: string;
  repository: string;
  onDeleted: () => void;
}) {
  const [tags, setTags] = useState<RegistryTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RegistryTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .registryTags(token, org, connectionId, repository)
      .then((r) => live && setTags(sortTags(r.items)))
      .catch((e: unknown) => {
        if (!live) return;
        setTags([]);
        setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org, connectionId, repository, round]);

  return (
    <div style={{ margin: "6px 0 0 18px" }} data-registry-tags={repository}>
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}
      {tags === null ? (
        <p className="hint">Reading its versions…</p>
      ) : tags.length === 0 && !error ? (
        <p className="sub">No version.</p>
      ) : (
        <ul className="env-list">
          {tags.map((t) => {
            const deletion = versionDeletion(t);
            return (
              <li key={t.digest ?? t.tags.join(",")} data-registry-version={t.digest ?? undefined}>
                <div className="env-head">
                  {t.tags.length > 0 ? t.tags.map((x) => <code key={x}>{x}</code>) : <span className="sub">no tag</span>}
                  <span className="sub">
                    {t.digest ? <code>{shortDigest(t.digest)}</code> : "no digest"}
                    {t.size_bytes != null ? ` · ${sizeText(t.size_bytes)}` : ""}
                    {t.pushed_at ? (
                      <>
                        {" "}
                        · <When iso={t.pushed_at} />
                      </>
                    ) : null}
                  </span>
                  {t.image_id ? (
                    <StatusChip tone="ok" title="Studio recorded it">
                      recorded
                    </StatusChip>
                  ) : (
                    <StatusChip tone="neutral" title="No record of Studio names it">
                      not recorded
                    </StatusChip>
                  )}
                  <span className="grow" />
                  <button
                    type="button"
                    className="danger"
                    disabled={!deletion.allowed}
                    title={deletion.reason ?? "Delete this version from the registry"}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(t);
                    }}
                    data-registry-version-delete
                  >
                    Delete
                  </button>
                </div>
                {t.running_in.length > 0 && <div className="sub">{whereItRuns(t.running_in)}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          spec={{
            title: `Delete ${deleting.tags[0] ?? (deleting.digest ? shortDigest(deleting.digest) : "this version")} of ${repository}?`,
            body: "It is deleted from the registry, every tag of it with it. A deploy that names it cannot pull it again.",
            confirmLabel: "Delete",
          }}
          busy={busy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setBusy(true);
            setDeleteError(null);
            try {
              if (!deleting.digest) throw new Error("The registry's listing gives no digest for it.");
              await api.deleteRegistryVersion(token, org, connectionId, repository, deleting.digest);
              setDeleting(null);
              setNotice("Deleting it from the registry.");
              setRound((n) => n + 1);
              onDeleted();
            } catch (e) {
              setDeleteError(imageRefusalText(e) ?? errText(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}
