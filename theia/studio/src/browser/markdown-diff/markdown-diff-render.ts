// The rows of markdown-diff-model.ts as DOM: two cells per row, each block
// rendered by markdown-it, sanitised, and — for a block that was edited
// rather than replaced — the words that changed marked inside it.
//
// The word marks are placed on the RENDERED text, not on the source. The
// original extension diffed the markdown source and then tried to find those
// characters in the rendered HTML, which stops matching as soon as a block has
// any markup: `**bold**` is eight source characters and four rendered ones.
// Here both cells are rendered first, their text nodes are read in order, the
// two texts are diffed by words, and each changed range is wrapped where it
// lies, across element boundaries if it has to.
//
// The output is inserted into the IDE's own DOM rather than into a webview,
// so everything markdown-it produces goes through DOMPurify, with inline
// styles and form controls removed as well: a document must not be able to
// lay a fixed-position box over the workbench.

import * as markdownit from '@theia/core/shared/markdown-it';
import * as DOMPurify from '@theia/core/shared/dompurify';
import { diffWordsWithSpace } from 'diff';
import { FRONT_MATTER_KIND, MarkdownBlock, MarkdownDiffRow, ParsedMarkdown } from './markdown-diff-model';

export const MERMAID_PLACEHOLDER_CLASS = 'studio-md-diff-mermaid';

/** A block whose words changed by more than this is marked as a whole, not word by word. */
const WORD_MARK_LIMIT = 0.6;

/** Unchanged blocks kept around each change when unchanged runs are folded. */
export const FOLD_CONTEXT = 1;

export function createMarkdownRenderer(): markdownit {
    const md = markdownit({ html: true, linkify: true, typographer: false, breaks: false });
    const defaultFence = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim().split(/\s+/)[0] === 'mermaid') {
            // Rendered into a diagram later, by the widget (it needs the
            // mermaid bundle and the theme); until then, and if that fails,
            // the source shows.
            return `<div class="${MERMAID_PLACEHOLDER_CLASS}"><pre><code>${md.utils.escapeHtml(token.content)}</code></pre></div>`;
        }
        return defaultFence(tokens, index, options, env, self);
    };
    return md;
}

export function sanitizeHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['style'],
    });
}

export function renderBlockHtml(md: markdownit, block: MarkdownBlock, doc: ParsedMarkdown): string {
    if (block.kind === FRONT_MATTER_KIND) {
        return `<pre class="studio-md-diff-front-matter"><code>${md.utils.escapeHtml(block.source)}</code></pre>`;
    }
    return sanitizeHtml(md.renderer.render(block.tokens, md.options, doc.env));
}

/** Task-list items (`- [ ]`, `- [x]`) as boxes; markdown-it core leaves them as text. */
export function renderTaskBoxes(root: HTMLElement): void {
    for (const item of Array.from(root.querySelectorAll('li'))) {
        const first = firstTextNode(item);
        const match = first && /^\[([ xX])\]\s/.exec(first.data);
        if (!first || !match) {
            continue;
        }
        first.data = first.data.slice(match[0].length);
        const box = item.ownerDocument.createElement('span');
        box.className = 'studio-md-diff-task' + (match[1] === ' ' ? '' : ' done');
        box.textContent = match[1] === ' ' ? '☐' : '☑';
        first.parentNode!.insertBefore(box, first);
        item.classList.add('studio-md-diff-task-item');
    }
}

function firstTextNode(root: Node): Text | undefined {
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && !node.data.trim()) {
        node = walker.nextNode() as Text | null;
    }
    return node ?? undefined;
}

/** The text nodes that carry a block's words, in reading order. Diagrams are compared whole. */
function textNodes(root: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: node => (node.parentElement?.closest(`.${MERMAID_PLACEHOLDER_CLASS}`)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node as Text);
    }
    return nodes;
}

function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

interface Range {
    readonly start: number;
    readonly end: number;
}

/**
 * Mark the words that differ between two renderings of one edited block.
 *
 * @returns `'words'` when words were marked, `'whole'` when so much changed
 *   that the block is better read as rewritten, `'markup'` when the text is
 *   identical and only the markup differs (a link target, emphasis).
 */
export function markWordChanges(oldRoot: HTMLElement, newRoot: HTMLElement): 'words' | 'whole' | 'markup' {
    const oldNodes = textNodes(oldRoot);
    const newNodes = textNodes(newRoot);
    const oldText = oldNodes.map(node => node.data).join('');
    const newText = newNodes.map(node => node.data).join('');
    // Whitespace collapsed: a paragraph rewrapped at another width renders the
    // same words with a newline where a space was, and that is formatting.
    if (collapseWhitespace(oldText) === collapseWhitespace(newText)) {
        return 'markup';
    }
    const removed: Range[] = [];
    const added: Range[] = [];
    let changed = 0;
    let oldOffset = 0;
    let newOffset = 0;
    for (const part of coalesce(diffWordsWithSpace(oldText, newText))) {
        const length = part.value.length;
        if (part.removed) {
            removed.push({ start: oldOffset, end: oldOffset + length });
            oldOffset += length;
            changed += length;
        } else if (part.added) {
            added.push({ start: newOffset, end: newOffset + length });
            newOffset += length;
            changed += length;
        } else {
            oldOffset += length;
            newOffset += length;
        }
    }
    if (changed / (oldText.length + newText.length) > WORD_MARK_LIMIT) {
        return 'whole';
    }
    wrapRanges(oldNodes, removed, 'del', 'studio-md-diff-word removed');
    wrapRanges(newNodes, added, 'ins', 'studio-md-diff-word added');
    return 'words';
}

interface Part {
    readonly value: string;
    readonly added?: boolean;
    readonly removed?: boolean;
}

/**
 * Let a rewritten phrase read as one mark. A word diff of a rewritten clause
 * alternates changed words with the unchanged spaces between them, and marked
 * that way it reads as a row of separate boxes. Whitespace, or one short word,
 * kept between two changes is folded into both of them — the rule product-ext's
 * diff.js applies to its line view (coalesceParts).
 */
export function coalesce(parts: readonly Part[]): Part[] {
    const changed = (part: Part | undefined): boolean => !!part && (!!part.added || !!part.removed);
    const bridged: Part[] = [];
    parts.forEach((part, index) => {
        const text = part.value.trim();
        const bridge = !changed(part) && changed(parts[index - 1]) && changed(parts[index + 1])
            && (!text || (text.length <= 3 && !/\s/.test(text)));
        if (bridge) {
            bridged.push({ value: part.value, removed: true }, { value: part.value, added: true });
        } else {
            bridged.push(part);
        }
    });
    // Adjacent parts of one side join, so each mark is one element.
    const joined: Part[] = [];
    let removed = '';
    let added = '';
    const flush = (): void => {
        if (removed) {
            joined.push({ value: removed, removed: true });
        }
        if (added) {
            joined.push({ value: added, added: true });
        }
        removed = '';
        added = '';
    };
    for (const part of bridged) {
        if (part.removed) {
            removed += part.value;
        } else if (part.added) {
            added += part.value;
        } else {
            flush();
            joined.push(part);
        }
    }
    flush();
    return joined;
}

/** Wrap character ranges of the concatenated text of `nodes`, splitting nodes where a range starts or ends inside one. */
function wrapRanges(nodes: Text[], ranges: Range[], tag: 'ins' | 'del', className: string): void {
    let nodeStart = 0;
    let rangeIndex = 0;
    for (const node of nodes) {
        const nodeEnd = nodeStart + node.data.length;
        // Pieces of this node to wrap, collected first: splitting a node
        // while walking its offsets would move them.
        const pieces: Range[] = [];
        while (rangeIndex < ranges.length && ranges[rangeIndex].start < nodeEnd) {
            const range = ranges[rangeIndex];
            const start = Math.max(range.start, nodeStart) - nodeStart;
            const end = Math.min(range.end, nodeEnd) - nodeStart;
            if (end > start && node.data.slice(start, end).trim()) {
                pieces.push({ start, end });
            }
            if (range.end > nodeEnd) {
                break;
            }
            rangeIndex++;
        }
        for (const piece of pieces.reverse()) {
            const target = node.splitText(piece.start);
            target.splitText(piece.end - piece.start);
            const mark = node.ownerDocument.createElement(tag);
            mark.className = className;
            target.parentNode!.insertBefore(mark, target);
            mark.appendChild(target);
        }
        nodeStart = nodeEnd;
    }
}

export interface NoteMarks {
    /** Discussions whose passage is in a changed row — what a reader of the change should look at. */
    readonly onChanges: number;
    /** Discussions whose passage is on the left and gone from the right: the edit took their anchor. */
    readonly orphaned: number;
}

/**
 * Mark where open discussions are. Each cell whose text holds a note's quote
 * gets a badge naming it; a quote found only in the left column is the edit
 * taking the passage a discussion is about, which is the one thing a reader
 * of a change must not miss — that badge says the thread will lose its place.
 *
 * Run after renderDiff: the badges are not document text, and the word marks
 * are computed on document text.
 */
export function markNotes(root: HTMLElement, notes: ReadonlyArray<{ quote: string; label: string }>, rightLabel: string): NoteMarks {
    let onChanges = 0;
    let orphaned = 0;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.studio-md-diff-row'));
    const textOf = (cell: Element | null): string => collapseWhitespace(cell?.textContent ?? '');
    for (const note of notes) {
        const quote = collapseWhitespace(note.quote);
        if (!quote) {
            continue;
        }
        const inOld = rows.filter(row => textOf(row.querySelector('.studio-md-diff-cell.old')).includes(quote));
        const inNew = rows.filter(row => textOf(row.querySelector('.studio-md-diff-cell.new')).includes(quote));
        const lost = inOld.length > 0 && inNew.length === 0;
        if (lost) {
            orphaned++;
        }
        if ([...inOld, ...inNew].some(row => !row.classList.contains('equal'))) {
            onChanges++;
        }
        for (const row of inNew) {
            badge(row.querySelector('.studio-md-diff-cell.new')!, note.label, false, rightLabel);
        }
        for (const row of inOld) {
            badge(row.querySelector('.studio-md-diff-cell.old')!, note.label, lost, rightLabel);
        }
    }
    return { onChanges, orphaned };
}

function badge(cell: Element, label: string, lost: boolean, rightLabel: string): void {
    const element = cell.ownerDocument!.createElement('span');
    element.className = 'studio-md-diff-note' + (lost ? ' orphaned' : '');
    element.textContent = lost ? '\u{1F4AC}!' : '\u{1F4AC}';
    element.title = lost ? `${label}\n\nThis passage is not in ${rightLabel}: the discussion will lose its place.` : label;
    element.setAttribute('aria-label', element.title);
    cell.insertBefore(element, cell.firstChild);
}

export interface RenderOptions {
    /** Show only the changes and a little context, with each unchanged run folded into one line. */
    readonly changesOnly: boolean;
    /** Indices of folds the reader opened. */
    readonly expanded: ReadonlySet<number>;
}

export interface RenderedDiff {
    readonly root: HTMLElement;
    /** One element per changed row, in order, for navigation and the overview ruler. */
    readonly changes: HTMLElement[];
    /** Modified rows whose text is identical — only markup changed. */
    readonly formattingOnly: number;
}

/**
 * The header's one line about a comparison.
 *
 * Formatting-only rows are counted apart from real edits, because a document
 * two editors save in turn (the Documents editor and the WYSIWYG one, which
 * serialise markdown differently) differs in dozens of rows nobody changed,
 * and "18 changed" for one rewritten sentence reads as eighteen edits.
 */
export function describeChanges(
    counts: { modified: number; added: number; removed: number },
    formattingOnly: number,
    missing: readonly string[] = [],
    notes: NoteMarks = { onChanges: 0, orphaned: 0 },
): string {
    const edited = counts.modified - formattingOnly;
    const parts = [
        ...missing.map(label => `Not in ${label}`),
        edited > 0 ? `${edited} changed` : '',
        counts.added ? `${counts.added} added` : '',
        counts.removed ? `${counts.removed} removed` : '',
        formattingOnly ? `${formattingOnly} formatting only` : '',
        notes.onChanges ? `${notes.onChanges} ${notes.onChanges === 1 ? 'discussion' : 'discussions'} on changed text` : '',
        notes.orphaned ? `${notes.orphaned} would lose ${notes.orphaned === 1 ? 'its' : 'their'} place` : '',
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'No changes';
}

/** The whole comparison as a grid of rows. */
export function renderDiff(
    document: Document,
    md: markdownit,
    rows: readonly MarkdownDiffRow[],
    oldDoc: ParsedMarkdown,
    newDoc: ParsedMarkdown,
    options: RenderOptions,
): RenderedDiff {
    const root = document.createElement('div');
    root.className = 'studio-md-diff-grid';
    const changes: HTMLElement[] = [];
    let formattingOnly = 0;
    const visible = visibleRows(rows, options.changesOnly);
    let foldIndex = 0;
    for (let index = 0; index < rows.length; index++) {
        if (!visible[index]) {
            const start = index;
            while (index + 1 < rows.length && !visible[index + 1]) {
                index++;
            }
            const fold = foldIndex++;
            if (!options.expanded.has(fold)) {
                root.appendChild(foldRow(document, fold, index - start + 1));
                continue;
            }
            for (let hidden = start; hidden <= index; hidden++) {
                root.appendChild(rowElement(document, md, rows[hidden], oldDoc, newDoc));
            }
            continue;
        }
        const element = rowElement(document, md, rows[index], oldDoc, newDoc);
        if (rows[index].kind !== 'equal') {
            changes.push(element);
        }
        if (element.classList.contains('marked-markup')) {
            formattingOnly++;
        }
        root.appendChild(element);
    }
    if (!rows.some(row => row.kind !== 'equal')) {
        const empty = document.createElement('div');
        empty.className = 'studio-md-diff-identical';
        empty.textContent = 'The two versions are identical.';
        root.insertBefore(empty, root.firstChild);
    }
    return { root, changes, formattingOnly };
}

/** Which rows show when unchanged runs are folded: every change, and FOLD_CONTEXT unchanged rows either side. */
export function visibleRows(rows: readonly MarkdownDiffRow[], changesOnly: boolean): boolean[] {
    if (!changesOnly) {
        return rows.map(() => true);
    }
    const visible = rows.map(row => row.kind !== 'equal');
    rows.forEach((row, index) => {
        if (row.kind === 'equal') {
            return;
        }
        for (let near = Math.max(0, index - FOLD_CONTEXT); near <= Math.min(rows.length - 1, index + FOLD_CONTEXT); near++) {
            visible[near] = true;
        }
    });
    return visible;
}

function foldRow(document: Document, fold: number, count: number): HTMLElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'studio-md-diff-fold';
    element.dataset.fold = String(fold);
    element.textContent = count === 1 ? '1 unchanged block' : `${count} unchanged blocks`;
    element.title = 'Show them';
    return element;
}

function rowElement(document: Document, md: markdownit, row: MarkdownDiffRow, oldDoc: ParsedMarkdown, newDoc: ParsedMarkdown): HTMLElement {
    const element = document.createElement('div');
    element.className = `studio-md-diff-row ${row.kind}`;
    const oldCell = cell(document, md, 'old', row.old, oldDoc);
    const newCell = cell(document, md, 'new', row.new, newDoc);
    element.append(oldCell, newCell);
    if (row.kind === 'replaced') {
        element.classList.add('marked-whole');
    } else if (row.kind === 'modified' && row.old?.kind === 'fence:mermaid') {
        // Two drawings side by side say more than marked source would.
        element.classList.add('marked-diagram');
    } else if (row.kind === 'modified') {
        const result = markWordChanges(oldCell, newCell);
        element.classList.add(`marked-${result}`);
        if (result === 'markup') {
            newCell.title = 'Only the formatting or a link changed';
        }
    }
    if (row.old) {
        element.dataset.oldLine = String(row.old.line + 1);
    }
    if (row.new) {
        element.dataset.newLine = String(row.new.line + 1);
    }
    return element;
}

function cell(document: Document, md: markdownit, side: 'old' | 'new', block: MarkdownBlock | undefined, doc: ParsedMarkdown): HTMLElement {
    const element = document.createElement('div');
    element.className = `studio-md-diff-cell ${side}` + (block ? '' : ' empty');
    if (block) {
        element.innerHTML = renderBlockHtml(md, block, doc);
        renderTaskBoxes(element);
    }
    return element;
}
