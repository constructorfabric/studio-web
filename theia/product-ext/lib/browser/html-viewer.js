/*
 * The Studio HTML viewer.
 *
 * Opens *.html rendered as a browser would render it — not as source. Wins the
 * file through OpenHandler priority the same way the Markdown editor does.
 *
 * Comment mode lets a reviewer click any *component* in the rendered page. The
 * element is outlined and badged, and its threads can be shown or hidden inline
 * underneath it. Threads go to the same in-repository sidecar as Markdown
 * comments, so they travel with the branch.
 *
 * Anchoring note: anchors are stored as a child-index PATH, not a CSS selector.
 * The viewer injects its own nodes into the page (thread panels), which would
 * shift :nth-of-type indices and silently re-point every selector. The path
 * walker skips injected nodes, so it stays stable.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { newId } = require('./comments-store');
const { signature, mergeFolded } = require('./comment-log');
const { ICONS } = require('./icons');
const { messageHtml, quoteLineHtml } = require('./comment-ui');
const { identity } = require('./identity');
const { showLoading } = require('./loader');
const {
    askClaude, askCodex, openAiMenu,
    revealAssistant, collapseRightPanel, assistantFromTabTitle, currentAssistant, SLOT_GRACE_MS
} = require('./ai-context');
const { slotStrip } = require('./slot-strip');

const INJECTED = 'data-studio-injected';

// --- anchoring --------------------------------------------------------------

function realChildren(parent) {
    return [...parent.children].filter(c => !c.hasAttribute(INJECTED));
}

function pathOf(el, doc) {
    const path = [];
    let node = el;
    while (node && node !== doc.body) {
        const parent = node.parentElement;
        if (!parent) { return undefined; }
        const idx = realChildren(parent).indexOf(node);
        if (idx < 0) { return undefined; }
        path.unshift(idx);
        node = parent;
    }
    return node === doc.body ? path : undefined;
}

function resolvePath(path, doc) {
    let node = doc.body;
    for (const idx of path) {
        const kids = realChildren(node);
        if (!kids[idx]) { return undefined; }
        node = kids[idx];
    }
    return node === doc.body ? undefined : node;
}

function snippetOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function describe(el) {
    let d = el.tagName.toLowerCase();
    if (el.id) { d += '#' + el.id; }
    else if (el.className && typeof el.className === 'string') {
        const first = el.className.trim().split(/\s+/)[0];
        if (first) { d += '.' + first; }
    }
    return d;
}

function commentCount(threads) {
    // A badge represents the conversation the reviewer sees, not the number
    // of anchors. A newly created, still-empty thread is one pending comment.
    return threads.reduce((count, thread) => count + Math.max(1, thread.messages.length), 0);
}

// --- CSS injected INTO the previewed document -------------------------------

const FRAME_CSS = `
html.studio-commenting * { cursor: crosshair !important; }
html.studio-commenting .studio-hover {
  outline: 2px solid var(--studio-cyan) !important; outline-offset: 1px !important;
  background: color-mix(in srgb, var(--studio-cyan) 12%, transparent) !important;
}
/* outline + ::after badge only: neither takes part in layout, so the page
   renders exactly as it does in a browser */
.studio-commented {
  outline: 2px solid var(--studio-amber) !important; outline-offset: 1px !important;
  background: color-mix(in srgb, var(--studio-amber) 14%, transparent) !important;
}
.studio-commented::after {
  content: attr(data-studio-count); position: absolute; margin: -10px 0 0 -10px;
  min-width: 17px; height: 17px; padding: 0 4px; box-sizing: border-box;
  border-radius: 9px; background: var(--studio-amber); color: var(--studio-bg); z-index: 2147483000;
  font: 600 10.5px/17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-align: center; cursor: pointer;
}
.studio-commented.resolved { outline-color: var(--studio-muted) !important; background: color-mix(in srgb, var(--studio-muted) 12%, transparent) !important; }
.studio-commented.resolved::after { background: var(--studio-muted); }
`;

class HtmlViewerWidget extends Widget {

    constructor(uri, ctx) {
        super();
        this.uri = uri;
        this.fileService = ctx.fileService;
        this.commentsStore = ctx.commentsStore;
        this.commandRegistry = ctx.commandRegistry;
        this.messageService = ctx.messageService;
        // Needed to put an assistant in the single right-hand slot, same as the
        // Markdown editor does.
        this.shell = ctx.shell;
        this.assistant = undefined;
        // Has the user expressed a slot preference yet? Until they do, an
        // assistant that reveals itself during startup is sent back. Same guard,
        // and the same constant, as the Markdown editor. See SLOT_GRACE_MS.
        this.slotChosen = false;
        this.openedAt = Date.now();

        this.id = 'studio-html:' + uri.toString();
        this.title.label = uri.path.base;
        this.title.caption = uri.path.toString();
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-browser';
        this.addClass('studio-html');

        this.threads = [];
        this.commentMode = false;
        this.openThreads = new Set();
        this.drafts = {};
        // Delete is a two-click confirm; see markDeleteArmed()/disarmDelete().
        this.armedDeleteId = undefined;

        /*
         * No slot selector in this bar any more — it is the shell's right-hand
         * strip, shared with the Markdown editor, and this widget answers it
         * through slotCapabilities()/slotState() below.
         *
         * The history is worth keeping, because it is why the strip is built the
         * way it is. Reported from use: "in the HTML rendered scenario I can't
         * open any codex / claude / changes" — the slot had only ever been built
         * into markdown-editor.js, so on a rendered page the assistants were
         * unreachable. The first fix gave this bar its own two-entry pill, which
         * made the same control have five entries on one surface and two on
         * another. The strip replaces both: fixed membership at five, with the
         * three this surface cannot serve disabled and explaining why.
         *
         * Comment mode stays here, and stays a button in this bar, because it is
         * a mode over the rendered page rather than an occupant of the slot.
         */
        this.node.innerHTML =
            '<div class="studio-doc-topbar">' +
            '  <span class="studio-doc-spacer"></span>' +
            '  <span class="studio-html-hint"></span>' +
            '  <button class="studio-btn" data-hact="reload">Reload</button>' +
            '  <button class="studio-btn" data-hact="toggle-all">Show all threads</button>' +
            '  <button class="studio-btn" data-hact="comment-mode">Comment mode</button>' +
            '</div>' +
            '<div class="studio-html-frame"><iframe></iframe><div class="studio-overlay"></div></div>';

        this.hintEl = this.node.querySelector('.studio-html-hint');
        this.frameHostEl = this.node.querySelector('.studio-html-frame');
        this.frame = this.node.querySelector('iframe');
        this.overlayEl = this.node.querySelector('.studio-overlay');
        this.overlayEl.addEventListener('click', e => this.onThreadClick(e));
        this.overlayEl.addEventListener('input', e => {
            const textarea = e.target.closest('textarea');
            const thread = e.target.closest('[data-thread-id]');
            if (textarea && thread) { this.drafts[thread.getAttribute('data-thread-id')] = textarea.value; }
        });
        // Enter sends; Shift+Enter keeps the newline.
        this.overlayEl.addEventListener('keydown', e => {
            if (e.key !== 'Enter' || e.shiftKey) { return; }
            const textarea = e.target.closest('textarea');
            const thread = e.target.closest('[data-thread-id]');
            if (!textarea || !thread) { return; }
            e.preventDefault();
            this.sendMessage(thread.getAttribute('data-thread-id'), textarea.value);
        });
        this.node.addEventListener('click', e => this.onToolbarClick(e));
        this.node.addEventListener('pointerdown', e => this.dismissOutsideThread(e), true);
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        if (!this.loaded) { this.loaded = true; this.load(); this.watchRightPanel(); }
    }

    onCloseRequest(msg) {
        this.detachTracking();
        /* The comment-log watcher holds a filesystem watch and a pending
         * debounce timer; leaving it attached would re-fold into a disposed
         * widget after the page is gone. */
        if (this.commentWatch) {
            try { this.commentWatch.dispose(); } catch (e) { /* already gone */ }
            this.commentWatch = undefined;
        }
        if (this.slotWatcher && this.shell && this.shell.rightPanelHandler) {
            this.shell.rightPanelHandler.tabBar.currentChanged.disconnect(this.slotWatcher);
            this.slotWatcher = undefined;
        }
        super.onCloseRequest(msg);
        // Raw Lumino Widget.onCloseRequest detaches without disposing, so the
        // shell's tracker keeps the closed viewer and the open handler finds it
        // by id instead of building a new one — the file then cannot be
        // reopened. See the long note on the same line in markdown-editor.js.
        this.dispose();
    }

    onResize(msg) {
        super.onResize(msg);
        this.positionOverlay();
    }

    async load() {
        /*
         * The longest wait this widget has, and until now the least visible:
         * an empty iframe on --studio-bg is indistinguishable from a page that
         * rendered as blank. Reload produces the same two seconds of nothing
         * with no acknowledgement that the button did anything.
         *
         * Cleared in onFrameLoad — including its cross-origin early return,
         * which is a real ending for this wait even though it is a failed one.
         * The one path that can leave it turning is the frame never firing
         * `load` at all, and that is the state it is FOR.
         */
        this.clearFrameLoading = showLoading(
            this.frameHostEl,
            'Rendering ' + this.uri.path.base + '…',
            { className: 'studio-html-loading' }
        );
        try {
            await this.loadComments();
        } catch (error) {
            this.clearFrameLoading();
            throw error;
        }
        this.frame.onload = () => this.onFrameLoad();
        // Served through the backend rather than a blob: URL — a blob has no
        // base, so any page that pulls in its own CSS/JS/images renders blank.
        this._t = (this._t || 0) + 1;
        this.frame.src = '/studio-preview' + this.uri.path.toString() + '?r=' + this._t;
    }

    /*
     * The comments only. Kept apart from load() because load() also re-points
     * the iframe: folding after every appended message through load() would
     * reload the rendered page under the user on every comment.
     */
    async loadComments() {
        const stored = await this.commentsStore.load(this.uri);
        this.threads = mergeFolded(this.threads, stored.threads);
        this.threadsSig = signature(stored.threads);
        /*
         * Re-fold when any party writes. Without this the append-only log buys
         * nothing a user can see: a colleague's reply sits on disk until the
         * page is reopened. The watcher is established once per widget and torn
         * down on close, so a reopened page does not accumulate two.
         */
        if (!this.commentWatch) {
            try {
                this.commentWatch = await this.commentsStore.watch(this.uri, data => {
                    if (this.isDisposed) { return; }
                    /*
                     * The watcher fires for MY OWN appends too (a debounce, not
                     * write bookkeeping — see comment-log.js on why). Re-rendering
                     * then would rebuild the cards and pull focus out of the
                     * textarea the user is still typing in, so a fold that says
                     * nothing new is dropped here rather than suppressed at the
                     * source. Anyone else's write changes the signature and gets
                     * through.
                     */
                    const sig = signature(data.threads);
                    if (sig === this.threadsSig) { return; }
                    this.threadsSig = sig;
                    this.threads = mergeFolded(this.threads, data.threads);
                    this.renderMarks();
                });
            } catch (e) {
                console.warn('[studio] could not watch the comment logs for this page', e);
            }
        }
    }

    get doc() {
        try { return this.frame.contentDocument; } catch (e) { return undefined; }
    }

    onFrameLoad() {
        if (this.clearFrameLoading) { this.clearFrameLoading(); this.clearFrameLoading = undefined; }
        const doc = this.doc;
        if (!doc) {
            this.hintEl.textContent = 'Preview blocked — the page is cross-origin.';
            return;
        }
        this.syncFrameTokens(doc);
        const style = doc.createElement('style');
        style.setAttribute(INJECTED, 'true');
        style.textContent = FRAME_CSS;
        doc.head.appendChild(style);

        doc.addEventListener('mouseover', e => this.onFrameHover(e), true);
        doc.addEventListener('mouseout', e => this.clearHover(), true);
        doc.addEventListener('click', e => this.onFrameClick(e), true);

        this.detachTracking();
        this.trackScroll = () => this.positionOverlay();
        doc.addEventListener('scroll', this.trackScroll, true);
        const view = doc.defaultView;
        if (view) { view.addEventListener('resize', this.trackScroll); }
        this.trackTimer = setInterval(this.trackScroll, 400);   // catches in-page layout changes

        this.applyMode();
        this.renderMarks();
        this.updateHint();
    }

    // The preview is a separate document, so CSS custom properties do not
    // cross the iframe boundary. Copy the shell's resolved semantic tokens
    // before injecting comment affordances; the preview then stays in step
    // with the product theme without owning a second palette.
    syncFrameTokens(doc) {
        const shell = getComputedStyle(document.documentElement);
        for (const token of ['--studio-bg', '--studio-surface', '--studio-surface-raised', '--studio-line', '--studio-text', '--studio-muted', '--studio-amber', '--studio-cyan', '--studio-green', '--studio-danger']) {
            const value = shell.getPropertyValue(token).trim();
            if (value) { doc.documentElement.style.setProperty(token, value); }
        }
    }

    detachTracking() {
        if (this.trackTimer) { clearInterval(this.trackTimer); this.trackTimer = undefined; }
        const doc = this.doc;
        if (doc && this.trackScroll) {
            doc.removeEventListener('scroll', this.trackScroll, true);
            const view = doc.defaultView;
            if (view) { view.removeEventListener('resize', this.trackScroll); }
        }
        this.trackScroll = undefined;
    }

    // -- comment mode --------------------------------------------------------

    applyMode() {
        const doc = this.doc;
        if (doc) { doc.documentElement.classList.toggle('studio-commenting', this.commentMode); }
        const btn = this.node.querySelector('[data-hact="comment-mode"]');
        if (btn) { btn.classList.toggle('on', this.commentMode); }
    }

    clearHover() {
        const doc = this.doc;
        if (!doc) { return; }
        doc.querySelectorAll('.studio-hover').forEach(n => n.classList.remove('studio-hover'));
    }

    onFrameHover(e) {
        if (!this.commentMode) { return; }
        const el = e.target;
        if (!el || el.nodeType !== 1 || el.closest('[' + INJECTED + ']')) { return; }
        this.clearHover();
        el.classList.add('studio-hover');
    }

    onFrameClick(e) {
        const doc = this.doc;
        if (!doc) { return; }

        // the count badge is a ::after on the element, so a click in its box
        // arrives on the element itself — treat clicks on commented elements as
        // a thread toggle whenever comment mode is off
        const commented = e.target.closest && e.target.closest('.studio-commented');
        if (!this.commentMode && commented) {
            const id = commented.getAttribute('data-studio-threads');
            if (id) {
                e.preventDefault(); e.stopPropagation();
                const ids = id.split(' ');
                const shouldOpen = ids.some(t => !this.openThreads.has(t));
                this.openThreads.clear();
                if (shouldOpen) { ids.forEach(t => this.openThreads.add(t)); }
                this.renderMarks();
            }
            return;
        }

        if (!this.commentMode) { return; }
        e.preventDefault();
        e.stopPropagation();
        const el = e.target;
        if (!el || el.nodeType !== 1 || el.closest('[' + INJECTED + ']')) { return; }
        const path = pathOf(el, doc);
        if (!path || !path.length) { return; }
        const thread = {
            id: newId(),
            anchor: { type: 'element', path, tag: el.tagName.toLowerCase(), describe: describe(el), snippet: snippetOf(el) },
            resolved: false,
            messages: []
        };
        this.threads.push(thread);
        this.openThreads.add(thread.id);
        this.commentMode = false;
        this.applyMode();
        this.clearHover();
        this.renderMarks();
        const ta = this.overlayEl.querySelector('[data-thread-id="' + thread.id + '"] textarea');
        if (ta) { ta.focus(); }
    }

    // -- rendering -----------------------------------------------------------

    renderMarks(focusThreadId) {
        const doc = this.doc;
        if (!doc) { return; }

        doc.querySelectorAll('.studio-commented').forEach(n => {
            n.classList.remove('studio-commented', 'resolved');
            n.removeAttribute('data-studio-count');
            n.removeAttribute('data-studio-threads');
        });

        this.anchors = [];
        const byElement = new Map();
        for (const th of this.threads) {
            if (!th.anchor || th.anchor.type !== 'element') { continue; }
            const el = resolvePath(th.anchor.path, doc);
            if (!el) { th.orphaned = true; continue; }
            th.orphaned = false;
            if (!byElement.has(el)) { byElement.set(el, []); }
            byElement.get(el).push(th);
        }
        for (const [el, threads] of byElement) {
            el.classList.add('studio-commented');
            if (threads.every(t => t.resolved)) { el.classList.add('resolved'); }
            el.setAttribute('data-studio-count', String(commentCount(threads)));
            el.setAttribute('data-studio-threads', threads.map(t => t.id).join(' '));
            this.anchors.push({ el, threads });
        }

        // Cards render into the WIDGET's overlay layer. Nothing is ever
        // inserted into the previewed document's flow, so the page keeps the
        // exact layout it has in a browser.
        const shown = this.anchors.filter(a => a.threads.some(t => this.openThreads.has(t.id)));
        this.overlayEl.innerHTML = shown.map(a => {
            const list = a.threads.filter(t => this.openThreads.has(t.id));
            return '<div class="studio-card" data-anchor="' + a.threads[0].id + '">' +
                list.map(th => this.threadHtml(th)).join('<div class="studio-card-sep"></div>') +
                '</div>';
        }).join('');
        for (const [id, text] of Object.entries(this.drafts)) {
            const textarea = this.overlayEl.querySelector('[data-thread-id="' + id + '"] textarea');
            if (textarea) { textarea.value = text; }
        }
        this.positionOverlay();
        this.updateHint();
        if (focusThreadId) {
            const textarea = this.overlayEl.querySelector('[data-thread-id="' + focusThreadId + '"] textarea');
            if (textarea) { textarea.focus(); }
        }
    }

    /*
     * Anchor each card to its element's on-screen box, in widget coordinates.
     * Placed to the right of the element when there is room, otherwise below —
     * always floating over the page, never displacing it.
     */
    positionOverlay() {
        const doc = this.doc;
        if (!doc || !this.overlayEl || !this.anchors) { return; }
        const hostEl = this.node.querySelector('.studio-html-frame');
        if (!hostEl) { return; }
        const host = hostEl.getBoundingClientRect();
        for (const card of [...this.overlayEl.children]) {
            const id = card.getAttribute('data-anchor');
            const anchor = this.anchors.find(a => a.threads[0].id === id);
            if (!anchor) { card.style.display = 'none'; continue; }
            const r = anchor.el.getBoundingClientRect();
            if (!r.width && !r.height) { card.style.display = 'none'; continue; }
            card.style.display = '';
            const w = card.offsetWidth || 300;
            const spaceRight = host.width - (r.right + 16);
            const right = spaceRight >= w;
            card.style.left = Math.round(right ? r.right + 16 : Math.max(8, host.width - w - 8)) + 'px';
            card.style.top = Math.round(Math.max(4, Math.min(right ? r.top : r.bottom + 8, host.height - 60))) + 'px';
        }
    }

    threadHtml(th) {
        const messages = th.messages.map(m => messageHtml(m, 'sth-msg')).join('');
        const resolveTitle = th.resolved ? 'Reopen thread' : 'Mark resolved';
        const deleteArmed = th.id === this.armedDeleteId;
        const target = quoteLineHtml({
            text: th.anchor.describe + (th.anchor.snippet ? ' — ' + th.anchor.snippet : ''),
            orphaned: th.orphaned,
            cls: 'sth-target'
        });
        return '<div data-thread-id="' + th.id + '">' +
            '<div class="sth-head">' + target +
            '<div class="sth-tools">' +
            '<button class="studio-icon-btn" data-tact="ask-ai" data-id="' + th.id + '" title="Ask an AI assistant about this comment" aria-label="Ask an AI assistant about this comment">' + ICONS.spark + '</button>' +
            '<button class="studio-icon-btn' + (th.resolved ? ' resolved' : '') + '" data-tact="resolve" data-id="' + th.id + '" title="' + resolveTitle + '" aria-label="' + resolveTitle + '">' +
            (th.resolved ? ICONS.checkCircle : ICONS.circle) + '</button>' +
            '<button class="studio-icon-btn danger' + (deleteArmed ? ' confirm' : '') + '" data-tact="delete" data-id="' + th.id + '" title="' +
            (deleteArmed ? 'Click again to delete' : 'Delete thread') + '" aria-label="Delete thread">' + ICONS.trash + '</button>' +
            '<button class="studio-icon-btn" data-tact="hide" data-id="' + th.id + '" title="Close" aria-label="Close">' + ICONS.close + '</button>' +
            '</div></div>' +
            messages +
            '<div class="sth-compose' + (th.messages.length ? ' studio-compose-indent' : '') + '">' +
            '<textarea rows="1" placeholder="' + (th.messages.length ? 'Reply…' : 'Add a comment…') + '"></textarea>' +
            '<button class="studio-icon-btn send" data-tact="send" data-id="' + th.id + '" title="Send (Enter)" aria-label="Send">' + ICONS.send + '</button>' +
            '</div></div>';
    }

    updateHint() {
        const open = this.threads.filter(t => !t.resolved).length;
        const orphan = this.threads.filter(t => t.orphaned).length;
        this.hintEl.textContent = this.commentMode
            ? 'Click any component to comment on it'
            : (this.threads.length
                ? open + ' open' + (orphan ? ' · ' + orphan + ' anchor lost' : '') + ' · click a badge to show the thread'
                : 'Turn on Comment mode, then click a component');
        const all = this.node.querySelector('[data-hact="toggle-all"]');
        if (all) { all.textContent = this.openThreads.size ? 'Hide all threads' : 'Show all threads'; }
    }

    // -- events --------------------------------------------------------------

    /*
     * One message becomes one op.
     *
     * The first message in a thread carries the `open` — a thread nobody typed
     * into never reaches disk, which is why an empty card can be abandoned
     * without leaving a permanent record. Everything after it is a `reply`.
     *
     * The optimistic in-memory push it used to do is gone: after appending, the
     * FOLD is the state. That is what makes ids agree with what a retract will
     * later name, and it is one small read.
     */
    async sendMessage(id, value) {
        const th = this.threads.find(t => t.id === id);
        if (!th || !value.trim()) { return; }
        const body = value.trim();
        delete this.drafts[id];
        try {
            if (!th.messages.length) {
                await this.commentsStore.openThread(this.uri, {
                    id: th.id, scope: 'element', anchor: th.anchor, body
                });
            } else {
                await this.commentsStore.reply(this.uri, th.id, body);
            }
            await this.loadComments();
        } catch (err) {
            console.error('[studio] html comment append failed', err);
            this.hintEl.textContent = 'Could not write the comment.';
            return;
        }
        this.renderMarks(id);
    }

    /*
     * Delete is a two-click confirm (arm, then confirm) rather than a
     * blocking window.confirm() — mirrors markdown-editor.js's thread rail.
     */
    armDelete(threadId, btn) {
        clearTimeout(this.armDeleteTimer);
        this.armedDeleteId = threadId;
        btn.classList.add('confirm');
        btn.title = 'Click again to delete';
        this.armDeleteTimer = setTimeout(() => { this.disarmDelete(); }, 2600);
    }

    disarmDelete() {
        clearTimeout(this.armDeleteTimer);
        if (!this.armedDeleteId) { return; }
        const btn = this.overlayEl.querySelector('[data-tact="delete"][data-id="' + this.armedDeleteId + '"]');
        if (btn) { btn.classList.remove('confirm'); btn.title = 'Delete thread'; }
        this.armedDeleteId = undefined;
    }

    askAi(th, anchorEl) {
        openAiMenu(this.node, anchorEl, kind => {
            // threadId: so an assistant with the comments MCP server can read
            // the live thread and reply into it rather than working from the
            // snapshot in the prompt.
            const args = { commandRegistry: this.commandRegistry, messageService: this.messageService, uri: this.uri, label: this.uri.path.base, excerpt: th.anchor.snippet || th.anchor.describe, thread: th.messages, threadId: th.id };
            if (kind === 'claude') { askClaude(args); } else { askCodex(args); }
        });
    }

    onThreadClick(e) {
        const btn = e.target.closest('[data-tact]');
        if (!btn) { return; }
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-tact');
        const th = this.threads.find(t => t.id === id);
        if (!th) { return; }
        if (act !== 'delete' || id !== this.armedDeleteId) { this.disarmDelete(); }
        if (act === 'send') {
            const ta = this.overlayEl.querySelector('[data-thread-id="' + id + '"] textarea');
            if (ta) { this.sendMessage(id, ta.value); }
            return;
        }
        /*
         * Resolution and deletion are ops, not field writes. Resolution is a
         * resolve/reopen pair so two people disagreeing about it settle by
         * timestamp; deletion is a tombstone the fold honours, so the record of
         * what was said is never actually erased from the log.
         *
         * A thread with no messages has never reached disk, so there is nothing
         * to tombstone — dropping it from memory IS the delete.
         */
        if (act === 'resolve') { th.resolved = !th.resolved; this.persistOp(store => store.setResolved(this.uri, id, th.resolved)); }
        if (act === 'hide') { this.openThreads.delete(id); }
        if (act === 'delete') {
            if (this.armedDeleteId !== id) { this.armDelete(id, btn); return; }
            const unsaved = !th.messages.length;
            this.threads = this.threads.filter(t => t.id !== id);
            this.openThreads.delete(id);
            if (!unsaved) { this.persistOp(store => store.deleteThread(this.uri, id)); }
        }
        if (act === 'ask-ai') { this.askAi(th, btn); return; }
        this.renderMarks();
    }

    dismissOutsideThread(e) {
        if (!this.openThreads.size || e.target.closest('.studio-card')) { return; }
        this.openThreads.clear();
        this.renderMarks();
    }

    onToolbarClick(e) {
        // The slot selector left this bar for the shell's right-hand strip; it
        // calls selectSlot() directly, so there is no markup here to dispatch.
        const btn = e.target.closest('[data-hact]');
        if (!btn) { return; }
        const a = btn.getAttribute('data-hact');
        if (a === 'reload') { this.load(); }
        if (a === 'comment-mode') { this.commentMode = !this.commentMode; this.applyMode(); this.clearHover(); this.updateHint(); }
        if (a === 'toggle-all') {
            if (this.openThreads.size) { this.openThreads.clear(); } else { this.threads.forEach(t => this.openThreads.add(t.id)); }
            this.renderMarks();
        }
    }

    /*
     * What the shell's slot strip renders for a rendered HTML document.
     *
     * Two of the five entries are real here, and the strip DISABLES the other
     * three with a reason rather than hiding them — which is what replaces the
     * old asymmetry of five pills on one surface and two on the other (D15).
     * Fixed membership with an explained gap is honest; membership that changes
     * per surface is a segmented control breaking its own promise.
     *
     * Comments is deliberately NOT a slot destination here, and this is the one
     * judgement call in this file worth defending. The strip answers "what can
     * occupy the right of the window", and on a rendered page comments do not:
     * they are cards anchored over the page itself, switched on by the Comment
     * mode control in this bar. Listing Comments here as well would have given
     * one piece of state two controls in two places — the exact defect this whole
     * change set exists to remove. The disabled entry's tooltip says where to go
     * instead.
     */
    slotCapabilities() { return ['claude', 'codex']; }

    slotState() {
        return {
            active: this.assistant,
            counts: { comments: this.threads.filter(t => !t.resolved).length }
        };
    }

    /*
     * Put an assistant in the slot, or take it out again.
     *
     * There is no rail on this surface to evict, so the only rule to keep is the
     * toggle: choosing the current occupant closes the slot and gives the width
     * back to the rendered page.
     */
    selectSlot(key) {
        // A choice made through the product's own selector is intentional by
        // definition, so it steps past the startup guard below.
        this.slotChosen = true;
        if (this.assistant === key) {
            this.assistant = undefined;
            collapseRightPanel(this.shell);
            this.renderSlot();
            return;
        }
        this.assistant = key;
        this.renderSlot();
        revealAssistant({
            shell: this.shell, commandRegistry: this.commandRegistry,
            messageService: this.messageService, key
        }).then(ok => {
            // Never leave the selector claiming an occupant that never arrived.
            if (!ok && this.assistant === key) { this.assistant = undefined; this.renderSlot(); }
        });
    }

    // The strip is the selector now, so keeping it in sync is the whole job.
    renderSlot() { slotStrip.refresh(); }

    /*
     * Keep the selector honest when the panel is worked through Theia's own
     * chrome — the activity-bar icon, or clicking the active tab to collapse it.
     * ApplicationShell has no expansion event; the Lumino tab-bar signal is the
     * real hook, and a null currentTitle IS the collapsed state. Same mechanism
     * as the Markdown editor's watchRightPanel.
     */
    watchRightPanel() {
        if (!this.shell || !this.shell.rightPanelHandler) { return; }
        /*
         * Sync with the panel's CURRENT occupant first: the signal below only
         * reports transitions, so a viewer opened while the panel was already
         * expanded would show an empty selector under an open assistant.
         *
         * ...and then defend the slot exactly as the Markdown editor does. Claude
         * Code's panel reveals itself when its extension activates, a second or
         * two after a document appears, and this surface never had the guard the
         * Markdown one grew for it — so an assistant became the default occupant
         * of every HTML document. Measured after the strip made the state
         * visible: opening report.html showed Claude as the slot's occupant
         * without anyone asking for it. The two surfaces have to behave the same
         * way; that is why the assistant plumbing lives in ai-context.js.
         */
        const uninvited = currentAssistant(this.shell);
        if (uninvited && !this.slotChosen && (Date.now() - this.openedAt) < SLOT_GRACE_MS) {
            this.assistant = undefined;
            collapseRightPanel(this.shell);
        } else {
            this.assistant = uninvited;
        }
        this.renderSlot();
        const tabBar = this.shell.rightPanelHandler.tabBar;
        this.slotWatcher = (sender, args) => {
            const next = assistantFromTabTitle(args && args.currentTitle);
            // Same bounded startup window as the Markdown editor: inside it an
            // assistant that arrived on its own is sent back; after it, whatever
            // the panel does is taken as intentional.
            if (next && !this.slotChosen && (Date.now() - this.openedAt) < SLOT_GRACE_MS) {
                collapseRightPanel(this.shell);
                return;
            }
            if (next === this.assistant) { return; }
            this.assistant = next;
            this.renderSlot();
        };
        tabBar.currentChanged.connect(this.slotWatcher);
    }

    /*
     * Append one op, then take the fold as the state.
     *
     * This replaced persist(), which wrote the entire thread array back over the
     * sidecar — the reason two people reviewing the same page silently destroyed
     * each other's comments (measured; comment-log-test.mjs pins it).
     */
    async persistOp(write) {
        try {
            await write(this.commentsStore);
            await this.loadComments();
            this.renderMarks();
        } catch (err) {
            console.error('[studio] html comment op failed', err);
            this.hintEl.textContent = 'Could not write the comment.';
        }
    }
}

const HTML_VIEWER_CSS = `
/* !important: see the matching note on .studio-doc in markdown-editor.js. */
.studio-html { display: flex; flex-direction: column; height: 100%; background: var(--studio-bg) !important; color: var(--studio-text); }
/* !important: see the matching note on .studio-doc-scroll in markdown-editor.js. */
.studio-html .studio-html-frame { flex: 1; min-height: 0; position: relative; background: var(--studio-bg) !important; }
/* Over the iframe AND over .studio-overlay: both are positioned and neither
   declares a z-index, so they stack by document order and an appended sibling
   would already win — the explicit 3 is so that stays true if either of them
   ever gets one. Opaque, so a half-painted page cannot show through and read
   as the finished render. */
.studio-html .studio-html-loading {
  position: absolute; inset: 0; z-index: 3; background: var(--studio-bg);
}
.studio-html iframe { width: 100%; height: 100%; border: none; background: var(--studio-surface); display: block; }
.studio-html-hint { font-size: 11.5px; color: var(--studio-muted); margin-right: 4px; }
.studio-html .studio-btn.on { background: var(--studio-amber); color: var(--studio-bg); border-color: var(--studio-amber); }

/* Comment cards float in their own layer above the iframe. They are outside
   the previewed document entirely, so they cannot reflow it. */
.studio-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
/*
 * A floating card is separated from the page it hovers over by elevation, so
 * that is the one device it uses: a real shadow plus a hairline. It previously
 * carried a border, a 3px accent rail AND a shadow whose color was mixed from
 * --studio-bg — i.e. a white shadow in light mode, which rendered as nothing.
 * Thread internals (quote, avatars, messages) come from comment-ui.js.
 */
/* The raised token, not raw white: the card floats over a document that is
   itself white, so tone is what separates them — the shadow and hairline
   only sharpen a separation the surface already makes. */
.studio-card {
  position: absolute; width: 300px; pointer-events: auto;
  background: var(--studio-surface-raised); color: var(--studio-text);
  border: 1px solid var(--studio-line); border-radius: 10px;
  padding: 11px 12px 12px; box-shadow: 0 10px 28px var(--studio-shadow); font-size: 13px; line-height: 1.5;
}
.studio-card-sep { height: 1px; background: var(--studio-line); margin: 11px -12px; }
.studio-card .sth-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 9px; }
.studio-card .sth-target { flex: 1; min-width: 0; }
.studio-card .sth-tools { display: flex; gap: 1px; flex: none; }
.studio-card .sth-compose { display: flex; align-items: flex-end; gap: 6px; margin-top: 8px; }
/* Inset on a raised card, so the field reads as recessed into it rather than
   as a third bordered box stacked on top. */
.studio-card textarea {
  flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 6px 8px; resize: vertical;
  border: 1px solid transparent; border-radius: 7px; background: var(--studio-surface); color: var(--studio-text);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.studio-card textarea:focus, .studio-card textarea:focus-visible {
  outline: none; border-color: var(--studio-amber); box-shadow: 0 0 0 3px var(--studio-focus);
}
.studio-card .sth-orphan { color: var(--studio-danger); font-weight: 600; }
`;

module.exports = { HtmlViewerWidget, HTML_VIEWER_CSS, commentCount };
