/*
 * Anchoring a comment to something that was rendered.
 *
 * The walker is tree arithmetic, so it is tested against a tree rather than a
 * browser: the fake nodes below carry exactly the four things it reads —
 * `children`, `parentElement`, `hasAttribute`, and the labelling bits. A jsdom
 * here would add a dependency and a second-long startup to check the same
 * arithmetic, and would not check it any harder.
 *
 * What is guarded is the property the whole model rests on: a path describes
 * the DOCUMENT, not the document plus whatever chrome the surface happens to
 * be showing. Every surface that renders a document injects nodes into it, so
 * an anchor that counted them would re-point every time a panel opened.
 *
 * Run: `node test/element-anchor.test.js` (or `npm run test:element-anchor`).
 */

const assert = require('node:assert');
const anchor = require('../src/browser/element-anchor');

/** A node with just enough of an element's surface for the walker. */
function node(tag, options = {}) {
    const el = {
        tagName: tag.toUpperCase(),
        id: options.id || '',
        className: options.className || '',
        textContent: options.text || '',
        children: [],
        parentElement: undefined,
        injected: !!options.injected,
        hasAttribute(name) { return name === anchor.INJECTED && this.injected; }
    };
    for (const child of options.children || []) {
        child.parentElement = el;
        el.children.push(child);
    }
    return el;
}

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok   ' + name);
    } catch (error) {
        failures++;
        console.error('  FAIL ' + name);
        console.error('       ' + (error && error.message));
    }
}

console.log('element anchor');

// -- there and back ----------------------------------------------------------

test('a path leads back to the element it came from', () => {
    const table = node('table', { text: 'Q3 numbers' });
    const root = node('body', { children: [
        node('h1', { text: 'Brief' }),
        node('section', { children: [node('p', { text: 'prose' }), table] })
    ] });

    const path = anchor.pathOf(table, root);
    assert.deepStrictEqual(path, [1, 1]);
    assert.strictEqual(anchor.resolvePath(path, root), table);
});

test('the root itself is not anchorable', () => {
    // A comment on "the whole document" is a document-scoped thread, which the
    // product already has. An anchor of [] would be a second way to say it.
    const root = node('body');
    assert.strictEqual(anchor.pathOf(root, root), undefined);
    assert.strictEqual(anchor.resolvePath([], root), undefined);
});

test('an element outside the root has no path', () => {
    const stray = node('p');
    assert.strictEqual(anchor.pathOf(stray, node('body')), undefined);
});

// -- injected chrome ---------------------------------------------------------

test('injected nodes are not counted, so a panel does not move every anchor', () => {
    // The defect this model exists for: open a thread panel above a table and a
    // selector-based anchor points at the panel.
    const table = node('table');
    const root = node('body', { children: [node('h1'), table] });
    const before = anchor.pathOf(table, root);

    const panel = node('div', { injected: true });
    panel.parentElement = root;
    root.children.splice(1, 0, panel);

    assert.deepStrictEqual(anchor.pathOf(table, root), before);
    assert.strictEqual(anchor.resolvePath(before, root), table);
});

test('an injected node cannot be anchored to', () => {
    const panel = node('div', { injected: true });
    const root = node('body', { children: [panel] });
    assert.strictEqual(anchor.pathOf(panel, root), undefined);
});

// -- when the document has moved on ------------------------------------------

test('a path that no longer resolves answers undefined, not something else', () => {
    // Ordinary, not exceptional: documents are edited between a comment and the
    // reading of it. What must never happen is quietly pointing at whatever now
    // sits in that position — hence the surface asks for reattachment.
    const root = node('body', { children: [node('h1'), node('table')] });
    assert.strictEqual(anchor.resolvePath([5], root), undefined);
    assert.strictEqual(anchor.resolvePath([1, 0], root), undefined);
});

test('what was lost can still be described', () => {
    const table = node('table', { id: 'q3', text: 'Q3 numbers by region' });
    const root = node('body', { children: [table] });
    const stored = anchor.anchorFor(table, root);

    assert.strictEqual(stored.type, 'element');
    assert.strictEqual(stored.tag, 'table');
    assert.strictEqual(stored.describe, 'table#q3');
    assert.strictEqual(stored.snippet, 'Q3 numbers by region');
    assert.strictEqual(anchor.lostText(stored), 'table#q3 — Q3 numbers by region');
});

test('an anchor is never stored without a path in it', () => {
    const root = node('body');
    assert.strictEqual(anchor.anchorFor(node('p'), root), undefined);
});

// -- the description ---------------------------------------------------------

test('the description is structural: tag, then id, else first class', () => {
    assert.strictEqual(anchor.describe(node('h2')), 'h2');
    assert.strictEqual(anchor.describe(node('h2', { id: 'risks' })), 'h2#risks');
    assert.strictEqual(anchor.describe(node('div', { className: 'chart wide' })), 'div.chart');
    // An id wins: it is the more specific of the two and the one a person
    // recognises in a page they wrote.
    assert.strictEqual(anchor.describe(node('div', { id: 'x', className: 'chart' })), 'div#x');
});

test('a snippet is one line, trimmed, and bounded', () => {
    const long = node('p', { text: '  lots   of\n   whitespace ' + 'x'.repeat(200) });
    const snippet = anchor.snippetOf(long);
    assert.ok(snippet.startsWith('lots of whitespace'), snippet);
    assert.strictEqual(snippet.length, 90);
});

if (failures) {
    console.error(failures + ' failing');
    process.exit(1);
}
console.log('  all passing');
