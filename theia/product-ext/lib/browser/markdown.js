/*
 * Markdown <-> editor conversion — the single import point.
 *
 * Previously a hand-written line/regex converter (markdown -> HTML string ->
 * generateJSON), kept explicit and auditable because the round trip is the
 * highest-risk part of a WYSIWYG Markdown product. This is now a real
 * remark/mdast pipeline instead, split across four modules that each own one
 * stage:
 *
 *   md-parse.js     stage C, the permissive parse — text -> mdast, with
 *                   every dialect accept-form folded in.
 *   md-schema.js    the mdast <-> ProseMirror bridge — ONE table, and the
 *                   X-01 fallback that makes it total in both directions.
 *   md-serialize.js stage E, the pinned emit — mdast -> text, every
 *                   cosmetic choice fixed so the same document produces the
 *                   same file on every save.
 *   md-repair.js    stage N, drift repair — text -> text, import and paste
 *                   only, never on save (D-05).
 *
 * This file is what stays the same: the path (`markdown.js`), so
 * markdown-editor.js's `require('./markdown')` is still the one integration
 * point; the two rules the old converter existed to enforce (frontmatter
 * held verbatim, `comment` marks never reaching the file — see
 * splitFrontmatter and md-schema.js's wrappableMarks respectively); and
 * `contentWords`/`unsupportedConstructs`, kept for the fidelity banner.
 */

const { parseMarkdown } = require('./md-parse');
const { blockFromMdastList } = require('./md-schema');
const { docToMarkdown } = require('./md-serialize');
const { repairMarkdown } = require('./md-repair');

/**
 * markdown text -> {doc, warnings}. Never throws: md-parse.js's own
 * parseMarkdown never throws (a processor failure falls back to one
 * rawBlock holding the whole body — see its header), and every mdast node
 * blockFromMdastList meets either has a schema row or becomes
 * rawBlock/rawInline (md-schema.js's X-01 fallback) — there is no input this
 * function can be handed that does not produce SOME doc.
 */
function markdownToDoc(md) {
    const { tree, source, warnings } = parseMarkdown(md);
    const ctx = {
        source,
        warn(node, message) { warnings.push({ kind: 'unmodelled', line: (node && node.position && node.position.start.line) || 0, message }); }
    };
    const content = blockFromMdastList(tree.children, ctx);
    return { doc: { type: 'doc', content }, warnings };
}

// --- frontmatter --------------------------------------------------------------

/*
 * Unchanged, byte-verbatim, from the previous converter — the reasoning that
 * justified it has not changed either: a leading `---` fence is otherwise
 * read as a horizontal rule (now: as part of an mdast `thematicBreak` OR,
 * worse, as the delimiter row of what remark-frontmatter tries to read as a
 * YAML block), which would silently destroy the block if this ever parsed
 * frontmatter instead of holding it aside.
 */
function splitFrontmatter(text) {
    const src = String(text).replace(/\r\n/g, '\n');
    if (!src.startsWith('---\n')) { return { frontmatter: '', body: src }; }
    const end = src.indexOf('\n---', 3);
    if (end === -1) { return { frontmatter: '', body: src }; }
    const afterFence = src.indexOf('\n', end + 1);
    const cut = afterFence === -1 ? src.length : afterFence + 1;
    return { frontmatter: src.slice(0, cut), body: src.slice(cut) };
}

function joinFrontmatter(frontmatter, body) {
    if (!frontmatter) { return body; }
    return frontmatter.replace(/\n*$/, '\n') + '\n' + body.replace(/^\n+/, '');
}

// --- fidelity -------------------------------------------------------------

/*
 * D-04 says unknown syntax is preserved verbatim, never dropped — and now
 * that md-schema.js's X-01 fallback makes that literally true for every
 * mdast node type, this blocklist shrinks to the two constructs that are
 * NOT safe to just preserve and hand back to the editor:
 *
 *   - an unbalanced fence: the document is, right now, mid-way through a
 *     fenced block by the letter of CommonMark's grammar. Parsing it
 *     anyway is what a permissive parser does (everything after becomes
 *     "inside" the fence), which is a legitimate reading but not the one
 *     that keeps the REST of the document editable — so this stays a hard
 *     stop rather than something rawBlock quietly absorbs.
 *   - HTML carrying `<script>`: not a fidelity problem — rawBlock would
 *     hold it losslessly — a SAFETY one. This editor has no sandbox around
 *     rendered HTML the way figure-view.js's iframe does for figures; a
 *     `<script>` tag is not something to open for editing at all.
 */
/*
 * WHY FENCE BALANCE IS A LINE SCAN AND NOT A REGEX.
 *
 * It was a regex, and the regex reported EVERY fenced block as unterminated:
 * `/^(fence)[^\n]*\n(?:(?!^fence$)[\s\S])*$/m` looks right, but under the `m`
 * flag `$` matches at the end of any line — so after consuming a single line of
 * fence body the match succeeded and the document was condemned. Since this
 * predicate is the read-only gate, that meant every document containing a code
 * block opened read-only: the exact failure this engine exists to remove.
 *
 * Nor is it fixable by anchoring to absolute end of input, because a CLOSING
 * fence is textually indistinguishable from an OPENING one. Anchored, the
 * pattern simply fails at the first fence and then matches at the last one,
 * which is the same false positive arriving by another route. Fence balance is
 * a state machine over lines, so it is written as one.
 *
 * The closing rule is CommonMark's: same fence character, at least as long as
 * the opener, and nothing but whitespace after it. An info string is legal on
 * the opener and illegal on the closer, which is what stops "```js" halfway
 * down a document from being read as a close.
 */
function unterminatedFence(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    let open;
    for (const line of lines) {
        const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
        if (!fence) { continue; }
        const marker = fence[1];
        if (!open) { open = marker; continue; }
        const closes = marker[0] === open[0] &&
            marker.length >= open.length &&
            /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line);
        if (closes) { open = undefined; }
    }
    return open !== undefined;
}

const UNSUPPORTED_SHORTLIST = [
    [unterminatedFence, 'an unterminated fenced code block'],
    [/<script[\s>]/i, 'HTML containing a <script> tag']
];

/*
 * Removes everything that is not prose: fenced blocks, inline code, and maths.
 *
 * MATHS IS STRIPPED FOR THE SAME REASON CODE IS, and leaving it in was a bug
 * with real consequences. contentWords compares the words of the document the
 * editor opened against the words it would save, and a ```math fence is
 * canonically emitted as a `$$` block (see md-parse.js's accept table). Strip
 * one form and not the other and the same equation counts as invisible on one
 * side and as prose on the other — so `\sum_{i=1}^{n} x_i` looked like six
 * words appearing out of nowhere, contentWords reported "text would be lost or
 * reordered", and every GitHub-flavoured document containing a maths fence
 * opened read-only. Measured on a file using four dialects at once.
 *
 * The cost is that this cannot see loss INSIDE an equation or a code sample.
 * That is the right trade: the structural round-trip check beside it compares
 * whole documents including their code and maths, so nothing here is the only
 * thing standing between a lossy save and the file. What this check uniquely
 * catches is prose being dropped or reordered, and prose is what it now looks
 * at. A lone `$` in running text ("costs $5") can swallow a few words between
 * it and the next `$`, which is a symmetric loss of sensitivity on both sides
 * of the comparison rather than a false alarm.
 */
function stripCode(md) {
    return String(md)
        .replace(/```[\s\S]*?```/g, '\n')
        .replace(/~~~[\s\S]*?~~~/g, '\n')
        .replace(/`[^`\n]*`/g, ' ')
        // Maths in EVERY notation the parser accepts, not just the one it
        // emits. Strip `$x$` alone and `\(x\)` counts as prose before the
        // round trip and as maths after it, which is the same asymmetry as
        // stripping code but not maths — measured on `\(a^2 + b^2 = c^2\)`,
        // which contributed the six words "a 2 b 2 c 2" to one side only.
        .replace(/^\$\$\n[\s\S]*?\n\$\$[ \t]*$/gm, '\n')
        .replace(/\$[^$\n]+\$/g, ' ')
        .replace(/\\\[[\s\S]*?\\\]/g, ' ')
        .replace(/\\\([\s\S]*?\\\)/g, ' ');
}

function unsupportedConstructs(md) {
    const src = String(md);
    const found = [];
    // The fence scan runs over the UNSTRIPPED text: stripCode only removes
    // CLOSED fences, so an open one survives stripping and is exactly what this
    // is looking for. The script check runs over the stripped text, so a
    // <script> tag quoted inside a code sample is not read as a live one.
    if (UNSUPPORTED_SHORTLIST[0][0](src)) { found.push(UNSUPPORTED_SHORTLIST[0][1]); }
    if (UNSUPPORTED_SHORTLIST[1][0].test(stripCode(src))) { found.push(UNSUPPORTED_SHORTLIST[1][1]); }
    return found;
}

/*
 * Word sequence, ignoring all markup — used to prove no content was dropped.
 *
 * The two sides of the comparison this feeds sit either side of
 * canonicalisation, so it has to be blind to everything canonicalisation is
 * ALLOWED to change. Code and maths are stripped above. Ordered-list markers
 * are stripped here, and that is not a detail: `incrementListMarker: false` is
 * a pinned serialiser option (see md-serialize.js — every marker emits as `1.`
 * so a list's diff does not renumber when an item is inserted), and a check
 * that reads marker digits as content sees "1 numbered one 2 numbered two"
 * become "1 numbered one 1 numbered two" and reports that the document lost
 * text. It locked every file containing a numbered list.
 *
 * The rule to apply when adding to this: if the serialiser may legitimately
 * rewrite it, this function must not see it.
 */
function contentWords(md) {
    return stripCode(md)
        .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, ' ')
        /*
         * Footnote LABELS, in both the marker and the definition. A Pandoc
         * inline footnote `^[the note text]` is normalised to a reference plus
         * a definition, and the label is SYNTHESISED from the text by
         * slugifying it — so the note's own words appear once before the round
         * trip and twice after it, once as prose and once as an identifier.
         * A generated identifier is not content.
         */
        .replace(/\[\^[^\]\n]*\]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

module.exports = {
    markdownToDoc, docToMarkdown, repairMarkdown,
    splitFrontmatter, joinFrontmatter,
    unsupportedConstructs, contentWords
};
