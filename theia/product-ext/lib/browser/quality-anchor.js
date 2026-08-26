/*
 * Anchoring quality findings into a live document — the two granularities.
 *
 * THE PROBLEM, AND THE FIX THAT WAS ALREADY REFUSED
 *
 * A detector reads a file off disk, normalises its text in its own way, and
 * reports a finding as character offsets into THAT text. The editor holds a
 * ProseMirror document that may have unsaved edits in it. The obvious fix is a
 * position map — Markdown offset N corresponds to ProseMirror position M — and
 * it is wrong, for the same reason it was refused once already for tracked
 * changes: read the header of suggest-marks.js. One source line can become
 * zero, one or several ProseMirror nodes, formatting can move a character
 * without changing what it says, and the map would have to be rebuilt on every
 * keystroke to stay honest. A map that goes stale silently is worse than no map,
 * because it highlights the wrong sentence with total confidence.
 *
 * So, as CONTRACT-quality.md §2 settles it: the offsets are used exactly twice,
 * at import time, to cut the quote out of the file and to compute which
 * occurrence of that quote this is (see quality-scan.js). After that they are
 * discarded. What crosses into the live document is QUOTE PLUS OCCURRENCE INDEX
 * — the same mechanism comments have used for years, implemented thirty lines
 * at a time in markdown-editor.js's reanchorThreads(). This file generalises
 * that mechanism to the second granularity purpose findings need — a whole
 * section rather than a phrase — and gives both a home outside the editor so
 * they can be tested without one.
 *
 * WHY THIS TAKES A FLATTENED INDEX, NOT A PROSEMIRROR DOCUMENT
 *
 * `buildTextIndex(doc)` already reduces a ProseMirror document to `{ text, map
 * }` — every text node's content concatenated, and a same-length array mapping
 * each character back to its document position. That is all reanchorThreads()
 * needs, and it is all this file needs too. Taking that shape instead of a
 * live `doc` means every hard case here — a quote split across two text nodes
 * by a bold mark, two headings with identical titles, a subsection that must
 * not swallow its parent's next sibling — is a plain object literal in a test,
 * checked in milliseconds under plain `node`. Building the real thing needs a
 * DOM, a Tiptap schema and a running editor; building `{ text, map }` and a
 * `headings` array needs an array literal. See quality-anchor-test.mjs for the
 * whole design paying for itself.
 *
 * `headings` is the same idea applied to section resolution: `[{ level, text,
 * from, to, index }]`, one entry per heading block IN DOCUMENT ORDER, where
 * `index` is that heading's ordinal among headings sharing its exact text — the
 * same "which one of these did you mean" question `occurrence` answers for a
 * quote, precomputed here because it is the caller's own document.
 */

const { normalizeText } = require('./quality-identity');

/*
 * How many occurrences of a quote (or a duplicate heading title) this module
 * will walk before giving up and saying so.
 *
 * The real corpus never gets close to this: 246 of 288 clusters occupy two
 * places and the worst is sixteen FILES, not sixteen occurrences in one file.
 * But `resolveSpan` is handed a raw string from a JSON file and asked to find
 * every occurrence of it in a whole document's text, and a one- or two-word
 * quote — the detector shortens long ones — against a large document is
 * exactly the input that turns a naive `indexOf` walk into real, felt latency.
 * 500 is comfortably above anything the data produces and small enough that
 * even a pathological quote costs microseconds.
 *
 * Per search-view.js's rule for MAX_HITS_PER_FILE and friends: a cap is only
 * honest if hitting it is DATA. Silently returning "not found" for the 501st
 * occurrence would be indistinguishable from the quote genuinely not being
 * there, and those are different facts — one says "re-check this finding",
 * the other says "this is fine, there just happen to be a lot of matches, and
 * we didn't look at all of them". So a search that stops at the cap without
 * having settled the question reports `{ occurrence, truncated: true }`
 * instead of `undefined` — see resolveSpan below.
 */
const OCCURRENCE_LIMIT = 500;

// -- small helpers -----------------------------------------------------------

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every occurrence of `needle` in `text`, literal and case-sensitive — the
 * exact same walk reanchorThreads() and createThreadFromSelection() already
 * do, capped at `limit`.
 *
 * Returns `{ positions, truncated }`. `truncated` is true only when there was
 * at least one more occurrence past the cap; it says nothing about whether the
 * requested occurrence was among the ones collected, which the caller decides.
 */
function locateExact(text, needle, limit) {
    const positions = [];
    let at = text.indexOf(needle);
    while (at !== -1) {
        positions.push(at);
        if (positions.length >= limit) {
            return { positions, truncated: text.indexOf(needle, at + 1) !== -1 };
        }
        at = text.indexOf(needle, at + 1);
    }
    return { positions, truncated: false };
}

/**
 * Every occurrence of `needle`'s WORDS in `text`, allowing any run of
 * whitespace between them where `needle` has any run of whitespace.
 *
 * This is the fallback for the commonest reason an exact search fails: the
 * detector's own normalisation pass collapsed a wrapped line or a run of
 * indentation into a single space before it cut the quote out, so the words
 * are right and the spacing between them is not. It is tried only after
 * `locateExact` has come back empty, and never before, because a
 * whitespace-insensitive search can match a near-duplicate passage that the
 * exact text would have told apart — see resolveSpan's comment on ordering.
 *
 * Returns the same `{ positions, truncated }` shape as locateExact, except
 * each position also carries the LENGTH actually matched in `text`, since a
 * whitespace-collapsed match is not necessarily `needle.length` characters
 * long in the document.
 */
function locateLoose(text, needle, limit) {
    const words = String(needle).trim().split(/\s+/).filter(Boolean);
    if (!words.length) { return { positions: [], truncated: false }; }
    const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'), 'g');
    const positions = [];
    let match = pattern.exec(text);
    while (match) {
        positions.push({ start: match.index, length: match[0].length });
        if (positions.length >= limit) {
            return { positions, truncated: pattern.exec(text) !== null };
        }
        // A word list can never produce a zero-length match (escapeRegExp
        // never yields an empty alternative and words.length >= 1), but the
        // guard costs nothing and an infinite loop here would hang a test
        // suite rather than fail it loudly.
        if (pattern.lastIndex === match.index) { pattern.lastIndex++; }
        match = pattern.exec(text);
    }
    return { positions, truncated: false };
}

/** `map[startIdx]` .. `map[endIdx - 1]` turned into a ProseMirror `{ from, to }`. */
function mapRange(map, startIdx, endIdx) {
    const from = map[startIdx];
    const to = map[endIdx - 1];
    if (from === undefined || to === undefined) { return undefined; }
    return { from, to: to + 1 };
}

// -- span anchoring -----------------------------------------------------------

/**
 * The `occurrence`-th occurrence of `quote` in the document, as a ProseMirror
 * range — or `undefined` when it genuinely is not there.
 *
 * Three outcomes, and they are deliberately not collapsed into one:
 *
 *   { from, to, occurrence }     found. This is the decoration target.
 *   undefined                    searched, and it is not there. The caller
 *                                 marks the finding orphaned VISIBLY, which is
 *                                 the entire point of anchoring by quote
 *                                 instead of by offset: an edit to the quoted
 *                                 text is supposed to be loud, not silently
 *                                 mis-highlighted a paragraph over.
 *   { occurrence, truncated }    the search hit OCCURRENCE_LIMIT before it
 *                                 could tell the two apart. This is not the
 *                                 same fact as "not there" and must not be
 *                                 reported as one — see the constant's
 *                                 comment.
 *
 * EXACT MATCH IS TRIED FIRST, ALWAYS. A normalised (whitespace-insensitive)
 * search is more forgiving, which is exactly what makes it dangerous to try
 * first: a document that repeats a boilerplate paragraph with slightly
 * different wrapping would let the loose search match the WRONG occurrence
 * while an exact search sitting right there would have found the right one.
 * So the loose search only runs at all when the exact search finds nothing
 * whatsoever — never to fill in occurrences the exact search left short.
 */
function resolveSpan(index, quote, occurrence = 0) {
    if (!index || typeof index.text !== 'string' || !Array.isArray(index.map)) { return undefined; }
    if (typeof quote !== 'string' || !quote) { return undefined; }
    if (!Number.isInteger(occurrence) || occurrence < 0) { return undefined; }

    const { text, map } = index;

    const exact = locateExact(text, quote, OCCURRENCE_LIMIT);
    if (exact.positions.length > 0) {
        if (occurrence < exact.positions.length) {
            const start = exact.positions[occurrence];
            const range = mapRange(map, start, start + quote.length);
            return range ? { ...range, occurrence } : undefined;
        }
        // Some occurrences exist, just not this many of them — unless the cap
        // is the reason we cannot tell, this is a real out-of-range answer.
        return exact.truncated ? { occurrence, truncated: true } : undefined;
    }

    const loose = locateLoose(text, quote, OCCURRENCE_LIMIT);
    if (loose.positions.length > 0) {
        if (occurrence < loose.positions.length) {
            const at = loose.positions[occurrence];
            const range = mapRange(map, at.start, at.start + at.length);
            return range ? { ...range, occurrence } : undefined;
        }
        return loose.truncated ? { occurrence, truncated: true } : undefined;
    }

    return undefined;
}

// -- section anchoring ---------------------------------------------------------

/**
 * The last breadcrumb segment: `'Feature: X > 2. Design > 2.1 API'` -> `'2.1
 * API'`. A path with no `>` in it (every real violation in
 * mcp-engine__PRD.md.json looks like this — the detector's own breadcrumbs
 * turned out to be single heading names, not the multi-level trail the
 * duplicate detector emits) is its own leaf, trimmed.
 */
function sectionLeaf(sectionPath) {
    const raw = String(sectionPath == null ? '' : sectionPath);
    const parts = raw.split('>').map(part => part.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw.trim();
}

/**
 * Find the heading a breadcrumb refers to, in three widening steps, stopping
 * at the first that succeeds. NEVER guesses: a caller that gets `undefined`
 * back is expected to draw no decoration at all, because a section chip on
 * the WRONG heading is worse than a missing one — it tells a reviewer that
 * nine lines of perfectly good prose are written in the wrong voice, which is
 * a false alarm actively pointed at the wrong target rather than a gap.
 *
 *   1. EXACT match on the leaf. Handles the common case outright: the
 *      detector's own parse and the editor's heading text agree byte for
 *      byte.
 *   2. normalizeText-EQUAL match on the leaf. Punctuation, a trailing colon, a
 *      pair of backticks around a code span — normalizeText already strips
 *      all of that for the fingerprint (CONTRACT §3), and reusing it here
 *      means a heading that differs only in the ways a reviewer edits headings
 *      still resolves.
 *   3. LONGEST-SUFFIX match on the full breadcrumb. For when the document's
 *      outline has been re-chunked since the report was produced — two
 *      headings merged into one, say, so no single heading's text equals the
 *      leaf at all. Every trailing run of two or more breadcrumb segments,
 *      longest first, is normalised and joined with a space and compared
 *      against a whole heading's normalised text; the first hit wins. This
 *      recovers "External MCP" + "Server Contract" folded into one "External
 *      MCP Server Contract" heading, while still requiring an exact
 *      (normalised) match on SOME real heading rather than a fuzzy score that
 *      could land anywhere.
 */
function matchHeading(headings, sectionPath) {
    if (!Array.isArray(headings) || !headings.length) { return undefined; }

    const leaf = sectionLeaf(sectionPath);
    if (!leaf) { return undefined; }

    const exact = headings.find(h => h.text === leaf);
    if (exact) { return exact; }

    const normalizedLeaf = normalizeText(leaf);
    const normalized = normalizedLeaf ? headings.find(h => normalizeText(h.text) === normalizedLeaf) : undefined;
    if (normalized) { return normalized; }

    const segments = String(sectionPath == null ? '' : sectionPath).split('>').map(s => s.trim()).filter(Boolean);
    for (let take = segments.length; take >= 2; take--) {
        const joined = normalizeText(segments.slice(segments.length - take).join(' '));
        if (!joined) { continue; }
        const found = headings.find(h => normalizeText(h.text) === joined);
        if (found) { return found; }
    }

    return undefined;
}

/** The position one past the last character this index knows about — see
 * resolveSection's use of it as the document-end fallback. */
function textEnd(index) {
    const map = (index && index.map) || [];
    // A block node's own PM range is [pos, pos + contentSize + 2) — one
    // position for its open token, its content, one for its close (the same
    // convention the test harness builds `{ text, map }` under, and the one
    // real ProseMirror uses). The last character's own document position plus
    // two is therefore the position immediately after the last block closes,
    // PROVIDED that block is a flat leaf like the ones this document is made
    // of — true for every heading and paragraph buildTextIndex walks, since
    // none of them nest another block inside themselves.
    return map.length ? map[map.length - 1] + 2 : 0;
}

/**
 * A breadcrumb section path resolved to a BLOCK RANGE: from the matched
 * heading's own start to the start of the next heading whose level is less
 * than or equal to it, or to the end of the document.
 *
 * "Less than or equal to it" is what stops a subsection swallowing its
 * parent's next sibling: a level-2 "2.1 API" section ends at the next level-1
 * OR level-2 heading, whichever comes first — never at the next level-1 alone,
 * which would let it eat every subsection after it that belongs to the SAME
 * parent.
 *
 * `occurrence` disambiguates two headings with identical text exactly the way
 * it disambiguates two identical quotes: `matchHeading` finds WHICH TITLE was
 * meant (by text, ignoring which copy), and then the family of headings
 * sharing that title is filtered down by its precomputed `index` — the
 * ordinal the caller already assigned per heading, in document order, among
 * headings with that same text.
 */
function resolveSection(index, headings, sectionPath, occurrence = 0) {
    if (!Array.isArray(headings) || !headings.length) { return undefined; }
    if (!Number.isInteger(occurrence) || occurrence < 0) { return undefined; }

    const matched = matchHeading(headings, sectionPath);
    if (!matched) { return undefined; }

    const heading = headings.find(h => h.text === matched.text && (h.index || 0) === occurrence);
    if (!heading) { return undefined; }

    // Document order, defensively re-sorted rather than trusted, since a
    // caller that got this wrong would otherwise silently mis-anchor every
    // section rather than fail loudly.
    const ordered = headings.slice().sort((a, b) => a.from - b.from);
    const at = ordered.indexOf(heading);

    let to = textEnd(index);
    for (let i = at + 1; i < ordered.length; i++) {
        if (ordered[i].level <= heading.level) { to = ordered[i].from; break; }
    }

    return { from: heading.from, to, heading };
}

// -- dispatch and the whole-finding walk --------------------------------------

/** One anchor, resolved by whichever granularity it declares. */
function resolveAnchor(index, headings, anchor) {
    if (!anchor) { return undefined; }
    if (anchor.granularity === 'span') { return resolveSpan(index, anchor.text, anchor.occurrence || 0); }
    if (anchor.granularity === 'section') { return resolveSection(index, headings, anchor.section, anchor.occurrence || 0); }
    return undefined;
}

/**
 * Every anchor of one finding, resolved against one open document.
 *
 * PLAN §7's central case: one finding, many places — 246 of 288 real clusters
 * span two, one spans sixteen files. This is the "one document's worth" of
 * that: it walks every anchor in `finding.anchors` and reports what came back,
 * so a caller (markdown-editor.js, not this file — see the header) can
 * highlight every occurrence that landed in the document it has open and list
 * the rest as links to other files.
 *
 * `file`, if given, filters `finding.anchors` down to that file's anchors
 * first — the literal reading of "every anchor of one finding whose file is
 * the open document". It is optional because this module has no notion of
 * "the open document" on its own (it is handed an index and a headings array,
 * never a path), so the filter is only meaningful when the caller supplies
 * one; omitting it resolves every anchor the finding carries, which is exactly
 * right for a finding that has already been filtered upstream, or that is
 * known to belong to a single document.
 *
 * `truncated` is broken out from `orphaned` on purpose. Both mean "this anchor
 * did not produce a range", but only `orphaned` means "the text is gone" —
 * `truncated` means "we could not tell", and collapsing the two would let a
 * finding read as resolved-or-fixed when the honest answer is "re-run the
 * scan with a wider occurrence cap". A `truncated` anchor is still counted
 * against `orphaned` (nothing decorates on screen either way) so existing
 * callers that only read `{ ranges, resolved, orphaned }` are not lied to
 * about the total.
 */
function resolveFinding(index, headings, finding, file) {
    const all = (finding && finding.anchors) || [];
    const anchors = file === undefined ? all : all.filter(a => a && a.file === file);

    const ranges = [];
    let resolved = 0;
    let orphaned = 0;
    let truncated = 0;

    for (const anchor of anchors) {
        const range = resolveAnchor(index, headings, anchor);
        if (range && range.truncated) { truncated++; orphaned++; continue; }
        if (range) { ranges.push({ ...range, anchor }); resolved++; continue; }
        orphaned++;
    }

    return { ranges, resolved, orphaned, truncated };
}

module.exports = {
    resolveSpan,
    resolveSection,
    resolveAnchor,
    resolveFinding,
    sectionLeaf,
    matchHeading,
    OCCURRENCE_LIMIT
};
