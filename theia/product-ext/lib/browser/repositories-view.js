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

// Badges re-read after a burst of sidecar writes (an "accept all" can touch
// several files at once) settle on one read instead of one per file change.
const PENDING_REFRESH_DEBOUNCE_MS = 200;

// Above this many segments, the breadcrumb collapses the middle into a
// clickable "…" instead of scrolling sideways — a horizontal scrollbar in a
// 24px-tall strip reads as broken, not as a navigation affordance.
const BREADCRUMB_COLLAPSE_THRESHOLD = 4;

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
}

// These are product glyphs, not an imported VS Code icon theme: a quiet file
// outline plus a compact semantic mark lets people scan a directory without a
// rainbow of logos or generic document icons.
function fileIconKind(name) {
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return ({
        md: 'markdown', html: 'html', htm: 'html', json: 'data', yaml: 'data', yml: 'data',
        csv: 'table', tsv: 'table', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', sh: 'terminal', css: 'style', scss: 'style', xml: 'markup', svg: 'vector',
        png: 'image', jpg: 'image', jpeg: 'image', pdf: 'pdf', txt: 'text', lock: 'package',
        'package.json': 'package'
    })[name.toLowerCase()] || ({
        json: 'data', yaml: 'data', yml: 'data', csv: 'table', tsv: 'table', ts: 'typescript', tsx: 'typescript',
        js: 'javascript', jsx: 'javascript', py: 'python', sh: 'terminal', css: 'style', scss: 'style',
        xml: 'markup', svg: 'vector', png: 'image', jpg: 'image', jpeg: 'image', pdf: 'pdf', md: 'markdown',
        html: 'html', htm: 'html', txt: 'text'
    })[extension] || 'file';
}

class RepositoriesWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileDialogService = ctx.fileDialogService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.messageService = ctx.messageService;
        // No openProjectPage callback any more: the route to the Project page is
        // the bottom line's own field, and this panel no longer has a control
        // that opens it. See the note where the ⋯ menu used to be.
        this.activeRoot = undefined;
        this.currentDirectory = undefined;
        this.moreCrumbsOpen = false;

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
            '<div class="studio-project-head">' +
            '  <div class="studio-project-switch-row">' +
            '    <select id="studio-project-switcher" class="studio-project-switcher" data-project-switcher aria-label="Active project"></select>' +
            '  </div>' +
            '</div>' +
            '<nav class="studio-project-breadcrumb" data-project-breadcrumb aria-label="Active path"></nav>' +
            '<div class="studio-project-browser" aria-live="polite">' +
            '  <div class="studio-project-entries"></div>' +
            '</div>';

        this.switcherEl = this.node.querySelector('[data-project-switcher]');
        this.breadcrumbEl = this.node.querySelector('[data-project-breadcrumb]');
        this.entriesEl = this.node.querySelector('.studio-project-entries');
        this.node.addEventListener('click', event => this.onClick(event));
        this.node.addEventListener('change', event => this.onChange(event));
        this.node.addEventListener('contextmenu', event => this.onContextMenu(event));
        document.addEventListener('click', this.outsideClickHandler = event => {
            if (this.moreCrumbsOpen && !event.target.closest('.studio-project-breadcrumb')) { this.closeMoreCrumbs(); }
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
            this.switcherEl.innerHTML = '<option>No projects connected</option>';
            this.breadcrumbEl.innerHTML = '';
            this.entriesEl.innerHTML =
                '<div class="studio-project-empty">Connect a local project to browse its files.</div>' +
                '<button class="studio-btn primary" data-act="connect">Connect project</button>';
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

        this.renderSwitcher(roots, root);
        this.renderBreadcrumb(root);
        await this.renderDirectory(root);
        if (restorePathFocus) { this.focusActivePath(); }
        this.watchPendingSidecars(root);
        // Deliberately not awaited: the directory listing is already on
        // screen, and badges are a follow-up DOM pass, not part of the
        // listing's own render.
        this.refreshBadges(root);
    }

    renderSwitcher(roots, activeRoot) {
        this.switcherEl.innerHTML = roots.map(root => {
            const uri = root.resource.toString();
            return '<option value="' + encodeURIComponent(uri) + '"' + (uri === activeRoot.resource.toString() ? ' selected' : '') + '>' +
                escapeHtml(root.resource.path.base) + '</option>';
        }).join('');
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
    renderBreadcrumb(root) {
        const parts = this.breadcrumbParts(root);
        this.moreCrumbsOpen = false;
        this.hiddenCrumbs = parts.length > BREADCRUMB_COLLAPSE_THRESHOLD ? parts.slice(1, parts.length - 2) : [];
        const visible = this.hiddenCrumbs.length ? [parts[0], ...parts.slice(parts.length - 2)] : parts;

        const crumbButton = part => {
            const isRoot = part === parts[0];
            return '<button data-project-crumb' +
                (isRoot ? ' class="studio-project-crumb-root" aria-label="' + escapeHtml(part.label) + '"' : '') +
                ' data-project-path="' + encodeURIComponent(part.uri.toString()) + '"' +
                (part === parts[parts.length - 1] ? ' aria-current="page"' : '') + '>' +
                (isRoot ? ICONS.home : escapeHtml(part.label)) + '</button>';
        };

        let html = parts.length > 1
            ? '<button class="studio-project-back" data-project-back aria-label="Back to parent folder">Back</button>'
            : '';
        visible.forEach((part, index) => {
            if (index > 0) { html += '<span class="studio-project-separator">/</span>'; }
            html += crumbButton(part);
            if (index === 0 && this.hiddenCrumbs.length) {
                html += '<span class="studio-project-separator">/</span>' +
                    '<button class="studio-project-crumb-more" data-project-more aria-haspopup="true" aria-expanded="false" ' +
                    'aria-label="Show ' + this.hiddenCrumbs.length + ' hidden path segment' + (this.hiddenCrumbs.length > 1 ? 's' : '') + '">…</button>';
            }
        });
        this.breadcrumbEl.innerHTML = html;
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
        try {
            const stat = await this.fileService.resolve(this.currentDirectory);
            const children = (stat.children || [])
                .filter(child => child.resource.path.base !== '.studio')
                .filter(child => fileTypeSettings.allows(child.resource, child.isDirectory))
                .sort((left, right) => {
                    if (left.isDirectory !== right.isDirectory) { return left.isDirectory ? -1 : 1; }
                    return left.resource.path.base.localeCompare(right.resource.path.base, undefined, { numeric: true, sensitivity: 'base' });
                });
            this.entriesEl.innerHTML = children.length ? children.map(child => {
                const uri = encodeURIComponent(child.resource.toString());
                const name = escapeHtml(child.resource.path.base);
                if (child.isDirectory) {
                    return '<button class="studio-project-entry folder" data-project-dir="' + uri + '">' +
                        '<span class="studio-entry-icon" aria-hidden="true"></span><span>' + name + '</span><span class="studio-entry-forward" aria-hidden="true">›</span></button>';
                }
                return '<button class="studio-project-entry file" data-project-file="' + uri + '">' +
                    '<span class="studio-entry-icon icon-' + fileIconKind(child.resource.path.base) + '" aria-hidden="true"></span><span>' + name + '</span></button>';
            }).join('') : '<div class="studio-project-empty">This folder is empty for the selected file types.</div>';
        } catch (error) {
            console.error('[studio] could not resolve project directory', this.currentDirectory.toString(), error);
            this.entriesEl.innerHTML = '<div class="studio-project-empty">This folder is unavailable.</div>';
        }
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
        const roots = await this.workspaceService.roots;
        const folder = await this.fileDialogService.showOpenDialog({
            title: 'Connect a local project', canSelectFiles: false, canSelectFolders: true,
            canSelectMany: false, openLabel: 'Connect'
        }, roots[0]);
        if (!folder) { return; }
        await this.workspaceService.addRoot(folder);
        this.activeRoot = folder.toString();
        this.currentDirectory = folder;
        await fileTypeSettings.reloadAll();
        await this.refresh();
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
        await open(this.openerService, this.rootUri(encoded));
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
            '[data-project-more], [data-file-op]'
        );
        if (!target) { return; }
        if (target.hasAttribute('data-file-op')) {
            this.runFileOperation(target.getAttribute('data-file-op'));
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

const REPOS_CSS = `
.studio-repos { display:flex; flex-direction:column; height:100%; min-width:0; background:var(--studio-surface, #16171c); color:var(--studio-text, #f1eee7); }
.studio-project-head { padding:16px 14px 10px; border-bottom:1px solid var(--studio-line, #e1e4e8); }
.studio-project-switch-label { display:block; margin:0 0 6px; color:var(--studio-muted, #9298a8); font-size:10px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
/* One control, the full width of the column. The row survives the ⋯ button's
   removal because the selector still wants a flex parent that cannot let it
   overflow a 257px rail; what changed is that nothing competes with it. */
.studio-project-switch-row { display:flex; align-items:center; }
.studio-project-switcher { flex:1; min-width:0; appearance:none; border:1px solid var(--studio-line, #30333d); border-radius:7px; background:var(--studio-surface-raised, #202127); color:var(--studio-text, #f1eee7); font:600 13px/1.2 inherit; padding:8px 28px 8px 10px; background-image:linear-gradient(45deg,transparent 50%,var(--studio-muted,#9298a8) 50%),linear-gradient(135deg,var(--studio-muted,#9298a8) 50%,transparent 50%); background-position:calc(100% - 14px) 50%,calc(100% - 10px) 50%; background-size:4px 4px,4px 4px; background-repeat:no-repeat; }
.studio-project-switcher:focus-visible, .studio-project-entry:focus-visible, .studio-project-breadcrumb button:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:2px; }
.studio-file-operations-menu { position:fixed; z-index:10000; width:176px; padding:4px; border:1px solid var(--studio-edge, var(--studio-line, #d7dbe1)); border-radius:7px; background:var(--studio-surface-raised, #fff); box-shadow:0 8px 24px var(--studio-shadow, rgba(15,23,42,.16)); }
.studio-file-operations-menu button { display:block; width:100%; border:0; border-radius:4px; background:transparent; color:var(--studio-text, #1f2328); cursor:pointer; font:500 12px/1 inherit; padding:8px 9px; text-align:left; }
.studio-file-operations-menu button:hover, .studio-file-operations-menu button:focus-visible { background:var(--studio-selection-bg, #e9edfb); color:var(--studio-text, #1f2328); outline:none; }
.studio-file-operations-menu button[data-file-op="delete"] { color:var(--studio-danger, #c43d36); }
.studio-file-operations-menu button[data-file-op="delete"]:hover, .studio-file-operations-menu button[data-file-op="delete"]:focus-visible { background:color-mix(in srgb, var(--studio-danger, #c43d36) 10%, transparent); color:var(--studio-danger, #c43d36); }
.studio-project-breadcrumb {
  position:relative; display:flex; align-items:center; gap:4px; min-height:39px;
  padding:0 12px; border-bottom:1px solid var(--studio-line, #e1e4e8); white-space:nowrap;
  /* Collapsing the middle into "…" keeps this from overflowing in the common
     case; overflow can still scroll for a rail this narrow with long names,
     but the scrollbar itself stays invisible — a visible one is the thing
     that read as broken, not the ability to reach a far segment. */
  overflow-x:auto; overflow-y:hidden; scrollbar-width:none;
}
.studio-project-breadcrumb::-webkit-scrollbar { display:none; }
.studio-project-breadcrumb button { flex:0 0 auto; border:0; background:transparent; color:var(--studio-muted, #9298a8); cursor:pointer; font:500 11.5px/1 inherit; padding:4px 2px; border-radius:4px; }
.studio-project-breadcrumb button[aria-current="page"] { color:var(--studio-text, #f1eee7); font-weight:600; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
.studio-project-breadcrumb button:hover { color:var(--studio-amber, #d59b3b); }
.studio-project-back { margin-right:5px !important; color:var(--studio-cyan, #61c9d7) !important; }
/* The root crumb carries a home glyph instead of the project name, which the
   switcher 30px above already states. The element, its target, and its
   aria-current are unchanged -- the name lives in aria-label. */
.studio-project-crumb-root { display:inline-flex; align-items:center; padding:4px !important; }
.studio-project-crumb-root svg { width:13px; height:13px; display:block; }
.studio-project-separator { color:var(--studio-line, #30333d); }
.studio-project-crumb-more {
  min-width:22px; height:20px; padding:0 4px !important; border-radius:5px; letter-spacing:.02em;
  background:var(--studio-surface-raised, #202127); border:1px solid var(--studio-line, #30333d) !important;
}
.studio-project-crumb-more[aria-expanded="true"] { color:var(--studio-amber, #d59b3b); border-color:var(--studio-amber, #d59b3b) !important; }
/* One popover, one user now: the breadcrumb's overflow menu. The project-actions
   menu that shared these rules is gone (its two actions moved to the bottom line
   and the panel's title bar), and its right-anchored variant went with it. */
.studio-crumb-popover {
  position:absolute; z-index:30; min-width:140px; max-width:260px;
  display:flex; flex-direction:column; padding:5px; border-radius:9px;
  background:var(--studio-surface-raised, #202127); border:1px solid var(--studio-line, #30333d);
  box-shadow:0 10px 28px color-mix(in srgb, var(--studio-bg, #16171c) 78%, transparent);
  opacity:0; transform:scale(.95); transform-origin:top left;
  transition:opacity 140ms cubic-bezier(0.23,1,0.32,1), transform 140ms cubic-bezier(0.23,1,0.32,1);
}
.studio-crumb-popover.open { opacity:1; transform:scale(1); }
.studio-crumb-popover button {
  display:block; width:100%; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  padding:6px 8px; border-radius:6px; border:0; background:transparent; cursor:pointer;
  color:var(--studio-text, #f1eee7); font:500 12px/1.3 inherit;
}
.studio-crumb-popover button:hover { background:var(--studio-surface, #16171c); color:var(--studio-amber, #d59b3b); }
.studio-crumb-popover button:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:-2px; }
.studio-project-browser { flex:1; min-height:0; overflow:auto; padding:8px; }
.studio-project-entries { display:flex; flex-direction:column; gap:2px; }
.studio-project-entry { display:grid; grid-template-columns:18px minmax(0,1fr) auto auto; align-items:center; min-height:32px; width:100%; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--studio-text, #f1eee7); cursor:pointer; font:500 12.5px/1.2 inherit; padding:0 8px; text-align:left; }
.studio-project-entry:hover { border-color:var(--studio-line, #30333d); background:var(--studio-surface-raised, #202127); }
.studio-entry-icon { width:13px; height:10px; box-sizing:border-box; border:1.5px solid var(--studio-muted, #9298a8); border-radius:2px; opacity:.9; }
.studio-project-entry.folder .studio-entry-icon { position:relative; border-color:var(--studio-amber, #d59b3b); }
.studio-project-entry.folder .studio-entry-icon::before { content:""; position:absolute; left:1px; top:-4px; width:5px; height:3px; border:1.5px solid var(--studio-amber, #d59b3b); border-bottom:0; border-radius:2px 2px 0 0; }
.studio-project-entry.file .studio-entry-icon { position:relative; width:11px; height:14px; border-radius:1px; border-color:var(--studio-muted, #6e7781); }
.studio-project-entry.file .studio-entry-icon::after { position:absolute; left:50%; top:50%; transform:translate(-50%,-48%); color:var(--studio-muted, #6e7781); content:"·"; font:700 9px/1 ui-sans-serif,system-ui,sans-serif; }
.studio-project-entry.file .studio-entry-icon.icon-markdown::after { content:"M"; font-size:7px; }
.studio-project-entry.file .studio-entry-icon.icon-html::after, .studio-project-entry.file .studio-entry-icon.icon-markup::after { content:"<>"; font-size:5px; letter-spacing:-1px; }
.studio-project-entry.file .studio-entry-icon.icon-data::after { content:"{}"; font-size:6px; letter-spacing:-1px; }
.studio-project-entry.file .studio-entry-icon.icon-table::after { content:"▦"; font-size:8px; }
.studio-project-entry.file .studio-entry-icon.icon-typescript::after { content:"TS"; font-size:5px; }
.studio-project-entry.file .studio-entry-icon.icon-javascript::after { content:"JS"; font-size:5px; }
.studio-project-entry.file .studio-entry-icon.icon-python::after { content:"Py"; font-size:5px; }
.studio-project-entry.file .studio-entry-icon.icon-terminal::after { content:">_"; font-size:6px; letter-spacing:-1px; }
.studio-project-entry.file .studio-entry-icon.icon-style::after { content:"#"; font-size:8px; }
.studio-project-entry.file .studio-entry-icon.icon-vector::after { content:"◇"; font-size:9px; }
.studio-project-entry.file .studio-entry-icon.icon-image::after { content:"◒"; font-size:9px; }
.studio-project-entry.file .studio-entry-icon.icon-pdf::after { content:"P"; font-size:7px; }
.studio-project-entry.file .studio-entry-icon.icon-package::after { content:"□"; font-size:8px; }
.studio-project-entry.file .studio-entry-icon.icon-markdown, .studio-project-entry.file .studio-entry-icon.icon-html, .studio-project-entry.file .studio-entry-icon.icon-typescript, .studio-project-entry.file .studio-entry-icon.icon-javascript, .studio-project-entry.file .studio-entry-icon.icon-python, .studio-project-entry.file .studio-entry-icon.icon-package { border-color:var(--studio-amber, #0b2275); }
.studio-project-entry.file .studio-entry-icon.icon-markdown::after, .studio-project-entry.file .studio-entry-icon.icon-html::after, .studio-project-entry.file .studio-entry-icon.icon-typescript::after, .studio-project-entry.file .studio-entry-icon.icon-javascript::after, .studio-project-entry.file .studio-entry-icon.icon-python::after, .studio-project-entry.file .studio-entry-icon.icon-package::after { color:var(--studio-amber, #0b2275); }
.studio-entry-forward { color:var(--studio-muted, #9298a8); font-size:18px; line-height:1; }
.studio-entry-badge { flex:none; font-size:10px; font-weight:650; min-width:16px; text-align:center; padding:1px 5px; margin-left:auto; border-radius:999px; background:var(--studio-amber, #d59b3b); color:#fff; font-variant-numeric:tabular-nums; }
.studio-project-empty { padding:16px 8px; color:var(--studio-muted, #9298a8); font-size:12px; line-height:1.45; }
/* With nothing connected, connecting IS the panel's content, so the primary
   button sits in the listing area rather than in a permanent footer band. The
   footer, the file-type filter, and the autosave toggle that used to live down
   there are gone; their styles moved to project-page.js with their controls. */
.studio-project-entries .studio-btn.primary { align-self:start; margin:0 8px; }
.studio-btn { border:1px solid var(--studio-line, #30333d); border-radius:6px; background:var(--studio-surface-raised, #202127); color:var(--studio-text, #f1eee7); cursor:pointer; font:600 11.5px/1 inherit; padding:7px 9px; }
.studio-btn:hover { border-color:var(--studio-amber, #d59b3b); }
.studio-btn.primary { background:var(--studio-amber, #d59b3b); border-color:var(--studio-amber, #d59b3b); color:var(--studio-bg, #101116); }
.studio-btn.ghost { background:transparent; color:var(--studio-muted, #9298a8); }
`;

module.exports = { RepositoriesWidget, REPOS_CSS };
