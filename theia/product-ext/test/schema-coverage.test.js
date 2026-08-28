/*
 * The assertion that was impossible to make before this pass: that the
 * engine (markdown.js + md-parse/md-schema/md-serialize) and the live
 * editor's Tiptap schema (buildExtensions() in markdown-editor.js) actually
 * agree about what a document can contain.
 *
 * Before callout/mathBlock/mathInline/rawBlock/rawInline/highlight existed
 * as real extensions, a document containing any of them parsed fine on the
 * engine side and then silently lost that content the moment
 * generateJSON/setContent handed it to a Tiptap schema that had never heard
 * of the node — no error, no warning, just fewer nodes than the source had.
 * Building the REAL extension list (not a hand-copied one) and constructing
 * a REAL ProseMirror schema from it is what makes this test able to catch
 * that class of drift again in the future, the moment either side changes.
 *
 * Run: node theia/product-ext/test/schema-coverage.test.js (or npm run test:schema)
 */

const assert = require('assert');

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'DOMParser', 'navigator', 'Element', 'HTMLElement',
    'customElements', 'getComputedStyle', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent',
    'CustomEvent', 'localStorage']) {
    if (dom.window[k]) { global[k] = dom.window[k]; }
}
global.requestAnimationFrame = fn => setTimeout(fn, 0);
// markdown-editor.js's own module-load path never touches these (StudioImage's
// richImageSrc, katex-runtime's script-tag loaders, etc. all run lazily,
// inside handlers and node views), but @lumino/domutils reads Element/
// HTMLElement off the global at require time, and figure-view.js's iframe
// wiring assumes DragEvent/ClipboardEvent exist as constructible types —
// see CONTRACT.md's own harness note, which this mirrors.
global.DragEvent = class DragEvent extends dom.window.Event {};
global.ClipboardEvent = class ClipboardEvent extends dom.window.Event {};
global.ResizeObserver = class ResizeObserver { observe() {} unobserve() {} disconnect() {} };
global.IntersectionObserver = class IntersectionObserver { observe() {} unobserve() {} disconnect() {} };

const { getSchema } = require('@tiptap/core');
const { buildExtensions } = require('../lib/browser/markdown-editor');
const { markdownToDoc, docToMarkdown } = require('../lib/browser/markdown');

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failures.push({ name, error: e });
    }
}

// A widget stub, not a real MarkdownEditorWidget: buildExtensions only reads
// `widget.uri` (StudioImage) and passes `widget` through to RawBlock/
// RawInline for their "Edit in Raw" affordance (raw-view.js), neither of
// which this test exercises interactively.
const widgetStub = { uri: undefined, setMode() {}, sourceEl: null };

const extensions = buildExtensions(widgetStub);
const schema = getSchema(extensions);

// md-schema.js's own SCHEMA table (see that file's header), restated here as
// plain names rather than imported — importing it would make this test
// unable to notice a row that names the wrong PM node, which is exactly the
// class of bug this file exists to catch.
const EXPECTED_NODES = [
    'blockquote', 'bulletList', 'callout', 'codeBlock', 'footnoteDef', 'footnoteRef',
    'hardBreak', 'heading', 'horizontalRule', 'image', 'listItem', 'mathBlock', 'mathInline',
    'orderedList', 'paragraph', 'rawBlock', 'rawInline', 'table', 'taskItem', 'taskList',
    'text', 'toggle'
];
const EXPECTED_MARKS = ['bold', 'highlight', 'italic', 'link', 'strike'];

test('every SCHEMA node name is a real node in the live Tiptap schema', () => {
    for (const name of EXPECTED_NODES) {
        assert.ok(schema.nodes[name], 'missing node: ' + name);
    }
});

test('every SCHEMA mark name is a real mark in the live Tiptap schema', () => {
    for (const name of EXPECTED_MARKS) {
        assert.ok(schema.marks[name], 'missing mark: ' + name);
    }
});

// --- the six new types, together, through the real engine -------------------

const SIX_TYPES_MD = [
    'Some *text* with ==highlighted== word and $x^2$ math.',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    ':::note',
    'A callout with **bold** text.',
    ':::',
    '',
    '<div class="weird">unsupported html block</div>',
    '',
    'See [[SomePage]] for more.',
    ''
].join('\n');

test('markdownToDoc exercises all six new types', () => {
    const { doc } = markdownToDoc(SIX_TYPES_MD);
    const types = new Set();
    const walk = node => {
        if (!node || typeof node !== 'object') { return; }
        if (node.type) { types.add(node.type); }
        (node.content || []).forEach(walk);
        (node.marks || []).forEach(m => types.add(m.type));
    };
    walk(doc);
    for (const t of ['callout', 'mathBlock', 'mathInline', 'rawBlock', 'rawInline', 'highlight']) {
        assert.ok(types.has(t), 'fixture does not exercise ' + t);
    }
});

test('that doc validates against the real Tiptap/ProseMirror schema', () => {
    const { doc } = markdownToDoc(SIX_TYPES_MD);
    // nodeFromJSON throws RangeError on anything the schema cannot place —
    // an unknown node/mark name, a content expression violation, a missing
    // attr. Not throwing IS the assertion.
    assert.doesNotThrow(() => schema.nodeFromJSON(doc));
});

test('and the markdown round-trips byte-identically', () => {
    const { doc } = markdownToDoc(SIX_TYPES_MD);
    const out = docToMarkdown(doc);
    assert.strictEqual(out, SIX_TYPES_MD);
});

// --- report -------------------------------------------------------------------

if (failures.length) {
    console.error(failures.length + ' failing, ' + passed + ' passing\n');
    for (const f of failures) {
        console.error('FAIL ' + f.name);
        console.error('  ' + (f.error && f.error.stack ? f.error.stack : f.error));
    }
    process.exit(1);
}
console.log('schema-coverage: ' + passed + ' passing');
