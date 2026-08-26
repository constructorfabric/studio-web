/*
 * The slot's selector: two icon clusters, one vocabulary.
 *
 * HISTORY, because this file is the second answer to the same question and the
 * first one is worth keeping. Design review 02 (option B) took the five ways to
 * fill the right of the window out of a segmented pill in the DOCUMENT topbar
 * and made them a vertical STRIP in the 48px right-hand column, for three
 * measured reasons:
 *
 *   - the 49 x 978 right column was on screen permanently with zero visible
 *     children, while the selector it could hold was 357px crammed into a 43px
 *     row (D11);
 *   - one segmented control spanned two scopes: Comments/Changes/History belong
 *     to the open document and die with it, Claude/Codex are app-level panels
 *     that outlive it (D15);
 *   - its membership changed per surface — five entries on Markdown, two on
 *     HTML — which a segmented control promises it will not do (D15).
 *
 * WHAT CHANGED, and why the strip did not survive. Filling the column stopped
 * it being empty but did not stop it COSTING: 48px of window, permanently, for
 * five buttons — and it made the closed state expensive rather than free, since
 * .studio-rail is already `width: 0` when shut. So the buttons moved again and
 * the column went away entirely:
 *
 *   - the three DOCUMENT destinations are a cluster at the right end of the
 *     document's own topbar, rendered by the surface that owns them (a bar the
 *     document already pays for, next to the save status);
 *   - the two APP-LEVEL assistants are entries in the LEFT activity rail's
 *     navigation column, mounted here — because they outlive the open document
 *     and a per-document toolbar cannot reach them when no document is open;
 *   - Theia's right sidebar column is hidden at the Lumino level, so a closed
 *     panel costs the document nothing at all. See hideRightSlotColumn.
 *
 * AND ONE MORE MOVE, reported from use. The assistants first landed at the FOOT
 * of that rail, as a 28px cluster under a full-bleed hairline, ~800px below the
 * one thing above them. Two things were wrong with it and only one was visual:
 * the cluster was hard-coded to hold exactly these two, so a third extension had
 * nowhere to go ("in terms of extensions it will break in future when user will
 * need more extensions"). They are now ordinary members of the rail's extensions
 * group, directly under Search — see rail-nav.js, which owns the column and the
 * separator, and which any future extension claims the same way this does. What
 * did NOT move is the mechanism: these are still not Lumino tabs (see below),
 * they still route through choose(), and the panels still open in the slot.
 *
 * The strip's three invariants all survive intact, which is why this is a move
 * and not a rewrite:
 *
 *   - MEMBERSHIP IS FIXED. ENTRIES below is still one list of five in one
 *     reading order. What varies is enablement: an entry the active surface
 *     cannot serve is marked unavailable and says why in its tooltip. A disabled
 *     destination is honest; one that silently disappears teaches people the
 *     product is inconsistent.
 *   - NOT LUMINO TABS. A Lumino TabBar can only hold the titles of real widgets,
 *     and three of these five are not widgets — they are views rendered INSIDE
 *     the document widget, one rail per document, holding that document's own
 *     drafts, open threads and gutter links. Hoisting them into shell-level
 *     widgets would mean one rail that has to follow the active document and
 *     re-bind all of that state on every tab switch. Raw nodes keep
 *     per-document state where it belongs.
 *   - NO SLOT STATE HERE. This module reads the active surface's slotState() and
 *     calls that surface's own selectSlot(), so the exclusivity rule stays in
 *     the one choke point it already lived in (constraint 20).
 *
 * The labels are the one deliberate loss. The strip carried 8.5px words because
 * a 48px column has room for nothing else and icon-only in a brand new place
 * would have traded one reported problem ("I can't open codex") for a quieter
 * version of it. In a 42px topbar, at 18px, beside a save status, there is no
 * room for words and no need for them: a tooltip carries the name.
 */

const { ICONS } = require('./icons');
const { railNav } = require('./rail-nav');
const { revealAssistant, collapseRightPanel, currentAssistant, assistantForKey, zeroRightPanelSlot } = require('./ai-context');
const { fileTypeSettings } = require('./file-type-settings');

/*
 * Fixed membership, in reading order: what is in the document, then who you can
 * ask about it. `kind` is the scope, and it decides two things — which cluster
 * an entry renders in, and what happens when no document is open (a document
 * view has nothing to show, an assistant does).
 *
 * ONE list, still, rather than two constants that happen to agree. The scope
 * boundary the strip drew as a hairline is now the boundary between the two
 * clusters, so it is derived from this data exactly as the hairline was.
 */
const ENTRIES = [
    { key: 'comments', label: 'Comments', icon: ICONS.docComment, kind: 'document' },
    { key: 'changes', label: 'Changes', icon: ICONS.changes, kind: 'document' },
    { key: 'history', label: 'History', icon: ICONS.history, kind: 'document' },
    /*
     * Quality, the fourth document destination — and the first test of the claim
     * this file's header makes, that adding one is a line here and nothing
     * anywhere else. It was: this row, one glyph in icons.js, one key in
     * SLOT_SHORTCUTS, and the rail's own render method. Nothing in this file
     * changed except the length of the list.
     *
     * `kind: 'document'` because it dies with the document that owns it. The
     * project-scope half of the same feature is a closable tab in the main dock
     * (quality-project-view.js), reached from the extensions group of the
     * activity rail — the same split Search made, and for the same measured
     * reason: a 16-file occurrence list plus source context does not fit a 360px
     * column.
     */
    { key: 'quality', label: 'Quality', icon: ICONS.gauge, kind: 'document', gated: 'qualitySignals' },
    /*
     * `brand` is the vendor's own colour, and it is a field on the entry rather
     * than a rule in a stylesheet so that adding the next extension is one line
     * HERE and nothing anywhere else -- which is the whole ask behind this
     * arrangement ("it should be standard approach for any new extensions").
     * rail-nav.js reads it as --studio-brand and paints the mark with it on hover
     * and while the panel is open; at rest every extension is --studio-muted like
     * the rest of the rail. See the long note in RAIL_NAV_CSS.
     *
     * Codex takes --studio-text rather than a hex: OpenAI's mark IS monochrome --
     * the extension ships a black and a white copy of it and picks by theme --
     * so the product's ink token is not a fallback here, it is the right answer,
     * and it follows the theme toggle for free.
     */
    { key: 'claude', label: 'Claude', icon: ICONS.claudeMark, brand: '#d97757', kind: 'app' },
    { key: 'codex', label: 'Codex', icon: ICONS.codexMark, brand: 'var(--studio-text)', kind: 'app' }
];

const DOC_ENTRIES = ENTRIES.filter(entry => entry.kind === 'document');
const APP_ENTRIES = ENTRIES.filter(entry => entry.kind === 'app');

/*
 * A destination that belongs to an OPTIONAL feature.
 *
 * `gated` on an entry names a project setting, and an entry whose setting is off
 * is not rendered at all — it is not a disabled button with a hint, the way an
 * unavailable-here destination is. The distinction is the point: "Quality does
 * not work on this file type" is information, and "Quality exists but this
 * project has not asked for it" is furniture. A person who never turns the
 * feature on should not be able to tell it was compiled in.
 *
 * Read per FILE where we have one, because the setting is per project and two
 * documents from different roots can be open side by side. `choose` has no file
 * (the shortcut is app-level), so it falls back to the active project.
 */
const FEATURE_GATES = {
    qualitySignals: uri => (uri
        ? fileTypeSettings.qualitySignalsForFile(uri)
        : fileTypeSettings.qualitySignalsActive())
};

function featureOn(entry, uri) {
    return !entry.gated || !!(FEATURE_GATES[entry.gated] && FEATURE_GATES[entry.gated](uri));
}

function offeredEntries(entries, uri) {
    return entries.filter(entry => featureOn(entry, uri));
}

/*
 * Why an entry is off, in the words of the situation rather than one generic
 * message — a disabled control that cannot say why is only marginally better
 * than one that vanishes.
 *
 * `comments` needs two answers, because there are two reasons: no document is
 * open at all, or the open document is a rendered page, where comments exist but
 * are cards anchored over the page rather than a panel in the slot. The first
 * version of this shipped the no-document wording on an open HTML document,
 * which told the user something plainly untrue.
 */
const UNAVAILABLE_HINT = {
    changes: 'Change review is only available for Markdown documents',
    history: 'History is only available for Markdown documents',
    quality: 'Specification signals are only available for Markdown documents',
    comments: 'Open a document to comment on it'
};

/*
 * A surface that cannot serve a destination says so IN ITS OWN WORDS, through
 * its optional slotHints(). This used to be one SURFACE_HINT table here, holding
 * the rendered-page wording for `comments` — and that was fine while exactly one
 * surface needed it. The moment a third surface got a cluster (the CSV grid,
 * which cannot anchor a comment to a row) that table started handing it the HTML
 * viewer's sentence, which was plainly untrue: a fallback shared by every
 * surface can only be right for the one it was written for.
 *
 * So the tables below are the generic last resort, and anything surface-specific
 * lives with the surface. UNAVAILABLE_HINT's `comments` line is the no-document
 * case, which belongs to no surface by definition.
 */

const SLOT_STRIP_CSS = `
/* --- the slot clusters ---------------------------------------------------- *
 *
 * What is left in this block is the DOCUMENT cluster: three entries in the
 * document's own topbar, rendered by the surface that owns them (see
 * renderDocCluster). Its placement rules live in editor-css.js with the rest of
 * .studio-doc-topbar; the button itself is here, because this file renders it.
 *
 * The two assistants used to share this vocabulary, as a second cluster with the
 * same 28px tile at the foot of the left rail. They no longer do, and that is a
 * deliberate split rather than drift: in the rail they are EXTENSIONS, sitting in
 * a column of 34px rail controls next to Search, and they take that column's
 * language (.studio-rail-btn plus .studio-ext-btn, styled in rail-nav.js) for the
 * same reason they took this one before — a control should look like where it is.
 * One vocabulary per host, not one vocabulary stretched over two.
 */
.studio-slot-cluster {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  /* What the count badge's ring is drawn in: the tone of the bar the button
     sits on, so the pill reads as sitting ON the bar rather than floating.
     Each host overrides it; .on overrides it again. */
  --studio-slot-ring: var(--studio-surface-raised);
}
/* --studio-muted at rest, which is the opposite of the strip's choice and for a
   reason that reversed with the labels: an 8.5px word is normal text and wanted
   AA's 4.5:1, so the strip used --studio-text. There is no text here. These are
   18px glyphs — non-text contrast, 3:1 — and muted measures 4.05:1 on this band,
   comfortably over. Resting icons at full text weight would have made a topbar
   of three loud buttons next to a quiet save status. */
.studio-slot-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: none; border-radius: 7px;
  background: transparent; color: var(--studio-muted); cursor: pointer;
  font: inherit; position: relative; flex: none;
  transition: background-color 140ms ease, color 140ms ease;
}
.studio-slot-btn svg { width: 18px; height: 18px; display: block; }
.studio-slot-btn:hover:not(.off) { background: var(--studio-surface-sunken); color: var(--studio-text); }
.studio-slot-btn:active:not(.off) { transform: scale(.94); }
.studio-slot-btn:focus-visible { outline: 2px solid var(--studio-amber); outline-offset: -2px; }
/* OPEN means "the panel is showing this", and it is the accent doing the work in
   both channels at once: a selection-tinted tile AND an accent glyph. The strip
   deliberately kept its label in --studio-text on a mixed tile, because tiny
   text on a tinted ground needs contrast more than colour. An 18px stroke glyph
   does not have that problem, so the state can be as unambiguous as it is.
   --studio-selection-bg rather than a color-mix of amber: it is the product's
   existing "this one is current" ground, already themed in both palettes. */
.studio-slot-btn.on {
  background: var(--studio-selection-bg); color: var(--studio-amber);
  --studio-slot-ring: var(--studio-selection-bg);
}
.studio-slot-btn.on:hover { background: var(--studio-selection-bg); color: var(--studio-amber); }
/* Unavailable, NOT removed, and not the HTML disabled attribute either.
 *
 * The whole point of fixed membership is that the entry stays reachable enough
 * to explain itself, and the disabled attribute drops a button out of the tab
 * order — so a keyboard user would get the vanishing-entry behaviour this design
 * exists to avoid. aria-disabled says the same thing to assistive tech, keeps
 * the tooltip and the focus ring, and the click handlers below ignore it. ~45%
 * of muted: still legibly a glyph, unmistakably not a target. */
.studio-slot-btn.off {
  color: color-mix(in srgb, var(--studio-muted) 45%, transparent);
  cursor: default;
}
/* THE BADGE IS LOAD-BEARING. With the panel absent by default it is the only
   thing on screen saying a document has open threads or pending hunks
   (constraint 22: closing the slot hides document-scope threads, which have no
   gutter mark). Ringed in the bar's own tone so a 13px pill reads over an 18px
   glyph without either becoming unreadable. */
.studio-slot-count {
  position: absolute; top: 0; right: 0; box-sizing: border-box;
  min-width: 13px; height: 13px; padding: 0 3px;
  border-radius: 999px; background: var(--studio-amber); color: var(--studio-bg);
  font-size: 9px; line-height: 13px; font-weight: 700; text-align: center;
  box-shadow: 0 0 0 1.5px var(--studio-slot-ring);
  pointer-events: none;
}

/* --- and the right-hand column, gone -------------------------------------- *
 *
 * The OTHER half of hideRightSlotColumn, and neither half works alone. This is
 * shell chrome living in this file because it is inseparable from that call; if
 * it ever wants to be SHELL_CSS instead, it moves as one line.
 *
 * Theia's sidepanel.css pins a collapsed side panel to the activity bar's width:
 *
 *   #theia-right-content-panel.theia-mod-collapsed { max-width: 48px }
 *
 * and the BoxLayout inside it writes min-width: 48px on the same node while the
 * sidebar container is visible. Measured against how Lumino resolves that pair:
 *
 *   - CSS alone (max-width: 0) loses, because BoxSizer honours minSize over
 *     maxSize, so the 48px min-width from the layout wins and the column stays;
 *   - hide() alone loses too, because it only takes the MIN away. The sizer's
 *     desired width is whatever the slot was last resized to (360), the max is
 *     still 48, and 48 is what you get -- an empty 48px column, which is exactly
 *     the state this whole change exists to remove.
 *
 * So: hide() drops the floor, this drops the ceiling, and the panel is 0.
 * !important is not specificity padding — it is insurance against style-loader
 * deciding to inject Theia's sheet after this one.
 */
#theia-right-content-panel.theia-mod-collapsed { max-width: 0 !important; }
/*
 * ...and its seam with it. SHELL_CSS draws the slot's left edge on the panel's
 * content child, which is correct while an assistant is IN the slot: it is the
 * same boundary .studio-rail draws, and the two occupants of one slot have to be
 * indistinguishable. But a 1px border on a 0-width box is still a 1px box, and
 * measured that is exactly what the window had left of it -- "right panel 1px"
 * where the claim is that an empty slot costs the document nothing. An edge
 * belongs to a panel that is showing something.
 */
#theia-right-content-panel.theia-mod-collapsed > .lm-BoxPanel-child { border-left: 0 !important; }
`;

/* Attributes are built into innerHTML, and a tooltip is the only field here a
   translator or a future entry could put a quote into. */
function attr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/*
 * One button, whichever cluster it is in.
 *
 * `data-studio-rail` is kept from the strip on purpose: it is the product's name
 * for "a slot destination", the two document surfaces and this module all
 * dispatch on it, and the regression probes already know it. Renaming it would
 * have been churn with no reader on the other side.
 */
/*
 * The two hosts, as data. `doc` is the topbar's 28px tile; `ext` is a member of
 * the left rail's navigation column, so it speaks .studio-rail-btn — the
 * product's icon-button language for chrome controls, which Search in the same
 * column already speaks — plus .studio-ext-btn for the vendor-colour states.
 *
 * A table rather than an if: the difference between the two hosts is a class
 * name and whether the entry's brand colour is written, and stating that as two
 * fields is what stops a third host being added as a third branch.
 */
const VARIANTS = {
    doc: { className: 'studio-slot-btn', branded: false },
    ext: { className: 'studio-rail-btn studio-ext-btn', branded: true }
};

function buttonHtml(entry, { on, enabled, count, hint }, variant) {
    // A brand colour is only ever a value this file wrote (see ENTRIES), but it
    // goes through attr() anyway: it lands in an attribute, and "only literals
    // we control" is a property of today's data, not of the code.
    const brand = variant.branded && entry.brand
        ? ' style="--studio-brand: ' + attr(entry.brand) + '"'
        : '';
    return '<button type="button" class="' + variant.className + (on ? ' on' : '') + (enabled ? '' : ' off') + '"' +
        ' data-studio-rail="' + entry.key + '"' + brand +
        ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (enabled ? '' : ' aria-disabled="true"') +
        ' title="' + attr(hint) + '" aria-label="' + attr(entry.label) + '">' +
        entry.icon +
        (count ? '<span class="studio-slot-count">' + count + '</span>' : '') +
        '</button>';
}

function clusterHtml(entries, { active, capabilities, counts, hints }, variant = VARIANTS.doc) {
    return entries.map(entry => {
        const enabled = capabilities.includes(entry.key);
        const on = enabled && active === entry.key;
        const count = enabled && counts[entry.key] ? counts[entry.key] : 0;
        const hint = enabled
            ? (entry.kind === 'app' ? 'Ask ' + entry.label + ' about this document' : entry.label)
            : ((hints && hints[entry.key]) || UNAVAILABLE_HINT[entry.key]
                || entry.label + ' is not available here');
        return buttonHtml(entry, { on, enabled, count, hint }, variant);
    }).join('');
}

/**
 * Paint a document surface's own cluster: Comments, Changes, History.
 *
 * Called by the surface, from wherever it already repaints its slot state, and
 * given the same slotCapabilities()/slotState() the strip used to read off it —
 * so a surface that adds a destination or a count needs no change here. The
 * assistants are NOT in this cluster: they outlive the document (see the header).
 *
 * Exported as a function rather than folded into the singleton because there is
 * one of these per open document, and the singleton is deliberately not keeping
 * a list of live widgets it would then have to prune on dispose.
 */
function renderDocCluster(node, surface) {
    if (!node) { return; }
    const state = (surface && surface.slotState && surface.slotState()) || {};
    const capabilities = surface && typeof surface.slotCapabilities === 'function'
        ? surface.slotCapabilities()
        : [];
    node.innerHTML = clusterHtml(offeredEntries(DOC_ENTRIES, surface && surface.uri), {
        active: state.active,
        capabilities,
        counts: state.counts || {},
        // Optional: a surface that can explain its own gaps does, and one that
        // cannot falls through to the generic wording above.
        hints: surface && typeof surface.slotHints === 'function' ? surface.slotHints() : undefined
    });
}

/*
 * Give the 48px right-hand column back, at the LUMINO level.
 *
 * A stylesheet cannot do this. The column is `theia-app-sidebar-container`, a
 * Panel inside the BoxLayout of #theia-right-content-panel, and BoxLayout
 * positions its children with inline top/left/width/height — so `width: 0` in
 * CSS is overwritten on the next fit, and `display: none` leaves the box
 * allocated (the same lesson SHELL_CSS records for the status bar: hiding a
 * BoxPanel child in CSS does not make it give back its box).
 *
 * Widget.hide() is the call that works, because BoxLayout SKIPS hidden children
 * when it fits and when it lays out, and because hiding a child sends
 * ChildHidden to the parent layout, which re-fits and drops the 48px from the
 * panel's own min-width — which is what let the split panel hold it open.
 *
 * WHAT MUST NOT HAPPEN: the tab bar must stay in the DOM. It is a child of this
 * container, so it stays attached and keeps its signals — and
 * rightPanelHandler.tabBar.currentChanged is how three surfaces learn that an
 * assistant opened or closed (constraint 20). Lumino signals do not care about
 * visibility, which is exactly why this is hide() on the container rather than
 * removing anything.
 *
 * SidePanelHandler.refresh() never touches this container (it sets hidden on the
 * OUTER container, the tab bar and the dock panel), so the hide survives every
 * expand and collapse and only has to be applied once per window.
 *
 * HALF THE FIX. This drops the panel's minimum width; Theia's collapsed max-width
 * of 48px still pins it. The other half is the .theia-mod-collapsed rule at the
 * end of SLOT_STRIP_CSS above, which explains the pair in full. Neither works
 * alone, and each looks like it should.
 */
function rightSlotColumn(shell) {
    const handler = shell && shell.rightPanelHandler;
    const box = handler && handler.container;
    const layout = box && box.layout;
    if (!layout || !layout.widgets) { return undefined; }
    return [...layout.widgets].find(w => w.hasClass && w.hasClass('theia-app-sidebar-container'));
}

function hideRightSlotColumn(shell) {
    try {
        const column = rightSlotColumn(shell);
        if (column && !column.isHidden) { column.hide(); }
        return !!column;
    } catch (e) {
        console.error('[studio] could not hide the right sidebar column', e);
        return false;
    }
}

/** The reverse, for whoever ever needs Theia's right activity bar back. */
function showRightSlotColumn(shell) {
    try {
        const column = rightSlotColumn(shell);
        if (column && column.isHidden) { column.show(); }
    } catch (e) {
        console.error('[studio] could not show the right sidebar column', e);
    }
}

class SlotStrip {

    /** Wired once from ProductChromeContribution; a singleton, like fileTypeSettings. */
    init({ shell, commandRegistry, messageService }) {
        this.shell = shell;
        this.commandRegistry = commandRegistry;
        this.messageService = messageService;
    }

    /*
     * The right-hand column is hidden from here rather than from the caller
     * because the two are one change: the assistants have a home in the left
     * rail, so the column they used to live in can go. Doing them together means
     * there is no window in which neither is true.
     *
     * This used to take an `attempt` and retry itself for ~2s, because a cluster
     * that failed to mount took BOTH assistants with it -- Theia's right-hand tab
     * bar is hidden, so these buttons are the only route to Claude or Codex when
     * no document is open. That retry has not gone away, it has MOVED: rail-nav.js
     * owns it, once, for every occupant of the column rather than once per caller.
     */
    mount() {
        if (!this.shell) { return; }
        hideRightSlotColumn(this.shell);
        /*
         * And give the slot's WIDTH back, once, at startup.
         *
         * Hiding the column removes 48px of chrome; it does not move the split
         * handle, and a restored layout arrives with the last session's slot
         * width still allocated to a panel that is now showing nothing. Measured
         * on a fresh launch: 265px of window to the right of the document,
         * belonging to no widget.
         *
         * Only when nothing is expanded, because a restored layout may
         * legitimately have an assistant open -- zeroing that would collapse a
         * panel the user left open.
         */
        if (!currentAssistant(this.shell)) {
            zeroRightPanelSlot(this.shell);
            /*
             * ...and again on the next frame. The desktop shell collapses both
             * side panels of its own accord at startup, and a collapse leaves
             * Theia's DEFAULT share (measured: 265px of a 1395px window) sitting
             * in the split handle. Whether that collapse runs before or after
             * this tick is not ours to order, so the second pass is the cheap way
             * not to depend on it -- zeroing is idempotent and returns
             * immediately once the share is already nothing.
             */
            requestAnimationFrame(() => {
                if (!currentAssistant(this.shell)) { zeroRightPanelSlot(this.shell); }
            });
        }
        if (this.claimed) { return; }
        this.claimed = true;
        /*
         * The rail's extensions group, claimed exactly as any later extension
         * would claim it. This module supplies the entries and the click
         * handling; rail-nav.js supplies the column, the separator above it and
         * the retry that finds the shell's DOM.
         *
         * The listener is delegated onto the group rather than bound per button
         * because refresh() replaces the innerHTML on every slot transition --
         * per-button listeners would be re-attached a few times a minute and the
         * group node outlives all of them.
         */
        railNav.claim('extensions', group => {
            this.node = group;
            this.node.setAttribute('aria-label', 'Assistants');
            this.node.addEventListener('click', event => {
                const button = event.target.closest('[data-studio-rail]');
                if (button && button.getAttribute('aria-disabled') !== 'true') {
                    this.choose(button.getAttribute('data-studio-rail'));
                }
            });
            this.listen();
            this.refresh();
        });
    }

    /*
     * What moves this cluster's state without it being involved. Split out of
     * mount() only because the claim above is a callback: everything here needs
     * the group to exist first, and nothing here is about the group.
     */
    listen() {
        /*
         * Two things move this cluster's state without it being involved:
         * switching document tabs (a different document, a different slot) and
         * an assistant panel opening or closing on its own. Both are signals
         * ApplicationShell already publishes.
         */
        if (this.shell.onDidChangeCurrentWidget) {
            this.shell.onDidChangeCurrentWidget(() => this.scheduleRefresh());
        }
        /*
         * The main dock's OWN events, not just the shell's, and all of them
         * deferred by a tick.
         *
         * `ApplicationShell.onDidChangeCurrentWidget` is focus-driven, and
         * activating a widget programmatically does not always move focus — so
         * opening the Project page left the selector still describing the
         * document it had replaced. Measured: with the page frontmost and
         * visible, and the dock tab marked current, it had not refreshed at all.
         *
         * `TheiaDockPanel.onDidChangeCurrent` is the event that actually tracks
         * which tab is current (Lumino's DockPanel has no `currentChanged` — that
         * belongs to TabBar, which is why an earlier attempt at this connected
         * nothing and failed silently). `widgetActivated` covers activation
         * without a current-title change. Both are guarded, because they are
         * Theia-specific rather than Lumino API.
         */
        const mainPanel = this.shell.mainPanel;
        if (mainPanel) {
            if (mainPanel.onDidChangeCurrent) { mainPanel.onDidChangeCurrent(() => this.scheduleRefresh()); }
            if (mainPanel.widgetActivated) { mainPanel.widgetActivated.connect(() => this.scheduleRefresh()); }
        }
        const tabBar = this.shell.rightPanelHandler && this.shell.rightPanelHandler.tabBar;
        if (tabBar) { tabBar.currentChanged.connect(() => this.scheduleRefresh()); }
    }

    /*
     * The document currently in the main area — NOT shell.currentWidget, which
     * follows focus and so returns the assistant's webview the moment you click
     * into it, making the selector forget which document it is describing.
     */
    activeSurface() {
        if (!this.shell) { return undefined; }
        let widget;
        try { widget = this.shell.getCurrentWidget('main'); }
        catch (e) { widget = undefined; }
        return widget && typeof widget.selectSlot === 'function' && typeof widget.slotState === 'function'
            ? widget : undefined;
    }

    /** Coalesced, and one tick late, so the shell has finished switching. */
    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 0);
    }

    /*
     * Repaint the assistant cluster. Still called `refresh` and still the whole
     * handoff from a document surface, so table-editor.js and the HTML viewer
     * need no change: what a document changes about the ASSISTANTS is which one
     * is open, and that is read from the shell here, not passed in.
     *
     * Each surface repaints its own three-entry cluster (renderDocCluster) from
     * wherever it already repaints its rail, because that cluster lives in that
     * widget's node and dies with it.
     */
    refresh() {
        if (!this.node) { return; }
        /*
         * The standing guarantee that an empty slot costs the document nothing.
         *
         * refresh() already runs on every signal that can change what occupies
         * the slot -- the right tab bar's currentChanged, the main dock's current
         * widget, widget activation -- so it is the one place that sees every
         * transition into "nothing is in there". Zeroing here is idempotent and
         * returns immediately when the share is already nothing, and it can
         * never fight a user dragging the sash: while the slot is empty there is
         * no panel on screen to drag.
         */
        if (!currentAssistant(this.shell)) { zeroRightPanelSlot(this.shell); }
        const surface = this.activeSurface();
        const capabilities = surface && typeof surface.slotCapabilities === 'function'
            ? surface.slotCapabilities()
            : ['claude', 'codex'];          // no document open: the assistants still work
        this.node.innerHTML = clusterHtml(APP_ENTRIES, {
            active: currentAssistant(this.shell),
            capabilities,
            counts: {}
            // No hints: both entries in this cluster are always available, and
            // an assistant that is not installed is not in ASSISTANTS at all.
        }, VARIANTS.ext);
    }

    /*
     * THE one entry point for "put this in the slot", used by both clusters and
     * by the keybindings. It does not decide anything itself: the active
     * surface's selectSlot() is the choke point (constraint 20), and picking
     * whatever is already open closes it, which is what makes a shortcut a
     * toggle for free.
     */
    choose(key) {
        const surface = this.activeSurface();
        /*
         * The keyboard reaches destinations the cluster is not drawing, so the
         * gate is enforced here too rather than only where buttons are painted.
         * Silently doing nothing is right for a chord: with the feature off
         * there is no surface to explain, and Opt+Cmd+Q on a project that does
         * not use quality signals should behave as if the shortcut was never
         * bound.
         */
        const entry = ENTRIES.find(candidate => candidate.key === key);
        if (entry && !featureOn(entry, surface && surface.uri)) { return; }
        if (surface) { surface.selectSlot(key); this.refresh(); return; }
        // No document open. Document views have nothing to show, but an
        // assistant is app-level and can still be opened -- and re-picking the
        // one already there closes the panel, matching the document surfaces'
        // own toggle behaviour.
        if (!assistantForKey(key)) { return; }
        if (currentAssistant(this.shell) === key) { collapseRightPanel(this.shell); this.refresh(); return; }
        revealAssistant({
            shell: this.shell,
            commandRegistry: this.commandRegistry,
            messageService: this.messageService,
            key
        }).then(() => this.refresh());
    }
}

const slotStrip = new SlotStrip();

module.exports = {
    slotStrip, SLOT_STRIP_CSS,
    renderDocCluster,
    hideRightSlotColumn, showRightSlotColumn,
    SLOT_STRIP_ENTRIES: ENTRIES,
    slotFeatureOn: (key, uri) => {
        const entry = ENTRIES.find(candidate => candidate.key === key);
        return !entry || featureOn(entry, uri);
    },
    SLOT_DOC_ENTRIES: DOC_ENTRIES,
    SLOT_APP_ENTRIES: APP_ENTRIES
};
