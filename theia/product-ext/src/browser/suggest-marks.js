/*
 * Live tracked marks while you are the one typing.
 *
 * THE PROBLEM THIS SOLVES
 *
 * tracked-changes.js renders a document with somebody's change marked in place,
 * and it does that by marking the MARKDOWN SOURCE and rendering it to static
 * HTML. That is the right mechanism for reviewing a change, and it is useless
 * for making one: the result is not editable, and while you are suggesting you
 * need a live caret.
 *
 * So Suggesting mode showed your text plainly, with the marks only appearing
 * once you left the mode and somebody reviewed it. Reported as the obvious gap:
 * "when i do suggestions i want to see highlights of deleted and added ... when
 * i'm in suggestion mode." Google Docs shows both, and it is right to.
 *
 * WHY DECORATIONS, AND WHY THEY AVOID THE MAPPING PROBLEM
 *
 * The reason the review renderer works in the source rather than the DOM is that
 * a Markdown position cannot be mapped to a ProseMirror position — one source
 * line can become zero, one, or several nodes, and this product has no such map.
 *
 * This module never needs one. It compares TWO PROSEMIRROR STATES of the same
 * document, both reduced to plain text by the same function, so the offsets on
 * both sides come from one coordinate system and the map back to document
 * positions is built by the same walk that produced the text. No Markdown is
 * involved, which is also why formatting is transparent to it: a word that is
 * bold in one version and plain in the other is the same word here, and does not
 * show up as an edit.
 *
 * Decorations are a VIEW-LAYER overlay. Nothing is added to the document, so
 * what is serialised to Markdown, what is written as your suggestion, and what
 * an undo step contains are all exactly as they were before this file existed.
 * That was the deciding property: a suggestion mark that lived in the document
 * model would have to be excluded from every serialisation path, and one missed
 * path would write review furniture into somebody's file.
 *
 * THE ASYMMETRY BETWEEN INSERTED AND DELETED TEXT
 *
 * Inserted text is IN the document, so it takes an inline decoration over the
 * range it occupies. Deleted text is not — that is what deleted means — so it
 * cannot be decorated at all and is drawn as a WIDGET: a struck-through span
 * held at the position the text used to occupy, belonging to the view and not to
 * the document. Widgets are not editable and not selectable by the caret, which
 * is exactly right: you cannot put your cursor inside text that is no longer
 * there.
 *
 * WHAT "REDUCED TO PLAIN TEXT" HAS TO MEAN
 *
 * The reduction above is not a detail — it decides what a "word boundary"
 * even is. The first version of this file put a boundary only between
 * TOP-LEVEL blocks, which is a paragraph and a heading and very little else:
 * a table is one top-level block, so every cell's text ran into the next
 * with nothing between them, and a diff cannot tell where a word ends and a
 * whole table's remaining text begins. Deleting one letter from a table
 * header struck through the entire table as one token. `collect()` now puts
 * a boundary at every block-level node boundary at ANY depth (`walkBlock`),
 * not a hardcoded list of container names, and treats the top-level
 * boundary as structurally distinct from every nested one — see
 * `buildDecorations`, which aligns blocks BEFORE it diffs their text, for
 * why that distinction has to survive all the way to a plain string.
 */

const { Extension } = require('@tiptap/core');
const { Plugin, PluginKey } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');
const { diffWords, diffSequences } = require('./diff');

const suggestMarksKey = new PluginKey('studio-suggest-marks');

/**
 * Is `node` a CONTAINER — something whose own children are further blocks,
 * rather than something that holds inline content directly?
 *
 * This used to be answered with a name list: table, tableRow, tableCell,
 * bulletList, listItem, blockquote. That list is exactly how the table defect
 * happened in the first place — `collect()` walked every text node it could
 * find with `descendants()` and never noticed it needed a boundary AT ALL
 * inside a table, because "table" was never in any list of things that get
 * special handling. `isTextblock` is PM's own answer to "does this hold
 * inline content" (paragraph, heading, a code block all say yes); anything
 * block-shaped that says no holds more blocks instead — or, for a leaf like a
 * horizontal rule, nothing at all, which this function is content to treat as
 * an empty container. A node type this file has never heard of falls into the
 * right bucket automatically, which a name list cannot do.
 */
function isContainer(node) {
    return node.isBlock && !node.isTextblock;
}

/**
 * Append one TEXTBLOCK's own text (a paragraph, a heading, a code block — any
 * leaf that holds inline content, never a container) onto `state.text`.
 * `base` is the document position immediately inside the block, i.e. one past
 * its own opening token, matching the `base + pos` arithmetic the file header
 * describes.
 */
function collectTextblock(block, base, state) {
    block.descendants((node, pos) => {
        if (node.isText) {
            state.spans.push({ start: state.text.length, from: base + pos, length: node.text.length });
            state.text += node.text;
            return false;
        }
        /*
         * A hard break carries no text of its own, so leaving it out of
         * `text` glues the word before it to the word after ("a" + "rail"
         * -> "arail") and diffWords reports a word-change nobody made.
         * Treating it as a one-character text node keeps it a real word
         * boundary and keeps it addressable by toDocRanges/toDocPos, the
         * same as any other span.
         */
        if (node.type.name === 'hardBreak') {
            state.spans.push({ start: state.text.length, from: base + pos, length: 1 });
            state.text += '\n';
            return false;
        }
        return true;
    });
    /*
     * Trailing whitespace at the end of a block is not content, and the
     * serialiser trims it (see md-serialize.js) rather than escaping it
     * into a &#x20; entity. So a trailing space must not be a MARK either:
     * without this, typing one at the end of a paragraph draws a struck
     * line break and an inserted space for an edit that will never reach
     * the file — the exact residual mark this whole fix set exists to
     * remove. The last span shrinks with the text so every offset the
     * decorations are placed at still addresses a real character.
     *
     * This used to run once per TOP-LEVEL block. It now runs once per
     * TEXTBLOCK at any depth — once per table cell's own paragraph, once per
     * list item's own paragraph — which is the granularity the trim actually
     * needs: a trailing space inside a cell is exactly as invisible to the
     * serialiser as one at the end of the document.
     */
    const trimmed = state.text.replace(/[ \t]+$/, '');
    if (trimmed.length !== state.text.length && state.spans.length) {
        const last = state.spans[state.spans.length - 1];
        last.length = Math.max(0, Math.min(last.length, trimmed.length - last.start));
        state.text = trimmed;
    }
}

/**
 * Append one BLOCK — leaf or container, at any depth — onto `state.text`,
 * separating a container's direct children with `sep`.
 *
 * `sep` is the file's whole answer to defect 2 (a table's cells running
 * together with no boundary at all): a container's children are never
 * concatenated raw. The top-level call in `collect()` below passes `'\n\n'`
 * for doc's own children and this function always recurses with `'\n'` —
 * so a paragraph boundary is two characters and a table-cell or list-item
 * boundary is one, and `'\n\n'` therefore appears in this string ONLY
 * between top-level blocks. `buildDecorations` relies on that: it recovers
 * a BASELINE's top-level blocks (which by then is only a string, not a
 * document) by splitting on `'\n\n'`, and that split is only trustworthy
 * because nothing nested ever emits the same two characters — except the
 * literal content of a code block, which is real text this file does not
 * touch, and an empty nested block sitting between two single separators
 * (two `'\n'` with nothing between them reads exactly like one `'\n\n'`).
 * Both are named, not hidden, at the point that split happens.
 *
 * Both separator characters are `\s+` under diff.js's tokeniser, so either
 * one is a real word boundary — gluing never happens — without being
 * mistaken for content.
 */
function walkBlock(node, base, state, sep) {
    const before = state.text.length;
    if (node.isTextblock) {
        collectTextblock(node, base, state);
    } else if (isContainer(node)) {
        let first = true;
        node.forEach((child, offset) => {
            if (!first) { state.text += sep; }
            first = false;
            walkBlock(child, base + offset + 1, state, '\n');
        });
    }
    /*
     * This block contributed no characters at all — an empty paragraph, an
     * empty table cell, an empty list item, a horizontal rule. Without an
     * entry here, the gap it leaves in `spans` is indistinguishable from the
     * separator on either side of it, and `toDocPos` has nothing that
     * STARTS at this offset to prefer over whatever merely ENDS there — which
     * is the previous block. That is defect 3 exactly: clearing a table cell
     * left its deletion widget in the column before it, because the empty
     * cell had no span of its own to be found at. A zero-length span here
     * gives that offset a place to start; `toDocRanges`'s `to > from` guard
     * means a zero-length span never becomes a visible range, so this is
     * inert everywhere except the tie-break in `toDocPos`.
     */
    if (state.text.length === before) {
        state.spans.push({ start: before, from: base, length: 0 });
    }
}

/**
 * The document as one string, with a map back to positions, and the offsets
 * of its own top-level blocks.
 *
 * `blocks` is what lets `buildDecorations` align the NEW document's top-level
 * blocks against the baseline's without re-deriving them from the string —
 * `collect()` already walked the real document and knows exactly where each
 * one starts and ends, which is strictly more trustworthy than re-splitting
 * text that a code block's own content could fool (see `walkBlock`'s
 * comment).
 *
 * `spans` is the map: each entry says where a span of text starts in the
 * string and where it starts in the document. Positions inside a node at
 * document offset `offset` are `offset + 1 + relative`, which holds at any
 * depth because ProseMirror positions are linear.
 */
function collect(doc) {
    const state = { text: '', spans: [] };
    const blocks = [];
    let first = true;
    doc.forEach((block, offset) => {
        if (!first) { state.text += '\n\n'; }
        first = false;
        // Captured AFTER the separator, not before: this block's own range
        // must not include the '\n\n' that precedes it, or the slice
        // buildDecorations takes for it is glued to a boundary that belongs
        // to no block at all, and two otherwise-identical blocks compare as
        // different because one of them is carrying its neighbour's fence.
        const start = state.text.length;
        if (block.isText) {
            // Defensive parity with the walk below: a schema that allowed
            // text straight into doc would still be extracted, not silently
            // dropped.
            state.spans.push({ start: state.text.length, from: offset, length: block.text.length });
            state.text += block.text;
        } else {
            walkBlock(block, offset + 1, state, '\n');
        }
        blocks.push({ start, end: state.text.length });
    });
    return { text: state.text, spans: state.spans, blocks };
}

/**
 * String range -> document ranges.
 *
 * More than one, because a range can cross text nodes: "**very** important" is
 * two nodes, and a decoration over both has to be two decorations. Returning a
 * list rather than one span is what keeps the marks correct over formatted text
 * instead of silently covering the wrong characters.
 */
function toDocRanges(spans, start, end) {
    const ranges = [];
    for (const span of spans) {
        const spanEnd = span.start + span.length;
        if (spanEnd <= start || span.start >= end) { continue; }
        const from = span.from + Math.max(0, start - span.start);
        const to = span.from + Math.min(span.length, end - span.start);
        if (to > from) { ranges.push({ from, to }); }
    }
    return ranges;
}

/**
 * The document position a string offset sits at, for a zero-width widget.
 *
 * Both ends of a span are valid landing points for an offset that sits at an
 * exact boundary — the position where one span ends is the same number as the
 * position where the next one begins. Returning on the FIRST match therefore
 * used to pick whichever span happened to come first in `spans` (document
 * order), which is the span that ENDS at the boundary, never the one that
 * STARTS there — so a deletion at the very beginning of a block attached
 * itself to the end of whatever came before it. That is the "cleared cell
 * shows its deletion in the previous column" screenshot: the cell's own
 * (possibly zero-length, see `walkBlock`) span starts exactly where the
 * previous cell's span ends, and the old code found the previous cell first
 * simply because it was earlier in the array.
 *
 * A span that STARTS at `offset` is preferred unconditionally; a span that
 * only ENDS there is remembered but not returned until the whole array has
 * been searched and no start-match turned up, which is the correct answer
 * exactly once — a position at the very end of the document, where nothing
 * after it starts.
 */
function toDocPos(spans, offset, fallback) {
    let endMatch;
    for (const span of spans) {
        if (offset === span.start) { return span.from; }
        if (offset > span.start && offset < span.start + span.length) {
            return span.from + (offset - span.start);
        }
        if (endMatch === undefined && offset === span.start + span.length) {
            endMatch = span.from + (offset - span.start);
        }
    }
    return endMatch !== undefined ? endMatch : fallback;
}

/*
 * WHICH HALF OF A DIFF IS "ADDED" DEPENDS ON WHICH WAY THE BASELINE POINTS.
 *
 * The geometry never changes: text that IS in the live document can carry an
 * inline decoration over the real characters, and text that is NOT in it has
 * nowhere to live but a widget. What changes is the MEANING of each half.
 *
 * While I am suggesting, the baseline is the document as it stood before I
 * started, so text present in the document and absent from the baseline is
 * something I added -- inline is an insertion, the widget is a deletion.
 *
 * While I am editing with somebody else's open suggestions on the document,
 * the baseline is the document WITH those suggestions applied, and the
 * polarity inverts: text present in the document and absent from that
 * baseline is what the suggestion proposes to REMOVE, and the text the
 * suggestion proposes to ADD is exactly the text that is not in the document
 * yet. Same diff, same alignment, same widgets -- the two class names and the
 * label swap places, and nothing else about this file has to know.
 */
const FORWARD = { inline: 'ins', widget: 'del', widgetLabel: 'Deleted: ' };
const INVERTED = { inline: 'del', widget: 'ins', widgetLabel: 'Suggested: ' };

function absentWidget(text, roles) {
    return () => {
        const node = document.createElement(roles.widget === 'del' ? 'del' : 'ins');
        node.className = 'studio-tc studio-tc-' + roles.widget + ' studio-tc-live';
        /* The text, not a marker. A reader has to be able to see WHAT was
         * removed, which is the whole difference between a tracked change and a
         * note that something happened here. */
        node.textContent = text;
        node.setAttribute('aria-label', roles.widgetLabel + text);
        return node;
    };
}

/*
 * Word-level decorations for one pair of block texts that `diffSequences`
 * has already decided correspond to each other (an aligned "=" pair whose
 * text still differs, or a "-"/"+" run paired positionally — see
 * `buildDecorations`). `blockStart` is where NEW_TEXT begins in the full
 * flattened string, so a part's offset within this one block can be turned
 * into an absolute offset the shared `spans` array actually addresses.
 *
 * The 0.85 "everything changed" guard lives HERE, not once for the whole
 * document, which is defect 3's other half: before block alignment, a single
 * rewritten paragraph could push the document-wide changed ratio over the
 * guard and blank marks on text nobody touched, or (below the guard) flood
 * the whole document because the un-aligned diff could not tell a structural
 * insert from a rewrite. Per-pair, the guard does what it was always meant to
 * do — suppress marks on a paragraph so unrecognisable that highlighting it
 * would say nothing — without that verdict leaking onto its neighbours.
 */
function decorateChangedBlock(oldBlockText, newBlockText, blockStart, spans, endOfDoc, decorations, roles) {
    if (oldBlockText === newBlockText) { return; }
    const parts = diffWords(oldBlockText, newBlockText);
    const changed = parts.filter(p => p.type !== '=').reduce((sum, p) => sum + p.text.length, 0);
    if (changed > Math.max(oldBlockText.length, newBlockText.length, 1) * 0.85) { return; }

    let offset = blockStart;              // where we are in the NEW text, absolute
    for (const part of parts) {
        if (part.type === '=') { offset += part.text.length; continue; }
        if (part.type === '+') {
            for (const range of toDocRanges(spans, offset, offset + part.text.length)) {
                decorations.push(Decoration.inline(range.from, range.to, {
                    class: 'studio-tc studio-tc-' + roles.inline + ' studio-tc-live'
                }));
            }
            offset += part.text.length;
            continue;
        }
        /* A removal consumes nothing of the new text, so the offset does not
         * move — the widget sits where the removed text used to begin. side: -1
         * keeps it before any insertion at the same position, so a replacement
         * reads old-then-new, the order the review cards state it in. */
        const at = toDocPos(spans, offset, endOfDoc);
        decorations.push(Decoration.widget(at, absentWidget(part.text, roles), {
            side: -1, marks: [], ignoreSelection: true
        }));
    }
}

/** A whole block exists only in the document: mark every real span inside it. */
function decoratePresentBlock(block, spans, decorations, roles) {
    for (const range of toDocRanges(spans, block.start, block.end)) {
        decorations.push(Decoration.inline(range.from, range.to, {
            class: 'studio-tc studio-tc-' + roles.inline + ' studio-tc-live'
        }));
    }
}

/** A whole block exists only in the baseline: one widget, anchored where the caller says. */
function decorateAbsentBlock(baseBlockText, at, decorations, roles) {
    decorations.push(Decoration.widget(at, absentWidget(baseBlockText, roles), {
        side: -1, marks: [], ignoreSelection: true
    }));
}

/**
 * Marks for the difference between `baseText` and the live document.
 *
 * STRUCTURE FIRST, TEXT SECOND. A flat word diff cannot express "a paragraph
 * was inserted" or "a row was added" — those are structural edits, and a diff
 * that only sees text reports them as one enormous replace covering
 * everything from the change to the end of the document. That was defect 3:
 * either the 0.85 guard fired on that enormous replace and showed nothing, or
 * it did not and every paragraph after the edit lit up as changed.
 *
 * So this aligns BLOCKS before it aligns words, the way every system in the
 * architecture review does it (OOXML, Google Docs, prosemirror-changeset —
 * none of them diff two documents as flat text first): split the new
 * document into its real top-level blocks (`collect()` already knows the
 * offsets, see its comment on why those are trusted over re-splitting a
 * string), recover the baseline's blocks by splitting on the `'\n\n'`
 * `collect()` promises appears nowhere else, and align the two arrays with
 * `diffSequences` — the SAME LCS `diffHunks` and `md-rewrap.js` use, not a
 * second alignment implementation to drift from theirs. An aligned "="
 * block whose text is byte-identical gets no decorations at all; everything
 * else is one of: a changed pair (word-diff within just that block), a pure
 * insertion (one new block, mark it whole), or a pure deletion (one old
 * block, one widget for it).
 */
function buildDecorations(doc, baseText, invert) {
    const roles = invert ? INVERTED : FORWARD;
    const { text, spans, blocks } = collect(doc);
    if (text === baseText) { return DecorationSet.empty; }

    const newBlockTexts = blocks.map(b => text.slice(b.start, b.end));
    const oldBlockTexts = baseText.split('\n\n');
    const ops = diffSequences(oldBlockTexts, newBlockTexts);

    const decorations = [];
    const endOfDoc = doc.content.size;
    // Position, in `blocks`, of the next NEW block not yet accounted for.
    let newIndex = 0;
    const anchorAt = (idx) => idx < blocks.length
        ? toDocPos(spans, blocks[idx].start, endOfDoc)
        : endOfDoc;

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (op.op === '=') { newIndex += op.b.length; continue; }

        /*
         * A "-" run immediately followed by a "+" run is not "these blocks
         * vanished, unrelated ones appeared" — `diffSequences` only produces
         * adjacent -/+ like this when nothing in one run matched anything in
         * the other at the BLOCK level, which is exactly what an edited
         * paragraph looks like (its new text is not equal to its old text, so
         * it cannot land in an "=" run). Pairing them positionally — the same
         * move `pairLines` and `md-rewrap.js`'s `preserveWrapping` make for
         * the identical shape of problem — recovers "this block became that
         * block" for a word-level diff; only a genuine mismatch in COUNT
         * (blocks merged, or split, or a real insert/delete alongside an
         * edit) falls through to plain insertion/deletion handling.
         */
        if (op.op === '-' && ops[i + 1] && ops[i + 1].op === '+') {
            const removed = op.a, added = ops[i + 1].b;
            const paired = Math.min(removed.length, added.length);
            for (let k = 0; k < paired; k++) {
                decorateChangedBlock(removed[k], added[k], blocks[newIndex + k].start, spans, endOfDoc, decorations, roles);
            }
            const anchor = anchorAt(newIndex + paired);
            for (let k = paired; k < removed.length; k++) { decorateAbsentBlock(removed[k], anchor, decorations, roles); }
            for (let k = paired; k < added.length; k++) { decoratePresentBlock(blocks[newIndex + k], spans, decorations, roles); }
            newIndex += added.length;
            i++; // the "+" run was consumed together with this "-" run
            continue;
        }

        if (op.op === '-') {
            const anchor = anchorAt(newIndex);
            for (const removedText of op.a) { decorateAbsentBlock(removedText, anchor, decorations, roles); }
            continue; // no new blocks consumed
        }

        // A "+" run with no paired "-" before it: pure insertion.
        for (let k = 0; k < op.b.length; k++) { decoratePresentBlock(blocks[newIndex + k], spans, decorations, roles); }
        newIndex += op.b.length;
    }

    return DecorationSet.create(doc, decorations);
}

/**
 * The extension.
 *
 * `getBaseText` is a callback rather than a value so the widget owns when the
 * baseline moves — it returns the document's text while Suggesting is on, and
 * undefined otherwise, which is also how the marks are turned off. Reading it
 * per transaction rather than caching is deliberate: the baseline changes when a
 * suggestion is accepted, when the mode is left, and when the file is reloaded
 * from disk, and none of those are events this plugin should have to know about.
 */
/*
 * `getBaseText` may return a bare string (the ordinary Suggesting baseline) or
 * `{ text, invert }` for the inverted polarity described at FORWARD/INVERTED
 * above. Normalising here rather than at every call site keeps the widget free
 * to hand back whichever it has.
 */
function readBase(getBaseText) {
    const base = getBaseText();
    if (base === undefined || base === null) { return undefined; }
    if (typeof base === 'string') { return { text: base, invert: false }; }
    return typeof base.text === 'string' ? { text: base.text, invert: !!base.invert } : undefined;
}

function suggestMarksExtension(getBaseText) {
    return Extension.create({
        name: 'studioSuggestMarks',
        addProseMirrorPlugins() {
            return [new Plugin({
                key: suggestMarksKey,
                state: {
                    init(_, state) {
                        const base = readBase(getBaseText);
                        return base === undefined ? DecorationSet.empty : buildDecorations(state.doc, base.text, base.invert);
                    },
                    apply(tr, value, oldState, newState) {
                        const base = readBase(getBaseText);
                        if (base === undefined) { return DecorationSet.empty; }
                        /*
                         * Recomputed only when the document actually changed, or
                         * when the baseline moved under us. A selection-only
                         * transaction — every arrow key — must not rebuild a
                         * decoration set, and mapping the old set through the
                         * step is not enough here: an edit changes the DIFF, not
                         * just the positions of the previous one.
                         */
                        if (!tr.docChanged && value !== DecorationSet.empty) {
                            const meta = tr.getMeta(suggestMarksKey);
                            if (!meta) { return value; }
                        }
                        return buildDecorations(newState.doc, base.text, base.invert);
                    }
                },
                props: {
                    decorations(state) { return suggestMarksKey.getState(state); }
                }
            })];
        }
    });
}

/**
 * Ask for a rebuild without editing the document.
 *
 * Needed because entering Suggesting mode changes nothing about the document —
 * only the baseline — so there is no transaction for the plugin to notice.
 */
function refreshSuggestMarks(editor) {
    if (!editor || !editor.view) { return; }
    const tr = editor.view.state.tr;
    tr.setMeta(suggestMarksKey, 'refresh');
    tr.setMeta('addToHistory', false);
    /* Marked as ours so onDocChanged ignores it: the widget treats an
     * unrecognised transaction as a user edit and would save the file. */
    tr.setMeta('studio-internal', true);
    editor.view.dispatch(tr);
}

const SUGGEST_MARKS_CSS = `
/*
 * The live marks reuse .studio-tc-ins / .studio-tc-del from tracked-changes.js
 * verbatim, so a change looks identical while you write it and after somebody
 * opens it for review. Only what the editing surface needs is added here.
 */
.studio-tc-live { border-radius: 2px; }
/*
 * SELECTED BY ELEMENT, NOT BY KIND. A widget is text that is not in the
 * document, so it must not read as somewhere the caret can go: no pointer
 * cursor, no selection. An inline decoration is the opposite -- real, editable
 * document characters with a class on them -- and it must stay fully
 * selectable.
 *
 * Which of the two carries -del and which carries -ins depends on the
 * baseline's polarity (see FORWARD/INVERTED above): while I am editing over
 * somebody else's suggestion, the struck-through text is real document text I
 * can still select and retype, and the GREEN text is the widget. So these
 * rules key on the tag ProseMirror actually renders -- a widget decoration
 * builds the <del>/<ins> element in absentWidget, an inline decoration wraps
 * document text in a <span> -- and never on the -ins/-del class.
 */
.ProseMirror del.studio-tc-live, .ProseMirror ins.studio-tc-live {
  user-select: none; -webkit-user-select: none; cursor: default; opacity: .85;
}
/* Live inline marks carry no background, unlike the review renderer's.
   A tint under text you are actively typing into follows the caret around and
   reads as a selection; the underline alone is enough while you can see your own
   cursor, and the review surface adds the tint back for the reader who cannot.
   Widgets keep their tint: nobody is typing into one. */
.ProseMirror span.studio-tc-live { background: none; }
`;

module.exports = { suggestMarksExtension, refreshSuggestMarks, SUGGEST_MARKS_CSS, collect, buildDecorations };
