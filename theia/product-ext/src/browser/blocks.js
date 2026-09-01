/*
 * The block registry: every insertable or convertible unit the slash menu
 * and the selection toolbar's block selector both read.
 *
 * One array rather than two lists -- SLASH_ITEMS today, and nothing at all
 * for the toolbar, which is why the selector is new this pass -- because a
 * block reachable from one menu and silently missing from the other is
 * exactly the kind of drift that gets caught once in review and then
 * reintroduced by the next person who adds a block and only remembers the
 * menu they were looking at.
 *
 * `convert: true` marks a block the selection toolbar's block selector may
 * turn a selection INTO. The rest are insert-only: either turning a run of
 * text into them has no coherent meaning (a divider replaces text with
 * nothing; a table or a footnote needs structure text alone cannot supply),
 * or they open a surface of their own (`defer`) rather than editing the
 * document directly.
 *
 * `requiresNode` / `requiresMark` name a schema entry that has to exist
 * before the item is usable. Math, callouts, a definition list, a table of
 * contents and the raw-source fallback are landing in a concurrent pass over
 * the engine; until each one does, `isBlockAvailable` below filters that
 * item out of both menus rather than letting `run` throw against a node
 * type ProseMirror does not know yet. The entry stays in the registry the
 * whole time, so the menu lights up the moment its node lands, with no
 * second change here.
 */

const { ICONS } = require('./icons');
const { tableContent } = require('./editor-tables');

const GROUP_ORDER = ['Recent', 'Basic', 'Callouts', 'Structure', 'Content', 'Insert', 'Advanced'];

/** The selected text, for the rows that turn a selection into a node's attribute. */
function selectedText(state) {
    const { from, to, empty } = state.selection;
    return empty ? '' : state.doc.textBetween(from, to, '\n').trim();
}

function heading(level) {
    return c => c.setNode('heading', { level });
}

/*
 * WHY CALLOUTS AND TOGGLES CANNOT USE setNode.
 *
 * `setNode` is prosemirror-commands' setBlockType, and setBlockType only ever
 * targets a TEXTBLOCK — a node whose content is inline. `callout` and
 * `toggle` are both `content: 'block+'` containers, exactly like blockquote,
 * so setBlockType finds no applicable range, returns false, and the chain
 * ends having done nothing at all. Silently: no throw, no console warning,
 * the menu closes and the document is unchanged. That is precisely the
 * reported bug — every callout tone and the toggle appeared in both menus and
 * neither wrote a single character to the file.
 *
 * The container equivalent is wrapIn. It needs a branch that a chain cannot
 * express on its own (a chained command that returns false aborts the whole
 * chain), hence `.command()`: one callback, the live editor to ask, and the
 * single commands running against the same transaction.
 */
function wrapOrRetone(tone) {
    return c => c.command(({ editor, commands }) => (
        editor.isActive('callout')
            // Already a callout: this is a TONE CHANGE, not another wrapper.
            // The selection toolbar's block selector is the main caller and
            // its whole purpose there is turning one tone into another.
            ? commands.updateAttributes('callout', { tone })
            : commands.wrapIn('callout', { tone })
    ));
}

/*
 * A short, unique-enough footnote label. Collisions are possible but cheap:
 * two footnotes sharing a label just render as one definition, which is a
 * visible, fixable mistake rather than a silent data-loss one -- unlike, say,
 * reusing a comment id, which would merge two threads.
 */
function footnoteLabel() {
    return Math.random().toString(36).slice(2, 6);
}

const BLOCKS = [
    { key: 'text', label: 'Text', group: 'Basic', icon: ICONS.blockText, hint: 'Plain paragraph',
        aliases: ['paragraph', 'p', 'plain', 'body', 'normal', 'prose'],
        convert: true,
        /*
         * Lifting first is what makes "Text" the way OUT of a callout or a
         * toggle. Without it the block selector could put a paragraph into a
         * callout and then had no row that took it back out again, so the
         * wrapper was permanent from the menus' point of view. `lift` is
         * attempted, not required — outside a container it simply reports
         * false and the setParagraph below is the whole operation.
         */
        run: c => c.command(({ editor, commands }) => {
            if (editor.isActive('callout')) { commands.lift('callout'); }
            if (editor.isActive('toggle')) { commands.lift('toggle'); }
            return commands.setParagraph();
        }) },
    { key: 'h1', label: 'Heading 1', group: 'Basic', icon: ICONS.heading1, hint: 'Large section title',
        aliases: ['title', '#', 'heading', 'big', 'section', 'header1'],
        convert: true, run: heading(1) },
    { key: 'h2', label: 'Heading 2', group: 'Basic', icon: ICONS.heading2, hint: 'Medium section title',
        aliases: ['##', 'heading', 'subtitle', 'section', 'header2'],
        convert: true, run: heading(2) },
    { key: 'h3', label: 'Heading 3', group: 'Basic', icon: ICONS.heading3, hint: 'Small section title',
        aliases: ['###', 'heading', 'subsection', 'header3'],
        convert: true, run: heading(3) },
    { key: 'h4', label: 'Heading 4', group: 'Basic', icon: ICONS.heading4, hint: 'Small subsection title',
        aliases: ['####', 'heading', 'subsection', 'header4'],
        convert: true, run: heading(4) },
    { key: 'h5', label: 'Heading 5', group: 'Basic', icon: ICONS.heading5, hint: 'Minor subsection title',
        aliases: ['#####', 'heading', 'subsection', 'header5'],
        convert: true, run: heading(5) },
    { key: 'h6', label: 'Heading 6', group: 'Basic', icon: ICONS.heading6, hint: 'Deepest subsection title',
        aliases: ['######', 'heading', 'label', 'caption', 'header6'],
        convert: true, run: heading(6) },
    { key: 'bullet', label: 'Bulleted list', group: 'Basic', icon: ICONS.bulletList, hint: 'Simple bulleted list',
        aliases: ['ul', 'list', 'unordered', 'dash', '-', '*', 'bullets', 'itemize'],
        convert: true, run: c => c.toggleBulletList() },
    { key: 'ordered', label: 'Numbered list', group: 'Basic', icon: ICONS.orderedList, hint: 'List with ordering',
        aliases: ['ol', 'list', 'numbered', '1.', 'steps', 'enumerate', 'numbers'],
        convert: true, run: c => c.toggleOrderedList() },
    { key: 'task', label: 'Checklist', group: 'Basic', icon: ICONS.taskList, hint: 'Task list with checkboxes',
        aliases: ['todo', 'checkbox', 'task', '[]', 'check', 'tickbox', 'checklist'],
        convert: true, run: c => c.toggleTaskList() },
    { key: 'quote', label: 'Quote', group: 'Basic', icon: ICONS.quote, hint: 'Capture a citation',
        aliases: ['blockquote', 'citation', '>', 'cite', 'excerpt', 'pullquote'],
        convert: true, run: c => c.toggleBlockquote() },
    { key: 'divider', label: 'Divider', group: 'Basic', icon: ICONS.divider, hint: 'Horizontal rule',
        aliases: ['hr', 'rule', 'line', 'separator', '---', 'break', 'horizontal'],
        convert: false, run: c => c.setHorizontalRule() },

    { key: 'callout-note', label: 'Note callout', group: 'Callouts', icon: ICONS.calloutNote,
        hint: 'Aside the reader should notice',
        aliases: ['admonition', 'info', 'aside', 'box', 'alert', 'callout', 'note'],
        convert: true, requiresNode: 'callout', run: wrapOrRetone('note') },
    { key: 'callout-tip', label: 'Tip callout', group: 'Callouts', icon: ICONS.calloutTip,
        hint: 'Advice, not obligation',
        aliases: ['admonition', 'hint', 'suggestion', 'advice', 'callout', 'tip'],
        convert: true, requiresNode: 'callout', run: wrapOrRetone('tip') },
    { key: 'callout-important', label: 'Important callout', group: 'Callouts', icon: ICONS.calloutImportant,
        hint: 'Cannot be skipped',
        aliases: ['admonition', 'key', 'must', 'callout', 'important', 'attention'],
        convert: true, requiresNode: 'callout', run: wrapOrRetone('important') },
    { key: 'callout-warning', label: 'Warning callout', group: 'Callouts', icon: ICONS.calloutWarning,
        hint: 'Consequence if ignored',
        aliases: ['admonition', 'caution', 'alert', 'careful', 'aside', 'box'],
        convert: true, requiresNode: 'callout', run: wrapOrRetone('warning') },
    { key: 'callout-caution', label: 'Caution callout', group: 'Callouts', icon: ICONS.calloutCaution,
        hint: 'Damage if ignored',
        aliases: ['admonition', 'danger', 'error', 'stop', 'callout', 'caution'],
        convert: true, requiresNode: 'callout', run: wrapOrRetone('caution') },

    { key: 'toggle', label: 'Toggle', group: 'Structure', icon: ICONS.toggle, hint: 'Collapsible details',
        aliases: ['details', 'collapse', 'accordion', 'expand', 'summary', 'fold', 'spoiler'],
        convert: true,
        // wrapIn for the same reason the callouts use it: `toggle` is a
        // block+ container, so setNode could never have applied to it.
        run: c => c.command(({ editor, commands }) => (
            editor.isActive('toggle') ? true : commands.wrapIn('toggle', { summary: 'Toggle' })
        )) },
    { key: 'table', label: 'Table', group: 'Structure', icon: ICONS.table, hint: 'Data table',
        aliases: ['grid', 'sheet', 'matrix', 'columns', 'rows', 'spreadsheet'],
        convert: false, run: c => c.insertContent(tableContent(3, 2)) },
    { key: 'definition', label: 'Definition list', group: 'Structure', icon: ICONS.definitionList,
        hint: 'Terms and meanings',
        aliases: ['dl', 'glossary', 'terms', 'dt', 'dictionary', 'definitions'],
        convert: false, requiresNode: 'definitionList',
        run: c => c.insertContent({
            type: 'definitionList',
            content: [
                { type: 'definitionTerm', content: [{ type: 'text', text: 'Term' }] },
                { type: 'definitionItem', content: [{ type: 'text', text: 'Definition' }] }
            ]
        }) },
    { key: 'footnote', label: 'Footnote', group: 'Structure', icon: ICONS.footnote, hint: 'Reference and note',
        aliases: ['ref', '^', 'note', 'aside', 'citation', 'endnote'],
        /*
         * `footnoteRef`/`footnoteDef` are already in the schema (see
         * markdown-editor.js's Node.create() calls) but were never reachable
         * from either menu -- there was no SLASH_ITEMS entry for them at
         * all. No `requiresNode` guard: the nodes already exist, so this
         * lights up immediately rather than waiting on the engine pass.
         */
        convert: false,
        run: c => {
            const label = footnoteLabel();
            return c.insertContent([
                { type: 'footnoteRef', attrs: { label } },
                { type: 'footnoteDef', attrs: { label }, content: [{ type: 'text', text: 'Note.' }] }
            ]);
        } },

    { key: 'code', label: 'Code block', group: 'Content', icon: ICONS.codeBlock, hint: 'Preformatted code',
        aliases: ['fence', 'snippet', '```', 'pre', 'program', 'terminal', 'codeblock'],
        convert: true, run: c => c.toggleCodeBlock() },
    { key: 'math-block', label: 'Equation', group: 'Content', icon: ICONS.mathBlock, hint: 'Display maths',
        aliases: ['math', 'latex', 'katex', 'tex', '$$', 'formula', 'equation'],
        convert: true, requiresNode: 'mathBlock',
        // The selection becomes the equation's source rather than being
        // deleted: converting a line that already holds LaTeX is the common
        // way an equation gets made, and throwing that text away made the
        // menu row destructive.
        run: c => c.command(({ state, commands }) => commands.insertContent({
            type: 'mathBlock', attrs: { latex: selectedText(state) }
        })) },
    { key: 'math-inline', label: 'Inline math', group: 'Content', icon: ICONS.mathInline, hint: 'Maths in a sentence',
        aliases: ['math', 'latex', '$', 'formula', 'tex'],
        convert: false, requiresNode: 'mathInline',
        /*
         * `x` WHEN THERE IS NOTHING SELECTED, and it is not arbitrary.
         *
         * An inline math node with empty latex serialises to `$$`, which is
         * not inline maths at all when read back — it reparses as the literal
         * two characters, so the node silently disappeared on the first save.
         * A block equation does not have this problem (`$$\n$$` round-trips as
         * an empty mathBlock), which is why only this row needs a seed. `x` is
         * the shortest valid LaTeX that renders to something visible and
         * therefore clickable.
         */
        run: c => c.command(({ state, commands }) => commands.insertContent({
            type: 'mathInline', attrs: { latex: selectedText(state) || 'x' }
        })) },

    { key: 'link', label: 'Link', group: 'Insert', icon: ICONS.link, hint: 'Link the selection, or paste a URL',
        /*
         * Neither 'address' nor 'href', and both omissions are measured.
         * `ad` is an alias prefix of "address" and `hr` of "href", so
         * including them put Link into the results for two of the shortest,
         * most canonical queries in the menu — `ad` for the callouts and `hr`
         * for the divider. That is the same precision-at-two-characters
         * problem the length gates on the substring tiers below exist to
         * solve, and an alias nobody types is not worth reopening it for;
         * 'url' already covers the case.
         */
        aliases: ['url', 'anchor', 'hyperlink', 'web'],
        /*
         * `defer`, and the ONE thing that makes this row different from the
         * other Insert rows: a link is a MARK, not a block. The registry is
         * still the right home for it — the reported complaint was precisely
         * that the slash menu had no way to make a link while the selection
         * toolbar did, and a reader looking for "link" looks in the menu that
         * lists everything else they can add. `defer` already means "opens a
         * surface of its own", which the link editor is.
         */
        convert: false, defer: true, run: (_, widget) => widget.openLinkEditor() },
    { key: 'image', label: 'Image', group: 'Insert', icon: ICONS.image, hint: 'Add an image from this project',
        aliases: ['picture', 'photo', 'img', 'screenshot', 'figure', 'upload', 'media'],
        convert: false, defer: true, run: (_, widget) => widget.importImage() },
    { key: 'figure', label: 'Interactive figure', group: 'Insert', icon: ICONS.figure,
        hint: 'Describe one, or start from a template',
        aliases: ['chart', 'plot', 'widget', 'viz', 'interactive', 'graph', 'embed'],
        convert: false, defer: true, run: (_, widget) => widget.createFigure() },
    { key: 'diagram', label: 'Diagram', group: 'Insert', icon: ICONS.diagram, hint: 'Mermaid diagram',
        aliases: ['mermaid', 'flowchart', 'sequence', 'uml', 'graph', 'erd'],
        convert: false,
        run: c => c.insertContent({
            type: 'codeBlock', attrs: { language: 'mermaid' },
            content: [{ type: 'text', text: 'graph TD;\n  A[Start] --> B[Finish];' }]
        }) },

    { key: 'frontmatter', label: 'Frontmatter', group: 'Advanced', icon: ICONS.frontmatter,
        hint: 'Document metadata',
        aliases: ['yaml', 'metadata', 'meta', 'header', 'properties'],
        /*
         * Frontmatter is split off the body and held verbatim by
         * splitFrontmatter/joinFrontmatter (markdown.js) -- it is not a node
         * inside the ProseMirror document at all, and none of the five nodes
         * the engine pass is adding makes it one. `requiresNode` names a node
         * that is not on anyone's list, which is a deliberate way to keep
         * this entry permanently filtered rather than inventing a second,
         * unguarded flag that would need to be kept in sync with this
         * comment by hand. If an in-document frontmatter affordance is ever
         * built, giving its node this name is what turns the item on.
         */
        convert: false, requiresNode: 'frontmatterField', run: () => {} },
    { key: 'toc', label: 'Table of contents', group: 'Advanced', icon: ICONS.toc, hint: 'Generated outline',
        aliases: ['contents', 'outline', 'index', 'nav'],
        convert: false, requiresNode: 'toc', run: c => c.insertContent({ type: 'toc' }) },
    { key: 'raw', label: 'Preserved source', group: 'Advanced', icon: ICONS.preserved, hint: 'Verbatim markdown',
        aliases: ['html', 'verbatim', 'escape', 'passthrough', 'literal'],
        convert: false, requiresNode: 'rawBlock',
        run: c => c.insertContent({ type: 'rawBlock', attrs: { source: '', kind: 'html' } }) }
];

function isBlockAvailable(block, schema) {
    if (block.requiresNode && !(schema && schema.nodes && schema.nodes[block.requiresNode])) { return false; }
    if (block.requiresMark && !(schema && schema.marks && schema.marks[block.requiresMark])) { return false; }
    return true;
}

/** BLOCKS filtered to what the current schema can actually run, optionally to convert targets only. */
function blocksFor(schema, opts) {
    const convertOnly = !!(opts && opts.convertOnly);
    return BLOCKS.filter(b => (!convertOnly || b.convert) && isBlockAvailable(b, schema));
}

// --- ranking ------------------------------------------------------------
//
// Exact key/alias, then key prefix, then label word-start, then alias
// prefix -- ungated, precise at any query length. Then label substring and
// alias substring, gated to 3+ characters, then fuzzy, gated to 4+
// characters AND only as a fallback below 3 results. Ported from
// markdown-block-editor.html's own rank()/score(), with two departures: the
// fuzzy addition noted on fuzzyScore below, and the length gates on
// baseScore's substring tiers and on fuzzyScore, which the reference never
// had and which "ul" needs -- see baseScore's comment for the measured
// twelve-row menu that ungated substring matching produced.

function subsequence(hay, needle) {
    let i = 0;
    for (const ch of hay) {
        if (ch === needle[i]) {
            i++;
            if (i === needle.length) { return true; }
        }
    }
    return false;
}

/*
 * The precise tiers: exact, key prefix, label word-start, alias prefix --
 * then the two SUBSTRING tiers, gated to queries of 3+ characters.
 *
 * Ungated, "ul" scored Divider("rule" contains "ul"), Quote("pullquote"
 * contains "ul"), Warning callout, Equation, Inline math and six more
 * besides Bulleted list -- a two-letter query returning twelve rows because
 * "ul" is a substring of "rule" and "pullquote" is not a menu answering
 * anything. `includes` at 2 characters matches almost every label and every
 * alias list of any length; 3 is short enough to still catch "ref", "img",
 * "ol " and long enough that it stops matching on coincidence.
 */
function baseScore(block, q) {
    const key = block.key.toLowerCase();
    const label = block.label.toLowerCase();
    const aliases = block.aliases.map(a => a.toLowerCase());
    if (key === q || aliases.includes(q)) { return 100; }
    if (key.startsWith(q)) { return 90; }
    if (label.split(/\s+/).some(w => w.startsWith(q))) { return 80; }
    if (aliases.some(a => a.startsWith(q))) { return 70; }
    if (q.length >= 3 && label.includes(q)) { return 50; }
    if (q.length >= 3 && aliases.some(a => a.includes(q))) { return 40; }
    return 0;
}

/*
 * Fuzzy over the label AND its aliases, gated to queries of 4+ characters
 * AND only tried when the precise tiers above found FEWER THAN THREE
 * blocks -- see the call site in rankBlocks. Both gates exist for the same
 * reason the substring tiers are gated: a subsequence match gets looser as
 * the query shortens, so at three characters or fewer nearly every label in
 * a 30-entry registry contains SOME subsequence of it.
 *
 * The reference implementation (markdown-block-editor.html) only fuzzies
 * the label, but "mermid" -- a plausible typo of the diagram block's
 * "mermaid" alias, and the exact case this tier exists to catch -- has no
 * letter 'e' to match anywhere in the label "diagram", so label-only fuzzy
 * can never find it. Fuzzing the aliases too is what turns a typo of an
 * ALIAS into a hit.
 */
function fuzzyScore(block, q) {
    if (q.length < 4) { return 0; }
    const label = block.label.toLowerCase();
    const aliases = block.aliases.map(a => a.toLowerCase());
    return (subsequence(label, q) || aliases.some(a => subsequence(a, q))) ? 20 : 0;
}

/**
 * rankBlocks(query, { recent, blocks }) => [{ block, group, score }]
 *
 * `blocks` defaults to the full registry; callers filter it to what the
 * live schema supports (see blocksFor) before ranking, so this function
 * itself stays pure and needs no schema or DOM to test.
 */
function rankBlocks(query, opts) {
    const options = opts || {};
    const recent = options.recent || [];
    const pool = options.blocks || BLOCKS;
    const q = String(query || '').trim().toLowerCase();

    if (!q) {
        return pool
            .map(block => ({ block, group: recent.includes(block.key) ? 'Recent' : block.group, score: 0 }))
            .sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) ||
                (x.group === 'Recent' ? recent.indexOf(x.block.key) - recent.indexOf(y.block.key) : 0));
    }

    const recentRank = key => { const i = recent.indexOf(key); return i === -1 ? Infinity : i; };
    const precise = pool
        .map(block => ({ block, group: block.group, score: baseScore(block, q) }))
        .filter(row => row.score > 0);

    /*
     * Fuzzy is a FALLBACK, not another tier stacked on every query: it only
     * runs when the precise tiers above left the menu with fewer than three
     * rows, and only over the blocks those tiers did not already place --
     * "mermid" reaches Diagram this way without also loosening "todo" or
     * "equation", which already have a precise answer and never touch this.
     */
    let rows = precise;
    if (precise.length < 3 && q.length >= 4) {
        const placed = new Set(precise.map(row => row.block));
        const fuzzy = pool
            .filter(block => !placed.has(block))
            .map(block => ({ block, group: block.group, score: fuzzyScore(block, q) }))
            .filter(row => row.score > 0);
        rows = precise.concat(fuzzy);
    }

    return rows.sort((x, y) => y.score - x.score ||
        GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) ||
        recentRank(x.block.key) - recentRank(y.block.key) ||
        pool.indexOf(x.block) - pool.indexOf(y.block));
}

module.exports = { BLOCKS, GROUP_ORDER, isBlockAvailable, blocksFor, rankBlocks };
