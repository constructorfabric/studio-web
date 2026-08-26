/*
 * Quality findings, in the text.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE RAIL. A finding you cannot see in the
 * document is a to-do list about a file, not a signal in it — so the rail and
 * the text are two halves of one feature and neither is optional. But they fail
 * differently: a rail that renders wrongly is ugly, and a decoration that
 * renders wrongly tells a reviewer the wrong nine lines of prose are in the
 * wrong voice. Keeping the decoration pass in its own module with its own
 * treatment rules is what makes that half reviewable on its own.
 *
 * WHY DECORATIONS AND NOT MARKS. suggest-marks.js already argues this at length
 * and the argument is the same one: a decoration is a VIEW-LAYER overlay, so
 * nothing enters the document model, nothing reaches the Markdown serialiser,
 * and nothing lands in an undo step. A quality mark that lived in the document
 * would have to be excluded from every serialisation path, and one missed path
 * writes review furniture into somebody's file.
 *
 * It also matters that this half is disposable. Findings are re-derived by every
 * check; the marks must appear, move and vanish without any of it being an edit.
 *
 * THE TWO TREATMENTS, AND WHY NEITHER IS A FILL
 *
 * A duplicate span takes an UNDERLINE — solid when the match was lexical, dotted
 * when a model made it. Deliberately not a background tint: comment marks
 * already own fill in this editor, and a fourth inline colour in a document that
 * may simultaneously carry comments, tracked changes and live suggestion marks
 * is where the editing surface stops being readable. The solid/dotted split is
 * doing real work rather than decorating — 55% of the real clusters were matched
 * by a model rather than by comparison, and trust in the two genuinely differs,
 * so it has to be legible without opening a card.
 *
 * A purpose violation is a SECTION, not a phrase, and it takes a left edge rule
 * across the section's blocks plus a chip on its heading. Tinting nine lines of
 * prose as if they were a phrase misreads the unit — the claim is about the
 * section, and the decoration has to be about the section too.
 *
 * WHERE THE RANGES COME FROM. Not from here. quality-anchor.js resolves an
 * anchor to a range by quote-and-occurrence, exactly as reanchorThreads() has
 * always done for comments, and the widget hands the result in through a
 * callback. This module knows nothing about findings, files or fingerprints
 * beyond the identifier it puts on a node so a click can be routed back.
 */

const { Extension } = require('@tiptap/core');
const { Plugin, PluginKey } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');

const qualityMarksKey = new PluginKey('studio-quality-marks');

/*
 * One range to decorate.
 *
 *   { from, to, kind: 'span' | 'section', provenance, trust, fingerprint,
 *     active, stale, label }
 *
 * `active` is the card-is-current state, and it is why this plugin rebuilds on a
 * refresh rather than only on a document change: selecting a card in the rail
 * changes nothing about the document and everything about which mark is lit.
 */

function spanDecoration(range) {
    /*
     * `data-quality` carries the fingerprint so the click handler in
     * markdown-editor.js can route from a mark back to its card without this
     * module knowing what a card is — the same shape the comment mark and the
     * tracked-change mark already use, so one delegated listener handles all
     * three.
     */
    const classes = ['studio-quality-span'];
    classes.push(range.provenance === 'semantic' ? 'studio-quality-semantic' : 'studio-quality-lexical');
    if (range.active) { classes.push('studio-quality-on'); }
    if (range.stale) { classes.push('studio-quality-stale'); }
    return Decoration.inline(range.from, range.to, {
        class: classes.join(' '),
        'data-quality': range.fingerprint || ''
    });
}

/*
 * A section's rule is drawn per BLOCK rather than once over the range, because
 * Decoration.node needs exact node boundaries and a section is several
 * top-level nodes rather than one. Walking depth 0 and decorating every node
 * that falls inside the range is what makes the rule continuous down the margin
 * without the plugin having to know what kinds of block are in there.
 */
function sectionDecorations(doc, range) {
    const out = [];
    let first = true;
    doc.forEach((node, offset) => {
        const from = offset;
        const to = offset + node.nodeSize;
        if (from < range.from || to > range.to) { return; }
        const classes = ['studio-quality-section'];
        if (first) { classes.push('studio-quality-section-head'); first = false; }
        if (range.active) { classes.push('studio-quality-on'); }
        if (range.stale) { classes.push('studio-quality-stale'); }
        out.push(Decoration.node(from, to, {
            class: classes.join(' '),
            'data-quality': range.fingerprint || ''
        }));
    });

    /*
     * The chip names what the section reads as. It is a widget rather than a
     * pseudo-element on the heading because the text is data — "reads as DESIGN"
     * against "reads as REQUIREMENT" — and CSS cannot carry a value that came out
     * of a report. `side: -1` puts it before the heading's own content so it
     * cannot be typed into the middle of, and the widget is unselectable in CSS
     * for the same reason suggest-marks.js makes its deletion widgets
     * unselectable: it is not somewhere a caret can go.
     */
    if (range.label) {
        out.push(Decoration.widget(range.from + 1, () => {
            const chip = document.createElement('span');
            chip.className = 'studio-quality-chip' + (range.active ? ' studio-quality-on' : '');
            chip.setAttribute('data-quality', range.fingerprint || '');
            chip.textContent = range.label;
            return chip;
        }, { side: -1, key: 'q-chip-' + (range.fingerprint || '') + '-' + range.from }));
    }

    return out;
}

function buildDecorations(doc, ranges) {
    if (!ranges || !ranges.length) { return DecorationSet.empty; }
    const decorations = [];
    for (const range of ranges) {
        /*
         * A range whose bounds no longer exist is dropped silently HERE and
         * reported by the rail instead. The two are not the same statement: a
         * decoration that cannot be drawn is a display fact, while a finding
         * whose text has gone is a triage fact, and the rail is where a person
         * can act on it. Drawing a clamped approximation would be the worst of
         * the three — a highlight over prose the finding is not about.
         */
        if (typeof range.from !== 'number' || typeof range.to !== 'number') { continue; }
        if (range.from < 0 || range.to > doc.content.size || range.to <= range.from) { continue; }
        if (range.kind === 'section') { decorations.push(...sectionDecorations(doc, range)); }
        else { decorations.push(spanDecoration(range)); }
    }
    return DecorationSet.create(doc, decorations);
}

/**
 * The extension.
 *
 * `getRanges` is a callback for the same reason suggest-marks.js takes one: the
 * plugin asks on every transaction, so the widget owns when the answer changes
 * and the plugin never has to learn about a rescan finishing, a card being
 * selected, a finding being dismissed, or the rail being closed. An empty array
 * is how the marks are off — which is every document nobody has checked, so this
 * costs nothing in the common case.
 */
function qualityMarksExtension(getRanges) {
    return Extension.create({
        name: 'studioQualityMarks',
        addProseMirrorPlugins() {
            return [new Plugin({
                key: qualityMarksKey,
                state: {
                    init(_, state) { return buildDecorations(state.doc, getRanges()); },
                    apply(tr, value, oldState, newState) {
                        /*
                         * A selection-only transaction — every arrow key — must
                         * not rebuild a decoration set. Unlike suggest-marks,
                         * mapping the old set through the step IS enough for an
                         * ordinary edit: these ranges are anchored by quote and
                         * occurrence, so an edit elsewhere moves them exactly as
                         * mapping does, and an edit inside one is meant to leave
                         * the mark where the text went until the next check
                         * re-anchors it. Only an explicit refresh rebuilds.
                         */
                        if (!tr.getMeta(qualityMarksKey)) {
                            return tr.docChanged ? value.map(tr.mapping, tr.doc) : value;
                        }
                        return buildDecorations(newState.doc, getRanges());
                    }
                },
                props: {
                    decorations(state) { return qualityMarksKey.getState(state); }
                }
            })];
        }
    });
}

/**
 * Ask for a rebuild without editing the document.
 *
 * Needed because everything that changes these marks — a check finishing, a card
 * being selected, a dismissal, the rail closing — changes nothing about the
 * document, so there is no transaction for the plugin to notice.
 */
function refreshQualityMarks(editor) {
    if (!editor || !editor.view) { return; }
    const tr = editor.view.state.tr;
    tr.setMeta(qualityMarksKey, 'refresh');
    tr.setMeta('addToHistory', false);
    /* Marked as ours so onDocChanged ignores it: the widget treats an
     * unrecognised transaction as a user edit and would save the file. */
    tr.setMeta('studio-internal', true);
    editor.view.dispatch(tr);
}

const QUALITY_MARKS_CSS = `
/* --- findings in the text ------------------------------------------------- *
 *
 * UNDERLINES, NOT FILLS, and the reason is the header's: this editor can be
 * carrying a comment mark (which owns fill), a tracked change, a live suggestion
 * mark and a quality finding over the same paragraph at the same time. A fourth
 * background is where it stops being readable. An underline is the one inline
 * treatment nothing else in the product has claimed.
 *
 * text-underline-offset rather than a border-bottom: a border sits under the
 * line box and drifts away from the text as the line height changes, while an
 * underline tracks the glyphs. It also survives a line wrap, which a border
 * does not — and a flagged sentence very often wraps.
 */
.studio-quality-span {
  text-decoration-line: underline;
  text-decoration-color: var(--studio-amber);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  cursor: pointer;
}
/* Solid for a lexical match, dotted for a model's. This is the one thing about a
   finding that must be legible without opening its card: 55% of the real
   clusters were matched by a model rather than by comparison, and the two do not
   deserve the same trust. */
.studio-quality-lexical { text-decoration-style: solid; }
.studio-quality-semantic { text-decoration-style: dotted; text-decoration-thickness: 2px; }

/* The current card's mark. A thicker underline plus the product's own selection
   ground — the same pairing tracked changes use for the hunk being reviewed, so
   "this is the one you are looking at" means one thing in this editor. */
.studio-quality-span.studio-quality-on {
  background: var(--studio-selection-bg);
  text-decoration-thickness: 2.5px;
  border-radius: 2px;
}

/* Stale: the text this was read from has changed, so the finding may already be
   fixed. Muted rather than hidden — dropping it would be a claim, and the claim
   would be wrong half the time. The rail says the same thing in words. */
.studio-quality-stale { text-decoration-color: var(--studio-muted); opacity: .7; }

/* --- a section in the wrong voice ---------------------------------------- *
 *
 * A LEFT EDGE RULE AND NO BODY TINT. The claim is about the section, so the
 * decoration is about the section: a rule down the margin marks its extent
 * without touching the prose. Tinting nine lines as if they were a phrase
 * misreads the unit, and it also collides with every inline treatment above.
 *
 * The rule is drawn per block (see sectionDecorations) and the blocks are
 * adjacent, so it reads as one continuous edge. box-shadow rather than
 * border-left: a border participates in layout and would shift the document's
 * text 3px sideways every time a check finished.
 */
.studio-quality-section {
  box-shadow: -11px 0 0 -8px var(--studio-edge);
}
.studio-quality-section.studio-quality-on {
  box-shadow: -11px 0 0 -8px var(--studio-amber);
}
.studio-quality-section.studio-quality-stale {
  box-shadow: -11px 0 0 -8px var(--studio-line);
}

/* The chip on the heading. It carries a VALUE — "reads as DESIGN" — which is why
   it is a widget with text rather than a pseudo-element: CSS cannot render a
   string that came out of a report. Unselectable for the same reason
   suggest-marks.js makes its deletion widgets unselectable: a widget is not part
   of the document and must not read as somewhere the caret can go. */
.studio-quality-chip {
  display: inline-block; margin-right: 8px; padding: 1px 6px;
  border: 1px solid var(--studio-line); border-radius: 999px;
  background: var(--studio-surface-raised);
  color: var(--studio-muted);
  font-size: 10.5px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase;
  vertical-align: middle; white-space: nowrap;
  user-select: none; -webkit-user-select: none; cursor: pointer;
}
.studio-quality-chip.studio-quality-on {
  border-color: var(--studio-amber); color: var(--studio-amber);
  background: var(--studio-selection-bg);
}

/* --- findings in the gutter ---------------------------------------------- *
 *
 * The same margin strip the comment marks use, because both are "there is
 * something to look at on this line" and a reviewer scanning a document should
 * read one column rather than two.
 *
 * A BAR, NOT A DOT, and specifically not a hollow dot — a hollow gutter dot
 * already means "resolved comment" in editor-css.js, so reusing it would have a
 * finding and a settled thread render identically. A short vertical rule is a
 * different silhouette at 9px, which is the size these are actually read at,
 * and it echoes the left edge rule a flagged section carries in the prose.
 *
 * Geometry, hover, active ring and focus ring all come from .studio-gutter-mark
 * in editor-css.js; only the shape and the colour are restated.
 */
.studio-gutter-mark.studio-gutter-quality {
  width: 3px; height: 13px; border-radius: 2px; left: 3px;
  border: none; background: var(--studio-muted);
}
.studio-gutter-mark.studio-gutter-quality.active { background: var(--studio-amber); }
`;

module.exports = { qualityMarksExtension, refreshQualityMarks, buildDecorations, QUALITY_MARKS_CSS };
