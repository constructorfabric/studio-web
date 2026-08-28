/*
 * The empty main dock — what the product says when it has nothing to show.
 *
 * WHY THIS EXISTS: with no project connected, the largest region of the window
 * was a blank white rectangle. Everything the product actually is — documents
 * that carry their own review conversation, AI edits that arrive as proposals
 * rather than as saved text, two assistants docked beside the page — was
 * invisible until the user had already connected a project, opened a file and
 * selected some words. The first screen taught nothing and asked for nothing.
 *
 * WHY IT IS NOT A WIDGET. A Welcome tab would put a closable document in the
 * dock that is not a document, give it a tab button, and then have to decide
 * what happens when the user closes it. This is a state of the empty dock, so
 * it is a layer inside the dock's own node, shown exactly when the dock holds
 * no widgets. Same pattern, and the same reason, as the assistant cluster and
 * bottom line: a raw node appended into a shell container, outside Lumino's
 * layout, driven by signals the shell already publishes.
 *
 * ONE ANSWER, not two. This had a second, quieter tier for "a project is
 * connected and nothing is open" — one line and a way back to the file list —
 * on the reasoning that an introduction repeated on every tab close is a
 * lecture. Measured against the running app, that reasoning had the frequencies
 * backwards: `start-local.sh` passes a workspace path, Theia restores the last
 * workspace even without one, so `activeProject` is set before this layer first
 * paints. The quiet tier was every session and the board was reachable only by
 * wiping THEIA_CONFIG_DIR. The tier meant to be the rare case was the only case
 * anybody saw, and the screen that explains the product was dead code.
 *
 * So the board is what an empty dock shows, always. Only the call to action
 * follows the state, because that genuinely differs: with no project the next
 * step is to connect one, and with a project connected it is to pick a file.
 *
 * THE SPECIMENS ARE NOT SCREENSHOTS AND NOT MOCKS. They are the product's own
 * markup and its own classes — .studio-avatar, .studio-bubble, .studio-hunk,
 * .studio-diff-line — so they cannot drift away from the real components the
 * way a picture would. They are inert on purpose: static markup, no handlers,
 * `pointer-events: none`, spans rather than buttons, `aria-hidden`. A control
 * that looks live and does nothing is worse than a drawing.
 *
 * They also read left to right as ONE example, not three unrelated ones: a
 * sentence says Q3, a reviewer asks which quarter, the assistant is asked to
 * fix it, and the resulting edit waits for a yes or a no. That is the whole
 * loop, and it fits on one line of the screen.
 */

const { ICONS } = require('./icons');
const { activeProject } = require('./active-project');

const CONNECT_PROJECT_COMMAND_ID = 'studio.connect-project';
const REPOSITORIES_WIDGET_ID = 'studio-repositories';

/*
 * The leader lines. Drawn rather than composed out of borders, because the
 * turn is the whole point: a straight rule beside a label is a divider, and a
 * line that ends in an arrowhead aimed off the edge is a pointer. One vector
 * language with the rest of the product (viewBox units, round caps, 1px).
 *
 * The direction is not decoration either, and the first version had it wrong.
 * The Projects panel is a full-height column beside the dock, so its leader runs
 * straight out sideways. The settings gear and the terminal are single fields at
 * the two ends of the 22px bottom line, so those two turn down. An arrow that
 * points where the thing is not is worse than no arrow.
 *
 * Which is why there are three leaders now and not four. `tr` named "Comments &
 * AI" and pointed right, at the 48px slot strip -- and that column is gone: the
 * three document views moved into the document's own topbar (which does not
 * exist while the dock is empty, so there is nothing here to point at) and the
 * two assistants moved to the FOOT of the left rail, which is the one direction
 * this leader could not mean. `tr` is kept below rather than deleted, because a
 * fourth region on that side is a plausible thing to want back and rediscovering
 * the geometry is the expensive part.
 */
const LEADERS = {
    tl: '<path d="M47 17H6"/><path d="m11 12-5 5 5 5"/>',
    tr: '<path d="M1 17h41"/><path d="m37 12 5 5-5 5"/>',
    bl: '<path d="M47 17H13a6 6 0 0 0-6 6v3"/><path d="m3 23 4 5 4-5"/>',
    br: '<path d="M1 17h34a6 6 0 0 1 6 6v3"/><path d="m37 23 4 5 4-5"/>'
};

function leaderSvg(corner) {
    return '<svg viewBox="0 0 48 34" fill="none" aria-hidden="true">' + LEADERS[corner] + '</svg>';
}

/*
 * A named region of the shell. The label sits on the inboard side and the
 * leader on the outboard side, so the pair reads as one gesture pointing off
 * the edge of the dock at the thing it names.
 */
function hintHtml(corner, label) {
    const svg = leaderSvg(corner);
    const text = '<span class="studio-welcome-hint-label">' + label + '</span>';
    const leaderFirst = corner === 'tl' || corner === 'bl';
    return '<div class="studio-welcome-hint studio-welcome-hint-' + corner + '">' +
        (leaderFirst ? svg + text : text + svg) + '</div>';
}

/*
 * Specimen 1 — a review thread, exactly as the rail draws it: the quoted anchor
 * underlined in the accent, then the speaker column. The two discs are doing
 * real work here. Outlined is another person and dashed is an agent, and that
 * distinction is never explained anywhere in words, so this is where a new user
 * meets it.
 */
const SPECIMEN_THREAD =
    '<div class="studio-welcome-quote"><span class="studio-quote-text">Ships in Q3.</span></div>' +
    '<div class="studio-msg-row">' +
    '  <span class="studio-avatar">AN</span>' +
    '  <div class="studio-msg-main">' +
    '    <div class="studio-msg-meta"><b>Ana</b> · <time>2h</time></div>' +
    '    <div class="studio-msg-body">Q3 or Q4? Pick one.</div>' +
    '  </div>' +
    '</div>' +
    '<div class="studio-msg-row">' +
    '  <span class="studio-avatar agent">CL</span>' +
    '  <div class="studio-msg-main">' +
    '    <div class="studio-msg-meta"><b>Claude</b> · <time>1h</time></div>' +
    '    <div class="studio-msg-body">Q4 in the plan. Fixed it.</div>' +
    '  </div>' +
    '</div>';

/*
 * Specimen 2 — the selection toolbar over a marked span. This is the product's
 * one gesture for reaching an assistant about a specific piece of text, and it
 * is otherwise undiscoverable: it only appears once you have already selected
 * something.
 */
const SPECIMEN_ASK =
    '<div class="studio-welcome-stage">' +
    '  <p class="studio-welcome-line">The rollout <span class="studio-comment-mark">ships in Q3</span>.</p>' +
    '  <div class="studio-bubble studio-welcome-bubble">' +
    '    <span class="studio-bubble-btn">B</span>' +
    '    <span class="studio-bubble-btn">I</span>' +
    '    <span class="studio-bubble-sep"></span>' +
    '    <span class="studio-bubble-btn comment">Comment</span>' +
    '    <span class="studio-bubble-btn ai">' + ICONS.spark + ' Ask AI</span>' +
    '  </div>' +
    '</div>';

/*
 * Specimen 3 — one reviewable hunk with its two decisions. Same markup as
 * diff-view.js builds, down to the gutter and the word-level marks, because the
 * point being made is that an AI edit arrives HERE and not in the file.
 */
const SPECIMEN_DECIDE =
    '<div class="studio-hunk">' +
    '  <div class="studio-hunk-head">' +
    '    <span class="studio-hunk-index">1 of 1</span>' +
    '    <span class="studio-hunk-summary">1 → 1 lines</span>' +
    '    <span class="studio-hunk-spacer"></span>' +
    '    <span class="studio-icon-btn accept">' + ICONS.check + '</span>' +
    '    <span class="studio-icon-btn danger">' + ICONS.close + '</span>' +
    '  </div>' +
    '  <div class="studio-diff">' +
    '    <div class="studio-diff-line del"><span class="studio-diff-gutter">12</span>' +
    '<span class="studio-diff-sign">-</span>' +
    '<span class="studio-diff-text">Ships in <mark class="studio-diff-word">Q3</mark>.</span></div>' +
    '    <div class="studio-diff-line ins"><span class="studio-diff-gutter"></span>' +
    '<span class="studio-diff-sign">+</span>' +
    '<span class="studio-diff-text">Ships in <mark class="studio-diff-word">Q4</mark>.</span></div>' +
    '  </div>' +
    '</div>';

/*
 * Heading, specimen, consequence. The heading is what you do, the specimen is
 * what it looks like, the line underneath is the part that is not visible in
 * the picture and is the actual reason to care.
 */
const COLUMNS = [
    { head: 'Talk in the doc.', body: SPECIMEN_THREAD, note: 'Comments are files in your repo. They commit with the document.' },
    { head: 'Ask for edits.', body: SPECIMEN_ASK, note: 'Select words, ask Claude or Codex. They read the thread too.' },
    { head: 'Decide what lands.', body: SPECIMEN_DECIDE, note: 'Nothing is written until you accept it. Reject costs one click.' }
];

class WelcomeView {

    init(ctx) {
        this.shell = ctx.shell;
        this.commandRegistry = ctx.commandRegistry;
    }

    mount(attempt = 0) {
        const panel = this.shell && this.shell.mainPanel;
        const container = panel && panel.node;
        if (!container) {
            // Same retry as the slot strip's: the shell's DOM is built by
            // Lumino on its own schedule and there is no event for "the dock
            // node exists".
            if (attempt < 20) { setTimeout(() => this.mount(attempt + 1), 100); }
            else { console.error('[studio] the welcome layer could not find the main dock'); }
            return;
        }
        this.node = document.createElement('div');
        this.node.className = 'studio-welcome';
        this.node.setAttribute('role', 'region');
        this.node.setAttribute('aria-label', 'Getting started');
        this.node.innerHTML = this.html();
        this.node.addEventListener('click', event => this.onClick(event));
        container.appendChild(this.node);

        /*
         * The dock's own membership signals, not the shell's focus events: this
         * layer is answering "is anything open", which changes only when a
         * widget is added to or removed from the dock.
         */
        if (panel.widgetAdded) { panel.widgetAdded.connect(() => this.scheduleRefresh()); }
        if (panel.widgetRemoved) { panel.widgetRemoved.connect(() => this.scheduleRefresh()); }
        // Connecting or disconnecting a project changes which tier is right,
        // and the Projects panel is the one surface that knows.
        activeProject.onChanged(() => this.refresh());
        /*
         * The dock is resized by things this layer never hears about: the
         * Projects panel collapsing, an assistant panel opening, the window
         * itself. Whether the leaders can stay in the corners depends on the
         * size it lands on, so it is re-measured rather than assumed.
         */
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => this.fitHints()).observe(this.node);
        }
        this.refresh();
    }

    html() {
        const columns = COLUMNS.map(column =>
            '<section class="studio-welcome-col">' +
            '  <h3 class="studio-welcome-col-head">' + column.head + '</h3>' +
            '  <div class="studio-welcome-spec" aria-hidden="true">' + column.body + '</div>' +
            '  <p class="studio-welcome-col-note">' + column.note + '</p>' +
            '</section>').join('');

        return hintHtml('tl', 'Your files') +
            hintHtml('bl', 'Project settings') +
            hintHtml('br', 'Terminal &amp; theme') +
            '<div class="studio-welcome-body">' +
            '  <header class="studio-welcome-head">' +
            '    <h2 class="studio-welcome-title" data-welcome-title>' +
            '<span>Write<i>.</i></span> <span>Talk<i>.</i></span> <span>Decide<i>.</i></span></h2>' +
            '    <p class="studio-welcome-lede" data-welcome-lede>' +
            'Documents live in your repository. So does everything said about them.</p>' +
            '    <div class="studio-welcome-cta" data-welcome-cta></div>' +
            '  </header>' +
            '  <div class="studio-welcome-cols">' + columns + '</div>' +
            '</div>';
    }

    /** Coalesced: adding a widget also removes one when a tab is replaced. */
    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 0);
    }

    dockIsEmpty() {
        const panel = this.shell && this.shell.mainPanel;
        if (!panel) { return false; }
        return panel.widgets().next().done === true;
    }

    refresh() {
        if (!this.node) { return; }
        const show = this.dockIsEmpty();
        const connected = !!activeProject.get();

        if (!show) {
            this.node.classList.remove('on', 'in');
            return;
        }

        /*
         * The heading, the lede and the three columns are the same in both
         * states — see the header comment. Only the next step differs.
         */
        this.node.querySelector('[data-welcome-cta]').innerHTML = connected
            ? '<button class="studio-btn" data-act="projects">Show Projects</button>'
            : '<button class="studio-btn primary" data-act="connect">Connect project</button>';

        if (this.node.classList.contains('on')) { this.fitHints(); return; }
        this.node.classList.add('on');
        this.fitHints();
        // One frame between "displayed" and "animating", or the transition has
        // no start value to run from.
        requestAnimationFrame(() => {
            if (this.node && this.node.classList.contains('on')) { this.node.classList.add('in'); }
        });
    }

    /*
     * The leaders are absolutely positioned inside a scrolling layer, so the
     * moment the board is taller than the dock they scroll with it and come to
     * rest across the middle of the content — measured at 980 x 820, where the
     * two bottom labels had landed on the third column's heading. A corner
     * label that is not in a corner is not quiet, it is debris.
     *
     * This is measured rather than set at a breakpoint because whether the
     * board fits depends on how the three notes wrap, which depends on the
     * dock's width AND its height AND the user's font size. A width breakpoint
     * guessed at both ends: an earlier one hid the leaders at 1040px, which,
     * with the Projects panel open on a 1440px window, is every ordinary
     * session — they would never have appeared at all.
     */
    fitHints() {
        if (!this.node || !this.node.classList.contains('on')) { return; }
        const fits = this.node.scrollHeight <= this.node.clientHeight;
        this.node.classList.toggle('no-hints', !fits);
    }

    onClick(event) {
        const target = event.target.closest('[data-act]');
        if (!target) { return; }
        const act = target.getAttribute('data-act');
        if (act === 'connect' && this.commandRegistry) {
            this.commandRegistry.executeCommand(CONNECT_PROJECT_COMMAND_ID);
        } else if (act === 'projects' && this.shell) {
            this.shell.activateWidget(REPOSITORIES_WIDGET_ID);
        }
    }
}

const welcomeView = new WelcomeView();

/*
 * Tokens only, and the two house rules this sheet obeys deliberately:
 *
 *   - --studio-line for every divider here. The columns are separated by a
 *     hairline and by space, NOT by boxes, for the same reason the Project page
 *     stopped boxing its sections: three boxed panels read as three unrelated
 *     apps, and this surface has to read as one product.
 *   - No new hues. The specimens carry the accent only where the real
 *     components already do — the quote underline, the identity disc, the
 *     inserted line, the Ask AI control.
 */
const WELCOME_CSS = `
/* --- the empty main dock -------------------------------------------------- */
.studio-welcome {
  position: absolute; inset: 0; z-index: 1;
  display: none; overflow: auto;
  padding: 40px 34px;
  background: var(--studio-bg); color: var(--studio-text);
  container-type: inline-size;
}
.studio-welcome.on { display: flex; }
/* margin:auto rather than centring on the flex container: a centred flex child
   that outgrows a scroll container has its top clipped and cannot be scrolled
   back to. This centres and still scrolls. */
.studio-welcome-body {
  margin: auto; width: 100%; max-width: 940px;
  opacity: 0; transform: translateY(9px);
  transition: opacity 420ms cubic-bezier(0.16,1,0.3,1), transform 420ms cubic-bezier(0.16,1,0.3,1);
}
.studio-welcome.in .studio-welcome-body { opacity: 1; transform: none; }

/* --- the head ------------------------------------------------------------- */
.studio-welcome-head { text-align: center; }
.studio-welcome-title {
  margin: 0; font-weight: 600; letter-spacing: -.035em; line-height: 1.04;
  font-size: clamp(27px, 4.4cqi, 46px); text-wrap: balance;
}
/* The stops carry the cadence the words are written in, so they are drawn as
   punctuation rather than as part of the word. */
.studio-welcome-title i { font-style: normal; color: var(--studio-muted); }
.studio-welcome-lede {
  margin: 13px auto 0; max-width: 48ch; text-wrap: balance;
  color: var(--studio-muted); font: 400 13.5px/1.6 inherit;
}
.studio-welcome-cta { margin-top: 22px; }
.studio-welcome-cta .studio-btn { padding: 9px 17px; font-size: 12.5px; border-radius: 7px; }
.studio-welcome-cta .studio-btn:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }

/* --- the three columns ---------------------------------------------------- */
.studio-welcome-cols {
  margin-top: 46px; padding-top: 30px; border-top: 1px solid var(--studio-line);
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
}
.studio-welcome-col { padding: 0 26px; border-left: 1px solid var(--studio-line); min-width: 0; }
.studio-welcome-col:first-child { border-left: none; padding-left: 0; }
.studio-welcome-col:last-child { padding-right: 0; }
.studio-welcome-col-head { margin: 0; font: 600 13.5px/1.35 inherit; letter-spacing: -.008em; }
.studio-welcome-col-note {
  margin: 16px 0 0; max-width: 46ch; text-wrap: pretty;
  color: var(--studio-muted); font: 400 12px/1.6 inherit;
}

/* The specimens are inert markup. Nothing here is focusable, hoverable or
   clickable.

   flex-start, not centre: the three drawings are different heights by nature,
   and centring each inside the shared min-height started all three at a
   different y. They hang from one line, and the min-height is what brings the
   three notes back onto one baseline underneath — without boxing the drawings
   to a common size, which is what a card would have done. */
.studio-welcome-spec {
  margin-top: 15px; min-height: 118px;
  display: flex; flex-direction: column; justify-content: flex-start;
  pointer-events: none; user-select: none;
}
.studio-welcome-quote { margin-bottom: 11px; }
.studio-welcome-spec .studio-msg-row:last-of-type { margin-bottom: 0; }
.studio-welcome-spec .studio-hunk { margin-bottom: 0; }

/* The selection toolbar is only ever seen floating just under the words it
   acts on, so the specimen keeps that relationship rather than stacking the two
   as separate blocks. The stage is exactly as tall as the line it wraps. */
.studio-welcome-stage { position: relative; padding-bottom: 42px; }
.studio-welcome-line { margin: 0 0 0 2px; font: 400 14px/1.55 inherit; }
/* A real selection toolbar is one row that never wraps — it floats, so it is
   never made to fit anything. Held to that here, and shrunk instead when the
   column gets narrow: at a 248px column the stock size wrapped "Ask AI" onto a
   second line, which is a shape this control cannot have. */
.studio-welcome-bubble { position: absolute; left: 0; top: calc(100% - 34px); white-space: nowrap; }
@container (max-width: 1060px) {
  .studio-welcome-bubble .studio-bubble-btn { height: 24px; padding: 0 6px; font-size: 11.5px; }
  .studio-welcome-bubble .studio-bubble-sep { margin: 0 2px; }
}

/* --- the leaders ---------------------------------------------------------- */
/* Four labels naming the regions on the other side of the dock's edges. They
   are visible exactly while this layer is, which is only ever when the dock
   holds nothing — so they annotate an empty window and never a working one. */
.studio-welcome-hint {
  position: absolute; display: flex; align-items: center; gap: 7px;
  color: var(--studio-muted); font: 500 10.5px/1 inherit; letter-spacing: .012em;
  pointer-events: none; opacity: 0; transition: opacity 320ms ease 200ms;
}
.studio-welcome.in .studio-welcome-hint { opacity: 1; }
.studio-welcome.in .studio-welcome-hint-tr { transition-delay: 260ms; }
.studio-welcome.in .studio-welcome-hint-bl { transition-delay: 320ms; }
.studio-welcome.in .studio-welcome-hint-br { transition-delay: 380ms; }
.studio-welcome-hint svg {
  width: 48px; height: 34px; flex: none; fill: none;
  stroke: color-mix(in srgb, var(--studio-muted) 44%, transparent);
  stroke-width: 1; stroke-linecap: round; stroke-linejoin: round;
}
.studio-welcome-hint-tl { top: 16px; left: 10px; }
.studio-welcome-hint-tr { top: 16px; right: 10px; }
.studio-welcome-hint-bl { bottom: 16px; left: 10px; }
.studio-welcome-hint-br { bottom: 16px; right: 10px; }

/* --- narrow docks --------------------------------------------------------- */
/* The dock is not the viewport — an assistant panel can halve it — so the
   breakpoints are on the container, not the window. */
/*
 * 720, not 880. The three columns are one sentence read left to right — talk,
 * ask, decide — and stacking them turns it into three unrelated sections. With
 * the Projects panel open on a 1440px window the dock is 890px and this layer's
 * content box is 822, which is the ordinary case, not an edge case; an 880px
 * breakpoint stacked the board for almost every real session. At 822 the
 * columns are ~248px, which the three specimens and their notes still fit.
 */
@container (max-width: 720px) {
  .studio-welcome-cols { grid-template-columns: 1fr; padding-top: 26px; }
  .studio-welcome-col { max-width: 620px; padding: 26px 0 0; margin-top: 26px; border-left: none; border-top: 1px solid var(--studio-line); }
  .studio-welcome-col:first-child { padding-top: 0; margin-top: 0; border-top: none; }
  /* The floor exists to line three notes up across a row. Stacked, there is no
     row, and it becomes a hole under the two shorter drawings. */
  .studio-welcome-spec { min-height: 0; }
}
/*
 * The leaders, hidden by whichever of two conditions bites first.
 *
 * Stacked, the board runs the full width of the dock all the way to the
 * bottom, so the two lower labels sit on top of the last column whether or not
 * anything scrolls — that one is a layout fact and belongs in the query.
 * Whether an unstacked board is short enough to leave the corners free is not,
 * so .no-hints is set by fitHints() from a measurement. See its comment.
 */
@container (max-width: 720px) { .studio-welcome-hint { display: none; } }
.studio-welcome.no-hints .studio-welcome-hint { display: none; }

@media (prefers-reduced-motion: reduce) {
  .studio-welcome-body { transform: none; transition-duration: 1ms; }
  .studio-welcome-hint { transition-duration: 1ms; transition-delay: 0ms; }
  .studio-welcome.in .studio-welcome-hint-tr,
  .studio-welcome.in .studio-welcome-hint-bl,
  .studio-welcome.in .studio-welcome-hint-br { transition-delay: 0ms; }
}
`;

module.exports = { welcomeView, WELCOME_CSS };
