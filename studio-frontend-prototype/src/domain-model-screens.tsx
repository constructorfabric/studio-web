/* The Domain model tab's three views (domain-model-views.ts): what to resolve
 * before building, the model as a map of connected entities, and each
 * requirement followed from its passage to its code. */
import { useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import type { SpecModelEntityEdit, SpecModelSentence, SpecModelWrite } from "./api";
import {
  cardFields,
  cardSize,
  entityDraft,
  LAYER_TITLE,
  LAYER_WHAT,
  layerOf,
  placeCards,
  relationEdges,
  weight,
  type DiagramEdge,
  type Layer,
  type PlacedCard,
} from "./domain-layers";
import { DataTable } from "./data-table";
import {
  blockItems,
  blocks,
  findEntities,
  mapEdges,
  neighbours,
  readiness,
  RESOLVE_LABEL,
  resolveQueue,
  traceChain,
  type MapEdge,
  type ResolveItem,
} from "./domain-model-views";
import { FactReviewContext } from "./review-state";
import {
  classify,
  REQUIREMENT_TYPE_LABEL,
  REQUIREMENT_TYPE_NOUN,
  REQUIREMENT_TYPE_WHAT,
  requirementProblems,
  tallyTypes,
  type RequirementType,
} from "./requirement-types";
import { DOC_QUALITY_LABEL, docQuality, relationSentence, type DocQualityItem } from "./doc-quality";
import { PROVISIONAL_NOTE } from "./saved-entities";
import { entityGears, type GearRef, type Keeper } from "./entity-gears";
import { EmptyState, InfoPopover, StatusChip } from "./ui-standard";
import {
  BASIS_LABEL,
  BASIS_ORDER,
  codeSpans,
  factsByKind,
  sideLabel,
  workLabel,
  workState,
  type Entity,
  type GlossaryEntry,
  type RequirementTraces,
  type SpecModelFact,
  type SpecModelFinding,
  type SpecModelSide,
  type SpecRequirement,
  type SpecRequirements,
  type WorkItem,
  type WorkLinks,
} from "./spec-model";

type OpenFile = ((path: string) => void) | undefined;

/** Text the backend wrote with backticked names, the names set as code. */
export function Prose({ text }: { text: string }) {
  return <>{codeSpans(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text))}</>;
}

export function SideLink({ side, onOpenFile }: { side: SpecModelSide; onOpenFile?: (path: string) => void }) {
  return (
    <div className="sm-side">
      <button className="sm-side-path" disabled={!onOpenFile} onClick={() => onOpenFile?.(side.path)} title="Open in the editor">
        {sideLabel(side)}
      </button>
      {side.quote && <blockquote className="sm-quote">{side.quote}</blockquote>}
    </div>
  );
}

export function FactRow({ fact, onOpenFile }: { fact: SpecModelFact; onOpenFile?: (path: string) => void }) {
  const inactive = fact.status !== "active";
  const review = useContext(FactReviewContext);
  const state = review?.stateOf(fact);
  return (
    <div className={`sm-fact${inactive ? " sm-inactive" : ""}${state ? ` sm-${state}` : ""}`}>
      {review && !fact.provisional && (
        <span className="sm-review" role="group" aria-label="Review this reading">
          <button
            type="button"
            aria-pressed={state === "accepted"}
            title={state === "accepted" ? "Accepted — click to put it back as proposed" : "Accept this reading"}
            onClick={() => void review.review([fact], state === "accepted" ? "proposed" : "accepted")}
          >
            ✓
          </button>
          <button type="button" title="Reject this reading: it leaves the model and is not proposed again" onClick={() => void review.review([fact], "rejected")}>
            ✗
          </button>
        </span>
      )}
      <div>
        {fact.aspect && <span className="sm-aspect">{fact.aspect}: </span>}
        {fact.value ? <strong>{fact.value}</strong> : fact.text}
        {inactive && (
          <span className="sm-status" title={fact.status_because}>
            {fact.status}
          </span>
        )}
        {fact.provisional && <span className="sm-status dm-provisional">{PROVISIONAL_NOTE}</span>}
        {state && review?.reviewedEarlier?.(fact) && (
          <span className="sm-status" title="Its document changed since: the words are the same, the text around them may not be">
            {state} at an earlier revision
          </span>
        )}
      </div>
      {fact.value && fact.text && <div className="hint">{fact.text}</div>}
      <SideLink side={fact.source} onOpenFile={onOpenFile} />
    </div>
  );
}

// ── 1 · To resolve ──────────────────────────────────────────────────────────

export function ResolveView({
  findings,
  requirements,
  entities = [],
  glossary = [],
  onDecide,
  onPropose,
  onSave,
  onSameThing,
  onProposeSentence,
  revisions,
  onTrace,
  onOpenFile,
  built,
  people = [],
  onCreateIssue,
  issueOf,
}: {
  /** Who an issue can be assigned to: members with a GitHub login. */
  people?: { name: string; login: string }[];
  /** Open an issue for a row in the project's repository. */
  onCreateIssue?: (key: string, issue: { title: string; body: string; assignees: string[] }) => Promise<{ number: number; url?: string | null }>;
  /** The issue already opened for a row, if any. */
  issueOf?: (key: string) => string | null;
  findings: SpecModelFinding[];
  requirements: SpecRequirements | null;
  /** The model's entities, saved edits laid over: what the documentation
   *  could say better is read off them. */
  entities?: Entity[];
  glossary?: GlossaryEntry[];
  /** Save an entity's section of docs/domain-model.md. */
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  /** Read the second word as the first everywhere (the glossary's merge). */
  onSameThing?: (alias: string, of: string) => Promise<void>;
  /** Open a pull request adding a sentence to a document. */
  onProposeSentence?: (s: SpecModelSentence) => Promise<SpecModelWrite>;
  /** Each read document's revision, by path. */
  revisions?: Map<string, string>;
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  /** Open a pull request with a finding's fix on its document. */
  onPropose?: (f: SpecModelFinding) => Promise<SpecModelWrite>;
  /** Follow a requirement in the Requirements view. */
  onTrace: (id: string) => void;
  onOpenFile: OpenFile;
  built: boolean;
}) {
  const queue = useMemo(() => resolveQueue(findings, requirements?.items ?? []), [findings, requirements]);
  // Kept apart from the queue's readiness: a thin passage does not stop a
  // build, it makes the next reader's job harder.
  const better = useMemo(() => docQuality(entities, glossary, revisions), [entities, glossary, revisions]);
  const ready = readiness(queue, requirements?.by_basis ?? {}, requirements?.total ?? 0);

  // One row per thing to decide, whichever list it came from: the queue (what
  // stops a build or should be looked at) and the documentation's thin
  // places. The card a row stood for opens under it.
  const issues: IssueRow[] = [
    ...queue.map((i) => ({
      key: i.key,
      kind: i.concern ? "Possible conflict" : RESOLVE_LABEL[i.type],
      group: (blocks(i) ? "blocks" : i.done ? "decided" : "look") as IssueGroup,
      title: i.title,
      side: i.sides[0] ?? null,
      tone: i.tone,
      queue: i,
    })),
    ...better.map((d) => ({
      key: d.key,
      kind: DOC_QUALITY_LABEL[d.type],
      group: "improve" as IssueGroup,
      title: d.title,
      side: d.sides[0] ?? null,
      tone: "warn" as const,
      doc: d,
    })),
  ];
  const n = (g: IssueGroup) => issues.filter((i) => i.group === g).length;
  const [opening, setOpening] = useState<string | null>(null);
  return (
    <div className="dm-resolve">
      <div className="dm-verdict-line" data-verdict>
        <b className={ready.ready ? "ok" : "bad"}>{ready.ready ? "Nothing stops a build" : `${ready.blocking} stop a build`}</b>
        <span className="sub">
          · {n("look")} to look at · {n("improve")} ways to make the documentation better
          {ready.total > 0 ? ` · ${ready.cited} of ${ready.total} requirements cite a source` : ""}
        </span>
        {!built && <span className="sub"> · build the model to look for disagreements</span>}
      </div>
      <div className="card">
        <DataTable<IssueRow>
          list="dm-issues"
          urlPrefix="iss."
          rows={issues}
          rowKey={(r) => r.key}
          rowLabel={(r) => r.title}
          pageSize={20}
          search={{ placeholder: "Search issues" }}
          searchText={(r) => [r.title, r.kind, r.side?.path]}
          filters={[
            {
              id: "group",
              allLabel: "Everything",
              kind: "chips",
              options: (
                [
                  ["blocks", "Stops a build"],
                  ["look", "To look at"],
                  ["improve", "Improve the docs"],
                  ["decided", "Decided"],
                ] as const
              )
                .filter(([g]) => n(g) > 0)
                .map(([g, label]) => ({ value: g, label })),
              match: (r, v) => r.group === v,
            },
            {
              id: "kind",
              allLabel: "Every kind",
              kind: "select",
              options: [...new Set(issues.map((i) => i.kind))].sort().map((k) => ({ value: k, label: k })),
              match: (r, v) => r.kind === v,
            },
            {
              id: "doc",
              allLabel: "Every document",
              kind: "select",
              options: [...new Set(issues.map((i) => i.side?.path).filter((p): p is string => !!p))].sort().map((p) => ({ value: p, label: p })),
              match: (r, v) => r.side?.path === v,
            },
          ]}
          empty={{ title: built ? "Nothing to decide here." : "Every reference resolves.", body: built ? undefined : "Build the model to look for disagreements between documents." }}
          columns={[
            {
              id: "kind",
              header: "Kind",
              compare: (x, y) => x.kind.localeCompare(y.kind),
              cell: (r) => <StatusChip tone={r.tone === "bad" ? "danger" : "warn"}>{r.kind}</StatusChip>,
            },
            { id: "title", header: "Issue", cell: (r) => <Prose text={r.title} /> },
            {
              id: "where",
              header: "Where",
              cell: (r) =>
                r.side ? (
                  <code className="dm-where" title={r.side.path}>
                    {r.side.path.split("/").pop()}
                    {r.side.line_start ? `:${r.side.line_start}` : ""}
                  </code>
                ) : (
                  <span className="sub">—</span>
                ),
            },
            {
              id: "group",
              header: "Status",
              compare: (x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group),
              cell: (r) => {
                const url = issueOf?.(r.key);
                return url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="dm-issue-link">
                    issue #{url.split("/").pop()}
                  </a>
                ) : (
                  <span className={`sub dm-status-${r.group}`}>{GROUP_LABEL[r.group]}</span>
                );
              },
            },
          ]}
          actions={(r) =>
            onCreateIssue && !issueOf?.(r.key) ? [{ label: "Create issue…", onSelect: () => setOpening(opening === r.key ? null : r.key) }] : []
          }
          detail={(r) =>
            opening === r.key && onCreateIssue ? (
              <IssueForm row={r} people={people} onCancel={() => setOpening(null)} onCreate={(issue) => onCreateIssue(r.key, issue).then((x) => (setOpening(null), x))} />
            ) : null
          }
          expand={(r) =>
            r.queue ? (
              <QueueItem item={r.queue} onDecide={onDecide} onPropose={onPropose} onTrace={onTrace} onOpenFile={onOpenFile} />
            ) : r.doc ? (
              <DocItem item={r.doc} onSave={onSave} onSameThing={onSameThing} onProposeSentence={onProposeSentence} onOpenFile={onOpenFile} />
            ) : null
          }
        />
      </div>
    </div>
  );
}

/** An issue's text from a row: what is wrong, where, and what to do. */
function issueBody(r: IssueRow): string {
  const hint = r.queue?.hint ?? r.doc?.hint ?? "";
  const sides = r.queue?.sides ?? r.doc?.sides ?? [];
  const lines = [`**${r.kind}** — ${GROUP_LABEL[r.group]}.`, "", hint, ""];
  if (sides.length) {
    lines.push("Where:");
    for (const s of sides.slice(0, 5)) lines.push(`- \`${s.path}${s.line_start ? `:${s.line_start}` : ""}\`${s.quote ? ` — “${s.quote.trim().slice(0, 200)}”` : ""}`);
    lines.push("");
  }
  const fix = r.queue?.finding?.edit;
  if (fix) lines.push(`Proposed fix in \`${fix.path}\`:`, "", "```diff", `- ${fix.replace}`, `+ ${fix.with}`, "```", "");
  lines.push("_Opened from the project's Issues in Constructor Studio._");
  return lines.join("\n");
}

/** The issue to open for a row: its title and text, editable, and who it is for. */
function IssueForm({
  row,
  people,
  onCreate,
  onCancel,
}: {
  row: IssueRow;
  people: { name: string; login: string }[];
  onCreate: (issue: { title: string; body: string; assignees: string[] }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(row.title.slice(0, 240));
  const [body, setBody] = useState(() => issueBody(row));
  const [assignee, setAssignee] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  return (
    <div className="dm-issue-form" data-issue-form>
      <label className="dm-field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="dm-field">
        <span>Description</span>
        <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="dm-actions">
        <label>
          Assign to{" "}
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign to">
            <option value="">nobody yet</option>
            {people.map((p) => (
              <option key={p.login} value={p.login}>
                {p.name} (@{p.login})
              </option>
            ))}
          </select>
        </label>
        {people.length === 0 && <span className="hint">No member has a GitHub login on their profile yet.</span>}
        <button
          type="button"
          className="primary"
          disabled={state.busy || !title.trim()}
          onClick={() => {
            setState({ busy: true });
            onCreate({ title: title.trim(), body, assignees: assignee ? [assignee] : [] }).catch((e: unknown) =>
              setState({ busy: false, error: e instanceof Error ? e.message : String(e) }),
            );
          }}
        >
          {state.busy ? "Opening…" : "Open the issue"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        {state.error && <span className="error-inline">{state.error}</span>}
      </div>
    </div>
  );
}

type IssueGroup = "blocks" | "look" | "improve" | "decided";
const GROUP_ORDER: IssueGroup[] = ["blocks", "look", "improve", "decided"];
const GROUP_LABEL: Record<IssueGroup, string> = {
  blocks: "stops a build",
  look: "to look at",
  improve: "improves the docs",
  decided: "decided",
};

/** One thing to decide, from the queue or from the documentation's thin
 *  places: the Issues table's row. */
interface IssueRow {
  key: string;
  kind: string;
  group: IssueGroup;
  title: string;
  side: SpecModelSide | null;
  tone: "bad" | "warn";
  queue?: ResolveItem;
  doc?: DocQualityItem;
}

function QueueItem({
  item,
  onDecide,
  onPropose,
  onTrace,
  onOpenFile,
}: {
  item: ResolveItem;
  onDecide: (f: SpecModelFinding, d: "confirmed" | "dismissed") => void;
  onPropose?: (f: SpecModelFinding) => Promise<SpecModelWrite>;
  onTrace: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  const f = item.finding;
  const [proposal, setProposal] = useState<{ busy: boolean; done?: SpecModelWrite; error?: string } | null>(null);
  const propose = async () => {
    if (!f || !onPropose) return;
    setProposal({ busy: true });
    try {
      setProposal({ busy: false, done: await onPropose(f) });
    } catch (e) {
      setProposal({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const r = item.requirement;
  return (
    <article className={`card dm-item${item.done ? " dm-done" : ""}`} data-item={item.key}>
      <header>
        <StatusChip tone={item.tone === "bad" ? "danger" : "warn"}>{item.concern ? "Possible conflict" : RESOLVE_LABEL[item.type]}</StatusChip>
        <b>
          <Prose text={item.title} />
        </b>
        {r && (
          <button type="button" className="dm-link" onClick={() => onTrace(r.id)}>
            trace it
          </button>
        )}
      </header>
      <div className="hint">{item.hint}</div>
      <div className="sm-sides sm-two">
        {item.sides.slice(0, 3).map((s, i) => (
          <SideLink key={i} side={s} onOpenFile={onOpenFile} />
        ))}
        {item.sides.length > 3 && <div className="hint">and {item.sides.length - 3} more places</div>}
      </div>
      {f?.edit && (
        <div className="sm-fix">
          <span className="hint">Fix in {f.edit.path}:</span>
          <del>{f.edit.replace}</del>
          <ins>{f.edit.with}</ins>
        </div>
      )}
      {f && !f.edit && f.decide.length > 0 && (
        <div className="sm-fix">
          <span className="hint">Choose:</span>
          <ul>
            {f.decide.map((o) => (
              <li key={o}>
                <Prose text={o} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="dm-actions">
        {f ? (
          item.done ? (
            <>
              <span className="hint">{f.decision === "confirmed" ? "✓ Marked as a real problem" : "✓ Marked as fine"}</span>
            </>
          ) : (
            <>
              {f.edit && onPropose && !proposal?.done && (
                <button type="button" className="primary" disabled={proposal?.busy} onClick={() => void propose()} title="Open a pull request with this change on the document">
                  {proposal?.busy ? "Proposing…" : "Propose this change"}
                </button>
              )}
              {proposal?.done && (
                <span className="dm-saved">
                  ✓ Proposed{" "}
                  {proposal.done.pr_url ? (
                    <a href={proposal.done.pr_url} target="_blank" rel="noreferrer">
                      as a pull request
                    </a>
                  ) : (
                    <>on {proposal.done.branch}</>
                  )}
                </span>
              )}
              {proposal?.error && <span className="error-inline">{proposal.error}</span>}
              {f.sides[0] && onOpenFile && (
                <button type="button" className={f.edit && onPropose ? "ghost" : "primary"} onClick={() => onOpenFile(f.sides[0].path)}>
                  Fix it in the editor
                </button>
              )}
              <button type="button" className="ghost" onClick={() => onDecide(f, "confirmed")} title="Keep it on the list as a real problem">
                It is a real problem
              </button>
              <button type="button" className="ghost" onClick={() => onDecide(f, "dismissed")} title="Take it off the list">
                It is fine
              </button>
            </>
          )
        ) : (
          r && (
            <>
              {onOpenFile && (
                <button type="button" className="primary" onClick={() => onOpenFile(r.defined_in.path)}>
                  {item.type === "question" ? "Answer it in the document" : item.type === "assumption" ? "Say how it is checked" : "Add its source"}
                </button>
              )}
            </>
          )
        )}
      </div>
    </article>
  );
}

/** A change that makes the documentation better, ready to save. The text it
 *  proposes is editable first; saving it goes through the same call as the
 *  model map's editor, and the item leaves the list at once because the tab
 *  lays the saved entity over the model (saved-entities.ts). */
function DocItem({
  item,
  onSave,
  onSameThing,
  onProposeSentence,
  onOpenFile,
}: {
  item: DocQualityItem;
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  onSameThing?: (alias: string, of: string) => Promise<void>;
  onProposeSentence?: (s: SpecModelSentence) => Promise<SpecModelWrite>;
  onOpenFile: OpenFile;
}) {
  const [edit, setEdit] = useState(item.edit ?? null);
  const [verb, setVerb] = useState(item.sentence?.verb ?? "");
  const [state, setState] = useState<{ busy: boolean; error?: string; done?: SpecModelWrite }>({ busy: false });
  const run = async (act: () => Promise<unknown>) => {
    setState({ busy: true });
    try {
      const done = await act();
      setState({ busy: false, done: item.sentence ? (done as SpecModelWrite) : undefined });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  // The relation a one-sided item adds is the last of the draft's.
  const added = item.type === "onesided" && edit ? edit.relations[edit.relations.length - 1] : null;
  const pair = item.pair;
  return (
    <article className="card dm-item" data-item={item.key}>
      <header>
        <StatusChip tone="warn">{DOC_QUALITY_LABEL[item.type]}</StatusChip>
        <b>{item.title}</b>
      </header>
      <div className="hint">{item.hint}</div>
      {item.sides.length > 0 && (
        <div className="sm-sides sm-two">
          {item.sides.map((s, i) => (
            <SideLink key={i} side={s} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
      {edit && !added && (
        <label className="dm-field">
          <span>What it is, as {edit.name}&apos;s section of docs/domain-model.md will say</span>
          <textarea rows={2} value={edit.definition ?? ""} onChange={(e) => setEdit({ ...edit, definition: e.target.value })} />
        </label>
      )}
      {item.sentence && (
        <div className="dm-field">
          <span>
            Added to {item.sentence.path} after line {item.sentence.line}
          </span>
          <div className="dm-inverse">
            <b>{item.sentence.name}</b>
            <input aria-label="Verb" value={verb} onChange={(e) => setVerb(e.target.value)} />
            <b>{item.sentence.target}</b>
          </div>
          <blockquote className="dm-sentence">{relationSentence(item.sentence.name, verb, item.sentence.target)}</blockquote>
        </div>
      )}
      {edit && added && (
        <div className="dm-field">
          <span>Added to {edit.name}&apos;s section of docs/domain-model.md</span>
          <div className="dm-inverse">
            <b>{edit.name}</b>
            <input
              aria-label="Verb"
              value={added.verb}
              onChange={(e) => setEdit({ ...edit, relations: edit.relations.map((r) => (r === added ? { ...r, verb: e.target.value } : r)) })}
            />
            <b>{added.target}</b>
          </div>
        </div>
      )}
      <div className="dm-actions">
        {edit && onSave && (
          <button
            type="button"
            className="primary"
            disabled={state.busy || (added ? !added.verb.trim() : !edit.definition?.trim())}
            onClick={() => void run(() => onSave({ ...edit, definition: edit.definition?.trim() || null }))}
            title="Save the entity's section of docs/domain-model.md, the way the repository takes changes"
          >
            {state.busy ? "Saving…" : item.type === "nodefinition" ? "Save definition" : item.type === "onesided" ? "Add the other side" : "Add to the domain model"}
          </button>
        )}
        {item.sentence && onProposeSentence && !state.done && (
          <button
            type="button"
            className="primary"
            disabled={state.busy || !verb.trim()}
            onClick={() => {
              const s = item.sentence!;
              void run(() =>
                onProposeSentence({
                  path: s.path,
                  revision: s.revision,
                  line: s.line,
                  sentence: relationSentence(s.name, verb, s.target),
                  why: `say how ${s.name} relates to ${s.target}`,
                }),
              );
            }}
            title="Open a pull request adding this sentence to the document"
          >
            {state.busy ? "Proposing…" : "Propose this change"}
          </button>
        )}
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
        {pair && onSameThing && (
          <button type="button" className="primary" disabled={state.busy} onClick={() => void run(() => onSameThing(pair.b.key, pair.a.key))} title={`Read “${pair.b.name}” as “${pair.a.name}”`}>
            Same thing
          </button>
        )}
        {state.error && <span className="error-inline">{state.error}</span>}
      </div>
    </article>
  );
}

// ── 2 · Model map ───────────────────────────────────────────────────────────

/** How many entities a layer shows at first: few enough to read. */
const SHOW_STEPS = [25, 40, 80, Infinity] as const;

export function ModelMapView({
  entities,
  onOpenFile,
  onSave,
  saved = new Map(),
  gears,
}: {
  entities: Entity[];
  onOpenFile: OpenFile;
  /** Save an edited entity to the project's documentation. */
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  /** What was saved this visit, by key: shown until the next build reads it. */
  saved?: Map<string, SpecModelWrite>;
  /** The gears that could keep a Domain entity; null while unknown, so no gap is claimed. */
  gears?: GearRef[] | null;
}) {
  const [layer, setLayer] = useState<Layer>("domain");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // The entity the pointer is on: the panel shows it until one is picked.
  const [peek, setPeek] = useState<string | null>(null);
  // Where the panel came from, newest last, for its Back.
  const [back, setBack] = useState<string[]>([]);
  // A cut of the layer the overview offers.
  const [only, setOnly] = useState<Only | null>(null);
  // A table first: thousands of entities read as rows, not as a drawing.
  const [mode, setMode] = useState<"diagram" | "list">("list");
  const [show, setShow] = useState<number>(25);
  const [mentions, setMentions] = useState(false);

  const layerOfKey = useMemo(() => new Map(entities.map((e) => [e.key, layerOf(e)])), [entities]);
  const counts = useMemo(() => {
    const c: Record<Layer, number> = { domain: 0, system: 0, deployment: 0 };
    let hidden = 0;
    for (const l of layerOfKey.values()) l ? c[l]++ : hidden++;
    return { ...c, hidden };
  }, [layerOfKey]);
  const relations = useMemo(() => relationEdges(entities), [entities]);
  const relationCount = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of relations) {
      out.set(r.from, (out.get(r.from) ?? 0) + 1);
      out.set(r.to, (out.get(r.to) ?? 0) + 1);
    }
    return out;
  }, [relations]);
  // Only what the product is about is kept by a gear; System and Deployment
  // entities are the gears and where they run.
  const keepers = useMemo(
    () => (gears ? entityGears(entities.filter((e) => layerOfKey.get(e.key) === "domain"), gears).byEntity : null),
    [entities, gears, layerOfKey],
  );
  const inLayer = useMemo(() => entities.filter((e) => layerOfKey.get(e.key) === layer), [entities, layer, layerOfKey]);
  const pool = useMemo(
    () =>
      findEntities(entities, query).filter(
        (e) =>
          layerOfKey.get(e.key) === layer &&
          (only !== "unrelated" || !relationCount.get(e.key)) &&
          (only !== "unkept" || (keepers !== null && !keepers.get(e.key))),
      ),
    [entities, query, layer, layerOfKey, only, relationCount, keepers],
  );
  const shown = useMemo(() => [...pool].sort((a, b) => weight(b) - weight(a)).slice(0, show), [pool, show]);
  const allMentions = useMemo(() => (mentions ? mapEdges(entities).filter((e) => e.kind === "mentions") : []), [entities, mentions]);
  const edges = useMemo(() => {
    const keep = new Set(shown.map((e) => e.key));
    const rel = relations.filter((e) => keep.has(e.from) && keep.has(e.to));
    const men = allMentions.filter((e) => keep.has(e.from) && keep.has(e.to) && !rel.some((r) => (r.from === e.from && r.to === e.to) || (r.from === e.to && r.to === e.from)));
    return { rel, men };
  }, [shown, relations, allMentions]);
  const sel = entities.find((e) => e.key === (selected ?? peek)) ?? null;
  const pinned = !!selected && sel?.key === selected;
  /** Show `l`; a cut is the layer's own (`keepers` holds Domain alone). */
  const toLayer = (l: Layer | null | undefined) => {
    if (!l || l === layer) return;
    setLayer(l);
    setOnly(null);
  };
  /** Open `k` in the panel, keeping where it came from for Back; `null`
   *  unpins, and forgets the way back as Unpin does. Either way the panel
   *  leaves what the pointer last showed: the element that showed it may be
   *  gone without a `mouseleave`. */
  const open = (k: string | null) => {
    setPeek(null);
    if (!k) {
      setSelected(null);
      setBack([]);
      return;
    }
    if (selected && k !== selected) setBack((b) => [...b.slice(-19), selected]);
    toLayer(layerOfKey.get(k));
    setSelected(k);
  };
  const goBack = () => {
    const prev = back[back.length - 1];
    setBack((b) => b.slice(0, -1));
    if (!prev) return;
    toLayer(layerOfKey.get(prev));
    setSelected(prev);
  };

  if (entities.length === 0) return <EmptyState title="Nothing read yet." body="Build the model to read the documents." />;

  return (
    <div className="dm-layered">
      <p className="dm-howto">
        <b>See what the application is.</b>{" "}
        <InfoPopover label="How to read this">Pick a layer, then a card: what it holds, how it relates and which passages say so. Missing a relation? A document has to declare it; the model reads it on the next build.</InfoPopover>
      </p>
      <div className="dm-layers" role="tablist" aria-label="Layer">
        {(Object.keys(LAYER_TITLE) as Layer[]).map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={layer === l}
            className={`dm-layer dm-layer-${l}${layer === l ? " on" : ""}`}
            onClick={() => {
              setLayer(l);
              setSelected(null);
              setOnly(null);
              setBack([]);
            }}
          >
            <i />
            <b>{LAYER_TITLE[l]}</b>
            <span className="dm-layer-n">{counts[l]}</span>
            <small>{LAYER_WHAT[l]}</small>
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        Left out: {counts.hidden} words that are not things the product has — identifiers such as ADR-0007 or cpt-…, a word
        used once in passing, what a kit&apos;s templates and examples say. They stay in Requirements and the Glossary.
      </p>
      <div className="dm-map2">
        <div className="card dm-canvas">
          <div className="dm-mapbar">
            <input type="search" placeholder="Find an entity" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an entity" />
{mode === "diagram" && (
              <>
            <span className="dm-seg" role="group" aria-label="How many">
              {SHOW_STEPS.map((n) => (
                <button key={n} type="button" aria-pressed={show === n} onClick={() => setShow(n)}>
                  {n === Infinity ? "all" : n === 25 ? "25 main" : n}
                </button>
              ))}
            </span>
            <label className="hint">
              <input type="checkbox" checked={mentions} onChange={(e) => setMentions(e.target.checked)} /> show mentions
            </label>
              </>
            )}
            <span className="dm-seg" role="group" aria-label="How to show it">
              <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
                Table
              </button>
              <button type="button" aria-pressed={mode === "diagram"} onClick={() => setMode("diagram")}>
                Diagram
              </button>
            </span>
            {only && (
              <button type="button" className="dm-only" onClick={() => setOnly(null)} title="Show the whole layer again">
                {ONLY_TITLE[only]} ×
              </button>
            )}
            <span className="hint" style={{ marginLeft: "auto" }}>
              {shown.length} of {pool.length} · {edges.rel.length} declared relation{edges.rel.length === 1 ? "" : "s"}
            </span>
          </div>
          {mode === "diagram" ? (
            <Diagram entities={shown} layer={layer} relations={edges.rel} mentions={edges.men} selected={selected} onSelect={open} onPeek={setPeek} />
          ) : (
            <DataTable<Entity>
              list="dm-entities"
              urlPrefix="ent."
              rows={pool}
              rowKey={(e) => e.key}
              rowLabel={(e) => e.name}
              pageSize={20}
              onOpen={(e) => open(e.key)}
              onPeek={(e) => setPeek(e?.key ?? null)}
              empty={{ title: only ? `No entity in this layer is ${ONLY_TITLE[only].toLowerCase()}.` : "No entity in this layer matches." }}
              columns={[
                {
                  id: "name",
                  header: "Entity",
                  compare: (a, b) => a.name.localeCompare(b.name),
                  cell: (e) => (
                    <span className={e.key === selected ? "dm-ent-on" : undefined}>
                      <b>{e.name}</b>
                    </span>
                  ),
                },
                { id: "facts", header: "Facts", num: true, compare: (a, b) => a.facts.length - b.facts.length, cell: (e) => e.facts.length },
                { id: "docs", header: "Documents", num: true, compare: (a, b) => a.documents - b.documents, cell: (e) => e.documents },
                {
                  id: "relations",
                  header: "Relations",
                  num: true,
                  compare: (a, b) => relationCount.get(a.key)! - relationCount.get(b.key)!,
                  cell: (e) => relationCount.get(e.key) ?? 0,
                },
                {
                  id: "keeper",
                  header: "Kept by",
                  cell: (e) => {
                    const k = keepers?.get(e.key);
                    return k ? k.gear.label : <span className="sub">—</span>;
                  },
                },
              ]}
            />
          )}
          {mode === "diagram" && (
            <div className="dm-legend">
              <span>
                <svg viewBox="0 0 26 8" width="26" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="26" y2="4" className="dm-edge relation" />
                </svg>
                a relation a document declares, named by its verb
              </span>
              {mentions && (
                <span>
                  <svg viewBox="0 0 26 8" width="26" height="8" aria-hidden="true">
                    <line x1="0" y1="4" x2="26" y2="4" className="dm-edge mentions" />
                  </svg>
                  one names the other
                </span>
              )}
              <span className="hint">scroll to zoom · drag to move</span>
            </div>
          )}
        </div>
        <aside className={`card dm-card${sel && !pinned ? " peek" : ""}`} aria-label="The selected entity">
          {sel && (
            <div className="dm-cardbar">
              {pinned ? (
                <>
                  <button
                    type="button"
                    className="ghost"
                    disabled={back.length === 0}
                    onClick={goBack}
                    title={back.length ? `Back to ${entities.find((e) => e.key === back[back.length - 1])?.name ?? ""}` : "Nothing to go back to"}
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => open(null)}
                    title="Unpin: the panel follows the pointer again"
                  >
                    Unpin ×
                  </button>
                </>
              ) : (
                <span className="hint">Preview · click to pin it</span>
              )}
            </div>
          )}
          {sel ? (
            <EntityCard
              key={sel.key}
              entity={sel}
              names={entities.filter((e) => layerOfKey.get(e.key)).map((e) => e.name)}
              saved={sel.keys.map((k) => saved.get(k)).find((w) => !!w) ?? null}
              onSave={onSave}
              layer={layerOfKey.get(sel.key) ?? null}
              keeper={keepers?.get(sel.key)}
              related={relations
                .filter((r) => r.from === sel.key || r.to === sel.key)
                .map((r) => ({ other: entities.find((e) => e.key === (r.from === sel.key ? r.to : r.from)), verbs: r.verbs }))
                .filter((r): r is { other: Entity; verbs: string[] } => !!r.other)}
              onSelect={open}
              onOpenFile={onOpenFile}
            />
          ) : (
            <LayerOverview
              layer={layer}
              entities={inLayer}
              relationCount={relationCount}
              keepers={keepers}
              only={only}
              onOnly={setOnly}
              onSelect={open}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function Diagram({
  entities,
  layer,
  relations,
  mentions,
  selected,
  onSelect,
  onPeek,
  gaps,
}: {
  entities: Entity[];
  layer: Layer;
  relations: DiagramEdge[];
  mentions: MapEdge[];
  selected: string | null;
  onSelect: (k: string | null) => void;
  /** The card the pointer is on, `null` once it leaves. */
  onPeek?: (k: string | null) => void;
  /** Entities no gear keeps: marked with a small hollow dot. */
  gaps?: Set<string>;
}) {
  const cards = useMemo(
    () =>
      entities.map((e) => {
        const fields = cardFields(e);
        return { key: e.key, name: e.name, fields, ...cardSize(e.name, fields) };
      }),
    [entities],
  );
  const placed = useMemo(() => placeCards(cards, relations), [cards, relations]);
  const at = useMemo(() => new Map(placed.cards.map((c) => [c.key, c])), [placed]);
  const near = selected ? new Set([selected, ...neighbours(selected, relations)]) : null;
  const few = entities.length <= 25;

  // Start on the whole drawing, with a margin, at the frame's proportions.
  const fit = useMemo(() => {
    const pad = 40;
    const w = placed.width + 2 * pad;
    const h = placed.height + 2 * pad;
    const ratio = 900 / 620;
    return w / h > ratio
      ? { x: -pad, y: -pad - (w / ratio - h) / 2, w, h: w / ratio }
      : { x: -pad - (h * ratio - w) / 2, y: -pad, w: h * ratio, h };
  }, [placed]);
  const [view, setView] = useState(fit);
  useEffect(() => setView(fit), [fit]);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const units = (px: number) => (svg.current ? px * (view.w / svg.current.clientWidth) : px);
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.min(fit.w * 2, Math.max(fit.w / 8, view.w * f));
    const h = (w / view.w) * view.h;
    const px = view.x + ((e.clientX - box.left) / box.width) * view.w;
    const py = view.y + ((e.clientY - box.top) / box.height) * view.h;
    setView({ x: px - ((px - view.x) * w) / view.w, y: py - ((py - view.y) * h) / view.h, w, h });
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.vx - units(e.clientX - d.x), y: d.vy - units(e.clientY - d.y) }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(null);
  };

  // A line leaves a card at its centre and bends a little, so two lines
  // between neighbours do not lie on each other.
  const curve = (a: PlacedCard, b: PlacedCard) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2 - (dy / len) * 0.12 * len;
    const my = (a.y + b.y) / 2 + (dx / len) * 0.12 * len;
    return { d: `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`, lx: (a.x + b.x) / 2 - (dy / len) * 0.06 * len, ly: (a.y + b.y) / 2 + (dx / len) * 0.06 * len };
  };

  return (
    <svg
      ref={svg}
      className="dm-diagram"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      role="img"
      aria-label={`${LAYER_TITLE[layer]} entities and how they relate`}
    >
      {mentions.map((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (!a || !b) return null;
        const cold = !!near && !(near.has(e.from) && near.has(e.to));
        return <path key={`m${e.from}|${e.to}`} d={curve(a, b).d} className={`dm-edge mentions${cold ? " cold" : ""}`} />;
      })}
      {relations.map((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (!a || !b) return null;
        const hot = !!selected && (e.from === selected || e.to === selected);
        return <path key={`r${e.from}|${e.to}`} d={curve(a, b).d} className={`dm-edge relation${hot ? " hot" : selected ? " cold" : ""}`} />;
      })}
      {placed.looseTop !== null && (
        <text x={0} y={placed.looseTop} className="dm-loose">
          Not related yet: no document declares how these connect to the rest
        </text>
      )}
      {placed.cards.map((c) => {
        const card = cards.find((x) => x.key === c.key)!;
        const cold = !!near && !near.has(c.key);
        return (
          <g
            key={c.key}
            transform={`translate(${c.x - c.w / 2},${c.y - c.h / 2})`}
            className={`dm-cardnode dm-layer-${layer}${c.key === selected ? " sel" : ""}${cold ? " cold" : ""}`}
            onPointerDown={(ev) => ev.stopPropagation()}
            onMouseEnter={() => onPeek?.(c.key)}
            onMouseLeave={() => onPeek?.(null)}
            onClick={(ev) => {
              ev.stopPropagation();
              onSelect(c.key === selected ? null : c.key);
            }}
            role="button"
            tabIndex={0}
            aria-label={card.name}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(c.key);
              }
            }}
          >
            <rect className="box" width={c.w} height={c.h} rx={8} />
            <rect className="band" x={1} y={1} width={c.w - 2} height={28} rx={7} />
            <rect className="stripe" x={8} y={6} width={4} height={18} rx={2} />
            <text className="title" x={18} y={19}>
              {card.name}
            </text>
            {gaps?.has(c.key) && (
              <circle className="nogear" cx={c.w - 11} cy={15} r={4}>
                <title>No gear keeps it yet</title>
              </circle>
            )}
            {card.fields.map((f, i) => (
              <text key={f} className="field" x={12} y={46 + 16 * i}>
                • {f}
              </text>
            ))}
          </g>
        );
      })}
      {relations.map((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (!a || !b || e.verbs.length === 0) return null;
        const hot = !!selected && (e.from === selected || e.to === selected);
        if (!few && !hot) return null;
        const { lx, ly } = curve(a, b);
        return (
          <text key={`l${e.from}|${e.to}`} x={lx} y={ly} className="dm-verb" textAnchor="middle">
            {e.verbs.slice(0, 2).join(" / ")}
          </text>
        );
      })}
    </svg>
  );
}

function EntityCard({
  entity,
  layer,
  related,
  names,
  saved,
  onSave,
  onSelect,
  onOpenFile,
  keeper,
}: {
  entity: Entity;
  layer: Layer | null;
  /** The gear that keeps it; null when none does; undefined when not asked. */
  keeper?: Keeper | null;
  related: { other: Entity; verbs: string[] }[];
  /** Every entity's name, for a relation's target. */
  names: string[];
  saved: SpecModelWrite | null;
  onSave?: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  onSelect: (k: string) => void;
  onOpenFile: OpenFile;
}) {
  const definition = entity.facts.find((f) => f.kind === "entity");
  const [editing, setEditing] = useState(false);
  const review = useContext(FactReviewContext);
  const reviewable = entity.facts.filter((f) => !f.provisional);
  const proposed = review ? reviewable.filter((f) => !review.stateOf(f)) : [];
  const rejected = review ? review.rejectedOf(entity.keys) : [];
  if (editing && onSave)
    return <EntityEditor entity={entity} names={names} onSave={onSave} onDone={() => setEditing(false)} />;
  return (
    <>
      <div>
        {layer && <span className={`dm-layer-pill dm-layer-${layer}`}>{LAYER_TITLE[layer]}</span>}
        {onSave && (
          <button type="button" className="ghost" style={{ float: "right" }} onClick={() => setEditing(true)} title="Correct what it is, what it holds or how it relates">
            Edit
          </button>
        )}
        <h2 style={{ margin: "4px 0 0" }}>{entity.name}</h2>
        {saved && <SavedNote saved={saved} />}
        <div className="hint">
          {entity.facts.length} facts from {entity.documents} document{entity.documents === 1 ? "" : "s"}
          {review && ` · ${reviewable.length - proposed.length} accepted, ${proposed.length} proposed`}
        </div>
        {review && proposed.length > 0 && (
          <button type="button" className="ghost dm-accept-all" onClick={() => void review.review(proposed, "accepted")} title="Accept every reading of it still proposed, in one action">
            Accept all {proposed.length} proposed
          </button>
        )}
      </div>
      {definition && (
        <blockquote className="sm-quote">
          {definition.text}
          {definition.provisional && <span className="sm-status dm-provisional">{PROVISIONAL_NOTE}</span>}
        </blockquote>
      )}
      {keeper && (
        <div className="dm-keeper" data-keeper={keeper.gear.id}>
          Kept by <b>{keeper.gear.label}</b>
          {keeper.gear.origin === "project" ? " (this project's gear)" : ""}
          <small>{keeper.why}</small>
        </div>
      )}
      {related.length > 0 && <Neighbourhood entity={entity} related={related} onSelect={onSelect} />}
      {related.length > 0 && (
        <section className="dm-rels">
          <div className="dm-h">How it relates</div>
          {related.map((r) => (
            <div key={r.other.key}>
              <b className="dm-verbtext" title={r.verbs.join(" / ")}>
                {r.verbs.length > 3 ? `${r.verbs.slice(0, 3).join(" / ")} …` : r.verbs.join(" / ") || "relates to"}
              </b>{" "}
              <button type="button" className="dm-link" onClick={() => onSelect(r.other.key)}>
                {r.other.name}
              </button>
            </div>
          ))}
        </section>
      )}
      <FactsFiltered facts={entity.facts.filter((f) => f !== definition && f.kind !== "relation")} onOpenFile={onOpenFile} />
      {review && rejected.length > 0 && (
        <details className="sm-kind dm-rejected">
          <summary>
            {rejected.length} rejected reading{rejected.length === 1 ? "" : "s"}
          </summary>
          {rejected.map((f, i) => (
            <div key={i} className="sm-fact sm-rejected">
              <div>
                {f.aspect && <span className="sm-aspect">{f.aspect}: </span>}
                {f.value || f.text}{" "}
                <button type="button" className="dm-link" onClick={() => void review.review([f], "proposed")}>
                  put back
                </button>
              </div>
              <SideLink side={f.source} onOpenFile={onOpenFile} />
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/** What the overview can narrow a layer to. */
type Only = "unrelated" | "unkept";

const ONLY_TITLE: Record<Only, string> = {
  unrelated: "Related to nothing",
  unkept: "Kept by no gear",
};

/** The layer at a glance, while nothing is picked: what is most described
 *  and most related, and what is loose -- each a way into the table. */
function LayerOverview({
  layer,
  entities,
  relationCount,
  keepers,
  only,
  onOnly,
  onSelect,
}: {
  layer: Layer;
  entities: Entity[];
  relationCount: Map<string, number>;
  /** Null when what keeps an entity is not known. */
  keepers: Map<string, Keeper | null> | null;
  only: Only | null;
  onOnly: (o: Only | null) => void;
  onSelect: (k: string) => void;
}) {
  const top = (by: (e: Entity) => number) => [...entities].sort((a, b) => by(b) - by(a) || a.name.localeCompare(b.name)).slice(0, 6);
  const connected = top((e) => relationCount.get(e.key) ?? 0).filter((e) => relationCount.get(e.key));
  const described = top((e) => e.facts.length);
  const unrelated = entities.filter((e) => !relationCount.get(e.key)).length;
  const unkept = layer === "domain" && keepers ? entities.filter((e) => !keepers.get(e.key)).length : null;
  const chips = (list: Entity[], n: (e: Entity) => number) => (
    <div className="dm-ov-chips">
      {list.map((e) => (
        <button
          key={e.key}
          type="button"
          className="dm-ov-chip"
          onClick={() => onSelect(e.key)}
        >
          {e.name} <span className="sub">{n(e)}</span>
        </button>
      ))}
    </div>
  );
  const cut = (o: Only, count: number, what: string) => (
    <button type="button" className={`dm-ov-cut${only === o ? " on" : ""}`} aria-pressed={only === o} onClick={() => onOnly(only === o ? null : o)} disabled={count === 0}>
      <b>{count}</b> {what}
    </button>
  );
  return (
    <div className="dm-overview" data-dm-overview={layer}>
      <span className={`dm-layer-pill dm-layer-${layer}`}>{LAYER_TITLE[layer]}</span>
      <p style={{ margin: "4px 0 0" }}>{LAYER_WHAT[layer]}.</p>
      <div className="dm-h">Most related</div>
      {connected.length ? chips(connected, (e) => relationCount.get(e.key) ?? 0) : <p className="hint">No relation is declared in this layer yet.</p>}
      <div className="dm-h">Most described</div>
      {chips(described, (e) => e.facts.length)}
      <div className="dm-h">Loose ends</div>
      <div className="dm-ov-cuts">
        {cut("unrelated", unrelated, "related to nothing: a document has to declare how")}
        {unkept !== null && cut("unkept", unkept, "kept by no gear of the product")}
      </div>
      <p className="hint" style={{ margin: "8px 0 0" }}>Point at a row to see it here; click it to keep it.</p>
    </div>
  );
}

/** The entity in the middle and what it relates to around it, each line
 *  named by its verb. A neighbour opens on click. */
function Neighbourhood({
  entity,
  related,
  onSelect,
}: {
  entity: Entity;
  related: { other: Entity; verbs: string[] }[];
  onSelect: (k: string) => void;
}) {
  const [on, setOn] = useState<string | null>(null);
  const shown = related.slice(0, 10);
  const W = 300;
  const H = shown.length > 6 ? 220 : 180;
  const cx = W / 2;
  const cy = H / 2;
  const rx = W / 2 - 52;
  const ry = H / 2 - 22;
  const at = shown.map((r, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / shown.length;
    return { ...r, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  return (
    <svg className="dm-ego" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`What ${entity.name} relates to`}>
      {at.map((n) => (
        <g key={`l:${n.other.key}`} className={`dm-ego-edge${on === n.other.key ? " on" : ""}`}>
          <line x1={cx} y1={cy} x2={n.x} y2={n.y} />
          {(on === n.other.key || shown.length <= 4) && n.verbs[0] && (
            <text x={(cx + n.x) / 2} y={(cy + n.y) / 2 - 3} textAnchor="middle">
              {clip(n.verbs[0], 18)}
            </text>
          )}
        </g>
      ))}
      <g className="dm-ego-me">
        <rect x={cx - 56} y={cy - 13} width={112} height={26} rx={13} />
        <text x={cx} y={cy + 4} textAnchor="middle">
          {clip(entity.name, 16)}
        </text>
      </g>
      {at.map((n) => (
        <g
          key={n.other.key}
          className={`dm-ego-node${on === n.other.key ? " on" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={`${n.verbs[0] ?? "relates to"} ${n.other.name}`}
          onMouseEnter={() => setOn(n.other.key)}
          onMouseLeave={() => setOn(null)}
          onFocus={() => setOn(n.other.key)}
          onBlur={() => setOn(null)}
          onClick={() => onSelect(n.other.key)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(n.other.key);
            }
          }}
        >
          <title>{`${n.verbs.join(" / ") || "relates to"} ${n.other.name}`}</title>
          <rect x={n.x - 46} y={n.y - 11} width={92} height={22} rx={11} />
          <text x={n.x} y={n.y + 4} textAnchor="middle">
            {clip(n.other.name, 14)}
          </text>
        </g>
      ))}
      {related.length > shown.length && (
        <text className="dm-ego-more" x={W - 4} y={H - 4} textAnchor="end">
          +{related.length - shown.length} more below
        </text>
      )}
    </svg>
  );
}

/** An entity's facts by kind, narrowed by a word and by kind. */
function FactsFiltered({ facts, onOpenFile }: { facts: SpecModelFact[]; onOpenFile: OpenFile }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const groups = factsByKind(facts);
  const needle = q.trim().toLowerCase();
  const matches = (f: SpecModelFact) =>
    !needle || [f.text, f.value, f.aspect, f.source.path].some((t) => (t ?? "").toLowerCase().includes(needle));
  if (facts.length === 0) return null;
  const visible = groups
    .filter((g) => !kind || g.kind === kind)
    .map((g) => ({ ...g, facts: g.facts.filter(matches) }))
    .filter((g) => g.facts.length > 0);
  return (
    <div className="dm-facts">
      {facts.length > 6 && (
        <div className="dm-facts-bar">
          <input type="search" placeholder="Find in its facts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find in its facts" />
          <span className="dm-facts-kinds">
            {groups.map((g) => (
              <button key={g.kind} type="button" aria-pressed={kind === g.kind} onClick={() => setKind(kind === g.kind ? null : g.kind)}>
                {KIND_TITLE[g.kind] ?? g.kind} <span className="sub">{g.facts.length}</span>
              </button>
            ))}
          </span>
        </div>
      )}
      {visible.map((g) => (
        <section key={g.kind} className="sm-kind">
          <h3>{KIND_TITLE[g.kind] ?? g.kind}</h3>
          {g.facts.map((f, i) => (
            <FactRow key={i} fact={f} onOpenFile={onOpenFile} />
          ))}
        </section>
      ))}
      {needle && visible.length === 0 && (
        <p className="hint">
          No {kind ? `${(KIND_TITLE[kind] ?? kind).toLowerCase()} ` : ""}fact says “{q.trim()}”.
        </p>
      )}
    </div>
  );
}

/** Where a saved edit went, and when the model will show it. */
function SavedNote({ saved }: { saved: SpecModelWrite }) {
  return (
    <div className="dm-saved">
      ✓ Saved to <code>{saved.path}</code>{" "}
      {saved.pr_url ? (
        <a href={saved.pr_url} target="_blank" rel="noreferrer">
          as a pull request
        </a>
      ) : (
        <>on {saved.branch}</>
      )}
      . The model reads it on its next build.
    </div>
  );
}

/** Correct an entity: what it is, what it holds, how it relates. Saved as
 *  its section of docs/domain-model.md, the way the repository takes changes. */
function EntityEditor({
  entity,
  names,
  onSave,
  onDone,
}: {
  entity: Entity;
  names: string[];
  onSave: (edit: SpecModelEntityEdit) => Promise<SpecModelWrite>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(() => entityDraft(entity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = `dm-names-${entity.key.replace(/\W+/g, "-")}`;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: draft.name,
        definition: draft.definition.trim() || null,
        fields: draft.fields.filter((f) => f.name.trim()),
        relations: draft.relations.filter((r) => r.verb.trim() && r.target.trim()),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="dm-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="dm-h">Edit {entity.name}</div>
      <p className="hint" style={{ margin: 0 }}>
        Saved to <code>docs/domain-model.md</code> in the project&apos;s repository, one section per entity. The model reads
        it on its next build.
      </p>
      <label className="dm-field">
        <span>What it is</span>
        <textarea rows={3} value={draft.definition} onChange={(e) => setDraft({ ...draft, definition: e.target.value })} placeholder={`A ${entity.name} is …`} />
      </label>
      <div className="dm-field">
        <span>What it holds</span>
        {draft.fields.map((f, i) => (
          <div key={i} className="dm-row2">
            <input aria-label="Field" value={f.name} placeholder="field" onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input aria-label="What it holds" value={f.meaning} placeholder="what it holds" onChange={(e) => setDraft({ ...draft, fields: draft.fields.map((x, j) => (j === i ? { ...x, meaning: e.target.value } : x)) })} />
            <button type="button" className="ghost" aria-label="Remove field" onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="dm-link" onClick={() => setDraft({ ...draft, fields: [...draft.fields, { name: "", meaning: "" }] })}>
          + field
        </button>
      </div>
      <div className="dm-field">
        <span>How it relates</span>
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {draft.relations.map((r, i) => (
          <div key={i} className="dm-row2">
            <input aria-label="Verb" value={r.verb} placeholder="belongs to" onChange={(e) => setDraft({ ...draft, relations: draft.relations.map((x, j) => (j === i ? { ...x, verb: e.target.value } : x)) })} />
            <input aria-label="Entity" list={listId} value={r.target} placeholder="entity" onChange={(e) => setDraft({ ...draft, relations: draft.relations.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) })} />
            <button type="button" className="ghost" aria-label="Remove relation" onClick={() => setDraft({ ...draft, relations: draft.relations.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="dm-link" onClick={() => setDraft({ ...draft, relations: [...draft.relations, { verb: "", target: "" }] })}>
          + relation
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="dm-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save to the documentation"}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const KIND_TITLE: Record<string, string> = {
  entity: "What it is",
  attribute: "What it holds",
  relation: "How it relates",
  constraint: "Must always be true",
  lifecycle: "How it changes",
  requirement: "Asked of it",
  decision: "Decided",
  role: "Who uses the product",
  action: "What is done to it",
};

// ── 3 · Requirements ────────────────────────────────────────────────────────

export function RequirementsView({
  read,
  traces,
  work,
  selected,
  onSelect,
  onOpenFile,
}: {
  read: SpecRequirements | { error: string } | null;
  traces: RequirementTraces | { error: string } | null;
  work: WorkLinks | { error: string } | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  // Requirements by type by default; the parts of the design that carry them
  // are a list of their own, not rows of "no basis stated".
  const [type, setType] = useState<RequirementType | "all" | "design">("all");
  const classes = useMemo(
    () => new Map(read && "items" in read ? read.items.map((r) => [r.id, classify(r)]) : []),
    [read],
  );
  const tally = useMemo(() => (read && "items" in read ? tallyTypes(read.items) : null), [read]);
  const problems = useMemo(() => (read && "items" in read ? requirementProblems(read.items) : []), [read]);
  const traceById = useMemo(
    () => new Map(traces && "items" in traces ? traces.items.map((t) => [t.id, t]) : []),
    [traces],
  );
  const workById = useMemo(() => new Map(work && "items" in work ? work.items.map((w) => [w.id, w.work]) : []), [work]);
  if (!read) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  const pool = read.items.filter((r) => {
    const c = classes.get(r.id) ?? null;
    if (type === "design") return c === null;
    if (!c) return false;
    return type === "all" || c.type === type;
  });
  const byBasis = (b: string) => pool.filter((r) => r.basis === b).length;
  const shownType = type !== "all" && type !== "design" ? tally?.types.find((t) => t.type === type) : undefined;
  const sel = read.items.find((r) => r.id === selected) ?? null;
  const codeOf = (id: string) => traceById.get(id)?.code.length ?? 0;
  const testsOf = (id: string) => traceById.get(id)?.tests.length ?? 0;

  return (
    <>
    <p className="dm-howto">
      <b>Follow a requirement to the code.</b>{" "}
      <InfoPopover label="How to read this">Pick one: the chain shows the passage that states it, what it rests on, the work that names it and where the code and tests name it — a name found, not proof it is covered. An orange step is where it stops.</InfoPopover>
    </p>
    {problems.length > 0 && (
      <details className="card dm-rproblems" aria-label="Problems in the requirements">
        <summary className="dm-h">
          {problems.length} problem{problems.length === 1 ? "" : "s"} in the requirements —{" "}
          {problems.filter((p) => p.severity === "missing").length} missing types,{" "}
          {problems.filter((p) => p.severity === "few").length} too few,{" "}
          {problems.filter((p) => p.severity === "ungrounded").length} resting on nothing
        </summary>
        {problems.map((p) => (
          <div key={`${p.severity}:${p.type}`} className={`dm-rproblem ${p.severity}`}>
            <StatusChip tone={p.severity === "missing" ? "danger" : "warn"}>
              {p.severity === "missing" ? "Missing" : p.severity === "few" ? "Too few" : "No basis"}
            </StatusChip>
            <div>
              <b>{p.title}.</b> <span className="hint">{p.why}</span>
              <div className="dm-rwhere">
                Write them in{" "}
                {p.where.path && onOpenFile ? (
                  <button type="button" className="dm-link" onClick={() => onOpenFile(p.where.path!)}>
                    {p.where.path}
                  </button>
                ) : (
                  <span>the product requirements</span>
                )}
                , {p.where.section}, each under its own id.
              </div>
            </div>
            <button type="button" className="ghost" onClick={() => setType(p.type)}>
              Show {REQUIREMENT_TYPE_NOUN[p.type]}
            </button>
          </div>
        ))}
      </details>
    )}
    {tally && (
      <div className="dm-rtypes" role="group" aria-label="Requirements by type">
        <button type="button" className={`dm-rtype${type === "all" ? " on" : ""}`} aria-pressed={type === "all"} onClick={() => setType("all")}>
          <b>{tally.types.reduce((n, t) => n + t.n, 0)}</b>
          <span>All requirements</span>
        </button>
        {tally.types.map((t) => (
          <button
            key={t.type}
            type="button"
            className={`dm-rtype${type === t.type ? " on" : ""}${t.n === 0 ? " gap" : ""}`}
            aria-pressed={type === t.type}
            title={`${REQUIREMENT_TYPE_LABEL[t.type]}: ${REQUIREMENT_TYPE_WHAT[t.type]}`}
            onClick={() => setType(type === t.type ? "all" : t.type)}
          >
            <b>{t.n}</b>
            <span>{REQUIREMENT_TYPE_LABEL[t.type]}</span>
            {t.n > 0 ? (
              <i className="dm-rtype-bar" title={`${t.grounded} of ${t.n} cite a source or give a reason`}>
                <i style={{ width: `${(t.grounded / t.n) * 100}%` }} />
              </i>
            ) : (
              <small>none written</small>
            )}
          </button>
        ))}
        <button type="button" className={`dm-rtype dm-rtype-design${type === "design" ? " on" : ""}`} aria-pressed={type === "design"} onClick={() => setType(type === "design" ? "all" : "design")}>
          <b>{tally.design}</b>
          <span>Design elements</span>
          <small>what carries them</small>
        </button>
      </div>
    )}
    {shownType && shownType.n === 0 && (
      <p className="dm-rgap">
        <b>No {REQUIREMENT_TYPE_NOUN[shownType.type]} are written.</b> They say{" "}
        {REQUIREMENT_TYPE_WHAT[shownType.type]}. Add them to the product requirements, each under its own id.
      </p>
    )}
    <div className="dm-reqs">
      <div className="card dm-reqlist">
        <DataTable<SpecRequirement>
          list="dm-reqs"
          urlPrefix="req."
          rows={pool}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.title ?? r.id}
          pageSize={20}
          onOpen={(r) => onSelect(r.id)}
          search={{ placeholder: "Find by id, title or text" }}
          searchText={(r) => [r.id, r.title, r.text]}
          filters={[
            {
              id: "basis",
              allLabel: "Any basis",
              kind: "chips",
              options: BASIS_ORDER.filter((b) => byBasis(b) > 0).map((b) => ({ value: b, label: BASIS_LABEL[b] })),
              match: (r, v) => r.basis === v,
            },
            ...(type !== "design"
              ? [
                  {
                    id: "level",
                    allLabel: "Any level",
                    kind: "select" as const,
                    options: (["business", "user", "system"] as const).map((l) => ({ value: l, label: l.charAt(0).toUpperCase() + l.slice(1) })),
                    match: (r: SpecRequirement, v: string) => classes.get(r.id)?.level === v,
                  },
                  {
                    id: "nature",
                    allLabel: "Any nature",
                    kind: "select" as const,
                    options: [
                      { value: "functional", label: "Functional" },
                      { value: "nonfunctional", label: "Non-functional" },
                    ],
                    match: (r: SpecRequirement, v: string) => classes.get(r.id)?.nature === v,
                  },
                ]
              : []),
          ]}
          empty={{ title: "Nothing matches." }}
          columns={[
            {
              id: "title",
              header: "Requirement",
              compare: (a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id),
              cell: (r) => (
                <span className={r.id === selected ? "dm-ent-on" : undefined}>
                  <b>{r.title ?? r.id}</b>
                  <div>
                    <code className="hint">{r.id}</code>
                  </div>
                </span>
              ),
            },
            {
              id: "type",
              header: "Type",
              cell: (r) =>
                classes.get(r.id) ? (
                  <span className="sm-sev dm-rtype-pill" title={r.kind ?? undefined}>
                    {REQUIREMENT_TYPE_LABEL[classes.get(r.id)!.type]}
                  </span>
                ) : (
                  r.kind && <span className="sm-sev">{r.kind}</span>
                ),
            },
            { id: "basis", header: "Basis", cell: (r) => <span className={`sm-sev sm-basis-${r.basis}`}>{BASIS_LABEL[r.basis]}</span> },
            { id: "priority", header: "Priority", compare: (a, b) => (a.priority ?? "z").localeCompare(b.priority ?? "z"), cell: (r) => r.priority ?? <span className="sub">—</span> },
            {
              id: "reach",
              header: "Named in",
              cell: (r) => (
                <span className="dm-marks">
                  <Mark n={codeOf(r.id)} what="code" known={!!traces && "items" in traces} />
                  <Mark n={(workById.get(r.id) ?? []).length || r.work} what="work" known />
                  <Mark n={testsOf(r.id)} what="tests" known={!!traces && "items" in traces} />
                </span>
              ),
            },
          ]}
        />
      </div>
      <aside className="card dm-chain" aria-label="Where the requirement comes from and how far it got">
        {sel ? (
          <Chain r={sel} traces={traces} work={workById.get(sel.id) ?? []} onSelect={onSelect} onOpenFile={onOpenFile} />
        ) : (
          <>
            <div className="dm-h">Trace a requirement</div>
            <p className="hint" style={{ margin: 0 }}>
              Pick a requirement to follow it from the passage that states it, through the documents that use it and the work that names
              it, to the code and tests that name it.
            </p>
          </>
        )}
      </aside>
    </div>
    </>
  );
}

function Mark({ n, what, known }: { n: number; what: string; known: boolean }) {
  return (
    <span className={`dm-mark${n ? " on" : ""}`} title={!known ? `${what}: not read yet` : n ? `${n} ${what}` : `no ${what} yet`}>
      {n ? "✓" : "–"} {what}
    </span>
  );
}

function Block({ text, onSelect }: { text: string; onSelect: (id: string) => void }) {
  const items = blockItems(text);
  const tokens = (item: ReturnType<typeof blockItems>[number]) =>
    item.map((t, i) => {
      switch (t.t) {
        case "done":
          return (
            <StatusChip key={i} tone="ok">
              done
            </StatusChip>
          );
        case "todo":
          return (
            <StatusChip key={i} tone="warn">
              to do
            </StatusChip>
          );
        case "priority":
          return (
            <span key={i} className="sm-sev">
              {t.v}
            </span>
          );
        case "id":
          return (
            <button key={i} type="button" className="dm-idchip" onClick={() => onSelect(t.v)}>
              {t.v}
            </button>
          );
        case "code":
          return <code key={i}>{t.v}</code>;
        default:
          return <span key={i}>{t.v}</span>;
      }
    });
  if (items.length <= 1) return <div className="dm-block">{items[0] ? tokens(items[0]) : null}</div>;
  return (
    <ul className="dm-block">
      {items.map((item, i) => (
        <li key={i}>{tokens(item)}</li>
      ))}
    </ul>
  );
}

function Chain({
  r,
  traces,
  work,
  onSelect,
  onOpenFile,
}: {
  r: SpecRequirement;
  traces: RequirementTraces | { error: string } | null;
  work: WorkItem[];
  onSelect: (id: string) => void;
  onOpenFile: OpenFile;
}) {
  const trace = traces && "items" in traces ? (traces.items.find((t) => t.id === r.id) ?? null) : null;
  const steps = traceChain(r, trace, work);
  return (
    <>
      <div>
        <code className="hint">{r.id}</code>
        <h2 style={{ margin: "2px 0 4px" }}>{r.title ?? r.id}</h2>
        <span className={`sm-sev sm-basis-${r.basis}`}>{BASIS_LABEL[r.basis]}</span>
        {r.because && <span className="hint"> “{r.because}”</span>}
      </div>
      <Block text={r.text} onSelect={onSelect} />
      {traces && "error" in traces && <div className="hint">The code could not be read: {traces.error}</div>}
      <div className="dm-h" style={{ marginTop: 8 }}>
        From the passage to the code
      </div>
      <ol className="dm-steps">
        {steps.map((s) => (
          <li key={s.label} className={s.on ? "on" : "off"}>
            <b>{s.label}</b>
            {s.sides.slice(0, 6).map((side, i) => (
              <SideLink key={i} side={side} onOpenFile={onOpenFile} />
            ))}
            {s.ids.length > 0 && (
              <div className="dm-ids">
                {s.ids.map((id) => (
                  <button key={id} type="button" className="dm-idchip" onClick={() => onSelect(id)}>
                    {id}
                  </button>
                ))}
              </div>
            )}
            {s.work.map((w, i) => (
              <div key={i} className="sm-work-title">
                {w.url ? (
                  <a href={w.url} target="_blank" rel="noreferrer">
                    {workLabel(w)}
                  </a>
                ) : (
                  workLabel(w)
                )}{" "}
                {w.title} <span className="sm-sev">{workState(w)}</span>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}
