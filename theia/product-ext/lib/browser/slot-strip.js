/*
 * The right-hand slot's own tab strip — one home for all five destinations.
 *
 * Decided from design review 02 (option B). Before this, the five ways to fill
 * the right of the window lived in a segmented pill inside the DOCUMENT topbar,
 * which had three problems that measurement made concrete:
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
 * So the strip is SHELL-level and its membership is FIXED at five. What varies
 * is enablement: an entry the active surface cannot serve is disabled and says
 * why in its tooltip. A disabled destination is honest; a destination that
 * silently disappears teaches people the product is inconsistent.
 *
 * Why a raw DOM node rather than Lumino tabs: a Lumino TabBar can only hold the
 * titles of real widgets, and three of these five are not widgets — they are
 * views rendered INSIDE the document widget, one rail per document, holding that
 * document's own drafts, open threads and gutter links. Hoisting them into
 * shell-level widgets would mean one rail that has to follow the active document
 * and re-bind all of that state on every tab switch. This keeps per-document
 * state where it belongs and still puts all five in one place. The same pattern
 * (a raw node appended into .theia-app-sidebar-container, outside Lumino's
 * layout) already anchors the left rail's utility cluster, and survives Theia's
 * own re-layout for the same reason.
 *
 * The strip does not own slot state. It reads the active surface's state and
 * calls the surface's own selectSlot(), so the exclusivity rule stays in the one
 * choke point it already lived in (constraint 20).
 */

const { ICONS } = require('./icons');
const { revealAssistant, collapseRightPanel, currentAssistant, assistantForKey } = require('./ai-context');

/*
 * Fixed membership, in reading order: what is in the document, then who you can
 * ask about it. `kind` is the scope, and it decides what happens when no
 * document is open — a document view has nothing to show, an assistant does.
 */
const ENTRIES = [
    { key: 'comments', label: 'Comments', icon: ICONS.docComment, kind: 'document' },
    { key: 'changes', label: 'Changes', icon: ICONS.changes, kind: 'document' },
    { key: 'history', label: 'History', icon: ICONS.history, kind: 'document' },
    { key: 'claude', label: 'Claude', icon: ICONS.spark, kind: 'app' },
    { key: 'codex', label: 'Codex', icon: ICONS.brackets, kind: 'app' }
];

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
    comments: 'Open a document to comment on it'
};

const SURFACE_HINT = {
    comments: 'Comments on a rendered page are cards on the page — use Comment mode'
};

const SLOT_STRIP_CSS = `
/* --- the slot strip ------------------------------------------------------- *
 * Sits in the 48px right column, which was previously empty. Entries are icon
 * plus a small label: the pills this replaces carried words, and dropping to
 * icon-only would have traded one reported problem ("I can't open codex") for
 * a quieter version of the same one.
 */
.studio-slot-strip {
  position: absolute; top: 0; left: 0; width: 48px;
  display: flex; flex-direction: column; align-items: stretch;
  padding: 4px 0; gap: 2px; z-index: 3;
}
/* --studio-text, not --studio-muted, and measured rather than chosen: muted on
   this band is 4.05:1, and an 8.5px label is normal text, so AA wants 4.5:1.
   These are navigation labels — primary text by function — and the resting/active
   distinction is carried by the filled tile, the accent edge and the accent
   colour rather than by making the resting state hard to read. */
.studio-slot-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; padding: 6px 0 5px; margin: 0 1px; border: none; border-radius: 7px;
  background: transparent; color: var(--studio-text); cursor: pointer;
  font: inherit; position: relative;
  transition: background-color 140ms ease, color 140ms ease;
}
.studio-slot-btn svg { width: 19px; height: 19px; display: block; }
/* Sentence case at 8.5px, and the widest label ("Comments") is what set both
   numbers. Measured: uppercase at 8.5px overflowed, sentence case at 9px still
   overflowed by a hair, so the button's side margin dropped from 2px to 1px to
   give the label 46px instead of 44px. A clipped label in a navigation strip
   reads as deliberate, which is the worst kind of bug -- slot-regression.mjs now
   asserts scrollWidth <= clientWidth on all five so it cannot come back. */
.studio-slot-btn .studio-slot-label {
  font-size: 8.5px; letter-spacing: -.01em; line-height: 1.1;
  max-width: 46px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.studio-slot-btn:hover:not(:disabled) { background: var(--studio-surface-sunken); color: var(--studio-text); }
.studio-slot-btn:active:not(:disabled) { transform: scale(.94); }
.studio-slot-btn:focus-visible { outline: 2px solid var(--studio-amber); outline-offset: -2px; }
/* Active reads as ONE thing: a deeper, accent-tinted tile.
 *
 * It used to be a filled tile PLUS a 2px accent bar down the entry's left edge,
 * and the bar is gone by decision — reported from use, "we agreed to remove this
 * type of selection UI". It was also the weaker half of the pair: a 2px rule in a
 * 48px column reads as a divider between the strip and the panel it opens rather
 * than as a property of the entry, and it left the tile itself only one step
 * (surface-sunken) away from the hover state, so "selected" and "the pointer is
 * here" looked nearly identical.
 *
 * So the fill carries it alone, and it is mixed with the accent rather than being
 * another grey: measured against the hover tone it is a clear step in a direction
 * greys do not go, in both themes. Text stays --studio-text rather than the
 * accent, because an 8.5px label on a tinted ground needs the contrast more than
 * it needs the colour — the tint already says which one is current. */
.studio-slot-btn.on {
  background: color-mix(in srgb, var(--studio-amber) 22%, var(--studio-surface-sunken));
  color: var(--studio-text);
}
.studio-slot-btn.on .studio-slot-label { font-weight: 620; }
/* Hover on the current entry must not read as a fourth state; it already has
   the deepest fill in the strip. */
.studio-slot-btn.on:hover:not(:disabled) {
  background: color-mix(in srgb, var(--studio-amber) 26%, var(--studio-surface-sunken));
}
.studio-slot-btn:disabled { opacity: .5; cursor: default; }
/* The scope boundary, kept from the pill this replaces.
 *
 * All five entries are ONE exclusive group -- picking any of them evicts the
 * others -- but they are not one KIND: the three above this line are views of
 * the open document and die with it, the two below are app-level panels that
 * outlive it. That difference is exactly what D15 named, and a hairline is the
 * honest amount of emphasis for it: enough to group, not enough to imply two
 * separate controls. It runs across the strip rather than down it now, because
 * the selector became vertical. */
.studio-slot-split {
  height: 1px; margin: 5px 10px; flex: none;
  background: var(--studio-line);
}
.studio-slot-count {
  position: absolute; top: 3px; right: 6px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 999px; background: var(--studio-amber); color: #fff;
  font-size: 9px; line-height: 14px; text-align: center; font-weight: 650;
}
/* The strip is the right column's content, so the column now needs the tone and
   the seam a populated panel has. */
#theia-right-content-panel .theia-app-sidebar-container {
  background: var(--studio-chrome) !important;
  border-left: 1px solid var(--studio-edge);
}
`;

class SlotStrip {

    /** Wired once from ProductChromeContribution; a singleton, like fileTypeSettings. */
    init({ shell, commandRegistry, messageService }) {
        this.shell = shell;
        this.commandRegistry = commandRegistry;
        this.messageService = messageService;
    }

    /*
     * `attempt` exists because a strip that fails to mount takes ALL FIVE
     * destinations with it — there is no other way to open Comments, Changes,
     * History, Claude or Codex any more. A single querySelector that happens to
     * run a tick early would therefore be an unrecoverable failure, so this
     * retries briefly rather than returning quietly. It gives up after ~2s and
     * says so in the console instead of retrying forever.
     */
    mount(attempt = 0) {
        if (!this.shell || this.node) { return; }
        const container = document.querySelector('#theia-right-content-panel .theia-app-sidebar-container');
        if (!container) {
            if (attempt < 20) { setTimeout(() => this.mount(attempt + 1), 100); }
            else { console.error('[studio] the slot strip could not find the right sidebar container'); }
            return;
        }
        this.node = document.createElement('div');
        this.node.className = 'studio-slot-strip';
        this.node.setAttribute('role', 'tablist');
        this.node.setAttribute('aria-label', 'Beside the document');
        this.node.addEventListener('click', event => {
            const button = event.target.closest('[data-studio-rail]');
            if (button && !button.disabled) { this.choose(button.getAttribute('data-studio-rail')); }
        });
        container.appendChild(this.node);
        /*
         * Two things move the strip's state without the strip being involved:
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
         * opening the Project page left the strip still describing the document it
         * had replaced. Measured: with the page frontmost and visible, and the
         * dock tab marked current, the strip had not refreshed at all.
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
        this.refresh();
    }

    /*
     * The document currently in the main area — NOT shell.currentWidget, which
     * follows focus and so returns the assistant's webview the moment you click
     * into it, making the strip forget which document it is describing.
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

    refresh() {
        if (!this.node) { return; }
        const surface = this.activeSurface();
        const state = surface ? (surface.slotState() || {}) : {};
        const capabilities = surface && typeof surface.slotCapabilities === 'function'
            ? surface.slotCapabilities()
            : ['claude', 'codex'];          // no document open: the assistants still work
        const assistant = currentAssistant(this.shell);
        const counts = state.counts || {};

        this.node.innerHTML = ENTRIES.map((entry, index) => {
            // The hairline goes where the scope changes, derived from the data
            // rather than hardcoded at index 3, so adding a destination cannot
            // put it in the wrong place.
            const boundary = index > 0 && ENTRIES[index - 1].kind !== entry.kind
                ? '<div class="studio-slot-split" role="separator" aria-hidden="true"></div>'
                : '';
            const enabled = capabilities.includes(entry.key);
            const on = enabled && (entry.kind === 'app' ? assistant === entry.key : state.active === entry.key);
            const count = enabled && counts[entry.key] ? counts[entry.key] : 0;
            const hint = enabled
                ? (entry.kind === 'app' ? 'Ask ' + entry.label + ' about this document' : entry.label)
                : ((surface && SURFACE_HINT[entry.key]) || UNAVAILABLE_HINT[entry.key]
                    || entry.label + ' is not available here');
            return boundary + '<button class="studio-slot-btn' + (on ? ' on' : '') + '"' +
                ' data-studio-rail="' + entry.key + '"' +
                ' role="tab" aria-selected="' + on + '" aria-pressed="' + on + '"' +
                (enabled ? '' : ' disabled') +
                ' title="' + hint + '" aria-label="' + entry.label + '">' +
                entry.icon +
                '<span class="studio-slot-label">' + entry.label + '</span>' +
                (count ? '<span class="studio-slot-count">' + count + '</span>' : '') +
                '</button>';
        }).join('');
    }

    choose(key) {
        const surface = this.activeSurface();
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

module.exports = { slotStrip, SLOT_STRIP_CSS, SLOT_STRIP_ENTRIES: ENTRIES };
