/*
 * Delimited text <-> a grid of strings. CSV, TSV, and the two relatives.
 *
 * WHY THIS IS ITS OWN MODULE. Same reason markdown.js is separate from
 * markdown-editor.js and diff.js from diff-view.js: this is the layer where a
 * bug rewrites somebody's data file rather than showing up as a broken pixel,
 * so it has to be testable without a browser. table-data-test.mjs requires it
 * directly, with no DOM and no Theia.
 *
 * THE ONE PROMISE IT MAKES. serialize(parse(text)) === text for a well-formed
 * file. Not "the same data" — the same BYTES. Everything below that looks like
 * over-engineering is in service of that: the line ending is detected rather
 * than assumed, the trailing newline is remembered rather than added, the
 * delimiter survives the round trip, and a file that quoted every field gets
 * every field quoted back.
 *
 * It cannot promise it for every file, because CSV is a family of conventions
 * rather than a format — `a,"b",c` and `a,b,c` parse identically and only one
 * of them can be written back. So the codec makes the round trip CHECKABLE
 * instead of pretending: the editor re-serialises at load, compares, and says
 * "formatting will normalise on save" when the two differ. That is the same
 * mechanism, and the same wording, the Markdown editor uses for its own
 * lossy-construct check (markdown-editor.js checkFidelity / willReformat).
 *
 * WHAT IS DELIBERATELY NOT HERE. No type inference. A cell holding `007` or
 * `2026-01-02` or `1.10` stays that string, and nothing in this file ever looks
 * at what a value might mean. Inference is how a spreadsheet turns a part
 * number into a float and a gene name into a date, and the whole point of
 * editing the file in place is that the file is the source of truth.
 */

const TAB = '\t';

/*
 * The delimiter each extension declares. `.tab` is the older spelling of
 * `.tsv`; `.psv` is pipe-separated, which is what a lot of database exports
 * produce because pipes are rare in prose.
 */
const EXTENSION_DELIMITER = {
    '.csv': ',',
    '.tsv': TAB,
    '.tab': TAB,
    '.psv': '|'
};

const TABLE_EXTENSIONS = Object.keys(EXTENSION_DELIMITER);

/*
 * The delimiters the sniffer will consider and the editor will offer by name.
 * Semicolon has no extension of its own and never will: a semicolon-separated
 * file is called `.csv` everywhere Excel has been configured for a locale whose
 * decimal separator is the comma, which is most of Europe. That is exactly the
 * case the sniffer below exists for.
 */
const DELIMITERS = [
    { value: ',', label: 'Comma' },
    { value: ';', label: 'Semicolon' },
    { value: TAB, label: 'Tab' },
    { value: '|', label: 'Pipe' }
];

const QUOTE = '"';

function extensionOf(name) {
    const dot = String(name || '').lastIndexOf('.');
    return dot < 0 ? '' : String(name).slice(dot).toLowerCase();
}

/** True for a file this codec claims. Used by the open handler. */
function isTableFile(name) {
    return TABLE_EXTENSIONS.includes(extensionOf(name));
}

function labelFor(delimiter) {
    const found = DELIMITERS.find(d => d.value === delimiter);
    return found ? found.label : 'Custom';
}

// --- detection --------------------------------------------------------------

/*
 * Which line ending this file uses, from the first one that ENDS A RECORD.
 *
 * Skipping quoted runs is not fussiness. A quoted cell holding a paragraph
 * carries \n characters of its own, and a plain indexOf would read the first of
 * those as the file's line ending — so a CRLF export whose first cell is a
 * quoted paragraph would be written back with LF endings, i.e. a diff on every
 * line of a file whose data did not change. Costs one pass; removes a whole
 * class of spurious "formatting will normalise" warnings.
 */
function detectEol(text) {
    const body = String(text || '');
    let inQuotes = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (inQuotes) {
            if (ch !== QUOTE) { continue; }
            if (body[i + 1] === QUOTE) { i++; continue; }
            inQuotes = false;
            continue;
        }
        if (ch === QUOTE) { inQuotes = true; continue; }
        if (ch === '\r') { return body[i + 1] === '\n' ? '\r\n' : '\r'; }
        if (ch === '\n') { return '\n'; }
    }
    // No record ever ended: a single line with no terminator. LF is what this
    // product would add if the user ever gives it one.
    return '\n';
}

/*
 * Count candidate delimiters in the first RECORD, skipping quoted runs.
 *
 * Record, not line: a quoted field may contain line breaks, so the scan only
 * stops at a line terminator it meets outside quotes. Getting that wrong would
 * make a file whose first cell is a quoted paragraph look like it had no
 * delimiters at all.
 */
function countCandidates(text) {
    const counts = new Map();
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch !== QUOTE) { continue; }
            if (text[i + 1] === QUOTE) { i++; continue; }
            inQuotes = false;
            continue;
        }
        if (ch === QUOTE) { inQuotes = true; continue; }
        if (ch === '\n' || ch === '\r') { break; }
        counts.set(ch, (counts.get(ch) || 0) + 1);
    }
    return counts;
}

/*
 * The file's dialect: what to split on, what to end lines with, and whether the
 * last record is followed by a newline.
 *
 * The extension is the default and it wins ties, so a `.tsv` full of commas
 * inside its cells is still tab-separated. The sniffer only overrules it when
 * another candidate is STRICTLY more frequent in the first record, which is the
 * semicolon-CSV case and little else.
 */
function detectDialect(name, text) {
    const body = String(text || '');
    const fallback = EXTENSION_DELIMITER[extensionOf(name)] || ',';
    const counts = countCandidates(body);
    let delimiter = fallback;
    let best = counts.get(fallback) || 0;
    for (const candidate of DELIMITERS) {
        const n = counts.get(candidate.value) || 0;
        if (n > best) { best = n; delimiter = candidate.value; }
    }
    return {
        delimiter,
        eol: detectEol(body),
        // A file that does not end in a newline is unusual but legal, and adding
        // one on the first save would show up as a diff nobody asked for.
        trailingNewline: /\n$|\r$/.test(body)
    };
}

// --- parse ------------------------------------------------------------------

/*
 * RFC 4180 with the concessions reality requires.
 *
 * Never throws. A malformed file — in practice, one with a quote that is never
 * closed — is reported through `malformed` and still parsed as far as it goes,
 * because the editor's answer to that is to open the file read-only and say
 * why. Throwing would leave the user with a tab that failed to open and no
 * information about a file they can plainly see is there.
 *
 * `rows` is RAGGED, exactly as the source is. Padding every row to the widest
 * one here would mean saving a file adds delimiters to lines that never had
 * them; the grid pads for display and the serialiser writes what each row
 * actually holds.
 */
function parse(text, delimiter) {
    const body = String(text || '');
    const rows = [];
    let row = [];
    let field = '';
    let quotedField = false;
    let inQuotes = false;
    let fields = 0;
    let quotedFields = 0;
    let malformed = '';

    const endField = () => {
        row.push(field);
        fields++;
        if (quotedField) { quotedFields++; }
        field = '';
        quotedField = false;
    };
    const endRow = () => { endField(); rows.push(row); row = []; };

    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (inQuotes) {
            if (ch !== QUOTE) { field += ch; continue; }
            // A doubled quote is one literal quote; a single one closes the field.
            if (body[i + 1] === QUOTE) { field += QUOTE; i++; continue; }
            inQuotes = false;
            continue;
        }
        // Only an OPENING quote quotes a field. A quote arriving mid-field
        // (`a"b`) is undefined in RFC 4180 and is kept as literal text here,
        // which is what every tolerant reader does. It will be written back as
        // `"a""b"`, so the load-time round-trip check reports the reformat
        // rather than the file changing shape in silence.
        if (ch === QUOTE && field === '') { inQuotes = true; quotedField = true; continue; }
        if (ch === delimiter) { endField(); continue; }
        if (ch === '\r') { if (body[i + 1] === '\n') { i++; } endRow(); continue; }
        if (ch === '\n') { endRow(); continue; }
        field += ch;
    }

    if (inQuotes) { malformed = 'a quoted field is never closed'; }
    /*
     * Close the last record only if there IS one. After a trailing newline
     * both `field` and `row` are empty and there is nothing left to end —
     * treating that as a final empty record is how a round trip grows a blank
     * line every time the file is saved.
     */
    if (field !== '' || row.length) { endRow(); }

    return {
        rows,
        malformed,
        /*
         * Whether the source quoted everything or only what needed it. A file
         * written by a tool that quotes every field is a real and common style,
         * and re-writing it in minimal style would show up as a diff on every
         * line of a file whose data did not change.
         */
        quoteStyle: fields > 0 && quotedFields === fields ? 'all' : 'minimal'
    };
}

// --- serialise --------------------------------------------------------------

function needsQuotes(value, delimiter) {
    return value.indexOf(delimiter) >= 0 || value.indexOf(QUOTE) >= 0 ||
        value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0;
}

/*
 * Deliberately NOT quoting for leading or trailing spaces.
 *
 * ` b` in `a, b` round trips as itself with no quotes, and quoting it would put
 * `a," b"` on disk — a diff on most of the hand-written CSVs in the world, in
 * exchange for a distinction no reader of this file makes.
 */
function quoted(value) {
    return QUOTE + value.replace(/"/g, '""') + QUOTE;
}

function serialize(rows, dialect) {
    const list = rows || [];
    if (!list.length) { return ''; }
    const delimiter = (dialect && dialect.delimiter) || ',';
    const eol = (dialect && dialect.eol) || '\n';
    const all = !!dialect && dialect.quoteStyle === 'all';
    const text = list.map(row => (row || []).map(cell => {
        const value = cell === undefined || cell === null ? '' : String(cell);
        return all || needsQuotes(value, delimiter) ? quoted(value) : value;
    }).join(delimiter)).join(eol);
    // `false` means the source genuinely had no final newline; undefined means
    // nobody asked, and a text file ending in one is the norm.
    return dialect && dialect.trailingNewline === false ? text : text + eol;
}

// --- grid helpers -----------------------------------------------------------

/** The widest row. What the grid renders; NOT what the file contains. */
function columnCount(rows) {
    return (rows || []).reduce((widest, row) => Math.max(widest, (row || []).length), 0);
}

/**
 * Write one cell, growing that row to reach it.
 *
 * Growing only the row that was typed into is the whole point: a ragged file
 * stays ragged except on the line the user actually edited.
 */
function setCell(rows, rowIndex, columnIndex, value) {
    while (rows.length <= rowIndex) { rows.push([]); }
    const row = rows[rowIndex];
    while (row.length <= columnIndex) { row.push(''); }
    row[columnIndex] = value;
}

/** Insert a row of empty cells, as wide as the grid currently shows. */
function insertRow(rows, at) {
    const width = Math.max(1, columnCount(rows));
    rows.splice(Math.max(0, Math.min(at, rows.length)), 0, new Array(width).fill(''));
}

/*
 * Insert a column into every row — including the short ones, which have to be
 * padded first or the insert would land at a different logical column on each
 * of them. This is the one operation that legitimately regularises a ragged
 * file, because a column is a property of the whole table.
 */
function insertColumn(rows, at) {
    const width = columnCount(rows);
    const index = Math.max(0, Math.min(at, width));
    for (const row of rows) {
        while (row.length < width) { row.push(''); }
        row.splice(index, 0, '');
    }
}

function deleteRow(rows, at) {
    if (at >= 0 && at < rows.length) { rows.splice(at, 1); }
}

function deleteColumn(rows, at) {
    for (const row of rows) {
        if (at >= 0 && at < row.length) { row.splice(at, 1); }
    }
}

/*
 * A clipboard payload that is a BLOCK of cells rather than one value.
 *
 * Copying a range out of Excel, Numbers, Sheets or this product's own grid puts
 * tab-separated rows on the clipboard, so a paste into a cell should fill a
 * block. Returns undefined for anything that is a single value, which is then
 * left to the browser's own plain-text paste.
 *
 * Parsed with the CSV parser rather than split(), so a copied cell that itself
 * contains a tab or a newline (which the source quotes) arrives as one cell.
 */
function parseClipboardGrid(text) {
    const normalised = String(text || '').replace(/\r\n?/g, '\n');
    if (!/[\t\n]/.test(normalised)) { return undefined; }
    const { rows } = parse(normalised.replace(/\n$/, ''), TAB);
    if (rows.length === 0) { return undefined; }
    if (rows.length === 1 && rows[0].length <= 1) { return undefined; }
    return rows;
}

module.exports = {
    TABLE_EXTENSIONS,
    DELIMITERS,
    extensionOf,
    isTableFile,
    labelFor,
    detectDialect,
    detectEol,
    parse,
    serialize,
    columnCount,
    setCell,
    insertRow,
    insertColumn,
    deleteRow,
    deleteColumn,
    parseClipboardGrid
};
