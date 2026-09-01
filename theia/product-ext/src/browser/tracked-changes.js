/*
 * Tracked changes — the second way to review a pending proposal.
 *
 * The product has always had exactly one review surface: the DIFF QUEUE. A
 * proposal arrives, the document is held at its reviewed state, and the
 * difference is presented in the rail as line-level hunks in a monospace
 * gutter, `+`/`−` signs and all. That surface is precise and it is the right
 * one when the question is "what exactly changed, line by line".
 *
 * It is the wrong one when the question is "does this read better". A patch
 * shows you the change with the document removed; a writer deciding on a
 * rewritten sentence needs the change with the document still around it. That
 * is what Word and Google Docs have done for twenty years, and it is what this
 * module renders: the document itself, with deletions struck through and
 * insertions underlined in place, and one card per change beside it carrying
 * who proposed it, when, what it does in words, and the two decisions.
 *
 * WHAT THIS MODULE IS NOT
 *
 * It is not a second review pipeline. There is exactly one — capture a
 * proposal, derive hunks from (base, proposed) through diff.js, record a
 * verdict per hunk id, recompose the body with applyHunks. This module adds a
 * RENDERING of that pipeline and nothing else: the same hunks, the same ids,
 * the same `hunk-accept` / `hunk-reject` actions the diff queue dispatches.
 * Switching a project between the two styles mid-review is therefore safe by
 * construction, because there is no state to migrate — both surfaces are
 * views of the same decisions map.
 *
 * HOW THE INLINE MARKUP IS PRODUCED
 *
 * The obvious approach — render the document to HTML and then walk the DOM
 * inserting <del>/<ins> at the right offsets — needs a mapping from Markdown
 * source positions to rendered DOM positions, which this product does not
 * have and which no cheap version of is correct (one source line can become
 * zero, one, or several nodes).
 *
 * So the marking happens in the SOURCE, before rendering, using three pairs of
 * C0 control characters as sentinels. Control characters survive markdownToHtml
 * untouched: `escapeHtml` only rewrites `& < >`, `inlineToHtml`'s emphasis and
 * code regexes do not match them, and `!line.trim()` does not treat them as
 * whitespace, so a marked line is never mistaken for a blank one. After
 * rendering, one pass rewrites each sentinel into a real tag. The result is
 * that a deleted list item is still a list item and a changed heading is still
 * a heading — the block structure is Markdown's, not ours.
 *
 * The one place the sentinels are placed with care is the start of a line: a
 * whole-line mark wraps only the text AFTER the block prefix (`- `, `1. `,
 * `## `, `> `), because a `<del>` opened before `- ` would stop the line being
 * a bullet at all. Word-level marks inside a paired line need no such care —
 * the prefix is common to both sides, so the word diff leaves it outside the
 * marks on its own.
 */

const { splitLines, coalesceParts } = require('./diff');
const { ICONS } = require('./icons');
const { avatarHtml } = require('./comment-ui');
const { authorRecord } = require('./identity');

// Deletion, insertion, and settled (already answered). Each pair is
// OPEN + payload + MID ... END, so the mark's provenance travels with it and
// every rendered fragment can be addressed back to the change it belongs to.
const D_OPEN = '\u0011', D_MID = '\u0012', D_END = '\u0013';
const I_OPEN = '\u0014', I_MID = '\u0015', I_END = '\u0016';
const S_OPEN = '\u0017', S_MID = '\u0018', S_END = '\u0019';

/*
 * What a mark has to know about itself, once a document can carry suggestions
 * from more than one author: which change it belongs to (to select it), which
 * PROPOSAL that change is part of (to decide it — two authors can propose
 * textually identical edits and they are still two decisions), and which author
 * SLOT to draw it in. Unit separator as the delimiter because no id contains
 * one, and because the payload has to survive markdownToHtml exactly as the
 * sentinels do.
 */
const SEP = '\u001f';

function payload(entry) {
    return String(entry.slot === undefined ? 0 : entry.slot) + SEP +
        String(entry.proposalId || '') + SEP + String(entry.ref || '');
}

/*
 * The Markdown that must stay OUTSIDE a whole-line mark, in the order the
 * parser reads it: blockquote arrows, then either a bullet (with an optional
 * task box), an ordered marker, or an ATX heading. Indentation is part of it
 * because list nesting is expressed as leading spaces.
 */
const BLOCK_PREFIX = /^([ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]*)?|\d+[.)][ \t]+|#{1,6}[ \t]+)?)([\s\S]*)$/;

function esc(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// --- marking the source -----------------------------------------------------

/** Wrap a whole line, leaving its Markdown block prefix outside the mark. */
function markLine(open, mid, end, id, line) {
    const match = BLOCK_PREFIX.exec(line);
    const prefix = match ? match[1] : '';
    const rest = match ? match[2] : line;
    // An empty line has nothing to strike through, and a mark around nothing
    // renders as an empty tag that the reader cannot see but the parser can.
    if (!rest) { return line; }
    return prefix + open + id + mid + rest + end;
}

/**
 * One changed line rendered as a single line carrying both sides, which is the
 * whole point of this style: `tell ~~you too much~~, i want to change this`
 * reads as a sentence, where the queue's two stacked monospace rows do not.
 * Used only where diff.js paired the lines (its similarity floor) — an
 * unpaired old and new line are two different sentences and get a row each.
 */
function markPairedLine(tag, parts) {
    return coalesceParts(parts).map(part => {
        if (part.type === '=') { return part.text; }
        if (part.type === '-') { return D_OPEN + tag + D_MID + part.text + D_END; }
        return I_OPEN + tag + I_MID + part.text + I_END;
    }).join('');
}

function markHunk(hunk, tag) {
    const rows = [];
    const count = Math.max(hunk.oldLines.length, hunk.newLines.length);
    for (let i = 0; i < count; i++) {
        const oldLine = hunk.oldLines[i];
        const newLine = hunk.newLines[i];
        const parts = hunk.words && hunk.words[i];
        if (parts && oldLine !== undefined && newLine !== undefined) {
            rows.push(markPairedLine(tag, parts));
            continue;
        }
        if (oldLine !== undefined) { rows.push(markLine(D_OPEN, D_MID, D_END, tag, oldLine)); }
        if (newLine !== undefined) { rows.push(markLine(I_OPEN, I_MID, I_END, tag, newLine)); }
    }
    return rows;
}

/**
 * Order the entries the document will be marked with, and flag what cannot be
 * drawn.
 *
 * Two authors can suggest edits to the SAME lines. Both are legitimate and both
 * have to be decidable, but they cannot both be rendered in place — the second
 * one describes text the first one has already replaced, and marking them
 * together produces a paragraph that is neither author's. So the earlier
 * suggestion is drawn and the later one is flagged `overlapped`: its card is
 * still there, still decidable, and says that it is waiting on the other.
 *
 * Earlier means earlier in the DOCUMENT, then older by creation, so the choice
 * is stable across renders rather than depending on read order.
 */
function orderEntries(entries) {
    const ordered = entries.slice().sort((a, b) =>
        a.hunk.oldStart - b.hunk.oldStart ||
        Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
    let reach = -1;
    for (const entry of ordered) {
        const start = entry.hunk.oldStart;
        const stop = start + entry.hunk.oldCount;
        entry.overlapped = start < reach;
        if (!entry.overlapped) { reach = Math.max(reach, stop); }
    }
    return ordered;
}

/**
 * The document with every drawable entry marked.
 *
 * An entry that has been ANSWERED shows the side that won, quietly tinted rather
 * than removed: "I already accepted that one" is information the reviewer needs
 * while deciding the rest, and a change that vanishes on accept makes the undo
 * button feel like it operates on nothing.
 */
function trackedMarkdown(baseBody, entries) {
    const lines = splitLines(baseBody);
    const out = [];
    let cursor = 0;
    for (const entry of orderEntries(entries)) {
        if (entry.overlapped) { continue; }
        const hunk = entry.hunk;
        if (hunk.oldStart < cursor) { continue; }
        out.push(...lines.slice(cursor, hunk.oldStart));
        const tag = payload(entry);
        if (entry.decision === 'accepted') {
            out.push(...hunk.newLines.map(line => markLine(S_OPEN, S_MID, S_END, tag + SEP + 'accepted', line)));
        } else if (entry.decision === 'rejected') {
            out.push(...hunk.oldLines.map(line => markLine(S_OPEN, S_MID, S_END, tag + SEP + 'rejected', line)));
        } else {
            out.push(...markHunk(hunk, tag));
        }
        cursor = hunk.oldStart + hunk.oldCount;
    }
    out.push(...lines.slice(cursor));
    return out.join('\n');
}

/**
 * The document as it would read if every open change were taken.
 *
 * The SAME walk as `trackedMarkdown` above -- same ordering, same overlap rule,
 * same "an answered entry shows the side that won" -- with the sentinels left
 * out. That is the point of putting it here rather than deriving it separately
 * in the editor: the marked-up page and the live marks would otherwise be two
 * independent opinions about which of two authors' overlapping suggestions is
 * the one being drawn, and a reader comparing the rail to the prose would be
 * the one who found out they disagreed.
 *
 * A `conflicted` hunk -- one whose text is no longer in the document -- is
 * skipped rather than applied at its stale offset. `orderEntries` cannot see
 * that condition (it is a property of the anchoring, decided in change-log.js),
 * and applying a hunk whose `oldLines` are not what is actually there would
 * splice the replacement over whatever now occupies those line numbers.
 */
function suggestedMarkdown(baseBody, entries) {
    const lines = splitLines(baseBody);
    const out = [];
    let cursor = 0;
    for (const entry of orderEntries(entries)) {
        if (entry.overlapped) { continue; }
        const hunk = entry.hunk;
        if (hunk.conflicted || hunk.oldStart < cursor) { continue; }
        out.push(...lines.slice(cursor, hunk.oldStart));
        out.push(...(entry.decision === 'rejected' ? hunk.oldLines : hunk.newLines));
        cursor = hunk.oldStart + hunk.oldCount;
    }
    out.push(...lines.slice(cursor));
    return out.join('\n');
}

/** Rewrite the sentinels the renderer carried through into real elements. */
function substituteMarks(html) {
    const attrs = spec => {
        const parts = String(spec).split(SEP);
        return ' data-slot="' + esc(parts[0] || '0') + '"' +
            ' data-proposal="' + esc(parts[1] || '') + '"' +
            ' data-hunk="' + esc(parts[2] || '') + '"';
    };
    return String(html)
        .replace(/\u0011([^\u0012]*)\u0012/g, (_, spec) =>
            '<del class="studio-tc studio-tc-del"' + attrs(spec) + '>')
        .replace(/\u0013/g, '</del>')
        .replace(/\u0014([^\u0015]*)\u0015/g, (_, spec) =>
            '<ins class="studio-tc studio-tc-ins"' + attrs(spec) + '>')
        .replace(/\u0016/g, '</ins>')
        .replace(/\u0017([^\u0018]*)\u0018/g, (_, spec) => {
            const parts = String(spec).split(SEP);
            const kind = parts[3] === 'rejected' ? 'rejected' : 'accepted';
            return '<span class="studio-tc studio-tc-settled ' + kind + '"' +
                attrs(parts.slice(0, 3).join(SEP)) + '>';
        })
        .replace(/\u0019/g, '</span>');
}

/**
 * The document as the reviewer sees it.
 *
 * `entries` is a flat list of { hunk, ref, proposalId, slot, decision,
 * createdAt } across EVERY open proposal, because the document is one document —
 * a per-proposal render would have to composite several marked-up versions of
 * the same prose, which is the problem this flat list avoids by construction.
 *
 * `render` is markdownToHtml, passed in rather than required, so this module
 * stays a pure function of its arguments and a different surface could hand it a
 * different renderer without this file learning about HTML files.
 */
function trackedHtml(baseBody, entries, render) {
    return substituteMarks(render(trackedMarkdown(baseBody, entries)));
}

// --- describing a change in words -------------------------------------------

const QUOTE_LIMIT = 64;

function quote(text) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    const shown = flat.length > QUOTE_LIMIT ? flat.slice(0, QUOTE_LIMIT - 1) + '…' : flat;
    return '<q class="studio-change-quote">' + esc(shown) + '</q>';
}

/*
 * Quoting a line means quoting what it SAYS, not how it is marked up. `- ` and
 * `## ` are the document's structure; a card reading Replace "- second item"
 * spends its most valuable words on two characters the reviewer did not write
 * and cannot decide on separately.
 */
function quoteLines(lines) {
    return quote(lines.map(line => {
        const match = BLOCK_PREFIX.exec(line);
        return match ? match[2] : line;
    }).join(' '));
}

/*
 * Whitespace has to be named, not quoted. Google Docs says "Delete space" for
 * exactly this reason: a card reading `Delete " "` is a card the reader has to
 * decode, and the single most common edit an assistant makes to prose is
 * closing up a double space or removing a trailing one.
 */
function whitespaceName(text) {
    if (text.length === 0 || /\S/.test(text)) { return undefined; }
    if (/\n/.test(text)) { return text.length === 1 ? 'a line break' : 'line breaks'; }
    return text.length === 1 ? 'a space' : text.length + ' spaces';
}

function lineCount(n, noun) {
    return n + ' ' + noun + (n === 1 ? '' : 's');
}

/**
 * A card's headline and its supporting sentence.
 *
 * The headline is what the change DOES, in two or three words, because that is
 * all a reviewer reads before deciding on an obvious one. The detail is the
 * evidence for it, and is what they read when it is not obvious.
 */
/**
 * The edits inside a hunk, as (removed, added) pairs, taken from the same
 * coalesced runs the inline marks are drawn from — so the card cannot describe
 * a different change from the one the document is showing.
 *
 * `whole` is false when any line of the hunk is unpaired, which means part of
 * the change is a block appearing or disappearing rather than a sentence being
 * edited. A quoted before/after sentence would then be describing only part of
 * what the reviewer is deciding on, so the summary falls back to line counts.
 */
function hunkEdits(hunk) {
    const count = Math.max(hunk.oldLines.length, hunk.newLines.length);
    const edits = [];
    let whole = count > 0;
    for (let i = 0; i < count; i++) {
        const parts = hunk.words && hunk.words[i];
        if (!parts || hunk.oldLines[i] === undefined || hunk.newLines[i] === undefined) {
            whole = false;
            continue;
        }
        let pair;
        for (const part of coalesceParts(parts)) {
            if (part.type === '=') { pair = undefined; continue; }
            if (!pair) { pair = { removed: '', added: '' }; edits.push(pair); }
            if (part.type === '-') { pair.removed += part.text; } else { pair.added += part.text; }
        }
    }
    return { edits, whole };
}

/** The Word-style sentence for one (removed, added) pair. */
function editSentence(edit) {
    const removedName = whitespaceName(edit.removed);
    const addedName = whitespaceName(edit.added);
    const removed = removedName || quote(edit.removed);
    const added = addedName || quote(edit.added);
    if (edit.removed && edit.added) {
        return { verb: 'Replace', action: 'Replace text', detail: 'Replace ' + removed + ' with ' + added };
    }
    if (edit.added) {
        return { verb: 'Insert', action: addedName ? 'Insert ' + addedName : 'Insert text', detail: 'Insert ' + added };
    }
    return { verb: 'Delete', action: removedName ? 'Delete ' + removedName : 'Delete text', detail: 'Delete ' + removed };
}

function changeSummary(hunk) {
    const { edits, whole } = hunkEdits(hunk);

    if (whole && edits.length === 1) {
        const sentence = editSentence(edits[0]);
        return { action: sentence.action, detail: sentence.detail };
    }
    if (whole && edits.length > 1) {
        /*
         * Several small edits inside lines the reviewer decides on together.
         * The first one is shown in full because it is usually representative,
         * and the count says how much is not being shown — a card that quoted
         * all six would be longer than the paragraph it describes.
         */
        const sentence = editSentence(edits[0]);
        const rest = edits.length - 1;
        return {
            action: edits.length + ' edits',
            detail: sentence.detail + ' · and ' + rest + ' more edit' + (rest === 1 ? '' : 's')
        };
    }

    const oldCount = hunk.oldLines.length;
    const newCount = hunk.newLines.length;
    if (hunk.kind === 'insert') {
        return { action: 'Insert ' + lineCount(newCount, 'line'), detail: 'Insert ' + quoteLines(hunk.newLines) };
    }
    if (hunk.kind === 'delete') {
        return { action: 'Delete ' + lineCount(oldCount, 'line'), detail: 'Delete ' + quoteLines(hunk.oldLines) };
    }
    /*
     * A wholesale rewrite: the same number of lines, but diff.js declined to
     * pair them (its similarity floor), which means the new text is not the old
     * text edited — it is different text in the same place. "Replace 1 line with
     * 1" is technically true and tells the reader nothing; "Rewrite" is what
     * happened.
     */
    return {
        action: oldCount === newCount
            ? 'Rewrite ' + lineCount(oldCount, 'line')
            : 'Replace ' + lineCount(oldCount, 'line') + ' with ' + newCount,
        detail: 'Replace ' + quoteLines(hunk.oldLines) + ' with ' + quoteLines(hunk.newLines)
    };
}

/** The card's sentence as plain text, for a history entry or a toast. */
function changeSummaryText(hunk) {
    const summary = changeSummary(hunk);
    return summary.detail
        .replace(/<q[^>]*>/g, '\u201c').replace(/<\/q>/g, '\u201d')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

/*
 * The stamp Word and Docs both use: clock time, then the day only when the day
 * is not today. A review conversation happens within a session, so "5:26 PM"
 * is the answer to "when"; the date matters only for a proposal that has been
 * sitting unanswered, and then it matters a lot.
 */
function changeStamp(iso) {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) { return ''; }
    const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const today = new Date();
    const sameDay = at.getFullYear() === today.getFullYear() &&
        at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
    if (sameDay) { return time + ' Today'; }
    return time + ' ' + at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * One change, as a card beside the document.
 *
 * The decision controls emit the same `data-act` values in both review styles,
 * so the editor's click handler serves both with no branch in it. What is new
 * here is `data-proposal`: with several proposals open, a hunk reference is not
 * enough to name a decision.
 *
 * `options`:
 *   current      this is the change the arrows and the document are focused on
 *   slot         which author line style to draw
 *   replyToName  this suggestion answers another one, so it nests under it
 *   mine         I wrote it, so the third control is Withdraw rather than Edit
 *   overlapped   another suggestion covers the same lines and is drawn instead
 *   conflicted   the text this was written against is no longer in the document
 */
function changeCardHtml(hunk, decision, proposal, options) {
    const opts = options || {};
    const summary = changeSummary(hunk);
    const who = (proposal && (proposal.by || proposal.author)) || 'assistant';
    const at = (proposal && (proposal.updatedAt || proposal.createdAt)) || undefined;
    const full = at && Number.isFinite(new Date(at).getTime()) ? new Date(at).toLocaleString() : '';
    const ref = esc(opts.ref || hunk.key || hunk.id);
    const target = ' data-id="' + ref + '" data-proposal="' + esc(proposal ? proposal.id : '') + '"';

    /*
     * Three controls, and the third one is the whole point of Suggesting mode.
     *
     * Accept and reject answer somebody else's suggestion. EDIT answers it with
     * a suggestion of my own: it does not rewrite what they proposed, it opens
     * their wording in my editor as the starting point for mine, and the two
     * cards then sit together with mine marked as a reply. Nobody's words are
     * altered by anybody else, which is the same rule this repository already
     * holds for a person's comment.
     *
     * On my OWN suggestion the third control is Withdraw instead, because
     * "propose a counter-suggestion to yourself" is not a thing — revising it is
     * what typing does.
     */
    const third = opts.mine
        ? '<button class="studio-icon-btn" data-act="withdraw-suggestion"' + target + ' ' +
          'title="Withdraw this suggestion" aria-label="Withdraw this suggestion">' + ICONS.trash + '</button>'
        : '<button class="studio-icon-btn" data-act="counter-suggest"' + target + ' ' +
          'title="Suggest a change to this suggestion" aria-label="Suggest a change to this suggestion">' +
          ICONS.pencil + '</button>';

    /* A conflicted change has nothing to accept into — see decideSuggestion. So
       the accept control is absent rather than present-and-failing, and the note
       below says why. */
    const controls = opts.conflicted && !decision
        ? '<button class="studio-icon-btn danger" data-act="hunk-reject"' + target + ' ' +
          'title="Dismiss this change" aria-label="Dismiss this change">' + ICONS.close + '</button>' + third
        : decision
        ? '<span class="studio-change-verdict">' + (decision === 'accepted' ? 'Accepted' : 'Dismissed') + '</span>' +
          /* Not `undo-decision`, which is the rail header's control and pops the
             LAST decision whatever it was. A button on this card has to undo
             THIS card, or it is lying about its scope. */
          '<button class="studio-icon-btn" data-act="reopen-change"' + target + ' ' +
          'title="Undo this decision" aria-label="Undo this decision">' + ICONS.undo + '</button>'
        : '<button class="studio-icon-btn accept" data-act="hunk-accept"' + target + ' ' +
          'title="Accept this change" aria-label="Accept this change">' + ICONS.check + '</button>' +
          '<button class="studio-icon-btn danger" data-act="hunk-reject"' + target + ' ' +
          'title="Dismiss this change" aria-label="Dismiss this change">' + ICONS.close + '</button>' +
          third;

    const notes = [];
    if (opts.overlapped) {
        notes.push('Another suggestion covers the same lines and is the one shown in the document. ' +
            'Decide that one first and this will re-derive against the result.');
    }
    if (opts.conflicted) {
        notes.push('The text this was written against is no longer in the document.');
    }

    return '<div class="studio-change-card' + (decision ? ' decided ' + decision : '') +
        (opts.current ? ' current' : '') + (opts.mine ? ' mine' : '') +
        (opts.replyToName ? ' reply' : '') + (opts.overlapped ? ' overlapped' : '') +
        '" data-hunk="' + ref + '" data-proposal="' + esc(proposal ? proposal.id : '') + '" ' +
        'data-slot="' + esc(opts.slot === undefined ? 0 : opts.slot) + '" ' +
        'data-act="focus-change"' + target + ' role="group" ' +
        'aria-label="' + esc(summary.action) + ', ' + esc(authorRecord(who).name) + '">' +
        (opts.replyToName
            ? '<div class="studio-change-reply-to">In reply to ' + esc(opts.replyToName) + '</div>'
            : '') +
        '<div class="studio-change-head">' +
        avatarHtml(who) +
        '<div class="studio-change-who">' +
        '<b>' + esc(authorRecord(who).name) + '</b>' +
        (at ? '<time title="' + esc(full) + '">' + esc(changeStamp(at)) + '</time>' : '') +
        '</div>' +
        '<span class="studio-change-spacer"></span>' +
        controls +
        '</div>' +
        '<div class="studio-change-action">' + esc(summary.action) + '</div>' +
        '<div class="studio-change-detail">' + summary.detail + '</div>' +
        notes.map(note => '<div class="studio-change-note">' + note + '</div>').join('') +
        '</div>';
}

/*
 * How authors are told apart, and why not by colour.
 *
 * Google Docs gives each author a hue. This product's palette is monochrome plus
 * one accent plus one danger, and those two already mean something specific here
 * — the accent is the incoming side of a change and the accept control, danger is
 * the outgoing side and the reject control. Spending hues on identity would
 * either break that or introduce a third and fourth meaning for colour on the
 * same run of text.
 *
 * So authors are distinguished by LINE STYLE, which is the precedent this product
 * already set: .studio-avatar.agent is dashed rather than a different colour,
 * for exactly this reason. Four slots, assigned in order of first appearance in
 * the document. Past four they wrap, and attribution falls back to the card —
 * which is where the name and the avatar are anyway, and which is why this is a
 * legible degradation rather than a wrong answer.
 */
const AUTHOR_SLOTS = ['solid', 'dashed', 'dotted', 'double'];

/*
 * Colour is borrowed, not invented — but not from where this used to borrow.
 *
 * This used to reuse --studio-accent for an insertion and --studio-danger for
 * a deletion, on the theory that the accept/reject control colours were the
 * same fact as inserted/deleted content. They are not: --studio-accent is
 * this product's one navigational blue, so in any document with real
 * hyperlinks an inserted word and a link became the same colour — reported as
 * "I can't tell what was added from what I can click." Every other review
 * tool (GitHub, GitLab, Word compare, CKEditor) puts inserted/deleted on
 * green/red and leaves accept/reject-style blue-vs-red for the DECISION, not
 * the content, which is the distinction restored here.
 *
 * --studio-ins and --studio-del (product-frontend-module.js) are aliases of
 * --studio-verified and --studio-danger — reusing this palette's existing
 * green and red rather than a new pair — so an insertion is underlined green
 * and a deletion struck through in red, and the diff queue's own accept/
 * reject colouring is untouched: accepting a deletion still shows as an
 * accent-coloured "Accepted", not a red one, because the decision and the
 * content it decided on are different facts. See .studio-tc-settled and
 * .studio-change-verdict below, which stay on accent/danger on purpose.
 *
 * Underline and strikethrough carry the meaning on their own, which is the
 * accessibility floor this needs: the two states are still distinguishable
 * with no colour perception at all, and it is what keeps the per-author
 * dashed/dotted/double variants (below) legible under either colour.
 */
const TRACKED_CSS = `
/* -- the document, marked in place -- */
/* The tracked document carries .studio-doc-page too, so it inherits the
   measured column and the whole prose type scale rather than restating them —
   a review surface that set its own line height would be describing a document
   the reader does not have. :not() rather than a new class on the editor's own
   page, so nothing that already selects .studio-doc-page has to change. */
.studio-tracked-page { display: none; }
.studio-doc-body.tracked-review .studio-doc-scroll > .studio-doc-page:not(.studio-tracked-page) { display: none; }
.studio-doc-body.tracked-review .studio-tracked-page { display: block; }
/* While the tracked document is showing it IS the document, in every mode.
   Split's source pane would otherwise offer an editable copy of a body the
   user is explicitly not allowed to edit yet. */
.studio-doc-body.tracked-review .studio-source-pane { display: none; }
.studio-doc-body.tracked-review .studio-doc-scroll { display: block; flex-basis: 100%; }

.studio-tc { border-radius: 2px; padding: 0 1px; }
.studio-tc-del {
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
  color: var(--studio-del);
  background: color-mix(in srgb, var(--studio-del) 9%, transparent);
}
.studio-tc-ins {
  text-decoration: underline;
  text-decoration-thickness: 1.5px;
  text-underline-offset: 2px;
  color: var(--studio-ins);
  background: color-mix(in srgb, var(--studio-ins) 12%, transparent);
}
/* A mark whose whole content is a space has no glyph to strike through, and
   deleting a stray space is the single most common edit an assistant makes to
   prose — so the tint has to be what makes it visible, and the space has to
   survive HTML collapsing to have a width to tint. pre-wrap, not inline-block:
   a multi-word deletion still has to break across lines like the text it is
   part of. */
.studio-tc { white-space: pre-wrap; }
/* Deliberately still --studio-accent/--studio-danger, NOT --studio-ins/-del:
   a settled mark has already been decided, so its tint reports the VERDICT
   (accepted vs rejected), not what kind of edit it was. A settled deletion
   that was accepted must not look red just because deletions are red while
   they are still live. */
.studio-tc-settled { background: color-mix(in srgb, var(--studio-accent) 7%, transparent); }
.studio-tc-settled.rejected { background: color-mix(in srgb, var(--studio-danger) 6%, transparent); opacity: .75; }
.studio-tc.current, .studio-tc[data-current="true"] {
  box-shadow: 0 0 0 3px var(--studio-focus); border-radius: 3px;
}

/* -- the cards beside it -- */
.studio-change-card {
  border: 1px solid var(--studio-line); border-radius: 10px; background: var(--studio-surface);
  padding: 9px 10px 10px; margin-bottom: 8px; cursor: pointer;
}
.studio-change-card:hover { border-color: color-mix(in srgb, var(--studio-accent) 40%, var(--studio-line)); }
.studio-change-card.current {
  border-color: var(--studio-accent); box-shadow: 0 0 0 3px var(--studio-focus);
}
.studio-change-card.decided { opacity: .62; }
/* accent/danger here too, same reason as .studio-tc-settled above: a card's
   border reports what the REVIEWER decided, not whether the underlying edit
   was an insertion or a deletion. */
.studio-change-card.decided.accepted { border-color: color-mix(in srgb, var(--studio-accent) 55%, var(--studio-line)); }
.studio-change-card.decided.rejected { border-color: color-mix(in srgb, var(--studio-danger) 45%, var(--studio-line)); }
.studio-change-head { display: flex; align-items: center; gap: 8px; }
.studio-change-who { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.studio-change-who b { font-size: 12px; font-weight: 620; }
.studio-change-who time { font-size: 10.5px; color: var(--studio-muted); font-variant-numeric: tabular-nums; }
.studio-change-spacer { flex: 1; }
.studio-change-verdict { font-size: 11px; font-weight: 650; color: var(--studio-muted); }
.studio-change-card.accepted .studio-change-verdict { color: var(--studio-accent); }
.studio-change-card.rejected .studio-change-verdict { color: var(--studio-danger); }
.studio-change-action { margin: 9px 0 3px; font-size: 12.5px; font-weight: 640; }
.studio-change-detail { font-size: 12px; line-height: 1.55; color: var(--studio-muted); }
.studio-change-quote { font-style: italic; quotes: "\\201C" "\\201D"; color: var(--studio-text); }

/* -- telling authors apart, by line style (see AUTHOR_SLOTS) -- */
.studio-tc[data-slot="1"] { text-decoration-style: dashed; }
.studio-tc[data-slot="2"] { text-decoration-style: dotted; }
.studio-tc[data-slot="3"] { text-decoration-style: double; }
/* The card echoes its author's line style on one edge, so a reader can pair a
   card with a mark without clicking either. Left edge rather than a full border:
   the border already carries decided/current state and cannot carry both. */
.studio-change-card { border-left-width: 3px; }
.studio-change-card[data-slot="0"] { border-left-color: var(--studio-accent); }
.studio-change-card[data-slot="1"] { border-left-style: dashed; border-left-color: var(--studio-accent); }
.studio-change-card[data-slot="2"] { border-left-style: dotted; border-left-color: var(--studio-accent); }
.studio-change-card[data-slot="3"] { border-left-style: double; border-left-color: var(--studio-accent); }

/* -- a suggestion answering another suggestion -- */
.studio-change-card.reply { margin-left: 14px; }
.studio-change-reply-to {
  font-size: 10.5px; color: var(--studio-muted); margin: -1px 0 7px;
  display: flex; align-items: center; gap: 5px;
}
.studio-change-reply-to::before {
  content: ""; width: 9px; height: 7px; flex: none;
  border-left: 1px solid var(--studio-line); border-bottom: 1px solid var(--studio-line);
  border-bottom-left-radius: 3px; margin-bottom: 3px;
}

/* -- a suggestion that cannot be drawn in place right now -- */
.studio-change-card.overlapped { opacity: .74; }
.studio-change-note {
  margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--studio-line);
  font-size: 11px; line-height: 1.5; color: var(--studio-muted);
}
.studio-change-card.mine { background: color-mix(in srgb, var(--studio-accent) 4%, var(--studio-surface)); }

/* -- the empty state, and the mode's own banner -- */
.studio-suggesting-note {
  font-size: 11.5px; line-height: 1.5; color: var(--studio-muted);
  padding: 8px 10px; margin-bottom: 10px; border-radius: 8px;
  background: var(--studio-surface-raised); border: 1px solid var(--studio-line);
}
`;

module.exports = {
    trackedHtml, trackedMarkdown, suggestedMarkdown, substituteMarks, orderEntries,
    changeCardHtml, changeSummary, changeSummaryText, changeStamp, TRACKED_CSS, AUTHOR_SLOTS
};
