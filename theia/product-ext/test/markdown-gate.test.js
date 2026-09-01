/*
 * The read-only gate, tested on its own.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE CORPUS TEST. The corpus in
 * markdown-roundtrip.test.js proves that what the engine parses it can emit
 * again. It says nothing about `unsupportedConstructs`, which is a different
 * question asked earlier: may this document be edited AT ALL. That gap hid a
 * bug that made every document containing a fenced code block open read-only —
 * a regex whose `$` matched at any line end under the `m` flag, so a single
 * line of fence body satisfied it (see markdown.js's own note). The round trip
 * for those same documents was perfect, so the corpus stayed green throughout.
 *
 * A predicate that decides whether a file is editable is worth its own test.
 * Both directions matter equally: a false positive locks a document nobody
 * needed to lock, and a false negative lets a lossy save through.
 *
 * Run: `node test/markdown-gate.test.js` (or `npm run test:markdown-gate`).
 */

const fs = require('fs');
const path = require('path');

const { unsupportedConstructs } = require('../src/browser/markdown');

let pass = 0;
const failures = [];

function check(name, source, expected) {
    const found = unsupportedConstructs(source);
    const ok = found.length === expected.length && expected.every(e => found.some(f => f.includes(e)));
    if (ok) { pass++; } else {
        failures.push(name + '\n      expected: ' + JSON.stringify(expected) + '\n      got:      ' + JSON.stringify(found));
    }
}

/* --- fence balance -------------------------------------------------------- */

const FENCE = 'an unterminated fence';
const SCRIPT = '<script>';

// Closed fences are editable. Every one of these was condemned by the regex
// this test replaced, which is the whole reason the list is this long.
check('backtick fence, closed', '```js\nconst a = 1;\n```\n', []);
check('bare fence, closed', '```\nplain text\n```\n', []);
check('math fence, closed', '```math\n\\int_0^1 x^2\n```\n', []);
check('tilde fence, closed', '~~~\nbody\n~~~\n', []);
check('two fences, both closed', '```js\na\n```\n\nprose\n\n```py\nb\n```\n', []);
check('empty fence body', '```\n```\n', []);
check('fence at end of file, closed', 'text\n\n```sh\nls\n```', []);
check('indented fence, closed', '  ```js\n  a\n  ```\n', []);

// CommonMark: the closer may be LONGER than the opener but not shorter, must
// use the same character, and must carry nothing but whitespace.
check('closer longer than opener', '```js\na\n````\n', []);
check('closer shorter than opener', '````js\na\n```\n', [FENCE]);
check('mismatched fence character', '```js\na\n~~~\n', [FENCE]);
check('closer carrying an info string', '```js\na\n```js\n', [FENCE]);

// A fence of one character type nested inside the other is body text, not a
// close — this is how a markdown document quotes markdown.
check('tilde fence inside backtick fence', '```md\n~~~\nnot a close\n~~~\n```\n', []);
check('backtick fence inside tilde fence', '~~~md\n```\nnot a close\n```\n~~~\n', []);

// Genuinely open fences must still be caught: this is the case the gate is for.
check('open backtick fence', '```js\nconst a = 1;\n', [FENCE]);
check('open tilde fence', '~~~\nbody\n', [FENCE]);
check('open fence, nothing after it', 'prose\n\n```', [FENCE]);
check('second fence left open', '```js\na\n```\n\n```py\nb\n', [FENCE]);

// Backticks that are not fences at all.
check('inline code span with triple backticks', 'see ```not a fence``` here\n', []);
check('two backticks is not a fence', '``\nnot a fence\n``\n', []);

/* --- the script check ----------------------------------------------------- */

check('live script tag', '<script>alert(1)</script>\n', [SCRIPT]);
check('script tag with attributes', '<script src="x.js"></script>\n', [SCRIPT]);
// Quoted inside a code sample it is documentation, not a vector — and a
// documentation repository is full of it.
check('script tag quoted in a closed fence', '```html\n<script>x</script>\n```\n', []);
check('script tag in an inline code span', 'use `<script>` carefully\n', []);
// Everything else HTML now reaches the X-01 fallback instead of the gate,
// which is the change this shortlist represents.
check('plain html block', '<div class="x">hello</div>\n', []);
check('html comment', '<!-- a note -->\n', []);
check('self-closing html', '<br/>\n', []);

/* --- nothing at all ------------------------------------------------------- */

check('empty document', '', []);
check('prose only', '# Title\n\nSome text.\n', []);

/*
 * And the corpus itself: every fixture must clear the gate, because a fixture
 * that cannot be opened cannot be round-tripped either. The two exceptions are
 * named rather than pattern-matched — an open fence is the POINT of those two
 * files (drift class DR-3, an interrupted agent's half-written output), so they
 * are the one place a positive is correct.
 */
const OPEN_BY_DESIGN = new Set(['dr3-streaming/interrupted-fence.md']);

function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { walk(full, rel); continue; }
        if (!entry.name.endsWith('.md')) { continue; }
        const body = fs.readFileSync(full, 'utf8');
        check('fixture ' + rel, body, OPEN_BY_DESIGN.has(rel) ? [FENCE] : []);
    }
}
walk(path.join(__dirname, 'fixtures'), '');

/* --- report --------------------------------------------------------------- */

console.log('');
if (!failures.length) {
    console.log('markdown-gate: ' + pass + ' passing');
    process.exitCode = 0;
} else {
    for (const f of failures) { console.log('  FAIL  ' + f); }
    console.log('\nmarkdown-gate: ' + pass + ' passing, ' + failures.length + ' failing');
    process.exitCode = 1;
}
