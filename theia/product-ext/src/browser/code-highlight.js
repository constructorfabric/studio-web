/*
 * Syntax highlighting for code blocks.
 *
 * WHY A DECORATION PLUGIN AND NOT innerHTML. A code block's text is part of
 * the ProseMirror document and the caret lives inside it, so the usual
 * "tokenize to HTML and assign it" approach is not available: it would
 * replace the very DOM ProseMirror is tracking, and every keystroke would
 * fight the editor's own state. Inline decorations are the mechanism that
 * exists for exactly this — they add classes to ranges without touching the
 * document, so the text stays editable and the highlighting is a pure
 * function of it.
 *
 * WHY PRISM. It is already on disk (1.30.0), it tokenizes to a plain nested
 * array rather than to markup, which is what a decoration pass wants, and its
 * grammars are per-language files so the language set is a deliberate list
 * rather than a 600 KB default. The curated set below is 73 KB minified for 36
 * languages; the alternative (highlight.js via lowlight) is neither present
 * nor smaller.
 *
 * Prism's own auto-highlighting must be off before the core module is
 * evaluated — it otherwise walks the whole document on DOMContentLoaded
 * looking for `<pre><code class="language-*">` and would rewrite our node
 * views out from under ProseMirror.
 */

/*
 * The `manual` flag has to be visible to Prism's core module BEFORE it is
 * evaluated, and the grammar files after it expect to find Prism as a global:
 * every `prism-*.js` is `(function (Prism) { ... }(Prism))` against a bare
 * identifier, so under CommonJS — where the core exports instead of assigning
 * itself — they throw ReferenceError unless the global is bound first. Binding
 * it explicitly is the documented way to use Prism's components outside a
 * browser script tag, and it is what makes this module loadable under the
 * tests as well as inside the bundle.
 */
const globalScope = typeof window !== 'undefined' ? window
    : typeof globalThis !== 'undefined' ? globalThis : global;
if (!globalScope.Prism) { globalScope.Prism = { manual: true }; }

const Prism = require('prismjs');
Prism.manual = true;
/*
 * Re-asserted on every scope name the grammar files might resolve through.
 * Prism's core binds the global itself when it can see one, but which object
 * that is depends on whether it decided it was in a browser, a worker or
 * neither — and a grammar file that cannot find `Prism` throws at load, which
 * would take the whole editor bundle down rather than merely losing colour.
 */
globalScope.Prism = Prism;
if (typeof globalThis !== 'undefined') { globalThis.Prism = Prism; }
if (typeof global !== 'undefined') { global.Prism = Prism; }
if (typeof window !== 'undefined') { window.Prism = Prism; }

const { Plugin, PluginKey } = require('@tiptap/pm/state');
const { Decoration, DecorationSet } = require('@tiptap/pm/view');

/*
 * The curated grammar set. `markup`/`html`/`xml`, `css`, `clike` and
 * `javascript` come with the core module and are not repeated here.
 *
 * Ordered so that a grammar's dependencies are already registered when it
 * loads (Prism grammars extend each other by name at require time, and a
 * missing base silently produces a broken grammar rather than an error).
 */
require('prismjs/components/prism-typescript');
require('prismjs/components/prism-jsx');
require('prismjs/components/prism-tsx');
require('prismjs/components/prism-python');
require('prismjs/components/prism-json');
require('prismjs/components/prism-json5');
require('prismjs/components/prism-yaml');
require('prismjs/components/prism-toml');
require('prismjs/components/prism-bash');
require('prismjs/components/prism-shell-session');
require('prismjs/components/prism-powershell');
require('prismjs/components/prism-sql');
require('prismjs/components/prism-go');
require('prismjs/components/prism-rust');
require('prismjs/components/prism-java');
require('prismjs/components/prism-kotlin');
require('prismjs/components/prism-swift');
require('prismjs/components/prism-c');
require('prismjs/components/prism-cpp');
require('prismjs/components/prism-csharp');
require('prismjs/components/prism-ruby');
require('prismjs/components/prism-php');
require('prismjs/components/prism-r');
require('prismjs/components/prism-lua');
require('prismjs/components/prism-scss');
require('prismjs/components/prism-less');
require('prismjs/components/prism-graphql');
require('prismjs/components/prism-protobuf');
require('prismjs/components/prism-hcl');
require('prismjs/components/prism-docker');
require('prismjs/components/prism-makefile');
require('prismjs/components/prism-ini');
require('prismjs/components/prism-diff');
require('prismjs/components/prism-latex');
require('prismjs/components/prism-regex');
require('prismjs/components/prism-markdown');

/*
 * THE IMPORTED NAME, COLOURED.
 *
 * Prism's python grammar tokenizes `import numpy` as one keyword and one bare
 * word, so the reported case — "it doesn't highlight the function and library
 * name" — was accurate: the line really does come out in two colours only if
 * the module name gets one. Every code surface a person compares this with
 * (VS Code's semantic pass, GitHub's tree-sitter queries) colours it, so the
 * pattern is added rather than the complaint declined.
 *
 * Inserted BEFORE `keyword`, which is what leaves `import` itself a keyword:
 * the lookbehind group is matched and not consumed, so the two patterns split
 * the line between them. It goes after `string`/`comment` in the grammar
 * order for the same reason those come first — the word "import" inside a
 * docstring is prose, not a statement.
 */
if (Prism.languages.python) {
    Prism.languages.insertBefore('python', 'keyword', {
        'imported-module': {
            pattern: /(\b(?:import|from)\s+)[a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*/,
            lookbehind: true,
            // `class-name` rather than a type of its own: the palette in this
            // file is deliberately five colours, and a module name is the same
            // kind of thing as a type name — a name from somewhere else.
            alias: 'class-name'
        }
    });
}

/*
 * What people actually type after the opening fence, mapped to the grammar
 * that handles it. Prism registers some of these itself; the ones here are
 * the spellings it does not know, plus every abbreviation that shows up in a
 * repository's own documentation.
 */
const ALIASES = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', python3: 'python',
    sh: 'bash', shell: 'bash', zsh: 'bash', ksh: 'bash', console: 'shell-session', terminal: 'shell-session',
    ps1: 'powershell', pwsh: 'powershell',
    yml: 'yaml',
    'c++': 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp',
    'c#': 'csharp', cs: 'csharp', dotnet: 'csharp',
    golang: 'go', rb: 'ruby', rs: 'rust', kt: 'kotlin', kts: 'kotlin',
    tf: 'hcl', terraform: 'hcl', hcl2: 'hcl',
    dockerfile: 'docker', containerfile: 'docker',
    md: 'markdown', mdx: 'markdown',
    tex: 'latex',
    proto: 'protobuf', proto3: 'protobuf',
    htm: 'markup', vue: 'markup', svelte: 'markup', svg: 'markup', xml: 'markup',
    conf: 'ini', cfg: 'ini', toml_: 'toml', editorconfig: 'ini',
    make: 'makefile', mk: 'makefile',
    patch: 'diff', udiff: 'diff'
};

/** The languages the fence's info string can name and get highlighting for. */
const SUPPORTED = Object.keys(Prism.languages)
    .filter(name => typeof Prism.languages[name] === 'object')
    .concat(Object.keys(ALIASES))
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();

/** The registered grammar for a fence info string, or undefined. */
function grammarFor(language) {
    const key = String(language || '').trim().toLowerCase();
    if (!key) { return undefined; }
    const resolved = ALIASES[key] || key;
    const grammar = Prism.languages[resolved];
    return grammar && typeof grammar === 'object' ? grammar : undefined;
}

/* ==========================================================================
 * GUESSING THE LANGUAGE OF A FENCE THAT DOES NOT NAME ONE.
 *
 * Most fences in a real repository's documentation carry no info string —
 * nobody types ```python around three lines of shell they pasted — so before
 * this, "code blocks show plain text and that's it" was the normal case rather
 * than the exception, and the language field was a control the reader had to
 * discover before the feature did anything at all.
 *
 * WHY NOT AN ENGINE. Neither Prism nor CodeMirror detects languages; the
 * engines that do are highlight.js (`highlightAuto`, which runs every
 * registered grammar and scores by how much of the text it consumed) and the
 * classifiers behind Linguist. `highlightAuto` is the reusable one and it is
 * also the expensive one: it means a second highlighter in the bundle, ~1 MB
 * of grammars, for a job whose whole input is usually under ten lines. The
 * signature table below is the same idea at 1% of the size — score the
 * unmistakable shapes of each language, take the winner if it wins clearly.
 *
 * TWO RULES KEEP A WRONG GUESS CHEAP.
 *  1. A guess NEVER touches the document. It drives the decoration pass and
 *     the field's placeholder, and that is all; the fence stays bare in the
 *     file, because writing a guess into a document on open would be an edit
 *     nobody asked for and would show up in the next diff.
 *  2. A guess has to WIN. Below the floor, or without a margin over the
 *     runner-up, the block stays plain — which is exactly what it was before,
 *     so the failure mode of this whole function is "no change".
 * ========================================================================== */

/*
 * `[pattern, weight]`, weight ~= how much the shape rules out other
 * languages. A keyword every C-family language shares is worth 1; a syntax
 * only one language has (`elif`, `<?php`, `@@ -1,4 +1,4 @@`) is worth 3.
 * Negative weights are the important half: `;` at the end of a line is what
 * stops a JavaScript snippet from scoring as Python on `import`.
 */
const SIGNATURES = [
    ['python', [
        [/^\s*(?:from\s+[\w.]+\s+)?import\s+[\w*]/m, 3],
        [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->[^:]+)?:/m, 3],
        [/^\s*class\s+\w+\s*(?:\([^)]*\))?\s*:/m, 2],
        [/\belif\b|\bself\b|\b__name__\b|\bNone\b|\bTrue\b|\bFalse\b/, 2],
        [/^\s*(?:async\s+)?with\s+.+:\s*$/m, 1],
        [/\bprint\s*\(|\blen\s*\(/, 1],
        [/[;{]\s*$/m, -2]
    ]],
    ['javascript', [
        [/\b(?:const|let|var)\s+[\w{[$]/, 2],
        [/\bfunction\s*\*?\s*\w*\s*\(|=>\s*[{(]/, 2],
        [/\brequire\s*\(|\bmodule\.exports\b|\bexport\s+(?:default|const|function)\b/, 3],
        [/\bimport\s+[\w{*][^;\n]*\bfrom\b/, 3],
        [/\bconsole\.log\s*\(|\bdocument\.|\bwindow\./, 2],
        [/\basync\s+function\b|\bawait\s+\w/, 1],
        [/^\s*(?:def|end|elif)\b/m, -2]
    ]],
    ['typescript', [
        [/:\s*(?:string|number|boolean|void|unknown|any)\b/, 3],
        [/\binterface\s+\w+\s*\{|\btype\s+\w+\s*=/, 3],
        [/\bexport\s+(?:interface|type|enum|abstract)\b/, 2],
        [/\bconst\s+\w+\s*:\s*\w/, 2],
        [/<[A-Z]\w*(?:,\s*[\w<>[\]]+)*>\s*\(/, 1]
    ]],
    ['bash', [
        [/^#!.*\b(?:ba|z|k)?sh\b/, 3],
        [/^\s*\$\s+\S/m, 3],
        [/\b(?:npm|yarn|pnpm|git|docker|kubectl|brew|apt-get|curl|sudo|chmod|mkdir|cd)\s+[\w./-]/, 2],
        [/\|\s*(?:grep|awk|sed|xargs|jq|head|tail|wc|sort)\b/, 2],
        [/\$\{?\w+\}?|^\s*export\s+\w+=/m, 1],
        [/&&|\s2>&1|\s--?[a-z][\w-]*/, 1],
        [/^\s*(?:def|class|function)\s/m, -1]
    ]],
    ['json', [
        [/^\s*[{[]/, 1],
        /* Not line-anchored: a one-line object is how a JSON snippet appears in
           documentation, and every line-anchored pattern here misses it. */
        [/"[^"\n]*"\s*:/, 3],
        [/:\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false|null)\s*,?\s*$/m, 2],
        [/^\s*(?:\/\/|#)/m, -3],
        [/[a-zA-Z_$]\w*\s*:/m, -1]
    ]],
    ['yaml', [
        [/^---\s*$/m, 2],
        [/^\s*[\w.-]+:(?:\s+\S|\s*$)/m, 2],
        [/^\s*-\s+[\w"'{[]/m, 2],
        [/^\s*#/m, 1],
        [/[{};]\s*$/m, -2],
        [/^\s*"[^"\n]+"\s*:/m, -1]
    ]],
    ['markup', [
        [/<\/(?:div|span|p|a|ul|li|body|html|head|section|table|td|tr)>/, 3],
        [/<!DOCTYPE\s+html>|<html\b|<\?xml\b/i, 3],
        [/<\w+(?:\s+[\w:-]+=(?:"[^"]*"|'[^']*'))+\s*\/?>/, 2],
        [/<\/?[A-Z]\w*[\s/>]/, 1]
    ]],
    ['css', [
        [/^[^{}\n]*\{[^}]*\}/m, 1],
        /* A one-line rule, which is how a CSS snippet in documentation is
           usually written and what the line-anchored patterns below all miss. */
        [/\{[^{}]*\b(?:color|background|margin|padding|display|font|width|height|border|flex|grid|position|opacity|transform)\b\s*:/, 3],
        [/^\s*(?:[.#]?[\w-]+|\*)(?:[^{;\n]*)\{\s*$/m, 2],
        [/^\s*[a-z-]+:\s*[^;\n]+;\s*$/m, 3],
        [/@(?:media|import|keyframes|supports|font-face)\b|--[\w-]+:/, 3],
        [/\b(?:function|def|class)\s+\w/, -2]
    ]],
    ['sql', [
        [/\bSELECT\b[\s\S]*\bFROM\b/i, 3],
        [/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE)\b/i, 3],
        [/\b(?:INNER|LEFT|RIGHT|OUTER)\s+JOIN\b|\bGROUP\s+BY\b|\bORDER\s+BY\b/i, 2],
        [/\bWHERE\b|\bVALUES\b/i, 1]
    ]],
    ['go', [
        [/^\s*package\s+\w+\s*$/m, 3],
        [/\bfunc\s+(?:\(\w+\s+\*?\w+\)\s*)?\w*\s*\(/, 3],
        [/:=|\bnil\b|\bdefer\b|\bgo\s+func\b/, 2],
        [/^\s*import\s+\(/m, 2],
        [/\bfmt\.\w+\(/, 2]
    ]],
    ['rust', [
        [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/, 3],
        [/\blet\s+mut\b|\bimpl\b|\bpub\s+(?:fn|struct|enum|mod)\b/, 3],
        [/\buse\s+[\w:]+(?:::\{[^}]*\})?;/, 2],
        [/->\s*(?:Result|Option|Self|Vec)</, 2],
        [/\bmatch\b[\s\S]*=>/, 1],
        [/\w+!\s*\(/, 1]
    ]],
    ['java', [
        [/\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\]]+\s+\w+\s*\(/, 3],
        [/\bSystem\.out\.print(?:ln)?\s*\(/, 3],
        [/^\s*(?:package|import)\s+[\w.]+;\s*$/m, 2],
        [/\bnew\s+[A-Z]\w*\s*\(|\b(?:class|interface|enum)\s+[A-Z]\w*/, 1],
        [/@Override\b|\bextends\b|\bimplements\b/, 1]
    ]],
    ['docker', [
        [/^\s*FROM\s+[\w./:-]+/mi, 3],
        [/^\s*(?:RUN|CMD|COPY|ADD|ENTRYPOINT|WORKDIR|EXPOSE|ENV|ARG|LABEL|VOLUME)\s+\S/mi, 2]
    ]],
    ['diff', [
        [/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m, 3],
        [/^(?:---|\+\+\+)\s+\S/m, 2],
        [/^[+-](?![+-])\S/m, 1]
    ]],
    ['ini', [
        [/^\s*\[[\w.$-]+\]\s*$/m, 3],
        [/^\s*[\w.-]+\s*=\s*\S/m, 2],
        [/^\s*[;#]/m, 1],
        [/[{};]\s*$/m, -2]
    ]]
];

/*
 * The floor and the margin.
 *
 * 3 is one unmistakable signature, or two shapes that individually could be
 * several languages; the winner also has to be at least 2 clear of the runner
 * up, because "python or ruby, roughly equally" is a guess with a coin flip in
 * it and the honest answer to a coin flip is no colour at all.
 */
const DETECT_FLOOR = 3;
const DETECT_MARGIN = 2;
/* Only the head of the block is scored: a signature that is not in the first
 * 80 lines of a listing is not a signature, and this runs inside a decoration
 * pass that reruns on every keystroke in the document. */
const DETECT_CHARS = 4000;

const detectCache = new Map();
const DETECT_CACHE_MAX = 64;

/**
 * The language a fence with no info string is probably written in, or '' when
 * nothing wins clearly. Pure function of the text; never written to the doc.
 */
function detectLanguage(text) {
    const source = String(text || '').slice(0, DETECT_CHARS);
    // Two or three characters cannot carry a signature, and one word of prose
    // in a fence is a deliberate `code` fence, not an undetected language.
    if (source.trim().length < 6) { return ''; }
    const cached = detectCache.get(source);
    if (cached !== undefined) { return cached; }

    let best = '';
    let bestScore = 0;
    let runnerUp = 0;
    for (const [language, patterns] of SIGNATURES) {
        let score = 0;
        for (const [pattern, weight] of patterns) {
            if (pattern.test(source)) { score += weight; }
        }
        if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = language; }
        else if (score > runnerUp) { runnerUp = score; }
    }
    const guess = bestScore >= DETECT_FLOOR && bestScore - runnerUp >= DETECT_MARGIN ? best : '';

    // A plain FIFO cap. The keys are code-block bodies, so an unbounded map
    // would hold every intermediate state of every block ever typed in.
    if (detectCache.size >= DETECT_CACHE_MAX) { detectCache.delete(detectCache.keys().next().value); }
    detectCache.set(source, guess);
    return guess;
}

/*
 * A token's class list.
 *
 * Prism's own convention, kept deliberately: `token` plus the type plus any
 * aliases. Following it means the CSS below reads like any Prism theme and a
 * grammar that emits an unfamiliar type still gets the base `token` colour
 * rather than nothing.
 */
function classesFor(token) {
    const alias = token.alias;
    const aliases = !alias ? [] : (Array.isArray(alias) ? alias : [alias]);
    return ['token', token.type].concat(aliases).join(' ');
}

/*
 * The token tree flattened into ranges.
 *
 * Prism returns strings and Token objects, and a Token's content is either a
 * string or another such array — nesting that carries real information (a
 * template literal's interpolation, a comment inside a string). Descending
 * emits a decoration at every level, so the inner range's class lands on top
 * of the outer one, which is how Prism's own markup behaves.
 */
function collectRanges(tokens, start, into) {
    let at = start;
    for (const token of tokens) {
        if (typeof token === 'string') { at += token.length; continue; }
        const content = token.content;
        const length = typeof content === 'string' ? content.length
            : Array.isArray(content) ? content.reduce((n, t) => n + tokenLength(t), 0)
                : String(content).length;
        into.push({ from: at, to: at + length, className: classesFor(token) });
        if (Array.isArray(content)) { collectRanges(content, at, into); }
        at += length;
    }
    return into;
}

function tokenLength(token) {
    if (typeof token === 'string') { return token.length; }
    const content = token.content;
    if (typeof content === 'string') { return content.length; }
    if (Array.isArray(content)) { return content.reduce((n, t) => n + tokenLength(t), 0); }
    return String(content).length;
}

/*
 * A ceiling, and a logged one.
 *
 * Tokenizing is linear but not free, and it reruns on every document change.
 * A pasted minified bundle in a single fence is the realistic worst case; at
 * that size the highlighting is worthless anyway (one line, no structure to
 * see) while the cost is paid on every keystroke in the whole document.
 */
const MAX_HIGHLIGHT_CHARS = 40000;

function buildDecorations(doc) {
    const decorations = [];
    doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') { return true; }
        const text = node.textContent;
        if (!text || text.length > MAX_HIGHLIGHT_CHARS) { return false; }
        /*
         * The fence's own info string first, and only then the guess — an
         * author who typed a language is never second-guessed, including when
         * they typed one this build has no grammar for (that stays plain, the
         * same as before, rather than falling back to a detected one and
         * colouring the block as a language the fence says it is not).
         */
        const named = (node.attrs && node.attrs.language) || '';
        const language = named || detectLanguage(text);
        const grammar = grammarFor(language);
        if (!grammar) { return false; }
        let ranges;
        try {
            ranges = collectRanges(Prism.tokenize(text, grammar), pos + 1, []);
        } catch (e) {
            // A grammar that throws on some input must not take the document
            // with it: an un-highlighted block is a cosmetic loss, an editor
            // that cannot compute its decorations does not render at all.
            console.error('[studio] could not highlight a ' + language + ' block', e);
            return false;
        }
        for (const range of ranges) {
            if (range.to > range.from) {
                decorations.push(Decoration.inline(range.from, range.to, { class: range.className }));
            }
        }
        return false;
    });
    return DecorationSet.create(doc, decorations);
}

const codeHighlightKey = new PluginKey('studioCodeHighlight');

function codeHighlightPlugin() {
    return new Plugin({
        key: codeHighlightKey,
        state: {
            init: (_, { doc }) => buildDecorations(doc),
            /*
             * Recomputed on any document change rather than mapped through the
             * transaction. Mapping would keep stale token boundaries — typing
             * `"` opens a string that reclassifies everything after it, and a
             * mapped decoration set has no way to know that. Recomputing is
             * O(code in the document) and only the code blocks are walked.
             */
            apply: (tr, previous) => (tr.docChanged ? buildDecorations(tr.doc) : previous)
        },
        props: {
            decorations(state) { return codeHighlightKey.getState(state); }
        }
    });
}

/*
 * The palette.
 *
 * Tied to the product's own tokens rather than lifted from a published theme:
 * keywords take the accent, strings the "verified" green, tags the danger red,
 * so a code block reads as part of this product and not as an embedded
 * gist. Numbers and properties use a blue that exists in neither palette
 * because both product hues are already spoken for and a fifth distinguishable
 * colour is what the grammar needs.
 *
 * Comments are the one italic in the document. Everything else stays upright:
 * at 12.8px in a monospace face, more than one style axis stops helping.
 */
const CODE_HIGHLIGHT_CSS = `
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.comment,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.prolog,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.cdata {
  color: var(--studio-code-comment); font-style: italic;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.punctuation,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.operator {
  color: var(--studio-code-punct);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.keyword,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.atrule,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.rule,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.important,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.doctype {
  color: var(--studio-code-keyword); font-weight: 600;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.string,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.char,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.attr-value,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.regex,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.url {
  color: var(--studio-code-string);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.number,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.boolean,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.constant,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.symbol,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.property,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.attr-name {
  color: var(--studio-code-number);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.function,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.class-name,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.builtin,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.namespace {
  color: var(--studio-code-fn);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.tag,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.selector,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.variable,
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.entity {
  color: var(--studio-code-tag);
}
/* A diff fence is the one grammar whose whole point is the two colours, so it
   gets the tinted ground the rest of the palette deliberately avoids. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.inserted {
  color: var(--studio-verified); background: color-mix(in srgb, var(--studio-verified) 12%, transparent);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.deleted {
  color: var(--studio-danger); background: color-mix(in srgb, var(--studio-danger) 12%, transparent);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.bold { font-weight: 700; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) pre .token.italic { font-style: italic; }
`;

/*
 * What the language picker offers, as opposed to what grammarFor accepts.
 *
 * SUPPORTED is 106 names once every alias and every Prism-internal spelling is
 * counted, which is a list nobody scrolls. This is the short one: the
 * languages a repository's own documentation actually contains, in the
 * spelling a person would type. The field stays free text, so a name that is
 * not on this list still works — the list is a suggestion, not a constraint.
 */
const LANGUAGE_MENU = [
    'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'docker', 'go', 'graphql', 'hcl',
    'html', 'ini', 'java', 'javascript', 'json', 'jsx', 'kotlin', 'latex', 'less',
    'lua', 'makefile', 'markdown', 'mermaid', 'php', 'powershell', 'protobuf',
    'python', 'r', 'ruby', 'rust', 'scss', 'shell-session', 'sql', 'swift',
    'toml', 'tsx', 'typescript', 'xml', 'yaml'
];

module.exports = {
    codeHighlightPlugin, grammarFor, detectLanguage, SUPPORTED, LANGUAGE_MENU, ALIASES,
    CODE_HIGHLIGHT_CSS, collectRanges
};
