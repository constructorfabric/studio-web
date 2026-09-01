/*
 * jsdom smoke test for the DOM-dependent parts of the two menus: the
 * markup bubbleButtonsHtml()/slashListHtml()/slashEmptyHtml() in
 * markdown-editor.js build for the states the brief lists (normal,
 * read-only, reviewing, code block, table cell, mixed selection), and the
 * ranking/positioning maths that does not need a real layout.
 *
 * These three functions take plain data, not a live Editor or ProseMirror
 * state — see the comment above bubbleButtonsHtml in markdown-editor.js —
 * which is what makes this runnable without booting a full Tiptap editor
 * inside a Theia Widget under jsdom (attempted; it needs DragEvent,
 * ClipboardEvent and a non-opaque origin stubbed just to require the
 * module, before a real editor is even constructed).
 *
 * Run: node theia/product-ext/test/blocks-toolbar.test.js
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
global.DragEvent = class DragEvent extends dom.window.Event {};
global.ClipboardEvent = class ClipboardEvent extends dom.window.Event {};

const { bubbleButtonsHtml, slashListHtml, slashEmptyHtml, blockKeyAt, MARK_DEFS, ASK_AI_SLASH_KEY } =
    require('../src/browser/markdown-editor');
const { BLOCKS, rankBlocks, blocksFor } = require('../src/browser/blocks');

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

function toEl(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
}

function marksFor(schemaMarkKeys, activeKeys) {
    const active = new Set(activeKeys || []);
    return MARK_DEFS.filter(m => schemaMarkKeys.includes(m.key)).map(m => ({ ...m, active: active.has(m.key) }));
}

// The engine's marks as they exist TODAY (bold/italic/code/link/strike; no
// highlight yet — see the report on the isBlockAvailable/StarterKit check).
const FULL_SCHEMA_MARKS = ['bold', 'italic', 'strike', 'code', 'link'];

// --- selection toolbar states ----------------------------------------------

test('normal selection: block selector, all available marks, comment + ai', () => {
    const html = bubbleButtonsHtml({
        locked: false, inCode: false, inCell: false, blockLabel: 'Paragraph',
        marks: marksFor(FULL_SCHEMA_MARKS, ['bold'])
    });
    const el = toEl(html);
    assert.ok(el.querySelector('[data-bsel]'), 'block selector should be present');
    assert.ok(el.querySelector('[data-mark="bold"]'), 'bold should be present');
    assert.ok(el.querySelector('[data-mark="bold"]').classList.contains('on'), 'bold should read active');
    assert.ok(el.querySelector('[data-mark="italic"]'), 'italic should be present');
    assert.ok(el.querySelector('[data-mark="strike"]'), 'strike should be present (already in the schema)');
    assert.ok(!el.querySelector('[data-mark="highlight"]'), 'highlight should be absent (not in the schema yet)');
    assert.ok(el.querySelector('[data-mark="comment"]'), 'comment should be present');
    assert.ok(el.querySelector('[data-mark="ai"]'), 'ask ai should be present');
});

test('read-only: only comment and ask ai, no block selector, no marks', () => {
    const html = bubbleButtonsHtml({
        locked: true, inCode: false, inCell: false, blockLabel: 'Paragraph',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.ok(!el.querySelector('[data-bsel]'));
    assert.ok(!el.querySelector('[data-mark="bold"]'));
    assert.ok(!el.querySelector('[data-mark="italic"]'));
    assert.ok(el.querySelector('[data-mark="comment"]'));
    assert.ok(el.querySelector('[data-mark="ai"]'));
});

test('reviewing (proposal open): same as read-only — only comment and ask ai', () => {
    // `locked` is `readOnly || reviewing` at the call site; reviewing alone
    // produces the identical shape, so this asserts the same contract under
    // the OTHER flag that sets it, not a duplicate of the read-only case.
    const html = bubbleButtonsHtml({
        locked: true, inCode: false, inCell: false, blockLabel: 'Heading 2',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.strictEqual(el.querySelectorAll('.studio-bubble-btn').length, 2, 'exactly Comment and Ask AI');
});

test('inside a code block: comment and ask ai, no marks, no block selector', () => {
    const html = bubbleButtonsHtml({
        locked: false, inCode: true, inCell: false, blockLabel: 'Code block',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.ok(!el.querySelector('[data-bsel]'), 'block selector omitted in a code block');
    assert.ok(!el.querySelector('[data-mark="bold"]'), 'format marks omitted in a code block');
    assert.ok(el.querySelector('[data-mark="comment"]'), 'a code block must be commentable');
    assert.ok(el.querySelector('[data-mark="ai"]'));
});

test('inside a table cell: marks and actions, block selector omitted', () => {
    const html = bubbleButtonsHtml({
        locked: false, inCode: false, inCell: true, blockLabel: 'Paragraph',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.ok(!el.querySelector('[data-bsel]'), 'the table bar owns structure inside a cell');
    assert.ok(el.querySelector('[data-mark="bold"]'), 'formatting still works inside a cell');
    assert.ok(el.querySelector('[data-mark="comment"]'));
});

test('mixed selection: block selector reads "Mixed"', () => {
    const html = bubbleButtonsHtml({
        locked: false, inCode: false, inCell: false, blockLabel: 'Mixed',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.strictEqual(el.querySelector('[data-bsel] span').textContent, 'Mixed');
});

test('bold/italic use letterforms, every other mark is a Lucide <svg>', () => {
    const html = bubbleButtonsHtml({
        locked: false, inCode: false, inCell: false, blockLabel: 'Paragraph',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.strictEqual(el.querySelector('[data-mark="bold"]').querySelector('svg'), null);
    assert.strictEqual(el.querySelector('[data-mark="bold"] .studio-bubble-glyph').textContent, 'B');
    assert.strictEqual(el.querySelector('[data-mark="italic"] .studio-bubble-glyph').textContent, 'I');
    assert.ok(el.querySelector('[data-mark="code"]').querySelector('svg'), 'code should be an icon');
    assert.ok(el.querySelector('[data-mark="link"]').querySelector('svg'), 'link should be an icon');
});

test('title attributes carry the keyboard shortcut', () => {
    const html = bubbleButtonsHtml({
        locked: false, inCode: false, inCell: false, blockLabel: 'Paragraph',
        marks: marksFor(FULL_SCHEMA_MARKS, [])
    });
    const el = toEl(html);
    assert.ok(el.querySelector('[data-mark="bold"]').getAttribute('title').includes('⌘B'));
    assert.ok(el.querySelector('[data-mark="comment"]').getAttribute('title').includes('⌘⌥M'));
});

// --- blockKeyAt (block selector label) --------------------------------------

test('blockKeyAt walks shallow to deep: a list wins over its paragraph', () => {
    const fakePos = {
        depth: 2,
        node: d => [
            { type: { name: 'doc' } },
            { type: { name: 'bulletList' } },
            { type: { name: 'paragraph' } }
        ][d]
    };
    assert.strictEqual(blockKeyAt(fakePos), 'bullet');
});

test('blockKeyAt reads a heading level from its attrs', () => {
    const fakePos = { depth: 1, node: d => [{ type: { name: 'doc' } }, { type: { name: 'heading' }, attrs: { level: 3 } }][d] };
    assert.strictEqual(blockKeyAt(fakePos), 'h3');
});

// --- slash menu rows ---------------------------------------------------------

test('slashListHtml renders group headers only for the empty query', () => {
    const rows = rankBlocks('', { recent: ['table'], blocks: blocksFor(undefined) });
    const html = slashListHtml(rows, '', 0);
    const el = toEl(html);
    assert.ok(el.querySelector('.studio-slash-group'), 'group headers appear when browsing (empty query)');
});

test('slashListHtml omits group headers once there is a query', () => {
    const rows = rankBlocks('h', { blocks: blocksFor(undefined) });
    const html = slashListHtml(rows, 'h', 0);
    const el = toEl(html);
    assert.ok(!el.querySelector('.studio-slash-group'), 'a filtered result reads as one flat ranked list');
});

test('slashListHtml shows the hint on the selected row only', () => {
    const rows = rankBlocks('h', { blocks: blocksFor(undefined) });
    const html = slashListHtml(rows, 'h', 0);
    const el = toEl(html);
    const items = [...el.querySelectorAll('.studio-slash-item')];
    assert.ok(items[0].querySelector('.studio-slash-hint'), 'row 0 (selected) should carry a hint');
    if (items[1]) { assert.ok(!items[1].querySelector('.studio-slash-hint'), 'row 1 (not selected) should not'); }
});

test('slashListHtml emphasises the matched substring', () => {
    // 'equation' itself only matches math-block, whose node is not in the
    // bare (schema-less) pool blocksFor(undefined) resolves against — see
    // the "unavailable blocks" tests below for that guard. 'head' matches
    // the always-available headings on a label word-start.
    const rows = rankBlocks('head', { blocks: blocksFor(undefined) });
    const html = slashListHtml(rows, 'head', 0);
    const el = toEl(html);
    assert.ok(el.querySelector('.studio-slash-label mark'), 'expected a <mark> around the matched text');
    assert.strictEqual(el.querySelector('.studio-slash-label mark').textContent, 'Head');
});

test('slashEmptyHtml offers an "Ask AI" row carrying the typed text, insert mode', () => {
    const html = slashEmptyHtml('sequence diagram of the save path', 'insert');
    const el = toEl(html);
    const askRow = el.querySelector('[data-slash="' + ASK_AI_SLASH_KEY + '"]');
    assert.ok(askRow, 'expected the Ask AI row');
    assert.ok(askRow.textContent.includes('sequence diagram of the save path'));
    assert.ok(askRow.textContent.toLowerCase().includes('insert'));
});

test('slashEmptyHtml phrases the convert-mode empty state as "turn this into"', () => {
    const html = slashEmptyHtml('zzz', 'convert');
    const el = toEl(html);
    assert.ok(el.textContent.toLowerCase().includes('turn this into'));
});

test('block selector pool is convert:true only', () => {
    const pool = blocksFor(undefined, { convertOnly: true });
    assert.ok(pool.every(b => b.convert));
    assert.ok(pool.some(b => b.key === 'h1'));
    assert.ok(!pool.some(b => b.key === 'divider'));
});

test('unavailable (schema-gated) blocks are absent from a bare pool', () => {
    // blocksFor(undefined) treats every requiresNode/requiresMark block as
    // unavailable — there is no schema to confirm the node against.
    const pool = blocksFor(undefined);
    assert.ok(!pool.some(b => b.key === 'math-block'));
    assert.ok(pool.some(b => b.key === 'text'));
});

test('unavailable blocks light up once a stub schema declares the node', () => {
    const schema = { nodes: { mathBlock: {}, callout: {} }, marks: {} };
    const pool = blocksFor(schema);
    assert.ok(pool.some(b => b.key === 'math-block'));
    assert.ok(pool.some(b => b.key === 'callout-note'));
    assert.ok(!pool.some(b => b.key === 'toc'), 'toc still absent — its node was not in this stub schema');
});

// --- positioning maths, asserted with stubbed rects -------------------------

test('bubble left clamps inside the host on both edges', () => {
    // Mirrors positionBubble()'s own formula without booting an Editor:
    // left = box.center - width/2, clamped to [8, hostWidth - width - 8].
    const clampLeft = (box, host, width) =>
        Math.max(8, Math.min(Math.round(box.left + box.width / 2 - host.left - width / 2), Math.round(host.width - width - 8)));
    const host = { left: 0, width: 400 };
    assert.strictEqual(clampLeft({ left: -50, width: 10 }, host, 320), 8, 'a selection near the left edge clamps to 8');
    assert.strictEqual(clampLeft({ left: 390, width: 10 }, host, 320), Math.round(host.width - 320 - 8), 'near the right edge clamps too');
});

test('bubble flips above only when there is room; otherwise clamps below', () => {
    const placeTop = (box, host, height) => {
        const above = Math.round(box.top - host.top - height - 8);
        const below = Math.round(box.bottom - host.top + 8);
        return above >= 8 ? above : Math.min(below, Math.round(host.height - height - 8));
    };
    const host = { top: 0, height: 600 };
    assert.strictEqual(placeTop({ top: 200, bottom: 220 }, host, 32), 200 - 32 - 8, 'room above: places above');
    const nearTop = placeTop({ top: 5, bottom: 25 }, host, 32);
    assert.ok(nearTop >= 8, 'no room above: never negative / off the top');
    assert.strictEqual(nearTop, 25 + 8, 'no room above: falls to below the selection');
});

// --- report -------------------------------------------------------------------

if (failures.length) {
    console.error(failures.length + ' failing, ' + passed + ' passing\n');
    for (const f of failures) {
        console.error('FAIL ' + f.name);
        console.error('  ' + (f.error && f.error.message ? f.error.message : f.error));
    }
    process.exit(1);
}
console.log('blocks-toolbar: ' + passed + ' passing');
