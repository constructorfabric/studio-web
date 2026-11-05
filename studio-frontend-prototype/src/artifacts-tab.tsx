// A project's Artifacts tab: what the project produced and what it holds.
// Outputs -- the files its CI builds kept, by the version built (passed builds
// only unless all are asked for; the runs are Tests' and Releases'), and its
// releases -- and Documents &
// files -- the repository files Studio knows the type of, and the files
// people added or Studio generated. The model is outputs.ts.
//
// A download is asked for when it is clicked: the server hands back a link
// the provider signs for about a minute, and the browser goes there. Nothing
// is downloaded through Studio, and no link is kept in the page.

import { useEffect, useMemo, useState } from "react";

import { api, type BuildOutput, type OutputAsset } from "./api";
import { buildsOf, type BuildRun } from "./builds";
import { DataTable, When } from "./data-table";
import { errText } from "./format";
import { documentRows, expiryText, formatBytes, groupOutputs, outputVersions, type DocumentRow, type OutputVersion } from "./outputs";
import { EmptyState, StatusChip } from "./ui-standard";
import { useStudioBridge, type StudioTarget } from "./studio-bridge";

/** The sync keeps the newest few hundred runs per repository. */
const RUN_LIMIT = 200;

/** Asks for the signed link and goes there; the error, if any, stays on the
 *  row that asked. */
function useDownload(token: string, projectId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const download = async (output: BuildOutput, asset?: OutputAsset) => {
    const key = asset ? `${output.id}:${asset.id}` : output.id;
    setBusy(key);
    setError(null);
    try {
      const { url } = await api.outputDownload(token, projectId, output.id, asset?.id);
      window.location.assign(url);
    } catch (e) {
      setError({ key, text: errText(e) });
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, download };
}

export function ProjectOutputs({
  token,
  projectId,
  onOpenTab,
  onCounts,
}: {
  token: string;
  projectId: string;
  onOpenTab?: (tab: "releases" | "sources") => void;
  /** What there is, for the page's header line. */
  onCounts?: (c: { versions: number; releases: number }) => void;
}) {
  const [outputs, setOutputs] = useState<BuildOutput[] | null>(null);
  const [runs, setRuns] = useState<BuildRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { busy, error: downloadError, download } = useDownload(token, projectId);

  useEffect(() => {
    let live = true;
    setOutputs(null);
    setError(null);
    api
      .listOutputs(token, projectId)
      .then((page) => live && setOutputs(page.items))
      .catch((e: unknown) => live && setError(errText(e)));
    api
      .listArtifactNodes(token, "workflow_run", projectId, undefined, RUN_LIMIT, { sort: "updated" })
      .then((page) => live && setRuns(buildsOf(page.nodes ?? [])))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [token, projectId, tick]);

  const { builds, releases } = useMemo(() => groupOutputs(outputs ?? [], runs), [outputs, runs]);
  /** Passed builds' files only, unless all are asked for. */
  const [passedOnly, setPassedOnly] = useState(true);
  const passed = useMemo(() => outputVersions(builds, true), [builds]);
  const all = useMemo(() => outputVersions(builds, false), [builds]);
  const versions = passedOnly ? passed : all;
  useEffect(() => {
    if (outputs) onCounts?.({ versions: passed.length, releases: releases.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputs, passed.length, releases.length]);
  const now = new Date();

  const rowError = (key: string) =>
    downloadError?.key === key ? <span className="error"> {downloadError.text}</span> : null;

  const fileButton = (output: BuildOutput, asset?: OutputAsset) => {
    const key = asset ? `${output.id}:${asset.id}` : output.id;
    const gone = !asset && expiryText(output, now) === "expired";
    return (
      <>
        <button
          className="ghost"
          disabled={gone || busy === key}
          title={gone ? "The provider no longer keeps this file" : "Download from the provider"}
          onClick={() => void download(output, asset)}
        >
          {busy === key ? "Preparing…" : "Download"}
        </button>
        {rowError(key)}
      </>
    );
  };

  return (
    <>
      <section className="card" data-outputs-builds>
        <DataTable<OutputVersion>
          list="outputs-builds"
          urlPrefix="builds."
          title="Files by version"
          rows={outputs === null && !error ? null : versions}
          error={error}
          onRetry={() => setTick((t) => t + 1)}
          rowKey={(v) => v.version}
          rowLabel={(v) => v.version}
          search={{ placeholder: "Search versions and files…" }}
          searchText={(v) => [v.version, v.branch, ...v.files.map((a) => a.title)]}
          primary={
            <div className="doc-views" role="tablist" aria-label="Which builds" style={{ marginBottom: 0 }} data-outputs-filter>
              <button role="tab" aria-selected={passedOnly} className={passedOnly ? "doc-view on" : "doc-view"} onClick={() => setPassedOnly(true)}>
                Passed · {passed.length}
              </button>
              <button role="tab" aria-selected={!passedOnly} className={!passedOnly ? "doc-view on" : "doc-view"} onClick={() => setPassedOnly(false)}>
                All · {all.length}
              </button>
            </div>
          }
          empty={{
            title: passedOnly && all.length > 0 ? "No passed build kept a file." : "No build has kept a file yet.",
            body:
              passedOnly && all.length > 0 ? (
                <button className="linklike" onClick={() => setPassedOnly(false)}>
                  Show all {all.length}
                </button>
              ) : onOpenTab ? (
                <button className="linklike" onClick={() => onOpenTab("releases")}>
                  Open Releases
                </button>
              ) : undefined,
          }}
          columns={[
            {
              id: "version",
              header: "Version",
              className: "acell-lead",
              cell: (v) => (
                <>
                  <code>{v.version}</code>{" "}
                  {v.branch && (
                    <StatusChip tone="neutral" className="chip-trunc" title={v.branch}>
                      {v.branch}
                    </StatusChip>
                  )}{" "}
                  {v.passed === false && <StatusChip tone="warn">no passed build</StatusChip>}
                </>
              ),
            },
            { id: "files", header: "Files", num: true, cell: (v) => String(v.files.length) },
            {
              id: "size",
              header: "Size",
              num: true,
              cell: (v) => formatBytes(v.files.reduce((n, a) => n + (a.size_in_bytes ?? 0), 0)),
            },
            { id: "when", header: "Built", cell: (v) => <When iso={v.at || null} /> },
          ]}
          expand={(v) => (
            <ul className="output-files" data-build-files>
              {v.files.map((a) => (
                <li key={a.id}>
                  <b>{a.title}</b> <span className="sub">{formatBytes(a.size_in_bytes)}</span>{" "}
                  <span className="sub">{expiryText(a, now) ?? ""}</span> {fileButton(a)}
                </li>
              ))}
            </ul>
          )}
        />
      </section>

      <section className="card" data-outputs-releases>
        <DataTable<BuildOutput>
          list="outputs-releases"
          urlPrefix="releases."
          title="Releases"
          rows={outputs === null && !error ? null : releases}
          error={error}
          onRetry={() => setTick((t) => t + 1)}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.title}
          search={{ placeholder: "Search releases…" }}
          searchText={(r) => [r.title, r.tag, r.repo_full_path, ...r.assets.map((a) => a.name)]}
          empty={{ title: "No releases.", body: "A tag released in a project repository shows here after the next sync." }}
          columns={[
            {
              id: "release",
              header: "Release",
              className: "acell-lead",
              cell: (r) => (
                <>
                  {r.title}
                  {r.tag && r.tag !== r.title ? <span className="sub"> · {r.tag}</span> : null}{" "}
                  {r.prerelease ? <StatusChip tone="info">pre-release</StatusChip> : null}{" "}
                  {r.draft ? <StatusChip tone="neutral">draft</StatusChip> : null}
                </>
              ),
            },
            { id: "repo", header: "Repository", cell: (r) => r.repo_full_path ?? "—" },
            { id: "files", header: "Files", num: true, cell: (r) => String(r.assets.length) },
            { id: "when", header: "Published", cell: (r) => <When iso={r.published_at ?? r.created_at ?? null} /> },
          ]}
          inline={(r) =>
            r.url ? (
              <a className="ghost" href={r.url} target="_blank" rel="noreferrer">
                Open ↗
              </a>
            ) : null
          }
          expand={(r) =>
            r.assets.length === 0 ? (
              <EmptyState title="No files attached." body="The release is its tag and notes." />
            ) : (
              <ul className="output-files" data-release-files>
                {r.assets.map((a) => (
                  <li key={a.id}>
                    <b>{a.name}</b> <span className="sub">{formatBytes(a.size)}</span>
                    {a.download_count ? <span className="sub"> · {a.download_count} downloads</span> : null}{" "}
                    {fileButton(r, a)}
                  </li>
                ))}
              </ul>
            )
          }
        />
      </section>

    </>
  );
}

/** The repository files Studio knows the type of: the project's documents. */
export function ProjectDocuments({
  token,
  workspaceId,
  projectId,
  target,
  onOpenTab,
}: {
  token: string;
  /** The parent workspace: document bindings are addressed under it. */
  workspaceId: string;
  projectId: string;
  /** What the IDE opens when a document is opened in it. */
  target: StudioTarget;
  onOpenTab?: (tab: "specs") => void;
}) {
  const studio = useStudioBridge();
  const [rows, setRows] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    api
      .allDocBindings(token, workspaceId, projectId)
      .then((page) => live && setRows(documentRows(page.items)))
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, workspaceId, projectId, tick]);

  const types = useMemo(() => [...new Set((rows ?? []).map((r) => r.type))].sort(), [rows]);

  return (
    <section className="card" data-project-documents>
      <DataTable<DocumentRow>
        list="project-documents"
        urlPrefix="docs."
        title="Documents in the repositories"
        rows={rows === null && !error ? null : (rows ?? [])}
        error={error}
        onRetry={() => setTick((t) => t + 1)}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.path}
        onOpen={(r) => void studio?.openFile(target, r.path)}
        canOpen={() => !!studio}
        search={{ placeholder: "Search documents…" }}
        searchText={(r) => [r.path, r.type]}
        filters={[
          {
            id: "type",
            allLabel: "All types",
            kind: types.length > 6 ? "select" : "chips",
            options: types.map((t) => ({ value: t, label: t })),
            match: (r, v) => r.type === v,
          },
        ]}
        empty={{
          title: "No typed documents yet.",
          body: onOpenTab ? (
            <>
              Studio types a repository&apos;s documents after a sync; confirm or set the types on{" "}
              <button className="linklike" onClick={() => onOpenTab("specs")}>
                Specs
              </button>
              .
            </>
          ) : (
            "Studio types a repository's documents after a sync."
          ),
        }}
        columns={[
          { id: "path", header: "Document", className: "acell-lead", compare: (a, b) => a.path.localeCompare(b.path), cell: (r) => <code>{r.path}</code> },
          { id: "type", header: "Type", compare: (a, b) => a.type.localeCompare(b.type), cell: (r) => r.type },
          {
            id: "typed",
            header: "Typed by",
            cell: (r) => (r.confirmed ? "a person" : <StatusChip tone="neutral">detected</StatusChip>),
          },
          {
            id: "conforms",
            header: "Follows its template",
            cell: (r) =>
              r.conforms === null ? (
                "—"
              ) : r.conforms ? (
                <StatusChip tone="ok">yes</StatusChip>
              ) : (
                <StatusChip tone="warn">gaps</StatusChip>
              ),
          },
        ]}
        inline={(r) => (
          <button
            className="ghost"
            onClick={() => void studio?.openFile(target, r.path)}
            disabled={!studio || studio.opening === target.id}
            title="Open this document in the Studio editor"
          >
            Open in editor
          </button>
        )}
      />
    </section>
  );
}
