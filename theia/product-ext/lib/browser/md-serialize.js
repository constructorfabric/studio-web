/*
 * Pinned emit — ProseMirror document JSON -> markdown text.
 *
 * Two layers: md-schema.js turns PM JSON into an mdast tree (that part is
 * D-01 — mdast is canonical, so PM is never stringified directly), and this
 * file turns that tree into text with remark-stringify, every cosmetic
 * option nailed down so the SAME document produces the SAME text on every
 * save — determinism is assertion 4 of the corpus test, and the only way to
 * guarantee it against a library with this many independently-defaulted
 * knobs is to set every one of them explicitly rather than trust the
 * defaults not to change under a version bump.
 */

const engine = require('./vendor/markdown-engine');
const {
    unified, remarkParse, remarkStringify, remarkGfm, remarkMath, remarkDirective, remarkFrontmatter,
    subscript, superscript, insert, highlight
} = engine;
const { blockToMdastList } = require('./md-schema');

/*
 * Custom mdast node types produced by md-schema.js's toMdast arms need
 * handlers of their own — remark-stringify only ships handlers for the
 * standard mdast node set.
 *
 *   studioCallout -> `:::tone` … `:::`      (the ONE emit form; see
 *                                            CONTRACT.md — accept forms are
 *                                            plural, emit form is singular)
 *   studioToggle  -> `<details><summary>…`  (unchanged from the previous
 *                                            converter's emit shape, so a
 *                                            document already on disk does
 *                                            not reformat just because the
 *                                            engine changed underneath it)
 *
 * Both use `state.containerFlow`, mdast-util-to-markdown's own primitive for
 * "stringify this node's block children, blank-line-joined, at the current
 * indent" — the same primitive blockquote and list item handlers use
 * internally, rather than a hand-rolled join that would drift from how
 * every OTHER block container is spaced.
 */
function calloutHandler(node, _parent, state, info) {
    const exit = state.enter('studioCallout');
    const value = ':::' + node.tone + '\n' + state.containerFlow(node, info) + '\n:::';
    exit();
    return value;
}

function toggleHandler(node, _parent, state, info) {
    const exit = state.enter('studioToggle');
    const body = state.containerFlow(node, info);
    const value = '<details>\n<summary>' + node.summary + '</summary>\n\n' + body + '\n</details>';
    exit();
    return value;
}

const CUSTOM_NODE_HANDLERS = {
    handlers: { studioCallout: calloutHandler, studioToggle: toggleHandler },
    unsafe: []
};

/*
 * Every option below is pinned, not left to remark-stringify's default,
 * because "whatever the library currently defaults to" is not a stable
 * value across a dependency bump — it is exactly the kind of drift
 * determinism (assertion 4) exists to catch, and the fix has to be pinning
 * the value, not hoping the default never moves.
 *
 *   bullet: '-'              a bulleted list always uses `-`, never `*` or
 *                             `+` — one spelling in, one spelling out.
 *   emphasis: '*'             `*x*` over `_x_` — `_` is reserved by this
 *                             product's dialect for intraword text
 *                             (`user_name`) staying literal; using it for
 *                             emphasis too would make the accept-form
 *                             parser's job (never reading `_` inside a word
 *                             as a mark) and the emit form disagree about
 *                             what `_` means.
 *   strong: '*'                mdast-util-to-markdown's `strong` option is
 *                             the MARKER CHARACTER, doubled automatically
 *                             (`'*'` -> `**x**`), not the doubled string
 *                             itself — easy to misread as the wrong value at
 *                             a glance, which is why this note exists.
 *                             `__x__` is a second accepted INPUT form (GFM),
 *                             never emitted.
 *   fence: '`'                backtick fences over `~~~` — backtick is what
 *                             every accept-form above already normalises
 *                             fenced code and math to (```math, ```mermaid),
 *                             so the emitted file matches what was parsed.
 *   fences: true               ALWAYS fence code, never indent it. An
 *                             indented-code accept-form is parsed (see
 *                             md-parse.js's dialect table) but never
 *                             reproduced — a fence carries a language, an
 *                             indent cannot, and figure-view.js/
 *                             mermaid-view.js both key off that language.
 *   setext: false              headings are always ATX (`#`), even though
 *                             `===`/`---` setext headings are an accepted
 *                             input form — one heading spelling out.
 *   incrementListMarker: true  ordered list markers count up: `1.`, `2.`,
 *                             `3.`. REVERSED from `false`, and measured. The
 *                             argument for `false` was diff stability —
 *                             inserting an item mid-list reflows every ordinal
 *                             after it. True, but it trades a hunk that only
 *                             appears when a list actually changes for one
 *                             that appears in EVERY document exactly once, on
 *                             first save, forever: 48 of the 85 lines a real
 *                             2,000-line paper reformatted were `2.` becoming
 *                             `1.`. Sequential numbering is also what a person
 *                             reads in Raw mode and what essentially every
 *                             document already on disk contains, so `false`
 *                             was optimising the rare case at the cost of the
 *                             common one.
 *   listItemIndent: 'one'      exactly one space after the marker, not
 *                             enough to align with a multi-digit ordinal —
 *                             keeps `- ` / `1. ` a fixed width regardless of
 *                             list length, for the same diff-stability
 *                             reason as incrementListMarker.
 *   rule: '-'                  `---`, matching frontmatter's own fence
 *                             character so a document is not visually
 *                             fighting itself between the two.
 *   ruleSpaces: false           `---` with no interior spaces (`- - -`
 *                             would round-trip identically in meaning but
 *                             is a second spelling this module refuses to
 *                             emit).
 *   tightDefinitions: true      no blank line between an unindented
 *                             definition-list-shaped block and what follows
 *                             it — not reachable from this schema today
 *                             (no definition-list node), pinned anyway so a
 *                             future row does not inherit a library default.
 *   resourceLink: true          `[x](url)`, never `[x][ref]` — D-02/
 *                             CONTRACT.md: reference-style links are an
 *                             accept form on the old converter's own
 *                             blocklist and never an emit form here either.
 *   quote: '"'                  the character used to quote a link TITLE
 *                             (`[x](url "title")`), for the rare case one
 *                             is present.
 *   emphasis/strongMarkers,
 *   closeAtx: false             no trailing `#`s on an ATX heading.
 */
const STRINGIFY_OPTIONS = {
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fence: '`',
    fences: true,
    setext: false,
    incrementListMarker: true,
    listItemIndent: 'one',
    rule: '-',
    ruleSpaces: false,
    ruleRepetition: 3,
    tightDefinitions: true,
    resourceLink: true,
    quote: '"',
    closeAtx: false,
};

function buildSerializeProcessor() {
    let p = unified()
        .use(remarkParse)
        /*
             * tablePipeAlign OFF, and it is a remark-gfm option rather than a
             * remark-stringify one — the table handler lives in
             * mdast-util-gfm-table, so pinning it beside `bullet` and
             * `emphasis` silently does nothing.
             *
             * Same reason as incrementListMarker: diff stability. Aligned
             * pipes are prettier in isolation and awful in review, because
             * widening one cell rewrites every row — a one-word edit arrives
             * as a whole-table diff. The old converter emitted `| a | b |`
             * unpadded and that is the form to keep.
             */
            .use(remarkGfm, { singleTilde: false, tablePipeAlign: false, tableCellPadding: true })
        .use(remarkMath)
        .use(remarkDirective)
        .use(remarkFrontmatter, [{ type: 'yaml', marker: '-' }])
        .use(remarkStringify, STRINGIFY_OPTIONS)
        .use(function studioCustomNodes() {
            const data = this.data();
            const list = data.toMarkdownExtensions ? data.toMarkdownExtensions : (data.toMarkdownExtensions = []);
            list.push(CUSTOM_NODE_HANDLERS);
        });
    for (const ext of [subscript, superscript, insert, highlight]) {
        p = p.use(function attach() {
            const data = this.data();
            const add = (field, value) => { const l = data[field] ? data[field] : (data[field] = []); l.push(value); };
            add('toMarkdownExtensions', ext.toMarkdown);
        });
    }
    return p;
}

const PROCESSOR = buildSerializeProcessor();

// --- PM doc -> mdast root ----------------------------------------------------

function makeCtx(warnings) {
    return {
        source: '',
        warn(node, message) { warnings.push({ kind: 'serialize', line: 0, message: message + (node && node.type ? ' (' + node.type + ')' : '') }); }
    };
}

/*
 * TRIM TRAILING WHITESPACE FROM THE LAST TEXT LEAF OF A FINISHED INLINE
 * CONTAINER, before remark-stringify ever sees the tree.
 *
 * A trailing space at the end of a paragraph, heading or table cell carries
 * no meaning anyone intends. It also never survives an ordinary parse:
 * CommonMark 4.8 has the paragraph's own raw content formed by "removing
 * initial and final whitespace", so a document that came from parsing a file
 * cannot have one on its last text node — this walk is a no-op on every
 * corpus fixture. What DOES produce one is a user typing a space at the very
 * end of an on-screen block in Suggesting mode: real content in the live PM
 * document that is never fed back through a parser to be trimmed by it.
 * mdast-util-to-markdown, handed a text value ending in a space, has to
 * ESCAPE it (`&#x20;`) rather than emit it bare, because a bare trailing
 * space before a line ending is invisible on screen and — under the "two
 * trailing spaces = hard break" convention this engine does not use but the
 * file format still defines — ambiguous. Nobody typing a space at the end of
 * a sentence means to write an HTML entity into their file, so the fix is to
 * never hand the serializer a text value that ends this way.
 *
 * Done HERE, on the mdast tree, and not as a regex over the finished
 * markdown text: a post-pass over the string cannot tell a paragraph's
 * trailing space from whitespace that is CONTENT inside a fenced code block
 * or a math block — exactly the constructs `unescapeIntrawordUnderscore`
 * above has to mask out before it can touch anything, for the same reason.
 * Trimming by NODE TYPE instead sidesteps that entirely: `code` and `math`
 * are mdast leaves with a `value` string, not `paragraph`/`heading`/
 * `tableCell` nodes with phrasing `children`, so they are never in
 * TRIMMABLE_CONTAINERS and this walk cannot reach inside one no matter how
 * it is nested (a fenced block inside a blockquote, say).
 */
const TRIMMABLE_CONTAINERS = new Set(['paragraph', 'heading', 'tableCell']);
// Mark wrappers (`**bold**`, a link, …) nest one level of `children` around
// the actual leaf. The trailing space that matters is on the rightmost LEAF
// of the container, so a container whose last child is a wrapped run
// (`...ends in *bold*`) has to be followed one level in, and recursively —
// nothing stops `strong > emphasis > text`.
const MARK_WRAPPERS = new Set(['emphasis', 'strong', 'delete', 'highlight', 'link']);

function trimTrailingSpace(container) {
    const kids = container.children;
    if (!kids || !kids.length) { return; }
    const last = kids[kids.length - 1];
    if (last.type === 'text') {
        last.value = (last.value || '').replace(/[ \t]+$/, '');
        // A text node the trim reduced to nothing (the block was nothing but
        // the trailing space, or a mark-wrapped run trimmed to empty) has no
        // work left to do and would only leave a zero-width no-op behind.
        if (last.value === '') { kids.pop(); }
    } else if (MARK_WRAPPERS.has(last.type)) {
        trimTrailingSpace(last);
    }
    // Any other trailing leaf — image, break, inlineCode, html, footnote
    // reference — has no text value to escape, so there is nothing to trim;
    // a hard `break` in particular is an intentional line break, not an
    // accidental trailing space, and must be left exactly as authored.
}

function trimTrailingWhitespace(node) {
    if (!node || typeof node !== 'object') { return; }
    if (TRIMMABLE_CONTAINERS.has(node.type)) { trimTrailingSpace(node); }
    for (const child of (node.children || [])) { trimTrailingWhitespace(child); }
}

/**
 * ProseMirror document JSON -> mdast root. Exported mainly for the corpus
 * test, which needs to compare TREES, not just text, for the round-trip and
 * determinism assertions.
 */
function docToMdast(doc, warnings) {
    const ctx = makeCtx(warnings || []);
    const blocks = (doc && doc.content) || [];
    const tree = { type: 'root', children: blockToMdastList(blocks, ctx) };
    trimTrailingWhitespace(tree);
    return tree;
}

/**
 * ProseMirror document JSON -> markdown text. TOTAL: every PM node name
 * this module is handed either has a schema row or arrives already
 * flattened to rawBlock/rawInline by markdownToDoc's own fallback, so
 * blockToMdast (md-schema.js) never has nothing to return — see that
 * module's header. Nothing here can therefore fail to produce SOME text.
 */
/*
 * INTRAWORD `_` DOES NOT NEED ESCAPING, AND ESCAPING IT CHURNS REAL FILES.
 *
 * mdast-util-to-markdown escapes every `_` it emits in phrasing, with no
 * regard for what is either side of it — the rule has no `before`/`after`
 * constraint and there is no option that adds one (an extension's `unsafe`
 * entries are appended to the defaults, never replace them). So a document
 * mentioning `snake_case`, an environment variable, or — the case that forced
 * this — mathematical subscripts written as prose, comes back with a
 * backslash before every underscore:
 *
 *     - (Q_0) — quality of the current result
 *     - (Q\_0) — quality of the current result
 *
 * Both render identically, so nothing is lost; what IS lost is the diff. A
 * 2,000-line research paper with subscripts on eighty lines reformats eighty
 * lines the first time it is opened and saved, which buries the one line the
 * author actually changed.
 *
 * The unescape is provably safe for `_` and ONLY for `_`. CommonMark 6.2:
 * emphasis with `_` additionally requires that a left-flanking delimiter run
 * is not preceded by an alphanumeric, and a right-flanking run is not
 * followed by one. An underscore with a word character on BOTH sides is
 * therefore neither an opener nor a closer, in any context, so it is always
 * literal and the backslash is always redundant. `*` has no such rule — it
 * does open emphasis intraword — which is why this touches one character and
 * not the general escaping.
 *
 * Code spans, fences and maths are masked first: their content is emitted
 * verbatim, so a literal `\_` inside one is the author's own backslash and
 * must survive.
 */
const MASK = '';

function unescapeIntrawordUnderscore(text) {
    const store = [];
    const put = m => { store.push(m); return MASK + (store.length - 1) + MASK; };
    let masked = text
        // Fenced blocks, complete ones only.
        .replace(/^([ \t]{0,3}(`{3,}|~{3,}))[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*$/gm, put)
        // Inline code spans, longest run of backticks first.
        .replace(/(`+)(?:[^`]|(?!\1)`)*?\1/g, put)
        // Display and inline maths.
        .replace(/^\$\$\n[\s\S]*?\n\$\$[ \t]*$/gm, put)
        .replace(/\$[^$\n]+\$/g, put);

    /*
     * `(^|[^\\])` is what keeps a real escaped backslash out of this: the
     * serializer writes an author's literal backslash-underscore as `\\_`,
     * and matching the `\_` at its tail would turn it into `\_`, changing the
     * document. Requiring the character before the backslash to not itself be
     * a backslash leaves that case alone.
     */
    masked = masked.replace(/(^|[^\\])\\_(?=[0-9A-Za-z])/g, (all, before, offset, whole) => {
        const prev = whole[offset + before.length - 1];
        return /[0-9A-Za-z]/.test(prev || '') ? before + '_' : all;
    });

    const re = new RegExp(MASK + '(\\d+)' + MASK, 'g');
    return masked.replace(re, (_, i) => store[Number(i)]);
}

function docToMarkdown(doc) {
    const warnings = [];
    const tree = docToMdast(doc, warnings);
    let text = unescapeIntrawordUnderscore(PROCESSOR.stringify(tree));
    if (!text.endsWith('\n')) { text += '\n'; }
    return text;
}

module.exports = {
    docToMarkdown, docToMdast, buildSerializeProcessor, STRINGIFY_OPTIONS, PROCESSOR,
    unescapeIntrawordUnderscore
};
