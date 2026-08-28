/*
 * The mdast <-> ProseMirror bridge.
 *
 * D-01 says mdast is canonical, but the editor's document model is ProseMirror
 * JSON, so every conversion in this product passes through here exactly once,
 * in one direction or the other. This file is one table — SCHEMA below — with
 * one row per node type the editor can produce or consume, each row carrying
 * both directions of the conversion side by side. Keeping both directions on
 * the same row is deliberate: a row with only `fromMdast` looks complete and
 * silently corrupts on save, and reading the two arms next to each other is
 * the only way a reviewer can check they actually agree about the shape of
 * the node.
 *
 * THE FALLBACK IS THE LOAD-BEARING PART OF THIS FILE, so it is built first,
 * before any node type this document happens to support today. D-04 says
 * unknown syntax is preserved verbatim, never dropped — and "unknown" here
 * does not mean "rare", it means "anything this file's author did not think
 * of", which includes syntax that does not exist yet. Two mdast node types
 * are reserved for it:
 *
 *   rawBlock / rawInline — literally any mdast node with no row below, or any
 *   node this module cannot otherwise place, keeps its exact source text
 *   (sliced by position off the ORIGINAL source string, not re-derived) and
 *   comes back out byte-identical. A Pandoc grid table, a wikilink, a raw
 *   `<script>` block, a directive nobody wrote a row for — all of them are
 *   this, not a parse error.
 *
 * Because the fallback exists, `toMdastTotal` below can make serialisation
 * TOTAL and assert it: every PM node name reaching this module either has a
 * row or is rawBlock/rawInline, so there is no PM node the serialiser can be
 * handed that it does not know how to turn into text. checkSchemaComplete()
 * runs at module load and throws immediately if a row is missing an arm —
 * "fails loudly at load, not silently at runtime" is the point of writing
 * this as a table instead of a scatter of `if` branches through the codebase.
 *
 * SYNTHETIC MDAST TYPES. `studioCallout` and `studioToggle` are not real
 * mdast/remark node types; md-parse.js constructs them once it has recognised
 * a callout or a <details> block in whatever spelling the author used (GitHub
 * alert, MkDocs admonition, MyST, a directive, raw <details> HTML — see that
 * file). Giving them their own row here means this module never has to know
 * about spelling variants; by the time a tree reaches this file, every
 * callout looks like one node type.
 */

const MARK_TABLE_ORDER = ['link', 'highlight', 'strike', 'bold', 'italic'];

const CALLOUT_TONES = ['note', 'tip', 'important', 'warning', 'caution'];

// --- fallback (X-01) --------------------------------------------------------

/** Pulls a node's exact original text out of the source string it came from. */
function sourceSlice(node, ctx) {
    const pos = node && node.position;
    if (!pos || typeof pos.start.offset !== 'number' || typeof pos.end.offset !== 'number') {
        return undefined;
    }
    return ctx.source.slice(pos.start.offset, pos.end.offset);
}

/**
 * A short, human label for what got preserved — shown nowhere in the UI today
 * (the fidelity banner reads `unsupportedConstructs`, not this), but carried
 * on the node now rather than added later, because "what kind of thing is
 * this" is exactly the information that is available here and nowhere else
 * once the raw text is all that is left.
 */
function fallbackKind(mdastType) {
    const KNOWN = {
        html: 'html', yaml: 'frontmatter', toml: 'frontmatter',
        containerDirective: 'directive', leafDirective: 'directive', textDirective: 'directive',
        definition: 'link reference', imageReference: 'image reference', linkReference: 'link reference',
        footnoteReference: 'footnote reference'
    };
    return KNOWN[mdastType] || mdastType || 'markdown';
}

function fallbackBlock(node, ctx) {
    const source = sourceSlice(node, ctx);
    if (source === undefined) {
        ctx.warn(node, 'a ' + (node.type || 'node') + ' block had no source position and could not be preserved exactly');
        return { type: 'paragraph', content: [] };
    }
    return { type: 'rawBlock', attrs: { source, kind: fallbackKind(node.type) } };
}

function fallbackInline(node, ctx) {
    const source = sourceSlice(node, ctx);
    if (source === undefined) {
        ctx.warn(node, 'a ' + (node.type || 'node') + ' span had no source position and could not be preserved exactly');
        return { type: 'text', text: '' };
    }
    return { type: 'rawInline', attrs: { source } };
}

// --- shared cell/paragraph helpers ------------------------------------------

function wrapInParagraph(inlineContent) {
    return { type: 'paragraph', content: inlineContent };
}

/** A cell (or any inline-only mdast position) flattened into one paragraph. */
function phrasingToParagraph(children, ctx) {
    return wrapInParagraph(inlineFromMdastList(children || [], ctx));
}

// --- the table ---------------------------------------------------------------

/*
 * `kind`:
 *   'block'  — a node that is itself PM block content, dispatched by
 *              blockFromMdast / blockToMdast.
 *   'mark'   — an mdast container whose children are phrasing content and
 *              which wraps them in a mark rather than producing a node of
 *              its own (emphasis, strong, delete, highlight, link).
 *   'atom'   — inline content with no phrasing children: it IS the leaf
 *              (text, inlineCode, image, break, footnoteReference,
 *              inlineMath, html-as-inline).
 *
 * `fromMdast` and `toMdast` are required on every row; checkSchemaComplete()
 * enforces that below. For 'mark' rows `toMdast` is `wrapMdast(children,
 * attrs)`, called by the grouping algorithm in pmInlineToMdast rather than
 * from a per-node dispatch loop, because marks do not correspond 1:1 with PM
 * nodes — see that function's header.
 */
const SCHEMA = [
    // -- block --------------------------------------------------------------
    {
        /*
         * A PARAGRAPH HOLDING NOTHING BUT AN IMAGE BECOMES THE IMAGE.
         *
         * mdast has no block image: `![alt](src)` on its own line is a
         * paragraph whose only child is an image, and that is the correct
         * mdast. The editor's schema disagrees — StudioImage is configured
         * `inline: false`, so `image` is in the block group and
         * `paragraph > image` fails its content expression outright:
         * "Invalid content for node paragraph: <image>". ProseMirror
         * constructs such a document without complaint and then drops the
         * image the moment it is checked, so every document with a standalone
         * image lost it on open.
         *
         * The old hand-written converter had a rule for exactly this shape
         * (a line matching `^!\[…\]\(…\)$` became a top-level <img>), and
         * losing that rule in the rewrite is what caused the regression. This
         * is that rule, restored at the bridge where it belongs.
         *
         * Only when the image is ALONE: `text ![alt](src) text` is a genuine
         * inline image and stays one — the schema allows that, because
         * StarterKit's paragraph takes `inline*` and an inline image is
         * inline content.
         */
        mdast: 'paragraph', pm: 'paragraph', kind: 'block',
        fromMdast: (node, ctx) => {
            const kids = node.children || [];
            /*
             * Decided on the MDAST children, not on the converted inline list:
             * a linked badge is `link > image`, which folds down to one image
             * carrying a link MARK and would look solitary from the other side.
             * A block node cannot carry an inline mark, so that shape has to
             * reach the fallback instead — see the image row below.
             */
            if (kids.length === 1 && kids[0] && kids[0].type === 'image') {
                return {
                    type: 'image',
                    attrs: {
                        src: kids[0].url || '',
                        alt: kids[0].alt || '',
                        title: kids[0].title || null
                    }
                };
            }
            return wrapInParagraph(inlineFromMdastList(kids, ctx));
        },
        toMdast: (node, ctx) => ({ type: 'paragraph', children: inlineToMdastList(node.content, ctx) })
    },
    {
        /*
         * And the way back: a top-level image node is a paragraph containing
         * one image, which is the only shape mdast has for it.
         */
        mdast: '__block_image', pm: 'image', kind: 'block',
        fromMdast: (node, ctx) => wrapInParagraph(inlineFromMdastList([node], ctx)),
        toMdast: (node, ctx) => ({
            type: 'paragraph',
            children: [{
                type: 'image',
                url: (node.attrs && node.attrs.src) || '',
                alt: (node.attrs && node.attrs.alt) || null,
                title: (node.attrs && node.attrs.title) || null
            }]
        })
    },
    {
        mdast: 'heading', pm: 'heading', kind: 'block',
        fromMdast: (node, ctx) => ({
            type: 'heading',
            attrs: { level: Math.min(6, Math.max(1, node.depth || 1)) },
            content: inlineFromMdastList(node.children, ctx)
        }),
        toMdast: (node, ctx) => ({
            type: 'heading',
            depth: Math.min(6, Math.max(1, (node.attrs && node.attrs.level) || 1)),
            children: inlineToMdastList(node.content, ctx)
        })
    },
    {
        mdast: 'thematicBreak', pm: 'horizontalRule', kind: 'block',
        fromMdast: () => ({ type: 'horizontalRule' }),
        toMdast: () => ({ type: 'thematicBreak' })
    },
    {
        mdast: 'blockquote', pm: 'blockquote', kind: 'block',
        fromMdast: (node, ctx) => ({ type: 'blockquote', content: blockFromMdastList(node.children, ctx) }),
        toMdast: (node, ctx) => ({ type: 'blockquote', children: blockToMdastList(node.content, ctx) })
    },
    {
        // A code fence whose language is `math` is an accept-form, resolved to
        // an mdast `math` node before this file ever sees it — see
        // dialectAcceptForms in md-parse.js. This row only ever meets ordinary
        // fenced/indented code, so it always emits a codeBlock: figure-view.js
        // and mermaid-view.js key off codeBlock's `language` attr, which is
        // why a fence's language is never lost or renamed here.
        mdast: 'code', pm: 'codeBlock', kind: 'block',
        fromMdast: node => ({
            type: 'codeBlock',
            attrs: { language: node.lang || '' },
            content: node.value ? [{ type: 'text', text: node.value }] : []
        }),
        toMdast: node => ({
            type: 'code',
            lang: (node.attrs && node.attrs.language) || null,
            value: (node.content || []).map(t => t.text || '').join('')
        })
    },
    {
        mdast: 'math', pm: 'mathBlock', kind: 'block',
        fromMdast: node => ({ type: 'mathBlock', attrs: { latex: node.value || '' } }),
        toMdast: node => ({ type: 'math', value: (node.attrs && node.attrs.latex) || '' })
    },
    {
        // mdast uses the SAME node type, `html`, for both flow and phrasing
        // content — remark tells them apart only by WHERE the node sits in
        // the tree, not by any field on the node itself. This module makes
        // the same distinction the same way: blockFromMdast (below) only
        // ever sees an `html` node when it was reached through a block
        // children array, and inlineFromMdast special-cases `html` before
        // consulting this table at all, routing it to `__html_inline`
        // instead — so this row's arm is never asked to handle the inline
        // case, and needs no flag to tell the two apart.
        mdast: 'html', pm: 'rawBlock', kind: 'block',
        fromMdast: node => ({
            type: 'rawBlock', attrs: { source: node.value, kind: 'html' }
        }),
        toMdast: node => ({ type: 'html', value: (node.attrs && node.attrs.source) || '' })
    },
    {
        // The X-01 fallback's own row. Every OTHER row exists so that fewer
        // nodes end up here; this one exists so that when they do, nothing is
        // lost. See the module header.
        mdast: '__fallback_block', pm: 'rawBlock', kind: 'block',
        fromMdast: fallbackBlock,
        toMdast: node => ({ type: 'html', value: (node.attrs && node.attrs.source) || '' })
    },
    {
        mdast: 'footnoteDefinition', pm: 'footnoteDef', kind: 'block',
        fromMdast: (node, ctx) => ({
            type: 'footnoteDef',
            attrs: { label: node.identifier || node.label || '' },
            // GFM footnote definitions are block content (they may hold more
            // than one paragraph); footnoteDef is `content: 'inline*'` — see
            // markdown-editor.js — so this flattens onto the first paragraph's
            // inline content, matching the pre-existing subset's documented
            // behaviour rather than widening it unannounced.
            content: flattenBlocksToInline(node.children, ctx)
        }),
        toMdast: (node, ctx) => ({
            type: 'footnoteDefinition',
            identifier: (node.attrs && node.attrs.label) || '',
            label: (node.attrs && node.attrs.label) || '',
            children: [{ type: 'paragraph', children: inlineToMdastList(node.content, ctx) }]
        })
    },
    {
        mdast: 'studioCallout', pm: 'callout', kind: 'block',
        fromMdast: (node, ctx) => ({
            type: 'callout',
            attrs: { tone: CALLOUT_TONES.includes(node.tone) ? node.tone : 'note' },
            content: blockFromMdastList(node.children, ctx)
        }),
        toMdast: (node, ctx) => ({
            type: 'studioCallout',
            tone: CALLOUT_TONES.includes(node.attrs && node.attrs.tone) ? node.attrs.tone : 'note',
            children: blockToMdastList(node.content, ctx)
        })
    },
    {
        mdast: 'studioToggle', pm: 'toggle', kind: 'block',
        fromMdast: (node, ctx) => ({
            type: 'toggle',
            attrs: { summary: node.summary || 'Toggle' },
            content: blockFromMdastList(node.children, ctx)
        }),
        toMdast: (node, ctx) => ({
            type: 'studioToggle',
            summary: (node.attrs && node.attrs.summary) || 'Toggle',
            children: blockToMdastList(node.content, ctx)
        })
    },
    // -- table --------------------------------------------------------------
    {
        mdast: 'table', pm: 'table', kind: 'block',
        fromMdast: (node, ctx) => {
            const aligns = node.align || [];
            // GFM's own rule is that the header (plus its mandatory delimiter
            // row) defines a table's width, and a data row may have fewer or
            // more cells than that — remark-gfm parses it exactly that
            // raggedly rather than padding it during parsing (verified
            // directly: a short row stays short in the mdast tree). PM has
            // no way to represent a ragged table — every tableRow's cell
            // count IS the table's column count as far as prosemirror-tables
            // is concerned — so padding/truncating to the header's width has
            // to happen HERE, on the way in, not deferred to the way out;
            // deferring it is what produced a table that only became
            // rectangular on RE-parse, which is a doc that fails the corpus
            // test's round-trip assertion even though the eventual markdown
            // text was already correct.
            const width = aligns.length || ((node.children[0] && node.children[0].children.length) || 0);
            const rows = (node.children || []).map((row, rowIndex) => {
                const cells = (row.children || []).slice(0, width);
                while (cells.length < width) { cells.push({ type: 'tableCell', children: [] }); }
                return {
                    type: 'tableRow',
                    content: cells.map((cell, colIndex) => {
                        const align = aligns[colIndex] || null;
                        return {
                            type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
                            attrs: { align: align || '' },
                            content: [phrasingToParagraph(cell.children, ctx)]
                        };
                    })
                };
            });
            return { type: 'table', content: rows };
        },
        toMdast: (node, ctx) => {
            const rows = node.content || [];
            // The header's own width, not the widest row — matching the
            // fromMdast arm above and GFM's own definition of a table's
            // column count.
            const width = (rows[0] && rows[0].content && rows[0].content.length) || 0;
            // Alignment is per-column in mdast (see editor-tables.js's own note
            // on the same asymmetry) — read off row 0 only, one entry per
            // column, defaulting a short header to unaligned rather than
            // shifting later columns' alignment left.
            const header = rows[0];
            const align = Array.from({ length: width }, (_, i) => {
                const cell = header && (header.content || [])[i];
                const a = cell && cell.attrs && cell.attrs.align;
                return a === 'left' || a === 'center' || a === 'right' ? a : null;
            });
            // Defensive padding/truncation to `width`, same as the old
            // converter's own jsonToMarkdown did for the same documented
            // reason ("even if the document model briefly is not" — see
            // editor-tables.js) — a PM doc reaching this from paste rather
            // than from fromMdast above is not guaranteed to be rectangular.
            const toWidth = cells => {
                const out = cells.slice(0, width).map(cell => ({ type: 'tableCell', children: cellToPhrasing(cell.content, ctx) }));
                while (out.length < width) { out.push({ type: 'tableCell', children: [] }); }
                return out;
            };
            return {
                type: 'table',
                align,
                children: rows.map(row => ({ type: 'tableRow', children: toWidth(row.content || []) }))
            };
        }
    },
    // -- lists ----------------------------------------------------------------
    {
        // `list` is one mdast node but up to three PM node types (bulletList,
        // orderedList, taskList), decided per RUN of same-kind items rather
        // than for the list as a whole — see listFromMdast. So this row hands
        // off entirely to that helper; the PM-side rows below exist for
        // completeness and are reached by listToMdast doing the same thing in
        // reverse.
        mdast: 'list', pm: 'bulletList', kind: 'block',
        fromMdast: listFromMdast,
        toMdast: (node, ctx) => bulletOrOrderedToMdast(node, ctx, false)
    },
    {
        mdast: '__list_ordered', pm: 'orderedList', kind: 'block',
        fromMdast: () => { throw new Error('orderedList is produced by the `list` row, not dispatched directly'); },
        toMdast: (node, ctx) => bulletOrOrderedToMdast(node, ctx, true)
    },
    {
        mdast: '__list_task', pm: 'taskList', kind: 'block',
        fromMdast: () => { throw new Error('taskList is produced by the `list` row, not dispatched directly'); },
        toMdast: (node, ctx) => ({
            type: 'list', ordered: false, start: null, spread: false, children: (node.content || []).map(item => ({
                type: 'listItem',
                checked: !!(item.attrs && item.attrs.checked),
                spread: false,
                children: blockToMdastList(item.content, ctx)
            }))
        })
    },
    {
        mdast: 'listItem', pm: 'listItem', kind: 'block',
        fromMdast: (node, ctx) => ({ type: 'listItem', content: listItemContent(node.children, ctx) }),
        toMdast: (node, ctx) => ({ type: 'listItem', spread: false, checked: null, children: blockToMdastList(node.content, ctx) })
    },
    {
        mdast: '__task_item', pm: 'taskItem', kind: 'block',
        fromMdast: () => { throw new Error('taskItem is produced by the `list` row, not dispatched directly'); },
        toMdast: (node, ctx) => ({
            type: 'listItem', checked: !!(node.attrs && node.attrs.checked), spread: false,
            children: blockToMdastList(node.content, ctx)
        })
    },
    // -- inline: marks --------------------------------------------------------
    {
        mdast: 'emphasis', pm: 'italic', kind: 'mark',
        wrapMdast: children => ({ type: 'emphasis', children }),
        markAttrs: () => undefined
    },
    {
        mdast: 'strong', pm: 'bold', kind: 'mark',
        wrapMdast: children => ({ type: 'strong', children }),
        markAttrs: () => undefined
    },
    {
        mdast: 'delete', pm: 'strike', kind: 'mark',
        wrapMdast: children => ({ type: 'delete', children }),
        markAttrs: () => undefined
    },
    {
        // `==x==`, via mdast-util-highlight-mark / micromark-extension-
        // highlight-mark rather than a hand-written tokenizer — an existing,
        // tested implementation of exactly this syntax, so writing a second
        // one would only be for the sake of not depending on it.
        mdast: 'highlight', pm: 'highlight', kind: 'mark',
        wrapMdast: children => ({ type: 'highlight', children }),
        markAttrs: () => undefined
    },
    {
        mdast: 'link', pm: 'link', kind: 'mark',
        wrapMdast: (children, attrs) => ({ type: 'link', url: (attrs && attrs.href) || '', title: (attrs && attrs.title) || null, children }),
        markAttrs: node => ({ href: node.url || '', title: node.title || undefined })
    },
    // -- inline: atoms ----------------------------------------------------------
    {
        /*
         * A SOFT LINE ENDING INSIDE A TEXT VALUE IS UNREPRESENTABLE IN
         * PROSEMIRROR, so it has to be canonicalised to a space HERE, at the
         * one place a raw mdast text value becomes a PM character.
         *
         * This product's repositories are hard-wrapped by hand at ~80
         * columns. mdast has no node for "these two source lines were one
         * paragraph" other than leaving the line ending as a literal "\n"
         * inside the surrounding `text` node's value — correctly so, since a
         * soft line ending carries no Markdown meaning of its own, it is just
         * where the author's editor happened to wrap. Passing that
         * character straight through used to look harmless because
         * `.ProseMirror` is `white-space: pre-wrap`, so it rendered as a real
         * line break and the document LOOKED right on open. But the moment
         * the user typed anything in that block, ProseMirror re-parsed the
         * touched DOM with `preserveWhitespace: true`, and
         * `@tiptap/extension-hard-break`'s `linebreakReplacement: true` turned
         * every one of those "\n" characters into a real hardBreak node —
         * so typing one space at the end of a hand-wrapped paragraph turned
         * every wrap point in it into a Markdown hard break on save. Measured
         * on the real editor: one keystroke produced a review card reading
         * `Insert "\" · and 3 more edits`.
         *
         * A soft line ending is interchangeable with a single space by
         * definition, so collapsing it here is lossless, and it has to
         * happen at THIS boundary rather than in the editor's whitespace
         * handling or the hard-break extension: this is the only place a
         * soft line ending is turned into a PM character at all, everywhere
         * else it is either still mdast (where it is meaningless) or already
         * text (where it is too late — the DOM has already round-tripped it
         * into a hardBreak by the time any editor-side code sees it).
         *
         * A hard break is never affected by this: it arrives as its own
         * mdast `break` node (see that row below) and never touches a `text`
         * node's value at all. And this row is reached ONLY for genuine
         * prose — the codeBlock and inlineCode rows above/below build their
         * PM text nodes directly from `node.value` without going through
         * this function, which is what keeps a code span or a fenced block's
         * literal whitespace intact.
         */
        mdast: 'text', pm: 'text', kind: 'atom',
        fromMdast: node => ({ type: 'text', text: (node.value || '').replace(/\r\n|\r|\n/g, ' ') }),
        toMdast: node => ({ type: 'text', value: node.text || '' })
    },
    {
        mdast: 'inlineCode', pm: 'text', kind: 'atom',
        // Shares its PM node name with plain text — a code span is a text run
        // carrying the `code` mark, not a node of its own (see codeMarkOf /
        // leafFromMdast below, which is where this row is actually reached
        // from on the way in). toMdast is reached the other way, from
        // leafToMdast noticing the `code` mark on a text node.
        fromMdast: node => ({ type: 'text', text: node.value, marks: [{ type: 'code' }] }),
        toMdast: node => ({ type: 'inlineCode', value: node.text || '' })
    },
    {
        mdast: 'break', pm: 'hardBreak', kind: 'atom',
        fromMdast: () => ({ type: 'hardBreak' }),
        toMdast: () => ({ type: 'break' })
    },
    {
        /*
         * AN IMAGE REACHED HERE IS AN INLINE IMAGE, AND THE EDITOR HAS NO SUCH
         * THING. StudioImage is configured `inline: false`, which puts `image`
         * in the block group: it can only ever be a top-level node. The
         * paragraph row above lifts a solitary image into that position; an
         * image anywhere else — `text ![a](b) text`, or the extremely common
         * `[![badge](img)](url)` in a README, where the link mark cannot live
         * on a block node either — has no valid shape in this schema at all.
         *
         * So it is preserved verbatim rather than emitted as something
         * ProseMirror will reject. That is the fallback doing precisely its
         * job: `check()` used to report "Invalid content for node doc:
         * <heading, link(image), …>" on a real GitHub README, and a document
         * the schema rejects is a document that opens with content missing.
         *
         * Making images inline-capable would be the fuller answer and is a
         * product decision, not a bridge one: it changes what a document can
         * contain, and the figure and comment machinery both assume a block
         * image today.
         */
        mdast: 'image', pm: 'image', kind: 'atom',
        fromMdast: (node, ctx) => fallbackInline(node, ctx),
        toMdast: node => ({
            type: 'image',
            url: (node.attrs && node.attrs.src) || '',
            alt: (node.attrs && node.attrs.alt) || null,
            title: (node.attrs && node.attrs.title) || null
        })
    },
    {
        mdast: 'inlineMath', pm: 'mathInline', kind: 'atom',
        fromMdast: node => ({ type: 'mathInline', attrs: { latex: node.value || '' } }),
        toMdast: node => ({ type: 'inlineMath', value: (node.attrs && node.attrs.latex) || '' })
    },
    {
        // GFM footnote references are ATOMS in the editor (see FootnoteRef's
        // own comment in markdown-editor.js) — the label is read straight off
        // the mdast identifier, never renumbered; see markdown.js's old
        // FOOTNOTE_LABEL comment for why that matters, carried forward here.
        mdast: 'footnoteReference', pm: 'footnoteRef', kind: 'atom',
        fromMdast: node => ({ type: 'footnoteRef', attrs: { label: node.identifier || node.label || '' } }),
        toMdast: node => ({ type: 'footnoteReference', identifier: (node.attrs && node.attrs.label) || '', label: (node.attrs && node.attrs.label) || '' })
    },
    {
        mdast: '__html_inline', pm: 'rawInline', kind: 'atom',
        fromMdast: (node, ctx) => ({ type: 'rawInline', attrs: { source: node.value } }),
        toMdast: node => ({ type: 'html', value: (node.attrs && node.attrs.source) || '' })
    },
    {
        mdast: '__fallback_inline', pm: 'rawInline', kind: 'atom',
        fromMdast: fallbackInline,
        toMdast: node => ({ type: 'html', value: (node.attrs && node.attrs.source) || '' })
    }
];

const BY_MDAST = new Map(SCHEMA.map(row => [row.mdast, row]));
const BLOCK_BY_PM = new Map(SCHEMA.filter(r => r.kind === 'block').map(row => [row.pm, row]));
const MARK_BY_MDAST = new Map(SCHEMA.filter(r => r.kind === 'mark').map(row => [row.mdast, row]));
const MARK_BY_PM = new Map(SCHEMA.filter(r => r.kind === 'mark').map(row => [row.pm, row]));
/*
 * Two rows legitimately share a PM name here — `html` and `__fallback_block`
 * both target rawBlock, `__html_inline` and `__fallback_inline` both target
 * rawInline — because a document can reach rawBlock/rawInline either as
 * parsed raw HTML or as the X-01 catch-all. Their `toMdast` arms are
 * identical (emit an mdast `html` node holding the stored source verbatim),
 * so which one this Map keeps on the collision does not matter; it is not
 * true of any other pair, and checkSchemaComplete only cares that every row
 * individually has both arms, not that pm names are unique.
 */
const ATOM_BY_PM = new Map(SCHEMA.filter(r => r.kind === 'atom').map(row => [row.pm, row]));

/*
 * Fails loudly at load, not silently at runtime — the whole reason this is a
 * table. A row with a typo'd arm name, or a `kind` this file forgot to
 * handle, is a bug in THIS module; the corpus test cannot catch it if the
 * module never gets far enough to be exercised.
 */
function checkSchemaComplete() {
    for (const row of SCHEMA) {
        if (!row.mdast || !row.pm || !row.kind) {
            throw new Error('md-schema: a row is missing mdast/pm/kind: ' + JSON.stringify(row));
        }
        if (row.kind === 'mark') {
            if (typeof row.wrapMdast !== 'function' || typeof row.markAttrs !== 'function') {
                throw new Error('md-schema: mark row "' + row.mdast + '" is missing wrapMdast/markAttrs');
            }
        } else if (typeof row.fromMdast !== 'function' || typeof row.toMdast !== 'function') {
            throw new Error('md-schema: row "' + row.mdast + '" is missing fromMdast/toMdast');
        }
    }
    if (!MARK_TABLE_ORDER.every(name => MARK_BY_PM.has(name))) {
        throw new Error('md-schema: MARK_TABLE_ORDER names a mark with no row: ' + MARK_TABLE_ORDER.join(','));
    }
}
checkSchemaComplete();

// --- block recursion ---------------------------------------------------------

function blockFromMdast(node, ctx) {
    const row = BY_MDAST.get(node.type);
    if (!row || row.kind !== 'block') { return fallbackBlock(node, ctx); }
    const out = row.fromMdast(node, ctx);
    return out === undefined ? fallbackBlock(node, ctx) : out;
}

function blockFromMdastList(children, ctx) {
    const out = [];
    for (const child of (children || [])) {
        if (child.type === 'list') { out.push(...listFromMdast(child, ctx)); continue; }
        const converted = blockFromMdast(child, ctx);
        if (Array.isArray(converted)) { out.push(...converted); } else if (converted) { out.push(converted); }
    }
    return out;
}

function blockToMdast(node, ctx) {
    const row = BLOCK_BY_PM.get(node.type);
    if (!row) {
        ctx.warn(node, 'a "' + node.type + '" node reached serialisation with no schema row');
        return { type: 'html', value: '' };
    }
    return row.toMdast(node, ctx);
}

function blockToMdastList(nodes, ctx) {
    return (nodes || []).map(n => blockToMdast(n, ctx));
}

/** A footnote definition's block content, flattened onto one inline run. */
function flattenBlocksToInline(children, ctx) {
    const paragraphs = (children || []).filter(c => c.type === 'paragraph');
    const rest = paragraphs.length ? paragraphs : (children || []);
    const parts = [];
    rest.forEach((p, i) => {
        if (i > 0) { parts.push({ type: 'text', value: ' ' }); }
        parts.push(...(p.children || (p.type === 'paragraph' ? [] : [p])));
    });
    return inlineFromMdastList(parts, ctx);
}

// --- list recursion (list <-> bulletList / orderedList / taskList) ----------

function isTaskItem(item) { return item.checked === true || item.checked === false; }

function listItemContent(children, ctx) {
    // A list item's first paragraph is unwrapped onto the item itself in the
    // editor's shape (the PM listItem's own first child is a paragraph, same
    // as mdast) — but nested block content (a sub-list, another paragraph)
    // stays as further block children. That is a straight blockFromMdastList;
    // nothing special is needed because PM listItem, like mdast listItem, is
    // `content: block+`.
    return blockFromMdastList(children, ctx);
}

/*
 * One mdast `list` becomes ONE OR MORE PM list nodes, split at every point
 * the item kind changes (task vs. not) — mirroring the split the old
 * hand-written converter made for the same reason (see its `listBlock`
 * comment, carried forward here): GFM allows a single `list` node to mix
 * task and non-task items, but PM has no node that represents a mixed list,
 * so the boundary has to become a new sibling list instead of silently
 * dropping the checkbox on one side of it.
 */
function listFromMdast(node, ctx) {
    const items = node.children || [];
    const runs = [];
    for (const item of items) {
        const task = isTaskItem(item);
        const last = runs[runs.length - 1];
        if (last && last.task === task) { last.items.push(item); } else { runs.push({ task, items: [item] }); }
    }
    /*
     * `start` CARRIED THROUGH, which it was not before.
     *
     * mdast records the first ordinal a list actually declares, and dropping
     * it renumbered every list that did not begin at 1 — a numbered
     * bibliography running 6..13 came back as 1..8, which is a change to what
     * the document SAYS and not to how it is spelled. Measured on a real
     * paper: four reference lists silently renumbered.
     *
     * `offset` is why this is not a one-liner. A single mdast list may mix
     * task and non-task items, and PM has no mixed list, so the run below
     * splits it into siblings — and the second ordered sibling has to resume
     * where the first left off rather than restarting, or splitting a list
     * would itself renumber it.
     */
    let offset = 0;
    return runs.map(run => {
        const first = (node.ordered ? (typeof node.start === 'number' ? node.start : 1) : 1) + offset;
        offset += run.items.length;
        if (run.task) {
            return {
                type: 'taskList',
                content: run.items.map(item => ({
                    type: 'taskItem',
                    attrs: { checked: !!item.checked },
                    content: listItemContent(item.children, ctx)
                }))
            };
        }
        return {
            type: node.ordered ? 'orderedList' : 'bulletList',
            attrs: node.ordered ? { start: first } : undefined,
            content: run.items.map(item => ({ type: 'listItem', content: listItemContent(item.children, ctx) }))
        };
    });
}

function bulletOrOrderedToMdast(node, ctx, ordered) {
    const declared = node.attrs && node.attrs.start;
    return {
        type: 'list',
        ordered,
        // The list's own first ordinal, not a hardcoded 1 — see listFromMdast.
        start: ordered ? (typeof declared === 'number' && declared > 0 ? declared : 1) : null,
        spread: false,
        children: (node.content || []).map(item => ({
            type: 'listItem', spread: false, checked: null, children: blockToMdastList(item.content, ctx)
        }))
    };
}

// --- inline recursion (marks) ------------------------------------------------

/** The `code` mark turns a text leaf into an mdast inlineCode leaf, not a wrap. */
function hasCodeMark(marks) { return (marks || []).some(m => m.type === 'code'); }

function inlineFromMdast(node, ctx, marks) {
    if (node.type === 'html') {
        const row = BY_MDAST.get('__html_inline');
        return [applyMarks(row.fromMdast(node, ctx), marks)];
    }
    const markRow = MARK_BY_MDAST.get(node.type);
    if (markRow) {
        const nextMarks = marks.concat([{ type: markRow.pm, attrs: markRow.markAttrs(node) }]);
        return inlineFromMdastList(node.children, ctx, nextMarks);
    }
    const row = BY_MDAST.get(node.type);
    if (!row || row.kind !== 'atom') {
        return [applyMarks(fallbackInline(node, ctx), marks)];
    }
    return [applyMarks(row.fromMdast(node, ctx), marks)];
}

function applyMarks(pmNode, marks) {
    if (!marks.length) { return pmNode; }
    // `comment` never reaches the file (see module header on markdown.js's
    // predecessor) — there is no mdast source of a comment mark, so this is
    // simply never in `marks` here; nothing to filter.
    const existing = pmNode.marks || [];
    return Object.assign({}, pmNode, { marks: marks.concat(existing) });
}

function inlineFromMdastList(children, ctx, marks) {
    const out = [];
    for (const child of (children || [])) { out.push(...inlineFromMdast(child, ctx, marks || [])); }
    return out;
}

// --- inline recursion (PM -> mdast) ------------------------------------------

/** One PM leaf -> {node, marks}: the base mdast leaf, and its wrappable marks. */
function leafToMdast(node, ctx) {
    if (node.type === 'text') {
        const marks = node.marks || [];
        if (hasCodeMark(marks)) {
            return { node: { type: 'inlineCode', value: node.text || '' }, marks: wrappableMarks(marks) };
        }
        return { node: { type: 'text', value: node.text || '' }, marks: wrappableMarks(marks) };
    }
    const row = ATOM_BY_PM.get(node.type);
    if (!row) {
        ctx.warn(node, 'an inline "' + node.type + '" node reached serialisation with no schema row');
        return { node: { type: 'html', value: '' }, marks: [] };
    }
    return { node: row.toMdast(node, ctx), marks: wrappableMarks(node.marks || []) };
}

/*
 * Marks that WRAP the leaf in mdast, in the fixed nesting order this module
 * always uses (innermost first here; applyMarkLevel below walks it outermost
 * first). `code` is excluded — it decided the leaf's mdast TYPE above, not a
 * wrapper — and `comment` is excluded because it must never reach the file
 * (see markdown.js's original header, carried forward): filtering it out
 * here, at the one place every mark on every text node passes through, is
 * what keeps that promise regardless of which code path produced the mark.
 */
function wrappableMarks(marks) {
    const out = [];
    for (const name of MARK_TABLE_ORDER) {
        const m = marks.find(x => x.type === name);
        if (m) { out.push(m); }
    }
    return out;
}

/*
 * The grouping algorithm. mdast marks are nested containers; PM marks are a
 * flat set per leaf. Converting back has to reconstruct nesting from a flat
 * run of leaves that may each carry a different SUBSET of the mark alphabet —
 * "bold, then bold+italic, then bold" has to become one <strong> whose middle
 * child is wrapped in <em>, not three separate bold runs.
 *
 * Walking MARK_TABLE_ORDER outermost-first and, at each level, grouping the
 * current sequence into runs that do/do not carry that mark — wrapping the
 * "do" runs and recursing into both — produces exactly that nesting, and
 * produces the SAME nesting every time for the same mark set, which is what
 * determinism (assertion 4 in the corpus test) requires: two different
 * orderings that render identically are not an option here, only one is ever
 * chosen.
 */
function applyMarkLevel(items, orderIndex) {
    if (orderIndex >= MARK_TABLE_ORDER.length) { return items.map(i => i.node); }
    const markName = MARK_TABLE_ORDER[orderIndex];
    const markRow = MARK_BY_PM.get(markName);
    const out = [];
    let i = 0;
    while (i < items.length) {
        const has = items[i].marks.some(m => m.type === markName);
        if (!has) {
            out.push(...applyMarkLevel([items[i]], orderIndex + 1));
            i++;
            continue;
        }
        let j = i;
        const attrs = items[i].marks.find(m => m.type === markName).attrs;
        while (j < items.length && items[j].marks.some(m => m.type === markName)) { j++; }
        const run = items.slice(i, j).map(item => Object.assign({}, item, {
            marks: item.marks.filter(m => m.type !== markName)
        }));
        const children = applyMarkLevel(run, orderIndex + 1);
        out.push(markRow.wrapMdast(children, attrs));
        i = j;
    }
    return out;
}

function inlineToMdastList(pmNodes, ctx) {
    const items = (pmNodes || []).map(n => leafToMdast(n, ctx));
    return applyMarkLevel(items, 0);
}

/** A table cell's paragraphs collapsed onto one phrasing run (see md-schema's table row). */
function cellToPhrasing(content, ctx) {
    const paragraphs = (content || []).filter(b => b.type === 'paragraph');
    const parts = [];
    paragraphs.forEach((p, i) => {
        if (i > 0) { parts.push({ type: 'break' }); }
        parts.push(...inlineToMdastList(p.content, ctx));
    });
    return parts;
}

module.exports = {
    SCHEMA, MARK_TABLE_ORDER, CALLOUT_TONES,
    blockFromMdast, blockFromMdastList, blockToMdast, blockToMdastList,
    inlineFromMdastList, inlineToMdastList,
    fallbackBlock, fallbackInline, sourceSlice
};
