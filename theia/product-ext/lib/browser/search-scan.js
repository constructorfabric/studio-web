/*
 * Search, as arithmetic — no DOM, no Theia, nothing that needs a window.
 *
 * WHY THIS IS A SEPARATE FILE. Everything hard about search is a pure question
 * with a checkable answer: does this line match, where exactly does it match,
 * which facet values does this hit carry, what comes back if that filter is
 * dropped, which of two hits is the better answer. Everything easy about it —
 * the panel, the chips, the checkboxes — is DOM. The two used to be written
 * together in products this one has borrowed from, and the cost is always the
 * same: the interesting half can only be tested by driving a browser, so in
 * practice it is not tested at all, and the ranking quietly becomes whatever
 * the last person's ordering hack made it.
 *
 * So the whole engine lives here, exported as named functions, and
 * search-scan-test.mjs drives it in node in a few milliseconds. search-view.js
 * owns the walk (which needs a file service) and the paint (which needs a
 * document) and nothing else.
 *
 * WHAT THIS MODULE IS HONEST ABOUT, because a search box is a machine for
 * making people believe they have seen everything:
 *
 *  - Caps are DATA, not silence. matchLines reports `truncated`; the caller is
 *    expected to carry that number to the screen. "No results" and "we stopped
 *    reading" must never look alike, and the only way to keep that promise is
 *    for the stopping to be a value somebody has to spend.
 *  - There is no access model in this product at all (constraint 4), so nothing
 *    here filters by permission and nothing here could. A hit exists if the file
 *    is on disk and inside a connected project. Said again where the walk
 *    happens, in search-view.js, because that is where a reader would ask.
 *  - Labels and categories are not searchable because nothing in a project
 *    carries one. That is a fact about the product, not a gap in this file; the
 *    facet rail says so out loud rather than offering an empty group.
 */

// -- caps ------------------------------------------------------------------

/*
 * Every one of these exists to stop one specific runaway, and every one of them
 * is reported to the user when it bites (see honestyLine).
 *
 * MAX_FILE_BYTES: a project is allowed to contain a 40MB CSV export. Reading it
 * to find a word in it costs more than the answer is worth, and the walk is
 * started by a keystroke.
 *
 * MAX_HITS_PER_FILE: a term like "the" matches every line of every document.
 * The cap is per file rather than global so one enormous file cannot crowd every
 * other file out of the results — the grouping is by file, so a file that
 * contributes 60 rows has already said what it has to say.
 *
 * SNIPPET_MAX: a matched line in a Markdown table can be 900 characters. The
 * row is one line tall on screen either way; the only question is whether the
 * match is inside the part that survives.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HITS_PER_FILE = 60;
const SNIPPET_MAX = 168;
const ELLIPSIS = '…';

// -- the closed vocabularies ------------------------------------------------

/*
 * The five content types, in the order the facet rail lists them, which is also
 * the order of how directly a hit answers "where is this in my project": the
 * document itself, then the things said about it.
 *
 * `checklist` is a DOCUMENT LINE that happens to be a task-list item. It is a
 * separate type rather than a flag because "find the unticked box that mentions
 * pricing" is a different question from "find the sentence that mentions
 * pricing", and a user who wants one is actively bothered by the other.
 */
const CONTENT_TYPES = [
    { value: 'document', label: 'Document' },
    { value: 'comment', label: 'Comment' },
    { value: 'change', label: 'Proposed change' },
    { value: 'history', label: 'History entry' },
    { value: 'checklist', label: 'Checklist item' }
];

/* How each type reads in a sentence, for the no-match state's blame line:
 * "6 of the matches are document text" has to be English, not a facet value. */
const KIND_PHRASE = {
    document: 'document text',
    comment: 'comments',
    change: 'proposed changes',
    history: 'history entries',
    checklist: 'checklist items'
};

/* The 66px kind column in a result row. Short, because the column is 66px. */
const KIND_COLUMN = {
    document: 'Doc',
    comment: 'Comment',
    change: 'Change',
    history: 'History',
    checklist: 'Task'
};

/*
 * The date facet, and the one thing about it that surprises people: the buckets
 * are CUMULATIVE, not exclusive. Something edited an hour ago is in Today AND
 * in Last 7 days AND in Last 30 days, so the counts nest and ticking the wider
 * box never hides a hit the narrower one showed. Exclusive buckets were tried
 * first and read as a bug every time: ticking "Last 7 days" made this morning's
 * edit disappear.
 */
const DATE_BUCKETS = [
    { value: 'today', label: 'Today' },
    { value: 'last7', label: 'Last 7 days' },
    { value: 'last30', label: 'Last 30 days' }
];

const FACET_KEYS = ['project', 'type', 'contributor', 'changed', 'folder'];

const FACET_LABEL = {
    project: 'Project',
    type: 'Content type',
    contributor: 'Contributor',
    changed: 'Changed',
    folder: 'Folder'
};

/* The chip row has ~9 characters before it starts wrapping, so a chip says
 * "Type" where the facet heading says "Content type". Same dimension, and the
 * chip has the value beside it to disambiguate. */
const CHIP_LABEL = {
    project: 'Project',
    type: 'Type',
    contributor: 'By',
    changed: 'Changed',
    folder: 'Folder'
};

const DAY_MS = 86400000;

// -- small shared helpers ---------------------------------------------------

/* Deterministic thousands separators. `toLocaleString` would follow the
 * machine's locale, which makes the honesty line — and the test that pins it —
 * depend on where the machine is. */
function groupDigits(value) {
    return String(Math.trunc(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural(count, one, many) {
    return count === 1 ? one : (many || one + 's');
}

/*
 * The same extension-to-glyph table the Projects browser draws its file rows
 * with (repositories-view.js's fileIconKind, which is not exported). Copied
 * rather than imported for one reason: that module builds a Lumino widget at
 * require time, and this one must stay loadable in node.
 */
function fileGlyphKind(name) {
    const base = String(name || '').toLowerCase();
    const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
    if (base === 'package.json') { return 'package'; }
    return ({
        md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html',
        json: 'data', yaml: 'data', yml: 'data',
        csv: 'table', tsv: 'table', tab: 'table', psv: 'table',
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', sh: 'terminal', css: 'style', scss: 'style',
        xml: 'markup', svg: 'vector', png: 'image', jpg: 'image', jpeg: 'image',
        pdf: 'pdf', txt: 'text', lock: 'package'
    })[extension] || 'file';
}

function extensionOf(path) {
    const base = String(path || '');
    const cut = base.lastIndexOf('.');
    const slash = base.lastIndexOf('/');
    return cut > slash + 1 ? base.slice(cut + 1).toLowerCase() : '';
}

/** The root-relative directory of a root-relative path, '' for the root itself. */
function folderOf(path) {
    const at = String(path || '').lastIndexOf('/');
    return at < 0 ? '' : String(path).slice(0, at);
}

/* The project root is a real folder and the commonest one, so it needs a name
 * rather than an empty checkbox label. */
function folderLabel(dir) {
    return dir ? dir : 'Project root';
}

/*
 * Is this text, or did we just read a PNG?
 *
 * A NUL byte is the decisive answer and the cheap one. The control-character
 * ratio catches the rest — a truncated binary with no NUL in the first
 * kilobyte — and is deliberately generous, because a false positive here means
 * a document silently stops being searchable, which is the failure mode this
 * whole file is trying to avoid. Only the head is examined: a file that is text
 * for 4KB and binary afterwards does not exist in practice, and reading the
 * whole thing to decide whether to read the whole thing is absurd.
 */
function isProbablyBinary(text) {
    const head = String(text == null ? '' : text).slice(0, 4096);
    if (head.indexOf('\u0000') >= 0) { return true; }
    if (!head.length) { return false; }
    let control = 0;
    for (let i = 0; i < head.length; i++) {
        const code = head.charCodeAt(i);
        // Tab, newline and carriage return are text; everything else below the
        // space, plus the C1 block, is not.
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) { control++; }
    }
    return control / head.length > 0.06;
}

// -- the query --------------------------------------------------------------

/*
 * Parse what was typed.
 *
 * Bare words are ANDed, a quoted run is one term, and three prefixes are
 * understood: `type:`, `by:`, `after:`. Anything else with a colon in it —
 * `http:`, `note:something`, a typo — stays a BARE TERM rather than being
 * swallowed as an unknown filter. That asymmetry is deliberate: quietly
 * dropping `htt` because the user typed a URL is a search that lies, while
 * searching for the literal text "foo:bar" is at worst useless.
 *
 * The prefixes exist because they are the only way to express a filter from the
 * keyboard without leaving the input, and every one of them maps onto a facet
 * the rail already offers — so nothing is reachable by typing that is not also
 * reachable by clicking, and vice versa.
 */
function parseQuery(raw, now = Date.now()) {
    const text = String(raw == null ? '' : raw);
    const terms = [];
    const types = [];
    const authors = [];
    let after;

    // One pass, quote-aware. A regex alternation over quoted-or-bare tokens is
    // shorter than a character loop and easier to be wrong in, so this is the
    // loop.
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (/\s/.test(character)) { index++; continue; }
        let token = '';
        let quoted = false;
        if (character === '"') {
            quoted = true;
            index++;
            while (index < text.length && text[index] !== '"') { token += text[index++]; }
            index++;                                   // the closing quote, if there is one
        } else {
            while (index < text.length && !/\s/.test(text[index])) { token += text[index++]; }
        }
        if (!token) { continue; }
        // A quoted run is a phrase, never a prefix: "type:comment" in quotes is
        // somebody looking for that literal string.
        const prefix = quoted ? undefined : /^(type|by|after):(.*)$/i.exec(token);
        if (!prefix || !prefix[2]) {
            terms.push(token.toLowerCase());
            continue;
        }
        const value = prefix[2];
        const name = prefix[1].toLowerCase();
        if (name === 'type') {
            /* The value, the label, or the label hyphenated — because the
             * tokenizer splits on whitespace, so `type:Proposed change` cannot
             * reach here as one token and a user who knows the type by its
             * label has to be able to type it: `type:proposed-change`. */
            const wanted = value.toLowerCase();
            const match = CONTENT_TYPES.find(t => t.value === wanted ||
                t.label.toLowerCase() === wanted ||
                t.label.toLowerCase().replace(/\s+/g, '-') === wanted);
            // An unrecognised type is not a filter and must not become a silent
            // "match nothing" — it goes back to being a word to look for.
            if (match) { types.push(match.value); } else { terms.push(token.toLowerCase()); }
        } else if (name === 'by') {
            authors.push(value.toLowerCase());
        } else {
            const resolved = parseAfter(value, now);
            if (resolved) { after = resolved; } else { terms.push(token.toLowerCase()); }
        }
    }

    return {
        raw: text,
        terms,
        /* The whole typed phrase, minus the prefixes, for the "does the query
         * appear contiguously" ranking bonus. */
        phrase: terms.join(' '),
        types,
        authors,
        after,
        empty: !terms.length
    };
}

/*
 * `after:` in the two forms people actually type — a relative window and a
 * date — resolved into the SAME vocabulary the Changed facet uses, so typing
 * `after:7d` and ticking "Last 7 days" produce one filter and not two that
 * happen to agree.
 */
function parseAfter(value, now = Date.now()) {
    const token = String(value || '').trim().toLowerCase();
    if (token === 'today') { return 'today'; }
    const window = /^(\d+)d$/.exec(token);
    if (window) {
        const days = Number(window[1]);
        if (days === 7) { return 'last7'; }
        if (days === 30) { return 'last30'; }
        if (days === 1) { return 'today'; }
        return 'since:' + isoDate(now - days * DAY_MS);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && Number.isFinite(Date.parse(token))) { return 'since:' + token; }
    return undefined;
}

function isoDate(at) {
    const date = new Date(at);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

/*
 * The cache key for "this query, matched against this file".
 *
 * Only the parts that change what MATCHES belong in it. The facet filters do
 * not: they are applied to the hit list afterwards, so ticking a checkbox must
 * not invalidate a single cached file. That is the difference between a facet
 * click that is instant and one that re-reads the project.
 */
function queryKey(query) {
    return (query && query.terms ? query.terms : []).join('\u0000');
}

// -- matching ---------------------------------------------------------------

/* Overlapping ranges become one <mark>, or the query "ana" against "banana"
 * would emit two marks that overlap and the second would close inside the
 * first, which is not a DOM. */
function mergeRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.length - b.length);
    const out = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && range.start <= last.start + last.length) {
            last.length = Math.max(last.length, range.start + range.length - last.start);
        } else {
            out.push({ start: range.start, length: range.length });
        }
    }
    return out;
}

/**
 * Where every term occurs in `text`, merged — or undefined when even one term
 * is missing.
 *
 * ALL terms, not any: two words typed into a search box mean "both", and an OR
 * over two common words returns the project. The undefined-versus-empty-array
 * distinction is what lets the caller skip a line in one test.
 */
function allTermsIn(text, terms) {
    if (!terms || !terms.length) { return undefined; }
    const lower = String(text == null ? '' : text).toLowerCase();
    const ranges = [];
    for (const term of terms) {
        if (!term) { continue; }
        let from = 0;
        let found = false;
        for (;;) {
            const at = lower.indexOf(term, from);
            if (at < 0) { break; }
            found = true;
            ranges.push({ start: at, length: term.length });
            from = at + Math.max(1, term.length);
        }
        if (!found) { return undefined; }
    }
    return ranges.length ? mergeRanges(ranges) : undefined;
}

/**
 * One line, cut down to something that fits on screen with the match still in
 * it, and the offsets moved to match.
 *
 * The window puts the first match about a third of the way in rather than
 * centring it: a match at the very start of the visible text has no context to
 * its left to say what it is part of, and prose is read left to right, so the
 * useful context is mostly ahead of it.
 *
 * Leading indentation is dropped first (and the offsets shifted), because a
 * nested list item in a Markdown document can be twelve spaces before its first
 * character and those twelve characters are the ones the snippet cannot spare.
 */
function extractSnippet(rawLine, ranges, max = SNIPPET_MAX) {
    const line = String(rawLine == null ? '' : rawLine);
    const lead = line.length - line.replace(/^\s+/, '').length;
    const text = line.slice(lead).replace(/\s+$/, '');
    const shifted = (ranges || [])
        .map(range => ({ start: range.start - lead, length: range.length }))
        .filter(range => range.start >= 0 && range.start + range.length <= text.length);
    if (text.length <= max) { return { text, offsets: shifted }; }

    const first = shifted.length ? shifted[0].start : 0;
    let start = Math.max(0, first - Math.round(max / 3));
    let end = Math.min(text.length, start + max);
    if (end - start < max) { start = Math.max(0, end - max); }
    const head = start > 0 ? ELLIPSIS : '';
    const tail = end < text.length ? ELLIPSIS : '';
    const delta = head.length - start;
    const offsets = shifted
        .map(range => ({ start: range.start + delta, length: range.length }))
        // A match that fell outside the window is not marked. It is still a
        // match — the line is still a hit — it simply is not visible, and a mark
        // drawn at a clamped offset would point at the wrong word.
        .filter(range => range.start >= head.length && range.start + range.length <= head.length + (end - start));
    return { text: head + text.slice(start, end) + tail, offsets };
}

/* A Markdown ATX heading, for the "line 42 · Scope" meta line. Setext headings
 * (underlined with === or ---) are not recognised: doing it properly needs a
 * one-line lookahead and they are vanishingly rare in this product's own
 * documents, which are written by its own editor. */
function headingOf(line) {
    const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(String(line == null ? '' : line));
    return match ? match[2] : undefined;
}

/* `- [ ] ship it` / `* [x] shipped`. The box, not the bullet: a plain list item
 * is document text. */
function isChecklistLine(line) {
    return /^\s*[-*+]\s+\[[ xX]\]\s/.test(String(line == null ? '' : line));
}

/**
 * Every matching line of one file.
 *
 * @returns { hits, truncated, lines } — `truncated` is the cap having bitten,
 *          and the caller MUST carry it to the screen. See the header.
 */
function matchLines(text, query, options = {}) {
    const terms = query && query.terms ? query.terms : [];
    const limit = options.maxHits === undefined ? MAX_HITS_PER_FILE : options.maxHits;
    const max = options.snippetMax || SNIPPET_MAX;
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const hits = [];
    let truncated = false;
    let section = '';

    if (!terms.length) { return { hits, truncated, lines: lines.length }; }

    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index];
        const heading = headingOf(raw);
        // Tracked even on non-matching lines: the section a hit is in is the
        // nearest heading ABOVE it, which is knowledge only a full pass has.
        if (heading !== undefined) { section = heading; }
        const ranges = allTermsIn(raw, terms);
        if (!ranges) { continue; }
        if (hits.length >= limit) { truncated = true; break; }
        const snippet = extractSnippet(raw, ranges, max);
        hits.push({
            kind: isChecklistLine(raw) ? 'checklist' : 'document',
            line: index + 1,
            section,
            text: snippet.text,
            offsets: snippet.offsets
        });
    }
    return { hits, truncated, lines: lines.length };
}

/**
 * The first matching line of a short piece of prose — a comment body, a
 * proposal title, a history entry's detail — or undefined.
 *
 * Op-log content has no line numbers a user could act on, so it gets one
 * snippet rather than a list. Multi-line comment bodies are common and the
 * matching line is the one worth showing, which is why this is not just
 * "the first 168 characters".
 */
function matchSnippet(text, query, options = {}) {
    const result = matchLines(text, query, { maxHits: 1, snippetMax: options.snippetMax });
    return result.hits.length ? { text: result.hits[0].text, offsets: result.hits[0].offsets } : undefined;
}

// -- dates ------------------------------------------------------------------

/* Local calendar day, not "within 24 hours". The facet says "Today", and to a
 * person that means today. */
function sameDay(a, b) {
    const left = new Date(a);
    const right = new Date(b);
    return left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate();
}

/** Every Changed bucket this timestamp belongs to. Cumulative — see DATE_BUCKETS. */
function dateBuckets(at, now = Date.now()) {
    const when = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(when)) { return []; }
    const out = [];
    if (sameDay(when, now)) { out.push('today'); }
    if (when >= now - 7 * DAY_MS) { out.push('last7'); }
    if (when >= now - 30 * DAY_MS) { out.push('last30'); }
    return out;
}

/** The narrowest bucket, for a one-word answer. undefined means older than 30 days. */
function dateBucket(at, now = Date.now()) {
    return dateBuckets(at, now)[0];
}

function matchesChanged(hit, value, now = Date.now()) {
    const since = /^since:(.+)$/.exec(String(value || ''));
    const when = hit && hit.changedAt !== undefined ? (typeof hit.changedAt === 'number' ? hit.changedAt : Date.parse(hit.changedAt)) : NaN;
    if (since) {
        const from = Date.parse(since[1]);
        return Number.isFinite(when) && Number.isFinite(from) && when >= from;
    }
    return dateBuckets(when, now).includes(value);
}

// -- facets -----------------------------------------------------------------

/** The values one hit carries in one dimension. Empty is a legitimate answer. */
function hitFacetValues(hit, key, now = Date.now()) {
    if (!hit) { return []; }
    switch (key) {
        case 'project': return hit.project ? [hit.project] : [];
        case 'type': return hit.kind ? [hit.kind] : [];
        /*
         * A document line HAS NO AUTHOR, and this returns nothing rather than
         * inventing one. It is the reason the Contributor facet is destructive in
         * a way users do not expect — ticking any contributor drops every line of
         * document text — and it is exactly the case explainEmpty() was written
         * to narrate instead of leaving as a mystery.
         */
        case 'contributor': return hit.author && hit.author.id ? [hit.author.id] : [];
        case 'changed': return dateBuckets(hit.changedAt, now);
        case 'folder': return hit.dir === undefined ? [] : [hit.dir];
        default: return [];
    }
}

function matchesFilter(hit, key, values, now = Date.now()) {
    if (!values || !values.length) { return true; }
    if (key === 'changed') { return values.some(value => matchesChanged(hit, value, now)); }
    const own = hitFacetValues(hit, key, now);
    return own.some(value => values.includes(value));
}

/**
 * Filter a hit list.
 *
 * AND ACROSS DIMENSIONS, OR WITHIN ONE. Two ticks in Content type widen the
 * result; one tick in Content type and one in Folder narrow it. That is what
 * every faceted search does and what users expect without being told, and it is
 * stated here because the code that implements it is four lines and reads
 * equally well as the wrong rule.
 */
function applyFilters(hits, filters, now = Date.now()) {
    const active = filters || {};
    return (hits || []).filter(hit => FACET_KEYS.every(key => matchesFilter(hit, key, active[key], now)));
}

/*
 * Counts for one dimension, computed against the hits that survive EVERY OTHER
 * dimension but not this one.
 *
 * This is the part of a facet rail that is quietly always wrong when it is
 * written the obvious way. Counting against the fully filtered list makes every
 * unticked box in the dimension you are using read 0, so the rail tells you
 * there is nothing else to choose exactly when you are choosing; counting
 * against the unfiltered list makes every number a promise the other filters
 * will break. Excluding only this dimension is the answer that makes each count
 * true: "tick this and you will see this many".
 */
function facetCounts(hits, key, filters, now = Date.now()) {
    const others = { ...(filters || {}) };
    delete others[key];
    const pool = applyFilters(hits, others, now);
    const counts = new Map();
    for (const hit of pool) {
        for (const value of hitFacetValues(hit, key, now)) {
            counts.set(value, (counts.get(value) || 0) + 1);
        }
    }
    return { counts, pool };
}

/**
 * The whole rail: every group, in the design's order, with its counts.
 *
 * @param options.now      the clock, for the date buckets
 * @param options.labels   value -> display name (project roots, contributors),
 *                         because a project's name is not derivable from a hit
 *                         and a contributor's is not derivable from an id
 * @param options.since    the 'since:YYYY-MM-DD' value currently in force, so
 *                         the "Since a date" row can show its own count
 */
function facetsFor(hits, filters, options = {}) {
    const now = options.now === undefined ? Date.now() : options.now;
    const labels = options.labels || new Map();
    const all = hits || [];
    const name = value => labels.get(value) || value;

    const listed = key => {
        const { counts } = facetCounts(all, key, filters, now);
        return [...counts.entries()]
            .map(([value, count]) => ({ value, count, label: key === 'folder' ? folderLabel(value) : name(value) }))
            // Count first so the useful values are at the top of a long rail,
            // then label so two equal counts do not swap places between renders.
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    };

    const typeCounts = facetCounts(all, 'type', filters, now).counts;
    const changedCounts = facetCounts(all, 'changed', filters, now);

    const changed = DATE_BUCKETS.map(bucket => ({
        value: bucket.value, label: bucket.label, count: changedCounts.counts.get(bucket.value) || 0
    }));
    if (options.since) {
        changed.push({
            value: 'since:' + options.since,
            label: 'Since ' + options.since,
            count: changedCounts.pool.filter(hit => matchesChanged(hit, 'since:' + options.since, now)).length
        });
    }

    return {
        project: listed('project'),
        /* The five types are a CLOSED vocabulary, so all five rows are drawn
         * even at zero. A row that vanishes at zero makes the rail's membership
         * change under the user, and "there are no comments matching this" is
         * information — it is the difference between having looked and not
         * having thought to look. */
        type: CONTENT_TYPES.map(type => ({
            value: type.value, label: type.label, count: typeCounts.get(type.value) || 0
        })),
        contributor: listed('contributor'),
        changed,
        folder: listed('folder')
    };
}

// -- ranking ----------------------------------------------------------------

/*
 * WHAT MAKES ONE HIT BETTER THAN ANOTHER, stated as a sum so it can be argued
 * with. Every term here answers a question someone actually asked of a search
 * box, and nothing here is a tie-break dressed up as relevance:
 *
 *   the kind      — the document is the thing; what was said about it is
 *                   context. A comment quoting a sentence should not outrank
 *                   the sentence.
 *   the filename  — "prd" typed by someone looking for prd.md. This is the
 *                   biggest single bonus on purpose: a filename match is almost
 *                   never a coincidence.
 *   the phrase    — all the words, adjacent, in order. Two words that happen to
 *                   share a line are a weaker answer than the phrase.
 *   the boundary  — "cat" in "cat" beats "cat" in "concatenate".
 *   the heading   — a match in the section title is about the whole section.
 *   recency       — last on purpose. A recently touched file is a better guess
 *                   only when nothing else separates two hits, and search that
 *                   sorts by date is a file listing.
 */
function scoreHit(hit, query) {
    const terms = (query && query.terms) || [];
    let score = ({ document: 100, checklist: 96, comment: 80, change: 72, history: 56 })[hit.kind] || 50;
    const name = String(hit.name || '').toLowerCase();
    if (terms.some(term => term && name.includes(term))) { score += 40; }
    const text = String(hit.text || '').toLowerCase();
    if (query && query.phrase && terms.length > 1 && text.includes(query.phrase)) { score += 25; }
    if (terms.some(term => term && new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRegExp(term) + '($|[^\\p{L}\\p{N}])', 'u').test(text))) { score += 15; }
    const section = String(hit.section || '').toLowerCase();
    if (section && terms.some(term => term && section.includes(term))) { score += 10; }
    const when = typeof hit.changedAt === 'number' ? hit.changedAt : Date.parse(hit.changedAt);
    if (Number.isFinite(when)) {
        const age = Math.max(0, (query && query.now ? query.now : Date.now()) - when);
        score += Math.max(0, 20 - Math.round(age / (30 * DAY_MS) * 20));
    }
    return score;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rank, in place-independent order.
 *
 * The tail of the comparator is not decoration: a search that returns the same
 * hits in a different order on a second run is a search people stop trusting,
 * and hits arrive here in filesystem-listing order, which is not stable across
 * machines. Path then line then kind is a total order over distinct hits.
 */
function rankHits(hits, query) {
    return (hits || [])
        .map(hit => ({ ...hit, score: hit.score === undefined ? scoreHit(hit, query) : hit.score }))
        .sort((a, b) =>
            b.score - a.score ||
            String(a.path || '').localeCompare(String(b.path || '')) ||
            (a.line || 0) - (b.line || 0) ||
            String(a.kind).localeCompare(String(b.kind)) ||
            String(a.text || '').localeCompare(String(b.text || '')));
}

/**
 * Ranked hits, gathered into one group per file, best file first.
 *
 * Files are ordered by their best hit rather than by their hit count: a file
 * with one exact answer beats a file with nine incidental mentions, which is
 * the whole reason for ranking hits in the first place.
 */
function groupByFile(hits) {
    const groups = new Map();
    for (const hit of hits || []) {
        const key = hit.uri || (hit.project + '/' + hit.path);
        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                uri: hit.uri,
                project: hit.project,
                projectName: hit.projectName,
                path: hit.path,
                dir: hit.dir,
                name: hit.name,
                glyph: hit.glyph || fileGlyphKind(hit.name),
                hits: []
            };
            groups.set(key, group);
        }
        group.hits.push(hit);
    }
    return [...groups.values()].map(group => ({ ...group, matches: group.hits.length }));
}

// -- the two counts the user reads -----------------------------------------

/** "38 matches in 11 files". The header's whole job. */
function countText(matches, files) {
    if (!matches) { return 'No matches'; }
    return groupDigits(matches) + ' ' + plural(matches, 'match', 'matches') +
        ' in ' + groupDigits(files) + ' ' + plural(files, 'file');
}

/**
 * The monospace line in the chip row: what was actually read, and what was not.
 *
 * This is the most important string in the feature. Without it, a capped scan
 * and an exhaustive one produce the same screen, and the user's conclusion
 * ("it isn't in the project") is one the product has no right to let them
 * reach. Every cap in this file surfaces here.
 */
function honestyLine(stats) {
    const s = stats || {};
    const parts = ['read ' + groupDigits(s.files || 0) + ' ' + plural(s.files || 0, 'file')];
    if (s.ops) { parts.push(groupDigits(s.ops) + ' comment ' + plural(s.ops, 'op')); }
    if (s.skipped) { parts.push(groupDigits(s.skipped) + ' skipped'); }
    if (s.capped) { parts.push(groupDigits(s.capped) + ' capped'); }
    return parts.join(' · ');
}

// -- the no-match state ----------------------------------------------------

/*
 * @param dominantCount how many of the recovered hits actually ARE `dominant`.
 *
 * That parameter exists because of a measured lie. The note used to read
 * "<recovers> of the matches are <dominant>", which is only true when the
 * dominant value accounts for all of them — with one document hit and one
 * comment hit recovered, it said "2 of the matches are comments". A sentence
 * offered as the reason to drop a filter has to be arithmetically true, or the
 * whole no-match state becomes a thing users learn to disregard. When the
 * dominant value is a plurality rather than the whole, the note says "mostly".
 */
function blameNote(key, recovers, dominant, dominantCount) {
    const many = plural(recovers, 'match', 'matches');
    const phrase = dominant ? (KIND_PHRASE[dominant] || dominant) : 'another content type';
    switch (key) {
        case 'type':
            if (dominantCount !== undefined && dominantCount < recovers) {
                return recovers + ' ' + many + ' come back, mostly ' + phrase;
            }
            return recovers + ' of the ' + many + ' ' + plural(recovers, 'is', 'are') + ' ' + phrase;
        case 'contributor':
            return recovers + ' ' + many + ' have no author — document text never does';
        case 'changed':
            return recovers + ' ' + many + ' ' + plural(recovers, 'is', 'are') + ' older than this';
        case 'project':
            return recovers + ' ' + many + ' ' + plural(recovers, 'is', 'are') + ' in another project';
        case 'folder':
            return recovers + ' ' + many + ' ' + plural(recovers, 'is', 'are') + ' in another folder';
        default:
            return recovers + ' ' + many + ' come back without this';
    }
}

/**
 * Why there are no results, in the only terms that help: how many times the
 * term appears with the filters off, and which filter is eating them.
 *
 * "No results found" is the least useful sentence a search box can produce,
 * because the two situations it covers — the word is not there, and the word is
 * there but you have hidden it — call for opposite next actions. This computes
 * the second: for every active dimension, how many hits come back if that one
 * dimension is dropped, and which value dominates what comes back, so the UI
 * can offer "drop this — 6 of the matches are document text" rather than a
 * shrug.
 *
 * Dimensions are examined ONE AT A TIME. A pair of filters that only conspire
 * together is real but rare, and reporting it means offering the user a
 * combination to drop, which is a sentence nobody reads. The single-dimension
 * answer is right in the overwhelming majority of cases and is always true as
 * far as it goes.
 */
function explainEmpty(allHits, filters, options = {}) {
    const now = options.now === undefined ? Date.now() : options.now;
    const total = (allHits || []).length;
    const drops = [];
    for (const key of FACET_KEYS) {
        const values = (filters || {})[key];
        if (!values || !values.length) { continue; }
        const without = { ...(filters || {}) };
        delete without[key];
        const recovered = applyFilters(allHits, without, now);
        if (!recovered.length) { continue; }
        // What the recovered hits mostly are, so the note can name it.
        const tally = new Map();
        for (const hit of recovered) {
            for (const value of hitFacetValues(hit, key, now)) {
                tally.set(value, (tally.get(value) || 0) + 1);
            }
        }
        const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
        drops.push({
            key,
            label: FACET_LABEL[key],
            values: values.slice(),
            recovers: recovered.length,
            dominant: dominant ? dominant[0] : undefined,
            dominantCount: dominant ? dominant[1] : 0,
            note: blameNote(key, recovered.length, dominant ? dominant[0] : undefined, dominant ? dominant[1] : undefined)
        });
    }
    // Loudest first: the filter hiding the most is the one to offer dropping.
    drops.sort((a, b) => b.recovers - a.recovers || a.label.localeCompare(b.label));
    // The design asks for "the one or two filters responsible". Three bulleted
    // suspects is a diagnosis nobody acts on.
    return { total, drops: drops.slice(0, 2), allDrops: drops };
}

// -- the cache -------------------------------------------------------------

/*
 * File text and per-query hits, keyed by mtime.
 *
 * WHY THE TEXT AND NOT ONLY THE HITS. "A repeat search of an unchanged project
 * must not re-read it" is the requirement, and a hit cache keyed by the query
 * satisfies it only for the SAME query — which is the one search a user is
 * least likely to run twice. Typing one more character is a new query over the
 * same bytes, so the bytes are what has to be kept. The hit memo on top of it
 * then makes the genuinely repeated search (backspace, or re-opening the tab)
 * free.
 *
 * WHAT INVALIDATES AN ENTRY. Two things, and only two: a different mtime, and
 * an explicit invalidate() from the file watcher. There is no time-based
 * expiry, because a cache that forgets on a timer is a cache that re-reads the
 * project for no reason at a moment nobody chose.
 *
 * The byte budget is a budget and not a count: 4,000 small Markdown files and
 * 40 large CSVs are the same problem for a browser process, and only one of
 * them is expressible as a file count. Eviction is oldest-touched-first, which
 * needs no bookkeeping beyond Map insertion order.
 */
const CACHE_BYTE_BUDGET = 24 * 1024 * 1024;

class ScanCache {

    constructor(byteBudget = CACHE_BYTE_BUDGET) {
        this.byteBudget = byteBudget;
        this.entries = new Map();          // uri -> { mtime, text, bytes, byQuery: Map }
        this.bytes = 0;
        this.hitCount = 0;
        this.missCount = 0;
    }

    /** The cached text for this file at this mtime, or undefined. */
    text(uri, mtime) {
        const entry = this.entries.get(String(uri));
        if (!entry || entry.mtime !== mtime) { this.missCount++; return undefined; }
        this.touch(String(uri), entry);
        this.hitCount++;
        return entry.text;
    }

    putText(uri, mtime, text) {
        const key = String(uri);
        const existing = this.entries.get(key);
        if (existing) { this.bytes -= existing.bytes; }
        const bytes = String(text == null ? '' : text).length * 2;   // UTF-16 in memory
        const entry = { mtime, text, bytes, byQuery: new Map() };
        this.entries.set(key, entry);
        this.bytes += bytes;
        this.evict();
        return entry;
    }

    /** Memoised hits for (file, mtime, query), or undefined. */
    hits(uri, mtime, key) {
        const entry = this.entries.get(String(uri));
        if (!entry || entry.mtime !== mtime) { return undefined; }
        return entry.byQuery.get(key);
    }

    putHits(uri, mtime, key, hits) {
        const entry = this.entries.get(String(uri));
        if (!entry || entry.mtime !== mtime) { return; }
        /* One file, many queries in one session (every keystroke is a query).
         * Only the last few are ever asked for again, and each one holds
         * snippets, so this is a small ring rather than an unbounded map. */
        if (entry.byQuery.size >= 8) { entry.byQuery.delete(entry.byQuery.keys().next().value); }
        entry.byQuery.set(key, hits);
    }

    /** The file changed on disk. Drop everything derived from its old bytes. */
    invalidate(uri) {
        const key = String(uri);
        const entry = this.entries.get(key);
        if (!entry) { return false; }
        this.bytes -= entry.bytes;
        this.entries.delete(key);
        return true;
    }

    /* A prefix, for "this project changed" and for a root being disconnected —
     * one call instead of walking the workspace to name every file in it. */
    invalidatePrefix(prefix) {
        const start = String(prefix);
        let dropped = 0;
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(start)) { this.invalidate(key); dropped++; }
        }
        return dropped;
    }

    clear() { this.entries.clear(); this.bytes = 0; }

    touch(key, entry) {
        // Re-insertion moves the entry to the end of the Map's iteration order,
        // which is what makes the eviction below least-recently-used.
        this.entries.delete(key);
        this.entries.set(key, entry);
    }

    evict() {
        while (this.bytes > this.byteBudget && this.entries.size) {
            const oldest = this.entries.keys().next().value;
            this.invalidate(oldest);
        }
    }

    stats() {
        return { files: this.entries.size, bytes: this.bytes, hits: this.hitCount, misses: this.missCount };
    }
}

// -- cancellation ----------------------------------------------------------

/*
 * A token, not a promise chain.
 *
 * The walk is abandoned by the next keystroke, and "abandoned" has to mean the
 * in-flight reads stop CONTRIBUTING as well as stop being awaited: an async
 * loop that is no longer awaited still runs to completion and still calls its
 * sink, so a fast third query can be painted over by a slow first one. A flag
 * the loop checks between awaits is the whole mechanism, and it is a flag
 * rather than an AbortController because there is nothing here to abort — the
 * file service has no cancellation seam — only work to stop starting.
 */
function makeCancelToken() {
    return {
        cancelled: false,
        cancel() { this.cancelled = true; }
    };
}

module.exports = {
    // caps and vocabularies
    MAX_FILE_BYTES, MAX_HITS_PER_FILE, SNIPPET_MAX, ELLIPSIS,
    CONTENT_TYPES, DATE_BUCKETS, FACET_KEYS, FACET_LABEL, CHIP_LABEL,
    KIND_PHRASE, KIND_COLUMN,
    // query
    parseQuery, parseAfter, queryKey,
    // matching
    allTermsIn, mergeRanges, extractSnippet, matchLines, matchSnippet,
    headingOf, isChecklistLine, isProbablyBinary,
    // dates
    dateBucket, dateBuckets, matchesChanged,
    // facets and filters
    hitFacetValues, matchesFilter, applyFilters, facetCounts, facetsFor,
    // ranking and grouping
    scoreHit, rankHits, groupByFile,
    // strings
    countText, honestyLine, groupDigits, folderLabel, folderOf, extensionOf,
    fileGlyphKind, plural,
    // the empty state
    explainEmpty, blameNote,
    // machinery
    ScanCache, makeCancelToken
};
