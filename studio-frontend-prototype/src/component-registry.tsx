/* ── The organization's component registry (ADR-0041) ─────────────────────
 *
 * Every component the organization's projects declare, wherever it is
 * declared: a `gear.toml` or `gear.gdl` directory, a `#[toolkit::gear]`
 * attribute, a FrontX package, a kit manifest. The sync walks every project
 * of the organization that is not excluded, and keeps what it finds, so this
 * page is the answer to "what components do we have" between page loads.
 *
 * The states past "declared in a project" are moved by people (phase 2): an
 * organization administrator registers, rejects, deprecates, restores,
 * publishes, merges or edits an entry from its expanded row, and every move
 * is recorded with who, when and why. Everyone else reads.
 *
 * Phase 3 adds candidates: code the walk found that looks like a gear and is
 * not declared one, with its evidence and score, in a Candidates view. Declare
 * it opens a pull request adding the candidate's manifest: the Gearbox
 * engine's gear.gdl when the engine is configured, else a gear.toml.
 *
 * Phase 4 (ADR-0041 P4, ADR-0042 §4): Publish opens a pull request giving the
 * gear to the platform (pending until the platform's catalogue has it), each
 * entry says which projects use it, and Suggest asks a model -- on the
 * caller's own key -- for a description, category and capabilities that an
 * Apply turns into an edit. */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, api, type CatalogNode } from "./api";
import type {
  RegistryDecisionInput,
  RegistryDeclareResult,
  RegistryEntry,
  RegistryExtractPreview,
  RegistryProjectWalk,
  RegistryReadiness,
  RegistrySuggestion,
} from "./api";
import { DataTable, type Column } from "./data-table";
import { errText } from "./format";
import { occurrencePlace } from "./org-gear-repository";
import {
  ACTION_LABEL,
  READINESS_LABEL,
  STATE_LABEL,
  STATE_TONE,
  allowedActions,
  candidateWhere,
  candidatesOf,
  consumerLine,
  consumersLabel,
  declareRefusal,
  decisionLine,
  decisionRefusal,
  decisionTargets,
  deprecationImpact,
  detectedProjects,
  evidenceLines,
  extractPreviewLines,
  extractionLine,
  extractionOpen,
  isDuplicated,
  isOrphaned,
  ownerLabel,
  projectsOf,
  publicationPending,
  publishStatus,
  readinessHeadline,
  readinessRefusal,
  registryProjects,
  stateCounts,
  suggestRefusal,
  spotLabel,
  suggestionEdit,
  walkLine,
} from "./registry";
import type { RegistryAction } from "./registry";
import { useDomainRefresh } from "./domain-live";

export function ComponentRegistry({
  token,
  projects,
  onOpenComponent,
  isPlatformAdmin = false,
  catalogue = [],
  catalogueCell,
}: {
  token: string;
  /** The organization's projects, for choosing which ones the walk reads. */
  projects: { id: string; name: string }[];
  /** Open a published component's page. */
  onOpenComponent?: (name: string) => void;
  /** What the organization's catalogue holds — published crates, kits — laid
   *  beside what its projects declare, so one list answers what the
   *  organization builds and how far each thing got. */
  catalogue?: CatalogNode[];
  /** The catalogue's own cell for a column, reused rather than redrawn. */
  catalogueCell?: (column: "release" | "downloads" | "activity", node: CatalogNode) => ReactNode;
  /** A platform administrator may mark a contributed entry published by hand. */
  isPlatformAdmin?: boolean;
}) {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [excluded, setExcluded] = useState<string[] | null>(null);
  /** What the last walk saw of each project. */
  const [walks, setWalks] = useState<RegistryProjectWalk[]>([]);
  const [sync, setSync] = useState("");
  const [busy, setBusy] = useState(false);
  /** Every component, or only the candidates (ADR-0041 P3). */
  const [view, setView] = useState<"all" | "candidates">("all");

  const load = async () => {
    setError(null);
    try {
      const [list, ex, walked] = await Promise.all([
        api.componentRegistry(token),
        api.registryExcludedProjects(token).catch(() => ({ project_ids: [] as string[] })),
        api.registryProjects(token).catch(() => ({ items: [] as RegistryProjectWalk[], total: 0 })),
      ]);
      setEntries(list.items);
      setExcluded(ex.project_ids);
      setWalks(walked.items);
    } catch (cause) {
      // A backend from before the registry answers 404: say so plainly.
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errText(cause));
    }
  };
  useDomainRefresh(["registry-entry","registry-occurrence","registry-decision","registry-settings","registry-read"], load);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** The people a decision can name as owner, and who decided: the caller's
   *  colleagues and the caller. Best effort -- without them an id is shown. */
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api.myColleagues(token).catch(() => []),
      api.myProfile(token).catch(() => null),
    ]).then(([colleagues, me]) => {
      if (!live) return;
      const out = new Map<string, string>();
      if (me) out.set(me.id, me.display_name || me.email || me.id);
      for (const c of colleagues) if (!out.has(c.user_id)) out.set(c.user_id, c.display_name || c.user_id);
      setPeople([...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => {
      live = false;
    };
  }, [token]);
  const names = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p.name])), [people]);

  /** Read every project again now, rather than waiting for the schedule. */
  const readNow = async () => {
    setBusy(true);
    setSync("queued…");
    try {
      const { run_id } = await api.syncComponents(token);
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const t = await api.componentsCatalogTask(token, run_id);
        if (t.status === "succeeded") {
          setSync("");
          await load();
          break;
        }
        if (t.status === "failed" || t.status === "cancelled") {
          setSync(t.message || `sync ${t.status}`);
          break;
        }
        setSync((t.message || t.status).replace(/…$/, "") + "…");
        if (Date.now() > deadline) {
          setSync("still running on the server");
          break;
        }
      }
    } catch (cause) {
      setSync(errText(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleProject = async (id: string) => {
    const next = (excluded ?? []).includes(id) ? (excluded ?? []).filter((x) => x !== id) : [...(excluded ?? []), id];
    setExcluded(next);
    try {
      await api.saveRegistryExcludedProjects(token, next);
    } catch (cause) {
      setError(errText(cause));
    }
  };

  const rows = useMemo(() => componentRows(entries ?? [], catalogue), [entries, catalogue]);
  const counts = useMemo(() => stateCounts(entries ?? []), [entries]);
  const seen = useMemo(() => registryProjects(entries ?? []), [entries]);
  const duplicated = (entries ?? []).filter(isDuplicated).length;
  const walkOf = (id: string) => walks.find((w) => w.project_id === id);
  const unreadable = projects.filter((p) => !(excluded ?? []).includes(p.id) && walkLine(walkOf(p.id)).failed);
  const orphaned = (entries ?? []).filter(isOrphaned).length;

  if (missing) {
    return (
      <div className="card">
        <h2>Registry</h2>
        <p className="empty">This backend has no component registry yet (ADR-0041).</p>
      </div>
    );
  }

  return (
    <div className="card" data-component-registry>
      <div className="card-head">
        <div>
          <h2>Components</h2>
          <p className="subtitle">
            What the organization builds, one row each: what its projects declare — a <code>gear.toml</code> or{" "}
            <code>gear.gdl</code>, a <code>#[toolkit::gear]</code> attribute, a FrontX package or a kit manifest —
            the code that could become a gear, and what it has published. Read from every project on a schedule,
            after a push, or now.
          </p>
        </div>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {sync && <span className="hint" style={{ fontSize: 12 }}>{sync}</span>}
          <button className="primary" disabled={busy} onClick={() => void readNow()}>
            {busy ? "Reading…" : "Read the projects now"}
          </button>
        </span>
      </div>
      {error && <div className="error">{error}</div>}

      {entries === null ? (
        <p className="empty">Reading the registry…</p>
      ) : (
        <>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            <b>
              {rows.length} component{rows.length === 1 ? "" : "s"}
            </b>
            {rows.length > entries.length && ` · ${rows.length - entries.length} published that no project declares`}
            {duplicated > 0 && ` · ${duplicated} declared in more than one repository`}
            {orphaned > 0 && ` · ${orphaned} no repository declares any more`}
          </p>
          {unreadable.length > 0 && (
            <div className="error" style={{ fontSize: 12, margin: "0 0 8px" }} data-registry-unreadable>
              <b>
                {unreadable.length} project{unreadable.length === 1 ? "" : "s"} could not be read
              </b>{" "}
              — {unreadable.map((p) => p.name).join(", ")}. {walkLine(walkOf(unreadable[0].id)).hint ?? "See the projects below."}
            </div>
          )}
          {((counts.candidate ?? 0) > 0 || orphaned > 0 || view === "candidates") && (
            <div className="reg-decide" role="group" aria-label="Needs a decision">
              <span className="sub">Needs a decision:</span>
              {view === "candidates" ? (
                <button type="button" className="primary" onClick={() => setView("all")}>
                  ← Every component
                </button>
              ) : (
                (counts.candidate ?? 0) > 0 && (
                  <button type="button" onClick={() => setView("candidates")} data-registry-candidates-tab>
                    <b>{counts.candidate}</b> could become a gear — decide
                  </button>
                )
              )}
              {orphaned > 0 && view !== "candidates" && (
                <span className="sub">
                  · <b>{orphaned}</b> no repository declares any more
                </span>
              )}
            </div>
          )}
          {view === "candidates" ? (
            <CandidatesView token={token} entries={entries} people={people} names={names} onDecided={() => void load()} />
          ) : (
          <>
          <DataTable<ComponentRow>
            list="org-components"
            urlPrefix="comp."
            rows={rows}
            rowKey={(r) => r.key}
            rowLabel={(r) => r.name}
            onOpen={onOpenComponent ? (r) => r.node && onOpenComponent(String(r.node.value.name ?? r.name)) : undefined}
            canOpen={(r) => !!r.node}
            search={{ placeholder: "Search names, descriptions, paths" }}
            searchText={(r) => [r.name, r.description, ...(r.entry?.occurrences ?? []).map((o) => o.path)]}
            filters={[
              {
                id: "state",
                allLabel: "Every state",
                kind: "chips",
                options: ROW_STATES.filter((st) => rows.some((r) => r.state === st)).map((st) => ({
                  value: st,
                  label: STATE_LABEL[st] ?? st,
                })),
                match: (r, v) => r.state === v,
              },
              {
                id: "kind",
                allLabel: "Every type",
                kind: "select",
                options: [...new Set(rows.map((r) => r.kind).filter(Boolean))].sort().map((k) => ({ value: k, label: k })),
                match: (r, v) => r.kind === v,
              },
              {
                id: "project",
                allLabel: "Every project",
                kind: "select",
                options: seen.map((pr) => ({ value: pr.id, label: pr.name })),
                match: (r, v) => (r.entry?.occurrences ?? []).some((o) => o.project_id === v),
              },
            ]}
            empty={{
              title: entries.length === 0 ? "Nothing read yet." : "No component matches.",
              body: entries.length === 0 ? "Read the projects now, or wait for the schedule." : undefined,
            }}
            columns={componentColumns(catalogueCell, catalogue.length > 0)}
            expand={(r) =>
              r.entry ? (
                <EntryDetail
                  token={token}
                  entry={r.entry}
                  entries={entries}
                  people={people}
                  names={names}
                  onDecided={() => void load()}
                  onOpenComponent={r.node ? onOpenComponent : undefined}
                  isPlatformAdmin={isPlatformAdmin}
                />
              ) : (
                <div className="reg-detail" style={{ fontSize: 12 }}>
                  Published, and no project of the organization declares it: it is read from the organization&apos;s
                  repositories.{" "}
                  {onOpenComponent && r.node && (
                    <button type="button" className="linklike" onClick={() => onOpenComponent(String(r.node!.value.name ?? r.name))}>
                      Open its page →
                    </button>
                  )}
                </div>
              )
            }
          />
          </>
          )}

          <details style={{ marginTop: 12, fontSize: 13 }}>
            <summary style={{ cursor: "pointer" }}>
              Projects the registry reads ({projects.length - (excluded ?? []).filter((id) => projects.some((p) => p.id === id)).length} of{" "}
              {projects.length})
            </summary>
            <p className="hint" style={{ fontSize: 12 }}>
              Every project is read unless it is excluded here: a registry with gaps nobody chose is what
              this page is for.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {projects.map((p) => {
                const line = walkLine(walkOf(p.id));
                const off = (excluded ?? []).includes(p.id);
                return (
                  <li key={p.id} style={{ margin: "3px 0" }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!off}
                        disabled={excluded === null}
                        onChange={() => void toggleProject(p.id)}
                      />{" "}
                      {p.name}
                    </label>{" "}
                    <span style={{ fontSize: 12, opacity: off ? 0.5 : 0.75, color: line.failed && !off ? "var(--danger, #c33)" : undefined }}>
                      {off ? "excluded" : line.text}
                    </span>
                    {line.hint && !off && <div style={{ fontSize: 12, opacity: 0.8, marginLeft: 22 }}>{line.hint}</div>}
                  </li>
                );
              })}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

/** One component's registry entry, opened under its row: why it looks like a
 *  gear, who owns it, where it is declared, what was contributed or extracted,
 *  and the decisions it allows. */
function EntryDetail({
  token,
  entry: e,
  entries,
  people,
  names,
  onDecided,
  onOpenComponent,
  isPlatformAdmin = false,
}: {
  token: string;
  entry: RegistryEntry;
  entries: RegistryEntry[];
  people: { id: string; name: string }[];
  names: Record<string, string>;
  onDecided: () => void;
  onOpenComponent?: (name: string) => void;
  isPlatformAdmin?: boolean;
}) {
  return (
    <div className="reg-detail" style={{ fontSize: 12 }}>
      {e.state === "candidate" && (
        <div data-registry-evidence>
          <b>Looks like a gear</b> (score {e.score ?? 0}):
          <ul style={{ margin: "2px 0 4px", paddingLeft: 18 }}>
            {evidenceLines(e).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <DeclareCandidate token={token} entry={e} onDeclared={onDecided} />
        </div>
      )}
      {e.capabilities.length > 0 && (
        <div>
          <b>Capabilities:</b> {e.capabilities.join(", ")}
        </div>
      )}
      <div>
        <b>Owner:</b> {ownerLabel(e.owner) ?? <span style={{ opacity: 0.6 }}>nobody yet</span>}
      </div>
      {e.category && (
        <div>
          <b>Category:</b> {e.category}
        </div>
      )}
      {(e.aliases ?? []).length > 0 && (
        <div>
          <b>Also found as:</b> {(e.aliases ?? []).join(", ")}
        </div>
      )}
      {e.state === "merged" && e.merged_into && (
        <div>
          <b>Merged into</b> {e.merged_into}: what is found under this name is recorded there.
        </div>
      )}
      {e.state === "deprecated" && (
        <div>
          <b>Deprecated</b>
          {e.replaced_by ? ` — use ${e.replaced_by} instead.` : ": no longer to be chosen."}
        </div>
      )}
      {e.state === "published" && e.version && (
        <div>
          <b>Published version:</b> {e.version}
        </div>
      )}
      {e.contribution && (
        <div data-registry-contribution>
          <b>{e.state === "published" ? "Contributed" : "Contribution PR opened"}:</b>{" "}
          {e.contribution.pr_url ? (
            <a href={e.contribution.pr_url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
              {e.contribution.pr_url}
            </a>
          ) : (
            <code>{e.contribution.branch}</code>
          )}{" "}
          <span style={{ opacity: 0.7 }}>
            — {e.contribution.files} file{e.contribution.files === 1 ? "" : "s"} into <code>{e.contribution.repo}</code> at{" "}
            <code>{e.contribution.path}</code>
            {e.state !== "published" && "; published once the platform's catalogue has it"}
          </span>
        </div>
      )}
      {(e.consumers ?? []).length > 0 && (
        <div data-registry-consumers>
          <b>{consumersLabel(e)}:</b> {(e.consumers ?? []).map(consumerLine).join(", ")}
        </div>
      )}
      <SuggestDescription token={token} entry={e} onApplied={onDecided} />
      {e.extraction && (
        <div data-registry-extraction>
          <b>{extractionLine(e.extraction)}</b>
          <div style={{ opacity: 0.8 }}>
            {[
              ["into the gear repository", e.extraction.gear_pr_url],
              ["into the project", e.extraction.source_pr_url],
            ].map(([what, url]) =>
              url ? (
                <span key={what ?? ""} style={{ marginRight: 8 }}>
                  <a href={url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                    pull request {what}
                  </a>
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
      <ExtractReadiness token={token} entry={e} onChanged={onDecided} />
      <div style={{ marginTop: 4 }}>
        <b>Found in</b>
      </div>
      <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
        {e.occurrences.map((o) => (
          <li key={`${o.repo}:${o.path}`}>
            {occurrencePlace(o)} · <code>{o.repo}</code>
            {o.git_ref ? `@${o.git_ref}` : ""} · <code>{o.path}</code> · {o.declared_in}
            {o.commit ? <span style={{ opacity: 0.6 }}> · {o.commit.slice(0, 7)}</span> : null}
          </li>
        ))}
      </ul>
      {(e.first_seen || e.last_seen) && (
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          {e.first_seen && `first seen ${new Date(e.first_seen).toLocaleDateString()}`}
          {e.last_seen && ` · last read ${new Date(e.last_seen).toLocaleString()}`}
        </div>
      )}
      {onOpenComponent && (
        <button type="button" className="linklike" style={{ marginTop: 6 }} onClick={() => onOpenComponent(e.name)}>
          Open in the catalogue →
        </button>
      )}
      <RegistryDecisions
        token={token}
        entry={e}
        entries={entries}
        people={people}
        names={names}
        onDecided={onDecided}
        isPlatformAdmin={isPlatformAdmin}
      />
    </div>
  );
}

/** Code that looks like a gear, strongest first, with why and what to do
 *  about it: Declare it, or the decisions a candidate allows (register,
 *  reject, merge, edit). */
function CandidatesView({
  token,
  entries,
  people,
  names,
  onDecided,
}: {
  token: string;
  entries: RegistryEntry[];
  people: { id: string; name: string }[];
  names: Record<string, string>;
  onDecided: () => void;
}) {
  const candidates = useMemo(() => candidatesOf(entries), [entries]);
  const [open, setOpen] = useState<string | null>(null);
  if (candidates.length === 0) {
    return (
      <p className="empty" data-registry-candidates>
        No candidates: nothing in the projects&apos; code looks like a gear that is not declared one.
      </p>
    );
  }
  return (
    <div data-registry-candidates>
      <p className="hint" style={{ fontSize: 12, margin: "0 0 6px" }}>
        Modules and crates that look like gears — their own REST surface, tables, types, a port or an SDK,
        other code using them, copies in other projects — and are not declared one. Strongest first.
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {candidates.map((e) => (
          <li key={e.name} style={{ borderTop: "1px solid var(--border, rgba(0,0,0,0.1))", padding: "6px 0" }}>
            <div
              style={{ display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer", flexWrap: "wrap" }}
              onClick={() => setOpen(open === e.name ? null : e.name)}
              aria-expanded={open === e.name}
            >
              <b>{e.name}</b>
              <span className="badge info" title="The sum of its evidence's weights">
                score {e.score ?? 0}
              </span>
              <span style={{ fontSize: 12, opacity: 0.75 }}>{candidateWhere(e)}</span>
            </div>
            {e.description && <div style={{ fontSize: 12, opacity: 0.75 }}>{e.description}</div>}
            <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {evidenceLines(e).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {open === e.name ? (
              <div style={{ fontSize: 12 }}>
                <DeclareCandidate token={token} entry={e} onDeclared={onDecided} />
                <RegistryDecisions token={token} entry={e} entries={entries} people={people} names={names} onDecided={onDecided} />
              </div>
            ) : (
              <button type="button" className="linklike" style={{ fontSize: 12 }} onClick={() => setOpen(e.name)}>
                Declare it, register or reject…
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A project's candidate, as its Components tab offers it ("could become a
 *  gear"): the registry's evidence for it, and Declare it for this project's
 *  occurrence. */
export function ProjectCandidate({ token, name, projectId }: { token: string; name: string; projectId: string }) {
  const [entry, setEntry] = useState<RegistryEntry | null>(null);
  useEffect(() => {
    let live = true;
    api
      .registryEntry(token, name)
      .then((e) => live && setEntry(e))
      .catch(() => live && setEntry(null));
    return () => {
      live = false;
    };
  }, [token, name]);
  if (!entry || entry.state !== "candidate") return null;
  return (
    <div style={{ marginTop: 4 }} data-project-candidate>
      <b>Why it looks like a gear</b> (score {entry.score ?? 0}):
      <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
        {evidenceLines(entry).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <DeclareCandidate token={token} entry={entry} projectId={projectId} />
    </div>
  );
}

/** Declare it (ADR-0041 P3): preview the files a pull request would add
 *  beside the candidate's code, then open it. The entry stays a candidate
 *  until the registry reads the merged declaration. */
export function DeclareCandidate({
  token,
  entry,
  projectId,
  onDeclared,
}: {
  token: string;
  /** The candidate; only its name and occurrences are read. */
  entry: Pick<RegistryEntry, "name" | "occurrences">;
  /** Declare the occurrence in this project, when the candidate is in several. */
  projectId?: string;
  onDeclared?: () => void;
}) {
  const [preview, setPreview] = useState<RegistryDeclareResult | null>(null);
  const [done, setDone] = useState<RegistryDeclareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const inProjects = detectedProjects(entry);
  const project = projectId ?? (inProjects.length > 1 ? inProjects[0] : undefined);

  const run = async (dry: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.declareRegistry(token, entry.name, {
        dry_run: dry,
        project_id: project,
        description: description.trim() || undefined,
      });
      if (dry) setPreview(result);
      else {
        setDone(result);
        setPreview(null);
        onDeclared?.();
      }
    } catch (cause) {
      setError(declareRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{ margin: "6px 0" }} data-declare-done>
        <b>Pull request opened</b> on <code>{done.branch}</code> in <code>{done.repo}</code>
        {done.pr_url ? (
          <>
            {" "}
            —{" "}
            <a href={done.pr_url} target="_blank" rel="noreferrer">
              {done.pr_url}
            </a>
          </>
        ) : null}
        . Once it is merged, the registry reads it as declared.
      </div>
    );
  }
  return (
    <div style={{ margin: "6px 0" }} data-declare-candidate>
      {!preview ? (
        <button type="button" disabled={busy} onClick={() => void run(true)}>
          {busy ? "Preparing…" : "Declare it…"}
        </button>
      ) : (
        <div style={{ display: "grid", gap: 6, maxWidth: 680 }}>
          <div>
            A pull request on <code>{preview.branch}</code> in <code>{preview.repo}</code> adds
            {preview.manifest ? (
              <>
                {" "}
                its <code>{preview.manifest}</code>
              </>
            ) : null}{" "}
            beside <code>{preview.path}</code>:
          </div>
          {preview.files.map((f) => (
            <div key={f.path}>
              <code>{f.path}</code>
              <pre style={{ margin: "2px 0", padding: 6, fontSize: 11, overflowX: "auto", background: "var(--muted, rgba(0,0,0,0.04))" }}>
                {f.content}
              </pre>
            </div>
          ))}
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <b>Description</b>
            <input
              value={description}
              onChange={(ev) => setDescription(ev.target.value)}
              placeholder="optional: what this gear does"
              aria-label="Description"
              style={{ flex: 1 }}
            />
          </label>
          <span>
            <button type="button" className="primary" disabled={busy} onClick={() => void run(false)}>
              {busy ? "Opening…" : "Open the pull request"}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => void run(true)}>
              Preview again
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {error && (
        <div className="error" style={{ fontSize: 12 }} data-declare-error>
          {error}
        </div>
      )}
    </div>
  );
}

/** An entry's decisions history and the moves its state allows. Anyone may
 *  read the history; only an organization administrator's move is accepted,
 *  and anyone else is told so by the server's 403. */
function RegistryDecisions({
  token,
  entry: e,
  entries,
  people,
  names,
  onDecided,
  isPlatformAdmin = false,
}: {
  token: string;
  entry: RegistryEntry;
  entries: RegistryEntry[];
  people: { id: string; name: string }[];
  names: Record<string, string>;
  onDecided: () => void;
  isPlatformAdmin?: boolean;
}) {
  const [detail, setDetail] = useState<RegistryEntry | null>(null);
  const [form, setForm] = useState<RegistryAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ownerKind, setOwnerKind] = useState<"person" | "team">(e.owner?.kind ?? "person");
  const [ownerId, setOwnerId] = useState(e.owner?.id ?? "");
  const [ownerName, setOwnerName] = useState(e.owner?.name ?? "");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [version, setVersion] = useState("");
  const [kind, setKind] = useState(e.kind);
  const [category, setCategory] = useState(e.category ?? "");
  const [capabilities, setCapabilities] = useState(e.capabilities.join(", "));
  const [description, setDescription] = useState(e.description ?? "");

  useEffect(() => {
    let live = true;
    api
      .registryEntry(token, e.name)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [token, e.name, e.state]);

  const targets = useMemo(() => decisionTargets(entries, e.name), [entries, e.name]);
  const decisions = detail?.decisions ?? [];
  // Asked of the platform and not answered yet (ADR-0042 §4).
  const requested = publicationPending(decisions);

  const open = (action: RegistryAction) => {
    setError(null);
    setForm(form === action ? null : action);
  };

  const submit = async () => {
    if (!form) return;
    const input: RegistryDecisionInput = { action: form };
    const owner = () =>
      ownerName.trim()
        ? { kind: ownerKind, id: ownerKind === "person" ? ownerId || null : null, name: ownerName.trim() }
        : undefined;
    if (form === "register" || form === "edit") {
      input.owner = owner();
      if (form === "edit") {
        input.kind = kind.trim() || undefined;
        input.category = category.trim() || null;
        input.description = description.trim() || null;
      } else if (category.trim()) {
        input.category = category.trim();
      }
      input.capabilities = capabilities
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    }
    if (reason.trim()) input.reason = reason.trim();
    if (form === "deprecate" && target) input.replaced_by = target;
    if (form === "merge") input.merge_into = target;
    if ((form === "mark_published" || form === "request_publication") && version.trim()) input.version = version.trim();
    setBusy(true);
    setError(null);
    try {
      const after = await api.decideRegistry(token, e.name, input);
      setDetail(after);
      setForm(null);
      setReason("");
      setTarget("");
      onDecided();
    } catch (cause) {
      setError(decisionRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };

  const ownerFields = (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <b>Owner</b>
      <select value={ownerKind} onChange={(ev) => setOwnerKind(ev.target.value as "person" | "team")} aria-label="Owner kind">
        <option value="person">person</option>
        <option value="team">team</option>
      </select>
      {ownerKind === "person" && people.length > 0 ? (
        <select
          value={ownerId}
          aria-label="Owner"
          onChange={(ev) => {
            setOwnerId(ev.target.value);
            setOwnerName(people.find((p) => p.id === ev.target.value)?.name ?? "");
          }}
        >
          <option value="">choose a person…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          placeholder={ownerKind === "person" ? "Person's name" : "Team name"}
          value={ownerName}
          onChange={(ev) => {
            setOwnerName(ev.target.value);
            setOwnerId("");
          }}
          aria-label="Owner name"
        />
      )}
    </div>
  );

  const targetSelect = (label: string, required: boolean) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <b>{label}</b>
      <select value={target} onChange={(ev) => setTarget(ev.target.value)} aria-label={label}>
        <option value="">{required ? "choose an entry…" : "none"}</option>
        {targets.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );

  const ready =
    form === "register"
      ? ownerName.trim() !== ""
      : form === "reject"
        ? reason.trim() !== ""
        : form === "merge"
          ? target !== ""
          : true;

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--border, rgba(0,0,0,0.1))", paddingTop: 6 }} data-registry-decisions>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <b>Decide</b>
        {allowedActions(e.state, {
          curator: isPlatformAdmin,
          publicationPending: requested || !!e.contribution,
        }).map((a) => (
          <button key={a} type="button" className={form === a ? "primary" : ""} onClick={() => open(a)} disabled={busy}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {requested && !e.contribution && (
        <div className="hint" data-registry-publication-requested>
          Publication requested: waiting for a platform curator to publish it into the platform&apos;s gear repository,
          or to decline it.
        </div>
      )}
      {form && (
        <div style={{ display: "grid", gap: 6, margin: "6px 0", maxWidth: 560 }}>
          {(form === "register" || form === "edit") && ownerFields}
          {(form === "register" || form === "edit") && (
            <>
              {form === "edit" && (
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b>Kind</b>
                  <input value={kind} onChange={(ev) => setKind(ev.target.value)} aria-label="Kind" />
                </label>
              )}
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b>Category</b>
                <input value={category} onChange={(ev) => setCategory(ev.target.value)} aria-label="Category" />
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b>Capabilities</b>
                <input
                  value={capabilities}
                  onChange={(ev) => setCapabilities(ev.target.value)}
                  placeholder="comma-separated keys"
                  aria-label="Capabilities"
                  style={{ flex: 1 }}
                />
              </label>
              {form === "edit" && (
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b>Description</b>
                  <input value={description} onChange={(ev) => setDescription(ev.target.value)} aria-label="Description" style={{ flex: 1 }} />
                </label>
              )}
            </>
          )}
          {form === "deprecate" && targetSelect("Replaced by", false)}
          {form === "deprecate" && deprecationImpact(detail ?? e) && (
            <div className="hint" data-registry-deprecate-impact>
              {deprecationImpact(detail ?? e)}
            </div>
          )}
          {form === "merge" && targetSelect("Merge into", true)}
          {form === "request_publication" && (
            <>
              <div className="hint" data-registry-publication-explain>
                Asks the platform to take this gear. A platform curator reviews the request, then opens a pull
                request into the platform&apos;s gear repository with its files, or declines it with a reason. The entry
                is published once the platform&apos;s catalogue has it.
              </div>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b>Version</b>
                <input value={version} onChange={(ev) => setVersion(ev.target.value)} placeholder="optional, e.g. 1.0.0" aria-label="Version" />
              </label>
            </>
          )}
          {form === "mark_published" && (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <b>Version</b>
              <input value={version} onChange={(ev) => setVersion(ev.target.value)} placeholder="e.g. 1.0.0" aria-label="Version" />
            </label>
          )}
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <b>{form === "reject" ? "Reason" : "Why"}</b>
            <input
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder={form === "reject" ? "required: why this is not a gear" : "optional"}
              aria-label="Reason"
              style={{ flex: 1 }}
            />
          </label>
          <span>
            <button type="button" className="primary" disabled={busy || !ready} onClick={() => void submit()}>
              {busy ? "Saving…" : ACTION_LABEL[form].replace("…", "")}
            </button>{" "}
            <button type="button" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {error && (
        <div className="error" style={{ fontSize: 12 }} data-registry-decision-error>
          {error}
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <b>Decisions</b>
      </div>
      {decisions.length === 0 ? (
        <div style={{ opacity: 0.6 }}>None yet: {e.state === "declared" ? "found by the walk, nobody has decided." : "nothing recorded."}</div>
      ) : (
        <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
          {decisions.map((d, i) => (
            <li key={`${d.at}:${i}`}>
              <span style={{ opacity: 0.6 }}>{new Date(d.at).toLocaleString()}</span> · {decisionLine(d, names)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Suggest (ADR-0041 P4): a model's description, category and capability
 *  keys for the entry, asked on the caller's own key. The suggestion is shown
 *  beside what the entry says; Apply sends it as an edit. */
function SuggestDescription({
  token,
  entry: e,
  onApplied,
}: {
  token: string;
  entry: RegistryEntry;
  onApplied: () => void;
}) {
  const [suggestion, setSuggestion] = useState<RegistrySuggestion | null>(e.suggestion ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const ask = async () => {
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      setSuggestion(await api.suggestRegistry(token, e.name));
    } catch (cause) {
      setError(suggestRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!suggestion) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideRegistry(token, e.name, suggestionEdit(suggestion));
      setApplied(true);
      onApplied();
    } catch (cause) {
      setError(decisionRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: "6px 0" }} data-registry-suggest>
      <button type="button" disabled={busy} onClick={() => void ask()}>
        {busy && !suggestion ? "Asking…" : suggestion ? "Suggest again" : "Suggest a description"}
      </button>{" "}
      <span className="hint" style={{ fontSize: 12 }}>
        asks a model on your own key; nothing changes until you apply it
      </span>
      {suggestion && (
        <div style={{ marginTop: 4, padding: 6, background: "var(--muted, rgba(0,0,0,0.04))" }} data-registry-suggestion>
          <div>
            <b>Suggested</b> <span style={{ opacity: 0.6 }}>by {suggestion.model}</span>
          </div>
          {suggestion.description && <div>{suggestion.description}</div>}
          <div>
            <b>Category:</b> {suggestion.category ?? <span style={{ opacity: 0.6 }}>none fits</span>}
          </div>
          <div>
            <b>Capabilities:</b>{" "}
            {suggestion.capabilities.length ? suggestion.capabilities.join(", ") : <span style={{ opacity: 0.6 }}>none fits</span>}
          </div>
          {applied ? (
            <div data-registry-suggestion-applied>Applied as an edit.</div>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => void apply()} style={{ marginTop: 4 }}>
              Apply
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="error" style={{ fontSize: 12 }} data-registry-suggest-error>
          {error}
        </div>
      )}
    </div>
  );
}

/** Ready to leave its project? (ADR-0044 §1, phase 1): the checks that come
 *  before Extract, read from the component's code on request. Each failure
 *  names its files and lines; nothing is written. */
function ExtractReadiness({
  token,
  entry: e,
  onChanged,
}: {
  token: string;
  entry: RegistryEntry;
  onChanged?: () => void;
}) {
  const [result, setResult] = useState<RegistryReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RegistryExtractPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Extract (ADR-0044 §1): a preview first, then both pull requests; once
  // both are merged, completing it checks them and tags the version.
  const extract = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const after = await api.decideRegistry(token, e.name, { action: "extract", ...(dryRun ? { dry_run: true } : {}) });
      if (dryRun) {
        setPreview(after.extract_preview ?? null);
      } else {
        setPreview(null);
        setDone(after.extraction ? extractionLine(after.extraction) : "Extraction opened.");
        onChanged?.();
      }
    } catch (cause) {
      setError(decisionRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };
  const complete = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const after = await api.decideRegistry(token, e.name, { action: "complete_extraction" });
      setDone(after.extraction ? extractionLine(after.extraction) : "Extracted.");
      onChanged?.();
    } catch (cause) {
      setError(decisionRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };
  const open = extractionOpen(e);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.registryReadiness(token, e.name));
    } catch (cause) {
      setError(readinessRefusal(cause instanceof ApiError ? cause.status : undefined, errText(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: "6px 0" }} data-registry-readiness>
      <button type="button" disabled={busy} onClick={() => void check()}>
        {busy ? "Checking…" : result ? "Check again" : "Ready to leave its project?"}
      </button>{" "}
      <span className="hint" style={{ fontSize: 12 }}>
        reads its code and says what would stop it building as a crate of its own
      </span>
      {error && (
        <div className="error" style={{ fontSize: 12 }} data-registry-readiness-error>
          {error}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 4, padding: 6, background: "var(--muted, rgba(0,0,0,0.04))" }}>
          <div data-registry-readiness-headline>
            <b>{readinessHeadline(result)}</b>
          </div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            {result.kind === "crate" ? "The crate" : "The module"} <code>{result.module_path ?? result.path}</code>
            {" · "}
            {result.files} file{result.files === 1 ? "" : "s"} in {result.repo}
            {result.project_name ? ` (${result.project_name})` : ""}
            {result.outside_read < result.outside_total &&
              ` · read ${result.outside_read} of the crate's ${result.outside_total} other files`}
          </div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {result.checks.map((c) => (
              <li key={c.key} data-readiness-check={c.key}>
                <span className={`badge ${c.ok ? "ok" : c.blocks ? "danger" : "warn"}`}>
                  {c.ok ? "ok" : c.blocks ? "blocks" : "look"}
                </span>{" "}
                <b>{READINESS_LABEL[c.key] ?? c.key}:</b> {c.summary}
                {c.spots.length > 0 && (
                  <ul style={{ margin: "2px 0", paddingLeft: 16, fontSize: 12 }}>
                    {c.spots.map((s, i) => (
                      <li key={`${s.path}:${s.line ?? ""}:${i}`} style={{ overflowWrap: "anywhere" }}>
                        <code>{spotLabel(s)}</code>
                        {s.text ? <span style={{ opacity: 0.7 }}> {s.text}</span> : null}
                      </li>
                    ))}
                    {c.more > 0 && <li style={{ opacity: 0.6 }}>and {c.more} more</li>}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {result.dependencies.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 12, overflowWrap: "anywhere" }}>
              <b>Its Cargo.toml would list:</b>{" "}
              {result.dependencies.map((d) => (d.spec ? d.name : `${d.name} (not in the crate's)`)).join(", ")}
            </div>
          )}
          {result.ready && e.state === "registered" && !open && (
            <div style={{ marginTop: 6 }} data-registry-extract>
              <button type="button" disabled={busy} onClick={() => void extract(true)}>
                {preview ? "Preview again" : "Extract…"}
              </button>{" "}
              <span className="hint" style={{ fontSize: 12 }}>
                moves it into the organization&apos;s gear repository as its own crate, with a pull request on each side
              </span>
            </div>
          )}
        </div>
      )}
      {preview && (
        <div style={{ marginTop: 4, padding: 6, fontSize: 12 }} data-registry-extract-preview>
          {extractPreviewLines(preview).map((l) => (
            <div key={l}>{l}</div>
          ))}
          {preview.manifest && (
            <pre style={{ margin: "4px 0", maxHeight: 160, overflow: "auto" }}>{preview.manifest}</pre>
          )}
          <button type="button" className="primary" disabled={busy} onClick={() => void extract(false)}>
            Open both pull requests
          </button>
        </div>
      )}
      {open && e.state === "registered" && (
        <div style={{ marginTop: 6 }} data-registry-extract-complete>
          <button type="button" disabled={busy} onClick={() => void complete()}>
            {ACTION_LABEL.complete_extraction}
          </button>{" "}
          <span className="hint" style={{ fontSize: 12 }}>
            checks both pull requests are merged, tags the version, and marks it extracted
          </span>
        </div>
      )}
      {done && (
        <div className="hint" style={{ fontSize: 12 }} data-registry-extract-done>
          {done}
        </div>
      )}
    </div>
  );
}

// ── one list: the registry and the catalogue ────────────────────────────────

/** One component as the list shows it: what a project declares (the registry
 *  entry), what was published (the catalogue node), or both. */
export interface ComponentRow {
  key: string;
  name: string;
  kind: string;
  description: string;
  /** The registry's state, or `published` for a catalogue node no project
   *  declares. */
  state: string;
  entry?: RegistryEntry;
  node?: CatalogNode;
}

/** The order a state filter offers them in: what needs a decision first. */
const ROW_STATES = ["candidate", "declared", "registered", "published", "merged", "deprecated", "rejected", "extracted"];

/** Whether a catalogue node is this registry entry, published: the same
 *  name, the crate its extraction named, an alias, or the `cf-gears-`/`cf-`
 *  name the crates are published under. */
export function sameComponent(e: Pick<RegistryEntry, "name" | "aliases" | "extraction">, nodeName: string): boolean {
  const n = nodeName.toLowerCase();
  const names = [e.name, ...(e.aliases ?? [])].map((x) => x.toLowerCase());
  return (
    names.includes(n) ||
    e.extraction?.crate_name?.toLowerCase() === n ||
    names.some((x) => n === `cf-gears-${x}` || n === `cf-${x}`)
  );
}

/** The registry's entries with the catalogue node each one is, and the
 *  catalogue's nodes no entry is, as rows of one list. */
export function componentRows(entries: RegistryEntry[], catalogue: CatalogNode[]): ComponentRow[] {
  const used = new Set<string>();
  // A node with no `name` of its own may still say whose it is (a profile's
  // `gear_name`); its id is the last resort, never the first thing shown.
  const nodeName = (n: CatalogNode) => String(n.value.name ?? n.value.gear_name ?? n.instance_id);
  const rows: ComponentRow[] = entries.map((e) => {
    const node = catalogue.find((n) => !used.has(n.instance_id) && sameComponent(e, nodeName(n)));
    if (node) used.add(node.instance_id);
    return { key: `r:${e.name}`, name: e.name, kind: e.kind, description: e.description ?? "", state: e.state, entry: e, node };
  });
  for (const n of catalogue) {
    if (used.has(n.instance_id)) continue;
    rows.push({
      key: `c:${n.instance_id}`,
      name: nodeName(n),
      kind: String(n.value.kind ?? "component"),
      description: String(n.value.description ?? ""),
      state: "published",
      node: n,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The columns: what a project declares always, what the catalogue knows
 *  only when there is a catalogue — a column empty in every row says nothing. */
function componentColumns(
  catalogueCell: ((column: "release" | "downloads" | "activity", node: CatalogNode) => ReactNode) | undefined,
  withCatalogue: boolean,
): Column<ComponentRow>[] {
  const dash = <span style={{ opacity: 0.5 }}>—</span>;
  const cols: Column<ComponentRow>[] = [
    {
      id: "name",
      header: "Component",
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (r) => (
        <div>
          <b>{r.name}</b> <span style={{ opacity: 0.6, fontSize: 12 }}>{r.kind}</span>
          {r.entry && isDuplicated(r.entry) && (
            <span className="badge warn" style={{ marginLeft: 6 }} title="Declared in more than one repository">
              ×{new Set(r.entry.occurrences.map((o) => o.repo)).size} repos
            </span>
          )}
          {r.entry && isOrphaned(r.entry) && (
            <span className="badge" style={{ marginLeft: 6 }} title="No repository declares it any more">
              orphaned
            </span>
          )}
          {r.description && <div style={{ fontSize: 12, opacity: 0.75 }}>{r.description}</div>}
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      compare: (a, b) => ROW_STATES.indexOf(a.state) - ROW_STATES.indexOf(b.state),
      cell: (r) => {
        const published = r.entry ? publishStatus(r.entry) : null;
        return (
          <>
            <span className={`badge ${STATE_TONE[r.state] ?? (r.state === "published" ? "ok" : "")}`}>{STATE_LABEL[r.state] ?? r.state}</span>
            {published && (
              <span className={`badge ${published.kind === "published" ? "ok" : "info"}`} style={{ marginLeft: 6 }} data-registry-publish-status>
                {published.label}
              </span>
            )}
          </>
        );
      },
    },
    {
      id: "projects",
      header: "Projects",
      cell: (r) => {
        if (!r.entry) return dash;
        const used = consumersLabel(r.entry);
        return (
          <span style={{ fontSize: 13 }}>
            {projectsOf(r.entry).join(", ") || "—"}
            {used && <div style={{ fontSize: 12, opacity: 0.75 }} data-registry-used-by>{used}</div>}
          </span>
        );
      },
    },
    {
      id: "where",
      header: "Declared at",
      cell: (r) => {
        const first = r.entry?.occurrences[0];
        if (!first) return r.node?.value.repository ? <span style={{ fontSize: 12 }}>{String(r.node.value.repository).replace(/^https?:\/\//, "")}</span> : dash;
        return (
          <span style={{ fontSize: 12 }}>
            <code>{first.path}</code> <span style={{ opacity: 0.6 }}>({first.declared_in})</span>
            {r.entry!.occurrences.length > 1 && <span style={{ opacity: 0.6 }}> and {r.entry!.occurrences.length - 1} more</span>}
          </span>
        );
      },
    },
  ];
  if (withCatalogue && catalogueCell) {
    for (const [id, header] of [
      ["release", "Release"],
      ["downloads", "Downloads"],
      ["activity", "Activity"],
    ] as const) {
      cols.push({ id, header, num: id === "downloads", cell: (r) => (r.node ? catalogueCell(id, r.node) : dash) });
    }
  }
  return cols;
}
