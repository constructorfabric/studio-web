// A project's Artifacts tab: what the project produced and what it holds.
// Outputs -- the files its CI builds kept and its releases -- and Documents &
// files -- the repository files Studio knows the type of, and the files
// people added or Studio generated. The model is outputs.ts.
//
// A download is asked for when it is clicked: the server hands back a link
// the provider signs for about a minute, and the browser goes there. Nothing
// is downloaded through Studio, and no link is kept in the page.

import { useEffect, useMemo, useState } from "react";

import { api, type BuildOutput, type OutputAsset } from "./api";
import { buildsOf, statusTone, type BuildRun } from "./builds";
import { DataTable, When } from "./data-table";
import { errText } from "./format";
import { documentRows, expiryText, formatBytes, groupOutputs, type DocumentRow, type OutputBuild } from "./outputs";
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
}: {
  token: string;
  projectId: string;
  onOpenTab?: (tab: "releases" | "sources") => void;
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

  const buildTitle = (b: OutputBuild) =>
    b.run ? (
      <>
        <code>{b.run.shortSha}</code>{" "}
        {b.run.url ? (
          <a href={b.run.url} target="_blank" rel="noreferrer">
            {b.run.workflow}
            {b.run.number != null ? ` #${b.run.number}` : ""}
          </a>
        ) : (
          b.run.workflow
        )}
      </>
    ) : (
      <span className="sub">a run the sync no longer keeps</span>
    );

  return (
    <>
      <section className="card" data-outputs-builds>
        <DataTable<OutputBuild>
          list="outputs-builds"
          urlPrefix="builds."
          title="From CI builds"
          rows={outputs === null && !error ? null : builds}
          error={error}
          onRetry={() => setTick((t) => t + 1)}
          rowKey={(b) => b.runId}
          rowLabel={(b) => b.run?.workflow ?? b.artifacts[0]?.title ?? b.runId}
          search={{ placeholder: "Search builds and files…" }}
          searchText={(b) => [b.run?.workflow, b.run?.branch, b.run?.sha, ...b.artifacts.map((a) => a.title)]}
          primary={
            <button className="ghost" onClick={() => setTick((t) => t + 1)}>
              Refresh
            </button>
          }
          empty={{
            title: "No build has kept a file yet.",
            body: (
              <>
                A CI run that uploads an artifact shows it here after the next sync. The runs themselves are on{" "}
                {onOpenTab ? (
                  <button className="linklike" onClick={() => onOpenTab("releases")}>
                    Releases
                  </button>
                ) : (
                  "Releases"
                )}
                .
              </>
            ),
          }}
          columns={[
            { id: "build", header: "Build", className: "acell-lead", cell: buildTitle },
            {
              id: "result",
              header: "Result",
              cell: (b) =>
                b.run ? <span className={`badge ${statusTone(b.run.status)}`}>{b.run.status}</span> : "—",
            },
            { id: "branch", header: "Branch", cell: (b) => b.run?.branch ?? b.artifacts[0]?.branch ?? "—" },
            {
              id: "files",
              header: "Files",
              num: true,
              cell: (b) => String(b.artifacts.length),
            },
            {
              id: "size",
              header: "Size",
              num: true,
              cell: (b) => formatBytes(b.artifacts.reduce((n, a) => n + (a.size_in_bytes ?? 0), 0)),
            },
            {
              id: "when",
              header: "When",
              cell: (b) => <When iso={b.run?.createdAt ?? b.artifacts[0]?.created_at ?? null} />,
            },
          ]}
          expand={(b) => (
            <ul className="output-files" data-build-files>
              {b.artifacts.map((a) => (
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
                  {r.tag && r.tag !== r.title ? <span className="sub"> · {r.tag}</span> : null}
                  {r.prerelease ? <span className="badge neutral">pre-release</span> : null}
                  {r.draft ? <span className="badge neutral">draft</span> : null}
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
              <p className="sub">No files attached: the release is its tag and notes.</p>
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

      {onOpenTab && (
        <p className="hint" data-outputs-images>
          Container images the builds published are deployed from{" "}
          <button className="linklike" onClick={() => onOpenTab("releases")}>
            Releases
          </button>
          .
        </p>
      )}
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
            cell: (r) => (r.confirmed ? "a person" : <span className="sub">detected</span>),
          },
          {
            id: "conforms",
            header: "Follows its template",
            cell: (r) =>
              r.conforms === null ? (
                "—"
              ) : r.conforms ? (
                <span className="badge ok">yes</span>
              ) : (
                <span className="badge warn">gaps</span>
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
