/*
 * Stage C — the permissive parse.
 *
 * markdown text -> mdast, via the vendored unified/remark stack (see
 * ./vendor/markdown-engine.js and build/markdown-engine.mjs for why that is
 * a checked-in bundle rather than a plain `require`), with every tolerant
 * option turned on and then the dialect's accept-forms folded in on top —
 * every spelling of the same construct an author or another tool might have
 * written, normalised to the ONE mdast shape md-schema.js knows about.
 *
 * The accept-forms are LOOKUP TABLES (CALLOUT accept-forms below, MATH
 * accept-forms below), not scattered `if` branches, because the failure mode
 * of an `if`-branch dialect table is a form that half-works: recognised by
 * the text rewrite but not by the tree normaliser, or vice versa. A table
 * that both stages read is one that cannot drift out of sync with itself.
 *
 * Two techniques do the recognising, chosen per form by what is genuinely
 * simpler for that form (see each function's own header for why):
 *   - a pre-parse TEXT REWRITE, for forms with no token-level ambiguity
 *     (`\(x\)`, `!!! note`, `:::{note}`, `>>>`, `^[inline]`) — turning them
 *     into the form remark already understands, before remark ever runs;
 *   - a post-parse MDAST NORMALISATION, for forms that are only safely
 *     recognisable once a real parser has already told blockquote from
 *     paragraph from code fence (`> [!NOTE]`, a ```math fence, a `<details>`
 *     block, a containerDirective whose name is a callout tone).
 */

const engine = require('./vendor/markdown-engine');
const { CALLOUT_TONES } = require('./md-schema');

const {
    unified, remarkParse, remarkStringify, remarkGfm, remarkMath, remarkDirective, remarkFrontmatter,
    visit, subscript, superscript, insert, highlight
} = engine;

/*
 * Wires a {micromark, fromMarkdown, toMarkdown} extension trio (see
 * build/inline-marks.mjs) onto a unified() processor. remark plugins usually
 * do this from inside a `function attacher() { … }` passed to `.use()`;
 * written out here because these four have no attacher of their own to call
 * — they are extension objects, not remark plugins.
 */
function attachExtension(processor, ext) {
    return processor.use(function attach() {
        const data = this.data();
        const add = (field, value) => {
            const list = data[field] ? data[field] : (data[field] = []);
            list.push(value);
        };
        add('micromarkExtensions', typeof ext.micromark === 'function' ? ext.micromark() : ext.micromark);
        add('fromMarkdownExtensions', ext.fromMarkdown);
        add('toMarkdownExtensions', ext.toMarkdown);
    });
}

/*
 * ONE processor, built once and reused: `.use()` chains are configuration,
 * not per-call state, and rebuilding this on every keystroke of every open
 * document would repeat the same work for no benefit.
 *
 * `singleTilde: false` on remark-gfm is what makes `~x~` available to the
 * subscript extension below instead of being claimed as strikethrough —
 * GitHub's own dialect accepts a single tilde as strikethrough too, but this
 * product's dialect table (CONTRACT.md) fixes `~x~` as subscript and `~~x~~`
 * as strikethrough, so the two cannot both claim one tilde.
 */
function buildParseProcessor() {
    let p = unified()
        .use(remarkParse)
        .use(remarkGfm, { singleTilde: false })
        .use(remarkMath)
        .use(remarkDirective)
        .use(remarkFrontmatter, [{ type: 'yaml', marker: '-' }])
        .use(remarkStringify);
    p = attachExtension(p, subscript);
    p = attachExtension(p, superscript);
    p = attachExtension(p, insert);
    p = attachExtension(p, highlight);
    return p;
}

const PROCESSOR = buildParseProcessor();

// --- pre-parse text rewrites (dialect accept-forms with no plugin) ---------

/*
 * Protects fenced code blocks and inline code spans from the text rewrites
 * below, so `` `~x~` `` in a document ABOUT this dialect table is never
 * itself rewritten. Deliberately approximate — real fence/code-span matching
 * has more edge cases (indentation, backtick-run length) than this regex —
 * because the failure mode of missing one is "a rewrite fires inside an
 * example of the syntax it rewrites", which is a quality issue, not a
 * correctness one: the result still parses and still round-trips.
 */
const MASK_OPEN = '\uE000';
const MASK_CLOSE = '\uE001';
const GRID_MARK_OPEN = '\uE002';
const GRID_MARK_CLOSE = '\uE003';

function maskProtectedSpans(text) {
    const store = [];
    const put = match => { store.push(match); return MASK_OPEN + (store.length - 1) + MASK_CLOSE; };
    let out = text.replace(/^([ \t]{0,3}(`{3,}|~{3,}))[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*$/gm, put);
    out = out.replace(/(`+)(?:[^`]|(?!\1)`)*?\1/g, put);
    const re = new RegExp(MASK_OPEN + '(\\d+)' + MASK_CLOSE, 'g');
    return { text: out, restore: s => s.replace(re, (_, i) => store[Number(i)]) };
}

/*
 * Pandoc grid tables, CONTRACT.md's other fixed decision ("preserved as
 * rawBlock, not converted"). Detected and pulled out before anything else
 * runs -- critically, before remark ever parses the text -- because `+` is
 * also a valid GFM bullet marker: left alone, a grid table's
 * `+------+------+` separator lines parse as a bulleted list whose items
 * are runs of dashes, a well-formed but completely wrong reading that a
 * POST-parse step could not recover from (the grid structure is already
 * gone by then). Pulled into its own placeholder paragraph -- never left
 * inline -- so it cannot be absorbed into a surrounding construct on the
 * way through the real parse.
 */
const GRID_SEPARATOR = /^\+[-=+]+\+[ \t]*$/;
const GRID_ROW = /^\|.*\|[ \t]*$/;

function extractGridTables(text) {
    const lines = text.split('\n');
    const stored = [];
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (GRID_SEPARATOR.test(lines[i])) {
            let j = i + 1;
            let separators = 1;
            while (j < lines.length && (GRID_SEPARATOR.test(lines[j]) || GRID_ROW.test(lines[j]))) {
                if (GRID_SEPARATOR.test(lines[j])) { separators++; }
                j++;
            }
            if (separators >= 2 && j > i + 2) {
                const idx = stored.length;
                stored.push(lines.slice(i, j).join('\n'));
                out.push('', GRID_MARK_OPEN + idx + GRID_MARK_CLOSE, '');
                i = j;
                continue;
            }
        }
        out.push(lines[i]);
        i++;
    }
    return { text: out.join('\n'), tables: stored };
}

/*
 * MyST inline role math, `` {math}`x` ``. Has to run BEFORE maskProtectedSpans
 * — the pattern is itself backtick-delimited, so the generic code-span mask
 * would swallow it first and this rewrite would never see it.
 */
function rewriteMystRoleMath(text) {
    return text.replace(/\{math\}(`+)([^`]*?)\1/g, (_, _t, inner) => '$' + inner + '$');
}

/*
 * LaTeX/Pandoc math delimiters, `\(x\)` and `\[x\]`, to `$x$` / `$$x$$`.
 * Block form first (it can span lines; matching it after the inline form
 * would let a stray `\(` inside a multi-line `\[…\]` confuse the inline
 * regex into stopping early).
 */
function rewriteLatexMathDelimiters(text) {
    let out = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => '$$' + inner.trim() + '$$');
    out = out.replace(/\\\(([^\n]*?)\\\)/g, (_, inner) => '$' + inner + '$');
    return out;
}

/*
 * MyST fenced directives, `:::{tag}` … `:::`. No nesting support — a nested
 * `:::{…}` inside one of these is left untouched and will not be recognised;
 * CommonMark-flavoured fenced divs of this depth are rare enough in practice
 * that the simple non-nesting scan was judged worth the lines it saves.
 * `{math}` becomes a ```math fence (picked up by convertMathFences below);
 * any of the five callout tones becomes `:::tag`, remark-directive's own
 * syntax; anything else is left as-is, which is not a loss — a directive
 * name outside both lists has no row in md-schema.js either, so it reaches
 * containerDirective and then the X-01 fallback, preserved verbatim.
 */
function rewriteMystFencedDirectives(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^(\s*):::\{([A-Za-z][\w-]*)\}[^\n]*$/);
        if (m) {
            const tag = m[2].toLowerCase();
            let j = i + 1;
            while (j < lines.length && !/^\s*:::\s*$/.test(lines[j])) { j++; }
            if (j < lines.length && (tag === 'math' || CALLOUT_TONES.includes(tag))) {
                const marker = tag === 'math' ? '```math' : ':::' + tag;
                const closer = tag === 'math' ? '```' : lines[j];
                out.push(m[1] + marker);
                for (let k = i + 1; k < j; k++) { out.push(lines[k]); }
                out.push(m[1] + closer);
                i = j + 1;
                continue;
            }
        }
        out.push(lines[i]);
        i++;
    }
    return out.join('\n');
}

/*
 * MkDocs admonitions, `!!! tag "optional title"` followed by a 4-space (or
 * deeper) indented body, to `:::tag`. The title, if present, is dropped —
 * callout has no title attribute (CONTRACT.md's node table: `tone` only) —
 * rather than folded into the body, where it would silently become the
 * first line of content on every future re-save.
 */
function rewriteMkdocsAdmonitions(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^(\s*)!!!\s+([A-Za-z]+)(?:\s+"[^"]*")?\s*$/);
        const tag = m && m[2].toLowerCase();
        if (m && CALLOUT_TONES.includes(tag)) {
            const base = m[1].length;
            const body = [];
            let j = i + 1;
            while (j < lines.length) {
                const line = lines[j];
                if (!line.trim()) { body.push(''); j++; continue; }
                const indent = line.match(/^\s*/)[0].length;
                if (indent <= base) { break; }
                body.push(line.slice(Math.min(base + 4, indent)));
                j++;
            }
            while (body.length && !body[body.length - 1].trim()) { body.pop(); }
            out.push(m[1] + ':::' + tag, ...body, m[1] + ':::');
            i = j;
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    return out.join('\n');
}

/** A short, deterministic, collision-proof label for an auto-footnote. */
function slugifyFootnote(text, counter) {
    const words = String(text).trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().split(/\s+/).slice(0, 4).join('-');
    return (words || 'note') + '-' + counter;
}

/*
 * Pandoc inline footnotes, `^[text]`, to GFM reference form: a
 * `[^auto-label]` marker in place, plus an appended `[^auto-label]: text`
 * definition. A balanced-bracket scan rather than a regex, because the
 * inline text commonly contains its own `[…]` (a link, another bracketed
 * aside) and a regex has no way to require the FIRST `]` to be the matching
 * one rather than just the nearest.
 */
function rewritePandocInlineFootnotes(text) {
    let out = '';
    let i = 0;
    let counter = 0;
    const defs = [];
    while (i < text.length) {
        if (text[i] === '^' && text[i + 1] === '[') {
            let depth = 1;
            let j = i + 2;
            while (j < text.length && depth > 0) {
                if (text[j] === '[') { depth++; } else if (text[j] === ']') { depth--; }
                if (depth > 0) { j++; }
            }
            if (depth === 0) {
                const inner = text.slice(i + 2, j);
                counter++;
                const label = slugifyFootnote(inner, counter);
                out += '[^' + label + ']';
                defs.push('[^' + label + ']: ' + inner.replace(/\n+/g, ' ').trim());
                i = j + 1;
                continue;
            }
        }
        out += text[i];
        i++;
    }
    if (defs.length) { out = out.replace(/\s+$/, '') + '\n\n' + defs.join('\n\n') + '\n'; }
    return out;
}

/*
 * `>>>` multiline blockquote, to standard `>`. Only the FIRST line needs the
 * marker: CommonMark's lazy-continuation rule already reads every following
 * non-blank line as part of the same blockquote paragraph without a `>` on
 * it, for exactly the shape this convention uses.
 */
function rewriteMultilineBlockquote(text) {
    return text.replace(/^>>>[ \t]?/gm, '> ');
}

function applyDialectTextForms(text) {
    // Grid tables are pulled out before EVERYTHING else, including the
    // fence/code mask — a grid table's `+---+` lines are not code, and
    // masking runs on a per-construct basis that has no reason to know
    // about them, so they would otherwise sit in the masked text as
    // ordinary characters, exposed to every rewrite below for no benefit.
    const { text: gridStripped, tables: gridTables } = extractGridTables(text);
    let out = rewriteMystRoleMath(gridStripped);
    const { text: masked, restore } = maskProtectedSpans(out);
    let m = masked;
    m = rewriteLatexMathDelimiters(m);
    m = rewriteMystFencedDirectives(m);
    m = rewriteMkdocsAdmonitions(m);
    m = rewritePandocInlineFootnotes(m);
    m = rewriteMultilineBlockquote(m);
    return { text: restore(m), gridTables };
}

// --- post-parse mdast normalisation (accept-forms only a real parse can see) --

const DETAILS_OPEN = /^\s*<details(?:\s[^>]*)?>\s*(?:\n\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*)?$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;

/** Strips the handful of entities a hand-typed `<summary>` realistically uses. */
function unescapeEntities(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/*
 * `<details><summary>…</summary>` … `</details>` -> one `studioToggle` node.
 *
 * Only the shape a blank-line-separated document actually produces is
 * handled: CommonMark's HTML-block rule ends a raw HTML block at the first
 * blank line, so `<details>` immediately followed by `<summary>…</summary>`
 * (no blank line between them) is ONE `html` node, the body in between is
 * ordinary already-parsed mdast siblings, and `</details>` on its own line
 * is a second `html` node. A `<details>` block written with no blank lines
 * anywhere inside it is not recognised — the whole thing is one opaque
 * `html` node in that case, and lands in rawBlock, still round-tripping
 * losslessly, just without becoming an editable toggle. Real documents
 * (including the old converter's own toggle test) use the blank-line form.
 */
function restructureToggles(children) {
    const out = [];
    let i = 0;
    while (i < children.length) {
        const node = children[i];
        if (node.type === 'html') {
            const open = node.value.match(DETAILS_OPEN);
            if (open) {
                let j = i + 1;
                while (j < children.length && !(children[j].type === 'html' && DETAILS_CLOSE.test(children[j].value))) { j++; }
                if (j < children.length) {
                    const summary = open[1] ? unescapeEntities(open[1].trim()) : 'Toggle';
                    out.push({ type: 'studioToggle', summary, children: children.slice(i + 1, j) });
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(node);
        i++;
    }
    return out;
}

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i;

/*
 * `> [!NOTE]` (GitHub alert blockquote) and a directive whose name is a
 * callout tone, to `studioCallout`. `:::note` itself needs no work here — it
 * is already a containerDirective named "note" by the time this runs, which
 * is exactly the second case below.
 */
function restructureCallouts(children) {
    return children.map(node => {
        if (node.type === 'blockquote' && node.children.length) {
            const first = node.children[0];
            const firstText = first.type === 'paragraph' && first.children[0];
            const m = firstText && firstText.type === 'text' && firstText.value.match(ALERT_MARKER);
            if (m) {
                const tone = m[1].toLowerCase();
                const rest = firstText.value.slice(m[0].length);
                const firstChildren = rest ? [Object.assign({}, firstText, { value: rest })].concat(first.children.slice(1)) : first.children.slice(1);
                const body = firstChildren.length ? [Object.assign({}, first, { children: firstChildren })].concat(node.children.slice(1)) : node.children.slice(1);
                return { type: 'studioCallout', tone, children: body };
            }
        }
        if (node.type === 'containerDirective') {
            const tone = String(node.name || '').toLowerCase();
            if (CALLOUT_TONES.includes(tone)) { return { type: 'studioCallout', tone, children: node.children }; }
        }
        return node;
    });
}

const GRID_PLACEHOLDER = new RegExp('^' + GRID_MARK_OPEN + '(\\d+)' + GRID_MARK_CLOSE + '$');

/** Swaps each grid-table placeholder paragraph for the verbatim block it stands for. */
function restoreGridTables(tree, tables) {
    if (!tables || !tables.length) { return; }
    const walk = node => {
        if (!Array.isArray(node.children)) { return; }
        node.children = node.children.map(child => {
            if (child.type === 'paragraph' && child.children.length === 1 && child.children[0].type === 'text') {
                const m = GRID_PLACEHOLDER.exec(child.children[0].value);
                if (m) { return { type: 'html', value: tables[Number(m[1])] }; }
            }
            walk(child);
            return child;
        });
    };
    walk(tree);
}

/*
 * `[[Page]]` / `[[Page|Title]]` — CONTRACT.md's decision: "preserved as
 * rawInline — no link resolution exists yet". Left alone, these are not
 * special syntax to remark at all (`[[` has no meaning in CommonMark or
 * GFM), so they parse as plain literal text and would round-trip correctly
 * by ACCIDENT rather than by design — indistinguishable, to this module,
 * from a document that never mentions wikilinks. Splitting them out
 * explicitly, into their own inline `html` node (reusing the mdast type
 * that already means "emit this verbatim", the same vehicle raw inline HTML
 * uses — see md-schema.js's `__html_inline` row), makes the decision an
 * actual decision: this text is recognised as wikilink syntax and is
 * DELIBERATELY not resolved, not merely left unexamined.
 */
const WIKILINK = /\[\[[^\]\n]+\]\]/g;

function splitWikilinks(children) {
    const out = [];
    for (const child of children) {
        if (child.type !== 'text' || !child.value.includes('[[')) { out.push(child); continue; }
        WIKILINK.lastIndex = 0;
        let last = 0;
        let m;
        let any = false;
        while ((m = WIKILINK.exec(child.value))) {
            any = true;
            if (m.index > last) { out.push(Object.assign({}, child, { value: child.value.slice(last, m.index) })); }
            out.push({ type: 'html', value: m[0] });
            last = m.index + m[0].length;
        }
        if (!any) { out.push(child); continue; }
        if (last < child.value.length) { out.push(Object.assign({}, child, { value: child.value.slice(last) })); }
    }
    return out;
}

/** Depth-first: children are normalised before the parent's own array is. */
function restructure(node) {
    if (!node || !Array.isArray(node.children)) { return node; }
    let kids = node.children.map(restructure);
    kids = restructureToggles(kids);
    kids = restructureCallouts(kids);
    kids = splitWikilinks(kids);
    return Object.assign({}, node, { children: kids });
}

const MATH_FENCE_LANG = /^math$/i;

/** ```math fences and `` `$x$` `` code spans, to real math nodes. */
function convertMathLiterals(tree) {
    visit(tree, 'code', node => {
        if (node.lang && MATH_FENCE_LANG.test(node.lang)) {
            node.type = 'math';
            delete node.lang;
            delete node.meta;
        }
    });
    visit(tree, 'inlineCode', node => {
        const m = /^\$([^$\n]+)\$$/.exec(node.value || '');
        if (m) { node.type = 'inlineMath'; node.value = m[1]; }
    });
    return tree;
}

/**
 * markdown text -> {tree, warnings}. Never throws: a processor failure (an
 * edge case in a plugin, not a malformed document — Markdown's grammar is
 * permissive enough that malformed input almost never fails to parse, it
 * just parses as something literal) falls back to ONE rawBlock holding the
 * entire body, which still round-trips and still shows the reader their text.
 */
function parseMarkdown(text) {
    const warnings = [];
    const source = String(text);
    try {
        const { text: rewritten, gridTables } = applyDialectTextForms(source);
        const tree = PROCESSOR.parse(rewritten);
        convertMathLiterals(tree);
        restoreGridTables(tree, gridTables);
        const restructured = restructure(tree);
        return { tree: restructured, source: rewritten, warnings };
    } catch (e) {
        warnings.push({ kind: 'parse-failed', line: 1, message: 'could not parse this document; it was kept as-is: ' + (e && e.message || e) });
        return {
            tree: { type: 'root', children: source.trim() ? [{ type: 'html', value: source }] : [] },
            source,
            warnings
        };
    }
}

module.exports = { parseMarkdown, buildParseProcessor, applyDialectTextForms, PROCESSOR };
