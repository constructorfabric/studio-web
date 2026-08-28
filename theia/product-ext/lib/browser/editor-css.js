/*
 * Presentation for the Markdown editor widget.
 *
 * Split out of markdown-editor.js because that file now carries the mode
 * machinery, the review pipeline and the history rail; a ~500-line template
 * literal in the middle of it made the logic hard to read. The diff and
 * diagram styles are composed in here rather than injected separately so the
 * product still installs exactly one stylesheet per widget family.
 */

const { DIFF_CSS } = require('./diff-view');
const { TRACKED_CSS } = require('./tracked-changes');
const { DIAGRAM_CSS } = require('./mermaid-view');
const { FIGURE_CSS } = require('./figure-view');
const { CALLOUT_CSS } = require('./callout-view');
const { MATH_CSS } = require('./math-view');
const { RAW_CSS } = require('./raw-view');
const { CODE_HIGHLIGHT_CSS } = require('./code-highlight');

const WIDGET_CSS = `
/* !important: Theia's generated theme CSS targets Lumino dock widgets with a
   two-class selector (.lm-Widget.lm-DockPanel-widget), which outranks this
   single-class rule on specificity alone regardless of source order, and
   pins the widget to a white background it resolved once at boot. */
.studio-doc { display: flex; flex-direction: column; height: 100%; background: var(--studio-bg) !important; color: var(--studio-text); position: relative; }
/* --- three layers, three tones, no extra space (D13) -----------------------
 *
 * Measured before this: the dock tab strip, this bar, the document surface and
 * the body were FOUR bands of the identical rgb(255,255,255), separated by one
 * hairline in total and by nothing at all between the tab strip and this bar.
 * Three different levels of the hierarchy -- window chrome, document chrome,
 * document content -- rendered as one continuous white field.
 *
 * The fix is tone, and ONLY tone. An earlier proposal also inset the document
 * as a bordered card on a sunken ground; that was rejected in review for the
 * right reason -- it consumed space to say something a tone already says. So
 * the document keeps every pixel of its column, on --studio-bg, with no card,
 * no border and no added padding. The tab strip is sunken, this bar is raised,
 * the document is the page white: chrome recedes, content advances.
 *
 * The seams stay hairline --studio-line, per constraint 24; the separation is
 * carried by the tones, which is exactly what lets the lines stay quiet.
 */
.studio-doc-topbar {
  display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 12px; flex: none;
  background: var(--studio-surface-raised);
  border-bottom: 1px solid var(--studio-line); font-size: 12px; color: var(--studio-muted);
}
.studio-doc-topbar[hidden] { display: none; }
.studio-doc-spacer { flex: 1; }
.studio-doc-status { font-size: 11.5px; color: var(--studio-muted); white-space: nowrap; }
.studio-doc-status.state-dirty { color: var(--studio-accent); }
.studio-doc-status.state-conflict, .studio-doc-status.state-error { color: var(--studio-danger); font-weight: 650; }
/* The save-in-progress dot. -6px pulls it against the status text it belongs
   to, out of the topbar's uniform 10px rhythm, so the pair reads as one field
   rather than as two adjacent ones. */
/* The mode pill sits left of the status with the same gap the status keeps from
   the Save button, so the topbar reads as one row of related facts rather than a
   control parked next to some text. */
.studio-doc-suggest { display: inline-flex; flex: none; margin-right: 4px; }
.studio-doc-suggest[hidden] { display: none; }
/* Suggesting takes the accent in the status too: the two together are the only
   answer to "is what I type going into the file", so they agree or neither is
   trustworthy. */
.studio-doc-status.state-suggesting, .studio-doc-status.state-suggested { color: var(--studio-accent); }
.studio-doc-busy { display: inline-flex; align-items: center; margin-right: -6px; }

/* --- segmented controls (mode) --- */
/* Sunken track, not raised: the bar it sits on is raised now, and a control has
   to be a different tone from its own background to read as a control. */
.studio-seg { display: inline-flex; gap: 1px; padding: 2px; border-radius: 8px; background: var(--studio-surface-sunken); flex: none; }
.studio-seg-btn {
  font: inherit; font-size: 11.5px; padding: 3px 10px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--studio-muted); white-space: nowrap;
}
.studio-seg-btn:hover { color: var(--studio-text); }
.studio-seg-btn.on { background: var(--studio-bg); color: var(--studio-text); font-weight: 620; box-shadow: 0 1px 2px color-mix(in srgb, var(--studio-text) 8%, transparent); }
.studio-seg-btn:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 1px; }

/* The slot selector is not a segmented control here and never will be again:
 * .studio-seg-split, .studio-seg-btn.assistant and the <em> count badge are
 * gone for good. That pill spanned two scopes with a 1px divider inside a
 * shared container as the only sign of it, and the mode segment is now the only
 * segmented control in the document -- which is what the shape should have
 * meant all along.
 *
 * What DID come back into this bar is the document's three slot destinations, as
 * an icon cluster at the right end. They went to a strip in the 48px right-hand
 * column in between (see the header of slot-strip.js for the whole round trip);
 * the column cost the document 48px permanently to hold five buttons, so the
 * three that belong to the document came back to the bar the document already
 * pays for, and the two app-level assistants went to the left activity rail.
 *
 * The BUTTON is styled once, in slot-strip.js, because the same node renders in
 * both places and two near-identical rule sets is how the old per-surface pills
 * drifted apart. What is here is only how this bar HOSTS one. */
/* --- the slot cluster, at the right end of the bar ------------------------- */
/* The bar's gap is 10px, which is the distance between unrelated facts in it.
 * The cluster is a different KIND from the save status next to it -- one states
 * what the file is doing, the other opens things beside it -- so it gets a rule
 * rather than more air: 18px of --studio-line (constraint 24: this is a divider
 * inside a panel, not a shell seam), with 2px margins so the 10px gaps either
 * side still carry most of the separation. -4px on the right pulls the cluster
 * to the bar's 12px padding: a 28px tile has its own visual inset, and without
 * this the last button floated ~7px off the window's right edge while the mode
 * segment sat flush on the left. */
.studio-slot-divider {
  flex: none; width: 1px; height: 18px; background: var(--studio-line); margin: 0 2px;
}
/* --studio-slot-ring is restated rather than inherited: the badge has to read as
 * sitting on THIS bar, and the cluster's own default is the same tone only by
 * coincidence -- the raised surface is where a cluster happens to live today. */
.studio-doc-topbar .studio-slot-cluster {
  margin-right: -4px; --studio-slot-ring: var(--studio-surface-raised);
}
/* Never hidden, and never emptied: membership is fixed, so the cluster is the
 * one thing in this bar that is always there. See updateTopbarVisibility. */

/* --- gutter marks ----------------------------------------------------------
 *
 * The document's own record that a line carries a comment. This is what makes
 * closing the slot safe: without it, a shut panel hides the fact that comments
 * exist at all.
 *
 * Sits in the page's left padding, absolutely positioned against
 * .studio-doc-page -- the same offsetParent as the comment marks whose
 * offsetTop drives it.
 */
.studio-doc-page { position: relative; }
.studio-doc-gutter { position: absolute; left: 8px; top: 0; width: 12px; pointer-events: none; }
.studio-doc-body.mode-split .studio-doc-gutter { left: 4px; }
.studio-gutter-mark {
  position: absolute; left: 0; width: 9px; height: 9px; padding: 0;
  border-radius: 50%; cursor: pointer; pointer-events: auto;
  border: 1.5px solid var(--studio-accent); background: var(--studio-accent);
  transition: transform 140ms cubic-bezier(.23, 1, .32, 1), box-shadow 140ms ease-out;
}
/* Hollow means resolved: the thread is still there, it just needs nothing. */
.studio-gutter-mark.resolved { background: transparent; border-color: var(--studio-muted); }
.studio-gutter-mark:hover { transform: scale(1.25); }
.studio-gutter-mark:active { transform: scale(1.05); }
.studio-gutter-mark.active { box-shadow: 0 0 0 3px var(--studio-selection-bg); }
.studio-gutter-mark:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }

/* --- banners ---------------------------------------------------------------
 *
 * A banner belongs to the DOCUMENT, so it spans the document column only.
 *
 * It used to be a sibling of .studio-doc-body, which made it full width: it ran
 * across the rail as well, and pushed the rail down. That severed the panel from
 * the selector pill that governs it -- the "Comments" toggle sat above a band of
 * warning, and the panel it opened started below it, so the two no longer read
 * as connected. It also implied the warning applied to the comments, which it
 * does not; it is about the file.
 *
 * A banner also no longer draws a saturated accent line under itself. A tinted
 * band already separates from white on its own, and a full-strength 1px accent
 * rule beneath it was the heaviest horizontal line on screen -- for a notice, not
 * for a structural boundary. The tint carries the meaning; the line only made
 * the notice louder than the document.
 */
.studio-doc-banners { flex: none; }
.studio-doc-banner {
  padding: 9px 16px; font-size: 12.5px; line-height: 1.6;
  background: color-mix(in srgb, var(--studio-accent) 10%, var(--studio-surface)); color: var(--studio-text);
  border-bottom: 1px solid color-mix(in srgb, var(--studio-accent) 22%, transparent);
}
.studio-doc-banner.block {
  background: color-mix(in srgb, var(--studio-danger) 9%, var(--studio-surface));
  border-bottom-color: color-mix(in srgb, var(--studio-danger) 26%, transparent);
}
.studio-doc-banner.info { background: var(--studio-surface-raised); border-bottom-color: var(--studio-line); }
.studio-doc-banner.note {
  padding: 4px 16px; font-size: 11.5px; line-height: 1.45;
  background: transparent; border-bottom-color: var(--studio-line); color: var(--studio-muted);
}
.studio-doc-banner .studio-btn { margin-left: 4px; vertical-align: baseline; }

/* --- body layout: the three authoring modes ---
 *
 * .studio-doc-main is the document column: banners plus the editing panes. It
 * exists so a banner cannot span the rail (see above). The mode classes stay on
 * .studio-doc-body and reach the panes as descendants, so every selector below
 * and every test that queries them is unaffected by the extra level.
 */
.studio-doc-body { flex: 1; display: flex; min-height: 0; }
.studio-doc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
/* position: relative so .studio-doc-loading below has a containing block.
   Checked against every absolutely positioned element in this file first: the
   gutter resolves against .studio-doc-page, the selected-cell wash against its
   own td, and the bubble/slash/table-bar are siblings of .studio-doc-body, not
   descendants of the panes — so none of them changes containing block. */
.studio-doc-panes { flex: 1; min-height: 0; display: flex; position: relative; }

/* The document-open state, over the panes rather than inside either of them:
   Rich and Raw put the content in different children, and the wait belongs to
   the document, not to the mode it will open in. Opaque, because a half-built
   ProseMirror surface showing through would be worse than a clean wait. */
.studio-doc-loading {
  position: absolute; inset: 0; z-index: 3;
  background: var(--studio-bg);
}
.studio-source-pane { display: none; flex: 1 1 50%; min-width: 0; border-right: 1px solid var(--studio-line); }
.studio-doc-body.mode-raw .studio-source-pane { display: flex; flex-basis: 100%; border-right: none; }
.studio-doc-body.mode-split .studio-source-pane { display: flex; }
.studio-doc-body.mode-raw .studio-doc-scroll { display: none; }
.studio-source {
  flex: 1; width: 100%; box-sizing: border-box; border: none; outline: none; resize: none;
  padding: 24px 20px 200px; background: var(--studio-bg); color: var(--studio-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.7;
  tab-size: 2;
}
.studio-source:read-only { color: var(--studio-muted); }
/* !important: the Lumino dock panel behind this widget carries its own
   background from Theia's generated theme CSS, resolved once at boot. That
   can win over a plain background rule here, leaving a white strip below
   short content when the runtime theme differs from ours. */
.studio-doc-scroll { flex: 1 1 50%; min-width: 0; overflow: auto; background: var(--studio-bg) !important; }
.studio-doc-page { max-width: 720px; margin: 0 auto; padding: 56px 32px 200px; }
.studio-doc-body.mode-split .studio-doc-page { padding: 24px 24px 200px; }

.studio-btn {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--studio-line); background: var(--studio-surface); color: var(--studio-text);
}
.studio-btn:hover { background: var(--studio-surface-raised); }
.studio-btn.primary { background: var(--studio-accent); color: #fff; border-color: var(--studio-accent); }
.studio-btn.primary:hover { background: var(--studio-accent-hover); }
.studio-btn.ghost { border-color: transparent; color: var(--studio-muted); }
.studio-btn:focus-visible, .studio-bubble-btn:focus-visible, .studio-thread textarea:focus-visible {
  outline: 2px solid var(--studio-accent); outline-offset: 2px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--studio-accent) 24%, transparent);
}

/* --- document typography ---
 *
 * Scoped to :is(.ProseMirror, .studio-tracked-page), not to .ProseMirror alone.
 *
 * The tracked-changes review surface (tracked-changes.js) is a second rendering
 * of the same document, and it is plain HTML rather than a ProseMirror instance
 * — so with the original selector it inherited the browser's default type scale
 * and a reviewer comparing the two saw a 32px Times heading where their document
 * has a 22px one. A review surface that does not look like the document is
 * describing a document the reader does not have.
 *
 * :is() rather than a second selector on every rule: it keeps the compound
 * selectors below correct (a trailing "h1" expands over both arms) and does not change
 * specificity, since both arms are class selectors. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) {
  outline: none; line-height: 1.7; font-size: 15.5px; color: var(--studio-text);
  /* TipTap's bundled base styles set an opaque white background on the
     editable surface; without this override that background survives a
     switch to dark mode while the text color (inherited) goes light,
     leaving near-invisible text on a still-white page. */
  background: var(--studio-bg);
}
/* --- the heading scale ---
 *
 * Six levels over a 15.5px body, and size alone cannot carry six steps on a
 * document surface this dense. Measured before this: h4 was 14px against 15.5px
 * body text -- a heading SMALLER than the paragraph it introduces, which reads
 * as bold body copy and not as a level at all -- and h5/h6 had no rule, so they
 * inherited the browser's 0.83em and 0.67em and came out smaller still.
 *
 * So the steps are carried by size down to h4 and by weight, tracking and case
 * below it. Adjacent sizes stay inside 1.06-1.26, which is the range a surface
 * with this many type roles can hold without the levels reading as noise; h5 is
 * body size at a heavier weight, h6 is a tracked small-caps label. Every level
 * is unmistakably a level, and none of them is quieter than the text under it.
 *
 * More space above a heading than below it, at every level: a heading belongs
 * to the section it opens, and equal margins leave it floating between two. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) h1 { font-size: 29px; line-height: 1.24; font-weight: 660; letter-spacing: -0.021em; margin: 34px 0 12px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) h2 { font-size: 23px; line-height: 1.3; font-weight: 640; letter-spacing: -0.014em; margin: 30px 0 10px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) h3 { font-size: 19px; line-height: 1.36; font-weight: 640; letter-spacing: -0.008em; margin: 26px 0 8px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) h4 { font-size: 16.5px; line-height: 1.42; font-weight: 650; margin: 22px 0 6px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) h5 { font-size: 15.5px; line-height: 1.45; font-weight: 700; margin: 20px 0 5px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) h6 { font-size: 13px; line-height: 1.45; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; margin: 20px 0 6px; }
/* The first block in the page sits on the page's own top padding, so its
 * heading margin would be counted twice. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) > :first-child { margin-top: 0; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) p { margin: 0 0 12px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul, .studio-doc :is(.ProseMirror, .studio-tracked-page) ol { padding-left: 22px; margin: 0 0 12px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) li p { margin: 0 0 4px; }
/* --- quotation ----------------------------------------------------------
 * Two complaints, both fixed here.
 *
 * NOT ALIGNED: a 3px bar plus 14px of padding pushed the quote's text 17px to
 * the right of every other line in the document, so a quote broke the single
 * left edge the page is read down. The rule now hangs in the page's own
 * margin — negative margin-left equal to the indent it then applies — so the
 * quoted TEXT sits on the same axis as the prose above it and the mark sits
 * beside the column rather than inside it.
 *
 * NOT STYLISH: --studio-line on white is a hairline nobody sees, and
 * --studio-muted made the quote read as disabled text rather than as
 * emphasis. A quotation is the author choosing to foreground someone else's
 * words; muting it says the opposite. So: full text colour, and the very
 * slight optical size increase that a pulled quotation carries in print.
 *
 * THREE THINGS HERE ARE CORRECTIONS, and all three came from looking at the
 * shipped pixels rather than at this file.
 *
 * 1. background: none is load-bearing. @theia/core's index.css styles bare
 *    "blockquote" globally -- 5px border, 16px padding, and a
 *    --theia-textBlockQuote-background fill. This rule outweighs it on
 *    specificity for every property it names, so overriding the geometry and
 *    not the fill left a grey slab behind quoted text, at whatever vertical
 *    padding THIS rule chose. It looked like a deliberate highlight set 2px
 *    too tight; it was a leak.
 *
 * 2. The rule sits ON the text column's left edge, not in the margin outside
 *    it. Hanging it at -18px is the print convention for a pulled quotation
 *    and it is wrong for an editor: every other block in the document starts
 *    at the same x, and a quote that starts left of all of them reads as
 *    misalignment rather than as emphasis. Indent the quoted text instead --
 *    the rule then lines up with the surrounding prose and the text steps in
 *    from it, which is what a reader of any block editor expects.
 *
 * 3. 3px of a near-text neutral, not of a 45%-mixed accent. The pale mix
 *    measured as a hairline: at 45% on white the rule carries less weight
 *    than the hairline around a table cell, so a multi-paragraph quote had no
 *    visible left boundary at all.
 *
 * With margin-left back at 0 there is nothing left for a quote nested inside
 * a narrower container to collide with, so the override that used to follow
 * this rule for li / callout / cell / toggle bodies is gone.
 */
.studio-doc :is(.ProseMirror, .studio-tracked-page) blockquote {
  background: none; margin: 14px 0; padding: 3px 0 3px 18px;
  border-left: 3px solid color-mix(in srgb, var(--studio-text) 82%, transparent);
  color: var(--studio-text); font-size: 15.5px; line-height: 1.65;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) blockquote > :last-child { margin-bottom: 0; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) blockquote > :first-child { margin-top: 0; }
/* --studio-surface is #ffffff in the light theme, so both of these used to be
   white on a white page: a code block was invisible except for its text
   indent, and an inline code span had no chip at all. Sunken is the token that
   means "recessed below the page" and is the one that reads as a code ground
   in both themes; the hairline is what keeps the block's edge legible in dark
   mode, where sunken and the page ground are only a few points apart. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre {
  background: var(--studio-surface-sunken); border: 1px solid var(--studio-line);
  border-radius: 8px; padding: 12px 14px; overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.8px; line-height: 1.55; margin: 0 0 12px;
  /* Code is the one place a long line must not be reflowed: wrapping it
     silently changes what the reader believes the source says. */
  white-space: pre; tab-size: 4;
}
/* The explicit colour is not redundant: @theia/core's index.css sets
   color: var(--theia-textPreformat-foreground) on bare "code" globally, and
   this product never defines that token, so every code span and every
   untokenised run inside a fence inherited VS Code's dark-red default. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em;
  color: var(--studio-text);
  background: color-mix(in srgb, var(--studio-line) 55%, transparent);
  padding: 1.5px 5px; border-radius: 4px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre code {
  background: none; padding: 0; font-size: inherit; border-radius: 0;
}
/* The node view wraps every fence in .studio-codeblock, which carries its own
   bottom margin — without this the two stack and a code block sits 26px clear
   of the next paragraph while everything else in the document sits 12px. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-codeblock > pre { margin: 0; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) hr { border: none; border-top: 1px solid var(--studio-line); margin: 22px 0; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) a { color: var(--studio-accent); text-decoration: underline; text-underline-offset: 2px; }
/* Footnotes. The reference is a chip rather than bare superscript text: it is an
   atom, so it behaves like one object under the caret, and it should look like
   one. The definition gets a rule and a hanging label so the block reads as
   apparatus rather than as another paragraph of the document. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-footnote-ref {
  font-size: 0.72em; font-weight: 650; line-height: 1; vertical-align: super;
  color: var(--studio-accent); background: var(--studio-surface);
  border: 1px solid var(--studio-line); border-radius: 4px;
  padding: 1px 4px; margin: 0 1px; cursor: default; white-space: nowrap;
  /* An atom holds no editable text, so a text cursor over it would lie. */
  user-select: none; -webkit-user-select: none;
}
.studio-doc .ProseMirror .studio-footnote-ref.ProseMirror-selectednode {
  outline: 2px solid var(--studio-accent); outline-offset: 1px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-footnote-def {
  display: flex; gap: 8px; margin: 0 0 8px; padding-top: 8px;
  border-top: 1px solid var(--studio-line);
  font-size: 13px; color: var(--studio-muted);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-footnote-def + .studio-footnote-def {
  border-top: none; padding-top: 0;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-footnote-def-label {
  flex: none; font-weight: 650; color: var(--studio-accent);
  user-select: none; -webkit-user-select: none;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-footnote-def-body { flex: 1; min-width: 0; }
/*
 * Toggles, and this is a rewrite rather than an adjustment.
 *
 * What shipped was a card: 1px border, 8px radius, a raised fill, and a 620
 * summary. Every one of those says "this is a component" -- and a toggle is
 * not one, it is an outline affordance around ordinary prose. Six of them down
 * a page read as six panels of chrome, each announcing itself louder than the
 * text it holds, and the card's own padding pushed the title off the text
 * column so nothing in the document lined up with anything else.
 *
 * So: a twisty, the title on the body baseline at the body's weight, and the
 * body indented to sit under the title. No fill, no border, no radius. The
 * only ink the control spends is the 15px chevron, which rotates rather than
 * swapping glyph -- the rotation is what carries open/closed, and the same
 * shape in both states is why it reads as one control.
 */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle { margin: 0 0 10px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-head { display: flex; align-items: flex-start; gap: 2px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-twisty {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 26px; padding: 0; margin: 0; border: none; background: none;
  color: var(--studio-muted); cursor: pointer; border-radius: 4px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-twisty svg { width: 15px; height: 15px; transition: transform 120ms ease; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle.is-open .studio-toggle-twisty svg { transform: rotate(90deg); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-twisty:hover { color: var(--studio-text); background: var(--studio-surface-raised); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-twisty:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 1px; }
/* The title is a contenteditable region, so it needs the caret affordances a
   textbox has and none of the ones a button has: no focus ring on click, but a
   hint while it is empty, and wrapping rather than an overflow that hides the
   end of a long name. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-title {
  flex: 1 1 auto; min-width: 0; padding: 1px 0; line-height: 1.6;
  outline: none; white-space: pre-wrap; overflow-wrap: anywhere;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-title:empty::before {
  content: attr(data-placeholder); color: var(--studio-muted); pointer-events: none;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-body { margin-left: 22px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle:not(.is-open) .studio-toggle-body { display: none; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-body > :last-child { margin-bottom: 0; }
/* The static spec, which is what copy/paste and the tracked-changes page get:
   no node view there, so the native disclosure marker is the twisty. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) details { margin: 0 0 10px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) details > summary { cursor: pointer; color: var(--studio-text); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) details > summary:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) details > [data-studio-toggle-body] { margin-left: 22px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) details > [data-studio-toggle-body] > :last-child { margin-bottom: 0; }
@media (prefers-reduced-motion: reduce) {
  .studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-toggle-twisty svg { transition: none; }
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) img { display: block; max-width: 100%; height: auto; margin: 0 0 12px; border-radius: 6px; }
/* Only ever on a textblock that can hold prose. The hint is a zero-height
   left float, so on a container node (a callout, a details, a table cell) it
   paints over whatever chrome sits at the top of that box rather than below
   it -- see the Placeholder configuration in markdown-editor.js, which is the
   other half of this: containers are handed the empty string. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) :is(p, h1, h2, h3, h4, h5, h6).is-editor-empty:first-child::before,
.studio-doc :is(.ProseMirror, .studio-tracked-page) :is(p, h1, h2, h3, h4, h5, h6).is-empty::before {
  content: attr(data-placeholder); color: var(--studio-muted); float: left; height: 0; pointer-events: none;
}
.studio-comment-mark { background: color-mix(in srgb, var(--studio-accent) 28%, transparent); border-bottom: 1.5px solid var(--studio-accent); cursor: pointer; }
/* Resolved anchors leave the active selection completely until their archived
   thread is explicitly opened in the Comments rail. */
.studio-comment-mark.studio-comment-resolved { background: transparent; border-bottom-color: transparent; cursor: default; }

/* The highlight mark (==x== in source). A translucent fill, at a weight chosen to sit between the two
   other fills already living on inline text — the comment mark's 28% accent
   (studio-comment-mark, above) and a live tracked insertion's 12% (studio-
   tc-ins.studio-tc-live in tracked-changes.js) — so a highlight is never
   mistaken for either at a glance. Marks nest as ancestor/descendant spans
   in the rendered DOM, so when a highlight and a comment do land on the same
   run the inner span's tint shows OVER the outer's rather than replacing it
   (ordinary alpha compositing) — both signals stay visible, which is the
   actual requirement; getting the same hue as either neighbour is not. */
.studio-highlight {
  background: color-mix(in srgb, var(--studio-accent) 20%, transparent);
  border-radius: 2px; padding: 0 1px; box-decoration-break: clone; -webkit-box-decoration-break: clone;
}

/*
 * StarterKit enables Gapcursor by default and this product never shipped its
 * stylesheet (prosemirror-gapcursor's own CSS is a separate package this
 * codebase never imports) — so the plugin was always deciding correctly
 * where the gap cursor belongs and never painting one. That was invisible
 * until this pass added FOUR atom node types: rawBlock and mathBlock can now
 * legitimately be the first or last node in a document, which is exactly the
 * position a gap cursor exists for (there is no text position before or
 * after an atom to put an ordinary caret at). Restated on the product's own
 * tokens rather than the library's literal black.
 */
.ProseMirror-gapcursor { display: none; pointer-events: none; position: absolute; }
.ProseMirror-gapcursor:after {
  content: ''; display: block; position: absolute; top: -2px; width: 20px;
  border-top: 1px solid var(--studio-text);
  animation: studio-gapcursor-blink 1.1s steps(2, start) infinite;
}
@keyframes studio-gapcursor-blink { to { visibility: hidden; } }
.ProseMirror-focused .ProseMirror-gapcursor { display: block; }

/* --- task lists --- */
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul[data-type="taskList"] { list-style: none; padding-left: 2px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 9px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul[data-type="taskList"] li > label { flex: none; margin-top: 4px; user-select: none; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul[data-type="taskList"] li > div { flex: 1; min-width: 0; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul[data-type="taskList"] input[type="checkbox"] { accent-color: var(--studio-accent); width: 14px; height: 14px; cursor: pointer; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) ul[data-type="taskList"] li[data-checked="true"] > div { color: var(--studio-muted); text-decoration: line-through; }

/* --- tables --- */
.studio-doc :is(.ProseMirror, .studio-tracked-page) table {
  width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 13.5px; table-layout: fixed; overflow: hidden;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) th, .studio-doc :is(.ProseMirror, .studio-tracked-page) td {
  border: 1px solid var(--studio-line); padding: 7px 9px; text-align: left; vertical-align: top; position: relative;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) th { background: var(--studio-surface-raised); font-weight: 650; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) td p, .studio-doc :is(.ProseMirror, .studio-tracked-page) th p { margin: 0; }
/* prosemirror-tables paints cell selection with this class; without a rule it
   is invisible, and "select a column, then align it" has no feedback at all. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .selectedCell::after {
  content: ''; position: absolute; inset: 0; background: var(--studio-selection-bg); opacity: .7; pointer-events: none;
}
/* The rule that makes [hidden] actually hide .studio-bubble, .studio-slash
 * and .studio-table-bar (all three set their own display, which outranks
 * the UA's [hidden]) now lives in SHELL_CSS in product-frontend-module.js,
 * scoped to .studio-doc [hidden] and so applied to all of them and to the
 * other two product widget roots. See the comment there. */

.studio-table-bar {
  position: absolute; z-index: 46; display: flex; align-items: center; gap: 1px; padding: 4px; flex-wrap: nowrap;
  background: var(--studio-surface-raised); border: 1px solid var(--studio-line); border-radius: 9px;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--studio-bg) 76%, transparent);
  transition: transform 140ms cubic-bezier(0.23,1,0.32,1);
}
.studio-table-bar.nudge { transform: translateX(-3px); }

/* --- slash menu / block selector ---
 *
 * One popup markup for both (see the header note on .studio-slash in
 * markdown-editor.js): a query row (mark + input, shown for both a typed
 * '/' and the block selector's own search box) over a scrollable, grouped
 * list. Rows are single-line now -- icon, label, and a hint that only the
 * HIGHLIGHTED row gets, right-aligned and truncated -- where the old markup
 * put a hint under every row and made a 28-item list two screens tall.
 */
.studio-slash {
  position: absolute; z-index: 40; width: 280px; max-height: 320px;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--studio-surface-raised); border: 1px solid var(--studio-line); border-radius: 10px;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--studio-bg) 72%, transparent); padding: 5px;
}
.studio-slash-query {
  display: flex; align-items: center; gap: 7px; flex: none;
  padding: 5px 7px 7px; margin-bottom: 4px; border-bottom: 1px solid var(--studio-line);
}
.studio-slash-mark { font-family: var(--studio-mono); font-size: 12.5px; color: var(--studio-muted); flex: none; }
.studio-slash-input {
  flex: 1; min-width: 0; font: inherit; font-size: 13px; background: none; border: none; outline: none;
  color: var(--studio-text);
}
.studio-slash-input::placeholder { color: var(--studio-muted); }
/* Read-only for the '/' trigger: the query is being typed into the
   DOCUMENT, not into this box -- the box only echoes it, so a caret and a
   click target here would promise an edit that has to happen somewhere
   else. openBlockSelector clears readOnly for its own, real search box. */
.studio-slash-input:read-only { caret-color: transparent; cursor: default; }
.studio-slash-list { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
.studio-slash-group {
  font-size: 9.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--studio-muted);
  padding: 8px 8px 4px;
}
.studio-slash-item { display: flex; align-items: center; gap: 9px; padding: 5px 7px; border-radius: 7px; cursor: pointer; }
/*
 * --studio-selection-bg, not --studio-surface. --studio-surface sits ABOVE
 * this popover's own --studio-surface-raised in the light palette, so a
 * selected row read as lighter and popped forward as a highlight should --
 * but --studio-surface is DARKER than --studio-surface-raised in the dark
 * palette, so the identical rule recessed the selected row instead of
 * lifting it: a highlight that inverts into a shadow depending on theme.
 * --studio-selection-bg is an accent tint over --studio-bg in both
 * palettes, so it lightens the row relative to its surroundings either way.
 */
.studio-slash-item.sel, .studio-slash-item:hover { background: var(--studio-selection-bg); }
.studio-slash-icon {
  width: 24px; height: 24px; flex: none; display: grid; place-items: center;
  border: 1px solid var(--studio-line); border-radius: 6px; color: var(--studio-muted); background: var(--studio-bg);
}
.studio-slash-icon svg { width: 14px; height: 14px; }
.studio-slash-item.sel .studio-slash-icon {
  color: var(--studio-accent); border-color: color-mix(in srgb, var(--studio-accent) 46%, var(--studio-line));
}
.studio-slash-label {
  flex: 1; min-width: 0; font-size: 13px; color: var(--studio-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.studio-slash-label mark { background: none; color: var(--studio-accent); font-weight: 650; }
.studio-slash-hint {
  flex: none; max-width: 42%; font-size: 11px; color: var(--studio-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.studio-slash-empty { padding: 10px 7px 4px; font-size: 12.5px; color: var(--studio-muted); }

/* --- selection toolbar --- */
.studio-bubble {
  position: absolute; z-index: 45; display: flex; align-items: center; gap: 2px; padding: 4px;
  background: var(--studio-surface-raised); border: 1px solid var(--studio-line); border-radius: 9px;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--studio-bg) 76%, transparent);
  opacity: 0; transform: translateY(3px);
  transition: opacity 110ms ease-out, transform 110ms cubic-bezier(.23,1,.32,1);
}
/*
 * .studio-bubble-in is added once, on the hidden -> visible edge, by
 * positionBubble() -- every reposition after that inside the same
 * selection is a plain left/top write with nothing to transition, which is
 * what keeps the toolbar glued to the pointer instead of visibly sliding
 * after it while a selection is being extended.
 */
.studio-bubble.studio-bubble-in { opacity: 1; transform: translateY(0); }
@media (prefers-reduced-motion: reduce) { .studio-bubble { transition: none; } }
.studio-bubble-btn {
  font: inherit; font-size: 12.5px; min-width: 28px; height: 26px; padding: 0 8px; border: none; border-radius: 6px;
  background: transparent; color: var(--studio-text); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  white-space: nowrap;
}
.studio-bubble-btn svg { width: 13px; height: 13px; }
.studio-bubble-btn:hover { background: var(--studio-surface); }
.studio-bubble-btn.on { background: var(--studio-surface); font-weight: 650; }
.studio-bubble-btn.comment, .studio-bubble-btn.ai { color: var(--studio-accent); }
/* The block selector reads as a labelled control, not a format toggle: a
   fixed cap on its own name plus a fixed caret width, so a long block label
   ("Important callout") truncates instead of stretching the toolbar. */
.studio-bubble-btn.blocksel { max-width: 150px; padding-right: 6px; }
.studio-bubble-btn.blocksel span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-bubble-btn.blocksel svg { width: 10px; height: 10px; opacity: .65; flex: none; }
/* Letterforms for Bold and Italic only, per the brief -- everything else on
   this bar is a Lucide icon at the shared 13px. */
.studio-bubble-glyph-bold { font-weight: 700; }
.studio-bubble-glyph-italic { font-style: italic; font-size: 13px; }
.studio-bubble-sep { width: 1px; height: 18px; background: var(--studio-line); margin: 0 4px; flex: none; }

/* --- the link editor -------------------------------------------------------
 *
 * The same panel language as the slash menu (raised surface, hairline, the
 * same shadow), because it is the same kind of thing: a small surface the
 * document opens over itself. Two fields stacked, text over target, and the
 * heading list below a rule -- the order the report drew.
 *
 * No transition. The bubble fades in because it appears on a gesture as loose
 * as dragging over a word; this one is opened deliberately and is a FORM, and
 * a form that arrives with a delay is a form whose first keystroke can miss.
 */
.studio-link {
  position: absolute; z-index: 47; width: 320px; max-width: calc(100% - 16px);
  display: flex; flex-direction: column; gap: 5px; padding: 7px;
  background: var(--studio-surface-raised); border: 1px solid var(--studio-line); border-radius: 10px;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--studio-bg) 72%, transparent);
}
.studio-link-row { display: flex; align-items: center; gap: 4px; }
.studio-link-text, .studio-link-href {
  flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 5px 8px;
  border: 1px solid var(--studio-line); border-radius: 7px; outline: none;
  background: var(--studio-bg); color: var(--studio-text);
}
/* The target is a URL or an anchor, which is not prose: monospace makes a
   mistyped scheme or a stray space visible, and it distinguishes the two
   fields from each other at a glance. */
.studio-link-href { font-family: var(--studio-mono); font-size: 12px; }
/* The VALUE of the target field is monospace; its placeholder is a sentence,
   and a sentence set in mono reads as sample input rather than as a prompt. */
.studio-link-text::placeholder { color: var(--studio-muted); }
.studio-link-href::placeholder {
  color: var(--studio-muted); font-size: 12.5px;
  /* The shell's own stack (product-frontend-module.js), spelled out because
     "inherit" on a placeholder inherits the input's font, which is the mono
     this field sets for its value. No backticks in this file. */
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.studio-link-text:focus, .studio-link-href:focus {
  border-color: var(--studio-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--studio-accent) 18%, transparent);
}
.studio-link-btn {
  flex: none; width: 28px; height: 28px; display: grid; place-items: center; padding: 0;
  border: 1px solid transparent; border-radius: 7px; background: transparent;
  color: var(--studio-muted); cursor: pointer;
}
.studio-link-btn svg { width: 14px; height: 14px; }
.studio-link-btn:hover { background: var(--studio-surface); color: var(--studio-text); }
/* Apply is the affirmative action and takes the accent; remove is destructive
   and stays neutral until hovered, where it takes the danger colour. Neither is
   a filled button: this panel has two fields and two controls, and a filled
   primary in a 320px box reads as a dialog. */
.studio-link-btn.go { color: var(--studio-accent); }
.studio-link-btn.go:hover { background: color-mix(in srgb, var(--studio-accent) 14%, transparent); color: var(--studio-accent); }
.studio-link-btn[data-link="remove"]:hover { color: var(--studio-danger); }
.studio-link-targets {
  max-height: 168px; overflow-y: auto; padding-top: 5px; margin-top: 1px;
  border-top: 1px solid var(--studio-line);
}
.studio-link-target { display: flex; align-items: center; gap: 8px; padding: 4px 7px; border-radius: 6px; cursor: pointer; }
.studio-link-target.sel, .studio-link-target:hover { background: var(--studio-selection-bg); }
.studio-link-level {
  flex: none; width: 20px; font-family: var(--studio-mono); font-size: 9.5px;
  letter-spacing: .04em; color: var(--studio-muted);
}
.studio-link-name {
  flex: 1; min-width: 0; font-size: 12.5px; color: var(--studio-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* --- the review rail (comments, changes, history) --- */
/* --- the slot panel -------------------------------------------------------
 *
 * The rail and the assistant panels are ONE panel style. They are different
 * widgets in different parts of the shell — ours is inside the document, the
 * assistants are webviews in Theia's right panel — but they occupy the same slot
 * and must therefore read as the same surface. See SLOT_PANEL_CSS in
 * product-frontend-module.js, which applies the matching half to Theia's panel.
 *
 * A panel separates from the document by TONE plus a hairline, not by a strong
 * rule. Both were white before, so the whole separation rested on a 2.03:1
 * border — which is why every panel edge read as a hard box. A raised surface
 * does that work quietly, and it is the same move already used for the floating
 * comment card ("separates by tone plus elevation").
 */
/*
 * --studio-edge, not --studio-line, and this is a correction.
 *
 * Constraint 24 defines --edge as the boundary between the TOP-LEVEL regions of
 * the window -- "activity bar | left panel | content | right panel". This seam is
 * literally "content | right panel": what sits to the right of it is the slot,
 * whether that is this rail or an assistant's panel. The previous round demoted
 * ten --edge uses at once and swept this one along with the nine that really were
 * interior dividers, which left the document and the slot separated by a
 * hairline at 1.15:1 against the rail's own surface plus a 1.04:1 tone step --
 * measured, and not a boundary. review-rail-regression caught it; that suite had
 * been unrunnable for an unrelated harness reason, which is why nobody noticed.
 *
 * The assistant panel's matching seam in SHELL_CSS takes the same token, because
 * the two occupants of one slot must stay indistinguishable.
 */
.studio-rail {
  width: 0; overflow: hidden; border-left: 1px solid var(--studio-edge); display: flex; flex-direction: column;
  background: var(--studio-surface-raised) !important; flex: none;
}
/* Matches SLOT_PANEL_WIDTH in markdown-editor.js, which resizes Theia's right
   panel to the same value so switching occupants does not reflow the document. */
.studio-rail.open { width: 360px; }
.studio-rail-head {
  display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px 14px; flex: none;
  border-bottom: 1px solid var(--studio-line);
}
.studio-rail-title { flex: 1; font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--studio-muted); }
.studio-rail-list { flex: 1; overflow: auto; padding: 0 12px 12px; }
.studio-rail-empty { font-size: 12.5px; color: var(--studio-muted); line-height: 1.6; padding: 6px 2px; }
/* The waiting twin of .studio-rail-empty above: same box, same voice. It is a
   separate class rather than that one plus a spinner because .studio-loading
   already carries the colour and the caption size, and stacking the two would
   have them argue about padding at equal specificity. */
.studio-rail-loading.studio-loading.inline { padding: 6px 2px; }
.studio-rail-loading .studio-loading-caption { font-size: 12.5px; line-height: 1.6; }
.studio-rail-section {
  font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--studio-muted);
  margin: 10px 2px 6px; padding-top: 8px; border-top: 1px solid var(--studio-line);
}
.studio-rail-list > .studio-rail-section:first-child { padding-top: 8px; margin-top: 2px; }
.studio-rail-toolbar { display: flex; align-items: center; gap: 5px; margin: 8px 0 10px; flex-wrap: wrap; }
.studio-rail-foot-note {
  padding: 8px 14px 12px; font-size: 10.5px; color: var(--studio-muted); border-top: 1px solid var(--studio-line);
  /* overflow-wrap: anywhere, not word-break: break-all — break-all splits at
     whatever character the line happens to end on, which turned the quality
     tab's analyser credit into "\u2026 0.3.0 \u00b7 ev / ery threshold \u2026". This still
     breaks a token that cannot fit on its own (a long path, a URL) and
     otherwise breaks at spaces like prose. */
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; flex: none;
}

/* --- comment threads ---
 * A thread draws no box of its own: it is a row in a conversation, separated
 * from its neighbour by a hairline and by whitespace. Selection is carried by
 * a tinted surface (the same --studio-selection-bg the Projects browser uses
 * for a selected row) rather than by recoloring one hairline, which was not
 * perceptible from across a 360px rail. Message rows, avatars and the quoted
 * anchor come from comment-ui.js, shared with the HTML cards.
 */
.studio-thread {
  position: relative; border: none; border-radius: 10px; padding: 10px 11px 11px;
  margin-bottom: 3px; background: transparent;
  transition: background-color 160ms ease, box-shadow 160ms ease;
}
.studio-thread + .studio-thread::before {
  content: ""; position: absolute; left: 11px; right: 11px; top: -2px; height: 1px;
  background: var(--studio-line); transition: opacity 160ms ease;
}
.studio-thread.active { background: var(--studio-selection-bg); }
.studio-thread.resolved { opacity: .5; }
.studio-thread.resolved .studio-avatar { border-color: var(--studio-muted); color: var(--studio-muted); background: transparent; }
.studio-thread.awaiting { background: var(--studio-selection-bg); box-shadow: 0 0 0 2px var(--studio-focus); }
/* A tinted row owns its whole edge; a rule running into it reads as a seam. */
.studio-thread.active::before,
.studio-thread.awaiting::before,
.studio-thread.active + .studio-thread::before,
.studio-thread.awaiting + .studio-thread::before { opacity: 0; }
.studio-thread-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 9px; }
.studio-thread-quote { flex: 1; min-width: 0; }
.studio-thread-tools { display: flex; gap: 1px; flex: none; }
.studio-thread-note { font-size: 11.5px; color: var(--studio-accent); margin: 0 0 8px 31px; }
.studio-orphan { color: var(--studio-danger); font-weight: 600; }
/* Borderless until focused: an empty reply box does not need to announce
   itself, it needs to announce itself once someone is typing in it. */
.studio-thread textarea {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 6px 8px; resize: vertical;
  border: 1px solid transparent; border-radius: 7px; background: var(--studio-surface-raised); color: var(--studio-text);
  transition: background-color 140ms ease, border-color 140ms ease;
}
.studio-thread textarea:focus, .studio-thread textarea:focus-visible {
  border-color: var(--studio-accent); background: var(--studio-surface); outline: none;
}
.studio-thread.active textarea, .studio-thread.awaiting textarea { background: var(--studio-surface); }
.studio-thread-compose { display: flex; align-items: flex-end; gap: 6px; margin-top: 8px; }
.studio-thread-compose textarea { flex: 1; min-width: 0; }
.studio-resolved-threads { margin-top: 12px; border-top: 1px solid var(--studio-line); }
.studio-resolved-toggle {
  width: 100%; display: flex; align-items: center; justify-content: space-between; border: 0; background: transparent;
  padding: 10px 3px 6px; color: var(--studio-muted); font: inherit; font-size: 11px; letter-spacing: .04em;
  text-transform: uppercase; cursor: pointer;
}
.studio-resolved-toggle:hover { color: var(--studio-text); }
.studio-resolved-list { padding-bottom: 2px; }
.studio-resolved-thread {
  width: 100%; display: flex; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--studio-muted); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.studio-resolved-thread > :last-child { font-size: 10.5px; white-space: nowrap; }
.studio-resolved-thread:hover { background: var(--studio-selection-bg); color: var(--studio-text); }

/* --- proposals --- */
.studio-proposal { margin-bottom: 10px; }
.studio-proposal-title { font-size: 13px; font-weight: 650; line-height: 1.45; }
.studio-proposal-meta { font-size: 10.5px; color: var(--studio-muted); margin-top: 2px; }
.studio-proposal-note { font-size: 11.5px; color: var(--studio-danger); margin-top: 5px; line-height: 1.45; }
.studio-file-row {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; cursor: pointer;
  font: inherit; font-size: 12px; padding: 6px 8px; margin-bottom: 3px; border-radius: 7px;
  border: 1px solid var(--studio-line); background: var(--studio-surface); color: var(--studio-text);
}
.studio-file-row:hover { background: var(--studio-surface-raised); border-color: var(--studio-accent); }
.studio-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.studio-file-count {
  flex: none; font-size: 10.5px; font-weight: 650; min-width: 18px; text-align: center;
  padding: 1px 5px; border-radius: 999px; background: var(--studio-accent); color: #fff;
}

/* --- history --- */
.studio-history { border: 1px solid var(--studio-line); border-radius: 9px; padding: 8px 10px; margin-bottom: 8px; background: var(--studio-surface); }
.studio-history.selected { border-color: var(--studio-accent); box-shadow: 0 0 0 3px var(--studio-focus); }
.studio-history-head { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.studio-history-kind {
  font-size: 10px; letter-spacing: .04em; text-transform: uppercase; font-weight: 650; color: var(--studio-muted);
  padding: 1px 6px; border-radius: 999px; border: 1px solid var(--studio-line);
}
.studio-history-kind.kind-accept, .studio-history-kind.kind-proposal { color: var(--studio-accent); border-color: var(--studio-accent); }
.studio-history-kind.kind-reject { color: var(--studio-danger); border-color: var(--studio-danger); }
.studio-history-title { font-size: 12.5px; line-height: 1.45; }
.studio-history-detail { font-size: 11.5px; color: var(--studio-muted); margin-top: 2px; line-height: 1.45; }
.studio-history-meta { font-size: 10.5px; color: var(--studio-muted); margin-top: 4px; }
.studio-compare { margin-bottom: 12px; }
`;

const EDITOR_CSS = WIDGET_CSS + DIFF_CSS + TRACKED_CSS + DIAGRAM_CSS + FIGURE_CSS + CALLOUT_CSS + MATH_CSS + RAW_CSS + CODE_HIGHLIGHT_CSS;

module.exports = { EDITOR_CSS };
