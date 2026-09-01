/*
 * The Studio table editor. CSV, TSV, and the two relatives, as a grid.
 *
 * Wins its files through OpenHandler priority exactly as the Markdown editor
 * and the HTML viewer do, so Monaco keeps every other file type. It is the
 * third document surface in this product and it is deliberately built out of
 * the same parts as the other two rather than as its own world:
 *
 *   - the SAME topbar (.studio-doc-topbar), status vocabulary and Save button;
 *   - the SAME Rich / Split / Raw switch, gated by the SAME project setting
 *     (fileTypeSettings.authoringModes) — a project that has not asked for
 *     source editing gets the grid and nothing else, and one that has gets the
 *     delimited text beside it;
 *   - the SAME saving policy (fileTypeSettings.autosave), the same mtime
 *     conflict guard, and the same "formatting will normalise on save" note.
 *
 * WHY THEIA'S OWN EDITOR IS NOT USED. There is no table editor in Theia or in
 * VS Code to adopt — a .csv opens in Monaco as text, which is exactly what the
 * user reported wanting to get away from. What Theia does provide, and what is
 * used here, is the open-handler priority mechanism and the file service.
 *
 * WHAT "RICH" MEANS FOR A TABLE. The grid IS the rendered document, in the same
 * sense that the ProseMirror surface is the rendered document for Markdown: the
 * thing you edit looks like the thing the file means. Raw shows the delimited
 * text. Split shows both, and syncs from whichever surface has the caret — same
 * sourceOfTruth rule, same debounce, as markdown-editor.js.
 *
 * THE FILE IS THE SOURCE OF TRUTH, and the codec (table-data.js) is what makes
 * that more than a slogan: line endings, the trailing newline, the delimiter,
 * quoting style and per-row raggedness all survive a load-edit-save cycle, so a
 * one-cell change produces a one-line diff. Where that cannot be guaranteed the
 * document says so in a banner instead of quietly reformatting.
 *
 * TWO THINGS DELIBERATELY NOT HERE.
 *
 *   No comments on cells. The comment sidecar anchors to quoted text (Markdown)
 *   or to a child-index path (HTML); a cell would have to anchor to a
 *   coordinate, and coordinates move the moment somebody inserts a row above.
 *   Doing it properly needs a stable per-row identity that a CSV file has no
 *   room to carry, so this surface's topbar cluster disables Comments and says
 *   why, rather than offering anchors that silently re-point.
 *
 *   No sorting or filtering. Both are views over data, and this surface edits a
 *   file in place: a sort that reached disk would reorder somebody's file, and a
 *   sort that did not would put the grid and the text out of correspondence in a
 *   product whose whole claim is that they match.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { fileTypeSettings } = require('./file-type-settings');
const { showLoading, loaderMarkup } = require('./loader');
const { statusLine } = require('./status-line');
const { slotStrip, renderDocCluster } = require('./slot-strip');
const {
    revealAssistant, collapseRightPanel, assistantFromTabTitle, currentAssistant, SLOT_GRACE_MS
} = require('./ai-context');
const {
    DELIMITERS, labelFor, detectDialect, parse, serialize,
    columnCount, setCell, insertRow, insertColumn, deleteRow, deleteColumn, parseClipboardGrid
} = require('./table-data');
const { FileChangeType } = require('@theia/filesystem/lib/common/files');

// Same three keys and the same labels as the Markdown editor's switch, because
// it is the same control answering the same question. Only the hints differ,
// and only because "the rendered document" is a grid here.
const MODES = [
    { key: 'rich', label: 'Rich', hint: 'Edit the table as a grid' },
    { key: 'split', label: 'Split', hint: 'Delimited text and the grid side by side' },
    { key: 'raw', label: 'Raw', hint: 'Edit the delimited text' }
];

const AUTOSAVE_DELAY_MS = 900;
const SPLIT_SYNC_MS = 400;
const EXTERNAL_POLL_MS = 2500;

/*
 * How many rows the grid puts in the DOM at once.
 *
 * A CSV is the one document type in this product that is routinely enormous —
 * a 200k-row export is an ordinary thing to be handed — and a <table> with
 * 200k rows in it does not render, it hangs the window. So the MODEL holds
 * every row (saving writes all of them, and the row count in the topbar counts
 * all of them) and the grid renders a window onto it, which the user extends.
 *
 * Not virtualised scrolling, deliberately: that means owning scroll maths, and
 * getting it wrong shows the user the wrong row of their data, which is worse
 * than a button. This way the DOM either has your row in it or plainly does
 * not.
 */
const ROW_CHUNK = 500;

// --- cell text --------------------------------------------------------------

/*
 * A contenteditable cell's value.
 *
 * textContent alone is wrong: a hard newline inside a cell can be a <br> rather
 * than a text node, depending on how it got there (typed with Alt+Enter, or
 * pasted), and textContent renders a <br> as nothing — so a two-line cell would
 * silently lose its break on the next keystroke. innerText would handle it but
 * depends on layout, which makes it both slow and undefined for a cell that is
 * scrolled out of view.
 */
function cellText(el) {
    let out = '';
    for (const node of el.childNodes) {
        if (node.nodeType === 3) { out += node.nodeValue; }
        else if (node.nodeName === 'BR') { out += '\n'; }
        else { out += node.textContent || ''; }
    }
    return out;
}

function escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeLabel(iso) {
    const date = iso ? new Date(iso) : new Date();
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

class TableEditorWidget extends Widget {

    constructor(uri, ctx) {
        super();
        this.uri = uri;
        this.fileService = ctx.fileService;
        this.commandRegistry = ctx.commandRegistry;
        this.messageService = ctx.messageService;
        this.shell = ctx.shell;

        this.id = 'studio-table:' + uri.toString();
        this.title.label = uri.path.base;
        this.title.caption = uri.path.toString();
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-table';
        this.addClass('studio-table');

        this.rows = [];
        this.dialect = { delimiter: ',', eol: '\n', trailingNewline: true, quoteStyle: 'minimal' };
        this.mode = 'rich';
        // Which surface last received input. In Split both are live, so the text
        // has to come from whichever the user is actually typing into. Same rule
        // and same field name as markdown-editor.js.
        this.sourceOfTruth = 'rich';
        this.saveState = 'clean';
        this.autosave = true;
        this.readOnly = false;
        this.readOnlyReason = undefined;
        this.willReformat = false;
        this.shown = ROW_CHUNK;
        this.focusedCell = undefined;      // {row, col} — survives a re-render
        // Deleting a row or a column is a two-click confirm, because there is no
        // undo stack on this surface and a mis-click would take data with it.
        this.armedOp = undefined;
        this.disposables = [];

        // Assistant slot bookkeeping, identical to the HTML viewer's — see
        // watchRightPanel() for why the grace window exists.
        this.assistant = undefined;
        this.slotChosen = false;
        this.openedAt = Date.now();

        this.node.innerHTML =
            '<div class="studio-doc-topbar">' +
            '  <div class="studio-seg" data-seg="mode"></div>' +
            /*
             * The structural operations, as four plain buttons rather than a
             * context menu on the grid.
             *
             * They act on the cell that has the caret, which is the one thing a
             * grid always has and a context menu has to be opened to establish.
             * A menu would also have to be built, positioned and dismissed —
             * three more places for the floating-toolbar bugs this product has
             * already paid for once (see repositionFloating in
             * markdown-editor.js).
             */
            '  <div class="studio-table-ops">' +
            '    <button class="studio-btn" data-tact="row-insert" title="Insert a row below the current one">Row +</button>' +
            '    <button class="studio-btn" data-tact="row-delete" title="Delete the current row">Row −</button>' +
            '    <button class="studio-btn" data-tact="col-insert" title="Insert a column right of the current one">Column +</button>' +
            '    <button class="studio-btn" data-tact="col-delete" title="Delete the current column">Column −</button>' +
            '  </div>' +
            '  <span class="studio-doc-spacer"></span>' +
            /*
             * The delimiter, as a control and not a label.
             *
             * It is detected (table-data.js detectDialect), and detection can be
             * wrong — a semicolon-separated file called .csv is the common case,
             * and the sniffer only overrules the extension when it is clearly
             * outvoted. A wrong guess with no control is a file that renders as
             * one wide column with no way back; a wrong guess with a picker is
             * two clicks. It is not gated behind authoring modes because it is a
             * property of the FILE, not a way of editing it.
             */
            '  <label class="studio-table-dialect">' +
            '    <select data-tact="delimiter"></select>' +
            '  </label>' +
            '  <span class="studio-table-shape"></span>' +
            '  <span class="studio-doc-busy" hidden>' + loaderMarkup({ size: 13, decorative: true }) + '</span>' +
            '  <span class="studio-doc-status">Loading…</span>' +
            '  <button class="studio-btn primary" data-tact="save-now" hidden>Save</button>' +
            /*
             * The same cluster as the other two surfaces, and it is HERE rather
             * than absent on purpose. All three of this grid's document entries
             * are disabled -- a CSV has no text anchor to comment on, no diff
             * pipeline and no history, so slotCapabilities() is the two
             * assistants alone -- which makes drawing no cluster at all the
             * cheap option. That is the vanishing-entry defect the fixed
             * membership rule exists to prevent, one level up: a surface where
             * the control is simply missing teaches that the product is
             * inconsistent, while three dimmed tiles that each say why teach
             * what this surface is.
             */
            '  <span class="studio-slot-divider" aria-hidden="true"></span>' +
            '  <div class="studio-slot-cluster" data-slot-cluster></div>' +
            '</div>' +
            // Same three-level body as the Markdown editor, so mode-rich /
            // mode-split / mode-raw in editor-css.js govern this surface too and
            // there is no second copy of the layout to keep in step. The scroll
            // host keeps .studio-doc-scroll for the same reason.
            '<div class="studio-doc-body">' +
            '  <div class="studio-doc-main">' +
            '    <div class="studio-doc-banners"></div>' +
            '    <div class="studio-doc-panes">' +
            '      <div class="studio-source-pane"><textarea class="studio-source" spellcheck="false"></textarea></div>' +
            '      <div class="studio-doc-scroll studio-table-scroll">' +
            '        <table class="studio-table-grid"><thead></thead><tbody></tbody></table>' +
            '        <div class="studio-table-more"></div>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '</div>';

        this.statusEl = this.node.querySelector('.studio-doc-status');
        this.slotClusterEl = this.node.querySelector('[data-slot-cluster]');
        this.busyEl = this.node.querySelector('.studio-doc-busy');
        this.saveBtn = this.node.querySelector('[data-tact="save-now"]');
        this.bannersEl = this.node.querySelector('.studio-doc-banners');
        this.bodyEl = this.node.querySelector('.studio-doc-body');
        this.panesEl = this.node.querySelector('.studio-doc-panes');
        this.sourceEl = this.node.querySelector('.studio-source');
        this.scrollEl = this.node.querySelector('.studio-table-scroll');
        this.gridEl = this.node.querySelector('.studio-table-grid');
        this.headEl = this.gridEl.querySelector('thead');
        this.bodyRowsEl = this.gridEl.querySelector('tbody');
        this.moreEl = this.node.querySelector('.studio-table-more');
        this.opsEl = this.node.querySelector('.studio-table-ops');
        this.shapeEl = this.node.querySelector('.studio-table-shape');
        this.delimiterEl = this.node.querySelector('[data-tact="delimiter"]');

        this.delimiterEl.innerHTML = DELIMITERS.map(d =>
            '<option value="' + escapeHtml(d.value) + '">' + escapeHtml(d.label) + '</option>').join('');
        this.delimiterEl.addEventListener('change', () => this.setDelimiter(this.delimiterEl.value));

        this.renderSegmented();

        /*
         * Authoring modes can be switched off from the Project page while this
         * document sits open in Split or Raw, and the document then has to come
         * back to the grid — otherwise it is left editing source on a surface
         * with no control to leave it by. Same handler, same isDisposed guard
         * (fileTypeSettings keeps a plain listener array with no unsubscribe),
         * and the same reason as markdown-editor.js.
         */
        fileTypeSettings.onChanged(() => {
            if (this.isDisposed) { return; }
            if (!fileTypeSettings.authoringModesForFile(this.uri) && this.mode !== 'rich') { this.setMode('rich'); }
            else { this.renderSegmented(); }
        });

        this.node.addEventListener('click', e => this.onToolbarClick(e));
        this.gridEl.addEventListener('input', e => this.onCellInput(e));
        this.gridEl.addEventListener('keydown', e => this.onCellKeyDown(e));
        this.gridEl.addEventListener('paste', e => this.onCellPaste(e));
        this.gridEl.addEventListener('focusin', e => this.onCellFocus(e));

        this.sourceEl.addEventListener('input', () => this.onSourceInput());
        this.sourceEl.addEventListener('focus', () => { this.sourceOfTruth = 'raw'; });
        this.sourceEl.addEventListener('keydown', e => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                this.save();
            }
        });

        /*
         * Cmd/Ctrl+S at the document level, capture phase — not on this widget's
         * node. Theia's keybinding service listens on the document and stops
         * propagation when it handles a binding, so an event never descends to a
         * listener on the widget. The activeElement containment check is what
         * keeps one open document from answering for another. Same mechanism,
         * and the same reasoning, as markdown-editor.js.
         */
        this.keyHandler = e => {
            if (!this.node.isConnected || !this.node.contains(document.activeElement)) { return; }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.save();
            }
        };
        document.addEventListener('keydown', this.keyHandler, true);
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        if (!this.loaded) { this.loaded = true; this.init(); this.watchRightPanel(); }
    }

    onCloseRequest(msg) {
        if (this.keyHandler) { document.removeEventListener('keydown', this.keyHandler, true); }
        clearTimeout(this.saveTimer);
        clearTimeout(this.splitTimer);
        clearInterval(this.pollTimer);
        for (const disposable of this.disposables) {
            try { disposable.dispose(); } catch (e) { /* already gone */ }
        }
        this.disposables = [];
        if (this.slotWatcher && this.shell && this.shell.rightPanelHandler) {
            this.shell.rightPanelHandler.tabBar.currentChanged.disconnect(this.slotWatcher);
            this.slotWatcher = undefined;
        }
        super.onCloseRequest(msg);
        // Raw Lumino Widget.onCloseRequest detaches without disposing, so the
        // shell's tracker keeps the closed widget and the open handler finds it
        // by id instead of building a new one — the file then cannot be
        // reopened. Same line, same reason, as the other two document widgets.
        this.dispose();
    }

    // -- loading -------------------------------------------------------------

    async init() {
        const done = showLoading(
            this.panesEl,
            'Opening ' + this.uri.path.base + '…',
            { className: 'studio-doc-loading' }
        );
        try {
            await this.loadDocument();
        } catch (e) {
            console.error('[studio] could not open', this.uri.toString(), e);
            this.setSaveState('error');
            this.bannersEl.innerHTML = '<div class="studio-doc-banner block">Could not read this file.</div>';
        } finally {
            done();
        }
    }

    async loadDocument() {
        const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
        this.knownMtime = stat.mtime;
        const content = await this.fileService.read(this.uri);
        this.setFromDisk(content.value);

        this.autosave = fileTypeSettings.autosaveForFile(this.uri);
        this.applyMode();
        this.renderGrid();
        this.renderBanners();
        this.watchFile();

        /*
         * Armed a tick late, exactly as the Markdown editor arms its save path:
         * opening a file must never write to it, and the render above can settle
         * asynchronously. Until then markDirty() is inert.
         */
        setTimeout(() => { this.armed = true; }, 0);
        this.setSaveState(this.readOnly ? 'read-only' : 'clean');
    }

    /**
     * Adopt the bytes on disk as the document, and work out what saving them
     * back would produce.
     *
     * The re-serialisation here is the whole fidelity story. If the round trip
     * is byte-exact, a later save of an unchanged cell is a no-op and a save of
     * one changed cell is a one-line diff. If it is not — the file quotes a
     * field that does not need it, or uses a bare quote mid-field — the document
     * still opens and still edits, and the banner says formatting will normalise
     * so the reformat is a thing the user was told about rather than found in
     * `git diff` afterwards.
     */
    setFromDisk(text) {
        const detected = detectDialect(this.uri.path.base, text);
        const parsed = parse(text, detected.delimiter);
        this.rows = parsed.rows;
        this.dialect = { ...detected, quoteStyle: parsed.quoteStyle };
        this.lastSavedText = text;
        this.sourceEl.value = text;

        /*
         * A file with an unterminated quote is read-only, not broken.
         *
         * Everything after the stray quote has been swallowed into one cell, so
         * the grid is not a faithful picture of the file and a save would commit
         * that misreading. Read-only with the reason stated is the honest
         * position — and "Edit anyway" is still offered, because normalising the
         * quoting IS the repair, and the git diff is the safety net. Same
         * escape hatch, same argument, as the Markdown editor's unlock().
         */
        this.readOnly = !!parsed.malformed;
        this.readOnlyReason = parsed.malformed || undefined;
        this.willReformat = !this.readOnly && serialize(this.rows, this.dialect) !== text;

        this.sourceEl.readOnly = this.readOnly;
        this.delimiterEl.value = this.dialect.delimiter;
        this.shown = ROW_CHUNK;
    }

    // -- modes ---------------------------------------------------------------

    /*
     * The switch is a PROJECT FEATURE and it is off by default — the same
     * setting, read the same way, as the Markdown editor's.
     *
     * That is the point rather than a coincidence: `authoringModes` means "this
     * project edits source as well as documents", and a project that has said
     * so has said it about its documents, not about one file type. So enabling
     * it on the Project page adds the switch above Markdown documents AND above
     * tables, and leaving it off gives both surfaces exactly one way to edit.
     *
     * Re-read on every render rather than cached at open, because this widget
     * does not own the control.
     */
    renderSegmented() {
        const seg = this.node.querySelector('[data-seg="mode"]');
        this.authoringModes = fileTypeSettings.authoringModesForFile(this.uri);
        // Emptied as well as hidden: a hidden container still holding three
        // buttons keeps them in the DOM and in the tab order.
        seg.hidden = !this.authoringModes;
        seg.innerHTML = !this.authoringModes ? '' : MODES.map(m =>
            '<button class="studio-seg-btn' + (m.key === this.mode ? ' on' : '') + '" data-studio-mode="' + m.key +
            '" title="' + m.hint + '" aria-pressed="' + (m.key === this.mode) + '">' + m.label + '</button>').join('');
        this.renderSlot();
    }

    /**
     * Move the document between surfaces, through DELIMITED TEXT in both
     * directions — so a mode switch can never introduce a difference the file
     * would not have. Same guarantee, same mechanism, as the Markdown editor.
     */
    setMode(mode) {
        if (mode === this.mode) { return; }
        // Rich is always available; the other two exist only where the project
        // asked for them. Enforced here and not only in the render, so no caller
        // can put a document into a mode its project does not offer.
        if (mode !== 'rich' && !fileTypeSettings.authoringModesForFile(this.uri)) { return; }
        const text = this.currentText();
        this.mode = mode;
        if (mode === 'raw' || mode === 'split') { this.sourceEl.value = text; }
        if (mode === 'rich' || mode === 'split') { this.adoptText(text); this.renderGrid(); }
        this.sourceOfTruth = mode === 'raw' ? 'raw' : 'rich';
        this.applyMode();
        if (mode === 'raw' || mode === 'split') { setTimeout(() => this.sourceEl.focus(), 0); }
        else { setTimeout(() => this.focusCell(this.focusedCell || { row: 0, col: 0 }), 0); }
    }

    applyMode() {
        this.bodyEl.classList.toggle('mode-rich', this.mode === 'rich');
        this.bodyEl.classList.toggle('mode-split', this.mode === 'split');
        this.bodyEl.classList.toggle('mode-raw', this.mode === 'raw');
        this.renderSegmented();
        // The four structural buttons act on the cell with the caret, and in Raw
        // there is no grid to have one. Called from here as well as from
        // renderGrid() because a mode change is exactly the case renderGrid()
        // does not cover: measured — the buttons stayed on screen in Raw, doing
        // nothing, which is worse than either showing or hiding them honestly.
        this.updateOps();
    }

    /** The document as bytes, from whichever surface the user is driving. */
    currentText() {
        if (this.mode === 'raw') { return this.sourceEl.value; }
        if (this.mode === 'split' && this.sourceOfTruth === 'raw') { return this.sourceEl.value; }
        return serialize(this.rows, this.dialect);
    }

    /** Re-parse delimited text into the grid model, keeping the dialect. */
    adoptText(text) {
        const parsed = parse(text, this.dialect.delimiter);
        this.rows = parsed.rows;
    }

    /*
     * Re-read the file under a different delimiter.
     *
     * Worth noting what this does NOT do: on its own it changes no bytes.
     * Re-splitting `a,b` on tabs gives one cell holding `a,b`, and writing that
     * cell back with a tab delimiter needs no quoting, so the text is identical
     * — the delimiter only reaches disk once a cell is actually edited. So
     * correcting a wrong guess is free, and correcting it back is free too.
     */
    setDelimiter(value) {
        if (!value || value === this.dialect.delimiter) { return; }
        const text = this.currentText();
        this.dialect = { ...this.dialect, delimiter: value };
        this.adoptText(text);
        this.shown = ROW_CHUNK;
        this.renderGrid();
        if (this.mode === 'raw' || this.mode === 'split') { this.sourceEl.value = this.currentText(); }
        this.refreshDirty();
    }

    onSourceInput() {
        this.sourceOfTruth = 'raw';
        if (this.readOnly) { return; }
        this.refreshDirty();
        if (this.mode !== 'split') { return; }
        clearTimeout(this.splitTimer);
        this.splitTimer = setTimeout(() => {
            // Only mirror while the source pane still owns input, so a switch of
            // focus mid-debounce cannot overwrite what the user has since typed
            // into the grid.
            if (this.sourceOfTruth !== 'raw') { return; }
            this.adoptText(this.sourceEl.value);
            this.renderGrid();
        }, SPLIT_SYNC_MS);
    }

    // -- the grid ------------------------------------------------------------

    /*
     * The whole visible grid, rebuilt.
     *
     * Called for STRUCTURAL changes only — a mode switch, a row or column
     * operation, a paste, a reload. Never on a keystroke in a cell: rebuilding
     * the table would destroy the caret the user is typing at. onCellInput()
     * writes straight into the model instead, and the DOM is already correct
     * because the cell holds the text.
     *
     * Row 0 is drawn as a header. That is a presentational assumption about a
     * format that cannot state whether it has one, and it is the right way to
     * be wrong: nearly every delimited file in circulation has a header row, and
     * being wrong costs a bold first line. The row NUMBERS deliberately count
     * lines of the file from 1, so they agree with Raw mode and with every error
     * message any other tool will ever print about this file, rather than
     * numbering data rows and being off by one against both.
     */
    renderGrid() {
        const width = Math.max(1, columnCount(this.rows));
        const editable = this.readOnly ? '' : ' contenteditable="plaintext-only"';

        if (!this.rows.length) {
            this.headEl.innerHTML = '';
            this.bodyRowsEl.innerHTML = '';
            this.moreEl.innerHTML = this.readOnly ? '<span class="studio-table-note">This file is empty.</span>'
                : '<span class="studio-table-note">This file is empty.</span>' +
                  '<button class="studio-btn" data-tact="seed">Add the first row</button>';
            this.updateShape();
            return;
        }

        const cell = (rowIndex, colIndex, tag) => {
            const row = this.rows[rowIndex] || [];
            // Beyond this row's own length the cell is a PAD: the grid shows it
            // because the table is rectangular, the file does not contain it,
            // and typing into it is what makes it real (table-data.js setCell
            // grows only the row written to).
            const value = colIndex < row.length ? row[colIndex] : '';
            const pad = colIndex >= row.length ? ' class="pad"' : '';
            return '<' + tag + pad + editable + ' data-row="' + rowIndex + '" data-col="' + colIndex + '"' +
                ' tabindex="-1">' + escapeHtml(value) + '</' + tag + '>';
        };

        const line = (rowIndex, tag) => {
            let html = '<tr data-row="' + rowIndex + '">' +
                '<td class="studio-table-num" aria-hidden="true">' + (rowIndex + 1) + '</td>';
            for (let colIndex = 0; colIndex < width; colIndex++) { html += cell(rowIndex, colIndex, tag); }
            return html + '</tr>';
        };

        this.headEl.innerHTML = line(0, 'th');

        const last = Math.min(this.rows.length, Math.max(1, this.shown));
        let body = '';
        for (let rowIndex = 1; rowIndex < last; rowIndex++) { body += line(rowIndex, 'td'); }
        this.bodyRowsEl.innerHTML = body;

        const hidden = this.rows.length - last;
        this.moreEl.innerHTML = hidden > 0
            ? '<span class="studio-table-note">' + hidden.toLocaleString() + ' more row' +
              (hidden === 1 ? '' : 's') + ' not shown. All of them are saved.</span>' +
              '<button class="studio-btn" data-tact="more">Show ' +
              Math.min(hidden, ROW_CHUNK).toLocaleString() + ' more</button>'
            : '';

        this.updateShape();
        this.updateOps();
    }

    updateShape() {
        const rows = this.rows.length;
        const cols = columnCount(this.rows);
        this.shapeEl.textContent = rows
            ? cols.toLocaleString() + ' column' + (cols === 1 ? '' : 's') + ' · ' +
              rows.toLocaleString() + ' row' + (rows === 1 ? '' : 's')
            : '';
        this.shapeEl.title = 'Read as ' + labelFor(this.dialect.delimiter).toLowerCase() + '-separated';
    }

    /*
     * The four structural buttons follow the caret, so they are disabled
     * whenever there is no cell to act on — and the two deletes are disabled
     * when they would leave nothing behind. A grid with no rows cannot be typed
     * back into existence, so deleting the last row is refused rather than
     * offered and regretted.
     */
    updateOps() {
        const at = this.focusedCell;
        const rows = this.rows.length;
        const cols = columnCount(this.rows);
        const set = (action, enabled) => {
            const btn = this.opsEl.querySelector('[data-tact="' + action + '"]');
            if (btn) { btn.disabled = !enabled; }
        };
        const live = !this.readOnly;
        set('row-insert', live && rows > 0);
        set('col-insert', live && cols > 0);
        set('row-delete', live && !!at && rows > 1);
        set('col-delete', live && !!at && cols > 1);
        this.opsEl.hidden = this.readOnly || this.mode === 'raw';
    }

    onCellFocus(e) {
        const cell = e.target.closest && e.target.closest('[data-row][data-col]');
        if (!cell) { return; }
        this.focusedCell = {
            row: Number(cell.getAttribute('data-row')),
            col: Number(cell.getAttribute('data-col'))
        };
        this.disarm();
        this.gridEl.querySelectorAll('.current').forEach(n => n.classList.remove('current'));
        cell.classList.add('current');
        this.updateOps();
    }

    onCellInput(e) {
        const cell = e.target.closest && e.target.closest('[data-row][data-col]');
        if (!cell || this.readOnly) { return; }
        const row = Number(cell.getAttribute('data-row'));
        const col = Number(cell.getAttribute('data-col'));
        setCell(this.rows, row, col, cellText(cell));
        // The cell is no longer padding: it is in the file now.
        cell.classList.remove('pad');
        this.sourceOfTruth = 'rich';
        if (this.mode === 'split') { this.sourceEl.value = this.currentText(); }
        this.updateShape();
        this.refreshDirty();
    }

    /*
     * Spreadsheet keys, with one deliberate departure.
     *
     * Tab and Enter move between cells, which is what anyone who has used a
     * grid will try first. Alt+Enter puts a real newline INSIDE a cell — the
     * convention Excel and Sheets both use — because a delimited file can carry
     * one (quoted) and the grid would otherwise be the one surface unable to
     * express something the format allows.
     *
     * The departure: the arrow keys are left to the caret rather than moving
     * between cells. In a spreadsheet a cell is a value you replace; here it is
     * text you edit, and stealing Left/Right would make it impossible to walk
     * through a sentence in a cell — which is a thing these files contain, since
     * the product's own documents live beside them.
     */
    onCellKeyDown(e) {
        const cell = e.target.closest && e.target.closest('[data-row][data-col]');
        if (!cell) { return; }
        const row = Number(cell.getAttribute('data-row'));
        const col = Number(cell.getAttribute('data-col'));

        if (e.key === 'Tab') {
            e.preventDefault();
            this.moveFocus(row, col, e.shiftKey ? -1 : 1, 0);
            return;
        }
        if (e.key === 'Enter' && (e.altKey || e.metaKey)) {
            if (this.readOnly) { e.preventDefault(); return; }
            // execCommand is the only way to insert into a contenteditable and
            // keep the browser's own undo stack, which is the cell's only undo.
            e.preventDefault();
            document.execCommand('insertText', false, '\n');
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            this.moveFocus(row, col, 0, e.shiftKey ? -1 : 1);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            cell.blur();
        }
    }

    /** One step through the grid in reading order, clamped at both ends. */
    moveFocus(row, col, dCol, dRow) {
        const width = Math.max(1, columnCount(this.rows));
        let nextRow = row + dRow;
        let nextCol = col + dCol;
        if (nextCol >= width) { nextCol = 0; nextRow += 1; }
        if (nextCol < 0) { nextCol = width - 1; nextRow -= 1; }
        // The last visible row, not the last row in the model: focus must never
        // land on a row the grid has not rendered.
        const last = Math.min(this.rows.length, Math.max(1, this.shown)) - 1;
        if (nextRow < 0 || nextRow > last) { return; }
        this.focusCell({ row: nextRow, col: nextCol });
    }

    focusCell(at) {
        if (!at) { return; }
        const cell = this.gridEl.querySelector('[data-row="' + at.row + '"][data-col="' + at.col + '"]');
        if (!cell) { return; }
        cell.focus();
        // Caret at the end, which is where a person who tabbed into a cell to
        // extend its value expects it. Selecting the whole value instead would
        // mean the next keystroke silently replaces the cell.
        const selection = document.getSelection();
        if (selection && cell.childNodes.length) {
            const range = document.createRange();
            range.selectNodeContents(cell);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    /*
     * A paste of MORE THAN ONE CELL fills a block.
     *
     * Copying a range out of Excel, Numbers, Sheets — or out of this grid —
     * puts tab-separated rows on the clipboard, and the useful thing to do with
     * them is fill cells, not drop the whole block into one. Anything that is a
     * single value falls through to the browser's own plain-text paste, so the
     * ordinary case is untouched.
     */
    onCellPaste(e) {
        if (this.readOnly) { return; }
        const cell = e.target.closest && e.target.closest('[data-row][data-col]');
        if (!cell || !e.clipboardData) { return; }
        const grid = parseClipboardGrid(e.clipboardData.getData('text/plain'));
        if (!grid) { return; }
        e.preventDefault();
        const atRow = Number(cell.getAttribute('data-row'));
        const atCol = Number(cell.getAttribute('data-col'));
        grid.forEach((row, r) => row.forEach((value, c) => setCell(this.rows, atRow + r, atCol + c, value)));
        // Rows pasted past the current window have to become visible, or the
        // paste would look like it went nowhere.
        if (this.rows.length > this.shown) { this.shown = this.rows.length; }
        this.renderGrid();
        this.focusCell({ row: atRow, col: atCol });
        if (this.mode === 'split') { this.sourceEl.value = this.currentText(); }
        this.refreshDirty();
    }

    // -- structural operations -----------------------------------------------

    /*
     * Delete is armed by the first click and done by the second.
     *
     * There is no undo stack on this surface — the browser's own covers text
     * inside one cell and nothing else — so a mis-aimed click on Row − would
     * take a line of somebody's data with no way back. The two-click confirm is
     * the same idiom the comment threads use for deleting a message, and the
     * button says what the second click will do rather than opening a dialog
     * over the grid.
     */
    arm(action, label) {
        this.armedOp = action;
        const btn = this.opsEl.querySelector('[data-tact="' + action + '"]');
        if (btn) { btn.classList.add('armed'); btn.textContent = label; }
    }

    disarm() {
        if (!this.armedOp) { return; }
        this.armedOp = undefined;
        const restore = { 'row-delete': 'Row −', 'col-delete': 'Column −' };
        for (const [action, label] of Object.entries(restore)) {
            const btn = this.opsEl.querySelector('[data-tact="' + action + '"]');
            if (btn) { btn.classList.remove('armed'); btn.textContent = label; }
        }
    }

    applyStructural(action) {
        const at = this.focusedCell;
        if (this.readOnly) { return; }
        if (action === 'row-insert') {
            const target = at ? at.row + 1 : this.rows.length;
            insertRow(this.rows, target);
            if (this.shown < this.rows.length) { this.shown = Math.max(this.shown, target + 1); }
            this.focusedCell = { row: target, col: at ? at.col : 0 };
        } else if (action === 'col-insert') {
            const target = at ? at.col + 1 : columnCount(this.rows);
            insertColumn(this.rows, target);
            this.focusedCell = { row: at ? at.row : 0, col: target };
        } else if (action === 'row-delete') {
            if (!at || this.rows.length <= 1) { return; }
            deleteRow(this.rows, at.row);
            this.focusedCell = { row: Math.min(at.row, this.rows.length - 1), col: at.col };
        } else if (action === 'col-delete') {
            if (!at || columnCount(this.rows) <= 1) { return; }
            deleteColumn(this.rows, at.col);
            this.focusedCell = { row: at.row, col: Math.min(at.col, Math.max(0, columnCount(this.rows) - 1)) };
        }
        this.disarm();
        this.renderGrid();
        this.focusCell(this.focusedCell);
        if (this.mode === 'split') { this.sourceEl.value = this.currentText(); }
        this.refreshDirty();
    }

    onToolbarClick(e) {
        const mode = e.target.closest('[data-studio-mode]');
        if (mode) { e.preventDefault(); this.setMode(mode.getAttribute('data-studio-mode')); return; }
        const btn = e.target.closest('[data-tact]');
        if (!btn || btn.disabled) { return; }
        const action = btn.getAttribute('data-tact');
        if (action === 'delimiter') { return; }              // the select handles itself

        // Any button other than the armed one cancels the confirm, so an armed
        // delete cannot be triggered later by a click somewhere else entirely.
        if (this.armedOp && this.armedOp !== action) { this.disarm(); }

        if (action === 'save-now') { this.save(); return; }
        if (action === 'more') { this.shown += ROW_CHUNK; this.renderGrid(); return; }
        if (action === 'seed') {
            this.rows = [['', '', '']];
            this.renderGrid();
            this.focusCell({ row: 0, col: 0 });
            this.refreshDirty();
            return;
        }
        if (action === 'unlock') { this.unlock(); return; }
        if (action === 'keep-mine') { this.resolveConflict('mine'); return; }
        if (action === 'take-theirs') { this.resolveConflict('theirs'); return; }
        if (action === 'row-insert' || action === 'col-insert') { this.applyStructural(action); return; }
        if (action === 'row-delete' || action === 'col-delete') {
            if (this.armedOp === action) { this.applyStructural(action); return; }
            this.arm(action, action === 'row-delete' ? 'Delete row?' : 'Delete column?');
        }
    }

    /*
     * Deliberate override of the read-only gate, same as the Markdown editor's.
     * The safety net is the Git diff: nothing here is committed without the
     * author seeing it in Source Control first.
     */
    unlock() {
        this.readOnly = false;
        this.readOnlyReason = undefined;
        // Saving a file whose quoting could not be read back faithfully WILL
        // reformat it, so the note that says so replaces the block that stopped
        // it — dropping both would be the one dishonest outcome.
        this.willReformat = true;
        this.sourceEl.readOnly = false;
        this.renderGrid();
        this.renderBanners();
        this.setSaveState('clean');
    }

    // -- persistence ---------------------------------------------------------

    /*
     * Dirty is COMPUTED, never accumulated.
     *
     * The Markdown editor tracks edits as events because a ProseMirror
     * transaction is the only place it can see one. Here the document is a
     * string and comparing it to the last saved string is both cheaper and
     * exactly right — which buys one behaviour that matters: an edit undone by
     * hand, or a delimiter switched and switched back, returns the document to
     * clean instead of leaving it permanently dirty and re-writing bytes that
     * did not change.
     */
    refreshDirty() {
        if (this.readOnly) { return; }
        const dirty = this.currentText() !== this.lastSavedText;
        if (this.saveState === 'conflict') { return; }       // autosave is paused; see resolveConflict
        if (!dirty) { this.setSaveState('clean'); return; }
        this.markDirty();
    }

    markDirty() {
        if (!this.armed || this.readOnly) { return; }
        this.setSaveState('dirty');
        if (!this.autosave) { return; }
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), AUTOSAVE_DELAY_MS);
    }

    setSaveState(state, detail) {
        this.saveState = state;
        // Re-read the policy on every status update rather than caching it at
        // open: the control lives on the Project page, so it can change from
        // another surface while this document is open. autosaveForFile is a
        // synchronous read of the already-loaded settings cache.
        this.autosave = fileTypeSettings.autosaveForFile(this.uri);
        const labels = {
            'read-only': 'Read-only',
            clean: 'Saved',
            dirty: this.autosave ? 'Editing…' : 'Unsaved changes',
            saving: 'Saving…',
            saved: 'Saved ' + (detail || timeLabel()),
            conflict: 'Conflict — not saved',
            error: 'Save failed'
        };
        if (this.statusEl) {
            this.statusEl.textContent = labels[state] || state;
            this.statusEl.className = 'studio-doc-status state-' + state;
        }
        // 'saving' is the only state that is a WAIT, so it is the only one that
        // gets the dot. Same rule as the Markdown editor's topbar.
        if (this.busyEl) { this.busyEl.hidden = state !== 'saving'; }
        statusLine.setDocumentState(this.uri, state, labels[state] || state);
        if (this.saveBtn) {
            this.saveBtn.hidden = this.autosave || this.readOnly ||
                (state !== 'dirty' && state !== 'error' && state !== 'conflict');
        }
    }

    /**
     * Conflict-safe write, the same shape as the Markdown editor's: the file's
     * mtime against the one last seen. If anything else wrote the file since,
     * the save is refused and the choice is handed to the user rather than one
     * version silently destroying the other.
     */
    async save(options) {
        if (this.readOnly || !this.armed) { return false; }
        const force = !!(options && options.force);
        const text = this.currentText();
        if (text === this.lastSavedText && !force) { this.setSaveState('clean'); return true; }

        this.setSaveState('saving');
        try {
            if (!force) {
                const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
                if (this.knownMtime !== undefined && stat.mtime !== this.knownMtime) {
                    const disk = await this.fileService.read(this.uri);
                    this.enterConflict(disk.value, text);
                    return false;
                }
            }
            const written = await this.fileService.write(this.uri, text);
            this.knownMtime = written.mtime;
            this.lastSavedText = text;
            // A save proves the round trip: what is on disk is now exactly what
            // this document would write again.
            this.willReformat = false;
            this.renderBanners();
            this.setSaveState('saved', timeLabel(new Date(written.mtime).toISOString()));
            return true;
        } catch (e) {
            console.error('[studio] save failed', e);
            this.setSaveState('error');
            return false;
        }
    }

    // -- external changes ----------------------------------------------------

    /*
     * An assistant editing a CSV is an ordinary thing to ask for, and this
     * surface has to notice.
     *
     * What it does about it is deliberately simpler than the Markdown editor's
     * answer. There, an external write becomes a PROPOSAL held for review,
     * because the review pipeline (hunks, verdicts, tracked changes) is built
     * for Markdown text. Holding a table change for review would need a diff
     * over rows and columns and a rail to show it in, none of which exists. So:
     * an unedited document reloads and says so; an edited one is a conflict and
     * the user chooses. Nothing is ever silently overwritten in either
     * direction, which is the property that actually matters.
     */
    watchFile() {
        try { this.disposables.push(this.fileService.watch(this.uri)); }
        catch (e) { console.warn('[studio] could not watch', this.uri.toString(), e); }
        this.disposables.push(this.fileService.onDidFilesChange(event => {
            if (!event.contains(this.uri, FileChangeType.UPDATED)) { return; }
            clearTimeout(this.externalTimer);
            this.externalTimer = setTimeout(() => this.onExternalChange(), 120);
        }));
        // The same belt-and-braces poll the Markdown editor keeps, for the same
        // reason: whether a watch event arrives at all depends on the backend
        // watcher provider, and a missed one here means the document quietly
        // disagrees with the file.
        this.pollTimer = setInterval(() => this.pollExternalChange(), EXTERNAL_POLL_MS);
    }

    async pollExternalChange() {
        if (this.isDisposed || this.checkingExternal) { return; }
        this.checkingExternal = true;
        try {
            const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            if (stat.mtime !== this.knownMtime) { await this.onExternalChange(); }
        } catch (e) {
            /* deleted or unreadable — the next save reports it */
        } finally {
            this.checkingExternal = false;
        }
    }

    async onExternalChange() {
        if (this.isDisposed) { return; }
        let stat;
        let content;
        try {
            stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            if (stat.mtime === this.knownMtime) { return; }
            content = await this.fileService.read(this.uri);
        } catch (e) {
            return;
        }
        if (content.value === this.lastSavedText) { this.knownMtime = stat.mtime; return; }

        const dirty = this.currentText() !== this.lastSavedText;
        if (dirty) {
            this.enterConflict(content.value, this.currentText());
            return;
        }
        // Clean: adopt the new bytes. The row window is deliberately kept, so a
        // file being appended to by another process does not jump back to the
        // first 500 rows under the reader.
        const window = this.shown;
        this.knownMtime = stat.mtime;
        this.setFromDisk(content.value);
        this.shown = Math.max(window, ROW_CHUNK);
        this.reloadedAt = timeLabel();
        this.renderGrid();
        this.renderBanners();
        this.setSaveState('clean');
    }

    // -- conflicts -----------------------------------------------------------

    enterConflict(diskText, myText) {
        this.conflict = { diskText, myText };
        this.setSaveState('conflict');
        this.renderBanners();
        this.messageService.warn(this.uri.path.base + ' changed on disk — your version was not saved.');
    }

    async resolveConflict(choice) {
        if (!this.conflict) { return; }
        const { diskText } = this.conflict;
        try {
            const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            this.knownMtime = stat.mtime;
        } catch (e) { /* the save below reports it */ }
        if (choice === 'theirs') {
            this.conflict = undefined;
            this.setFromDisk(diskText);
            this.renderGrid();
            this.renderBanners();
            this.setSaveState('clean');
            return;
        }
        this.conflict = undefined;             // adopt the mtime, then overwrite deliberately
        this.renderBanners();
        await this.save({ force: true });
    }

    renderBanners() {
        const banners = [];
        if (this.conflict) {
            banners.push({
                tone: 'block',
                html: '<b>' + escapeHtml(this.uri.path.base) + ' changed on disk</b> while you were editing it. ' +
                    'Your version was not saved. ' +
                    '<button class="studio-btn" data-tact="take-theirs">Take theirs</button>' +
                    '<button class="studio-btn" data-tact="keep-mine">Keep mine</button>'
            });
        }
        if (this.readOnly) {
            banners.push({
                tone: 'block',
                html: '<b>Read-only</b> &mdash; ' + escapeHtml(this.readOnlyReason || 'this file could not be read as a table') +
                    ', so the grid is not a faithful picture of it. Unlock only if you intend to review the change as a diff ' +
                    'before committing. <button class="studio-btn" data-tact="unlock">Edit anyway</button>'
            });
        } else if (this.willReformat) {
            banners.push({
                tone: 'note',
                html: 'Quoting will normalize on save · No data is lost.'
            });
        }
        if (this.reloadedAt && !this.conflict) {
            banners.push({
                tone: 'note',
                html: 'Reloaded at ' + escapeHtml(this.reloadedAt) + ' · this file changed on disk.'
            });
        }
        this.bannersEl.innerHTML = banners.map(b =>
            '<div class="studio-doc-banner ' + b.tone + '">' + b.html + '</div>').join('');
    }

    // -- the right-hand slot -------------------------------------------------

    /*
     * Two of the strip's five destinations are real here, and the strip disables
     * the other three with a reason rather than hiding them — the same answer
     * the HTML viewer gives, for the same reason (slot-strip.js: fixed
     * membership with an explained gap is honest, membership that changes per
     * surface is a segmented control breaking its own promise).
     *
     * Comments is off because a cell has no stable anchor; see the header.
     * Changes and History are off because both are built on a text diff of a
     * Markdown document.
     */
    slotCapabilities() { return ['claude', 'codex']; }

    /*
     * The three dimmed tiles, each saying what is true of a DELIMITED FILE
     * rather than what is true of "not Markdown". The header of this file
     * explains the comment case at length: a cell anchor would have to be a
     * coordinate, and coordinates move when somebody inserts a row.
     */
    slotHints() {
        return {
            comments: 'A row has no stable identity to anchor a comment to — see the note on cell comments',
            changes: 'Change review is only available for Markdown documents',
            history: 'History is only available for Markdown documents'
        };
    }

    slotState() { return { active: this.assistant, counts: {} }; }

    selectSlot(key) {
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
            if (!ok && this.assistant === key) { this.assistant = undefined; this.renderSlot(); }
        });
    }

    renderSlot() {
        renderDocCluster(this.slotClusterEl, this);
        slotStrip.refresh();
    }

    /*
     * Keep the selector honest when the panel is worked through Theia's own
     * chrome, and defend the slot during startup — Claude Code's panel reveals
     * itself when its extension activates, a second or two after a document
     * appears, and without the grace window it would become the default
     * occupant of every table the user opens. Identical to the HTML viewer's;
     * the shared plumbing is in ai-context.js.
     */
    watchRightPanel() {
        if (!this.shell || !this.shell.rightPanelHandler) { return; }
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
}

const TABLE_EDITOR_CSS = `
/* !important: see the matching note on .studio-doc in markdown-editor.js — the
   Lumino dock panel behind this widget carries its own background from Theia's
   generated theme CSS, resolved once at boot, which can win over a plain rule. */
.studio-table { display: flex; flex-direction: column; height: 100%; background: var(--studio-bg) !important; color: var(--studio-text); }
.studio-table .studio-table-ops { display: inline-flex; gap: 4px; flex: none; }
.studio-table .studio-table-ops[hidden] { display: none; }
.studio-table .studio-btn[disabled] { opacity: .45; cursor: default; }
.studio-table .studio-btn[disabled]:hover { background: var(--studio-surface); }
/* An armed delete takes the danger colour, so the second click is aimed at
   something that already looks like what it does. */
.studio-table .studio-btn.armed {
  background: var(--studio-danger); color: #fff; border-color: var(--studio-danger);
}
.studio-table .studio-table-dialect { flex: none; display: inline-flex; }
.studio-table .studio-table-dialect select {
  font: inherit; font-size: 11.5px; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--studio-line); background: var(--studio-surface); color: var(--studio-text);
}
.studio-table .studio-table-shape { font-size: 11.5px; color: var(--studio-muted); white-space: nowrap; flex: none; }

/* The grid itself.
 *
 * border-collapse: separate with a 0 gap plus per-cell borders, not collapse:
 * a sticky header over collapsed borders loses its bottom edge as it scrolls,
 * because the shared border belongs to the row beneath it and that row is not
 * sticky. This way every cell owns its own hairlines. */
/* Bottom padding only, and the top is FLUSH on purpose.
 *
 * position:sticky / top:0 on the header cells resolves against this scroll
 * port's content edge, so any padding-top here would park the header that far
 * down and let rows scroll through the gap above it. Flush also happens to be
 * right: a grid reading as continuous with the bar above it is what every
 * spreadsheet does. The bottom padding is free of that constraint and stops the
 * last row of a full file from sitting on the window edge. */
.studio-table .studio-table-scroll { overflow: auto; padding-bottom: 40px; }
.studio-table .studio-table-grid {
  border-collapse: separate; border-spacing: 0; font-size: 12.5px; line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.studio-table .studio-table-grid th,
.studio-table .studio-table-grid td {
  border-right: 1px solid var(--studio-line); border-bottom: 1px solid var(--studio-line);
  padding: 5px 9px; text-align: left; vertical-align: top;
  min-width: 88px; max-width: 340px;
  /* pre-wrap, so a cell that legitimately contains a newline shows it rather
     than collapsing it into a space. */
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.studio-table .studio-table-grid th {
  position: sticky; top: 0; z-index: 2;
  background: var(--studio-surface-raised); font-weight: 620; color: var(--studio-text);
}
/* The line-number gutter. Sticky on the other axis, and z-index 3 on the header
   cell so the corner stays above both. */
.studio-table .studio-table-num {
  position: sticky; left: 0; z-index: 1;
  min-width: 0; width: 1px; padding: 5px 8px;
  background: var(--studio-surface-sunken); color: var(--studio-muted);
  font-size: 11px; text-align: right; user-select: none;
  border-right: 1px solid var(--studio-line);
}
.studio-table .studio-table-grid thead .studio-table-num { z-index: 3; }
/* A cell the grid shows but the file does not contain: this row is shorter than
   the widest one. Muted ground rather than a border, so it reads as absence
   rather than as an error. */
.studio-table .studio-table-grid .pad { background: color-mix(in srgb, var(--studio-muted) 6%, transparent); }
.studio-table .studio-table-grid [contenteditable]:focus,
.studio-table .studio-table-grid [contenteditable]:focus-visible {
  outline: 2px solid var(--studio-accent); outline-offset: -2px;
}
.studio-table .studio-table-grid .current { background: color-mix(in srgb, var(--studio-accent) 8%, transparent); }
.studio-table .studio-table-grid th.current { background: color-mix(in srgb, var(--studio-accent) 14%, var(--studio-surface-raised)); }

.studio-table .studio-table-more {
  display: flex; align-items: center; gap: 8px; padding: 12px 16px 40px;
}
.studio-table .studio-table-more:empty { display: none; }
.studio-table .studio-table-note { font-size: 11.5px; color: var(--studio-muted); }
`;

module.exports = { TableEditorWidget, TABLE_EDITOR_CSS, cellText };
