/*
 * The block registry's commands, run against a REAL editor.
 *
 * WHY THIS FILE EXISTS. blocks-ranking.test.js proves the right row is found
 * and blocks-toolbar.test.js proves the right buttons are drawn; neither ever
 * CALLS a row's `run`. That gap shipped a menu in which every callout tone and
 * the toggle did nothing at all: they used `setNode`, which is
 * prosemirror-commands' setBlockType, and setBlockType only targets a
 * textblock. `callout` and `toggle` are `content: 'block+'` containers, so the
 * command returned false, the chain ended, and the document was unchanged —
 * silently, with no throw and no warning. Six menu rows, all inert, and every
 * existing test green.
 *
 * So this asserts the only thing that actually matters about a menu row: that
 * running it changes the file, and that what it writes is read back as the same
 * node. Every row is covered, which is what stops the next container-shaped
 * block from shipping the same way.
 *
 * Run: `node test/block-commands.test.js`.
 */

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://studio.test/' });
for (const k of ['Element', 'HTMLElement', 'Node', 'DOMParser', 'MutationObserver', 'Event', 'CustomEvent',
    'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'innerHeight', 'innerWidth']) { global[k] = dom.window[k]; }
global.window = dom.window; global.document = dom.window.document; global.navigator = dom.window.navigator;
global.DragEvent = dom.window.Event; global.ClipboardEvent = dom.window.Event;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame = cb => setTimeout(cb, 0);
global.cancelAnimationFrame = id => clearTimeout(id);
dom.window.requestAnimationFrame = global.requestAnimationFrame;
dom.window.cancelAnimationFrame = global.cancelAnimationFrame;

const { Editor } = require('@tiptap/core');
const { buildExtensions, MarkdownEditorWidget } = require('../src/browser/markdown-editor');
const { markdownToDoc, docToMarkdown, repairMarkdown } = require('../src/browser/markdown');
const { BLOCKS, blocksFor, isBlockAvailable } = require('../src/browser/blocks');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) { pass++; } else { failures.push(name + (extra ? '\n      ' + extra : '')); } };

const START = 'Some starting text.\n';
const editor = new Editor({
    element: document.getElementById('host'),
    extensions: buildExtensions(undefined),
    content: markdownToDoc(START).doc
});
const schema = editor.schema;

/*
 * Runs one registry row over a five-character selection and returns the
 * markdown, dispatching it EXACTLY the way applySlash does: a row returns a
 * chain and the caller runs it, except for a `defer` row which is handed no
 * chain at all and opens its own surface. Getting this wrong makes every row
 * look inert, which is indistinguishable from the bug this file exists to
 * catch — so it is worth mirroring the real call site rather than approximating
 * it.
 */
function runBlock(block) {
    editor.commands.setContent(markdownToDoc(START).doc, false);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    if (block.defer) { block.run(undefined, deferredWidget); }
    else { block.run(editor.chain().focus(), deferredWidget).run(); }
    return docToMarkdown(editor.getJSON()).trim();
}

/** The same dispatch, against the chain the caller already holds. */
function dispatch(key) {
    const block = BLOCKS.find(b => b.key === key);
    return block.run(editor.chain().focus(), deferredWidget).run();
}

const deferredCalls = [];
const deferredWidget = {
    importImage() { deferredCalls.push('importImage'); },
    createFigure() { deferredCalls.push('createFigure'); },
    openLinkEditor() { deferredCalls.push('openLinkEditor'); }
};

/* --- 1. every AVAILABLE row must change the document ---------------------- */

/*
 * `text` is the one legitimate no-op: the selection is already a paragraph, so
 * "turn this into a paragraph" has nothing to do. Every other row that the
 * schema can run has to write something, and a row that does not is the exact
 * failure the callouts shipped with.
 */
const NO_OP_BY_DESIGN = new Set(['text']);

for (const block of blocksFor(schema)) {
    if (block.defer) {
        deferredCalls.length = 0;
        runBlock(block);
        ok('defer row ' + block.key + ' calls its widget method', deferredCalls.length === 1,
            'calls: ' + JSON.stringify(deferredCalls));
        continue;
    }
    const md = runBlock(block);
    if (NO_OP_BY_DESIGN.has(block.key)) {
        ok('row ' + block.key + ' leaves the document alone', md === 'Some starting text.', 'got ' + JSON.stringify(md));
    } else {
        ok('row ' + block.key + ' changes the document', md !== 'Some starting text.', 'document unchanged');
    }
}

/* --- 2. the six rows that were inert, by name and by output --------------- */

const CONTAINERS = [
    ['callout-note', ':::note\nSome starting text.\n:::'],
    ['callout-tip', ':::tip\nSome starting text.\n:::'],
    ['callout-important', ':::important\nSome starting text.\n:::'],
    ['callout-warning', ':::warning\nSome starting text.\n:::'],
    ['callout-caution', ':::caution\nSome starting text.\n:::'],
    ['toggle', '<details>\n<summary>Toggle</summary>\n\nSome starting text.\n</details>']
];

for (const [key, expected] of CONTAINERS) {
    const block = BLOCKS.find(b => b.key === key);
    ok(key + ' is in the registry and available', !!block && isBlockAvailable(block, schema));
    const md = runBlock(block);
    ok(key + ' writes its own markdown', md === expected,
        'got      ' + JSON.stringify(md) + '\n      expected ' + JSON.stringify(expected));
}

/* --- 3. and what they write must come back as the same node -------------- */

for (const [key, markdown] of CONTAINERS) {
    const { doc } = markdownToDoc(repairMarkdown(markdown + '\n'));
    const first = doc.content && doc.content[0];
    const wanted = key.startsWith('callout') ? 'callout' : 'toggle';
    ok(key + ' round-trips as a ' + wanted, !!first && first.type === wanted,
        'got ' + JSON.stringify(first && first.type));
    if (wanted === 'callout') {
        ok(key + ' keeps its tone', !!first && first.attrs.tone === key.slice('callout-'.length),
            'got ' + JSON.stringify(first && first.attrs));
    }
}

/* --- 4. tone changes REPLACE the tone, they do not nest ------------------ */

editor.commands.setContent(markdownToDoc(START).doc, false);
editor.commands.setTextSelection({ from: 1, to: 6 });
dispatch('callout-note');
dispatch('callout-warning');
ok('a second tone retones rather than nesting',
    docToMarkdown(editor.getJSON()).trim() === ':::warning\nSome starting text.\n:::',
    'got ' + JSON.stringify(docToMarkdown(editor.getJSON()).trim()));

/* --- 5. Text is the way back out of a container -------------------------- */

dispatch('text');
ok('Text lifts out of a callout', docToMarkdown(editor.getJSON()).trim() === 'Some starting text.',
    'got ' + JSON.stringify(docToMarkdown(editor.getJSON()).trim()));

editor.commands.setContent(markdownToDoc(START).doc, false);
editor.commands.setTextSelection({ from: 1, to: 6 });
dispatch('toggle');
dispatch('text');
ok('Text lifts out of a toggle', docToMarkdown(editor.getJSON()).trim() === 'Some starting text.',
    'got ' + JSON.stringify(docToMarkdown(editor.getJSON()).trim()));

/* --- 6. the maths rows keep the selection rather than deleting it -------- */

ok('Equation uses the selection as its source',
    runBlock(BLOCKS.find(b => b.key === 'math-block')) === '$$\nSome\n$$\n\nstarting text.',
    'got ' + JSON.stringify(runBlock(BLOCKS.find(b => b.key === 'math-block'))));
ok('Inline math uses the selection as its source',
    runBlock(BLOCKS.find(b => b.key === 'math-inline')) === '$Some$starting text.',
    'got ' + JSON.stringify(runBlock(BLOCKS.find(b => b.key === 'math-inline'))));

/*
 * An inline maths node with EMPTY latex serialises to `$$`, which reparses as
 * two literal characters — the node vanished on the first save. So the row
 * seeds one when there is no selection, and this is the assertion that the
 * seed survives a round trip.
 */
editor.commands.setContent(markdownToDoc(START).doc, false);
editor.commands.setTextSelection({ from: 6, to: 6 });
dispatch('math-inline');
const seeded = docToMarkdown(editor.getJSON());
ok('Inline math with no selection is seeded', /\$[^$]+\$/.test(seeded), 'got ' + JSON.stringify(seeded));
ok('a seeded inline maths node survives a save',
    (markdownToDoc(seeded).doc.content[0].content || []).some(n => n.type === 'mathInline'),
    'got ' + JSON.stringify(markdownToDoc(seeded).doc.content[0].content));

/* --- 7. the marks the selection toolbar dispatches ----------------------- */

/*
 * `toggleHighlight` did not exist: Mark.create synthesises no commands, so the
 * toolbar's generic `chain()['toggle' + Key]()` was calling undefined and
 * throwing a TypeError out of the click handler. Every mark the toolbar can
 * dispatch is checked here, because the next hand-written mark will have the
 * same hole.
 */
for (const key of ['bold', 'italic', 'strike', 'code', 'highlight']) {
    editor.commands.setContent(markdownToDoc(START).doc, false);
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const command = 'toggle' + key[0].toUpperCase() + key.slice(1);
    let threw;
    try { editor.chain().focus()[command]().run(); } catch (e) { threw = e.message; }
    ok(command + ' exists and applies', !threw && docToMarkdown(editor.getJSON()).trim() !== 'Some starting text.',
        threw || 'document unchanged');
}

/* --- 8. a mark never lands on the selection's trailing space ------------- */

/*
 * CommonMark forbids a closing `**` preceded by whitespace, so remark had to
 * emit the space as an entity to keep the emphasis legal — `**Some **starting`
 * became `**Some&#x20;**&#x73;tarting`, which is where the stray `&#x20;` in
 * saved documents came from. A drag-selected line almost always ends in a
 * space, so this was the common case, not the corner.
 */
const trim = MarkdownEditorWidget.prototype.trimmedMarkRange;
for (const [name, range, expected] of [
    ['exact word', { from: 1, to: 5 }, '**Some** starting text.'],
    ['trailing space', { from: 1, to: 6 }, '**Some** starting text.'],
    ['leading and trailing', { from: 5, to: 15 }, 'Some **starting** text.']
]) {
    editor.commands.setContent(markdownToDoc(START).doc, false);
    editor.commands.setTextSelection(range);
    const trimmed = trim.call({ editor });
    const chain = editor.chain().focus();
    if (trimmed) { chain.setTextSelection(trimmed); }
    chain.toggleBold().run();
    const md = docToMarkdown(editor.getJSON()).trim();
    ok('bold over a selection with ' + name + ' emits no entities', md === expected,
        'got      ' + JSON.stringify(md) + '\n      expected ' + JSON.stringify(expected));
    ok('bold over a selection with ' + name + ' has no &#x', !md.includes('&#x'), md);
}

/* --- report -------------------------------------------------------------- */

console.log('');
if (!failures.length) {
    console.log('block-commands: ' + pass + ' passing');
    process.exitCode = 0;
} else {
    for (const f of failures) { console.log('  FAIL  ' + f); }
    console.log('\nblock-commands: ' + pass + ' passing, ' + failures.length + ' failing');
    process.exitCode = 1;
}
