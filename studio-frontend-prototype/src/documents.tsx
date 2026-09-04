// Documents tab (prototype). Two modes:
//  • Documents — a project's effective documents (own + inherited from the
//    workspace); create from a type template (at project or workspace level),
//    edit markdown, and see the live section checklist + conformance.
//  • Types — the workspace's effective document types (built-in ∪
//    workspace-defined); define or override a type (template, sections, rules).
import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { api, CatalogNode, Doc, DocQuestion, DocRules, DocSection, DocType, DocValidation } from "./api";

/** Human-readable message from an ApiError (title/detail) or any Error. */
function errText(e: unknown): string {
  const x = e as { detail?: string; title?: string; message?: string } | null;
  return x?.detail || x?.title || x?.message || String(e);
}

const STATUSES: Doc["status"][] = ["draft", "review", "approved"];
const card = { border: "1px solid var(--border,#e2e4e9)", borderRadius: 10, padding: 12 } as const;
const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "section";

/** Project-level: work with the project's documents (own + inherited from the
 *  workspace). Document types are defined at the workspace level — see
 *  [`DocumentTypesTab`] — so this view only reads them for the create picker. */
export function DocumentsTab({
  token,
  workspaceId,
  projectTenantId,
}: {
  token: string;
  /** The parent workspace tenant — the storage scope for documents and types. */
  workspaceId: string;
  /** The open project tenant. */
  projectTenantId: string;
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
      <DocumentsView
        token={token}
        workspaceId={workspaceId}
        projectTenantId={projectTenantId}
        types={types}
      />
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
}: {
  token: string;
  workspaceId: string;
  projectTenantId: string;
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

  const createDoc = async (title: string, content?: string) => {
    if (!newType || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const body: { type_key: string; title: string; content?: string } = {
        type_key: newType,
        title: title.trim(),
      };
      if (content) body.content = content;
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
      const [components, profs] = await Promise.all([
        api.listComponents(token),
        api.listComponentProfiles(token).catch(() => ({ nodes: [] as import("./api").CatalogNode[] })),
      ]);
      const profiles: Record<string, Record<string, unknown>> = {};
      for (const n of profs.nodes ?? []) {
        const nm = (n.value as Record<string, unknown>).gear_name;
        if (typeof nm === "string") profiles[nm] = n.value as Record<string, unknown>;
      }
      const caps = parseCapabilities(selected.content);
      setPlan(composePlan(caps, components.nodes ?? [], profiles));
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
                  border: "1px solid var(--border,#e2e4e9)",
                  background: d.id === selectedId ? "var(--accent-soft,#eef2ff)" : "transparent",
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
                  {d.inherited && <span style={{ color: "var(--muted,#6b7280)" }}>· inherited</span>}
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
                  style={{ width: "100%", minHeight: 420, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.5, padding: 10, borderRadius: 8, border: "1px solid var(--border,#e2e4e9)", resize: "vertical" }}
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
          onSubmit={(content, title) => createDoc(title, content)}
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
      {scaffold && (
        <ScaffoldModal
          scaffold={scaffold}
          token={token}
          projectTenantId={projectTenantId}
          onBack={() => setScaffold(null)}
          onClose={() => setScaffold(null)}
        />
      )}
    </>
  );
}

// ── Questionnaire intake ─────────────────────────────────────────────────────

type Answer = string | string[] | boolean;

/** Render one answer as markdown text. Empty answers return "". */
function answerText(q: DocQuestion, a: Answer | undefined): string {
  if (a === undefined || a === null) return "";
  if (q.kind === "bool") return a ? "Yes" : "No";
  if (q.kind === "multi") return Array.isArray(a) ? a.join(", ") : "";
  return typeof a === "string" ? a.trim() : String(a);
}

/** Is a required question satisfied? */
function answered(q: DocQuestion, a: Answer | undefined): boolean {
  if (q.kind === "bool") return true; // a boolean is always answered
  if (q.kind === "multi") return Array.isArray(a) && a.length > 0;
  return typeof a === "string" && a.trim().length > 0;
}

/** Build a conforming markdown document from questionnaire answers: front
 *  matter, title, and each section filled with the answers that target it.
 *  Capability tags that were answered are recorded in the front matter so the
 *  Composer can read them later. */
function generateFromQuestionnaire(type: DocType, title: string, answers: Record<string, Answer>): string {
  const questions = type.questionnaire ?? [];
  const caps = Array.from(
    new Set(
      questions
        .filter((q) => q.capability && answered(q, answers[q.id]) && answers[q.id] !== false)
        .map((q) => q.capability as string),
    ),
  );
  const lines: string[] = ["---", "status: draft", "owner: "];
  if (caps.length) lines.push(`capabilities: ${caps.join(", ")}`);
  lines.push("---", "", `# ${type.name} — ${title.trim()}`, "");
  for (const s of type.sections) {
    lines.push(`## ${s.title}`, "");
    for (const q of questions.filter((x) => x.section === s.key)) {
      const text = answerText(q, answers[q.id]);
      if (text) lines.push(`**${q.prompt}**`, "", text, "");
    }
  }
  return lines.join("\n");
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
  onSubmit: (content: string, title: string) => void;
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
                {q.required && <span style={{ color: "#dc2626" }}> *</span>}
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
            onClick={() => onSubmit(generateFromQuestionnaire(type, title, answers), title)}
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
        style={{ width: "100%", minHeight: 72, padding: 8, borderRadius: 6, border: "1px solid var(--border,#e2e4e9)", fontSize: 13, resize: "vertical" }}
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
  background: "var(--surface,#fff)",
  color: "var(--text,#111)",
  border: "1px solid var(--border,#e2e4e9)",
  borderRadius: 12,
  padding: 20,
  width: "min(640px, 100%)",
  boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
};
const qLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 };
const qTag: CSSProperties = { marginLeft: 8, fontSize: 10, opacity: 0.6, fontWeight: 400 };


// ── Compose (v1): match the App Spec's capabilities to catalog components ─────

/** Search terms per capability tag; a component matches when its catalog
 *  metadata contains any of them. Deliberately explicit and explainable — v2
 *  replaces this with agent-driven, embedding-based matching. */
const CAP_KEYWORDS: Record<string, string[]> = {
  tenancy: ["tenant", "tenancy", "account", "organization", "org", "resource group"],
  auth: ["auth", "authn", "identity", "idp", "oidc", "keycloak", "login", "session", "credential"],
  authz: ["authz", "authorization", "permission", "rbac", "policy", "access", "role"],
  storage: ["storage", "graph", "postgres", "database", "file", "object", "search", "node"],
  connectors: ["connector", "github", "gitlab", "bitbucket", "integration", "source"],
  facade: ["connector", "proxy", "gateway", "adapter", "facade", "wrapper", "oagw", "egress"],
  billing: ["billing", "payment", "invoice", "metering", "subscription", "usage"],
  compliance: ["audit", "compliance", "gdpr", "secret", "credstore", "policy"],
  deploy: ["deploy", "gitops", "helm", "k8s", "kubernetes", "bootstrap"],
};

type Candidate = { name: string; kind: string; score: number; why: string[] };
type PlanRow = { capability: string; candidates: Candidate[]; gap: boolean };

/** Capability tags recorded in the App Spec's front matter by the questionnaire. */
function parseCapabilities(content: string): string[] {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const line = fm[1].split("\n").find((l) => l.trim().startsWith("capabilities:"));
  if (!line) return [];
  return line
    .replace(/^\s*capabilities:/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

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

function composePlan(
  caps: string[],
  gears: CatalogNode[],
  profiles: Record<string, Record<string, unknown>>,
): PlanRow[] {
  const geared = gears.filter((g) => typeof g.value.name === "string");
  return caps.map((cap) => {
    const kws = CAP_KEYWORDS[cap] ?? [cap];
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
    gear: "#1a7f4b",
    sdk: "#0065e3",
    plugin: "#7147d2",
    toolkit: "#9a6700",
    frontx: "#b3261e",
  };
  return m[kind] ?? "#8b90a3";
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
            background: "var(--surface-raised,#f6f7f9)",
            border: "1px solid var(--border,#e2e4e9)",
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
                  border: "1px solid var(--border,#e2e4e9)",
                  background: i === active ? "var(--accent-soft,#eef2ff)" : "transparent",
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
                border: "1px solid var(--border,#e2e4e9)",
                background: "var(--surface-raised,#f6f7f9)",
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
                <div key={r.capability} style={{ border: "1px solid var(--border,#e2e4e9)", borderRadius: 8, padding: "10px 12px" }}>
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
  border: "1px solid var(--border,#e2e4e9)",
  borderLeftWidth: 3,
  background: "var(--surface-raised,#f6f7f9)",
  whiteSpace: "nowrap",
};
const gapBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 20,
  background: "#fef3c7",
  color: "#92400e",
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
            background: report?.conforms ? "#dcfce7" : "#fef3c7",
            color: report?.conforms ? "#166534" : "#92400e",
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
                <span style={{ width: 14, color: s.ok ? "#16a34a" : s.required ? "#dc2626" : "#9ca3af" }}>
                  {s.ok ? "✓" : s.required ? "✕" : "○"}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                <span style={{ marginLeft: "auto", opacity: 0.6 }}>{s.word_count}w</span>
              </div>
            ))}
          </div>
          {report.issues.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: "#92400e" }}>Issues</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--muted,#6b7280)" }}>
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
  --dtb: var(--border, #2b2f3a);
  --dtsf: var(--surface, #1c1f27);
  --dtsf2: var(--panel, #232733);
  --dttx: var(--text, #e7e9ee);
  --dtmu: var(--muted, #8b90a3);
  --dtac: var(--accent, #3b82f6);
  --dtacs: var(--accent-soft, rgba(59,130,246,.16));
  --dtok: #1a7f4b;
  color: var(--dttx);
}
.doctypes .dt-head h2 { font-size: 18px; font-weight: 700; margin: 0 0 4px; letter-spacing: -.01em; }
.doctypes .dt-head p { margin: 0 0 14px; color: var(--dtmu); font-size: 13px; line-height: 1.5; max-width: 92ch; }

.doctypes .dt-flow { display: flex; align-items: stretch; flex-wrap: wrap; gap: 8px; padding: 12px; margin: 0 0 16px; border: 1px solid var(--dtb); border-radius: 12px; background: var(--dtsf2); }
.doctypes .dt-flow-step { display: flex; align-items: center; gap: 9px; padding: 8px 12px; background: var(--dtsf); border: 1px solid var(--dtb); border-radius: 9px; min-width: 0; }
.doctypes .dt-flow-step.outcome { background: var(--dtacs); border-color: color-mix(in srgb, var(--dtac) 45%, transparent); }
.doctypes .dt-flow-n { width: 20px; height: 20px; flex: none; border-radius: 50%; background: var(--dtac); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.doctypes .dt-flow-body { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
.doctypes .dt-flow-t { font-weight: 600; font-size: 12.5px; }
.doctypes .dt-flow-d { font-size: 10.5px; color: var(--dtmu); }
.doctypes .dt-flow-arrow { align-self: center; color: var(--dtmu); font-size: 15px; }
.doctypes .dt-flow-arrow.big { font-size: 18px; color: var(--dtac); }

.doctypes .dt-grid { display: grid; grid-template-columns: 250px minmax(0,1fr); gap: 16px; align-items: start; }
.doctypes .dt-list { display: flex; flex-direction: column; gap: 6px; }
.doctypes .dt-new { padding: 9px 12px; border-radius: 9px; border: 0; cursor: pointer; background: var(--dtac); color: #fff; font: inherit; font-weight: 600; margin-bottom: 4px; }
.doctypes .dt-type { text-align: left; cursor: pointer; font: inherit; color: inherit; display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border: 1px solid var(--dtb); border-radius: 9px; background: var(--dtsf); transition: border-color .12s, background .12s; }
.doctypes .dt-type:hover { border-color: var(--dtac); }
.doctypes .dt-type.active { border-color: var(--dtac); background: var(--dtacs); }
.doctypes .dt-type-name { font-weight: 600; font-size: 13px; }
.doctypes .dt-type-meta { display: flex; align-items: center; gap: 7px; }
.doctypes .dt-type-meta code { font-size: 11px; color: var(--dtmu); }
.doctypes .dt-owner { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; }
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
.doctypes .dt-step { width: 20px; height: 20px; flex: none; border-radius: 6px; background: var(--dtacs); color: var(--dtac); display: grid; place-items: center; font-size: 11px; font-weight: 700; }
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
.doctypes .dt-toggle { font: inherit; font-size: 11.5px; cursor: pointer; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--dtb); background: var(--dtsf2); color: var(--dtmu); }
.doctypes .dt-toggle.on { background: var(--dtacs); color: var(--dtac); border-color: color-mix(in srgb, var(--dtac) 45%, transparent); font-weight: 600; }
.doctypes .dt-del { font: inherit; cursor: pointer; border: 1px solid var(--dtb); background: var(--dtsf2); color: var(--dtmu); border-radius: 7px; width: 30px; height: 30px; }
.doctypes .dt-del:hover { color: var(--dtac); border-color: var(--dtac); }
.doctypes .dt-add { margin-top: 8px; font: inherit; font-size: 12px; cursor: pointer; background: none; border: 1px dashed var(--dtb); color: var(--dtmu); border-radius: 8px; padding: 6px 12px; }
.doctypes .dt-add:hover { border-color: var(--dtac); color: var(--dtac); }
.doctypes .dt-rules { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }

.doctypes .dt-checks { border: 1px solid color-mix(in srgb, var(--dtok) 40%, var(--dtb)); background: color-mix(in srgb, var(--dtok) 8%, var(--dtsf)); border-radius: 12px; padding: 12px 15px; }
.doctypes .dt-checks-h { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.doctypes .dt-checks ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.doctypes .dt-checks li { font-size: 12px; color: var(--dttx); }
.doctypes .dt-checks li::marker { color: var(--dtok); }

.doctypes .dt-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.doctypes .dt-save { font: inherit; font-weight: 600; cursor: pointer; background: var(--dtac); color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; }
.doctypes .dt-save:disabled { opacity: .6; cursor: default; }

@media (max-width: 720px) { .doctypes .dt-grid { grid-template-columns: 1fr; } }
`;
