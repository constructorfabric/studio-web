/*
 * Restoring hand-wrapping after a save the user did not ask to reflow.
 *
 * Many repositories this product opens were hard-wrapped by hand at ~80
 * columns, long before this editor existed. Markdown treats a single
 * newline inside a paragraph as a SOFT break — cosmetic, not structural —
 * so it carries no meaning the document model is obliged to keep, and once
 * the model stops holding those newlines (a separate fix, not this file)
 * every wrapped paragraph in an untouched file re-serialises onto one long
 * line. The file itself did not change in any way a diff should report, but
 * git sees the whole paragraph flip, and the change-review machinery
 * (diff.js's diffHunks) reports every line of it as edited — exactly the
 * "touched one word, reviewed the whole paragraph" failure this exists to
 * prevent.
 *
 * The fix is NOT "never reflow" — a real edit to a wrapped paragraph has to
 * be allowed to come out however the serializer naturally emits it, and an
 * inserted paragraph has no prior wrapping to restore in the first place.
 * The fix is block-level, after the fact: split both the file's ORIGINAL
 * text and the freshly serialised text into blocks, line the two lists up
 * by content, and wherever a block is the same PROSE — its words unchanged,
 * only the position of its line breaks different — put the original's line
 * breaks back. A block that is not the same prose (a real edit) or that has
 * no prior wrapping to speak of is left exactly as the serializer wrote it.
 *
 * Block-level, not line-level: diff.js's diffHunks operates on individual
 * lines, which is right for review (a hunk has to be something a user can
 * accept or reject on its own) but wrong here, because a hard-wrapped
 * paragraph's lines do not correspond 1:1 with the same paragraph reflowed
 * onto one line — there is nothing for a line-level LCS to align. Blocks
 * collapse each paragraph to a single comparable unit first, and reuse the
 * SAME diffSequences alignment diff.js already relies on, so "the same
 * block, moved" and "a new block, inserted in the middle" are told apart by
 * the one alignment algorithm this product trusts, not a second one that
 * could disagree with it.
 *
 * A block whose prose DID change still needs its wrapping put back, or the
 * serialiser's one-long-line rendering makes a one-word edit look like the
 * whole paragraph was rewritten — the original complaint ("I add one change
 * and it breaks everything") in the one form block-matching alone cannot
 * fix, because the two sides are no longer the same text to align as blocks.
 * The fix drops one level further, to WORDS: tokenise the original block and
 * the new one, align them with the same diffSequences LCS the block match
 * and the hunks both use, and walk the alignment re-inserting a newline
 * every time it crosses a line boundary recorded from the ORIGINAL block.
 * A break stays put wherever the words around it are unchanged; an inserted
 * word just makes its line longer, a deleted one makes it shorter. This is
 * NOT re-wrapping to a column limit — a line a few characters over 80 after
 * an insertion is the correct trade, because the point is that the DIFF a
 * word-edit produces should look like a word-edit, not that the file stay
 * under some width.
 */

const { diffSequences } = require('./diff');

/*
 * Blocks are separated by a RUN of blank lines, not a single newline, which
 * is exactly the boundary Markdown itself uses between block-level
 * constructs. A lone `\n` inside a block is what a hard-wrapped paragraph
 * IS — that has to stay inside the block for the whitespace-collapsed key
 * below to ever see it as the same text as its reflowed form.
 */
function splitBlocks(body) {
    return body.split(/\n(?:[ \t]*\n)+/);
}

/*
 * The comparison key: every run of whitespace — spaces, tabs, and the very
 * newlines this file exists to move around — collapsed to one space. Two
 * blocks with this same key are the same prose no matter where either one's
 * line breaks fall, which is the whole basis for calling one a rewrap of the
 * other rather than an edit.
 */
function collapseKey(block) {
    return block.replace(/\s+/g, ' ').trim();
}

/*
 * Blocks where a line break is not cosmetic, so "restoring" one would
 * silently change meaning instead of just appearance:
 *
 *   - a fence (```/~~~ opener) — the lines inside are the fenced content
 *     itself, not prose reflowed by a renderer;
 *   - indented code (four spaces or a tab to start) — same reasoning, the
 *     other accept-form for the same construct;
 *   - a table row (a line whose first non-space character is `|`) — a row
 *     boundary IS a newline; there is no "reflowed" form of a table to
 *     un-reflow.
 *
 * Checked on EITHER side of the pair. The serializer (md-serialize.js) only
 * ever emits fenced code, never indented — `fences: true` — so an indented
 * hit here can only come from the original file, e.g. a block whose
 * markdown-it-flavoured indentation predates this parser. Checked anyway,
 * on both sides, because this function only knows it is looking at "the
 * same prose" from the whitespace-collapsed key, and that key cannot tell a
 * table row's newline from a paragraph's.
 */
function hasSignificantWhitespace(block) {
    const lines = block.split('\n');
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[0])) { return true; }
    if (/^( {4}|\t)/.test(lines[0])) { return true; }
    return lines.some(line => /^[ \t]*\|/.test(line));
}

/*
 * Whitespace-separated words, the unit the changed-block rewrap aligns on.
 * A newline is just whitespace at this level — tokenising a block that
 * already has its original line breaks in it (as happens on the second of
 * two calls, see idempotence below) yields the exact same word list as
 * tokenising its one-line form, which is what makes this deterministic on
 * the ALREADY-restored text and not just on the serializer's raw output.
 */
function tokenizeWords(block) {
    return block.split(/\s+/).filter(Boolean);
}

/*
 * Which word-token INDEX each of the original's line breaks falls at, e.g.
 * {12, 27} means "a new line starts at word 12 and another at word 27".
 * Counting non-whitespace runs per line rather than re-tokenising the whole
 * block keeps this in lockstep with tokenizeWords: a line never splits a
 * word, so summing per-line counts lands on the same boundaries.
 */
function lineBoundaries(origBlock) {
    const lines = origBlock.split('\n');
    const boundaries = new Set();
    let count = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        count += (lines[i].match(/\S+/g) || []).length;
        boundaries.add(count);
    }
    return boundaries;
}

/*
 * Restore wrapping onto a single block the words themselves DID change in.
 * Guards mirror the unchanged-block path exactly: no prior wrapping to
 * speak of, or significant whitespace on either side (a fence/table cannot
 * be rewrapped without changing what it means), and NEXT is returned as the
 * serializer wrote it.
 *
 * The alignment is over WORDS, not lines, and uses the same diffSequences
 * LCS the block match above and diff.js's hunks both use — so "this word is
 * unchanged" here can never disagree with what the reviewer is shown as
 * unchanged. Walking that alignment, a line boundary recorded from the
 * original is owed to whichever word gets emitted next once the walk
 * reaches that position, whether that word survived unchanged, was typed
 * fresh, or comes after a run of deletions that ate the original's own
 * line-starting word — `pendingBreak` carries the debt across ops until
 * there is an actual word to hang it on.
 */
function rewrapChangedBlock(orig, next) {
    if (!orig.includes('\n') || hasSignificantWhitespace(orig) || hasSignificantWhitespace(next)) {
        return next;
    }

    const origWords = tokenizeWords(orig);
    const boundaries = lineBoundaries(orig);
    const ops = diffSequences(origWords, tokenizeWords(next));

    const out = [];
    let origIdx = 0;
    let pendingBreak = false;
    const emit = word => {
        if (!out.length) { out.push(word); }
        else if (pendingBreak) { out.push('\n' + word); pendingBreak = false; }
        else { out.push(' ' + word); }
    };
    for (const op of ops) {
        if (op.op === '-') {
            // Deleted words still consume original positions — a boundary
            // that fell on one of them is not gone, it is just unpaid until
            // the next word (matched or inserted) comes along to carry it.
            for (let i = 0; i < op.a.length; i++) {
                if (boundaries.has(origIdx)) { pendingBreak = true; }
                origIdx++;
            }
        } else if (op.op === '=') {
            for (const word of op.b) {
                if (boundaries.has(origIdx)) { pendingBreak = true; }
                emit(word);
                origIdx++;
            }
        } else {
            // Inserted words do not consume an original position, so an
            // insertion sitting exactly at a boundary stays attached to the
            // end of the PRECEDING line — the break is only paid out once
            // the walk reaches the original word that actually started the
            // next one.
            for (const word of op.b) { emit(word); }
        }
    }
    return out.join('');
}

/**
 * Restore ORIGINAL line-wrapping onto NEWBODY, for every block whose prose
 * is unchanged — see the file header for why this exists and why it works
 * block-by-block rather than line-by-line.
 *
 * `originalBody` missing or empty means there is nothing to restore
 * anything FROM (a brand-new file, or no prior save to compare against);
 * `newBody` is returned untouched rather than guessing.
 */
function preserveWrapping(originalBody, newBody) {
    if (!originalBody) { return newBody; }

    const origBlocks = splitBlocks(originalBody);
    const newBlocks = splitBlocks(newBody);
    const ops = diffSequences(origBlocks.map(collapseKey), newBlocks.map(collapseKey));

    const out = [];
    let posA = 0, posB = 0;
    for (let idx = 0; idx < ops.length; idx++) {
        const op = ops[idx];
        if (op.op === '=') {
            const n = op.a.length;
            for (let i = 0; i < n; i++) {
                const orig = origBlocks[posA + i];
                const next = newBlocks[posB + i];
                // No newline in the original: there is no wrapping to put
                // back, so restoring would just be copying the same text.
                const restore = orig.includes('\n') &&
                    !hasSignificantWhitespace(orig) && !hasSignificantWhitespace(next);
                out.push(restore ? orig : next);
            }
            posA += n; posB += n;
        } else if (op.op === '-') {
            const next = ops[idx + 1];
            // A removed run immediately followed by an added run of the
            // SAME length is not "these blocks vanished, those appeared" —
            // it is "these blocks became those", one-for-one, in document
            // order (a genuinely mismatched pair never shares a collapsed
            // key, which is exactly why they landed in -/+ instead of '=').
            // Only a matching count is unambiguous enough to pair; a
            // reshaped run (blocks merged or split) falls through to the
            // plain delete/insert handling below, unrewrapped.
            if (next && next.op === '+' && next.b.length === op.a.length) {
                for (let i = 0; i < op.a.length; i++) {
                    out.push(rewrapChangedBlock(origBlocks[posA + i], newBlocks[posB + i]));
                }
                posA += op.a.length; posB += next.b.length;
                idx++;
            } else {
                posA += op.a.length;
            }
        } else {
            for (let i = 0; i < op.b.length; i++) { out.push(newBlocks[posB + i]); }
            posB += op.b.length;
        }
    }

    // The join is always exactly one blank line, matching what the
    // serializer itself puts between blocks — the ORIGINAL file's blank-run
    // width (one blank line, three blank lines, whatever a hand-edited file
    // happened to have) is not part of any block's own text and is not a
    // rewrap decision this function makes.
    let result = out.join('\n\n');

    // Trailing newline is NEWBODY's convention, not the original's: the
    // last restored block carries whatever trailing whitespace ITS source
    // body ended on, which is irrelevant here — only the document-level
    // convention of the text actually being written out matters.
    const newTrailing = /\n*$/.exec(newBody)[0];
    result = result.replace(/\n*$/, '') + newTrailing;

    return result;
}

module.exports = { preserveWrapping };
