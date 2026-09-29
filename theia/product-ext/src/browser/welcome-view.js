/*
 * The empty main dock — the start page of the project that is open.
 *
 * WHAT CHANGED, AND WHY. This layer used to be a board that explained the
 * product: "Write. Talk. Decide.", three illustrated columns and three corner
 * labels pointing at the shell. It taught what the product is and offered
 * nothing to do, on the screen a person sees every time they close their last
 * tab. It is now a start page: the documents touched lately, the threads waiting
 * for this person, the proposals waiting for a decision, and the two actions
 * that start work — a new document, and Search. The explanation stays, in three
 * lines, for an empty project and for the first time the page is seen.
 *
 * WHY IT IS STILL NOT A WIDGET. A Welcome tab would put a closable document in
 * the dock that is not a document, give it a tab button, and then have to decide
 * what happens when the user closes it. This is a state of the empty dock, so it
 * is a layer inside the dock's own node, shown exactly when the dock holds no
 * widgets — a raw node appended into a shell container, outside Lumino's
 * layout, driven by signals the shell already publishes.
 *
 * WHAT IT READS, AND WHEN. Everything on the page comes from the project's own
 * files, read when the page is shown (and again, debounced, if a file changes
 * while it is on screen): the tree's mtimes, the per-author comment logs folded
 * by comment-log.js, and `.studio/changes/`. No indexer and no background walk —
 * with a document open, this layer is hidden and reads nothing. The walk is
 * bounded, and the foot line says when a bound bit. The one fact the files
 * cannot hold — which documents this browser opened — is kept per project in
 * local storage and labelled "opened", never "edited".
 *
 * The decisions — what counts as recent, what is waiting for you, what a row
 * says — are in welcome-scan.js, tested in node. This file reads and paints.
 */

const { URI } = require('@theia/core/lib/common/uri');
const { open } = require('@theia/core/lib/browser/opener-service');
const { isOSX } = require('@theia/core/lib/common/os');
const { activeProject } = require('./active-project');
const { identity } = require('./identity');
const { esc } = require('./comment-ui');
const { CommentLog, foldOps } = require('./comment-log');
const { ChangesStore } = require('./changes-store');
const sidecarScan = require('./sidecar-scan');
const collabScan = require('./collab-scan');
const scan = require('./welcome-scan');

/* The commands the page runs. Ids, not imports: the handlers live in
 * product-frontend-module.js, and a button that names a command is a button the
 * palette and a keybinding can reach the same way. */
const NEW_DOCUMENT_COMMAND_ID = 'studio.document.new';
const SEARCH_COMMAND_ID = 'studio.search.open';
const COLLAB_COMMAND_ID = 'studio.collaboration';

/* How many documents' comment logs one read folds, and how many per-document
 * proposal files it opens for their titles. The Collaboration page folds up to
 * 400; a start page lists five threads and can stop sooner. */
const MAX_COMMENT_DOCUMENTS = 200;
const MAX_PROPOSAL_FILES = 20;

/* A save while the page is on screen is a burst of change events. */
const RELOAD_DEBOUNCE_MS = 600;

const OPENED_KEY = 'studio-welcome-opened:';
const EXPLAINED_KEY = 'studio-welcome-explained';

function readStorage(key) {
    try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null; } catch (e) { return null; }
}
function writeStorage(key, value) {
    try { if (globalThis.localStorage) { globalThis.localStorage.setItem(key, value); } } catch (e) { /* storage refused */ }
}

/*
 * The three columns, compact. What you do, and the part a picture would not
 * show: where it lives and what it costs.
 */
const COLUMNS = [
    { head: 'Talk in the doc.', note: 'Comments are files in your repo. They commit with the document.' },
    { head: 'Ask for edits.', note: 'Select words, ask Claude or Codex. They read the thread too.' },
    { head: 'Decide what lands.', note: 'Nothing is written until you accept it. Reject costs one click.' }
];

const EMPTY_STATE = {
    loading: true,
    hasProject: false,
    projectName: '',
    rootString: '',
    recent: [],
    documents: 0,
    waiting: { mode: 'mine', title: 'Waiting for you', items: [], more: 0, open: 0, others: 0, note: '' },
    pending: { available: false, rows: [], more: 0, total: 0 },
    stats: {}
};

class WelcomeView {

    init(ctx) {
        this.shell = ctx.shell;
        this.commandRegistry = ctx.commandRegistry;
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.commentLog = ctx.fileService ? new CommentLog(ctx.fileService, ctx.workspaceService) : undefined;
        this.changesStore = ctx.fileService ? new ChangesStore(ctx.fileService, ctx.workspaceService) : undefined;
        this.state = Object.assign({}, EMPTY_STATE);
        this.token = undefined;
    }

    mount(attempt = 0) {
        const panel = this.shell && this.shell.mainPanel;
        const container = panel && panel.node;
        if (!container) {
            // Lumino builds the shell's DOM on its own schedule and there is no
            // event for "the dock node exists".
            if (attempt < 20) { setTimeout(() => this.mount(attempt + 1), 100); }
            else { console.error('[studio] the start page could not find the main dock'); }
            return;
        }
        this.node = document.createElement('div');
        this.node.className = 'studio-welcome';
        this.node.setAttribute('role', 'region');
        this.node.setAttribute('aria-label', 'Start');
        container.appendChild(this.node);

        this.node.addEventListener('click', event => this.onActivate(event));
        this.node.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            if (!event.target.closest('[data-open],[data-run]')) { return; }
            if (event.target.tagName === 'BUTTON') { return; } // a button already clicks on both
            event.preventDefault();
            this.onActivate(event);
        });

        /*
         * The dock's own membership signals: this layer answers "is anything
         * open", which changes only when a widget is added or removed. The
         * added widget is also the one fact the files cannot hold — that this
         * browser opened a document — so it is remembered here.
         */
        if (panel.widgetAdded) {
            panel.widgetAdded.connect((sender, widget) => { this.rememberOpened(widget); this.scheduleRefresh(); });
        }
        if (panel.widgetRemoved) { panel.widgetRemoved.connect(() => this.scheduleRefresh()); }
        activeProject.onChanged(() => { if (this.visible()) { void this.load(); } });
        /* A singleton for the life of the page, so identity's listener list —
         * which cannot unsubscribe — holds one closure, not one per tab. */
        identity.onChanged(() => { if (this.visible()) { void this.load(); } });
        if (this.fileService && this.fileService.onDidFilesChange) {
            this.fileService.onDidFilesChange(() => {
                if (!this.visible()) { return; }
                clearTimeout(this.reloadTimer);
                this.reloadTimer = setTimeout(() => void this.load(), RELOAD_DEBOUNCE_MS);
            });
        }
        this.render();
        this.refresh();
    }

    visible() {
        return !!this.node && this.node.classList.contains('on');
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
        if (!this.dockIsEmpty()) {
            this.node.classList.remove('on', 'in');
            if (this.token) { this.token.cancelled = true; }
            return;
        }
        if (this.visible()) { return; }
        this.node.classList.add('on');
        // Shown again: read again. What the page lists is what changed while
        // somebody was looking at a document.
        void this.load();
        // One frame between "displayed" and "animating", or the transition has
        // no start value to run from.
        requestAnimationFrame(() => {
            if (this.visible()) { this.node.classList.add('in'); }
        });
    }

    // -- the reads -----------------------------------------------------------

    async activeRoot() {
        let roots = [];
        try { roots = this.workspaceService ? await this.workspaceService.roots : []; } catch (e) { roots = []; }
        const active = activeProject.resolve(roots);
        return active ? active.resource : undefined;
    }

    /**
     * Everything the page shows, read once. A newer read cancels an older one:
     * two interleaved reads writing `this.state` is how a page ends up showing
     * half of one project.
     */
    async load() {
        if (this.token) { this.token.cancelled = true; }
        const token = { cancelled: false };
        this.token = token;

        const root = await this.activeRoot();
        if (token.cancelled) { return; }
        if (!root || !this.fileService) {
            this.state = Object.assign({}, EMPTY_STATE, { loading: false });
            this.render();
            return;
        }
        const rootString = root.toString();
        if (this.state.rootString !== rootString) {
            // A different project: nothing from the last one may linger while
            // this one is read.
            this.state = Object.assign({}, EMPTY_STATE, { hasProject: true, projectName: root.path.base, rootString });
            this.render();
        }

        const walk = await scan.walkDocuments(this.fileService, root, token);
        if (token.cancelled) { return; }
        const recent = scan.recentDocuments(walk, this.readOpened(rootString), { rootString });

        const threads = await this.readThreads(root, token);
        if (token.cancelled) { return; }
        const me = identity.current();
        const waiting = scan.waitingSection(collabScan.inbox(threads.files, me), me);

        const pending = await this.readPending(root, token);
        if (token.cancelled) { return; }

        const firstRun = !readStorage(EXPLAINED_KEY);
        if (firstRun) { writeStorage(EXPLAINED_KEY, String(Date.now())); }

        this.state = {
            loading: false,
            hasProject: true,
            projectName: root.path.base,
            rootString,
            recent,
            documents: walk.files.length,
            waiting,
            pending,
            firstRun: firstRun || this.state.firstRun === true && this.state.rootString === rootString,
            stats: {
                walkTruncated: walk.truncated,
                walked: walk.entries,
                unreadable: threads.unreadable,
                cappedDocuments: threads.capped,
                commentDocuments: MAX_COMMENT_DOCUMENTS
            }
        };
        this.render();
    }

    /*
     * Threads come from the FOLD, never from the bytes — the way search-view.js
     * reads them: a retracted message and a deleted thread are still in the log
     * files, and only foldOps honours the tombstones.
     */
    async readThreads(root, token) {
        const out = { files: [], unreadable: 0, capped: 0 };
        let documents = [];
        try {
            const sidecars = await sidecarScan.collectSidecars(this.fileService, root, token);
            documents = [...sidecars.comments].sort();
        } catch (e) {
            return out;
        }
        if (documents.length > MAX_COMMENT_DOCUMENTS) { out.capped = documents.length - MAX_COMMENT_DOCUMENTS; }
        const rootString = root.toString();
        for (const rel of documents.slice(0, MAX_COMMENT_DOCUMENTS)) {
            if (token.cancelled) { return out; }
            const docUri = new URI(rootString + '/' + rel);
            try {
                const base = await this.commentLog.readLegacy(root, docUri);
                const ops = await this.commentLog.readOps(root, docUri);
                out.files.push({ path: rel, uri: docUri.toString(), threads: foldOps(base, ops) });
            } catch (e) {
                out.unreadable++;
            }
        }
        return out;
    }

    async readPending(root, token) {
        let status;
        try {
            status = await this.changesStore.pendingFilesStatus(root);
        } catch (e) {
            status = { available: false, files: [] };
        }
        const details = {};
        for (const file of (status.files || []).slice(0, MAX_PROPOSAL_FILES)) {
            if (token.cancelled) { break; }
            try {
                details[file.path] = (await this.changesStore.load(file.uri)).proposals;
            } catch (e) { /* the index's count still stands */ }
        }
        return scan.pendingSection(status, details);
    }

    // -- opened documents, per project, in this browser -------------------------

    readOpened(rootString) {
        try {
            const parsed = JSON.parse(readStorage(OPENED_KEY + rootString) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    rememberOpened(widget) {
        let uri;
        try {
            uri = widget && (widget.uri || (typeof widget.getResourceUri === 'function' ? widget.getResourceUri() : undefined));
        } catch (e) { uri = undefined; }
        if (!uri) { return; }
        const uriString = uri.toString();
        const roots = (this.workspaceService && this.workspaceService.tryGetRoots) ? this.workspaceService.tryGetRoots() : [];
        const root = roots
            .map(r => r.resource.toString())
            .filter(r => uriString.startsWith(r + '/'))
            .sort((a, b) => b.length - a.length)[0];
        if (!root) { return; }
        const path = scan.relativeTo(root, uriString);
        if (!path || !scan.isDocument(path)) { return; }
        writeStorage(OPENED_KEY + root, JSON.stringify(scan.rememberOpened(this.readOpened(root), path, Date.now())));
    }

    // -- actions ---------------------------------------------------------------

    onActivate(event) {
        const target = event.target.closest('[data-open],[data-run]');
        if (!target || !this.node.contains(target)) { return; }
        if (target.dataset.run) {
            this.run(target.dataset.run);
            return;
        }
        const uri = target.dataset.open;
        if (!uri || !this.openerService) { return; }
        open(this.openerService, new URI(uri)).catch(e =>
            console.warn('[studio] the start page could not open', uri, e));
    }

    run(commandId) {
        if (!this.commandRegistry) { return; }
        this.commandRegistry.executeCommand(commandId).catch(e =>
            console.warn('[studio] the start page could not run', commandId, e));
    }

    // -- paint -----------------------------------------------------------------

    render() {
        if (!this.node) { return; }
        this.node.innerHTML = this.html();
    }

    html() {
        const s = this.state;
        const explain = !s.loading && scan.showExplainer({
            hasProject: s.hasProject,
            firstRun: s.firstRun,
            documents: s.documents,
            threads: s.waiting.open,
            pending: s.pending.rows.length
        });

        if (!s.loading && !s.hasProject) {
            return '<div class="studio-welcome-body">' +
                '<header class="studio-start-head">' +
                '<div class="studio-start-title-wrap"><h2 class="studio-start-title" data-welcome-title>No project is open</h2>' +
                '<p class="studio-start-sub">Studio opens a project for you — from the portal, or from the Constructor Studio view on the desktop.</p></div>' +
                '</header>' +
                this.explainerHtml() +
                '</div>';
        }

        return '<div class="studio-welcome-body">' +
            this.headHtml() +
            '<div class="studio-start-grid">' +
            '<div class="studio-start-col">' + this.recentHtml() + '</div>' +
            '<div class="studio-start-col">' + this.waitingHtml() + this.pendingHtml() + '</div>' +
            '</div>' +
            (explain ? this.explainerHtml() : '') +
            (s.loading ? '' : '<p class="studio-start-honesty" data-start-honesty>' + esc(scan.honestyLine(s.stats)) + '</p>') +
            '</div>';
    }

    headHtml() {
        const s = this.state;
        const key = isOSX ? '⇧⌘F' : 'Ctrl+Shift+F';
        return '<header class="studio-start-head">' +
            '<div class="studio-start-title-wrap">' +
            '<span class="studio-start-eyebrow">Project</span>' +
            '<h2 class="studio-start-title" data-welcome-title>' + esc(s.projectName || ' ') + '</h2>' +
            '</div>' +
            '<div class="studio-start-actions">' +
            '<button type="button" class="studio-btn primary" data-run="' + NEW_DOCUMENT_COMMAND_ID + '" data-start-action="new">New document</button>' +
            '<button type="button" class="studio-btn" data-run="' + SEARCH_COMMAND_ID + '" data-start-action="search">Search <kbd>' + key + '</kbd></button>' +
            '</div>' +
            '</header>';
    }

    sectionHtml(id, title, count, body) {
        return '<section class="studio-start-section" data-start-section="' + id + '">' +
            '<h3 class="studio-start-section-head"><span>' + esc(title) + '</span>' +
            (count ? '<span class="studio-start-count">' + esc(count) + '</span>' : '') + '</h3>' +
            body + '</section>';
    }

    emptyHtml(text) {
        return '<p class="studio-start-empty">' + text + '</p>';
    }

    loadingHtml() {
        return '<p class="studio-start-empty">Reading…</p>';
    }

    recentHtml() {
        const s = this.state;
        if (s.loading) { return this.sectionHtml('recent', 'Recent documents', '', this.loadingHtml()); }
        if (!s.recent.length) {
            return this.sectionHtml('recent', 'Recent documents', '',
                this.emptyHtml('No documents in this project yet. <b>New document</b> starts one.'));
        }
        const rows = s.recent.map(row =>
            '<li><button type="button" class="studio-start-row" data-open="' + esc(row.uri) + '" title="' + esc(row.path) + '">' +
            '<span class="studio-start-main"><span class="studio-start-name">' + esc(row.name) + '</span>' +
            (row.folder ? '<span class="studio-start-folder">' + esc(row.folder) + '</span>' : '') + '</span>' +
            '<span class="studio-start-meta">' + esc(row.reason) + ' ' + esc(scan.agoText(new Date(row.at).toISOString())) + '</span>' +
            '</button></li>').join('');
        return this.sectionHtml('recent', 'Recent documents', '', '<ul class="studio-start-list">' + rows + '</ul>');
    }

    waitingHtml() {
        const s = this.state;
        const w = s.waiting;
        if (s.loading) { return this.sectionHtml('waiting', 'Waiting for you', '', this.loadingHtml()); }
        let body = '';
        if (!w.items.length) {
            if (w.open === 0) {
                body = this.emptyHtml('No open comment threads in this project.');
            } else {
                body = this.emptyHtml('Nothing is waiting for you. ' +
                    '<button type="button" class="studio-start-link" data-run="' + COLLAB_COMMAND_ID + '">' +
                    esc(collabScan.plural(w.others || w.open, 'other open thread', 'other open threads')) + '</button>');
            }
        } else {
            const rows = w.items.map(item => {
                const reason = scan.waitingReason(item);
                return '<li><button type="button" class="studio-start-row thread" data-open="' + esc(item.uri) + '" title="' + esc(scan.decodePath(item.path)) + '">' +
                    '<span class="studio-start-main">' +
                    (item.quote ? '<span class="studio-start-quote">' + esc(item.quote) + '</span>' : '<span class="studio-start-quote doc">Whole document</span>') +
                    '<span class="studio-start-preview"><b>' + esc(item.lastBy || 'Someone') + '</b> ' + esc(item.preview) + '</span>' +
                    '<span class="studio-start-folder">' + esc(scan.decodePath(item.path)) + '</span>' +
                    '</span>' +
                    '<span class="studio-start-meta">' +
                    (reason ? '<span class="studio-start-tag">' + esc(reason) + '</span>' : '') +
                    esc(scan.ageText(item.lastAt)) + '</span>' +
                    '</button></li>';
            }).join('');
            body = '<ul class="studio-start-list">' + rows + '</ul>';
            const extra = [];
            if (w.more) { extra.push(w.more + ' more'); }
            if (w.mode === 'mine' && w.others) { extra.push(collabScan.plural(w.others, 'other open thread', 'other open threads')); }
            if (extra.length) {
                body += '<p class="studio-start-more"><button type="button" class="studio-start-link" data-run="' + COLLAB_COMMAND_ID + '">' +
                    esc(extra.join(' · ')) + '</button></p>';
            }
        }
        if (w.note) { body += '<p class="studio-start-note" data-start-note>' + esc(w.note) + '</p>'; }
        return this.sectionHtml('waiting', w.title, '', body);
    }

    pendingHtml() {
        const s = this.state;
        const p = s.pending;
        const title = 'Proposed changes';
        if (s.loading) { return this.sectionHtml('pending', title, '', this.loadingHtml()); }
        if (!p.rows.length) {
            return this.sectionHtml('pending', title, '', this.emptyHtml(p.available
                ? 'Nothing is waiting for a decision.'
                : 'No proposed changes yet. An assistant’s edit waits here for a yes or a no.'));
        }
        const rows = p.rows.map(row =>
            '<li><button type="button" class="studio-start-row" data-open="' + esc(row.uri) + '" title="' + esc(row.path) + '">' +
            '<span class="studio-start-main"><span class="studio-start-name">' + esc(row.name) + '</span>' +
            (row.title ? '<span class="studio-start-preview">' + esc(row.title) +
                (row.author ? ' · ' + esc(row.author) : '') + '</span>' : '') +
            (row.folder ? '<span class="studio-start-folder">' + esc(row.folder) + '</span>' : '') + '</span>' +
            '<span class="studio-start-meta"><span class="studio-start-pending">' +
            esc(collabScan.plural(row.pending, 'change', 'changes')) + '</span>' +
            (row.at ? esc(scan.ageText(row.at)) : '') + '</span>' +
            '</button></li>').join('');
        let body = '<ul class="studio-start-list">' + rows + '</ul>';
        if (p.more) {
            body += '<p class="studio-start-more"><button type="button" class="studio-start-link" data-run="' + COLLAB_COMMAND_ID + '">' +
                esc(collabScan.plural(p.more, 'more document', 'more documents')) + '</button></p>';
        }
        return this.sectionHtml('pending', title, scan.pendingCountText(p), body);
    }

    explainerHtml() {
        const columns = COLUMNS.map(column =>
            '<section class="studio-welcome-col">' +
            '<h3 class="studio-welcome-col-head">' + column.head + '</h3>' +
            '<p class="studio-welcome-col-note">' + column.note + '</p>' +
            '</section>').join('');
        return '<div class="studio-welcome-explain" data-start-explainer>' +
            '<p class="studio-welcome-lede"><span class="studio-welcome-title">' +
            '<span>Write<i>.</i></span> <span>Talk<i>.</i></span> <span>Decide<i>.</i></span></span> ' +
            'Documents live in your repository. So does everything said about them.</p>' +
            '<div class="studio-welcome-cols">' + columns + '</div>' +
            '</div>';
    }
}

const welcomeView = new WelcomeView();

/*
 * Tokens only, and the house rules the old board obeyed:
 *
 *   - --studio-line for every divider. Sections are separated by a hairline and
 *     by space, NOT by boxes: boxed panels read as unrelated apps, and this
 *     surface has to read as one product.
 *   - No new hues. The accent marks what can be acted on — the primary action,
 *     the reason a thread is listed, a pending count — and nothing else.
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

/* --- the head: which project, and the two ways to start ------------------- */
.studio-start-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  padding-bottom: 22px; border-bottom: 1px solid var(--studio-line);
}
.studio-start-title-wrap { min-width: 0; }
.studio-start-eyebrow {
  display: block; margin-bottom: 6px;
  color: var(--studio-muted); font: 600 10.5px/1 inherit; letter-spacing: .08em; text-transform: uppercase;
}
.studio-start-title {
  margin: 0; font-weight: 600; letter-spacing: -.03em; line-height: 1.08;
  font-size: clamp(24px, 3.4cqi, 34px); overflow-wrap: anywhere;
}
.studio-start-sub { margin: 10px 0 0; max-width: 56ch; color: var(--studio-muted); font: 400 13px/1.6 inherit; }
.studio-start-actions { display: flex; gap: 8px; flex: none; }
.studio-start-actions .studio-btn { padding: 8px 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 8px; }
.studio-start-actions kbd {
  font: 500 10.5px/1 var(--studio-mono, inherit); color: var(--studio-muted);
  border: 1px solid var(--studio-line); border-radius: 4px; padding: 2px 4px;
}

/* --- the sections ---------------------------------------------------------- */
.studio-start-grid {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  margin-top: 26px;
}
.studio-start-col { min-width: 0; padding: 0 26px; border-left: 1px solid var(--studio-line); }
.studio-start-col:first-child { padding-left: 0; border-left: none; }
.studio-start-col:last-child { padding-right: 0; }
.studio-start-section + .studio-start-section { margin-top: 26px; }
.studio-start-section-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  margin: 0 0 8px; font: 600 13px/1.35 inherit; letter-spacing: -.005em;
}
.studio-start-count { color: var(--studio-muted); font-weight: 500; font-size: 11.5px; }
.studio-start-list { list-style: none; margin: 0 -8px; padding: 0; }
.studio-start-row {
  all: unset; box-sizing: border-box; width: 100%;
  display: flex; align-items: baseline; gap: 12px;
  padding: 7px 8px; border-radius: 6px; cursor: pointer;
}
.studio-start-row:hover { background: var(--studio-surface-sunken); }
.studio-start-row:focus-visible { outline: 2px solid var(--studio-focus, var(--studio-accent)); outline-offset: -2px; }
.studio-start-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.studio-start-name { font: 500 13px/1.4 inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-start-folder, .studio-start-preview {
  color: var(--studio-muted); font: 400 11.5px/1.45 inherit;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.studio-start-preview b { color: var(--studio-text); font-weight: 600; }
.studio-start-quote {
  font: 400 12.5px/1.45 inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-decoration: underline; text-decoration-color: var(--studio-accent); text-underline-offset: 3px;
}
.studio-start-quote.doc { text-decoration: none; color: var(--studio-muted); font-style: italic; }
.studio-start-meta {
  flex: none; display: inline-flex; align-items: baseline; gap: 8px;
  color: var(--studio-muted); font: 400 11px/1.4 inherit; white-space: nowrap;
}
.studio-start-tag, .studio-start-pending { color: var(--studio-accent); font-weight: 600; }
.studio-start-empty, .studio-start-note, .studio-start-more {
  margin: 4px 0 0; color: var(--studio-muted); font: 400 12px/1.6 inherit; max-width: 52ch;
}
.studio-start-empty b { color: var(--studio-text); font-weight: 600; }
.studio-start-note { margin-top: 8px; font-size: 11.5px; }
.studio-start-link {
  all: unset; cursor: pointer; color: var(--studio-accent); font-weight: 500;
}
.studio-start-link:hover { text-decoration: underline; }
.studio-start-link:focus-visible { outline: 2px solid var(--studio-focus, var(--studio-accent)); outline-offset: 2px; border-radius: 2px; }
.studio-start-honesty {
  margin: 30px 0 0; color: var(--studio-muted); font: 400 11px/1.6 inherit; max-width: 80ch;
}

/* --- the explanation, compact --------------------------------------------- */
.studio-welcome-explain { margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--studio-line); }
.studio-welcome-lede { margin: 0; color: var(--studio-muted); font: 400 12.5px/1.6 inherit; }
.studio-welcome-title { color: var(--studio-text); font-weight: 600; letter-spacing: -.01em; margin-right: 4px; }
/* The stops carry the cadence the words are written in. */
.studio-welcome-title i { font-style: normal; color: var(--studio-muted); }
.studio-welcome-cols { margin-top: 16px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.studio-welcome-col { padding: 0 22px; border-left: 1px solid var(--studio-line); min-width: 0; }
.studio-welcome-col:first-child { border-left: none; padding-left: 0; }
.studio-welcome-col:last-child { padding-right: 0; }
.studio-welcome-col-head { margin: 0; font: 600 12.5px/1.35 inherit; }
.studio-welcome-col-note { margin: 5px 0 0; color: var(--studio-muted); font: 400 11.5px/1.55 inherit; text-wrap: pretty; }

/* --- narrow docks --------------------------------------------------------- */
/* The dock is not the viewport — an assistant panel can halve it — so the
   breakpoints are on the container, not the window. */
@container (max-width: 720px) {
  .studio-start-grid { grid-template-columns: 1fr; }
  .studio-start-col { padding: 0; border-left: none; }
  .studio-start-col + .studio-start-col { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--studio-line); }
  .studio-welcome-cols { grid-template-columns: 1fr; gap: 12px; }
  .studio-welcome-col { padding: 0; border-left: none; }
}

@media (prefers-reduced-motion: reduce) {
  .studio-welcome-body { transform: none; transition-duration: 1ms; }
}
`;

module.exports = { welcomeView, WELCOME_CSS };
