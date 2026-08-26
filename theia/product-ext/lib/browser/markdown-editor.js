/*
 * The Studio Markdown editor widget.
 *
 * One widget hosts three authoring surfaces over the same file (Rich, Split,
 * Raw), the review rails beside them (Comments, Changes, History), and the
 * save/conflict machinery underneath. They are together rather than split
 * across widgets because they all read and write ONE body string; splitting
 * them would mean synchronising that string across widget boundaries, which
 * is exactly the class of bug this file spends most of its care avoiding.
 *
 * The invariants worth knowing before changing anything here:
 *
 *  1. The .md file on disk is the source of truth. Comments, proposals and
 *     history live in sidecars and never touch it.
 *  2. Opening a document must never write to it. `armed` gates that.
 *  3. Nothing unreviewed is ever live: an assistant's write to the file is
 *     captured as a proposal and the file is put back to its reviewed state
 *     (see captureProposal).
 *  4. While a proposal is open the document is review-only, so a proposal's
 *     recorded base cannot drift out from under the diff the user is reading.
 */

const { Editor, Extension, Mark, Node, mergeAttributes, generateJSON } = require('@tiptap/core');
const { StarterKit } = require('@tiptap/starter-kit');
const { Link } = require('@tiptap/extension-link');
const { Code } = require('@tiptap/extension-code');
const { Image } = require('@tiptap/extension-image');
const { Placeholder } = require('@tiptap/extension-placeholder');
const { TaskList } = require('@tiptap/extension-task-list');
const { TaskItem } = require('@tiptap/extension-task-item');
const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { FileChangeType } = require('@theia/filesystem/lib/common/files');
const { BinaryBuffer } = require('@theia/core/lib/common/buffer');

const { markdownToHtml, jsonToMarkdown, splitFrontmatter, joinFrontmatter, unsupportedConstructs, contentWords } = require('./markdown');
const { newId } = require('./comments-store');
const { ChangesStore, resolveFile, resolveGroup } = require('./changes-store');
const { diffHunks, applyHunks, countPending } = require('./diff');
const { reviewHunkHtml, comparisonHtml, escapeHtml } = require('./diff-view');
const { trackedHtml, changeCardHtml, changeSummaryText, orderEntries, AUTHOR_SLOTS } = require('./tracked-changes');
const { suggestionHunks, isMine, hunkKey } = require('./change-log');
const { suggestMode, suggestSwitchHtml } = require('./suggest-mode');
const { suggestMarksExtension, refreshSuggestMarks, collect } = require('./suggest-marks');
const { TABLE_EXTENSIONS, TABLE_COMMANDS, tableContent, cellContext, currentAlign } = require('./editor-tables');
/*
 * ONE code block extension, for both rendered content types.
 *
 * Mermaid diagrams and interactive figures are both fenced code blocks, and
 * ProseMirror allows exactly one node view per node type — so figure-view.js owns
 * the dispatch and calls mermaid-view.js's node view when the language is
 * Mermaid. Importing the diagram extension directly here again would install a
 * second node view for the same node and silently lose whichever lost the race.
 */
const { DocumentCodeBlock, starterButtonsHtml } = require('./figure-view');
const { FIGURE_LANGUAGE, figureRequestPrompt, starterFigure } = require('./figure-spec');
const { SessionLock } = require('./session-lock');
const { fileTypeSettings } = require('./file-type-settings');
const { ICONS } = require('./icons');
const { messageHtml, quoteLineHtml } = require('./comment-ui');
const { identity, authorRecord } = require('./identity');
const { signature, mergeFolded } = require('./comment-log');
const { loaderMarkup, loadingMarkup, showLoading } = require('./loader');
const {
    requestChange, openAiPrompt,
    assistantForKey, revealAssistant, collapseRightPanel, assistantFromTabTitle, SLOT_GRACE_MS
} = require('./ai-context');
const { slotStrip, renderDocCluster } = require('./slot-strip');
/*
 * The quality extension: specification signals about this document.
 *
 * Five modules, split along the one seam that matters — three of them are pure
 * (no DOM, no Theia, tested in milliseconds under plain node) and two build
 * markup. The orchestration is in this file, in "rail: quality", and it is only
 * orchestration; every hard question is answered in one of these.
 */
const qualityScan = require('./quality-scan');
const qualityIdentity = require('./quality-identity');
const qualityAnchor = require('./quality-anchor');
const qualityView = require('./quality-view');
const qualityMeasures = require('./quality-measures');
const { qualityMarksExtension, refreshQualityMarks } = require('./quality-marks');
const qualityMove = require('./quality-move');
const { previewBase } = require('./preview-url');
const { statusLine } = require('./status-line');

// StarterKit's Code mark declares `excludes: '_'`, which means it cannot
// coexist with any other mark — so `[`file.tsv`](file.tsv)` loses its link on
// parse. Allowing coexistence is what keeps that construct round-trippable.
const CoexistingCode = Code.extend({ excludes: '' });

/*
 * Toggle source stays standard and plain:
 *
 *   <details><summary>Title</summary>…</details>
 *
 * The extra wrapper only exists in the editor DOM. It gives ProseMirror a
 * content element that excludes <summary>, which is UI chrome rather than a
 * paragraph in the document model.
 */
const Toggle = Node.create({
    name: 'toggle', group: 'block', content: 'block+', isolating: true,
    addAttributes() { return { summary: { default: 'Toggle' } }; },
    parseHTML() {
        return [{
            tag: 'details', contentElement: '[data-studio-toggle-body]',
            getAttrs: element => ({ summary: element.querySelector('summary')?.textContent || 'Toggle' })
        }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['details', ['summary', HTMLAttributes.summary], ['div', { 'data-studio-toggle-body': '' }, 0]];
    }
});

/*
 * Footnotes, as two nodes.
 *
 * The reference is an ATOM. A footnote reference is one indivisible token whose
 * label has to match a definition elsewhere in the file; if the caret could sit
 * inside it, ordinary typing would produce `[^peo|ple]` and quietly break that
 * pairing. Atom means the editor treats it as a single character: select it,
 * delete it, or leave it alone.
 *
 * The definition is a normal block with inline content, because the text of a
 * footnote is prose that deserves bold, links and code like any other. Only its
 * label is an attribute, rendered as a non-editable prefix — editing the label
 * in place would silently orphan every reference pointing at it.
 */
const FootnoteRef = Node.create({
    name: 'footnoteRef', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes() {
        return {
            label: {
                default: '',
                parseHTML: el => el.getAttribute('data-footnote-ref') || '',
                renderHTML: attrs => ({ 'data-footnote-ref': attrs.label || '' })
            }
        };
    },
    parseHTML() { return [{ tag: 'sup[data-footnote-ref]' }]; },
    renderHTML({ HTMLAttributes }) {
        const label = HTMLAttributes['data-footnote-ref'] || '';
        return ['sup', mergeAttributes(HTMLAttributes, { class: 'studio-footnote-ref' }), label];
    }
});

const FootnoteDef = Node.create({
    name: 'footnoteDef', group: 'block', content: 'inline*', defining: true,
    addAttributes() {
        return {
            label: {
                default: '',
                parseHTML: el => el.getAttribute('data-footnote-def') || '',
                renderHTML: attrs => ({ 'data-footnote-def': attrs.label || '' })
            }
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-footnote-def]', contentElement: '[data-studio-footnote-body]' }];
    },
    renderHTML({ HTMLAttributes }) {
        const label = HTMLAttributes['data-footnote-def'] || '';
        /* The label is shown in source form. A reader editing the footnote needs
         * to see which reference it answers, and `[^people]` is the spelling
         * they wrote and can search for; a bare `people` reads as body text. */
        return ['div', mergeAttributes(HTMLAttributes, { class: 'studio-footnote-def' }),
            ['span', { class: 'studio-footnote-def-label', contenteditable: 'false' }, '[^' + label + ']'],
            ['span', { class: 'studio-footnote-def-body', 'data-studio-footnote-body': '' }, 0]];
    }
});

function richImageSrc(documentUri, src) {
    const value = String(src || '');
    // Remote and data URLs retain their author-provided meaning. Markdown
    // relative paths must be resolved against the document, not the app shell.
    if (!documentUri || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) { return value; }
    // previewBase() rather than a root-relative path: on an Electron shell the
    // document is displayed from a file:// page, and a leading slash resolves
    // there instead of at the backend — every image in every document broken.
    // encodeURI is safe over the absolute form: it leaves ':' and '/' alone.
    return encodeURI(previewBase() + documentUri.parent.resolve(value).path.toString());
}

const StudioImage = Image.extend({
    renderHTML({ HTMLAttributes }) {
        return ['img', {
            ...HTMLAttributes,
            src: richImageSrc(this.options.documentUri, HTMLAttributes.src),
            'data-studio-markdown-src': HTMLAttributes.src || ''
        }];
    }
});

// ---------------------------------------------------------------------------
// A mark that exists only in the editor. It is never written to the .md file —
// see markdown.js:inlineFromJson.
// ---------------------------------------------------------------------------
const CommentMark = Mark.create({
    name: 'comment',
    inclusive() { return false; },
    addAttributes() {
        return {
            commentId: {
                default: null,
                parseHTML: el => el.getAttribute('data-comment-id'),
                renderHTML: attrs => attrs.commentId ? { 'data-comment-id': attrs.commentId } : {}
            }
        };
    },
    parseHTML() { return [{ tag: 'span[data-comment-id]' }]; },
    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { class: 'studio-comment-mark' }), 0];
    }
});

/*
 * ONE extension list.
 *
 * The fidelity check parses the file with this set and the live editor edits
 * it with the same set. They used to be two separate literals, which meant a
 * document could pass a check performed against a schema the editor did not
 * actually have — the fidelity gate silently guaranteeing the wrong thing.
 */
/*
 * Cmd/Ctrl+S has to be claimed inside ProseMirror, not on the widget node.
 * Theia's own keybinding service listens at the document level and is
 * registered long before this widget exists, so a node-level listener never
 * reliably sees the event; a keymap entry in the editor itself runs first and
 * returns true, which both saves and stops the browser's Save-page dialog.
 * Adding no nodes or marks, it cannot affect the fidelity check that shares
 * this list.
 */
function saveShortcut(widget) {
    return Extension.create({
        name: 'studioSaveShortcut',
        addKeyboardShortcuts() {
            return { 'Mod-s': () => { if (widget) { widget.save(); } return true; } };
        }
    });
}

/*
 * How long "Dismissed — undo" stays on the rail.
 *
 * A dismissal writes to a file that gets committed, so a mis-click has to be
 * takeable back — and long enough to notice it happened, which four seconds is
 * not. Six is the figure the comment rail's armed delete settled on for the same
 * class of decision.
 */
const QUALITY_UNDO_MS = 6000;

/* The document's path inside its project, which is the key everything about a
 * quality run is stored under. Same rule as changes-store.js's relativePath, and
 * repeated rather than imported because that one is about a sidecar filename and
 * this one is about matching a detector's own path. */
function qualityRelativePath(rootUri, docUri) {
    const root = rootUri.toString();
    const doc = docUri.toString();
    return doc.startsWith(root) ? decodeURIComponent(doc.slice(root.length).replace(/^\//, '')) : doc;
}

/*
 * Every path a detector's path could mean inside this project, longest first.
 *
 * The detectors record their own root-relative path —
 * `tests/traceability/assess/mcp-engine/DESIGN.md` — which has nothing to do
 * with the Studio project root. So a report's path is treated as a suffix to be
 * matched rather than an address to be resolved, exactly as quality-store.js
 * does when it matches a report to a document. Longest first, so a project that
 * genuinely reproduces the detector's directory layout wins over a coincidence
 * two segments deep.
 */
function qualitySuffixCandidates(reportPath) {
    const parts = String(reportPath || '').split('/').filter(Boolean);
    const out = [];
    for (let start = 0; start < parts.length; start++) { out.push(parts.slice(start).join('/')); }
    return out;
}

/*
 * Is this anchor pointing at the document on screen?
 *
 * A suffix comparison in both directions, aligned on segment boundaries. Aligned
 * because the alternative — a bare `endsWith` — makes `api.md` match
 * `internal-api.md`, which would put another document's findings in this one's
 * rail with no visible sign that it had happened.
 */
function qualitySameFile(reportPath, relPath) {
    if (!reportPath || !relPath) { return false; }
    if (reportPath === relPath) { return true; }
    const a = String(reportPath).split('/').filter(Boolean);
    const b = String(relPath).split('/').filter(Boolean);
    const n = Math.min(a.length, b.length);
    for (let i = 1; i <= n; i++) { if (a[a.length - i] !== b[b.length - i]) { return false; } }
    return n > 0;
}

/*
 * The chip that goes on a flagged heading: what the section reads as.
 *
 * Taken from the finding's own explanation rather than composed here, because
 * the detector's wording is the claim and paraphrasing a claim in the view is
 * how a UI ends up saying something the data does not support. Upper-cased by
 * CSS, not here, so the value stays readable in a tooltip and in the rail.
 */
function qualitySectionLabel(finding) {
    const role = finding && finding.fix && finding.fix.readsAs;
    if (role) { return 'reads as ' + role; }
    const match = /reads as ([A-Za-z]+)/.exec((finding && finding.explain && finding.explain.reason) || '');
    return match ? 'reads as ' + match[1] : 'wrong voice';
}

/*
 * Every document's duplication and leak numbers, so one document's rate can be
 * stated as a rank. Cheap: the reports are already parsed and in memory.
 */
function qualityProjectMetrics(reports) {
    const rows = [];
    for (const report of (reports && reports.bloat) || []) {
        const path = (report.paths && report.paths[0]) || report.path;
        if (!path) { continue; }
        rows.push({ path, dupRate: (report.metrics || {}).dup_rate });
    }
    for (const report of (reports && reports.purpose) || []) {
        if (!report.path) { continue; }
        const existing = rows.find(row => row.path === report.path);
        const leakShare = (report.gate || {}).leak_share;
        if (existing) { existing.leakShare = leakShare; }
        else { rows.push({ path: report.path, leakShare }); }
    }
    return rows;
}

function qualityShorten(text, limit = 60) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

/* GitHub's heading-anchor rule, which is what a Markdown reader will resolve the
 * link against. Not a general slugifier — only what a heading needs. */
function qualitySlug(text) {
    return String(text || '').toLowerCase().trim()
        .replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
}

/*
 * The prompt an assistant is given for a tier-2 or tier-3 fix.
 *
 * SHORT BY CONSTRUCTION, and the envelope is what makes it short: the
 * occurrences are ADDRESSES — a file, a heading path, a line range — rather than
 * pasted text, so a cluster spanning sixteen files is sixteen lines of prompt
 * instead of sixteen paragraphs. ai-context.js records why this matters (a
 * seeded assistant opens as an editor tab, not in the slot, so the prompt is
 * read by a person before it is read by a model).
 *
 * It names the rule that fired and the outcome asked for, and it says nothing
 * about how to achieve it — the tiers exist precisely because the deterministic
 * cases are handled without a model, and what is left is judgment.
 */
function qualityFixInstruction(finding, relPath) {
    const places = (finding.anchors || []).map(anchor => {
        const where = qualitySameFile(anchor.file, relPath) ? 'this document' : anchor.file;
        const lines = anchor.line ? ' lines ' + anchor.line +
            (anchor.lineEnd && anchor.lineEnd !== anchor.line ? '–' + anchor.lineEnd : '') : '';
        return '  - ' + where + ' § ' + (anchor.section || '(top level)') + lines;
    }).join('\n');

    if (finding.rule === 'purpose') {
        const readsAs = (finding.fix && finding.fix.readsAs) || 'another kind of document';
        const belongs = (finding.fix && finding.fix.belongsIn) || 'the document that owns that material';
        return 'A specification check found that this section reads as ' + readsAs +
            ' rather than as part of a ' + ((finding.fix && finding.fix.docType) || 'document') +
            '.\n\nSection:\n' + places +
            '\n\nMove it to ' + belongs + ', leaving a one-line reference behind, and change nothing else.' +
            ' Reason given by the check: ' + (finding.explain && finding.explain.reason || '') + '.';
    }

    return 'A specification check found the same content in more than one place — ' +
        (finding.trust === 'exact' ? 'identical wording' : 'reworded, matched by a model') + '.\n\n' +
        'Quoted:\n  "' + qualityShorten(finding.quote, 240) + '"\n\nPlaces:\n' + places +
        '\n\nKeep one authoritative copy and replace the others with a reference to it.' +
        ' Do not paraphrase the copy you keep.';
}

function buildExtensions(widget) {
    return [
        saveShortcut(widget),
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, code: false, codeBlock: false }),
        DocumentCodeBlock,
        CoexistingCode,
        Link.configure({ openOnClick: false, autolink: false, validate: () => true, isAllowedUri: () => true }),
        Placeholder.configure({ placeholder: "Type '/' for blocks…" }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Toggle,
        FootnoteRef,
        FootnoteDef,
        StudioImage.configure({ inline: false, allowBase64: false, documentUri: widget && widget.uri }),
        CommentMark,
        /*
         * Live tracked marks, and the reason this is a callback rather than a
         * value: the plugin asks on every transaction, so the widget owns when
         * the baseline moves and the plugin never has to learn about accepting a
         * suggestion, leaving the mode, or reloading the file. `undefined` is how
         * the marks are off, which is every document that is not being suggested
         * into — so nothing here costs anything in Editing mode.
         */
        suggestMarksExtension(() => (widget && widget.suggestBaseline ? widget.suggestBaseline() : undefined)),
        /*
         * Quality findings in the text, on the same callback argument: the
         * plugin asks per transaction, so the widget owns when the answer
         * changes and the plugin never learns about a check finishing, a card
         * being selected or a finding being dismissed. An empty array is how the
         * marks are off, which is every document nobody has checked.
         */
        qualityMarksExtension(() => (widget && widget.qualityRanges ? widget.qualityRanges() : [])),
        ...TABLE_EXTENSIONS
    ];
}

const SLASH_ITEMS = [
    { key: 'text', label: 'Text', hint: 'Plain paragraph', icon: 'T', run: c => c.setParagraph() },
    { key: 'h1', label: 'Heading 1', hint: 'Large section title', icon: 'H1', run: c => c.setNode('heading', { level: 1 }) },
    { key: 'h2', label: 'Heading 2', hint: 'Medium section title', icon: 'H2', run: c => c.setNode('heading', { level: 2 }) },
    { key: 'h3', label: 'Heading 3', hint: 'Small section title', icon: 'H3', run: c => c.setNode('heading', { level: 3 }) },
    { key: 'h4', label: 'Heading 4', hint: 'Small subsection title', icon: 'H4', run: c => c.setNode('heading', { level: 4 }) },
    { key: 'bullet', label: 'Bulleted list', hint: 'Simple bulleted list', icon: '•', run: c => c.toggleBulletList() },
    { key: 'ordered', label: 'Numbered list', hint: 'List with ordering', icon: '1.', run: c => c.toggleOrderedList() },
    { key: 'task', label: 'Checklist', hint: 'Task list with checkboxes', icon: '☑', run: c => c.toggleTaskList() },
    { key: 'quote', label: 'Quote', hint: 'Capture a citation', icon: '"', run: c => c.toggleBlockquote() },
    { key: 'code', label: 'Code block', hint: 'Preformatted code', icon: '{}', run: c => c.toggleCodeBlock() },
    { key: 'toggle', label: 'Toggle', hint: 'Collapsible details', icon: '›', run: c => c.setNode('toggle', { summary: 'Toggle' }) },
    { key: 'image', label: 'Image', hint: 'Add an image from this project', icon: '▧', defer: true, run: (_, widget) => widget.importImage() },
    { key: 'diagram', label: 'Diagram', hint: 'Mermaid diagram', icon: '◇', run: c => c.insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'graph TD;\n  A[Start] --> B[Finish];' }] }) },
    /*
     * `defer` means "this one opens a surface of its own": the slash text is
     * deleted, the menu closes, and the item takes over. Two items need it and
     * the second one is why it is a flag rather than a special case — the image
     * picker was special-cased in applySlash, and adding a second special case
     * beside it is how a switch statement starts.
     */
    { key: 'figure', label: 'Interactive figure', hint: 'Describe one, or start from a template', icon: '◈', defer: true, run: (_, widget) => widget.createFigure() },
    { key: 'table', label: 'Table', hint: 'Data table', icon: '▦', run: c => c.insertContent(tableContent(3, 2)) },
    { key: 'divider', label: 'Divider', hint: 'Horizontal rule', icon: '—', run: c => c.setHorizontalRule() }
];

const MODES = [
    { key: 'rich', label: 'Rich', hint: 'Edit the rendered document' },
    { key: 'split', label: 'Split', hint: 'Source and rendered document side by side' },
    { key: 'raw', label: 'Raw', hint: 'Edit the Markdown source' }
];

/*
 * The assistants share ONE slot with the rails below.
 *
 * The right of the window holds exactly one surface. Before this, our rail
 * (361px) and Theia's right panel (306px) could both be open, which put 667px
 * of talking-about-the-document beside 628px of document and left two live
 * composers -- "Reply..." and "Ask Claude to edit..." -- with nothing to say
 * which one a keystroke belonged to.
 *
 * They cannot literally share a container: Claude and Codex are unmodified VS
 * Code extensions whose views are webviews served from their own per-panel
 * subdomains, owned by Theia's right panel. Reparenting an iframe like that
 * across widgets tears it down. So the single slot is enforced by
 * COORDINATION -- choosing one collapses the other -- which is observationally
 * the same thing and does not touch either extension.
 *
 * ASSISTANTS, the reveal/collapse plumbing and the selector markup live in
 * ai-context.js because html-viewer.js needs the same slot, and two surfaces
 * building one selector twice is how they drift apart.
 */

// Minimum vertical distance between two gutter marks. Two threads anchored to
// the same line would otherwise render one on top of the other.
const GUTTER_MIN_GAP = 14;

// SLOT_GRACE_MS now lives in ai-context.js, with the rest of the assistant
// plumbing, because BOTH document surfaces need it: the HTML viewer had no guard
// and an assistant became the default occupant of every rendered page.

const AUTOSAVE_DELAY_MS = 700;
// Re-rendering the rich surface on every keystroke in the source pane would
// fight the typist; this is long enough to batch a burst of typing and short
// enough that the preview still reads as live.
const SPLIT_SYNC_MS = 320;
// How often to stat the file as a safety net behind the file watcher. Cheap
// enough to be invisible, frequent enough that an assistant's edit surfaces
// while the user is still thinking about the request that caused it.
const EXTERNAL_POLL_MS = 2000;

/*
 * How long after a keystroke a suggestion is written.
 *
 * Longer than AUTOSAVE_DELAY_MS deliberately. An autosave is invisible; a
 * suggestion is a card that appears on somebody's rail and, once the watcher
 * below is in play, on somebody else's screen. Writing one per burst of typing
 * would make a colleague watch a sentence being composed a word at a time.
 */
const SUGGEST_DELAY_MS = 1100;

function buildTextIndex(doc) {
    let text = '';
    const map = [];
    doc.descendants((node, pos) => {
        if (node.isText && node.text) {
            for (let i = 0; i < node.text.length; i++) { map.push(pos + i); }
            text += node.text;
        }
    });
    return { text, map };
}

/*
 * Live editor widgets, by document URI.
 *
 * A bulk decision that spans files (requirement 12's "accept/reject
 * everywhere") must reach an OPEN editor through that editor's own review
 * pipeline. Writing its file behind its back instead makes it treat the
 * result as a fresh external change and propose it straight back — so
 * "reject everywhere" would leave the rejected text pending again.
 */
const openEditors = new Map();

/*
 * A rendered body reduced to the same string shape suggest-marks.js's collect()
 * produces from a ProseMirror document: the text of each top-level block, joined
 * by a newline.
 *
 * The correspondence holds because every block the renderer emits — p, h1-h4, ul,
 * ol, blockquote, pre, table — becomes exactly one top-level ProseMirror node,
 * and neither side puts a separator between the items inside one.
 */
function plainBlockText(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return [...host.children].map(el => el.textContent).join('\n');
}

function timeLabel(iso) {
    const d = iso ? new Date(iso) : new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

class MarkdownEditorWidget extends Widget {

    constructor(uri, ctx) {
        super();
        this.uri = uri;
        this.fileService = ctx.fileService;
        this.commentsStore = ctx.commentsStore;
        this.changesStore = ctx.changesStore;
        this.changeLog = ctx.changeLog;
        this.historyStore = ctx.historyStore;
        this.labelProvider = ctx.labelProvider;
        this.commandRegistry = ctx.commandRegistry;
        this.messageService = ctx.messageService;
        this.openerService = ctx.openerService;
        // Needed to arbitrate the single right slot against Theia's own right
        // panel, which hosts the assistants. See selectSlot().
        this.shell = ctx.shell;

        this.id = 'studio-md:' + uri.toString();
        this.title.label = uri.path.base;
        this.title.caption = uri.path.toString();
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-file';
        this.addClass('studio-doc');

        this.threads = [];
        this.proposals = [];
        this.historyEntries = [];
        this.pendingFiles = [];
        // undefined is a deliberate loading state; false means the sidecar
        // could not be read or did not satisfy the index contract.
        this.pendingFilesAvailable = undefined;
        this.compareSelection = [];
        this.decisionJournal = [];
        this.mode = 'rich';
        // Which review style this project uses, re-read from the settings store
        // wherever it is needed rather than trusted from open time — the Project
        // page can change it while this document sits open. See renderTracked.
        this.reviewStyle = 'queue';
        /*
         * Suggestions from every author, and MY answers to them.
         *
         * Separate from this.proposals, which is the assistant path's single
         * proposal against a recorded base. They render into the same rail and
         * the same document, and they are two stores because they are two shapes
         * — see change-log.js.
         */
        this.suggestions = [];
        this.rejections = {};
        this.suggesting = suggestMode.suggesting();
        // Set while a counter-suggestion is being composed, so the record says
        // which suggestion it answers.
        this.counterTo = undefined;
        /*
         * Which rail would open, and whether it is open. NOT open by default,
         * and that changed with the topbar cluster.
         *
         * Comments being the default occupant made sense while a 48px strip was
         * on screen advertising all five destinations: the panel was the visible
         * half of a control the user could already see. Now the resting state is
         * the whole point — the document reaches the window's edge, and the
         * count badge on the Comments tile is what says a document has threads.
         * Opening 360px of rail unasked would give the width back with one hand
         * and take it with the other.
         *
         * `rail` still remembers Comments, so the first press opens what it
         * always did.
         */
        this.rail = 'comments';
        this.railOpen = false;
        // Which assistant, if any, is the current occupant of the single right
        // slot. Mutually exclusive with railOpen -- see selectSlot().
        this.assistant = undefined;
        // Has the user expressed a slot preference yet? Until they do, the
        // document's own rail defends the slot against a self-revealing
        // assistant panel. See SLOT_GRACE_MS.
        this.slotChosen = false;
        this.openedAt = Date.now();
        this.saveState = 'clean';
        this.autosave = true;
        // Which surface last received input. In Split both are live, so the
        // body has to come from whichever the user is actually typing into.
        this.sourceOfTruth = 'rich';
        this.activeThreadId = undefined;
        // Resolved threads are archive material. The disclosure keeps the
        // active review queue short; this id names the one archived thread a
        // reviewer explicitly chose to inspect.
        this.resolvedThreadsOpen = false;
        this.openResolvedThreadId = undefined;
        this.armedDeleteId = undefined;
        /*
         * The quality rail's own state, all of it view state except the
         * judgments, which are a mirror of the committed sidecar.
         *
         * `qualityLoaded` rather than a truthiness check on the envelope,
         * because a document with no report is a legitimate loaded state and
         * must not send the rail back to read the directory on every render.
         */
        this.qualityStore = ctx.qualityStore;
        /*
         * The detector runner, or undefined where there is none. Probed once,
         * lazily, when the rail first opens — not in this constructor, which
         * runs for every document a person opens whether they look at Quality
         * or not, and an unconditional probe there is a filesystem walk per tab.
         */
        this.qualityRunner = ctx.qualityRunner;
        this.qualityRun = undefined;      // { available, why, running, done, total, current, error }
        this.qualityRunId = undefined;
        this.qualityRunWatch = undefined;
        this.qualityEnvelope = undefined;
        this.qualityFindings = [];
        this.qualityJudgments = {};
        this.qualityTab = 'findings';
        this.qualityTrust = 'all';
        this.qualitySort = 'document';
        this.qualityShowWeak = false;
        this.qualityShowDismissed = false;
        this.activeFinding = undefined;
        this.qualityExplainFor = undefined;
        this.qualityPickerFor = undefined;
        this.qualityPickerReason = undefined;
        this.qualityUndoFor = undefined;
        this.qualityResolvedSince = 0;
        this.qualityLoaded = false;
        this.qualityLoading = false;
        this.qualityDocTypeOpen = false;
        this.qualitySegment = undefined;
        this.qualityMissing = undefined;
        this.qualityError = undefined;
        this.drafts = {};
        this.disposables = [];

        this.node.innerHTML =
            /*
             * Two segmented controls used to sit 40px apart in this bar, the
             * same pill in the same row, encoding different categories: mode
             * changes WHAT YOU EDIT (and discards the selection), the slot
             * changes WHAT YOU READ BESIDE IT (and discards nothing). Same
             * shape is a promise of same kind, so they are now separated --
             * mode stays welded to the path on the left as a property of the
             * document, and the slot selector is pushed to the right edge
             * where the surface it governs actually is.
             *
             * The autosave toggle is gone from this bar entirely: it sat next
             * to the status and contradicted it outright ("Read-only" beside
             * "Autosave on"). It is a per-project policy you set once, so it
             * now lives with the other project settings in the Projects panel
             * and this bar states the save situation exactly once.
             */
            /*
             * Two things left this bar in design review 02, and both left
             * because they belonged to another scope. One of them has come
             * back, changed.
             *
             * The slot selector moved to the shell's right-hand strip
             * (slot-strip.js): three of its five entries were app-level panels
             * that outlive the document, and the pill's membership changed per
             * surface. It is now HALF back, as the icon cluster at the end of
             * this bar -- the three DOCUMENT destinations only. The two
             * assistants stayed shell-level and live at the foot of the left
             * activity rail, because a per-document toolbar cannot reach them
             * when no document is open. The strip's own 48px column is gone; see
             * the header of slot-strip.js for why holding it was worse than
             * crowding this bar.
             *
             * The path moved to the status line: it stated the file name a
             * second time 35px under the dock tab that already says it, and the
             * project name a third time after the switcher and the breadcrumb.
             * What only it carried -- which FOLDER you are in -- is now a
             * status-line field, so nothing was lost and nothing is said twice.
             */
            '<div class="studio-doc-topbar">' +
            '  <div class="studio-seg" data-seg="mode"></div>' +
            '  <span class="studio-doc-spacer"></span>' +
            /*
             * The busy dot sits BESIDE the status, never inside it.
             *
             * .studio-doc-status is read as text by four regression suites --
             * content-editing asserts /^Saved/ on it, slot- and fidcheck read
             * its textContent -- so putting a <title>Loading</title> inside it
             * would make the widget's own state assertion depend on the
             * spinner's accessible name. It is a sibling with its own hidden
             * flag, and setSaveState below owns when it shows.
             */
            /*
             * Editing / Suggesting sits here rather than in a menu because it
             * changes what the NEXT KEYSTROKE DOES, and a mode with that much
             * consequence has to be visible without being opened — the same
             * argument that keeps the save status in this bar. It is placed
             * after the spacer, next to the status, because the two together
             * answer one question: where is my typing going.
             */
            '  <span class="studio-doc-suggest"></span>' +
            '  <span class="studio-doc-busy" hidden>' +
                 loaderMarkup({ size: 13, decorative: true }) +
            '  </span>' +
            '  <span class="studio-doc-status">Loading…</span>' +
            '  <button class="studio-btn primary" data-act="save-now" hidden>Save</button>' +
            /*
             * Last, hard against the bar's right edge, because the surface it
             * governs is the right of the window -- the same argument that
             * pushed the old pill out of the middle of this row.
             *
             * The divider is not decoration: everything left of it states what
             * the FILE is doing, everything right of it opens something BESIDE
             * it. Without a rule the cluster read as three more status fields.
             */
            '  <span class="studio-slot-divider" aria-hidden="true"></span>' +
            '  <div class="studio-slot-cluster" data-slot-cluster></div>' +
            '</div>' +
            /*
             * Banners live INSIDE the document column, not above the whole
             * widget. As a sibling of the body they ran the full width, across
             * the rail as well, which pushed the rail down and cut it off from
             * the selector pill that opens it — and implied a warning about the
             * file was a warning about the comments.
             */
            '<div class="studio-doc-body">' +
            '  <div class="studio-doc-main">' +
            '    <div class="studio-doc-banners"></div>' +
            '    <div class="studio-doc-panes">' +
            '      <div class="studio-source-pane"><textarea class="studio-source" spellcheck="false"></textarea></div>' +
            '      <div class="studio-doc-scroll">' +
            '        <div class="studio-doc-page"></div>' +
            /*
             * The tracked-changes rendering of the document, a SIBLING of the
             * live editor page rather than a replacement for its contents.
             *
             * Writing the marked-up document into .studio-doc-page would mean
             * tearing down ProseMirror's DOM and rebuilding it on every
             * decision, and ProseMirror owns that subtree — it would come back
             * without its plugin state, its selection, or its comment marks.
             * Two nodes, one shown at a time (see .tracked-review in
             * tracked-changes.js), keeps the editor intact underneath and makes
             * releasing the review lock a class toggle instead of a reload.
             */
            '        <div class="studio-doc-page studio-tracked-page" hidden></div>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '  <aside class="studio-rail">' +
            '    <div class="studio-rail-head"></div>' +
            '    <div class="studio-rail-list"></div>' +
            '    <div class="studio-rail-foot-note"></div>' +
            '  </aside>' +
            '</div>' +
            '<div class="studio-slash" hidden></div>' +
            '<div class="studio-bubble" hidden></div>' +
            '<div class="studio-table-bar" hidden></div>';

        this.statusEl = this.node.querySelector('.studio-doc-status');
        this.suggestEl = this.node.querySelector('.studio-doc-suggest');
        this.busyEl = this.node.querySelector('.studio-doc-busy');
        this.saveBtn = this.node.querySelector('[data-act="save-now"]');
        this.slotClusterEl = this.node.querySelector('[data-slot-cluster]');
        this.bannersEl = this.node.querySelector('.studio-doc-banners');
        this.bodyEl = this.node.querySelector('.studio-doc-body');
        // The loading state's host. Not .studio-doc-scroll, which mode-raw
        // hides outright, and not the widget root, which would put a cover over
        // the topbar the user reads the document's state from.
        this.panesEl = this.node.querySelector('.studio-doc-panes');
        this.sourcePaneEl = this.node.querySelector('.studio-source-pane');
        this.sourceEl = this.node.querySelector('.studio-source');
        this.pageEl = this.node.querySelector('.studio-doc-page');
        this.trackedEl = this.node.querySelector('.studio-tracked-page');
        this.railEl = this.node.querySelector('.studio-rail');
        this.railHeadEl = this.node.querySelector('.studio-rail-head');
        this.listEl = this.node.querySelector('.studio-rail-list');
        this.footEl = this.node.querySelector('.studio-rail-foot-note');
        this.slashEl = this.node.querySelector('.studio-slash');
        this.bubbleEl = this.node.querySelector('.studio-bubble');
        this.tableBarEl = this.node.querySelector('.studio-table-bar');

        this.renderSegmented();

        /*
         * Authoring modes can be turned off from the Project page while a
         * document is open in Split or Raw — that is a setting write, so it
         * arrives here as a settings change, not as a click in this widget. The
         * document has to come back to Rich, or it would be left editing source
         * in a surface with no way back to the rendered document.
         *
         * fileTypeSettings.onChanged keeps a plain listener array with no
         * unsubscribe, and this widget is closable, so the isDisposed guard is
         * what makes a stale listener inert instead of a source of exceptions on
         * every settings write. Same guard, same reason, as project-page.js.
         */
        /*
         * suggestMode keeps a plain listener array with no unsubscribe, like
         * fileTypeSettings, so the isDisposed guard is what makes a stale
         * listener inert rather than a source of exceptions. Every open document
         * follows the mode, because it is a property of the person and not of
         * one file.
         */
        suggestMode.onChanged(() => { if (!this.isDisposed) { this.applySuggestMode(); } });
        this.renderSuggestSwitch();

        fileTypeSettings.onChanged(() => {
            if (this.isDisposed) { return; }
            if (!fileTypeSettings.authoringModesForFile(this.uri) && this.mode !== 'rich') { this.setMode('rich'); }
            else { this.renderSegmented(); }
            /*
             * The review style can be switched from the Project page while a
             * proposal is open in this document, and both styles are views of
             * the same decisions — so the correct response is to re-render, not
             * to refuse or to reload. Guarded on an actual change because this
             * listener fires for every settings write, including the file-type
             * checkboxes, and re-rendering the tracked document rebuilds its
             * markup from the proposal each time.
             */
            /*
             * Specification signals can be turned off from the Project page
             * while this document has the quality rail open — the destination
             * stops being drawn, and a panel left open in a slot nothing can
             * reach any more is a trap. Close it, and give the width back to the
             * document exactly as the selector's own toggle would.
             */
            if (!fileTypeSettings.qualitySignalsForFile(this.uri) && this.rail === 'quality' && this.railOpen) {
                this.closeSlot();
            }
            this.renderSlotCluster();
            const style = fileTypeSettings.changeReviewForFile(this.uri);
            if (style !== this.reviewStyle) {
                this.reviewStyle = style;
                this.renderTracked();
                this.renderRail();
                this.renderBanners();
            }
        });

        this.node.addEventListener('click', e => this.onClick(e));
        this.listEl.addEventListener('input', e => {
            const t = e.target.closest('textarea');
            const th = e.target.closest('[data-thread]');
            if (t && th) { this.drafts[th.getAttribute('data-thread')] = t.value; }
        });
        this.listEl.addEventListener('keydown', e => {
            if (e.key !== 'Enter' || e.shiftKey) { return; }
            const t = e.target.closest('textarea');
            const th = e.target.closest('[data-thread]');
            if (!t || !th) { return; }
            e.preventDefault();
            this.addMessage(th.getAttribute('data-thread'), t.value);
        });
        // Clicking the floating toolbars must not blur the editor, or the
        // selection is gone before the handler reads it.
        for (const floating of [this.bubbleEl, this.slashEl, this.tableBarEl]) {
            floating.addEventListener('mousedown', e => e.preventDefault());
        }

        // The source pane is a plain textarea, so it needs its own handler for
        // the shortcut the ProseMirror keymap covers in Rich mode.
        this.sourceEl.addEventListener('keydown', e => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                this.save();
            }
        });
        this.sourceEl.addEventListener('input', () => this.onSourceInput());
        this.sourceEl.addEventListener('focus', () => { this.sourceOfTruth = 'raw'; });
        this.pasteHandler = e => {
            if (this.readOnly || !this.editor || !this.editor.view.dom.contains(e.target)) { return; }
            const files = e.clipboardData && e.clipboardData.files;
            const image = files && [...files].find(file => /^image\//i.test(file.type));
            // Text and non-image paste remain ProseMirror's responsibility.
            if (!image) { return; }
            e.preventDefault();
            void this.insertImageFile(image);
        };
        this.node.addEventListener('paste', this.pasteHandler);
        /*
         * Document level, capture phase — not the widget node.
         *
         * Theia's keybinding service listens on the document and already owns
         * Cmd/Ctrl+S; when it handles a binding it stops propagation, so the
         * event never descends to a listener on this widget's node. Listening
         * on the document too means this handler still runs (stopPropagation
         * does not cancel other listeners on the same node), and the
         * activeElement guard keeps one open document from answering for
         * another.
         */
        this.keyHandler = e => {
            if (!this.node.isConnected || !this.node.contains(document.activeElement)) { return; }
            this.onKeyDown(e);
        };
        document.addEventListener('keydown', this.keyHandler, true);

        /*
         * The floating toolbars also have to go when the click lands OUTSIDE
         * this widget entirely.
         *
         * onClick below dismisses them for clicks inside the widget, which used
         * to be enough, because every product control near the document was
         * inside it. It is not any more: the ambient state is a status line and
         * the two assistants are a cluster in the left activity rail, both
         * outside this node. Measured consequence before this existed — clicking
         * the shell-level slot selector (then a strip in the right-hand column)
         * to open Comments left the selection toolbar hanging over the document,
         * because on macOS pressing a button moves no focus, so the editor kept
         * both focus and selection and nothing told it to hide. The document's
         * own three destinations are back inside this node and are covered by
         * onClick again, but the assistants are not, so this stays.
         *
         * Capture phase on `document`, mirroring the keydown handler above, so a
         * control that stops propagation cannot swallow the dismissal; the
         * containment check keeps one open document from answering for another.
         */
        this.outsidePointerHandler = e => {
            if (!this.node.isConnected || this.node.contains(e.target)) { return; }
            this.hideBubble();
            this.hideSlash();
            this.hideTableBar();
        };
        document.addEventListener('pointerdown', this.outsidePointerHandler, true);
    }

    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        openEditors.set(this.uri.toString(), this);
        if (!this.editor) { this.init(); }
    }

    onCloseRequest(msg) {
        openEditors.delete(this.uri.toString());
        if (this.selectionChangeHandler) { document.removeEventListener('selectionchange', this.selectionChangeHandler); }
        if (this.keyHandler) { document.removeEventListener('keydown', this.keyHandler, true); }
        if (this.outsidePointerHandler) { document.removeEventListener('pointerdown', this.outsidePointerHandler, true); }
        for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* already gone */ } }
        this.disposables = [];
        clearInterval(this.pollTimer);
        clearTimeout(this.externalTimer);
        if (this.lock) { this.lock.release(); this.lock = undefined; }
        if (this.editor) { this.editor.destroy(); this.editor = undefined; }
        super.onCloseRequest(msg);
        /*
         * Lumino's Widget.onCloseRequest DETACHES but never disposes — only
         * Theia's own BaseWidget adds the dispose() call, and this widget
         * extends the raw Lumino class (no TypeScript build step here, so
         * there is no BaseWidget to inherit from cheaply).
         *
         * Without this line the closed widget stays in ApplicationShell's
         * FocusTracker for the lifetime of the page, because the tracker only
         * drops a widget when its `disposed` signal fires. The open handler
         * then finds that detached corpse by id, skips construction, and calls
         * activateWidget on a widget that belongs to no area — which does
         * nothing at all. Reported as "if i close md or file once, i cant open
         * it again": one close made a document unopenable until reload.
         *
         * onAfterAttach's `if (!this.editor)` guard means re-adding the same
         * instance would not rebuild it either, so disposal is the fix rather
         * than resurrection.
         */
        this.dispose();
    }

    buildExtensions() { return buildExtensions(this); }

    /*
     * Can this editor represent the document without losing anything?
     *
     * Parse the file, serialise it back, parse THAT, and compare the two
     * documents structurally. If they differ, the file uses Markdown this
     * subset cannot express (footnotes, raw HTML blocks, reference links…)
     * and saving would silently destroy it — so the document opens read-only
     * instead. Textual-only differences (bullet char, wrapping) are reported
     * as reformatting, not as data loss.
     */
    checkFidelity(body) {
        try {
            const found = unsupportedConstructs(body);
            if (found.length) { return { lossless: false, identical: false, reason: found.join(', ') }; }

            const exts = this.buildExtensions();
            const first = generateJSON(markdownToHtml(body), exts);
            const roundTripped = jsonToMarkdown(first);
            const second = generateJSON(markdownToHtml(roundTripped), exts);

            const wBefore = contentWords(body);
            const wAfter = contentWords(roundTripped);
            if (wBefore !== wAfter) {
                const a = wBefore.split(' '), bb = wAfter.split(' ');
                let k = 0; while (k < a.length && a[k] === bb[k]) { k++; }
                console.info('[studio][fidelity] content mismatch in', this.uri.path.base,
                    '\n  at word', k, '\n  before:', a.slice(Math.max(0, k - 4), k + 6).join(' '),
                    '\n  after :', bb.slice(Math.max(0, k - 4), k + 6).join(' '));
                return { lossless: false, identical: false, reason: 'text would be lost or reordered' };
            }
            if (JSON.stringify(first) !== JSON.stringify(second)) {
                return { lossless: false, identical: false, reason: 'the round trip is not stable' };
            }
            return { lossless: true, identical: roundTripped.replace(/\s+$/, '') === body.replace(/\s+$/, ''), roundTripped };
        } catch (e) {
            console.error('[studio] fidelity check failed', e);
            return { lossless: false, identical: false, reason: 'the fidelity check itself failed' };
        }
    }

    /*
     * Opening a document is the one wait in this product with a MEASURED
     * duration attached to it, and the measurement is already in this file.
     *
     * The note in loadDocument() below records why the editor is created last:
     * the loads and the session claim are asynchronous, and creating the editor
     * first made the ProseMirror surface interactive "several hundred
     * milliseconds before the chrome settled". That ordering is right and stays
     * — but it also states, in the code's own words, how long this widget is a
     * blank white rectangle with "Loading…" in 11.5px grey at the far end of
     * its topbar. The dock is the largest region of the window; the status was
     * the smallest text in it.
     *
     * The wrapper exists so the loading state cannot outlive the load. Every
     * exit from loadDocument passes through the finally — including the throw
     * from a file that vanished between the click and the read, which would
     * otherwise leave a spinner turning over a document that is never coming.
     */
    async init() {
        const done = showLoading(
            this.panesEl,
            'Opening ' + this.uri.path.base + '…',
            { className: 'studio-doc-loading' }
        );
        try {
            await this.loadDocument();
        } finally {
            done();
        }
    }

    async loadDocument() {
        const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
        this.knownMtime = stat.mtime;
        const content = await this.fileService.read(this.uri);
        this.lastWrittenFull = content.value;

        // Frontmatter never enters the editor; it is held verbatim.
        const split = splitFrontmatter(content.value);
        this.frontmatter = split.frontmatter;
        this.originalBody = split.body;

        const fidelity = this.checkFidelity(this.originalBody);
        this.readOnly = !fidelity.lossless;
        this.readOnlyReason = fidelity.reason;
        this.willReformat = fidelity.lossless && !fidelity.identical;

        this.sourceEl.value = this.originalBody;
        this.autosave = fileTypeSettings.autosaveForFile(this.uri);
        this.reviewStyle = fileTypeSettings.changeReviewForFile(this.uri);

        /*
         * Everything that changes the LAYOUT around the editor happens before
         * the editor exists.
         *
         * The rail's width and the banners' height both move the document
         * area, and these loads plus the session claim are asynchronous. When
         * the editor was created first, the ProseMirror surface became
         * interactive several hundred milliseconds before the chrome settled,
         * so a click or drag in that window landed on coordinates that had
         * since moved — the interaction was simply lost. Creating the editor
         * last means the surface appearing implies a settled layout.
         */
        const [comments, changes, history, suggested] = await Promise.all([
            this.commentsStore.load(this.uri),
            this.changesStore.load(this.uri),
            this.historyStore.load(this.uri),
            this.changeLog.load(this.uri)
        ]);
        this.suggestions = suggested.proposals;
        this.rejections = suggested.rejections;
        this.threads = comments.threads.map(t => ({ scope: 'inline', ...t }));
        this.threadsSig = signature(comments.threads);
        this.proposals = changes.proposals;
        this.historyEntries = history.entries;

        this.watchComments();
        this.watchSuggestions();
        this.watchFile();
        await this.claimSession();

        this.applyMode();
        this.renderRail();
        this.renderBanners();

        this.editor = new Editor({
            element: this.pageEl,
            extensions: this.buildExtensions(),
            editable: !this.readOnly,
            content: markdownToHtml(this.originalBody),
            onUpdate: ({ transaction }) => {
                this.sourceOfTruth = 'rich';
                this.onDocChanged(transaction);
                this.updateSlash();
            },
            onSelectionUpdate: () => { this.updateBubble(); this.updateSlash(); this.updateTableBar(); },
            onBlur: () => { setTimeout(() => { this.hideBubble(); }, 150); }
        });

        // A native selection may collapse without a ProseMirror transaction
        // when a drag finishes outside the editable surface. The previous
        // toolbar only watched editor callbacks, so it could remain stale.
        this.selectionChangeHandler = () => {
            const selection = document.getSelection();
            if (!selection || selection.isCollapsed || !this.editor || !this.editor.view.dom.contains(selection.anchorNode)) {
                this.hideBubble();
            }
        };
        document.addEventListener('selectionchange', this.selectionChangeHandler);

        /*
         * The gutter is appended after the editor is constructed rather than
         * included in the widget's initial innerHTML: TipTap mounts into
         * pageEl, and letting it build its own subtree first keeps this out of
         * the way of that. It is absolutely positioned against pageEl, which
         * is also the offsetParent of the comment marks it tracks, so both
         * share one coordinate origin and no conversion is needed.
         */
        this.gutterEl = document.createElement('div');
        this.gutterEl.className = 'studio-doc-gutter';
        this.pageEl.appendChild(this.gutterEl);

        /*
         * Re-place the marks whenever the page's box changes.
         *
         * Opening the slot, entering Split, and resizing the window all reflow
         * the text, which moves every anchor. A ResizeObserver is used instead
         * of calling renderGutter from those code paths because the rail has a
         * width transition: reading offsetTop the moment the class flips gives
         * the pre-animation layout, and the marks would settle in the wrong
         * place. The observer fires as the box actually changes.
         */
        if (typeof ResizeObserver === 'function') {
            this.pageObserver = new ResizeObserver(() => this.renderGutter());
            this.pageObserver.observe(this.pageEl);
            this.disposables.push({ dispose: () => this.pageObserver.disconnect() });
        }

        this.reanchorThreads();
        this.renderRail();
        this.watchRightPanel();
        this.reconcileSlot();
        /*
         * Deliberately NOT also on a timer.
         *
         * A delayed reconcile was tried and removed: it collapsed the right
         * panel ten seconds after the document opened, which reflowed the page
         * underneath whatever the user was doing. Six table-editing checks in
         * content-editing-regression failed because .studio-table-bar had been
         * positioned against the pre-reflow layout and its buttons had moved out
         * from under the click -- but the real problem is the behaviour, not the
         * test: a panel must not rearrange itself while someone is editing.
         *
         * It was redundant anyway. Every way the slot can be contested is
         * already covered by an event: reconcileSlot above for a panel that is
         * already expanded at open, the SLOT_GRACE_MS branch in watchRightPanel
         * for one that reveals itself later (which fires a tab-bar signal), and
         * onActivateRequest for switching between document tabs.
         */
        this.refreshPendingFiles();

        // The save path is armed only after load-time normalisation and the
        // re-anchor transaction have settled. Opening a file must never write
        // to it.
        this.lastSavedBody = jsonToMarkdown(this.editor.getJSON());
        setTimeout(() => { this.armed = true; }, 0);
        this.setSaveState(this.readOnly ? 'read-only' : 'clean');
        this.applyReviewLock();
    }

    // -- modes ---------------------------------------------------------------

    /*
     * The mode switch is a PROJECT FEATURE, and it is off by default.
     *
     * Rich is what this product is for; Split and Raw show Markdown source,
     * which is useful when you need it and a standing invitation to leave the
     * rendered document when you do not. So a project opts in
     * (fileTypeSettings.authoringModes) and until it does there is no switch at
     * all — not a disabled one, since there is nothing to enable here: the
     * setting is on the Project page.
     *
     * The flag is re-read on every render rather than cached at open, for the
     * same reason the saving policy is (see setSaveState): this widget does not
     * own the control, so the value can change from another surface while the
     * document is open.
     */
    renderSegmented() {
        const seg = this.node.querySelector('[data-seg="mode"]');
        this.authoringModes = fileTypeSettings.authoringModesForFile(this.uri);
        // Emptied as well as hidden: a hidden container still holding three
        // buttons keeps them in the DOM and in the tab order, which is the same
        // defect the floating toolbars had (see the [hidden] note in SHELL_CSS).
        seg.hidden = !this.authoringModes;
        if (!this.authoringModes) {
            seg.innerHTML = '';
            this.updateTopbarVisibility();
            this.renderSlotCluster();
            slotStrip.refresh();
            return;
        }
        seg.innerHTML = MODES.map(m =>
            '<button class="studio-seg-btn' + (m.key === this.mode ? ' on' : '') + '" data-studio-mode="' + m.key +
            '" title="' + m.hint + '" aria-pressed="' + (m.key === this.mode) + '">' + m.label + '</button>').join('');
        /*
         * The document's three destinations are in this bar and the two
         * assistants are not, so keeping the selector honest is two calls, not
         * one: renderSlotCluster paints this widget's own cluster from
         * slotState(), and slotStrip.refresh() repaints the shell-level
         * assistant cluster from whichever assistant owns Theia's panel.
         */
        this.renderSlotCluster();
        slotStrip.refresh();
        this.updateTopbarVisibility();
    }

    /*
     * THE BAR IS ALWAYS SHOWN. This method exists to say so and to record why it
     * used to do something, because it has now been wrong twice in the same
     * direction and the reasoning is what stops a third time.
     *
     * Round one: hidden whenever authoring modes were off and no Save button was
     * needed — which is the DEFAULT project (autosave on, source modes off), so
     * on an ordinary document the bar was not there at all. Right when its only
     * contents were the mode segment and a conditional button.
     *
     * Round two: hidden only when it would be EMPTY, after the bar gained the
     * Editing / Suggesting switch. That switch is available on every editable
     * document, and a control nobody can reach is not a feature — reported
     * exactly that way, "i don't get how to enable suggestion mode", with the
     * switch rendering correctly into a parent that had `hidden` set.
     *
     * Round three, here: the bar can no longer be empty, so there is no
     * condition left to test. It carries the slot cluster, whose membership is
     * FIXED at three (slot-strip.js) — an entry the document cannot serve is
     * dimmed and explains itself rather than disappearing, so the cluster has
     * exactly the same three children on every document, always. Hiding the bar
     * would take the only route to Comments, Changes and History with it, which
     * is round two's mistake with a worse blast radius.
     *
     * The cost is deliberate and worth naming: an ordinary document shows a 42px
     * bar it did not before the mode switch landed. That is a charge against the
     * empty-chrome work (D10–D19), and this change is what pays for it — the
     * 48px right-hand column that held the same buttons is gone, so the document
     * is 48px wider and the bar is the only chrome left.
     *
     * The call sites are kept rather than deleted: it is the one place that
     * knows the answer, and a future bar that CAN be empty needs it back here
     * rather than reinvented at four call sites.
     */
    updateTopbarVisibility() {
        const topbar = this.node.querySelector('.studio-doc-topbar');
        if (!topbar) { return; }
        topbar.hidden = false;
    }

    /*
     * Paint this document's own slot cluster.
     *
     * The rendering is slot-strip.js's, from this widget's slotCapabilities()
     * and slotState() — the same two methods the shell-level strip used to read
     * off it. Nothing about the contract changed when the buttons moved into
     * this node; only who owns the pixels.
     */
    renderSlotCluster() { renderDocCluster(this.slotClusterEl, this); }

    /*
     * What the slot clusters render for this document.
     *
     * Capabilities are stated rather than implied: membership is fixed at five
     * across the two clusters, and an entry a surface cannot serve is dimmed
     * with a reason. A Markdown document can serve all five.
     *
     * `counts` keeps the same two numbers the old pills carried as <em> badges,
     * and they matter MORE now than they did in either previous home: with the
     * panel absent by default, the badge on the Comments button is the only
     * thing on screen saying a document-scope thread exists at all (constraint
     * 22 — those threads have no gutter mark to fall back on).
     */
    slotCapabilities() { return ['comments', 'changes', 'history', 'quality', 'claude', 'codex']; }

    slotState() {
        return {
            active: this.assistant || (this.railOpen ? this.rail : undefined),
            counts: {
                comments: this.threads.filter(t => !t.resolved).length,
                // Both stores. A colleague's suggestion is review work waiting on
                // me exactly as an assistant's proposal is, so a strip that
                // counted only one of them would say the rail was empty.
                changes: this.pendingHunkCount() + this.pendingSuggestionCount(),
                /*
                 * Open findings, which is what is left to triage. Dismissed and
                 * resolved are deliberately excluded and `later` is deliberately
                 * included: parking something does not settle it, and a badge
                 * that dropped it would make the rail look finished while work
                 * was still parked in it.
                 *
                 * Zero until the rail has been opened once, because reading the
                 * run costs a directory walk and nothing should pay for it on
                 * every document that is merely open.
                 */
                quality: this.qualityFindings.filter(finding => finding.status !== 'dismissed').length
            }
        };
    }

    /**
     * Move the body between surfaces, then show the ones this mode uses.
     * Content is transferred through Markdown text in both directions, so a
     * mode switch can never introduce a difference the file would not have.
     */
    setMode(mode) {
        if (mode === this.mode) { return; }
        // Rich is always available; the other two exist only where the project
        // asked for them. Enforced here rather than only in the render, so no
        // caller can put a document into a mode its project does not offer.
        if (mode !== 'rich' && !fileTypeSettings.authoringModesForFile(this.uri)) { return; }
        const body = this.currentBody();
        this.mode = mode;
        if (mode === 'raw' || mode === 'split') { this.sourceEl.value = body; }
        if (mode === 'rich' || mode === 'split') { this.setRichContent(body); }
        this.sourceOfTruth = mode === 'raw' ? 'raw' : 'rich';
        // A mode change genuinely invalidates the floating toolbars — the
        // selection they described belongs to a surface that is going away.
        // A rail toggle does not, which is why this lives here and not in
        // applyMode().
        this.hideBubble();
        this.hideSlash();
        this.hideTableBar();
        this.applyMode();
        if (mode === 'raw' || mode === 'split') { setTimeout(() => this.sourceEl.focus(), 0); }
        else { setTimeout(() => this.editor && this.editor.commands.focus(), 0); }
    }

    /*
     * Layout only. Opening or closing the rail resizes the editor, so the
     * floating toolbars are RE-POSITIONED against the live selection rather
     * than hidden: hiding them here meant every rail render dropped the
     * selection toolbar, including the render during init, which raced a
     * user (or a test) selecting text the moment the document appeared.
     */
    applyMode() {
        this.bodyEl.classList.toggle('mode-rich', this.mode === 'rich');
        this.bodyEl.classList.toggle('mode-split', this.mode === 'split');
        this.bodyEl.classList.toggle('mode-raw', this.mode === 'raw');
        this.railEl.classList.toggle('open', this.railOpen);
        this.renderSegmented();
        this.repositionFloating();
    }

    /*
     * Re-place the floating toolbars that are ALREADY showing, and never
     * reveal one that is not.
     *
     * Opening the rail resizes the editor, so a visible toolbar has to move.
     * But calling updateBubble() unconditionally here made this method
     * resurrect a toolbar that had just been dismissed on purpose — creating a
     * comment hides the bubble and then re-renders the rail, which brought it
     * straight back over a selection the user had finished with. Hiding
     * unconditionally instead is the opposite bug: it dropped the toolbar
     * during the rail render that happens while the document is still loading.
     */
    repositionFloating() {
        if (!this.editor) { return; }
        if (this.bubbleEl && !this.bubbleEl.hidden) { this.updateBubble(); }
        if (this.tableBarEl && !this.tableBarEl.hidden) { this.updateTableBar(); }
    }

    /** The body as it stands in whichever surface the user is driving. */
    currentBody() {
        if (this.mode === 'raw') { return this.sourceEl.value; }
        if (this.mode === 'split' && this.sourceOfTruth === 'raw') { return this.sourceEl.value; }
        return this.editor ? jsonToMarkdown(this.editor.getJSON()) : this.sourceEl.value;
    }

    /** Push a body into the rich surface without it counting as a user edit. */
    setRichContent(body) {
        if (!this.editor) { return; }
        this.internalUpdate = true;
        this.editor.commands.setContent(markdownToHtml(body), false);
        this.internalUpdate = false;
        this.reanchorThreads();
    }

    setBody(body) {
        this.sourceEl.value = body;
        this.setRichContent(body);
    }

    onSourceInput() {
        this.sourceOfTruth = 'raw';
        if (this.readOnly || this.reviewing) { return; }
        this.markDirty();
        if (this.mode !== 'split') { return; }
        clearTimeout(this.splitTimer);
        this.splitTimer = setTimeout(() => {
            // Only mirror while the source pane still owns input, so a
            // switch of focus mid-debounce cannot overwrite what the user
            // has since typed in the rich surface.
            if (this.sourceOfTruth !== 'raw') { return; }
            this.setRichContent(this.sourceEl.value);
        }, SPLIT_SYNC_MS);
    }

    // -- persistence ---------------------------------------------------------

    /*
     * Only real edits reach disk.
     *
     * ProseMirror fires onUpdate for our own transactions too — the re-anchor
     * pass that paints comment highlights is one. That is exactly how an
     * earlier build silently rewrote files merely by opening them. Four gates:
     * the editor must be armed, we must not be mid-review, the transaction
     * must not be ours, and the serialised body must actually differ.
     */
    onDocChanged(transaction) {
        if (!this.armed || this.readOnly || this.reviewing || this.internalUpdate) { return; }
        if (transaction && transaction.getMeta('studio-internal')) { return; }
        if (transaction && !transaction.docChanged) { return; }
        const body = jsonToMarkdown(this.editor.getJSON());
        if (body === this.lastSavedBody) { return; }
        if (this.mode === 'split') { this.sourceEl.value = body; }
        this.markDirty();
    }

    markDirty() {
        if (this.saveState === 'conflict') { return; }   // autosave is paused; see resolveConflict
        /*
         * Suggesting mode diverts HERE, at the one place in this widget that
         * knows the user has just typed something real.
         *
         * Nothing reaches disk on this path. The body in the editor becomes my
         * suggestion instead, and the file stays exactly as it was — which is
         * what makes this a suggestion rather than an edit. The session lock is
         * deliberately not marked dirty either: the document has no unsaved
         * work, I do, and a second tab warning somebody about unsaved edits to a
         * file that is untouched would be a lie.
         */
        if (this.suggestingNow()) {
            this.setSaveState('suggesting');
            clearTimeout(this.suggestTimer);
            this.suggestTimer = setTimeout(() => this.captureSuggestion(), SUGGEST_DELAY_MS);
            return;
        }
        if (this.lock) { this.lock.setDirty(true); }
        this.setSaveState('dirty');
        if (!this.autosave) { return; }
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), AUTOSAVE_DELAY_MS);
    }

    setSaveState(state, detail) {
        this.saveState = state;
        /*
         * D5: re-read the policy on every status update.
         *
         * The autosave toggle used to live in this topbar next to the status,
         * where it stated a second, contradictory fact about persistence --
         * "Read-only" beside "Autosave on". It is a per-project setting you
         * choose once, so it moved to the Projects panel with the other project
         * settings, and this widget no longer owns the control.
         *
         * Not owning the control means it can be changed from elsewhere, so the
         * policy is re-read here rather than cached at open. autosaveForFile is
         * a synchronous read of the already-loaded settings cache, so this is
         * cheap enough to do on every status change and removes the need for an
         * event channel between two widgets.
         */
        this.autosave = fileTypeSettings.autosaveForFile(this.uri);
        const labels = {
            'read-only': 'Read-only',
            clean: 'Saved',
            dirty: this.autosave ? 'Editing…' : 'Unsaved changes',
            saving: 'Saving…',
            saved: 'Saved ' + (detail || timeLabel()),
            /* Not a variant of 'dirty'. "Editing…" would be false: the document
               is not being edited, and nothing here is on its way to disk. */
            suggesting: 'Suggesting…',
            suggested: 'Suggested ' + (detail || timeLabel()),
            conflict: 'Conflict — not saved',
            error: 'Save failed'
        };
        if (this.statusEl) {
            this.statusEl.textContent = labels[state] || state;
            this.statusEl.className = 'studio-doc-status state-' + state;
        }
        /*
         * 'saving' is the ONLY state that gets the dot, and that is the whole
         * rule: it is the only one of the seven that is a wait. 'dirty' reads
         * "Editing…" and is the user typing, not the product working; 'saved'
         * and 'clean' are outcomes. A spinner on any of those would be an
         * indicator that never stops, which is an indicator that says nothing.
         */
        if (this.busyEl) { this.busyEl.hidden = state !== 'saving'; }
        statusLine.setDocumentState(this.uri, state, labels[state] || state);
        if (this.saveBtn) {
            this.saveBtn.hidden = this.autosave || this.readOnly || this.reviewing || this.suggesting ||
                (state !== 'dirty' && state !== 'error' && state !== 'conflict');
        }
        this.updateTopbarVisibility();
        if (this.lock) { this.lock.setDirty(state === 'dirty' || state === 'conflict'); }
    }

    /**
     * Conflict-safe write.
     *
     * Requirement 11 asks autosave to apply "only when the current changes
     * can be saved without overwriting conflicting remote or parallel
     * edits". The check is the file's mtime against the one we last saw: if
     * something else wrote the file since, this save is refused and the user
     * is offered the comparison instead. It is not a distributed lock — it
     * cannot be, in a single-backend prototype — but it does make silent
     * clobbering impossible in the case that actually occurs here.
     */
    async save(options) {
        /*
         * Cmd+S while suggesting flushes the suggestion rather than doing
         * nothing. The keystroke means "commit what I just wrote", and on this
         * path what I just wrote is a suggestion — refusing silently would read
         * as the shortcut being broken.
         */
        if (this.suggestingNow()) {
            clearTimeout(this.suggestTimer);
            await this.captureSuggestion();
            return false;
        }
        if (!this.editor || this.readOnly || !this.armed || this.reviewing) { return false; }
        const force = !!(options && options.force);
        const body = this.currentBody();
        if (body === this.lastSavedBody && !force) { this.setSaveState('clean'); return true; }

        this.setSaveState('saving');
        try {
            if (!force) {
                const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
                if (this.knownMtime !== undefined && stat.mtime !== this.knownMtime) {
                    const disk = await this.fileService.read(this.uri);
                    this.enterConflict(splitFrontmatter(disk.value).body, body, disk.value);
                    return false;
                }
            }
            const written = await this.writeBody(body);
            this.lastSavedBody = body;
            this.setSaveState('saved', timeLabel(new Date(written.mtime).toISOString()));
            await this.historyStore.record(this.uri, {
                kind: 'edit', title: 'Edited ' + this.uri.path.base, detail: 'Manual edit', body
            }).then(entries => { this.historyEntries = entries; if (this.rail === 'history') { this.renderRail(); } });
            void this.checkPurposeOnSave();
            return true;
        } catch (e) {
            console.error('[studio] save failed', e);
            this.setSaveState('error');
            return false;
        }
    }

    /*
     * The save-time pass — purpose only, and only when the rail is open.
     *
     * PLAN §13 is the whole argument: purpose is 68 ms and model-free, so it can
     * follow a save; duplication is 2.1 s behind a ~500 MB reranker, so it
     * cannot, and CONTRACT-runner.md §1 records the correction to the plan's own
     * table. Nothing runs on a keystroke, ever.
     *
     * GATED ON THE RAIL BEING OPEN, which is the difference between a helpful
     * background check and a subprocess spawned on every Cmd+S of every document
     * for a panel nobody is looking at. Fire-and-forget: a save must not wait on
     * a detector, and a detector that fails must not make a successful save look
     * failed.
     */
    async checkPurposeOnSave() {
        if (this.rail !== 'quality' || !this.railOpen) { return; }
        const runner = await this.qualityRunnerState();
        if (!runner || !runner.available || runner.running) { return; }
        try {
            const started = await this.qualityRunner.run(this.qualityRoot, {
                scope: 'document', paths: [this.qualityRelPath], detectors: ['purpose']
            });
            await this.qualityRunner.watch(started && started.runId);
            this.qualityLoaded = false;
            await this.refreshQuality({ quiet: true });
            this.renderRail();
        } catch (e) {
            /* Deliberately quiet. The document saved; the check is a bonus, and
             * a toast about a background pass a person did not ask for would be
             * noise on the one action they DID ask for. The rail's freshness
             * line still tells the truth about when the last check ran. */
            console.warn('[studio] the save-time quality check did not run', e);
        }
    }

    /*
     * Requirement 11's policy switch, exposed where it is decided rather than
     * only in a file: it is a PROJECT setting (it lands in
     * <project>/.studio/settings.json and travels with the repo), but the
     * moment anyone cares about it is while editing a document, so the
     * control lives in the document's topbar.
     */
    async toggleAutosave() {
        const next = !this.autosave;
        this.autosave = next;
        this.setSaveState(this.saveState);
        try {
            await fileTypeSettings.setAutosaveForFile(this.uri, next);
        } catch (e) {
            console.error('[studio] could not persist the autosave policy', e);
            this.messageService.error('Could not save the autosave setting for this project.');
        }
        // Turning autosave back on should not leave an edit stranded.
        if (next && this.saveState === 'dirty') { this.save(); }
    }

    /** The single write path, so `lastWrittenFull` can never miss one. */
    async writeBody(body) {
        const full = joinFrontmatter(this.frontmatter, body);
        this.lastWrittenFull = full;
        const written = await this.fileService.write(this.uri, full);
        this.knownMtime = written.mtime;
        return written;
    }

    // -- conflicts -----------------------------------------------------------

    /*
     * `diskFull` is carried alongside the split body because adopting the
     * incoming version has to update BOTH of the editor's beliefs about the
     * file — its body and the exact bytes it thinks are on disk. Leaving the
     * latter stale made a later external write that happened to match those
     * stale bytes look like the editor's own write, so it was never captured
     * as a proposal.
     */
    enterConflict(diskBody, myBody, diskFull) {
        this.conflict = { diskBody, myBody, diskFull };
        this.setSaveState('conflict');
        this.renderBanners();
        this.messageService.warn(this.uri.path.base + ' changed on disk — your version was not saved.');
    }

    async resolveConflict(choice) {
        if (!this.conflict) { return; }
        const { diskBody, myBody } = this.conflict;
        if (choice === 'compare') {
            this.comparing = { heading: 'On disk → your unsaved version', a: diskBody, b: myBody };
            this.openSlot('changes');
            return;
        }
        if (choice === 'theirs') {
            const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            this.knownMtime = stat.mtime;
            this.setBody(diskBody);
            this.lastSavedBody = diskBody;
            if (this.conflict.diskFull !== undefined) {
                this.frontmatter = splitFrontmatter(this.conflict.diskFull).frontmatter;
                this.lastWrittenFull = this.conflict.diskFull;
            }
            this.conflict = undefined;
            this.comparing = undefined;
            this.setSaveState('clean');
        } else if (choice === 'mine') {
            const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            this.knownMtime = stat.mtime;             // adopt, then overwrite deliberately
            this.conflict = undefined;
            this.comparing = undefined;
            await this.save({ force: true });
        }
        this.renderBanners();
        this.renderRail();
    }

    // -- external changes and proposals --------------------------------------

    /*
     * The AI change loop, requirement 6.
     *
     * Claude Code and Codex cannot hand text back to this widget — neither
     * exposes an API for it (see ai-context.js) — but they CAN edit the file,
     * which is what they are for. So the integration point is the file
     * itself: when the document changes underneath us and it was not our own
     * write, that is a proposal, and it gets held for review rather than
     * applied.
     */
    watchFile() {
        /*
         * `onDidFilesChange` only reports resources something has asked to
         * watch. The workspace root is watched by the file navigator, which
         * this product does not use — so without this explicit watch the
         * event never arrives for a document opened from the Projects
         * browser, and an assistant's write would be discovered only on the
         * next save's mtime check (as a conflict) rather than captured as a
         * proposal.
         */
        try { this.disposables.push(this.fileService.watch(this.uri)); }
        catch (e) { console.warn('[studio] could not watch', this.uri.toString(), e); }
        this.disposables.push(this.fileService.onDidFilesChange(event => {
            if (!event.contains(this.uri, FileChangeType.UPDATED)) { return; }
            // Coalesce: an editor writing a file can emit several events.
            clearTimeout(this.externalTimer);
            this.externalTimer = setTimeout(() => this.onExternalChange(), 120);
        }));

        /*
         * A deliberate belt-and-braces mtime poll.
         *
         * The watcher above is the right mechanism and is kept, but it proved
         * unreliable for this case: whether a change event arrives at all
         * depends on the backend watcher provider and on who else is watching
         * the same path, and a MISSED event here does not degrade gracefully —
         * an assistant's edit would land in the document unreviewed, which is
         * the one outcome the review pipeline exists to prevent. A cheap stat
         * every couple of seconds makes the guarantee not depend on that.
         * A hosted product would get a push event it controls and could drop
         * this.
         */
        this.pollTimer = setInterval(() => this.pollExternalChange(), EXTERNAL_POLL_MS);
    }

    async pollExternalChange() {
        if (!this.editor || this.applyingProposal || this.checkingExternal) { return; }
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
        if (!this.editor || this.applyingProposal) { return; }
        let content;
        let stat;
        try {
            stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            content = await this.fileService.read(this.uri);
        } catch (e) { return; }                    // deleted or unreadable; nothing to capture
        if (content.value === this.lastWrittenFull) {
            // Our own write, echoed back — adopt the timestamp so the poll
            // above does not re-examine the same file forever.
            this.knownMtime = stat.mtime;
            return;
        }

        const split = splitFrontmatter(content.value);
        const diskBody = split.body;
        /*
         * Frontmatter is held verbatim and is not part of a proposal's diff,
         * so an assistant's edit to it is neither applied nor silently kept:
         * restoring the reviewed state reverts it, and the proposal says so
         * rather than leaving the author to notice on their own.
         */
        const frontmatterChanged = split.frontmatter !== this.frontmatter;

        if (this.saveState === 'dirty' || this.saveState === 'conflict') {
            // Genuine collision: the user has unsaved work AND something else
            // wrote the file. That is a conflict to resolve, not a proposal to
            // review — resolving it by silently discarding either side is
            // exactly what requirement 11 forbids.
            this.enterConflict(diskBody, this.currentBody(), content.value);
            return;
        }
        await this.captureProposal(diskBody, frontmatterChanged ? { frontmatterChanged: true } : undefined);
    }

    /**
     * Turn an external body into a pending proposal and put the file back to
     * its reviewed state, so nothing unapproved is ever the live document.
     */
    async captureProposal(proposedBody, meta) {
        /*
         * If I was suggesting, my draft is in the editor and is about to be in
         * the way: the document is going to be held at `base` for review, and
         * the editor has to show that base rather than my unsaved wording.
         *
         * So flush first (the draft becomes my suggestion, on the rail, where it
         * survives) and reset the surface after the write below. Both halves are
         * needed — flushing without resetting leaves my text on screen labelled
         * as the document under review, and resetting without flushing loses it.
         */
        const wasSuggesting = this.suggestingNow();
        if (wasSuggesting) {
            clearTimeout(this.suggestTimer);
            await this.captureSuggestion();
        }

        // The arming context (set when the user asked for the change) and the
        // capture context (discovered when the write arrived) are both real —
        // merge them rather than letting one shadow the other.
        const info = { ...(this.awaitingProposal || {}), ...(meta || {}) };
        this.awaitingProposal = undefined;

        /*
         * A caller that computed the proposal itself must also say what it
         * computed it AGAINST. pasteProposal builds its replacement from the
         * live document, which can differ from the last saved body by an
         * unsaved keystroke — and taking the base from the saved body instead
         * folded that keystroke into the diff as a second, unrelated hunk.
         */
        const base = info.base !== undefined
            ? info.base
            : (this.lastSavedBody !== undefined ? this.lastSavedBody : this.originalBody);
        if (proposedBody === base) { return; }
        this.lastSavedBody = base;              // the base is what is about to be on disk

        const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
        this.knownMtime = stat.mtime;
        await this.writeBody(base);
        if (wasSuggesting) { this.setBody(base); }

        const open = this.proposals.find(p => p.status === 'open');
        if (open) {
            /*
             * One open proposal per file, deliberately. A second assistant
             * pass while a review is in flight extends the SAME proposal
             * rather than stacking a second base on top of a document the
             * first proposal is still describing. Decisions whose hunk no
             * longer exists are dropped, because that hunk is not a thing
             * the user can be said to have decided any more.
             */
            open.proposedBody = proposedBody;
            open.updatedAt = new Date().toISOString();
            if (info.instruction) { open.instruction = info.instruction; open.title = info.instruction; }
            const ids = new Set(diffHunks(open.baseBody, proposedBody).hunks.map(h => h.id));
            for (const id of Object.keys(open.decisions)) { if (!ids.has(id)) { delete open.decisions[id]; } }
        } else {
            this.proposals.push(ChangesStore.proposal({
                title: info.instruction || 'Changes proposed for ' + this.uri.path.base,
                origin: info.origin || 'assistant-file-write',
                instruction: info.instruction || '',
                commentId: info.commentId,
                author: info.author || 'assistant',
                baseBody: base,
                /*
                 * A cross-file move is a cut here and an insert there, and the
                 * two must accept or reject together — half of it deletes a
                 * section from one document without adding it to the other.
                 * `groupId` is undefined for every ordinary proposal and is not
                 * serialised at all in that case, so nothing already on disk
                 * changes shape (PLAN §8, changes-store.js's own group block).
                 */
                groupId: info.groupId,
                groupMembers: info.groupMembers,
                proposedBody
            }));
        }

        if (info.frontmatterChanged) {
            const target = this.openProposal();
            if (target) { target.frontmatterChanged = true; }
        }

        await this.changesStore.save(this.uri, this.proposals);
        const count = this.pendingHunkCount();
        this.historyEntries = await this.historyStore.record(this.uri, {
            kind: 'proposal',
            author: info.author || 'assistant',
            title: info.instruction || 'Proposed changes',
            detail: count + ' change' + (count === 1 ? '' : 's') + ' awaiting review' +
                (info.frontmatterChanged ? ' (frontmatter edits were not applied)' : ''),
            commentId: info.commentId,
            proposalId: (this.proposals.find(p => p.status === 'open') || {}).id
        });

        this.currentHunkIndex = 0;
        this.applyReviewLock();
        this.openSlot('changes');
        this.renderBanners();
        this.messageService.info(count + ' proposed change' + (count === 1 ? '' : 's') + ' ready to review.');
    }

    // -- suggesting mode -----------------------------------------------------

    /** The reviewed state: what is on disk, and the base every suggestion is derived against. */
    reviewedBody() {
        return this.lastSavedBody !== undefined ? this.lastSavedBody : this.originalBody;
    }

    renderSuggestSwitch() {
        if (!this.suggestEl) { return; }
        /*
         * Hidden on a document nobody can change. On a read-only document there
         * is no keystroke to route, so a switch offering to route one is a
         * control that does nothing — and while an assistant proposal holds the
         * document at its base, the answer to "where does my typing go" is
         * "nowhere yet", which the review banner already says.
         */
        const useless = this.readOnly || this.reviewing;
        this.suggestEl.hidden = useless;
        this.suggestEl.innerHTML = useless ? '' : suggestSwitchHtml();
        // This control is one of the three things that decide whether the bar is
        // empty, so showing or hiding it has to re-ask the question.
        this.updateTopbarVisibility();
    }

    /**
     * Follow a mode change, in this document.
     *
     * Two asymmetric jobs, and the asymmetry is the interesting part.
     *
     * Entering Suggesting: if I already have an open suggestion on this
     * document, the editor is seeded with it so I carry on where I left off
     * rather than starting again from the document.
     *
     * Leaving Suggesting: the editor is put back to the document. My draft is
     * not lost — it was written as a suggestion on the last pause, and its card
     * is on the rail — but it must stop being what the editor contains, or the
     * next keystroke would save my suggested text INTO the document as an
     * ordinary edit. That is the one way this mode could silently apply
     * something nobody approved, so the reset is not optional.
     */
    async applySuggestMode() {
        const next = suggestMode.suggesting();
        if (next === this.suggesting) { this.renderSuggestSwitch(); return; }
        clearTimeout(this.suggestTimer);
        if (!next) { await this.captureSuggestion(); }
        this.suggesting = next;
        this.counterTo = undefined;

        const mine = this.mySuggestion();
        if (next) {
            // BEFORE seeding: right now the editor holds the document, and after
            // the next line it may not.
            this.captureSuggestBaseline();
            if (mine) { this.setBody(mine.proposedBody); }
        } else {
            this.setBody(this.reviewedBody());
        }

        this.renderSuggestSwitch();
        this.applyReviewLock();
        // Entering or leaving the mode changes nothing about the document, so
        // there is no transaction for the marks plugin to notice.
        refreshSuggestMarks(this.editor);
        this.setSaveState(next ? 'suggesting' : 'clean');
        this.renderRail();
        this.renderBanners();
    }

    setSuggestMode(mode) {
        suggestMode.set(mode);          // fires onChanged -> applySuggestMode
    }

    mySuggestion() {
        return this.suggestions.find(p => isMine(p.by));
    }

    /**
     * Am I suggesting RIGHT NOW, as distinct from having chosen to.
     *
     * The two come apart when an assistant proposal arrives: that holds the
     * document at its reviewed base and makes the editor read-only, because every
     * hunk under review describes that exact base. My mode is still Suggesting
     * and stays so — it is my standing choice and nothing gets to change it
     * behind my back — but there is no live caret to route, so every behaviour
     * that depends on typing asks THIS rather than the stored flag.
     *
     * The review lock wins because it is the narrower, temporary state; my mode
     * is the broader, persistent one, waiting underneath for it to clear.
     */
    suggestingNow() {
        return this.suggesting && !this.reviewing && !this.readOnly;
    }

    /**
     * The text the live marks are measured against, or undefined for no marks.
     *
     * Read by the ProseMirror plugin on every transaction, so it must be cheap
     * and must not allocate a document. Two sources, preferred in order:
     *
     *   CAPTURED — the editor's own text, taken at a moment when the editor was
     *   holding the document. Exact by construction, because it comes from the
     *   same extraction the plugin uses.
     *
     *   DERIVED — the reviewed body rendered to HTML and reduced to block text.
     *   Needed when the editor has never held the document in this session, which
     *   happens when Suggesting is entered with a suggestion already open and the
     *   editor is seeded with that instead. It matches the captured form because
     *   ProseMirror's top-level blocks correspond to the renderer's top-level
     *   elements, but it is the fallback rather than the first choice precisely
     *   because that correspondence is an assumption and the capture is not.
     */
    suggestBaseline() {
        if (!this.suggestingNow()) { return undefined; }
        const body = this.reviewedBody();
        if (this.baselineBody === body && this.baselineText !== undefined) { return this.baselineText; }
        this.baselineBody = body;
        this.baselineText = plainBlockText(markdownToHtml(body));
        return this.baselineText;
    }

    /**
     * Take the baseline from the editor, which is exact.
     *
     * Called only at the moments the editor is known to hold the document: just
     * before Suggesting seeds it with something else, and just after a decision
     * has written a new document into it.
     */
    captureSuggestBaseline() {
        if (!this.editor) { return; }
        try {
            this.baselineText = collect(this.editor.state.doc).text;
            this.baselineBody = this.reviewedBody();
        } catch (e) {
            // Fall back to the derived form rather than leaving a stale baseline,
            // which would mark text nobody changed.
            this.baselineBody = undefined;
            this.baselineText = undefined;
        }
    }

    /**
     * Write what is in the editor as my suggestion.
     *
     * The base handed to the store is the reviewed body, never the editor's own
     * previous content: a suggestion is the difference between the document and
     * what I think it should say, and computing it against my own last draft
     * would make it the difference between two drafts of mine.
     */
    async captureSuggestion() {
        if (!this.editor || this.isDisposed) { return; }
        const body = this.currentBody();
        const documentBody = this.reviewedBody();
        try {
            await this.changeLog.upsert(this.uri, identity.current(), {
                documentBody,
                proposedBody: body,
                inReplyTo: this.counterTo
            });
        } catch (e) {
            console.error('[studio] could not record the suggestion', e);
            this.messageService.error('Could not save your suggestion.');
            this.setSaveState('error');
            return;
        }
        await this.reloadSuggestions();
        if (this.suggestingNow()) { this.setSaveState('suggested'); }
    }

    async reloadSuggestions() {
        try {
            const loaded = await this.changeLog.load(this.uri);
            this.suggestions = loaded.proposals;
            this.rejections = loaded.rejections;
        } catch (e) {
            console.warn('[studio] could not read suggestions', e);
        }
        if (this.isDisposed) { return; }
        // A suggestion can be withdrawn or accepted from under the focused index,
        // by me here or by its author in another window.
        const total = this.orderedEntries().length;
        if (this.currentHunkIndex !== undefined && this.currentHunkIndex >= total) {
            this.currentHunkIndex = total ? total - 1 : 0;
        }
        this.renderTracked();
        this.renderRail();
        this.renderBanners();
    }

    /**
     * Every change on the document that a card can be drawn for, from both
     * stores, with an author slot each.
     *
     * Slots are assigned in order of first appearance so they are stable within
     * a render and shared by the document and the rail — which is what lets a
     * reader pair a dashed mark with a dashed card without clicking either.
     */
    trackedEntries() {
        const documentBody = this.reviewedBody();
        const slots = new Map();
        const slotFor = author => {
            const key = authorRecord(author).id;
            if (!slots.has(key)) { slots.set(key, slots.size % AUTHOR_SLOTS.length); }
            return slots.get(key);
        };

        const entries = [];
        const assistant = this.openProposal();
        if (assistant) {
            /* The assistant path keys verdicts by the positional hunk id, and
               its base is held still for exactly that reason, so `ref` is the
               id. Suggestions key by content — see change-log.js. */
            for (const hunk of this.proposalHunks(assistant)) {
                entries.push({
                    hunk, ref: hunk.id, proposalId: assistant.id, proposal: assistant,
                    slot: slotFor(assistant.by || assistant.author),
                    decision: assistant.decisions[hunk.id],
                    createdAt: assistant.createdAt
                });
            }
        }
        for (const suggestion of this.suggestions) {
            for (const hunk of suggestionHunks(suggestion, documentBody, this.rejections)) {
                entries.push({
                    hunk, ref: hunk.key, proposalId: suggestion.id, proposal: suggestion,
                    slot: slotFor(suggestion.by),
                    decision: hunk.rejected ? 'rejected' : undefined,
                    createdAt: suggestion.createdAt,
                    conflicted: hunk.conflicted,
                    mine: isMine(suggestion.by),
                    replyTo: suggestion.inReplyTo
                });
            }
        }
        return entries;
    }

    /** Unanswered suggestion hunks, for the rail count and the banner. */
    pendingSuggestionCount() {
        const documentBody = this.reviewedBody();
        return this.suggestions.reduce((sum, p) =>
            sum + suggestionHunks(p, documentBody, this.rejections).filter(h => !h.rejected).length, 0);
    }

    /**
     * Answer one suggested change.
     *
     * Accept and reject are asymmetric, and that follows from a suggestion
     * having no stored base: accepting writes the text into the document, after
     * which the change is simply absent from the next derivation and needs no
     * record. Rejecting has to be REMEMBERED by content key, or the change
     * reappears on the next render. See change-log.js.
     */
    async decideSuggestion(proposalId, key, verdict) {
        const suggestion = this.suggestions.find(p => p.id === proposalId);
        if (!suggestion) { return; }
        const documentBody = this.reviewedBody();
        const hunks = suggestionHunks(suggestion, documentBody, this.rejections);
        const hunk = hunks.find(h => h.key === key);
        if (!hunk) { return; }
        /*
         * A conflicted hunk edits text that is no longer in the document, so
         * there is nothing to apply it to — accepting it would write the author's
         * lines at whatever position the search failed to find. Dismissal is the
         * only honest answer, and the card says so.
         */
        if (hunk.conflicted && verdict === 'accepted') {
            this.messageService.warn('That suggestion no longer matches the document. ' +
                'Its author will need to make it again.');
            return;
        }

        if (verdict === 'rejected') {
            try {
                this.rejections = await this.changeLog.reject(this.uri, key, true);
            } catch (e) {
                console.error('[studio] could not record the rejection', e);
                this.messageService.error('Could not dismiss that suggestion.');
                return;
            }
        } else {
            const body = applyHunks(documentBody, hunks, [hunk.id]);
            const written = await this.writeDecidedBody(body);
            if (!written) { return; }
        }

        this.historyEntries = await this.historyStore.record(this.uri, {
            kind: verdict === 'accepted' ? 'accept' : 'reject',
            author: identity.displayName(),
            title: (verdict === 'accepted' ? 'Accepted' : 'Dismissed') + ' a suggestion from ' +
                authorRecord(suggestion.by).name,
            detail: changeSummaryText(hunk),
            proposalId,
            body: verdict === 'accepted' ? this.reviewedBody() : undefined
        });
        await this.reloadSuggestions();
        this.setSaveState(verdict === 'accepted' ? 'saved' : this.saveState);
    }

    /** Take back my own answer, so the change is unanswered again. */
    async reopenSuggestion(key) {
        try {
            this.rejections = await this.changeLog.reject(this.uri, key, false);
        } catch (e) {
            console.error('[studio] could not undo that decision', e);
            return;
        }
        await this.reloadSuggestions();
    }

    /**
     * Write a body that a decision produced.
     *
     * Goes through the same applyingProposal guard the assistant path uses, so
     * our own write is not read back by the external-change watcher and
     * re-proposed to us.
     */
    async writeDecidedBody(body) {
        this.applyingProposal = true;
        try {
            this.setBody(body);
            await this.writeBody(body);
            this.lastSavedBody = body;
            // The editor now holds the new document, which is the one moment the
            // baseline can be taken exactly rather than derived.
            this.captureSuggestBaseline();
            return true;
        } catch (e) {
            console.error('[studio] could not apply the suggestion', e);
            this.messageService.error('Could not write the accepted suggestion.');
            return false;
        } finally {
            this.applyingProposal = false;
        }
    }

    /**
     * Answer somebody's suggestion with one of my own.
     *
     * Their wording becomes the STARTING POINT for mine, and their suggestion is
     * left open and undecided. Nothing they wrote is altered — which is the same
     * rule this repository already holds for a person's comment, applied to a
     * proposal. The reviewer then has both cards and decides between them.
     */
    async counterSuggest(proposalId) {
        const theirs = this.suggestions.find(p => p.id === proposalId);
        if (!theirs) { return; }
        if (isMine(theirs.by)) { return; }          // revising my own is what typing does
        clearTimeout(this.suggestTimer);
        this.counterTo = proposalId;
        if (!suggestMode.suggesting()) {
            // Sets this.suggesting through the listener, and would seed the
            // editor from my existing suggestion -- so seed from theirs after.
            suggestMode.set(suggestMode.SUGGEST);
        }
        this.suggesting = true;
        this.setBody(theirs.proposedBody);
        await this.captureSuggestion();
        this.renderSuggestSwitch();
        this.messageService.info('Editing ' + authorRecord(theirs.by).name +
            '\u2019s suggestion as your own. Theirs stays open.');
        setTimeout(() => this.editor && this.editor.commands.focus(), 0);
    }

    /** Withdraw my own suggestion. A reviewer dismisses; only the author withdraws. */
    async withdrawSuggestion(proposalId) {
        const mine = this.suggestions.find(p => p.id === proposalId);
        if (!mine || !isMine(mine.by)) { return; }
        try {
            await this.changeLog.withdraw(this.uri, identity.current(), proposalId);
        } catch (e) {
            console.error('[studio] could not withdraw the suggestion', e);
            return;
        }
        if (this.counterTo === proposalId) { this.counterTo = undefined; }
        if (this.suggestingNow()) { this.setBody(this.reviewedBody()); }
        await this.reloadSuggestions();
    }

    openProposal() { return this.proposals.find(p => p.status === 'open'); }

    proposalHunks(proposal) {
        if (!proposal) { return []; }
        return diffHunks(proposal.baseBody, proposal.proposedBody).hunks;
    }

    pendingHunkCount() {
        const p = this.openProposal();
        return p ? countPending(this.proposalHunks(p), p.decisions) : 0;
    }

    /*
     * While a proposal is open the document is review-only.
     *
     * A proposal is a diff against a recorded base. Allowing free edits
     * during review would move the document out from under that base, so
     * every hunk the user was reading would silently describe a document
     * that no longer exists. Deciding the changes — or rejecting them all —
     * releases the lock.
     */
    /*
     * Whether the tracked document is what this widget is currently showing.
     *
     * Three things have to be true, and each is a separate fact: the project
     * asked for this style, there is something to review, and the document
     * survived the fidelity check. The last one matters — a read-only document
     * is one this product cannot round-trip through Markdown, so rendering it
     * as a tracked document would be showing a reader a version of their file
     * that the product has already admitted it gets wrong. Those documents keep
     * the diff queue, which quotes source lines verbatim and claims nothing.
     */
    trackedActive() {
        /*
         * Four facts, each separate.
         *
         * The project asked for this style; something is waiting to be reviewed;
         * the document survived the fidelity check (a document this product
         * cannot round-trip through Markdown must not be shown as a tracked
         * version of itself — those keep the diff queue, which quotes source
         * lines verbatim and claims nothing); and I am not myself suggesting.
         *
         * That last one is a real limitation rather than a nicety. While I am
         * suggesting I need a live caret, and the tracked page is not editable —
         * so my own typing surface wins and other people's suggestions are
         * visible on the rail as cards but not marked up in the prose. Docs shows
         * both at once; doing that here needs the marks to be part of the editor
         * model rather than a second rendering of it.
         */
        if (this.reviewStyle !== 'inline' || this.readOnly || this.suggestingNow()) { return false; }
        return !!this.openProposal() || this.suggestions.length > 0;
    }

    /**
     * Paint the tracked document, or put the editor back.
     *
     * Called from applyReviewLock rather than from the rail render, because
     * which surface the document shows is a property of the review LOCK, not of
     * which rail happens to be open — the marked-up document must be there when
     * the reviewer closes the rail entirely.
     */
    renderTracked() {
        const active = this.trackedActive();
        this.bodyEl.classList.toggle('tracked-review', active);
        if (!this.trackedEl) { return; }
        this.trackedEl.hidden = !active;
        if (!active) {
            // Dropped rather than left in place: it is a snapshot of a proposal
            // that no longer exists, and keeping it would let a later reveal
            // flash the previous review before the new one renders.
            this.trackedEl.innerHTML = '';
            return;
        }
        /*
         * One base, every author. The reviewed body is the base for both stores:
         * while an assistant proposal is open the document is held AT its base,
         * so the two coincide, and a suggestion is derived against the live
         * document by definition.
         */
        this.trackedEl.innerHTML = trackedHtml(this.reviewedBody(), this.trackedEntries(), markdownToHtml);
        this.highlightTracked();
    }

    /**
     * The document's changes in the order they appear in it, which is the order
     * the rail lists them and the order the arrows step through.
     *
     * One ordering, computed in one place, because three surfaces index into it.
     * `orderEntries` also flags the entries that cannot be drawn — two authors
     * editing the same lines — so the rail can say why a card has no mark.
     */
    orderedEntries() {
        return orderEntries(this.trackedEntries());
    }

    /**
     * Mark the change under review in the document, to the same index the rail
     * highlights. One attribute rather than a class, so the CSS can carry the
     * ring on the mark without a second class name to keep in step.
     */
    highlightTracked(scroll) {
        if (!this.trackedEl || this.trackedEl.hidden) { return; }
        const entries = this.orderedEntries();
        const current = entries[this.currentHunkIndex === undefined ? 0 : this.currentHunkIndex];
        for (const mark of this.trackedEl.querySelectorAll('.studio-tc')) {
            mark.removeAttribute('data-current');
        }
        if (!current) { return; }
        /* Both halves of the address: two authors can propose textually
           identical edits, and they are still two decisions. */
        const marks = this.trackedEl.querySelectorAll(
            '[data-hunk="' + current.ref + '"][data-proposal="' + current.proposalId + '"]');
        marks.forEach(mark => mark.setAttribute('data-current', 'true'));
        if (scroll && marks[0]) { marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }

    /**
     * Make one change the current one, from either side of the pairing.
     *
     * The document and the rail are two views of one list, so selecting in
     * either has to move the other — a reviewer who clicks a struck-through
     * sentence is asking "what is this?", and the answer is the card.
     */
    focusChange(ref, proposalId, { fromDocument = false } = {}) {
        const entries = this.orderedEntries();
        const index = entries.findIndex(entry =>
            entry.ref === ref && (!proposalId || entry.proposalId === proposalId));
        if (index === -1) { return; }
        this.currentHunkIndex = index;
        this.highlightTracked(!fromDocument);
        this.highlightCurrentCard(fromDocument);
    }

    /** The rail side of focusChange, and of stepHunk in this style. */
    highlightCurrentCard(scroll) {
        const cards = [...this.listEl.querySelectorAll('.studio-change-card')];
        cards.forEach((card, i) => card.classList.toggle('current', i === this.currentHunkIndex));
        if (!scroll) { return; }
        const card = cards[this.currentHunkIndex];
        if (card) { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }

    applyReviewLock() {
        const wasReviewing = this.reviewing;
        this.reviewing = !!this.openProposal();
        const editable = !this.readOnly && !this.reviewing;
        // Only on a real change: ProseMirror re-applies contenteditable when
        // setEditable is called, and the browser drops the DOM selection when
        // it does — so calling this unconditionally (as the end of init did)
        // silently wiped a selection the user had just made.
        if (this.editor && this.editor.isEditable !== editable) { this.editor.setEditable(editable); }
        this.sourceEl.readOnly = this.readOnly || this.reviewing;
        // After the lock, not before: renderTracked reads openProposal() and
        // this.readOnly, and showing the tracked document while the editor is
        // still editable would put an accept/reject surface over a live caret.
        this.renderTracked();
        this.renderSuggestSwitch();
        if (wasReviewing !== this.reviewing) { this.setSaveState(this.saveState); }
    }

    async decideHunk(hunkId, verdict) {
        const proposal = this.openProposal();
        if (!proposal) { return; }
        this.decisionJournal.push({ proposalId: proposal.id, hunkId, previous: proposal.decisions[hunkId] });
        proposal.decisions[hunkId] = verdict;
        await this.applyProposal(proposal, { hunkId, verdict });
    }

    async undoLastDecision() {
        const last = this.decisionJournal.pop();
        if (!last) { return; }
        const proposal = this.proposals.find(p => p.id === last.proposalId);
        if (!proposal) { return; }
        if (last.previous === undefined) { delete proposal.decisions[last.hunkId]; }
        else { proposal.decisions[last.hunkId] = last.previous; }
        proposal.status = 'open';
        await this.applyProposal(proposal, { undo: true });
    }

    /**
     * Put one decided change back to undecided.
     *
     * Distinct from undoLastDecision, which is a stack pop: this one names the
     * change, because a tracked-changes card sits beside its own change and its
     * undo button therefore promises to undo that one. The journal entries for
     * this hunk are dropped rather than kept, since a later stack pop would
     * otherwise restore a decision the user has already retracted here.
     *
     * A resolved proposal is reopened, which is what makes the accepted text
     * reviewable again — decideHunk cannot be reached on a resolved one.
     */
    async reopenChange(hunkId) {
        const proposal = this.proposals.find(p => p.decisions && p.decisions[hunkId] !== undefined);
        if (!proposal) { return; }
        delete proposal.decisions[hunkId];
        this.decisionJournal = this.decisionJournal.filter(entry => entry.hunkId !== hunkId);
        proposal.status = 'open';
        await this.applyProposal(proposal, { undo: true });
    }

    async decideAll(verdict) {
        const proposal = this.openProposal();
        if (!proposal) { return; }
        for (const hunk of this.proposalHunks(proposal)) {
            if (proposal.decisions[hunk.id]) { continue; }
            this.decisionJournal.push({ proposalId: proposal.id, hunkId: hunk.id, previous: undefined });
            proposal.decisions[hunk.id] = verdict;
        }
        await this.applyProposal(proposal, { bulk: verdict });
    }

    /** Compose base + accepted hunks, write it, and record what happened. */
    async applyProposal(proposal, event) {
        const hunks = this.proposalHunks(proposal);
        const accepted = hunks.filter(h => proposal.decisions[h.id] === 'accepted').map(h => h.id);
        const body = applyHunks(proposal.baseBody, hunks, accepted);

        this.applyingProposal = true;
        try {
            this.setBody(body);
            await this.writeBody(body);
            this.lastSavedBody = body;
        } catch (e) {
            console.error('[studio] could not apply the change', e);
            this.messageService.error('Could not write the accepted change.');
        } finally {
            this.applyingProposal = false;
        }

        const settled = hunks.every(h => proposal.decisions[h.id]);
        proposal.status = settled ? 'resolved' : 'open';
        // A resolved proposal stays in memory so undoLastDecision() can bring
        // it back; only the sidecar drops it (ChangesStore.save filters), so a
        // reload starts clean while this session can still step backwards.
        await this.changesStore.save(this.uri, this.proposals);

        if (!event.undo) {
            const kind = event.bulk === 'rejected' || event.verdict === 'rejected' ? 'reject' : 'accept';
            this.historyEntries = await this.historyStore.record(this.uri, {
                kind,
                title: event.bulk
                    ? (event.bulk === 'accepted' ? 'Accepted all proposed changes' : 'Rejected all proposed changes')
                    : (event.verdict === 'accepted' ? 'Accepted a proposed change' : 'Rejected a proposed change'),
                detail: proposal.instruction || proposal.title,
                proposalId: proposal.id,
                commentId: proposal.commentId,
                hunkId: event.hunkId,
                body
            });
        }

        this.applyReviewLock();
        this.setSaveState('saved');
        this.renderRail();
        this.renderBanners();
        this.renderSegmented();
        this.refreshPendingFiles();

        if (settled && proposal.commentId) { this.offerCommentResolution(proposal.commentId); }
        if (settled && proposal.groupId) { await this.settleGroup(proposal); }
    }

    /*
     * The other half of a linked move, resolved the same way this half was.
     *
     * A move is a cut in one document and an insert in another; half of it
     * deletes a section without adding it anywhere. So when this side settles,
     * the rest of the group follows — through changes-store.js's `resolveGroup`,
     * which validates every remaining member against its own base BEFORE
     * writing anything and refuses the lot if one has moved underneath.
     *
     * MIXED DECISIONS ARE REFUSED RATHER THAN GUESSED AT. Per-hunk review is
     * the right granularity for an assistant's edit and the wrong one for a
     * move: "accept the deletion but not the insertion" is not a coherent
     * outcome, and picking one of the two verdicts on the reviewer's behalf
     * would be this feature quietly deciding something about their document.
     * The other half stays open, which `proposalsInGroup` reports as `partial`,
     * and the message says what to do about it.
     */
    async settleGroup(proposal) {
        const decisions = Object.values(proposal.decisions || {});
        const uniform = decisions.length && decisions.every(d => d === decisions[0]);
        if (!uniform) {
            this.messageService.warn('A linked move has to be accepted or rejected as a whole. ' +
                'The other document still has its half of this change waiting.');
            return;
        }
        try {
            const result = await resolveGroup({
                fileService: this.fileService, changesStore: this.changesStore,
                historyStore: this.historyStore, anyUri: this.uri, groupId: proposal.groupId,
                verdict: decisions[0], splitFrontmatter, joinFrontmatter
            });
            await this.refreshPendingFiles();
            /* `ok: false` is a REFUSAL, not a crash: resolveGroup validated every
             * remaining member first and wrote nothing. Say which document and
             * why, because the reviewer is the only one who can decide what to
             * do about a document that moved underneath the plan. */
            if (result && result.ok === false) {
                this.messageService.warn('The linked half of this change was not applied — ' + result.why);
            }
        } catch (e) {
            console.error('[studio] could not resolve the linked half of this change', e);
            this.messageService.error('The other document could not be updated, so this move is only half applied. ' +
                'Open it to finish or undo it.');
        }
    }

    /*
     * Requirement 10's audit link: a proposal that came from a comment
     * finishes by offering to close that comment, and records the connection
     * either way rather than leaving the thread silently stale.
     */
    offerCommentResolution(commentId) {
        const thread = this.threads.find(t => t.id === commentId);
        if (!thread || thread.resolved) { return; }
        thread.pendingResolution = true;
        this.openSlot('comments');
    }

    async refreshPendingFiles() {
        try {
            const status = await this.changesStore.pendingFilesStatus(this.uri);
            this.pendingFiles = status.files;
            this.pendingFilesAvailable = status.available;
        } catch (e) {
            this.pendingFiles = [];
            this.pendingFilesAvailable = false;
        }
        this.renderSegmented();
        if (this.rail === 'changes' && this.railOpen) { this.renderRail(); }
    }

    /** Requirement 12's global decision, across every file with pending work. */
    async decideAllFiles(verdict) {
        const files = this.pendingFiles.slice();
        let total = 0;
        for (const file of files) {
            if (file.uri.toString() === this.uri.toString()) { continue; }
            const open = openEditors.get(file.uri.toString());
            if (open && open !== this) {
                // Decide it in its own editor — see openEditors above.
                total += open.pendingHunkCount();
                try { await open.decideAll(verdict); }
                catch (e) { console.error('[studio] could not resolve the open editor for', file.path, e); }
                continue;
            }
            try {
                const result = await resolveFile({
                    fileService: this.fileService, changesStore: this.changesStore,
                    historyStore: this.historyStore, uri: file.uri, verdict,
                    splitFrontmatter, joinFrontmatter
                });
                total += result.hunks;
            } catch (e) {
                console.error('[studio] could not resolve', file.path, e);
                this.messageService.error('Could not resolve pending changes in ' + file.path + '.');
            }
        }
        await this.decideAll(verdict);
        await this.refreshPendingFiles();
        if (total) {
            this.messageService.info((verdict === 'accepted' ? 'Accepted' : 'Rejected') +
                ' ' + total + ' change' + (total === 1 ? '' : 's') + ' in other files.');
        }
    }

    // -- session lock --------------------------------------------------------

    async claimSession() {
        this.lock = new SessionLock(this.uri, {
            onYieldRequested: () => {
                // Another tab took the file. Stop writing from here rather
                // than racing it, and say so plainly.
                this.yielded = true;
                this.readOnly = true;
                this.readOnlyReason = 'another tab took over this document';
                if (this.editor) { this.editor.setEditable(false); }
                this.sourceEl.readOnly = true;
                clearTimeout(this.saveTimer);
                this.setSaveState('read-only');
                this.renderBanners();
            },
            onOtherClosed: () => {
                if (!this.duplicateSession) { return; }
                this.duplicateSession = undefined;
                this.renderBanners();
            }
        });
        this.duplicateSession = await this.lock.claim();
        if (this.duplicateSession) { this.renderBanners(); }
    }

    resolveDuplicate(choice) {
        if (choice === 'switch') {
            this.lock.focusOther();
            this.messageService.info('Asked the other tab to come forward.');
            return;
        }
        if (choice === 'takeover') { this.lock.takeOver(); }
        // 'resume' simply dismisses: both tabs stay open, and the mtime check
        // in save() is what stops the later save from clobbering the earlier.
        this.duplicateSession = undefined;
        this.renderBanners();
    }

    // -- banners -------------------------------------------------------------

    renderBanners() {
        const banners = [];

        if (this.duplicateSession) {
            banners.push({
                tone: 'warn',
                html: '<b>This document is already open in another tab.</b> ' +
                    (this.duplicateSession.dirty
                        ? 'That tab has unsaved edits. Continuing here risks losing them.'
                        : 'That tab has no unsaved edits.') +
                    ' <button class="studio-btn" data-act="dup-switch">Go to that tab</button>' +
                    ' <button class="studio-btn" data-act="dup-resume">Keep both open</button>' +
                    ' <button class="studio-btn" data-act="dup-takeover">Take over here</button>'
            });
        }
        if (this.yielded) {
            banners.push({ tone: 'block', html: '<b>Taken over elsewhere.</b> Another tab is now editing this document. Close and reopen this one to continue here.' });
        }
        if (this.conflict) {
            banners.push({
                tone: 'block',
                html: '<b>This file changed on disk while you were editing.</b> Autosave is paused so neither version is lost. ' +
                    '<button class="studio-btn" data-act="conflict-compare">Compare</button>' +
                    ' <button class="studio-btn" data-act="conflict-mine">Keep mine</button>' +
                    ' <button class="studio-btn" data-act="conflict-theirs">Take theirs</button>'
            });
        }
        const proposal = this.openProposal();
        if (proposal) {
            const pending = this.pendingHunkCount();
            banners.push({
                tone: 'info',
                html: '<b>' + escapeHtml(proposal.title) + '</b> — ' + pending + ' change' + (pending === 1 ? '' : 's') +
                    ' awaiting your review. ' +
                    (this.trackedActive()
                        /* The tracked document is not the file. Saying so here is
                           the whole reason this banner has a second sentence: a
                           reader looking at struck-through text they did not
                           write needs to know that nothing on disk says that. */
                        ? 'They are shown in the document below; the file on disk is still at its reviewed state. '
                        : 'The file is held at its reviewed state and editing is paused until you decide. ') +
                    '<button class="studio-btn" data-act="rail-changes">Review</button>' +
                    ' <button class="studio-btn" data-act="accept-all">Accept all</button>' +
                    ' <button class="studio-btn" data-act="reject-all">Reject all</button>'
            });
        }
        /*
         * Suggestions get a banner only when somebody ELSE is waiting on me.
         * My own suggestion needs no announcement — the topbar already says I am
         * suggesting, and a banner telling me about my own typing is noise on
         * every keystroke.
         */
        const suggestedByOthers = this.suggestions.filter(p => !isMine(p.by));
        const waiting = suggestedByOthers.length ? this.pendingSuggestionCount() : 0;
        if (waiting) {
            const names = [...new Set(suggestedByOthers.map(p => authorRecord(p.by).name))];
            banners.push({
                tone: 'info',
                html: '<b>' + escapeHtml(names.join(', ')) + '</b> suggested ' + waiting +
                    ' change' + (waiting === 1 ? '' : 's') + '. The document is unchanged until you accept them. ' +
                    '<button class="studio-btn" data-act="rail-changes">Review</button>'
            });
        }
        /*
         * The banner teaches the mode ONCE and then stops.
         *
         * Its job is to explain a consequence that is not obvious the first time:
         * the file is not changing. Once there is a card with your name on it the
         * consequence has been demonstrated, and a permanent banner restating it
         * on every keystroke is what made this mode feel noisy. The pill and the
         * status carry the state from then on.
         */
        if (this.suggestingNow() && !this.mySuggestion()) {
            banners.push({
                tone: 'note',
                html: 'Suggesting · What you type is recorded for review, and this file is not changed.'
            });
        }
        if (this.readOnly && !this.yielded) {
            banners.push({
                tone: 'block',
                html: '<b>Read-only</b> &mdash; ' + escapeHtml(this.readOnlyReason || 'unsupported Markdown') +
                    '. Saving would rewrite this file lossily. Unlock only if you intend to review the change as a diff ' +
                    'before committing. <button class="studio-btn" data-act="unlock">Edit anyway</button>'
            });
        } else if (this.willReformat) {
            banners.push({
                tone: 'note',
                html: 'Formatting will normalize on save · No content is lost.'
            });
        }

        this.bannersEl.innerHTML = banners.map(b =>
            '<div class="studio-doc-banner ' + b.tone + '">' + b.html + '</div>').join('');
    }

    /*
     * Deliberate override of the fidelity gate. The safety net is then the Git
     * diff: nothing here is committed without the author seeing it in Source
     * Control first.
     */
    unlock() {
        this.readOnly = false;
        this.unlocked = true;
        this.willReformat = false;
        this.applyReviewLock();
        this.setSaveState('clean');
        this.renderBanners();
    }

    // -- gutter marks ---------------------------------------------------------

    /*
     * A mark in the document's left margin for every unresolved anchored
     * thread. Resolved work is intentionally absent from the active selection;
     * the archived quote becomes visible only after a reviewer opens it.
     *
     * Cheap on purpose: reanchorThreads() already applies a ProseMirror mark
     * that renders as span.studio-comment-mark[data-comment-id], so the
     * vertical position of a thread is just that element's offsetTop. No
     * coordsAtPos, no position bookkeeping, and it follows reflow for free
     * because it is read from laid-out DOM.
     *
     * Document-scope threads get no mark: they are not anchored to a line, and
     * inventing a position for them would be a lie. They stay in the rail's
     * "On the document" section.
     */
    renderGutter() {
        if (!this.gutterEl) { return; }
        /*
         * Nothing to anchor to while the tracked review is showing: the editor
         * page is display:none, so every mark's offsetTop reads 0 and all of
         * them would be placed at the top of a document nobody is looking at.
         * Clearing is safe because the ResizeObserver below fires when the page
         * comes back (display:none reports a 0x0 box), which re-renders them
         * against the real layout.
         */
        if (this.mode === 'raw' || !this.editor || this.trackedActive()) { this.gutterEl.innerHTML = ''; return; }

        const root = this.editor.view.dom;
        const marks = [];
        for (const th of this.threads) {
            if (th.scope === 'document' || th.orphaned) { continue; }
            const el = root.querySelector('.studio-comment-mark[data-comment-id="' + th.id + '"]');
            if (!el) { continue; }
            const revealResolved = th.resolved && th.id === this.openResolvedThreadId;
            el.classList.toggle('studio-comment-resolved', th.resolved && !revealResolved);
            if (th.resolved) { continue; }
            // offsetTop is relative to the nearest positioned ancestor, which
            // is the page; the gutter shares that origin, so no conversion.
            marks.push({ id: th.id, top: el.offsetTop });
        }

        // Two threads on the same line would stack on top of each other; nudge
        // the later one down so both stay clickable.
        marks.sort((a, b) => a.top - b.top);
        let lastTop = -Infinity;
        this.gutterEl.innerHTML = marks.map(m => {
            const top = Math.max(m.top, lastTop + GUTTER_MIN_GAP);
            lastTop = top;
            const active = m.id === this.activeThreadId;
            return '<button class="studio-gutter-mark' +
                (active ? ' active' : '') + '" data-gutter-thread="' + m.id +
                '" style="top:' + top + 'px" title="' +
                'Open comment" aria-label="Open comment"></button>';
        }).join('') + this.qualityGutterHtml(root, lastTop);
    }

    /*
     * Quality findings in the same gutter, and deliberately in the same gutter.
     *
     * A second margin strip would say the two kinds of mark are different kinds
     * of thing; they are not — both are "there is something to look at on this
     * line", and a reviewer scanning a document should be able to read one
     * column rather than two. They are told apart by treatment, not by position:
     * a comment mark is a filled dot, a finding is a hollow one.
     *
     * Read off laid-out DOM exactly as the comment marks are, for the same
     * reason — the decoration plugin has already put a span at the right place,
     * so a mark's vertical position is that element's offsetTop and no position
     * bookkeeping is needed. It follows reflow for free.
     */
    qualityGutterHtml(root, floor) {
        if (!this.qualityFindings.length) { return ''; }
        const marks = [];
        const seen = new Set();
        for (const el of root.querySelectorAll('[data-quality]')) {
            const fingerprint = el.getAttribute('data-quality');
            if (!fingerprint || seen.has(fingerprint)) { continue; }
            seen.add(fingerprint);
            marks.push({ fingerprint, top: el.offsetTop });
        }
        marks.sort((a, b) => a.top - b.top);
        let lastTop = floor;
        return marks.map(mark => {
            const top = Math.max(mark.top, lastTop + GUTTER_MIN_GAP);
            lastTop = top;
            const active = mark.fingerprint === this.activeFinding;
            return '<button class="studio-gutter-mark studio-gutter-quality' +
                (active ? ' active' : '') + '" data-act="quality-focus" data-fp="' +
                mark.fingerprint + '" style="top:' + top + 'px" ' +
                'title="Open this finding" aria-label="Open this finding"></button>';
        }).join('');
    }

    scrollThreadIntoView(id) {
        const el = this.listEl.querySelector('[data-thread="' + id + '"]');
        if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }

    // -- the single right slot -----------------------------------------------

    /**
     * THE choke point for what occupies the right of the window.
     *
     * Every path that opens a rail or an assistant goes through here, because
     * the invariant -- exactly one occupant -- cannot be maintained by callers
     * that each set two independent flags.
     *
     * toggle=true (the selector itself): picking the current occupant closes
     * the slot entirely and gives the width back to the document.
     * toggle=false (a banner's "Review", clicking a comment mark): the caller
     * is asking to SHOW something specific, and must never close it instead --
     * a Review button that hid the review would be a bug, not a toggle.
     */
    selectSlot(key, { toggle = true } = {}) {
        // From here on the user has an opinion about the slot, so the startup
        // guard in watchRightPanel steps aside.
        this.slotChosen = true;
        const assistant = assistantForKey(key);

        if (assistant) {
            if (toggle && this.assistant === key) { this.closeSlot(); return; }
            this.assistant = key;
            this.railOpen = false;          // our rail yields the slot
            this.applyMode();
            this.renderRail();
            this.revealAssistant(assistant);
            return;
        }

        if (toggle && this.rail === key && this.railOpen) { this.closeSlot(); return; }
        this.rail = key;
        this.railOpen = true;
        this.assistant = undefined;
        this.collapseRightPanel();          // Theia's panel yields the slot
        if (key === 'changes') { this.pendingFilesAvailable = undefined; }
        this.applyMode();
        this.renderRail();
        if (key === 'changes') { void this.refreshPendingFiles(); }
    }

    /** Show this occupant; never interpret the call as "close it". */
    openSlot(key) { this.selectSlot(key, { toggle: false }); }

    closeSlot() {
        this.railOpen = false;
        this.assistant = undefined;
        this.collapseRightPanel();
        this.applyMode();
        this.renderRail();
    }

    /*
     * Reveal an assistant's view container.
     *
     * revealWidget cannot reveal what the shell has not built, and these
     * containers are created lazily by the plugin host, so the extension's own
     * open command runs first on a cold slot. After that the cheap shell call
     * is enough, and it is preferred because it neither steals focus from the
     * document nor re-runs the extension's wiring.
     */
    async revealAssistant(assistant) {
        const ok = await revealAssistant({
            shell: this.shell, commandRegistry: this.commandRegistry,
            messageService: this.messageService, key: assistant.key
        });
        // Do not leave the selector claiming an occupant that never arrived.
        if (!ok && this.assistant === assistant.key) { this.assistant = undefined; this.renderSegmented(); }
    }

    collapseRightPanel() { collapseRightPanel(this.shell); }

    /*
     * Keep the selector honest when the user works Theia's own chrome.
     *
     * The right panel can be opened or collapsed without touching our
     * selector -- the activity-bar icon, or clicking the active tab to
     * collapse it. ApplicationShell has no expansion event; the Lumino tab bar
     * signal is the real hook, and it fires for both user and programmatic
     * paths because both funnel through tabBar.currentTitle. A null
     * currentTitle IS the collapsed state.
     *
     * args.currentTitle is checked rather than shell.isExpanded('right'),
     * because the signal fires before the expansion state settles.
     */
    /*
     * Reconcile the slot with the panel's CURRENT state, not just its changes.
     *
     * watchRightPanel only hears about transitions. If Theia's right panel is
     * already expanded when a document opens -- which is the ordinary case,
     * since the assistant panel persists across reloads and reveals itself on
     * activation -- no signal ever fires, and the rail and the assistant end up
     * on screen together. That is the exact defect the single slot exists to
     * remove, surviving in the most common path. A passing selector-driven test
     * did not catch it because clicking the selector always goes through
     * selectSlot; this state is reached without ever touching it.
     *
     * The document's own rail is the default owner: activating a document makes
     * that document's slot state authoritative. An assistant the user actually
     * chose is left alone.
     */
    reconcileSlot() {
        if (!this.shell) { return; }
        if (this.assistant) { return; }         // an explicit choice stands
        if (this.railOpen) { this.collapseRightPanel(); }
    }

    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        // Switching to this document tab re-asserts its own slot state.
        this.reconcileSlot();
    }

    watchRightPanel() {
        if (!this.shell || !this.shell.rightPanelHandler) { return; }
        const tabBar = this.shell.rightPanelHandler.tabBar;
        const onChange = (sender, args) => {
            const next = assistantFromTabTitle(args && args.currentTitle);
            if (next === this.assistant) { return; }

            /*
             * Startup only: an assistant that reveals itself, rather than being
             * asked for, does not get to evict the document's own comments.
             * See SLOT_GRACE_MS.
             */
            if (next && !this.slotChosen && (Date.now() - this.openedAt) < SLOT_GRACE_MS) {
                this.collapseRightPanel();
                return;
            }

            this.assistant = next;
            // An assistant arriving in the slot means our rail has left it.
            if (next) { this.railOpen = false; this.applyMode(); }
            this.renderRail();
        };
        tabBar.currentChanged.connect(onChange);
        this.disposables.push({ dispose: () => tabBar.currentChanged.disconnect(onChange) });
    }

    // -- rails ---------------------------------------------------------------

    renderRail() {
        this.railEl.classList.toggle('open', this.railOpen);
        this.renderSegmented();
        // Before the early return: the gutter is the document's own record of
        // where comments are, and it matters MOST when the rail is closed.
        this.renderGutter();
        if (!this.railOpen) { return; }
        if (this.rail === 'comments') { return this.renderComments(); }
        if (this.rail === 'changes') { return this.renderChanges(); }
        if (this.rail === 'quality') { return this.renderQuality(); }
        return this.renderHistory();
    }

    // -- comments ------------------------------------------------------------

    reanchorThreads() {
        if (!this.editor) { return; }
        const { text, map } = buildTextIndex(this.editor.state.doc);
        const tr = this.editor.state.tr;
        let applied = false;
        for (const th of this.threads) {
            if (th.scope === 'document') { continue; }
            if (!th.quote) { th.orphaned = true; continue; }
            const positions = [];
            let idx = text.indexOf(th.quote);
            while (idx !== -1) { positions.push(idx); idx = text.indexOf(th.quote, idx + 1); }
            const at = positions[th.occurrence || 0];
            if (at === undefined) { th.orphaned = true; continue; }
            th.orphaned = false;
            const from = map[at];
            const to = map[at + th.quote.length - 1] + 1;
            if (from === undefined || to === undefined) { th.orphaned = true; continue; }
            tr.addMark(from, to, this.editor.schema.marks.comment.create({ commentId: th.id }));
            applied = true;
        }
        if (applied) {
            this.editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('studio-internal', true));
        }
    }

    createThreadFromSelection() {
        const { state } = this.editor;
        const { from, to } = state.selection;
        if (from === to) { return; }
        const quote = state.doc.textBetween(from, to, ' ');
        if (!quote.trim()) { return; }

        const { text, map } = buildTextIndex(state.doc);
        const positions = [];
        let idx = text.indexOf(quote);
        while (idx !== -1) { positions.push(idx); idx = text.indexOf(quote, idx + 1); }
        const occurrence = Math.max(0, positions.findIndex(p => map[p] === from));

        const thread = { id: newId(), scope: 'inline', quote, occurrence, resolved: false, messages: [] };
        this.threads.push(thread);
        this.editor.chain().command(({ tr }) => { tr.setMeta('studio-internal', true); return true; })
            .setMark('comment', { commentId: thread.id }).run();
        this.focusThread(thread.id);
    }

    /** Requirement 4: a thread about the document, with no text anchor at all. */
    createDocumentThread() {
        const thread = { id: newId(), scope: 'document', resolved: false, messages: [] };
        this.threads.push(thread);
        this.focusThread(thread.id);
    }

    focusThread(id) {
        this.activeThreadId = id;
        // Through the slot choke point, not by setting rail/railOpen directly:
        // opening comments has to evict an assistant from the slot, and that
        // rule lives in one place. openSlot, because focusing a thread must
        // always show it -- never toggle the rail shut.
        this.openSlot('comments');
        this.hideBubble();          // after applyMode, so nothing re-reveals it
        this.renderRail();
        const input = this.listEl.querySelector('[data-thread="' + id + '"] textarea');
        if (input) { setTimeout(() => input.focus(), 0); }
    }

    /*
     * Re-fold when any party appends. This is the half of the fix that a user
     * can actually see: without it a colleague's reply sits on disk until the
     * document is reopened, and an append-only log is just a tidier way of
     * storing the same invisible file.
     */
    /**
     * Follow other people's suggestion files.
     *
     * This is the whole point of one file per author: somebody else's suggestion
     * appears here without either of us coordinating. The reload is dropped when
     * it says nothing new, because the watcher fires for this client's own writes
     * too (a debounce, not write bookkeeping — see change-log.js) and
     * re-rendering on those would move focus out of the document mid-sentence.
     */
    async watchSuggestions() {
        if (this.suggestWatch || !this.changeLog || typeof this.changeLog.watch !== 'function') { return; }
        try {
            this.suggestWatch = await this.changeLog.watch(this.uri, data => {
                if (this.isDisposed) { return; }
                const sig = JSON.stringify(data.proposals.map(p => [p.id, p.updatedAt, p.proposedBody.length]))
                    + '|' + Object.keys(data.rejections).sort().join(',');
                if (sig === this.suggestionsSig) { return; }
                this.suggestionsSig = sig;
                this.suggestions = data.proposals;
                this.rejections = data.rejections;
                this.renderTracked();
                this.renderRail();
                this.renderBanners();
                // The strip carries a pending count, so somebody else's new
                // suggestion has to reach it too.
                slotStrip.refresh();
            });
            // onCloseRequest drains this, which releases the filesystem watch and
            // cancels a pending debounce into a disposed widget.
            this.disposables.push(this.suggestWatch);
        } catch (e) {
            console.warn('[studio] could not watch the suggestion files', e);
        }
    }

    async watchComments() {
        if (this.commentWatch || typeof this.commentsStore.watch !== 'function') { return; }
        try {
            this.commentWatch = await this.commentsStore.watch(this.uri, data => {
                if (this.isDisposed) { return; }
                /*
                 * The watcher fires for this client's own appends too (see
                 * comment-log.js on why it is a debounce rather than write
                 * bookkeeping). Re-rendering the rail on those would move focus
                 * out of the composer mid-sentence, so a fold that says nothing
                 * new is dropped here.
                 */
                const sig = signature(data.threads);
                if (sig === this.threadsSig) { return; }
                this.threadsSig = sig;
                this.threads = mergeFolded(this.threads, data.threads)
                    .map(t => ({ scope: 'inline', ...t }));
                this.renderRail();
                // The strip shows an unresolved-comment count, so somebody
                // else's new thread has to reach it too.
                slotStrip.refresh();
            });
            // onCloseRequest drains this, which is what releases the filesystem
            // watch and cancels a pending debounce into a disposed widget.
            this.disposables.push(this.commentWatch);
        } catch (e) {
            console.warn('[studio] could not watch the comment logs', e);
        }
    }

    /*
     * Append one op, then take the fold as the state.
     *
     * saveComments() used to serialise the whole thread array over the sidecar,
     * which is why two people with the same document open destroyed each other's
     * comments with no error — measured, and pinned by comment-log-test.mjs.
     */
    async persistComments(write) {
        try {
            await write(this.commentsStore);
            const data = await this.commentsStore.load(this.uri);
            this.threadsSig = signature(data.threads);
            this.threads = mergeFolded(this.threads, data.threads)
                .map(t => ({ scope: 'inline', ...t }));
            this.footEl.textContent = 'Stored in the repository at .studio/comments/' +
                this.uri.path.base + '/';
            this.renderRail();
        } catch (e) {
            console.error('[studio] comment append failed', e);
            this.footEl.textContent = 'Could not write the comment log.';
        }
    }

    /*
     * One message, one op. The first message in a thread carries the `open`, so
     * a thread the user opened and then abandoned without typing never becomes a
     * permanent record; everything after it is a `reply`.
     *
     * The optimistic in-memory push is still done, then superseded by the fold:
     * the rail must repaint on this keystroke rather than after a round trip,
     * and persistComments replaces the message with the folded one — which is
     * what gives it the id a later retract names.
     */
    addMessage(threadId, body) {
        const th = this.threads.find(t => t.id === threadId);
        if (!th || !body.trim()) { return; }
        const text = body.trim();
        const first = !th.messages.length;
        /* See the same stamp in html-viewer.js: `by` is structured, `author`
         * stays the display string that existing sidecars and suites read. */
        const me = identity.current();
        th.messages.push({ author: me.name, by: me, at: new Date().toISOString(), body: text });
        delete this.drafts[threadId];
        this.persistComments(store => first
            ? store.openThread(this.uri, {
                id: th.id, scope: th.scope, quote: th.quote, occurrence: th.occurrence, body: text
            })
            : store.reply(this.uri, th.id, text));
        this.historyStore.record(this.uri, {
            kind: 'comment',
            title: (th.scope === 'document' ? 'Commented on the document' : 'Commented on “' + String(th.quote).slice(0, 40) + '”'),
            detail: body.trim().slice(0, 120),
            commentId: th.id
        }).then(entries => { this.historyEntries = entries; });
        this.renderRail();
        const textarea = this.listEl.querySelector('[data-thread="' + threadId + '"] textarea');
        if (textarea) { textarea.focus(); }
    }

    toggleResolved(threadId) {
        const th = this.threads.find(t => t.id === threadId);
        if (!th) { return; }
        th.resolved = !th.resolved;
        th.pendingResolution = false;
        this.openResolvedThreadId = undefined;
        if (th.resolved) {
            this.activeThreadId = undefined;
            this.resolvedThreadsOpen = false;
        }
        /* A resolve/reopen pair rather than a boolean field, so two people who
         * disagree settle it by timestamp instead of by whoever saved last. */
        this.persistComments(store => store.setResolved(this.uri, threadId, th.resolved));
        this.historyStore.record(this.uri, {
            kind: 'comment-resolved',
            title: th.resolved ? 'Resolved a comment' : 'Reopened a comment',
            detail: th.scope === 'document' ? 'Document comment' : String(th.quote || '').slice(0, 60),
            commentId: th.id
        }).then(entries => { this.historyEntries = entries; });
        this.renderRail();
    }

    deleteThread(threadId) {
        const th = this.threads.find(t => t.id === threadId);
        // A thread with no messages has never reached disk, so there is nothing
        // to tombstone — dropping it from memory IS the delete.
        const unsaved = !th || !th.messages.length;
        this.threads = this.threads.filter(t => t.id !== threadId);
        if (this.openResolvedThreadId === threadId) { this.openResolvedThreadId = undefined; }
        if (this.activeThreadId === threadId) { this.activeThreadId = undefined; }
        if (th && th.scope !== 'document' && this.editor) {
            const tr = this.editor.state.tr;
            this.editor.state.doc.descendants((node, pos) => {
                if (!node.isText) { return; }
                const m = (node.marks || []).find(mk => mk.type.name === 'comment' && mk.attrs.commentId === threadId);
                if (m) { tr.removeMark(pos, pos + node.nodeSize, m); }
            });
            this.editor.view.dispatch(tr.setMeta('studio-internal', true));
        }
        /* A tombstone, not an erasure: the op stays in the log, and the fold
         * honours the deletion. A log cannot forget. */
        if (unsaved) { this.renderRail(); } else { this.persistComments(store => store.deleteThread(this.uri, threadId)); }
    }

    /*
     * Delete is armed on the first click (the trash button turns solid red
     * and its title flips to "Click again to delete") and only takes effect
     * on a second click within a few seconds. Any other click disarms it.
     * This replaces a blocking window.confirm() with a reversible in-place
     * state that costs one extra glance, not a modal.
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
        const btn = this.listEl.querySelector('[data-act="comment-delete"][data-id="' + this.armedDeleteId + '"]');
        if (btn) { btn.classList.remove('confirm'); btn.title = 'Delete thread'; }
        this.armedDeleteId = undefined;
    }

    /*
     * D4: the clipboard handoff is gone from this surface.
     *
     * Every thread used to carry TWO adjacent 24px icon buttons of identical
     * weight, distinguished only by tooltip: the spark opened a prompt and
     * produced a reviewable pending change, while this one copied the thread to
     * the clipboard, focused a panel, and produced nothing you could accept or
     * reject. They looked like alternatives; one was a dead end.
     *
     * requestChangeFromComment below is the surviving route, and it is the
     * better one -- it closes the loop through ChangeCapture. The clipboard
     * handoff still exists in ai-context.js because html-viewer.js has no
     * pending-change path of its own, and there it is the ONLY route, so it is
     * not a duplicate and not confusable with anything.
     */

    /** Requirement 10: turn this thread's feedback into a proposed change. */
    requestChangeFromComment(threadId, anchorEl) {
        const th = this.threads.find(t => t.id === threadId);
        if (!th) { return; }
        const feedback = th.messages.map(m => m.body).join('\n');
        openAiPrompt(this.node, anchorEl, {
            title: 'Turn this comment into a change',
            excerpt: th.quote,
            placeholder: feedback ? feedback.slice(0, 90) : 'Rewrite this to address the comment…'
        }, {
            onSubmit: (kind, instruction) => this.startChangeRequest(kind, instruction || feedback, th.quote, th.id)
        });
    }

    // -- AI change requests --------------------------------------------------

    /** Requirement 8: ask for an edit scoped to the current selection. */
    askAiForSelection(anchorEl) {
        const { state } = this.editor;
        const { from, to } = state.selection;
        const excerpt = from === to ? '' : state.doc.textBetween(from, to, ' ');
        openAiPrompt(this.node, anchorEl, {
            title: excerpt ? 'Ask AI to edit this selection' : 'Ask AI to edit this document',
            excerpt,
            placeholder: 'Tighten this paragraph…'
        }, {
            onSubmit: (kind, instruction) => this.startChangeRequest(kind, instruction, excerpt, undefined)
        });
    }

    /*
     * Arm the capture, then hand the request over.
     *
     * `awaitingProposal` is what gives the resulting proposal its title and
     * its link back to a comment: the assistant's write arrives later, as an
     * ordinary file change, carrying none of that context with it.
     */
    async startChangeRequest(kind, instruction, excerpt, commentId) {
        if (kind === 'paste') { return this.pasteProposal(instruction, excerpt, commentId); }
        this.awaitingProposal = {
            instruction: instruction || 'Requested change',
            commentId,
            origin: commentId ? 'comment' : 'inline-ai',
            author: kind === 'claude' ? 'Claude Code' : 'Codex'
        };
        const ok = await requestChange({
            commandRegistry: this.commandRegistry, messageService: this.messageService,
            uri: this.uri, kind, path: this.uri.path.toString(), instruction, excerpt,
            // Present only when the request came from a comment, which is what
            // lets the assistant answer the thread as well as edit the file.
            threadId: commentId
        });
        if (!ok) { this.awaitingProposal = undefined; }
    }

    /*
     * The offline path. Neither assistant can return text to this widget, so
     * when one is unavailable — or the user is working from an answer they
     * already have — the replacement text can be pasted in and reviewed
     * through exactly the same per-hunk pipeline.
     */
    pasteProposal(instruction, excerpt, commentId) {
        const replacement = window.prompt(
            excerpt ? 'Paste the replacement for the selected passage:' : 'Paste the proposed document:',
            '');
        if (replacement === null || !replacement.trim()) { return; }
        const base = this.currentBody();
        let proposed;
        if (excerpt && base.includes(excerpt)) {
            proposed = base.replace(excerpt, replacement);
        } else if (excerpt) {
            this.messageService.warn('That passage moved — the proposal was applied to the whole document instead.');
            proposed = replacement;
        } else {
            proposed = replacement.endsWith('\n') ? replacement : replacement + '\n';
        }
        this.captureProposal(proposed, {
            instruction: instruction || 'Pasted proposal',
            commentId,
            origin: 'manual',
            // A proposal is attributed the same way a comment is: whoever pasted
            // it. The other captureProposal callers pass 'Claude Code'/'Codex',
            // so this field is already a display name rather than a token.
            author: identity.displayName(),
            base
        });
    }

    // -- interactive figures -------------------------------------------------

    /*
     * "Describe a figure and have it generated."
     *
     * THE SHAPE OF THIS, AND WHY IT IS NOT A CHAT BOX. The request goes out
     * through the SAME path as an inline AI edit — the assistant writes the file,
     * the editor's watcher catches the write and holds it as a proposal — so a
     * generated figure arrives as a reviewable pending change and not as content
     * that appeared in somebody's document. That matters more here than for a
     * text edit: a figure is a few hundred lines of code, nobody is going to read
     * it line by line, and the answer to "what did that put in my file" has to be
     * the review pipeline rather than trust.
     *
     * The starters are the other half. Neither assistant can hand text back to
     * this widget (ai-context.js explains why), and on this target both arrive
     * over the network on first run — so without a route that needs no assistant,
     * the entry point in the slash menu would do nothing at all for the first
     * few minutes of the product's life.
     */
    createFigure() {
        if (this.readOnly || !this.editor) { return; }
        const { state } = this.editor;
        const block = state.selection.$from.parent;
        // The paragraph or heading the caret is in, which is what the assistant
        // is told to insert after. A figure belongs next to the sentence that
        // called for it, and this is the only evidence of which sentence that is.
        const anchorText = (block && block.textContent ? block.textContent : '').trim().slice(0, 400);
        openAiPrompt(this.node, this.caretAnchor(), {
            title: 'Describe an interactive figure',
            excerpt: anchorText,
            placeholder: 'How compound interest outruns simple interest…',
            extra: starterButtonsHtml(),
            secondary: false
        }, {
            onSubmit: (kind, description) => {
                if (kind.indexOf('starter:') === 0) { return this.insertFigure(starterFigure(kind.slice(8))); }
                this.startFigureRequest(kind, description, anchorText);
            }
        });
    }

    /*
     * A DOM-less anchor for a popover at the caret.
     *
     * openAiPrompt anchors to an element, and a slash command has no element to
     * anchor to — the menu it was chosen from is already gone by the time this
     * runs. Only getBoundingClientRect is ever called on it, so a duck is
     * cheaper than inserting a placeholder element into the document just to
     * measure it and take it out again.
     */
    caretAnchor() {
        const coords = this.editor.view.coordsAtPos(this.editor.state.selection.from);
        return {
            getBoundingClientRect: () => ({
                left: coords.left, right: coords.left, top: coords.top, bottom: coords.bottom,
                width: 0, height: coords.bottom - coords.top
            })
        };
    }

    /** Put a figure block in the document, at the caret. */
    insertFigure(code) {
        if (this.readOnly || !this.editor) { return; }
        this.editor.chain().focus().insertContent({
            type: 'codeBlock',
            attrs: { language: FIGURE_LANGUAGE },
            content: [{ type: 'text', text: String(code) }]
        }).run();
    }

    /*
     * Hand the figure request to an assistant.
     *
     * `awaitingProposal` is armed first, for the reason startChangeRequest gives:
     * the write arrives later as an ordinary file change carrying none of this
     * context, and without it the proposal has no title and no attribution.
     */
    async startFigureRequest(kind, description, anchorText) {
        this.awaitingProposal = {
            instruction: 'Interactive figure: ' + description,
            origin: 'figure',
            author: kind === 'claude' ? 'Claude Code' : 'Codex'
        };
        const ok = await requestChange({
            commandRegistry: this.commandRegistry, messageService: this.messageService,
            uri: this.uri, kind, path: this.uri.path.toString(),
            instruction: description, excerpt: anchorText,
            prompt: figureRequestPrompt({
                path: this.uri.path.toString(), description, anchor: anchorText
            })
        });
        if (!ok) { this.awaitingProposal = undefined; }
    }

    // -- rail: comments ------------------------------------------------------

    renderComments() {
        const unresolved = this.threads.filter(t => !t.resolved);
        const inline = unresolved.filter(t => t.scope !== 'document');
        const documentLevel = unresolved.filter(t => t.scope === 'document');
        const resolved = this.threads.filter(t => t.resolved);

        this.railHeadEl.innerHTML =
            '<span class="studio-rail-title">Comments</span>' +
            '<button class="studio-icon-btn" data-act="new-document-comment" title="Comment on the whole document" ' +
            'aria-label="Comment on the whole document">' + ICONS.docComment + '</button>';

        if (!this.threads.length) {
            /*
             * D8: this used to be two paragraphs -- how to start a thread, and
             * where threads are stored -- which made a 361px column whose
             * entire content was instructions the widest permanent element on
             * screen, holding no data. An empty state should say what is true
             * and point at where the work happens, in one line.
             *
             * The "select text and choose Comment" half is taught at the point
             * of action instead: the selection toolbar's own Comment button is
             * the thing being described, and it is already on screen exactly
             * when the instruction is relevant. The sidecar detail is
             * documentation, not an empty state, and is not the reader's
             * problem the first time they open a document.
             */
            this.listEl.innerHTML =
                '<div class="studio-rail-empty">No comments yet. Select any text to start a thread.</div>';
            this.footEl.textContent = '';
            return;
        }

        const section = (title, threads) => threads.length
            ? '<div class="studio-rail-section">' + title + '</div>' + threads.map(t => this.threadHtml(t)).join('')
            : '';

        this.listEl.innerHTML =
            section('On the document', documentLevel) +
            section('In the text', inline) +
            this.resolvedThreadsHtml(resolved);

        for (const [id, text] of Object.entries(this.drafts)) {
            if (!text) { continue; }
            const ta = this.listEl.querySelector('[data-thread="' + id + '"] textarea');
            if (ta) { ta.value = text; }
        }
    }

    resolvedThreadsHtml(threads) {
        if (!threads.length) { return ''; }
        const expanded = this.resolvedThreadsOpen;
        const count = threads.length;
        return '<div class="studio-resolved-threads">' +
            '<button class="studio-resolved-toggle" data-act="toggle-resolved-threads" aria-expanded="' + expanded + '">' +
            'Resolved (' + count + ')<span aria-hidden="true">' + (expanded ? '⌄' : '›') + '</span></button>' +
            (expanded
                ? '<div class="studio-resolved-list">' + threads.map(th => this.resolvedThreadHtml(th)).join('') + '</div>'
                : '') +
            '</div>';
    }

    resolvedThreadHtml(th) {
        if (this.openResolvedThreadId === th.id) {
            return '<div data-resolved-thread="' + th.id + '">' + this.threadHtml(th) + '</div>';
        }
        const messageCount = th.messages.length;
        return '<button class="studio-resolved-thread" data-act="show-resolved-thread" data-id="' + th.id +
            '" data-resolved-thread="' + th.id + '">' +
            '<span>Resolved comment</span><span>' + (messageCount ? messageCount + ' message' + (messageCount === 1 ? '' : 's') : 'Open to view') + '</span>' +
            '</button>';
    }

    toggleResolvedThreads() {
        this.resolvedThreadsOpen = !this.resolvedThreadsOpen;
        if (!this.resolvedThreadsOpen) { this.openResolvedThreadId = undefined; }
        this.renderRail();
    }

    showResolvedThread(id) {
        const th = this.threads.find(t => t.id === id && t.resolved);
        if (!th) { return; }
        this.resolvedThreadsOpen = true;
        this.openResolvedThreadId = id;
        this.activeThreadId = id;
        this.renderRail();
        const anchor = this.editor && this.editor.view.dom.querySelector('.studio-comment-mark[data-comment-id="' + id + '"]');
        if (anchor) { anchor.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }

    threadHtml(th) {
        const messages = th.messages.map(m => messageHtml(m, 'studio-msg')).join('');
        const resolveTitle = th.resolved ? 'Reopen thread' : 'Mark resolved';
        const deleteArmed = th.id === this.armedDeleteId;
        const quote = quoteLineHtml({ text: th.quote, scope: th.scope, orphaned: th.orphaned });

        return '<div class="studio-thread' + (th.resolved ? ' resolved' : '') +
            (th.id === this.activeThreadId ? ' active' : '') +
            (th.pendingResolution ? ' awaiting' : '') + '" data-thread="' + th.id + '">' +
            '<div class="studio-thread-head">' + quote +
            '<div class="studio-thread-tools">' +
            '<button class="studio-icon-btn" data-act="comment-request-change" data-id="' + th.id + '" title="Ask AI to change this" aria-label="Ask AI to change this">' + ICONS.spark + '</button>' +
            '<button class="studio-icon-btn' + (th.resolved ? ' resolved' : '') + '" data-act="comment-resolve" data-id="' + th.id + '" title="' + resolveTitle + '" aria-label="' + resolveTitle + '">' +
            (th.resolved ? ICONS.checkCircle : ICONS.circle) + '</button>' +
            '<button class="studio-icon-btn danger' + (deleteArmed ? ' confirm' : '') + '" data-act="comment-delete" data-id="' + th.id + '" title="' +
            (deleteArmed ? 'Click again to delete' : 'Delete thread') + '" aria-label="Delete thread">' + ICONS.trash + '</button>' +
            '</div></div>' +
            (th.pendingResolution
                ? '<div class="studio-thread-note">The change from this comment was applied. Resolve the thread?</div>'
                : '') +
            messages +
            '<div class="studio-thread-compose' + (th.messages.length ? ' studio-compose-indent' : '') + '">' +
            '<textarea rows="1" placeholder="' + (th.messages.length ? 'Reply…' : 'Add a comment…') + '"></textarea>' +
            '<button class="studio-icon-btn send" data-act="comment-send" data-id="' + th.id + '" title="Send (Enter)" aria-label="Send">' + ICONS.send + '</button>' +
            '</div></div>';
    }

    // -- rail: changes -------------------------------------------------------

    /*
     * What a proposal is, and the decisions that apply to all of it — shared by
     * both review styles verbatim.
     *
     * The bulk controls and the step arrows are the same controls doing the same
     * thing in both, so they are built once. Only what sits BELOW this block
     * differs: hunks with diffs in the queue, cards with sentences inline.
     */
    proposalHeaderHtml(proposal, pending) {
        return '<div class="studio-proposal">' +
            '<div class="studio-proposal-title">' + escapeHtml(proposal.title) + '</div>' +
            '<div class="studio-proposal-meta">' + escapeHtml(proposal.author) + ' · ' +
            new Date(proposal.createdAt).toLocaleString() +
            (proposal.commentId ? ' · from a comment' : '') + '</div>' +
            (proposal.frontmatterChanged
                ? '<div class="studio-proposal-note">Frontmatter edits in this write were not applied — only the document body is reviewable here.</div>'
                : '') +
            '<div class="studio-rail-toolbar">' +
            '<button class="studio-btn" data-act="accept-all">Accept all ' + (pending ? '(' + pending + ')' : '') + '</button>' +
            '<button class="studio-btn" data-act="reject-all">Reject all</button>' +
            '<span class="studio-doc-spacer"></span>' +
            '<button class="studio-icon-btn" data-act="hunk-prev" title="Previous change" aria-label="Previous change">' + ICONS.chevronLeft + '</button>' +
            '<button class="studio-icon-btn" data-act="hunk-next" title="Next change" aria-label="Next change">' + ICONS.chevronRight + '</button>' +
            '</div></div>';
    }

    renderChanges() {
        const proposal = this.openProposal();
        const others = this.pendingFiles.filter(f => f.uri.toString() !== this.uri.toString());

        this.railHeadEl.innerHTML =
            '<span class="studio-rail-title">Review queue</span>' +
            (this.decisionJournal.length
                ? '<button class="studio-icon-btn" data-act="undo-decision" title="Undo the last decision" aria-label="Undo the last decision">' + ICONS.undo + '</button>'
                : '');

        // A conflict comparison borrows this rail; it is read-only and has no
        // decisions attached, so it renders and returns before the review UI.
        if (this.comparing) {
            this.listEl.innerHTML =
                '<div class="studio-rail-toolbar"><button class="studio-btn ghost" data-act="close-compare">Close comparison</button></div>' +
                comparisonHtml(diffHunks(this.comparing.a, this.comparing.b).hunks, { heading: this.comparing.heading });
            this.footEl.textContent = '';
            return;
        }

        if (this.pendingFilesAvailable === undefined) {
            /*
             * `undefined` here is a deliberate third value (see the note on
             * pendingFilesAvailable in the constructor) meaning "the index has
             * not answered yet", as distinct from `false`, "it could not be
             * read". The two states already render differently -- this one and
             * the Retry block below -- and this one now says which of the two
             * it is with something other than the tense of a sentence.
             */
            this.listEl.innerHTML = loadingMarkup('Loading review queue…', { inline: true, className: 'studio-rail-loading' });
            this.footEl.textContent = '';
            return;
        }

        if (!this.pendingFilesAvailable) {
            this.listEl.innerHTML =
                '<div class="studio-rail-empty">The review queue could not load. Try again to check for pending changes.</div>' +
                '<div class="studio-rail-toolbar"><button class="studio-btn ghost" data-act="retry-pending-files">Retry</button></div>';
            this.footEl.textContent = 'Queue unavailable.';
            return;
        }

        const filesHtml = others.length
            ? '<div class="studio-rail-section">Pending in other files</div>' +
              others.map(f =>
                  '<button class="studio-file-row" data-act="open-changed-file" data-path="' + escapeHtml(f.path) + '">' +
                  '<span class="studio-file-name">' + escapeHtml(f.path) + '</span>' +
                  '<span class="studio-file-count">' + f.pending + '</span></button>').join('') +
              '<div class="studio-rail-toolbar">' +
              '<button class="studio-btn" data-act="accept-all-files">Accept all, everywhere</button>' +
              '<button class="studio-btn" data-act="reject-all-files">Reject all, everywhere</button>' +
              '</div>'
            : '';

        if (!proposal) {
            /* "This document is clear" is only true if there are no suggestions
               either. With one open it is the opposite of true, which is why this
               early return renders the section rather than skipping to it. */
            const suggestions = this.suggestionsSectionHtml();
            this.listEl.innerHTML = filesHtml + suggestions +
                (suggestions ? '' : '<div class="studio-rail-empty">This document is clear.</div>');
            const open = this.pendingSuggestionCount();
            this.footEl.textContent = open
                ? open + ' suggestion' + (open === 1 ? '' : 's') + ' to decide'
                : (others.length ? 'Review work remains in other files.' : 'No pending review work.');
            return;
        }

        const hunks = this.proposalHunks(proposal);
        const pending = countPending(hunks, proposal.decisions);

        /*
         * The tracked-changes rail, and what it deliberately does NOT repeat.
         *
         * In this style the document beside it is already showing the change in
         * place, so a card that also carried a diff would be stating the same
         * thing twice at two different granularities — and the second telling
         * is the one in monospace, which is the wrong one to leave a prose
         * reader with. A card carries what the document cannot: who proposed
         * it, when, what it does in words, and the two decisions.
         */
        if (this.trackedActive()) {
            if (this.currentHunkIndex === undefined) { this.currentHunkIndex = 0; }
            this.listEl.innerHTML = filesHtml +
                (proposal ? this.proposalHeaderHtml(proposal, pending) : '') +
                this.changeCardsHtml();
            const open = pending + this.pendingSuggestionCount();
            this.footEl.textContent = open
                ? open + ' change' + (open === 1 ? '' : 's') + ' still to decide'
                : 'All changes decided.';
            return;
        }

        this.listEl.innerHTML = filesHtml + this.proposalHeaderHtml(proposal, pending) +
            hunks.map((h, i) => reviewHunkHtml(h, proposal.decisions[h.id], i, hunks.length)).join('') +
            this.suggestionsSectionHtml();
        this.footEl.textContent = pending
            ? pending + ' of ' + hunks.length + ' still to decide'
            : 'All changes decided.';
        this.highlightCurrentHunk();
    }

    /**
     * One card per change, in document order, from both stores.
     *
     * The same list backs both review styles: in Tracked changes it is the whole
     * rail, and in Diff queue it sits under the hunks as the SUGGESTIONS section
     * — because a suggestion has no place in a patch view (it is not a patch
     * against a fixed base), and leaving it out of that style entirely would
     * hide a colleague's work from anyone whose project prefers the queue.
     */
    changeCardsHtml(only) {
        /*
         * ONE call to orderedEntries, not two. trackedEntries() builds fresh
         * objects every time, so filtering a second call and then asking the
         * first for indexOf compares objects from different lists and never
         * matches — the current card would silently never be marked current.
         */
        const all = this.orderedEntries();
        const entries = only ? all.filter(only) : all;
        if (!entries.length) { return ''; }
        const nameOf = id => {
            const target = this.suggestions.find(p => p.id === id);
            return target ? authorRecord(target.by).name : undefined;
        };
        return entries.map(entry => changeCardHtml(entry.hunk, entry.decision, entry.proposal, {
            /* Indexed against the FULL list, not the filtered one, so the arrows
               and the document stay in step with whichever subset is drawn. */
            current: all.indexOf(entry) === this.currentHunkIndex,
            ref: entry.ref,
            slot: entry.slot,
            mine: entry.mine,
            replyToName: entry.replyTo ? nameOf(entry.replyTo) : undefined,
            overlapped: entry.overlapped,
            conflicted: entry.hunk.conflicted
        })).join('');
    }

    /**
     * The suggestions section.
     *
     * It used to carry a sentence explaining Suggesting mode as well, and that
     * sentence was the third statement of one fact — the topbar pill is solid
     * accent, the status reads "Suggesting…", and a banner said it in the
     * document. Reported as "this seems overloaded", correctly. The rail is the
     * one place it was least useful, because it sits directly above a heading
     * that says SUGGESTIONS over a card with the reader's own name on it.
     */
    suggestionsSectionHtml() {
        const cards = this.changeCardsHtml(entry => entry.proposal && entry.proposal.kind === 'suggestion');
        return cards ? '<div class="studio-rail-section">Suggestions</div>' + cards : '';
    }

    /** Requirement 7's sequential review: step through the undecided hunks. */
    stepHunk(delta) {
        /*
         * In Tracked changes the list is every change in the document from every
         * author, which is what the arrows have to walk — stepping only the
         * assistant's hunks would skip past a colleague's suggestion sitting
         * between two of them.
         */
        if (this.trackedActive()) {
            const entries = this.orderedEntries();
            if (!entries.length) { return; }
            const at = this.currentHunkIndex === undefined ? 0 : this.currentHunkIndex;
            this.currentHunkIndex = Math.max(0, Math.min(entries.length - 1, at + delta));
            this.highlightTracked(true);
            this.highlightCurrentCard(true);
            return;
        }
        const proposal = this.openProposal();
        if (!proposal) { return; }
        const hunks = this.proposalHunks(proposal);
        if (!hunks.length) { return; }
        const index = this.currentHunkIndex === undefined ? 0 : this.currentHunkIndex;
        this.currentHunkIndex = Math.max(0, Math.min(hunks.length - 1, index + delta));
        // Both styles step through the same list; only what "the current change"
        // looks like differs. Calling both is safe -- each is a no-op when its
        // surface is not the one showing.
        this.highlightCurrentHunk(true);
        this.highlightCurrentCard(true);
        this.highlightTracked(true);
    }

    highlightCurrentHunk(scroll) {
        const nodes = [...this.listEl.querySelectorAll('.studio-hunk')];
        nodes.forEach((n, i) => n.classList.toggle('current', i === this.currentHunkIndex));
        if (!scroll) { return; }
        const node = nodes[this.currentHunkIndex];
        if (node) { node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }

    async openChangedFile(path) {
        const target = this.pendingFiles.find(f => f.path === path);
        if (!target || !this.openerService) { return; }
        try {
            const opener = await this.openerService.getOpener(target.uri);
            await opener.open(target.uri);
        } catch (e) {
            console.error('[studio] could not open', path, e);
            this.messageService.error('Could not open ' + path + '.');
        }
    }

    // -- rail: history -------------------------------------------------------

    renderHistory() {
        this.railHeadEl.innerHTML =
            '<span class="studio-rail-title">History</span>' +
            (this.compareSelection.length === 2
                ? '<button class="studio-btn ghost" data-act="clear-compare">Clear</button>'
                : '');

        if (!this.historyEntries.length) {
            this.listEl.innerHTML = '<div class="studio-rail-empty">Nothing recorded yet. Edits, comments, ' +
                'AI proposals and every accept or reject decision are logged here as you work.</div>';
            this.footEl.textContent = '';
            return;
        }

        const withSnapshots = this.historyEntries.filter(e => e.snapshot !== undefined);
        let comparison = '';
        if (this.compareSelection.length === 2) {
            const [a, b] = this.compareSelection.map(id => this.historyEntries.find(e => e.id === id)).filter(Boolean);
            if (a && b) {
                const [older, newer] = Date.parse(a.at) <= Date.parse(b.at) ? [a, b] : [b, a];
                comparison = '<div class="studio-compare">' +
                    comparisonHtml(diffHunks(older.snapshot, newer.snapshot).hunks, {
                        heading: older.title + ' (' + older.author + ', ' + new Date(older.at).toLocaleString() + ')' +
                            '  →  ' + newer.title + ' (' + newer.author + ', ' + new Date(newer.at).toLocaleString() + ')'
                    }) + '</div>';
            }
        }

        const rows = this.historyEntries.slice().reverse().map(entry => {
            const selectable = entry.snapshot !== undefined;
            const selected = this.compareSelection.includes(entry.id);
            return '<div class="studio-history' + (selected ? ' selected' : '') + '" data-entry="' + entry.id + '">' +
                '<div class="studio-history-head">' +
                '<span class="studio-history-kind kind-' + entry.kind + '">' + escapeHtml(entry.label || entry.kind) + '</span>' +
                '<span class="studio-doc-spacer"></span>' +
                (selectable
                    ? '<button class="studio-icon-btn' + (selected ? ' resolved' : '') + '" data-act="history-compare" data-id="' + entry.id + '" ' +
                      'title="Select for comparison" aria-label="Select for comparison">' + (selected ? ICONS.checkCircle : ICONS.circle) + '</button>' +
                      '<button class="studio-icon-btn" data-act="history-restore" data-id="' + entry.id + '" ' +
                      'title="Restore this version" aria-label="Restore this version">' + ICONS.restore + '</button>'
                    : '') +
                '</div>' +
                '<div class="studio-history-title">' + escapeHtml(entry.title) + '</div>' +
                (entry.detail ? '<div class="studio-history-detail">' + escapeHtml(entry.detail) + '</div>' : '') +
                '<div class="studio-history-meta">' + escapeHtml(entry.author) + ' · ' + new Date(entry.at).toLocaleString() + '</div>' +
                '</div>';
        }).join('');

        this.listEl.innerHTML = comparison + rows;
        this.footEl.textContent = this.compareSelection.length === 1
            ? 'Select a second version to compare.'
            : withSnapshots.length + ' restorable version' + (withSnapshots.length === 1 ? '' : 's');
    }

    toggleCompare(entryId) {
        const at = this.compareSelection.indexOf(entryId);
        if (at >= 0) { this.compareSelection.splice(at, 1); }
        else {
            this.compareSelection.push(entryId);
            // Two at a time: a third selection replaces the oldest, so the
            // control never needs an explicit "clear" step to keep working.
            if (this.compareSelection.length > 2) { this.compareSelection.shift(); }
        }
        this.renderRail();
    }

    async restoreVersion(entryId) {
        const entry = this.historyEntries.find(e => e.id === entryId);
        if (!entry || entry.snapshot === undefined) { return; }
        if (this.reviewing) {
            this.messageService.warn('Decide the pending changes before restoring an earlier version.');
            return;
        }
        this.setBody(entry.snapshot);
        this.lastSavedBody = undefined;              // force the write below
        await this.writeBody(entry.snapshot);
        this.lastSavedBody = entry.snapshot;
        this.historyEntries = await this.historyStore.record(this.uri, {
            kind: 'restore',
            title: 'Restored an earlier version',
            detail: 'From ' + entry.title + ' (' + new Date(entry.at).toLocaleString() + ')',
            body: entry.snapshot
        });
        this.compareSelection = [];
        this.setSaveState('saved');
        this.renderRail();
        this.messageService.info('Restored the version from ' + new Date(entry.at).toLocaleString() + '.');
    }

    // -- rail: quality -------------------------------------------------------

    /*
     * The fourth destination in this document's slot: specification signals.
     *
     * WHAT IT IS. Detectors that run outside Theia produce reports about a
     * document's duplication and about whether its sections read as the kind of
     * document it claims to be. This rail is where those reports become
     * something a person can act on: findings they can jump to, decline, or fix,
     * and — behind the second tab — the numbers that did not earn a place in the
     * findings list.
     *
     * WHY IT IS A RAIL AND NOT A PANEL OF ITS OWN. It dies with the document,
     * and it holds that document's triage. The project-scope half of the same
     * feature is a closable tab in the main dock (quality-project-view.js),
     * because a sixteen-file occurrence list plus source context does not fit a
     * 360px column — the same measurement that moved Search out of the rail.
     *
     * WHAT THIS SECTION OWNS AND WHAT IT DELEGATES. Everything here is
     * orchestration: read the reports, normalise them, reconcile them against
     * what was seen last time, resolve anchors into the live document, and route
     * clicks. The four hard questions are all somewhere else, on purpose —
     * identity in quality-identity.js, normalisation and ordering in
     * quality-scan.js, anchoring in quality-anchor.js, and the markup in
     * quality-view.js and quality-measures.js. That split is what lets the
     * engine be tested in milliseconds under plain node, which is the argument
     * search-scan.js makes at its head and it is the same argument.
     */

    /*
     * Read a run and make it presentable, once.
     *
     * Deliberately lazy and deliberately not on a keystroke. The reports are
     * files somebody or some CI job dropped into `.studio/quality/reports/`;
     * reading them costs a directory walk and a few JSON parses, which is
     * nothing next to a check but is not free either. So this runs when the rail
     * is first opened and when the sidecar changes underneath us, and never in
     * response to typing.
     */
    /*
     * "Check again" — and what that means depends on what is reachable.
     *
     * With a runner: run the detectors over THIS DOCUMENT. That is the purpose
     * pass only, measured at 68 ms on the corpus's largest PRD and needing no
     * model — CONTRACT-runner.md §1 records why duplication is not in it (the
     * bloat detector has no lexical-only mode, so it would cost 2.1 s and a
     * ~500 MB model load). Cross-document work belongs to the project tab,
     * whose scope matches that cost.
     *
     * Without one: re-read whatever is on disk, which is what this button has
     * always done and remains the honest action when the reports come from CI
     * or from a colleague's hand-drop.
     */
    async recheckQuality() {
        const runner = await this.qualityRunnerState();
        if (!runner || !runner.available || runner.running) {
            this.qualityLoaded = false;
            void this.refreshQuality();
            return;
        }
        this.qualityRun = { ...runner, running: true, done: 0, total: 1, current: this.qualityRelPath, error: undefined };
        this.renderRail();
        try {
            /*
             * PURPOSE ONLY — the comment above is the contract and this is where
             * it is kept. Without the filter this ran everything, which for one
             * document means the docset's duplication pass: measured here, a
             * ⟳ click sat on "Checking…" for over a minute loading the reranker
             * to answer a question about one file. The expensive pass belongs to
             * the project tab, where its cost is signposted and its scope
             * matches what it computes.
             */
            const started = await this.qualityRunner.run(this.qualityRoot, {
                scope: 'document', paths: [this.qualityRelPath], detectors: ['purpose']
            });
            this.qualityRunId = started && started.runId;
            this.qualityRunWatch = this.qualityRunner.watch(this.qualityRunId, progress => {
                this.qualityRun = { ...this.qualityRun, done: progress.done, total: progress.total, current: progress.current };
                this.renderRail();
            });
            const final = await this.qualityRunWatch;
            this.qualityRunWatch = undefined;
            this.qualityRun = {
                ...this.qualityRun, running: false,
                error: final && final.state === 'failed' ? (final.error || 'the detectors reported an error') : undefined
            };
            /* The run wrote FILES; the rail reads them the same way it reads a
             * hand-dropped report. There is no result payload over RPC, which is
             * the property that lets CI produce the same thing (PLAN §11). */
            this.qualityLoaded = false;
            await this.refreshQuality({ quiet: true });
            this.renderRail();
        } catch (e) {
            this.qualityRunWatch = undefined;
            this.qualityRun = { ...this.qualityRun, running: false, error: String((e && e.message) || e) };
            this.renderRail();
        }
    }

    async cancelQualityRun() {
        if (!this.qualityRunner || !this.qualityRunId) { return; }
        try { await this.qualityRunner.cancel(this.qualityRunId); } catch (e) { /* already finished */ }
        if (this.qualityRunWatch) { this.qualityRunWatch.cancel(); this.qualityRunWatch = undefined; }
        this.qualityRun = { ...this.qualityRun, running: false };
        this.renderRail();
    }

    /*
     * Probe once per document, and remember the answer. Whether a detector is
     * installed is a fact about the machine and the project, not about anything
     * the person is doing, so asking again on every render would spawn a
     * filesystem walk per repaint for an answer that cannot have changed.
     */
    async qualityRunnerState() {
        if (this.qualityRun) { return this.qualityRun; }
        if (!this.qualityRunner || !this.qualityRoot) { return undefined; }
        try {
            const probe = await this.qualityRunner.probe(this.qualityRoot);
            this.qualityRun = { available: !!(probe && probe.available), why: probe && probe.why };
        } catch (e) {
            this.qualityRun = { available: false, why: 'the runner could not be reached' };
        }
        return this.qualityRun;
    }

    async refreshQuality({ quiet = false } = {}) {
        if (this.qualityLoading || !this.qualityStore) { return; }
        this.qualityLoading = true;
        if (!quiet) { this.renderRail(); }
        try {
            const root = await this.qualityStore.rootFor(this.uri);
            const relPath = qualityRelativePath(root, this.uri);
            const reports = await this.qualityStore.loadReports(root);
            const state = await this.qualityStore.loadState(root);
            const judgments = await this.qualityStore.loadJudgments(root);

            this.qualityRoot = root;
            this.qualityRelPath = relPath;
            /*
             * Ask the backend whether there is a detector here, once, without
             * blocking this load — the reports on disk are what the panel is
             * about, and waiting on a probe to draw them would make a cheap
             * read wait on a filesystem walk. The answer only changes the
             * "Check again" tooltip and the project tab's button, so it can
             * arrive a moment late and repaint.
             */
            if (!this.qualityRun) {
                void this.qualityRunnerState().then(() => {
                    if (this.rail === 'quality' && this.railOpen) { this.renderRail(); }
                });
            }
            this.qualityReportStats = { read: reports.read, skipped: reports.skipped };
            this.qualityJudgments = judgments;
            this.qualityDocTypes = qualityScan.DOC_TYPES;

            const pair = this.qualityStore.reportsForDocument(reports, relPath) || {};
            if (!reports.present || (!pair.bloat && !pair.purpose)) {
                /*
                 * Two different absences, and the view renders them
                 * differently: no reports at all in the project, or reports that
                 * exist but none matching this document. Neither is an empty
                 * panel — a document nobody has checked and a document with
                 * nothing wrong must never look alike, and 14 of the 86 real
                 * documents are genuinely clean.
                 */
                this.qualityEnvelope = undefined;
                this.qualityFindings = [];
                this.qualityMissing = reports.present ? 'document' : 'project';
                this.qualityFreshness = { producedAt: reports.producedAt, present: reports.present };
                return;
            }

            this.qualityMissing = undefined;
            const override = (state.overrides || {})[relPath];
            const envelope = qualityScan.normalizeDocument({
                bloat: pair.bloat,
                purpose: pair.purpose,
                docPath: relPath,
                root: root.toString(),
                runId: reports.runId,
                producedAt: reports.producedAt,
                overrides: override,
                /*
                 * The other documents' numbers, so a rate can be stated as a
                 * rank. "the highest of 7 documents in this project" is
                 * actionable in a way that "9.3%" is not, and PLAN §5 asks for
                 * exactly that — the rate on its own discriminates nothing,
                 * because it is non-zero almost everywhere in the corpus.
                 */
                projectMetrics: qualityProjectMetrics(reports)
            });

            /*
             * Reconcile against what was seen last time, so a triage decision
             * survives a rescan and a re-word. `previous` is the slim record
             * saveLastRun wrote — enough anchors for the supersede case to be
             * decidable, and nothing else, because observations are disposable
             * and only judgments are kept.
             */
            /* An ARRAY of slim finding records — the shape saveLastRun below
             * writes, and the shape quality-store.js persists verbatim. */
            const previousRun = (state.lastRun || {})[relPath];
            const reconciled = qualityIdentity.reconcile({
                previous: Array.isArray(previousRun) ? previousRun : [],
                next: envelope.findings,
                judgments
            });

            /*
             * STALENESS IS A DOCUMENT-LEVEL FACT HERE, not a per-finding one,
             * and that is an honest limitation rather than a shortcut. A real
             * per-finding answer needs the content hash the detector read, and
             * the detectors do not emit one — so what can actually be known is
             * "this document has moved since the report was produced", which is
             * true of every finding in it or of none. The envelope keeps the
             * per-finding field for the day a runner fills it in.
             */
            const stale = await this.qualityStaleness(reports.producedAt);
            for (const finding of reconciled.findings) { finding.stale = stale; }

            envelope.findings = reconciled.findings;
            this.qualityEnvelope = envelope;
            this.qualityResolvedSince = reconciled.resolved.length;
            this.qualityFindings = qualityScan.orderFindings(reconciled.findings, this.qualitySort);
            this.qualityFreshness = {
                producedAt: reports.producedAt, present: true, stale,
                analyzers: envelope.analyzers
            };

            /*
             * Record what was seen, so the next load can tell resolved from
             * unchanged. Written after the counts above are computed, because
             * writing first would make every run look like the first one.
             */
            await this.qualityStore.saveLastRun(root, relPath,
                reconciled.findings.map(finding => ({
                    fingerprint: finding.fingerprint,
                    rule: finding.rule,
                    status: finding.status,
                    /*
                     * Enough anchor to make the supersede case decidable, and
                     * nothing else. Observations are disposable; this record
                     * exists only so the next run can tell "still here" from
                     * "resolved" from "the same problem, re-worded".
                     */
                    anchors: (finding.anchors || []).map(anchor =>
                        ({ file: anchor.file, section: anchor.section, text: anchor.text }))
                })));
        } catch (error) {
            /*
             * A malformed report is somebody else's tool's output, so it is an
             * expected condition rather than a defect here. Say so on the rail
             * instead of leaving a panel that renders nothing and explains
             * nothing.
             */
            console.warn('[studio] quality: could not read the run', error);
            this.qualityError = String((error && error.message) || error);
            this.qualityEnvelope = undefined;
            this.qualityFindings = [];
        } finally {
            this.qualityLoading = false;
            this.qualityLoaded = true;
            if (!this.isDisposed) {
                this.renderRail();
                refreshQualityMarks(this.editor);
            }
        }
    }

    /*
     * Has the document moved since the report was produced?
     *
     * Two ways it can have: unsaved edits in this buffer, or a saved file whose
     * mtime is newer than the newest report. Both mean the same thing to a
     * reader — "this may already be fixed" — and neither is allowed to silently
     * drop a finding, because dropping it would be a claim and the claim would
     * be wrong about half the time.
     */
    async qualityStaleness(producedAt) {
        if (this.saveState === 'dirty' || this.saveState === 'conflict') { return true; }
        if (!producedAt) { return false; }
        try {
            const stat = await this.fileService.resolve(this.uri, { resolveMetadata: true });
            return stat.mtime > new Date(producedAt).getTime();
        } catch (error) {
            return false;
        }
    }

    /*
     * The document's flattened text with a map back to positions, plus its
     * headings — the two things quality-anchor.js resolves against.
     *
     * The sentinel heading at the end is how the section resolver learns where
     * the document stops: a section's range runs to the next heading of the same
     * level or shallower, and the last section in a document has no such
     * heading. A level-0 sentinel is shallower than every real heading, so the
     * rule needs no special case for the final section.
     */
    qualityIndex() {
        if (!this.editor) { return undefined; }
        const doc = this.editor.state.doc;
        const index = buildTextIndex(doc);
        const headings = [];
        const seen = new Map();
        doc.forEach((node, offset) => {
            if (node.type.name !== 'heading') { return; }
            const text = node.textContent;
            const ordinal = seen.get(text) || 0;
            seen.set(text, ordinal + 1);
            headings.push({
                level: node.attrs.level, text,
                from: offset, to: offset + node.nodeSize, index: ordinal
            });
        });
        headings.push({ level: 0, text: '', from: doc.content.size, to: doc.content.size, index: 0 });
        return { index, headings };
    }

    /*
     * What the decoration plugin draws.
     *
     * Dismissed findings contribute nothing — their decorations leaving the text
     * is what dismissing IS. `later` findings keep theirs, because parking
     * something is not the same as deciding it is not a problem.
     *
     * Only anchors in THIS file are resolved. A cluster spanning sixteen files
     * has one card with sixteen jump targets; fifteen of them are links to other
     * documents, and this method is only about the one on screen.
     */
    qualityRanges() {
        if (!this.editor || !this.qualityFindings.length) { return []; }
        const resolved = this.qualityIndex();
        if (!resolved) { return []; }
        const relPath = this.qualityRelPath;
        const ranges = [];
        for (const finding of this.qualityFindings) {
            if (finding.status === 'dismissed') { continue; }
            if (this.qualityTrust === 'exact' && finding.trust !== 'exact') { continue; }
            if (this.qualityTrust === 'hide-weak' && finding.trust === 'weak') { continue; }
            for (const anchor of finding.anchors || []) {
                if (!qualitySameFile(anchor.file, relPath)) { continue; }
                const range = qualityAnchor.resolveAnchor(resolved.index, resolved.headings, anchor);
                if (!range) { continue; }
                ranges.push({
                    from: range.from, to: range.to,
                    kind: anchor.granularity === 'section' ? 'section' : 'span',
                    provenance: finding.provenance,
                    trust: finding.trust,
                    fingerprint: finding.fingerprint,
                    active: finding.fingerprint === this.activeFinding,
                    stale: !!finding.stale,
                    /* The chip carries a VALUE — what the section reads as —
                     * which is why it is passed as data rather than styled. */
                    label: anchor.granularity === 'section' ? qualitySectionLabel(finding) : undefined
                });
            }
        }
        return ranges;
    }

    /** The state object both tabs render from. One shape, two renderers. */
    qualityState() {
        const findings = this.qualityFindings;
        return {
            envelope: this.qualityEnvelope,
            tab: this.qualityTab,
            findings,
            partitioned: qualityScan.partition(findings, {
                trustFilter: this.qualityTrust,
                showWeak: this.qualityShowWeak,
                showDismissed: this.qualityShowDismissed
            }),
            trustFilter: this.qualityTrust,
            sort: this.qualitySort,
            showWeak: this.qualityShowWeak,
            showDismissed: this.qualityShowDismissed,
            activeFingerprint: this.activeFinding,
            explainFor: this.qualityExplainFor,
            pickerFor: this.qualityPickerFor,
            pickerReason: this.qualityPickerReason,
            undoFor: this.qualityUndoFor,
            resolvedSince: this.qualityResolvedSince,
            freshness: this.qualityFreshness || { present: false },
            missing: this.qualityMissing,
            error: this.qualityError,
            docRelPath: this.qualityRelPath,
            docTypes: this.qualityDocTypes,
            docTypeOpen: this.qualityDocTypeOpen,
            openSegment: this.qualitySegment,
            reportStats: this.qualityReportStats,
            scanning: this.qualityLoading,
            runner: this.qualityRun
        };
    }

    renderQuality() {
        /*
         * First open reads the run. Rendering the loading state first rather
         * than awaiting is what keeps the rail from appearing empty for the
         * duration of a directory walk — the same reason loader.js exists.
         */
        if (!this.qualityLoaded && !this.qualityLoading) { void this.refreshQuality(); }

        const state = this.qualityState();
        this.railHeadEl.innerHTML = qualityView.qualityHeadHtml(state);
        this.listEl.innerHTML = state.tab === 'measured'
            ? qualityMeasures.measuredListHtml(state)
            : qualityView.qualityListHtml(state);
        this.footEl.textContent = state.tab === 'measured'
            ? qualityMeasures.measuredFootText(state)
            : qualityView.qualityFootText(state);
    }

    /*
     * One entry point for every control on this rail.
     *
     * A single dispatcher rather than twenty cases in the widget's main switch,
     * because the vocabulary is exported from quality-view.js — the view and the
     * handler read the same list, so a renamed action is a missing method rather
     * than a button that silently does nothing.
     */
    onQualityAct(action, el) {
        const fingerprint = el.getAttribute('data-fp');
        switch (action) {
            case 'quality-tab':
                this.qualityTab = el.getAttribute('data-tab') === 'measured' ? 'measured' : 'findings';
                this.qualityExplainFor = undefined;
                this.renderRail();
                break;
            case 'quality-focus':
                this.focusFinding(fingerprint);
                break;
            case 'quality-jump':
                this.jumpToFinding(fingerprint, Number(el.getAttribute('data-anchor')) || 0);
                break;
            case 'quality-explain':
                this.qualityExplainFor = this.qualityExplainFor === fingerprint ? undefined : fingerprint;
                this.renderRail();
                break;
            case 'quality-explain-close':
                this.qualityExplainFor = undefined;
                this.renderRail();
                break;
            case 'quality-dismiss':
                this.qualityPickerFor = fingerprint;
                this.qualityPickerReason = undefined;
                this.renderRail();
                break;
            case 'quality-reason':
                this.qualityPickerReason = el.getAttribute('data-reason');
                /*
                 * "Wrong document type" is not a dismissal at all — it says the
                 * whole run was judged against the wrong template, and the fix
                 * is the type control rather than seven dismissals one at a
                 * time. Routing it is the reason the picker exists.
                 */
                if (this.qualityPickerReason === 'wrong-doc-type') {
                    this.qualityPickerFor = undefined;
                    this.qualityTab = 'measured';
                    this.qualityDocTypeOpen = true;
                }
                this.renderRail();
                break;
            case 'quality-dismiss-confirm':
                void this.judgeFinding(fingerprint, 'dismissed');
                break;
            case 'quality-picker-cancel':
                this.qualityPickerFor = undefined;
                this.qualityPickerReason = undefined;
                this.renderRail();
                break;
            case 'quality-later':
                void this.judgeFinding(fingerprint, 'later');
                break;
            case 'quality-undo':
            case 'quality-restore':
                void this.judgeFinding(fingerprint, 'open');
                break;
            case 'quality-toggle-weak':
                this.qualityShowWeak = !this.qualityShowWeak;
                this.renderRail();
                break;
            case 'quality-toggle-dismissed':
                this.qualityShowDismissed = !this.qualityShowDismissed;
                this.renderRail();
                refreshQualityMarks(this.editor);
                break;
            case 'quality-trust':
                this.qualityTrust = el.getAttribute('data-trust') || 'all';
                this.renderRail();
                refreshQualityMarks(this.editor);
                break;
            case 'quality-sort':
                this.qualitySort = el.getAttribute('data-sort') === 'reach' ? 'reach' : 'document';
                this.qualityFindings = qualityScan.orderFindings(this.qualityFindings, this.qualitySort);
                this.renderRail();
                break;
            case 'quality-fix':
                void this.applyQualityFix(fingerprint, el.getAttribute('data-kind'));
                break;
            case 'quality-recheck':
                void this.recheckQuality();
                break;
            case 'quality-cancel-run':
                void this.cancelQualityRun();
                break;
            case 'quality-dismiss-resolved':
                this.qualityResolvedSince = 0;
                this.renderRail();
                break;
            case 'quality-doctype':
                void this.setQualityDocType(el.getAttribute('data-type'));
                break;
            /* Two spellings, one behaviour. quality-measures.js renders the
             * disclosure and quality-view.js renders the reason picker's route
             * into it, and the two named the toggle differently — accepting
             * both is cheaper and safer than making one of them wrong, and a
             * disclosure that silently does nothing is the failure this avoids. */
            case 'quality-doctype-open':
            case 'quality-doctype-toggle':
                this.qualityDocTypeOpen = !this.qualityDocTypeOpen;
                this.renderRail();
                break;
            case 'quality-segment':
                this.qualitySegment = this.qualitySegment === el.getAttribute('data-role')
                    ? undefined : el.getAttribute('data-role');
                this.renderRail();
                break;
            case 'quality-open-project':
                void this.commandRegistry.executeCommand('studio.quality.project');
                break;
            default:
                break;
        }
    }

    /*
     * Make a card current, and light its marks.
     *
     * The pairing is focusChange()'s exact shape, which already exists twice in
     * this file: clicking a mark makes its card current and scrolls the rail;
     * clicking a card scrolls the document. A reviewer who clicks an underlined
     * sentence has to get an answer, and the answer is the card.
     */
    focusFinding(fingerprint, { fromDocument = false } = {}) {
        this.activeFinding = fingerprint;
        this.qualityExplainFor = undefined;
        if (!this.railOpen || this.rail !== 'quality') { this.openSlot('quality'); }
        else { this.renderRail(); }
        refreshQualityMarks(this.editor);
        if (fromDocument) {
            const card = this.listEl.querySelector('[data-quality-card="' + fingerprint + '"]');
            if (card) { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        } else {
            this.jumpToFinding(fingerprint, 0, { keepFocus: true });
        }
    }

    /*
     * Scroll to one of a finding's places.
     *
     * An anchor in ANOTHER file is a link, not a jump: it opens that document,
     * where its own rail can triage it. 246 of the 288 real clusters span two
     * places and one spans sixteen files, so "the other places" is the common
     * case rather than an edge.
     */
    jumpToFinding(fingerprint, anchorIndex, { keepFocus = false } = {}) {
        const finding = this.qualityFindings.find(candidate => candidate.fingerprint === fingerprint);
        if (!finding) { return; }
        if (!keepFocus) { this.activeFinding = fingerprint; this.renderRail(); refreshQualityMarks(this.editor); }
        const anchor = (finding.anchors || [])[anchorIndex];
        if (!anchor) { return; }

        if (!qualitySameFile(anchor.file, this.qualityRelPath)) {
            void this.openQualityAnchorFile(anchor.file);
            return;
        }

        const resolved = this.qualityIndex();
        if (!resolved) { return; }
        const range = qualityAnchor.resolveAnchor(resolved.index, resolved.headings, anchor);
        if (!range) {
            /*
             * The text moved. Said out loud rather than scrolling somewhere
             * arbitrary — a quality tool that highlights the wrong sentence is
             * worse than one that admits it lost the right one.
             */
            this.messageService.info('That passage has changed since the check ran.');
            return;
        }
        const el = this.editor.view.dom.querySelector('[data-quality="' + fingerprint + '"]');
        if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }

    /*
     * Write a judgment, and give it back for a few seconds.
     *
     * A mis-click here writes to a file that gets committed, so undo is not a
     * nicety. The card collapses to "Dismissed — undo", its decorations leave
     * the text, and it moves into a counted, collapsed Dismissed row — never
     * deleted, always restorable, because "what have we already decided about
     * this file" should be one click rather than a git log.
     */
    async judgeFinding(fingerprint, status) {
        const finding = this.qualityFindings.find(candidate => candidate.fingerprint === fingerprint);
        if (!finding || !this.qualityStore || !this.qualityRoot) { return; }

        if (status === 'open') {
            finding.status = 'open';
            finding.judgment = undefined;
            delete this.qualityJudgments[fingerprint];
            this.qualityUndoFor = undefined;
            await this.qualityStore.clearJudgment(this.qualityRoot, fingerprint);
        } else {
            const note = this.qualityPickerFor === fingerprint
                ? (this.listEl.querySelector('[data-quality-note]') || {}).value
                : undefined;
            const record = {
                status,
                /*
                 * A reason is required for a dismissal and meaningless for
                 * "later": parking something says nothing about whether the
                 * detector was right, and the closed vocabulary exists to be the
                 * one piece of ground truth this product can generate about
                 * detector quality. Recording it from the first day is what
                 * makes a false-positive rate measurable later, and it costs one
                 * enum.
                 */
                reason: status === 'dismissed' ? (this.qualityPickerReason || 'wont-fix') : undefined,
                note: note && note.trim() ? note.trim() : undefined
            };
            finding.status = status;
            finding.judgment = record;
            this.qualityJudgments[fingerprint] = record;
            this.qualityUndoFor = status === 'dismissed' ? fingerprint : undefined;
            await this.qualityStore.saveJudgment(this.qualityRoot, fingerprint, record);
        }

        this.qualityPickerFor = undefined;
        this.qualityPickerReason = undefined;
        if (this.activeFinding === fingerprint && status === 'dismissed') { this.activeFinding = undefined; }
        this.renderRail();
        this.renderSlotCluster();
        refreshQualityMarks(this.editor);

        if (this.qualityUndoFor) {
            clearTimeout(this.qualityUndoTimer);
            this.qualityUndoTimer = setTimeout(() => {
                if (this.isDisposed) { return; }
                this.qualityUndoFor = undefined;
                this.renderRail();
            }, QUALITY_UNDO_MS);
        }
    }

    /*
     * Correct the document type, and re-read everything against it.
     *
     * THE HIGHEST-LEVERAGE CONTROL IN THE FEATURE, and until now there was no
     * way to say the inference was wrong at all. The type is inferred from the
     * filename and it is the INPUT to the purpose detector — if it is wrong,
     * every violation is wrong. Nothing else in this product turns seven
     * findings into zero with one click.
     *
     * What it cannot do yet is re-run the detector: there is no runner in this
     * build, so the override is recorded and the gate is re-evaluated against
     * the sections the existing report already classified. That is a real
     * answer for the common case — a document classified as an ADR that is
     * actually a PRD — and it is honest about being a re-reading rather than a
     * re-analysis, which the Measured tab says in words.
     */
    async setQualityDocType(docType) {
        if (!docType || !this.qualityStore || !this.qualityRoot) { return; }
        this.qualityDocTypeOpen = false;
        await this.qualityStore.saveDocTypeOverride(this.qualityRoot, this.qualityRelPath, docType);
        this.qualityLoaded = false;
        await this.refreshQuality();
    }

    /*
     * The four tiers of "fix it", and which of them this build actually has.
     *
     * Every one of them lands in the EXISTING review pipeline as a pending
     * proposal — never a silent write. That is already this product's rule for
     * assistant edits and for generated figures, and a quality tool that edited
     * files behind a reviewer's back would be the one place it is broken.
     */
    async applyQualityFix(fingerprint, kind) {
        const finding = this.qualityFindings.find(candidate => candidate.fingerprint === fingerprint);
        if (!finding) { return; }

        if (kind === 'dedupe-link') { return this.applyDedupeLink(finding); }
        if (kind === 'move-section') { return this.applyQualityMove(finding); }

        /*
         * Tier 3 — anything needing judgment — goes to an assistant, and the
         * label says so. Tier 2 no longer does: applyQualityMove computes the
         * cut and the insert itself and opens them as ONE linked pair of
         * proposals, which is what `groupId` in changes-store.js exists for.
         * A move that cannot be computed falls through to here rather than
         * failing, because a precise instruction to a model is slower and not
         * wrong.
         */
        const excerpt = finding.quote || '';
        const instruction = qualityFixInstruction(finding, this.qualityRelPath);
        return this.startChangeRequest('claude', instruction, excerpt, undefined);
    }

    /*
     * Tier 2: the structural one — a section moved to the document it belongs
     * in, as ONE linked pair of proposals.
     *
     * Two documents, and they must not be half-accepted: a cut here without an
     * insert there deletes somebody's section. `groupId` is what makes accept
     * and reject cover both, and changes-store.js validates every member
     * against its own base BEFORE writing anything, so a target edited since
     * the check refuses the whole move rather than applying half of it.
     *
     * The target is a sibling of the source, named by the role the detector
     * assigned: design leaks go to DESIGN.md, requirements to PRD.md, and a
     * decision goes nowhere — its home is a NEW ADR, which a move cannot
     * create, so that case falls through to an assistant. Refusals here are
     * loud and specific, because the alternative to a refusal is guessing where
     * a paragraph of somebody's specification should live.
     */
    async applyQualityMove(finding) {
        const suggested = finding.fix && finding.fix.suggestedFile;
        if (!suggested) {
            this.messageService.warn('There is no document to move this into — ' +
                ((finding.fix && finding.fix.belongsIn) || 'its home') + ' would have to be written first.');
            return;
        }
        const targetRel = await this.findQualityTarget(suggested);
        if (!targetRel) {
            this.messageService.warn('There is no ' + suggested + ' in this document\'s service folder to move the section into.');
            return;
        }
        if (targetRel === this.qualityRelPath) {
            this.messageService.warn('That section is already in the document it belongs in.');
            return;
        }
        const targetUri = this.qualityRoot.resolve(targetRel);

        const sourceBody = this.currentBody();
        const targetRead = await this.fileService.read(targetUri);
        const targetSplit = splitFrontmatter(targetRead.value);

        const plan = qualityMove.planMove({
            finding, sourceBody, targetBody: targetSplit.body,
            sourcePath: this.qualityRelPath, targetPath: targetRel
        });
        if (!plan.ok) {
            this.messageService.warn(plan.why);
            return;
        }

        /*
         * One id for both halves. Derived from the finding's fingerprint rather
         * than randomly, so re-running the same move on the same finding lands
         * in the same group instead of creating a second one beside the first.
         */
        const groupId = 'move-' + finding.fingerprint;
        const members = [this.qualityRelPath, targetRel];
        const heading = (plan.source.removed && plan.source.removed.heading) || 'that section';
        const instruction = 'Move "' + qualityShorten(heading) + '" to ' + suggested;

        /*
         * THE TARGET FIRST, and deliberately. The source half goes through
         * captureProposal, which writes the base to disk and locks this editor
         * for review; if the target's write failed after that, a reviewer would
         * be looking at half a move with the editor already locked. Writing the
         * side we do not own first means a failure there aborts before anything
         * visible has happened here.
         */
        const targetProposals = (await this.changesStore.load(targetUri)).proposals;
        targetProposals.push(ChangesStore.proposal({
            title: instruction,
            origin: 'quality',
            instruction,
            author: identity.displayName(),
            baseBody: targetSplit.body,
            proposedBody: plan.target.body,
            groupId,
            groupMembers: members
        }));
        await this.changesStore.save(targetUri, targetProposals);

        await this.captureProposal(plan.source.body, {
            instruction, origin: 'quality', author: identity.displayName(),
            base: sourceBody, groupId, groupMembers: members
        });
        this.openSlot('changes');
        this.messageService.info(instruction + ' — review it here and in ' + suggested + '; they accept together.');
    }

    /*
     * Where the service's DESIGN.md (or PRD.md) actually is: beside this
     * document, or in a directory above it, up to the project root.
     *
     * NOT JUST THE SIBLING. An ADR lives in `<service>/ADR/0010-….md` and its
     * design document is `<service>/DESIGN.md`, one level up — measured across
     * the real corpus, a sibling-only search finds a target for 35 of the 46
     * purpose violations and refuses the other 11 for a document that is
     * plainly there. Nearest first, so a service that does have its own
     * `ADR/DESIGN.md` wins over the one at the service root.
     *
     * Stops at the project root, and never leaves it: a search that walked past
     * the root would offer to move a paragraph of somebody's specification into
     * a file from an unrelated project.
     */
    async findQualityTarget(filename) {
        const segments = this.qualityRelPath.split('/').filter(Boolean).slice(0, -1);
        while (true) {
            const candidate = segments.concat(filename).join('/');
            if (await this.fileService.exists(this.qualityRoot.resolve(candidate))) { return candidate; }
            if (!segments.length) { return undefined; }
            segments.pop();
        }
    }

    /*
     * Tier 1: the deterministic one.
     *
     * When every occurrence of a cluster is textually identical — 130 of the
     * 288 real clusters — the edit does not need a model. Keep the first
     * occurrence, replace the others with a link to the section it lives in, and
     * open the result as a proposal.
     *
     * COMPUTED AGAINST THE MARKDOWN SOURCE, not the ProseMirror document,
     * because a proposal is a body and the review pipeline diffs bodies. If the
     * text is not found verbatim in the source, this says so and does nothing —
     * the detector read a normalised copy of the file on disk, and a
     * find-and-replace that guesses which near-match was meant is exactly the
     * silent corruption this whole feature is supposed to be the opposite of.
     */
    async applyDedupeLink(finding) {
        const base = this.currentBody();
        const here = (finding.anchors || []).filter(anchor => qualitySameFile(anchor.file, this.qualityRelPath));
        if (here.length < 2) {
            this.messageService.warn('This repetition spans other documents, so it cannot be de-duplicated from here.');
            return;
        }

        const keep = here[0];
        const label = qualityAnchor.sectionLeaf(keep.section) || 'above';
        const link = 'See [' + label + '](#' + qualitySlug(label) + ').';

        let proposed = base;
        let replaced = 0;
        for (const anchor of here.slice(1)) {
            const text = anchor.text || '';
            if (!text || !proposed.includes(text)) { continue; }
            proposed = proposed.replace(text, link);
            replaced++;
        }
        if (!replaced) {
            this.messageService.warn('That wording has changed since the check ran — re-check before de-duplicating.');
            return;
        }
        await this.captureProposal(proposed, {
            instruction: 'Keep one copy of "' + qualityShorten(keep.text || finding.quote) +
                '" and link to it from ' + replaced + (replaced === 1 ? ' other place' : ' other places'),
            origin: 'quality',
            author: identity.displayName(),
            base
        });
        this.openSlot('changes');
    }

    /*
     * Open a sibling document a finding also points at.
     *
     * Same shape as openChangedFile above — the opener service, and a message
     * rather than a console line when it fails, because the click came from a
     * visible link and a link that does nothing is a defect the user cannot
     * diagnose. The path is the DETECTOR'S, relative to its own root, so the
     * longest-suffix match quality-store.js does for reports is done again here:
     * a report can name `tests/traceability/assess/mcp-engine/DESIGN.md` for a
     * file that lives at `mcp-engine/DESIGN.md` in this project.
     */
    async openQualityAnchorFile(reportPath) {
        if (!this.openerService || !this.qualityRoot) { return; }
        const candidates = qualitySuffixCandidates(reportPath);
        for (const relative of candidates) {
            const target = this.qualityRoot.resolve(relative);
            try {
                if (!(await this.fileService.exists(target))) { continue; }
                const opener = await this.openerService.getOpener(target);
                await opener.open(target);
                return;
            } catch (error) { /* try the next, shorter candidate */ }
        }
        this.messageService.info(reportPath + ' is not in this project.');
    }

    // -- slash menu ----------------------------------------------------------

    updateSlash() {
        if (!this.editor || this.mode === 'raw') { return this.hideSlash(); }
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || this.editor.isActive('codeBlock')) { return this.hideSlash(); }
        const start = $from.start();
        const before = state.doc.textBetween(start, $from.pos, '\n', '\n');
        const m = before.match(/(?:^|\s)\/([A-Za-z0-9]*)$/);
        if (!m) { return this.hideSlash(); }
        this.slashFrom = $from.pos - m[1].length - 1;
        const q = m[1].toLowerCase();
        const items = SLASH_ITEMS.filter(i => !q || i.label.toLowerCase().includes(q) || i.key.startsWith(q));
        if (!items.length) { return this.hideSlash(); }
        this.slashItems = items;
        this.slashIndex = 0;
        this.slashEl.innerHTML = items.map((i, n) =>
            '<div class="studio-slash-item' + (n === 0 ? ' sel' : '') + '" data-slash="' + i.key + '">' +
            '<span class="studio-slash-icon">' + i.icon + '</span>' +
            '<span class="studio-slash-label">' + i.label + '<em>' + i.hint + '</em></span></div>').join('');
        const rect = this.editor.view.coordsAtPos($from.pos);
        const host = this.node.getBoundingClientRect();
        this.slashEl.style.left = Math.round(rect.left - host.left) + 'px';
        this.slashEl.style.top = Math.round(rect.bottom - host.top + 6) + 'px';
        this.slashEl.hidden = false;
    }

    hideSlash() { if (this.slashEl) { this.slashEl.hidden = true; } this.slashItems = undefined; }

    applySlash(key) {
        const item = SLASH_ITEMS.find(i => i.key === key);
        if (!item) { return; }
        const chain = this.editor.chain().focus().deleteRange({ from: this.slashFrom, to: this.editor.state.selection.from });
        if (item.defer) {
            // The range has to go BEFORE the surface opens: a popover positioned
            // at the caret has to be positioned at where the caret ends up, and
            // an image picker that returns to a document still holding `/image`
            // inserts its image after it.
            chain.run();
            this.hideSlash();
            item.run(undefined, this);
            return;
        }
        item.run(chain, this).run();
        this.hideSlash();
    }

    async importImage() {
        if (this.readOnly || !this.editor) { return; }
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'image/*';
        picker.hidden = true;
        document.body.appendChild(picker);
        picker.addEventListener('change', async () => {
            try {
                const file = picker.files && picker.files[0];
                if (!file) { return; }
                await this.insertImageFile(file);
            } catch (e) {
                // insertImageFile already reports the error; this branch only
                // keeps the picker lifecycle independent of that report.
            } finally {
                picker.remove();
            }
        }, { once: true });
        picker.click();
    }

    async insertImageFile(file) {
        try {
            const relativePath = await this.copyImageToAssets(file);
            this.editor.chain().focus().insertContent({
                type: 'image', attrs: { src: relativePath, alt: this.imageAlt(file.name) }
            }).run();
        } catch (e) {
            console.error('[studio] image import failed', e);
            this.messageService.error('Could not add the image. The document was not changed.');
            throw e;
        }
    }

    imageAlt(name) {
        return String(name).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Image';
    }

    async copyImageToAssets(file) {
        const documentDir = this.uri.parent;
        let assetsDir;
        for (const name of ['img', 'images', 'assets']) {
            const candidate = documentDir.resolve(name);
            if (await this.fileService.exists(candidate)) { assetsDir = candidate; break; }
        }
        if (!assetsDir) {
            assetsDir = documentDir.resolve('assets');
            await this.fileService.createFolder(assetsDir);
        }

        const sourceName = String(file.name || 'image').replace(/[\\/]/g, '-');
        const dot = sourceName.lastIndexOf('.');
        const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
        const ext = dot > 0 ? sourceName.slice(dot) : '';
        let n = 0;
        let target;
        do {
            target = assetsDir.resolve(stem + (n ? '-' + n : '') + ext);
            n++;
        } while (await this.fileService.exists(target));

        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.fileService.createFile(target, BinaryBuffer.wrap(bytes), { overwrite: false });
        const prefix = documentDir.path.toString().replace(/\/$/, '') + '/';
        return target.path.toString().startsWith(prefix)
            ? target.path.toString().slice(prefix.length)
            : target.path.base;
    }

    // -- selection toolbar ---------------------------------------------------

    updateBubble() {
        if (!this.editor || this.mode === 'raw') { return this.hideBubble(); }
        const { state } = this.editor;
        const { from, to, empty } = state.selection;
        if (empty || this.editor.isActive('codeBlock')) { return this.hideBubble(); }
        const marks = [
            ['bold', 'B', this.editor.isActive('bold')],
            ['italic', 'I', this.editor.isActive('italic')],
            ['code', '&lt;/&gt;', this.editor.isActive('code')],
            ['link', 'Link', this.editor.isActive('link')]
        ];
        this.bubbleEl.innerHTML = marks.map(([k, label, active]) =>
            '<button class="studio-bubble-btn' + (active ? ' on' : '') + '" data-mark="' + k + '">' + label + '</button>').join('') +
            '<span class="studio-bubble-sep"></span>' +
            '<button class="studio-bubble-btn comment" data-mark="comment">Comment</button>' +
            '<button class="studio-bubble-btn ai" data-mark="ai" title="Ask AI to edit this selection">' + ICONS.spark + ' Ask AI</button>';
        const start = this.editor.view.coordsAtPos(from);
        const end = this.editor.view.coordsAtPos(to);
        const host = this.node.getBoundingClientRect();
        this.bubbleEl.hidden = false;
        const width = this.bubbleEl.offsetWidth || 320;
        this.bubbleEl.style.left = Math.max(8, Math.round((start.left + end.left) / 2 - host.left - width / 2)) + 'px';
        this.bubbleEl.style.top = Math.round(start.top - host.top - 46) + 'px';
    }

    /*
     * Emptied as well as hidden. The buttons act on a selection, so once there
     * is no selection they are stale: leaving them in the DOM keeps them in the
     * accessibility tree and the tab order, and it is what made the CSS bug
     * above present as a fully usable toolbar rather than an empty box.
     */
    hideBubble() {
        if (!this.bubbleEl) { return; }
        this.bubbleEl.hidden = true;
        this.bubbleEl.innerHTML = '';
    }

    // -- table toolbar -------------------------------------------------------

    updateTableBar() {
        if (!this.editor || this.mode === 'raw' || this.reviewing || this.readOnly) { return this.hideTableBar(); }
        const ctx = cellContext(this.editor.state);
        if (!ctx) { return this.hideTableBar(); }
        const align = currentAlign(this.editor);
        const groups = [];
        let lastGroup;
        for (const cmd of TABLE_COMMANDS) {
            if (lastGroup && cmd.group !== lastGroup) { groups.push('<span class="studio-bubble-sep"></span>'); }
            lastGroup = cmd.group;
            const on = cmd.key === 'align-' + align;
            groups.push('<button class="studio-bubble-btn' + (on ? ' on' : '') + '" data-tcmd="' + cmd.key +
                '" title="' + cmd.label + '" aria-label="' + cmd.label + '">' + cmd.icon + '</button>');
        }
        this.tableBarEl.innerHTML = groups.join('');
        const host = this.node.getBoundingClientRect();
        this.tableBarEl.hidden = false;
        const width = this.tableBarEl.offsetWidth || 460;
        const height = this.tableBarEl.offsetHeight || 36;

        /*
         * Anchor to the TABLE, never to the caret.
         *
         * This used to sit 84px above the caret, which put it on top of the
         * table whenever the caret was in the third row or lower: measured with
         * a four-row table, the bar occupied y591-627 while the header row's
         * centre was y608, so a click meant for the first header cell landed on
         * the bar's "insert column before" button and silently added a column.
         * The toolbar was eating clicks aimed at the thing it edits.
         *
         * It was a knife-edge coincidence of one magic offset against the row
         * height, so it appeared and disappeared with any small layout change --
         * which is also why a test that clicks cell centres could pass for a
         * long time and then fail for reasons that look unrelated.
         *
         * Above the table if there is room, below it otherwise. Either way it
         * cannot cover a cell.
         */
        const domAt = this.editor.view.domAtPos(this.editor.state.selection.from);
        const fromNode = domAt && domAt.node
            ? (domAt.node.nodeType === 1 ? domAt.node : domAt.node.parentElement)
            : undefined;
        const tableEl = fromNode && fromNode.closest ? fromNode.closest('table') : undefined;

        let left;
        let top;
        if (tableEl) {
            const box = tableEl.getBoundingClientRect();
            left = Math.round(box.left + box.width / 2 - host.left - width / 2);
            const above = Math.round(box.top - host.top - height - 8);
            top = above >= 8 ? above : Math.round(box.bottom - host.top + 8);
        } else {
            // No table DOM (shouldn't happen while cellContext resolves) — fall
            // back to the caret, still clamped inside the widget.
            const coords = this.editor.view.coordsAtPos(this.editor.state.selection.from);
            left = Math.round(coords.left - host.left - width / 2);
            top = Math.round(coords.top - host.top - height - 8);
        }
        this.tableBarEl.style.left = Math.max(8, Math.min(left, Math.round(host.width - width - 8))) + 'px';
        this.tableBarEl.style.top = Math.max(8, Math.min(top, Math.round(host.height - height - 8))) + 'px';
    }

    /* Emptied as well as hidden, for the same reason as hideBubble(). */
    hideTableBar() {
        if (!this.tableBarEl) { return; }
        this.tableBarEl.hidden = true;
        this.tableBarEl.innerHTML = '';
    }

    runTableCommand(key) {
        const cmd = TABLE_COMMANDS.find(c => c.key === key);
        if (!cmd) { return; }
        const changed = cmd.run(this.editor);
        if (changed === false) {
            // Nothing moved — the caret is already at the edge of the table.
            this.tableBarEl.classList.add('nudge');
            setTimeout(() => this.tableBarEl.classList.remove('nudge'), 220);
            return;
        }
        this.updateTableBar();
    }

    // -- events --------------------------------------------------------------

    onKeyDown(e) {
        const meta = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        if (meta && (key === 'z' || (key === 'y' && !e.shiftKey))) {
            e.preventDefault();
            e.stopPropagation();
            const redo = (key === 'z' && e.shiftKey) || key === 'y';
            if (this.sourceEl && this.sourceEl === document.activeElement) {
                // Raw mode is a native textarea, so preserve its own undo stack
                // instead of attempting to mirror it in the document model.
                document.execCommand(redo ? 'redo' : 'undo');
            } else if (this.editor) {
                if (redo) { this.editor.commands.redo(); }
                else { this.editor.commands.undo(); }
            }
            return;
        }
        if (meta && key === 's') {
            e.preventDefault();
            e.stopPropagation();
            this.save();
            return;
        }
        if (meta && e.shiftKey && e.key.toLowerCase() === 'z' && this.decisionJournal.length && this.reviewing) {
            e.preventDefault();
            this.undoLastDecision();
        }
    }

    /*
     * `Element.closest()` walks all the way to <html>, so an unscoped lookup
     * here can match an element in Theia's OWN shell — which uses `data-mode`
     * on the sidebar containers this widget is nested inside. That made every
     * click in the widget look like a mode switch and return before reaching
     * its real handler. Product attributes are `data-studio-*` prefixed AND
     * matches are required to live inside this widget: either fix alone would
     * do, but the pair means a future attribute name cannot resurrect it.
     */
    closestIn(target, selector) {
        const found = target.closest ? target.closest(selector) : undefined;
        return found && this.node.contains(found) ? found : undefined;
    }

    onClick(e) {
        /*
         * Any click outside the rendered text dismisses the selection toolbar.
         *
         * On macOS, clicking a button does not move focus, so the editor keeps
         * both focus and its selection — the toolbar therefore survived clicks
         * on the rail and the topbar, hanging over the document long after the
         * user had moved on. The toolbar's own buttons are excluded, since
         * they act ON that selection.
         */
        if (this.bubbleEl && !this.bubbleEl.hidden &&
            !this.closestIn(e.target, '.studio-bubble') &&
            !(this.editor && this.editor.view.dom.contains(e.target))) {
            this.hideBubble();
        }

        // A click inside a composer must never trigger a re-render: rebuilding
        // the rail's innerHTML destroys the textarea mid-typing.
        if (this.closestIn(e.target, 'textarea')) { return; }

        const mode = this.closestIn(e.target, '[data-studio-mode]');
        if (mode) { e.preventDefault(); this.setMode(mode.getAttribute('data-studio-mode')); return; }

        /*
         * The slot cluster is back inside this widget's node, so this branch is
         * back too -- it was deleted while the selector lived in the shell's
         * right-hand strip, which called selectSlot() directly.
         *
         * selectSlot() with its default toggle=true: clicking the destination
         * that is already open closes the slot and gives the width back to the
         * document. A dimmed entry is a real, focusable button (see the .off
         * note in slot-strip.js), so it has to be skipped here rather than by
         * the DOM.
         */
        const slot = this.closestIn(e.target, '[data-studio-rail]');
        if (slot) {
            e.preventDefault();
            if (slot.getAttribute('aria-disabled') !== 'true') {
                this.selectSlot(slot.getAttribute('data-studio-rail'));
            }
            return;
        }

        const tableCmd = this.closestIn(e.target, '[data-tcmd]');
        if (tableCmd) { e.preventDefault(); this.runTableCommand(tableCmd.getAttribute('data-tcmd')); return; }

        const slash = this.closestIn(e.target, '[data-slash]');
        if (slash) { e.preventDefault(); this.applySlash(slash.getAttribute('data-slash')); return; }

        const mark = this.closestIn(e.target, '[data-mark]');
        if (mark) {
            e.preventDefault();
            const k = mark.getAttribute('data-mark');
            if (k === 'comment') { this.createThreadFromSelection(); return; }
            if (k === 'ai') { this.askAiForSelection(mark); return; }
            if (k === 'link') {
                const href = window.prompt('Link URL', this.editor.getAttributes('link').href || 'https://');
                if (href === null) { return; }
                if (!href) { this.editor.chain().focus().unsetLink().run(); } else { this.editor.chain().focus().setLink({ href }).run(); }
                return;
            }
            this.editor.chain().focus()['toggle' + k[0].toUpperCase() + k.slice(1)]().run();
            this.updateBubble();
            return;
        }

        /*
         * A click on a tracked mark in the document selects that change.
         *
         * Before the [data-act] lookup, because the marks carry no data-act of
         * their own on purpose: a struck-through sentence is not a button, and
         * giving it one would make "accept" a thing that can happen from a
         * mis-aimed click in the middle of the prose. Selecting is the whole
         * affordance; the decision stays on the card, where the two verdicts sit
         * side by side and one of them is destructive.
         */
        const trackedMark = this.trackedEl && !this.trackedEl.hidden
            ? this.closestIn(e.target, '.studio-tc') : undefined;
        if (trackedMark && this.trackedEl.contains(trackedMark)) {
            this.focusChange(trackedMark.getAttribute('data-hunk'),
                trackedMark.getAttribute('data-proposal'), { fromDocument: true });
            return;
        }

        /*
         * A click on a quality mark selects its card, and never decides
         * anything — the same rule the tracked marks above follow, for the same
         * reason: an underlined sentence is not a button, and a mis-aimed click
         * in the middle of the prose must not be able to dismiss a finding. The
         * decision stays on the card.
         */
        const qualityMark = this.closestIn(e.target, '[data-quality]');
        if (qualityMark && !this.closestIn(e.target, '[data-act]')) {
            e.preventDefault();
            this.focusFinding(qualityMark.getAttribute('data-quality'), { fromDocument: true });
            return;
        }

        const act = this.closestIn(e.target, '[data-act]');
        const isArmedDeleteTarget = act && act.getAttribute('data-act') === 'comment-delete' &&
            act.getAttribute('data-id') === this.armedDeleteId;
        if (!isArmedDeleteTarget) { this.disarmDelete(); }
        if (act) {
            const a = act.getAttribute('data-act');
            const id = act.getAttribute('data-id');
            /*
             * Which store owns this decision.
             *
             * Present on every card, absent on the diff queue's own hunk
             * controls — and that absence is the routing rule rather than a
             * defect: a queue hunk can only belong to the one assistant
             * proposal, so it has nothing to name.
             */
            const proposalId = act.getAttribute('data-proposal');
            const suggested = proposalId && this.suggestions.some(p => p.id === proposalId);
            /*
             * One dispatcher for the quality rail instead of twenty cases here.
             * The action names are exported from quality-view.js and read by
             * both sides, so a renamed action is a missing method rather than a
             * button that silently does nothing.
             */
            if (a.startsWith('quality-')) { e.preventDefault(); this.onQualityAct(a, act); return; }
            switch (a) {
                case 'unlock': this.unlock(); break;
                case 'save-now': this.save(); break;
                case 'toggle-autosave': this.toggleAutosave(); break;
                case 'new-document-comment': this.createDocumentThread(); break;
                case 'toggle-resolved-threads': this.toggleResolvedThreads(); break;
                case 'show-resolved-thread': this.showResolvedThread(id); break;
                case 'comment-send': {
                    const ta = this.listEl.querySelector('[data-thread="' + id + '"] textarea');
                    if (ta) { this.addMessage(id, ta.value); }
                    break;
                }
                case 'comment-resolve': this.toggleResolved(id); break;
                case 'comment-delete':
                    if (this.armedDeleteId === id) { this.deleteThread(id); } else { this.armDelete(id, act); }
                    break;
                case 'comment-request-change': this.requestChangeFromComment(id, act); break;
                case 'hunk-accept':
                    if (suggested) { this.decideSuggestion(proposalId, id, 'accepted'); }
                    else { this.decideHunk(id, 'accepted'); }
                    break;
                case 'hunk-reject':
                    if (suggested) { this.decideSuggestion(proposalId, id, 'rejected'); }
                    else { this.decideHunk(id, 'rejected'); }
                    break;
                case 'focus-change': this.focusChange(id, proposalId); break;
                case 'reopen-change':
                    if (suggested) { this.reopenSuggestion(id); } else { this.reopenChange(id); }
                    break;
                case 'counter-suggest': this.counterSuggest(proposalId); break;
                case 'withdraw-suggestion': this.withdrawSuggestion(proposalId); break;
                case 'suggest-mode': this.setSuggestMode(act.getAttribute('data-mode')); break;
                case 'hunk-prev': this.stepHunk(-1); break;
                case 'hunk-next': this.stepHunk(1); break;
                case 'accept-all': this.decideAll('accepted'); break;
                case 'reject-all': this.decideAll('rejected'); break;
                case 'accept-all-files': this.decideAllFiles('accepted'); break;
                case 'reject-all-files': this.decideAllFiles('rejected'); break;
                case 'undo-decision': this.undoLastDecision(); break;
                case 'retry-pending-files': this.pendingFilesAvailable = undefined; this.renderRail(); void this.refreshPendingFiles(); break;
                case 'open-changed-file': this.openChangedFile(act.getAttribute('data-path')); break;
                case 'rail-changes': this.openSlot('changes'); break;
                case 'close-compare': this.comparing = undefined; this.renderRail(); break;
                case 'clear-compare': this.compareSelection = []; this.renderRail(); break;
                case 'history-compare': this.toggleCompare(id); break;
                case 'history-restore': this.restoreVersion(id); break;
                case 'conflict-compare': this.resolveConflict('compare'); break;
                case 'conflict-mine': this.resolveConflict('mine'); break;
                case 'conflict-theirs': this.resolveConflict('theirs'); break;
                case 'dup-switch': this.resolveDuplicate('switch'); break;
                case 'dup-resume': this.resolveDuplicate('resume'); break;
                case 'dup-takeover': this.resolveDuplicate('takeover'); break;
                default: break;
            }
            return;
        }

        const threadEl = this.closestIn(e.target, '[data-thread]');
        if (threadEl) {
            const id = threadEl.getAttribute('data-thread');
            if (id === this.activeThreadId) { return; }     // no needless re-render
            this.activeThreadId = id;
            this.renderRail();
            return;
        }

        const inMark = this.closestIn(e.target, '.studio-comment-mark');
        if (inMark) {
            this.activeThreadId = inMark.getAttribute('data-comment-id');
            this.openSlot('comments');
            this.renderRail();
            return;
        }

        // A gutter mark is the same intent as clicking the quoted text, so it
        // shares the path rather than growing a second one.
        const gutterMark = this.closestIn(e.target, '[data-gutter-thread]');
        if (gutterMark) {
            e.preventDefault();
            this.activeThreadId = gutterMark.getAttribute('data-gutter-thread');
            this.openSlot('comments');
            this.renderRail();
            this.scrollThreadIntoView(this.activeThreadId);
        }
    }

    handleEvent(e) { /* Lumino */ }
}

// keyboard for the slash menu has to sit on the widget node because ProseMirror
// swallows keydown inside the editable area
function attachSlashKeys(widget) {
    widget.node.addEventListener('keydown', e => {
        if (!widget.slashItems || widget.slashEl.hidden) { return; }
        if (e.key === 'Escape') { widget.hideSlash(); e.preventDefault(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = widget.slashItems.length;
            widget.slashIndex = (widget.slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            [...widget.slashEl.children].forEach((c, i) => c.classList.toggle('sel', i === widget.slashIndex));
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            widget.applySlash(widget.slashItems[widget.slashIndex].key);
        }
    }, true);
}

const EDITOR_CSS = require('./editor-css').EDITOR_CSS;

module.exports = { MarkdownEditorWidget, attachSlashKeys, EDITOR_CSS, SLASH_ITEMS, buildExtensions };
