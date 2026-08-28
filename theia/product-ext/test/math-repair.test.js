/*
 * Display maths whose delimiters share a line with content.
 *
 * THE BUG THIS FILE EXISTS FOR, because it destroyed a real document and no
 * existing test could see it.
 *
 * remark-math recognises a flow-maths opener only at the start of a line and
 * treats whatever follows it on that line as the fence's "meta", which
 * mdast-util-math then DISCARDS. It closes only on a line whose content is a
 * run of `$` and nothing else. So the single most common way display maths is
 * written fails at both ends:
 *
 *     $$\begin{aligned}        <- `\begin{aligned}` is meta, and is dropped
 *     V(a) ={}&
 *     \end{aligned}$$          <- not a closer: it carries other content
 *
 * The opener never closes, so the construct runs to end of file. Measured on a
 * 72,507-byte research paper: 70,179 bytes — every heading, list, table and
 * paragraph after the first equation — collapsed into one mathBlock's `latex`
 * attribute. The editor showed one red error box where the document used to be.
 *
 * AND THE ROUND TRIP WAS PERFECT. A giant maths blob re-serialises to itself
 * byte for byte, so checkFidelity's stability check passed and the document
 * opened editable, at which point the next save wrote the blob back with its
 * fence widened to `$$$`. That is why the corpus test in
 * markdown-roundtrip.test.js stayed green through all of it: round-trip
 * stability is not structural correctness, and this file asserts structure.
 *
 * Run: `node test/math-repair.test.js`.
 */

const { normaliseDisplayMath, closeOpenMath } = require('../lib/browser/md-repair');
const { markdownToDoc, docToMarkdown, repairMarkdown } = require('../lib/browser/markdown');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) { pass++; } else { failures.push(name + (extra ? '\n      ' + extra : '')); } };

/** The top-level node types a document parses to, after repair. */
function structure(md) {
    const { doc } = markdownToDoc(repairMarkdown(md));
    return (doc.content || []).map(n => n.type);
}

/** The latex of every mathBlock in a document. */
function equations(md) {
    const { doc } = markdownToDoc(repairMarkdown(md));
    return (doc.content || []).filter(n => n.type === 'mathBlock').map(n => n.attrs.latex);
}

/** Does repair -> parse -> serialise return exactly the repaired text? */
function stable(md) {
    const repaired = repairMarkdown(md);
    return docToMarkdown(markdownToDoc(repaired).doc) === repaired;
}

/* --- 1. the four broken spellings, each now one bounded equation ---------- */

const FORMS = [
    ['canonical', '$$\nx = 1\n$$\n', 'x = 1'],
    ['one line', '$$x = 1$$\n', 'x = 1'],
    ['meta on the opener', '$$\\begin{aligned}\nx &= 1\n\\end{aligned}$$\n', '\\begin{aligned}\nx &= 1\n\\end{aligned}'],
    ['content on the opener', '$$\\text{a} =\n\\text{b}$$\n', '\\text{a} =\n\\text{b}'],
    ['glued closer', '$$\nx = 1$$\n', 'x = 1']
];

for (const [name, md, latex] of FORMS) {
    ok(name + ' parses to exactly one equation', structure(md).join(',') === 'mathBlock',
        'got [' + structure(md).join(', ') + ']');
    ok(name + ' keeps its latex intact', equations(md)[0] === latex,
        'got      ' + JSON.stringify(equations(md)[0]) + '\n      expected ' + JSON.stringify(latex));
    ok(name + ' round-trips byte-stably', stable(md));
}

/*
 * The named case: `\begin{aligned}` must survive, because losing it is what
 * made the equation invalid LaTeX as well as losing the document.
 */
ok('\\begin{aligned} is not discarded as fence meta',
    equations('$$\\begin{aligned}\nx &= 1\n\\end{aligned}$$\n')[0].startsWith('\\begin{aligned}'));

/* --- 2. an equation may not swallow the document ------------------------- */

/*
 * The invariant, and the one that actually bounds the damage: there is no such
 * thing as display maths containing a blank line. TeX treats one as a
 * paragraph break and errors; every Markdown flavour ends the construct there.
 * remark-math does not, so repair closes it.
 */
const SWALLOW = [
    'Intro paragraph.', '',
    '$$$', 'V(a)', '\\end{aligned}$$', '',
    'Prose after the equation.', '',
    '# A heading', '',
    '- a list item', '- another', '',
    '| a | b |', '| - | - |', '| 1 | 2 |', ''
].join('\n');

const swallowed = structure(SWALLOW);
ok('a malformed equation does not consume the rest of the document',
    swallowed.length >= 6, 'got [' + swallowed.join(', ') + ']');
ok('the heading after a malformed equation is still a heading', swallowed.includes('heading'),
    '[' + swallowed.join(', ') + ']');
ok('the list after a malformed equation is still a list', swallowed.includes('bulletList'),
    '[' + swallowed.join(', ') + ']');
ok('the table after a malformed equation is still a table', swallowed.includes('table'),
    '[' + swallowed.join(', ') + ']');
ok('the malformed equation is bounded to its own block',
    equations(SWALLOW).every(l => !l.includes('# A heading')),
    JSON.stringify(equations(SWALLOW)));

/*
 * A closer with a stray character after it — `\right)$$_`, which an earlier
 * pass of this repository's own marker balancing left in a real file — is not
 * a closer, and used to merge four hundred lines into one equation.
 */
const STRAY = ['$$', 'C_{x}', '\\right)$$_', '', 'Prose.', '', '## Heading', ''].join('\n');
ok('a closer with trailing junk still ends at the blank line',
    structure(STRAY).includes('heading') && structure(STRAY).includes('paragraph'),
    '[' + structure(STRAY).join(', ') + ']');

/* --- 3. what must NOT be touched ---------------------------------------- */

// Inline maths is a different construct and repair has no business in it.
ok('single-dollar inline maths is untouched',
    normaliseDisplayMath('see $x=1$ and $y$ here\n') === 'see $x=1$ and $y$ here\n');
ok('bare dollars in prose are untouched',
    normaliseDisplayMath('it costs $5 and $6\n') === 'it costs $5 and $6\n');

// `$$` inside a fence is code, not a delimiter.
const FENCE = '```sh\necho $$\ncat <<X\n$$foo\nX\n```\n';
ok('dollars inside a fenced block are untouched', normaliseDisplayMath(FENCE) === FENCE);
ok('a fence containing dollars still parses as one code block',
    structure(FENCE).join(',') === 'codeBlock', '[' + structure(FENCE).join(', ') + ']');

// A `$$$`-delimited block that closes properly is valid and must be left alone.
const TRIPLE = '$$$\nx = 1\n$$$\n';
ok('a correctly closed $$$ block is left alone', closeOpenMath(TRIPLE) === TRIPLE);

// Several delimiter runs on one line are ambiguous; repair must not guess.
ok('an ambiguous multi-delimiter line is left alone',
    normaliseDisplayMath('$$a$$ and $$b$$\n') === '$$a$$ and $$b$$\n');

/* --- 4. several equations in one document ------------------------------- */

const MANY = [
    '$$a = 1$$', '',
    'Between them.', '',
    '$$\\begin{cases}', 'b', '\\end{cases}$$', '',
    'And after.', ''
].join('\n');
ok('every equation in a document is found', equations(MANY).length === 2,
    'got ' + equations(MANY).length);
ok('a multi-equation document keeps its prose',
    structure(MANY).filter(t => t === 'paragraph').length === 2, '[' + structure(MANY).join(', ') + ']');
ok('a multi-equation document round-trips byte-stably', stable(MANY));

/* --- 5. and the two ordered-list regressions found alongside ------------- */

/*
 * `start` was dropped on the way into the editor, so a bibliography numbered
 * 6..13 came back numbered 1..8 — a change to what the document says, not to
 * how it is spelled.
 */
for (const [name, md] of [['a list starting at 1', '1. a\n2. b\n'],
    ['a list starting at 5', '5. a\n6. b\n'],
    ['a list starting at 20', '20. a\n21. b\n22. c\n']]) {
    ok(name + ' keeps its first ordinal', stable(md), JSON.stringify(docToMarkdown(markdownToDoc(repairMarkdown(md)).doc)));
}

/* --- report ------------------------------------------------------------- */

console.log('');
if (!failures.length) {
    console.log('math-repair: ' + pass + ' passing');
    process.exitCode = 0;
} else {
    for (const f of failures) { console.log('  FAIL  ' + f); }
    console.log('\nmath-repair: ' + pass + ' passing, ' + failures.length + ' failing');
    process.exitCode = 1;
}
