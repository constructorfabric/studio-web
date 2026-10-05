// Save what was edited, not the whole file reformatted.
//
// The WYSIWYG editor holds a document as a model and writes it back out with
// its own serializer, and so does the Documents editor (product-ext) — with a
// different one. Each re-flows paragraphs, re-pads tables and re-picks list
// markers its own way, so in a document both save in turn every save rewrote
// rows nobody edited: noise in git, in pull requests and in the review queue.
//
// The remedy is block-level and after the fact, as product-ext's
// md-rewrap.js (preserveWrapping) does for line breaks: cut the file as it was
// and the text being saved into blocks (markdown-it's own, list items one by
// one — markdown-diff-model.ts), line them up, and wherever a block RENDERS
// the same as before — the same words, links and emphasis, only the source
// spelled differently — write the file's own lines for it back. A block the
// person changed goes out as the serializer wrote it, except for one thing:
// a list item takes the bullet its list already uses, because an item with
// `*` among items with `-` ends one list and starts another.

import * as markdownit from '@theia/core/shared/markdown-it';
import { diffArrays } from 'diff';
import { createMarkdownRenderer } from '../markdown-diff/markdown-diff-render';
import { FRONT_MATTER_KIND, MarkdownBlock, ParsedMarkdown, parseMarkdown } from '../markdown-diff/markdown-diff-model';

let renderer: markdownit | undefined;

/** What a block means: its kind and its rendering, whitespace aside. */
function meaningOf(md: markdownit, block: MarkdownBlock, doc: ParsedMarkdown): string {
    const rendered = block.kind === FRONT_MATTER_KIND
        ? block.source
        : md.renderer.render(block.tokens, md.options, doc.env);
    return `${block.kind}\u0000${rendered.replace(/\s+/g, ' ').trim()}`;
}

/** A bullet list item's marker (`-`, `*`, `+`); undefined for anything else. */
function bulletOf(block: MarkdownBlock): string | undefined {
    const markup = block.kind === 'list_item:bullet' ? block.tokens[0]?.markup : undefined;
    return markup && /^[-*+]$/.test(markup) ? markup : undefined;
}

/** The item's lines with its own bullet (the first line's marker) replaced. */
function withBullet(lines: string[], bullet: string): string[] {
    if (!lines.length) {
        return lines;
    }
    return [lines[0].replace(/^(\s*)[-*+](\s)/, `$1${bullet}$2`), ...lines.slice(1)];
}

/**
 * `edited` with every block that renders the same as in `original` written as
 * `original` spelled it. Line endings follow the original file.
 */
export function preserveUnchangedBlocks(original: string, edited: string): string {
    if (!original || original === edited) {
        return edited;
    }
    renderer ??= createMarkdownRenderer();
    const md = renderer;
    const crlf = original.includes('\r\n');
    const before = original.replace(/\r\n?/g, '\n');
    const after = edited.replace(/\r\n?/g, '\n');
    const oldDoc = parseMarkdown(md, before);
    const newDoc = parseMarkdown(md, after);
    const oldKeys = oldDoc.blocks.map(block => meaningOf(md, block, oldDoc));
    const newKeys = newDoc.blocks.map(block => meaningOf(md, block, newDoc));

    // New block index → the old block it is the same as.
    const same = new Map<number, MarkdownBlock>();
    let oldIndex = 0;
    let newIndex = 0;
    for (const part of diffArrays(oldKeys, newKeys)) {
        const count = part.value.length;
        if (part.removed) {
            oldIndex += count;
        } else if (part.added) {
            newIndex += count;
        } else {
            for (let i = 0; i < count; i++) {
                same.set(newIndex + i, oldDoc.blocks[oldIndex + i]);
            }
            oldIndex += count;
            newIndex += count;
        }
    }
    if (!same.size) {
        return edited;
    }

    // Each new list's bullet, where any of its items is kept from the file.
    const listBullet = new Map<number, string>();
    newDoc.blocks.forEach((block, index) => {
        const old = same.get(index);
        const bullet = old && bulletOf(old);
        if (block.list !== undefined && bullet && !listBullet.has(block.list)) {
            listBullet.set(block.list, bullet);
        }
    });

    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    const out: string[] = [];
    let cursor = 0;
    newDoc.blocks.forEach((block, index) => {
        if (block.endLine <= block.line) {
            return;
        }
        const old = same.get(index);
        let lines: string[] | undefined;
        if (old && old.endLine > old.line) {
            lines = oldLines.slice(old.line, old.endLine);
            const bullet = block.list !== undefined ? listBullet.get(block.list) : undefined;
            // A kept item with another bullet than its list's (the file mixed
            // them) follows the list, for the same reason an edited one does.
            if (bullet && bulletOf(old) && bulletOf(old) !== bullet) {
                lines = withBullet(lines, bullet);
            }
        } else if (block.list !== undefined && listBullet.has(block.list) && bulletOf(block)) {
            lines = withBullet(newLines.slice(block.line, block.endLine), listBullet.get(block.list)!);
        }
        if (!lines) {
            return;
        }
        out.push(...newLines.slice(cursor, block.line));
        out.push(...lines);
        cursor = block.endLine;
    });
    out.push(...newLines.slice(cursor));
    const text = out.join('\n');
    return crlf ? text.replace(/\n/g, '\r\n') : text;
}
