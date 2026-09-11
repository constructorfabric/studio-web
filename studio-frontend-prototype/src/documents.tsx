// Documents tab (prototype). Two modes:
//  • Documents — a project's effective documents (own + inherited from the
//    workspace); create from a type template (at project or workspace level),
//    edit markdown, and see the live section checklist + conformance.
//  • Types — the workspace's effective document types (built-in ∪
//    workspace-defined); define or override a type (template, sections, rules).
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  api,
  ArtifactNode,
  CatalogNode,
  Connection,
  ConnectorProvider,
  Doc,
  DocBinding,
  DocBindingState,
  DocQuestion,
  DocRules,
  DocSection,
  DocType,
  DocValidation,
  RemoteRepo,
  SpecFinding,
  WrittenFile,
} from "./api";
import { detectDocType, isDetectorCancel, MIN_SPEC_SHARE } from "./spec-quality";

/** Human-readable message from an ApiError (title/detail) or any Error. */
function errText(e: unknown): string {
  const x = e as { detail?: string; title?: string; message?: string } | null;
  return x?.detail || x?.title || x?.message || String(e);
}

const STATUSES: Doc["status"][] = ["draft", "review", "approved"];
const card = { border: "1px solid var(--border)", borderRadius: 10, padding: 12 } as const;
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "section";

/** Project-level: what the project's repository actually contains.
 *
 *  Authoring lives at the workspace, next to the types — see
 *  [`WorkspaceDocumentsTab`]. A document reaches a project by being written
 *  into its repository, and reaches this view by being ingested and identified.
 *  That is the whole of it: this tab reports, it does not author. */
export function DocumentsTab({
  token,
  workspaceId,
  projectTenantId,
  onOpenStudio,
}: {
  token: string;
  /** The parent workspace tenant — the storage scope for documents and types. */
  workspaceId: string;
  /** The open project tenant. */
  projectTenantId: string;
  /** Open this project in the IDE — where a document is actually edited. */
  onOpenStudio: () => void;
}) {
  const [types, setTypes] = useState<DocType[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .docTypes(token, workspaceId)
      .then((r) => {
        if (alive) setTypes(r.items);
      })
      .catch((e) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [token, workspaceId]);

  return (
    <div className="documents">
      {err && <div className="error">{err}</div>}
      <IngestedDocumentsView
        token={token}
        workspaceId={workspaceId}
        projectTenantId={projectTenantId}
        types={types}
        onOpenStudio={onOpenStudio}
      />
    </div>
  );
}

/** Workspace-level: the documents the workspace itself keeps, written from its
 *  own types and published into a repository from here.
 *
 *  It sits beside the type catalogue on purpose. A type, its template and its
 *  questionnaire are workspace property, and so is a document written from one
 *  before any project has claimed it. */
export function WorkspaceDocumentsTab({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}) {
  const [types, setTypes] = useState<DocType[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .docTypes(token, workspaceId)
      .then((r) => {
        if (alive) setTypes(r.items);
      })
      .catch((e) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [token, workspaceId]);

  return (
    <div className="documents">
      {err && <div className="error">{err}</div>}
      <DocumentsView token={token} workspaceId={workspaceId} types={types} />
    </div>
  );
}

/** Workspace-level: define the document types — templates, section checklists
 *  and conformance rules. They are inherited by every project in the workspace,
 *  where documents are actually created and edited. */
export function DocumentTypesTab({ token, workspaceId }: { token: string; workspaceId: string }) {
  const [types, setTypes] = useState<DocType[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const loadTypes = useCallback(async () => {
    try {
      setTypes((await api.docTypes(token, workspaceId)).items);
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, workspaceId]);

  useEffect(() => {
    void loadTypes();
  }, [loadTypes]);

  return (
    <div className="doctypes">
      <style>{DOCTYPES_CSS}</style>
      <div className="dt-head">
        <h2>Document types</h2>
        <p>
          Define a document type once — its template, the sections it must contain, and the rules that
          make it valid. Every project in the workspace inherits it, so its documents can be checked
          against the same requirements.
        </p>
      </div>
      <DocTypesFlow />
      {err && <div className="error">{err}</div>}
      <TypesView token={token} workspaceId={workspaceId} types={types} onSaved={loadTypes} />
    </div>
  );
}

/** The concept in one line: what you define here, and what it enables in projects. */
function DocTypesFlow() {
  const steps = [
    { n: "1", t: "Type", d: "name & purpose" },
    { n: "2", t: "Template", d: "markdown skeleton" },
    { n: "3", t: "Sections", d: "required headings" },
    { n: "4", t: "Rules", d: "what makes it valid" },
  ];
  return (
    <div className="dt-flow">
      {steps.map((s, i) => (
        <Fragment key={s.n}>
          <div className="dt-flow-step">
            <span className="dt-flow-n">{s.n}</span>
            <span className="dt-flow-body">
              <span className="dt-flow-t">{s.t}</span>
              <span className="dt-flow-d">{s.d}</span>
            </span>
          </div>
          {i < steps.length - 1 && <span className="dt-flow-arrow">→</span>}
        </Fragment>
      ))}
      <span className="dt-flow-arrow big">⇒</span>
      <div className="dt-flow-step outcome">
        <span className="dt-flow-body">
          <span className="dt-flow-t">In projects</span>
          <span className="dt-flow-d">documents are validated · conform ✓ / issues ✗</span>
        </span>
      </div>
    </div>
  );
}

// ── Documents ────────────────────────────────────────────────────────────────

function DocumentsView({
  token,
  workspaceId,
  types,
}: {
  token: string;
  workspaceId: string;
  types: DocType[];
}) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [report, setReport] = useState<DocValidation | null>(null);
  const [newType, setNewType] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [showQ, setShowQ] = useState(false);
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [scaffold, setScaffold] = useState<Scaffold | null>(null);
  const [publishing, setPublishing] = useState<Doc | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const newTypeObj = useMemo(() => types.find((t) => t.key === newType) ?? null, [types, newType]);
  const hasQuestionnaire = (newTypeObj?.questionnaire?.length ?? 0) > 0;

  const selected = useMemo(() => docs.find((d) => d.id === selectedId) ?? null, [docs, selectedId]);
  const editable = !!selected && !selected.inherited;

  const reload = useCallback(async () => {
    setErr(null);
    try {
      setDocs((await api.workspaceDocuments(token, workspaceId)).items);
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (types.length > 0 && !newType) setNewType(types[0].key);
  }, [types, newType]);

  useEffect(() => {
    if (!selected) {
      setDraftTitle("");
      setDraftBody("");
      setReport(null);
      return;
    }
    setDraftTitle(selected.title);
    setDraftBody(selected.content);
    setReport(null);
    api.validateDocument(token, workspaceId, selected.id).then(setReport).catch(() => setReport(null));
  }, [selectedId, selected, token, workspaceId]);

  const createDoc = async (title: string, answers?: import("./api").DocAnswer[]) => {
    if (!newType || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // The body is composed server-side from the answers (ADR-0014 follow-up
      // 2). It used to be built here, which made one client's markdown the de
      // facto contract for a type that every client shares.
      const body: {
        type_key: string;
        title: string;
        content?: string;
        answers?: import("./api").DocAnswer[];
      } = {
        type_key: newType,
        title: title.trim(),
      };
      if (answers) body.answers = answers;
      const doc = await api.createWorkspaceDocument(token, workspaceId, body);
      setNewTitle("");
      setShowQ(false);
      await reload();
      setSelectedId(doc.id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const create = () => createDoc(newTitle);

  const runCompose = async () => {
    if (!selected) return;
    setComposeBusy(true);
    setErr(null);
    try {
      const [components, profs, vocab] = await Promise.all([
        api.listComponents(token),
        api.listComponentProfiles(token).catch(() => ({ nodes: [] as import("./api").CatalogNode[] })),
        api.capabilities(token, workspaceId),
      ]);
      const profiles: Record<string, Record<string, unknown>> = {};
      for (const n of profs.nodes ?? []) {
        const nm = (n.value as Record<string, unknown>).gear_name;
        if (typeof nm === "string") profiles[nm] = n.value as Record<string, unknown>;
      }
      const caps = selected.capabilities ?? [];
      setPlan(composePlan(caps, components.nodes ?? [], profiles, vocab.items ?? []));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setComposeBusy(false);
    }
  };

  const save = async () => {
    if (!selected || !editable) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateDocument(token, workspaceId, selected.id, { title: draftTitle, content: draftBody });
      setReport(await api.validateDocument(token, workspaceId, selected.id));
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: Doc["status"]) => {
    if (!selected || !editable) return;
    setBusy(true);
    try {
      await api.updateDocument(token, workspaceId, selected.id, { status });
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || !editable) return;
    setBusy(true);
    try {
      await api.deleteDocument(token, workspaceId, selected.id);
      setSelectedId(null);
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const typeName = (key: string) => types.find((t) => t.key === key)?.name ?? key;

  return (
    <>
      {err && <div className="error">{err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={card}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>New document</div>
            <select value={newType} onChange={(e) => setNewType(e.target.value)} style={{ width: "100%", marginBottom: 6 }}>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                  {t.owner === "workspace" ? " · workspace" : ""}
                </option>
              ))}
            </select>
            <input
              placeholder="Title…"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              style={{ width: "100%", marginBottom: 6 }}
            />
            {hasQuestionnaire ? (
              <button className="primary" onClick={() => setShowQ(true)} disabled={busy} style={{ width: "100%" }}>
                Fill questionnaire →
              </button>
            ) : (
              <button className="primary" onClick={create} disabled={busy || !newTitle.trim()} style={{ width: "100%" }}>
                Create from template
              </button>
            )}
            {hasQuestionnaire && (
              <p style={{ fontSize: 11, opacity: 0.7, margin: "6px 0 0" }}>
                {newTypeObj?.name} is filled by answering a questionnaire.
              </p>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {docs.length === 0 && <p className="empty">No documents yet — create one from a type.</p>}
            {docs.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: d.id === selectedId ? "var(--accent)" : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.title || "(untitled)"}
                  </span>
                  <span title={d.conforms ? "conforms" : "incomplete"} style={{ marginLeft: "auto", fontSize: 11 }}>
                    {d.conforms ? "✓" : "•"}
                  </span>
                </span>
                <span style={{ fontSize: 11, opacity: 0.7, display: "flex", gap: 6 }}>
                  <code>{typeName(d.type_key)}</code>
                  <span>· {d.status}</span>
                  {d.inherited && <span style={{ color: "var(--muted-foreground)" }}>· inherited</span>}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          {!selected ? (
            <p className="empty">Select a document, or create one.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} disabled={!editable} style={{ flex: 1, fontWeight: 600 }} />
                  <select value={selected.status} onChange={(e) => setStatus(e.target.value as Doc["status"])} disabled={!editable || busy}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  disabled={!editable}
                  spellCheck={false}
                  style={{ width: "100%", minHeight: 420, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.5, padding: 10, borderRadius: 8, border: "1px solid var(--border)", resize: "vertical" }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="primary" onClick={save} disabled={!editable || busy}>
                    Save &amp; validate
                  </button>
                  {selected.type_key === "app_spec" && (
                    <button onClick={runCompose} disabled={composeBusy} title="Match this spec's capabilities against the component catalog">
                      {composeBusy ? "Composing…" : "Compose →"}
                    </button>
                  )}
                  <button
                    onClick={() => setPublishing(selected)}
                    disabled={busy}
                    title="Commit this document into a repository through one of the project's connections"
                  >
                    Publish…
                  </button>
                  <button onClick={remove} disabled={!editable || busy}>
                    Delete
                  </button>
                  {selected.inherited && (
                    <span className="subtitle" style={{ margin: 0 }}>
                      Inherited from the workspace — read-only here.
                    </span>
                  )}
                </div>
              </div>
              <Checklist report={report} />
            </div>
          )}
        </div>
      </div>
      {showQ && newTypeObj && (
        <QuestionnaireModal
          type={newTypeObj}
          busy={busy}
          initialTitle={newTitle}
          onCancel={() => setShowQ(false)}
          onSubmit={(answers, title) => createDoc(title, answers)}
        />
      )}
      {plan && (
        <ComposePlanModal
          plan={plan}
          title={selected?.title ?? "App Spec"}
          onScaffold={(cap) => setScaffold(scaffoldGear(cap, selected?.title ?? "App Spec"))}
          onClose={() => setPlan(null)}
        />
      )}
      {publishing && (
        <PublishModal
          token={token}
          doc={publishing}
          tenantId={workspaceId}
          onClose={() => setPublishing(null)}
        />
      )}
      {scaffold && (
        <ScaffoldModal
          scaffold={scaffold}
          token={token}
          projectTenantId={workspaceId}
          onBack={() => setScaffold(null)}
          onClose={() => setScaffold(null)}
        />
      )}
    </>
  );
}

// ── From the repository ──────────────────────────────────────────────────────
// Scenario B: the repository already had documents in it when we connected to
// it. Their content stays in the artifact graph — this view only decides what
// each file IS, so the same templates that govern documents written in Studio
// can be applied to documents that were not.

/** How many files go into one classify request. The whole repository in one
 *  body would blow the gateway's request-size limit. */
const CLASSIFY_BATCH = 25;

/** Page size when walking the artifact graph's file nodes. */
const NODE_PAGE = 200;

/** Only these need a person: everything else is either settled or not a doc. */
const NEEDS_REVIEW: DocBindingState[] = ["detected", "unknown"];

const STATE_LABEL: Record<DocBindingState, string> = {
  detected: "proposed",
  confirmed: "confirmed",
  manual: "set by hand",
  unknown: "undetermined",
  not_a_document: "not a document",
};

/** The product's own status colours, not ours: a proposal reads as information,
 *  a settled type as success, an undecided file as something still wanting
 *  attention, and a file we were told is not a document recedes. */
const STATE_TONE: Record<DocBindingState, { bg: string; fg: string }> = {
  detected: { bg: "var(--info-soft)", fg: "var(--info)" },
  confirmed: { bg: "var(--success-soft)", fg: "var(--success)" },
  manual: { bg: "var(--success-soft)", fg: "var(--success)" },
  unknown: { bg: "var(--warning-soft)", fg: "var(--warning)" },
  not_a_document: { bg: "var(--muted)", fg: "var(--muted-foreground)" },
};

const SOURCE_LABEL: Record<string, string> = {
  front_matter: "declared in the file",
  heuristic: "matched the template",
  spec_quality: "Spec Quality",
  manual: "chosen by hand",
};

/** A detector says how it went in its own words. These are the ones the
 *  prototype writes (`materializeFinding` in spec-quality.tsx); anything else a
 *  future detector invents reads as neutral rather than as a failure. */
const FINDING_TONE: Record<string, { bg: string; fg: string }> = {
  "gate-passed": { bg: "var(--success-soft)", fg: "var(--success)" },
  clean: { bg: "var(--success-soft)", fg: "var(--success)" },
  "gate-failed": { bg: "var(--destructive-soft)", fg: "var(--destructive)" },
  high: { bg: "var(--destructive-soft)", fg: "var(--destructive)" },
  some: { bg: "var(--warning-soft)", fg: "var(--warning)" },
  analyzed: { bg: "var(--info-soft)", fg: "var(--info)" },
};

const findingTone = (severity?: string | null) =>
  FINDING_TONE[severity ?? ""] ?? { bg: "var(--muted)", fg: "var(--muted-foreground)" };

type BindingFilter = "review" | "bound" | "ignored" | "all";

/** The files Studio pulled out of the repository, and what we think each is. */
function IngestedDocumentsView({
  token,
  workspaceId,
  projectTenantId,
  types,
  onOpenStudio,
}: {
  token: string;
  workspaceId: string;
  projectTenantId: string;
  types: DocType[];
  /** Editing a document is the IDE's job — this hands the project over to it. */
  onOpenStudio: () => void;
}) {
  const [bindings, setBindings] = useState<DocBinding[]>([]);
  const [filter, setFilter] = useState<BindingFilter>("review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** Content from the last scan, keyed by graph node id. Held only so a
   *  decision can re-check conformance without re-reading the graph; the
   *  server never stores it. */
  const [contentByNode, setContentByNode] = useState<Record<string, string>>({});
  /** Detector verdicts read back from the graph, keyed by document node id. */
  const [findings, setFindings] = useState<Record<string, SpecFinding[]>>({});
  const abortRef = useRef<AbortController | null>(null);

  const typeName = useCallback(
    (key?: string | null) => (key ? (types.find((t) => t.key === key)?.name ?? key) : "—"),
    [types],
  );

  const reload = useCallback(async () => {
    setErr(null);
    try {
      setBindings((await api.docBindings(token, workspaceId, projectTenantId)).items);
    } catch (e) {
      setErr(errText(e));
    }
    // Findings are their own nodes in the graph and outlive this tab, the
    // session and the detector run that produced them. A failure to read them
    // must not cost the queue itself: the bindings above are the point, the
    // verdicts are what is known about them so far.
    try {
      const found = await api.listSpecFindings(token, projectTenantId);
      const byNode: Record<string, SpecFinding[]> = {};
      for (const f of found) (byNode[f.subject] ??= []).push(f);
      for (const list of Object.values(byNode)) list.sort((a, b) => a.detector.localeCompare(b.detector));
      setFindings(byNode);
    } catch {
      // Leave whatever was already read; the column simply shows nothing.
    }
  }, [token, workspaceId, projectTenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /** Walk the artifact graph's file nodes and classify everything that has
   *  text. A node without text was ingested from the connector's tree API
   *  (metadata only) — there is nothing to read, so it is reported, not
   *  silently dropped. */
  /** The text of every file in the project's checkouts, keyed by repo-relative
   *  path.
   *
   *  The clone is the only place the content reliably is: a graph file node
   *  carries `text` only when ingest read it from one, and a sync that went
   *  through the connector's tree API leaves every node metadata-only. Reading
   *  the node and giving up left the queue empty on projects whose clone was
   *  right there.
   *
   *  One flat map across repositories. Two repositories with the same path is
   *  the one case it cannot tell apart; the graph node ids still keep those
   *  files as separate bindings, so the cost is a wrong preview, not a wrong
   *  identity. */
  const readCheckouts = useCallback(async (): Promise<Record<string, string>> => {
    const settings = await api.workspaceSettings(token, projectTenantId).catch(() => null);
    const repos = (settings?.repos ?? []).filter((r) => r.source !== "local");
    const byPath: Record<string, string> = {};
    for (const repo of repos) {
      try {
        const { files } = await api.repoFiles(token, projectTenantId, repo.target || repo.name);
        for (const f of files) if (!(f.path in byPath)) byPath[f.path] = f.text;
      } catch {
        // One repository that was never cloned must not stop the others.
      }
    }
    return byPath;
  }, [token, projectTenantId]);

  /** Walk the ingested file nodes, take each one's text from the checkout (or
   *  from the node, when ingest did capture it), and classify what is prose. */
  const scan = async () => {
    setBusy(true);
    setErr(null);
    setNote("");
    setProgress("Reading the repository's files…");
    try {
      const fromCheckout = await readCheckouts();

      const nodes: ArtifactNode[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listArtifactNodes(
          token,
          "file",
          projectTenantId,
          cursor,
          NODE_PAGE,
        );
        nodes.push(...(page.nodes ?? []));
        cursor = page.next_cursor;
        setProgress(`Read ${nodes.length} file${nodes.length === 1 ? "" : "s"}…`);
      } while (cursor);

      if (nodes.length === 0) {
        setNote("No files ingested yet — run Sync on a repository in the Artifacts tab first.");
        return;
      }

      const files: { node_id: string; path: string; content: string }[] = [];
      let withoutText = 0;
      const seen: Record<string, string> = {};
      for (const n of nodes) {
        const path = typeof n.value.path === "string" ? n.value.path : "";
        if (!path || n.value.is_dir) continue;
        const text =
          fromCheckout[path] ?? (typeof n.value.text === "string" ? n.value.text : "");
        if (!text) {
          withoutText += 1;
          continue;
        }
        files.push({ node_id: n.instance_id, path, content: text });
        seen[n.instance_id] = text;
      }

      if (files.length === 0) {
        setNote(
          `None of the ${nodes.length} ingested files carry their text, and no checkout of ` +
            "this project's repositories has one either. Open the project in the IDE so the " +
            "repository is cloned, then scan again.",
        );
        return;
      }

      let classified = 0;
      let skipped = 0;
      for (let i = 0; i < files.length; i += CLASSIFY_BATCH) {
        const batch = files.slice(i, i + CLASSIFY_BATCH);
        setProgress(`Classifying ${i + 1}–${i + batch.length} of ${files.length}…`);
        const res = await api.classifyDocFiles(token, workspaceId, projectTenantId, batch);
        classified += res.items.length;
        skipped += res.skipped;
      }
      setContentByNode((prev) => ({ ...prev, ...seen }));
      await reload();
      setNote(
        `Classified ${classified} document${classified === 1 ? "" : "s"}` +
          (skipped ? `, skipped ${skipped} non-prose file${skipped === 1 ? "" : "s"}` : "") +
          (withoutText ? `, ${withoutText} file${withoutText === 1 ? "" : "s"} had no text` : "") +
          ".",
      );
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  /** Ask Spec Quality about everything the offline scoring could not decide.
   *  One LLM round-trip per document, so it runs only on the leftovers and
   *  only when asked. Its answer is a proposal, not a decision — it lands as
   *  `detected` and still waits for a person. */
  const refineWithSpecQuality = async () => {
    // Skip what a detector has already looked at. The verdict is in the graph
    // and shown in the list, so paying for it again buys nothing — including
    // when the answer was "recognised too little to place", which is a result.
    const analysed = (b: DocBinding) =>
      (findings[b.node_id] ?? []).some((f) => f.detector === "purpose");
    const targets = bindings.filter(
      (b) => b.state === "unknown" && contentByNode[b.node_id] && !analysed(b),
    );
    const alreadyDone = bindings.filter((b) => b.state === "unknown" && analysed(b)).length;
    if (targets.length === 0) {
      setNote(
        alreadyDone > 0
          ? `Nothing left to refine — Spec Quality has already looked at ${alreadyDone} of ${
              alreadyDone === 1 ? "these" : "them"
            }, and its verdict is in the list.`
          : bindings.some((b) => b.state === "unknown")
            ? "Run Scan first — Spec Quality needs each document's text, which the scan loads."
            : "Nothing undetermined to refine.",
      );
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setErr(null);
    setNote("");
    let named = 0;
    let declined = 0;
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const b = targets[i];
        setProgress(`Spec Quality ${i + 1}/${targets.length} · ${basename(b.path)}`);
        const { docType, specShare, gatePassed, taskId } = await detectDocType(
          token,
          b.path,
          contentByNode[b.node_id],
          ctrl.signal,
        );
        // Two things have to hold before a verdict is worth recording: the
        // detector recognised enough of the document for the type it named to
        // mean anything, and that name is one this workspace has a template
        // for. It always names a type, so without the first check a run over
        // unrelated files comes back with all of them called the same thing.
        const recognised = specShare >= MIN_SPEC_SHARE;

        const summary = docType
          ? `purpose: ${docType} (${Math.round(specShare * 100)}% specification)`
          : "purpose: no type named";

        // Two writes, for two different things, and neither is a copy of the
        // other. The graph keeps the finding itself — the detector, the score,
        // the raw result — joined to the file, which is what survives and what
        // the list shows. The binding keeps the pass/fail, which is the one
        // question a stage gate asks and the only one it can afford to walk a
        // graph for.
        void api
          .saveQualityFindings(token, {
            findings: [
              {
                detector: "purpose",
                subject: b.node_id,
                path: b.path,
                severity:
                  gatePassed === true
                    ? "gate-passed"
                    : gatePassed === false
                      ? "gate-failed"
                      : recognised
                        ? "analyzed"
                        : "unrecognised",
                summary,
                score: specShare,
              },
            ],
            workspace_id: workspaceId,
            project_id: projectTenantId,
          })
          .catch(() => {
            // The binding below is the decision; losing its trace is not worth
            // failing the run the person is watching.
          });

        // `gate` is `leak_share` against a threshold — no foreign content where
        // the type says there should be none. Useless as evidence for the type
        // it named, exactly right as the verdict a stage gating on `purpose`
        // waits for. Unknown stays `pending`: a gate never opens on a value we
        // could not interpret.
        void api
          .recordBindingAnalysis(token, workspaceId, b.id, "purpose", {
            state: gatePassed === true ? "passed" : gatePassed === false ? "failed" : "pending",
            task_id: taskId,
            summary,
          })
          .catch(() => {
            // Same reasoning: the person is watching the queue, not the gate.
          });

        if (docType && recognised && types.some((t) => t.key === docType)) {
          await api.decideDocBinding(token, workspaceId, b.id, {
            action: "set",
            type_key: docType,
            source: "spec_quality",
            confidence: specShare,
            content: contentByNode[b.node_id],
          });
          named += 1;
        } else {
          declined += 1;
        }
      }
      await reload();
      setNote(
        `Spec Quality named ${named} document${named === 1 ? "" : "s"}` +
          (declined
            ? `, and recognised too little of ${declined} to place ${
                declined === 1 ? "it" : "them"
              }`
            : "") +
          (alreadyDone ? `; ${alreadyDone} had been analysed before` : "") +
          ".",
      );
    } catch (e) {
      if (isDetectorCancel(e)) setNote(`Stopped after ${named} document${named === 1 ? "" : "s"}.`);
      else setErr(errText(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress("");
    }
  };

  /** Apply one person's decision to one binding, re-validating when we still
   *  hold the file's text. */
  const decide = async (
    b: DocBinding,
    body: Parameters<typeof api.decideDocBinding>[3],
  ) => {
    setErr(null);
    try {
      const content = contentByNode[b.node_id];
      const updated = await api.decideDocBinding(token, workspaceId, b.id, {
        ...body,
        ...(content ? { content } : {}),
      });
      setBindings((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setErr(errText(e));
    }
  };

  const counts = useMemo(() => {
    const review = bindings.filter((b) => NEEDS_REVIEW.includes(b.state)).length;
    const bound = bindings.filter((b) => b.state === "confirmed" || b.state === "manual").length;
    const ignored = bindings.filter((b) => b.state === "not_a_document").length;
    return { review, bound, ignored, all: bindings.length };
  }, [bindings]);

  const shown = useMemo(() => {
    const list = bindings.filter((b) => {
      switch (filter) {
        case "review":
          return NEEDS_REVIEW.includes(b.state);
        case "bound":
          return b.state === "confirmed" || b.state === "manual";
        case "ignored":
          return b.state === "not_a_document";
        default:
          return true;
      }
    });
    return [...list].sort((a, b) => a.path.localeCompare(b.path));
  }, [bindings, filter]);

  const selected = useMemo(
    () => shown.find((b) => b.id === selectedId) ?? null,
    [shown, selectedId],
  );

  const FILTERS: { id: BindingFilter; label: string; count: number }[] = [
    { id: "review", label: "Needs review", count: counts.review },
    { id: "bound", label: "Bound", count: counts.bound },
    { id: "ignored", label: "Not documents", count: counts.ignored },
    { id: "all", label: "All", count: counts.all },
  ];

  return (
    <div className="ingested">
      <style>{INGESTED_CSS}</style>
      <div className="ing-head">
        <h2>Documents already in the repository</h2>
        <p>
          Studio reads the files the repository sync pulled in and works out which template each
          one was written against — from a type declared in its front matter, or by matching its
          sections, path and title. Anything it cannot decide waits here for you.
        </p>
      </div>

      <div className="ing-bar">
        <button className="primary" onClick={scan} disabled={busy}>
          {busy ? "Working…" : "Scan repository"}
        </button>
        <button
          onClick={refineWithSpecQuality}
          disabled={busy || counts.review === 0}
          title="Ask the Spec Quality purpose detector about the documents scoring could not place"
        >
          Refine undetermined with Spec Quality
        </button>
        {busy && abortRef.current && (
          <button onClick={() => abortRef.current?.abort()}>Stop</button>
        )}
        {progress && <span className="ing-progress">{progress}</span>}
        {note && !progress && <span className="ing-note">{note}</span>}
      </div>

      {err && <div className="error">{err}</div>}

      <div className="ing-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? "ing-filter on" : "ing-filter"}
            onClick={() => setFilter(f.id)}
          >
            {f.label} <span className="ing-count">{f.count}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="empty">
          {counts.all === 0
            ? "Nothing scanned yet. Run Scan repository to see what is in there."
            : "Nothing in this view."}
        </p>
      ) : (
        <div className="ing-split">
          <div className="ing-table">
            <div className="ing-row ing-row-head">
              <span>File</span>
              <span>Document type</span>
              <span>Why</span>
              <span>Conforms</span>
              <span>Analysis</span>
              <span />
            </div>
            {shown.map((b) => (
              <div
                key={b.id}
                className={selectedId === b.id ? "ing-row on" : "ing-row"}
                onClick={() => setSelectedId(b.id)}
              >
                <span className="ing-path" title={b.path}>
                  {b.path}
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <select
                    value={b.type_key ?? ""}
                    disabled={busy}
                    onChange={(e) =>
                      e.target.value
                        ? void decide(b, { action: "set", type_key: e.target.value })
                        : void decide(b, { action: "reset" })
                    }
                  >
                    <option value="">— undetermined —</option>
                    {types.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </span>
                <span className="ing-why">
                  <span
                    className="ing-state"
                    style={{
                      background: STATE_TONE[b.state].bg,
                      color: STATE_TONE[b.state].fg,
                    }}
                  >
                    {STATE_LABEL[b.state]}
                  </span>
                  {b.confidence != null && b.state === "detected" && (
                    <span className="ing-conf">{Math.round(b.confidence * 100)}%</span>
                  )}
                  {b.source && <span className="ing-src">{SOURCE_LABEL[b.source] ?? b.source}</span>}
                </span>
                <span>
                  {b.conforms == null ? (
                    <span className="ing-dash">—</span>
                  ) : (
                    <span className={b.conforms ? "ing-ok" : "ing-bad"}>
                      {b.conforms ? "✓" : `${b.validation?.issues.length ?? 0} issue(s)`}
                    </span>
                  )}
                </span>
                <span className="ing-findings">
                  {(findings[b.node_id] ?? []).length === 0 ? (
                    <span className="ing-dash">—</span>
                  ) : (
                    (findings[b.node_id] ?? []).map((f) => (
                      <span
                        key={f.detector}
                        className="ing-state"
                        title={f.summary ?? f.detector}
                        style={{
                          background: findingTone(f.severity).bg,
                          color: findingTone(f.severity).fg,
                        }}
                      >
                        {f.detector}
                      </span>
                    ))
                  )}
                </span>
                <span className="ing-actions" onClick={(e) => e.stopPropagation()}>
                  {b.state === "detected" && (
                    <button onClick={() => void decide(b, { action: "confirm" })} disabled={busy}>
                      Confirm
                    </button>
                  )}
                  {b.state === "not_a_document" ? (
                    <button onClick={() => void decide(b, { action: "reset" })} disabled={busy}>
                      Reconsider
                    </button>
                  ) : (
                    <button
                      onClick={() => void decide(b, { action: "reject" })}
                      disabled={busy}
                      title="This file is not a document — stop proposing types for it"
                    >
                      Not a doc
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div className="ing-side">
            {!selected ? (
              <p className="empty" style={{ fontSize: 12 }}>
                Pick a file to see what the type expects of it.
              </p>
            ) : (
              <>
                <div style={card}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    {basename(selected.path)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                    {typeName(selected.type_key)}
                  </div>
                  {/* The file lives in the repository, so the repository's
                      editor is where it is changed. Studio reports on it. */}
                  <button
                    onClick={onOpenStudio}
                    style={{ marginTop: 10, width: "100%" }}
                    title="Open this project in the IDE to edit the file"
                  >
                    Edit in the IDE →
                  </button>
                  {selected.candidates.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                        What it looked like
                      </div>
                      <ul
                        style={{
                          margin: 0,
                          paddingLeft: 16,
                          fontSize: 12,
                          color: "var(--muted-foreground)",
                        }}
                      >
                        {selected.candidates.map((c) => (
                          <li key={c.type_key}>
                            <b>{typeName(c.type_key)}</b> {Math.round(c.confidence * 100)}% — {c.why}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <Checklist report={selected.validation ?? null} />
                <div style={card}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Analysis</div>
                  {(findings[selected.node_id] ?? []).length === 0 ? (
                    <p className="empty" style={{ fontSize: 12, margin: 0 }}>
                      No detector has looked at this document yet. Run one from the Analyze tab, or
                      refine the undetermined above.
                    </p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {(findings[selected.node_id] ?? []).map((f) => (
                        <div key={f.detector} style={{ fontSize: 12 }}>
                          <span
                            className="ing-state"
                            style={{
                              background: findingTone(f.severity).bg,
                              color: findingTone(f.severity).fg,
                            }}
                          >
                            {f.detector}
                          </span>{" "}
                          {f.severity ?? "recorded"}
                          {f.score != null && (
                            <span className="ing-conf"> · {Math.round(f.score * 100)}%</span>
                          )}
                          {f.summary && (
                            <div style={{ opacity: 0.7, marginTop: 2 }}>{f.summary}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const INGESTED_CSS = `
.ingested { display: flex; flex-direction: column; gap: 12px; }
.ing-head h2 { margin: 0 0 4px; font-size: 16px; }
.ing-head p { margin: 0; font-size: 13px; color: var(--muted-foreground); max-width: 70ch; }
.ing-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ing-progress, .ing-note { font-size: 12px; color: var(--muted-foreground); }
.ing-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.ing-filter { font-size: 12px; padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border); background: transparent; cursor: pointer; }
.ing-filter.on { background: var(--accent); border-color: var(--accent-foreground); }
.ing-count { opacity: 0.6; margin-left: 4px; }
.ing-split { display: grid; grid-template-columns: minmax(0,1fr) 280px; gap: 12px; align-items: start; }
.ing-table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.ing-row { display: grid; grid-template-columns: minmax(0,2fr) 150px minmax(0,1.2fr) 100px minmax(0,1fr) 150px; gap: 8px; align-items: center; padding: 6px 10px; font-size: 12px; border-top: 1px solid var(--border); cursor: pointer; }
.ing-row:first-child { border-top: none; }
.ing-row.on { background: var(--accent); }
.ing-row-head { font-weight: 600; cursor: default; background: var(--surface-raised); }
.ing-row select { width: 100%; font-size: 12px; }
.ing-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; }
.ing-why { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ing-state { padding: 1px 7px; border-radius: 20px; font-size: 11px; white-space: nowrap; }
.ing-conf { opacity: 0.7; }
.ing-src { opacity: 0.6; font-size: 11px; }
.ing-ok { color: var(--success); }
.ing-bad { color: var(--warning); }
.ing-dash { opacity: 0.4; }
.ing-findings { display: flex; gap: 4px; flex-wrap: wrap; }
.ing-actions { display: flex; gap: 4px; justify-content: flex-end; }
.ing-actions button { font-size: 11px; padding: 2px 8px; }
.ing-side { display: flex; flex-direction: column; gap: 10px; position: sticky; top: 8px; }
@media (max-width: 900px) {
  .ing-split { grid-template-columns: 1fr; }
  .ing-row { grid-template-columns: 1fr; gap: 4px; }
  .ing-side { position: static; }
}
`;

// ── Publishing back to the source ────────────────────────────────────────────
// The other half of scenario A: a document written here is only half-delivered
// while it lives in Studio's database. Publishing commits it through the same
// connection the project already uses to read that repository, so what may be
// written is exactly what that credential may push.

/** Commit straight onto a branch, or land it as a request to review. */
type PublishMode = "pull_request" | "commit";

const PUBLISH_MODES: { id: PublishMode; label: string; hint: string }[] = [
  {
    id: "pull_request",
    label: "Open a pull request",
    hint: "Commits to a working branch and opens a request against the base.",
  },
  {
    id: "commit",
    label: "Commit directly",
    hint: "Commits straight onto the branch named — no review step.",
  },
];

/** Where a document of this type belongs in a repository, by convention.
 *  Only a starting suggestion — the path is editable. */
function suggestedPath(doc: Doc): string {
  return `docs/${doc.type_key}/${slugPath(doc.title)}.md`;
}

/** A filename-safe slug of a document title. */
function slugPath(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function PublishModal({
  token,
  doc,
  tenantId,
  onClose,
}: {
  token: string;
  doc: Doc;
  /** Tenant whose connections to offer — the project, which also sees the ones
   *  inherited from its workspace and organization. */
  tenantId: string;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[]>([]);
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<PublishMode>("pull_request");
  const [branch, setBranch] = useState(`studio/${slugPath(doc.title)}`);
  const [base, setBase] = useState("");
  const [prTitle, setPrTitle] = useState(`Publish ${doc.title}`);
  const [prBody, setPrBody] = useState("");
  const [path, setPath] = useState(suggestedPath(doc));
  const [message, setMessage] = useState(`docs: publish ${doc.title}`);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [written, setWritten] = useState<WrittenFile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Only source hosts can be published to; a model-provider connection has no
  // repositories at all, so offering it would only produce a confusing 400.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [conns, provs] = await Promise.all([
          api.connections(token, tenantId),
          api.connectorProviders(token).catch(() => ({ items: [] as ConnectorProvider[] })),
        ]);
        const sourceHosts = new Set(
          provs.items.filter((p) => p.category === "source_code").map((p) => p.provider),
        );
        const usable = conns.items.filter((c) => sourceHosts.has(c.provider));
        if (!alive) return;
        setConnections(usable);
        if (usable.length > 0) setConnectionId(usable[0].id);
      } catch (e) {
        if (alive) setErr(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, tenantId]);

  useEffect(() => {
    if (!connectionId) return;
    let alive = true;
    setLoadingRepos(true);
    setRepos([]);
    setRepo("");
    api
      .connectionRepositories(token, connectionId, tenantId)
      .then((r) => {
        if (!alive) return;
        setRepos(r.items);
        if (r.items.length > 0) setRepo(r.items[0].full_path);
      })
      .catch((e) => {
        if (alive) setErr(errText(e));
      })
      .finally(() => {
        if (alive) setLoadingRepos(false);
      });
    return () => {
      alive = false;
    };
  }, [token, connectionId, tenantId]);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.full_path === repo) ?? null,
    [repos, repo],
  );

  const publish = async () => {
    setBusy(true);
    setErr(null);
    try {
      const result = await api.writeRepoFile(token, connectionId, tenantId, {
        repo,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(base.trim() ? { base: base.trim() } : {}),
        path: path.trim(),
        content: doc.content,
        message: message.trim() || `docs: publish ${doc.title}`,
        ...(mode === "pull_request"
          ? {
              pull_request: {
                title: prTitle.trim() || `Publish ${doc.title}`,
                ...(prBody.trim() ? { body: prBody.trim() } : {}),
              },
            }
          : {}),
      });
      setWritten(result);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // A request has to come from somewhere. The server says so too, but saying
  // it here means the person is not told after a commit has already landed.
  const canPublish =
    !!connectionId &&
    !!repo &&
    path.trim().length > 0 &&
    (mode === "commit" || branch.trim().length > 0) &&
    !busy;

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Publish to a repository</span>
          <button onClick={onClose} style={{ marginLeft: "auto" }} aria-label="Close">
            ✕
          </button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
          Commits <b>{doc.title}</b> through one of this project's connections. A whole-file
          write: anything already at that path is replaced. Publishing a second revision
          lands on the same branch, and on the request already open for it.
        </p>

        {!doc.conforms && !written && (
          <div
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 8,
              background: "var(--warning-soft)",
              color: "var(--warning)",
              marginBottom: 12,
            }}
          >
            This document does not yet satisfy its type's checklist. You can still publish it —
            just know that is what you are publishing.
          </div>
        )}

        {written ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13 }}>
              {written.updated ? "Updated" : "Created"} <code>{written.path}</code>
              {written.branch ? ` on ${written.branch}` : ""}
              {written.branch_created ? " (new branch)" : ""}.
            </div>
            {written.commit && (
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                commit <code>{written.commit.slice(0, 10)}</code>
              </div>
            )}
            {written.pull_request && (
              <div style={{ fontSize: 13 }}>
                {written.pull_request.created
                  ? "Opened pull request"
                  : "Added to the pull request already open"}{" "}
                <b>#{written.pull_request.number}</b>.
                {written.pull_request.url && (
                  <>
                    {" "}
                    <a href={written.pull_request.url} target="_blank" rel="noreferrer">
                      Review it →
                    </a>
                  </>
                )}
              </div>
            )}
            {written.url && (
              <a href={written.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Open the file in the provider →
              </a>
            )}
            <div style={{ marginTop: 8 }}>
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            {connections.length === 0 ? (
              <p className="empty" style={{ fontSize: 12 }}>
                No source connections reach this project. Add one under Connections first.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={qLabel}>Connection</label>
                  <select
                    value={connectionId}
                    onChange={(e) => setConnectionId(e.target.value)}
                    style={{ width: "100%" }}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} · {c.provider} · {c.account}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={qLabel}>Repository</label>
                  <select
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    disabled={loadingRepos || repos.length === 0}
                    style={{ width: "100%" }}
                  >
                    {loadingRepos && <option>loading…</option>}
                    {!loadingRepos && repos.length === 0 && <option value="">none reachable</option>}
                    {repos.map((r) => (
                      <option key={r.id} value={r.full_path}>
                        {r.full_path}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={qLabel}>How</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {PUBLISH_MODES.map((m) => (
                      <button
                        key={m.id}
                        className={mode === m.id ? "primary" : undefined}
                        onClick={() => setMode(m.id)}
                        title={m.hint}
                        style={{ flex: 1 }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    {PUBLISH_MODES.find((m) => m.id === mode)?.hint}
                  </div>
                </div>

                <div>
                  <label style={qLabel}>
                    Branch
                    {mode === "commit" && <span style={qTag}>optional</span>}
                  </label>
                  <input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder={
                      mode === "commit"
                        ? (selectedRepo?.default_branch ?? "default branch")
                        : "studio/…"
                    }
                    style={{ width: "100%" }}
                  />
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    A branch that does not exist yet is cut from the base.
                  </div>
                </div>

                <div>
                  <label style={qLabel}>
                    Base<span style={qTag}>optional</span>
                  </label>
                  <input
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    placeholder={selectedRepo?.default_branch ?? "default branch"}
                    style={{ width: "100%" }}
                  />
                </div>

                {mode === "pull_request" && (
                  <>
                    <div>
                      <label style={qLabel}>Pull request title</label>
                      <input
                        value={prTitle}
                        onChange={(e) => setPrTitle(e.target.value)}
                        style={{ width: "100%" }}
                      />
                    </div>
                    <div>
                      <label style={qLabel}>
                        Description<span style={qTag}>optional</span>
                      </label>
                      <textarea
                        value={prBody}
                        onChange={(e) => setPrBody(e.target.value)}
                        rows={3}
                        style={{ width: "100%" }}
                      />
                    </div>
                  </>
                )}

                <div>
                  <label style={qLabel}>Path in the repository</label>
                  <input value={path} onChange={(e) => setPath(e.target.value)} style={{ width: "100%" }} />
                </div>

                <div>
                  <label style={qLabel}>Commit message</label>
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
            )}

            {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
              <button className="primary" onClick={publish} disabled={!canPublish}>
                {busy ? "Publishing…" : "Publish"}
              </button>
              <button onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Questionnaire intake ─────────────────────────────────────────────────────

type Answer = string | string[] | boolean;

/** Is a required question satisfied? */
function answered(q: DocQuestion, a: Answer | undefined): boolean {
  if (q.kind === "bool") return true; // a boolean is always answered
  if (q.kind === "multi") return Array.isArray(a) && a.length > 0;
  return typeof a === "string" && a.trim().length > 0;
}

/** Map the editor's answers onto the wire shape. The server owns rendering; a
 *  client only says what was answered. */
function toWireAnswers(
  questions: DocQuestion[],
  answers: Record<string, Answer>,
): import("./api").DocAnswer[] {
  return questions
    .filter((q) => answers[q.id] !== undefined)
    .map((q) => {
      const a = answers[q.id];
      if (q.kind === "bool") return { question_id: q.id, flag: Boolean(a) };
      if (q.kind === "multi")
        return { question_id: q.id, choices: Array.isArray(a) ? a : [] };
      return { question_id: q.id, text: typeof a === "string" ? a : String(a) };
    });
}

function QuestionnaireModal({
  type,
  busy,
  initialTitle,
  onCancel,
  onSubmit,
}: {
  type: DocType;
  busy: boolean;
  initialTitle: string;
  onCancel: () => void;
  onSubmit: (answers: import("./api").DocAnswer[], title: string) => void;
}) {
  const questions = type.questionnaire ?? [];
  const [title, setTitle] = useState(initialTitle);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const set = (id: string, v: Answer) => setAnswers((a) => ({ ...a, [id]: v }));

  const missing = questions.filter((q) => q.required && !answered(q, answers[q.id])).map((q) => q.id);
  const canSubmit = title.trim().length > 0 && missing.length === 0 && !busy;

  return (
    <div style={modalBackdrop} onClick={onCancel}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{type.name}</span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>· intake questionnaire</span>
          <button onClick={onCancel} style={{ marginLeft: "auto" }} aria-label="Close">
            ✕
          </button>
        </div>
        {type.description && <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>{type.description}</p>}

        <label style={qLabel}>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name this app…" style={{ width: "100%", marginBottom: 14 }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {questions.map((q) => (
            <div key={q.id}>
              <label style={qLabel}>
                {q.prompt}
                {q.required && <span style={{ color: "var(--destructive)" }}> *</span>}
                {q.capability && <code style={qTag}>{q.capability}</code>}
              </label>
              {q.help && <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{q.help}</div>}
              <QuestionInput q={q} value={answers[q.id]} onChange={(v) => set(q.id, v)} />
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 18 }}>
          <button
            className="primary"
            disabled={!canSubmit}
            onClick={() => onSubmit(toWireAnswers(questions, answers), title)}
          >
            Generate document
          </button>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {missing.length > 0 && (
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              {missing.length} required answer{missing.length === 1 ? "" : "s"} left
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function QuestionInput({
  q,
  value,
  onChange,
}: {
  q: DocQuestion;
  value: Answer | undefined;
  onChange: (v: Answer) => void;
}) {
  if (q.kind === "long_text") {
    return (
      <textarea
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", minHeight: 72, padding: 8, borderRadius: 6, border: "1px solid var(--border)", fontSize: 13, resize: "vertical" }}
      />
    );
  }
  if (q.kind === "bool") {
    return (
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        Yes
      </label>
    );
  }
  if (q.kind === "single") {
    return (
      <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }}>
        <option value="">— select —</option>
        {q.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (q.kind === "multi") {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {q.options.map((o) => (
          <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={arr.includes(o)}
              onChange={(e) => onChange(e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))}
            />
            {o}
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: "100%" }}
    />
  );
}

const modalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "6vh 16px",
  zIndex: 50,
  overflowY: "auto",
};
const modalCard: CSSProperties = {
  background: "var(--card)",
  color: "var(--foreground)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 20,
  width: "min(640px, 100%)",
  boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
};
const qLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 };
const qTag: CSSProperties = { marginLeft: 8, fontSize: 10, opacity: 0.6, fontWeight: 400 };


// ── Compose (v1): match the App Spec's capabilities to catalog components ─────


type Candidate = { name: string; kind: string; score: number; why: string[] };
type PlanRow = { capability: string; candidates: Candidate[]; gap: boolean };

function profileText(profile?: Record<string, unknown>): string {
  const auto = profile?.auto;
  if (auto && typeof auto === "object") {
    const d = (auto as Record<string, unknown>).description;
    if (d && typeof d === "object") {
      const s = (d as Record<string, unknown>).s;
      if (typeof s === "string") return s;
    }
    if (typeof d === "string") return d;
  }
  return "";
}

function componentHaystack(g: CatalogNode, profile?: Record<string, unknown>): string {
  const v = g.value;
  return [
    v.name ?? "",
    v.description ?? "",
    v.kind ?? "",
    (v.keywords ?? []).join(" "),
    (v.categories ?? []).join(" "),
    profileText(profile),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Resolve capabilities to candidate components.
 *
 *  `vocabulary` is the workspace's effective capability catalogue, which used to
 *  be a `CAP_KEYWORDS` constant in this file. A workspace that invents a
 *  capability can now give it search terms instead of getting zero candidates
 *  and no explanation (ADR-0014 s5). A capability the catalogue does not know is
 *  still matched against its own name, exactly as before. */
function composePlan(
  caps: string[],
  gears: CatalogNode[],
  profiles: Record<string, Record<string, unknown>>,
  vocabulary: readonly import("./api").Capability[],
): PlanRow[] {
  const terms = new Map(vocabulary.map((c) => [c.key, c.terms]));
  const geared = gears.filter((g) => typeof g.value.name === "string");
  return caps.map((cap) => {
    const kws = terms.get(cap)?.length ? terms.get(cap)! : [cap];
    const candidates = geared
      .map((g) => {
        const hay = componentHaystack(g, profiles[g.value.name as string]);
        const why = new Set<string>();
        for (const k of kws) if (hay.includes(k)) why.add(k);
        if (hay.includes(cap)) why.add(cap);
        return {
          name: g.value.name as string,
          kind: g.value.kind ?? "gear",
          score: why.size,
          why: Array.from(why),
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return { capability: cap, candidates, gap: candidates.length === 0 };
  });
}

function shortName(name: string): string {
  return name.replace(/^cf-gears-/, "").replace(/^@[^/]+\//, "");
}
function kindColor(kind: string): string {
  const m: Record<string, string> = {
    gear: "var(--avatar-mint)",
    sdk: "var(--avatar-blue)",
    plugin: "var(--avatar-purple)",
    toolkit: "var(--avatar-yellow)",
    frontx: "var(--avatar-red)",
  };
  return m[kind] ?? "var(--avatar-grey)";
}

// ── Scaffolding: generate a starter gear for a capability gap ─────────────────

type ScaffoldFile = { path: string; content: string };
type Scaffold = { capability: string; slug: string; files: ScaffoldFile[] };

function pascal(s: string): string {
  return s.replace(/(^|[-_ ])(\w)/g, (_m, _sep, c: string) => c.toUpperCase());
}

/** A canonical toolkit-gear skeleton for a missing capability: manifest, crate,
 *  the `#[toolkit::gear]` entrypoint, and PRD/DESIGN stubs (so it reads well in
 *  the catalog immediately). This is the harness an agent then fills in. */
function scaffoldGear(capability: string, appTitle: string): Scaffold {
  const slug = capability.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "capability";
  const crate = `cf-gears-${slug}`;
  const Gear = `${pascal(slug)}Gear`;
  const gearToml =
    `name = "${crate}"\n` +
    `description = "${capability} capability for ${appTitle}. Scaffolded from an App Spec gap."\n` +
    `category = "platform"\n` +
    `capabilities = ["${capability}"]\n\n` +
    `[plugins]\ndeclared = false\n`;
  const cargoToml =
    `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n\n` +
    `[dependencies]\ntoolkit = { workspace = true }\nasync-trait = { workspace = true }\nanyhow = { workspace = true }\n`;
  const lib =
    `//! ${crate} — the \`${capability}\` capability. Scaffolded from an App Spec gap;\n` +
    `//! fill in the service, GTS types and REST surface.\n\n` +
    `use async_trait::async_trait;\nuse toolkit::{Gear, GearCtx};\n\n` +
    `#[toolkit::gear(\n    name = "${crate}",\n    deps = [],\n    capabilities = [rest]\n)]\n` +
    `#[derive(Default)]\npub struct ${Gear};\n\n` +
    `#[async_trait]\nimpl Gear for ${Gear} {\n` +
    `    async fn init(&self, _ctx: &GearCtx) -> anyhow::Result<()> {\n` +
    `        // TODO: register GTS types, resolve dependencies, wire the ${capability} service.\n` +
    `        Ok(())\n    }\n}\n`;
  const prd =
    `---\nstatus: draft\nowner: \n---\n\n# PRD — ${capability} gear\n\n` +
    `## Problem\n\n${appTitle} needs the \`${capability}\` capability, and no catalogued component provides it.\n\n` +
    `## Goals\n\n- Provide \`${capability}\` as a reusable gear other apps can compose.\n\n` +
    `## Non-Goals\n\n## Users & Use Cases\n\n## Requirements\n\n## Success Metrics\n`;
  const design =
    `---\nstatus: draft\n---\n\n# Design — ${capability} gear\n\n## Overview\n\n` +
    `## Architecture\n\n\`\`\`mermaid\ngraph LR\n    Client --> G["${capability}"]\n    G --> DB[(storage)]\n\`\`\`\n\n` +
    `## Data Model\n\n## Interfaces\n\n## Trade-offs\n`;
  return {
    capability,
    slug,
    files: [
      { path: `gears/${slug}/gear.toml`, content: gearToml },
      { path: `gears/${slug}/Cargo.toml`, content: cargoToml },
      { path: `gears/${slug}/src/lib.rs`, content: lib },
      { path: `gears/${slug}/docs/PRD.md`, content: prd },
      { path: `gears/${slug}/docs/DESIGN.md`, content: design },
    ],
  };
}

function ScaffoldModal({
  scaffold,
  token,
  projectTenantId,
  onBack,
  onClose,
}: {
  scaffold: Scaffold;
  token: string;
  projectTenantId: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const [openPr, setOpenPr] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ branch: string; pr_url?: string | null } | null>(null);
  const file = scaffold.files[active];
  const copy = () => navigator.clipboard?.writeText(file.content).catch(() => {});

  const push = async () => {
    setPushing(true);
    setPushErr(null);
    try {
      const r = await api.scaffoldGearToRepo(token, projectTenantId, {
        slug: scaffold.slug,
        files: scaffold.files,
        open_pr: openPr,
      });
      setResult({ branch: r.branch, pr_url: r.pr_url });
    } catch (e) {
      setPushErr(errText(e));
    } finally {
      setPushing(false);
    }
  };

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: "min(860px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <button onClick={onBack} title="Back to plan">←</button>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Scaffold gear</span>
          <code style={{ fontSize: 12 }}>cf-gears-{scaffold.slug}</code>
          <button onClick={onClose} style={{ marginLeft: "auto" }} aria-label="Close">✕</button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
          Starter skeleton for the <code>{scaffold.capability}</code> gap. Review, then push it to the
          project's connected gear repo on a <code>scaffold/{scaffold.slug}</code> branch — the session
          agent fills it in, and a re-sync registers it in the catalog.
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 12,
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
          }}
        >
          {result ? (
            <span style={{ fontSize: 12 }}>
              ✓ Pushed to <code>{result.branch}</code>
              {result.pr_url && (
                <>
                  {" · "}
                  <a href={result.pr_url} target="_blank" rel="noreferrer">
                    open pull request →
                  </a>
                </>
              )}
            </span>
          ) : (
            <>
              <button className="primary" onClick={push} disabled={pushing}>
                {pushing ? "Pushing…" : "Push to gear repo →"}
              </button>
              <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.target.checked)} />
                open a pull request
              </label>
              <span style={{ fontSize: 11, opacity: 0.6 }}>
                needs a connected gear repository (card at the top of Documents)
              </span>
            </>
          )}
          {pushErr && (
            <span className="error" style={{ fontSize: 12 }}>
              {pushErr}
            </span>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 12, minHeight: 300 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {scaffold.files.map((f, i) => (
              <button
                key={f.path}
                onClick={() => setActive(i)}
                style={{
                  textAlign: "left",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: i === active ? "var(--accent)" : "transparent",
                  cursor: "pointer",
                  fontSize: 11.5,
                  fontFamily: "ui-monospace, Menlo, monospace",
                }}
              >
                {f.path.replace(`gears/${scaffold.slug}/`, "")}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: 11, opacity: 0.7 }}>{file.path}</code>
              <button onClick={copy} style={{ marginLeft: "auto", fontSize: 11 }}>
                Copy
              </button>
            </div>
            <pre
              style={{
                margin: 0,
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface-raised)",
                fontSize: 12,
                lineHeight: 1.5,
                overflow: "auto",
                maxHeight: "50vh",
                whiteSpace: "pre",
              }}
            >
              {file.content}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComposePlanModal({
  plan,
  title,
  onScaffold,
  onClose,
}: {
  plan: PlanRow[];
  title: string;
  onScaffold: (capability: string) => void;
  onClose: () => void;
}) {
  const gaps = plan.filter((r) => r.gap).length;
  const matched = plan.length - gaps;
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={{ ...modalCard, width: "min(760px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Composition plan</span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>· {title}</span>
          <button onClick={onClose} style={{ marginLeft: "auto" }} aria-label="Close">
            ✕
          </button>
        </div>
        {plan.length === 0 ? (
          <p className="empty" style={{ fontSize: 13 }}>
            No capabilities found in this spec. Fill the questionnaire so it records capability tags
            in the front matter.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 14px" }}>
              {plan.length} capabilities · {matched} matched · {gaps} gap{gaps === 1 ? "" : "s"} to
              build. Candidates ranked by how well each component's catalog metadata matches.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {plan.map((r) => (
                <div key={r.capability} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: r.gap ? 0 : 8 }}>
                    <code style={{ fontSize: 12, fontWeight: 700 }}>{r.capability}</code>
                    {r.gap ? (
                      <>
                        <span style={gapBadge}>GAP</span>
                        <button
                          onClick={() => onScaffold(r.capability)}
                          style={{ marginLeft: "auto", fontSize: 11 }}
                          title="Generate a starter gear for this capability"
                        >
                          Scaffold gear →
                        </button>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, opacity: 0.6 }}>
                        {r.candidates.length} candidate{r.candidates.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {!r.gap && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {r.candidates.map((c) => (
                        <span key={c.name} title={`matched: ${c.why.join(", ")}`} style={{ ...composeChip, borderLeftColor: kindColor(c.kind) }}>
                          <span style={{ fontWeight: 600 }}>{shortName(c.name)}</span>
                          <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 10 }}>{c.kind}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, fontSize: 11, opacity: 0.6 }}>
              v1 heuristic match (name · description · keywords). Next: agent-driven matching and
              scaffolding gears for the gaps.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const composeChip: CSSProperties = {
  fontSize: 11.5,
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  borderLeftWidth: 3,
  background: "var(--surface-raised)",
  whiteSpace: "nowrap",
};
const gapBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 20,
  background: "var(--warning-soft)",
  color: "var(--warning)",
};

function Checklist({ report }: { report: DocValidation | null }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Checklist</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 20,
            background: report?.conforms ? "var(--success-soft)" : "var(--warning-soft)",
            color: report?.conforms ? "var(--success)" : "var(--warning)",
          }}
        >
          {report ? (report.conforms ? "conforms" : "incomplete") : "—"}
        </span>
      </div>
      {!report ? (
        <p className="empty" style={{ fontSize: 12 }}>
          Save to validate.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {report.sections.map((s) => (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ width: 14, color: s.ok ? "var(--success)" : s.required ? "var(--destructive)" : "var(--muted-foreground)" }}>
                  {s.ok ? "✓" : s.required ? "✕" : "○"}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                <span style={{ marginLeft: "auto", opacity: 0.6 }}>{s.word_count}w</span>
              </div>
            ))}
          </div>
          {report.issues.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: "var(--warning)" }}>Issues</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--muted-foreground)" }}>
                {report.issues.map((i, k) => (
                  <li key={k}>{i}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

type SectionRow = { title: string; required: boolean; minWords: number };

function TypesView({
  token,
  workspaceId,
  types,
  onSaved,
}: {
  token: string;
  workspaceId: string;
  types: DocType[];
  onSaved: () => Promise<void> | void;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [body, setBody] = useState("");
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [frontMatter, setFrontMatter] = useState("");
  const [minTitle, setMinTitle] = useState(1);
  const [forbid, setForbid] = useState(true);
  const [warn, setWarn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dirtyKey, setDirtyKey] = useState<string | null>(null);

  const load = (t: DocType) => {
    setDirtyKey(t.key);
    setKey(t.key);
    setName(t.name);
    setDesc(t.description);
    setBody(t.body);
    setSections(
      t.sections.map((s) => ({ title: s.title, required: s.required, minWords: s.min_words ?? 0 })),
    );
    setFrontMatter(t.rules.front_matter.join(", "));
    setMinTitle(t.rules.min_title_words);
    setForbid(t.rules.forbid_placeholders);
    setWarn(t.rules.warn_unknown_sections);
    setErr(null);
  };

  const blank = () => {
    setDirtyKey(null);
    setKey("");
    setName("");
    setDesc("");
    setBody("# <title>\n\n## Section\n");
    setSections([{ title: "Section", required: true, minWords: 0 }]);
    setFrontMatter("status");
    setMinTitle(1);
    setForbid(true);
    setWarn(false);
    setErr(null);
  };

  const setRow = (i: number, patch: Partial<SectionRow>) =>
    setSections((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (!key.trim() || !name.trim()) {
      setErr("Key and name are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const secs: DocSection[] = sections
        .filter((s) => s.title.trim())
        .map((s) => ({
          key: slug(s.title),
          title: s.title.trim(),
          required: s.required,
          min_words: s.minWords > 0 ? s.minWords : null,
        }));
      const rules: DocRules = {
        warn_unknown_sections: warn,
        front_matter: frontMatter.split(",").map((x) => x.trim()).filter(Boolean),
        forbid_placeholders: forbid,
        min_title_words: minTitle,
      };
      await api.upsertDocType(token, workspaceId, { key: key.trim(), name: name.trim(), description: desc, body, sections: secs, rules });
      await onSaved();
      setDirtyKey(key.trim());
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const definedSections = sections.filter((s) => s.title.trim());
  const requiredSections = definedSections.filter((s) => s.required);
  const frontKeys = frontMatter.split(",").map((x) => x.trim()).filter(Boolean);
  const hasMinWords = definedSections.some((s) => s.minWords > 0);
  const editing = dirtyKey !== null || sections.length > 0;

  return (
    <div className="dt-grid">
      <aside className="dt-list">
        <button className="dt-new" onClick={blank}>
          + New type
        </button>
        {types.map((t) => (
          <button
            key={t.key}
            className={`dt-type${dirtyKey === t.key ? " active" : ""}`}
            onClick={() => load(t)}
          >
            <span className="dt-type-name">{t.name}</span>
            <span className="dt-type-meta">
              <code>{t.key}</code>
              <span className={`dt-owner ${t.owner === "workspace" ? "ws" : "bi"}`}>{t.owner}</span>
            </span>
            <span className="dt-type-sub">
              {t.sections.length} section{t.sections.length === 1 ? "" : "s"}
              {t.rules.front_matter.length > 0 ? ` · ${t.rules.front_matter.length} front-matter` : ""}
            </span>
          </button>
        ))}
      </aside>

      <section className="dt-editor">
        {err && <div className="error">{err}</div>}
        {!editing ? (
          <div className="dt-empty">
            <div className="dt-empty-ic">▤</div>
            <p>Pick a type on the left to view or override it, or create a new one.</p>
            <p className="dt-hint">
              Saving always writes a <strong>workspace-owned</strong> type — overriding a built-in of
              the same key — and every project inherits it.
            </p>
          </div>
        ) : (
          <>
            <div className="dt-panel">
              <h3>
                <span className="dt-step">1</span> Identity
              </h3>
              <div className="dt-idrow">
                <label className="dt-field">
                  <span>Key (slug)</span>
                  <input placeholder="adr" value={key} onChange={(e) => setKey(e.target.value)} />
                </label>
                <label className="dt-field">
                  <span>Name</span>
                  <input
                    placeholder="Architecture Decision Record"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </div>
              <label className="dt-field">
                <span>Description</span>
                <input
                  placeholder="What this document is for…"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                />
              </label>
            </div>

            <div className="dt-panel">
              <h3>
                <span className="dt-step">2</span> Template
                <span className="dt-h-sub">the markdown skeleton a new document starts from</span>
              </h3>
              <textarea
                className="dt-template"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
              />
            </div>

            <div className="dt-panel">
              <h3>
                <span className="dt-step">3</span> Section checklist
                <span className="dt-h-sub">headings a conforming document must contain</span>
              </h3>
              <div className="dt-sec-head">
                <span>Section title</span>
                <span>Required</span>
                <span>Min words</span>
                <span />
              </div>
              {sections.map((s, i) => (
                <div key={i} className="dt-sec-row">
                  <input
                    placeholder="Section title"
                    value={s.title}
                    onChange={(e) => setRow(i, { title: e.target.value })}
                  />
                  <button
                    type="button"
                    className={`dt-toggle${s.required ? " on" : ""}`}
                    onClick={() => setRow(i, { required: !s.required })}
                  >
                    {s.required ? "required" : "optional"}
                  </button>
                  <input
                    type="number"
                    min={0}
                    title="minimum words (0 = no minimum)"
                    value={s.minWords}
                    onChange={(e) => setRow(i, { minWords: Number(e.target.value) || 0 })}
                  />
                  <button
                    type="button"
                    className="dt-del"
                    title="remove section"
                    onClick={() => setSections((r) => r.filter((_, k) => k !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="dt-add"
                onClick={() => setSections((r) => [...r, { title: "", required: false, minWords: 0 }])}
              >
                + Add section
              </button>
            </div>

            <div className="dt-panel">
              <h3>
                <span className="dt-step">4</span> Conformance rules
                <span className="dt-h-sub">what makes a document pass or fail</span>
              </h3>
              <label className="dt-field">
                <span>Required front-matter keys (comma-separated)</span>
                <input
                  placeholder="status, owner"
                  value={frontMatter}
                  onChange={(e) => setFrontMatter(e.target.value)}
                />
              </label>
              <div className="dt-rules">
                <label className="dt-field small">
                  <span>Min title words</span>
                  <input
                    type="number"
                    min={0}
                    value={minTitle}
                    onChange={(e) => setMinTitle(Number(e.target.value) || 0)}
                  />
                </label>
                <button
                  type="button"
                  className={`dt-toggle${forbid ? " on" : ""}`}
                  onClick={() => setForbid(!forbid)}
                >
                  {forbid ? "✓ " : ""}forbid placeholders
                </button>
                <button
                  type="button"
                  className={`dt-toggle${warn ? " on" : ""}`}
                  onClick={() => setWarn(!warn)}
                >
                  {warn ? "✓ " : ""}warn on unknown sections
                </button>
              </div>
            </div>

            <div className="dt-checks">
              <div className="dt-checks-h">In a project, a document of this type conforms when:</div>
              <ul>
                <li>
                  {requiredSections.length} required section{requiredSections.length === 1 ? "" : "s"}{" "}
                  present
                  {definedSections.length > requiredSections.length
                    ? ` (of ${definedSections.length} defined)`
                    : ""}
                </li>
                {hasMinWords && <li>each section meets its minimum length</li>}
                {frontKeys.length > 0 && <li>front-matter carries: {frontKeys.join(", ")}</li>}
                <li>
                  the title has at least {minTitle} word{minTitle === 1 ? "" : "s"}
                </li>
                {forbid && <li>{"no leftover template placeholders (TODO, TBD, <…>)"}</li>}
                {warn && <li>sections outside the checklist are flagged</li>}
              </ul>
            </div>

            <div className="dt-actions">
              <button className="dt-save" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save workspace type"}
              </button>
              <span className="dt-note">Saved as a workspace type — inherited by every project.</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ── styles for the workspace Document Types page ─────────────────────────────

const DOCTYPES_CSS = `
.doctypes {
  --dtb: var(--border);
  --dtsf: var(--card);
  --dtsf2: var(--muted);
  --dttx: var(--foreground);
  --dtmu: var(--muted-foreground);
  --dtac: var(--primary);
  --dtacs: var(--accent, rgba(59,130,246,.16));
  --dtok: var(--success);
  color: var(--dttx);
}
.doctypes .dt-head h2 { font-size: 18px; font-weight: 700; margin: 0 0 4px; letter-spacing: -.01em; }
.doctypes .dt-head p { margin: 0 0 14px; color: var(--dtmu); font-size: 13px; line-height: 1.5; max-width: 92ch; }

.doctypes .dt-flow { display: flex; align-items: stretch; flex-wrap: wrap; gap: 8px; padding: 12px; margin: 0 0 16px; border: 1px solid var(--dtb); border-radius: 12px; background: var(--dtsf2); }
.doctypes .dt-flow-step { display: flex; align-items: center; gap: 9px; padding: 8px 12px; background: var(--dtsf); border: 1px solid var(--dtb); border-radius: var(--radius-lg); min-width: 0; }
.doctypes .dt-flow-step.outcome { background: var(--dtacs); border-color: color-mix(in srgb, var(--dtac) 45%, transparent); }
.doctypes .dt-flow-n { width: 20px; height: 20px; flex: none; border-radius: 50%; background: var(--dtac); color: var(--primary-foreground); display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.doctypes .dt-flow-body { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
.doctypes .dt-flow-t { font-weight: 600; font-size: 12.5px; }
.doctypes .dt-flow-d { font-size: 10.5px; color: var(--dtmu); }
.doctypes .dt-flow-arrow { align-self: center; color: var(--dtmu); font-size: 15px; }
.doctypes .dt-flow-arrow.big { font-size: 18px; color: var(--dtac); }

.doctypes .dt-grid { display: grid; grid-template-columns: 250px minmax(0,1fr); gap: 16px; align-items: start; }
.doctypes .dt-list { display: flex; flex-direction: column; gap: 6px; }
.doctypes .dt-new { padding: 9px 12px; border-radius: var(--radius-lg); border: 0; cursor: pointer; background: var(--dtac); color: var(--primary-foreground); font: inherit; font-weight: 600; margin-bottom: 4px; }
.doctypes .dt-type { text-align: left; cursor: pointer; font: inherit; color: inherit; display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border: 1px solid var(--dtb); border-radius: var(--radius-lg); background: var(--dtsf); transition: border-color .12s, background .12s; }
.doctypes .dt-type:hover { border-color: var(--dtac); }
.doctypes .dt-type.active { border-color: var(--dtac); background: var(--dtacs); }
.doctypes .dt-type-name { font-weight: 600; font-size: 13px; }
.doctypes .dt-type-meta { display: flex; align-items: center; gap: 7px; }
.doctypes .dt-type-meta code { font-size: 11px; color: var(--dtmu); }
.doctypes .dt-owner { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: var(--radius-full); }
.doctypes .dt-owner.bi { background: var(--dtsf2); color: var(--dtmu); border: 1px solid var(--dtb); }
.doctypes .dt-owner.ws { background: var(--dtacs); color: var(--dtac); }
.doctypes .dt-type-sub { font-size: 10.5px; color: var(--dtmu); }

.doctypes .dt-editor { display: flex; flex-direction: column; gap: 12px; }
.doctypes .dt-empty { text-align: center; padding: 40px 20px; color: var(--dtmu); border: 1px dashed var(--dtb); border-radius: 12px; }
.doctypes .dt-empty-ic { font-size: 28px; opacity: .5; margin-bottom: 8px; }
.doctypes .dt-empty p { margin: 4px auto; font-size: 13px; max-width: 60ch; }
.doctypes .dt-hint, .doctypes .dt-note { font-size: 11.5px; color: var(--dtmu); }

.doctypes .dt-panel { border: 1px solid var(--dtb); border-radius: 12px; background: var(--dtsf); padding: 13px 15px; }
.doctypes .dt-panel h3 { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; margin: 0 0 11px; }
.doctypes .dt-step { width: 20px; height: 20px; flex: none; border-radius: var(--radius-md); background: var(--dtacs); color: var(--dtac); display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.doctypes .dt-h-sub { font-weight: 400; font-size: 11px; color: var(--dtmu); margin-left: auto; }

.doctypes .dt-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--dtmu); margin-bottom: 9px; }
.doctypes .dt-field:last-child { margin-bottom: 0; }
.doctypes .dt-field.small { flex-direction: row; align-items: center; gap: 8px; margin-bottom: 0; }
.doctypes .dt-idrow { display: grid; grid-template-columns: 160px 1fr; gap: 10px; }
.doctypes input, .doctypes textarea, .doctypes select { font: inherit; color: var(--dttx); background: var(--dtsf2); border: 1px solid var(--dtb); border-radius: 7px; padding: 6px 9px; font-size: 13px; }
.doctypes .dt-field input { width: 100%; }
.doctypes .dt-field.small input { width: 64px; }
.doctypes .dt-template { width: 100%; min-height: 200px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; resize: vertical; }

.doctypes .dt-sec-head, .doctypes .dt-sec-row { display: grid; grid-template-columns: 1fr 110px 90px 30px; gap: 8px; align-items: center; }
.doctypes .dt-sec-head { font-size: 10.5px; color: var(--dtmu); text-transform: uppercase; letter-spacing: .03em; padding: 0 2px 6px; }
.doctypes .dt-sec-row { margin-bottom: 6px; }
.doctypes .dt-sec-row input[type=number] { width: 100%; }
.doctypes .dt-toggle { font: inherit; font-size: 11.5px; cursor: pointer; padding: 6px 10px; border-radius: var(--radius-full); border: 1px solid var(--dtb); background: var(--dtsf2); color: var(--dtmu); }
.doctypes .dt-toggle.on { background: var(--dtacs); color: var(--dtac); border-color: color-mix(in srgb, var(--dtac) 45%, transparent); font-weight: 600; }
.doctypes .dt-del { font: inherit; cursor: pointer; border: 1px solid var(--dtb); background: var(--dtsf2); color: var(--dtmu); border-radius: 7px; width: 30px; height: 30px; }
.doctypes .dt-del:hover { color: var(--dtac); border-color: var(--dtac); }
.doctypes .dt-add { margin-top: 8px; font: inherit; font-size: 12px; cursor: pointer; background: none; border: 1px dashed var(--dtb); color: var(--dtmu); border-radius: var(--radius-lg); padding: 6px 12px; }
.doctypes .dt-add:hover { border-color: var(--dtac); color: var(--dtac); }
.doctypes .dt-rules { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }

.doctypes .dt-checks { border: 1px solid color-mix(in srgb, var(--dtok) 40%, var(--dtb)); background: color-mix(in srgb, var(--dtok) 8%, var(--dtsf)); border-radius: 12px; padding: 12px 15px; }
.doctypes .dt-checks-h { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.doctypes .dt-checks ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.doctypes .dt-checks li { font-size: 12px; color: var(--dttx); }
.doctypes .dt-checks li::marker { color: var(--dtok); }

.doctypes .dt-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.doctypes .dt-save { font: inherit; font-weight: 600; cursor: pointer; background: var(--dtac); color: var(--primary-foreground); border: 0; border-radius: var(--radius-lg); padding: 9px 16px; }
.doctypes .dt-save:disabled { opacity: .6; cursor: default; }

@media (max-width: 720px) { .doctypes .dt-grid { grid-template-columns: 1fr; } }
`;
