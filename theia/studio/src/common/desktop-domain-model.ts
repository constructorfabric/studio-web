// The project's domain model in the IDE: what its documents say the
// application is, and where they disagree about it (docs/spec-domain-model.md).
//
// The model is the documents gear's (`/studio-documents/v1/spec-model`), the
// one the portal's project tab Domain model draws. This file is its arithmetic
// for the IDE, pure so the view only draws and the tests need no Theia:
// the facts folded into entities, the findings in the order a person works
// through them, and -- the IDE's own part -- where a passage the model read is
// in the file on this machine now.
//
// The folding and the order are the prototype's `spec-model.ts`, kept in step
// by hand: the two front ends share no package, and the backend's
// `rules::subject_key` is what both must match.
//
// A model is read from what is pushed. The file in front may have been edited
// since, so a passage is found by its quote, nearest the line it was read at,
// and a quote no longer in the file is said rather than pinned to a stale line.

export interface DomainModelSide {
    readonly path: string;
    readonly line_start?: number | null;
    readonly line_end?: number | null;
    readonly quote?: string | null;
}

export type FactStatus = 'active' | 'proposed' | 'deferred' | 'superseded' | 'resolved' | 'evidence';

export interface DomainModelFact {
    readonly kind: string;
    readonly subject: string;
    readonly aspect: string;
    readonly value: string;
    readonly text: string;
    readonly status: FactStatus;
    readonly status_because: string;
    readonly source: DomainModelSide;
}

export interface DomainModelDocument {
    readonly path: string;
    readonly revision: string;
    /** `kept`: the server has no copy of the text; the last reading is shown. */
    readonly state: 'extracted' | 'failed' | 'stale' | 'pending' | 'kept';
    readonly facts: number;
    readonly dropped: number;
    readonly error?: string | null;
}

export interface DomainModelBuild {
    readonly running: boolean;
    readonly documents: number;
    readonly done: number;
    readonly candidates: number;
    readonly judged: number;
    readonly current?: string | null;
    readonly error?: string | null;
    readonly started_at?: string | null;
    readonly finished_at?: string | null;
    /** The one document this build reads again, when it was asked for one. */
    readonly path?: string | null;
}

export interface DomainModel {
    readonly build: DomainModelBuild;
    readonly documents: readonly DomainModelDocument[];
    readonly facts: readonly DomainModelFact[];
    /** Typed documents the server has no copy of. Absent from an older server. */
    readonly unread_documents?: number;
    readonly unread_because?: string | null;
}

export type FindingDecision = 'confirmed' | 'dismissed';

export interface DomainModelFinding {
    readonly fingerprint: string;
    readonly rule: string;
    readonly severity: 'high' | 'medium' | 'low';
    readonly message: string;
    readonly sides: readonly DomainModelSide[];
    /** The questions a person answers to resolve it. */
    readonly decide: readonly string[];
    readonly decision?: FindingDecision | null;
}

export interface GlossaryEntry {
    readonly key: string;
    readonly name: string;
    /** Whether a member chose `name`; else it is the most frequent spelling. */
    readonly chosen: boolean;
    readonly spellings: readonly string[];
    readonly aliases: readonly { readonly key: string; readonly name: string }[];
    readonly facts: number;
    readonly documents: number;
}

/** Kinds that describe the need, not a thing the application keeps. */
export const NEED_KINDS: ReadonlySet<string> = new Set(['problem', 'outcome', 'idea', 'benefit', 'scenario']);

/** Where a Studio-held document (a material, a document written in Studio)
 *  sits in the model: no file on any machine. */
export const STUDIO_DOCUMENT_PREFIX = 'studio:';

/** A subject folded so two spellings of one thing meet: case, articles,
 *  punctuation and a plural `s` do not count. The backend's `subject_key`. */
export function subjectKey(subject: string): string {
    return subject
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w && w !== 'the' && w !== 'a' && w !== 'an')
        .map(w => (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w))
        .join(' ');
}

export interface Entity {
    readonly key: string;
    /** The glossary's name, else the spelling the documents use most. */
    readonly name: string;
    readonly facts: readonly DomainModelFact[];
    /** Documents that say something about it. */
    readonly documents: number;
    /** Facts in force. */
    readonly active: number;
}

/** The model's subjects, each with every fact about it, the most described
 *  first. A subject that is only ever a decision is left out: a decision is
 *  not part of the application. */
export function entitiesOf(facts: readonly DomainModelFact[], glossary: readonly GlossaryEntry[] = []): Entity[] {
    const index = new Map<string, GlossaryEntry>();
    for (const entry of glossary) {
        index.set(entry.key, entry);
        entry.aliases.forEach(alias => index.set(alias.key, entry));
    }
    const byKey = new Map<string, { spellings: Map<string, number>; facts: DomainModelFact[] }>();
    for (const fact of facts) {
        if (NEED_KINDS.has(fact.kind)) {
            continue;
        }
        const own = subjectKey(fact.subject);
        if (!own) {
            continue;
        }
        const key = index.get(own)?.key ?? own;
        const group = byKey.get(key) ?? { spellings: new Map<string, number>(), facts: [] };
        group.spellings.set(fact.subject, (group.spellings.get(fact.subject) ?? 0) + 1);
        group.facts.push(fact);
        byKey.set(key, group);
    }
    const out: Entity[] = [];
    for (const [key, group] of byKey) {
        if (group.facts.every(f => f.kind === 'decision')) {
            continue;
        }
        const name = index.get(key)?.name
            ?? [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
        out.push({
            key,
            name,
            facts: group.facts,
            documents: new Set(group.facts.map(f => f.source.path)).size,
            active: group.facts.filter(f => f.status === 'active').length,
        });
    }
    return out.sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name));
}

/** The order a reader wants an entity's facts in: what it is, what it has,
 *  what it relates to, what must hold, how it lives, what is required of it. */
export const KIND_ORDER: readonly string[] = [
    'entity', 'attribute', 'relation', 'role', 'action', 'constraint', 'lifecycle', 'requirement', 'decision',
];

export function factsByKind(facts: readonly DomainModelFact[]): { kind: string; facts: DomainModelFact[] }[] {
    return KIND_ORDER
        .map(kind => ({ kind, facts: facts.filter(f => f.kind === kind) }))
        .filter(group => group.facts.length > 0);
}

const SEVERITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Findings in the order a person works through them: undecided first, then
 *  confirmed, dismissed last; within each, high before low, and
 *  disagreements before references. */
export function orderFindings(findings: readonly DomainModelFinding[]): DomainModelFinding[] {
    const decided = (f: DomainModelFinding) => (f.decision === 'dismissed' ? 2 : f.decision === 'confirmed' ? 1 : 0);
    const family = (f: DomainModelFinding) => (f.rule.startsWith('reference.') ? 1 : 0);
    return [...findings].sort((a, b) =>
        decided(a) - decided(b)
        || (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3)
        || family(a) - family(b)
        || a.rule.localeCompare(b.rule));
}

/** What a rule is called on the screen. */
export function ruleLabel(rule: string): string {
    const labels: Record<string, string> = {
        'contradiction.value': 'Two values',
        'contradiction.cardinality': 'Cardinality',
        'contradiction.lifecycle': 'Lifecycle',
        'contradiction.access': 'Access',
        'contradiction.decision': 'Against a decision',
        'stale.superseded': 'Describes what was replaced',
        'reference.dangling': 'Refers to nothing',
        'reference.ambiguous': 'Ambiguous reference',
        'reference.misattributed': 'Wrong record cited',
    };
    return labels[rule] ?? rule;
}

/** One line about the build: what it is doing, or how it ended. */
export function buildLine(build: DomainModelBuild): string {
    if (build.running) {
        if (build.candidates > 0 || build.done >= build.documents) {
            return `Checking disagreements ${build.judged}/${build.candidates}`;
        }
        return `Reading documents ${build.done}/${build.documents}${build.current ? ` · ${build.current}` : ''}`;
    }
    if (build.error) {
        return `Stopped: ${build.error}`;
    }
    if (build.finished_at) {
        return `Built ${build.done} document(s), checked ${build.judged} candidate(s)`;
    }
    return '';
}

/** Why the model reads nothing, or less than is typed, in one line; `undefined`
 *  when every typed document was read. */
export function unreadNote(model: DomainModel): string | undefined {
    const unread = model.unread_documents ?? 0;
    if (unread === 0) {
        return model.documents.length === 0
            ? 'The model is read from the project\'s typed documents, and none are typed yet. Type them in the portal (the project\'s Specs tab), then build the model.'
            : undefined;
    }
    const n = `${unread} typed document${unread === 1 ? '' : 's'}`;
    if (model.unread_because) {
        return `${n} cannot be read on the server: ${model.unread_because}.`;
    }
    return `${n} cannot be read: the server has no copy of the repository right now. Sync it in the portal (the project's Sources tab).`;
}

/** "path:12-14", or the path alone for a whole document. */
export function sideLabel(side: DomainModelSide): string {
    if (!side.line_start) {
        return side.path;
    }
    return side.line_end && side.line_end !== side.line_start
        ? `${side.path}:${side.line_start}-${side.line_end}`
        : `${side.path}:${side.line_start}`;
}

/**
 * The model's name for a file on this machine: the first of `candidates` (a
 * path relative to the workspace root, then the same without each leading
 * folder, so `repo/docs/a.md` also tries `docs/a.md`) that the model has read.
 */
export function modelPathOf(candidates: readonly string[], documents: readonly DomainModelDocument[]): string | undefined {
    const known = new Set(documents.map(d => d.path));
    return candidates.find(candidate => known.has(candidate));
}

/** What the model reads in one document, and finds about it. */
export interface DocumentReading {
    readonly document?: DomainModelDocument;
    readonly facts: DomainModelFact[];
    /** Findings with a side in this document, in working order. */
    readonly findings: DomainModelFinding[];
}

export function readingOf(path: string, model: DomainModel, findings: readonly DomainModelFinding[]): DocumentReading {
    return {
        document: model.documents.find(d => d.path === path),
        facts: model.facts.filter(f => f.source.path === path && !NEED_KINDS.has(f.kind)),
        findings: orderFindings(findings.filter(f => f.sides.some(side => side.path === path))),
    };
}

/** A 0-based line and character, as Theia's ranges count. */
export interface Position {
    readonly line: number;
    readonly character: number;
}

export type Passage =
    /** The quote, found in the text. */
    | { readonly kind: 'found'; readonly start: Position; readonly end: Position }
    /** No quote to look for: the lines the model read it at. */
    | { readonly kind: 'lines'; readonly start: Position; readonly end: Position }
    /** The quote is not in the text any more: edited since the model read it. */
    | { readonly kind: 'gone' };

/**
 * Where `side`'s passage is in `text`, the file as it is now.
 *
 * Found by its quote with runs of whitespace folded (an extractor's quote is
 * one line; the file may wrap it), the occurrence nearest the line it was read
 * at winning. Markdown emphasis the extractor may have dropped is not
 * guessed at: a quote not found is `gone`, which the view says.
 */
export function locatePassage(text: string, side: DomainModelSide): Passage {
    const lineOf = lineIndex(text);
    const quote = (side.quote ?? '').replace(/\s+/g, ' ').trim();
    if (quote) {
        const { folded, offsets } = foldWhitespace(text);
        const wanted = (side.line_start ?? 1) - 1;
        let best: { start: number; end: number; distance: number } | undefined;
        for (let at = folded.indexOf(quote); at >= 0; at = folded.indexOf(quote, at + 1)) {
            const start = offsets[at];
            const end = offsets[at + quote.length - 1] + 1;
            const distance = Math.abs(lineOf(start).line - wanted);
            if (!best || distance < best.distance) {
                best = { start, end, distance };
            }
        }
        return best ? { kind: 'found', start: lineOf(best.start), end: lineOf(best.end) } : { kind: 'gone' };
    }
    const lines = text.split('\n');
    const first = Math.min(Math.max((side.line_start ?? 1) - 1, 0), Math.max(lines.length - 1, 0));
    const last = Math.min(Math.max((side.line_end ?? side.line_start ?? 1) - 1, first), Math.max(lines.length - 1, 0));
    return { kind: 'lines', start: { line: first, character: 0 }, end: { line: last, character: (lines[last] ?? '').replace(/\r$/, '').length } };
}

/** `text` with every run of whitespace one space, and for each of its
 *  characters the offset it came from. */
function foldWhitespace(text: string): { folded: string; offsets: number[] } {
    let folded = '';
    const offsets: number[] = [];
    let inSpace = false;
    for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) {
            if (!inSpace) {
                folded += ' ';
                offsets.push(i);
                inSpace = true;
            }
        } else {
            folded += text[i];
            offsets.push(i);
            inSpace = false;
        }
    }
    return { folded, offsets };
}

function lineIndex(text: string): (offset: number) => Position {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return offset => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return { line: lo, character: offset - starts[lo] };
    };
}

/** How a finding reads as a problem in the file: high and medium warn, low
 *  informs. Never an error -- a disagreement between documents does not break
 *  anything the editor knows of. */
export function markerSeverity(finding: DomainModelFinding): 'warning' | 'information' {
    return finding.severity === 'low' ? 'information' : 'warning';
}

/** The findings worth a marker: the decided-dismissed ones are not. */
export function markedFindings(findings: readonly DomainModelFinding[]): DomainModelFinding[] {
    return findings.filter(f => f.decision !== 'dismissed');
}
