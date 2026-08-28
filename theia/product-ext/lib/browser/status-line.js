/*
 * The bottom line — the product's ambient surface.
 *
 * Decided from design review 02 (option A). The shell had nowhere to put a fact
 * that is true CONTINUOUSLY rather than about one document, so such facts were
 * either duplicated into every surface that had room or dropped: which project
 * is active was stated three times, whether saving is automatic sat in a panel
 * footer, and the theme toggle lived alone at the foot of a 978px column with a
 * 48px divider above it separating one button from nothing (D10, D19).
 *
 * Two measurements decided the mechanism:
 *
 *   1. The band already exists. `#theia-statusBar` was hidden in CSS, but hiding
 *      a Lumino BoxPanel child with CSS does not make it give back its box —
 *      Lumino still laid out 22px for it, and `elementFromPoint(800, 990)`
 *      returned the shell itself. 1600 x 22 of window was allocated and blank.
 *      So this costs nothing: it fills space that was already spent.
 *   2. Theia's own `StatusBar` service is the supported way in, with `setElement`
 *      / `removeElement` and an `onclick` per entry. No monkey-patching, no
 *      second status bar of our own painted over Theia's.
 *
 * THE CAP IS THE POINT. A status line is where clutter goes to hide, and this
 * product has already had one junk drawer (the Projects panel footer this
 * replaces). The rule, recorded in the extension-point table: at most five
 * fields, replace rather than append, no destructive actions, and a field earns
 * its place only by being true continuously. Anything episodic — a conflict, a
 * failed save — is a banner in the document, which is where those already are.
 *
 * The cap now reads: at most five FIELDS — entries that state a fact — plus
 * controls that operate a surface this shell already has. That distinction was
 * forced by the terminal toggle below, and it is drawn where it is because the
 * failure the cap prevents is a line nobody reads. A sixth fact competes with
 * the five for the same glance; a glyph that opens a panel does not. What has
 * not moved: no destructive actions, nothing episodic, and a control still has
 * to earn its place rather than arrive because it was easy to add.
 *
 * Fields, and why each qualifies:
 *   location  where you are: project plus the active document's folder. This is
 *             also the ONLY remaining statement of the project name outside the
 *             Projects panel, which is what let the document topbar drop its
 *             path (it was the file name a second time, 35px under the tab).
 *   settings  the way to the Project page. It arrived here when the Projects
 *             panel's ⋯ menu was removed ("these dots are breaking nice UI"):
 *             this band already names the project and states its saving policy,
 *             so the control that configures both belongs in it rather than
 *             beside a selector at the top of another panel. Five fields exactly
 *             — the cap is now reached, and the next addition has to replace.
 *   saving    the project's persistence policy, previously in the footer.
 *   pending   how many proposals are waiting across the project. Continuous,
 *             project-scoped, and invisible when zero, so it never reads as a
 *             field that is merely empty.
 *   theme     app-scoped, one click, previously alone at the foot of the rail.
 *   terminal  a control, not a field: one glyph that opens or puts away
 *             Theia's own bottom-panel terminal. Lit while that panel is open,
 *             so the button says which way it will act. It reuses the terminal
 *             that already exists instead of spawning one per click.
 *
 * WHICH project all of this is about is `activeProject`, not `roots[0]`.
 * Reported from use: "I selected project OFFICE but bottom menu shows theia-ws".
 * roots[0] is insertion order; the user's choice lives in the Projects panel's
 * switcher, and active-project.js is where the two surfaces now agree.
 */

const { StatusBarAlignment } = require('@theia/core/lib/browser/status-bar/status-bar-types');
const { ChangesStore, relativePath } = require('./changes-store');
const { fileTypeSettings } = require('./file-type-settings');
const { activeProject } = require('./active-project');

/*
 * Pending counts are re-read after a burst of sidecar writes settles rather than
 * once per file event — an "accept all" can touch several files at once. Same
 * debounce, and the same reason, as the Projects browser's badges.
 */
const PENDING_DEBOUNCE_MS = 200;

const STATUS_LINE_CSS = `
/* --- the bottom line ------------------------------------------------------ *
 * Quiet by size, not by contrast: 11px on a chrome-toned band, one hairline
 * above it. It is read at a glance and never competes with the document.
 *
 * The text is --studio-text rather than --studio-muted, and that was decided by
 * measurement: muted on this band is 4.05:1, below AA for normal text, and 11px
 * is not large text. Full-strength ink at 11px on a 22px band is the calm option
 * that is also readable (14.09:1 light, 12.4:1 dark) -- and it is what VS Code's
 * own status bar does. The seam above it is a top-level shell boundary, which is
 * the one case --studio-edge is for (constraint 24).
 */
#theia-statusBar {
  height: 22px; min-height: 22px;
  /* The outermost chrome tone, shared with the activity bars and the dock's tab
     strip, so the shell's frame is one material. */
  background: var(--studio-chrome);
  border-top: 1px solid var(--studio-edge);
  color: var(--studio-text);
  font-size: 11px;
  padding: 0 6px;
}
#theia-statusBar .area { display: flex; align-items: center; gap: 2px; }
/* --- the cap, enforced in CSS as well as in policy ------------------------- *
 *
 * Un-hiding Theia's status bar also inherits its contributors, and measurement
 * found three of them the moment the bar became visible: a marker count reading
 * "0  0" (96px, for a Problems view this product does not have) and two 36px
 * entries with no text at all. That is exactly the drift the five-field cap
 * exists to prevent, and a cap that only lives in a comment is not a cap.
 *
 * Same stance, and the same mechanism, as the activity-rail curation above: the
 * product shows the fields it owns. If a future entry is worth showing, it gets
 * a studio-status-* class and a place in the policy.
 */
#theia-statusBar .element:not([class*="studio-status-"]) { display: none !important; }
/* !important on the colour, for the same reason the token in SHELL_CSS carries
   it: Theia's own status-bar stylesheet sets the text colour on
   "#theia-statusBar .area .element", which outranks a product rule on
   "#theia-statusBar .element" on specificity alone, and it resolved that colour
   from its own light theme. Measured in dark before this: every field at 1.08:1
   against its background -- text that is present and invisible. Belt and braces
   with the token, since a field nobody can read is the one failure mode a status
   line must not have. */
#theia-statusBar .element {
  height: 18px; display: flex; align-items: center; gap: 5px;
  padding: 0 7px; border-radius: 4px; white-space: nowrap;
  color: var(--studio-text) !important;
}
#theia-statusBar .element.hasCommand:hover,
#theia-statusBar .element[onclick]:hover { background: var(--studio-surface-raised); color: var(--studio-text); cursor: pointer; }
#theia-statusBar .element:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: -2px; }
/* The terminal toggle: a glyph, and lit while its panel is open so the button
   states which way it will act. Same 22px box as every other entry. */
#theia-statusBar .element.studio-status-terminal { padding: 0 6px; color: var(--studio-muted) !important; }
#theia-statusBar .element.studio-status-terminal:hover { color: var(--studio-text) !important; }
#theia-statusBar .element.studio-status-terminal.is-open { color: var(--studio-text) !important; background: var(--studio-surface-raised); }
/* The one field that is a count rather than a fact reads as a count. */
#theia-statusBar .element.studio-status-pending { color: var(--studio-accent); font-weight: 600; }
#theia-statusBar .element.studio-status-saving.state-conflict,
#theia-statusBar .element.studio-status-saving.state-error { color: var(--studio-danger) !important; font-weight: 650; }
#theia-statusBar .element.studio-status-saving.state-dirty { color: var(--studio-accent) !important; }
/* The settings field is a glyph, not a word: it sits immediately after the
   project name it configures, and a labelled "Project settings" field would have
   said "project" twice inside 200px. The codicon carries the meaning and the
   tooltip carries the name. Slightly tighter padding so a 13px glyph does not
   read as a wider field than the text beside it. */
#theia-statusBar .element.studio-status-project { padding: 0 6px; color: var(--studio-muted) !important; }
#theia-statusBar .element.studio-status-project:hover { color: var(--studio-text) !important; }
`;

class StatusLine {

    init({ statusBar, shell, workspaceService, fileService, currentTheme, toggleTheme, openProjectPage, commandRegistry }) {
        this.statusBar = statusBar;
        this.shell = shell;
        this.commandRegistry = commandRegistry;
        this.workspaceService = workspaceService;
        this.fileService = fileService;
        this.currentTheme = currentTheme;             // () => 'light' | 'dark'
        this.toggleTheme = toggleTheme;               // () => void
        this.openProjectPage = openProjectPage;
        this.changesStore = new ChangesStore(fileService, workspaceService);
        this.pending = 0;
        this.documentStates = new Map();
    }

    start() {
        if (!this.statusBar) { return; }
        this.render();
        // Which document is in front changes the location field, and nothing
        // else publishes that.
        if (this.shell && this.shell.onDidChangeCurrentWidget) {
            this.shell.onDidChangeCurrentWidget(() => this.render());
        }
        if (this.workspaceService && this.workspaceService.onWorkspaceChanged) {
            this.workspaceService.onWorkspaceChanged(() => { this.refreshPending(); this.render(); });
        }
        // Switching projects changes every project-scoped field here — the name,
        // the saving policy and the pending count — and nothing else publishes
        // that choice.
        activeProject.onChanged(() => { this.refreshPending(); this.render(); });
        // The saving policy is written by the project page, which does not know
        // this exists; the settings store is the shared channel.
        fileTypeSettings.onChanged(() => this.render());
        if (this.fileService && this.fileService.onDidFilesChange) {
            this.fileService.onDidFilesChange(() => {
                clearTimeout(this.pendingTimer);
                this.pendingTimer = setTimeout(() => this.refreshPending(), PENDING_DEBOUNCE_MS);
            });
        }
        this.refreshPending();
    }

    /** Repaint on a theme change, which also flips this field's own label. */
    onThemeChanged() { this.render(); }

    activeDocumentUri() {
        if (!this.shell) { return undefined; }
        let widget;
        try { widget = this.shell.getCurrentWidget('main'); }
        catch (e) { widget = undefined; }
        return widget && widget.uri ? widget.uri : undefined;
    }

    setDocumentState(uri, state, text) {
        if (!uri) { return; }
        this.documentStates.set(uri.toString(), { state, text });
        this.render();
    }

    async refreshPending() {
        try {
            const roots = await this.workspaceService.roots;
            const root = activeProject.resolve(roots);
            if (!root) { this.pending = 0; this.render(); return; }
            const status = await this.changesStore.pendingFilesStatus(root.resource);
            this.pending = status.available
                ? status.files.reduce((total, file) => total + file.pending, 0)
                : 0;
        } catch (e) {
            // An unreadable or absent index is "nothing pending", never an error
            // in a status line — a line that can shout is a line people stop
            // reading.
            this.pending = 0;
        }
        this.render();
    }

    /*
     * Resolved once per render, because three of the four fields need it and
     * `roots` is a promise.
     *
     * `location` is "project / folder", never the file name. The dock tab
     * already names the file, and the whole reason the topbar's path could go is
     * that this field states what the tab does not: which project, and which
     * folder inside it. At the project root there is no folder to add, so it
     * stays just the project.
     *
     * The PROJECT is the one the user selected (activeProject), not roots[0].
     * The folder is only appended when the open document actually lives inside
     * that project — with a document from another root in front, relativePath
     * returns nothing and the field states the project alone, which is true,
     * rather than gluing one project's name to another's folder.
     */
    async context() {
        let roots = [];
        try { roots = await this.workspaceService.roots; } catch (e) { roots = []; }
        const active = activeProject.resolve(roots);
        const root = active ? active.resource : undefined;
        const uri = this.activeDocumentUri();
        if (!root) { return { location: 'No project', autosave: true }; }
        const name = root.path.base;
        let location = name;
        if (uri) {
            const relative = relativePath(root, uri);
            if (relative && relative.indexOf('/') >= 0) {
                location = name + ' / ' + relative.slice(0, relative.lastIndexOf('/'));
            }
        }
        /*
         * The policy of the ACTIVE PROJECT, not of the open document's root.
         *
         * For the common case they are the same read — the document you are
         * editing is in the project you selected — but when they differ, every
         * other project-scoped field on this line describes the active project,
         * and the field's own click opens THAT project's page. Reading the
         * document's root here would state one project's name and another
         * project's policy in adjacent fields, which is the class of
         * disagreement this whole change is about.
         */
        return { root, uri, location, autosave: fileTypeSettings.autosaveFor(root) };
    }

    /*
     * Theia keeps terminals in the bottom panel, which this shell leaves in
     * place but never opens. "Visible" therefore means the panel is expanded
     * AND it holds a terminal — the panel can also be open for something else,
     * and a toggle that collapsed somebody else's panel would be a surprise.
     */
    terminalWidgets() {
        if (!this.shell || !this.shell.widgets) { return []; }
        return this.shell.widgets.filter(widget => widget && typeof widget.id === 'string'
            && widget.id.startsWith('terminal-'));
    }

    terminalVisible() {
        const bottomPanel = this.shell && this.shell.bottomPanel;
        if (!bottomPanel || bottomPanel.isHidden) { return false; }
        return this.terminalWidgets().some(widget => !widget.isDisposed && widget.parent);
    }

    /*
     * Open one, or put it away. Reusing the terminal that already exists rather
     * than spawning another on every click: this is a toggle in the bottom
     * line, not the "new terminal" command, and a button that silently
     * accumulates shell processes is how a review session ends up with nine of
     * them.
     */
    async toggleTerminal() {
        if (!this.shell) { return; }
        const existing = this.terminalWidgets().filter(widget => !widget.isDisposed && widget.parent);
        if (this.terminalVisible()) {
            this.shell.collapsePanel('bottom');
            this.render();
            return;
        }
        if (existing.length) {
            this.shell.activateWidget(existing[0].id);
            this.render();
            return;
        }
        if (!this.commandRegistry) { return; }
        try {
            await this.commandRegistry.executeCommand('terminal:new');
        } catch (error) {
            console.error('[studio] could not open a terminal', error);
        }
        this.render();
    }

    async render() {
        if (!this.statusBar) { return; }
        const { location, autosave, root } = await this.context();
        this.statusBar.setElement('studio.location', {
            text: location,
            alignment: StatusBarAlignment.LEFT,
            priority: 100,
            tooltip: 'Where you are. Click to show the Projects panel.',
            className: 'studio-status-location',
            onclick: () => { try { this.shell.activateWidget('studio-repositories'); } catch (e) { /* not mounted */ } }
        });

        /*
         * The way to the Project page, immediately after the project it
         * configures. This replaces the Projects panel's ⋯ menu, whose two items
         * both left: settings here, Connect project to the panel's title bar.
         *
         * A codicon rather than a word, and immediately to the right of the name
         * rather than over on the right-hand cluster, because its subject is the
         * field it sits next to. The gear is the one glyph nobody has to learn.
         */
        if (root) {
            this.statusBar.setElement('studio.project', {
                text: '$(gear)',
                alignment: StatusBarAlignment.LEFT,
                priority: 99,
                tooltip: 'Project settings',
                className: 'studio-status-project',
                onclick: () => { if (this.openProjectPage) { this.openProjectPage(); } }
            });
        } else {
            // Nothing to configure, so no control: with no project connected the
            // page has only its own empty state to show, and the Projects panel
            // is already offering the one action that applies.
            this.statusBar.removeElement('studio.project');
        }

        const documentState = root && this.documentStates.get((this.activeDocumentUri() || {}).toString?.());
        const savingText = documentState ? documentState.text : (autosave ? 'Autosave on' : 'Manual save');
        this.statusBar.setElement('studio.saving', {
            text: savingText,
            alignment: StatusBarAlignment.RIGHT,
            priority: 200,
            tooltip: documentState
                ? 'Current document save state. ' + (autosave ? 'Autosave is on.' : 'Manual save is enabled.')
                : autosave
                ? 'Changes are written to disk as you type. Click to change how this project saves.'
                : 'Changes are held until you save. Click to change how this project saves.',
            className: 'studio-status-saving' + (documentState ? ' state-' + documentState.state : ''),
            onclick: () => { if (this.openProjectPage) { this.openProjectPage(); } }
        });

        // Absent rather than zero: a field that is usually "0 pending" trains
        // people to stop looking at the line.
        if (this.pending > 0) {
            this.statusBar.setElement('studio.pending', {
                text: this.pending + (this.pending === 1 ? ' pending change' : ' pending changes'),
                alignment: StatusBarAlignment.RIGHT,
                priority: 300,
                tooltip: 'Proposed changes waiting for review in this project',
                className: 'studio-status-pending'
            });
        } else {
            this.statusBar.removeElement('studio.pending');
        }

        /*
         * A terminal, kept to a glyph.
         *
         * This is the sixth entry against a documented cap of five, and it is
         * deliberate rather than drift: it was asked for, and the alternative
         * — dropping one of the five to make room — would have removed a fact
         * that is true continuously in order to add a control that is used
         * occasionally. The cap's purpose is to stop the line becoming a junk
         * drawer, and the discipline it actually enforces is "no destructive
         * actions, no episodic state, replace before you append". A one-glyph
         * toggle for a panel that already exists in the shell does not breach
         * that; a sixth *field* stating a sixth fact would have.
         *
         * It stays a glyph on purpose. Terminal use is occasional in a
         * document-review product, so the entry earns a 22px icon and not a
         * word — the same reasoning as the settings gear, which is also a
         * control rather than a fact.
         */
        this.statusBar.setElement('studio.terminal', {
            text: '$(terminal)',
            alignment: StatusBarAlignment.RIGHT,
            priority: 40,
            tooltip: this.terminalVisible() ? 'Hide the terminal' : 'Open a terminal',
            className: 'studio-status-terminal' + (this.terminalVisible() ? ' is-open' : ''),
            onclick: () => this.toggleTerminal()
        });

        const dark = this.currentTheme && this.currentTheme() === 'dark';
        this.statusBar.setElement('studio.theme', {
            text: (dark ? '☽' : '☀') + ' ' + (dark ? 'Dark' : 'Light'),
            alignment: StatusBarAlignment.RIGHT,
            priority: 50,
            tooltip: dark ? 'Switch to the light theme' : 'Switch to the dark theme',
            className: 'studio-status-theme',
            onclick: () => { if (this.toggleTheme) { this.toggleTheme(); } }
        });
    }
}

const statusLine = new StatusLine();

module.exports = { statusLine, STATUS_LINE_CSS };
