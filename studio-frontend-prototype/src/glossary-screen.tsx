/* The project's glossary (glossary-view.ts): what each word means, the pairs
 * that are probably one thing, and the words nobody has defined. Rows come a
 * page at a time and merging searches, so it opens at once however many words
 * the documents use. */
import { useCallback, useContext, useMemo, useState } from "react";

import type { GlossaryDoc, GlossaryDocRow, GlossaryRenameProposal, SpecModelSentence, SpecModelWrite } from "./api";
import { GlossaryDocument } from "./glossary-document";
import { DataTable } from "./data-table";
import { FactRow } from "./domain-model-screens";
import { FactReviewContext } from "./review-state";
import { passageOf } from "./doc-quality";
import { LAYER_TITLE } from "./domain-layers";
import {
  clarifySentence,
  filterRows,
  glossaryRows,
  mergeCandidates,
  renameOffer,
  similarPairs,
  type GlossaryFilter,
  type GlossaryRow,
  pairVerdict,
  type PairAction,
  type PairVerdict,
  type SimilarPair,
} from "./glossary-view";
import type { Entity, GlossaryEntry } from "./spec-model";
import { EmptyState, InfoPopover, StatusChip, type Tone } from "./ui-standard";

type Decide = (key: string, decision: { name: string | null; alias_of: string | null }) => Promise<void>;
type Rename = { from: string; to: string };
/** Offer, after a decision, to carry a rename into the documents. */
type Offer = (rename: Rename | null) => void;


export function GlossaryScreen({
  entries,
  entities,
  onDecide,
  onProposeRename,
  onProposeSentence,
  onDistinct,
  revisions = new Map(),
  onOpenFile,
  onLoadDocument,
  onProposeDocument,
}: {
  /** The glossary the project's documents keep. */
  onLoadDocument?: () => Promise<GlossaryDoc>;
  /** Propose the glossary as docs/glossary.md. */
  onProposeDocument?: (rows: GlossaryDocRow[]) => Promise<SpecModelWrite>;
  /** Open a passage in the project's IDE. */
  onOpenFile?: (path: string) => void;
  entries: GlossaryEntry[];
  entities: Entity[];
  onDecide: Decide;
  onProposeRename: (from: string, to: string) => Promise<GlossaryRenameProposal>;
  /** Open a pull request adding a sentence to a document. */
  onProposeSentence?: (s: SpecModelSentence) => Promise<SpecModelWrite>;
  /** Keep two entries apart for good: they are different things. */
  onDistinct?: (a: string, b: string) => Promise<void>;
  /** Each read document's revision, by path. */
  revisions?: Map<string, string>;
}) {
  const [offer, setOffer] = useState<Rename | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposed, setProposed] = useState<GlossaryRenameProposal | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const offerRename: Offer = (rename) => {
    setOffer(rename);
    setProposed(null);
    setProposeError(null);
  };
  const propose = (rename: Rename) => {
    setProposing(true);
    setProposeError(null);
    onProposeRename(rename.from, rename.to)
      .then((r) => setProposed(r))
      .catch((e: unknown) => setProposeError(e instanceof Error ? e.message : String(e)))
      .finally(() => setProposing(false));
  };
  const [filter, setFilter] = useState<GlossaryFilter>("all");
  const [text, setText] = useState("");
  /** Pairs a person said are different things: hidden at once, and kept
   *  apart for good once the decision is saved. */
  const [apart, setApart] = useState<Set<string>>(new Set());
  const keepApart = (p: SimilarPair) => {
    setApart((s) => new Set(s).add(`${p.a.key}|${p.b.key}`));
    void onDistinct?.(p.a.key, p.b.key);
  };
  /** The pair whose clarifying sentence is open. */
  const [clarifying, setClarifying] = useState<string | null>(null);
  const rows = useMemo(() => glossaryRows(entries, entities), [entries, entities]);
  const pairs = useMemo(() => similarPairs(entries).filter((p) => !apart.has(`${p.a.key}|${p.b.key}`)), [entries, apart]);
  const review = useContext(FactReviewContext);
  /** The definition a term goes by: one a member accepted, else the first. */
  const chosenDef = useCallback(
    (r: GlossaryRow) => r.definitions.find((f) => review?.stateOf(f) === "accepted") ?? r.definitions[0] ?? null,
    [review],
  );
  const settled = useCallback(
    (r: GlossaryRow) => r.entry.chosen || r.definitions.some((f) => review?.stateOf(f) === "accepted"),
    [review],
  );
  const validated = (r: GlossaryRow) => {
    const d = chosenDef(r);
    return d ? review?.stateOf(d) ?? null : null;
  };
  const list = useMemo(() => filterRows(rows, filter, text, pairs), [rows, filter, text, pairs]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.entry.key, r])), [rows]);
  const verdicts = useMemo(() => new Map<string, PairVerdict>(pairs.map((p) => [`${p.a.key}|${p.b.key}`, pairVerdict(p, (k) => rowByKey.get(k))])), [pairs, rowByKey]);
  const verdictOf = (p: SimilarPair) => verdicts.get(`${p.a.key}|${p.b.key}`)!;
  const undefinedCount = useMemo(() => rows.filter((r) => !r.definition && r.layer !== null).length, [rows]);
  const named = useMemo(() => rows.filter((r) => r.entry.chosen || r.entry.aliases.length > 0).length, [rows]);

  if (entries.length === 0) return <EmptyState title="Nothing read yet." body="Build the model to read the documents." />;

  const chip = (id: GlossaryFilter, label: string, n: number) => (
    <button
      type="button"
      className={filter === id ? "chip on" : "chip"}
      onClick={() => setFilter(id)}
    >
      {label} <span className="chip-n">{n}</span>
    </button>
  );

  return (
    <div className="gl">
      <p className="dm-howto">
        <b>Settle the project&apos;s words.</b>{" "}
        <InfoPopover label="How to read this">Give each thing one name, merge two names of one thing, and define what nobody has. The model, its checks and every document&apos;s review then read the same word the same way.</InfoPopover>
      </p>
      {onLoadDocument && onProposeDocument && (
        <GlossaryDocument rows={rows} defOf={chosenDef} settled={settled} load={onLoadDocument} propose={onProposeDocument} />
      )}
      <div className="gl-bar">
        <input type="search" placeholder="Find a word or what it means" value={text} onChange={(e) => setText(e.target.value)} aria-label="Find a word" />
        {chip("all", "All", rows.length)}
        {chip("similar", "Maybe one thing", pairs.length)}
        {chip("undefined", "Not defined", undefinedCount)}
        {chip("named", "Settled by you", named)}
      </div>

      {offer && (
        <section className="card gl-offer" aria-live="polite">
          {proposed ? (
            <span>
              Proposed renaming “{offer.from}” to “{offer.to}” in {proposed.files.length} document{proposed.files.length === 1 ? "" : "s"} ({proposed.renamed} use
              {proposed.renamed === 1 ? "" : "s"}):{" "}
              {proposed.pr_url ? (
                <a href={proposed.pr_url} target="_blank" rel="noreferrer">
                  {proposed.pr_url}
                </a>
              ) : (
                <code>{proposed.branch}</code>
              )}
            </span>
          ) : (
            <span>
              The documents still say “{offer.from}” (and its plural and possessive forms).{" "}
              <button type="button" className="primary" disabled={proposing} onClick={() => propose(offer)}>
                {proposing ? "Proposing…" : `Propose renaming “${offer.from}” to “${offer.to}” in the documents`}
              </button>
              {proposeError && <span className="hint"> {proposeError}</span>}
            </span>
          )}{" "}
          <button type="button" className="ghost" onClick={() => offerRename(null)}>
            {proposed ? "Close" : "Not now"}
          </button>
        </section>
      )}

      {filter !== "similar" && filter !== "named" && pairs.length > 0 && (
        <p className="dm-verdict-line">
          <b>{pairs.length}</b> pair{pairs.length === 1 ? "" : "s"} of names may be one thing.{" "}
          <button type="button" className="dm-link" onClick={() => setFilter("similar")}>
            Review them with a recommendation for each
          </button>
        </p>
      )}
      {filter === "similar" && (
        <div className="card gl-pairs">
          <DataTable<SimilarPair>
            list="glossary-pairs"
            urlPrefix="pair."
            rows={pairs}
            rowKey={(p) => `${p.a.key}|${p.b.key}`}
            rowLabel={(p) => `${p.a.name} / ${p.b.name}`}
            pageSize={20}
            filters={[
              {
                id: "action",
                allLabel: "Every recommendation",
                kind: "chips",
                options: [
                  { value: "same", label: "Same thing" },
                  { value: "clarify", label: "Clarify in the docs" },
                  { value: "different", label: "Different things" },
                ],
                match: (p, v) => verdictOf(p).action === v,
              },
            ]}
            empty={{ title: "No pair left to decide." }}
            columns={[
              {
                id: "pair",
                header: "Names",
                cell: (p) => (
                  <span>
                    <b>{p.a.name}</b> · <b>{p.b.name}</b>
                    <div className="sub">{p.why}</div>
                  </span>
                ),
              },
              {
                id: "evidence",
                header: "Said",
                cell: (p) => {
                  const e = verdictOf(p).evidence;
                  return (
                    <span className="sub gl-evidence">
                      {e.aFacts} / {e.bFacts} facts · {e.aDocs} / {e.bDocs} docs · {e.shared} shared
                      <br />
                      defined: {e.aDefined ? "✓" : "—"} / {e.bDefined ? "✓" : "—"}
                    </span>
                  );
                },
              },
              {
                id: "recommend",
                header: "Recommended",
                cell: (p) => {
                  const v = verdictOf(p);
                  return (
                    <span>
                      <StatusChip tone={ACTION_TONE[v.action]} data-action={v.action}>{ACTION_LABEL[v.action]}</StatusChip>
                      <div className="sub">{v.why}</div>
                    </span>
                  );
                },
              },
            ]}
            expand={(p) => {
              const v = verdictOf(p);
              const ra = rowByKey.get(p.a.key);
              const rb = rowByKey.get(p.b.key);
              const key = `${p.a.key}|${p.b.key}`;
              return (
                <div className="gl-pair-detail">
                  <div className="gl-pair-sides">
                    {[ra, rb].map((r, k) => (
                      <div key={k}>
                        <div className="dm-h">{(k === 0 ? p.a : p.b).name}</div>
                        {r && r.definitions.length ? (
                          r.definitions.slice(0, 2).map((f, i) => <FactRow key={i} fact={f} onOpenFile={onOpenFile} />)
                        ) : (
                          <p className="sub">No document says what it is.</p>
                        )}
                        {r && <div className="sub">Said in: {r.paths.slice(0, 4).map((x) => x.split("/").pop()).join(", ")}{r.paths.length > 4 ? ` +${r.paths.length - 4}` : ""}</div>}
                      </div>
                    ))}
                  </div>
                  <div className="gl-pair-actions">
                    <button
                      type="button"
                      className={v.action === "same" ? "primary" : "ghost"}
                      title={`Read “${p.b.name}” as “${p.a.name}”`}
                      onClick={() => void onDecide(p.b.key, { name: null, alias_of: p.a.key }).then(() => offerRename(renameOffer(p.b, p.a.name)))}
                    >
                      Same thing
                    </button>
                    {onProposeSentence && (
                      <button
                        type="button"
                        className={v.action === "clarify" ? "primary" : "ghost"}
                        aria-expanded={clarifying === key}
                        onClick={() => setClarifying((c) => (c === key ? null : key))}
                      >
                        Clarify in the docs
                      </button>
                    )}
                    <button type="button" className={v.action === "different" ? "primary" : "ghost"} onClick={() => keepApart(p)}>
                      Different things
                    </button>
                  </div>
                  {onProposeSentence && clarifying === key && (
                    <Clarify pair={p} entities={entities} revisions={revisions} onPropose={onProposeSentence} onDone={() => keepApart(p)} />
                  )}
                </div>
              );
            }}
          />
        </div>
      )}

      {filter !== "similar" && (
      <div className="card">
        <DataTable<GlossaryRow>
          list="glossary"
          urlPrefix="gl."
          rows={list}
          rowKey={(r) => r.entry.key}
          rowLabel={(r) => r.entry.name}
          pageSize={20}
          empty={{ title: "Nothing matches." }}
          columns={[
            {
              id: "term",
              header: "Term",
              compare: (a, b) => a.entry.name.localeCompare(b.entry.name),
              cell: (r) => (
                <span>
                  <b>{r.entry.name}</b>
                  {r.entry.chosen && <span className="sub"> · named by you</span>}
                  {chosenDef(r) && <div className="sub gl-def">{chosenDef(r)!.text}</div>}
                </span>
              ),
            },
            {
              id: "from",
              header: "Definition from",
              cell: (r) => {
                const d = chosenDef(r);
                if (!d) return <span className="sub">—</span>;
                return (
                  <span className="gl-from">
                    <code className="dm-where" title={d.source.path}>
                      {d.source.path.split("/").pop()}
                      {d.source.line_start ? `:${d.source.line_start}` : ""}
                    </code>
                    {r.definitions.length > 1 && <span className="sub"> +{r.definitions.length - 1}</span>}
                  </span>
                );
              },
            },
            {
              id: "validated",
              header: "Validated",
              cell: (r) => {
                const v = validated(r);
                return v === "accepted" ? <span className="gl-ok">✓ accepted</span> : v === "rejected" ? <span className="dm-status-blocks">✗ rejected</span> : r.definitions.length ? <span className="sub">not yet</span> : <span className="sub">—</span>;
              },
            },
            {
              id: "aliases",
              header: "Also written as",
              cell: (r) => {
                const other = [...r.entry.spellings.filter((x) => x !== r.entry.name), ...r.entry.aliases.map((a) => a.name)];
                return other.length ? <span className="sub">{other.slice(0, 3).join(", ")}{other.length > 3 ? ` +${other.length - 3}` : ""}</span> : <span className="sub">—</span>;
              },
            },
            { id: "layer", header: "Layer", cell: (r) => (r.layer ? LAYER_TITLE[r.layer] : <span className="sub">—</span>) },
            { id: "defined", header: "Defined", cell: (r) => (r.definition ? "✓" : r.layer ? <span className="dm-status-blocks">no</span> : <span className="sub">—</span>) },
            { id: "facts", header: "Facts", num: true, compare: (a, b) => a.entry.facts - b.entry.facts, cell: (r) => r.entry.facts },
            { id: "docs", header: "Documents", num: true, compare: (a, b) => a.entry.documents - b.entry.documents, cell: (r) => r.entry.documents },
          ]}
          filters={[
            {
              id: "validated",
              allLabel: "Any definition",
              kind: "chips",
              options: [
                { value: "not-yet", label: "Not validated" },
                { value: "accepted", label: "Accepted" },
                { value: "rejected", label: "Rejected" },
              ],
              match: (r, v) => (v === "not-yet" ? r.definitions.length > 0 && !validated(r) : validated(r) === v),
            },
          ]}
          expand={(r) => (
            <div>
              {r.definitions.length > 0 && (
                <div className="gl-defs">
                  <div className="dm-h">
                    What it is — {r.definitions.length} passage{r.definitions.length === 1 ? "" : "s"} say so; accept the one that is right
                  </div>
                  {r.definitions.map((f, k) => (
                    <FactRow key={k} fact={f} onOpenFile={onOpenFile} />
                  ))}
                </div>
              )}
              <ul className="gl-list">
                <GlossaryItem row={r} entries={entries} onDecide={onDecide} onOffer={offerRename} />
              </ul>
            </div>
          )}
        />
      </div>
      )}
    </div>
  );
}

function GlossaryItem({ row, entries, onDecide, onOffer }: { row: GlossaryRow; entries: GlossaryEntry[]; onDecide: Decide; onOffer: Offer }) {
  const e = row.entry;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const others = e.spellings.filter((s) => s !== e.name);
  const candidates = merging === null ? [] : mergeCandidates(e, entries, merging);
  return (
    <li className="gl-item">
      <div className="gl-head">
        {renaming !== null ? (
          <form
            className="gl-inline"
            onSubmit={(ev) => {
              ev.preventDefault();
              const name = renaming.trim();
              void onDecide(e.key, { name: name || null, alias_of: null }).then(() => {
                setRenaming(null);
                onOffer(renameOffer(e, name));
              });
            }}
          >
            <input autoFocus aria-label={`Name for ${e.name}`} value={renaming} onChange={(ev) => setRenaming(ev.target.value)} />
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" className="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <b className="gl-term">{e.name}</b>
            {row.layer && <span className={`dm-layer-pill dm-layer-${row.layer}`}>{LAYER_TITLE[row.layer]}</span>}
            {e.chosen && <StatusChip tone="ok">named by you</StatusChip>}
            <span className="hint">
              {e.facts} fact{e.facts === 1 ? "" : "s"} · {e.documents} doc{e.documents === 1 ? "" : "s"}
            </span>
          </>
        )}
        {renaming === null && (
          <span className="gl-actions">
            <button type="button" className="dm-link" onClick={() => setRenaming(e.name)}>
              Rename
            </button>
            {e.chosen && (
              <button type="button" className="dm-link" onClick={() => void onDecide(e.key, { name: null, alias_of: null })}>
                Use the documents&apos; name
              </button>
            )}
            <button type="button" className="dm-link" aria-expanded={merging !== null} onClick={() => setMerging(merging === null ? "" : null)}>
              Same thing as…
            </button>
          </span>
        )}
      </div>
      <div className={row.definition ? "gl-def" : "gl-def gl-missing"}>
        {row.definition ?? (row.layer ? "No document says what this is yet." : "A word the documents use; not one of the product's things.")}
      </div>
      {(others.length > 0 || e.aliases.length > 0) && (
        <div className="gl-names">
          {others.length > 0 && <span className="hint">Also written {others.join(", ")}.</span>}
          {e.aliases.map((a) => (
            <button key={a.key} type="button" className="chip" title={`Split “${a.name}” out into a word of its own`} onClick={() => void onDecide(a.key, { name: null, alias_of: null })}>
              = {a.name} ×
            </button>
          ))}
        </div>
      )}
      {merging !== null && (
        <div className="gl-merge">
          <input autoFocus type="search" placeholder={`Which word is “${e.name}” another name for?`} value={merging} onChange={(ev) => setMerging(ev.target.value)} aria-label={`Merge ${e.name} into`} />
          {candidates.map((c) => (
            <button key={c.key} type="button" className="chip" onClick={() => void onDecide(e.key, { name: e.chosen ? e.name : null, alias_of: c.key }).then(() => {
                    setMerging(null);
                    onOffer(renameOffer(e, c.name));
                  })
              }>
              {c.name} <span className="chip-n">{c.facts}</span>
            </button>
          ))}
          {merging.trim() && candidates.length === 0 && <span className="hint">No word matches.</span>}
        </div>
      )}
    </li>
  );
}

/** A sentence that tells two words apart, editable, proposed as a pull
 *  request to the document that describes the longer word, after the passage
 *  that says what it is. The pair leaves the list once it is proposed: the
 *  documents now say they are two things. */
function Clarify({
  pair,
  entities,
  revisions,
  onPropose,
  onDone,
}: {
  pair: SimilarPair;
  entities: Entity[];
  revisions: Map<string, string>;
  onPropose: (s: SpecModelSentence) => Promise<SpecModelWrite>;
  onDone: () => void;
}) {
  const longer = pair.b.key.length >= pair.a.key.length ? pair.b : pair.a;
  const base = longer === pair.b ? pair.a : pair.b;
  const anchor = useMemo(() => {
    const of = (key: string) => entities.find((e) => e.key === key || e.keys.includes(key));
    const e = of(longer.key) ?? of(base.key);
    return e ? passageOf(e, revisions) : null;
  }, [entities, revisions, longer, base]);
  const [text, setText] = useState(() => clarifySentence(pair));
  const [state, setState] = useState<{ busy: boolean; error?: string; done?: SpecModelWrite }>({ busy: false });
  if (!anchor?.source.line_end)
    return <div className="gl-clarify hint">No document read at its current revision describes “{longer.name}”: build the model, then clarify it.</div>;
  const unfinished = !text.trim() || text.includes("…");
  const propose = () => {
    setState({ busy: true });
    onPropose({
      path: anchor.source.path,
      revision: revisions.get(anchor.source.path)!,
      line: anchor.source.line_end!,
      sentence: text,
      why: `tell “${longer.name}” and “${base.name}” apart`,
    })
      .then((done) => setState({ busy: false, done }))
      .catch((e: unknown) => setState({ busy: false, error: e instanceof Error ? e.message : String(e) }));
  };
  return (
    <div className="gl-clarify">
      <label className="dm-field">
        <span>
          Added to {anchor.source.path} after line {anchor.source.line_end}
        </span>
        <textarea rows={2} value={text} disabled={!!state.done} onChange={(e) => setText(e.target.value)} />
      </label>
      {state.done ? (
        <span className="dm-saved">
          ✓ Proposed{" "}
          {state.done.pr_url ? (
            <a href={state.done.pr_url} target="_blank" rel="noreferrer">
              as a pull request
            </a>
          ) : (
            <>on {state.done.branch}</>
          )}{" "}
          <button type="button" className="dm-link" onClick={onDone}>
            done
          </button>
        </span>
      ) : (
        <button type="button" className="primary" disabled={state.busy || unfinished} onClick={propose} title={unfinished ? "Finish the sentence first" : undefined}>
          {state.busy ? "Proposing…" : "Propose this change"}
        </button>
      )}
      {state.error && <span className="error-inline">{state.error}</span>}
    </div>
  );
}

const ACTION_LABEL: Record<PairAction, string> = {
  same: "Same thing",
  clarify: "Clarify in the docs",
  different: "Different things",
};
const ACTION_TONE: Record<PairAction, Tone> = { same: "ok", clarify: "info", different: "neutral" };
