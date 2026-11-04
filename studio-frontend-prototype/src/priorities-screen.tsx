/* Priorities (prioritise.ts): pick the requirements to compare, give each an
 * Impact, take Confidence from what it rests on or correct it, give an effort
 * for Ease, and read the ICE score and the order it leads to. Every value
 * says where it comes from, an unknown stays unknown, a tie stays a tie. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DataTable } from "./data-table";

import {
  confidenceFromBasis,
  confidenceFromHypotheses,
  easeFromEffort,
  ICE_LABEL,
  iceScore,
  orderItems,
  unknown,
  type CheckedClaim,
  type Criterion,
  type IceCriterion,
  type IceInputs,
} from "./prioritise";
import type { SpecModelWrite } from "./api";
import {
  changedSince,
  confirmations,
  confirmationWrite,
  itemWrite,
  removeWrite,
  workingSet,
  type ConfirmedRow,
  type Entry,
  type ReviewWrite,
  type WorkingSet,
} from "./priority-store";
import { EVIDENCE_LABEL } from "./need-view";
import { classify, REQUIREMENT_TYPE_LABEL } from "./requirement-types";
import type { SpecModelReview } from "./review-state";
import type { SpecRequirement, SpecRequirements } from "./spec-model";
import { EmptyState, InfoPopover } from "./ui-standard";

const ORIGIN_LABEL: Record<Criterion["origin"], string> = {
  measured: "measured",
  estimated: "Studio's estimate",
  entered: "entered",
  unknown: "unknown",
};

/** Where an earlier version kept the working set: in this browser only. */
const legacyKey = (projectId: string) => `studio.priorities.${projectId}`;

function loadLegacy(projectId: string): WorkingSet | null {
  try {
    const raw = localStorage.getItem(legacyKey(projectId));
    const set = raw ? (JSON.parse(raw) as WorkingSet) : null;
    return set && Array.isArray(set.items) && set.items.length ? set : null;
  } catch {
    // Private window or blocked storage: nothing to bring over.
    return null;
  }
}

function dropLegacy(projectId: string) {
  try {
    localStorage.removeItem(legacyKey(projectId));
  } catch {
    // Nothing kept, nothing to drop.
  }
}

/** How long an entry waits for more typing before it is saved. */
const SAVE_AFTER_MS = 700;

/** The entries typed this visit and not saved yet: a reload of the project's
 *  set must not undo them. */
function stillTyped(s: WorkingSet, timers: Map<string, unknown>): Record<string, Entry> {
  return Object.fromEntries([...timers.keys()].filter((id) => s.entries[id]).map((id) => [id, s.entries[id]]));
}

/** "3" or "1.5-3" as person-weeks; undefined when it is neither. */
function parseEffort(text: string | undefined): number | [number, number] | undefined {
  if (!text?.trim()) return undefined;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:[-–]\s*(\d+(?:[.,]\d+)?))?\s*$/.exec(text);
  if (!m) return undefined;
  const a = Number(m[1].replace(",", "."));
  return m[2] ? [a, Number(m[2].replace(",", "."))] : a;
}

/** The three criteria of one item: what was entered, else what Studio can
 *  propose — Confidence from its checked hypotheses first, else from what
 *  the requirement rests on — else unknown. */
function inputsOf(r: SpecRequirement, e: Entry, claims: CheckedClaim[]): IceInputs {
  const effort = parseEffort(e.effort);
  return {
    impact: e.impact !== undefined ? { score: e.impact, origin: "entered", basis: "Entered by a person." } : unknown("Needs the expected contribution to the goal."),
    confidence:
      e.confidence !== undefined
        ? { score: e.confidence, origin: "entered", basis: "Entered by a person." }
        : (confidenceFromHypotheses(claims) ?? confidenceFromBasis(r.basis)),
    ease: effort !== undefined ? easeFromEffort(effort, `${e.effort} person-weeks, entered.`, "entered") : unknown("Needs an effort estimate in person-weeks."),
  };
}

export function PrioritiesScreen({
  read,
  projectId,
  reviews,
  onSave,
  claimsFor,
  onTrace,
  onConfirm,
}: {
  read: SpecRequirements | { error: string } | null;
  projectId: string;
  /** The hypotheses about a requirement, as far as checking them went:
   *  what Confidence is first proposed from. */
  claimsFor?: (r: SpecRequirement) => CheckedClaim[];
  /** The project's decisions: the working set and the confirmed orders are among them. */
  reviews: SpecModelReview[];
  /** Keep changes to the working set, or a confirmed order, with the project. */
  onSave?: (writes: ReviewWrite[]) => Promise<void>;
  /** Propose the confirmed order as docs/priorities.md: versioned by the
   *  repository, reviewed like any change. */
  onConfirm?: (content: string) => Promise<SpecModelWrite>;
  /** Follow a requirement in the Requirements view. */
  onTrace: (id: string) => void;
}) {
  const kept = useMemo(() => workingSet(reviews), [reviews]);
  const history = useMemo(() => confirmations(reviews), [reviews]);
  // What is on screen: the project's set, with this visit's typing laid over
  // it until it is saved.
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [saved, setSaved] = useState<WorkingSet>(kept);
  useEffect(() => setSaved((s) => ({ items: kept.items, entries: { ...kept.entries, ...stillTyped(s, pending.current) } })), [kept]);
  useEffect(() => () => pending.current.forEach((t) => clearTimeout(t)), []);
  const [legacy, setLegacy] = useState(() => loadLegacy(projectId));
  const [adding, setAdding] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ busy: boolean; done?: SpecModelWrite; error?: string }>({ busy: false });
  const save = (writes: ReviewWrite[]) => {
    if (!onSave || writes.length === 0) return Promise.resolve();
    return onSave(writes)
      .then(() => setSaveError(null))
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));
  };

  const items = read && "items" in read ? read.items : [];
  const candidates = useMemo(
    () => items.filter((r) => {
      const c = classify(r);
      return c && (c.type === "functional" || c.type === "user");
    }),
    [items],
  );
  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);
  const chosen = saved.items.map((id) => byId.get(id)).filter((r): r is SpecRequirement => !!r);
  const scored = chosen.map((r) => {
    const claims = claimsFor?.(r) ?? [];
    const inputs = inputsOf(r, saved.entries[r.id] ?? {}, claims);
    return { r, inputs, claims, ice: iceScore(inputs) };
  });
  const ordering = orderItems(
    scored.map((s) => ({ id: s.r.id, score: s.ice.score ?? s.ice.range?.[0] ?? null })),
    new Map(),
  );
  const rank = new Map(ordering.order.map((id, n) => [id, n + 1]));
  const rows = [...scored].sort((a, b) => rank.get(a.r.id)! - rank.get(b.r.id)!);

  const setEntry = (id: string, patch: Partial<Entry>) => {
    const entry = { ...saved.entries[id], ...patch };
    setSaved((s) => ({ ...s, entries: { ...s.entries, [id]: entry } }));
    // Typing is saved once it pauses, one item at a time.
    clearTimeout(pending.current.get(id));
    pending.current.set(
      id,
      setTimeout(() => {
        pending.current.delete(id);
        void save([itemWrite(id, entry)]);
      }, SAVE_AFTER_MS),
    );
  };
  const add = (ids: string[]) => {
    const fresh = ids.filter((id) => !saved.items.includes(id));
    setSaved((s) => ({ ...s, items: [...s.items, ...fresh] }));
    void save(fresh.map((id) => itemWrite(id, saved.entries[id] ?? {})));
  };
  const remove = (id: string) => {
    setSaved((s) => ({ ...s, items: s.items.filter((x) => x !== id) }));
    void save([removeWrite(id)]);
  };
  const bringLegacy = async () => {
    if (!legacy) return;
    const ids = legacy.items.filter((id) => !saved.items.includes(id));
    await save(ids.map((id) => itemWrite(id, legacy.entries[id] ?? {})));
    dropLegacy(projectId);
    setLegacy(null);
  };
  const q = adding.trim().toLowerCase();
  const matches = q ? candidates.filter((r) => !saved.items.includes(r.id) && `${r.id} ${r.title ?? ""}`.toLowerCase().includes(q)).slice(0, 8) : [];
  const num = (v: string) => (v.trim() === "" ? undefined : Math.min(10, Math.max(1, Math.round(Number(v)))));
  const scoreText = (ice: (typeof rows)[number]["ice"]) => String(ice.score ?? (ice.range ? `${ice.range[0]}–${ice.range[1]}` : "incomplete"));
  const nowRows: ConfirmedRow[] = rows.map(({ r, ice }) => ({ id: r.id, rank: rank.get(r.id)!, ice: scoreText(ice) }));
  const last = history[0];
  const changed = changedSince(last, nowRows);

  if (!read) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;

  return (
    <div className="pr">
      <p className="dm-howto">
        <b>Compare what to build first.</b>{" "}
        <InfoPopover label="How to read this">ICE: the mean of Impact, Confidence and Ease, each 1–10, higher is better. Each value says where it comes from; one nobody knows leaves the score incomplete rather than guessed. Order puts a prerequisite before what needs it, and a tie stays a tie.</InfoPopover>
      </p>
      {legacy && onSave && (
        <div className="card pr-legacy">
          <span>
            This browser still keeps a comparison of {legacy.items.length} item{legacy.items.length === 1 ? "" : "s"} from before
            it was kept with the project.
          </span>
          <button type="button" className="primary" onClick={() => void bringLegacy()}>
            Bring it into the project
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              dropLegacy(projectId);
              setLegacy(null);
            }}
          >
            Discard it
          </button>
        </div>
      )}
      {saveError && <div className="error">Not saved: {saveError}</div>}
      <div className="card pr-add">
        <input type="search" placeholder="Add a functional or user requirement by id or title" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a requirement" />
        <button
          type="button"
          className="ghost"
          onClick={() => add(candidates.filter((r) => r.priority === "p1").map((r) => r.id))}
          title="Every functional and user requirement the documents mark p1"
        >
          Add all p1 ({candidates.filter((r) => r.priority === "p1").length})
        </button>
        {matches.length > 0 && (
          <ul className="pr-matches">
            {matches.map((r) => (
              <li key={r.id}>
                <button type="button" className="dm-link" onClick={() => add([r.id])}>
                  {r.title ?? r.id}
                </button>{" "}
                <code className="hint">{r.id}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nothing to compare yet." body="Add the requirements to weigh against each other." />
      ) : (
        <div className="card">
          <DataTable<(typeof rows)[number]>
            list="priorities"
            urlPrefix="pri."
            rows={rows}
            rowKey={(x) => x.r.id}
            rowLabel={(x) => x.r.title ?? x.r.id}
            pageSize={20}
            empty={{ title: "Nothing to compare yet." }}
            columns={[
              {
                id: "rank",
                header: "#",
                num: true,
                compare: (a, b) => rank.get(a.r.id)! - rank.get(b.r.id)!,
                cell: ({ r }) => (
                  <span className="pr-rank">
                    {rank.get(r.id)}
                    {ordering.ties.has(r.id) && <small title="Same score as its neighbour: a tie, not a decision">tie</small>}
                  </span>
                ),
              },
              {
                id: "req",
                header: "Requirement",
                cell: ({ r }) => (
                  <span>
                    <button type="button" className="dm-link" onClick={() => onTrace(r.id)}>
                      {r.title ?? r.id}
                    </button>
                    <small className="hint" style={{ display: "block" }}>
                      {REQUIREMENT_TYPE_LABEL[classify(r)!.type]} · {r.priority ?? "no mark"} · <code>{r.id}</code>
                    </small>
                  </span>
                ),
              },
              {
                id: "impact",
                header: "Impact",
                cell: ({ r, inputs }) => (
                  <Cell c={inputs.impact}>
                    <input type="number" min={1} max={10} aria-label={`${ICE_LABEL.impact} of ${r.id}`} value={(saved.entries[r.id] ?? {}).impact ?? ""} onChange={(ev) => setEntry(r.id, { impact: num(ev.target.value) })} />
                  </Cell>
                ),
              },
              {
                id: "confidence",
                header: "Confidence",
                cell: ({ r, inputs, claims }) => (
                  <Cell c={inputs.confidence}>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      aria-label={`${ICE_LABEL.confidence} of ${r.id}`}
                      placeholder={inputs.confidence.origin === "estimated" ? String(inputs.confidence.score) : ""}
                      value={(saved.entries[r.id] ?? {}).confidence ?? ""}
                      onChange={(ev) => setEntry(r.id, { confidence: num(ev.target.value) })}
                    />
                    {claims.length > 0 && (
                      <small className="pr-claims" title={inputs.confidence.basis}>
                        {claims.map((c) => `${c.claim}: ${EVIDENCE_LABEL[c.state].toLowerCase()}`).join("; ")}
                      </small>
                    )}
                  </Cell>
                ),
              },
              {
                id: "ease",
                header: "Effort, weeks → Ease",
                cell: ({ r, inputs }) => (
                  <Cell c={inputs.ease}>
                    <input type="text" aria-label={`Effort of ${r.id}`} placeholder="3 or 1.5-3" value={(saved.entries[r.id] ?? {}).effort ?? ""} onChange={(ev) => setEntry(r.id, { effort: ev.target.value })} />
                  </Cell>
                ),
              },
              {
                id: "ice",
                header: "ICE",
                num: true,
                cell: ({ ice }) => (
                  <span className="pr-score">
                    {ice.score !== null ? ice.score : ice.range ? `${ice.range[0]}–${ice.range[1]}` : "—"}
                    {ice.missing.length > 0 && <small>needs {ice.missing.map((k) => ICE_LABEL[k]).join(", ")}</small>}
                  </span>
                ),
              },
            ]}
            actions={({ r }) => [{ label: "Take out of the comparison", onSelect: () => remove(r.id) }]}
          />
        </div>
      )}
      {rows.length > 0 && onConfirm && (
        <div className="dm-actions">
          <button
            type="button"
            className="primary"
            disabled={confirm.busy}
            onClick={() => {
              setConfirm({ busy: true });
              const lines = [
                "---",
                "type: material",
                "---",
                "",
                "# Priorities",
                "",
                "<!-- Confirmed in Studio. ICE: the mean of Impact, Confidence and Ease, each 1–10. -->",
                "",
                "| # | Requirement | Impact | Confidence | Ease | ICE |",
                "|---|---|---|---|---|---|",
                ...rows.map(({ r, inputs, ice }) => {
                  const v = (k: IceCriterion) =>
                    `${inputs[k].range ? `${inputs[k].range![0]}–${inputs[k].range![1]}` : (inputs[k].score ?? "unknown")} (${ORIGIN_LABEL[inputs[k].origin]})`;
                  return `| ${rank.get(r.id)}${ordering.ties.has(r.id) ? " (tie)" : ""} | ${(r.title ?? r.id).replace(/\|/g, "\\|")} \`${r.id}\` | ${v("impact")} | ${v("confidence")} | ${v("ease")} | ${scoreText(ice)} |`;
                }),
                "",
              ];
              onConfirm(lines.join("\n"))
                .then(async (done) => {
                  // The confirmation is kept with the project too: who, when,
                  // the pull request and the order, to compare against later.
                  await save([confirmationWrite(new Date().toISOString(), done, nowRows)]);
                  setConfirm({ busy: false, done });
                })
                .catch((e: unknown) => setConfirm({ busy: false, error: e instanceof Error ? e.message : String(e) }));
            }}
            title="Write this order to docs/priorities.md as a pull request: a confirmed, versioned snapshot"
          >
            {confirm.busy ? "Proposing…" : "Confirm as docs/priorities.md"}
          </button>
          {confirm.done && (
            <span className="dm-saved">
              ✓ Proposed{" "}
              {confirm.done.pr_url ? (
                <a href={confirm.done.pr_url} target="_blank" rel="noreferrer">
                  as a pull request
                </a>
              ) : (
                <>on {confirm.done.branch}</>
              )}
            </span>
          )}
          {confirm.error && <span className="error-inline">{confirm.error}</span>}
        </div>
      )}
      {history.length > 0 && (
        <details className="card pr-history" open={changed}>
          <summary className="dm-h">
            {changed ? "Changed since the order confirmed last" : "The order is as confirmed last"} ·{" "}
            {history.length} confirmed order{history.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {history.map((c) => (
              <li key={c.key}>
                {new Date(c.at).toLocaleString()} —{" "}
                {c.prUrl ? (
                  <a href={c.prUrl} target="_blank" rel="noreferrer">
                    the pull request
                  </a>
                ) : (
                  c.branch && <>on {c.branch}</>
                )}{" "}
                <span className="hint">
                  {c.rows
                    .slice(0, 5)
                    .map((r) => `${r.rank}. ${r.id} (${r.ice})`)
                    .join(", ")}
                  {c.rows.length + c.more > 5 ? `, … ${c.rows.length + c.more} in all` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {rows.length > 0 && (
        <p className="hint">
          The working set is kept with the project, for everyone who opens it; a confirmed order is a document in the repository
          and a record here. Confidence starts from what each requirement rests on — an assumption is a weak claim, a citation
          indirect evidence — and is yours to correct with what was observed.
        </p>
      )}
    </div>
  );
}

/** One ICE criterion's cell: the field, then its value and where it comes from. */
function Cell({ c, children }: { c: Criterion; children: ReactNode }) {
  return (
    <span className={`pr-cell pr-${c.origin}`} title={c.basis}>
      {children}
      <small>
        {c.range ? `${c.range[0]}–${c.range[1]}` : (c.score ?? "?")} · {ORIGIN_LABEL[c.origin]}
      </small>
    </span>
  );
}
