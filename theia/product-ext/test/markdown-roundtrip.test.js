/*
 * Corpus test for the markdown engine (markdown.js + md-parse/md-schema/
 * md-serialize/md-repair). Plain Node, no test runner — see CONTRACT.md's
 * "Verification" section, which is also where the jsdom shim below comes
 * from: markdown.js itself never touches the DOM any more (the whole point
 * of going through mdast instead of an HTML intermediate — see markdown.js's
 * header), but StudioImage's renderHTML path is exercised indirectly by
 * nothing here, so the shim is mostly insurance against a future regression
 * that reintroduces a DOM dependency.
 *
 * Run: `node test/markdown-roundtrip.test.js` (or `npm run test:markdown`).
 *
 * For every fixture under test/fixtures/**, five assertions (CONTRACT.md's
 * own numbering):
 *   1. round trip    — docToMarkdown(markdownToDoc(x).doc) reparses to an
 *                       IDENTICAL doc (structural, not textual — see D-02's
 *                       own distinction between reformatting and data loss).
 *   2. idempotence    — repairMarkdown(repairMarkdown(x)) === repairMarkdown(x)
 *   3. loss           — no node in the parsed doc is rawBlock/rawInline,
 *                       UNLESS the fixture lives under unsupported-by-design/
 *   4. determinism    — docToMarkdown(doc) twice is byte-identical
 */

const fs = require('fs');
const path = require('path');

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio.test/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
/*
 * The fuller shim, because assertion 5 requires markdown-editor.js to get the
 * real extension list, and that pulls in @lumino/domutils (which reaches for
 * `Element` at module scope) and Theia's widget layer.
 */
for (const key of ['Element', 'HTMLElement', 'Node', 'DOMParser', 'MutationObserver',
                   'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle',
                   'requestAnimationFrame', 'cancelAnimationFrame', 'innerHeight', 'innerWidth']) {
    global[key] = dom.window[key];
}
global.DragEvent = dom.window.Event;
global.ClipboardEvent = dom.window.Event;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const { markdownToDoc, docToMarkdown, repairMarkdown } = require('../src/browser/markdown');

/*
 * ASSERTION 5: the document the engine produces is one the EDITOR will accept.
 *
 * `schema.nodeFromJSON` constructs without validating content expressions, so
 * it is not this check — `.check()` is. The difference is not academic: a
 * standalone image came out as `paragraph > image` while StudioImage is
 * configured `inline: false`, which makes `image` a block node. nodeFromJSON
 * built that document happily, every round-trip assertion passed on it, and
 * ProseMirror would have dropped the image on open. `.check()` says
 * "Invalid content for node paragraph: <image>" immediately.
 *
 * This is the assertion that holds the engine and the editor to the same
 * schema, so it runs over every fixture.
 */
const { getSchema } = require('@tiptap/core');
const { buildExtensions } = require('../src/browser/markdown-editor');
const EDITOR_SCHEMA = getSchema(buildExtensions(undefined));

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function collectFixtures(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { out.push(...collectFixtures(full)); }
        else if (entry.name.endsWith('.md')) { out.push(full); }
    }
    return out;
}

function relClass(file) {
    return path.relative(FIXTURES_DIR, file).split(path.sep)[0];
}

/** Every rawBlock/rawInline node in a doc, with a rough location for the report. */
function findFallbacks(doc) {
    const found = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') { return; }
        if (node.type === 'rawBlock' || node.type === 'rawInline') {
            found.push({ type: node.type, kind: node.attrs && node.attrs.kind, source: (node.attrs && node.attrs.source || '').slice(0, 60), path });
        }
        for (const child of (node.content || [])) { walk(child, path); }
    };
    walk(doc, []);
    return found;
}

/** Structural doc equality — ignores nothing; PM JSON has no incidental fields. */
function docsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const results = { pass: 0, fail: 0, failures: [] };

function check(fixture, label, ok, detail) {
    if (ok) { results.pass++; return; }
    results.fail++;
    results.failures.push({ fixture, label, detail });
}

function runFixture(file) {
    const text = fs.readFileSync(file, 'utf8');
    const cls = relClass(file);
    const name = path.relative(FIXTURES_DIR, file);
    const allowFallback = cls === 'unsupported-by-design';

    // 1. round trip
    let doc1, md1, doc2;
    try {
        doc1 = markdownToDoc(text).doc;
        md1 = docToMarkdown(doc1);
        doc2 = markdownToDoc(md1).doc;
        check(name, 'round-trip', docsEqual(doc1, doc2),
            'reparsed doc differs after one save\n--- first md ---\n' + md1 + '\n--- reparsed md ---\n' + docToMarkdown(doc2));
    } catch (e) {
        check(name, 'round-trip', false, 'threw: ' + (e && e.stack || e));
        return;
    }

    // 2. idempotence
    try {
        const once = repairMarkdown(text);
        const twice = repairMarkdown(once);
        check(name, 'idempotence', once === twice,
            'repair is not a fixed point\n--- once ---\n' + once + '\n--- twice ---\n' + twice);
    } catch (e) {
        check(name, 'idempotence', false, 'threw: ' + (e && e.stack || e));
    }

    // 3. loss
    const fallbacks = findFallbacks(doc1);
    if (allowFallback) {
        check(name, 'loss', fallbacks.length > 0,
            'fixture is under unsupported-by-design/ but nothing fell back to raw — either the engine now supports this construct (move the fixture) or the fixture no longer exercises what it claims to');
    } else {
        check(name, 'loss', fallbacks.length === 0,
            'unexpected fallback node(s): ' + JSON.stringify(fallbacks, null, 1));
    }

    // 4. determinism
    try {
        const s1 = docToMarkdown(doc1);
        const s2 = docToMarkdown(doc1);
        check(name, 'determinism', s1 === s2, 'two serialisations of the same doc differ');
    } catch (e) {
        check(name, 'determinism', false, 'threw: ' + (e && e.stack || e));
    }

    // 5. the editor will accept it
    try {
        EDITOR_SCHEMA.nodeFromJSON(doc1).check();
        check(name, 'schema-valid', true);
    } catch (e) {
        check(name, 'schema-valid', false,
            'the document the engine produced is not valid in the editor schema: ' + (e && e.message || e) +
            '\nProseMirror constructs such a document without complaint and drops the offending node on open, ' +
            'so every other assertion here can pass while content is being lost.');
    }

    return { fallbacks, doc: doc1 };
}

const fixtures = collectFixtures(FIXTURES_DIR).filter(f => !f.includes(path.sep + 'legacy' + path.sep));
const perFixtureFallbacks = [];
for (const file of fixtures) {
    const r = runFixture(file);
    if (r && r.fallbacks.length) { perFixtureFallbacks.push({ name: path.relative(FIXTURES_DIR, file), fallbacks: r.fallbacks }); }
}

// --- summary -----------------------------------------------------------------

console.log('Markdown engine corpus: ' + fixtures.length + ' fixtures, ' +
    (results.pass) + ' assertions passed, ' + results.fail + ' failed.\n');

const byClass = {};
for (const file of fixtures) {
    const cls = relClass(file);
    byClass[cls] = (byClass[cls] || 0) + 1;
}
console.log('Fixtures per class:');
for (const [cls, n] of Object.entries(byClass).sort()) { console.log('  ' + cls.padEnd(24) + n); }
console.log('');

if (results.failures.length) {
    console.log('FAILURES:\n');
    for (const f of results.failures) {
        console.log('  [' + f.fixture + '] ' + f.label);
        console.log('    ' + String(f.detail).split('\n').join('\n    '));
        console.log('');
    }
}

console.log('Fixtures that used the X-01 fallback (rawBlock/rawInline):');
for (const f of perFixtureFallbacks) {
    console.log('  ' + f.name + ':');
    for (const fb of f.fallbacks) { console.log('    ' + fb.type + (fb.kind ? ' (' + fb.kind + ')' : '') + ': ' + JSON.stringify(fb.source)); }
}

console.log('');
if (results.fail === 0) {
    console.log('PASS — all ' + results.pass + ' assertions across ' + fixtures.length + ' fixtures.');
    process.exitCode = 0;
} else {
    console.log('FAIL — ' + results.fail + ' assertion(s) failed.');
    process.exitCode = 1;
}

// Regression comparison against the old converter runs as a separate,
// informational step — see test/regression-compare.js's own header for why
// it is not part of the pass/fail gate above.
try {
    require('./regression-compare');
} catch (e) {
    console.log('\n(regression comparison skipped: ' + (e && e.message) + ')');
}
