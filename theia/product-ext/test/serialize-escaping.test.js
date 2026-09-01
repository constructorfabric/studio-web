/*
 * What the serialiser escapes, and what it must stop escaping.
 *
 * mdast-util-to-markdown escapes every `_` it emits in phrasing with no regard
 * for its neighbours — the rule carries no before/after constraint and no
 * option adds one, since an extension's `unsafe` entries are appended to the
 * defaults rather than replacing them. So a document mentioning `snake_case`,
 * an environment variable, or mathematical subscripts written as prose came
 * back with a backslash before every underscore. Nothing renders differently;
 * what changes is the diff. A 2,000-line paper with subscripts on eighty lines
 * reformatted eighty lines on first save, which buries the one line the author
 * changed.
 *
 * The unescape is safe for `_` and only for `_`. CommonMark 6.2 additionally
 * requires that a `_` left-flanking run is not preceded by an alphanumeric and
 * a right-flanking run is not followed by one, so an underscore with a word
 * character on BOTH sides can neither open nor close emphasis in any context:
 * it is always literal and the backslash is always redundant. `*` has no such
 * rule — it does open emphasis intraword — which is why this touches exactly
 * one character.
 *
 * Run: `node test/serialize-escaping.test.js`.
 */

const { unescapeIntrawordUnderscore } = require('../src/browser/md-serialize');
const { markdownToDoc, docToMarkdown, repairMarkdown } = require('../src/browser/markdown');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) { pass++; } else { failures.push(name + (extra ? '\n      ' + extra : '')); } };

function unit(name, input, expected) {
    const got = unescapeIntrawordUnderscore(input);
    ok(name, got === expected, 'got      ' + JSON.stringify(got) + '\n      expected ' + JSON.stringify(expected));
}

/* --- unescaped: a word character on both sides -------------------------- */

unit('a subscript', 'Q\\_0', 'Q_0');
unit('several in one word', 'snake\\_case\\_word', 'snake_case_word');
unit('digits either side', 'a1\\_2b', 'a1_2b');

/* --- left alone: not intraword ------------------------------------------ */

// A `_` that COULD open or close emphasis keeps its backslash, because there
// the escape is doing real work.
unit('leading underscore', 'a \\_b', 'a \\_b');
unit('trailing underscore', 'x\\_', 'x\\_');
unit('underscore after punctuation', 'a.\\_b', 'a.\\_b');

/* --- left alone: verbatim spans ----------------------------------------- */

// Their content is emitted exactly as given, so a backslash inside one is the
// author's own character and must survive.
unit('inside an inline code span', '`Q\\_0`', '`Q\\_0`');
unit('inside a double-backtick span', '``a\\_b``', '``a\\_b``');
unit('inside inline maths', '$Q\\_0$', '$Q\\_0$');
unit('inside display maths', '$$\nQ\\_0\n$$', '$$\nQ\\_0\n$$');
unit('inside a fenced block', '```\nQ\\_0\n```', '```\nQ\\_0\n```');

/* --- left alone: an author's literal backslash -------------------------- */

// The serialiser writes a literal backslash-underscore as `\\_`; matching the
// `\_` at its tail would change the document.
unit('an escaped backslash before an underscore', 'a\\\\\\_b', 'a\\\\\\_b');

/* --- end to end: a document with all of them --------------------------- */

const DOCS = [
    'Values (Q_0) and (C_L) matter.\n',
    'A snake_case_name here.\n',
    'Code `a_b`, maths $Q_0$, and prose Q_0.\n',
    '- (L_A) — training\n- (K_O) — knowledge\n',
    '```python\nMY_VAR = 1\n```\n',
    '$$\nC_{\\text{cost}} + C_{\\text{other}}\n$$\n'
];
for (const md of DOCS) {
    const repaired = repairMarkdown(md);
    const out = docToMarkdown(markdownToDoc(repaired).doc);
    ok('round-trips byte-stably: ' + JSON.stringify(md.slice(0, 44)), out === repaired,
        'got      ' + JSON.stringify(out) + '\n      expected ' + JSON.stringify(repaired));
    ok('no stray backslash added: ' + JSON.stringify(md.slice(0, 44)), !/[0-9A-Za-z]\\_[0-9A-Za-z]/.test(out), out);
}

/*
 * Emphasis still has to WORK. Unescaping too eagerly would turn literal text
 * into emphasis on the next parse, which is the failure mode worth guarding:
 * these documents must mean the same thing after a round trip.
 */
for (const [md, wantEmphasis] of [['Real _emphasis_ here.\n', true], ['Not a_b emphasis.\n', false]]) {
    const { doc } = markdownToDoc(repairMarkdown(md));
    const marked = JSON.stringify(doc).includes('"italic"');
    ok('emphasis is ' + (wantEmphasis ? 'kept' : 'not invented') + ' in ' + JSON.stringify(md.trim()),
        marked === wantEmphasis);
    // And again after a save, which is where an over-eager unescape would show.
    const again = markdownToDoc(docToMarkdown(doc));
    ok('emphasis survives a save in ' + JSON.stringify(md.trim()),
        JSON.stringify(again.doc).includes('"italic"') === wantEmphasis);
}

/* --- report ------------------------------------------------------------ */

console.log('');
if (!failures.length) {
    console.log('serialize-escaping: ' + pass + ' passing');
    process.exitCode = 0;
} else {
    for (const f of failures) { console.log('  FAIL  ' + f); }
    console.log('\nserialize-escaping: ' + pass + ' passing, ' + failures.length + ' failing');
    process.exitCode = 1;
}
