/*
 * Pure-Node tests for blocks.js's rankBlocks(). No jsdom: the ranking never
 * touches the DOM, so a plain `node blocks-ranking.test.js` is enough to
 * prove it, and that is the point -- these run in CI without a browser.
 *
 * Run: node theia/product-ext/test/blocks-ranking.test.js
 */

const assert = require('assert');
const { BLOCKS, rankBlocks } = require('../src/browser/blocks');

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

function topKey(query, opts) {
    const rows = rankBlocks(query, opts);
    return rows.length ? rows[0].block.key : undefined;
}

// --- required cases from the brief ---------------------------------------

test('hr lands on Divider, not Heading 1', () => {
    assert.strictEqual(topKey('hr'), 'divider');
});

test('ul lands on Bulleted list', () => {
    assert.strictEqual(topKey('ul'), 'bullet');
});

test('equation lands on Equation', () => {
    assert.strictEqual(topKey('equation'), 'math-block');
});

test('``` lands on Code block', () => {
    assert.strictEqual(topKey('```'), 'code');
});

test('todo lands on Checklist', () => {
    assert.strictEqual(topKey('todo'), 'task');
});

test('admonition lands on a callout', () => {
    const rows = rankBlocks('admonition');
    assert.ok(rows.length > 0, 'expected at least one match');
    assert.strictEqual(rows[0].group, 'Callouts');
    assert.ok(rows[0].block.key.startsWith('callout-'));
});

test('mermid (typo) surfaces Diagram via fuzzy', () => {
    const rows = rankBlocks('mermid');
    assert.ok(rows.some(r => r.block.key === 'diagram'), 'Diagram not found for "mermid"');
});

// --- short-query gating -----------------------------------------------------
//
// Ungated, "ul" scored twelve blocks -- Divider because "rule" contains it,
// Quote because "pullquote" contains it, plus Warning callout, Equation and
// six more on the same coincidence. baseScore's substring tiers (50/40) now
// require 3+ characters and fuzzyScore requires 4+ AND fewer than three
// precise hits already, so a two-letter query returns only what actually
// matched it precisely (exact/prefix/word-start).

test('ul returns Bulleted list only (not Divider via "rule", not Quote via "pullquote")', () => {
    const rows = rankBlocks('ul');
    assert.deepStrictEqual(rows.map(r => r.block.key), ['bullet']);
});

test('hr returns Divider only', () => {
    const rows = rankBlocks('hr');
    assert.deepStrictEqual(rows.map(r => r.block.key), ['divider']);
});

test('ol returns Numbered list only', () => {
    const rows = rankBlocks('ol');
    assert.deepStrictEqual(rows.map(r => r.block.key), ['ordered']);
});

test('eq returns Equation only', () => {
    const rows = rankBlocks('eq');
    assert.deepStrictEqual(rows.map(r => r.block.key), ['math-block']);
});

test('ad returns exactly the five callouts, via alias prefix on "admonition"', () => {
    const rows = rankBlocks('ad');
    const keys = rows.map(r => r.block.key).sort();
    assert.deepStrictEqual(keys, ['callout-caution', 'callout-important', 'callout-note', 'callout-tip', 'callout-warning']);
    assert.ok(rows.every(r => r.score === 70), 'all five should be the alias-prefix tier, not fuzzy');
});

test('short queries do not starve legitimately broad ones: h leads with the six headings', () => {
    const rows = rankBlocks('h');
    const top = rows.slice(0, 6).map(r => r.block.key).sort();
    assert.deepStrictEqual(top, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
});

test('short queries do not starve legitimately broad ones: p leads with Text', () => {
    const rows = rankBlocks('p');
    assert.strictEqual(rows[0].block.key, 'text');
});

test('todo, equation and ``` are unaffected by the length gates (already exact-alias matches)', () => {
    assert.deepStrictEqual(rankBlocks('todo').map(r => r.block.key), ['task']);
    assert.deepStrictEqual(rankBlocks('equation').map(r => r.block.key), ['math-block']);
    assert.deepStrictEqual(rankBlocks('```').map(r => r.block.key), ['code']);
});

test('fuzzy never fires once the precise tiers already found 3+ blocks', () => {
    // "ad" alone finds five callouts via alias prefix; a 4+ character query
    // that still lands 3+ precise hits must not ALSO go loose and pull in
    // fuzzy noise on top of them.
    const rows = rankBlocks('admo');
    assert.ok(rows.every(r => r.score >= 70), 'no fuzzy(20) rows once the precise tiers cleared the floor');
});

test('empty query puts Recent first, then Basic', () => {
    const rows = rankBlocks('', { recent: ['table', 'math-block', 'callout-note'] });
    assert.strictEqual(rows[0].group, 'Recent');
    assert.strictEqual(rows[0].block.key, 'table');
    const groupsInOrder = [];
    for (const r of rows) {
        if (groupsInOrder[groupsInOrder.length - 1] !== r.group) { groupsInOrder.push(r.group); }
    }
    assert.strictEqual(groupsInOrder[0], 'Recent');
    assert.strictEqual(groupsInOrder[1], 'Basic');
});

test('empty query with no recent starts at Basic', () => {
    const rows = rankBlocks('');
    assert.strictEqual(rows[0].group, 'Basic');
});

test('every block is reachable by at least three distinct queries', () => {
    const failing = [];
    for (const block of BLOCKS) {
        const candidates = new Set([
            block.key,
            ...block.label.toLowerCase().split(/\s+/),
            ...block.aliases.map(a => a.toLowerCase())
        ]);
        let reachable = 0;
        for (const q of candidates) {
            if (!q) { continue; }
            const rows = rankBlocks(q);
            if (rows.some(r => r.block.key === block.key)) { reachable++; }
        }
        if (reachable < 3) { failing.push(block.key + ' (' + reachable + ')'); }
    }
    assert.deepStrictEqual(failing, [], 'blocks reachable by fewer than three queries: ' + failing.join(', '));
});

// --- additional coverage ---------------------------------------------------

test('registry has no duplicate keys', () => {
    const keys = BLOCKS.map(b => b.key);
    assert.strictEqual(new Set(keys).size, keys.length);
});

test('every block declares at least three aliases', () => {
    const short = BLOCKS.filter(b => (b.aliases || []).length < 3).map(b => b.key);
    assert.deepStrictEqual(short, []);
});

test('exact key match always outranks a substring match elsewhere', () => {
    // "table" is an exact key; "definition" and others merely mention
    // tabular concepts in aliases ("grid", "sheet", "matrix" etc. do not
    // collide with "table" itself, so this is really asserting exact-match
    // supremacy holds structurally, not asserting a specific collision.
    assert.strictEqual(topKey('table'), 'table');
});

test('h1 query ranks headings above Highlight-shaped aliases', () => {
    const rows = rankBlocks('h1');
    assert.strictEqual(rows[0].block.key, 'h1');
});

test('ranking is case-insensitive', () => {
    assert.strictEqual(topKey('EQUATION'), topKey('equation'));
});

test('unmatched gibberish query returns no rows', () => {
    const rows = rankBlocks('zzzqqqxxx');
    assert.deepStrictEqual(rows, []);
});

test('rankBlocks respects a supplied blocks pool (schema filtering point)', () => {
    const onlyDivider = BLOCKS.filter(b => b.key === 'divider');
    const rows = rankBlocks('hr', { blocks: onlyDivider });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].block.key, 'divider');
    const rowsExcluded = rankBlocks('hr', { blocks: BLOCKS.filter(b => b.key !== 'divider') });
    assert.ok(!rowsExcluded.some(r => r.block.key === 'divider'));
});

test('convert:true blocks include the block selector floor (text, headings, callouts)', () => {
    const convertKeys = BLOCKS.filter(b => b.convert).map(b => b.key);
    for (const must of ['text', 'h1', 'h2', 'callout-note', 'code', 'math-block']) {
        assert.ok(convertKeys.includes(must), must + ' should be convert:true');
    }
    for (const mustNot of ['divider', 'table', 'image', 'figure', 'frontmatter']) {
        assert.ok(!convertKeys.includes(mustNot), mustNot + ' should not be convert:true');
    }
});

// --- report -----------------------------------------------------------------

if (failures.length) {
    console.error(failures.length + ' failing, ' + passed + ' passing\n');
    for (const f of failures) {
        console.error('FAIL ' + f.name);
        console.error('  ' + (f.error && f.error.message ? f.error.message : f.error));
    }
    process.exit(1);
}
console.log('blocks-ranking: ' + passed + ' passing');
