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
 */

const { Extension } = require('@tiptap/core');
const { Plugin, PluginKey } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');
const { diffWords } = require('./diff');

const suggestMarksKey = new PluginKey('studio-suggest-marks');

/**
 * The document as one string, with a map back to positions.
 *
 * Top-level blocks are joined with a newline so a paragraph boundary is a real
 * boundary in the text — without it, the last word of one paragraph and the
 * first of the next tokenise as one word and a diff reports an edit that nobody
 * made.
 *
 * `spans` is the map: each entry says where a text node's content starts in the
 * string and where it starts in the document. Positions inside a node at
 * document offset `offset` are `offset + 1 + relative`, which holds at any depth
 * because ProseMirror positions are linear.
 */
function collect(doc) {
    let text = '';
    const spans = [];
    doc.forEach((block, offset) => {
        if (text.length) { text += '\n'; }
        const base = offset + 1;
        if (block.isText) {
            spans.push({ start: text.length, from: offset, length: block.text.length });
            text += block.text;
            return;
        }
        block.descendants((node, pos) => {
            if (node.isText) {
                spans.push({ start: text.length, from: base + pos, length: node.text.length });
                text += node.text;
                return false;
            }
            return true;
        });
    });
    return { text, spans };
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

/** The document position a string offset sits at, for a zero-width widget. */
function toDocPos(spans, offset, fallback) {
    for (const span of spans) {
        if (offset >= span.start && offset <= span.start + span.length) {
            return span.from + (offset - span.start);
        }
    }
    return fallback;
}

function deletionWidget(text) {
    return () => {
        const node = document.createElement('del');
        node.className = 'studio-tc studio-tc-del studio-tc-live';
        /* The text, not a marker. A reader has to be able to see WHAT was
         * removed, which is the whole difference between a tracked change and a
         * note that something happened here. */
        node.textContent = text;
        node.setAttribute('aria-label', 'Deleted: ' + text);
        return node;
    };
}

/**
 * Marks for the difference between `baseText` and the live document.
 *
 * Word-level, not character-level: diff.js's tokeniser is what the review
 * surface already uses, so a change looks the same while you write it as it will
 * when somebody reads it. A character diff would mark "chang|ed" mid-word while
 * you type, which is noise rather than information.
 */
function buildDecorations(doc, baseText) {
    const { text, spans } = collect(doc);
    if (text === baseText) { return DecorationSet.empty; }

    /*
     * A guard against a bad baseline, not against a big edit.
     *
     * The derived baseline (see the widget's suggestBaseline) assumes the
     * renderer's top-level blocks map one-to-one onto ProseMirror's. If that ever
     * fails, the diff is not "a lot changed" but "everything changed", and the
     * failure mode without this check is the whole document painted as an
     * insertion — which looks like data loss and hides whatever the real edit
     * was. Above this ratio the marks say nothing useful either way, so showing
     * none is both safer and no less informative.
     */
    const parts = diffWords(baseText, text);
    const changed = parts.filter(p => p.type !== '=').reduce((sum, p) => sum + p.text.length, 0);
    if (changed > Math.max(baseText.length, text.length, 1) * 0.85) { return DecorationSet.empty; }

    const decorations = [];
    let offset = 0;                       // where we are in the NEW text
    for (const part of parts) {
        if (part.type === '=') { offset += part.text.length; continue; }
        if (part.type === '+') {
            for (const range of toDocRanges(spans, offset, offset + part.text.length)) {
                decorations.push(Decoration.inline(range.from, range.to, {
                    class: 'studio-tc studio-tc-ins studio-tc-live'
                }));
            }
            offset += part.text.length;
            continue;
        }
        /* A removal consumes nothing of the new text, so the offset does not
         * move — the widget sits where the removed text used to begin. side: -1
         * keeps it before any insertion at the same position, so a replacement
         * reads old-then-new, the order the review cards state it in. */
        const at = toDocPos(spans, offset, 1);
        decorations.push(Decoration.widget(at, deletionWidget(part.text), {
            side: -1, marks: [], ignoreSelection: true
        }));
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
function suggestMarksExtension(getBaseText) {
    return Extension.create({
        name: 'studioSuggestMarks',
        addProseMirrorPlugins() {
            return [new Plugin({
                key: suggestMarksKey,
                state: {
                    init(_, state) {
                        const base = getBaseText();
                        return base === undefined ? DecorationSet.empty : buildDecorations(state.doc, base);
                    },
                    apply(tr, value, oldState, newState) {
                        const base = getBaseText();
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
                        return buildDecorations(newState.doc, base);
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
/* A widget is not part of the document, so it must not read as somewhere the
   caret can go: no pointer cursor, no text selection, and unselectable. */
.studio-tc-del.studio-tc-live {
  user-select: none; -webkit-user-select: none; cursor: default; opacity: .85;
}
/* Live insertions carry no background, unlike the review renderer's.
   A tint under text you are actively typing into follows the caret around and
   reads as a selection; the underline alone is enough while you can see your own
   cursor, and the review surface adds the tint back for the reader who cannot. */
.ProseMirror .studio-tc-ins.studio-tc-live { background: none; }
`;

module.exports = { suggestMarksExtension, refreshSuggestMarks, SUGGEST_MARKS_CSS, collect, buildDecorations };
