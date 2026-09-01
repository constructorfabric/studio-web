/*
 * Stage N — drift repair.
 *
 * D-05: this runs on IMPORT and PASTE only, never on save — markdown.js
 * wires it in exactly twice, both outside the save path. The reason is the
 * same reason checkFidelity used to open a document read-only rather than
 * guess: a save has to be exactly what the editor's document model says, and
 * a repair heuristic is exactly the kind of "probably what they meant" logic
 * that must never run on a path that writes the file the author did not
 * touch. Import and paste are different — the text has not been through the
 * editor's model yet, so there is no "what the model says" to contradict.
 *
 * Two passes, matching the two places drift actually shows up:
 *
 *   repairText   - TEXT-level, before the real parser ever sees the string:
 *                  unterminated inline markers, an open fence at EOF, a
 *                  half-written table row, a 2-space list indent that would
 *                  mis-nest under an ordered marker. All of these are cases
 *                  where the PARSER would misread the rest of the document
 *                  if they were left for it - a dangling `**` does not just
 *                  fail to close, it turns every subsequent `*` in the file
 *                  into emphasis boundaries. Fixing them has to happen
 *                  before parsing, not after.
 *
 *   repairTree   - MDAST-level, after a real parse: a ragged table row
 *                  padded/truncated to the header's width.
 *
 * Both passes are heuristic by nature - "probably what the author meant" -
 * which is exactly why D-05 confines them to import and paste.
 */

const { PROCESSOR } = require('./md-parse');
// The pinned stringify processor, not md-parse's own - repairMarkdown's text
// output should already be in this product's one house style (see
// md-serialize.js's STRINGIFY_OPTIONS) rather than whatever remark-stringify
// defaults to, since Raw mode can show this text before the first real save
// ever runs docToMarkdown over it.
const { CALLOUT_TONES } = require('./md-schema');

// --- shared masking (see md-parse.js's own copy; kept separate on purpose -
// repair's masking additionally has to leave an UNCLOSED fence visible, since
// finding one is the whole point of one of these repairs, whereas md-parse's
// only ever needs to protect complete, already-valid spans) ------------------

/*
 * The placeholder uses U+E000, a Private Use Area codepoint that cannot
 * appear in a document typed or pasted as ordinary text. An earlier version
 * of this used plain spaces around the index (` 3 `) and broke on the FIRST
 * table cell containing a lone number - "| 1 | 2 |" already contains " 1 "
 * as a literal substring, and the restore regex matched that instead of an
 * actual placeholder, splicing `store[1]` (`undefined`) into the table.
 */
const MASK_OPEN = '';
const MASK_CLOSE = '';

function maskComplete(text) {
    const store = [];
    const put = m => { store.push(m); return MASK_OPEN + (store.length - 1) + MASK_CLOSE; };
    // Complete fences only - `\2` backreferences the SAME run, so a fence
    // closed by a longer or shorter run of the same character (invalid) is
    // deliberately left unmasked, and an unclosed fence at EOF (no match at
    // all) is left unmasked too, exactly the "leave complete fences
    // untouched" / "an open fence at EOF" pair CONTRACT.md asks for.
    let out = text.replace(/^([ \t]{0,3}(`{3,}|~{3,}))[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*$/gm, put);
    out = out.replace(/(`+)(?:[^`]|(?!\1)`)*?\1/g, put);
    /*
     * Math content, same reasoning as code: LaTeX source inside `$$…$$` or
     * `$…$` uses `_`, `^` and `*` as its own syntax (`\int_{0}^{x}`), not as
     * Markdown emphasis markers, and an earlier version of this function did
     * not know that — it read the lone `_` in `\int_{0}^{x}` as an
     * unmatched opener (not intraword: the character after it is `{`, not a
     * word character) and appended a spurious closing `_` after every
     * document containing block math. Masking the whole math span, the same
     * way a fence is masked, is what a real parser already does for these
     * two constructs — see md-parse.js's own accept-form table — so this is
     * catching up to that, not inventing a new rule.
     */
    out = out.replace(/^\$\$\n[\s\S]*?\n\$\$[ \t]*$/gm, put);
    out = out.replace(/\$[^$\n]+\$/g, put);
    const re = new RegExp(MASK_OPEN + '(\\d+)' + MASK_CLOSE, 'g');
    return { text: out, restore: s => s.replace(re, (_, i) => store[Number(i)]) };
}

// --- an open fence at EOF ----------------------------------------------------

/** Appends a closing fence if the document ends inside an unterminated one. */
function closeOpenFence(text) {
    const lines = text.split('\n');
    let open = null; // { char, len, indent }
    for (const line of lines) {
        const m = line.match(/^([ \t]{0,3})(`{3,}|~{3,})/);
        if (open) {
            // A fence only closes another fence of the SAME character, with a
            // run at least as long - CommonMark's own rule, repeated here so
            // this repair does not "close" a fence with a line that would not
            // actually close it once reparsed.
            if (m && m[2][0] === open.char && m[2].length >= open.len) { open = null; }
            continue;
        }
        if (m) { open = { char: m[2][0], len: m[2].length, indent: m[1] }; }
    }
    if (!open) { return text; }
    const closer = open.indent + open.char.repeat(open.len);
    return text.replace(/\n*$/, '\n') + closer + '\n';
}

// --- a half-written table row ------------------------------------------------

/**
 * The document was cut off mid-row: the last line looks like part of an
 * unterminated table row and the line before it belongs to the same table.
 * GFM already tolerates a SHORT row (pads with empty cells - verified
 * against remark-gfm directly), so this only has to handle the row not
 * being terminated as a line at all.
 */
function closeOpenTableRow(text) {
    if (/\n\s*$/.test(text) || !text.trim()) { return text; }
    const lines = text.split('\n');
    const last = lines[lines.length - 1];
    if (!/^\s*\|/.test(last) && !last.includes('|')) { return text; }
    const prev = lines[lines.length - 2] || '';
    if (!/\|/.test(prev)) { return text; }
    const trimmed = last.replace(/\s+$/, '');
    const closed = trimmed.endsWith('|') ? trimmed : trimmed + ' |';
    lines[lines.length - 1] = closed;
    return lines.join('\n') + '\n';
}

// --- display math sharing a line with its delimiters -------------------------

/*
 * `$$` PUT ON ITS OWN LINE, AND THE REASON THIS IS A DATA-LOSS FIX.
 *
 * remark-math's flow-math construct recognises an opening `$$` at the start
 * of a line and treats ANYTHING FOLLOWING IT ON THAT LINE as the fence's
 * "meta" — which mdast-util-math then discards, exactly the way a code
 * fence's info string is not part of its body. It also closes only on a line
 * whose content is a run of `$` and nothing else. Both halves of the single
 * most common way display maths is actually written therefore fail:
 *
 *     $$\begin{aligned}          <- `\begin{aligned}` becomes meta, DROPPED
 *     V(a) ={}&
 *     \end{aligned}$$            <- not a closer: it carries other content
 *
 * The opener is left unclosed, so the construct runs to end of file and the
 * WHOLE REST OF THE DOCUMENT becomes one latex string. Measured on a real
 * 72,507-byte research file: 70,179 bytes — everything after the first
 * equation — collapsed into a single mathBlock, and because a giant maths
 * blob re-serialises to itself byte for byte, checkFidelity's round trip was
 * perfectly stable and the document opened editable. The gate cannot see
 * this class of damage; the parse has to not produce it.
 *
 * Splitting the delimiters onto their own lines is a pure reformat: the latex
 * between them is untouched, `\begin{aligned}` survives as the first line of
 * the body rather than as a discarded fence annotation, and the result is the
 * canonical form docToMarkdown already emits, so it round-trips exactly.
 *
 * A STATE MACHINE, not two regexes, because "content then `$$`" must only be
 * read as a closer while a block is actually open. Otherwise an ordinary
 * sentence ending in `$$` — prose about currency, a regex, a shell variable —
 * would be split in half by a rule that has no business firing outside maths.
 */
function normaliseDisplayMath(text) {
    const lines = text.split('\n');
    const out = [];
    let fence;      // { char, len } while inside a code fence
    let mathRun;    // the opener's `$` run while inside display maths

    for (const line of lines) {
        // A fenced block's body is code, and `$$` inside it is code too.
        const fenceMark = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (fenceMark && fenceMark[1][0] === fence.char && fenceMark[1].length >= fence.len &&
                /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)) { fence = undefined; }
            out.push(line);
            continue;
        }
        if (fenceMark && !mathRun) { fence = { char: fenceMark[1][0], len: fenceMark[1].length }; out.push(line); continue; }

        if (mathRun) {
            // Already canonical: a delimiter line on its own closes the block.
            if (new RegExp('^[ \\t]{0,3}\\${' + mathRun + ',}[ \\t]*$').test(line)) { mathRun = undefined; out.push(line); continue; }
            /*
             * A BLANK LINE ENDS DISPLAY MATHS, and this is the rule that stops
             * one mistyped delimiter eating a chapter.
             *
             * There is no such thing as a display equation containing a blank
             * line: TeX itself treats one as a paragraph break and errors, and
             * every Markdown flavour ends the construct there. remark-math does
             * NOT — it scans on to the next delimiter line, so a closer with so
             * much as a stray character after it (`\\right)$$_`, which a previous
             * pass of this very file's marker balancing left behind) silently
             * merged four hundred lines of prose, headings and tables into one
             * latex string.
             *
             * Closing at the blank line keeps the damage inside the equation
             * that is actually malformed: KaTeX fails on it, math-view.js shows
             * the source with the error underneath, and every block after it is
             * still a block. The alternative — trusting the next delimiter — is
             * what produced a 70 KB equation.
             */
            if (!line.trim()) {
                out.push('$'.repeat(mathRun), line);
                mathRun = undefined;
                continue;
            }
            // `\end{aligned}$$` — content and the closer on one line.
            const glued = /^([ \t]{0,3}.*?\S)(\$\$+)[ \t]*$/.exec(line);
            if (glued && !glued[1].includes('$$') && glued[2].length >= mathRun) {
                out.push(glued[1], glued[2]);
                mathRun = undefined;
                continue;
            }
            out.push(line);
            continue;
        }

        const opener = /^([ \t]{0,3})(\$\$+)(.*)$/.exec(line);
        if (!opener) { out.push(line); continue; }
        const indent = opener[1];
        const run = opener[2];
        const rest = opener[3].replace(/[ \t]+$/, '');

        // `$$` alone: canonical, and it opens a block.
        if (!rest) { out.push(line); mathRun = run.length; continue; }

        // `$$E = mc^2$$` all on one line — a complete display equation.
        const closer = new RegExp('(\\${' + run.length + ',})$').exec(rest);
        if (closer && closer.index > 0) {
            const body = rest.slice(0, closer.index);
            if (!body.includes('$$')) { out.push(indent + run, body, indent + closer[1]); continue; }
        }

        // `$$\begin{aligned}` — an opener carrying what would be dropped as meta.
        if (!rest.includes('$$')) { out.push(indent + run, rest); mathRun = run.length; continue; }

        // Anything else (several `$$` runs on one line) is ambiguous; a repair
        // pass that cannot tell what was meant must leave the text alone.
        out.push(line);
    }
    return out.join('\n');
}

/*
 * A display-maths block still open at end of file, bounded to its own block.
 *
 * The mirror of closeOpenFence, with the opposite placement, and the
 * difference is the point. An unterminated fence at EOF is the interrupted-
 * agent case (DR-3) where the tail genuinely IS code, so its closer belongs
 * at the very end. An unterminated `$$` is almost never that: it is a
 * mistyped delimiter partway through a finished document, and appending the
 * closer at EOF would ratify the swallow instead of undoing it — the 70 KB
 * blob above is exactly what "close it at EOF" produces.
 *
 * So the closer goes at the end of the opener's own block (the next blank
 * line), which is where a display equation ends in every document that has
 * one. Everything after it goes back to being markdown.
 */
function closeOpenMath(text) {
    const lines = text.split('\n');
    let fence;
    let openAt = -1;
    let run = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMark = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (fenceMark && fenceMark[1][0] === fence.char && fenceMark[1].length >= fence.len &&
                /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)) { fence = undefined; }
            continue;
        }
        if (fenceMark && openAt < 0) { fence = { char: fenceMark[1][0], len: fenceMark[1].length }; continue; }

        const delim = /^[ \t]{0,3}(\$\$+)[ \t]*$/.exec(line);
        if (!delim) { continue; }
        if (openAt < 0) { openAt = i; run = delim[1].length; continue; }
        if (delim[1].length >= run) { openAt = -1; run = 0; }
    }

    if (openAt < 0) { return text; }
    let end = lines.length;
    for (let i = openAt + 1; i < lines.length; i++) {
        if (!lines[i].trim()) { end = i; break; }
    }
    lines.splice(end, 0, '$'.repeat(run));
    return lines.join('\n');
}

// --- unterminated inline markers --------------------------------------------

/*
 * Markers checked longest-first so `**` is never seen as two stray `*`s.
 * `$` is single-length only - `$$block$$` is a DIFFERENT construct (a math
 * block, handled by md-parse.js's own dialect table) that this repair does
 * not need to know about; it only ever balances single `$`.
 */
const MARKERS = ['**', '__', '~~', '==', '_', '*', '$'];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isWordChar(ch) { return !!ch && /[\p{L}\p{N}_]/u.test(ch); }

/** `- `, `* `, `+ `, `1. ` at the very start of a (trimmed) line. */
function isListMarkerRun(text, index) {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const before = text.slice(lineStart, index);
    if (!/^[ \t]*$/.test(before)) { return false; }
    const after = text.slice(index);
    return /^(?:[-*+]|\d+[.)])[ \t]/.test(after);
}

/**
 * True when `marker` at `index` is flanked by word characters on both
 * sides - `user_name`, `234*123` - which this repair leaves alone entirely,
 * matching CommonMark's own rule that an intraword delimiter is not a
 * legitimate emphasis boundary in the first place.
 */
function isIntraword(text, index, marker) {
    const before = text[index - 1];
    const after = text[index + marker.length];
    return isWordChar(before) && isWordChar(after);
}

/**
 * True when the character at `index` is itself backslash-escaped (an odd
 * number of backslashes immediately precede it) — an escaped marker can
 * never be an active delimiter, by definition, regardless of what flanks
 * it. This has to be checked SEPARATELY from isIntraword rather than folded
 * into it: md-serialize.js's own escaping can put a backslash in front of
 * an otherwise-intraword marker (`\int_0^\infty` serialises its underscore
 * as `\_0`), and at that point the character immediately before the marker
 * is the backslash itself, not the word character on the other side of it —
 * checking intraword flanking there would see "not a word character" and
 * wrongly treat the escaped marker as a fresh candidate. A repaired
 * document reaching balanceMarker a SECOND time (idempotence — assertion 2)
 * is exactly how this surfaces: the first pass's output is the second
 * pass's input, and the first pass's stringifier may have added escaping
 * the second pass's scanner then has to see through.
 */
function isEscaped(text, index) {
    let count = 0;
    let i = index - 1;
    while (i >= 0 && text[i] === '\\') { count++; i--; }
    return count % 2 === 1;
}

/*
 * Every legitimate candidate occurrence of `marker` is collected first, and
 * only then paired off open/close in the order found. That order matters: a
 * candidate is one that is not intraword, not a list bullet at this
 * position, and, for the single-character markers, not actually one
 * character of a LONGER run of the same character (so `***` is not misread
 * as three separate candidates).
 *
 * Filter-then-pair is not the obvious approach; the obvious one is "find the
 * next occurrence and treat the span up to the following one as a matched
 * pair", and it is wrong: that greedy approach has no way to know the FIRST
 * `*` it meets is intraword (`234*123`) until after it has already paired
 * it with a real one much later, swallowing everything genuine in between
 * as if it were inside emphasis. An earlier version of this function did
 * exactly that, and mis-fired on `234*123 ... *emphasis*`, reading the
 * intraword `*` as an opener and the real closing `*` as unmatched.
 */
function candidatePositions(text, marker) {
    const re = new RegExp(escapeRe(marker), 'g');
    const positions = [];
    let match;
    while ((match = re.exec(text))) {
        const idx = match.index;
        if (isEscaped(text, idx)) { continue; }
        if (marker.length === 1) {
            if (isIntraword(text, idx, marker)) { continue; }
            if (text[idx - 1] === marker || text[idx + 1] === marker) { continue; }
        }
        if (isListMarkerRun(text, idx)) { continue; }
        positions.push(idx);
    }
    return positions;
}

/*
 * A line that begins a DIFFERENT block from the one before it.
 *
 * Used to find where an unterminated marker's block ends. A masked
 * placeholder counts: by the time this runs, every complete fence and math
 * span is one, and emphasis cannot reach across either.
 */
const STARTS_BLOCK = new RegExp(
    '^(?:' +
    '[ \\t]{0,3}(?:[-*+]|\\d+[.)])[ \\t]' +      // a list item
    '|[ \\t]{0,3}#{1,6}[ \\t]' +                  // an ATX heading
    '|[ \\t]{0,3}(?:`{3,}|~{3,})' +                // a fence
    '|[ \\t]{0,3}>' +                              // a blockquote
    '|[ \\t]{0,3}(?:-{3,}|\\*{3,}|_{3,})[ \\t]*$' +  // a thematic break
    '|[ \\t]{0,3}\\|' +                            // a table row
    '|' + MASK_OPEN +                              // a masked fence or math span
    ')'
);

/*
 * Where the block containing `index` ends — the offset just past its last
 * non-whitespace character.
 *
 * Walks forward line by line from the opener, stopping before the first line
 * that is blank or begins a different block. Emphasis in Markdown can span a
 * soft line break inside one paragraph but nothing beyond it, so this is the
 * furthest a closing marker could legally reach.
 */
function blockEnd(text, index) {
    const trimEnd = at => { let e = at; while (e > 0 && /\s/.test(text[e - 1])) { e--; } return e; };
    let cursor = text.indexOf('\n', index);
    if (cursor === -1) { return trimEnd(text.length); }
    let end = cursor;
    while (cursor !== -1) {
        const next = text.indexOf('\n', cursor + 1);
        const line = text.slice(cursor + 1, next === -1 ? text.length : next);
        if (!line.trim() || STARTS_BLOCK.test(line)) { break; }
        end = next === -1 ? text.length : next;
        if (next === -1) { break; }
        cursor = next;
    }
    return trimEnd(end);
}

/*
 * Does an unterminated `marker` remain in `text`? Closes it if so.
 *
 * AT THE END OF THE OPENER'S OWN BLOCK, and that is a correction. This used
 * to append the closer on a new line at the end of the DOCUMENT, which did
 * not close anything — it destroyed what it was trying to rescue. Measured on
 * `some **unfinished`, the result was `some \*\*unfinished` followed by a
 * stray `\*\*` paragraph: the marker was orphaned in one block and its
 * partner in another, so remark read neither as emphasis, the serialiser
 * escaped both as literal asterisks, and the document gained a line of
 * punctuation it never had. `a $x^2` came back as `a \$x\^2` plus a stray
 * `\$` — worse than leaving the file alone, which is the bar any repair has
 * to clear.
 *
 * The odd count means the LAST candidate is the unmatched opener; earlier
 * ones have already paired off. Its block is where its closer belongs.
 */
function balanceMarker(text, marker) {
    const positions = candidatePositions(text, marker);
    if (positions.length % 2 === 0) { return text; }
    const at = blockEnd(text, positions[positions.length - 1]);
    return text.slice(0, at) + marker + text.slice(at);
}

// --- two-space list indent under an ordered marker --------------------------

/*
 * `1. ` is three columns wide; CommonMark requires a nested item's indent to
 * reach the parent marker's content column, so a 2-space nested line under
 * an ordered item is read as a lazy paragraph continuation, not a sub-list -
 * the nesting is gone by the time anything downstream could recover it. This
 * has to run BEFORE parsing for exactly that reason. Promoting every
 * 2-space list-shaped indent to 4 is safe under a bullet parent too - `- `
 * only needs 2, and 4 still clears that bar - so this does not need to
 * distinguish which kind of list it is nesting under.
 */
function normaliseListIndent(text) {
    const lines = text.split('\n');
    let prevWasListLine = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^( {2})((?:[-*+]|\d+[.)])[ \t]|(?:\[[ xX]\][ \t]))/);
        if (m && prevWasListLine) { lines[i] = '    ' + line.slice(2); }
        prevWasListLine = /^\s*(?:[-*+]|\d+[.)])[ \t]/.test(lines[i]) || (prevWasListLine && /^\s+\S/.test(line));
    }
    return lines.join('\n');
}

/** markdown text -> markdown text, with the text-level repairs applied. */
function repairText(text) {
    let out = String(text).replace(/\r\n/g, '\n');
    out = normaliseListIndent(out);
    /*
     * Fences and the trailing table row are closed FIRST, before masking and
     * marker-balancing run — so that by the time the marker scan happens, a
     * fence that was open at EOF is already complete and gets masked like
     * any other fence. Doing it the other way round left an open fence's
     * body exposed to the marker scan, and — worse — let balanceMarker's
     * "append the missing closer at the end of the text" land the closer
     * AFTER the fence content but before its closing backticks, corrupting
     * the fence. Closing the fence first does not fully solve the general
     * case (an unterminated marker earlier in the SAME paragraph as a
     * trailing fence still gets its closer appended at the very end of the
     * document, not at the point the marker was actually left open — see
     * balanceMarker), but it is the ordering that avoids the fence itself
     * being corrupted. balanceMarker now closes a marker inside its own
     * block rather than at the end of the document, so the case that note
     * used to describe as unsolved is solved; this ordering still matters,
     * because a closed fence is a MASKED fence and masking is what keeps the
     * marker scan out of a fence's body.
     */
    out = closeOpenFence(out);
    out = closeOpenTableRow(out);
    /*
     * Before masking, because maskComplete's own math pattern only recognises
     * the canonical `$$\n…\n$$` shape — normalising first is what lets a
     * `$$\begin{aligned}` block be masked (and so protected from the marker
     * scan) like any other. Before closeOpenMath, because normalising turns
     * `\end{aligned}$$` into a real closer and so removes most of the
     * unterminated blocks closeOpenMath would otherwise have to bound.
     */
    out = normaliseDisplayMath(out);
    out = closeOpenMath(out);
    const { text: masked, restore } = maskComplete(out);
    let m = masked;
    for (const marker of MARKERS) { m = balanceMarker(m, marker); }
    out = restore(m);
    return out;
}

// --- mdast repair -------------------------------------------------------------

/** A table row padded/truncated to the header's cell count. */
function repairTables(tree) {
    const fixOne = table => {
        const width = (table.align || []).length || ((table.children[0] && table.children[0].children.length) || 0);
        for (const tr of table.children) {
            const cells = tr.children;
            while (cells.length < width) { cells.push({ type: 'tableCell', children: [] }); }
            if (cells.length > width) { cells.length = width; }
        }
    };
    const walk = node => {
        if (node.type === 'table') { fixOne(node); }
        (node.children || []).forEach(walk);
    };
    walk(tree);
    return tree;
}

/** repairText, then a real parse, then the mdast-level repairs. */
function repairTree(text) {
    const repaired = repairText(text);
    const tree = PROCESSOR.parse(repaired);
    repairTables(tree);
    return tree;
}

/**
 * markdown text -> markdown text, repaired.
 *
 * TEXT-LEVEL PASSES ONLY, AND THAT IS A CORRECTION. This used to parse the
 * repaired text and re-serialise it, on the reasoning that a caller wanting
 * text back should also get the mdast-level repairs. The parse it used is
 * md-parse's raw PROCESSOR, which carries the remark plugins but NOT the
 * dialect accept-forms — those live in parseMarkdown, as a pre-parse text
 * rewrite and a post-parse restructuring either side of it. So every dialect
 * form went through a processor that had never heard of it and came back
 * flattened:
 *
 *     > [!NOTE]            ->  > \[!NOTE]
 *         An MkDocs body   ->  An MkDocs body      (indent removed)
 *
 * A GFM alert escaped into literal text is no longer an alert, and repair runs
 * BEFORE the parser — so stage N was destroying exactly the input stage C
 * exists to recognise, and a document written in four dialects opened as four
 * paragraphs of punctuation. It also tripped the word-level check, because an
 * escaped bracket is a different word.
 *
 * Canonicalisation is not repair's job. markdownToDoc and docToMarkdown own
 * it and they know the accept-forms; repair's job is to make damaged text
 * parseable, which every pass in repairText does without needing a parser.
 * The mdast-level table padding is still available through repairTree for a
 * caller that wants a tree, and the schema bridge pads ragged rows on the way
 * in regardless, so nothing depends on it happening here.
 */
function repairMarkdown(text) {
    const out = repairText(text);
    return out.endsWith('\n') ? out : out + '\n';
}

module.exports = { repairMarkdown, repairText, repairTree, normaliseDisplayMath, closeOpenMath, CALLOUT_TONES };
