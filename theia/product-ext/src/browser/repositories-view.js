/*
 * Focused Projects browser.
 *
 * Theia continues to own workspace roots and opening. This widget deliberately
 * does not mirror Navigator's recursive tree: it shows the selected project's
 * current directory only, with a breadcrumb for the active path.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { open } = require('@theia/core/lib/browser/opener-service');
const { ConfirmDialog, SingleTextInputDialog } = require('@theia/core/lib/browser/dialogs');
// Only the read side of the settings is needed here now: the listing filters on
// `allows`, while the vocabulary (KNOWN_TYPES/DEFAULT_ON) is imported by
// project-page.js, which owns the control that edits it.
const { fileTypeSettings } = require('./file-type-settings');
const { ICONS } = require('./icons');
const { ChangesStore, relativePath } = require('./changes-store');
// This panel WRITES the active project; the status line and the Project page
// read it. See active-project.js for why the fact needed one home.
const { activeProject } = require('./active-project');
const { showLoading } = require('./loader');

// Badges re-read after a burst of sidecar writes (an "accept all" can touch
// several files at once) settle on one read instead of one per file change.
const PENDING_REFRESH_DEBOUNCE_MS = 200;

/*
 * The path strip folds by MEASURED WIDTH, not by segment count — see fitPath().
 *
 * A count threshold was tried first and is what produced the bug this replaced:
 * three segments never collapsed, so flexbox shrank them instead, and a 300px
 * rail rendered the project as two clipped letters and an intermediate folder
 * as "p…". A crumb ground down to one character is not a shortened word, it is
 * noise in the shape of one — and it costs the space of the two crumbs that
 * actually answer "where am I". Every crumb now renders IN FULL or not at all.
 */

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
}

/*
 * One Lucide glyph per BROAD KIND -- six of them, plus the generic file.
 *
 * What this replaced: eleven CSS-drawn boxes, each a 11x14px border with a
 * letter pushed through ::after at 5-7px ("M", "TS", "JS", ">_", a lozenge for
 * SVG). Two grey smudges is not an icon, and it made the file list the only
 * surface in the product that did not use the icon set icons.js exists to be.
 *
 * COARSE ON PURPOSE. The row is scanned for a NAME; the glyph's job is to say
 * "folder or not, and roughly what kind" and then stop competing with the text.
 * A per-language icon per extension is how eleven rules became eleven rules.
 */
function fileIconKind(name) {
    const lower = name.toLowerCase();
    const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    return ({
        md: 'fileText', markdown: 'fileText', txt: 'fileText', rst: 'fileText', adoc: 'fileText',
        json: 'fileData', yaml: 'fileData', yml: 'fileData', toml: 'fileData', lock: 'fileData',
        csv: 'fileTable', tsv: 'fileTable', tab: 'fileTable', psv: 'fileTable', xlsx: 'fileTable',
        png: 'fileImage', jpg: 'fileImage', jpeg: 'fileImage', gif: 'fileImage', webp: 'fileImage',
        svg: 'fileImage', pdf: 'fileImage',
        html: 'fileCode', htm: 'fileCode', xml: 'fileCode', js: 'fileCode', jsx: 'fileCode',
        ts: 'fileCode', tsx: 'fileCode', py: 'fileCode', sh: 'fileCode', css: 'fileCode',
        scss: 'fileCode', mjs: 'fileCode', cjs: 'fileCode'
    })[extension] || 'file';
}

/*
 * Middle truncation, and the reason it is not just `text-overflow: ellipsis`.
 *
 * These filenames share long prefixes. Clipped at the tail,
 * "checks-findings-alerts-metric-tree-diagrams.md" and
 * "checks-findings-alerts-metric-tree.md" BOTH render as
 * "checks-findings-alerts-met..." -- which is worse than wrapping, because it
 * is confidently ambiguous rather than visibly incomplete.
 *
 * So the name is split: the head ellipsises under pressure, the tail (last
 * hyphen- or underscore-delimited segment, plus the extension) is flex:none and
 * always survives. The two names above stay distinguishable at any width that
 * fits the tail at all.
 */
function splitName(name) {
    const dot = name.lastIndexOf('.');
    const hasExtension = dot > 0;
    const extension = hasExtension ? name.slice(dot) : '';
    const stem = hasExtension ? name.slice(0, dot) : name;
    const cut = Math.max(stem.lastIndexOf('-'), stem.lastIndexOf('_'));
    // A tail longer than this stops being a distinguishing suffix and starts
    // being the whole name, at which point there is nothing left to ellipsise.
    if (cut > 0 && stem.length - cut <= 18) {
        return { head: stem.slice(0, cut + 1), tail: stem.slice(cut + 1), extension };
    }
    return { head: stem, tail: '', extension };
}

// Compact enough for a 257px rail: "3m", "2h", "5d", then a date. Never a
// sentence -- this column is scanned, and it is the first thing dropped when
// the panel narrows.
function relativeTime(millis) {
    if (!millis) { return ''; }
    const seconds = Math.max(0, (Date.now() - millis) / 1000);
    if (seconds < 60) { return 'now'; }
    if (seconds < 3600) { return Math.floor(seconds / 60) + 'm'; }
    if (seconds < 86400) { return Math.floor(seconds / 3600) + 'h'; }
    if (seconds < 86400 * 7) { return Math.floor(seconds / 86400) + 'd'; }
    if (seconds < 86400 * 365) { return Math.floor(seconds / 86400 / 7) + 'w'; }
    return Math.floor(seconds / 86400 / 365) + 'y';
}

// Name / Modified / Type, and the labels the sort menu shows for them.
const SORT_MODES = [
    { key: 'name', label: 'Name' },
    { key: 'modified', label: 'Last modified' },
    { key: 'type', label: 'Type' }
];

class RepositoriesWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileDialogService = ctx.fileDialogService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.messageService = ctx.messageService;
        // Only for the Connect dialog's last-resort folder. See dialogStartFolder().
        this.envVariables = ctx.envVariables;
        // No openProjectPage callback any more: the route to the Project page is
        // the bottom line's own field, and this panel no longer has a control
        // that opens it. See the note where the ⋯ menu used to be.
        this.activeRoot = undefined;
        this.currentDirectory = undefined;
        this.moreCrumbsOpen = false;
        // Name/ascending is the only default that is right before anything is
        // known about the folder. Instance state, not a setting: it is a view
        // preference, and the Project page owns settings.
        this.sortKey = 'name';
        this.sortAscending = true;
        /*
         * The URI of the row to mark as open. See markOpenFile().
         *
         * openFileUri, NOT openFile: this used to be `this.openFile`, which is
         * the name of the METHOD that opens a file, so the constructor overwrote
         * it with `undefined` on every instance and clicking a file threw
         * "this.openFile is not a function". Directories still worked -- they
         * take a different branch in onClick -- so the panel looked alive while
         * the thing it exists for did nothing.
         */
        this.openFileUri = undefined;

        // Requirement 12 (changed-file indicators): a small index of pending
        // AI-proposal counts, keyed by root-relative path, applied to the
        // rendered rows as a second DOM pass so a slow or missing index file
        // never delays the directory listing itself.
        this.changesStore = new ChangesStore(ctx.fileService, ctx.workspaceService);
        this.pendingByPath = new Map();
        this.badgeRoot = undefined;
        this.disposables = [];

        this.id = 'studio-repositories';
        this.title.label = 'Projects';
        this.title.caption = 'Projects';
        this.title.closable = false;
        this.addClass('studio-repos');

        /*
         * There is no footer any more.
         *
         * Measured in the running app, the old .studio-project-footer was a
         * permanent 114px band -- 11.7% of the panel -- carrying three
         * different CLASSES of thing at once: a view filter over the list
         * above it (21 checkboxes when expanded, in a 257px column), a
         * project-wide persistence policy, and a workspace-level action.
         * Nothing labelled the band and nothing ordered it, so it became the
         * only place anything project-scoped could go: a junk drawer.
         *
         * All three moved to project-page.js, which has room for a heading and
         * a sentence of help per setting and costs nothing when nobody asked
         * for it. What is left here is what a person uses continuously: which
         * project, where in it, and what is in there.
         */
        this.node.innerHTML =
            /*
             * No visible "Project" label above the switcher: the panel itself
             * is titled "Projects", so the label restated the same word 50px
             * lower. The select keeps its aria-label, so the accessible name
             * is unchanged — only the redundant ink is gone.
             *
             * NO ⋯ MENU EITHER, and the selector takes the whole column.
             *
             * Reported from use: "these dots are breaking nice UI". They were,
             * and the reason is that the menu's two items never belonged beside
             * the selector in the first place. Both have a better home:
             *
             *   - Project settings is a field on the bottom line, next to the
             *     project name and the saving policy it configures — the band
             *     that already carries project-scoped facts (status-line.js);
             *   - Connect project is a + in the panel's own title bar, where an
             *     "add one of these" action belongs (product-frontend-module.js).
             *
             * So the head holds exactly one control, and it is the one used
             * continuously. A 32px button and a 6px gap came off the selector's
             * width, which is 100% of the column now.
             */
            /*
             * THE HEAD BAND IS GONE, and the switcher moved into the path.
             *
             * Measured in the running app, the old head was 61px -- 16px of
             * padding, a 34px select, 10px, a rule -- carrying a control used a
             * few times a day, directly above a 40px breadcrumb whose root
             * crumb was a HOME GLYPH precisely because the switcher above had
             * already said the project name. The duplication had been patched
             * rather than removed.
             *
             * They are one control. The project IS the root segment of the
             * path, so the two bands became one 30px line and the project name
             * is stated once. 71px back, before the row height changed at all.
             *
             * The root chip is a SPLIT control, and that is load-bearing rather
             * than decorative. The label half stays a crumb button -- it keeps
             * data-project-path, keeps aria-current at the root, and keeps
             * being the thing focus is restored to, which is what the browser
             * regression suite pins. The caret half carries a real <select>,
             * transparent and stretched over it, so switching projects keeps
             * the native menu, its keyboard behaviour and its accessible name
             * instead of a div pretending to be a listbox.
             */
            '<nav class="studio-project-path" data-project-breadcrumb aria-label="Active path"></nav>' +
            '<div class="studio-project-browser">' +
            '  <div class="studio-project-entries" role="listbox" aria-label="Folder contents" tabindex="0"></div>' +
            '</div>' +
            // Screen readers get the directory summary from here. The listing
            // itself must NOT be a live region: it used to be, which meant every
            // navigation read out the whole folder.
            '<div class="studio-project-status" role="status" aria-live="polite"></div>';

        this.breadcrumbEl = this.node.querySelector('[data-project-breadcrumb]');
        this.entriesEl = this.node.querySelector('.studio-project-entries');
        this.statusEl = this.node.querySelector('.studio-project-status');
        this.node.addEventListener('click', event => this.onClick(event));
        this.node.addEventListener('change', event => this.onChange(event));
        this.node.addEventListener('contextmenu', event => this.onContextMenu(event));
        this.entriesEl.addEventListener('keydown', event => this.onListKeyDown(event));
        /*
         * The path folds by measured width, and Theia resizes this rail by
         * dragging its edge — no re-render, no window resize, no event any of
         * the code above would hear. This is also what performs the FIRST fold:
         * the widget is laid out after the constructor runs, so the render that
         * happens before attachment measures a zero-width strip and returns.
         */
        if (typeof ResizeObserver === 'function') {
            this.pathResizeObserver = new ResizeObserver(() => this.fitPath());
            this.pathResizeObserver.observe(this.breadcrumbEl);
        }
        document.addEventListener('click', this.outsideClickHandler = event => {
            if (this.moreCrumbsOpen && !event.target.closest('.studio-project-path')) { this.closeMoreCrumbs(); }
        });
        document.addEventListener('pointerdown', this.fileOperationsOutsideHandler = event => {
            if (this.fileOperationsMenu && !this.fileOperationsMenu.contains(event.target)) { this.closeFileOperationsMenu(); }
        }, true);
        document.addEventListener('keydown', this.fileOperationsKeyHandler = event => {
            if (event.key === 'Escape') { this.closeFileOperationsMenu(); }
        }, true);
        this.workspaceService.onWorkspaceChanged(() => this.refresh());
        fileTypeSettings.onChanged(() => this.refresh());
        // The index is written by whatever resolved a proposal (the markdown
        // editor, a bulk accept/reject), never by this widget — so badges
        // have to follow the file watcher rather than the widget's own
        // navigation events.
        this.disposables.push(this.fileService.onDidFilesChange(event => this.onFilesChanged(event)));
    }

    onCloseRequest(msg) {
        document.removeEventListener('click', this.outsideClickHandler);
        document.removeEventListener('pointerdown', this.fileOperationsOutsideHandler, true);
        document.removeEventListener('keydown', this.fileOperationsKeyHandler, true);
        this.closeFileOperationsMenu();
        clearTimeout(this.pendingRefreshTimer);
        if (this.pathResizeObserver) { this.pathResizeObserver.disconnect(); }
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
        super.onCloseRequest(msg);
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.refresh();
    }

    /*
     * Re-read the pending counts whenever this panel comes back into view.
     *
     * The file-watch subscription below is the fast path, but it only reports
     * resources something has asked to watch, and nothing watches
     * `.studio/changes/` — so an accept or reject made in an editor while this
     * panel was hidden would otherwise leave stale badges until the next
     * navigation. Becoming visible is exactly the moment they have to be right.
     */
    onAfterShow(msg) {
        super.onAfterShow(msg);
        if (this.badgeRoot || this.activeRoot) { this.refreshBadges(this.badgeRoot || this.activeRoot); }
    }

    rootUri(encoded) {
        const { URI } = require('@theia/core/lib/common/uri');
        return new URI(decodeURIComponent(encoded));
    }

    findRoot(roots) {
        return roots.find(root => root.resource.toString() === this.activeRoot);
    }

    directoryIsInRoot(root) {
        return this.currentDirectory && this.currentDirectory.toString().startsWith(root.resource.toString() + '/');
    }

    async refresh(restorePathFocus = false) {
        const roots = await this.workspaceService.roots;
        if (!roots.length) {
            this.activeRoot = undefined;
            this.currentDirectory = undefined;
            activeProject.set(undefined);
            this.breadcrumbEl.innerHTML = '';
            // Not a listbox when it holds prose and a primary action: a listbox
            // whose children are not options is a listbox a screen reader reads
            // as empty. The role comes back with the listing.
            this.entriesEl.removeAttribute('role');
            this.entriesEl.setAttribute('tabindex', '-1');
            this.entriesEl.innerHTML =
                '<div class="studio-project-empty">Connect a local project to browse its files.</div>' +
                '<button class="studio-btn primary" data-act="connect">Connect project</button>';
            this.announce(undefined);
            return;
        }

        let root = this.findRoot(roots);
        if (!root) {
            root = roots[0];
            this.activeRoot = root.resource.toString();
        }
        if (!this.directoryIsInRoot(root)) {
            this.currentDirectory = root.resource;
        }
        /*
         * Published on every refresh, not only on a switcher change: the active
         * root also moves when a project is connected, disconnected, or first
         * defaulted to roots[0] above. The status line and the Project page
         * follow this, so a silent default here is exactly how they used to end
         * up naming a different project than the one on screen.
         */
        activeProject.set(this.activeRoot);

        this.renderPath(roots, root);
        await this.renderDirectory(root);
        if (restorePathFocus) { this.focusActivePath(); }
        this.watchPendingSidecars(root);
        // Deliberately not awaited: the directory listing is already on
        // screen, and badges are a follow-up DOM pass, not part of the
        // listing's own render.
        this.refreshBadges(root);
    }

    /*
     * The root chip: the project name, a caret, and a transparent <select>
     * stretched over the caret half.
     *
     * The select is a real one. It keeps the native menu (and its type-ahead,
     * its keyboard model and its accessible name) while the visible ink is the
     * path's own -- which is the whole point of overlaying rather than
     * rebuilding it as a popover. onChange below still receives it unchanged.
     */
    rootChip(roots, activeRoot, isCurrent) {
        const options = roots.map(root => {
            const uri = root.resource.toString();
            return '<option value="' + encodeURIComponent(uri) + '"' +
                (uri === activeRoot.resource.toString() ? ' selected' : '') + '>' +
                escapeHtml(root.resource.path.base) + '</option>';
        }).join('');
        const name = activeRoot.resource.path.base;
        return '<span class="studio-project-root">' +
            '<button class="studio-project-root-name" data-project-crumb' +
            ' data-project-path="' + encodeURIComponent(activeRoot.resource.toString()) + '"' +
            (isCurrent ? ' aria-current="page"' : '') +
            // The accessible name is on the button, not in its text, because the
            // text is what fitPath() drops first when the strip runs out of room.
            ' aria-label="' + escapeHtml(name) + ', project root"' +
            ' title="' + escapeHtml(name) + ' — go to the project root">' +
            '<span class="studio-project-root-glyph" aria-hidden="true">' + ICONS.home + '</span>' +
            '<span class="studio-project-root-label">' + escapeHtml(name) + '</span>' +
            '</button>' +
            '<span class="studio-project-root-switch">' +
            ICONS.chevronDown +
            '<select id="studio-project-switcher" class="studio-project-switcher" data-project-switcher' +
            ' aria-label="Active project">' + options + '</select>' +
            '</span>' +
            '</span>';
    }

    breadcrumbParts(root) {
        const rootPath = root.resource.path.toString().replace(/\/+$/, '');
        const currentPath = this.currentDirectory.path.toString();
        const relative = currentPath.slice(rootPath.length).replace(/^\/+/, '');
        const parts = [{ label: root.resource.path.base, uri: root.resource }];
        let uri = root.resource;
        for (const segment of relative ? relative.split('/') : []) {
            uri = uri.resolve(segment);
            parts.push({ label: segment, uri });
        }
        return parts;
    }

    /*
     * A long path used to make this strip scroll sideways — a horizontal
     * scrollbar in a 24px-tall nav reads as broken. Past a threshold, the
     * middle segments collapse into a single "…" that opens a small menu,
     * so the row always fits on one line and the current folder (the
     * segment people actually care about) is never the part that's cut off.
     */
    /*
     * The root crumb STAYS. Only its ink changes: a home glyph instead of the
     * project name.
     *
     * D6 asked for the project name to be stated once -- it appeared in the
     * switcher, again in this crumb 30px below it, and a third time in the
     * document topbar's path. Deleting the crumb was tried and reverted,
     * because the duplication is only visual while the element is load-bearing
     * three ways:
     *
     *   - it is the sole affordance that jumps to the project root from a
     *     nested path ("Back" walks up one level, which is not the same);
     *   - at the root it is the only element carrying aria-current="page", so
     *     removing it left nothing for keyboard navigation to return focus to;
     *   - project-browser-regression pins exactly that focus restoration for
     *     both Enter (into a folder) and Space (back up the crumbs).
     *
     * Three assertions failed and all three were right. So the element, its
     * data-project-path, and its aria-current are untouched here; the project
     * name moves into aria-label, which keeps the accessible name identical
     * while the visible duplication of the switcher's own text goes away.
     */
    /*
     * One line: project chip, path segments, sort control.
     *
     * NO "BACK" BUTTON. It was a violet text button doing exactly what clicking
     * the parent segment does -- and the parent segment is 40px to its right,
     * already on screen, already keyboard reachable. Three navigation idioms in
     * a 40px strip (accent text button, grey glyph, bold black text) collapse to
     * one: segments are one weight and one colour, and only the folder you are
     * actually in takes full ink.
     *
     * goBack() did not go anywhere -- see onListKeyDown, which binds it to
     * Backspace and to Left, where a keyboard user looks for it.
     */
    renderPath(roots, root) {
        const parts = this.breadcrumbParts(root);
        this.pathParts = parts;
        this.moreCrumbsOpen = false;
        this.hiddenCrumbs = [];
        const last = parts[parts.length - 1];
        const mode = SORT_MODES.find(entry => entry.key === this.sortKey) || SORT_MODES[0];
        const separator = '<span class="studio-project-separator" aria-hidden="true">/</span>';

        /*
         * EVERY segment is rendered, at full width, and fitPath() then decides
         * which of them survive. Deciding here — before the strip has been
         * measured — is what the old count threshold did, and it cannot know
         * whether three short folders fit where two long ones do not.
         */
        this.breadcrumbEl.innerHTML =
            this.rootChip(roots, root, parts.length === 1) +
            separator +
            '<button class="studio-crumb studio-project-crumb-more" data-project-more hidden' +
            ' aria-haspopup="true" aria-expanded="false" aria-label="Show hidden path segments">…</button>' +
            parts.slice(1).map(part => separator +
                '<button class="studio-crumb" data-project-crumb data-project-path="' +
                encodeURIComponent(part.uri.toString()) + '"' +
                // Only the current crumb can ever be ellipsised (fitPath folds the
                // others away whole), so it is the only one a tooltip tells you
                // anything you cannot already read.
                (part === last ? ' aria-current="page" title="' + escapeHtml(part.label) + '"' : '') +
                '>' + escapeHtml(part.label) + '</button>').join('') +
            '<button class="studio-project-sort" data-project-sort aria-haspopup="true" aria-expanded="false"' +
            ' title="Sort: ' + escapeHtml(mode.label) + ', ' + (this.sortAscending ? 'ascending' : 'descending') + '"' +
            ' aria-label="Sort by ' + escapeHtml(mode.label) + ', ' + (this.sortAscending ? 'ascending' : 'descending') + '">' +
            (this.sortAscending ? ICONS.sortAsc : ICONS.sortDesc) + '</button>';
        this.fitPath();
    }

    /*
     * Fold the path to the width it actually has.
     *
     * Nothing here shrinks: every crumb is flex:none, so the strip genuinely
     * overflows when it does not fit and scrollWidth says so. What gets dropped
     * is decided in one fixed order, cheapest information first:
     *
     *   1. intermediate segments, nearest the ROOT first, into the "…" menu —
     *      the folders between the project and where you are are the ones you
     *      can reconstruct without reading them;
     *   2. the project NAME, leaving the chip as a home glyph and its caret, so
     *      the switcher stays a click away at every width;
     *   3. only then does the current folder ellipsise. It is last because it is
     *      the one thing this strip exists to say, and at the root it is also
     *      the project name, which is why step 2 is skipped there.
     *
     * Re-run on resize (see the observer in the constructor): Theia drags this
     * rail wider and narrower without any of this re-rendering on its own.
     */
    fitPath() {
        const nav = this.breadcrumbEl;
        if (!nav || !nav.clientWidth || !this.pathParts) { return; }
        this.closeMoreCrumbs();

        // A separator belongs to the crumb it precedes, and goes with it.
        const setHidden = (element, hidden) => {
            if (!element) { return; }
            element.hidden = hidden;
            const before = element.previousElementSibling;
            if (before && before.classList.contains('studio-project-separator')) { before.hidden = hidden; }
        };
        const overflows = () => nav.scrollWidth > nav.clientWidth;

        const crumbs = Array.from(nav.querySelectorAll('.studio-crumb[data-project-crumb]'));
        const more = nav.querySelector('[data-project-more]');
        nav.classList.remove('root-compact', 'tight');
        crumbs.forEach(crumb => setHidden(crumb, false));
        setHidden(more, true);
        this.hiddenCrumbs = [];

        // crumbs.length - 1: the folder you are in is never folded away.
        for (let index = 0; index < crumbs.length - 1 && overflows(); index++) {
            setHidden(crumbs[index], true);
            this.hiddenCrumbs.push(this.pathParts[index + 1]);
            setHidden(more, false);
        }
        if (more && this.hiddenCrumbs.length) {
            more.setAttribute('aria-label', 'Show ' + this.hiddenCrumbs.length + ' hidden path segment' +
                (this.hiddenCrumbs.length > 1 ? 's' : ''));
        }
        // Skipped at the root, where the project name is the only crumb there is.
        if (crumbs.length && overflows()) { nav.classList.add('root-compact'); }
        if (overflows()) { nav.classList.add('tight'); }
    }

    toggleMoreCrumbs() {
        this.moreCrumbsOpen ? this.closeMoreCrumbs() : this.openMoreCrumbs();
    }

    openMoreCrumbs() {
        const trigger = this.breadcrumbEl.querySelector('[data-project-more]');
        if (!trigger || !this.hiddenCrumbs.length) { return; }
        this.moreCrumbsOpen = true;
        trigger.setAttribute('aria-expanded', 'true');
        const menu = document.createElement('div');
        menu.className = 'studio-crumb-popover';
        menu.innerHTML = this.hiddenCrumbs.map(part =>
            '<button data-project-crumb data-project-path="' + encodeURIComponent(part.uri.toString()) + '">' + escapeHtml(part.label) + '</button>'
        ).join('');
        // Anchored to the widget root, not to the breadcrumb strip itself —
        // the strip can scroll and clips its own overflow, which would clip
        // or drag along a popover that lived inside it.
        this.node.appendChild(menu);
        const hostRect = this.node.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        menu.style.left = Math.round(triggerRect.left - hostRect.left) + 'px';
        menu.style.top = Math.round(triggerRect.bottom - hostRect.top + 4) + 'px';
        // Entrance is deferred a frame so the transition actually plays,
        // instead of starting already in its end state.
        requestAnimationFrame(() => menu.classList.add('open'));
    }

    closeMoreCrumbs() {
        this.moreCrumbsOpen = false;
        const trigger = this.breadcrumbEl.querySelector('[data-project-more]');
        if (trigger) { trigger.setAttribute('aria-expanded', 'false'); }
        const menu = this.node.querySelector('.studio-crumb-popover');
        if (menu) { menu.remove(); }
    }

    focusActivePath() {
        const activePath = this.breadcrumbEl.querySelector('[data-project-crumb][aria-current="page"]');
        if (activePath) { activePath.focus(); }
    }

    /*
     * The ⋯ project-actions menu is GONE, and with it the second popover
     * implementation this file carried.
     *
     * Its two items were never siblings of the selector: Project settings is now
     * a field on the bottom line (status-line.js), beside the project name and
     * the saving policy it edits, and Connect project is a + in this panel's own
     * title bar (registered in product-frontend-module.js, executed by connect()
     * below). Nothing was dropped — one control was removed and both actions got
     * a home that names them.
     */

    async renderDirectory(root) {
        /*
         * The listing keeps the PREVIOUS folder on screen while the next one
         * resolves. That is the correct default for a local disk, where the
         * resolve returns in single-digit milliseconds and blanking the list
         * would produce a flicker on every click — and it is why this loading
         * state is delayed rather than immediate.
         *
         * But the default is only correct while it is fast. On a slow or remote
         * root the panel shows one folder's contents under another folder's
         * breadcrumb, which is not "not yet updated", it is wrong: the entries
         * are clickable and they belong to somewhere else. So past the delay the
         * stale listing is REPLACED rather than covered, and what replaces it
         * names the folder being opened.
         */
        const done = showLoading(
            this.entriesEl,
            'Opening ' + this.currentDirectory.path.base + '…',
            { replace: true, className: 'studio-project-loading' }
        );
        try {
            /*
             * resolveMetadata is what puts mtime on the children, and it is the
             * only new DATA any of this needed. Without it there is no Modified
             * column and no sort by it -- the listing would have to stat every
             * child separately, which is one round trip per file.
             */
            const stat = await this.fileService.resolve(this.currentDirectory, { resolveMetadata: true });
            const children = (stat.children || [])
                .filter(child => child.resource.path.base !== '.studio')
                .filter(child => fileTypeSettings.allows(child.resource, child.isDirectory));
            this.sortEntries(children);
            // See the empty branch in refresh(): the listbox role belongs to a
            // listing, not to the sentence that stands in for one.
            if (children.length) { this.entriesEl.setAttribute('role', 'listbox'); }
            else { this.entriesEl.removeAttribute('role'); }
            this.entriesEl.innerHTML = children.length
                ? children.map(child => this.entryRow(child)).join('')
                : '<div class="studio-project-empty">This folder is empty for the selected file types.</div>';
            this.announce(children.length);
            this.markOpenFile();
            this.setRovingFocus();
        } catch (error) {
            console.error('[studio] could not resolve project directory', this.currentDirectory.toString(), error);
            this.entriesEl.innerHTML = '<div class="studio-project-empty">This folder is unavailable.</div>';
            this.announce(undefined);
        } finally {
            // Both branches above replace the whole listing, so the node is
            // already gone by now; this is here for the pending TIMER, which
            // would otherwise fire into the folder that just finished loading.
            done();
        }
    }

    /*
     * Folders first, always, whatever the sort key -- a directory listing where
     * folders interleave with files by date is a listing you have to read
     * rather than scan. The chosen key orders within each group.
     */
    sortEntries(children) {
        const direction = this.sortAscending ? 1 : -1;
        const byName = (left, right) => left.resource.path.base.localeCompare(
            right.resource.path.base, undefined, { numeric: true, sensitivity: 'base' });
        children.sort((left, right) => {
            if (left.isDirectory !== right.isDirectory) { return left.isDirectory ? -1 : 1; }
            if (this.sortKey === 'modified') {
                // Newest first when ascending: "sorted by last modified" means
                // the recent end, which is the end anyone opened this for.
                return direction * ((right.mtime || 0) - (left.mtime || 0)) || byName(left, right);
            }
            if (this.sortKey === 'type') {
                const kind = stat => stat.isDirectory ? '' : fileIconKind(stat.resource.path.base);
                const compared = kind(left).localeCompare(kind(right));
                return compared ? direction * compared : byName(left, right);
            }
            return direction * byName(left, right);
        });
    }

    /*
     * One row. Reading order is exactly the row's priority order, which is what
     * makes the narrow-width rules in REPOS_CSS a matter of hiding a trailing
     * column rather than of rearranging anything:
     *
     *   glyph · name (grows, ellipsises in the middle) · time · badge · chevron
     *
     * The name is wrapped in .studio-entry-name and nothing else in the row
     * contributes to that element's text, so a test or a screen reader can read
     * a filename off a row without the timestamp glued to the end of it.
     */
    entryRow(child) {
        const uri = encodeURIComponent(child.resource.toString());
        const base = child.resource.path.base;
        const parts = splitName(base);
        const name = '<span class="studio-entry-name">' +
            '<span class="studio-entry-name-head">' + escapeHtml(parts.head) + '</span>' +
            '<span class="studio-entry-name-tail">' + escapeHtml(parts.tail) +
            '<span class="studio-entry-ext">' + escapeHtml(parts.extension) + '</span></span>' +
            '</span>';
        const when = relativeTime(child.mtime);
        const time = '<span class="studio-entry-time" aria-hidden="true">' + escapeHtml(when) + '</span>';
        const attribute = child.isDirectory ? 'data-project-dir' : 'data-project-file';
        const kind = child.isDirectory ? 'folder' : 'file';
        return '<button class="studio-project-entry ' + kind + '" role="option" aria-selected="false"' +
            ' tabindex="-1" ' + attribute + '="' + uri + '" title="' + escapeHtml(base) + '">' +
            '<span class="studio-entry-icon" aria-hidden="true">' +
            ICONS[child.isDirectory ? 'folder' : fileIconKind(base)] + '</span>' +
            name + time +
            (child.isDirectory ? '<span class="studio-entry-forward" aria-hidden="true">' + ICONS.chevronRight + '</span>' : '') +
            '</button>';
    }

    // The listing is not a live region any more, so the summary is stated here
    // instead -- one sentence per navigation rather than one per file.
    announce(count) {
        if (!this.statusEl) { return; }
        const where = this.currentDirectory ? this.currentDirectory.path.base : '';
        this.statusEl.textContent = count === undefined
            ? where + ' is unavailable'
            : where + ', ' + count + (count === 1 ? ' item' : ' items');
    }

    /*
     * The open document had no representation here at all: you opened a file
     * and the panel that opened it gave you no indication of where you were.
     */
    markOpenFile() {
        if (!this.entriesEl) { return; }
        const open = this.openFileUri && this.openFileUri.toString();
        this.entriesEl.querySelectorAll('[data-project-file]').forEach(entry => {
            const isOpen = !!open && decodeURIComponent(entry.getAttribute('data-project-file')) === open;
            entry.classList.toggle('open', isOpen);
            entry.setAttribute('aria-selected', isOpen ? 'true' : 'false');
        });
        this.setRovingFocus();
    }

    setActiveFile(uri) {
        this.openFileUri = uri;
        this.markOpenFile();
    }

    /*
     * ROVING TABINDEX, and it fixes a real defect rather than polishing one.
     *
     * Every row was a bare <button> in a <div>, so a 200-file folder was 200
     * tab stops between the sidebar and anything after it. The listing is one
     * stop now; the arrow keys move within it.
     */
    setRovingFocus() {
        if (!this.entriesEl) { return; }
        const rows = this.rows();
        if (!rows.length) { this.entriesEl.setAttribute('tabindex', '0'); return; }
        const current = rows.find(row => row.tabIndex === 0);
        const target = current || rows.find(row => row.classList.contains('open')) || rows[0];
        rows.forEach(row => { row.tabIndex = row === target ? 0 : -1; });
        // With a focusable row inside it, the container must not also be a stop.
        this.entriesEl.setAttribute('tabindex', '-1');
    }

    rows() {
        return [...this.entriesEl.querySelectorAll('.studio-project-entry')];
    }

    moveFocus(from, delta) {
        const rows = this.rows();
        if (!rows.length) { return; }
        const index = Math.max(0, rows.indexOf(from));
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
        if (!next) { return; }
        rows.forEach(row => { row.tabIndex = row === next ? 0 : -1; });
        next.focus();
    }

    onListKeyDown(event) {
        const row = event.target.closest('.studio-project-entry');
        const rows = this.rows();
        const keys = {
            ArrowDown: () => this.moveFocus(row, 1),
            ArrowUp: () => this.moveFocus(row, -1),
            Home: () => this.moveFocus(rows[0], 0),
            End: () => this.moveFocus(rows[rows.length - 1], 0),
            // Left is "up a level" in every file tree anyone has used, and it is
            // where the deleted Back button's job went.
            ArrowLeft: () => this.goBack(),
            Backspace: () => this.goBack(),
            ArrowRight: () => { if (row && row.hasAttribute('data-project-dir')) { row.click(); } }
        };
        const handler = keys[event.key];
        if (!handler) { return; }
        event.preventDefault();
        if (!row && event.key !== 'ArrowLeft' && event.key !== 'Backspace' && rows.length) {
            this.moveFocus(rows[0], 0);
            return;
        }
        handler();
    }

    // -- pending-change badges (requirement 12) ------------------------------

    /*
     * `onDidFilesChange` only reports resources something has asked to watch,
     * and the pending-change index lives in a directory nothing else opens —
     * so without this the badge subscription below never fires at all and the
     * counts only moved when the user happened to navigate. Watching the
     * whole `.studio` directory (rather than the index file, which may not
     * exist yet on a project that has never had a proposal) is what makes the
     * subscription real.
     */
    watchPendingSidecars(root) {
        const key = root.resource.toString();
        if (this.watchedSidecarRoot === key) { return; }
        this.watchedSidecarRoot = key;
        if (this.sidecarWatch) {
            try { this.sidecarWatch.dispose(); } catch (e) { /* already disposed */ }
            this.sidecarWatch = undefined;
        }
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            this.sidecarWatch = this.fileService.watch(new URI(key + '/.studio'));
            this.disposables.push(this.sidecarWatch);
        } catch (e) {
            console.warn('[studio] could not watch the pending-change sidecars for', key, e);
        }
    }

    onFilesChanged(event) {
        const touchedIndex = (event.changes || []).some(change => change.resource.toString().includes('.studio/changes/'));
        if (!touchedIndex || !this.badgeRoot) { return; }
        clearTimeout(this.pendingRefreshTimer);
        this.pendingRefreshTimer = setTimeout(() => this.refreshBadges(this.badgeRoot), PENDING_REFRESH_DEBOUNCE_MS);
    }

    async loadPending(root) {
        try {
            const files = await this.changesStore.pendingFiles(root.resource);
            return new Map(files.map(file => [file.path, file.pending]));
        } catch (e) {
            // No index yet, no workspace root, a bad read — any of these
            // just means "nothing pending", never a broken Projects browser.
            console.warn('[studio] could not read pending AI changes', e);
            return new Map();
        }
    }

    refreshBadges(root) {
        this.badgeRoot = root;
        const directory = this.currentDirectory.toString();
        this.loadPending(root).then(map => {
            // The user may have navigated elsewhere while the read was in
            // flight; a stale map would badge the wrong listing.
            if (this.isDisposed || this.currentDirectory.toString() !== directory) { return; }
            this.pendingByPath = map;
            this.applyBadges(root);
        });
    }

    /** Sum of pending counts for every file whose path sits under `path`. */
    pendingUnder(path) {
        const prefix = path + '/';
        let sum = 0;
        for (const [entryPath, pending] of this.pendingByPath) {
            if (entryPath.startsWith(prefix)) { sum += pending; }
        }
        return sum;
    }

    /*
     * A lightweight second pass over already-rendered rows: it only adds,
     * updates, or removes the badge element, so it can run whenever pending
     * data changes without re-rendering (and re-losing focus/scroll on) the
     * directory listing itself.
     */
    applyBadges(root) {
        if (!this.entriesEl) { return; }
        this.entriesEl.querySelectorAll('[data-project-file], [data-project-dir]').forEach(entry => {
            const encoded = entry.getAttribute('data-project-file') || entry.getAttribute('data-project-dir');
            const path = relativePath(root.resource, this.rootUri(encoded));
            const isDirectory = entry.hasAttribute('data-project-dir');
            const count = isDirectory ? this.pendingUnder(path) : (this.pendingByPath.get(path) || 0);
            this.setBadge(entry, count, isDirectory);
        });
    }

    setBadge(entry, count, isDirectory) {
        let badge = entry.querySelector('.studio-entry-badge');
        if (!count) {
            if (badge) { badge.remove(); }
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'studio-entry-badge';
            // Ahead of the forward chevron (if any) rather than appended
            // last, so the chevron stays the row's rightmost affordance.
            const forward = entry.querySelector('.studio-entry-forward');
            if (forward) { entry.insertBefore(badge, forward); } else { entry.appendChild(badge); }
        }
        badge.textContent = String(count);
        badge.title = isDirectory ? count + ' proposed changes inside' : count + ' proposed changes awaiting review';
    }

    async connect() {
        /*
         * THE STARTING FOLDER HAS TO BE ONE THAT STILL EXISTS.
         *
         * This passed `roots[0]` straight through, and that is how "Connect
         * project" became a button that does nothing. Theia's
         * ElectronFileDialogService resolves the folder it is given
         * (`getRootNode` -> `fileService.resolve`), swallows the failure in a bare
         * `catch {}`, and returns `undefined` — which is the same value it returns
         * when the user cancels. So a workspace whose FIRST root has been deleted,
         * renamed, or left on an unmounted volume produces: no dialog, no error,
         * no message, and no way to connect a project ever again without editing
         * the workspace file by hand.
         *
         * Reproduced exactly: with root[0] present the native dialog opens; with
         * root[0] missing the call resolves `undefined` in under a millisecond.
         * It is easy to reach — a project under /tmp that the OS has cleaned, a
         * folder moved in Finder, an external disk — and completely silent, which
         * is the worst combination a primary action can have.
         *
         * So the dialog is given the first candidate that actually resolves, and
         * `undefined` if none does, which makes Theia fall back to the user's
         * working directory. The candidate ORDER is also an improvement in its own
         * right: opening where the user is currently browsing beats opening at
         * whichever root happens to be first.
         */
        const folder = await this.fileDialogService.showOpenDialog({
            title: 'Connect a local project', canSelectFiles: false, canSelectFolders: true,
            canSelectMany: false, openLabel: 'Connect'
        }, await this.dialogStartFolder());
        if (!folder) { return; }
        /*
         * delayMs: 0, against the rule the other listing state follows.
         *
         * Connecting is the one action in this panel the user has already spent
         * a modal dialog on, and it is the slowest: addRoot rewrites the
         * workspace file and makes Theia re-resolve every root, reloadAll reads
         * a settings sidecar per root, and only then does the listing render.
         * The dialog closes the instant Connect is clicked, so with a delay the
         * panel would sit on the OLD project — or on "Connect a local project"
         * — for the whole of it, which reads as the click having missed.
         */
        const done = showLoading(
            this.entriesEl,
            'Connecting ' + folder.path.base + '…',
            { replace: true, delayMs: 0, className: 'studio-project-loading' }
        );
        try {
            await this.workspaceService.addRoot(folder);
            this.activeRoot = folder.toString();
            this.currentDirectory = folder;
            await fileTypeSettings.reloadAll();
            await this.refresh();
        } finally {
            done();
        }
    }

    /**
     * Where the Connect dialog should open, as a FileStat Theia can resolve.
     *
     * Candidates in order of how useful they are to the person clicking, not in
     * the order the workspace happens to store them: where they are browsing,
     * then the project they have selected, then any root at all.
     */
    async dialogStartFolder() {
        const { URI } = require('@theia/core/lib/common/uri');
        const roots = await this.workspaceService.roots;
        const candidates = [];
        if (this.currentDirectory) { candidates.push(this.currentDirectory); }
        if (this.activeRoot) { candidates.push(new URI(this.activeRoot)); }
        for (const root of roots) { candidates.push(root.resource); }
        /*
         * The home directory LAST, and it is what makes this a fix rather than an
         * improvement.
         *
         * Handing Theia `undefined` looks like it should be enough — its own
         * `getRootNode` falls back to `UserWorkingDirectoryProvider` — and it is
         * not: that provider tries the current SELECTION first, which in a
         * workspace whose folder has gone missing is a path inside the missing
         * folder. So `undefined` resolves to a dead directory, `resolve` throws,
         * the bare `catch {}` swallows it, and the dialog still never opens.
         * Verified in the running application: with every candidate dead and
         * `undefined` passed, the command still returned immediately.
         *
         * Home is the one directory that cannot have been deleted out from under
         * the person now asking to connect a project.
         */
        if (this.envVariables && typeof this.envVariables.getHomeDirUri === 'function') {
            try { candidates.push(new URI(await this.envVariables.getHomeDirUri())); }
            catch (e) { console.warn('[studio] could not read the home directory', e); }
        }
        return firstResolvableFolder(candidates, uri => this.fileService.resolve(uri));
    }

    /*
     * Disconnect, and its two-click confirm, moved to project-page.js -- the
     * arming logic went with the button rather than being duplicated here, so
     * there is exactly one implementation of the confirm gesture for it.
     */

    async navigate(encoded) {
        this.currentDirectory = this.rootUri(encoded);
        await this.refresh(true);
    }

    async goBack() {
        const roots = await this.workspaceService.roots;
        const root = this.findRoot(roots);
        if (!root || this.currentDirectory.toString() === root.resource.toString()) { return; }
        await this.navigate(encodeURIComponent(this.currentDirectory.parent.toString()));
    }

    async openFile(encoded) {
        if (!this.openerService) {
            console.error('[studio] opener service is unavailable');
            return;
        }
        const uri = this.rootUri(encoded);
        // Marked before the open rather than after it: opening is asynchronous
        // and the row should respond to the click, not to the editor.
        this.setActiveFile(uri);
        await open(this.openerService, uri);
    }

    /*
     * The sort menu, reusing the file-operations popover rather than adding a
     * third popover implementation to this file. Picking the mode that is
     * already active flips direction, which is what a sort control does
     * everywhere else and saves a second menu for it.
     */
    toggleSortMenu() {
        const trigger = this.breadcrumbEl.querySelector('[data-project-sort]');
        if (!trigger) { return; }
        if (this.fileOperationsMenu) { this.closeFileOperationsMenu(); return; }
        const menu = document.createElement('div');
        menu.className = 'studio-file-operations-menu studio-sort-menu';
        menu.setAttribute('role', 'menu');
        menu.innerHTML = SORT_MODES.map(mode =>
            '<button role="menuitemradio" aria-checked="' + (mode.key === this.sortKey) + '"' +
            ' data-sort-key="' + mode.key + '"' + (mode.key === this.sortKey ? ' class="checked"' : '') + '>' +
            escapeHtml(mode.label) +
            (mode.key === this.sortKey ? '<span aria-hidden="true">' + (this.sortAscending ? '↑' : '↓') + '</span>' : '') +
            '</button>').join('');
        const rect = trigger.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)) + 'px';
        menu.style.top = Math.round(rect.bottom + 4) + 'px';
        document.body.appendChild(menu);
        this.fileOperationsMenu = menu;
        trigger.setAttribute('aria-expanded', 'true');
        const first = menu.querySelector('[data-sort-key]');
        if (first) { first.focus(); }
    }

    applySort(key) {
        this.sortAscending = key === this.sortKey ? !this.sortAscending : true;
        this.sortKey = key;
        this.closeFileOperationsMenu();
        this.refresh();
    }

    fileOperationParent(uri, isDirectory) {
        return isDirectory ? uri : uri.parent;
    }

    async promptForName({ title, placeholder, initialValue = '', parent }) {
        const dialog = new SingleTextInputDialog({
            title,
            maxWidth: 400,
            placeholder,
            initialValue,
            validate: async name => {
                const trimmed = name.trim();
                if (!trimmed) { return 'A name is required.'; }
                if (trimmed !== name || /[\\/]/.test(name) || name === '.' || name === '..') {
                    return 'Use a single file or folder name.';
                }
                if (await this.fileService.exists(parent.resolve(name))) { return 'An item with this name already exists.'; }
                return '';
            }
        });
        return dialog.open();
    }

    async newFile(parent) {
        const name = await this.promptForName({ title: 'New File', placeholder: 'File name', parent });
        if (!name) { return; }
        const uri = parent.resolve(name);
        await this.fileService.create(uri);
        await this.refresh();
        await open(this.openerService, uri);
    }

    async newFolder(parent) {
        const name = await this.promptForName({ title: 'New Folder', placeholder: 'Folder name', parent });
        if (!name) { return; }
        await this.fileService.createFolder(parent.resolve(name));
        await this.refresh();
    }

    async rename(uri) {
        const name = await this.promptForName({
            title: 'Rename', placeholder: 'Name', initialValue: uri.path.base, parent: uri.parent
        });
        if (!name || name === uri.path.base) { return; }
        await this.fileService.move(uri, uri.parent.resolve(name));
        await this.refresh();
    }

    async chooseDestination(source, verb) {
        const current = await this.fileService.resolve(this.currentDirectory);
        const destination = await this.fileDialogService.showOpenDialog({
            title: verb + ' “' + source.path.base + '” to…',
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: verb
        }, current);
        if (!destination || destination.toString() === source.parent.toString()) { return; }
        const target = destination.resolve(source.path.base);
        if (await this.fileService.exists(target)) {
            throw new Error('“' + source.path.base + '” already exists in the selected folder.');
        }
        return target;
    }

    async copy(uri) {
        const target = await this.chooseDestination(uri, 'Copy');
        if (!target) { return; }
        await this.fileService.copy(uri, target);
        await this.refresh();
    }

    async move(uri) {
        const target = await this.chooseDestination(uri, 'Move');
        if (!target) { return; }
        await this.fileService.move(uri, target);
        await this.refresh();
    }

    async delete(uri) {
        const confirmed = await new ConfirmDialog({
            title: 'Delete “' + uri.path.base + '”?',
            msg: 'This permanently deletes the selected file or folder and its contents.',
            ok: 'Delete', cancel: 'Cancel'
        }).open();
        if (!confirmed) { return; }
        await this.fileService.delete(uri, { recursive: true });
        await this.refresh();
    }

    closeFileOperationsMenu() {
        if (this.fileOperationsMenu) { this.fileOperationsMenu.remove(); }
        this.fileOperationsMenu = undefined;
        this.fileOperationsTarget = undefined;
        // The sort trigger shares this popover, so it shares its teardown.
        const sort = this.breadcrumbEl && this.breadcrumbEl.querySelector('[data-project-sort]');
        if (sort) { sort.setAttribute('aria-expanded', 'false'); }
    }

    onContextMenu(event) {
        const entry = event.target.closest('[data-project-file], [data-project-dir]');
        if (!entry || !this.node.contains(entry)) { return; }
        event.preventDefault();
        this.closeFileOperationsMenu();
        const encoded = entry.getAttribute('data-project-file') || entry.getAttribute('data-project-dir');
        this.fileOperationsTarget = {
            uri: this.rootUri(encoded), isDirectory: entry.hasAttribute('data-project-dir')
        };
        const menu = document.createElement('div');
        menu.className = 'studio-file-operations-menu';
        menu.setAttribute('data-file-operations-menu', '');
        menu.setAttribute('role', 'menu');
        menu.innerHTML = [
            ['new-file', 'New File'], ['new-folder', 'New Folder'], ['rename', 'Rename'],
            ['copy', 'Copy'], ['move', 'Move'], ['delete', 'Delete']
        ].map(([operation, label]) => '<button role="menuitem" data-file-op="' + operation + '">' + label + '</button>').join('');
        menu.style.left = Math.min(event.clientX, window.innerWidth - 188) + 'px';
        menu.style.top = Math.min(event.clientY, window.innerHeight - 250) + 'px';
        document.body.appendChild(menu);
        this.fileOperationsMenu = menu;
        // The menu intentionally lives under <body> so it can escape the
        // narrow, overflow-clipped Projects rail. Its clicks therefore do not
        // bubble through this widget's normal delegated handler.
        menu.addEventListener('click', event => {
            const action = event.target.closest('[data-file-op]');
            if (action) { void this.runFileOperation(action.getAttribute('data-file-op')); }
        });
        menu.querySelector('[data-file-op]').focus();
    }

    async runFileOperation(operation) {
        const target = this.fileOperationsTarget;
        if (!target) { return; }
        const parent = this.fileOperationParent(target.uri, target.isDirectory);
        this.closeFileOperationsMenu();
        try {
            if (operation === 'new-file') { await this.newFile(parent); }
            else if (operation === 'new-folder') { await this.newFolder(parent); }
            else if (operation === 'rename') { await this.rename(target.uri); }
            else if (operation === 'copy') { await this.copy(target.uri); }
            else if (operation === 'move') { await this.move(target.uri); }
            else if (operation === 'delete') { await this.delete(target.uri); }
        } catch (error) {
            console.error('[studio] file operation failed', error);
            if (this.messageService) { this.messageService.error(error.message || 'The file operation failed.'); }
        }
    }

    /*
     * The file-type filter and the saving policy are read here (renderDirectory
     * filters on fileTypeSettings.allows) but no longer WRITTEN here: their
     * controls, and the toggleType/toggleAutosave/renderAutosave that drove
     * them, live on the Project page. This panel stays a browser.
     */

    onChange(event) {
        const target = event.target;
        if (target.matches('[data-project-switcher]')) {
            this.activeRoot = decodeURIComponent(target.value);
            this.currentDirectory = this.rootUri(target.value);
            /*
             * The ring on this control is a focus ring, and after a mouse
             * choice it has nothing left to say — the selector already shows
             * what was picked. Reported from use ("highlight on buttons persists
             * after the selection"). The product-wide fix is the pointer/keyboard
             * modality gate in SHELL_CSS; nothing is blurred here, because a
             * keyboard user changing projects with the arrow keys must keep both
             * the focus and the ring that shows where it is.
             */
            this.refresh(true);
        }
    }

    onClick(event) {
        const target = event.target.closest(
            '[data-act], [data-project-dir], [data-project-file], [data-project-crumb], [data-project-back], ' +
            '[data-project-more], [data-project-sort], [data-sort-key], [data-file-op]'
        );
        if (!target) { return; }
        if (target.hasAttribute('data-file-op')) {
            this.runFileOperation(target.getAttribute('data-file-op'));
        } else if (target.hasAttribute('data-sort-key')) {
            this.applySort(target.getAttribute('data-sort-key'));
        } else if (target.hasAttribute('data-project-sort')) {
            this.toggleSortMenu();
        } else if (target.hasAttribute('data-project-more')) {
            this.toggleMoreCrumbs();
        } else if (target.hasAttribute('data-project-dir') || target.hasAttribute('data-project-crumb')) {
            this.navigate(target.getAttribute('data-project-dir') || target.getAttribute('data-project-path'));
        } else if (target.hasAttribute('data-project-file')) {
            this.openFile(target.getAttribute('data-project-file'));
        } else if (target.hasAttribute('data-project-back')) {
            this.goBack();
        } else if (target.getAttribute('data-act') === 'connect') {
            // The empty state's own primary button. The title bar's + does the
            // same thing through a command, and both land in connect() below —
            // there is one implementation of connecting a project.
            this.connect();
        }
    }
}

/**
 * The first of `uris` that resolves to a directory, or undefined.
 *
 * Pure, and exported, because the bug it exists to prevent is entirely about
 * what happens when a path is gone — which is a condition a test can state in
 * one line and a running application can only be coaxed into.
 */
async function firstResolvableFolder(uris, resolve) {
    for (const uri of uris || []) {
        if (!uri) { continue; }
        try {
            const stat = await resolve(uri);
            if (stat && stat.isDirectory) { return stat; }
        } catch (e) {
            // Deleted, renamed, or on a volume that is no longer mounted. Not
            // worth reporting: the next candidate is the answer, and the last
            // resort (undefined) is a working dialog at the user's home.
        }
    }
    return undefined;
}

const REPOS_CSS = `
/*
 * CONTAINER, NOT VIEWPORT.
 *
 * Every width rule below keys off this element, because Theia lets someone drag
 * this rail narrow while the window stays exactly where it was -- which is the
 * case the old stylesheet had no answer for at all, and the reason a 170px rail
 * used to render every filename over two or three lines.
 *
 * The rule the whole panel now obeys: NOTHING WRAPS, EVER. Every element is one
 * line with a defined truncation strategy, and narrowing DROPS COLUMNS in a
 * fixed priority order rather than reflowing anything onto a new line.
 */
.studio-repos { display:flex; flex-direction:column; height:100%; min-width:0; container-type:inline-size; container-name:repos; background:var(--studio-surface); color:var(--studio-text); }

/* -- the path bar: project chip, segments, sort. One 30px line. ------------ */
/*
 * NOTHING IN THIS STRIP SHRINKS. Every control is flex:none, so when the path
 * does not fit the nav genuinely overflows -- which is the measurement fitPath()
 * reads. Letting flexbox resolve it instead is what produced the reported bug:
 * shrink is distributed by ratio, so it took the project chip down to two
 * clipped letters and a folder down to "p…" while the strip still "fitted".
 *
 * The two escape hatches below are applied BY fitPath, in order, and only after
 * folding whole segments away has failed.
 */
.studio-project-path {
  position:relative; flex:none; display:flex; align-items:center; gap:0;
  height:30px; padding:0 4px 0 6px; border-bottom:1px solid var(--studio-line);
  white-space:nowrap; overflow:hidden;
}
.studio-project-path [hidden] { display:none !important; }
.studio-project-path button {
  flex:none; min-width:0; border:0; background:transparent; color:var(--studio-muted);
  cursor:pointer; font:500 12px/1 inherit; padding:4px 4px; border-radius:4px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.studio-project-path button:hover { color:var(--studio-text); background:var(--studio-surface-raised); }
/* Only the folder you are actually in takes full ink. */
.studio-project-path button[aria-current="page"] { color:var(--studio-text); font-weight:600; }
.studio-project-separator { flex:none; margin:0 1px; color:var(--studio-line); font-size:11px; }

/* The split root chip. The label navigates to the project root; the caret half
   carries a real <select>, stretched transparent over it, so switching projects
   keeps the native menu instead of a div pretending to be one. */
.studio-project-root { flex:none; min-width:0; display:flex; align-items:center; border-radius:4px; }
.studio-project-root:hover { background:var(--studio-surface-raised); }
.studio-project-root-name {
  display:inline-flex !important; align-items:center;
  font-weight:600 !important; color:var(--studio-text) !important; padding-right:1px !important;
}
.studio-project-root-label { overflow:hidden; text-overflow:ellipsis; }
/* FOLD STEP 2: the project name goes, the chip stays. A home glyph plus the
   caret is still a target, still navigates to the root, and still opens the
   project switcher -- which is the control this panel exists to keep reachable.
   The accessible name lives on the button, so dropping the text drops nothing
   a screen reader was using. */
.studio-project-root-glyph { display:none; }
.studio-project-root-glyph svg { width:13px; height:13px; display:block; }
.studio-project-path.root-compact .studio-project-root-glyph { display:block; }
.studio-project-path.root-compact .studio-project-root-label { display:none; }
.studio-project-root-switch { position:relative; flex:none; display:flex; align-items:center; padding:0 3px; color:var(--studio-muted); }
.studio-project-root-switch svg { width:11px; height:11px; display:block; }
.studio-project-root-switch:hover { color:var(--studio-text); }
.studio-project-switcher {
  position:absolute; inset:0; width:100%; height:100%;
  opacity:0; cursor:pointer; appearance:none; border:0; padding:0; font:inherit;
}
/* :has(:focus-visible), not :focus-within. The overlaid <select> takes focus on
   a plain mouse click, so :focus-within left a 2px accent ring parked on a 17px
   caret for the rest of the session — which is most of what made the strip read
   as broken in the report. The ring is for keyboard focus, which is what asked
   for it. */
.studio-project-root-switch:has(:focus-visible) { outline:2px solid var(--studio-accent); outline-offset:1px; border-radius:3px; }

/* FOLD STEP 3, last resort. Below the width where even one crumb plus a glyph
   fits, the current folder is allowed to ellipsise -- it is the last thing to
   degrade, never the first. min-width keeps it from being clipped to nothing. */
.studio-project-path.tight .studio-project-root,
.studio-project-path.tight .studio-project-root-name,
.studio-project-path.tight .studio-project-root-label,
.studio-project-path.tight button[aria-current="page"] { flex:0 1 auto; min-width:3ch; }

.studio-project-sort { flex:none; margin-left:auto; display:inline-flex; align-items:center; padding:4px !important; }
.studio-project-sort svg { width:13px; height:13px; display:block; }
.studio-project-sort[aria-expanded="true"] { color:var(--studio-accent) !important; background:var(--studio-surface-raised); }
.studio-project-crumb-more {
  min-width:18px; padding:2px 4px !important; border-radius:4px; text-align:center;
  background:var(--studio-surface-raised); border:1px solid var(--studio-line) !important;
}
.studio-project-crumb-more[aria-expanded="true"] { color:var(--studio-accent) !important; border-color:var(--studio-accent) !important; }

.studio-project-path button:focus-visible, .studio-project-entry:focus-visible, .studio-project-entries:focus-visible { outline:2px solid var(--studio-accent); outline-offset:-2px; }

/* -- menus ----------------------------------------------------------------- */
.studio-file-operations-menu { position:fixed; z-index:10000; width:176px; padding:4px; border:1px solid var(--studio-edge); border-radius:8px; background:var(--studio-surface-raised); box-shadow:0 8px 24px var(--studio-shadow); }
.studio-file-operations-menu button { display:flex; justify-content:space-between; gap:8px; width:100%; border:0; border-radius:4px; background:transparent; color:var(--studio-text); cursor:pointer; font:500 12px/1.4 inherit; padding:6px 8px; text-align:left; }
.studio-file-operations-menu button:hover, .studio-file-operations-menu button:focus-visible { background:var(--studio-selection-bg); color:var(--studio-text); outline:none; }
.studio-file-operations-menu button[data-file-op="delete"] { color:var(--studio-danger); }
.studio-file-operations-menu button[data-file-op="delete"]:hover, .studio-file-operations-menu button[data-file-op="delete"]:focus-visible { background:color-mix(in srgb, var(--studio-danger) 10%, transparent); color:var(--studio-danger); }
.studio-sort-menu button.checked { color:var(--studio-accent); font-weight:600; }

.studio-crumb-popover {
  position:absolute; z-index:30; min-width:140px; max-width:260px;
  display:flex; flex-direction:column; padding:4px; border-radius:8px;
  background:var(--studio-surface-raised); border:1px solid var(--studio-line);
  box-shadow:0 10px 28px color-mix(in srgb, var(--studio-bg) 78%, transparent);
  opacity:0; transform:scale(.95); transform-origin:top left;
  transition:opacity 140ms cubic-bezier(0.23,1,0.32,1), transform 140ms cubic-bezier(0.23,1,0.32,1);
}
.studio-crumb-popover.open { opacity:1; transform:scale(1); }
.studio-crumb-popover button {
  display:block; width:100%; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  padding:6px 8px; border-radius:4px; border:0; background:transparent; cursor:pointer;
  color:var(--studio-text); font:500 12px/1.3 inherit;
}
.studio-crumb-popover button:hover { background:var(--studio-surface); color:var(--studio-accent); }
.studio-crumb-popover button:focus-visible { outline:2px solid var(--studio-accent); outline-offset:-2px; }

/* -- the listing ----------------------------------------------------------- */
.studio-project-browser { flex:1; min-height:0; overflow:auto; padding:4px; }
.studio-project-entries { display:flex; flex-direction:column; }
.studio-project-entries:focus { outline:none; }
/*
 * 24px, down from a 32px min-height plus a 2px gap.
 *
 * The old row spent 34px of pitch on a 13px glyph and one line of 12.5px text.
 * At 24px the target is still the full width of the rail, and the saving is
 * per-row: a 200-file folder is 2000px shorter. Flex, not grid -- the columns
 * are dropped rather than resized as the panel narrows, and a flex line with
 * display:none children collapses cleanly where a fixed grid track does not.
 */
.studio-project-entry {
  display:flex; align-items:center; gap:7px; height:24px; flex:none;
  width:100%; border:0; border-radius:4px; background:transparent;
  color:var(--studio-text); cursor:pointer; font:600 12px/1 inherit;
  padding:0 6px; text-align:left; white-space:nowrap;
}
.studio-project-entry:hover { background:var(--studio-surface-raised); }
/* The open document, which had no representation in this panel at all. */
.studio-project-entry.open { background:var(--studio-selection-bg); }
.studio-project-entry.open .studio-entry-name { color:var(--studio-accent); }

/*
 * ACCENT MEANS TWO THINGS IN THIS LIST, and only two: this is a folder
 * (navigation), or this needs you (pending changes). Every file glyph is muted
 * -- markdown included, which used to be accent-tinted along with five other
 * kinds. Eleven CSS-drawn boxes with letters in them became one Lucide glyph.
 */
.studio-entry-icon { flex:none; display:flex; width:14px; height:14px; color:var(--studio-muted); }
.studio-entry-icon svg { width:14px; height:14px; display:block; }
.studio-project-entry.folder .studio-entry-icon { color:var(--studio-accent); }

/* Middle truncation: the head gives way, the tail never does. See splitName(). */
.studio-entry-name { flex:1; min-width:0; display:flex; align-items:baseline; overflow:hidden; }
.studio-entry-name-head { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.studio-entry-name-tail { flex:none; }
.studio-entry-ext { color:var(--studio-muted); font-weight:400; }
.studio-project-entry.open .studio-entry-ext { color:inherit; opacity:.7; }

.studio-entry-time { flex:none; font-size:10.5px; font-weight:400; color:var(--studio-muted); font-variant-numeric:tabular-nums; }
/*
 * The pending-change count SURVIVES EVERY WIDTH. It is actionable state -- this
 * file is waiting on you -- where the timestamp beside it is passive metadata,
 * so the metadata is what gives way first. Below the threshold in the container
 * query at the foot of this file the badge stops being a number and becomes a
 * dot: still flagged, no longer counted.
 */
.studio-entry-badge { flex:none; font-size:9px; font-weight:700; line-height:14px; height:14px; min-width:14px; text-align:center; padding:0 4px; border-radius:999px; background:var(--studio-accent); color:var(--studio-on-accent); font-variant-numeric:tabular-nums; }
.studio-entry-forward { flex:none; display:flex; color:var(--studio-muted); }
.studio-entry-forward svg { width:12px; height:12px; display:block; }

.studio-project-empty { padding:12px 8px; color:var(--studio-muted); font-size:12px; line-height:1.45; }
.studio-project-loading { padding:24px 8px; }
.studio-project-loading .studio-loading-caption { font-size:12px; overflow-wrap:anywhere; }
/* Visually hidden, but a real live region -- the listing used to be one, which
   meant every navigation announced the entire folder. */
.studio-project-status { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }

.studio-project-entries .studio-btn.primary { align-self:start; margin:4px 6px; }
.studio-btn { border:1px solid var(--studio-line); border-radius:6px; background:var(--studio-surface-raised); color:var(--studio-text); cursor:pointer; font:600 11.5px/1 inherit; padding:7px 9px; }
.studio-btn:hover { border-color:var(--studio-accent); }
.studio-btn.primary { background:var(--studio-accent); border-color:var(--studio-accent); color:var(--studio-on-accent); }
.studio-btn.ghost { background:transparent; color:var(--studio-muted); }

/*
 * THE COLUMN PRIORITY LADDER.
 *
 * Read it as one ordered sentence: the Modified column goes first, then the
 * badge loses its digits, then the folder chevron goes. The badge itself never
 * leaves, and no rule here changes a row's height or lets anything wrap -- a
 * narrow panel shows FEWER COLUMNS, never more lines.
 */
@container repos (max-width: 230px) {
  .studio-entry-time { display:none; }
}
@container repos (max-width: 190px) {
  .studio-entry-badge { min-width:0; width:6px; height:6px; padding:0; border-radius:999px; font-size:0; line-height:0; overflow:hidden; }
}
@container repos (max-width: 170px) {
  .studio-entry-forward { display:none; }
  .studio-project-entry { gap:6px; padding:0 4px; }
}
`;

// splitName/relativeTime/fileIconKind are exported for the browser suite rather
// than for another module: they carry the row's whole truncation and iconography
// contract, and that contract is worth pinning without a running application.
module.exports = {
    RepositoriesWidget, REPOS_CSS, firstResolvableFolder,
    splitName, relativeTime, fileIconKind, SORT_MODES
};
