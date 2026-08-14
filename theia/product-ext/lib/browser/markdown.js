/*
 * Markdown <-> editor conversion.
 *
 * Written by hand rather than pulled from `tiptap-markdown` on purpose: the
 * round trip is the highest-risk part of a WYSIWYG Markdown product, so the
 * prototype keeps it explicit and auditable. The supported subset is exactly
 * the block set offered by the slash menu, plus images and nested lists.
 *
 * Two rules this module exists to enforce:
 *  1. YAML frontmatter is NEVER parsed — it is split off, held verbatim and
 *     re-attached byte-for-byte on save. (A `---` fence is otherwise read as a
 *     horizontal rule, which silently destroys the block.)
 *  2. Comment marks are never serialised, so the .md on disk stays clean
 *     Markdown and the file remains the source of truth.
 *
 * Anything this subset cannot represent is caught by the fidelity check in
 * markdown-editor.js, which opens the document read-only rather than risking a
 * lossy save.
 */

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}

// --- frontmatter ------------------------------------------------------------

/** Splits a leading YAML frontmatter block off, verbatim. */
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

// --- inline -----------------------------------------------------------------

function inlineToHtml(text) {
    let out = escapeHtml(text);
    // code first so its contents are not further formatted
    const codeSpans = [];
    let marker = '[[studio-code]]';
    while (out.includes(marker)) { marker = '[' + marker + ']'; }
    out = out.replace(/`([^`]+)`/g, (_, c) => {
        codeSpans.push(c);
        return marker + (codeSpans.length - 1) + marker;
    });
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    codeSpans.forEach((code, index) => {
        out = out.split(marker + index + marker).join('<code>' + code + '</code>');
    });
    return out;
}

// --- markdown -> html -------------------------------------------------------

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
// Must be tested before BULLET — `- [ ] x` matches both, and only the first
// reading is the one the author meant.
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function tableCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

/*
 * Column alignment lives in the delimiter row (`:---`, `:---:`, `---:`) and is
 * therefore per-COLUMN in Markdown, but per-CELL in ProseMirror. Both
 * directions resolve it through the column index: parsing stamps the column's
 * alignment onto every cell in it, and serialising reads it back off the
 * header row only. That asymmetry is why alignment survives a round trip
 * even though the editor lets you select a single cell.
 */
function tableAlignments(dividerLine) {
    return tableCells(dividerLine).map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) { return 'center'; }
        if (right) { return 'right'; }
        if (left) { return 'left'; }
        return '';
    });
}

function alignAttr(align) {
    return align ? ' style="text-align:' + align + '"' : '';
}

function tableHtml(header, rows, aligns) {
    const row = (tag, cells) => '<tr>' + cells.map((cell, i) =>
        '<' + tag + alignAttr((aligns || [])[i]) + '>' + inlineToHtml(cell) + '</' + tag + '>').join('') + '</tr>';
    return '<table><thead>' + row('th', header) + '</thead><tbody>' + rows.map(cells => row('td', cells)).join('') + '</tbody></table>';
}

/** Reads one list line as {indent, kind, text, checked} — or undefined. */
function itemMatch(line) {
    const task = line.match(TASK);
    if (task) { return { indent: task[1].length, kind: 'task', text: task[3], checked: task[2].toLowerCase() === 'x' }; }
    const ordered = line.match(ORDERED);
    if (ordered) { return { indent: ordered[1].length, kind: 'ordered', text: ordered[2] }; }
    const bullet = line.match(BULLET);
    if (bullet) { return { indent: bullet[1].length, kind: 'bullet', text: bullet[2] }; }
    return undefined;
}

/*
 * Consumes one list — including nested sub-lists — and returns [html, next].
 *
 * A run of items ends when the KIND changes at the same indent, so
 * `- [ ] a` followed by `- b` becomes a task list and a bullet list rather
 * than one malformed list. That split is invisible on the way back out:
 * both serialise to exactly the lines they came from.
 */
function listBlock(lines, start) {
    const first = itemMatch(lines[start]);
    const baseIndent = first.indent;
    const kind = first.kind;
    const items = [];
    let i = start;
    while (i < lines.length) {
        const m = itemMatch(lines[i]);
        if (!m || m.indent < baseIndent) { break; }
        if (m.indent > baseIndent) {
            const [html, next] = listBlock(lines, i);
            if (items.length) { items[items.length - 1].html += html; }
            i = next;
            continue;
        }
        if (m.kind !== kind) { break; }
        items.push({ html: '<p>' + inlineToHtml(m.text) + '</p>', checked: m.checked });
        i++;
    }
    if (kind === 'task') {
        return ['<ul data-type="taskList">' + items.map(x =>
            '<li data-type="taskItem" data-checked="' + (x.checked ? 'true' : 'false') + '">' + x.html + '</li>'
        ).join('') + '</ul>', i];
    }
    const tag = kind === 'ordered' ? 'ol' : 'ul';
    return ['<' + tag + '>' + items.map(x => '<li>' + x.html + '</li>').join('') + '</' + tag + '>', i];
}

function markdownToHtml(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        /*
         * A details block is deliberately the one HTML construct we edit. It
         * is standard Markdown-adjacent source and remains entirely legible in
         * Raw mode, while its body is parsed by this same converter so lists,
         * fences and all other supported blocks keep their normal semantics.
         */
        if (/^\s*<details>\s*$/.test(line) && i + 1 < lines.length) {
            const summary = lines[i + 1].match(/^\s*<summary>(.*?)<\/summary>\s*$/);
            let end = -1;
            if (summary) {
                for (let n = i + 2; n < lines.length; n++) {
                    if (/^\s*<\/details>\s*$/.test(lines[n])) { end = n; break; }
                }
            }
            if (summary && end !== -1) {
                out.push('<details><summary>' + inlineToHtml(summary[1]) + '</summary><div data-studio-toggle-body>' +
                    markdownToHtml(lines.slice(i + 2, end).join('\n')) + '</div></details>');
                i = end + 1;
                continue;
            }
        }

        const image = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
        if (image) {
            out.push('<img alt="' + escapeAttribute(image[1]) + '" src="' + escapeAttribute(image[2]) + '">');
            i++;
            continue;
        }

        const fence = line.match(/^```\s*(\S*)\s*$/);
        if (fence) {
            const lang = fence[1] || '';
            const body = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
            i++;
            out.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' +
                escapeHtml(body.join('\n')) + '</code></pre>');
            continue;
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            out.push('<h' + heading[1].length + '>' + inlineToHtml(heading[2]) + '</h' + heading[1].length + '>');
            i++;
            continue;
        }

        if (/^\s*>\s?/.test(line)) {
            const body = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
            out.push('<blockquote><p>' + inlineToHtml(body.join(' ')) + '</p></blockquote>');
            continue;
        }

        if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
            const header = tableCells(line);
            const aligns = tableAlignments(lines[i + 1]);
            const rows = [];
            i += 2;
            while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(tableCells(lines[i])); i++; }
            out.push(tableHtml(header, rows, aligns));
            continue;
        }

        if (itemMatch(line)) { const [html, next] = listBlock(lines, i); out.push(html); i = next; continue; }

        const para = [];
        while (i < lines.length && lines[i].trim() &&
            !/^(#{1,4}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])) {
            para.push(lines[i].trim());
            i++;
        }
        if (para.length) { out.push('<p>' + inlineToHtml(para.join(' ')) + '</p>'); } else { i++; }
    }

    return out.join('\n') || '<p></p>';
}

// --- editor JSON -> markdown ------------------------------------------------

function inlineFromJson(nodes) {
    return (nodes || []).map(n => {
        if (n.type === 'hardBreak') { return '\n'; }
        if (n.type === 'image') {
            const a = n.attrs || {};
            return '![' + (a.alt || '') + '](' + (a.src || '') + ')';
        }
        if (n.type !== 'text') { return ''; }
        let t = n.text || '';
        const marks = n.marks || [];
        const has = name => marks.some(m => m.type === name);
        // `comment` is intentionally ignored — it never reaches the file.
        if (has('code')) { t = '`' + t + '`'; }          // NB: no early return —
        if (has('bold')) { t = '**' + t + '**'; }        // a link whose text is a
        if (has('italic')) { t = '*' + t + '*'; }        // code span must keep both
        const link = marks.find(m => m.type === 'link');
        if (link && link.attrs && link.attrs.href) { t = '[' + t + '](' + link.attrs.href + ')'; }
        return t;
    }).join('');
}

function blockToMarkdown(node, indent) {
    const pad = ' '.repeat(indent * 2);
    switch (node.type) {
        case 'image': {
            const a = node.attrs || {};
            return pad + '![' + (a.alt || '') + '](' + (a.src || '') + ')';
        }
        case 'toggle': {
            const summary = (node.attrs && node.attrs.summary) || '';
            const body = (node.content || []).map(c => blockToMarkdown(c, 0)).filter(Boolean).join('\n\n');
            return pad + '<details>\n' + pad + '<summary>' + summary + '</summary>\n\n' +
                body + '\n' + pad + '</details>';
        }
        case 'heading':
            return pad + '#'.repeat((node.attrs && node.attrs.level) || 1) + ' ' + inlineFromJson(node.content);
        case 'paragraph':
            return pad + inlineFromJson(node.content);
        case 'codeBlock':
            return '```' + ((node.attrs && node.attrs.language) || '') + '\n' + inlineFromJson(node.content) + '\n```';
        case 'blockquote':
            return (node.content || []).map(c => '> ' + blockToMarkdown(c, 0)).join('\n');
        case 'horizontalRule':
            return '---';
        case 'bulletList':
        case 'orderedList': {
            const ordered = node.type === 'orderedList';
            return (node.content || []).map((li, idx) => {
                const marker = ordered ? (idx + 1) + '. ' : '- ';
                const parts = (li.content || []);
                const head = parts.length ? blockToMarkdown(parts[0], 0).trim() : '';
                const rest = parts.slice(1).map(c => blockToMarkdown(c, indent + 1)).filter(Boolean);
                return pad + marker + head + (rest.length ? '\n' + rest.join('\n') : '');
            }).join('\n');
        }
        case 'taskList':
            return (node.content || []).map(item => {
                const box = '[' + (item.attrs && item.attrs.checked ? 'x' : ' ') + '] ';
                const parts = item.content || [];
                const head = parts.length ? blockToMarkdown(parts[0], 0).trim() : '';
                const rest = parts.slice(1).map(c => blockToMarkdown(c, indent + 1)).filter(Boolean);
                return pad + '- ' + box + head + (rest.length ? '\n' + rest.join('\n') : '');
            }).join('\n');
        case 'listItem':
        case 'taskItem':
            return (node.content || []).map(c => blockToMarkdown(c, indent)).join('\n');
        case 'table': {
            const rows = node.content || [];
            if (!rows.length) { return ''; }
            /*
             * A GFM cell is a single line, so every block inside a cell is
             * flattened onto one. A cell spanning several columns is written
             * out as its content followed by empty cells: GFM has no colspan,
             * and padding keeps the table rectangular (and the text intact)
             * rather than silently shifting every later column left. The
             * editor deliberately offers no merge command for the same
             * reason — see TABLE_COMMANDS in markdown-editor.js.
             */
            const cells = row => {
                const out = [];
                for (const cell of (row.content || [])) {
                    const text = (cell.content || [])
                        .map(block => inlineFromJson(block.content))
                        .join(' ').trim().replace(/\|/g, '\\|');
                    out.push(text);
                    const span = ((cell.attrs && cell.attrs.colspan) || 1) - 1;
                    for (let k = 0; k < span; k++) { out.push(''); }
                }
                return out;
            };
            const alignOf = cell => (cell.attrs && cell.attrs.align) || '';
            const aligns = (rows[0].content || []).map(alignOf);
            const delimiter = align =>
                align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---';

            const header = cells(rows[0]);
            const width = header.length;
            const line = row => '| ' + row.join(' | ') + ' |';
            // Pad short rows so the emitted table is rectangular even if the
            // document model briefly is not (a paste, say, mid-normalisation).
            const pad = row => row.length >= width ? row.slice(0, width) : row.concat(Array(width - row.length).fill(''));
            return [
                line(header),
                line(Array.from({ length: width }, (_, i) => delimiter(aligns[i]))),
                ...rows.slice(1).map(row => line(pad(cells(row))))
            ].join('\n');
        }
        default:
            return pad + inlineFromJson(node.content);
    }
}

function jsonToMarkdown(doc) {
    const blocks = (doc && doc.content) || [];
    const body = blocks.map(b => blockToMarkdown(b, 0)).filter(b => b !== undefined).join('\n\n');
    return body.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n';
}

// --- fidelity ---------------------------------------------------------------

/*
 * Constructs this subset provably cannot represent. Idempotence alone does not
 * catch them: a table parses into plain paragraphs, and paragraphs round-trip
 * perfectly — so the check would pass while the table was being destroyed.
 *
 * This is a blocklist, so it is not complete by construction. It is paired with
 * a word-level content comparison and an idempotence check in
 * markdown-editor.js; a document has to clear all three to become editable.
 */
const UNSUPPORTED = [
    [/^\s*\[[^\]]+\]:\s+\S+/m, 'reference-style link definitions'],
    [/\[\^[^\]]+\]/, 'footnotes'],
    [/^#{5,}\s/m, 'headings deeper than level 4'],
    [/^(?: {4}|\t)\S/m, 'indented code blocks'],
    [/<\/?[a-zA-Z][^>]*>/, 'inline or block HTML']
];

/** Removes fenced blocks and inline code so their contents are not scanned. */
function stripCode(md) {
    return String(md).replace(/```[\s\S]*?```/g, '\n').replace(/`[^`\n]*`/g, ' ');
}

function unsupportedConstructs(md) {
    // `details` is an intentional, portable exception to the raw-HTML guard.
    // Strip only its wrapper tags so any unrelated raw HTML in the body remains
    // protected by the existing safety gate.
    const scan = stripCode(md)
        .replace(/^\s*<details>\s*$/gm, '')
        .replace(/^\s*<\/details>\s*$/gm, '')
        .replace(/^\s*<summary>.*?<\/summary>\s*$/gm, '');
    return UNSUPPORTED.filter(([re]) => re.test(scan)).map(([, name]) => name);
}

/** Word sequence, ignoring all markup — used to prove no content was dropped. */
function contentWords(md) {
    return stripCode(md).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

module.exports = {
    markdownToHtml, jsonToMarkdown, splitFrontmatter, joinFrontmatter,
    unsupportedConstructs, contentWords
};
