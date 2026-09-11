// Spec-Quality playground.
//
// A prototype surface to exercise the external spec-quality detector service
// through OUR backend wrapper (studio-spec-quality gear → /cf/spec-quality/*).
// The service key lives in the backend config; the browser only ever talks to
// the Studio gateway with the user's normal token.
//
// Four detectors:
//   bloat        — cross-document duplication over a doc-set (docs map)
//   purpose      — section roles + a purpose gate (one document)
//   leak         — foreign-content verdicts per section (one document)
//   traceability — an ID graph (extract) or LLM drift judging (classify)
//
// bloat & traceability take a whole doc-set; purpose & leak are per-document
// (with a "run on every file" batch mode so you can sweep the dataset).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, apiUrl } from "./api";
import type { ArtifactNode } from "./api";

/* ── Types ── */

type Detector = "bloat" | "purpose" | "leak" | "traceability";
type DocType = "" | "prd" | "design" | "adr" | "feature" | "decomposition";

interface DocEntry {
  path: string;
  text: string;
  size: number;
  /** Graph node instance id this document maps to (issue/PR/file), when it was
   *  loaded from ingested artifacts. Lets detector results be written back to
   *  the graph as findings/relations keyed on the real node. */
  instanceId?: string;
}

interface TaskCreated {
  task_id: string;
  detector: Detector;
  status: string;
  poll?: string;
}
interface TaskView {
  task_id: string;
  detector: Detector;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  result?: any;
  error?: { type?: string; message?: string } | null;
  warnings?: string[];
}

const DETECTORS: { id: Detector; label: string; blurb: string; setwise: boolean }[] = [
  {
    id: "bloat",
    label: "Bloat",
    blurb: "Duplication across one or more documents.",
    setwise: true,
  },
  {
    id: "purpose",
    label: "Purpose",
    blurb: "Section roles, doc-type mixture, and the purpose gate.",
    setwise: false,
  },
  {
    id: "leak",
    label: "Leak",
    blurb: "Per-section foreign-content verdicts with evidence.",
    setwise: false,
  },
  {
    id: "traceability",
    label: "Traceability",
    blurb: "ID graph (extract) or LLM drift judging (classify).",
    setwise: true,
  },
];

const DOC_TYPES: DocType[] = ["", "prd", "design", "adr", "feature", "decomposition"];

/* ── Small fetch layer (Studio token → gateway → wrapper gear) ── */

async function sqFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(`/spec-quality${path}`), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 413) {
      throw new Error(
        "payload too large (HTTP 413) — the doc-set exceeds the request size limit. " +
          "Remove big/non-spec files (e.g. reports/*.json, graph.json) or analyse fewer documents.",
      );
    }
    const detail =
      (body && (body.detail || body.message || body.title)) || `HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

/** Sentinel thrown when the user stops a run; callers treat it as "not an error". */
const CANCELLED = "__spec_quality_cancelled__";
const isCancel = (e: unknown) =>
  (e instanceof Error && e.message === CANCELLED) ||
  (e instanceof DOMException && e.name === "AbortError") ||
  (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError");

/** Sleep that resolves early (and still resolves) when the signal aborts, so a
 *  Stop doesn't wait out the full poll interval. */
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface RunOpts {
  onTick?: (t: TaskView) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Submit + poll to a terminal state. Throws CANCELLED if the signal aborts.
 *
 *  Note: the upstream service exposes no cancel endpoint, so Stop halts OUR
 *  polling (and the in-flight request) — the already-submitted task keeps
 *  running server-side and can still be found via GET /tasks. */
async function runDetector(
  detector: Detector,
  payload: unknown,
  token: string,
  { onTick, signal, timeoutMs = 180_000 }: RunOpts = {},
): Promise<TaskView> {
  if (signal?.aborted) throw new Error(CANCELLED);
  const created = await sqFetch<TaskCreated>(`/v1/analyze/${detector}`, token, {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
  });
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error(CANCELLED);
    const view = await sqFetch<TaskView>(`/v1/tasks/${created.task_id}`, token, { signal });
    onTick?.(view);
    if (view.status === "succeeded") return view;
    if (view.status === "failed") {
      throw new Error(view.error?.message || "analysis failed");
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s (task ${created.task_id})`);
    }
    await sleep(1200, signal);
    if (signal?.aborted) throw new Error(CANCELLED);
  }
}

/** Ask the `purpose` detector what kind of document this is.
 *
 *  The third and most expensive step of document-type detection (see the
 *  studio-documents `classify` module): offline scoring runs on everything,
 *  and only what it could not decide is worth an LLM round-trip. Returns
 *  `null` when the detector declines to name a type.
 *
 *  Lives here rather than in the Documents tab because this is the module that
 *  owns talking to the detector service — submit, poll, and the error shapes. */
export async function detectDocType(
  token: string,
  path: string,
  text: string,
  signal?: AbortSignal,
): Promise<DocTypeVerdict> {
  const view = await runDetector(
    "purpose",
    { text, path, classify_doc_type: true },
    token,
    { signal },
  );
  const r = (view.result ?? {}) as {
    doc_type?: unknown;
    mixture?: Record<string, unknown>;
    gate?: Record<string, unknown>;
  };
  const docType = typeof r.doc_type === "string" && r.doc_type.trim() ? r.doc_type.trim() : null;
  const passed = r.gate?.passed ?? r.gate?.ok;

  // `mixture` is how much of the document each section role accounts for.
  // `other` is the share that is not specification content at all, so what is
  // left is how much of the file the detector actually recognised as a spec —
  // and that, not `gate`, is what says whether `doc_type` means anything.
  const other = Number(r.mixture?.other ?? 0);
  const specShare = Number.isFinite(other) ? Math.max(0, Math.min(1, 1 - other)) : 0;
  return {
    docType,
    specShare,
    gatePassed: typeof passed === "boolean" ? passed : null,
    taskId: view.task_id,
  };
}

/** What the `purpose` detector concluded about one document. */
export interface DocTypeVerdict {
  /** The type it named. It always names one, hence `specShare`. */
  docType: string | null;
  /** How much of the document read as specification content rather than
   *  `other`, 0.0–1.0 — the detector's own evidence for the type it named. */
  specShare: number;
  /** Whether the purpose gate passed: `leak_share` under its threshold, i.e.
   *  no foreign content where the type says there should be none.
   *
   *  This is the one thing `gate` is good for. It is not evidence for
   *  `doc_type` — see [`MIN_SPEC_SHARE`] — but it is exactly what a stage that
   *  gates on `purpose` is asking about. */
  gatePassed: boolean | null;
  /** The upstream task, so a disputed verdict can be traced to its run. */
  taskId: string;
}

/** Below this, the detector recognised too little of the document for the type
 *  it named to mean anything.
 *
 *  Measured against ten files of this repository whose kind we already know:
 *
 *  ```text
 *  docs/adr/0009-roles-over-tenant.md      adr             0.99
 *  .../0014-document-types-are-components  adr             0.86   gate FAILED
 *  docs/adr/0007-shell-tokens…             adr             0.72
 *  docs/theia-bridge-contract-v1.md        feature         0.88
 *  docs/roadmap-alignment.md               decomposition   0.00
 *  TASKS.md                                decomposition   0.00
 *  README.md                               feature         0.16
 *  ```
 *
 *  Two things that table settles. `doc_type` on its own is not a signal at all:
 *  a task list and a roadmap both come back `decomposition`, because the
 *  classifier must return one of the types it knows. And `gate` is not
 *  confidence — it is `leak_share` against a threshold, so it passes the
 *  roadmap and fails a genuine ADR; gating on it would reject the real
 *  documents and keep the noise.
 *
 *  At 0.5 the sample keeps every real specification and drops four of the five
 *  files that are not one. */
export const MIN_SPEC_SHARE = 0.5;

/** True when an error came from the user pressing Stop, not from a failure. */
export const isDetectorCancel = isCancel;

/* ── Helpers ── */

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const pct = (x: number) => `${Math.round((x ?? 0) * 100)}%`;
const isTextFile = (name: string) => /\.(md|markdown|txt|json|ya?ml|rst|adoc)$/i.test(name);

// "Spec doc" filter for the set-wise detectors (bloat / traceability) and for
// batch purpose/leak: keep prose specs (.md/.txt/…), drop the export's OUTPUT
// artefacts (reports/*.json, graph.json, benchmark_targets.json), dotfiles and
// macOS cruft — those are not spec content and only bloat the request body.
const SPEC_EXT = /\.(md|markdown|txt|rst|adoc)$/i;
const isSpecDoc = (path: string) => {
  if (!SPEC_EXT.test(path)) return false;
  if (/(^|[\\/])reports[\\/]/i.test(path)) return false;
  if (/__MACOSX/i.test(path)) return false;
  if (basename(path).startsWith(".")) return false;
  return true;
};

const ROLE_COLORS: Record<string, string> = {
  requirement: "var(--primary)",
  design: "var(--avatar-turquoise)",
  decision: "var(--warning)",
  other: "var(--avatar-grey)",
};

/** Filesystem-safe slug for an artifact title, so each issue/PR becomes a
 *  distinct, readable doc path the detectors can key on. */
const slug = (s: string) =>
  (s || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

/** Turn ingested issue/PR nodes into detector documents: one markdown doc per
 *  artifact (title as H1, then body). Files (`repo`) are skipped — they carry
 *  no prose to analyse. Returns them sorted, ready to merge into `docs`. */
function artifactsToDocs(nodes: ArtifactNode[]): DocEntry[] {
  const out: DocEntry[] = [];
  for (const n of nodes) {
    const isIssue = n.type_id.includes("issue");
    const isPr = n.type_id.includes("pull_request");
    if (!isIssue && !isPr) continue;
    const v = n.value ?? {};
    const dir = isPr ? "pull_requests" : "issues";
    const num = v.number != null ? String(v.number) : n.instance_id.slice(0, 8);
    const title = typeof v.title === "string" ? v.title : "(untitled)";
    const body = typeof v.body === "string" ? v.body : "";
    const labels = Array.isArray(v.labels) && v.labels.length ? `\n\n_labels: ${v.labels.join(", ")}_` : "";
    const text = `# ${title}${labels}\n\n${body}`.trim() + "\n";
    out.push({
      path: `${dir}/${num}-${slug(title)}.md`,
      text,
      size: text.length,
      instanceId: n.instance_id,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ── Component ── */

export function SpecQuality({
  token,
  workspaceId,
  parentWorkspaceId,
}: {
  token: string;
  /** When rendered inside a project, the project id — lets the artifact loader
   *  label its source. Undefined = the standalone playground. */
  workspaceId?: string;
  /** The parent workspace tenant. Together with `workspaceId` (the project),
   *  scopes persisted finding nodes so the graph's scope filter keeps them. */
  parentWorkspaceId?: string;
}) {
  // Tenants to tag persisted findings with — mirrors the sync tagging
  // (workspace = parent, project = this project). Spread into every
  // saveQualityFindings call so findings survive the graph's scope filter.
  const scopeTags = workspaceId
    ? { workspace_id: parentWorkspaceId ?? workspaceId, project_id: workspaceId }
    : {};
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [detector, setDetector] = useState<Detector>("bloat");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [stopped, setStopped] = useState(false);
  // Ingested-artifact loader state (the "From artifacts" button).
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [artifactNote, setArtifactNote] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  // Results are kept PER detector type, so switching tabs shows that
  // detector's last run instead of wiping it. A fresh run of the same type
  // replaces only its own slot.
  type BatchRow = { path: string; view?: TaskView; error?: string };
  const [results, setResults] = useState<Partial<Record<Detector, TaskView | null>>>({});
  const [batches, setBatches] = useState<Partial<Record<Detector, BatchRow[]>>>({});
  const result = results[detector] ?? null;
  const batch = batches[detector] ?? [];

  // Per-detector options.
  const [purposeFile, setPurposeFile] = useState<string>("");
  const [docType, setDocType] = useState<DocType>("");
  const [classifyDocType, setClassifyDocType] = useState(true);
  const [gateThreshold, setGateThreshold] = useState(0.05);
  const [leakVerify, setLeakVerify] = useState(true);
  const [batchMode, setBatchMode] = useState(true);
  const [traceMode, setTraceMode] = useState<"extract" | "classify">("extract");
  const [traceVerify, setTraceVerify] = useState(true);
  // Traceability matches docs by a canonical layout (PRD.md/DESIGN.md/
  // features/*.md/ADR/*.md …). A flat issue export matches nothing, so this
  // remaps each doc key to features/<name>.md so the service accepts them and
  // builds the ID graph over their cross-references.
  const [traceRemap, setTraceRemap] = useState(true);
  const [bloatK, setBloatK] = useState<number | "">("");
  // Filter the set-wise / batch input down to spec docs (drops output JSON etc.).
  const [specOnly, setSpecOnly] = useState(true);

  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (list: FileList | null) => {
    if (!list) return;
    const entries: DocEntry[] = [];
    for (const f of Array.from(list)) {
      const path = (f as any).webkitRelativePath || f.name;
      if (!isTextFile(f.name)) continue;
      const text = await f.text();
      entries.push({ path, text, size: f.size });
    }
    setDocs((prev) => {
      const byPath = new Map(prev.map((d) => [d.path, d]));
      for (const e of entries) byPath.set(e.path, e);
      const merged = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
      return merged;
    });
  }, []);

  const removeDoc = (path: string) => setDocs((prev) => prev.filter((d) => d.path !== path));
  const clearDocs = () => {
    setDocs([]);
    setResults({});
    setBatches({});
    setArtifactNote("");
  };

  // Pull the ingested issues/PRs (from the repository sync) and add them as
  // documents. This is what "run for artifacts pulled from the repository"
  // means: the same corpus the artifact-ingest gear stored in the graph.
  const loadArtifacts = useCallback(async () => {
    setLoadingArtifacts(true);
    setArtifactNote("");
    setError("");
    try {
      const { nodes } = await api.listArtifactNodes(token);
      const seeded = artifactsToDocs(nodes ?? []);
      if (seeded.length === 0) {
        setArtifactNote("No ingested issues or PRs yet — run Sync on a repository in Artifacts first.");
        return;
      }
      setDocs((prev) => {
        const byPath = new Map(prev.map((d) => [d.path, d]));
        for (const d of seeded) byPath.set(d.path, d);
        return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
      });
      setArtifactNote(`Added ${seeded.length} artifact document${seeded.length === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoadingArtifacts(false);
    }
  }, [token]);

  // Load the cloned repository's own files (from the IDE workspace checkout) as
  // documents — the primary way to analyse the repo instead of hand-picking a
  // file or folder. Needs the project context (workspaceId) and an opened
  // Studio session (so the repo is cloned).
  const loadRepoFiles = useCallback(async () => {
    if (!workspaceId) return;
    setLoadingRepo(true);
    setArtifactNote("");
    setError("");
    try {
      const settings = await api.workspaceSettings(token, workspaceId).catch(() => null);
      const repos = (settings?.repos ?? []).filter((r) => r.source !== "local");
      if (repos.length === 0) {
        setArtifactNote("No git repositories attached to this project.");
        return;
      }
      const seeded: DocEntry[] = [];
      for (const r of repos) {
        const dir = r.target || r.name;
        try {
          const { files } = await api.repoFiles(token, workspaceId, dir);
          for (const f of files) {
            const path = `${r.name}/${f.path}`;
            seeded.push({ path, text: f.text, size: f.text.length });
          }
        } catch {
          // One repo failing (e.g. never cloned) should not stop the others.
        }
      }
      if (seeded.length === 0) {
        setArtifactNote(
          "No repository files yet — open Studio for this project so the repo is cloned, then retry.",
        );
        return;
      }
      setDocs((prev) => {
        const byPath = new Map(prev.map((d) => [d.path, d]));
        for (const d of seeded) byPath.set(d.path, d);
        return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
      });
      setArtifactNote(`Added ${seeded.length} repository file${seeded.length === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoadingRepo(false);
    }
  }, [token, workspaceId]);

  // In a project, pre-load the ingested artifacts (issues/PRs from the last
  // Sync) as soon as the tab opens — the corpus you almost always want to
  // analyse, so you don't have to click "+ From artifacts" every time. Runs
  // once per project; the buttons still let you add/replace by hand.
  const autoLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    if (autoLoadedRef.current === workspaceId) return;
    autoLoadedRef.current = workspaceId;
    void loadArtifacts();
  }, [workspaceId, loadArtifacts]);

  // Input actually sent to set-wise detectors / used for batch — after the
  // spec-doc filter (when enabled).
  const includedDocs = useMemo(
    () => (specOnly ? docs.filter((d) => isSpecDoc(d.path)) : docs),
    [docs, specOnly],
  );
  const excludedCount = docs.length - includedDocs.length;
  const includedKb = (includedDocs.reduce((s, d) => s + d.size, 0) / 1024).toFixed(1);

  const docsMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of includedDocs) m[d.path] = d.text;
    return m;
  }, [includedDocs]);

  const selectedPurposeDoc = useMemo(
    () => docs.find((d) => d.path === purposeFile) ?? docs[0],
    [docs, purposeFile],
  );

  // Lazily-built index of ingested file nodes (repo path -> instance id), so
  // file documents (loaded "From repository") resolve to their graph node too.
  const fileIndexRef = useRef<Map<string, string> | null>(null);

  // ── Materialize detector results into the artifact graph (ADR-0010) ──
  // Best-effort: writes findings + derived relations back through the artifact-
  // ingest gear. Keyed on document node instance ids, so it only acts on docs
  // that came from ingested artifacts.

  async function docInstanceIndex(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const d of docs) if (d.instanceId) map.set(d.path, d.instanceId);
    if (!fileIndexRef.current) {
      try {
        const { nodes } = await api.listArtifactNodes(token, "file");
        const fi = new Map<string, string>();
        for (const n of nodes) {
          const p = (n.value as { path?: unknown })?.path;
          if (typeof p === "string") fi.set(p, n.instance_id);
        }
        fileIndexRef.current = fi;
      } catch {
        fileIndexRef.current = new Map();
      }
    }
    for (const [p, id] of fileIndexRef.current) if (!map.has(p)) map.set(p, id);
    return map;
  }

  const resolveRef = (
    ref: string,
    byPath: Map<string, string>,
    byBase: Map<string, string>,
  ): string | undefined => byPath.get(ref) ?? byBase.get(basename(ref));

  async function materializeSetwise(det: "bloat" | "traceability", view: TaskView): Promise<void> {
    try {
      const byPath = await docInstanceIndex();
      const byBase = new Map<string, string>();
      for (const [p, id] of byPath) byBase.set(basename(p), id);
      const r = (view.result ?? {}) as Record<string, any>;

      if (det === "bloat") {
        const clusters: any[] = Array.isArray(r.clusters) ? r.clusters : [];
        const seen = new Set<string>();
        const duplicates: { from: string; to: string }[] = [];
        for (const c of clusters) {
          const occ: any[] = Array.isArray(c.occurrences) ? c.occurrences : [];
          const ids = Array.from(
            new Set(
              occ.map((o) => resolveRef(String(o.file ?? ""), byPath, byBase)).filter(Boolean),
            ),
          ) as string[];
          for (let i = 0; i < ids.length; i++)
            for (let j = i + 1; j < ids.length; j++) {
              const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
              const key = `${a}|${b}`;
              if (!seen.has(key)) {
                seen.add(key);
                duplicates.push({ from: a, to: b });
              }
            }
        }
        if (duplicates.length) {
          const res = await api.saveQualityFindings(token, { duplicates, ...scopeTags });
          setProgress(`Saved to graph: ${res.edges} duplicate link(s).`);
        }
      } else {
        const edgesRaw: any[] = r.edges || r.links || r.references || r.pairs || [];
        const seen = new Set<string>();
        const traces: { from: string; to: string }[] = [];
        for (const e of edgesRaw) {
          const from = resolveRef(String(e.from ?? e.source ?? e.src ?? e.a ?? ""), byPath, byBase);
          const to = resolveRef(String(e.to ?? e.target ?? e.dst ?? e.b ?? ""), byPath, byBase);
          if (!from || !to || from === to) continue;
          const key = `${from}|${to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          traces.push({ from, to });
        }
        if (traces.length) {
          const res = await api.saveQualityFindings(token, { traces, ...scopeTags });
          setProgress(`Saved to graph: ${res.edges} trace link(s).`);
        }
      }
    } catch (e) {
      console.warn("[spec-quality] materialize to graph failed", e);
    }
  }

  async function materializeFinding(det: Detector, doc: DocEntry, view: TaskView): Promise<void> {
    const subject = doc.instanceId;
    if (!subject) return; // only artifact-backed docs map to a node
    try {
      const r = (view.result ?? {}) as Record<string, any>;
      const gate = (r.gate ?? {}) as Record<string, any>;
      let severity: string;
      let score: number | undefined;
      let summary: string;
      if (det === "purpose") {
        const ok = gate.ok ?? gate.passed;
        severity = ok === false ? "gate-failed" : ok === true ? "gate-passed" : "analyzed";
        score = typeof gate.leak_share === "number" ? gate.leak_share : undefined;
        summary = `purpose ${severity}${r.n_sections != null ? `, ${r.n_sections} sections` : ""}`;
      } else {
        const share =
          typeof gate.leak_share === "number"
            ? gate.leak_share
            : typeof r.leak_share === "number"
              ? r.leak_share
              : undefined;
        const nSec = Array.isArray(r.sections) ? r.sections.length : undefined;
        severity = share != null ? (share > 0.15 ? "high" : share > 0 ? "some" : "clean") : "analyzed";
        score = share;
        summary = `leak ${severity}${nSec != null ? `, ${nSec} sections` : ""}`;
      }
      await api.saveQualityFindings(token, {
        findings: [{ detector: det, subject, path: doc.path, severity, summary, score, details: r }],
        ...scopeTags,
      });
    } catch (e) {
      console.warn("[spec-quality] finding save failed", e);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setProgress("Stopping…");
  }

  async function run() {
    const runDet = detector; // captured — the run keeps writing to this slot
    setError("");
    setStopped(false);
    // Clear only THIS detector's stored result; other tabs keep theirs.
    setResults((r) => ({ ...r, [runDet]: null }));
    setBatches((b) => ({ ...b, [runDet]: [] }));
    if (docs.length === 0) {
      setError("Add at least one document first.");
      return;
    }
    const setwise = runDet === "bloat" || runDet === "traceability";
    if (setwise && Object.keys(docsMap).length === 0) {
      setError(
        specOnly
          ? "No spec docs after the filter — add .md/.txt files or turn off “spec docs only”."
          : "No documents to send.",
      );
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;
    setBusy(true);
    try {
      if (runDet === "bloat") {
        setProgress(`Running bloat over ${Object.keys(docsMap).length} docs…`);
        const payload: any = { docs: docsMap };
        if (bloatK !== "") payload.config = { k: Number(bloatK) };
        const view = await runDetector("bloat", payload, token, {
          signal,
          onTick: (t) => setProgress(`bloat: ${t.status}…`),
        });
        setResults((r) => ({ ...r, bloat: view }));
        void materializeSetwise("bloat", view);
      } else if (runDet === "traceability") {
        setProgress("Running traceability over the doc-set…");
        // Optionally remap keys into the canonical features/ layout so the
        // service recognises a flat issue export instead of ignoring it.
        let traceDocs = docsMap;
        if (traceRemap) {
          const m: Record<string, string> = {};
          for (const d of includedDocs) {
            let key = `features/${basename(d.path)}`;
            let i = 2;
            while (m[key] !== undefined) key = `features/${basename(d.path).replace(/\.md$/i, "")}-${i++}.md`;
            m[key] = d.text;
          }
          traceDocs = m;
        }
        const payload: any = { docs: traceDocs, mode: traceMode, verify: traceVerify };
        const view = await runDetector("traceability", payload, token, {
          signal,
          onTick: (t) => setProgress(`traceability: ${t.status}…`),
        });
        setResults((r) => ({ ...r, traceability: view }));
        void materializeSetwise("traceability", view);
      } else {
        // purpose / leak — single doc, or batch over the filtered doc list.
        const targets = batchMode ? includedDocs : selectedPurposeDoc ? [selectedPurposeDoc] : [];
        if (targets.length === 0) {
          setError("Pick a document to analyse.");
          setBusy(false);
          return;
        }
        if (!batchMode) {
          const d = targets[0];
          setProgress(`${runDet}: ${basename(d.path)}…`);
          const view = await runDetector(runDet, buildDocPayload(runDet, d), token, {
            signal,
            onTick: (t) => setProgress(`${runDet} · ${basename(d.path)}: ${t.status}…`),
          });
          setResults((r) => ({ ...r, [runDet]: view }));
          void materializeFinding(runDet, d, view);
        } else {
          const acc: BatchRow[] = [];
          let i = 0;
          for (const d of targets) {
            if (signal.aborted) {
              setStopped(true);
              break;
            }
            i += 1;
            setProgress(`${runDet}: ${i}/${targets.length} · ${basename(d.path)}`);
            try {
              const view = await runDetector(runDet, buildDocPayload(runDet, d), token, {
                signal,
              });
              acc.push({ path: d.path, view });
              void materializeFinding(runDet, d, view);
            } catch (e: any) {
              if (isCancel(e)) {
                setStopped(true);
                break;
              }
              acc.push({ path: d.path, error: e?.message || String(e) });
            }
            setBatches((b) => ({ ...b, [runDet]: [...acc] }));
          }
        }
      }
    } catch (e: any) {
      if (isCancel(e)) setStopped(true);
      else setError(e?.message || String(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress("");
    }
  }

  function buildDocPayload(det: Detector, d: DocEntry): any {
    const base: any = {
      text: d.text,
      path: d.path,
      gate_threshold: gateThreshold,
      classify_doc_type: classifyDocType,
    };
    if (docType) base.doc_type = docType;
    if (det === "leak") base.verify = leakVerify;
    return base;
  }

  const totalKb = (docs.reduce((s, d) => s + d.size, 0) / 1024).toFixed(1);
  const curDet = DETECTORS.find((x) => x.id === detector)!;

  return (
    <div className="sq">
      <SqStyles />
      <div className="card">
        <div className="card-head">
          <div>
            <h2>Spec Quality</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              Run the spec-quality detectors over this project's repository — use{" "}
              {workspaceId ? (
                <>
                  <b>+ From repository</b> to load the cloned repo's files,{" "}
                </>
              ) : null}
              <b>+ From artifacts</b> for ingested issues and PRs, or add files by hand. Calls go
              through the backend wrapper (<code>/cf/spec-quality</code>).
              {workspaceId ? ` · project ${workspaceId.slice(0, 8)}…` : ""}
            </p>
          </div>
          <SqStatusChip token={token} />
        </div>

        {/* ── 1. Documents ── */}
        <div className="sq-section">
          <div className="sq-section-title">1 · Documents</div>
          <div className="sq-drop">
            <div className="sq-drop-actions">
              <button className="chip" onClick={() => fileRef.current?.click()}>
                + Add files
              </button>
              <button className="chip" onClick={() => dirRef.current?.click()}>
                + Add folder
              </button>
              {workspaceId && (
                <button
                  className="chip"
                  onClick={() => void loadRepoFiles()}
                  disabled={loadingRepo}
                  title="Load the cloned repository's files (from the IDE workspace) as documents"
                >
                  {loadingRepo ? "Loading…" : "+ From repository"}
                </button>
              )}
              <button
                className="chip"
                onClick={() => void loadArtifacts()}
                disabled={loadingArtifacts}
                title="Load the ingested issues and pull requests from the repository sync as documents"
              >
                {loadingArtifacts ? "Loading…" : "+ From artifacts"}
              </button>
              {docs.length > 0 && (
                <button className="chip" onClick={clearDocs}>
                  Clear
                </button>
              )}
              <span className="sq-muted">
                {docs.length} file{docs.length === 1 ? "" : "s"} · {totalKb} KB
              </span>
            </div>
            {artifactNote && (
              <div className="sq-muted" style={{ marginTop: 6 }}>
                {artifactNote}
              </div>
            )}
            <label className="sq-opt sq-check" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={specOnly}
                onChange={(e) => setSpecOnly(e.target.checked)}
              />
              spec docs only (.md/.txt) — drops reports/*.json, graph.json &amp; other output
            </label>
            {docs.length > 0 && (
              <div className="sq-muted" style={{ marginTop: 4 }}>
                sending {includedDocs.length} of {docs.length} · {includedKb} KB
                {excludedCount > 0 && ` · ${excludedCount} excluded`}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
            <input
              ref={dirRef}
              type="file"
              hidden
              multiple
              // webkitdirectory/directory are non-standard folder-picker attrs
              // (not in React's input typings) — spread as any to set them.
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => addFiles(e.target.files)}
            />
            {docs.length > 0 && (
              <ul className="sq-files">
                {docs.map((d) => {
                  const excluded = specOnly && !isSpecDoc(d.path);
                  return (
                    <li key={d.path} className={excluded ? "excluded" : ""}>
                      <span className="sq-file-path" title={d.path}>
                        {d.path}
                      </span>
                      {excluded && <span className="sq-muted">excluded</span>}
                      <span className="sq-muted">{(d.size / 1024).toFixed(1)} KB</span>
                      <button className="sq-x" onClick={() => removeDoc(d.path)} title="Remove">
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* ── 2. Detector ── */}
        <div className="sq-section">
          <div className="sq-section-title">2 · Detector</div>
          <div className="sq-tabs">
            {DETECTORS.map((d) => (
              <button
                key={d.id}
                className={`sq-tab ${detector === d.id ? "on" : ""}`}
                onClick={() => {
                  // Keep each detector's results; just switch the view and drop
                  // the transient run banners.
                  setDetector(d.id);
                  setError("");
                  setStopped(false);
                }}
              >
                <span className="sq-tab-label">
                  {d.label}
                  {(results[d.id] || (batches[d.id]?.length ?? 0) > 0) && (
                    <span className="sq-tab-dot" title="has a saved result">
                      ●
                    </span>
                  )}
                </span>
                <span className="sq-tab-blurb">{d.blurb}</span>
              </button>
            ))}
          </div>

          {/* Per-detector options */}
          <div className="sq-opts">
            {detector === "bloat" && (
              <label className="sq-opt">
                top-k duplicates
                <input
                  type="number"
                  min={1}
                  max={50}
                  placeholder="default"
                  value={bloatK}
                  onChange={(e) => setBloatK(e.target.value === "" ? "" : Number(e.target.value))}
                  style={{ width: 90 }}
                />
              </label>
            )}
            {detector === "traceability" && (
              <>
                <label className="sq-opt">
                  mode
                  <select value={traceMode} onChange={(e) => setTraceMode(e.target.value as any)}>
                    <option value="extract">extract (ID graph, free)</option>
                    <option value="classify">classify (LLM drift judge)</option>
                  </select>
                </label>
                <label className="sq-opt sq-check">
                  <input
                    type="checkbox"
                    checked={traceVerify}
                    onChange={(e) => setTraceVerify(e.target.checked)}
                  />
                  verify pass
                </label>
                <label
                  className="sq-opt sq-check"
                  title="Traceability only sees a canonical layout (PRD.md, DESIGN.md, features/*.md, ADR/*.md). This remaps each file to features/<name>.md so a flat issue export is accepted."
                >
                  <input
                    type="checkbox"
                    checked={traceRemap}
                    onChange={(e) => setTraceRemap(e.target.checked)}
                  />
                  map files → features/ layout
                </label>
              </>
            )}
            {(detector === "purpose" || detector === "leak") && (
              <>
                <label className="sq-opt sq-check">
                  <input
                    type="checkbox"
                    checked={batchMode}
                    onChange={(e) => setBatchMode(e.target.checked)}
                  />
                  run on every file
                </label>
                {!batchMode && (
                  <label className="sq-opt">
                    document
                    <select
                      value={purposeFile || docs[0]?.path || ""}
                      onChange={(e) => setPurposeFile(e.target.value)}
                    >
                      {docs.map((d) => (
                        <option key={d.path} value={d.path}>
                          {basename(d.path)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="sq-opt sq-check">
                  <input
                    type="checkbox"
                    checked={classifyDocType}
                    onChange={(e) => setClassifyDocType(e.target.checked)}
                  />
                  auto doc-type
                </label>
                {!classifyDocType && (
                  <label className="sq-opt">
                    doc-type
                    <select value={docType} onChange={(e) => setDocType(e.target.value as DocType)}>
                      {DOC_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t || "(none)"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="sq-opt">
                  gate threshold
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={gateThreshold}
                    onChange={(e) => setGateThreshold(Number(e.target.value))}
                    style={{ width: 90 }}
                  />
                </label>
                {detector === "leak" && (
                  <label className="sq-opt sq-check">
                    <input
                      type="checkbox"
                      checked={leakVerify}
                      onChange={(e) => setLeakVerify(e.target.checked)}
                    />
                    verify pass
                  </label>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── 3. Run ── */}
        <div className="sq-run">
          <button className="primary" onClick={run} disabled={busy || docs.length === 0}>
            {busy ? "Running…" : `Run ${curDet.label}`}
          </button>
          {busy && (
            <button className="chip" onClick={stop}>
              ■ Stop
            </button>
          )}
          {progress && <span className="sq-muted">{progress}</span>}
          {stopped && !busy && <span className="sq-muted">Stopped.</span>}
          {error && <span className="sq-err">{error}</span>}
        </div>
      </div>

      {/* ── Results ── */}
      {result && detector === "bloat" && <BloatView view={result} />}
      {result && detector === "traceability" && <TraceView view={result} />}
      {result && detector === "purpose" && <PurposeView view={result} />}
      {result && detector === "leak" && <GenericResult title="Leak result" view={result} />}
      {batch.length > 0 && (detector === "purpose" || detector === "leak") && (
        <BatchView detector={detector} rows={batch} />
      )}
    </div>
  );
}

/* ── Status chip ── */

function SqStatusChip({ token }: { token: string }) {
  const [state, setState] = useState<"?" | "on" | "off" | "err">("?");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    sqFetch<{ configured: boolean; base_url_set: boolean; key_set: boolean }>("/v1/status", token)
      .then((s) => {
        if (!live) return;
        setState(s.configured ? "on" : "off");
        setMsg(
          s.configured
            ? "wrapper configured"
            : `not configured (base_url ${s.base_url_set ? "✓" : "✗"}, key ${s.key_set ? "✓" : "✗"})`,
        );
      })
      .catch((e) => {
        if (!live) return;
        setState("err");
        setMsg(e?.message || "status check failed");
      });
    return () => {
      live = false;
    };
  }, [token]);
  const tone = state === "on" ? "ok" : state === "?" ? "muted" : "err";
  return (
    <span className={`sq-badge ${tone}`} title={msg}>
      {state === "on" ? "● service ready" : state === "off" ? "○ not configured" : state === "err" ? "○ unreachable" : "…"}
    </span>
  );
}

/* ── Purpose view (tailored) ── */

function MixtureBar({ mixture }: { mixture: Record<string, number> }) {
  const order = ["requirement", "design", "decision", "other"];
  const parts = order.filter((k) => (mixture?.[k] ?? 0) > 0);
  return (
    <div className="sq-mix">
      <div className="sq-mix-bar">
        {parts.map((k) => (
          <div
            key={k}
            className="sq-mix-seg"
            style={{ width: pct(mixture[k]), background: ROLE_COLORS[k] }}
            title={`${k}: ${pct(mixture[k])}`}
          />
        ))}
      </div>
      <div className="sq-mix-legend">
        {order.map((k) => (
          <span key={k} className="sq-mix-key">
            <i style={{ background: ROLE_COLORS[k] }} /> {k} {pct(mixture?.[k] ?? 0)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`sq-tile ${tone ?? ""}`}>
      <div className="sq-tile-v">{value}</div>
      <div className="sq-tile-l">{label}</div>
    </div>
  );
}

function GateBadge({ gate }: { gate: any }) {
  if (!gate) return null;
  const ok = gate.passed;
  return (
    <span className={`sq-badge ${ok ? "ok" : "err"}`} title={`threshold ${gate.threshold}`}>
      {ok ? "gate ✓ passed" : "gate ✗ failed"} · leak {pct(gate.leak_share ?? 0)} / thr{" "}
      {pct(gate.threshold ?? 0)}
    </span>
  );
}

function PurposeSections({ sections }: { sections: any[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <table className="sq-table">
      <thead>
        <tr>
          <th>Section</th>
          <th>Role</th>
          <th>Conf</th>
          <th>Tokens</th>
          <th>Lines</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((s, i) => {
          const ev: string[] = Object.values(s.evidence ?? {}).flat() as string[];
          return (
            <Fragment key={i}>
              <tr className="sq-row" onClick={() => setOpen(open === i ? null : i)}>
                <td title={s.path}>{s.leaf || s.path}</td>
                <td>
                  <span className="sq-chip" style={{ borderColor: ROLE_COLORS[s.role], color: ROLE_COLORS[s.role] }}>
                    {s.role}
                  </span>
                </td>
                <td>{s.confidence != null ? s.confidence.toFixed(2) : "—"}</td>
                <td>{s.n_tokens ?? "—"}</td>
                <td className="sq-muted">
                  {s.line_start}–{s.line_end}
                </td>
              </tr>
              {open === i && ev.length > 0 && (
                <tr>
                  <td colSpan={5} className="sq-ev">
                    {ev.map((e, j) => (
                      <div key={j}>· {e}</div>
                    ))}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function PurposeView({ view }: { view: TaskView }) {
  const r = view.result ?? {};
  return (
    <div className="card">
      <div className="card-head">
        <h2>Purpose · {basename(r.path || "")}</h2>
        <GateBadge gate={r.gate} />
      </div>
      <Warnings view={view} />
      <div className="sq-tiles">
        <Tile label="doc type" value={r.doc_type ?? "—"} />
        <Tile label="sections" value={r.n_sections ?? "—"} />
        <Tile label="tokens" value={r.n_tokens ?? "—"} />
        <Tile label="gate" value={r.gate?.passed ? "pass" : "fail"} tone={r.gate?.passed ? "ok" : "err"} />
      </div>
      {r.mixture && <MixtureBar mixture={r.mixture} />}
      {Array.isArray(r.sections) && <PurposeSections sections={r.sections} />}
      <RawJson value={view.result} />
    </div>
  );
}

/* ── Bloat view (tailored) ── */

function BloatView({ view }: { view: TaskView }) {
  const r = view.result ?? {};
  const m = r.metrics ?? {};
  const clusters: any[] = Array.isArray(r.clusters) ? r.clusters : [];
  const [onlyCross, setOnlyCross] = useState(false);
  const shown = useMemo(() => {
    const list = onlyCross ? clusters.filter((c) => c.cross_section) : clusters;
    return [...list].sort((a, b) => (b.occurrences?.length ?? 0) - (a.occurrences?.length ?? 0));
  }, [clusters, onlyCross]);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Bloat · {Array.isArray(r.paths) ? `${r.paths.length} docs` : ""}</h2>
      </div>
      <Warnings view={view} />
      <div className="sq-tiles">
        <Tile label="dup rate" value={pct(m.dup_rate ?? 0)} tone={(m.dup_rate ?? 0) > 0.15 ? "warn" : ""} />
        <Tile label="dup tokens" value={pct(m.dup_token_rate ?? 0)} />
        <Tile label="cross-section" value={pct(m.dup_cross_section_rate ?? 0)} />
        <Tile label="clusters" value={m.n_clusters ?? clusters.length} />
        <Tile label="semantic" value={m.semantic_clusters ?? "—"} />
        <Tile label="paragraphs" value={m.n_paragraphs ?? "—"} />
      </div>
      <div className="sq-opts" style={{ marginTop: 8 }}>
        <label className="sq-opt sq-check">
          <input type="checkbox" checked={onlyCross} onChange={(e) => setOnlyCross(e.target.checked)} />
          only cross-section
        </label>
        <span className="sq-muted">{shown.length} clusters</span>
      </div>
      <div className="sq-clusters">
        {shown.map((c, i) => (
          <div key={i} className="sq-cluster">
            <div className="sq-cluster-head">
              <span className="sq-badge muted">{c.source}</span>
              {c.cross_section && <span className="sq-badge warn">cross-section</span>}
              <span className="sq-muted">conf {c.confidence?.toFixed?.(2) ?? c.confidence}</span>
              <span className="sq-muted">· {c.occurrences?.length ?? 0} occurrences</span>
            </div>
            <div className="sq-cluster-text">{c.text}</div>
            <ul className="sq-occ">
              {(c.occurrences ?? []).slice(0, 8).map((o: any, j: number) => (
                <li key={j}>
                  <span className="sq-occ-file">{basename(o.file || "")}</span>
                  {o.section && <span className="sq-muted"> › {o.section}</span>}
                  {o.line != null && <span className="sq-muted"> :{o.line}</span>}
                </li>
              ))}
              {(c.occurrences?.length ?? 0) > 8 && (
                <li className="sq-muted">+ {c.occurrences.length - 8} more…</li>
              )}
            </ul>
          </div>
        ))}
      </div>
      <RawJson value={view.result} />
    </div>
  );
}

/* ── Traceability view (light-tailored, falls back to generic) ── */

function TraceView({ view }: { view: TaskView }) {
  const r = view.result ?? {};
  // Best-effort: look for a node/edge shape; otherwise render generically.
  const nodes: any[] = r.nodes || r.ids || [];
  const edges: any[] = r.edges || r.links || r.references || r.pairs || [];
  if (!Array.isArray(nodes) && !Array.isArray(edges)) {
    return <GenericResult title="Traceability result" view={view} />;
  }
  return (
    <div className="card">
      <div className="card-head">
        <h2>Traceability</h2>
      </div>
      <Warnings view={view} />
      <div className="sq-tiles">
        <Tile label="nodes" value={Array.isArray(nodes) ? nodes.length : "—"} />
        <Tile label="edges" value={Array.isArray(edges) ? edges.length : "—"} />
      </div>
      {Array.isArray(edges) && edges.length > 0 && (
        <table className="sq-table">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Kind / verdict</th>
            </tr>
          </thead>
          <tbody>
            {edges.slice(0, 300).map((e: any, i: number) => (
              <tr key={i}>
                <td>{e.from ?? e.source ?? e.src ?? e.a ?? "—"}</td>
                <td>{e.to ?? e.target ?? e.dst ?? e.b ?? "—"}</td>
                <td className="sq-muted">{e.kind ?? e.type ?? e.verdict ?? e.relation ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RawJson value={view.result} />
    </div>
  );
}

/* ── Batch view (purpose/leak over every file) ── */

function BatchView({
  detector,
  rows,
}: {
  detector: Detector;
  rows: { path: string; view?: TaskView; error?: string }[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const done = rows.filter((r) => r.view).length;
  const failed = rows.filter((r) => r.error).length;
  const gatesFailed = rows.filter((r) => r.view?.result?.gate && !r.view.result.gate.passed).length;
  return (
    <div className="card">
      <div className="card-head">
        <h2>{detector === "purpose" ? "Purpose" : "Leak"} · {rows.length} files</h2>
        <span className="sq-muted">
          {done} ok · {failed} errored · {gatesFailed} gate-fail
        </span>
      </div>
      <table className="sq-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Doc type</th>
            <th>Gate</th>
            <th>Mixture</th>
            <th>Sections</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const r = row.view?.result;
            return (
              <Fragment key={row.path}>
                <tr
                  className="sq-row"
                  onClick={() => setOpen(open === row.path ? null : row.path)}
                >
                  <td title={row.path}>{basename(row.path)}</td>
                  <td>{r?.doc_type ?? (row.error ? "—" : "…")}</td>
                  <td>
                    {row.error ? (
                      <span className="sq-badge err">error</span>
                    ) : r?.gate ? (
                      <span className={`sq-badge ${r.gate.passed ? "ok" : "err"}`}>
                        {r.gate.passed ? "✓" : "✗"}
                      </span>
                    ) : (
                      "…"
                    )}
                  </td>
                  <td style={{ minWidth: 160 }}>{r?.mixture && <MiniMix mixture={r.mixture} />}</td>
                  <td>{r?.n_sections ?? "—"}</td>
                </tr>
                {open === row.path && (
                  <tr>
                    <td colSpan={5}>
                      {row.error ? (
                        <span className="sq-err">{row.error}</span>
                      ) : row.view ? (
                        detector === "purpose" ? (
                          <PurposeInline view={row.view} />
                        ) : (
                          <RawJson value={row.view.result} open />
                        )
                      ) : null}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PurposeInline({ view }: { view: TaskView }) {
  const r = view.result ?? {};
  return (
    <div className="sq-inline">
      {r.mixture && <MixtureBar mixture={r.mixture} />}
      {Array.isArray(r.sections) && <PurposeSections sections={r.sections} />}
    </div>
  );
}

function MiniMix({ mixture }: { mixture: Record<string, number> }) {
  const order = ["requirement", "design", "decision", "other"];
  return (
    <div className="sq-mix-bar mini">
      {order
        .filter((k) => (mixture?.[k] ?? 0) > 0)
        .map((k) => (
          <div
            key={k}
            className="sq-mix-seg"
            style={{ width: pct(mixture[k]), background: ROLE_COLORS[k] }}
            title={`${k}: ${pct(mixture[k])}`}
          />
        ))}
    </div>
  );
}

/* ── Generic result (leak, and any unknown shape) ── */

function GenericResult({ title, view }: { title: string; view: TaskView }) {
  const r = view.result ?? {};
  const scalars = Object.entries(r).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  const arrays = Object.entries(r).filter(([, v]) => Array.isArray(v)) as [string, any[]][];
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {r.gate && <GateBadge gate={r.gate} />}
      </div>
      <Warnings view={view} />
      {scalars.length > 0 && (
        <div className="sq-tiles">
          {scalars.map(([k, v]) => (
            <Tile key={k} label={k} value={String(v)} />
          ))}
        </div>
      )}
      {arrays.map(([k, v]) => (
        <ArrayTable key={k} name={k} items={v} />
      ))}
      <RawJson value={view.result} />
    </div>
  );
}

function ArrayTable({ name, items }: { name: string; items: any[] }) {
  if (items.length === 0) return null;
  if (typeof items[0] !== "object" || items[0] === null) {
    return (
      <div className="sq-arr">
        <div className="sq-section-title">
          {name} ({items.length})
        </div>
        <div className="sq-muted">{items.slice(0, 40).map((x) => String(x)).join(", ")}</div>
      </div>
    );
  }
  const colSet = new Set<string>();
  for (const it of items.slice(0, 10)) {
    Object.keys(it as Record<string, unknown>).forEach((k) => colSet.add(k));
  }
  const cols: string[] = Array.from(colSet).slice(0, 6);
  const cell = (v: any) =>
    v == null
      ? "—"
      : typeof v === "object"
        ? Array.isArray(v)
          ? `[${v.length}]`
          : "{…}"
        : String(v);
  return (
    <div className="sq-arr">
      <div className="sq-section-title">
        {name} ({items.length})
      </div>
      <table className="sq-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 200).map((it, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} title={typeof it[c] === "object" ? JSON.stringify(it[c]) : ""}>
                  {cell(it[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Shared bits ── */

function Warnings({ view }: { view: TaskView }) {
  if (!view.warnings || view.warnings.length === 0) return null;
  return (
    <div className="sq-warn">
      {view.warnings.map((w, i) => (
        <div key={i}>⚠ {w}</div>
      ))}
    </div>
  );
}

function RawJson({ value, open = false }: { value: unknown; open?: boolean }) {
  const [show, setShow] = useState(open);
  return (
    <div className="sq-raw">
      <button className="chip" onClick={() => setShow((s) => !s)}>
        {show ? "Hide raw JSON" : "Show raw JSON"}
      </button>
      {show && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

/* ── Scoped styles ── */

function SqStyles() {
  return (
    <style>{`
.sq h2 { margin: 0; font-size: 17px; }
.sq .sq-section { margin-top: 18px; }
.sq .sq-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted-foreground); margin-bottom: 8px; }
.sq .sq-muted { color: var(--muted-foreground); font-size: 12.5px; }
.sq .sq-err { color: var(--destructive); font-size: 13px; }
.sq code { background: var(--accent); color: var(--primary); padding: 1px 5px; border-radius: 5px; font-size: 12px; }

.sq .sq-drop { border: 1px dashed var(--border); border-radius: 12px; padding: 12px; }
.sq .sq-drop-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sq .sq-files { list-style: none; margin: 10px 0 0; padding: 0; max-height: 220px; overflow: auto; }
.sq .sq-files li { display: flex; align-items: center; gap: 10px; padding: 4px 6px; border-radius: var(--radius-md); }
.sq .sq-files li:hover { background: var(--accent); }
.sq .sq-files li.excluded { opacity: .5; }
.sq .sq-file-path { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sq .sq-x { border: none; background: none; color: var(--muted-foreground); cursor: pointer; }
.sq .sq-x:hover { color: var(--destructive); }

.sq .sq-tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
.sq .sq-tab { text-align: left; border: 1px solid var(--border); background: var(--card); border-radius: 10px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
.sq .sq-tab.on { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent); }
.sq .sq-tab-label { font-weight: 600; font-size: 13.5px; }
.sq .sq-tab-dot { color: var(--success); font-size: 9px; margin-left: 6px; vertical-align: middle; }
.sq .sq-tab-blurb { font-size: 11.5px; color: var(--muted-foreground); }

.sq .sq-opts { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; margin-top: 12px; }
.sq .sq-opt { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted-foreground); }
.sq .sq-opt.sq-check { flex-direction: row; align-items: center; gap: 6px; color: var(--foreground); font-size: 13px; }
.sq .sq-opt select, .sq .sq-opt input[type=number] { font-size: 13px; }

.sq .sq-run { display: flex; align-items: center; gap: 12px; margin-top: 18px; }

.sq .sq-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin: 6px 0 14px; }
.sq .sq-tile { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--card); }
.sq .sq-tile-v { font-size: 20px; font-weight: 650; }
.sq .sq-tile-l { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted-foreground); margin-top: 2px; }
.sq .sq-tile.warn .sq-tile-v { color: var(--warning); }
.sq .sq-tile.ok .sq-tile-v { color: var(--success); }
.sq .sq-tile.err .sq-tile-v { color: var(--destructive); }

.sq .sq-mix { margin: 6px 0 16px; }
.sq .sq-mix-bar { display: flex; height: 16px; border-radius: var(--radius-md); overflow: hidden; background: var(--border); }
.sq .sq-mix-bar.mini { height: 10px; }
.sq .sq-mix-seg { height: 100%; }
.sq .sq-mix-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; }
.sq .sq-mix-key { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted-foreground); }
.sq .sq-mix-key i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

.sq .sq-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
.sq .sq-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted-foreground); border-bottom: 1px solid var(--border); padding: 6px 8px; }
.sq .sq-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.sq .sq-row { cursor: pointer; }
.sq .sq-row:hover td { background: var(--accent); }
.sq .sq-ev { background: var(--accent); font-size: 12px; color: var(--foreground); }
.sq .sq-chip { border: 1px solid var(--border); border-radius: 20px; padding: 1px 9px; font-size: 11.5px; }

.sq .sq-badge { border-radius: 20px; padding: 2px 10px; font-size: 12px; border: 1px solid var(--border); white-space: nowrap; }
.sq .sq-badge.ok { background: var(--success-soft); color: var(--success); border-color: color-mix(in oklab, var(--success) 35%, var(--card)); }
.sq .sq-badge.err { background: var(--destructive-soft); color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 35%, var(--card)); }
.sq .sq-badge.warn { background: var(--warning-soft); color: var(--warning); border-color: color-mix(in oklab, var(--warning) 35%, var(--card)); }
.sq .sq-badge.muted { color: var(--muted-foreground); }

.sq .sq-clusters { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.sq .sq-cluster { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.sq .sq-cluster-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sq .sq-cluster-text { font-size: 12.5px; margin: 8px 0; padding: 8px 10px; background: var(--background); border-radius: var(--radius-md); white-space: pre-wrap; word-break: break-word; max-height: 96px; overflow: auto; }
.sq .sq-occ { list-style: none; margin: 0; padding: 0; font-size: 12px; }
.sq .sq-occ li { padding: 2px 0; }
.sq .sq-occ-file { font-weight: 600; }

.sq .sq-warn { background: var(--warning-soft); color: var(--warning); border-radius: var(--radius-lg); padding: 8px 10px; font-size: 12.5px; margin-bottom: 10px; }
.sq .sq-raw { margin-top: 12px; }
/* The raw payload reads as content, not as an editor: it follows the theme on
   --muted with the product's mono face, rather than staying a dark slab inside
   a light page. The IDE keeps its own colours; this is a JSON dump. */
.sq .sq-raw pre { background: var(--muted); color: var(--foreground); font-family: var(--font-mono); padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: auto; max-height: 360px; font-size: 12px; margin-top: 8px; }
.sq .sq-arr { margin-top: 14px; }
.sq .sq-inline { padding: 8px 0; }
`}</style>
  );
}
