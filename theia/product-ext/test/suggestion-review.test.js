/*
 * The suggestion review pipeline, guarded at the four places it actually broke.
 *
 * Every assertion here corresponds to a defect that shipped, and each is written
 * against the REAL modules — a booted editor, the widget's own decideSuggestion,
 * the real change log — rather than against a restatement of what they are
 * supposed to do. A test that reimplements the fix cannot catch the fix being
 * undone.
 *
 *   1. ROUND TRIP UNDER A KEYSTROKE. Hand-wrapped paragraphs kept their soft
 *      line endings as literal newlines in the document model, and HardBreak
 *      declared itself the schema's linebreakReplacement — so the first
 *      keystroke in a paragraph converted every one of them into a hard break,
 *      and one typed space wrote backslashes through the user's file.
 *   2. ONE EDIT IS ONE CHANGE. The visible symptom of (1): a one-word edit was
 *      reported to the reviewer as a paragraph-sized replacement.
 *   3. ACCEPT DOES NOT REVERT. Accepting one suggested hunk rebuilt the whole
 *      body from that suggestion's own stale base, silently reverting a
 *      colleague's accepted edit wherever the suggestion also had a conflicted
 *      hunk.
 *   4. UNDO CLEARS THE CARD. Withdrawal compared bodies as strings, so any
 *      cosmetic re-serialisation left an empty suggestion on the rail for good.
 *
 * Run: `node test/suggestion-review.test.js` (or `npm run test:suggestion`).
 */

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://studio.test/' });
for (const k of ['Element', 'HTMLElement', 'Node', 'DOMParser', 'MutationObserver', 'Event', 'CustomEvent',
    'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'innerHeight', 'innerWidth', 'localStorage']) { global[k] = dom.window[k]; }
global.window = dom.window; global.document = dom.window.document; global.navigator = dom.window.navigator;
global.DragEvent = dom.window.Event; global.ClipboardEvent = dom.window.Event;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame = cb => setTimeout(cb, 0);
global.cancelAnimationFrame = id => clearTimeout(id);
dom.window.requestAnimationFrame = global.requestAnimationFrame;
dom.window.cancelAnimationFrame = global.cancelAnimationFrame;

const { Editor } = require('@tiptap/core');
const { DOMParser: PMDOMParser } = require('@tiptap/pm/model');
const { URI } = require('@theia/core/lib/common/uri');
const { MarkdownEditorWidget, buildExtensions } = require('../src/browser/markdown-editor');
const { markdownToDoc, docToMarkdown } = require('../src/browser/markdown');
const { preserveWrapping } = require('../src/browser/md-rewrap');
const { collect, buildDecorations } = require('../src/browser/suggest-marks');
const { diffHunks } = require('../src/browser/diff');
const { ChangeLog, suggestionHunks } = require('../src/browser/change-log');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) { pass++; } else { failures.push(name + (extra ? '\n        ' + extra : '')); } };

/* Hand-wrapped exactly as the repositories this product is used on are. The
 * second paragraph is the control: nothing touches it, so it must survive byte
 * for byte through a save. */
const MD = `**Your transcript is not the record.** The person is looking at a document and a
rail; their colleague and your own next session see only this repository.
Anything that matters goes into a file or into a tool call. A conclusion that exists
only in the chat does not exist.

A second paragraph, also hand-wrapped, that nobody is going to touch at all
during this test and which therefore must come back byte for byte.
`;

const host = dom.window.document.getElementById('host');
const editorFor = doc => new Editor({ element: host, extensions: buildExtensions(undefined), content: doc });

/* --- 1. a keystroke must not rewrite the paragraph ----------------------- */

const editor = editorFor(markdownToDoc(MD).doc);
const modelText = collect(editor.state.doc).text;

ok('the schema declares no linebreakReplacement', !editor.schema.linebreakReplacement,
    'got: ' + (editor.schema.linebreakReplacement && editor.schema.linebreakReplacement.name));

/* What ProseMirror does on every keystroke: re-parse the touched block with
 * preserveWhitespace: true. That is where the hard breaks used to appear. */
const reparsed = PMDOMParser.fromSchema(editor.schema).parse(editor.view.dom, { preserveWhitespace: true });
let breaks = 0;
reparsed.descendants(node => { if (node.type.name === 'hardBreak') { breaks++; } });
ok('a re-parse manufactures no hard breaks', breaks === 0, 'hardBreak nodes: ' + breaks);
ok('a re-parse does not change the text', collect(reparsed).text === modelText);

/* --- 2. one edit is one change ------------------------------------------- */

const firstParaEnd = editor.state.doc.child(0).nodeSize - 1;
editor.view.dispatch(editor.state.tr.insertText(' ', firstParaEnd));

ok('a trailing space draws no mark at all', buildDecorations(editor.state.doc, modelText).find().length === 0);

const trailingBody = preserveWrapping(MD, docToMarkdown(editor.state.doc.toJSON()));
ok('no backslash hard break reaches the file', !/\\\n/.test(trailingBody), JSON.stringify(trailingBody.slice(0, 120)));
ok('no &#x20; entity reaches the file', !trailingBody.includes('&#x20;'));
ok('a trailing space records no change at all', diffHunks(MD, trailingBody).hunks.length === 0);

const at = MD.indexOf('their colleague');
const edited = editorFor(markdownToDoc(MD.slice(0, at) + 'dear ' + MD.slice(at)).doc);
ok('a real word insertion draws exactly one mark',
    buildDecorations(edited.state.doc, modelText).find().length === 1);

const editedBody = preserveWrapping(MD, docToMarkdown(edited.state.doc.toJSON()));
const editedHunks = diffHunks(MD, editedBody).hunks;
ok('a real word insertion is exactly one hunk', editedHunks.length === 1, 'got ' + editedHunks.length);
ok('and it touches one line, not the paragraph',
    editedHunks.length === 1 && editedHunks[0].oldLines.length === 1 && editedHunks[0].newLines.length === 1,
    editedHunks.length ? JSON.stringify({ old: editedHunks[0].oldLines, new: editedHunks[0].newLines }) : '');
ok('the untouched paragraph keeps its own wrapping',
    editedBody.includes('A second paragraph, also hand-wrapped, that nobody is going to touch at all\nduring this test'));

/* --- 3. accepting a suggestion must not revert somebody else's edit ------- */

const authorBase = ['alpha', 'bravo', 'charlie', 'delta'].join('\n');
const authorProposed = ['alpha', 'BRAVO!', 'charlie', 'DELTA!'].join('\n');
const documentBody = ['alpha', 'bravo-edited-by-someone-else', 'charlie', 'delta'].join('\n');
const suggestion = {
    id: 'p-1', by: { id: 'other', name: 'Alex' },
    baseBody: authorBase, proposedBody: authorProposed, createdAt: new Date().toISOString()
};

let written;
const widget = {
    suggestions: [suggestion],
    rejections: {},
    reviewedBody: () => documentBody,
    messageService: { warn: m => { written = 'REFUSED: ' + m; }, error: () => {}, info: () => {} },
    historyStore: { record: async () => [] },
    changeLog: { reject: async () => ({}) },
    writeDecidedBody: async body => { written = body; return true; },
    reloadSuggestions: async () => {},
    setSaveState: () => {},
    saveState: 'clean'
};

/* --- 4. undoing back to the document withdraws the suggestion ------------- */

function fakeWorkspace() {
    const root = new URI('file:///repo');
    const files = new Map();
    return {
        root,
        doc: new URI('file:///repo/docs/prd.md'),
        fileService: {
            async exists(uri) { return files.has(uri.toString()); },
            async read(uri) { return { value: files.get(uri.toString()) }; },
            async write(uri, body) { files.set(uri.toString(), body); },
            async createFile(uri, buffer) { files.set(uri.toString(), String(buffer)); }
        },
        workspaceService: { roots: Promise.resolve([{ resource: root }]) }
    };
}

(async () => {
    const hunks = suggestionHunks(suggestion, documentBody, {});
    const target = hunks.find(h => !h.conflicted);
    const conflicted = hunks.find(h => h.conflicted);
    ok('the hunk whose text is gone is flagged conflicted', !!conflicted);
    ok('the hunk whose text is still there anchors', !!target);

    await MarkdownEditorWidget.prototype.decideSuggestion.call(widget, 'p-1', target.key, 'accepted');
    ok('the accepted change is applied', typeof written === 'string' && written.includes('DELTA!'), JSON.stringify(written));
    ok("the colleague's edit survives the accept",
        written === ['alpha', 'bravo-edited-by-someone-else', 'charlie', 'DELTA!'].join('\n'), JSON.stringify(written));

    written = undefined;
    await MarkdownEditorWidget.prototype.decideSuggestion.call(widget, 'p-1', conflicted.key, 'accepted');
    ok('accepting a conflicted hunk is refused rather than written',
        typeof written === 'string' && written.startsWith('REFUSED'), JSON.stringify(written));

    const env = fakeWorkspace();
    const log = new ChangeLog(env.fileService, env.workspaceService);
    const author = { id: 'local-test', name: 'Test Person' };
    const body = ['one', 'two', 'three'].join('\n');

    await log.upsert(env.doc, author, { documentBody: body, proposedBody: ['one', 'TWO!', 'three'].join('\n') });
    ok('a real suggestion is recorded', (await log.loadFile(env.doc, author)).proposals.length === 1);

    /* Undo, arriving as a body that is line-identical but not byte-identical —
     * the shape any re-serialisation produces, and what used to strand a card. */
    await log.upsert(env.doc, author, { documentBody: body, proposedBody: ['one', 'two', 'three'].join('\r\n') });
    ok('undoing back to the document withdraws the card',
        (await log.loadFile(env.doc, author)).proposals.length === 0,
        JSON.stringify((await log.loadFile(env.doc, author)).proposals.map(p => p.proposedBody)));

    console.log('\nsuggestion-review: ' + pass + ' passing' + (failures.length ? ', ' + failures.length + ' FAILING' : ''));
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(failures.length ? 1 : 0);
})();
