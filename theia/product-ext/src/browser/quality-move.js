/*
 * Tier 2 (PLAN §8): the linked move. "§X reads as DESIGN — move it to
 * DESIGN.md" is not a suggestion this product can leave to a find-and-replace.
 * It has to cut the exact section a person is looking at from one document
 * and land it, whole, in another — and it has to REFUSE the moment it is not
 * certain which section that is, for the same reason applyDedupeLink() in
 * markdown-editor.js refuses rather than guesses (read it before this file;
 * the discipline here is copied from it on purpose): a proposal that silently
 * cuts the wrong nine lines out of someone's specification is worse than one
 * that does nothing and says why.
 *
 * PURE, ON PURPOSE. This module requires nothing but its own sibling pure
 * modules (quality-identity.js for normalizeText, quality-anchor.js for the
 * one helper reused below) — no Theia, no DOM, no node built-ins, not even
 * node's own `path`. CONTRACT-runner.md §8 says pure modules require nothing,
 * and the payoff is the one quality-anchor.js's own header describes: every
 * hard case here — a subsection that must not swallow its parent's next
 * sibling, a `#` sitting inside a fenced code block, a file with no trailing
 * newline — is a plain string literal in a test, checked in milliseconds
 * under plain `node`, with no editor or ProseMirror schema to stand up first.
 *
 * COMPUTED AGAINST RAW MARKDOWN TEXT, NEVER A PARSED TREE, for the same
 * reason quality-anchor.js discards character offsets at its boundary: a
 * proposal is a diff of file BODIES (`changes-store.js` diffs bodies, not
 * documents), so the edit has to exist in that same coordinate system from
 * the start. Line numbers, not ProseMirror positions; string splicing, not a
 * tree edit.
 *
 * WHY THIS DOES NOT IMPORT `matchHeading` FROM quality-anchor.js, THOUGH IT
 * WAS ASKED TO CONSIDER IT. `matchHeading` finds the FIRST heading that
 * satisfies its three widening stages and stops — exactly right for
 * `resolveSection`, which then disambiguates any remaining duplicates by the
 * anchor's own `occurrence` index. A `purpose` finding's anchor is useless for
 * that here: `buildPurposeFinding` in quality-scan.js calls `withOccurrence`
 * on an array holding its OWN single anchor every time, so `occurrence` is
 * always 0 — it carries no information about which of several identically
 * named headings in the document was meant. Reusing `matchHeading` as-is
 * would therefore silently accept the first of several ambiguous headings,
 * which is precisely the guess this module exists to refuse. Detecting the
 * ambiguity needs the WHOLE family of headings that satisfy whichever stage
 * won — a fact `matchHeading` never hands back — so the three stages are
 * reimplemented below, deliberately, rather than bending that function to
 * return more than `resolveSection` has ever needed. `sectionLeaf`, by
 * contrast, is reused verbatim: it is a one-line string operation with no
 * notion of "the first match", so importing it costs nothing and duplicating
 * it would only be a second place for the breadcrumb rule to drift.
 */

const { normalizeText } = require('./quality-identity');
const { sectionLeaf } = require('./quality-anchor');

// -- documents, as lines, with their own line-ending convention --------------

/*
 * Which line ending this document uses, read off its own first line break
 * rather than assumed. A file is not expected to mix conventions internally
 * — CONTRACT §6 asks that a move "preserve the source's line endings", not
 * that this module invent a per-line answer for a file that does not have
 * one — so the FIRST break found settles it for the whole document.
 */
function detectEol(body) {
    const at = body.indexOf('\n');
    if (at > 0 && body[at - 1] === '\r') { return '\r\n'; }
    return '\n';
}

/*
 * A Markdown body, split into content lines with its terminators removed, plus
 * enough to put it back together byte-for-byte: which terminator it used, and
 * whether the body ended with one at all. That second fact is its own source
 * of a whole-file diff if it is guessed wrong — a file with no final newline
 * that comes back with one added is a one-line, unreadable review the moment
 * it lands, exactly the failure CONTRACT §6 names by name.
 */
function splitDocument(body) {
    const text = String(body == null ? '' : body);
    const eol = detectEol(text);
    if (text === '') { return { lines: [], eol, trailingNewline: false }; }
    const trailingNewline = text.endsWith(eol);
    const trimmed = trailingNewline ? text.slice(0, -eol.length) : text;
    return { lines: trimmed.split(eol), eol, trailingNewline };
}

/** The exact inverse of splitDocument — `joinDocument(splitDocument(x))` is `x`. */
function joinDocument(lines, eol, trailingNewline) {
    const body = lines.join(eol);
    return trailingNewline ? body + eol : body;
}

// -- headings, walked with a fence in mind -----------------------------------

/*
 * An ATX heading line (`#` through `######`), the same shape and the same
 * deliberate omission search-scan.js's `headingOf` documents: Setext headings
 * (underlined with `===`/`---`) are not recognised. That module's reasoning
 * holds here unchanged — a one-line lookahead to catch them is not worth it
 * for a form this product's own editor never writes — so the regex is the
 * same one, not a coincidence.
 */
const HEADING_LINE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** The opening (or a candidate closing) fence delimiter on one line, or null. */
function fenceOpener(line) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    return m ? { marker: m[1][0], length: m[1].length, rest: m[2] } : null;
}

/*
 * Every ATX heading in `lines`, in document order, with a `#` inside a fenced
 * code block correctly not counted as one — CONTRACT §6's explicit example of
 * a way this can go quietly wrong. A fence closes on a line using the SAME
 * character and AT LEAST as many of it as the line that opened it, with
 * nothing but trailing whitespace after — CommonMark's own rule, and the
 * reason `close.rest.trim() === ''` is checked rather than merely spotting
 * three more backticks: a longer inner fence (` ```` ` nested inside ` ``` `)
 * must not be mistaken for the outer fence's close.
 */
function extractHeadings(lines) {
    const headings = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fence) {
            const close = fenceOpener(line);
            if (close && close.marker === fence.marker && close.length >= fence.length && close.rest.trim() === '') {
                fence = null;
            }
            continue; // nothing inside a fence is a heading, including its own close line
        }
        const open = fenceOpener(line);
        if (open) { fence = open; continue; }
        const heading = HEADING_LINE.exec(line);
        if (heading) { headings.push({ level: heading[1].length, text: heading[2].trim(), lineIndex: i }); }
    }
    return headings;
}

// -- resolving a breadcrumb to ONE heading, or refusing --------------------

/*
 * The three widening stages CONTRACT §6 and quality-anchor.js's own
 * `matchHeading` both specify, reimplemented here so that AMBIGUITY — more
 * than one heading satisfying the stage that matched — can be reported rather
 * than silently resolved to the first one. See the file header for why this
 * cannot simply call `matchHeading` and stop.
 *
 * Returns `{ heading, ambiguous: false }`, `{ heading: undefined, ambiguous:
 * true, count }`, or `{ heading: undefined, ambiguous: false }` for a plain
 * miss.
 */
function matchSectionHeading(headings, sectionPath, leaf) {
    const settle = (candidates) => candidates.length === 1
        ? { heading: candidates[0], ambiguous: false }
        : { heading: undefined, ambiguous: candidates.length > 1, count: candidates.length };

    // Stage 1 — exact.
    const exact = headings.filter(h => h.text === leaf);
    if (exact.length) { return settle(exact); }

    // Stage 2 — normalizeText-equal (punctuation, a trailing colon, backticks).
    const normalizedLeaf = normalizeText(leaf);
    if (normalizedLeaf) {
        const normalized = headings.filter(h => normalizeText(h.text) === normalizedLeaf);
        if (normalized.length) { return settle(normalized); }
    }

    // Stage 3 — longest breadcrumb suffix, for a re-chunked outline.
    const segments = String(sectionPath == null ? '' : sectionPath).split('>').map(s => s.trim()).filter(Boolean);
    for (let take = segments.length; take >= 2; take--) {
        const joined = normalizeText(segments.slice(segments.length - take).join(' '));
        if (!joined) { continue; }
        const found = headings.filter(h => normalizeText(h.text) === joined);
        if (found.length) { return settle(found); }
    }

    return { heading: undefined, ambiguous: false };
}

/*
 * A section, cut out of `body` by breadcrumb, or a reason it cannot be.
 *
 * "Cut" means: the heading line through the line before the next heading of
 * the SAME OR HIGHER level (fewer or equal `#`s), or the end of the document
 * — CONTRACT §6, and the same "≤ level" rule PLAN §7's anchoring table already
 * uses for a section's decoration range, so a level-3 subsection's own three
 * paragraphs never bleed into its parent's next level-2 sibling, and a
 * level-2 section is never clipped at its FIRST level-3 child.
 *
 * Exported on its own (the house style — see quality-anchor-test.mjs) so the
 * cut itself is checkable without also exercising the cross-document half of
 * `planMove`.
 */
function findSection(body, sectionPath) {
    const leaf = sectionLeaf(sectionPath);
    if (!leaf) { return { ok: false, why: 'This finding names no section to move.' }; }

    const doc = splitDocument(body);
    const headings = extractHeadings(doc.lines);
    const match = matchSectionHeading(headings, sectionPath, leaf);

    if (match.ambiguous) {
        return {
            ok: false,
            why: '"' + leaf + '" matches ' + match.count + ' headings — refusing to guess which one is meant.'
        };
    }
    if (!match.heading) {
        return { ok: false, why: 'No heading matching "' + leaf + '" was found.' };
    }

    const heading = match.heading;
    let endLineIndex = doc.lines.length;
    for (const candidate of headings) {
        if (candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level) {
            endLineIndex = candidate.lineIndex;
            break;
        }
    }

    const contentLines = doc.lines.slice(heading.lineIndex + 1, endLineIndex);
    if (!contentLines.some(line => line.trim() !== '')) {
        return { ok: false, why: 'The section "' + heading.text + '" has no content to move.' };
    }

    return {
        ok: true,
        heading,
        headings,
        doc,
        // 1-based, inclusive — the same convention `anchor.line`/`lineEnd`
        // already use throughout quality-scan.js, so a caller can print
        // "removed lines 519-530" without a unit conversion of its own.
        lineStart: heading.lineIndex + 1,
        lineEnd: endLineIndex,
        lines: doc.lines.slice(heading.lineIndex, endLineIndex)
    };
}

// -- the reference left behind, and where the section lands ------------------

/*
 * GitHub's heading-anchor slugifier, and nothing fancier: lower-case, trim,
 * drop everything but letters/digits/hyphens/spaces, collapse whitespace to
 * a hyphen. The same rule markdown-editor.js's `qualitySlug` already applies
 * for its tier-1 dedupe link and for the link editor's heading targets,
 * reimplemented rather than imported because that file is not pure — pulling
 * it in would drag Theia and the DOM behind it for one string transform.
 *
 * \p{L}\p{N} rather than \w, in both copies: `\w` is ASCII-only, so the
 * earlier form deleted every letter of a non-Latin heading and slugged
 * "Стратегическое делегирование" to "-".
 */
function slugify(text) {
    return String(text == null ? '' : text).toLowerCase().trim()
        .replace(/[^\p{L}\p{N}\- ]+/gu, '').replace(/\s+/g, '-');
}

/** The last path segment, without requiring node's own `path` module — see the
 * file header on why this module requires nothing at all. */
function basename(filePath) {
    const value = String(filePath == null ? '' : filePath);
    const at = value.lastIndexOf('/');
    return at === -1 ? value : value.slice(at + 1);
}

const MOVED_FROM_PREFIX = 'Moved from ';

/**
 * The one real thing this whole module computes: cut a section out of
 * `sourceBody`, land it in `targetBody`, and describe both edits as whole new
 * document bodies — because `changes-store.js` diffs BODIES, per CONTRACT §6.
 *
 * REFUSES rather than guesses, in every case CONTRACT §6 names:
 *   - `finding.rule` is not `'purpose'` — nothing else names a section to cut.
 *   - `sourcePath === targetPath` — nowhere to move it TO.
 *   - the heading is not found, or is found more than once ambiguously.
 *   - the section has no content.
 *   - `targetBody` already has a heading with that exact text — moving a
 *     second copy in on top of it would silently create the very duplicate
 *     this move is meant to resolve.
 *
 * WHERE IT LANDS (CONTRACT §7): the END of `targetBody`, at the heading depth
 * it already had (never re-levelled — nothing in the envelope says what level
 * is right under an unrelated document's outline, and PLAN §7 is explicit that
 * guessing placement is worse than appending and letting a reviewer move it),
 * under a `## Moved from <sourcePath>` heading created only the first time —
 * a second move from the same source finds that heading already there (by its
 * exact text, checked across every heading target already carries — not only
 * its last one) and simply appends under it again, which is what makes "the
 * heading being created once and reused the second time" true across two
 * separate calls rather than something this function has to remember.
 */
function planMove({ finding, sourceBody, targetBody, sourcePath, targetPath } = {}) {
    if (!finding || finding.rule !== 'purpose') {
        // quality-scan.js's buildFix() gives every `purpose` violation (and
        // ONLY a purpose violation) `fix.kind: 'move-section'` — checking the
        // rule is checking the same fact one step earlier and needs no
        // knowledge of that payload's shape.
        return { ok: false, why: 'Only a purpose finding names a section to move.' };
    }
    if (typeof sourcePath !== 'string' || !sourcePath || typeof targetPath !== 'string' || !targetPath) {
        return { ok: false, why: 'A move needs both a source and a target document path.' };
    }
    if (sourcePath === targetPath) {
        return { ok: false, why: 'The target is the same document as the source (' + sourcePath + ') — nothing to move.' };
    }
    if (typeof sourceBody !== 'string' || typeof targetBody !== 'string') {
        return { ok: false, why: 'Both documents must be given as text to compute a move.' };
    }

    const anchor = (finding.anchors || [])[0];
    const sectionPath = anchor && anchor.section;
    if (!sectionPath) { return { ok: false, why: 'This finding names no section to move.' }; }

    const cut = findSection(sourceBody, sectionPath);
    if (!cut.ok) { return cut; }

    const targetDoc = splitDocument(targetBody);
    const targetHeadings = extractHeadings(targetDoc.lines);
    if (targetHeadings.some(h => h.text === cut.heading.text)) {
        return {
            ok: false,
            why: targetPath + ' already has a heading titled "' + cut.heading.text + '" — refusing to create a duplicate.'
        };
    }

    // -- the source edit: splice the section out, leave one line behind -----

    const targetName = basename(targetPath);
    const reference = 'Moved to [' + targetName + '](' + targetName + '#' + slugify(cut.heading.text) + ').';
    /*
     * A BLANK LINE AFTER THE REFERENCE, unless the next line is already one.
     * The cut takes the section's own trailing blank line with it, so replacing
     * the whole span with a single line left the reference butted straight up
     * against the next heading — `Moved to […].` followed immediately by
     * `#### Next Section`, which is valid ATX but reads as a mistake in the
     * source and is exactly the kind of thing a reviewer would reject a
     * proposal over. Not added at the end of the document, where a trailing
     * blank line is noise rather than a separator.
     */
    const after = cut.doc.lines.slice(cut.lineEnd);
    const needsGap = after.length > 0 && after[0].trim() !== '';
    const newSourceLines = cut.doc.lines.slice(0, cut.heading.lineIndex)
        .concat(needsGap ? [reference, ''] : [reference])
        .concat(after);
    const newSourceBody = joinDocument(newSourceLines, cut.doc.eol, cut.doc.trailingNewline);

    // -- the target edit: append under a `## Moved from <source>` heading ---

    const movedFromText = MOVED_FROM_PREFIX + sourcePath;
    const hasMovedFromHeading = targetHeadings.some(h => h.level === 2 && h.text === movedFromText);

    const addition = [];
    // No leading blank line onto a genuinely empty target — see the header on
    // why an empty document is not merely "one line shorter" here.
    if (targetDoc.lines.length) { addition.push(''); }
    if (!hasMovedFromHeading) {
        addition.push('## ' + movedFromText);
        addition.push('');
    }
    const insertedHeadingOffset = addition.length; // where cut.lines[0] lands within `addition`
    for (const line of cut.lines) { addition.push(line); }

    const newTargetLines = targetDoc.lines.concat(addition);
    const newTargetBody = joinDocument(newTargetLines, targetDoc.eol, targetDoc.trailingNewline);
    const insertedAt = targetDoc.lines.length + insertedHeadingOffset + 1; // 1-based

    return {
        ok: true,
        source: {
            body: newSourceBody,
            removed: {
                heading: cut.heading.text,
                level: cut.heading.level,
                line: cut.lineStart,
                lineEnd: cut.lineEnd
            }
        },
        target: {
            body: newTargetBody,
            insertedAt
        }
    };
}

module.exports = {
    planMove,
    findSection,
    matchSectionHeading,
    extractHeadings,
    splitDocument,
    joinDocument,
    slugify,
    basename
};
