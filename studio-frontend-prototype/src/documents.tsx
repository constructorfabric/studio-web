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
  type ReactNode,
} from "react";

import {
  api,
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
  ScaffoldFile,
  SpecFinding,
  StageStatus,
  WrittenFile,
} from "./api";
import {
  collectBatch,
  interpretBloat,
  interpretDocType,
  interpretLeak,
  interpretTrace,
  isDetectorCancel,
  MIN_SPEC_SHARE,
  useSpecQualityCapabilities,
} from "./spec-quality";
import { useStudioBridge, type StudioTarget } from "./studio-bridge";
import { errText, relTime } from "./format";
import { Modal } from "./modal";
import { composePlan, profilesByName, type PlanRow } from "./compose";
import { gearSlug } from "./scaffold";
import { Tile, TileGrid, ViewToggle, useViewMode } from "./view-mode";
import {
  inFilter,
  specCounts,
  specRows,
  type SpecCandidate,
  type SpecFilter,
} from "./spec-rows";

const STATUSES: Doc["status"][] = ["draft", "review", "approved"];
const card = { border: "1px solid var(--border)", borderRadius: 10, padding: 12 } as const;
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "section";

/** Project-level: what the project's repository actually contains.
 *
 *  Authoring lives HERE, not at the workspace. It used to sit beside the type
 *  catalogue, on the reasoning that a type is workspace property and so is a
 *  document written from one before a project claims it. In practice nobody
 *  wrote one: a document is something a project needs, and a workspace-level
 *  draft belonging to no project is a state with no reader. The types stay
 *  workspace property; the writing moved to where the writing happens.
 *
 *  So this tab has three views of one subject. A document can reach a project
 *  two ways — written from a type here, or found in the repository by a scan —
 *  and the third view is the detector run that judges either. */
type DocView = "specs" | "authored" | "analysis";

export function DocumentsTab({
  token,
  workspaceId,
  projectTenantId,
  onOpenFile,
  analysis,
  studioTarget,
}: {
  token: string;
  /** The parent workspace tenant — the storage scope for documents and types. */
  workspaceId: string;
  /** The open project tenant. */
  projectTenantId: string;
  /** Open one document where documents are edited: the project's IDE, at that
   *  file. The path is repo-relative, which is what the IDE's opener wants. */
  onOpenFile: (path: string) => void;
  /** The detector console, which used to be a section of its own called
   *  Findings. It is a VIEW here rather than a second section: a detector run
   *  is something you do to the documents in this list, and its output is the
   *  Status column beside them. */
  analysis?: ReactNode;
  /** The project an "Edit in Studio" hand-off launches the IDE against. */
  studioTarget?: StudioTarget;
}) {
  const [types, setTypes] = useState<DocType[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<DocView>("specs");
  /** An authored document the list asked the editor to open. Held here because
   *  the list and the editor are siblings: the list knows which row was
   *  clicked, the editor knows what to do about it. */
  const [openDoc, setOpenDoc] = useState<string | null>(null);

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
      {/* One list, not two. "In the repository" and "Authored" split the specs
          by where their bytes live, which is our implementation detail, and it
          made the question a reader actually has — what specs do we have, and
          are they any good — answerable only by reading both and merging them
          by eye. The Origin column keeps the difference visible where it
          belongs: on the row. What is left beside the list is the EDITOR, a
          place rather than a second inventory. */}
      <div className="doc-views" role="tablist" aria-label="Specs view">
        <button
          role="tab"
          aria-selected={view === "specs"}
          className={view === "specs" ? "doc-view on" : "doc-view"}
          onClick={() => setView("specs")}
        >
          Specs
        </button>
        <button
          role="tab"
          aria-selected={view === "authored"}
          className={view === "authored" ? "doc-view on" : "doc-view"}
          onClick={() => setView("authored")}
        >
          Editor
        </button>
        {analysis && (
          <button
            role="tab"
            aria-selected={view === "analysis"}
            className={view === "analysis" ? "doc-view on" : "doc-view"}
            onClick={() => setView("analysis")}
          >
            Analysis
          </button>
        )}
      </div>
      {/* All of them stay mounted. The console holds a detector run in progress
          and the results of the last one, and the editor holds an unsaved
          draft — unmounting either to glance at a list would throw that away. */}
      <div hidden={view !== "specs"}>
        <IngestedDocumentsView
          token={token}
          workspaceId={workspaceId}
          projectTenantId={projectTenantId}
          types={types}
          onOpenFile={onOpenFile}
          onOpenDoc={(id) => {
            setOpenDoc(id);
            setView("authored");
          }}
          onWriteDoc={() => {
            setOpenDoc(null);
            setView("authored");
          }}
        />
      </div>
      <div hidden={view !== "authored"}>
        <DocumentsView
          token={token}
          workspaceId={workspaceId}
          projectTenantId={projectTenantId}
          types={types}
          studioTarget={studioTarget}
          openDocId={openDoc}
        />
      </div>
      {analysis && <div hidden={view !== "analysis"}>{analysis}</div>}
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
  projectTenantId,
  types,
  studioTarget,
  openDocId,
}: {
  token: string;
  workspaceId: string;
  /** The project these documents belong to. Documents are authored INSIDE a
   *  project — the workspace owns the types, the project owns the writing —
   *  so this is where both the listing and the creation are scoped.
   *
   *  The project listing is the effective one: a project's own documents plus
   *  the ones inherited from its workspace. Nothing that was written at the
   *  workspace level becomes unreachable by scoping here. */
  projectTenantId: string;
  types: DocType[];
  studioTarget?: StudioTarget;
  /** A document the Specs list asked to open. Selecting it here rather than
   *  keeping a second list means one inventory and one editor, which is the
   *  whole point of merging the two tabs. */
  openDocId?: string | null;
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
  /** The capability a gap flow asked for a gear for. The skeleton itself is
   *  the server's to compose, so this holds the question, not the answer. */
  const [scaffold, setScaffold] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<Doc | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const newTypeObj = useMemo(() => types.find((t) => t.key === newType) ?? null, [types, newType]);
  const hasQuestionnaire = (newTypeObj?.questionnaire?.length ?? 0) > 0;

  const selected = useMemo(() => docs.find((d) => d.id === selectedId) ?? null, [docs, selectedId]);

  // The list asked for one. Honoured on every change of `openDocId`, not only
  // the first: clicking two rows in a row must open the second.
  useEffect(() => {
    if (openDocId) setSelectedId(openDocId);
  }, [openDocId]);
  const editable = !!selected && !selected.inherited;

  /* ── Editing in the IDE ──
     The same document, opened in Studio's markdown editor instead of the
     textarea below. One gesture: the portal reuses or launches the workspace's
     session, mounts its space and hands the document over (see
     ./studio-bridge). The IDE reads and writes it straight through the
     documents gear over a `studio-doc:` URI, so there is no copy to reconcile
     — only a reload here once it reports the write back.

     This is the authoring surface: a project's Documents tab reports what its
     repository contains, and a document gets there by being published into it.
     Before it is published there is no file to open, which is exactly why the
     IDE needed a way to address the row itself. */
  const studio = useStudioBridge();
  const opening = !!studioTarget && studio?.opening === studioTarget.id;
  const dirty =
    !!selected && (draftTitle !== selected.title || draftBody !== selected.content);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** Set when the IDE saved the document currently open here while this view
   *  held unsaved edits — reloading is then the user's call, not ours. */
  const [staleDoc, setStaleDoc] = useState<string | null>(null);
  const handledSaveRef = useRef(0);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      setDocs((await api.projectDocuments(token, workspaceId, projectTenantId)).items);
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, workspaceId, projectTenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (types.length > 0 && !newType) setNewType(types[0].key);
  }, [types, newType]);

  // The IDE wrote a document back through the gear: re-read it so the list,
  // the status and the conformance checklist reflect what was just saved.
  // Keyed on the report's timestamp, not on `docs`, so the reload it triggers
  // cannot re-trigger itself.
  useEffect(() => {
    const saved = studio?.savedDocument;
    if (!saved || saved.at === handledSaveRef.current) return;
    if (saved.workspaceId !== workspaceId) return;
    handledSaveRef.current = saved.at;
    if (saved.documentId === selectedId && dirtyRef.current) {
      setStaleDoc(saved.documentId); // local draft would be overwritten
      return;
    }
    void reload();
  }, [studio?.savedDocument, workspaceId, selectedId, reload]);

  // A different document is a different conversation — drop the stale banner.
  useEffect(() => setStaleDoc(null), [selectedId]);

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
      const doc = await api.createProjectDocument(token, workspaceId, projectTenantId, body);
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
      const profiles = profilesByName(profs.nodes ?? []);
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
                {staleDoc === selected.id && (
                  <div className="hint" style={{ ...card, display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ flex: 1 }}>
                      Saved in Studio while you had unsaved changes here. Reloading takes the
                      IDE&rsquo;s version and drops the draft below.
                    </span>
                    <button
                      onClick={() => {
                        setStaleDoc(null);
                        void reload();
                      }}
                      disabled={busy}
                    >
                      Reload
                    </button>
                  </div>
                )}
                <textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  disabled={!editable}
                  spellCheck={false}
                  style={{ width: "100%", minHeight: 420, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.5, padding: 10, borderRadius: 8, border: "1px solid var(--border)", resize: "vertical" }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {studio && studioTarget && (
                    <button
                      className="primary"
                      onClick={async () => {
                        // Hand over what is on screen, not what was last
                        // saved: the IDE reads the row from the gear, so an
                        // unsaved draft here would simply not be there.
                        if (dirty) await save();
                        void studio.openDocument(studioTarget, {
                          workspaceId,
                          id: selected.id,
                          title: selected.title,
                        });
                      }}
                      disabled={!editable || opening || busy}
                      title={
                        editable
                          ? "Edit this document in Studio's markdown editor — it opens in a session you already have running, or starts one"
                          : "Inherited from the workspace — edit it where it is defined"
                      }
                    >
                      {opening
                        ? "Opening Studio…"
                        : studio.isOpen(studioTarget.id)
                          ? "Edit in Studio"
                          : "Edit in Studio →"}
                    </button>
                  )}
                  {/* Still here, and still the only editor when no session can
                      be opened. It stays a plain button next to the hand-off so
                      the IDE is the obvious place to write, not the exception. */}
                  <button
                    className={studio && studioTarget ? "" : "primary"}
                    onClick={save}
                    disabled={!editable || busy}
                  >
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
          onScaffold={(cap) => setScaffold(cap)}
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
          capability={scaffold}
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

/** Page size when walking the artifact graph's file nodes. The server clamps
 *  this to 200, so it is the fewest round trips the walk can take. */
const NODE_PAGE = 200;

/** How many rows are put in the DOM at once.
 *
 *  A synced repository is thousands of files and every row is a dozen elements,
 *  so rendering the whole list costs tens of thousands of nodes for a screen
 *  that shows twenty. The rows all exist in memory — the counts on the chips
 *  are over the full list and stay exact — this only bounds what is mounted,
 *  and the footer says what is being held back rather than letting the list
 *  end silently on a lie. */
const RENDER_PAGE = 200;

/** Whether an ingested node is a file this tab should list.
 *
 *  Every file, not a guessed subset. What is and is not a document is the
 *  analysis's answer, and it has one — `not_a_document` is a state a binding
 *  can hold and a queue this list already shows. Deciding it here by extension
 *  would be this tab guessing ahead of the detector, and guessing wrong
 *  silently: a spec named `DESIGN` with no extension would never appear, and
 *  nothing would say why.
 *
 *  So: directories out, everything else in, and the scan sorts them afterwards.
 */
function isFileCandidate(value: Record<string, unknown>): boolean {
  if (value.is_dir === true) return false;
  return typeof value.path === "string" && value.path.length > 0;
}

/** Only these need a person: everything else is either settled or not a doc. */

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

/** The tone for a state, including one this build has never heard of.
 *
 *  `DocBindingState` is transcribed by hand from a sentence in the backend's
 *  OpenAPI description — the field is typed `string` there, with the five
 *  values written in prose — so a sixth state compiles fine here and arrives
 *  at runtime. Read straight, `STATE_TONE[state].bg` then throws and takes the
 *  panel with it. Neutral is the right answer to a state we cannot interpret,
 *  and it is what `findingTone` next door already does. */
export const stateTone = (state: string) =>
  STATE_TONE[state as DocBindingState] ?? { bg: "var(--muted)", fg: "var(--muted-foreground)" };

/** Its label, likewise. An unrecognised state shows its own wire value rather
 *  than nothing: a reader can then say what the screen could not. */
export const stateLabel = (state: string) => STATE_LABEL[state as DocBindingState] ?? state;

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

/** What the Status column says: how many findings are open on this document.
 *
 *  Counted, not listed. The old column printed one chip per detector, which
 *  made the row as tall as the document's worst day and told the reader four
 *  detector names they cannot act on from a list. The names are one click
 *  away, in the panel beside it. */
function findingLabel(found: SpecFinding[] | undefined): string {
  const n = found?.length ?? 0;
  if (n === 0) return "No findings";
  return `${n} finding${n === 1 ? "" : "s"}`;
}

/** The dot beside that count. Findings outrank conformance: a document can
 *  satisfy its template exactly and still be the one with an unresolved
 *  placeholder in it, and that is the more useful thing to colour for. */
function findingDotTone(found: SpecFinding[] | undefined, conforms?: boolean | null): string {
  if (found?.length) {
    const worst = found.some((f) => f.severity === "high" || f.severity === "gate-failed");
    return worst ? "var(--destructive)" : "var(--warning)";
  }
  if (conforms === false) return "var(--warning)";
  if (conforms === true) return "var(--success)";
  return "var(--muted-foreground)";
}


/** The files Studio pulled out of the repository, and what we think each is. */
function IngestedDocumentsView({
  token,
  workspaceId,
  projectTenantId,
  types,
  onOpenFile,
  onOpenDoc,
  onWriteDoc,
}: {
  token: string;
  workspaceId: string;
  projectTenantId: string;
  types: DocType[];
  /** Editing a document is the IDE's job — this hands it the file. */
  onOpenFile: (path: string) => void;
  /** An authored row was clicked. The editor is where such a document is read
   *  and written; this list is an inventory, not a second editor. */
  onOpenDoc: (id: string) => void;
  /** Hand over to the editor with nothing open — the "write the first one"
   *  route out of the empty state. */
  onWriteDoc: () => void;
}) {
  const [bindings, setBindings] = useState<DocBinding[]>([]);
  const [filter, setFilter] = useState<SpecFilter>("needs-review");
  /** "any" = both origins. Kept apart from the queue filter because they ask
   *  different questions: one is "what state is it in", the other "where did
   *  it come from". */
  const [originFilter, setOriginFilter] = useState<"any" | "repository" | "authored">("any");
  /** "" = every type, "-" = the ones with no type yet. */
  const [typeFilter, setTypeFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** Detector verdicts read back from the graph, keyed by document node id. */
  const [findings, setFindings] = useState<Record<string, SpecFinding[]>>({});
  /** Which repository each document came from, keyed by its graph node id.
   *
   *  Read from the file nodes rather than inferred from the path: a binding
   *  carries a repo-RELATIVE path and nothing else, so two repositories with a
   *  `docs/prd.md` each are indistinguishable by path alone. The node knows,
   *  because ingest wrote `value.repo` when it pulled the file. This listing is
   *  metadata only — it never asks for the text — so it costs a page walk, not
   *  a clone. */
  const [repoByNode, setRepoByNode] = useState<Record<string, string>>({});
  /** What each repository is called, keyed by its node id.
   *
   *  A file node carries only the repo's instance id — a v5 UUID over
   *  (scope, connector, path) — which identifies the repository perfectly and
   *  tells a reader nothing. The repo node itself holds `full_path`, so one
   *  extra listing turns the column from an id into "owner/name". A repository
   *  missing from the map keeps its id: unnamed provenance still beats none. */
  const [repoNames, setRepoNames] = useState<Record<string, string>>({});
  const [view, setView] = useViewMode("specs.view");
  /** The documents written here. Read alongside the bindings so both origins
   *  land in one list; failing separately, because losing one must not empty
   *  the other. */
  const [authored, setAuthored] = useState<Doc[]>([]);
  /** Ingested prose nothing has classified yet — the list before a scan. */
  const [candidates, setCandidates] = useState<SpecCandidate[]>([]);
  /** Where the project stands against its workspace's journey. */
  const [stages, setStages] = useState<StageStatus[]>([]);
  /** The types a stage wants and the project has no document for. */
  const [seeding, setSeeding] = useState<string[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const typeName = useCallback(
    (key?: string | null) => (key ? (types.find((t) => t.key === key)?.name ?? key) : "—"),
    [types],
  );

  /** Walk the ingested file nodes ONCE, and answer both questions about them.
   *
   *  This used to be two walks of the same collection, a few lines apart in the
   *  same reload — one collecting classification candidates, one collecting
   *  which repository each node came from. Same endpoint, same page size, same
   *  pages: on a project with 5,785 files that was 58 requests to read 29
   *  pages, and every node's payload arrived twice.
   *
   *  Metadata only — no text is asked for and no checkout has to exist, which
   *  is the whole point: this answers "what is in there" the moment a sync has
   *  run, while reading the content still needs a clone the backend can see.
   *
   *  The two results now fail together, where they used to have a `catch`
   *  each. That is not a loss: they were always one request sequence, so a
   *  failure of one was a failure of the other, and the separate handlers only
   *  made them look independent.
   */
  const readFiles = useCallback(async (): Promise<{
    candidates: SpecCandidate[];
    repoByNode: Record<string, string>;
  }> => {
    const candidates: SpecCandidate[] = [];
    const repoByNode: Record<string, string> = {};
    let cursor: string | undefined;
    do {
      const page = await api.listArtifactNodes(token, "file", projectTenantId, cursor, NODE_PAGE);
      for (const n of page.nodes ?? []) {
        // Provenance is wanted for every file, candidate or not: the Specs
        // table shows the repository beside a bound document too.
        if (typeof n.value.repo === "string") repoByNode[n.instance_id] = n.value.repo;
        if (!isFileCandidate(n.value)) continue;
        const path = typeof n.value.path === "string" ? n.value.path : "";
        if (path) candidates.push({ nodeId: n.instance_id, path });
      }
      cursor = page.next_cursor;
    } while (cursor);
    return { candidates, repoByNode };
  }, [token, projectTenantId]);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      setBindings((await api.docBindings(token, workspaceId, projectTenantId)).items);
    } catch (e) {
      setErr(errText(e));
    }
    try {
      setAuthored((await api.projectDocuments(token, workspaceId, projectTenantId)).items);
    } catch {
      // The list still holds what the repository has. An authored document
      // missing from it is a gap; an empty screen would be a bigger one.
    }
    // Findings are their own nodes in the graph and outlive this tab, the
    // session and the detector run that produced them. A failure to read them
    // must not cost the queue itself: the bindings above are the point, the
    // verdicts are what is known about them so far.
    // The journey is computed from the documents, so it is re-read whenever
    // they are. A workspace that has defined no stages simply has nothing to
    // say, which the panel renders as nothing at all.
    try {
      setStages((await api.projectStageStatus(token, workspaceId, projectTenantId)).items);
    } catch {
      setStages([]);
    }
    try {
      const found = await api.listSpecFindings(token, projectTenantId);
      const byNode: Record<string, SpecFinding[]> = {};
      for (const f of found) (byNode[f.subject] ??= []).push(f);
      for (const list of Object.values(byNode)) list.sort((a, b) => a.detector.localeCompare(b.detector));
      setFindings(byNode);
    } catch {
      // Leave whatever was already read; the column simply shows nothing.
    }
    // The names behind the repository ids `readFiles` collects. Its own
    // listing — `repo` nodes, not `file` ones — so it neither waits for that
    // walk nor repeats it, and it is allowed to fail separately: losing the
    // names must leave the ids on screen, not blank the column.
    try {
      const names: Record<string, string> = {};
      let cursor: string | undefined;
      do {
        const page = await api.listArtifactNodes(token, "repo", projectTenantId, cursor, 200);
        for (const n of page.nodes) {
          const label = n.value.full_path ?? n.value.name;
          if (typeof label === "string" && label) names[n.instance_id] = label;
        }
        cursor = page.next_cursor;
      } while (cursor);
      setRepoNames(names);
    } catch {
      // Ids stay on screen.
    }
  }, [token, workspaceId, projectTenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** The file walk, kept off `reload`.
   *
   *  `readFiles` pages the whole file listing, and the server caps a page at
   *  200 — so a repository of six thousand files is thirty round trips even
   *  after #302 merged the two walks into one. `reload` runs after every
   *  decision, every detector pass and every commit, which made changing one
   *  dropdown cost thirty requests about files that had not moved.
   *
   *  What it answers only changes when a SYNC runs, and that is another tab:
   *  within this one a file leaves the list by gaining a binding, and
   *  `specRows` drops it from what is already in memory, while a file's
   *  repository never changes at all. So: once per project.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const files = await readFiles();
        if (!alive) return;
        setCandidates(files.candidates);
        setRepoByNode(files.repoByNode);
      } catch {
        // Candidates are a head start, not the record, and the repository is
        // provenance rather than identity. The bindings are the queue that
        // matters, and losing either of these must not cost them.
      }
    })();
    return () => {
      alive = false;
    };
  }, [readFiles]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /** Read the queue again, files and all.
   *
   *  What this screen shows is the sync's work, and the sync runs elsewhere --
   *  in the Sources tab, or on a push nobody here saw. There used to be a
   *  button that pulled every file's text through the browser to feed the
   *  detectors; the detectors read for themselves now, so the one thing left
   *  worth offering is the thing a person wants right after a sync: look
   *  again.
   *
   *  It re-walks the file listing, which `reload` deliberately does not -- a
   *  sync is exactly the event that changes what that walk would answer. */
  const recheck = async () => {
    setBusy(true);
    setErr(null);
    setNote("");
    setProgress("Looking again…");
    try {
      await reload();
      const files = await readFiles();
      setCandidates(files.candidates);
      setRepoByNode(files.repoByNode);
      setNote(
        files.candidates.length === 0
          ? "Nothing new. Every file the sync pulled in already has a verdict."
          : `${files.candidates.length} file${files.candidates.length === 1 ? "" : "s"} ` +
            "the sync has not placed yet.",
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
      (b) => b.state === "unknown" && !analysed(b),
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
      // One run for the whole set: the backend reads each document off the
      // checkout, submits it and waits for its verdict, and this follows that
      // run. What a verdict MEANS is still decided here — see the two checks
      // below — and so is which documents were worth asking about.
      setProgress(`Spec Quality · asking about ${targets.length} document(s)…`);
      const run = await api.analyzeProjectDocuments(
        token,
        workspaceId,
        projectTenantId,
        "purpose",
        targets.map((b) => b.id),
      );
      const collected = await collectBatch(token, run.run_id, {
        onProgress: (phase) => {
          // The run reports `3/20 · <path>`; the person wants the name.
          const [count, path] = phase.split(" · ");
          setProgress(`Spec Quality ${count}${path ? ` · ${basename(path)}` : ""}`);
        },
        signal: ctrl.signal,
      });

      for (const b of targets) {
        const got = collected.get(b.path);
        if (!got) continue;
        if ("error" in got) {
          // One document the sweep could not analyse is not a failed run: the
          // others have verdicts, and this one is simply still unplaced.
          declined += 1;
          continue;
        }
        const { docType, specShare, gatePassed, taskId } = interpretDocType(
          got.result,
          got.taskId,
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

  /** Check the bound documents for content belonging to another kind.
   *
   *  This runs here rather than in the Analyze tab for a reason the service
   *  itself enforces: `leak` refuses a document whose type it has not been
   *  told, because "foreign content" means nothing until you have said what
   *  native content would be. A bound document has a type; nothing is guessed.
   *
   *  As with the purpose run, the verdict goes two places — the finding to the
   *  graph, the pass/fail to the binding, which is what a stage gating on
   *  `leak` waits for. */
  const runLeakChecks = async () => {
    const already = (b: DocBinding) =>
      (findings[b.node_id] ?? []).some((f) => f.detector === "leak");
    const targets = bindings.filter((b) => b.type_key && !already(b));
    const alreadyDone = bindings.filter((b) => b.type_key && already(b)).length;

    if (targets.length === 0) {
      setNote(
        alreadyDone > 0
          ? `Nothing left to check — leak has already looked at ${alreadyDone}.`
          : "No document has a type yet, and leak cannot run without one.",
      );
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setErr(null);
    setNote("");
    let clean = 0;
    let leaky = 0;
    try {
      // The server reads the documents. This names which ones, because which
      // documents deserve a detector is a decision and only the reading moved.
      setProgress(`Leak · asking about ${targets.length} document(s)…`);
      const run = await api.analyzeProjectDocuments(
        token,
        workspaceId,
        projectTenantId,
        "leak",
        targets.map((b) => b.id),
      );
      const collected = await collectBatch(token, run.run_id, {
        onProgress: (phase) => setProgress(`Leak · ${phase}`),
        signal: ctrl.signal,
      });

      for (const b of targets) {
        const got = collected.get(b.path);
        if (!got || "error" in got) continue;
        const { passed, leakShare, foreignRoles, taskId } = interpretLeak(got.result, got.taskId);
        if (passed === true) clean += 1;
        else if (passed === false) leaky += 1;

        const share = leakShare == null ? "" : ` (${Math.round(leakShare * 100)}% foreign)`;
        const summary =
          passed === true
            ? `leak: clean${share}`
            : passed === false
              ? `leak: reads partly as ${foreignRoles.join(", ") || "another kind"}${share}`
              : "leak: no verdict";

        void api
          .saveQualityFindings(token, {
            findings: [
              {
                detector: "leak",
                subject: b.node_id,
                path: b.path,
                severity:
                  passed === true ? "clean" : passed === false ? "high" : "analyzed",
                summary,
                score: leakShare ?? undefined,
              },
            ],
            workspace_id: workspaceId,
            project_id: projectTenantId,
          })
          .catch(() => {
            // The run the person is watching matters more than its trace.
          });

        void api
          .recordBindingAnalysis(token, workspaceId, b.id, "leak", {
            state: passed === true ? "passed" : passed === false ? "failed" : "pending",
            task_id: taskId,
            summary,
          })
          .catch(() => {
            // Same.
          });
      }
      await reload();
      setNote(
        `Checked ${targets.length} document${targets.length === 1 ? "" : "s"}: ` +
          `${clean} clean, ${leaky} carrying another kind's content` +
          (alreadyDone ? `; ${alreadyDone} had been checked before` : "") +
          ".",
      );
    } catch (e) {
      if (isDetectorCancel(e)) setNote(`Stopped after ${clean + leaky}.`);
      else setErr(errText(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress("");
    }
  };

  /** Trace how the bound documents reference each other — the fourth detector.
   *
   *  The page ran three of the service's four. Traceability was reachable only
   *  from the Analysis console, which meant the one question it answers —
   *  "which of these documents is connected to the rest, and which is an
   *  island" — was not askable from the list where the documents are.
   *
   *  `extract` mode: it builds the graph from the ids already written in the
   *  text and spends no model call. `classify` asks an LLM to judge drift, and
   *  a button on a list page should not quietly cost tokens.
   *
   *  Set-wise, like bloat, and for the same reason: "what does this reference"
   *  has no answer from one document. */
  const runTraceCheck = async () => {
    const targets = bindings.filter((b) => b.type_key);
    if (targets.length < 2) {
      setNote(
        targets.length === 1
          ? "Tracing is a question about two documents; this project has one."
          : "No bound documents with text to trace. Run Scan first.",
      );
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setErr(null);
    setNote("");
    setProgress(`Tracing references across ${targets.length} documents…`);
    try {
      // One analysis over the whole set — the server reads it — and the set is
      // one item, because "which of these references which" has no answer for
      // a document on its own.
      const run = await api.analyzeProjectDocuments(
        token,
        workspaceId,
        projectTenantId,
        "traceability",
        targets.map((b) => b.id),
      );
      const collected = await collectBatch(token, run.run_id, {
        onProgress: (phase) => setProgress(`Traceability · ${phase}`),
        signal: ctrl.signal,
      });
      const whole = [...collected.values()][0];
      if (!whole || "error" in whole) {
        setErr(whole && "error" in whole ? whole.error : "the traceability run reported nothing");
        return;
      }
      const { byPath, recognised, taskId } = interpretTrace(
        whole.result,
        whole.taskId,
        targets.map((b) => b.path),
      );

      // The service does not document this response, so an unreadable shape
      // must not be reported as "nothing references anything" — that reads as
      // a fact about the documents when it is a fact about this reader.
      if (!recognised) {
        setNote(
          "The traceability run finished, but its result carried no edge list this build " +
            "recognises — so nothing was recorded. The raw result is on the Analysis view.",
        );
        return;
      }

      let connected = 0;
      for (const b of targets) {
        const refs = byPath[b.path] ?? [];
        if (refs.length > 0) connected += 1;
        const summary =
          refs.length === 0
            ? "traceability: references no other document in this set"
            : `traceability: references ${refs.map(basename).join(", ")}`;

        void api
          .saveQualityFindings(token, {
            findings: [
              {
                detector: "traceability",
                subject: b.node_id,
                path: b.path,
                // An unreferenced document is worth noticing, not failing:
                // a glossary that cites nothing is doing its job.
                severity: refs.length === 0 ? "some" : "clean",
                summary,
                score: refs.length,
              },
            ],
            workspace_id: workspaceId,
            project_id: projectTenantId,
          })
          .catch(() => {});

        void api
          .recordBindingAnalysis(token, workspaceId, b.id, "traceability", {
            state: "passed",
            task_id: taskId,
            summary,
          })
          .catch(() => {});
      }

      await reload();
      setNote(
        `Traced ${targets.length} documents: ${connected} reference at least one other, ` +
          `${targets.length - connected} reference none.`,
      );
    } catch (e) {
      if (isDetectorCancel(e)) setNote("Stopped.");
      else setErr(errText(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress("");
    }
  };

  /** Find the documents that repeat each other.
   *
   *  One run over the whole set, because that is the only way the question
   *  makes sense — "does this document say what another one already says" has
   *  no answer from one document. The per-document verdict falls out of which
   *  files each duplicate cluster names.
   *
   *  Unlike the other two runs this one cannot skip what it has already seen:
   *  a verdict about a set goes stale the moment the set changes, so adding one
   *  document re-judges all of them. */
  const runBloatCheck = async () => {
    const targets = bindings.filter((b) => b.type_key);
    if (targets.length < 2) {
      setNote(
        targets.length === 1
          ? "Duplication is a question about two documents; this project has one."
          : "No bound documents with text to compare. Run Scan first.",
      );
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setErr(null);
    setNote("");
    setProgress(`Comparing ${targets.length} documents…`);
    try {
      // Same shape as traceability, and for the same reason: "does this repeat
      // another" is a question about a set.
      const run = await api.analyzeProjectDocuments(
        token,
        workspaceId,
        projectTenantId,
        "bloat",
        targets.map((b) => b.id),
      );
      const collected = await collectBatch(token, run.run_id, {
        onProgress: (phase) => setProgress(`Duplication · ${phase}`),
        signal: ctrl.signal,
      });
      const whole = [...collected.values()][0];
      if (!whole || "error" in whole) {
        setErr(whole && "error" in whole ? whole.error : "the duplication run reported nothing");
        return;
      }
      const { byPath, pairs, taskId } = interpretBloat(
        whole.result,
        whole.taskId,
        targets.map((b) => b.path),
      );

      let repeating = 0;
      for (const b of targets) {
        const others = byPath[b.path] ?? [];
        const clean = others.length === 0;
        if (!clean) repeating += 1;
        const summary = clean
          ? "bloat: nothing repeated elsewhere"
          : `bloat: repeats ${others.map(basename).join(", ")}`;

        void api
          .saveQualityFindings(token, {
            findings: [
              {
                detector: "bloat",
                subject: b.node_id,
                path: b.path,
                severity: clean ? "clean" : "high",
                summary,
                score: others.length,
              },
            ],
            workspace_id: workspaceId,
            project_id: projectTenantId,
          })
          .catch(() => {});

        void api
          .recordBindingAnalysis(token, workspaceId, b.id, "bloat", {
            state: clean ? "passed" : "failed",
            task_id: taskId,
            summary,
          })
          .catch(() => {});
      }

      // The relation itself, for the graph: which document repeats which.
      const nodeOf = new Map(targets.map((b) => [b.path, b.node_id]));
      const duplicates = pairs
        .map(([a, b]) => ({ from: nodeOf.get(a) ?? "", to: nodeOf.get(b) ?? "" }))
        .filter((d) => d.from && d.to);
      if (duplicates.length > 0) {
        void api
          .saveQualityFindings(token, {
            duplicates,
            workspace_id: workspaceId,
            project_id: projectTenantId,
          })
          .catch(() => {});
      }

      await reload();
      setNote(
        `Compared ${targets.length} documents: ${targets.length - repeating} repeat nothing, ` +
          `${repeating} share text with another.`,
      );
    } catch (e) {
      if (isDetectorCancel(e)) setNote("Stopped.");
      else setErr(errText(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress("");
    }
  };

  /** Apply one person's decision to one binding.
   *
   *  The decision goes alone: conformance against the newly named type is
   *  recomputed by the server, which reads the file off the checkout. This
   *  used to send the text along, because the browser happened to be holding
   *  it -- and when it was not, the binding silently kept a verdict about the
   *  previous type. */
  const decide = async (
    b: DocBinding,
    body: Parameters<typeof api.decideDocBinding>[3],
  ) => {
    setErr(null);
    try {
      const updated = await api.decideDocBinding(token, workspaceId, b.id, body);
      setBindings((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setErr(errText(e));
    }
  };

  /** Every spec the project has, from both origins, newest first. */
  const rows = useMemo(
    () => specRows(bindings, authored, candidates),
    [bindings, authored, candidates],
  );
  const counts = useMemo(() => specCounts(rows), [rows]);

  /** The types this project's documents actually are, for the picker. Offering
   *  the whole catalogue would list types nothing here has. */
  const presentTypes = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) if (row.typeKey) keys.add(row.typeKey);
    return [...keys].sort((a, b) => typeName(a).localeCompare(typeName(b)));
  }, [rows, typeName]);

  const shown = useMemo(() => {
    const list = rows.filter((row) => {
      if (typeFilter === "-" && row.typeKey) return false;
      if (typeFilter && typeFilter !== "-" && row.typeKey !== typeFilter) return false;
      if (originFilter !== "any" && row.origin !== originFilter) return false;
      return inFilter(row, filter);
    });
    return [...list].sort((a, b) => a.path.localeCompare(b.path));
    // `rows` and `originFilter` belong here: the list is derived from them, and
    // leaving them out meant a row that appeared without a binding changing —
    // a candidate arriving from the graph — was not shown until something else
    // forced a recompute.
  }, [rows, filter, typeFilter, originFilter]);

  /** How much of `shown` is mounted. Reset whenever the view changes: a filter
   *  is a new question, and answering it from row 400 of the previous one
   *  would be a strange place to start reading. */
  const [rendered, setRendered] = useState(RENDER_PAGE);
  useEffect(() => setRendered(RENDER_PAGE), [filter, typeFilter, originFilter, view]);
  const visible = useMemo(() => shown.slice(0, rendered), [shown, rendered]);

  /** The row the side panel is about — always a repository one. An authored
   *  document opens in the editor instead, where it can be changed; a panel
   *  that only says what its type expects would be a worse answer than the
   *  place that lets you do something about it. */
  const selected = useMemo(
    () => shown.find((row) => row.id === selectedId)?.binding ?? null,
    [shown, selectedId],
  );

  const FILTERS: { id: SpecFilter; label: string; count: number }[] = [
    // First, because it is the state a freshly synced project is in: prose the
    // sync found, nothing has read yet.
    { id: "not-scanned", label: "Not scanned", count: counts["not-scanned"] },
    { id: "needs-review", label: "Needs review", count: counts["needs-review"] },
    { id: "bound", label: "Bound", count: counts.bound },
    { id: "not-documents", label: "Not documents", count: counts["not-documents"] },
    { id: "all", label: "All", count: counts.all },
  ];

  return (
    <div className="ingested">
      <style>{INGESTED_CSS}</style>
      <div className="ing-head">
        <h2>Specs</h2>
        <p>
          Studio reads the files the repository sync pulled in and works out which template each
          one was written against — from a type declared in its front matter, or by matching its
          sections, path and title. Anything it cannot decide waits here for you. The Status column
          counts what the detectors found open on each document; the analysis that produced those
          findings is the other view.
        </p>
      </div>

      <div className="ing-bar">
        <button onClick={recheck} disabled={busy}>
          {busy ? "Working…" : "Look again"}
        </button>
        <button
          className="primary"
          onClick={refineWithSpecQuality}
          disabled={busy || counts["needs-review"] === 0}
          title="Ask the Spec Quality purpose detector about the documents scoring could not place"
        >
          Refine undetermined with Spec Quality
        </button>
        <button
          onClick={runLeakChecks}
          disabled={busy || counts.bound === 0}
          title="Check each bound document for content that belongs to another kind of document"
        >
          Check bound documents for leaks
        </button>
        <button
          onClick={runBloatCheck}
          disabled={busy || counts.bound < 2}
          title="Find the documents that repeat each other"
        >
          Compare bound documents for duplication
        </button>
        <button
          onClick={runTraceCheck}
          disabled={busy || counts.bound < 2}
          title="Build the reference graph between bound documents and find the ones nothing connects to"
        >
          Trace references between bound documents
        </button>
        {busy && abortRef.current && (
          <button onClick={() => abortRef.current?.abort()}>Stop</button>
        )}
        {progress && <span className="ing-progress">{progress}</span>}
        {note && !progress && <span className="ing-note">{note}</span>}
      </div>

      {err && <div className="error">{err}</div>}

      <JourneyPanel stages={stages} types={types} onSeed={setSeeding} />

      {seeding && (
        <SeedModal
          token={token}
          tenantId={projectTenantId}
          typeKeys={seeding}
          types={types}
          onClose={() => {
            setSeeding(null);
            void reload();
          }}
        />
      )}

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
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          title="Show one kind of document"
          style={{ marginLeft: "auto", fontSize: 12 }}
        >
          <option value="">All types</option>
          {presentTypes.map((k) => (
            <option key={k} value={k}>
              {typeName(k)}
            </option>
          ))}
          <option value="-">Undetermined</option>
        </select>
        {/* Where it came from, as a filter rather than as a tab. The two
            origins belong in one list; wanting to see only one of them is a
            question about this list, not a different list. */}
        <select
          value={originFilter}
          onChange={(e) => setOriginFilter(e.target.value as typeof originFilter)}
          title="Show one origin"
          style={{ fontSize: 12 }}
        >
          <option value="any">Any origin</option>
          <option value="repository">From the repository</option>
          <option value="authored">Authored here</option>
        </select>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {shown.length === 0 ? (
        counts.all === 0 ? (
          /* A project with no documents is the ordinary state of a project that
             was created a minute ago, and this is the screen that owns its
             documentation — so it opens with the two ways to have some, not
             with a sentence about having none. Which one is first depends on
             where the documents would come from: an imported app already has
             them and needs reading, a new one has to write them.
             Both routes stay offered either way, because a new project can
             inherit a repository and an old one can still need a PRD. */
          <div className="ing-start">
            <h3>No documents yet</h3>
            <p>
              This is where the project&apos;s documentation lives — what it declares, what
              type each document is, and what the detectors find in them.
            </p>
            <div className="ing-start-routes">
              <button className="primary" onClick={onWriteDoc} disabled={busy}>
                Write the first one
              </button>
              <button onClick={recheck} disabled={busy}>
                {busy ? "Working…" : "Look again"}
              </button>
            </div>
            <p className="ing-start-note">
              Connect a repository under Sources and its sync will read whatever prose is
              already in it, working out which template each file was written against as it
              goes. Until then, documents written here are the project&apos;s.
            </p>
          </div>
        ) : (
          <p className="empty">Nothing in this view.</p>
        )
      ) : (
        <div className="ing-split">
          {view === "tiles" ? (
            /* The type picker does not come with. It is a <select> per row,
               and a dropdown is the one control that has to line up down a
               column to be worth anything: deciding a type is what the table
               and the side panel are for, and tiles answer "what have we
               got". */
            <TileGrid>
              {visible.map((row) => {
                const open = row.nodeId ? (findings[row.nodeId] ?? []).length : 0;
                const repoId = row.nodeId ? repoByNode[row.nodeId] : undefined;
                return (
                  <Tile
                    key={row.id}
                    icon={
                      <span className="ing-doc-ic" aria-hidden>
                        ▤
                      </span>
                    }
                    title={row.name}
                    subtitle={row.path || "not in a repository yet"}
                    tone={selectedId === row.id ? "on" : undefined}
                    onClick={() =>
                      row.origin === "authored" ? onOpenDoc(row.id) : setSelectedId(row.id)
                    }
                    stats={[
                      { label: "type", value: typeName(row.typeKey) },
                      {
                        label: "findings",
                        value: open > 0 ? <span className="pnum-attn">{open}</span> : "—",
                      },
                    ]}
                    footer={
                      <>
                        {/* Where it came from, which on a card has to be
                            written out: there is no column header above it to
                            say what the name means. */}
                        <span title={repoId ?? ""}>
                          {row.origin === "authored"
                            ? "Authored here"
                            : repoId
                              ? (repoNames[repoId] ?? repoId)
                              : "—"}
                        </span>
                        <span style={{ marginLeft: "auto" }}>{relTime(row.updatedAt)}</span>
                      </>
                    }
                  />
                );
              })}
            </TileGrid>
          ) : (
          <div className="ing-table">
            {/* The product's artifact table, column for column: what the thing
                is called, what type it was written against, where it came from,
                where it sits, what is open on it, and when it last moved. The
                old header named the pipeline's own vocabulary — "Why",
                "Conforms", "Analysis" — which describes how Studio decided
                rather than what the reader is looking at. */}
            <div className="ing-row ing-row-head">
              <span>Name</span>
              <span>Type</span>
              <span>Origin</span>
              <span>Path</span>
              <span>Status</span>
              <span>Updated</span>
              <span />
            </div>
            {visible.map((row) => {
              const b = row.binding;
              const open = row.nodeId ? findings[row.nodeId] : undefined;
              const repoId = row.nodeId ? repoByNode[row.nodeId] : undefined;
              return (
              <div
                key={row.id}
                className={selectedId === row.id ? "ing-row on" : "ing-row"}
                onClick={() =>
                  row.origin === "authored" ? onOpenDoc(row.id) : setSelectedId(row.id)
                }
              >
                {/* Name is the basename for a file and the title for a written
                    document. The full path has its own column, so repeating it
                    here cost the widest column in the table to say the same
                    thing twice. */}
                <span className="ing-name" title={row.path || row.name}>
                  <span className="ing-doc-ic" aria-hidden>
                    ▤
                  </span>
                  {row.name}
                </span>
                {/* A picker only where there is something to pick. An authored
                    document's type was chosen before a word of it was written,
                    and offering to change it here would offer to rewrite the
                    document against a different template. */}
                {b ? (
                  <span onClick={(e) => e.stopPropagation()}>
                    <select
                      value={row.typeKey ?? ""}
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
                ) : (
                  <span>{typeName(row.typeKey)}</span>
                )}
                {/* Where it came from. For a repository file that is the
                    repository, named rather than hashed — the id stays on the
                    title, because the name is what a reader recognises and the
                    id is what an API call wants. */}
                <span className="ing-repo" title={repoId ?? ""}>
                  {row.origin === "authored" ? (
                    <span className="ing-origin">Authored</span>
                  ) : repoId ? (
                    (repoNames[repoId] ?? repoId)
                  ) : (
                    <span className="ing-dash">—</span>
                  )}
                </span>
                <span className="ing-path" title={row.path}>
                  {row.path || <span className="ing-dash">not committed</span>}
                </span>
                {/* Status is what is OPEN on the document, which is the one
                    thing a reader scanning this list is looking for. How the
                    type was decided, and how confidently, moved to a title —
                    it matters while triaging and never afterwards. */}
                <span
                  className="ing-status"
                  title={[
                    b
                      ? `${stateLabel(b.state)}${
                          b.confidence != null && b.state === "detected"
                            ? ` · ${Math.round(b.confidence * 100)}%`
                            : ""
                        }`
                      : row.doc
                        ? `written here · ${row.doc.status ?? "draft"}`
                        : "ingested · not analysed yet",
                    b?.source ? (SOURCE_LABEL[b.source] ?? b.source) : "",
                    row.conforms == null
                      ? "not validated"
                      : row.conforms
                        ? "conforms to its type"
                        : `${b?.validation?.issues.length ?? 0} conformance issue(s)`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <span
                    className="ing-dot"
                    style={{ background: findingDotTone(open, row.conforms) }}
                    aria-hidden
                  />
                  {/* An authored document has no detector verdicts of its own
                      until it is committed and scanned, so it reports its
                      editorial status instead of a finding count it cannot
                      have. */}
                  {row.origin === "authored"
                    ? (row.doc?.status ?? "draft")
                    : b
                      ? findingLabel(open)
                      : /* Nothing has read this file yet, so it has no verdict
                           to report — and a finding count of zero would claim
                           it came back clean. */
                        "not scanned"}
                </span>
                <span className="ing-updated" title={row.updatedAt}>
                  {/* A candidate carries no timestamp: the graph node's is
                      about the sync, not about the file, and showing the
                      sync's time here would read as "this document changed". */}
                  {row.updatedAt ? relTime(row.updatedAt) : <span className="ing-dash">—</span>}
                </span>
                <span className="ing-actions" onClick={(e) => e.stopPropagation()}>
                  {b ? (
                    <>
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
                    </>
                  ) : (
                    <button onClick={() => onOpenDoc(row.id)} title="Open in the editor">
                      Open
                    </button>
                  )}
                </span>
              </div>
              );
            })}
          </div>
          )}

          {visible.length < shown.length && (
            /* Says what is held back rather than letting the list stop without
               explanation — a table that ends at row 200 of 5785 with no note
               reads as "that is all there is". */
            <div className="ing-more">
              <button onClick={() => setRendered((n) => n + RENDER_PAGE)} disabled={busy}>
                Show {Math.min(RENDER_PAGE, shown.length - visible.length)} more
              </button>
              <span className="ing-dash">
                {visible.length} of {shown.length}
              </span>
            </div>
          )}

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
                  {/* How the type was decided, and how sure. This used to be a
                      column ("Why"); it belongs here, because it is a question
                      you ask about ONE document while deciding what to do with
                      it, and never while scanning the list. */}
                  <div className="ing-why" style={{ marginTop: 8 }}>
                    <span
                      className="ing-state"
                      style={{
                        background: stateTone(selected.state).bg,
                        color: stateTone(selected.state).fg,
                      }}
                    >
                      {stateLabel(selected.state)}
                    </span>
                    {selected.confidence != null && selected.state === "detected" && (
                      <span className="ing-conf">{Math.round(selected.confidence * 100)}%</span>
                    )}
                    {selected.source && (
                      <span className="ing-src">
                        {SOURCE_LABEL[selected.source] ?? selected.source}
                      </span>
                    )}
                  </div>
                  {/* The file lives in the repository, so the repository's
                      editor is where it is changed. Studio reports on it. */}
                  <button
                    onClick={() => onOpenFile(selected.path)}
                    style={{ marginTop: 10, width: "100%" }}
                    title={`Open ${selected.path} in the IDE`}
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



/** Picking somewhere to write: a source connection and one of its repositories.
 *
 *  Shared because both things that write to a repository need exactly this and
 *  nothing more — publishing one document, and seeding the ones a journey is
 *  still missing. Only source hosts are offered: a model-provider connection
 *  has no repositories at all, so listing it would only produce a confusing
 *  400 later.
 */
function useRepoTarget(token: string, tenantId: string) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[]>([]);
  const [repo, setRepo] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  return {
    connections,
    connectionId,
    setConnectionId,
    repos,
    repo,
    setRepo,
    selectedRepo,
    loadingRepos,
    err,
    setErr,
  };
}

/** The two pickers, rendered the same way wherever a repository is chosen. */
function RepoTargetFields({ target }: { target: ReturnType<typeof useRepoTarget> }) {
  return (
    <>
      <div>
        <label style={qLabel}>Connection</label>
        <select
          value={target.connectionId}
          onChange={(e) => target.setConnectionId(e.target.value)}
          style={{ width: "100%" }}
        >
          {target.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {c.provider} · {c.account}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label style={qLabel}>Repository</label>
        <select
          value={target.repo}
          onChange={(e) => target.setRepo(e.target.value)}
          disabled={target.loadingRepos || target.repos.length === 0}
          style={{ width: "100%" }}
        >
          {target.loadingRepos && <option>loading…</option>}
          {!target.loadingRepos && target.repos.length === 0 && (
            <option value="">none reachable</option>
          )}
          {target.repos.map((r) => (
            <option key={r.id} value={r.full_path}>
              {r.full_path}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** Writes the documents a journey asks for and the project has none of.
 *
 *  A template, not a document: what lands in the repository is the type's own
 *  skeleton, with its sections and its front matter, for someone to fill in
 *  where documents are actually edited. That is the whole point of putting it
 *  there rather than in a text area here — the next person to touch it opens
 *  the IDE, not this tab.
 *
 *  One branch and one pull request for the lot. The connector opens a request
 *  on the first file and finds the same one for the rest, so a seeding run
 *  arrives as a single thing to review rather than as five.
 */
function SeedModal({
  token,
  tenantId,
  typeKeys,
  types,
  onClose,
}: {
  token: string;
  tenantId: string;
  typeKeys: string[];
  types: DocType[];
  onClose: () => void;
}) {
  const target = useRepoTarget(token, tenantId);
  const [branch, setBranch] = useState("studio/seed-documents");
  const [base, setBase] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(typeKeys));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [written, setWritten] = useState<WrittenFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const wanted = typeKeys
    .map((key) => types.find((t) => t.key === key))
    .filter((t): t is DocType => !!t);

  const seed = async () => {
    setBusy(true);
    setErr(null);
    const done: WrittenFile[] = [];
    try {
      const chosen = wanted.filter((t) => selected.has(t.key));
      for (let i = 0; i < chosen.length; i += 1) {
        const type = chosen[i];
        setProgress(`Writing ${i + 1}/${chosen.length} · ${type.name}`);
        done.push(
          await api.writeRepoFile(token, target.connectionId, tenantId, {
            repo: target.repo,
            branch: branch.trim(),
            ...(base.trim() ? { base: base.trim() } : {}),
            path: `docs/${type.key}.md`,
            content: type.body,
            message: `docs: add the ${type.name} template`,
            pull_request: {
              title: "Add the documents the journey requires",
              body:
                "Templates for the document types this project's journey asks for and the " +
                "repository did not have. Fill them in here; Studio reads them back and " +
                "checks them against the same types.",
            },
          }),
        );
      }
      setWritten(done);
    } catch (e) {
      setErr(errText(e));
      // Keep what did land: a partial run is worth reporting honestly rather
      // than looking like nothing happened.
      if (done.length > 0) setWritten(done);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const pr = written?.find((w) => w.pull_request)?.pull_request ?? null;
  const canSeed =
    !!target.connectionId && !!target.repo && branch.trim().length > 0 && selected.size > 0 && !busy;

  return (
    <Modal label="Write the missing documents" onClose={onClose}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Write the missing documents</span>
          <button onClick={onClose} style={{ marginLeft: "auto" }} aria-label="Close">
            ✕
          </button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
          Each type's template goes into the repository as a file, on one branch and one pull
          request. They are skeletons — fill them in where documents are edited.
        </p>

        {written ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13 }}>
              Wrote {written.length} file{written.length === 1 ? "" : "s"} to{" "}
              <code>{branch.trim()}</code>.
            </div>
            {written.map((w) => (
              <div key={w.path} style={{ fontSize: 12, opacity: 0.75 }}>
                {w.updated ? "updated" : "created"} <code>{w.path}</code>
              </div>
            ))}
            {pr && (
              <div style={{ fontSize: 13 }}>
                {pr.created ? "Opened pull request" : "Added to the request already open"}{" "}
                <b>#{pr.number}</b>.
                {pr.url && (
                  <>
                    {" "}
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      Review it →
                    </a>
                  </>
                )}
              </div>
            )}
            {err && <div className="error">{err}</div>}
            <div style={{ marginTop: 8 }}>
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            {target.connections.length === 0 ? (
              <p className="empty" style={{ fontSize: 12 }}>
                No source connections reach this project. Add one under Connections first.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={qLabel}>Documents</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {wanted.map((t) => (
                      <label key={t.key} style={{ fontSize: 12, display: "flex", gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={selected.has(t.key)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(t.key);
                              else next.delete(t.key);
                              return next;
                            })
                          }
                        />
                        <span>
                          {t.name} <code style={qTag}>docs/{t.key}.md</code>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <RepoTargetFields target={target} />

                <div>
                  <label style={qLabel}>Branch</label>
                  <input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={qLabel}>
                    Base<span style={qTag}>optional</span>
                  </label>
                  <input
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    placeholder={target.selectedRepo?.default_branch ?? "default branch"}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
            )}

            {(err || target.err) && <div className="error" style={{ marginTop: 10 }}>{err ?? target.err}</div>}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
              <button className="primary" onClick={seed} disabled={!canSeed}>
                {busy ? "Writing…" : `Write ${selected.size} file${selected.size === 1 ? "" : "s"}`}
              </button>
              <button onClick={onClose} disabled={busy}>
                Cancel
              </button>
              {progress && <span style={{ fontSize: 12, opacity: 0.7 }}>{progress}</span>}
            </div>
          </>
        )}
    </Modal>
  );
}

/** What the workspace's journey still wants from this project.
 *
 *  The catalogue has been able to answer this since stages grew requirements,
 *  and nothing asked. Which is a shame, because it is the one view that says
 *  what to do next rather than what happens to be there: a stage names the
 *  document types it cannot do without and the detectors those documents must
 *  pass, and this is the project measured against that.
 *
 *  Both kinds of document count — written in Studio, or a repository file
 *  someone bound to the type — so a project whose PRD has always lived in its
 *  repository reads as having a PRD. */
function JourneyPanel({
  stages,
  types,
  onSeed,
}: {
  stages: StageStatus[];
  types: DocType[];
  /** Offer to write the missing documents into the repository. */
  onSeed: (typeKeys: string[]) => void;
}) {
  const typeName = (key: string) => types.find((t) => t.key === key)?.name ?? key;

  // Stages that ask for nothing say nothing: a journey is mostly those, and
  // listing them buries the two that actually want something.
  const asking = stages.filter((s) => s.requirements.length > 0);
  if (asking.length === 0) return null;

  const missing = [
    ...new Set(
      asking.flatMap((s) => s.requirements.filter((r) => !r.present).map((r) => r.type_key)),
    ),
  ];

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>What the journey needs</span>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
          {asking.filter((s) => s.complete).length} of {asking.length} stages complete
        </span>
      </div>

      <div className="jr-stages">
        {asking.map((stage) => (
          <div key={stage.key} className="jr-stage">
            <span className={stage.complete ? "ing-ok" : "ing-dash"} style={{ width: 14 }}>
              {stage.complete ? "✓" : "○"}
            </span>
            <span className="jr-label">
              {stage.label}
              {stage.required && <span style={qTag}>required</span>}
            </span>
            <span className="jr-reqs">
              {stage.requirements.map((r) => (
                <span
                  key={r.type_key}
                  className="ing-state"
                  title={
                    !r.present
                      ? "No document of this type in the project"
                      : !r.conforms
                        ? "Present, but it does not pass its type's checklist"
                        : r.analyses_outstanding.length > 0
                          ? `Waiting on ${r.analyses_outstanding.join(", ")}`
                          : "Present, conforming, and past every gate"
                  }
                  style={
                    !r.present
                      ? { background: "var(--warning-soft)", color: "var(--warning)" }
                      : !r.conforms || r.analyses_outstanding.length > 0
                        ? { background: "var(--info-soft)", color: "var(--info)" }
                        : { background: "var(--success-soft)", color: "var(--success)" }
                  }
                >
                  {typeName(r.type_key)}
                  {r.present && r.analyses_outstanding.length > 0 && (
                    <> · {r.analyses_outstanding.join(", ")}</>
                  )}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>

      {missing.length > 0 && (
        <div className="jr-seed">
          <span>
            {missing.length} required document{missing.length === 1 ? " is" : "s are"} not in this
            repository yet.
          </span>
          <button className="primary" onClick={() => onSeed(missing)}>
            Write {missing.length === 1 ? "it" : "them"} from the templates →
          </button>
        </div>
      )}
    </div>
  );
}

const INGESTED_CSS = `
.ingested { display: flex; flex-direction: column; gap: 12px; }
.ing-start { border: 1px solid var(--border); border-radius: 10px; padding: 20px 22px; max-width: 70ch; }
.ing-start h3 { margin: 0 0 6px; font-size: 15px; }
.ing-start p { margin: 0; font-size: 13px; color: var(--muted-foreground); }
.ing-start-routes { display: flex; gap: 8px; margin: 14px 0 12px; flex-wrap: wrap; }
.ing-start-note { font-size: 12px; }
.ing-head h2 { margin: 0 0 4px; font-size: 16px; }
.ing-head p { margin: 0; font-size: 13px; color: var(--muted-foreground); max-width: 70ch; }
.ing-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ing-progress, .ing-note { font-size: 12px; color: var(--muted-foreground); }
.ing-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.ing-filter { font-size: 12px; padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border); background: transparent; cursor: pointer; }
.ing-filter.on { background: var(--accent); border-color: var(--accent-foreground); }
.ing-count { opacity: 0.6; margin-left: 4px; }
/* The detail panel sits beside the table only while the table can still afford
   it. Seven columns need ~1040px before Name starts ellipsising to nothing, so
   below 1500px the panel goes under the table and gives that width back —
   measured: at 1280 the side-by-side split left Name 66px wide. */
.ing-split { display: grid; grid-template-columns: minmax(0,1fr) 280px; gap: 12px; align-items: start; }
@media (max-width: 1500px) { .ing-split { grid-template-columns: minmax(0,1fr); } }
/* overflow-x, not hidden: when the columns below cannot all fit at their
   minimums the table scrolls sideways, the way the product's does
   (its Table is overflow-x-auto). Clipping instead would simply delete the
   Updated column and the row's own actions off the right edge.
   No backticks in this comment — the whole block is a template literal. */
.ing-table { border: 1px solid var(--border); border-radius: var(--radius-xl); overflow-x: auto; background: var(--card); }
/* Name | Type | Repository | Path | Status | Updated | row actions.
   Every flexible column carries a floor. minmax(0,...) let the four of them be
   squeezed to nothing by the four fixed ones — at 1280px that produced a 66px
   Name and a 37px Repository, which is a row of ellipses. The floors add up to
   970px plus 72px of gaps, and .ing-table scrolls past that rather than
   shrinking anything below it. */
.ing-row { display: grid; grid-template-columns: minmax(180px,1.6fr) 140px minmax(110px,0.9fr) minmax(160px,1.4fr) 130px 110px 140px; gap: 12px; align-items: center; padding: 10px 14px; font-size: 12px; border-top: 1px solid var(--border); cursor: pointer; }
.ing-row:first-child { border-top: none; }
.ing-row.on { background: var(--accent); }
/* The column row is the shipped TableHead: 10px uppercase in the mono face at
   normal weight, not a small bold heading. */
.ing-row-head { font-family: var(--font-mono); font-size: 10px; line-height: 16px; font-weight: 400; text-transform: uppercase; color: var(--muted-foreground); cursor: default; background: transparent; padding-top: 8px; padding-bottom: 8px; }
.ing-row select { width: 100%; font-size: 12px; }
.ing-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 600; color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ing-doc-ic { flex: none; color: var(--primary); font-size: 13px; }
.ing-repo { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
.ing-updated { color: var(--muted-foreground); white-space: nowrap; }
.ing-status { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.ing-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.ing-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--muted-foreground); }
.ing-why { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ing-state { padding: 1px 7px; border-radius: 20px; font-size: 11px; white-space: nowrap; }
.ing-conf { opacity: 0.7; }
.ing-src { opacity: 0.6; font-size: 11px; }
.ing-ok { color: var(--success); }
.ing-bad { color: var(--warning); }
.ing-dash { opacity: 0.4; }
.ing-more {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 2px 2px;
  font-size: 12px;
}
/* Authored, said in the Origin column where every other row names a
   repository. A chip rather than plain text: it is a different KIND of answer
   from the ones around it, not another repository with an odd name. */
.ing-origin { border: 1px solid var(--border); border-radius: 20px; padding: 1px 8px; font-size: 11px; color: var(--muted-foreground); }
.ing-findings { display: flex; gap: 4px; flex-wrap: wrap; }
.jr-stages { display: flex; flex-direction: column; gap: 6px; }
.jr-stage { display: grid; grid-template-columns: 14px minmax(120px, 200px) minmax(0, 1fr); gap: 8px; align-items: center; font-size: 12px; }
.jr-label { font-weight: 500; }
.jr-reqs { display: flex; gap: 4px; flex-wrap: wrap; }
.jr-seed { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 12px; }
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
  const target = useRepoTarget(token, tenantId);
  const [mode, setMode] = useState<PublishMode>("pull_request");
  const [branch, setBranch] = useState(`studio/${slugPath(doc.title)}`);
  const [base, setBase] = useState("");
  const [prTitle, setPrTitle] = useState(`Publish ${doc.title}`);
  const [prBody, setPrBody] = useState("");
  const [path, setPath] = useState(suggestedPath(doc));
  const [message, setMessage] = useState(`docs: publish ${doc.title}`);
  const [busy, setBusy] = useState(false);
  const [written, setWritten] = useState<WrittenFile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setErr(null);
    try {
      const result = await api.writeRepoFile(token, target.connectionId, tenantId, {
        repo: target.repo,
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
    !!target.connectionId &&
    !!target.repo &&
    path.trim().length > 0 &&
    (mode === "commit" || branch.trim().length > 0) &&
    !busy;

  return (
    <Modal label="Publish to a repository" onClose={onClose}>
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
            {target.connections.length === 0 ? (
              <p className="empty" style={{ fontSize: 12 }}>
                No source connections reach this project. Add one under Connections first.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <RepoTargetFields target={target} />

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
                        ? (target.selectedRepo?.default_branch ?? "default branch")
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
                    placeholder={target.selectedRepo?.default_branch ?? "default branch"}
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

            {(err || target.err) && (
              <div className="error" style={{ marginTop: 10 }}>
                {err ?? target.err}
              </div>
            )}

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
    </Modal>
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
    <Modal label="Intake questionnaire" onClose={onCancel}>
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
    </Modal>
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

const qLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 };
const qTag: CSSProperties = { marginLeft: 8, fontSize: 10, opacity: 0.6, fontWeight: 400 };


// ── Compose (v1): match the App Spec's capabilities to catalog components ─────
//
// The matcher lives in compose.ts: the project's Components tab asks the same
// question from the other end, and two answers to it would be one too many.

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

// ── Scaffolding: a starter gear for a capability gap ──────────────────────
//
// The skeleton is generated server-side (components_catalog/skeleton.rs). This
// screen asks for it with `dry_run` to show it, then asks again to write it --
// rather than composing the files here and posting them, which is what made the
// browser the only thing that knew what a gear looks like.

function ScaffoldModal({
  capability,
  token,
  projectTenantId,
  onBack,
  onClose,
}: {
  capability: string;
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
  const [files, setFiles] = useState<ScaffoldFile[] | null>(null);
  const slug = gearSlug(capability);

  // The preview is the server's own answer, asked for with nothing written.
  // A preview composed here would be a second generator, and a second
  // generator is a promise the write does not have to keep.
  useEffect(() => {
    let alive = true;
    setPushErr(null);
    api
      .scaffoldGearToRepo(token, projectTenantId, { slug: capability, dry_run: true })
      .then((r) => {
        if (alive) setFiles(r.files);
      })
      .catch((e) => {
        if (alive) setPushErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [token, projectTenantId, capability]);

  const file = files?.[active];
  const copy = () => {
    if (file) navigator.clipboard?.writeText(file.content).catch(() => {});
  };

  const push = async () => {
    setPushing(true);
    setPushErr(null);
    try {
      const r = await api.scaffoldGearToRepo(token, projectTenantId, {
        slug: capability,
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
    <Modal label="Scaffold gear" onClose={onClose} cardStyle={{ width: "min(860px, 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <button onClick={onBack} title="Back to plan">←</button>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Scaffold gear</span>
          <code style={{ fontSize: 12 }}>cf-gears-{slug}</code>
          <button onClick={onClose} style={{ marginLeft: "auto" }} aria-label="Close">✕</button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
          Starter skeleton for the <code>{capability}</code> gap. Review, then push it to the
          project's connected gear repo on a <code>scaffold/{slug}</code> branch — the session
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
            {(files ?? []).map((f, i) => (
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
                {f.path.replace(new RegExp(`^.*/${slug}/`), "")}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: 11, opacity: 0.7 }}>
                {file?.path ?? (files ? "—" : "asking the server…")}
              </code>
              <button onClick={copy} disabled={!file} style={{ marginLeft: "auto", fontSize: 11 }}>
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
              {file?.content ?? ""}
            </pre>
          </div>
        </div>
    </Modal>
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
    <Modal label="Composition plan" onClose={onClose} cardStyle={{ width: "min(760px, 100%)" }}>
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
              build. Components that have been built rank above ones the catalogue has only
              documents for; within each, by how well the metadata matches.
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
                      <>
                        <span style={{ fontSize: 11, opacity: 0.6 }}>
                          {r.candidates.length} candidate{r.candidates.length === 1 ? "" : "s"}
                        </span>
                        {/* Candidates, but nothing anyone can build from yet: closer to a
                            gap than to a match, and the one state a keyword ranking used
                            to hide completely. */}
                        {r.unbuilt && (
                          <>
                            <span style={{ ...gapBadge, opacity: 0.75 }}>NOT BUILT</span>
                            <button
                              onClick={() => onScaffold(r.capability)}
                              style={{ marginLeft: "auto", fontSize: 11 }}
                              title="Generate a starter gear for this capability"
                            >
                              Scaffold gear →
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                  {!r.gap && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {r.candidates.map((c) => (
                        <span
                          key={c.name}
                          title={
                            `matched: ${c.why.join(", ")}` +
                            (c.built === "docs-only"
                              ? " · the catalogue found no crate under this component — docs and a manifest only"
                              : "")
                          }
                          style={{
                            ...composeChip,
                            borderLeftColor: kindColor(c.kind),
                            opacity: c.built === "docs-only" ? 0.65 : 1,
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{shortName(c.name)}</span>
                          <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 10 }}>{c.kind}</span>
                          {c.built === "docs-only" && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700 }}>
                              docs only
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, fontSize: 11, opacity: 0.6 }}>
              v1 heuristic match (name · description · keywords), with built components first —
              a gear directory holding only docs is not a gear you can compose from. Next:
              agent-driven matching.
            </div>
          </>
        )}
    </Modal>
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
  /** The type keys the analyser accepts, asked of the service rather than
   *  restated here. null = the wrapper could not read its schema, which is
   *  "unknown" and not "none". */
  const caps = useSpecQualityCapabilities(token);
  const analysable = useMemo(() => (caps ? new Set(caps.docTypes) : null), [caps]);
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
      {/* A table, not a column of cards. Each type carried five facts stacked
          into three lines inside a 280px rail, so the reader compared them by
          scrolling instead of by scanning — the question "which of these has
          front-matter rules" needed seven separate reads. In columns it is one
          glance down, and the same table idiom the documents list uses. */}
      <aside className="dt-list">
        <div className="dt-list-head">
          <span className="dt-list-title">
            {types.length} type{types.length === 1 ? "" : "s"}
          </span>
          <button className="dt-new" onClick={blank}>
            New type
          </button>
        </div>
        <div className="dt-row dt-row-head">
          <span>Name</span>
          <span>Key</span>
          <span>Owner</span>
          <span>Sections</span>
          <span>Front-matter</span>
          <span>Analyser</span>
        </div>
        {types.map((t) => (
          <button
            key={t.key}
            className={`dt-row dt-type${dirtyKey === t.key ? " active" : ""}`}
            onClick={() => load(t)}
          >
            <span className="dt-type-name">{t.name}</span>
            <code className="dt-type-key">{t.key}</code>
            <span>
              <span className={`dt-owner ${t.owner === "workspace" ? "ws" : "bi"}`}>{t.owner}</span>
            </span>
            <span className="dt-type-num">{t.sections.length}</span>
            {/* A dash, not a 0. Zero front-matter rules and "this type does not
                use front matter" are the same fact, and a column of noughts
                reads as data the reader has to discount. */}
            <span className="dt-type-num">
              {t.rules.front_matter.length || <span className="dt-dash">—</span>}
            </span>
            {/* Whether the spec-quality service can analyse a document of this
                type. The workspace owns the template and the rules; the SERVICE
                owns which type keys its purpose and leak detectors accept, and
                the two lists are not the same. A type it does not know is a
                perfectly good template — it just cannot be analysed, and
                saying so here beats finding out from a 422 later. */}
            <span className="dt-type-analyser">
              {analysable === null ? (
                <span className="dt-dash" title="Could not read the analyser's vocabulary">
                  ?
                </span>
              ) : analysable.has(t.key) ? (
                <span className="badge ok">analysable</span>
              ) : (
                <span
                  className="badge"
                  title={`The analyser accepts ${[...analysable].join(", ")} — documents of this type can still be templated and validated, but purpose and leak will refuse them`}
                >
                  template only
                </span>
              )}
            </span>
          </button>
        ))}
      </aside>

      <section className="dt-editor">
        {err && <div className="error">{err}</div>}
        {!editing ? (
          <div className="dt-empty">
            <div className="dt-empty-ic">▤</div>
            <p>Pick a type above to view or override it, or create a new one.</p>
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

/* The table on top, the editor under it — not side by side. A 280px rail could
   not hold five facts per type without stacking them three deep, and the editor
   it left room for is the tallest screen in the product: both halves were
   cramped to make a split that helped neither. Full width, one below the other,
   each with the room it actually needs. */
.doctypes .dt-grid { display: flex; flex-direction: column; gap: 16px; }
/* ONE panel with hairline dividers, not a stack of bordered cards each with its
   own gap. Eight types were eight floating boxes with eight shadow-less
   outlines — the list read as eight unrelated things rather than one column of
   choices. */
.doctypes .dt-list { display: flex; flex-direction: column; border: 1px solid var(--dtb); border-radius: var(--radius-xl); background: var(--dtsf); overflow: hidden; }
/* Name | Key | Owner | Sections | Front-matter. Name is the only one that
   flexes; the four beside it are short and fixed, so the columns do not
   reshuffle as types load in. */
/* Only Name flexes. Key was minmax(140px,0.5fr) and took 339px at 1600 to
   print "adr" — a slug has a known, short length, so the slack belongs to the
   one column that can actually use it. */
.doctypes .dt-row { display: grid; grid-template-columns: minmax(200px,1fr) 180px 110px 90px 120px 130px; gap: 12px; align-items: center; padding: 10px 14px; }
.doctypes .dt-row-head { font-family: var(--font-mono); font-size: 10px; line-height: 16px; text-transform: uppercase; color: var(--dtmu); border-bottom: 1px solid var(--dtb); }
.doctypes .dt-type-key { font-size: 11px; color: var(--dtmu); overflow: hidden; text-overflow: ellipsis; }
.doctypes .dt-type-num { font-variant-numeric: tabular-nums; color: var(--dttx); }
.doctypes .dt-dash { opacity: 0.4; }
/* The create action is a control, not a banner. It was a full-width solid-blue
   slab above the list — the single heaviest thing on a screen whose subject is
   the list under it. It sits in the panel's own header row now, at the size the
   rest of the product's buttons are. */
.doctypes .dt-list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dtb); }
.doctypes .dt-list-title { font-family: var(--font-mono); font-size: 10px; line-height: 16px; text-transform: uppercase; color: var(--dtmu); }
.doctypes .dt-new { padding: 5px 12px; height: 28px; border-radius: var(--radius-md); border: 1px solid var(--dtb); cursor: pointer; background: var(--dtsf2); color: var(--dttx); font: inherit; font-size: 12px; font-weight: 500; }
.doctypes .dt-new:hover { background: var(--studio-control-hover-neutral); }
.doctypes .dt-type { text-align: left; cursor: pointer; font: inherit; font-size: 12px; color: inherit; border: 0; border-top: 1px solid var(--dtb); border-radius: 0; background: none; transition: background var(--motion-micro) var(--ease-standard), color var(--motion-micro) var(--ease-standard); }
.doctypes .dt-row-head + .dt-type { border-top: 0; }
.doctypes .dt-type:hover { background: var(--studio-control-hover-neutral); }
/* Selected is the shell's own pair — neutral fill, blue label — so a chosen
   type reads the same as a chosen section in the band above it. */
.doctypes .dt-type.active { background: var(--studio-selection-subtle); }
.doctypes .dt-type.active .dt-type-name { color: var(--dtac); }
.doctypes .dt-type-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doctypes .dt-owner { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: var(--radius-full); }
.doctypes .dt-owner.bi { background: var(--dtsf2); color: var(--dtmu); border: 1px solid var(--dtb); }
.doctypes .dt-owner.ws { background: var(--dtacs); color: var(--dtac); }

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

/* Past the columns' own minimums the panel scrolls sideways rather than
   crushing Name to an ellipsis — the same trade the documents table makes. */
@media (max-width: 900px) { .doctypes .dt-list { overflow-x: auto; } }
`;
