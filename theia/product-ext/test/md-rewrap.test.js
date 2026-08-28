/*
 * Pure-Node tests for md-rewrap.js's preserveWrapping(). No jsdom, no
 * markdown pipeline: the function only ever sees two plain strings, so a
 * plain `node md-rewrap.test.js` is enough to prove it, and that is the
 * point -- these run in CI without a browser.
 *
 * Run: node theia/product-ext/test/md-rewrap.test.js
 */

const assert = require('assert');
const { preserveWrapping } = require('../lib/browser/md-rewrap');

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

// --- required cases from the brief ---------------------------------------

test('an untouched hard-wrapped paragraph is restored byte for byte', () => {
    const original = 'This paragraph was\nhand-wrapped by its\nauthor a long time ago.\n';
    const reflowed = 'This paragraph was hand-wrapped by its author a long time ago.\n';
    assert.strictEqual(preserveWrapping(original, reflowed), original);
});

// This used to assert the WHOLE block came back on one line the moment any
// word in it changed -- the exact defect this module now fixes. An edit to
// the last line must not cost the first two their wrapping.
test('a hard-wrapped paragraph whose words changed keeps its unchanged lines and reflows only the changed one', () => {
    const original = 'This paragraph was\nhand-wrapped by its\nauthor a long time ago.\n';
    const edited = 'This paragraph was hand-wrapped by its author yesterday, not long ago.\n';
    const expected = 'This paragraph was\nhand-wrapped by its\nauthor yesterday, not long ago.\n';
    assert.strictEqual(preserveWrapping(original, edited), expected);
});

test('a fenced code block whose only change is whitespace is NOT restored', () => {
    const original = '```js\nconst x = 1;   \nconst y = 2;\n```\n';
    const reserialized = '```js\nconst x = 1;\nconst y = 2;\n```\n';
    assert.strictEqual(preserveWrapping(original, reserialized), reserialized);
});

test('a table is NOT restored', () => {
    const original = '| a  |  b |\n| - | - |\n| 1  | 2 |\n';
    const reserialized = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    assert.strictEqual(preserveWrapping(original, reserialized), reserialized);
});

test('a paragraph added in the middle leaves the untouched neighbours restored', () => {
    const original = 'First paragraph\nwrapped by hand.\n\nThird paragraph\nalso wrapped.\n';
    const withInsertion =
        'First paragraph wrapped by hand.\n\nA brand new paragraph the author just typed.\n\nThird paragraph also wrapped.\n';
    const expected =
        'First paragraph\nwrapped by hand.\n\nA brand new paragraph the author just typed.\n\nThird paragraph\nalso wrapped.\n';
    assert.strictEqual(preserveWrapping(original, withInsertion), expected);
});

test('idempotent: applying it twice is the same as applying it once', () => {
    const original = 'First paragraph\nwrapped by hand.\n\nThird paragraph\nalso wrapped.\n';
    const withInsertion =
        'First paragraph wrapped by hand.\n\nA brand new paragraph the author just typed.\n\nThird paragraph also wrapped.\n';
    const once = preserveWrapping(original, withInsertion);
    const twice = preserveWrapping(original, once);
    assert.strictEqual(twice, once);
});

test('undefined, null and empty original all return newBody untouched', () => {
    const reflowed = 'Whatever the serializer produced.\n';
    assert.strictEqual(preserveWrapping(undefined, reflowed), reflowed);
    assert.strictEqual(preserveWrapping(null, reflowed), reflowed);
    assert.strictEqual(preserveWrapping('', reflowed), reflowed);
});

// --- additional coverage ---------------------------------------------------

test('a block with no newline in the original is left as the new text', () => {
    const original = 'Already a single line.\n';
    const reflowed = 'Already a single line.\n';
    assert.strictEqual(preserveWrapping(original, reflowed), reflowed);
});

test('trailing-newline convention follows newBody, not the original', () => {
    const original = 'Wrapped\nparagraph.\n';
    const noTrailingNewline = 'Wrapped paragraph.';
    assert.strictEqual(preserveWrapping(original, noTrailingNewline), 'Wrapped\nparagraph.');
});

test('an indented-code-shaped block is not restored even when its collapsed key matches', () => {
    const original = '    line one\n    line two';
    const reflowed = '    line one line two';
    assert.strictEqual(preserveWrapping(original, reflowed), reflowed);
});

test('a ~~~-fenced block is treated the same as a ```-fenced one', () => {
    const original = '~~~js\nconst x = 1;   \n~~~\n';
    const reserialized = '~~~js\nconst x = 1;\n~~~\n';
    assert.strictEqual(preserveWrapping(original, reserialized), reserialized);
});

test('an unrelated, unwrapped paragraph elsewhere in the document is untouched', () => {
    const original = 'A single-line paragraph.\n\nA second\nhand-wrapped one.\n';
    const reflowed = 'A single-line paragraph.\n\nA second hand-wrapped one.\n';
    assert.strictEqual(preserveWrapping(original, reflowed), original);
});

test('multiple wrapped paragraphs in the same document are all restored', () => {
    const original = 'One\ntwo\nthree.\n\nFour\nfive\nsix.\n\nSeven\neight\nnine.\n';
    const reflowed = 'One two three.\n\nFour five six.\n\nSeven eight nine.\n';
    assert.strictEqual(preserveWrapping(original, reflowed), original);
});

// --- changed-block word-level rewrap ---------------------------------------

test('the measured case: inserting one word into a hand-wrapped line produces a one-line change', () => {
    const original =
        '**Your transcript is not the record.** The person is looking at a document and a\n' +
        'rail; their colleague and your own next session see only this repository.\n' +
        'Anything that matters goes into a file or into a tool call. A conclusion that exists\n' +
        'only in the chat does not exist.\n';
    const edited =
        '**Your transcript is not the record.** The person is looking at a document and a ' +
        'rail; dear their colleague and your own next session see only this repository. ' +
        'Anything that matters goes into a file or into a tool call. A conclusion that exists ' +
        'only in the chat does not exist.\n';
    const expected =
        '**Your transcript is not the record.** The person is looking at a document and a\n' +
        'rail; dear their colleague and your own next session see only this repository.\n' +
        'Anything that matters goes into a file or into a tool call. A conclusion that exists\n' +
        'only in the chat does not exist.\n';
    assert.strictEqual(preserveWrapping(original, edited), expected);
});

test('deleting a word inside a wrapped paragraph shrinks only the line it was on', () => {
    const original = 'Line one has some words\nthat continue right here\nand then a third line too.\n';
    const edited = 'Line one has some words that continue here and then a third line too.\n';
    const expected = 'Line one has some words\nthat continue here\nand then a third line too.\n';
    assert.strictEqual(preserveWrapping(original, edited), expected);
});

test('a changed block that was never wrapped stays on one line', () => {
    const original = 'This line was never wrapped in the first place.\n';
    const edited = 'This line was never wrapped at all.\n';
    assert.strictEqual(preserveWrapping(original, edited), edited);
});

test('idempotent on a changed block: applying it twice matches applying it once', () => {
    const original =
        '**Your transcript is not the record.** The person is looking at a document and a\n' +
        'rail; their colleague and your own next session see only this repository.\n' +
        'Anything that matters goes into a file or into a tool call. A conclusion that exists\n' +
        'only in the chat does not exist.\n';
    const edited =
        '**Your transcript is not the record.** The person is looking at a document and a ' +
        'rail; dear their colleague and your own next session see only this repository. ' +
        'Anything that matters goes into a file or into a tool call. A conclusion that exists ' +
        'only in the chat does not exist.\n';
    const once = preserveWrapping(original, edited);
    const twice = preserveWrapping(original, once);
    assert.strictEqual(twice, once);
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
console.log('md-rewrap: ' + passed + ' passing');
