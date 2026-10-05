// What changed between two versions of a markdown document, in the units a
// reader sees: paragraphs, headings, list items, tables, code blocks.
//
// The idea is Markdown Diff Visualiser's (arjuntic/markdown-diff-visualiser,
// MIT, (c) 2026 arjun-staticvar): render both versions and mark what was
// added, removed and reworded, instead of showing the source lines. The unit
// is not. That extension cut the documents at the line boundaries of a
// `git diff` hunk and rendered each cut separately, so a changed row of a
// table or item of a list came out as a fragment that was no longer a table or
// a list. Here the cut is markdown-it's own block structure, so every piece
// rendered on its own is still well-formed, and the comparison needs two
// strings rather than git: a conflict, a history entry or an agent's proposal
// compare the same way as HEAD against the working tree.

import * as markdownit from '@theia/core/shared/markdown-it';
import { diffArrays, diffWordsWithSpace } from 'diff';

type Token = markdownit.Token;

/** One top-level unit of a document: what is compared, and what is rendered. */
export interface MarkdownBlock {
    /** The kind of block, e.g. `paragraph`, `heading:h2`, `list_item:bullet`, `fence:mermaid`. */
    readonly kind: string;
    /** The block's own source lines. */
    readonly source: string;
    /** The tokens that render this block alone; empty for front matter. */
    readonly tokens: Token[];
    /** 0-based line in the document where the block starts. */
    readonly line: number;
    /** 0-based line where it ends, exclusive. */
    readonly endLine: number;
    /** For a list item: which list of the document it belongs to (0, 1, …). */
    readonly list?: number;
}

export interface ParsedMarkdown {
    readonly blocks: MarkdownBlock[];
    /** markdown-it's env: link reference definitions, shared by every block of this document. */
    readonly env: object;
}

/**
 * `modified`: one block, edited — its words are marked. `replaced`: a removed
 * block and an unrelated added one that took its place, side by side so the
 * view does not stack the two runs one under the other.
 */
export type MarkdownDiffRowKind = 'equal' | 'modified' | 'replaced' | 'added' | 'removed';

/** One row of the side-by-side view: a block on the left, on the right, or both. */
export interface MarkdownDiffRow {
    readonly kind: MarkdownDiffRowKind;
    readonly old?: MarkdownBlock;
    readonly new?: MarkdownBlock;
}

export const FRONT_MATTER_KIND = 'front_matter';

const FRONT_MATTER = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/;

/** A block's identity for the comparison: its kind and its text, trailing spaces ignored. */
export function blockKey(block: MarkdownBlock): string {
    return block.kind + '\u0000' + block.source.split('\n').map(line => line.trimEnd()).join('\n').trim();
}

export function parseMarkdown(md: markdownit, markdown: string): ParsedMarkdown {
    const text = markdown.replace(/\r\n?/g, '\n');
    const blocks: MarkdownBlock[] = [];
    let body = text;
    let offset = 0;
    const frontMatter = FRONT_MATTER.exec(text);
    if (frontMatter) {
        const source = frontMatter[0].replace(/\n$/, '');
        blocks.push({ kind: FRONT_MATTER_KIND, source, tokens: [], line: 0, endLine: source.split('\n').length });
        offset = source.split('\n').length;
        // Blank lines in place of the front matter, so token maps stay
        // document line numbers.
        body = '\n'.repeat(offset) + text.slice(frontMatter[0].length);
    }
    const env = {};
    const tokens = md.parse(body, env);
    const lines = body.split('\n');
    const sourceOf = (map: [number, number] | null): string => map ? lines.slice(map[0], map[1]).join('\n') : '';

    let index = 0;
    let lists = 0;
    while (index < tokens.length) {
        const token = tokens[index];
        const end = token.nesting === 1 ? closingIndex(tokens, index) : index;
        const group = tokens.slice(index, end + 1);
        if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
            blocks.push(...listItems(group, sourceOf, lists++));
        } else {
            blocks.push({ kind: kindOf(token), source: sourceOf(token.map), tokens: group, line: token.map?.[0] ?? 0, endLine: token.map?.[1] ?? 0 });
        }
        index = end + 1;
    }
    return { blocks, env };
}

function closingIndex(tokens: Token[], open: number): number {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        depth += tokens[i].nesting;
        if (depth === 0) {
            return i;
        }
    }
    return tokens.length - 1;
}

function kindOf(token: Token): string {
    const type = token.type.replace(/_open$/, '');
    if (type === 'heading') {
        return `heading:${token.tag}`;
    }
    if (type === 'fence') {
        const language = token.info.trim().split(/\s+/)[0];
        return language === 'mermaid' ? 'fence:mermaid' : 'fence';
    }
    return type;
}

/**
 * A list, one block per item. A list is where documents change most — one
 * bullet added to twenty — and as a single block every such edit would mark
 * the whole list. Each item renders inside a copy of its list's opening
 * token, carrying the item's own number for an ordered list.
 */
function listItems(group: Token[], sourceOf: (map: [number, number] | null) => string, list: number): MarkdownBlock[] {
    const open = group[0];
    const close = group[group.length - 1];
    const ordered = open.type === 'ordered_list_open';
    const kind = ordered ? 'list_item:ordered' : 'list_item:bullet';
    const items: MarkdownBlock[] = [];
    let index = 1;
    while (index < group.length - 1) {
        const item = group[index];
        const end = closingIndex(group, index);
        let listOpen = open;
        if (ordered) {
            listOpen = Object.assign(Object.create(Object.getPrototypeOf(open)), open) as Token;
            listOpen.attrs = [['start', item.info || String(items.length + 1)]];
        }
        items.push({
            kind,
            source: sourceOf(item.map),
            tokens: [listOpen, ...group.slice(index, end + 1), close],
            line: item.map?.[0] ?? 0,
            endLine: item.map?.[1] ?? 0,
            list,
        });
        index = end + 1;
    }
    return items;
}

/** How alike two texts are, from 0 (nothing shared) to 1 (identical), by words. */
export function similarity(a: string, b: string): number {
    if (a === b) {
        return 1;
    }
    const total = a.length + b.length;
    if (total === 0) {
        return 1;
    }
    let common = 0;
    for (const part of diffWordsWithSpace(a, b)) {
        if (!part.added && !part.removed) {
            common += part.value.length;
        }
    }
    return (2 * common) / total;
}

/** Below this, a replaced block reads as one removed and another added, not as an edit. */
export const MODIFIED_SIMILARITY = 0.35;

/** Past this many removed × added blocks in one run, pairing looks only a few blocks ahead. */
const PAIRING_CELL_BUDGET = 2500;
const PAIRING_WINDOW = 8;

/** The rows of the side-by-side view, in document order. */
export function diffMarkdown(oldDoc: ParsedMarkdown, newDoc: ParsedMarkdown): MarkdownDiffRow[] {
    const rows: MarkdownDiffRow[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    let removed: MarkdownBlock[] = [];
    let added: MarkdownBlock[] = [];
    const flush = (): void => {
        rows.push(...pairChanges(removed, added));
        removed = [];
        added = [];
    };
    for (const change of diffArrays(oldDoc.blocks.map(blockKey), newDoc.blocks.map(blockKey))) {
        const count = change.value.length;
        if (change.removed) {
            removed.push(...oldDoc.blocks.slice(oldIndex, oldIndex + count));
            oldIndex += count;
        } else if (change.added) {
            added.push(...newDoc.blocks.slice(newIndex, newIndex + count));
            newIndex += count;
        } else {
            flush();
            for (let i = 0; i < count; i++) {
                rows.push({ kind: 'equal', old: oldDoc.blocks[oldIndex++], new: newDoc.blocks[newIndex++] });
            }
        }
    }
    flush();
    return rows;
}

/**
 * One run of changes between two unchanged blocks. A removed block and an
 * added one of the same kind that still share most of their words are one
 * edit, shown side by side with the words marked. Which pairs, is the
 * order-preserving choice with the most words in common — the alignment a
 * reader would make, where taking the first plausible match can tie a
 * paragraph to the wrong one and leave its real counterpart unpaired. What
 * no pair claims is laid out side by side as replaced, removed or added.
 */
function pairChanges(removed: MarkdownBlock[], added: MarkdownBlock[]): MarkdownDiffRow[] {
    const pairs = removed.length * added.length > PAIRING_CELL_BUDGET
        ? greedyPairs(removed, added)
        : bestPairs(removed, added);
    const rows: MarkdownDiffRow[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    for (const [oldPair, newPair] of [...pairs, [removed.length, added.length] as const]) {
        const olds = removed.slice(oldIndex, oldPair);
        const news = added.slice(newIndex, newPair);
        for (let i = 0; i < Math.max(olds.length, news.length); i++) {
            const old = olds[i];
            const next = news[i];
            rows.push(old && next ? { kind: 'replaced', old, new: next } : old ? { kind: 'removed', old } : { kind: 'added', new: next });
        }
        if (oldPair < removed.length && newPair < added.length) {
            rows.push({ kind: 'modified', old: removed[oldPair], new: added[newPair] });
        }
        oldIndex = oldPair + 1;
        newIndex = newPair + 1;
    }
    return rows;
}

function pairScore(old: MarkdownBlock, next: MarkdownBlock): number {
    if (old.kind !== next.kind) {
        return 0;
    }
    const score = similarity(old.source, next.source);
    return score >= MODIFIED_SIMILARITY ? score : 0;
}

/** The order-preserving pairing with the greatest total similarity (an LCS weighted by it). */
function bestPairs(removed: MarkdownBlock[], added: MarkdownBlock[]): Array<readonly [number, number]> {
    const n = removed.length;
    const m = added.length;
    const width = m + 1;
    const best = new Float64Array((n + 1) * width);
    const score = new Float64Array(n * m);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            const pair = score[i * m + j] = pairScore(removed[i], added[j]);
            best[i * width + j] = Math.max(
                best[(i + 1) * width + j],
                best[i * width + j + 1],
                pair > 0 ? pair + best[(i + 1) * width + j + 1] : 0,
            );
        }
    }
    const pairs: Array<readonly [number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const pair = score[i * m + j];
        if (pair > 0 && best[i * width + j] === pair + best[(i + 1) * width + j + 1]) {
            pairs.push([i++, j++]);
        } else if (best[(i + 1) * width + j] >= best[i * width + j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

/** For a very long run: each removed block takes the first good match a few blocks ahead. */
function greedyPairs(removed: MarkdownBlock[], added: MarkdownBlock[]): Array<readonly [number, number]> {
    const pairs: Array<readonly [number, number]> = [];
    let next = 0;
    removed.forEach((old, i) => {
        for (let j = next; j < Math.min(added.length, next + PAIRING_WINDOW); j++) {
            if (pairScore(old, added[j]) > 0) {
                pairs.push([i, j]);
                next = j + 1;
                return;
            }
        }
    });
    return pairs;
}

/** How many rows changed, by kind — for the header's summary. */
export function countChanges(rows: readonly MarkdownDiffRow[]): { modified: number; added: number; removed: number } {
    const counts = { modified: 0, added: 0, removed: 0 };
    for (const row of rows) {
        if (row.kind === 'replaced') {
            counts.removed++;
            counts.added++;
        } else if (row.kind !== 'equal') {
            counts[row.kind]++;
        }
    }
    return counts;
}
