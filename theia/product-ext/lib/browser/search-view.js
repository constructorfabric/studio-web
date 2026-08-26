/*
 * Search — a page you ask for, not a panel that is always there.
 *
 * WHY A MAIN-DOCK TAB AND NOT A LEFT-RAIL PANEL. Search in this product is not
 * a navigation tree; it is a RESULT SET with five facet dimensions over it, and
 * a result set is a document. Measured against the shapes already in the
 * product: the facet rail alone wants 240px, the results column wants 60+
 * characters of snippet per row plus a meta line, and the honesty line is
 * monospace and long. In a 257px left panel (the width the Projects browser
 * actually gets) that is a facet rail with no room for results — the same
 * mistake the old Projects footer made, where a 21-checkbox filter was stacked
 * into a 257px column and became unusable. So this is the same class of surface
 * as the Project page: a closable tab in the main dock, costing nothing when
 * nobody asked for it.
 *
 * WHAT IS ACTUALLY SEARCHED, and this is the whole design decision. A document
 * product's content is not only its documents. Four other things in a project
 * are prose somebody wrote and will later go looking for, and three of them are
 * already newline-delimited JSON op logs under `.studio/`:
 *
 *   documents        the file text, per line
 *   checklist items  a document line that is a task-list box, called out as its
 *                    own type because "the unticked box about pricing" is a
 *                    different question from "the sentence about pricing"
 *   comments         folded out of the per-author logs with comment-log.js's own
 *                    foldOps — NOT grepped as text, because a log is ops and
 *                    half of them are tombstones: grep would return a retracted
 *                    message and a deleted thread as live results
 *   proposed changes changes-store.js, title + instruction + the proposed body
 *   history entries  history-store.js, title + detail
 *
 * WHAT IS NOT SEARCHED, said out loud in the UI as well as here, because a
 * search box is a machine for making people believe they have seen everything:
 *
 *   - LABELS AND CATEGORIES. Not omitted, ABSENT: nothing in a project carries
 *     one. There is no tagging model, so a Label facet would be an empty group
 *     that reads as a bug. Folder and Content type stand in, and the rail says
 *     so where a user would otherwise wonder.
 *   - ANOTHER WORKSPACE. A project is the space. Search reaches the connected
 *     roots and nothing else — there is no index of projects you have not
 *     connected, and inventing one would be a filesystem crawl nobody asked for.
 *   - PERMISSIONS. There is no access model in this product (constraint 4), so
 *     nothing here can be hidden from anyone, and this file does not pretend
 *     otherwise. Every hit is a file the user's own process can already read.
 *   - HISTORY SNAPSHOTS. history-store.js keeps a full document snapshot per
 *     entry, so searching them would return the same sentence once per version
 *     it survived — twenty hits for one paragraph. The entry's own title and
 *     detail are searched; its snapshot is not.
 *
 * ON DEMAND, AND CANCELLABLE. There is no background index. The walk is started
 * by a debounced keystroke and abandoned by the next one, which is the only
 * honest arrangement here: an ambient indexer over a project the user is
 * actively editing spends its life being wrong, and this product's documents are
 * a few kilobytes each. What makes a repeat search cheap instead is the mtime
 * cache in search-scan.js.
 *
 * Everything that can be decided without a DOM lives in search-scan.js and is
 * driven by a node suite. This file is the walk, the paint, and the keyboard.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { open } = require('@theia/core/lib/browser/opener-service');
const { fileTypeSettings } = require('./file-type-settings');
const { activeProject } = require('./active-project');
const { ICONS } = require('./icons');
const { esc, avatarHtml, relativeTime } = require('./comment-ui');
const { authorRecord } = require('./identity');
const { loaderMarkup } = require('./loader');
const { CommentLog, foldOps } = require('./comment-log');
const { ChangesStore } = require('./changes-store');
const { HistoryStore } = require('./history-store');
const scan = require('./search-scan');

const SEARCH_WIDGET_ID = 'studio-search';

/*
 * 220ms. Below ~150ms a fluent typist starts a walk per character and every one
 * of them is thrown away; above ~300ms the field feels like it is thinking about
 * whether to help. This is also the number the product's other debounces sit
 * near (comment-log's watcher uses 150ms for a much cheaper job).
 */
const DEBOUNCE_MS = 220;

/* loader.js's own figure, restated here because this surface gates its whole
 * scanning block rather than calling showLoading: nothing appears for a wait
 * under 140ms, so a search that resolves out of the cache never flashes. */
const LOADER_DELAY_MS = 140;

/* Results stream, but not per hit: a repaint per hit on a 900-hit query is
 * hundreds of full re-renders. This is fast enough to read as "arriving" and
 * slow enough to be free. */
const PAINT_THROTTLE_MS = 90;

/*
 * Rows actually put into the DOM. A CAP, therefore REPORTED — see the note row
 * at the foot of the results. 400 rows is already twenty screens; the fix for
 * needing more is a filter, and the rail is right there.
 */
const MAX_RENDERED_ROWS = 400;

/*
 * Directories the walk never enters.
 *
 * `.studio` is not "ignored" — it is the sidecar home, and its contents are read
 * through comment-log/changes-store/history-store, which know that a `.jsonl` is
 * an op log and not a paragraph. Walking it as text would double every comment
 * (once folded, once raw) and resurrect tombstoned ones.
 *
 * `.git` and `node_modules` are excluded because they are not the user's prose
 * and are, between them, most of the bytes in any real project.
 */
const SKIP_DIRS = new Set(['.studio', '.git', 'node_modules']);

/*
 * How deep the walk goes. Not a performance number — a TERMINATION one: a
 * symlink pointing at its own ancestor makes the recursion below infinite, and
 * the file service will happily resolve the same directory forever under a
 * longer and longer path. Twelve is far past anything a document project has;
 * a source tree that needs more is not what this walk is for.
 */
const MAX_WALK_DEPTH = 12;

const RECENT_KEY = 'studio-search-recent';
const MAX_RECENT = 6;

/* ⌘ on a Mac, Ctrl elsewhere. The keyboard row at the foot is a promise about
 * which key, so it has to be the right one — and this product ships as a macOS
 * application first, which is exactly why the fallback is easy to forget. */
const IS_MAC = /Mac|iPhone|iPad/.test((globalThis.navigator && globalThis.navigator.platform) || '');
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/** The query's marks, as HTML. Offsets come from search-scan and are trusted. */
function markedText(text, offsets) {
    const source = String(text == null ? '' : text);
    let out = '';
    let at = 0;
    for (const range of (offsets || []).slice().sort((a, b) => a.start - b.start)) {
        // Overlaps are already merged by search-scan.mergeRanges; a range that
        // still starts behind the cursor would nest a <mark> inside a <mark>.
        if (range.start < at) { continue; }
        out += esc(source.slice(at, range.start)) +
            '<mark>' + esc(source.slice(range.start, range.start + range.length)) + '</mark>';
        at = range.start + range.length;
    }
    return out + esc(source.slice(at));
}

/* Root-relative path of a file URI under a root URI. */
function relativeTo(rootString, uriString) {
    return uriString.startsWith(rootString) ? uriString.slice(rootString.length).replace(/^\//, '') : uriString;
}

class SearchWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.messageService = ctx.messageService;
        // Not used today. Kept because every product widget takes the same ctx
        // shape, and the first thing this page will want is "open the Project
        // page to widen the file types" as a real command rather than a hint.
        this.commandRegistry = ctx.commandRegistry;

        /* The three op-log readers, constructed once. Each one resolves a
         * document's root itself, so nothing here has to thread roots through. */
        this.commentLog = new CommentLog(ctx.fileService, ctx.workspaceService);
        this.changesStore = new ChangesStore(ctx.fileService, ctx.workspaceService);
        this.historyStore = new HistoryStore(ctx.fileService, ctx.workspaceService);

        // -- state -----------------------------------------------------------
        this.query = scan.parseQuery('');
        this.filters = {};                 // dimension -> [value]
        this.hits = [];                    // every hit found, unfiltered
        this.visible = [];                 // ranked + filtered, what the rows are
        this.rows = [];                    // the subset actually in the DOM
        this.selected = -1;
        this.scope = 'all';                // 'all' or a root uri string
        this.since = undefined;            // the 'Since a date' value, if set
        this.labels = new Map();           // facet value -> display name
        this.stats = { files: 0, ops: 0, skipped: 0, capped: 0 };
        this.progress = { done: 0, total: 0 };
        this.scanning = false;
        this.token = undefined;
        this.cache = new scan.ScanCache();
        this.disposables = [];

        this.id = SEARCH_WIDGET_ID;
        this.title.label = 'Search';
        this.title.caption = 'Search this project';
        this.title.closable = true;
        /* The dock tab takes a codicon class, like the Project page's tab does;
         * ICONS.search is this product's own 19px magnifier and is drawn in the
         * query row below, where there is room for the product's stroke
         * language. Two glyphs for one thing, in two places with two different
         * constraints — the same split the activity rail already lives with. */
        this.title.iconClass = 'codicon codicon-search';
        this.addClass('studio-search');

        /*
         * Built once; only the parts that change are re-rendered. The query
         * input in particular must never be re-created — every keystroke
         * triggers a scan, a scan repaints, and a repaint that rebuilt the input
         * would drop the caret on the second character. Same reason the Project
         * page syncs its checkboxes in place.
         */
        this.node.innerHTML =
            '<div class="studio-search-shell">' +
            /*
             * 1. The query row. The count sits BESIDE the field rather than
             * above the results, because it is the answer to what was typed and
             * belongs where the typing is.
             */
            '  <div class="studio-search-query">' +
            '    <span class="studio-search-glyph" aria-hidden="true">' + ICONS.search + '</span>' +
            '    <input class="studio-search-input" type="text" spellcheck="false" autocomplete="off" ' +
            'placeholder="Search documents, comments, changes and history" aria-label="Search this project" ' +
            'data-search-input>' +
            '    <span class="studio-search-count" data-search-count aria-live="polite"></span>' +
            '    <label class="studio-search-scope-label">' +
            '      <span class="studio-visually-hidden">Where to search</span>' +
            '      <select class="studio-search-scope" data-search-scope></select>' +
            '    </label>' +
            '  </div>' +

            /*
             * 2. The chip row: what is currently narrowing the results, and —
             * pushed to the far right — what was actually read to produce them.
             *
             * The honesty line is on this row and not in a footer on purpose. It
             * is the counterweight to the chips: chips say "you are seeing less
             * than everything because you asked", the honesty line says "you are
             * seeing less than everything because we stopped". A user who
             * concludes "it isn't in the project" has to be able to see both
             * reasons at once.
             */
            '  <div class="studio-search-chips" data-search-chips></div>' +

            // 3. The body: facet rail, results.
            '  <div class="studio-search-body">' +
            '    <aside class="studio-search-facets" data-search-facets aria-label="Filters"></aside>' +
            '    <div class="studio-search-results" data-search-results tabindex="-1"></div>' +
            '  </div>' +

            /*
             * 4. The keyboard row. Every one of these is implemented — see
             * onKeyDown. A shortcut legend that lists a key nothing handles is
             * worse than no legend, because it is checked once and trusted
             * afterwards.
             */
            '  <div class="studio-search-keys">' +
            '    <span><kbd>↑</kbd><kbd>↓</kbd> move</span>' +
            '    <span><kbd>↵</kbd> open in place</span>' +
            '    <span><kbd>' + esc(MOD_LABEL) + '</kbd><kbd>↵</kbd> open in a new tab</span>' +
            '    <span><kbd>⌫</kbd> drop the last filter</span>' +
            '    <span><kbd>esc</kbd> back to the document</span>' +
            '  </div>' +
            '</div>';

        this.inputEl = this.node.querySelector('[data-search-input]');
        this.countEl = this.node.querySelector('[data-search-count]');
        this.scopeEl = this.node.querySelector('[data-search-scope]');
        this.chipsEl = this.node.querySelector('[data-search-chips]');
        this.facetsEl = this.node.querySelector('[data-search-facets]');
        this.resultsEl = this.node.querySelector('[data-search-results]');

        this.inputEl.addEventListener('input', () => this.onInput());
        this.scopeEl.addEventListener('change', () => this.onScopeChanged());
        this.node.addEventListener('click', event => this.onClick(event));
        this.node.addEventListener('change', event => this.onChange(event));
        // Not capture: the input's own editing keys must win, and the ones this
        // handles (arrows, Enter, Escape, Backspace-on-empty) are ones no field
        // in this widget needs.
        this.node.addEventListener('keydown', event => this.onKeyDown(event));

        // Roots can be connected or disconnected from anywhere while this tab
        // sits open, and the scope control is a list of them.
        try {
            this.disposables.push(this.workspaceService.onWorkspaceChanged(() => this.renderScope()));
        } catch (e) {
            console.warn('[studio] search could not follow workspace changes', e);
        }
        /*
         * CACHE INVALIDATION, and what is actually load-bearing here.
         *
         * The mtime is the CORRECTNESS mechanism: every scan re-stats every file
         * as it walks, and a cached entry is only used when its mtime still
         * matches, so a stale hit cannot be shown even if this listener never
         * fires. This listener is the PROMPTNESS mechanism — it drops the bytes
         * as soon as they are known to be dead, so the next scan does not carry
         * a whole project's superseded text in memory.
         *
         * It is deliberately not treated as more than that. `onDidFilesChange`
         * only reports resources something has asked to watch (the trap
         * documented in comment-log.js and repositories-view.js), and this
         * widget registers no watches of its own — so what arrives here is
         * whatever the review pipeline and the open documents already watch.
         * Best-effort by construction, which is fine for a hint and would not
         * have been fine for the guarantee.
         */
        try {
            this.disposables.push(this.fileService.onDidFilesChange(event => {
                for (const change of (event && event.changes) || []) {
                    if (change.resource) { this.cache.invalidate(change.resource.toString()); }
                }
            }));
        } catch (e) {
            console.warn('[studio] search could not follow file changes', e);
        }
        // The scope control's default ("this project") follows the Projects
        // panel, so it has to follow the panel's changes too.
        this.disposables.push(activeProject.onChanged(() => { if (!this.isDisposed) { this.renderScope(); } }));
    }

    onAfterAttach(message) {
        super.onAfterAttach(message);
        this.renderScope();
        this.render();
        // The tab was opened to type in. Focus goes to the field on the tick
        // after attach, because Lumino activates the widget after this message
        // and would take it back.
        setTimeout(() => { if (!this.isDisposed) { this.inputEl.focus(); } }, 0);
    }

    onActivateRequest(message) {
        super.onActivateRequest(message);
        // Re-activating the tab (⇧⌘F while it is already open) means "search
        // again", so the caret goes back to the query and selects it — the
        // conventional behaviour of every search field, and the reason the
        // keybinding does not need a separate "focus search" command.
        if (this.inputEl) { this.inputEl.focus(); this.inputEl.select(); }
    }

    /*
     * Constraint 27. This widget extends the raw Lumino Widget (there is no
     * TypeScript build here, so there is no Theia BaseWidget to inherit the
     * dispose from), and Lumino's onCloseRequest DETACHES without disposing —
     * which leaves the closed tab in ApplicationShell's FocusTracker forever,
     * so the reopen path finds it by id, skips construction, and activates a
     * widget that belongs to no area: the "close it once and it never opens
     * again" bug, already fixed this way in markdown-editor.js and
     * project-page.js.
     *
     * There is one more reason here than there is on those pages: an in-flight
     * scan holds a cancellation token, a debounce timer and a paint timer, and
     * a walk that keeps reading a project into a detached widget is not merely
     * untidy — it is filesystem work nobody will ever see the result of.
     */
    onCloseRequest(message) {
        this.stopWork();
        for (const disposable of this.disposables) {
            try { disposable.dispose(); } catch (e) { /* already gone */ }
        }
        this.disposables = [];
        this.cache.clear();
        super.onCloseRequest(message);
        this.dispose();
    }

    stopWork() {
        clearTimeout(this.debounceTimer);
        clearTimeout(this.paintTimer);
        clearTimeout(this.loaderTimer);
        this.debounceTimer = undefined;
        this.paintTimer = undefined;
        this.loaderTimer = undefined;
        if (this.token) { this.token.cancel(); }
        this.token = undefined;
        this.scanning = false;
    }

    // -- scope ---------------------------------------------------------------

    async rootsInScope() {
        let roots = [];
        try {
            roots = await this.workspaceService.roots;
        } catch (e) {
            console.warn('[studio] search could not read the workspace roots', e);
            return [];
        }
        if (this.scope === 'all') { return roots; }
        return roots.filter(root => root.resource.toString() === this.scope);
    }

    async renderScope() {
        if (this.isDisposed) { return; }
        let roots = [];
        try {
            roots = await this.workspaceService.roots;
        } catch (e) { /* reported by the scan itself */ }
        if (this.isDisposed) { return; }
        /* "All connected projects" is first and is the default, because a
         * cross-project search is the one a workspace with several roots exists
         * to make possible — and it is the only scope that can honestly claim to
         * have looked everywhere the product can reach. */
        const options = ['<option value="all">All connected projects</option>'].concat(
            roots.map(root => '<option value="' + esc(root.resource.toString()) + '">' +
                esc(root.resource.path.base) + '</option>'));
        this.scopeEl.innerHTML = options.join('');
        // A root that has gone away cannot stay selected.
        if (this.scope !== 'all' && !roots.some(root => root.resource.toString() === this.scope)) { this.scope = 'all'; }
        this.scopeEl.value = this.scope;
        for (const root of roots) { this.labels.set(root.resource.toString(), root.resource.path.base); }
    }

    onScopeChanged() {
        this.scope = this.scopeEl.value || 'all';
        // The project facet is a subset of the scope, so a narrowed scope makes
        // any project chip a statement about a project that is no longer being
        // searched. Dropping it is the only reading that stays true.
        if (this.scope !== 'all') { delete this.filters.project; }
        this.startSearch(true);
    }

    // -- input ---------------------------------------------------------------

    onInput() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.startSearch(false), DEBOUNCE_MS);
    }

    /**
     * Begin (or re-begin) a search.
     *
     * @param immediate skip the debounce — a facet click, a scope change, or a
     *                  recent search being replayed, none of which are typing
     */
    startSearch(immediate) {
        clearTimeout(this.debounceTimer);
        if (immediate) { this.debounceTimer = undefined; }
        const raw = this.inputEl.value;
        const parsed = scan.parseQuery(raw, Date.now());

        /*
         * A query that only says HOW to filter and never says WHAT to look for
         * is not a search. `type:comment` alone would walk every project and
         * return every comment in it, which is a report, not an answer — and it
         * would do so on the third keystroke of typing `type:comment budget`.
         */
        if (parsed.empty) {
            this.stopWork();
            this.query = parsed;
            this.hits = [];
            this.visible = [];
            this.stats = { files: 0, ops: 0, skipped: 0, capped: 0 };
            this.render();
            return;
        }

        // The prefixes are filters, and a filter typed into the field is the
        // same filter as one ticked in the rail — merged, so the chip row shows
        // what was typed and the tick appears in the group it belongs to.
        this.query = parsed;
        this.applyQueryPrefixes(parsed);
        this.runScan(parsed);
    }

    /*
     * A prefix typed into the field BECOMES a chip, and stays one.
     *
     * Deleting `type:comment` from the query does not remove the filter — the
     * chip does, and the chip is on screen with an × on it. That is deliberate:
     * the alternative is a field whose text is the sole authority on the
     * filters, which means a checkbox ticked in the rail must either write
     * itself back into the query string (turning the user's own typing into
     * generated text under their caret) or be silently dropped on the next
     * keystroke. One representation, one place to remove it.
     */
    applyQueryPrefixes(parsed) {
        const union = (key, values) => {
            if (!values || !values.length) { return; }
            const current = new Set(this.filters[key] || []);
            values.forEach(value => current.add(value));
            this.filters[key] = [...current];
        };
        union('type', parsed.types);
        /*
         * `by:claude` names an agent by the token identity.js already
         * understands, so the record it resolves to is the same one a folded op
         * carries — which is what makes the typed filter and the ticked
         * checkbox the same filter rather than two that look alike.
         */
        union('contributor', (parsed.authors || []).map(name => authorRecord(name).id));
        if (parsed.after) { union('changed', [parsed.after]); }
        if (parsed.after && /^since:/.test(parsed.after)) { this.since = parsed.after.slice('since:'.length); }
    }

    // -- the scan ------------------------------------------------------------

    /*
     * One walk, cancellable, streaming.
     *
     * The shape is: discover everything cheaply (directory stats only), then
     * read. Discovery first is what makes the progress bar honest — a bar over
     * an unknown total is a decoration — and directory resolution is orders of
     * magnitude cheaper than reading, so the first hits still paint promptly.
     */
    async runScan(query) {
        this.stopWork();
        const token = scan.makeCancelToken();
        this.token = token;
        this.scanning = true;
        this.hits = [];
        this.visible = [];
        this.selected = -1;
        this.stats = { files: 0, ops: 0, skipped: 0, capped: 0 };
        this.progress = { done: 0, total: 0 };
        /* The scanning block only appears if the wait is long enough to be
         * perceived as one. A search served entirely from the mtime cache
         * finishes inside this delay and never flashes a loader. */
        this.showLoaderAt = Date.now() + LOADER_DELAY_MS;
        this.loaderTimer = setTimeout(() => { if (!this.isDisposed && this.scanning) { this.render(); } }, LOADER_DELAY_MS);

        try {
            const plan = await this.discover(token);
            if (token.cancelled || this.isDisposed) { return; }
            this.progress.total = plan.length;
            this.render();

            for (const entry of plan) {
                if (token.cancelled || this.isDisposed) { return; }
                await this.readEntry(entry, query, token);
                this.progress.done++;
                this.schedulePaint();
            }
        } catch (e) {
            console.error('[studio] the search walk failed', e);
            if (this.messageService) {
                this.messageService.error('Search could not finish reading this project. See the console for what stopped it.');
            }
        } finally {
            if (this.token === token) {
                this.scanning = false;
                clearTimeout(this.loaderTimer);
                if (!token.cancelled && !this.isDisposed) {
                    this.paint();
                    this.rememberSearch();
                }
            }
        }
    }

    /**
     * Everything that will be read, before anything is read.
     *
     * @returns [{ root, rootName, path, uri, mtime, hasText, sidecars }]
     */
    async discover(token) {
        const roots = await this.rootsInScope();
        const plan = [];
        for (const root of roots) {
            if (token.cancelled) { return plan; }
            const rootString = root.resource.toString();
            const name = root.resource.path.base;
            this.labels.set(rootString, name);

            const files = new Map();       // relative path -> { uri, mtime }
            await this.walk(root.resource, rootString, files, token);
            const sidecars = await this.collectSidecars(root.resource, token);
            if (token.cancelled) { return plan; }

            /*
             * The union of "files on disk" and "documents with sidecars".
             *
             * The second half matters and is easy to miss: a document that was
             * deleted still has its comment log, and a comment is a thing
             * somebody wrote and will search for. Its hits are reported against
             * the path the log names, which is the only address it has. The
             * union is still filtered by the project's own file-type policy
             * below, so a sidecar cannot smuggle in a document type the project
             * has chosen not to show.
             */
            const paths = new Set([...files.keys(), ...sidecars.comments, ...sidecars.changes, ...sidecars.history]);
            for (const path of [...paths].sort()) {
                const known = files.get(path);
                if (!known && !this.allowsPath(root.resource, path)) { continue; }
                plan.push({
                    root: root.resource,
                    rootString,
                    rootName: name,
                    path,
                    uri: known ? known.uri : rootString + '/' + path,
                    mtime: known ? known.mtime : 0,
                    size: known ? known.size : 0,
                    hasText: !!known,
                    sidecars: {
                        comments: sidecars.comments.has(path),
                        changes: sidecars.changes.has(path),
                        history: sidecars.history.has(path)
                    }
                });
            }
        }
        return plan;
    }

    /* The project's own allowed-extension policy, asked of a root-relative
     * path. fileTypeSettings.allows takes a URI, and a sidecar path has no file
     * on disk to build one from, so the URI is synthesised. */
    allowsPath(rootUri, path) {
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            return fileTypeSettings.allows(new URI(rootUri.toString() + '/' + path), false);
        } catch (e) {
            return false;
        }
    }

    /*
     * Depth-first, one directory resolve at a time.
     *
     * fileService.resolve returns children with metadata, so this collects
     * mtimes and sizes for free — which is what the cache is keyed by and what
     * the size cap is checked against, both WITHOUT reading a byte.
     */
    async walk(dirUri, rootString, into, token, depth = 0) {
        if (token.cancelled || depth > MAX_WALK_DEPTH) { return; }
        let stat;
        try {
            stat = await this.fileService.resolve(dirUri);
        } catch (e) {
            // A directory that vanished mid-walk, or one on an unmounted
            // volume. Counted as skipped rather than thrown: one unreadable
            // folder must not cost the user the whole search.
            this.stats.skipped++;
            return;
        }
        for (const child of (stat && stat.children) || []) {
            if (token.cancelled) { return; }
            const base = child.resource.path.base;
            if (child.isDirectory) {
                if (SKIP_DIRS.has(base)) { continue; }
                await this.walk(child.resource, rootString, into, token, depth + 1);
                continue;
            }
            if (!fileTypeSettings.allows(child.resource, false)) { continue; }
            into.set(relativeTo(rootString, child.resource.toString()), {
                uri: child.resource.toString(),
                // 0 means "no usable stamp", which the cache treats as
                // always-changed rather than as a cache key everything shares.
                mtime: Number(child.mtime) || 0,
                size: Number(child.size) || 0
            });
        }
    }

    /**
     * Which documents have comment logs, proposals, or history — one shallow
     * walk of `.studio/` per root instead of three existence probes per file.
     *
     * On a project with 1,200 documents and comments on nine of them, the probe
     * version costs 3,600 filesystem calls to discover nine. This costs three
     * directory walks.
     */
    async collectSidecars(rootUri, token) {
        const found = { comments: new Set(), changes: new Set(), history: new Set() };
        const { URI } = require('@theia/core/lib/common/uri');
        const base = rootUri.toString() + '/.studio';

        /* comments/<rel>/  is a DIRECTORY of per-author .jsonl logs;
         * comments/<rel>.json is the legacy sidecar. Both name one document. */
        await this.walkSidecar(new URI(base + '/comments'), base + '/comments', token, (rel, isDirectory, hasLogs) => {
            if (isDirectory && hasLogs) { found.comments.add(rel); }
            if (!isDirectory && rel.endsWith('.json')) { found.comments.add(rel.slice(0, -'.json'.length)); }
        });
        await this.walkSidecar(new URI(base + '/changes'), base + '/changes', token, (rel, isDirectory) => {
            // index.json at the top is the workspace-wide pending index, not a
            // document's proposals.
            if (!isDirectory && rel.endsWith('.json') && rel !== 'index.json') { found.changes.add(rel.slice(0, -'.json'.length)); }
        });
        await this.walkSidecar(new URI(base + '/history'), base + '/history', token, (rel, isDirectory) => {
            if (!isDirectory && rel.endsWith('.json')) { found.history.add(rel.slice(0, -'.json'.length)); }
        });
        return found;
    }

    async walkSidecar(dirUri, prefix, token, visit) {
        if (token.cancelled) { return; }
        let stat;
        try {
            // A project with no comments has no .studio/comments, and that is
            // the common case rather than an error.
            if (!(await this.fileService.exists(dirUri))) { return; }
            stat = await this.fileService.resolve(dirUri);
        } catch (e) {
            return;
        }
        for (const child of (stat && stat.children) || []) {
            if (token.cancelled) { return; }
            const rel = relativeTo(prefix, child.resource.toString());
            if (child.isDirectory) {
                /* A log directory is one whose own children are .jsonl files.
                 * Anything else is an intermediate folder mirroring the
                 * document tree, so the walk continues through it. */
                let logs = false;
                try {
                    const inner = await this.fileService.resolve(child.resource);
                    logs = ((inner && inner.children) || []).some(entry =>
                        !entry.isDirectory && entry.resource.path.base.endsWith('.jsonl'));
                } catch (e) { /* treated as not a log directory */ }
                visit(rel, true, logs);
                if (!logs) { await this.walkSidecar(child.resource, prefix, token, visit); }
                continue;
            }
            visit(rel, false, false);
        }
    }

    /** Every hit one document can produce, pushed onto this.hits. */
    async readEntry(entry, query, token) {
        const common = {
            project: entry.rootString,
            projectName: entry.rootName,
            path: entry.path,
            uri: entry.uri,
            dir: scan.folderOf(entry.path),
            name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
            glyph: scan.fileGlyphKind(entry.path)
        };

        if (entry.hasText) { await this.readText(entry, query, token, common); }
        if (token.cancelled) { return; }
        if (entry.sidecars.comments) { await this.readComments(entry, query, token, common); }
        if (token.cancelled) { return; }
        if (entry.sidecars.changes) { await this.readChanges(entry, query, token, common); }
        if (token.cancelled) { return; }
        if (entry.sidecars.history) { await this.readHistory(entry, query, token, common); }
    }

    async readText(entry, query, token, common) {
        if (entry.size > scan.MAX_FILE_BYTES) {
            // Reported, not silent: this is exactly the case where "no results"
            // and "we did not look" would otherwise be indistinguishable.
            this.stats.skipped++;
            return;
        }
        const key = scan.queryKey(query);
        let matched = entry.mtime ? this.cache.hits(entry.uri, entry.mtime, key) : undefined;
        if (!matched) {
            let text = entry.mtime ? this.cache.text(entry.uri, entry.mtime) : undefined;
            if (text === undefined) {
                try {
                    const { URI } = require('@theia/core/lib/common/uri');
                    text = (await this.fileService.read(new URI(entry.uri))).value;
                } catch (e) {
                    this.stats.skipped++;
                    return;
                }
                if (token.cancelled) { return; }
                if (scan.isProbablyBinary(text)) {
                    // A .png that the project's file-type policy allows. Not an
                    // error, and not searchable either.
                    this.stats.skipped++;
                    return;
                }
                if (entry.mtime) { this.cache.putText(entry.uri, entry.mtime, text); }
            }
            const result = scan.matchLines(text, query);
            if (result.truncated) { this.stats.capped++; }
            matched = result.hits;
            if (entry.mtime) { this.cache.putHits(entry.uri, entry.mtime, key, matched); }
        }
        this.stats.files++;
        for (const hit of matched) {
            this.hits.push({
                ...common,
                kind: hit.kind,
                line: hit.line,
                section: hit.section,
                text: hit.text,
                offsets: hit.offsets,
                /* A document line's "changed" is the FILE's mtime. It is the
                 * only timestamp a line has, and it is the one a user means by
                 * "changed today" — they are thinking of the document, not of
                 * the line. */
                changedAt: entry.mtime || undefined
            });
        }
    }

    /*
     * Comments come from the FOLD, never from the bytes.
     *
     * foldOps applies tombstones: a retracted message and a deleted thread are
     * still physically present in the log files and would both be returned by
     * anything that read them as text. Reusing comment-log.js's own fold is
     * therefore not tidiness — it is the difference between search results a
     * user can act on and search results that resurrect things somebody
     * deliberately withdrew.
     */
    async readComments(entry, query, token, common) {
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            const docUri = new URI(entry.uri);
            const base = await this.commentLog.readLegacy(entry.root, docUri);
            const ops = await this.commentLog.readOps(entry.root, docUri);
            if (token.cancelled) { return; }
            this.stats.ops += ops.length;
            for (const thread of foldOps(base, ops)) {
                for (const message of thread.messages || []) {
                    const snippet = scan.matchSnippet(message.body, query);
                    if (!snippet) { continue; }
                    this.hits.push({
                        ...common,
                        kind: 'comment',
                        text: snippet.text,
                        offsets: snippet.offsets,
                        /* The quoted anchor is the "where" for a comment, in
                         * place of the line number a document hit has. */
                        section: thread.quote ? thread.quote.slice(0, 60) : '',
                        author: authorRecord(message.by || message.author),
                        at: message.at,
                        changedAt: message.at,
                        status: thread.resolved ? 'resolved' : 'open'
                    });
                }
            }
        } catch (e) {
            console.warn('[studio] search could not fold the comments for', entry.path, e);
            this.stats.skipped++;
        }
    }

    /*
     * A proposal is searched on what a person wrote — its title and the
     * instruction that produced it — and on the body it proposes.
     *
     * The BASE body is deliberately not searched. It is the document as it was
     * before, so every unchanged line of it would match twice: once as the
     * document, once as the proposal's memory of the document.
     */
    async readChanges(entry, query, token, common) {
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            const store = await this.changesStore.load(new URI(entry.uri));
            if (token.cancelled) { return; }
            for (const proposal of store.proposals || []) {
                const where = [proposal.title, proposal.instruction, proposal.proposedBody];
                let snippet;
                for (const candidate of where) {
                    snippet = scan.matchSnippet(candidate, query);
                    if (snippet) { break; }
                }
                if (!snippet) { continue; }
                this.hits.push({
                    ...common,
                    kind: 'change',
                    text: snippet.text,
                    offsets: snippet.offsets,
                    section: proposal.title || '',
                    author: authorRecord(proposal.author),
                    at: proposal.createdAt,
                    changedAt: proposal.createdAt,
                    // Resolved proposals are not loaded by the store at all, so
                    // anything here is open by construction.
                    status: 'open'
                });
            }
        } catch (e) {
            console.warn('[studio] search could not read the proposals for', entry.path, e);
            this.stats.skipped++;
        }
    }

    async readHistory(entry, query, token, common) {
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            const store = await this.historyStore.load(new URI(entry.uri));
            if (token.cancelled) { return; }
            for (const record of store.entries || []) {
                // The snapshot is not searched — see the header.
                const snippet = scan.matchSnippet(record.title, query) || scan.matchSnippet(record.detail, query);
                if (!snippet) { continue; }
                this.hits.push({
                    ...common,
                    kind: 'history',
                    text: snippet.text,
                    offsets: snippet.offsets,
                    section: record.label || '',
                    author: authorRecord(record.author),
                    at: record.at,
                    changedAt: record.at
                });
            }
        } catch (e) {
            console.warn('[studio] search could not read the history for', entry.path, e);
            this.stats.skipped++;
        }
    }

    // -- painting ------------------------------------------------------------

    schedulePaint() {
        if (this.paintTimer) { return; }
        this.paintTimer = setTimeout(() => {
            this.paintTimer = undefined;
            if (!this.isDisposed) { this.paint(); }
        }, PAINT_THROTTLE_MS);
    }

    paint() { this.render(); }

    render() {
        if (this.isDisposed) { return; }
        const now = Date.now();
        this.visible = scan.rankHits(scan.applyFilters(this.hits, this.filters, now), { ...this.query, now });
        this.renderCount();
        this.renderChips();
        this.renderFacets(now);
        this.renderResults(now);
    }

    renderCount() {
        const files = new Set(this.visible.map(hit => hit.uri)).size;
        this.countEl.textContent = this.query.empty ? '' : scan.countText(this.visible.length, files);
    }

    renderChips() {
        const chips = [];
        for (const key of scan.FACET_KEYS) {
            for (const value of this.filters[key] || []) {
                chips.push(
                    '<span class="studio-chip">' +
                    '<span class="studio-chip-key">' + esc(scan.CHIP_LABEL[key]) + '</span>' +
                    '<b>' + esc(this.valueLabel(key, value)) + '</b>' +
                    '<button class="studio-chip-x" data-act="drop" data-facet="' + esc(key) + '" ' +
                    'data-value="' + esc(value) + '" aria-label="Remove this filter" title="Remove this filter">' +
                    ICONS.close + '</button></span>');
            }
        }
        const honesty = this.query.empty ? '' : scan.honestyLine(this.stats);
        this.chipsEl.innerHTML =
            (chips.length ? chips.join('') + '<button class="studio-search-clear" data-act="clear-all">Clear all</button>' : '') +
            '<span class="studio-search-honesty" title="What this search actually read">' + esc(honesty) + '</span>';
        // The row is 9px/22px of padding around nothing when there is nothing to
        // say; an empty band above the results reads as a rendering fault.
        this.chipsEl.hidden = !chips.length && !honesty;
    }

    valueLabel(key, value) {
        if (key === 'type') {
            const type = scan.CONTENT_TYPES.find(candidate => candidate.value === value);
            return type ? type.label : value;
        }
        if (key === 'changed') {
            const bucket = scan.DATE_BUCKETS.find(candidate => candidate.value === value);
            if (bucket) { return bucket.label; }
            return /^since:/.test(value) ? 'Since ' + value.slice('since:'.length) : value;
        }
        if (key === 'folder') { return scan.folderLabel(value); }
        return this.labels.get(value) || value;
    }

    /*
     * THE OMISSION, STATED. Without this note the rail looks like it is missing
     * two groups every faceted search has, and a missing group is
     * indistinguishable from a broken one. With it, the absence is a fact about
     * the product: there is no tagging model, so there is nothing a Label facet
     * could count. It is at the FOOT of the rail because it is a footnote about
     * the rail — leading with a list of what is missing is not an introduction.
     */
    facetNote() {
        return '<p class="studio-facet-note">No Label or Category filter: nothing in a project carries one — there is no ' +
            'tagging model to filter on. <b>Folder</b> and <b>Content type</b> are what stand in for them.</p>';
    }

    renderFacets(now) {
        // Nothing typed: there are no hits to fold into facets, and a rail of
        // zeroes reads as a broken rail rather than an empty one.
        if (this.query.empty) {
            if (this.facetSignature !== 'idle') {
                this.facetsEl.innerHTML = '<p class="studio-facet-note">Filters appear here once there is something to ' +
                    'filter. Type to search.</p>' + this.facetNote();
                this.facetSignature = 'idle';
            }
            return;
        }

        const facets = scan.facetsFor(this.hits, this.filters, { now, labels: this.labels, since: this.since });
        const plan = [
            ['project', facets.project], ['type', facets.type], ['contributor', facets.contributor],
            ['changed', facets.changed], ['folder', facets.folder]
        ];
        const flat = [];
        for (const [key, rows] of plan) { for (const row of rows) { flat.push([key, row]); } }
        const signature = plan.map(([key, rows]) => key + ':' + rows.map(row => row.value).join('|')).join(';');

        /*
         * IN PLACE WHENEVER THE ROWS ARE THE SAME ROWS, and this is not an
         * optimisation — it is the only way the rail is usable from the
         * keyboard.
         *
         * Every tick re-renders (filters are applied to the hit list, so a
         * click is a repaint), and a repaint that rebuilt the DOM would destroy
         * the very checkbox that was just clicked and drop focus with it — so a
         * keyboard user could never tick a second value, and the streaming
         * repaint during a scan would fight anyone touching the rail. Exactly
         * the bug project-page.js's renderTypes documents, in exactly the same
         * shape, so it is fixed the same way.
         *
         * Positional rather than by selector on purpose: facet values are
         * project URIs, folder paths and ISO dates, and building an attribute
         * selector out of those is a quoting bug waiting to happen. The
         * signature guarantees the order and membership are identical, which is
         * what makes position a safe key.
         */
        const labels = [...this.facetsEl.querySelectorAll('.studio-facet:not(.studio-facet-since)')];
        if (signature === this.facetSignature && labels.length === flat.length) {
            labels.forEach((label, index) => {
                const [key, row] = flat[index];
                const on = (this.filters[key] || []).includes(row.value);
                const dead = !row.count && !on;
                const input = label.querySelector('input');
                if (input) { input.checked = on; input.disabled = dead; }
                label.classList.toggle('on', on);
                label.classList.toggle('empty', dead);
                const count = label.querySelector('.studio-facet-count');
                if (count) { count.textContent = scan.groupDigits(row.count); }
            });
            return;
        }

        const group = (key, rows) => rows.length
            ? '<div class="studio-facet-group">' +
              '<h4>' + esc(scan.FACET_LABEL[key]) + '</h4>' +
              rows.map(row => this.facetRow(key, row)).join('') +
              (key === 'changed' ? this.sinceRow() : '') +
              '</div>'
            : '';
        this.facetsEl.innerHTML = plan.map(([key, rows]) => group(key, rows)).join('') + this.facetNote();
        this.facetSignature = signature;
    }

    /*
     * Put the keyboard back on the control that was just used, for the case the
     * in-place path above cannot cover: ticking one dimension can remove values
     * from ANOTHER (narrow by project and a folder that only existed in the
     * other project is gone), which changes the signature and forces a rebuild.
     * Without this, the one interaction that legitimately rebuilds the rail is
     * also the one that silently ejects a keyboard user from it.
     */
    refocusFacet(key, value) {
        for (const input of this.facetsEl.querySelectorAll('input[data-facet]')) {
            if (input.getAttribute('data-facet') === key && input.getAttribute('data-value') === value) {
                try { input.focus(); } catch (e) { /* detached, or jsdom */ }
                return;
            }
        }
    }

    facetRow(key, row) {
        const on = (this.filters[key] || []).includes(row.value);
        // A zero row in a closed vocabulary is information ("there are no
        // comments matching this"), but it is not a choice, so it cannot be
        // ticked into a filter that guarantees an empty result.
        const dead = !row.count && !on;
        return '<label class="studio-facet' + (on ? ' on' : '') + (dead ? ' empty' : '') + '">' +
            '<input type="checkbox" data-facet="' + esc(key) + '" data-value="' + esc(row.value) + '"' +
            (on ? ' checked' : '') + (dead ? ' disabled' : '') + '>' +
            '<span class="studio-facet-name" title="' + esc(row.label) + '">' + esc(row.label) + '</span>' +
            '<span class="studio-facet-count">' + esc(scan.groupDigits(row.count)) + '</span></label>';
    }

    /* "Since a date" is a field, not a checkbox: the fourth option in the
     * Changed group is an open value, and pretending otherwise would mean
     * inventing buckets nobody asked for (Last 90 days? Last year?). */
    sinceRow() {
        return '<label class="studio-facet studio-facet-since">' +
            '<span class="studio-facet-name">Since a date</span>' +
            '<input type="date" class="studio-since-input" data-act="since" value="' + esc(this.since || '') + '">' +
            '</label>';
    }

    renderResults(now) {
        if (this.query.empty) { this.resultsEl.innerHTML = this.idleMarkup(); this.rows = []; this.selected = -1; return; }

        const scanning = this.scanning && Date.now() >= this.showLoaderAt;
        const head = scanning ? this.scanningMarkup() : '';

        if (!this.visible.length) {
            // Mid-scan, "nothing yet" is not "nothing" — the no-match state
            // would be a false statement about a project still being read.
            this.resultsEl.innerHTML = head + (this.scanning ? '' : this.emptyMarkup(now));
            this.rows = [];
            return;
        }

        const shown = this.visible.slice(0, MAX_RENDERED_ROWS);
        const groups = scan.groupByFile(shown);
        /*
         * this.rows is filled IN DOM ORDER, not in ranked order.
         *
         * Grouping by file re-sequences the ranked list — a file's second-best
         * hit is drawn immediately under its best one, above another file's
         * better hit — so `visible[n]` and the nth row on screen are different
         * hits. ↑↓ counts rows, so the array the keyboard indexes into has to be
         * the rows. Getting this wrong opens a different file than the one
         * highlighted, which is the worst possible bug in a search result: it
         * looks like the product misunderstood you.
         */
        this.rows = [];
        const body = groups.map(group => {
            const rows = group.hits.map(hit => {
                const index = this.rows.length;
                this.rows.push(hit);
                return this.hitMarkup(hit, index);
            }).join('');
            return '<section class="studio-file-group">' +
                '<header class="studio-file-head">' +
                '<span class="studio-file-glyph icon-' + esc(group.glyph) + '" aria-hidden="true"></span>' +
                '<span class="studio-file-path">' +
                (group.dir ? '<span class="studio-file-dir">' + esc(group.dir) + '/</span>' : '') +
                '<b>' + esc(group.name) + '</b></span>' +
                // Which project, but only when more than one is in scope: a
                // repeated project name on every group in a single-root
                // workspace is ink that says nothing.
                (this.scope === 'all' && this.labels.size > 1
                    ? '<span class="studio-file-project">' + esc(group.projectName) + '</span>' : '') +
                '<span class="studio-file-matches">' + esc(scan.groupDigits(group.matches)) + ' ' +
                esc(scan.plural(group.matches, 'match', 'matches')) + '</span>' +
                '</header>' + rows + '</section>';
        }).join('');

        // The render cap, reported. See MAX_RENDERED_ROWS.
        const more = this.visible.length > shown.length
            ? '<p class="studio-search-more">Showing the first ' + esc(scan.groupDigits(shown.length)) + ' of ' +
              esc(scan.groupDigits(this.visible.length)) + ' matches. Narrow it with a filter to see the rest.</p>'
            : '';

        this.resultsEl.innerHTML = head + body + more;
        this.syncSelection();
    }

    hitMarkup(hit, index) {
        return '<button class="studio-hit" data-hit="' + index + '" type="button">' +
            '<span class="studio-hit-kind">' + esc(scan.KIND_COLUMN[hit.kind] || hit.kind) + '</span>' +
            '<span class="studio-hit-main">' +
            '<span class="studio-hit-line">' + markedText(hit.text, hit.offsets) + '</span>' +
            '<span class="studio-hit-meta">' + this.metaMarkup(hit) + '</span>' +
            '</span></button>';
    }

    /*
     * The 10.5px line under a hit answers "where is this" — and what "where"
     * means depends entirely on the kind, which is why this is a switch rather
     * than one format with blanks in it. A document is at a line, inside a
     * section. A comment is by somebody, at a time, in a thread that is open or
     * resolved. Formatting them the same way would put a line number on a
     * comment and an author on a paragraph.
     */
    metaMarkup(hit) {
        if (hit.kind === 'document' || hit.kind === 'checklist') {
            const parts = [];
            if (hit.line) { parts.push('Line ' + hit.line); }
            if (hit.section) { parts.push(esc(hit.section)); }
            return parts.join(' · ');
        }
        const who = hit.author ? avatarHtml(hit.author) + '<span class="studio-hit-who">' + esc(hit.author.name) + '</span>' : '';
        // A stamp that does not parse gets no <time> at all rather than an
        // "Invalid Date" tooltip: an op log is committed data and can be
        // hand-edited, so a malformed `at` is a thing that happens.
        const stamp = hit.at ? new Date(hit.at) : undefined;
        const when = stamp && Number.isFinite(stamp.getTime())
            ? '<time title="' + esc(stamp.toLocaleString()) + '">' + esc(relativeTime(hit.at)) + '</time>'
            : '';
        const pill = hit.status
            ? '<span class="studio-hit-pill' + (hit.status === 'open' ? ' open' : '') + '">' + esc(hit.status) + '</span>'
            : '';
        const where = hit.section ? '<span class="studio-hit-where">' + esc(hit.section) + '</span>' : '';
        return who + when + pill + where;
    }

    // -- the three states ----------------------------------------------------

    /*
     * Nothing typed. Two lists, and the second one is the point.
     *
     * Recent searches carry their FILTERS and the count they returned, because a
     * recent query without its filters is not the search that was run — clicking
     * it would produce a different number and quietly teach the user that this
     * list lies.
     *
     * "What gets searched" is here rather than behind a help link because the
     * coverage of this feature is genuinely surprising in both directions:
     * comments and history are searched (people do not expect that), labels are
     * not (people do expect that). This is the moment to say so — the user has
     * asked for search and has not yet typed anything to be misled about.
     */
    idleMarkup() {
        const recent = this.readRecent();
        const recentMarkup = recent.length
            ? '<ul class="studio-recent">' + recent.map((item, index) =>
                '<li><button class="studio-recent-btn" data-act="recent" data-recent="' + index + '" type="button">' +
                '<span class="studio-recent-q">' + esc(item.q) + '</span>' +
                (item.chips && item.chips.length
                    ? '<span class="studio-recent-chips">' + item.chips.map(chip => '<span>' + esc(chip) + '</span>').join('') + '</span>'
                    : '') +
                '<span class="studio-recent-count">' + esc(scan.countText(item.matches || 0, item.files || 0)) + '</span>' +
                '</button></li>').join('') + '</ul>'
            : '<p class="studio-search-hint">Nothing searched yet in this session.</p>';

        return '<div class="studio-search-idle">' +
            '<section><h3>Recent searches</h3>' + recentMarkup + '</section>' +
            '<section><h3>What gets searched</h3>' +
            '<ul class="studio-covered">' +
            '<li class="yes">Document text, line by line, in every connected project</li>' +
            '<li class="yes">Checklist items inside those documents</li>' +
            '<li class="yes">Comment threads — every author\'s log, folded, so retracted messages and deleted threads stay gone</li>' +
            '<li class="yes">Proposed changes: the title, the instruction, and the body being proposed</li>' +
            '<li class="yes">History entries: what happened and to what</li>' +
            '<li class="no">Not labels or categories — <b>nothing in a project carries one</b>. There is no tagging ' +
            'model here, so there is nothing to filter on. Folder and Content type stand in.</li>' +
            '<li class="no">Not other workspaces — <b>a project is the space</b>. Search reaches the projects you have ' +
            'connected, and there is no index of the ones you have not.</li>' +
            '<li class="no">Not binaries, and not files over ' + esc(scan.groupDigits(Math.round(scan.MAX_FILE_BYTES / 1024 / 1024))) +
            'MB. Anything skipped is counted on the line above the results.</li>' +
            '<li class="no">Not file types this project has chosen to hide. The Project page decides which ones those are.</li>' +
            '</ul></section></div>';
    }

    /*
     * Scanning. The flip-dot mark, a progress bar, and the honesty line
     * counting up — with results streaming in beneath it rather than after it.
     *
     * The counters move during the wait on purpose. A spinner tells you
     * something is happening; a number climbing past 1,200 files tells you what
     * is happening and roughly how much of it is left, which is the difference
     * between waiting and wondering.
     */
    scanningMarkup() {
        const total = this.progress.total;
        const done = this.progress.done;
        const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
        return '<div class="studio-search-scanning" role="status">' +
            '<div class="studio-scanning-head">' +
            loaderMarkup({ variant: '5x5', size: 14, decorative: true }) +
            '<span>Reading the project…</span>' +
            '<span class="studio-scanning-honesty">' + esc(scan.honestyLine(this.stats)) + '</span>' +
            '</div>' +
            '<div class="studio-scanning-bar' + (total ? '' : ' indeterminate') + '">' +
            '<span style="width:' + percent + '%"></span></div>' +
            '</div>';
    }

    /*
     * No matches — the state that decides whether this feature is trusted.
     *
     * "No results found" covers two opposite situations: the word is not in the
     * project, and the word is in the project but you have hidden it. They call
     * for opposite next actions, so this says which one it is, names the filter
     * responsible, and offers the button that undoes it. The counts come from
     * explainEmpty, which is a pure function with a test.
     */
    emptyMarkup(now) {
        const explained = scan.explainEmpty(this.hits, this.filters, { now });
        // What the user TYPED, not the lowercased terms the matcher works in.
        // Quoting somebody's search back at them in the wrong case reads as a
        // correction.
        const term = this.inputEl.value.trim();
        if (!explained.total) {
            return '<div class="studio-search-empty">' +
                '<h3>No matches for “' + esc(term) + '”</h3>' +
                '<p>Nothing in ' + (this.scope === 'all' ? 'the connected projects' : 'this project') +
                ' contains that. ' + esc(scan.honestyLine(this.stats)) + ' — anything skipped or capped there is a ' +
                'place this search did not look.</p>' +
                (this.scope !== 'all'
                    ? '<div class="studio-search-actions"><button class="studio-btn" data-act="every-project" type="button">Search every project</button></div>'
                    : '') +
                '</div>';
        }
        return '<div class="studio-search-empty">' +
            '<h3>No matches with these filters</h3>' +
            '<p>“' + esc(term) + '” appears <b>' + esc(scan.groupDigits(explained.total)) + ' ' +
            esc(scan.plural(explained.total, 'time')) + '</b> with the filters off.</p>' +
            '<ul class="studio-blame">' + explained.drops.map(drop =>
                '<li><b>' + esc(drop.label) + '</b> is hiding them — ' + esc(drop.note) + ' ' +
                '<button class="studio-btn ghost" data-act="drop-dimension" data-facet="' + esc(drop.key) + '" type="button">' +
                'Drop this filter</button></li>').join('') + '</ul>' +
            '<div class="studio-search-actions">' +
            '<button class="studio-btn" data-act="all-types" type="button">Search all types</button>' +
            '<button class="studio-btn" data-act="clear-all" type="button">Clear all filters</button>' +
            '<button class="studio-btn" data-act="every-project" type="button">Search every project</button>' +
            '</div></div>';
    }

    // -- recent searches -----------------------------------------------------

    /*
     * Per machine, in localStorage, like the display name and for the same
     * reason: what you searched for is yours, not the project's. Writing it to
     * `.studio/` would commit one person's queries into everybody's branch.
     */
    readRecent() {
        try {
            const raw = globalThis.localStorage && globalThis.localStorage.getItem(RECENT_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
        } catch (e) {
            return [];
        }
    }

    rememberSearch() {
        const raw = this.inputEl.value.trim();
        if (!raw) { return; }
        const chips = [];
        for (const key of scan.FACET_KEYS) {
            for (const value of this.filters[key] || []) { chips.push(scan.CHIP_LABEL[key] + ': ' + this.valueLabel(key, value)); }
        }
        const item = {
            q: raw,
            filters: JSON.parse(JSON.stringify(this.filters)),
            scope: this.scope,
            chips,
            matches: this.visible.length,
            files: new Set(this.visible.map(hit => hit.uri)).size,
            at: new Date().toISOString()
        };
        const kept = [item, ...this.readRecent().filter(other => other.q !== raw)].slice(0, MAX_RECENT);
        try {
            if (globalThis.localStorage) { globalThis.localStorage.setItem(RECENT_KEY, JSON.stringify(kept)); }
        } catch (e) { /* private mode, or a full quota; a lost history is not an error */ }
    }

    replayRecent(index) {
        const item = this.readRecent()[index];
        if (!item) { return; }
        this.inputEl.value = item.q;
        this.filters = item.filters && typeof item.filters === 'object' ? item.filters : {};
        this.scope = item.scope || 'all';
        this.scopeEl.value = this.scope;
        this.startSearch(true);
    }

    // -- filter mutation -----------------------------------------------------

    toggleFacet(key, value, on, fromRail) {
        const current = new Set(this.filters[key] || []);
        if (on) { current.add(value); } else { current.delete(value); }
        if (current.size) { this.filters[key] = [...current]; } else { delete this.filters[key]; }
        /* Filters are applied to the hit list, not to the walk, so this is a
         * re-render and not a re-scan — which is why a facet click is instant
         * even on a project that took two seconds to read. */
        this.render();
        if (fromRail) { this.refocusFacet(key, value); }
    }

    dropDimension(key) {
        delete this.filters[key];
        if (key === 'changed') { this.since = undefined; }
        this.render();
    }

    clearAll() {
        this.filters = {};
        this.since = undefined;
        this.render();
    }

    /*
     * ⌫ drops the LAST filter, in the order the chip row shows them, so the key
     * undoes the chip a user is looking at rather than an arbitrary one. It
     * unwinds one value at a time, not one dimension: two ticks in Content type
     * are two decisions and take two presses.
     */
    dropLastFilter() {
        for (const key of [...scan.FACET_KEYS].reverse()) {
            const values = this.filters[key];
            if (values && values.length) {
                values.pop();
                if (!values.length) { delete this.filters[key]; }
                if (key === 'changed') { this.since = undefined; }
                this.render();
                return true;
            }
        }
        return false;
    }

    searchEveryProject() {
        this.scope = 'all';
        this.scopeEl.value = 'all';
        delete this.filters.project;
        this.startSearch(true);
    }

    // -- selection and opening ----------------------------------------------

    syncSelection() {
        const nodes = [...this.resultsEl.querySelectorAll('.studio-hit')];
        if (this.selected >= nodes.length) { this.selected = nodes.length - 1; }
        nodes.forEach((node, index) => node.classList.toggle('on', index === this.selected));
    }

    moveSelection(delta) {
        const nodes = [...this.resultsEl.querySelectorAll('.studio-hit')];
        if (!nodes.length) { return; }
        // From nowhere, ↑ starts at the end and ↓ at the start, which is what
        // makes ↑ from the query field a useful gesture rather than a no-op.
        const next = this.selected < 0
            ? (delta > 0 ? 0 : nodes.length - 1)
            : Math.min(nodes.length - 1, Math.max(0, this.selected + delta));
        this.selected = next;
        this.syncSelection();
        try {
            nodes[next].scrollIntoView({ block: 'nearest' });
        } catch (e) { /* jsdom, and harmless */ }
    }

    /**
     * @param background open it and STAY here — the "new tab" gesture.
     *
     * HONEST LIMIT: this product's open handlers reuse one widget per URI
     * (makeOpenHandler in product-frontend-module.js looks the widget up by a
     * prefixed id), so a second tab for the same document is not something the
     * shell can be asked for. What ⌘↵ therefore does is open the document
     * WITHOUT taking focus — a new tab appears in the dock and the search keeps
     * the keyboard — which is the behaviour people want from the gesture even
     * though it is not literally a duplicate tab. ↵ opens and activates.
     */
    async openSelection(background) {
        const hit = this.rows[this.selected];
        if (!hit) { return; }
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            await open(this.openerService, new URI(hit.uri), { mode: background ? 'open' : 'activate' });
        } catch (e) {
            console.error('[studio] search could not open', hit.uri, e);
            if (this.messageService) {
                this.messageService.error('Could not open ' + hit.path + '. It may have been moved or deleted since this search ran.');
            }
        }
        /*
         * The line number is NOT carried into the document, and that is a real
         * gap rather than an oversight. The product's document surfaces are
         * rendered — a ProseMirror document and a rendered HTML page — and
         * neither has a "line" to reveal: the mapping from a source line to a
         * position in the rendered document is the same problem the comment
         * anchors solve with quoted text plus an occurrence index. Reusing that
         * anchoring model here is the right fix and is more than this widget.
         */
    }

    // -- events --------------------------------------------------------------

    onChange(event) {
        const target = event.target;
        if (target.matches('input[type="checkbox"][data-facet]')) {
            this.toggleFacet(target.getAttribute('data-facet'), target.getAttribute('data-value'), target.checked, true);
            return;
        }
        if (target.matches('[data-act="since"]')) {
            const value = target.value;
            // Replaces any previous since-value rather than accumulating them:
            // two "since" dates in one dimension means the earlier one, which is
            // a filter that does nothing.
            const others = (this.filters.changed || []).filter(candidate => !/^since:/.test(candidate));
            this.since = value || undefined;
            this.filters.changed = value ? [...others, 'since:' + value] : others;
            if (!this.filters.changed.length) { delete this.filters.changed; }
            this.render();
        }
    }

    onClick(event) {
        const hitNode = event.target.closest('.studio-hit');
        if (hitNode) {
            this.selected = Number(hitNode.getAttribute('data-hit'));
            this.syncSelection();
            // A plain click opens and moves you there; that is what clicking a
            // search result means everywhere else.
            this.openSelection(false);
            return;
        }
        const target = event.target.closest('[data-act]');
        if (!target) { return; }
        const act = target.getAttribute('data-act');
        if (act === 'drop') {
            this.toggleFacet(target.getAttribute('data-facet'), target.getAttribute('data-value'), false);
        } else if (act === 'clear-all') {
            this.clearAll();
        } else if (act === 'drop-dimension') {
            this.dropDimension(target.getAttribute('data-facet'));
        } else if (act === 'all-types') {
            this.dropDimension('type');
        } else if (act === 'every-project') {
            this.searchEveryProject();
        } else if (act === 'recent') {
            this.replayRecent(Number(target.getAttribute('data-recent')));
        }
    }

    onKeyDown(event) {
        const inInput = event.target === this.inputEl;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key === 'Enter') {
            // Enter with nothing selected takes the best answer. Requiring an
            // explicit ↓ first would make the commonest gesture in a search box
            // — type, press Enter — do nothing at all.
            if (this.selected < 0) {
                if (!this.rows.length) { return; }
                this.selected = 0;
                this.syncSelection();
            }
            event.preventDefault();
            this.openSelection(event.metaKey || event.ctrlKey);
            return;
        }
        if (event.key === 'Backspace') {
            /*
             * Backspace is the field's own key first. It only drops a filter
             * when there is no text left for it to delete — otherwise the
             * gesture would eat a character AND a filter, or worse, a filter
             * instead of a character.
             */
            if (inInput && this.inputEl.value.length) { return; }
            if (this.dropLastFilter()) { event.preventDefault(); }
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            /*
             * Two steps, because "back to the document" from the results list
             * usually means "back to the query" — the user is refining, not
             * leaving. From the query field it means leaving, and this widget is
             * a closable tab, so closing it IS returning to the document that
             * was in the dock. Nothing is lost that was not already in the
             * recent list.
             */
            if (!inInput) { this.inputEl.focus(); this.inputEl.select(); return; }
            this.close();
        }
    }
}

/*
 * Tokens only, and the two rules this sheet obeys deliberately:
 *
 *  - --studio-edge is the SHELL seam and appears nowhere in here. Every divider
 *    on this page — the query row's underline, the facet rail's right edge, the
 *    group rules — is --studio-line (constraint 24). A page whose internal
 *    dividers are as heavy as the window's own frame reads as several panels
 *    that happen to be adjacent.
 *  - Monochrome plus one accent. The accent means "interactive, current, or the
 *    thing you searched for" — which is why <mark> is the accent at low alpha
 *    rather than a highlighter yellow: a second hue would make a match look
 *    like a different KIND of thing rather than like the thing that was found.
 */
const SEARCH_CSS = `
/* The [hidden] trap from SHELL_CSS, which is scoped to the three widget roots
   that existed when it was written. Every container on this page sets display,
   so el.hidden is a no-op here without this line — the exact bug the chip row
   would hit on its first empty render. */
.studio-search [hidden] { display: none !important; }

.studio-search { height: 100%; overflow: hidden; background: var(--studio-bg, #fff); color: var(--studio-text, #1f2328); }
.studio-search-shell { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.studio-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

/* --- 1. the query row ---------------------------------------------------- */
.studio-search-query {
  flex: none; height: 56px; display: flex; align-items: center; gap: 12px;
  padding: 0 18px; border-bottom: 1px solid var(--studio-line, #e1e4e8);
}
.studio-search-glyph { flex: none; display: block; color: var(--studio-muted, #6e7781); }
.studio-search-glyph svg { width: 19px; height: 19px; display: block; }
/* No border and no box: the row's own hairline is the field's edge. A bordered
   input inside a 56px bordered row is two boxes for one control. */
.studio-search-input {
  flex: 1 1 auto; min-width: 0; border: 0; background: transparent;
  color: var(--studio-text, #1f2328); font: 400 17px/1.4 inherit; padding: 0;
}
.studio-search-input::placeholder { color: var(--studio-muted, #6e7781); }
.studio-search-input:focus { outline: none; }
/* The focus ring goes on the ROW, so a focused field is a lit row rather than a
   rectangle drawn inside another rectangle. */
.studio-search-query:focus-within { box-shadow: inset 0 -2px 0 var(--studio-amber, #0b2275); }
.studio-search-count { flex: none; color: var(--studio-muted, #6e7781); font: 400 12px/1.4 inherit; white-space: nowrap; }
.studio-search-scope-label { flex: none; display: flex; align-items: center; }
.studio-search-scope {
  max-width: 210px; padding: 5px 8px; border: 1px solid var(--studio-line, #e1e4e8);
  border-radius: 6px; background: var(--studio-surface, #fff); color: var(--studio-text, #1f2328);
  font: 400 12px/1.3 inherit; cursor: pointer;
}
.studio-search-scope:hover { border-color: var(--studio-amber, #0b2275); }
.studio-search-scope:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 1px; }

/* --- 2. the chip row ----------------------------------------------------- */
.studio-search-chips {
  flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
  padding: 9px 22px; background: var(--studio-surface-raised, #f6f7f9);
  border-bottom: 1px solid var(--studio-line, #e1e4e8);
}
.studio-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 9px;
  border: 1px solid var(--studio-line, #e1e4e8); border-radius: 999px;
  background: var(--studio-surface, #fff); font: 400 11.5px/1.3 inherit;
}
.studio-chip-key { color: var(--studio-muted, #6e7781); }
.studio-chip b { font-weight: 620; }
.studio-chip-x {
  display: grid; place-items: center; width: 17px; height: 17px; padding: 0;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--studio-muted, #6e7781); cursor: pointer;
}
.studio-chip-x svg { width: 11px; height: 11px; display: block; }
.studio-chip-x:hover { background: var(--studio-surface-sunken, #f0f2f5); color: var(--studio-text, #1f2328); }
.studio-chip-x:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 1px; }
.studio-search-clear {
  border: 0; background: transparent; padding: 3px 6px; cursor: pointer;
  color: var(--studio-amber, #0b2275); font: 620 11.5px/1.3 inherit;
}
.studio-search-clear:hover { text-decoration: underline; }
.studio-search-clear:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 1px; border-radius: 4px; }
/* Pushed to the right edge and monospace, because it is a set of counts to be
   compared between runs, not a sentence to be read. */
.studio-search-honesty {
  margin-left: auto; color: var(--studio-muted, #6e7781);
  font: 400 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46ch;
}

/* --- 3. the body: rail and results --------------------------------------- */
.studio-search-body { flex: 1 1 auto; min-height: 0; display: flex; }
.studio-search-facets {
  flex: none; width: 240px; overflow: auto; padding: 0 0 22px;
  border-right: 1px solid var(--studio-line, #e1e4e8);
}
.studio-facet-group { padding: 0 14px 12px; }
.studio-facet-group h4 {
  margin: 0; padding: 14px 0 7px; border-top: 1px solid var(--studio-line, #e1e4e8);
  color: var(--studio-muted, #6e7781);
  font: 620 10.5px/1.3 inherit; letter-spacing: .07em; text-transform: uppercase;
}
.studio-facet-group:first-child h4 { border-top: 0; }
.studio-facet {
  display: flex; align-items: center; gap: 8px; padding: 4px 7px;
  border-radius: 5px; cursor: pointer; font: 400 13px/1.35 inherit;
}
.studio-facet:hover { background: var(--studio-surface-raised, #f6f7f9); }
/* Checked reads as a selected ROW, not as a ticked box in a list of rows: the
   selection tone is what makes an active filter visible while scanning the
   rail, which is when it matters. */
.studio-facet.on { background: var(--studio-selection-bg, #e9edfb); }
.studio-facet input { flex: none; margin: 0; accent-color: var(--studio-amber, #0b2275); }
.studio-facet input:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 2px; }
.studio-facet-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Tabular figures so a column of counts lines up on its digits — the whole
   reason to put numbers in a column. */
.studio-facet-count {
  flex: none; color: var(--studio-muted, #6e7781); font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.studio-facet.empty { cursor: default; opacity: .45; }
.studio-facet.empty:hover { background: transparent; }
.studio-facet-since { cursor: default; }
.studio-since-input {
  flex: none; width: 118px; padding: 2px 5px; border: 1px solid var(--studio-line, #e1e4e8);
  border-radius: 5px; background: var(--studio-surface, #fff);
  color: var(--studio-text, #1f2328); font: 400 11px/1.3 inherit;
}
.studio-since-input:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 1px; }
/* The stated omission. Muted and small, at the FOOT of the rail: it is a
   footnote about the rail, and putting it at the top would make the first thing
   a user reads a list of what is missing. */
.studio-facet-note {
  margin: 16px 14px 0; padding-top: 12px; border-top: 1px solid var(--studio-line, #e1e4e8);
  color: var(--studio-muted, #6e7781); font: 400 11px/1.55 inherit;
}
.studio-facet-note b { font-weight: 620; color: var(--studio-text, #1f2328); }

.studio-search-results { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 0 0 28px; }
.studio-search-results:focus-visible { outline: none; }

/* --- results: one group per file ----------------------------------------- */
.studio-file-group { border-bottom: 1px solid var(--studio-line, #e1e4e8); }
.studio-file-head {
  display: flex; align-items: center; gap: 9px; padding: 9px 18px 7px;
  font: 400 12.5px/1.4 inherit;
}
.studio-file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-file-dir { color: var(--studio-muted, #6e7781); }
.studio-file-path b { font-weight: 620; }
.studio-file-project {
  flex: none; padding: 1px 7px; border-radius: 999px;
  background: var(--studio-surface-sunken, #f0f2f5); color: var(--studio-muted, #6e7781); font-size: 10.5px;
}
.studio-file-matches {
  margin-left: auto; flex: none; color: var(--studio-muted, #6e7781);
  font-size: 11.5px; font-variant-numeric: tabular-nums;
}
/* The same drawn-not-imported file mark the Projects browser uses, at the same
   size, so a file looks like the same file in both places. */
.studio-file-glyph {
  flex: none; position: relative; width: 11px; height: 14px; box-sizing: border-box;
  border: 1.5px solid var(--studio-muted, #6e7781); border-radius: 1px;
}
.studio-file-glyph::after {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -48%);
  color: var(--studio-muted, #6e7781); content: "·"; font: 700 9px/1 ui-sans-serif, system-ui, sans-serif;
}
.studio-file-glyph.icon-markdown::after { content: "M"; font-size: 7px; }
.studio-file-glyph.icon-html::after, .studio-file-glyph.icon-markup::after { content: "<>"; font-size: 5px; letter-spacing: -1px; }
.studio-file-glyph.icon-data::after { content: "{}"; font-size: 6px; letter-spacing: -1px; }
.studio-file-glyph.icon-table::after { content: "#"; font-size: 7px; }
.studio-file-glyph.icon-text::after { content: "T"; font-size: 7px; }

.studio-hit {
  display: flex; align-items: flex-start; gap: 12px; width: 100%;
  padding: 6px 18px 7px; border: 0; background: transparent;
  color: inherit; cursor: pointer; text-align: left; font: inherit;
}
.studio-hit:hover { background: var(--studio-surface-raised, #f6f7f9); }
/* The keyboard's own selection, distinct from hover: ↑↓ moves this, and it has
   to stay visible while the pointer is elsewhere on the page. */
.studio-hit.on { background: var(--studio-selection-bg, #e9edfb); }
.studio-hit:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: -2px; }
.studio-hit-kind {
  flex: none; width: 66px; padding-top: 2px; color: var(--studio-muted, #6e7781);
  font: 620 9.5px/1.5 inherit; letter-spacing: .08em; text-transform: uppercase;
}
.studio-hit-main { flex: 1 1 auto; min-width: 0; }
.studio-hit-line {
  display: block; font: 400 13px/1.5 inherit;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.studio-hit-line mark {
  /* The accent at 22% alpha: enough to find with your eye, transparent enough
     that the text on top of it is still the document's text and not a badge. */
  background: color-mix(in srgb, var(--studio-amber, #0b2275) 22%, transparent);
  color: inherit; border-radius: 2px; padding: 0 1px;
}
.studio-hit-meta {
  display: flex; align-items: center; gap: 6px; margin-top: 2px;
  color: var(--studio-muted, #6e7781); font: 400 10.5px/1.5 inherit;
}
/* The comment surfaces' own disc, shrunk to meta size. Reused rather than
   redrawn so "who" looks the same here as it does in a thread. */
.studio-hit-meta .studio-avatar { width: 15px; height: 15px; margin: 0; font-size: 7.5px; border-width: 1.2px; }
.studio-hit-who { font-weight: 620; color: var(--studio-text, #1f2328); }
.studio-hit-where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; }
.studio-hit-pill {
  flex: none; padding: 0 6px; border: 1px solid var(--studio-line, #e1e4e8); border-radius: 999px;
  font-size: 9.5px; letter-spacing: .04em; text-transform: uppercase;
}
.studio-hit-pill.open { border-color: var(--studio-amber, #0b2275); color: var(--studio-amber, #0b2275); }
.studio-search-more {
  margin: 0; padding: 14px 18px; color: var(--studio-muted, #6e7781); font: 400 11.5px/1.6 inherit;
}

/* --- the scanning state -------------------------------------------------- */
.studio-search-scanning {
  padding: 12px 18px 0; border-bottom: 1px solid var(--studio-line, #e1e4e8);
}
.studio-scanning-head { display: flex; align-items: center; gap: 9px; color: var(--studio-muted, #6e7781); font: 400 12px/1.5 inherit; }
.studio-scanning-honesty {
  margin-left: auto; font: 400 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.studio-scanning-bar { position: relative; overflow: hidden; height: 2px; margin: 10px 0 11px; background: var(--studio-line, #e1e4e8); border-radius: 999px; }
.studio-scanning-bar > span { display: block; height: 100%; background: var(--studio-amber, #0b2275); transition: width 160ms linear; }
/* Before the walk has finished counting, the bar has nothing honest to show as
   a fraction — so it sweeps instead of lying about a percentage. */
.studio-scanning-bar.indeterminate > span { width: 34% !important; animation: studio-search-sweep 1100ms ease-in-out infinite; }
@keyframes studio-search-sweep { 0% { transform: translateX(-110%); } 100% { transform: translateX(310%); } }
@media (prefers-reduced-motion: reduce) {
  .studio-scanning-bar.indeterminate > span { animation: none; width: 100% !important; opacity: .4; }
  .studio-scanning-bar > span { transition: none; }
}

/* --- the idle state ------------------------------------------------------ */
.studio-search-idle { max-width: 720px; padding: 22px 18px 40px; }
.studio-search-idle section + section { margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--studio-line, #e1e4e8); }
.studio-search-idle h3 { margin: 0 0 10px; font: 620 13px/1.3 inherit; }
.studio-search-hint { margin: 0; color: var(--studio-muted, #6e7781); font: 400 12.5px/1.6 inherit; }
.studio-recent { margin: 0; padding: 0; list-style: none; }
.studio-recent-btn {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 9px;
  border: 0; border-radius: 6px; background: transparent; color: inherit;
  cursor: pointer; text-align: left; font: inherit;
}
.studio-recent-btn:hover { background: var(--studio-surface-raised, #f6f7f9); }
.studio-recent-btn:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: -2px; }
.studio-recent-q { flex: none; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 620 13px/1.4 inherit; }
.studio-recent-chips { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
.studio-recent-chips span {
  padding: 1px 7px; border: 1px solid var(--studio-line, #e1e4e8); border-radius: 999px;
  color: var(--studio-muted, #6e7781); font-size: 10.5px; white-space: nowrap;
}
.studio-recent-count { margin-left: auto; flex: none; color: var(--studio-muted, #6e7781); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.studio-covered { margin: 0; padding: 0; list-style: none; }
.studio-covered li {
  position: relative; padding: 4px 0 4px 24px;
  color: var(--studio-text, #1f2328); font: 400 12.5px/1.6 inherit;
}
.studio-covered li b { font-weight: 620; }
/* A tick and a dash, not two colours: the palette has one accent, and "we do
   not search this" is not a danger state. */
.studio-covered li.yes::before { content: "✓"; position: absolute; left: 4px; top: 4px; color: var(--studio-amber, #0b2275); font-size: 11px; }
.studio-covered li.no { color: var(--studio-muted, #6e7781); }
.studio-covered li.no::before { content: "—"; position: absolute; left: 2px; top: 4px; }
.studio-covered li.no b { color: var(--studio-text, #1f2328); }

/* --- the no-match state -------------------------------------------------- */
.studio-search-empty { max-width: 680px; padding: 26px 18px 40px; }
.studio-search-empty h3 { margin: 0; font: 620 15px/1.35 inherit; }
.studio-search-empty p { margin: 9px 0 0; color: var(--studio-muted, #6e7781); font: 400 12.5px/1.65 inherit; }
.studio-search-empty p b { color: var(--studio-text, #1f2328); font-weight: 620; }
.studio-blame { margin: 16px 0 0; padding: 0; list-style: none; }
.studio-blame li {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding: 9px 12px; margin-top: 8px; border-radius: var(--studio-radius, 8px);
  background: var(--studio-surface-sunken, #f0f2f5); font: 400 12.5px/1.5 inherit;
}
.studio-blame li b { font-weight: 620; }
.studio-search-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
/* .studio-btn itself is defined in REPOS_CSS and shared across the product;
   only the focus ring is restated, because this page's buttons sit on three
   different tones and the shared rule assumes one. */
.studio-search .studio-btn:focus-visible { outline: 2px solid var(--studio-amber, #0b2275); outline-offset: 2px; }

/* --- 4. the keyboard row ------------------------------------------------- */
.studio-search-keys {
  flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 16px;
  padding: 0 18px; height: 30px;
  border-top: 1px solid var(--studio-line, #e1e4e8);
  background: var(--studio-surface-raised, #f6f7f9);
  color: var(--studio-muted, #6e7781); font: 400 10.5px/1.4 inherit;
}
.studio-search-keys span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.studio-search-keys kbd {
  display: inline-grid; place-items: center; min-width: 15px; height: 15px; padding: 0 3px;
  border: 1px solid var(--studio-line, #e1e4e8); border-radius: 3px;
  background: var(--studio-surface, #fff); color: var(--studio-text, #1f2328);
  font: 500 9.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* A narrow dock cannot afford a 240px rail beside a results column: below this
   the rail becomes a horizontal band above the results rather than a scroll
   sideways. Same reasoning as the Projects breadcrumb's collapse. */
@media (max-width: 720px) {
  .studio-search-body { flex-direction: column; }
  .studio-search-facets {
    width: auto; max-height: 216px; border-right: 0;
    border-bottom: 1px solid var(--studio-line, #e1e4e8);
  }
}
`;

module.exports = { SearchWidget, SEARCH_CSS, SEARCH_WIDGET_ID };
