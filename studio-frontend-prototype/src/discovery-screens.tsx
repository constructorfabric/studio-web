/* The need and the hypotheses (need-view.ts): who has which problem, what
 * they want, what the materials propose — and which benefits someone expects,
 * each a hypothesis with a way to check it and where it stands. Read off the
 * same facts and passages as the model; every line opens its source. */
import { useState } from "react";

import type { SpecModelWrite } from "./api";
import { DataTable } from "./data-table";
import { blockedByRules, obligations, type Obligation } from "./behaviour";
import { conflicts, describe as sayRule, readRule } from "./rule-checks";
import { FactRow } from "./domain-model-screens";
import {
  CHECK_NOTE_MAX,
  checkSize,
  hypothesesDocument,
  proposedBrief,
  proposedMethods,
  TIMING_LABEL,
  type Check,
  type MethodDef,
  type Timing,
} from "./hypothesis-check";
import {
  EVIDENCE_LABEL,
  hypothesesOf,
  materialFromFile,
  MATERIAL_MAX_BYTES,
  needGaps,
  needsByRole,
  needDocument,
  unlinkedRequirements,
  type EvidenceState,
  type Hypothesis,
} from "./need-view";
import type { SpecModelFact, SpecRequirement } from "./spec-model";
import { EmptyState, InfoPopover, KpiTile, StatusChip, type Tone } from "./ui-standard";

/** How an evidence state reads as a StatusChip. */
const EVIDENCE_TONE: Record<EvidenceState, Tone> = { unchecked: "neutral", supports: "ok", contradicts: "danger", insufficient: "warn" };

type OpenFile = ((path: string) => void) | undefined;

export function NeedsScreen({
  facts,
  onOpenFile,
  accepted,
  onAddMaterial,
  onPropose,
  requirements,
  readStopped,
}: {
  facts: SpecModelFact[];
  onOpenFile: OpenFile;
  /** Why the last reading stopped — no model key anyone reaches, most often. */
  readStopped?: string | null;
  /** Whether a member accepted a reading. */
  accepted: (f: SpecModelFact) => boolean;
  /** Keep a pasted material in the project and read it at once. */
  onAddMaterial?: (title: string, content: string) => Promise<void>;
  /** Propose the accepted need as docs/discovery.md. */
  onPropose?: (content: string) => Promise<SpecModelWrite>;
  /** The functional and user requirements, to say which trace to no need. */
  requirements?: SpecRequirement[];
}) {
  const roles = needsByRole(facts);
  const unlinked = unlinkedRequirements(requirements ?? [], facts);
  const gaps = [
    ...needGaps(facts),
    ...(unlinked.length
      ? [{ kind: "idea-without-problem" as const, title: `${unlinked.length} requirement${unlinked.length === 1 ? "" : "s"} name no problem or goal of the need — ${unlinked.slice(0, 3).map((r) => r.id).join(", ")}${unlinked.length > 3 ? "…" : ""}` }]
      : []),
  ];
  const any = roles.some((r) => r.problems.length + r.outcomes.length + r.ideas.length + r.scenarios.length > 0);
  const needRows: NeedRow[] = roles.flatMap((r) =>
    (
      [
        ["Problem", r.problems],
        ["Wants to reach", r.outcomes],
        ["Idea", r.ideas],
        ["Scenario", r.scenarios],
      ] as const
    ).flatMap(([kind, list]) =>
      list.map((fact, i) => ({ key: `${r.role}|${kind}|${i}|${fact.subject}`, kind, role: r.role || "No role named", fact })),
    ),
  );
  const [adding, setAdding] = useState<{ title: string; content: string } | null>(null);
  const [state, setState] = useState<{ busy: boolean; error?: string; done?: SpecModelWrite; added?: string }>({ busy: false });
  const [refused, setRefused] = useState<string[]>([]);
  /** Each text file a material of its own, read once all are added. */
  const addFiles = async (files: FileList | null) => {
    if (!files?.length || !onAddMaterial) return;
    const took: string[] = [];
    const no: string[] = [];
    await run(async () => {
      for (const file of [...files]) {
        const m = materialFromFile(file.name, file.size, file.size <= MATERIAL_MAX_BYTES ? await file.text() : "");
        if ("refused" in m) no.push(m.refused);
        else {
          await onAddMaterial(m.title, m.content);
          took.push(m.title);
        }
      }
    }, undefined);
    setRefused(no);
    setState((s) => ({ ...s, added: took.length ? took.map((t) => `“${t}”`).join(", ") : undefined }));
  };
  const run = async (act: () => Promise<SpecModelWrite | void>, added?: string) => {
    setState({ busy: true });
    try {
      const done = await act();
      setState({ busy: false, done: done || undefined, added });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const acceptedNeed = facts.filter((f) => accepted(f));
  const intake = (
    <section className="card nd-intake">
      {adding ? (
        <>
          <input
            type="text"
            placeholder="What it is: Interview with an operator, 2026-10-12"
            value={adding.title}
            onChange={(e) => setAdding({ ...adding, title: e.target.value })}
            aria-label="Material title"
          />
          <textarea rows={8} placeholder="Paste the interview, the request or the report as it is." value={adding.content} onChange={(e) => setAdding({ ...adding, content: e.target.value })} />
          <div className="dm-actions">
            <button
              type="button"
              className="primary"
              disabled={state.busy || !adding.title.trim() || !adding.content.trim()}
              onClick={() => void run(async () => {
                await onAddMaterial!(adding.title.trim(), adding.content);
                setAdding(null);
              }, adding.title.trim())}
            >
              {state.busy ? "Adding…" : "Add and read it"}
            </button>
            <button type="button" className="ghost" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="dm-actions">
          {onAddMaterial && (
            <>
              <button type="button" className="ghost" onClick={() => setAdding({ title: "", content: "" })}>
                Paste material
              </button>
              <label className="nd-file" title="Markdown, plain text, CSV, HTML, e-mail or subtitles; each file is one material">
                Add files
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  accept=".md,.markdown,.txt,.text,.csv,.tsv,.json,.html,.htm,.eml,.vtt,.srt,.log,.yaml,.yml"
                  disabled={state.busy}
                  onChange={(e) => {
                    void addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          )}
          {onPropose && (
            <button
              type="button"
              className="primary"
              disabled={state.busy || acceptedNeed.length === 0}
              title={acceptedNeed.length ? "Write what was accepted to docs/discovery.md, as a pull request" : "Accept readings first: only what a person accepted is written"}
              onClick={() => void run(() => onPropose(needDocument(acceptedNeed)))}
            >
              Accept the need ({acceptedNeed.filter((f) => f.kind !== "role").length} readings)
            </button>
          )}
          <span className="hint">
            Materials are read as soon as they are added: on your own model key, else an AI connection you reach — yours, the
            workspace&apos;s or the organization&apos;s.
          </span>
        </div>
      )}
      {state.added && <span className="dm-saved">✓ {state.added.startsWith("“") ? state.added : `“${state.added}”`} added; being read.</span>}
      {readStopped && (
        <span className="error-inline" data-read-stopped>
          Reading stopped: {readStopped}
        </span>
      )}
      {refused.map((r) => (
        <span key={r} className="error-inline">
          Not added — {r}
        </span>
      ))}
      {state.done && (
        <span className="dm-saved">
          ✓ Proposed{" "}
          {state.done.pr_url ? (
            <a href={state.done.pr_url} target="_blank" rel="noreferrer">
              as a pull request
            </a>
          ) : (
            <>on {state.done.branch}</>
          )}
        </span>
      )}
      {state.error && <span className="error-inline">{state.error}</span>}
    </section>
  );
  if (!any)
    return (
      <div className="nd">
        {intake}
        <EmptyState
          title="No problems, goals or ideas read yet."
          body={<>They come from the project&apos;s materials — interviews, requests, a PRD&apos;s problem statement — once a build reads them with the current extractor.</>}
        />
      </div>
    );
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>What the need is.</b>{" "}
        <InfoPopover label="How to read this">Who has which problem, what they want to reach and what the materials propose, each with the passage it comes from. Accept or reject each reading; a link nobody stated is shown as a gap, never filled in. What you accept becomes the need, proposed as a document.</InfoPopover>
      </p>
      {intake}
      {gaps.length > 0 && (
        <details className="card dm-rproblems" aria-label="Gaps in the need">
          <summary className="dm-h">
            {gaps.length} gap{gaps.length === 1 ? "" : "s"} in the need — a problem nothing solves, an idea with no problem
          </summary>
          {gaps.map((g, i) => (
            <div key={i} className="dm-rproblem">
              <StatusChip tone="warn">
                {g.kind === "problem-without-idea" ? "No solution" : g.kind === "idea-without-problem" ? "No problem" : "No need"}
              </StatusChip>
              <div>
                <b>{g.title}.</b>
                {g.fact && (
                  <div className="dm-rwhere">
                    {g.fact.source.path}
                    {g.fact.source.line_start ? `:${g.fact.source.line_start}` : ""}
                  </div>
                )}
              </div>
            </div>
          ))}
        </details>
      )}
      <div className="card">
        <DataTable<NeedRow>
          list="dm-needs"
          urlPrefix="need."
          rows={needRows}
          rowKey={(r) => r.key}
          rowLabel={(r) => r.fact.subject}
          pageSize={20}
          search={{ placeholder: "Search the need" }}
          searchText={(r) => [r.fact.subject, r.fact.value, r.fact.text, r.role]}
          filters={[
            {
              id: "kind",
              allLabel: "Everything",
              kind: "chips",
              options: (["Problem", "Wants to reach", "Idea", "Scenario"] as const)
                .filter((k) => needRows.some((r) => r.kind === k))
                .map((k) => ({ value: k, label: k })),
              match: (r, v) => r.kind === v,
            },
            {
              id: "role",
              allLabel: "Every role",
              kind: "select",
              options: [...new Set(needRows.map((r) => r.role))].sort().map((x) => ({ value: x, label: x })),
              match: (r, v) => r.role === v,
            },
          ]}
          empty={{ title: "Nothing matches." }}
          columns={[
            { id: "kind", header: "Kind", cell: (r) => <StatusChip tone="warn">{r.kind}</StatusChip> },
            {
              id: "what",
              header: "What",
              compare: (a, b) => a.fact.subject.localeCompare(b.fact.subject),
              cell: (r) => (
                <span>
                  <b>{r.fact.subject}</b>
                  {r.fact.value && <span className="sub"> — {r.fact.value}</span>}
                </span>
              ),
            },
            { id: "role", header: "Who", compare: (a, b) => a.role.localeCompare(b.role), cell: (r) => r.role },
            {
              id: "where",
              header: "Read from",
              cell: (r) => (
                <code className="dm-where">
                  {r.fact.source.path.split("/").pop()}
                  {r.fact.source.line_start ? `:${r.fact.source.line_start}` : ""}
                </code>
              ),
            },
            { id: "accepted", header: "Accepted", cell: (r) => (accepted(r.fact) ? "✓" : <span className="sub">—</span>) },
          ]}
          expand={(r) => <FactRow fact={r.fact} onOpenFile={onOpenFile} />}
        />
      </div>
    </div>
  );
}

export function HypothesesScreen({
  facts,
  stateOf,
  onEvidence,
  catalogue,
  kitNote,
  checkOf,
  onSaveCheck,
  onPropose,
  onOpenFile,
}: {
  facts: SpecModelFact[];
  /** Where a hypothesis stands, as members recorded it. */
  stateOf: (f: SpecModelFact) => EvidenceState;
  onEvidence?: (f: SpecModelFact, state: EvidenceState) => Promise<void>;
  /** The check methods: built in, then the project's kits'. */
  catalogue: MethodDef[];
  /** Which kits' methods were read, or why some were not. */
  kitNote?: string | null;
  /** The check a member planned or recorded for a hypothesis. */
  checkOf: (h: Hypothesis) => Check | undefined;
  onSaveCheck?: (h: Hypothesis, check: Check) => Promise<void>;
  /** Propose the hypotheses as docs/hypotheses.md. */
  onPropose?: (content: string) => Promise<SpecModelWrite>;
  onOpenFile: OpenFile;
}) {
  const list = hypothesesOf(facts);
  const [draft, setDraft] = useState<Record<number, Check>>({});
  const [saving, setSaving] = useState<{ i?: number; error?: string; done?: SpecModelWrite; busy?: boolean }>({});
  const label = (id: string) => catalogue.find((m) => m.id === id)?.label ?? id;
  /** What the row shows: the draft being edited, else the record, else a
   *  first proposal nobody saved. */
  const checkAt = (i: number, h: Hypothesis): Check =>
    draft[i] ??
    checkOf(h) ?? {
      methods: proposedMethods(h, catalogue).map((p) => p.id).slice(0, 1),
      timing: null,
      brief: "",
      criterion: "",
      result: "",
    };
  const edit = (i: number, h: Hypothesis, patch: Partial<Check>) => setDraft((d) => ({ ...d, [i]: { ...checkAt(i, h), ...patch } }));
  if (list.length === 0)
    return (
      <EmptyState
        title="No expected benefits read yet."
        body={<>A hypothesis comes from what someone expects a solution to do for someone — “the search will let operators find a request in seconds” — once a build reads it with the current extractor.</>}
      />
    );
  const counts = list.reduce<Record<EvidenceState, number>>(
    (c, h) => ({ ...c, [stateOf(h.fact)]: c[stateOf(h.fact)] + 1 }),
    { unchecked: 0, supports: 0, contradicts: 0, insufficient: 0 },
  );
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>Check what is expected, not what is written.</b>{" "}
        <InfoPopover label="How to read this">Each benefit someone expects is a hypothesis: which solution, for whom, with what effect. Studio proposes how to check it; what the check found is yours to record. Accepting the wording is not validating it, and an unchecked hypothesis stops nothing.</InfoPopover>
      </p>
      {(onPropose || kitNote) && (
        <div className="dm-actions">
          {onPropose && (
            <button
              type="button"
              className="ghost"
              disabled={saving.busy}
              title="Write every hypothesis, where it stands and how it is checked to docs/hypotheses.md, as a pull request"
              onClick={() => {
                setSaving({ busy: true });
                onPropose(hypothesesDocument(list, (h) => stateOf(h.fact), (h) => checkOf(h), catalogue))
                  .then((done) => setSaving({ done }))
                  .catch((e: unknown) => setSaving({ error: e instanceof Error ? e.message : String(e) }));
              }}
            >
              {saving.busy ? "Proposing…" : "Propose as docs/hypotheses.md"}
            </button>
          )}
          {saving.done && (
            <span className="dm-saved">
              ✓ Proposed{" "}
              {saving.done.pr_url ? (
                <a href={saving.done.pr_url} target="_blank" rel="noreferrer">
                  as a pull request
                </a>
              ) : (
                <>on {saving.done.branch}</>
              )}
            </span>
          )}
          {kitNote && <span className="hint">{kitNote}</span>}
        </div>
      )}
      {saving.error && <div className="error">{saving.error}</div>}
      <div className="card">
        <DataTable<HypRow>
          list="dm-hypotheses"
          urlPrefix="hyp."
          rows={list.map((h, i) => ({ key: `${i}|${h.solution}|${h.effect}`, i, h, state: stateOf(h.fact) }))}
          rowKey={(r) => r.key}
          rowLabel={(r) => r.h.solution || "A solution not named"}
          pageSize={20}
          search={{ placeholder: "Search hypotheses" }}
          searchText={(r) => [r.h.solution, r.h.role, r.h.effect, r.h.fact.text]}
          filters={[
            {
              id: "state",
              allLabel: "Every state",
              kind: "chips",
              options: (Object.keys(EVIDENCE_LABEL) as EvidenceState[])
                .filter((st) => counts[st] > 0)
                .map((st) => ({ value: st, label: EVIDENCE_LABEL[st] })),
              match: (r, v) => r.state === v,
            },
          ]}
          empty={{ title: "Nothing matches." }}
          columns={[
            { id: "state", header: "State", cell: (r) => <StatusChip tone={EVIDENCE_TONE[r.state]} data-evidence={r.state}>{EVIDENCE_LABEL[r.state]}</StatusChip> },
            { id: "solution", header: "Solution", compare: (a, b) => a.h.solution.localeCompare(b.h.solution), cell: (r) => <b>{r.h.solution || <i>not named</i>}</b> },
            { id: "role", header: "For whom", cell: (r) => r.h.role || <i className="sub">not named</i> },
            { id: "effect", header: "Expected", cell: (r) => r.h.effect || <i className="sub">not stated</i> },
            {
              id: "method",
              header: "Check by",
              cell: (r) => {
                const c = checkOf(r.h);
                return c ? (
                  <span>
                    {c.methods.map(label).join(", ") || <i className="sub">no method</i>}
                    {c.timing && <small className="hint" style={{ display: "block" }}>{TIMING_LABEL[c.timing]}</small>}
                  </span>
                ) : (
                  <span className="sub">proposed: {label(proposedMethods(r.h, catalogue)[0].id)}</span>
                );
              },
            },
          ]}
          expand={(r) => {
            const c = checkAt(r.i, r.h);
            const chosen = catalogue.filter((m) => c.methods.includes(m.id));
            const proposals = proposedMethods(r.h, catalogue);
            const size = checkSize(c);
            return (
              <div className="nd-hyp-detail">
                <FactRow fact={r.h.fact} onOpenFile={onOpenFile} />
                <div className="nd-check">
                  <span className="hint">
                    Proposed: {proposals.map((p) => `${label(p.id)} — ${p.why}`).join("; ")}.
                  </span>
                  <div className="nd-methods" role="group" aria-label="Check by">
                    {catalogue.map((m) => (
                      <label key={m.id} title={`${m.uncertainty} Needs: ${m.inputs} Limit: ${m.limits}`}>
                        <input
                          type="checkbox"
                          checked={c.methods.includes(m.id)}
                          onChange={(e) =>
                            edit(r.i, r.h, { methods: e.target.checked ? [...c.methods, m.id] : c.methods.filter((x) => x !== m.id) })
                          }
                        />{" "}
                        {m.label}
                        {m.kit && <small className="hint"> · {m.kit} kit</small>}
                      </label>
                    ))}
                  </div>
                  {chosen.map((m) => (
                    <span key={m.id} className="hint">
                      <b>{m.label}:</b> {m.uncertainty} {m.action} <i>Limit: {m.limits}</i>
                    </span>
                  ))}
                  <label>
                    When{" "}
                    <select value={c.timing ?? ""} onChange={(e) => edit(r.i, r.h, { timing: (e.target.value || null) as Timing | null })}>
                      <option value="">not chosen</option>
                      {(Object.keys(TIMING_LABEL) as Timing[]).map((t) => (
                        <option key={t} value={t}>
                          {TIMING_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="nd-field">
                    Brief{" "}
                    <button type="button" className="dm-link" onClick={() => edit(r.i, r.h, { brief: proposedBrief(r.h, chosen, c.timing) })}>
                      {c.brief ? "propose again" : "propose one"}
                    </button>
                    <textarea rows={c.brief ? 7 : 2} value={c.brief} onChange={(e) => edit(r.i, r.h, { brief: e.target.value })} />
                  </label>
                  <label className="nd-field">
                    Criterion to read a result by
                    <input
                      type="text"
                      placeholder="Not agreed: a result is then exploratory"
                      value={c.criterion}
                      onChange={(e) => edit(r.i, r.h, { criterion: e.target.value })}
                    />
                  </label>
                  <label className="nd-field">
                    What checking found
                    <textarea
                      rows={3}
                      placeholder="Paste or write the result: who was observed or asked, under what conditions, what was seen."
                      value={c.result}
                      onChange={(e) => edit(r.i, r.h, { result: e.target.value })}
                    />
                  </label>
                  {onSaveCheck && (
                    <div className="dm-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={size > CHECK_NOTE_MAX || saving.i === r.i}
                        onClick={() => {
                          setSaving({ i: r.i });
                          onSaveCheck(r.h, c)
                            .then(() => {
                              setDraft((d) => {
                                const { [r.i]: _saved, ...rest } = d;
                                return rest;
                              });
                              setSaving({});
                            })
                            .catch((e: unknown) => setSaving({ error: e instanceof Error ? e.message : String(e) }));
                        }}
                      >
                        {saving.i === r.i ? "Saving…" : "Save the check"}
                      </button>
                      <span className={size > CHECK_NOTE_MAX ? "error-inline" : "hint"}>
                        {size} / {CHECK_NOTE_MAX} bytes
                      </span>
                      {!c.criterion.trim() && c.result.trim() && <span className="hint">No criterion agreed: the result is kept as exploratory.</span>}
                    </div>
                  )}
                </div>
                {onEvidence && (
                  <div className="dm-actions">
                    <span className="hint">What checking found:</span>
                    {(["supports", "contradicts", "insufficient", "unchecked"] as EvidenceState[]).map((st) => (
                      <button key={st} type="button" className={r.state === st ? "primary" : "ghost"} aria-pressed={r.state === st} onClick={() => void onEvidence(r.h.fact, st)}>
                        {EVIDENCE_LABEL[st]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}

/** Bounded behaviour coverage: what the specification must say about each
 *  action in each state, answered by a passage, asked, or excluded with a
 *  reason. Nothing here is a release gate. */
export function BehaviourScreen({
  facts,
  rules,
  decisionOf,
  onExclude,
  onOpenFile,
}: {
  facts: SpecModelFact[];
  /** The constraints a member accepted, read: what an action is checked against. */
  rules: ReturnType<typeof readRule>[];
  decisionOf: (key: string) => { state: string; note: string | null } | undefined;
  /** Record a reason an obligation does not apply, or `null` to ask it again. */
  onExclude?: (o: Obligation, reason: string | null) => Promise<void>;
  onOpenFile: OpenFile;
}) {
  const list = obligations(facts);
  const blocked = blockedByRules(facts, rules);
  const [reason, setReason] = useState<Record<string, string>>({});
  const cannot = blocked.length > 0 && (
    <details className="card dm-rproblems" open aria-label="Cannot happen as written">
      <summary className="dm-h">
        {blocked.length} action{blocked.length === 1 ? "" : "s"} or scenario{blocked.length === 1 ? "" : "s"} a confirmed rule
        forbids as written
      </summary>
      {blocked.map((b, i) => (
        <div key={i} className="dm-rproblem">
          <StatusChip tone="danger">Cannot happen</StatusChip>
          <div>
            <b>{b.witness}.</b>
            <FactRow fact={b.fact} onOpenFile={onOpenFile} />
            <FactRow fact={b.rule.fact} onOpenFile={onOpenFile} />
          </div>
        </div>
      ))}
    </details>
  );
  if (list.length === 0)
    return (
      <div className="nd">
        {cannot}
        <EmptyState
          title="No behaviour questions yet."
          body={<>They come from an entity&apos;s states (a lifecycle that lists them) and the actions roles take on it, once a build reads them with the current extractor.</>}
        />
      </div>
    );
  const excluded = list.filter((o) => decisionOf(o.key)?.state === "excluded");
  const answered = list.filter((o) => o.answer && !excluded.includes(o));
  const open = list.filter((o) => !o.answer && !excluded.includes(o));
  const statusOf = (o: Obligation) => (excluded.includes(o) ? "excluded" : o.answer ? "answered" : "open");
  const row = (o: Obligation) => (
    <div key={o.key} className="nd-ob">
      <div>
        May <b>{o.role || "someone"}</b> {o.action} a <b>{o.entity}</b> that is <b>{o.state}</b>?
      </div>
      {o.answer ? (
        <FactRow fact={o.answer} onOpenFile={onOpenFile} />
      ) : decisionOf(o.key)?.state === "excluded" ? (
        <div className="hint">
          Excluded: {decisionOf(o.key)?.note}{" "}
          {onExclude && (
            <button type="button" className="dm-link" onClick={() => void onExclude(o, null)}>
              ask again
            </button>
          )}
        </div>
      ) : (
        onExclude && (
          <div className="dm-actions">
            <input
              type="text"
              placeholder="Why it does not apply"
              value={reason[o.key] ?? ""}
              onChange={(e) => setReason((r) => ({ ...r, [o.key]: e.target.value }))}
              aria-label="Reason to exclude"
            />
            <button type="button" className="ghost" disabled={!reason[o.key]?.trim()} onClick={() => void onExclude(o, reason[o.key].trim())}>
              Exclude with this reason
            </button>
          </div>
        )
      )}
    </div>
  );
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>What the specification must say about behaviour.</b>{" "}
        <InfoPopover label="How to read this">For each action roles take on a thing and each state it goes through: may it happen then? A question is answered only where one passage names both; otherwise answer it in the documents, or exclude it with a reason. What a rule you accepted forbids is shown first. None of this blocks a build.</InfoPopover>
      </p>
      {cannot}
      <div className="card">
        <DataTable<Obligation>
          list="dm-behaviour"
          urlPrefix="beh."
          rows={list}
          rowKey={(o) => o.key}
          rowLabel={(o) => `${o.action} ${o.entity} ${o.state}`}
          pageSize={20}
          search={{ placeholder: "Search questions" }}
          searchText={(o) => [o.role, o.action, o.entity, o.state]}
          filters={[
            {
              id: "status",
              allLabel: "Every question",
              kind: "chips",
              options: [
                { value: "open", label: `Not answered` },
                { value: "answered", label: "Answered" },
                { value: "excluded", label: "Excluded" },
              ].filter((x) => (x.value === "open" ? open.length : x.value === "answered" ? answered.length : excluded.length) > 0),
              match: (o, v) => statusOf(o) === v,
            },
            {
              id: "entity",
              allLabel: "Every thing",
              kind: "select",
              options: [...new Set(list.map((o) => o.entity))].sort().map((x) => ({ value: x, label: x })),
              match: (o, v) => o.entity === v,
            },
          ]}
          empty={{ title: "Nothing matches." }}
          columns={[
            {
              id: "status",
              header: "Status",
              cell: (o) => <StatusChip tone={statusOf(o) === "open" ? "warn" : "ok"}>{statusOf(o) === "open" ? "not answered" : statusOf(o)}</StatusChip>,
            },
            {
              id: "question",
              header: "Question",
              cell: (o) => (
                <span>
                  May <b>{o.role || "someone"}</b> {o.action} a <b>{o.entity}</b> that is <b>{o.state}</b>?
                </span>
              ),
            },
            { id: "entity", header: "Thing", compare: (a, b) => a.entity.localeCompare(b.entity), cell: (o) => o.entity },
            { id: "state", header: "State", cell: (o) => o.state },
          ]}
          expand={(o) => row(o)}
        />
      </div>
    </div>
  );
}

/** The rules a member confirmed, read into a precise form, and checked
 *  against each other: a conflict with the two passages that witness it,
 *  none among what was read, incomplete, or a rule this check has no form
 *  for. Unconfirmed rules give no verdict. */
export function RulesScreen({
  facts,
  accepted,
  onOpenFile,
}: {
  facts: SpecModelFact[];
  accepted: (f: SpecModelFact) => boolean;
  onOpenFile: OpenFile;
}) {
  const all = facts.filter((f) => f.kind === "constraint" && f.status === "active");
  const confirmed = all.filter(accepted).map(readRule);
  const pending = all.length - confirmed.length;
  const found = conflicts(confirmed);
  const read = confirmed.filter((r) => r.outcome === "read");
  const incomplete = confirmed.filter((r) => r.outcome === "incomplete");
  const unsupported = confirmed.filter((r) => r.outcome === "unsupported");
  return (
    <div className="nd">
      <p className="dm-howto">
        <b>Check the rules against each other.</b>{" "}
        <InfoPopover label="How to read this">Only rules a member accepted are checked. Each is read into a precise form — who may do what, a number that bounds something — shown so you can say it is what the rule means. Two that cannot both hold are a conflict, shown with both passages.</InfoPopover>
      </p>
      <div className="dash-stats" data-rule-counts>
        <KpiTile label="Conflicts" value={found.length} tone={found.length ? "danger" : "ok"} />
        <KpiTile label="Read" value={read.length} />
        <KpiTile label="Incomplete" value={incomplete.length} tone={incomplete.length ? "warn" : undefined} />
        <KpiTile label="Unsupported" value={unsupported.length} tone={unsupported.length ? "warn" : undefined} />
        <KpiTile label="Not accepted yet" value={pending} />
      </div>
      {confirmed.length === 0 && (
        <EmptyState
          title="No rule is accepted yet."
          body="Accept the constraints you agree with on an entity's card; only those are checked, so an unconfirmed reading never becomes a verdict."
        />
      )}
      {confirmed.length > 0 && (
        <div className="card">
          <DataTable<RuleRow>
            list="dm-rules"
            urlPrefix="rule."
            rows={confirmed.map((r, i) => ({ key: `${i}|${r.fact.subject}|${r.fact.text}`, r, conflict: found.find((x) => x.a === r || x.b === r) ?? null }))}
            rowKey={(x) => x.key}
            rowLabel={(x) => x.r.fact.subject}
            pageSize={20}
            search={{ placeholder: "Search rules" }}
            searchText={(x) => [x.r.fact.subject, x.r.fact.text, x.r.fact.value]}
            filters={[
              {
                id: "outcome",
                allLabel: "Every rule",
                kind: "chips",
                options: [
                  { value: "conflict", label: "In conflict" },
                  { value: "read", label: "Read" },
                  { value: "incomplete", label: "Incomplete" },
                  { value: "unsupported", label: "Unsupported" },
                ],
                match: (x, v) => (v === "conflict" ? !!x.conflict : x.r.outcome === v),
              },
            ]}
            empty={{ title: "Nothing matches." }}
            columns={[
              {
                id: "outcome",
                header: "Outcome",
                cell: (x) =>
                  x.conflict ? (
                    <StatusChip tone="danger">conflict</StatusChip>
                  ) : (
                    <StatusChip tone={x.r.outcome === "read" ? "ok" : "warn"}>{x.r.outcome}</StatusChip>
                  ),
              },
              { id: "subject", header: "About", compare: (a, b) => a.r.fact.subject.localeCompare(b.r.fact.subject), cell: (x) => <b>{x.r.fact.subject}</b> },
              {
                id: "reading",
                header: "Read as",
                cell: (x) => (x.r.reading ? sayRule(x.r.reading) : <span className="sub">{x.r.why}</span>),
              },
            ]}
            expand={(x) => (
              <div>
                {x.conflict && <div className="dm-rgap"><b>Cannot both hold:</b> {x.conflict.witness}</div>}
                <FactRow fact={x.r.fact} onOpenFile={onOpenFile} />
                {x.conflict && <FactRow fact={(x.conflict.a === x.r ? x.conflict.b : x.conflict.a).fact} onOpenFile={onOpenFile} />}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}

interface NeedRow {
  key: string;
  kind: "Problem" | "Wants to reach" | "Idea" | "Scenario";
  role: string;
  fact: SpecModelFact;
}

interface HypRow {
  key: string;
  i: number;
  h: ReturnType<typeof hypothesesOf>[number];
  state: EvidenceState;
}

interface RuleRow {
  key: string;
  r: ReturnType<typeof readRule>;
  conflict: ReturnType<typeof conflicts>[number] | null;
}
