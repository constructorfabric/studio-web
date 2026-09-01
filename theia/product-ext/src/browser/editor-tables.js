/*
 * Tables.
 *
 * The previous build declared four minimal ProseMirror nodes by hand, which
 * was enough to render a pasted pipe table and edit the text inside a cell —
 * and nothing else. Row and column operations, cell selection and header
 * control all need prosemirror-tables' column-map machinery, so this module
 * moves to @tiptap/extension-table and adds the three things it does not
 * ship: Markdown column alignment, row/column reordering, and TSV paste.
 *
 * Deliberately NOT offered: merge and split cells. GFM has no colspan or
 * rowspan, so a merged cell cannot survive a save — and requirement 2 asks
 * for merging only "where the document format can preserve the result
 * safely", which here it cannot. jsonToMarkdown() still degrades a merged
 * cell safely (content plus padding) if one arrives by paste, but the
 * product does not invite the user to create one.
 */

const { Table } = require('@tiptap/extension-table');
const { TableRow } = require('@tiptap/extension-table-row');
const { TableCell } = require('@tiptap/extension-table-cell');
const { TableHeader } = require('@tiptap/extension-table-header');
const { Extension } = require('@tiptap/core');
const { Plugin } = require('@tiptap/pm/state');
const { ICONS } = require('./icons');

/*
 * Markdown stores alignment once per column, in the delimiter row;
 * ProseMirror stores attributes per cell. The attribute below is the cell
 * half of that bridge (markdown.js holds the other half) — which is why
 * every alignment command in this file writes the whole COLUMN, never a
 * single cell: a per-cell alignment would be silently lost on save.
 */
const alignAttribute = {
    align: {
        default: '',
        parseHTML: el => el.style.textAlign || '',
        renderHTML: attrs => attrs.align ? { style: 'text-align:' + attrs.align } : {}
    }
};

const AlignedTableCell = TableCell.extend({
    addAttributes() { return { ...this.parent?.(), ...alignAttribute }; }
});

const AlignedTableHeader = TableHeader.extend({
    addAttributes() { return { ...this.parent?.(), ...alignAttribute }; }
});

const StudioTable = Table.configure({ resizable: false, allowTableNodeSelection: true });

// --- geometry ---------------------------------------------------------------

/** Where the caret is, in table terms — or undefined if it is not in a table. */
function cellContext(state) {
    const $from = state.selection.$from;
    let depth = -1;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') { depth = d; break; }
    }
    if (depth < 0) { return undefined; }
    return {
        table: $from.node(depth),
        tablePos: $from.before(depth),
        rowIndex: $from.depth > depth ? $from.index(depth) : 0,
        colIndex: $from.depth > depth + 1 ? $from.index(depth + 1) : 0
    };
}

function rowsOf(table) {
    const rows = [];
    table.forEach(row => rows.push(row));
    return rows;
}

function cellsOf(row) {
    const cells = [];
    row.forEach(cell => cells.push(cell));
    return cells;
}

/*
 * Does this table have a Markdown header row? Every GFM table does — the
 * delimiter row is mandatory — so row 0 is pinned in place: it can be
 * edited, but not moved out of first position and not displaced by another
 * row moving up. Without this, "move row up" on row 1 would produce a table
 * whose header is in the middle, which serialises to a different table than
 * the one on screen.
 */
function hasHeaderRow(table) {
    const first = table.firstChild;
    return !!first && !!first.firstChild && first.firstChild.type.name === 'tableHeader';
}

// --- reordering -------------------------------------------------------------

/** Absolute document position just inside a given cell's first block. */
function positionInCell(tablePos, table, rowIndex, colIndex) {
    let pos = tablePos + 1;
    for (let r = 0; r < rowIndex && r < table.childCount; r++) { pos += table.child(r).nodeSize; }
    const row = table.child(Math.min(rowIndex, table.childCount - 1));
    let cell = pos + 1;
    for (let c = 0; c < colIndex && c < row.childCount; c++) { cell += row.child(c).nodeSize; }
    return cell + 1;
}

/*
 * Replacing the whole table node is the simplest way to reorder rows and
 * columns — prosemirror-tables has no move command — but a wholesale
 * replaceWith leaves the caret nowhere useful, which silently broke the NEXT
 * command the user issued (delete row after a move did nothing, because the
 * selection was no longer in a cell). So the caret is put back into the cell
 * that moved, addressed by its new coordinates.
 */
function replaceTable(editor, ctx, rows, caret) {
    const table = ctx.table.type.create(ctx.table.attrs, rows);
    const tr = editor.state.tr.replaceWith(ctx.tablePos, ctx.tablePos + ctx.table.nodeSize, table);
    try {
        const { TextSelection } = require('@tiptap/pm/state');
        const target = positionInCell(ctx.tablePos, table, caret.row, caret.col);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target, tr.doc.content.size))));
    } catch (e) {
        console.warn('[studio] could not restore the caret after a table move', e);
    }
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
    return true;
}

function moveRow(editor, delta) {
    const ctx = cellContext(editor.state);
    if (!ctx) { return false; }
    const rows = rowsOf(ctx.table);
    const floor = hasHeaderRow(ctx.table) ? 1 : 0;
    const from = ctx.rowIndex;
    const to = from + delta;
    if (from < floor || to < floor || to >= rows.length) { return false; }
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    return replaceTable(editor, ctx, rows, { row: to, col: ctx.colIndex });
}

function moveColumn(editor, delta) {
    const ctx = cellContext(editor.state);
    if (!ctx) { return false; }
    const width = ctx.table.firstChild ? ctx.table.firstChild.childCount : 0;
    const from = ctx.colIndex;
    const to = from + delta;
    if (from < 0 || to < 0 || to >= width) { return false; }
    const rows = rowsOf(ctx.table).map(row => {
        const cells = cellsOf(row);
        if (cells.length <= Math.max(from, to)) { return row; }
        const [moved] = cells.splice(from, 1);
        cells.splice(to, 0, moved);
        return row.type.create(row.attrs, cells);
    });
    return replaceTable(editor, ctx, rows, { row: ctx.rowIndex, col: to });
}

/** Alignment is written to every cell in the column — see alignAttribute. */
function setColumnAlign(editor, align) {
    const ctx = cellContext(editor.state);
    if (!ctx) { return false; }
    const tr = editor.state.tr;
    ctx.table.forEach((row, rowOffset) => {
        const rowPos = ctx.tablePos + 1 + rowOffset;
        row.forEach((cell, cellOffset, index) => {
            if (index !== ctx.colIndex) { return; }
            tr.setNodeMarkup(rowPos + 1 + cellOffset, undefined, { ...cell.attrs, align });
        });
    });
    if (!tr.steps.length) { return false; }
    editor.view.dispatch(tr);
    return true;
}

function currentAlign(editor) {
    const ctx = cellContext(editor.state);
    if (!ctx || !ctx.table.firstChild) { return ''; }
    const cell = ctx.table.firstChild.child(Math.min(ctx.colIndex, ctx.table.firstChild.childCount - 1));
    return (cell && cell.attrs && cell.attrs.align) || '';
}

// --- paste ------------------------------------------------------------------

/*
 * prosemirror-tables already reconstructs a table from the text/html flavour
 * that Excel, Numbers and Google Sheets put on the clipboard. This covers the
 * other common case — plain tab- or comma-separated text, which arrives with
 * no HTML flavour at all and would otherwise paste as a wall of paragraphs.
 */
function looksTabular(text) {
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    if (lines.length < 2) { return undefined; }
    const separator = lines[0].includes('\t') ? '\t' : (lines.every(l => l.includes(',')) ? ',' : undefined);
    if (!separator) { return undefined; }
    const grid = lines.map(l => l.split(separator));
    const width = grid[0].length;
    if (width < 2 || !grid.every(r => r.length === width)) { return undefined; }
    return grid;
}

function gridToTable(grid) {
    const cell = (type, text) => ({
        type,
        content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }]
    });
    return {
        type: 'table',
        content: grid.map((row, i) => ({
            type: 'tableRow',
            content: row.map(text => cell(i === 0 ? 'tableHeader' : 'tableCell', text.trim()))
        }))
    };
}

const TabularPaste = Extension.create({
    name: 'studioTabularPaste',
    addProseMirrorPlugins() {
        const editor = this.editor;
        return [new Plugin({
            props: {
                handlePaste(view, event) {
                    const html = event.clipboardData && event.clipboardData.getData('text/html');
                    if (html && /<table/i.test(html)) { return false; }   // let prosemirror-tables have it
                    const text = event.clipboardData && event.clipboardData.getData('text/plain');
                    const grid = text && looksTabular(text);
                    if (!grid) { return false; }
                    event.preventDefault();
                    editor.chain().focus().insertContent(gridToTable(grid)).run();
                    return true;
                }
            }
        })];
    }
});

// --- starter content --------------------------------------------------------

function tableContent(columns, rows) {
    const cols = columns || 2;
    const bodyRows = rows || 1;
    const cell = (type, text) => ({
        type,
        content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }]
    });
    const header = {
        type: 'tableRow',
        content: Array.from({ length: cols }, (_, i) => cell('tableHeader', 'Column ' + (i + 1)))
    };
    const body = Array.from({ length: bodyRows }, () => ({
        type: 'tableRow',
        content: Array.from({ length: cols }, () => cell('tableCell', ''))
    }));
    return { type: 'table', content: [header, ...body] };
}

// --- toolbar ----------------------------------------------------------------

/*
 * The commands the floating table toolbar offers, in display order. Each
 * `run` returns truthy when it changed the document, so the toolbar can be
 * built from this list alone rather than from a parallel set of DOM handlers.
 */
const TABLE_COMMANDS = [
    { key: 'row-before', group: 'row', label: 'Insert row above', icon: ICONS.tableRowBefore, run: e => e.chain().focus().addRowBefore().run() },
    { key: 'row-after', group: 'row', label: 'Insert row below', icon: ICONS.tableRowAfter, run: e => e.chain().focus().addRowAfter().run() },
    { key: 'row-up', group: 'row', label: 'Move row up', icon: ICONS.tableRowUp, run: e => moveRow(e, -1) },
    { key: 'row-down', group: 'row', label: 'Move row down', icon: ICONS.tableRowDown, run: e => moveRow(e, 1) },
    { key: 'row-delete', group: 'row', label: 'Delete row', icon: ICONS.tableRowDelete, run: e => e.chain().focus().deleteRow().run() },
    { key: 'col-before', group: 'col', label: 'Insert column left', icon: ICONS.tableColBefore, run: e => e.chain().focus().addColumnBefore().run() },
    { key: 'col-after', group: 'col', label: 'Insert column right', icon: ICONS.tableColAfter, run: e => e.chain().focus().addColumnAfter().run() },
    { key: 'col-left', group: 'col', label: 'Move column left', icon: ICONS.tableColLeft, run: e => moveColumn(e, -1) },
    { key: 'col-right', group: 'col', label: 'Move column right', icon: ICONS.tableColRight, run: e => moveColumn(e, 1) },
    { key: 'col-delete', group: 'col', label: 'Delete column', icon: ICONS.tableColDelete, run: e => e.chain().focus().deleteColumn().run() },
    { key: 'align-left', group: 'align', label: 'Align column left', icon: ICONS.alignLeft, run: e => setColumnAlign(e, 'left') },
    { key: 'align-center', group: 'align', label: 'Align column centre', icon: ICONS.alignCenter, run: e => setColumnAlign(e, 'center') },
    { key: 'align-right', group: 'align', label: 'Align column right', icon: ICONS.alignRight, run: e => setColumnAlign(e, 'right') },
    { key: 'header-row', group: 'table', label: 'Toggle header row', icon: ICONS.tableHeaderRow, run: e => e.chain().focus().toggleHeaderRow().run() },
    { key: 'table-delete', group: 'table', label: 'Delete table', icon: ICONS.tableDelete, run: e => e.chain().focus().deleteTable().run() }
];

const TABLE_EXTENSIONS = [StudioTable, TableRow, AlignedTableCell, AlignedTableHeader, TabularPaste];

module.exports = {
    TABLE_EXTENSIONS, TABLE_COMMANDS, tableContent,
    cellContext, currentAlign, moveRow, moveColumn, setColumnAlign, looksTabular, gridToTable
};
