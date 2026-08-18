/*
 * The Project page — once-per-project settings, on demand.
 *
 * WHY THIS EXISTS (measured, not assumed): the Projects panel used to carry a
 * permanent 114px footer band — 11.7% of the panel's height — holding three
 * things that are not the same KIND of thing at all:
 *
 *   - a VIEW FILTER over the file list above it (21 checkboxes when expanded,
 *     stacked in a 257px-wide column, which is what made it unusable);
 *   - a PROJECT-WIDE PERSISTENCE POLICY (the autosave toggle);
 *   - a WORKSPACE-LEVEL ACTION (connect another project).
 *
 * Nothing labelled the band and nothing ordered it, so it became the product's
 * unplanned junk drawer: the only place anything project-scoped could go. Two
 * of its three controls also misstated their own affordance — "+ File types"
 * used the universal add glyph for what is a disclosure triangle, and
 * "Autosave on" was a live toggle rendered as muted static text, which is
 * exactly why a user read it as a status label rather than a control.
 *
 * The fix is not a better strip. Settings that are touched once per project get
 * a real PAGE, with room for headings and a sentence of help, and take no
 * permanent screen space when nobody asked for them. The Projects panel keeps
 * only what is used continuously: the switcher, the path, and the file list.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { fileTypeSettings, KNOWN_TYPES, DEFAULT_ON } = require('./file-type-settings');
const { activeProject } = require('./active-project');
const { identity } = require('./identity');
const { assistantAuthView, ASSISTANT_AUTH_CSS } = require('./assistant-auth-view');
const { avatarHtml } = require('./comment-ui');

// Same two-click confirm window as the comment-thread delete and the old
// disconnect button: long enough to be a deliberate second click, short enough
// that a forgotten armed button disarms itself rather than lying in wait.
const CONFIRM_DISARM_MS = 2600;

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
}

class ProjectPageWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        // Not used by this page today; kept because every product widget
        // receives the same ctx shape and a settings page that grows a "reveal
        // .studio/settings.json" affordance will need it.
        this.openerService = ctx.openerService;
        this.armedDisconnect = false;
        this.disposables = [];

        this.id = 'studio-project-page';
        this.title.label = 'Project';
        this.title.caption = 'Project settings';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-settings-gear';
        this.addClass('studio-project-page');

        /*
         * The markup is built once and then only its VALUES are refreshed.
         *
         * Writing a setting persists to .studio/settings.json, which fires
         * fileTypeSettings.onChanged, which refreshes this page — so a refresh
         * that re-created the DOM would rip focus out of the very checkbox that
         * was just clicked. See renderTypes for the in-place sync that avoids
         * that, and note the same reason keeps the headings out of the refresh
         * path entirely.
         *
         * Sections are separated by a hairline and by tone, not by boxes: an
         * earlier round read as a stack of cards, which made three settings
         * look like three unrelated apps.
         */
        this.node.innerHTML =
            '<div class="studio-page-column">' +
            '  <header class="studio-page-head">' +
            '    <h2>Project</h2>' +
            '    <p class="studio-page-lede">Settings for the connected project. They are stored in the project itself, at ' +
            '<code>.studio/settings.json</code>, so they travel with the branch instead of with this machine. ' +
            'Your name is the exception, and says so.</p>' +
            '  </header>' +

            /*
             * 0. Who you are.
             *
             * Deliberately ABOVE the empty state and OUTSIDE [data-page-sections]:
             * every other setting on this page is keyed to a connected project and
             * vanishes when there is none, but a name is not project-scoped and a
             * user with no project connected must still be able to say who they
             * are. Putting it inside the sections div would hide the field exactly
             * when a new user first opens the page.
             *
             * It is first because it is a prerequisite rather than a preference:
             * until it is set, every comment this user writes is attributed to
             * "You", which reads as nobody to the next person to open the file.
             *
             * The value goes to localStorage, NOT to .studio/settings.json, and
             * the note says so. That file is committed — a display name written
             * there would travel to whoever clones the repository and silently
             * claim their comments as this user's.
             */
            '  <section class="studio-settings-section studio-settings-you">' +
            '    <h3>You</h3>' +
            '    <p class="studio-settings-help">The name shown on comments and change proposals you write.</p>' +
            '    <div class="studio-settings-row">' +
            '      <span data-page-identity-avatar></span>' +
            '      <input type="text" class="studio-input" data-act="display-name" maxlength="60" ' +
            'placeholder="Your name" aria-label="Your display name" spellcheck="false">' +
            '    </div>' +
            '    <p class="studio-settings-note" data-page-identity-note></p>' +
            '  </section>' +

            /*
             * 0b. The assistants, and signing in to them as yourself.
             *
             * User-scoped like the name above it, and outside [data-page-sections]
             * for the same reason: an assistant login has nothing to do with which
             * project is connected, and hiding it until one is would strand a user
             * who opened the IDE to talk to Codex.
             *
             * Subscription sign-in rather than an API key first, because that is
             * how most people hold these accounts. Both flows are headless on
             * purpose: an interactive login wants a browser callback on localhost,
             * and localhost inside a hosted session is not somewhere the user's
             * browser can reach. Codex prints a device code to approve elsewhere;
             * Claude issues a subscription token.
             */
            '  <section class="studio-settings-section studio-settings-assistants">' +
            '    <h3>Assistants</h3>' +
            '    <p class="studio-settings-help">Sign in to Codex and Claude as yourself. ' +
            'Credentials are stored for your account only, not for this workspace.</p>' +
            '    <div data-page-assistants></div>' +
            '  </section>' +

            '  <div class="studio-page-empty" data-page-empty hidden>No project is connected. Connect one from the Projects panel to configure it.</div>' +
            '  <div class="studio-page-sections" data-page-sections>' +

            /*
             * 1. Identity, and the one destructive action that belongs to it.
             *
             * Disconnect moved here from a bare trash icon sitting beside the
             * project switcher, where a single click on a control the width of
             * a checkbox could unhook the project you were looking at. A named
             * button, on a page you had to ask for, is the right weight — and
             * the two-click confirm is retained on top of that.
             */
            '    <section class="studio-settings-section">' +
            '      <h3>Project</h3>' +
            '      <p class="studio-settings-help">The connected folder every setting on this page applies to.</p>' +
            '      <div class="studio-project-identity">' +
            '        <div class="studio-project-title" data-page-project-name></div>' +
            '        <div class="studio-project-location" data-page-project-location></div>' +
            '      </div>' +
            '      <div class="studio-settings-row">' +
            '        <button class="studio-btn danger" data-act="disconnect">Disconnect project</button>' +
            '        <span class="studio-settings-note">Removes the project from this workspace. Nothing on disk is deleted.</span>' +
            '      </div>' +
            '    </section>' +

            /*
             * 2. The view filter — a filter over the Projects list, stated as
             * such. In the footer it had no label at all, so "md, html, txt…"
             * read as a property of the project rather than of the listing.
             */
            '    <section class="studio-settings-section">' +
            '      <h3>Files shown</h3>' +
            '      <p class="studio-settings-help">Which file types the Projects browser lists. Hidden files stay on disk ' +
            'and still open from a direct link; this only narrows what you browse.</p>' +
            '      <div class="studio-types-grid" data-page-types></div>' +
            '      <div class="studio-types-actions" data-page-types-actions></div>' +
            '    </section>' +

            /*
             * 3. Authoring modes — the Rich / Split / Raw switch, off by
             * default.
             *
             * It is a project setting rather than a per-document one for the same
             * reason the saving policy is: it decides how this project is
             * authored, so it should not be a decision anybody makes per file. Off
             * by default because Rich is what the product is for, and a switch
             * that is always on screen is an invitation to leave the rendered
             * document — so with the feature off, the switch is not rendered at
             * all rather than rendered disabled.
             */
            '    <section class="studio-settings-section">' +
            '      <h3>Authoring modes</h3>' +
            '      <p class="studio-settings-help">Documents are edited in Rich mode: the rendered document itself. ' +
            'Turn this on to add a Rich / Split / Raw switch above every Markdown document, for working on the ' +
            'Markdown source directly.</p>' +
            '      <div class="studio-settings-row">' +
            '        <button class="studio-switch" data-act="toggle-modes" aria-pressed="false" ' +
            'title="Authoring modes for this project">Source modes off</button>' +
            '        <span class="studio-settings-note" data-page-modes-note></span>' +
            '      </div>' +
            '    </section>' +

            /*
             * 4. How a proposed change is reviewed.
             *
             * Two styles, and the setting is a CHOICE rather than a toggle
             * because neither is the absence of the other — "tracked changes
             * off" does not describe the diff queue, it describes nothing. So
             * this is the one control on this page that is a pair of buttons:
             * both options are named, both are visible, and the pressed one is
             * the current state.
             *
             * A project setting for the same reason the two above it are: two
             * people reviewing the same proposal should be looking at the same
             * thing, and it travels with the branch.
             */
            '    <section class="studio-settings-section">' +
            '      <h3>Reviewing changes</h3>' +
            '      <p class="studio-settings-help">How a change proposed by an assistant is presented for you to accept ' +
            'or reject. Both styles decide the same changes and write the same result — they differ in what you are ' +
            'looking at while you decide.</p>' +
            '      <div class="studio-settings-row">' +
            '        <div class="studio-choice" role="group" aria-label="Change review style">' +
            '          <button class="studio-choice-btn" data-act="review-style" data-style="queue" ' +
            'aria-pressed="true">Diff queue</button>' +
            '          <button class="studio-choice-btn" data-act="review-style" data-style="inline" ' +
            'aria-pressed="false">Tracked changes</button>' +
            '        </div>' +
            '      </div>' +
            '      <p class="studio-settings-note" data-page-review-note></p>' +
            '    </section>' +

            /*
             * 5. The saving policy. The button, its data-act, and its exact
             * label text are carried over verbatim: the words are accurate and
             * content-editing-regression asserts on them. It LOOKS like the
             * control it always was (a switch, not muted body text) and says what
             * the setting will do to your edits — the missing consequence is why
             * it was once read as a status readout.
             */
            '    <section class="studio-settings-section">' +
            '      <h3>Saving</h3>' +
            '      <p class="studio-settings-help">How edits made in this project reach disk.</p>' +
            '      <div class="studio-settings-row">' +
            '        <button class="studio-switch" data-act="toggle-autosave" aria-pressed="true" ' +
            'title="Saving policy for this project">Autosave on</button>' +
            '        <span class="studio-settings-note" data-page-autosave-note></span>' +
            '      </div>' +
            '    </section>' +
            '  </div>' +
            '</div>';

        this.emptyEl = this.node.querySelector('[data-page-empty]');
        this.sectionsEl = this.node.querySelector('[data-page-sections]');
        this.nameEl = this.node.querySelector('[data-page-project-name]');
        this.locationEl = this.node.querySelector('[data-page-project-location]');
        this.typesEl = this.node.querySelector('[data-page-types]');
        this.typesActionsEl = this.node.querySelector('[data-page-types-actions]');
        this.disconnectEl = this.node.querySelector('[data-act="disconnect"]');
        this.autosaveEl = this.node.querySelector('[data-act="toggle-autosave"]');
        this.autosaveNoteEl = this.node.querySelector('[data-page-autosave-note]');
        this.modesEl = this.node.querySelector('[data-act="toggle-modes"]');
        this.reviewStyleEls = [...this.node.querySelectorAll('[data-act="review-style"]')];
        this.reviewNoteEl = this.node.querySelector('[data-page-review-note]');
        this.modesNoteEl = this.node.querySelector('[data-page-modes-note]');
        this.identityEl = this.node.querySelector('[data-act="display-name"]');
        this.identityAvatarEl = this.node.querySelector('[data-page-identity-avatar]');
        this.identityNoteEl = this.node.querySelector('[data-page-identity-note]');
        this.assistantsEl = this.node.querySelector('[data-page-assistants]');
        /*
         * Signing in is user-scoped, so it is wired here rather than in the
         * project refresh below: it must work on a page with no project
         * connected, which is exactly when somebody opens the IDE to talk to
         * an assistant for the first time.
         */
        if (ctx.container) {
            assistantAuthView.init(ctx.container, this.assistantsEl);
            void assistantAuthView.refresh();
        }

        this.node.addEventListener('click', event => this.onClick(event));
        this.node.addEventListener('change', event => this.onChange(event));
        /*
         * On `input`, not on `change`/blur. The name is what every comment this
         * user writes is stamped with, and a field that only commits on blur
         * leaves a user who types a name and immediately clicks into a document
         * still writing as "You". Persisting is a localStorage write, so there
         * is nothing to debounce for correctness.
         */
        this.identityEl.addEventListener('input', () => this.commitDisplayName());
        // Any other surface may rename this user (nothing does today; OIDC will).
        identity.onChanged(() => { if (!this.isDisposed) { this.renderIdentity(); } });

        // The workspace can gain or lose roots from anywhere (the Projects
        // panel's Connect, a Theia command, a restored layout), and every
        // setting below is keyed to the active root — so this page follows the
        // workspace rather than caching what it was opened with.
        try {
            this.disposables.push(this.workspaceService.onWorkspaceChanged(() => this.refresh()));
        } catch (e) {
            console.warn('[studio] could not follow workspace changes on the project page', e);
        }
        // And which of those roots is active: this page can sit open in a
        // background tab while the Projects panel switches project, and every
        // section below describes one specific project.
        this.disposables.push(activeProject.onChanged(() => { if (!this.isDisposed) { this.refresh(); } }));
        /*
         * fileTypeSettings.onChanged has no unsubscribe (it keeps a plain
         * listener array), and this widget is closable — so a close/reopen
         * cycle would otherwise leave a listener pointing at a disposed
         * widget. The isDisposed guard is what makes the stale listener inert
         * instead of a source of exceptions on every settings write.
         */
        fileTypeSettings.onChanged(() => { if (!this.isDisposed) { this.refresh(); } });
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.refresh();
    }

    /*
     * Settings can be changed elsewhere while this page sits in a background
     * tab (the Projects panel still owns Connect, and .studio/settings.json is
     * an ordinary committed file someone can edit by hand). Becoming visible is
     * exactly the moment the page has to be right.
     */
    onAfterShow(msg) {
        super.onAfterShow(msg);
        this.refresh();
    }

    onCloseRequest(msg) {
        clearTimeout(this.disconnectArmTimer);
        for (const disposable of this.disposables) {
            try { disposable.dispose(); } catch (e) { /* already gone */ }
        }
        this.disposables = [];
        super.onCloseRequest(msg);
        /*
         * Lumino's Widget.onCloseRequest DETACHES but never disposes — only
         * Theia's BaseWidget adds the dispose() call, and this widget extends
         * the raw Lumino class (there is no TypeScript build step here, so
         * there is no BaseWidget to inherit from cheaply).
         *
         * Without this line the closed page stays in ApplicationShell's
         * FocusTracker for the lifetime of the page, because the tracker only
         * drops a widget when its `disposed` signal fires. The reopen path then
         * finds that detached corpse by id, skips construction, and calls
         * activateWidget on a widget that belongs to no area — which does
         * nothing at all. That is the "close it once and it never opens again"
         * bug already fixed the same way in markdown-editor.js; a page reached
         * from a menu would hit it on the very first close.
         */
        this.dispose();
    }

    /*
     * Which project this page configures — asked of active-project.js, which is
     * where that fact lives now.
     *
     * The previous version read the Projects panel's `<select>` value out of the
     * DOM, with a comment admitting it was the narrowest way to AGREE with state
     * it had no accessor for. It also had to work when the panel was not
     * mounted, and fell back to roots[0] there. The status line derived the same
     * fact a third way and got it wrong ("I selected OFFICE but the bottom shows
     * theia-ws"), which is what turned three derivations into one store.
     */
    async activeRoot() {
        const roots = await this.workspaceService.roots;
        return activeProject.resolve(roots);
    }

    async refresh() {
        let root;
        try {
            root = await this.activeRoot();
        } catch (e) {
            console.warn('[studio] could not read the workspace roots for the project page', e);
        }
        if (this.isDisposed) { return; }

        // Before the early return below: the name is not project-scoped, so it
        // is rendered whether or not a project is connected.
        this.renderIdentity();

        // No project is a legitimate state, not an error: the page can be left
        // open while the last root is disconnected, including by its own
        // Disconnect button one line below.
        this.emptyEl.hidden = !!root;
        this.sectionsEl.hidden = !root;
        if (!root) {
            this.disarmDisconnect();
            return;
        }

        this.nameEl.textContent = root.resource.path.base;
        // Quiet monospace, because a filesystem path is something you compare
        // character by character (two checkouts of the same repository differ
        // only in the middle of the path) rather than read as prose.
        this.locationEl.textContent = root.resource.path.toString();
        this.renderTypes(root);
        this.renderModes(root);
        this.renderReviewStyle(root);
        this.renderAutosave(root);
    }

    // -- you -----------------------------------------------------------------

    /*
     * The name field's value is only written into the input when the user is NOT
     * typing in it. refresh() runs on every settings write and on every
     * workspace change, and this page is also refreshed by its own identity
     * listener — assigning `value` under a caret would move it to the end of the
     * field on the second keystroke. Same reason renderTypes syncs in place.
     */
    renderIdentity() {
        const me = identity.current();
        const focused = document.activeElement === this.identityEl;
        if (!focused) { this.identityEl.value = me.unnamed ? '' : me.name; }
        this.identityAvatarEl.innerHTML = avatarHtml(me);

        /*
         * Two things this note has to be honest about, because both are
         * surprising: the name is per machine while everything else on the page
         * is per project, and it is not verified. OIDC is what will make it
         * verified, and saying so here is cheaper than a user discovering later
         * that a name they trusted was self-declared.
         */
        this.identityNoteEl.textContent = me.unnamed
            ? 'Until you set this, your comments are signed "You" — which reads as nobody to the next person who opens the file. Stored on this machine only, not in the project.'
            : 'Stored on this machine only, not in the project, so it is not committed and does not travel to anyone who clones it. Self-declared for now; it will come from your organisation’s sign-in once that is connected.';
    }

    commitDisplayName() {
        identity.setDisplayName(this.identityEl.value);
        // The avatar and the note both change on the transition into and out of
        // the unnamed state, so they are re-rendered on every keystroke rather
        // than only on blur. renderIdentity leaves the focused input alone.
        this.renderIdentity();
    }

    // -- files shown ---------------------------------------------------------

    /*
     * Copied from the panel's renderTypes, with two deliberate changes.
     *
     * (1) Layout: a multi-column grid instead of a single 257px column. There
     * are ~21 known types; one column made this a scroll, which is the concrete
     * reason the filter was effectively unreachable.
     *
     * (2) In-place sync when the type list has not changed. Every checkbox
     * click writes .studio/settings.json, which fires onChanged, which calls
     * refresh() — rebuilding the DOM there would move focus off the checkbox
     * mid-interaction, so keyboard users could never toggle a second type.
     */
    renderTypes(root) {
        const key = root.resource.toString();
        const encodedKey = encodeURIComponent(key);
        const allowed = fileTypeSettings.forRoot(root.resource);
        const types = [...new Set([...KNOWN_TYPES, ...allowed])].sort();

        const existing = [...this.typesEl.querySelectorAll('input[data-act="type"]')];
        const sameList = existing.length === types.length && existing.every((input, index) =>
            input.getAttribute('data-type') === types[index] && input.getAttribute('data-root') === encodedKey);
        if (sameList) {
            existing.forEach(input => {
                const on = allowed.has(input.getAttribute('data-type'));
                input.checked = on;
                if (input.parentElement) { input.parentElement.classList.toggle('on', on); }
            });
            return;
        }

        this.typesEl.innerHTML = types.map(type =>
            '<label class="studio-type' + (allowed.has(type) ? ' on' : '') + '">' +
            '<input type="checkbox" data-act="type" data-root="' + encodedKey + '" data-type="' + escapeHtml(type) + '"' +
            (allowed.has(type) ? ' checked' : '') + '>' +
            '<span class="studio-type-name">.' + escapeHtml(type) + '</span></label>').join('');
        this.typesActionsEl.innerHTML =
            '<button class="studio-btn ghost" data-act="type-default" data-root="' + encodedKey + '">Reset to defaults</button>' +
            '<button class="studio-btn ghost" data-act="type-all" data-root="' + encodedKey + '">Show all types</button>' +
            '<span class="studio-settings-note">Defaults are the document types this product edits: ' +
            escapeHtml(DEFAULT_ON.map(type => '.' + type).join(', ')) + '.</span>';
    }

    rootUri(encoded) {
        const { URI } = require('@theia/core/lib/common/uri');
        return new URI(decodeURIComponent(encoded));
    }

    async toggleType(encoded, type, enabled) {
        const root = this.rootUri(encoded);
        const allowed = new Set(fileTypeSettings.forRoot(root));
        if (enabled) { allowed.add(type); } else { allowed.delete(type); }
        await fileTypeSettings.setForRoot(root, [...allowed]);
    }

    // -- authoring modes -----------------------------------------------------

    /*
     * The same shape as the saving policy below, deliberately: two project
     * policies, one control language, and both re-read from the settings store
     * after the write rather than updated optimistically — every open document
     * reads the same store when it renders its topbar, so they agree without an
     * event channel between widgets.
     */
    async toggleModes() {
        const root = await this.activeRoot();
        if (!root) { return; }
        const next = !fileTypeSettings.authoringModesFor(root.resource);
        try {
            await fileTypeSettings.setAuthoringModes(root.resource, next);
        } catch (e) {
            console.error('[studio] could not persist the authoring-modes policy', e);
        }
        this.renderModes(root);
    }

    renderModes(root) {
        if (!this.modesEl) { return; }
        const on = root ? fileTypeSettings.authoringModesFor(root.resource) : false;
        this.modesEl.textContent = on ? 'Source modes on' : 'Source modes off';
        this.modesEl.setAttribute('aria-pressed', String(on));
        this.modesNoteEl.textContent = on
            ? 'A Rich / Split / Raw switch appears above every Markdown document.'
            : 'Markdown documents are edited in Rich mode, with no mode switch.';
    }

    // -- review style --------------------------------------------------------

    /*
     * Set, not toggle: the control names both options, so a click means "this
     * one", and a click on the option that is already current is a no-op rather
     * than a switch back. Writing the value the user already has would still be
     * harmless — the write is idempotent — but it would fire onChanged and make
     * every open document re-render for nothing.
     */
    async setReviewStyle(style) {
        const root = await this.activeRoot();
        if (!root) { return; }
        if (fileTypeSettings.changeReviewFor(root.resource) === style) { return; }
        try {
            await fileTypeSettings.setChangeReview(root.resource, style);
        } catch (e) {
            console.error('[studio] could not persist the change-review style', e);
        }
        this.renderReviewStyle(root);
    }

    renderReviewStyle(root) {
        if (!this.reviewStyleEls || !this.reviewStyleEls.length) { return; }
        const style = root ? fileTypeSettings.changeReviewFor(root.resource) : 'queue';
        this.reviewStyleEls.forEach(button =>
            button.setAttribute('aria-pressed', String(button.getAttribute('data-style') === style)));
        this.reviewNoteEl.textContent = style === 'inline'
            ? 'The document shows the change in place — deletions struck through, insertions underlined — and each ' +
              'change gets a card beside it saying who proposed it and what it does. Closest to Word or Google Docs. ' +
              'Documents this product cannot round-trip losslessly stay on the diff queue.'
            : 'The document is held at its reviewed state and the change is listed beside it as a patch, with line ' +
              'numbers and the surrounding lines for context. Best when the exact edit matters more than how it reads.';
    }

    // -- saving policy -------------------------------------------------------

    /*
     * Moved here from the Projects footer (and to the footer, before that, from
     * the document topbar). fileTypeSettings.onChanged is wired to refresh(),
     * so the label follows the write rather than being updated optimistically,
     * and every open document re-reads the policy in its own setSaveState — so
     * they all agree without an event channel between widgets.
     */
    async toggleAutosave() {
        const root = await this.activeRoot();
        if (!root) { return; }
        const next = !fileTypeSettings.autosaveFor(root.resource);
        try {
            await fileTypeSettings.setAutosave(root.resource, next);
        } catch (e) {
            console.error('[studio] could not persist the autosave policy', e);
        }
        this.renderAutosave(root);
    }

    /*
     * The exact strings "Autosave on" / "Autosave off" are load-bearing:
     * content-editing-regression asserts on them to prove the policy switches
     * and persists per project. They are also simply accurate, so nothing here
     * needs to invent new words — the sentence beside the switch carries the
     * consequence that the two-word label cannot.
     */
    renderAutosave(root) {
        if (!this.autosaveEl) { return; }
        const on = root ? fileTypeSettings.autosaveFor(root.resource) : true;
        this.autosaveEl.textContent = on ? 'Autosave on' : 'Autosave off';
        this.autosaveEl.setAttribute('aria-pressed', String(on));
        this.autosaveNoteEl.textContent = on
            ? 'Changes are written to disk as you type.'
            : 'Changes are held until you save with Cmd+S.';
    }

    // -- disconnect ----------------------------------------------------------

    /*
     * Two-click confirm, lifted verbatim in behaviour from the panel's
     * armDisconnect/disarmDisconnect: the button turns solid danger on the
     * first click and reverts on a timeout or on any other click in the page,
     * so disconnecting costs a deliberate second click rather than a blocking
     * window.confirm(). shell-chrome-regression asserts on the `confirm` class
     * after the first click, so the class name is part of the contract.
     */
    armDisconnect() {
        clearTimeout(this.disconnectArmTimer);
        this.armedDisconnect = true;
        this.disconnectEl.classList.add('confirm');
        this.disconnectEl.textContent = 'Click again to disconnect';
        this.disconnectArmTimer = setTimeout(() => this.disarmDisconnect(), CONFIRM_DISARM_MS);
    }

    disarmDisconnect() {
        clearTimeout(this.disconnectArmTimer);
        this.armedDisconnect = false;
        this.disconnectEl.classList.remove('confirm');
        this.disconnectEl.textContent = 'Disconnect project';
    }

    async disconnect() {
        const root = await this.activeRoot();
        this.disarmDisconnect();
        if (!root) { return; }
        const { URI } = require('@theia/core/lib/common/uri');
        await this.workspaceService.removeRoots([new URI(root.resource.toString())]);
        await this.refresh();
    }

    // -- events --------------------------------------------------------------

    onChange(event) {
        const target = event.target;
        if (target.matches('[data-act="type"]')) {
            this.toggleType(target.getAttribute('data-root'), target.getAttribute('data-type'), target.checked);
        }
    }

    onClick(event) {
        const target = event.target.closest('[data-act]');
        if (target && target.getAttribute('data-act') === 'disconnect') {
            if (this.armedDisconnect) { this.disconnect(); } else { this.armDisconnect(); }
            return;
        }
        // Any other interaction is evidence the destructive click was not the
        // user's current intent.
        if (this.armedDisconnect) { this.disarmDisconnect(); }
        if (!target) { return; }
        const act = target.getAttribute('data-act');
        if (act === 'type-default') {
            fileTypeSettings.setForRoot(this.rootUri(target.getAttribute('data-root')), DEFAULT_ON);
        } else if (act === 'type-all') {
            fileTypeSettings.setForRoot(this.rootUri(target.getAttribute('data-root')), KNOWN_TYPES);
        } else if (act === 'toggle-autosave') {
            this.toggleAutosave();
        } else if (act === 'toggle-modes') {
            this.toggleModes();
        } else if (act === 'review-style') {
            this.setReviewStyle(target.getAttribute('data-style'));
        }
    }
}

/*
 * Tokens only, and only the documented ones. Two rules this sheet obeys
 * deliberately, because both were broken before:
 *
 *   - --studio-edge is the SHELL seam (panel against panel, rail against
 *     content). Every divider INSIDE this page uses --studio-line, which is why
 *     nothing here reads as heavily as the boundary around it.
 *   - The palette is monochrome plus one accent (--studio-amber) plus one
 *     danger (--studio-danger). No new hues are introduced, so the accent still
 *     means "this is interactive or current" wherever it appears.
 */
const PROJECT_PAGE_CSS = ASSISTANT_AUTH_CSS + `
.studio-project-page { height:100%; overflow:auto; background:var(--studio-bg, #16171c); color:var(--studio-text, #f1eee7); }
/* A centred, measured column. A settings page that stretches to a 1400px dock
   puts the label and its control at opposite ends of the screen. */
.studio-page-column { max-width:720px; margin:0 auto; padding:34px 28px 56px; }
.studio-page-head h2 { margin:0; font:600 20px/1.25 inherit; letter-spacing:-.01em; }
.studio-page-lede { margin:8px 0 0; max-width:60ch; color:var(--studio-muted, #9298a8); font:400 12.5px/1.6 inherit; }
.studio-page-lede code { font:400 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--studio-text, #f1eee7); }
.studio-page-empty { margin-top:26px; padding-top:20px; border-top:1px solid var(--studio-line, #e1e4e8); color:var(--studio-muted, #9298a8); font:400 13px/1.6 inherit; }

/* Sections are told apart by a hairline and by tone. Boxing each one made
   three settings read as three unrelated apps in a previous round. */
.studio-settings-section { padding:26px 0 0; margin-top:26px; border-top:1px solid var(--studio-line, #e1e4e8); }
.studio-settings-section:first-child { margin-top:22px; }
.studio-settings-section h3 { margin:0; font:600 13px/1.3 inherit; letter-spacing:.01em; }
.studio-settings-help { margin:6px 0 0; max-width:62ch; color:var(--studio-muted, #9298a8); font:400 12px/1.6 inherit; }
.studio-settings-row { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-top:16px; }
.studio-settings-note { flex:1 1 20ch; min-width:0; color:var(--studio-muted, #9298a8); font:400 11.5px/1.55 inherit; }

/* You. The disc beside the field is the same one the comment surfaces draw, so
   what you are setting and what the next person sees are the same object rather
   than two things that have to be kept in agreement by hand. The note sits on
   its own line, not in the row: it is two sentences, and flex-wrapping it beside
   a 240px field produced a one-word-per-line column. */
.studio-settings-you .studio-settings-row { align-items:center; }
.studio-settings-you .studio-settings-note { flex:none; margin:10px 0 0; max-width:62ch; }
.studio-input {
  flex:0 1 240px; min-width:0; padding:7px 10px;
  border:1px solid var(--studio-line, #30333d); border-radius:6px;
  background:var(--studio-surface, #16171c); color:var(--studio-text, #f1eee7);
  font:400 13px/1.4 inherit;
}
.studio-input::placeholder { color:var(--studio-muted, #9298a8); }
.studio-input:hover { border-color:color-mix(in srgb, var(--studio-amber, #d59b3b) 45%, var(--studio-line, #30333d)); }
.studio-input:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:1px; border-color:var(--studio-amber, #d59b3b); }

/* Identity: name as the heading it is, path as something you compare rather
   than read, on a sunken tone instead of inside another bordered box. */
.studio-project-identity { margin-top:14px; padding:12px 14px; border-radius:var(--studio-radius, 8px); background:var(--studio-surface-sunken, #f0f2f5); }
.studio-project-title { font:600 15px/1.3 inherit; }
.studio-project-location { margin-top:4px; color:var(--studio-muted, #9298a8); font:400 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; }

/* The filter, finally wide enough to scan. auto-fill rather than a fixed count
   so a narrow dock degrades to fewer columns instead of scrolling sideways. */
.studio-types-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px, 1fr)); gap:6px; margin-top:16px; }
.studio-type { display:flex; align-items:center; gap:7px; min-width:0; padding:7px 9px; border:1px solid var(--studio-line, #30333d); border-radius:6px; background:var(--studio-surface, #16171c); color:var(--studio-muted, #9298a8); cursor:pointer; font:400 12px/1 inherit; }
.studio-type:hover { border-color:var(--studio-amber, #d59b3b); color:var(--studio-text, #f1eee7); }
.studio-type.on { border-color:color-mix(in srgb, var(--studio-amber, #d59b3b) 45%, var(--studio-line, #30333d)); background:var(--studio-surface-raised, #202127); color:var(--studio-text, #f1eee7); }
.studio-type input { flex:none; margin:0; accent-color:var(--studio-amber, #d59b3b); }
.studio-type input:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:2px; }
.studio-type-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
.studio-types-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:12px; }

/* The saving policy, now shaped like the toggle it always was. The track is a
   pseudo-element on purpose: renderAutosave sets textContent, which would wipe
   any real child node, and the label text is pinned by a regression suite. */
.studio-switch { position:relative; display:inline-flex; align-items:center; gap:9px; padding:6px 13px 6px 9px; border:1px solid var(--studio-line, #30333d); border-radius:999px; background:var(--studio-surface-raised, #202127); color:var(--studio-text, #f1eee7); cursor:pointer; font:600 12px/1.2 inherit; }
.studio-switch::before { content:""; flex:none; width:26px; height:15px; border-radius:999px; background:var(--studio-line, #30333d); transition:background-color 140ms ease; }
.studio-switch::after { content:""; position:absolute; left:11px; top:50%; width:11px; height:11px; margin-top:-5.5px; border-radius:999px; background:var(--studio-muted, #9298a8); transition:transform 140ms cubic-bezier(0.23,1,0.32,1), background-color 140ms ease; }
.studio-switch[aria-pressed="true"] { border-color:color-mix(in srgb, var(--studio-amber, #d59b3b) 55%, var(--studio-line, #30333d)); }
.studio-switch[aria-pressed="true"]::before { background:var(--studio-amber, #d59b3b); }
/* --studio-bg on amber is the pairing the primary button already uses, so the
   knob stays readable in both themes without a new token. */
.studio-switch[aria-pressed="true"]::after { transform:translateX(11px); background:var(--studio-bg, #16171c); }
.studio-switch:hover { border-color:var(--studio-amber, #d59b3b); }
.studio-switch:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:2px; }

/* A two-option choice, not a toggle. One track, both labels legible, and the
   pressed half filled — the same amber-on-bg pairing the switch knob and the
   primary button use, so nothing new has to be learned to read it. Segments
   share a single border rather than each having one, so the pair reads as one
   control with two states and not as two independent buttons. */
.studio-choice { display:inline-flex; border:1px solid var(--studio-line, #30333d); border-radius:999px; padding:2px; background:var(--studio-surface-raised, #202127); }
.studio-choice-btn { border:0; border-radius:999px; padding:6px 14px; background:transparent; color:var(--studio-muted, #9298a8); cursor:pointer; font:600 12px/1.2 inherit; }
.studio-choice-btn:hover { color:var(--studio-text, #f1eee7); }
.studio-choice-btn[aria-pressed="true"] { background:var(--studio-amber, #d59b3b); color:var(--studio-bg, #16171c); }
.studio-choice-btn:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:2px; }
/* This note is a full sentence about a consequence, so it sits under the
   control on its own line rather than competing with it for the row. */
.studio-settings-section .studio-settings-note[data-page-review-note] { flex:none; margin:10px 0 0; max-width:64ch; }

/* Danger reads as danger only once armed: an outline button first, filled on
   the confirming click, so the loud state is the one that actually removes. */
.studio-project-page .studio-btn.danger { border-color:color-mix(in srgb, var(--studio-danger, #e5534b) 45%, var(--studio-line, #30333d)); background:transparent; color:var(--studio-danger, #e5534b); }
.studio-project-page .studio-btn.danger:hover { border-color:var(--studio-danger, #e5534b); background:color-mix(in srgb, var(--studio-danger, #e5534b) 12%, transparent); }
.studio-project-page .studio-btn.danger.confirm { background:var(--studio-danger, #e5534b); border-color:var(--studio-danger, #e5534b); color:#fff; }
.studio-project-page .studio-btn:focus-visible { outline:2px solid var(--studio-amber, #d59b3b); outline-offset:2px; }
`;

module.exports = { ProjectPageWidget, PROJECT_PAGE_CSS };
