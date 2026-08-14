/*
 * Rendering for diff.js's hunks — requirement 15, "diff clarity".
 *
 * Three surfaces share this: reviewing a pending AI proposal, comparing two
 * recorded versions in history, and inspecting a save conflict. They render
 * identically on purpose, so a user learns the visual language once.
 *
 * The rule the markup encodes: the DECISION unit is a line-level hunk, and
 * word-level emphasis exists only to explain it. That is why accept/reject
 * controls hang off the hunk element and never off a word — highlighted
 * words carry no controls at all.
 */

const { ICONS } = require('./icons');

function escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One source line, with word-level emphasis when a counterpart was paired. */
function lineHtml(kind, number, text, parts, keep) {
    const gutter = number === undefined ? '' : String(number);
    let body;
    if (parts) {
        body = parts
            .filter(p => p.type === '=' || p.type === keep)
            .map(p => p.type === '='
                ? escapeHtml(p.text)
                : '<mark class="studio-diff-word">' + escapeHtml(p.text) + '</mark>')
            .join('');
    } else {
        body = escapeHtml(text);
    }
    const sign = kind === 'ins' ? '+' : kind === 'del' ? '−' : ' ';
    return '<div class="studio-diff-line ' + kind + '">' +
        '<span class="studio-diff-gutter">' + gutter + '</span>' +
        '<span class="studio-diff-sign">' + sign + '</span>' +
        '<span class="studio-diff-text">' + (body || '&nbsp;') + '</span></div>';
}

/** The line block of one hunk: leading context, removals, additions, trailing context. */
function hunkLinesHtml(hunk) {
    const rows = [];
    let n = hunk.oldStart - hunk.before.length + 1;
    for (const line of hunk.before) { rows.push(lineHtml('ctx', n++, line)); }
    hunk.oldLines.forEach((line, i) => rows.push(lineHtml('del', n++, line, hunk.words[i], '-')));
    hunk.newLines.forEach((line, i) => rows.push(lineHtml('ins', undefined, line, hunk.words[i], '+')));
    let after = hunk.oldStart + hunk.oldCount + 1;
    for (const line of hunk.after) { rows.push(lineHtml('ctx', after++, line)); }
    return rows.join('');
}

function summarise(hunk) {
    const added = hunk.newLines.length;
    const removed = hunk.oldLines.length;
    if (hunk.kind === 'insert') { return added + (added === 1 ? ' line added' : ' lines added'); }
    if (hunk.kind === 'delete') { return removed + (removed === 1 ? ' line removed' : ' lines removed'); }
    return removed + ' → ' + added + ' lines';
}

/**
 * A reviewable hunk: the diff plus its decision controls.
 * `decision` is undefined, 'accepted' or 'rejected'.
 */
function reviewHunkHtml(hunk, decision, index, total) {
    const decided = !!decision;
    return '<div class="studio-hunk' + (decided ? ' decided ' + decision : '') + '" data-hunk="' + hunk.id + '">' +
        '<div class="studio-hunk-head">' +
        '<span class="studio-hunk-index">' + (index + 1) + ' of ' + total + '</span>' +
        '<span class="studio-hunk-summary">' + summarise(hunk) + '</span>' +
        '<span class="studio-hunk-spacer"></span>' +
        (decided
            ? '<span class="studio-hunk-verdict">' + (decision === 'accepted' ? 'Accepted' : 'Rejected') + '</span>'
            : '<button class="studio-icon-btn accept" data-act="hunk-accept" data-id="' + hunk.id + '" title="Accept this change" aria-label="Accept this change">' + ICONS.check + '</button>' +
              '<button class="studio-icon-btn danger" data-act="hunk-reject" data-id="' + hunk.id + '" title="Reject this change" aria-label="Reject this change">' + ICONS.close + '</button>') +
        '</div>' +
        '<div class="studio-diff">' + hunkLinesHtml(hunk) + '</div>' +
        '</div>';
}

/** A read-only comparison of two versions — history, and the conflict view. */
function comparisonHtml(hunks, options) {
    const opts = options || {};
    if (!hunks.length) {
        return '<div class="studio-diff-empty">These two versions are identical.</div>';
    }
    return (opts.heading ? '<div class="studio-diff-heading">' + escapeHtml(opts.heading) + '</div>' : '') +
        hunks.map(hunk =>
            '<div class="studio-hunk read-only" data-hunk="' + hunk.id + '">' +
            '<div class="studio-hunk-head"><span class="studio-hunk-summary">' + summarise(hunk) +
            '</span><span class="studio-hunk-spacer"></span>' +
            '<span class="studio-hunk-index">line ' + (hunk.oldStart + 1) + '</span></div>' +
            '<div class="studio-diff">' + hunkLinesHtml(hunk) + '</div></div>'
        ).join('');
}

const DIFF_CSS = `
.studio-hunk {
  border: 1px solid var(--studio-line); border-radius: 9px; overflow: hidden; margin-bottom: 10px;
  background: var(--studio-surface);
}
.studio-hunk.decided { opacity: .58; }
.studio-hunk.decided.accepted { border-color: color-mix(in srgb, var(--studio-amber) 55%, var(--studio-line)); }
.studio-hunk.decided.rejected { border-color: color-mix(in srgb, var(--studio-danger) 45%, var(--studio-line)); }
.studio-hunk.current { border-color: var(--studio-amber); box-shadow: 0 0 0 3px var(--studio-focus); }
.studio-hunk-head {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px 5px 10px;
  border-bottom: 1px solid var(--studio-line); background: var(--studio-surface-raised);
}
.studio-hunk-spacer { flex: 1; }
.studio-hunk-index { font-size: 10.5px; color: var(--studio-muted); font-variant-numeric: tabular-nums; }
.studio-hunk-summary { font-size: 11.5px; color: var(--studio-muted); }
.studio-hunk-verdict { font-size: 11px; font-weight: 650; color: var(--studio-muted); padding-right: 6px; }
.studio-hunk.accepted .studio-hunk-verdict { color: var(--studio-amber); }
.studio-hunk.rejected .studio-hunk-verdict { color: var(--studio-danger); }
.studio-icon-btn.accept:hover { background: color-mix(in srgb, var(--studio-amber) 16%, transparent); color: var(--studio-amber); }

.studio-diff {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.8px; line-height: 1.65;
  overflow-x: auto; background: var(--studio-bg);
}
.studio-diff-line { display: flex; align-items: baseline; white-space: pre; min-width: min-content; }
.studio-diff-gutter {
  flex: none; width: 40px; padding: 0 8px 0 0; text-align: right; color: var(--studio-muted);
  opacity: .65; font-variant-numeric: tabular-nums; user-select: none;
}
.studio-diff-sign { flex: none; width: 14px; text-align: center; color: var(--studio-muted); user-select: none; }
.studio-diff-text { flex: 1; padding-right: 12px; white-space: pre-wrap; word-break: break-word; }
/* Line level first: an inserted or removed line is legible as such before any
   word inside it is read. Word emphasis then explains it, one step quieter. */
.studio-diff-line.ins { background: color-mix(in srgb, var(--studio-amber) 11%, transparent); }
.studio-diff-line.del { background: color-mix(in srgb, var(--studio-danger) 10%, transparent); }
.studio-diff-line.del .studio-diff-text { text-decoration: none; }
.studio-diff-word { background: transparent; color: inherit; border-radius: 3px; padding: 0 1px; font-weight: 650; }
.studio-diff-line.ins .studio-diff-word { background: color-mix(in srgb, var(--studio-amber) 30%, transparent); }
.studio-diff-line.del .studio-diff-word { background: color-mix(in srgb, var(--studio-danger) 26%, transparent); }
.studio-diff-empty { font-size: 12.5px; color: var(--studio-muted); padding: 10px 2px; }
.studio-diff-heading { font-size: 11.5px; color: var(--studio-muted); margin: 0 0 8px; }
`;

module.exports = { reviewHunkHtml, comparisonHtml, hunkLinesHtml, summarise, escapeHtml, DIFF_CSS };
