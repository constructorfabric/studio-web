/*
 * The Measured tab — the rail's second tab, and the answer to a rule stated in
 * PLAN-quality.md §1: a number earns a place in the Findings tab by crossing a
 * line somebody drew, or by being the size of something a person can act on.
 * Every other number that exists in the envelope — the ones that do not clear
 * that bar — still has to live SOMEWHERE, because suppressing a number is only
 * honest if the answer is designed and findable. This module is that "one
 * click away".
 *
 * WHY A TAB, AND NOT A DISCLOSURE AT THE FOOT OF THE FINDINGS LIST. That was
 * tried first and rejected: a collapsed row at the bottom of a scrolling list
 * of cards is not findable in the way a second tab, sitting next to "Findings
 * 16" at the same visual weight, is findable. A person who never scrolls to
 * the foot of a sixteen-card list would never learn the row was there, and at
 * that point "not broadcast" and "hidden" are the same experience. A tab is a
 * standing, permanent piece of the rail's chrome — it is visible on the empty
 * project (14 of 86 documents have nothing to broadcast) exactly as it is on
 * the worst one, which is the only way "the answer is findable" is actually
 * true rather than asserted.
 *
 * WHAT THIS FILE OWNS. Four shapes of value (CONTRACT-quality.md §2's
 * `measures[]`), the `gates[]` verdicts, and the analyser credit line at the
 * foot — nothing else. It renders HTML strings and a CSS constant; it does not
 * touch a node, does not attach a listener, and does not know what
 * `data-act` handlers exist. `quality-view.js` owns the DOM, the click
 * dispatch and the state machine (`docTypeOpen`, `openSegment`, …) that this
 * module only reads. That split is this codebase's standard one for a view
 * module — `search-view.js` draws the same line — and it is what lets this
 * file be proved correct with `node` and a hand-built envelope, with no
 * Theia and no browser, before the widget that hosts it exists.
 *
 * THE FOUR SHAPES, RENDERED FOUR WAYS, ON PURPOSE. `quantity`, `category`,
 * `distribution` and the gate verdict are visually unrelated below because
 * making them look alike would be the lie this whole tab exists to avoid — a
 * document type is not a rate, and rendering both as "a number and a bar"
 * erases the fact that one of them can be wrong in a way a person corrects and
 * the other cannot. See CONTRACT-quality.md §2 for the wire shapes and
 * PLAN-quality.md §5 for the rendering table this file implements literally.
 */

const { esc } = require('./comment-ui');
const { ICONS } = require('./icons');

/* ------------------------------------------------------------------------ *
 * Small, shared formatting helpers. Nothing here talks to the DOM.
 * ------------------------------------------------------------------------ */

/*
 * Every actionable quantity in the real corpus (leak share, dup rate) is a
 * fraction in [0, 1] read as a percentage — that is what the fixtures actually
 * contain, and it is the only shape this renderer has evidence for. A future
 * quantity that is a raw count would need `unit: 'count'` to opt out of the
 * percent reading; that is a guess this file states rather than hides, since
 * quality-scan.js — the module that would settle it for real — does not exist
 * yet (CONTRACT-quality.md §0).
 */
function formatQuantityValue(value, unit) {
    if (typeof value !== 'number' || !Number.isFinite(value)) { return String(value == null ? '—' : value); }
    if (unit === 'count') { return value.toLocaleString(); }
    if (value >= 0 && value <= 1) { return (value * 100).toFixed(1).replace(/\.0$/, '') + '%'; }
    return value.toLocaleString();
}

/* "12 Aug" — the same short, dateline register `relativeTime` in comment-ui.js
 * falls back to once relative time stops being useful, reused here because a
 * run history is measured in days, not minutes. */
function formatDay(at) {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) { return ''; }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* 1st / 2nd / 3rd / 4th — English ordinal suffixes, used nowhere else in this
 * product because nothing else ranks a document against its siblings. */
function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/*
 * The distribution's four roles, in the fixed reading order the corpus's own
 * `mixture` object already comes in (requirement, design, decision, other) —
 * see tests/fixtures/quality/purpose/mcp-engine__PRD.md.json. Fixed order and
 * fixed labels, rather than deriving either from whatever keys happen to be
 * present, is what keeps "design" in the same slot — and the same segment
 * colour — on every document, so a reader does not have to re-learn the
 * legend each time the mixture is redrawn.
 */
const ROLE_ORDER = ['requirement', 'design', 'decision', 'other'];
const ROLE_LABEL = { requirement: 'Requirements', design: 'Design', decision: 'Decisions', other: 'Framing' };

/*
 * `quality-scan.js` may not exist yet — CONTRACT-quality.md §0 says it is
 * being written in parallel and this module must not depend on it at
 * verification time — so the document-type vocabulary is read defensively:
 * `quality-scan.DOC_TYPES` when the module is there to ask, `state.docTypes`
 * otherwise. Neither is hard-coded here, per the brief: the picker in this
 * panel is the one place a wrong doc-type inference gets corrected, and a
 * hard-coded list would silently drift from whatever the detector actually
 * accepts.
 */
function resolveDocTypes(state) {
    let scan = null;
    try { scan = require('./quality-scan'); } catch (e) { /* not written yet, or not on this build */ }
    const list = (scan && Array.isArray(scan.DOC_TYPES) && scan.DOC_TYPES.length) ? scan.DOC_TYPES : (state.docTypes || []);
    /* A bare string list and a [{key,label}] list are both honoured — the
     * exact shape `quality-scan.js` will export is not settled yet, and
     * guessing wrong here should not mean the control fails to render. */
    return list.map(entry => (typeof entry === 'string' ? { key: entry, label: entry } : entry));
}

/* ------------------------------------------------------------------------ *
 * quantity — the number, its threshold, its rank, its history.
 * ------------------------------------------------------------------------ */

/*
 * "the highest of 86 documents in this project", from the `{ rank, of }`
 * quality-scan.js hands over.
 *
 * THE WORDS BELONG HERE AND THE POSITION BELONGS THERE, and getting that
 * backwards is not a stylistic matter: this file previously escaped the object
 * straight into the panel, which rendered a literal "[object Object]" next to a
 * real duplication rate — the two modules had each documented the opposite
 * decision about who formats it. The engine is right to keep it as data, since
 * "3rd of 86" and "the highest of 86" are both faithful renderings of the same
 * fact and only a view knows which one it wants. A plain string is still
 * accepted, so a caller that composes its own sentence is not broken by this.
 */
function rankSentence(rank) {
    if (!rank) { return ''; }
    if (typeof rank === 'string') { return rank; }
    const position = Number(rank.rank);
    const total = Number(rank.of);
    if (!Number.isFinite(position) || !Number.isFinite(total) || total < 2) { return ''; }
    const of = ' of ' + total + ' documents in this project';
    return (position === 1 ? 'the highest' : ordinal(position) + ' highest') + of;
}

/* 1st, 2nd, 3rd, 4th — and 11th/12th/13th, which the last-digit rule alone
 * gets wrong. */
function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) { return n + 'th'; }
    const last = n % 10;
    return n + (last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th');
}

/**
 * One `valueType: 'quantity'` measure: leak share, duplication rate — a
 * number with an optional threshold and an optional rank among this
 * project's own documents. Both are rendered when present; neither is
 * invented when absent, which is why leak share (which has a threshold) and
 * duplication (which the corpus shows does not discriminate enough to earn
 * one — PLAN §1) can share this one renderer without either looking like the
 * other's twin.
 */
function quantityRowHtml(measure) {
    if (!measure) { return ''; }
    const valueText = formatQuantityValue(measure.value, measure.unit);
    const unitSuffix = (measure.unit && measure.unit !== 'count' && measure.unit !== '%')
        ? ' <span class="studio-quality-quantity-unit">' + esc(measure.unit) + '</span>' : '';

    let thresholdHtml = '';
    if (measure.threshold != null) {
        const thresholdText = formatQuantityValue(measure.threshold, measure.unit);
        const over = !!measure.breached;
        thresholdHtml =
            '<span class="studio-quality-quantity-threshold">limit ' + esc(thresholdText) + '</span>' +
            '<span class="studio-quality-quantity-flag ' + (over ? 'over' : 'within') + '">' +
            (over ? ICONS.close : ICONS.check) +
            '<span class="studio-visually-hidden">' + (over ? 'over the limit' : 'within the limit') + '</span>' +
            '</span>';
    }

    /* The rank sentence. The POSITION is handed over — quality-scan.js owns the
     * cross-document reach and this file could not compute it — but the WORDS
     * are composed here; see rankSentence, and the seam it exists to close. */
    const rank = rankSentence(measure.rankInProject);
    const rankHtml = rank
        ? '<p class="studio-quality-quantity-rank">' + esc(rank) + '</p>' : '';

    const noteHtml = measure.note
        ? '<p class="studio-quality-quantity-note">' + esc(measure.note) + '</p>' : '';

    const spark = sparklineHtml(measure.series);

    return (
        '<div class="studio-quality-quantity">' +
        '<div class="studio-quality-quantity-head">' +
        '<span class="studio-quality-quantity-label">' + esc(measure.label || measure.name) + '</span>' +
        '<span class="studio-quality-quantity-value">' + esc(valueText) + '</span>' + unitSuffix +
        thresholdHtml +
        '</div>' +
        rankHtml + noteHtml +
        (spark ? '<div class="studio-quality-quantity-spark">' + spark + '</div>' : '') +
        '</div>'
    );
}

/* ------------------------------------------------------------------------ *
 * category — the value, its provenance, and the one control that matters.
 * ------------------------------------------------------------------------ */

/**
 * The document-type measure. PLAN-quality.md calls this "the highest-leverage
 * control in the whole feature": it is inferred from the filename and it is
 * the INPUT to the purpose detector, so a wrong inference makes every one of
 * that detector's violations wrong too. That is why it sits first in
 * `measuredListHtml`, why its provenance is stated in words rather than left
 * implicit, and why the sentence "Everything below is judged against this" is
 * not decoration — it is the one fact a reader needs before trusting anything
 * else in the panel.
 *
 * `open` mirrors `state.docTypeOpen`: this module has no click handling of
 * its own, so whether the correction list is showing is a fact handed in,
 * not a fact this function keeps. The toggle button's own `data-act` is this
 * module's choice rather than a contract requirement (only the correcting
 * control's `data-act="quality-doctype"` / `data-type` are specified) —
 * `quality-view.js` is free to rename it if it wires up a different one.
 */
function categoryRowHtml(measure, docTypes, open) {
    if (!measure) { return ''; }
    const types = Array.isArray(docTypes) ? docTypes : [];
    const current = types.find(t => t.key === measure.value);
    const currentLabel = current ? current.label : String(measure.value == null ? 'unknown' : measure.value).toUpperCase();
    const origin = measure.origin || 'not stated';

    const options = open
        ? '<div class="studio-quality-doctype-options" role="listbox" aria-label="Correct the document type">' +
          types.map(t => (
              '<button type="button" class="studio-quality-doctype-option' + (t.key === measure.value ? ' current' : '') + '" ' +
              'data-act="quality-doctype" data-type="' + esc(t.key) + '" ' +
              'aria-selected="' + (t.key === measure.value ? 'true' : 'false') + '">' +
              esc(t.label) + (t.key === measure.value ? ' <span class="studio-quality-doctype-tag">current</span>' : '') +
              '</button>'
          )).join('') +
          '</div>'
        : '';

    return (
        '<div class="studio-quality-doctype">' +
        '<h3 class="studio-quality-heading">Document type</h3>' +
        '<div class="studio-quality-doctype-row">' +
        '<span class="studio-quality-doctype-value">' + esc(currentLabel) + '</span>' +
        '<button type="button" class="studio-quality-doctype-toggle" data-act="quality-doctype-toggle" ' +
        'aria-expanded="' + (open ? 'true' : 'false') + '">Change ' + ICONS.chevronRight + '</button>' +
        '<span class="studio-quality-doctype-origin">' + esc(origin) + '</span>' +
        '</div>' +
        options +
        '<p class="studio-quality-doctype-note">Everything below is judged against this.</p>' +
        '</div>'
    );
}

/* ------------------------------------------------------------------------ *
 * distribution — one stacked bar, checkable by clicking a segment.
 * ------------------------------------------------------------------------ */

/**
 * The one stacked bar. `measure.value` is the `{ role: share }` object the
 * purpose detector's `mixture` already is (see the fixture at
 * tests/fixtures/quality/purpose/mcp-engine__PRD.md.json). This is the only
 * legitimate home 2,252 section-role labels get in this feature — PLAN §1 and
 * §14 both rule out a labels feed — and a stacked bar is a CLAIM ("8% of this
 * document is DESIGN"), so it has to be checkable: every segment, including a
 * zero-share one, carries `data-act="quality-segment"` / `data-role`, and
 * `segmentSectionsHtml` is what a click on it opens.
 *
 * A zero-share segment is still drawn in the legend, with its true 0%, and is
 * skipped only in the BAR itself — a 0%-wide `<div>` with a border still
 * paints a hairline sliver, which would read as "trace amount" rather than
 * "measured, and it is zero". The legend is where a zero stays honest.
 */
function distributionHtml(measure) {
    if (!measure) { return ''; }
    const value = (measure.value && typeof measure.value === 'object') ? measure.value : {};
    const roles = ROLE_ORDER.filter(role => Object.prototype.hasOwnProperty.call(value, role));
    /* A role the fixed order does not know about is not dropped — it is
     * appended and given the last (faintest) segment colour on a cyclic
     * basis, rather than inventing a fifth hue, per the CSS's own rule. */
    const extra = Object.keys(value).filter(role => !ROLE_ORDER.includes(role));

    const allRoles = roles.concat(extra);
    const bar = allRoles.map((role, index) => {
        const share = Number(value[role]) || 0;
        if (share <= 0) { return ''; }
        const seg = (index % 4) + 1;
        const pct = (share * 100);
        return '<div class="studio-quality-seg" style="width:' + pct.toFixed(3) + '%;' +
            '--studio-quality-seg-color:var(--studio-quality-seg-' + seg + ')" ' +
            'data-act="quality-segment" data-measure="' + esc(measure.name || '') + '" data-role="' + esc(role) + '" ' +
            'role="button" tabindex="0" ' +
            'aria-label="' + esc((ROLE_LABEL[role] || role) + ' ' + formatQuantityValue(share) + ' — show the sections counted into it') + '">' +
            '</div>';
    }).join('');

    const legend = allRoles.map((role, index) => {
        const share = Number(value[role]) || 0;
        const seg = (index % 4) + 1;
        return '<button type="button" class="studio-quality-legend-item" data-act="quality-segment" ' +
            'data-measure="' + esc(measure.name || '') + '" data-role="' + esc(role) + '">' +
            '<span class="studio-quality-swatch" style="--studio-quality-seg-color:var(--studio-quality-seg-' + seg + ')" aria-hidden="true"></span>' +
            '<span class="studio-quality-legend-name">' + esc(ROLE_LABEL[role] || role) + '</span>' +
            '<span class="studio-quality-legend-pct">' + esc(formatQuantityValue(share)) + '</span>' +
            '</button>';
    }).join('');

    const note = measure.note
        ? '<p class="studio-quality-distribution-note">' + esc(measure.note) + '</p>' : '';

    return (
        '<div class="studio-quality-distribution">' +
        '<h3 class="studio-quality-heading">' + esc(measure.label || 'Balance') + '</h3>' +
        '<div class="studio-quality-bar" role="group" aria-label="Section-role balance">' + bar + '</div>' +
        '<div class="studio-quality-legend">' + legend + '</div>' +
        note +
        '</div>'
    );
}

/**
 * What a stacked-bar segment is actually made of — the click-through
 * `distributionHtml` promises. `measure.labelRefs` is `{ role: [ { path,
 * line_start, line_end }, … ] }`, the trimmed section references the
 * normaliser is expected to carry alongside the mixture (CONTRACT §2's
 * `labelRefs`); this function does not compute anything, it only lists what
 * it is given, honestly including the empty case — a zero-share segment with
 * no sections behind it says so instead of silently rendering nothing, which
 * would look identical to a rendering bug.
 *
 * The list is capped: a requirement-heavy PRD can have thirty sections in one
 * role, and thirty lines of "§X, lines 1–2" is a feed by another name — the
 * exact thing PLAN §14 rules out. Past the cap the rest are counted, not
 * listed, the same collapse `search-view.js` uses for an over-long result set.
 */
const SEGMENT_SECTIONS_CAP = 8;

function segmentSectionsHtml(measure, role) {
    if (!measure) { return ''; }
    const refs = (measure.labelRefs && Array.isArray(measure.labelRefs[role])) ? measure.labelRefs[role] : [];
    const share = (measure.value && typeof measure.value === 'object') ? Number(measure.value[role]) || 0 : 0;
    const label = ROLE_LABEL[role] || role;

    if (!refs.length) {
        return (
            '<div class="studio-quality-segment-sections">' +
            '<h4 class="studio-quality-segment-title">' + esc(label) + ' — ' + esc(formatQuantityValue(share)) + '</h4>' +
            '<p class="studio-quality-segment-empty">No sections were counted into this segment.</p>' +
            '</div>'
        );
    }

    const shown = refs.slice(0, SEGMENT_SECTIONS_CAP);
    const items = shown.map(ref => {
        const name = ref.leaf || ref.section || ref.path || '(untitled section)';
        const lines = (ref.line_start != null)
            ? 'lines ' + esc(String(ref.line_start)) + (ref.line_end != null && ref.line_end !== ref.line_start ? '–' + esc(String(ref.line_end)) : '')
            : '';
        return '<li class="studio-quality-segment-item">' +
            '<span class="studio-quality-segment-name" title="' + esc(ref.path || name) + '">' + esc(name) + '</span>' +
            (lines ? '<span class="studio-quality-segment-lines">' + lines + '</span>' : '') +
            '</li>';
    }).join('');
    const more = refs.length > shown.length
        ? '<li class="studio-quality-segment-more">+' + esc(String(refs.length - shown.length)) + ' more</li>' : '';

    return (
        '<div class="studio-quality-segment-sections">' +
        '<h4 class="studio-quality-segment-title">' + esc(label) + ' — ' + esc(formatQuantityValue(share)) + '</h4>' +
        '<ul class="studio-quality-segment-list">' + items + more + '</ul>' +
        '</div>'
    );
}

/* ------------------------------------------------------------------------ *
 * the sparkline — history, and only from the second run onward.
 * ------------------------------------------------------------------------ */

/**
 * An inline SVG sparkline over `series: [{ runId, at, value }]`.
 *
 * TWO RULES, BOTH FROM PLAN §5, AND BOTH EASY TO GET WRONG BY ACCIDENT.
 *
 * First: fewer than two points renders NOTHING, not a flat line and not a
 * single dot pretending to be a trend. A one-point series is not a history,
 * and drawing anything for it implies one exists.
 *
 * Second: the label says what the line is a history OF. It is built from
 * `.studio/quality/runs/`, i.e. since this feature started keeping records —
 * never from the document's own revision history, because this product
 * retains no such thing (PLAN §5, §13). "6 checks since 12 Aug" is a true
 * sentence about six stored runs; "6 checks since 12 Aug" read as "six edits
 * to this document" would be a fabrication this file is not going to make
 * easy to write by accident, so the wording is fixed here rather than left to
 * whichever caller assembles the row.
 */
function sparklineHtml(series, opts) {
    const points = Array.isArray(series) ? series.filter(p => p && Number.isFinite(Number(p.value))) : [];
    if (points.length < 2) { return ''; }
    const options = opts || {};

    const values = points.map(p => Number(p.value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1; // a flat series still draws a flat, honest line — never a divide-by-zero
    const W = 60, H = 16, PAD = 1.5;
    const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
    const coords = values.map((v, i) => {
        const x = PAD + i * stepX;
        const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
        return x.toFixed(2) + ',' + y.toFixed(2);
    });
    const last = coords[coords.length - 1].split(',');

    const svg =
        '<svg class="studio-quality-spark-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" ' +
        'preserveAspectRatio="none" aria-hidden="true">' +
        '<polyline points="' + coords.join(' ') + '" fill="none" stroke="currentColor" stroke-width="1.4" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="1.6" fill="currentColor"/>' +
        '</svg>';

    const label = options.label || (points.length + ' checks since ' + formatDay(points[0].at));

    return '<span class="studio-quality-sparkline" title="' + esc(String(options.title || label)) + '">' +
        svg + '<span class="studio-quality-spark-label">' + esc(label) + '</span></span>';
}

/* ------------------------------------------------------------------------ *
 * gates — pass / fail / not run, never a fourth state.
 * ------------------------------------------------------------------------ */

/**
 * The gate rows. `notRun` entries are folded in by `measuredListHtml` before
 * this is called (see there for why) so this function only ever sees the one
 * `gates[]` shape from CONTRACT §2: `{ name, status, observed, threshold,
 * reason }`. `skipped` reads as "not run" on screen, because that is the word
 * a person reads as a verdict; "skipped" reads as something a machine decided
 * to leave out, which is not what a missing traceability pass is.
 */
function gateRowsHtml(gates) {
    const rows = Array.isArray(gates) ? gates : [];
    if (!rows.length) { return '<p class="studio-quality-empty-note">No gates are defined for this document.</p>'; }

    return '<div class="studio-quality-gate-rows">' + rows.map(gate => {
        const status = gate.status === 'pass' ? 'pass' : gate.status === 'fail' ? 'fail' : 'skipped';
        const icon = status === 'pass' ? ICONS.checkCircle : status === 'fail' ? ICONS.close : ICONS.minusCircle;
        const statusText = status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : 'not run';

        let detail = '';
        if (status !== 'skipped' && gate.observed != null && gate.threshold != null) {
            detail = esc(formatQuantityValue(gate.observed)) + ' against ' + esc(formatQuantityValue(gate.threshold));
        } else if (gate.reason) {
            detail = esc(gate.reason);
        }

        return (
            '<div class="studio-quality-gate studio-quality-gate-' + status + '">' +
            '<span class="studio-quality-gate-icon" aria-hidden="true">' + icon + '</span>' +
            '<span class="studio-quality-gate-name">' + esc(gate.name) + '</span>' +
            '<span class="studio-quality-gate-status">' + esc(statusText) + '</span>' +
            (detail ? '<span class="studio-quality-gate-detail">' + detail + '</span>' : '') +
            '</div>'
        );
    }).join('') + '</div>';
}

/* ------------------------------------------------------------------------ *
 * the analyser credit line — the foot of the tab.
 * ------------------------------------------------------------------------ */

/*
 * "A finding whose analyser cannot be identified is never shown" is stated
 * for findings in CONTRACT-quality.md §2; the brief for this tab extends it
 * to measures too. Concretely: an analyzer entry with no `id` contributes
 * nothing to this line, silently — there is no number above this footer that
 * an unnamed analyser could be blamed for or credited with.
 */
function namedAnalyzers(analyzers) {
    return (Array.isArray(analyzers) ? analyzers : []).filter(a => a && a.id);
}

/* "purpose-classifier 0.3.0" and "bge-m3 reranker" are the same shape once you
 * notice it: id, then whatever distinguishes this build — a version number
 * for a versioned detector, a model name for one that is really a wrapper
 * around a model. Trying to special-case "which one is this" would need to
 * know something about each detector that this file has no business knowing. */
function analyzerLabel(a) {
    return (a.id + ' ' + (a.version || a.model || '')).trim();
}

function measuredFootText(state) {
    const envelope = (state && state.envelope) || {};
    const analyzers = namedAnalyzers(envelope.analyzers);
    if (!analyzers.length) {
        return 'No analyser for this document could be identified, so nothing above is attributed to one.';
    }

    const names = analyzers.map(analyzerLabel).filter(Boolean).join(' · ');

    /* Calibration, stated once for the whole line rather than once per
     * analyser: CONTRACT §2 says calibration is 'none' everywhere today, and
     * repeating "uncalibrated" four times would be noise where one honest
     * sentence does the job. The day one detector earns `calibration:
     * 'corpus'`, this starts naming the holdouts instead of speaking for all
     * of them — that branch exists below for exactly that day. */
    const uncalibrated = analyzers.filter(a => a.calibration !== 'corpus');
    let calibrationText;
    if (uncalibrated.length === analyzers.length) { calibrationText = 'every threshold uncalibrated'; }
    else if (!uncalibrated.length) { calibrationText = 'thresholds calibrated on this corpus'; }
    else { calibrationText = uncalibrated.map(a => a.id).join(', ') + ' uncalibrated'; }

    /* `benchmark: undefined` reads as "not benchmarked" — true of every
     * detector as of this writing, and worth a reader knowing rather than
     * leaving them to assume a build with a version number has been measured
     * against anything. */
    const unbenchmarked = analyzers.filter(a => a.benchmark === undefined);
    let benchmarkText = '';
    if (unbenchmarked.length === analyzers.length) { benchmarkText = 'not benchmarked'; }
    else if (unbenchmarked.length) { benchmarkText = unbenchmarked.map(a => a.id).join(', ') + ' not benchmarked'; }

    return [names, calibrationText, benchmarkText].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------------ *
 * measuredListHtml — the whole tab body, assembled in the order PLAN §5 mocks.
 * ------------------------------------------------------------------------ */

/**
 * The full contents of the rail's `listEl` when `state.tab === 'measured'`.
 *
 * ORDER IS NOT ARBITRARY. Document type comes first because it is the input
 * every purpose finding is judged against — putting it anywhere else would
 * bury the one control that can turn seven wrong violations into zero.
 * Balance (the distribution) comes next because it is the direct
 * justification for whatever the document-type gate says. The quantities
 * follow, then the gates, which are the verdicts those quantities feed —
 * reading top to bottom is reading cause before effect.
 *
 * `state.envelope.notRun` — axes with no detector behind them at all — is
 * folded into the same rows `gates[]` produces rather than given its own
 * section: PLAN's own mock shows "Traceability   not run   needs the LLM
 * pass" sitting in the Gates block next to Purpose, and a reader has no
 * reason to care that the two facts arrived from different arrays in the
 * envelope. `gateRowsHtml` itself stays ignorant of `notRun`'s shape — this
 * function is where the two are reconciled, so that export stays a pure
 * function of the one shape CONTRACT §2 actually specifies for `gates`.
 */
function measuredListHtml(state) {
    const envelope = (state && state.envelope) || {};
    const measures = Array.isArray(envelope.measures) ? envelope.measures : [];
    const gates = Array.isArray(envelope.gates) ? envelope.gates : [];
    const notRun = Array.isArray(envelope.notRun) ? envelope.notRun : [];

    const category = measures.find(m => m.valueType === 'category');
    const distributions = measures.filter(m => m.valueType === 'distribution');
    const quantities = measures.filter(m => m.valueType === 'quantity');

    if (!measures.length && !gates.length && !notRun.length) {
        return '<div class="studio-quality-empty">' +
            '<p class="studio-quality-empty-note">Nothing measured yet for this document.</p>' +
            '</div>';
    }

    const parts = [];

    if (category) {
        parts.push(categoryRowHtml(category, resolveDocTypes(state), !!state.docTypeOpen));
    }

    for (const measure of distributions) {
        let block = distributionHtml(measure);
        /* The click-through: `state.openSegment` names which segment (and,
         * optionally, which measure — a document could in principle carry
         * more than one distribution) is currently expanded. Its exact shape
         * is not settled by CONTRACT or PLAN, so both a bare role string and
         * a `{ measure, role }` pair are honoured; see this file's report for
         * why that is a judgment call rather than a specified contract. */
        const open = state.openSegment;
        const role = typeof open === 'string' ? open
            : (open && (!open.measure || open.measure === measure.name)) ? open.role : null;
        if (role) { block += segmentSectionsHtml(measure, role); }
        parts.push(block);
    }

    if (quantities.length) {
        parts.push('<div class="studio-quality-quantities">' + quantities.map(quantityRowHtml).join('') + '</div>');
    }

    /* `notRun` axes become skipped-looking gate rows with their `why` as the
     * reason, purely for display — the underlying arrays stay separate in the
     * envelope, only the two rowsets are interleaved here. Document order
     * from `gates[]` first, then the not-run axes, which is the same order
     * PLAN's mock uses (Purpose, then Traceability). */
    /*
     * An axis already present as a gate is NOT repeated as a not-run row.
     * `normalizeDocument` emits both for traceability when the LLM pass did not
     * run — a `skipped` gate AND a `notRun` axis — which rendered the panel as
     * "traceability / not run" followed three rows later by "Traceability / not
     * run", the same fact twice in two different capitalisations. The gate wins:
     * it is the one the envelope's `gates[]` contract actually specifies.
     */
    const named = new Set(gates.map(gate => String(gate && gate.name || '').toLowerCase()));
    const combinedGates = gates.concat(notRun
        .filter(entry => !named.has(String(entry && entry.axis || '').toLowerCase()))
        .map(entry => ({ name: entry.axis, status: 'skipped', reason: entry.why })));
    if (combinedGates.length) {
        parts.push('<section class="studio-quality-section studio-quality-gates">' +
            '<h3 class="studio-quality-heading">Gates</h3>' + gateRowsHtml(combinedGates) + '</section>');
    }

    return '<div class="studio-quality-measures">' + parts.join('<div class="studio-quality-sep"></div>') + '</div>';
}

/* ------------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------------ */

const MEASURES_CSS = `
/* --- the Measured tab (quality-measures.js) ------------------------------- *
 *
 * THE SEGMENT PALETTE. CONTRACT-quality.md §1 fixes the product's whole
 * palette at monochrome plus one accent (--studio-accent) plus one danger
 * (--studio-danger); a four-way stacked bar still needs four segments a
 * reader can tell apart without a legend, so these four stops are DERIVED
 * from the three tokens the contract already allows (amber, muted, line)
 * rather than adding a fifth hue. Because each stop is a var() reference
 * rather than a baked colour, it re-derives itself for free whenever the
 * theme switches -- there is deliberately no separate dark-mode block for
 * these four, unlike every other colour in this file's :root.
 *
 * Colour is never the ONLY distinction: the legend always carries the role's
 * name and its percentage in text, so the bar remains legible to a reader who
 * cannot separate the two middle stops by eye alone.
 */
:root {
  --studio-quality-seg-1: var(--studio-accent);
  --studio-quality-seg-2: color-mix(in srgb, var(--studio-accent) 55%, var(--studio-muted) 45%);
  --studio-quality-seg-3: color-mix(in srgb, var(--studio-muted) 60%, var(--studio-line) 40%);
  --studio-quality-seg-4: var(--studio-line);
}

.studio-quality-measures { display: flex; flex-direction: column; font-size: 13px; color: var(--studio-text); }
.studio-quality-sep { height: 1px; background: var(--studio-line); margin: 14px 0; flex: none; }
.studio-quality-heading {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  color: var(--studio-muted); margin: 0 0 8px;
}
.studio-quality-empty-note, .studio-quality-empty { color: var(--studio-muted); font-size: 12.5px; }

/* --- document type: the highest-leverage control in the panel ------------ */
/* A GRID, NOT A FLEX ROW WITH A FLEXIBLE PROVENANCE.
   The provenance was flex: 1 1 0%, so its basis was zero: it never triggered
   the row's wrap, it just shrank. "PRD — a product requirements document" is
   313px of a 326px row, which left the provenance a 5px column and its text
   spilling off the panel edge as "infer / from / the / filena". Two explicit
   rows instead: the type and its Change control on the first, the provenance
   on its own underneath, where a long value cannot reach it. */
.studio-quality-doctype-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 3px 8px;
}
.studio-quality-doctype-value {
  grid-column: 1; font-size: 15px; font-weight: 700; letter-spacing: .02em; color: var(--studio-text);
  overflow-wrap: break-word;
}
.studio-quality-doctype-origin { grid-column: 1 / -1; font-size: 11.5px; color: var(--studio-muted); }
.studio-quality-doctype-toggle {
  grid-column: 2; display: inline-flex; align-items: center; gap: 3px; background: none; border: none;
  cursor: pointer; font-size: 12px; color: var(--studio-accent); padding: 2px 0; justify-self: end;
}
.studio-quality-doctype-toggle svg { width: 12px; height: 12px; transform: rotate(90deg); }
.studio-quality-doctype-toggle[aria-expanded="true"] svg { transform: rotate(-90deg); }
.studio-quality-doctype-options {
  display: flex; flex-direction: column; gap: 2px; margin-top: 8px; padding: 6px;
  background: var(--studio-surface-sunken); border: 1px solid var(--studio-line); border-radius: var(--studio-radius);
}
.studio-quality-doctype-option {
  text-align: left; background: none; border: none; border-radius: 5px; cursor: pointer;
  padding: 5px 8px; font-size: 12.5px; color: var(--studio-text);
}
.studio-quality-doctype-option:hover { background: var(--studio-surface-raised); }
.studio-quality-doctype-option.current { color: var(--studio-muted); cursor: default; }
.studio-quality-doctype-tag { font-size: 10.5px; color: var(--studio-muted); }
/* "Everything below is judged against this" — the sentence that is the whole
   reason this control sits at the top of the tab rather than anywhere else. */
.studio-quality-doctype-note { font-size: 11.5px; color: var(--studio-muted); margin: 8px 0 0; font-style: italic; }

/* --- distribution: one stacked bar, checkable by clicking a segment ------- */
.studio-quality-bar {
  display: flex; width: 100%; height: 10px; border-radius: 5px; overflow: hidden;
  background: var(--studio-surface-sunken); border: 1px solid var(--studio-line);
}
.studio-quality-seg {
  height: 100%; background: var(--studio-quality-seg-color); flex: none; cursor: pointer;
  border-right: 1px solid var(--studio-surface); min-width: 0;
}
.studio-quality-seg:last-child { border-right: none; }
.studio-quality-seg:hover, .studio-quality-seg:focus-visible { filter: brightness(1.12); outline: none; }
.studio-quality-legend {
  display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-variant-numeric: tabular-nums;
}
.studio-quality-legend-item {
  display: inline-flex; align-items: center; gap: 5px; background: none; border: none; cursor: pointer;
  padding: 2px 0; font-size: 12px; color: var(--studio-text);
}
.studio-quality-swatch {
  width: 9px; height: 9px; border-radius: 2px; background: var(--studio-quality-seg-color); flex: none;
  border: 1px solid var(--studio-line);
}
.studio-quality-legend-pct { color: var(--studio-muted); }
/* The denominator sentence -- "by tokens, over 44 classified sections" -- is
   how n_sections and n_tokens are allowed to appear here at all: inside a
   sentence, never as their own tile (PLAN §1). */
.studio-quality-distribution-note { font-size: 11.5px; color: var(--studio-muted); margin: 8px 0 0; }

/* --- the click-through: what a segment is made of ------------------------- */
.studio-quality-segment-sections {
  margin-top: 8px; padding: 8px 10px; background: var(--studio-surface-sunken);
  border-left: 2px solid var(--studio-accent); border-radius: 0 5px 5px 0;
}
.studio-quality-segment-title { margin: 0 0 4px; font-size: 11.5px; font-weight: 700; color: var(--studio-text); }
.studio-quality-segment-empty { margin: 0; font-size: 12px; color: var(--studio-muted); }
.studio-quality-segment-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.studio-quality-segment-item, .studio-quality-segment-more {
  display: flex; justify-content: space-between; gap: 10px; font-size: 12px;
}
.studio-quality-segment-name { color: var(--studio-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-quality-segment-lines { color: var(--studio-muted); flex: none; font-variant-numeric: tabular-nums; }
.studio-quality-segment-more { color: var(--studio-muted); font-style: italic; }

/* --- quantity: the number, its threshold, its rank, its history ---------- */
.studio-quality-quantities { display: flex; flex-direction: column; gap: 14px; }
.studio-quality-quantity-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.studio-quality-quantity-label { font-weight: 600; color: var(--studio-text); flex: 1; min-width: 0; }
.studio-quality-quantity-value {
  font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--studio-text);
}
.studio-quality-quantity-unit { font-size: 11.5px; color: var(--studio-muted); }
.studio-quality-quantity-threshold { font-size: 11.5px; color: var(--studio-muted); font-variant-numeric: tabular-nums; }
.studio-quality-quantity-flag { display: inline-flex; align-items: center; }
.studio-quality-quantity-flag svg { width: 13px; height: 13px; }
.studio-quality-quantity-flag.over { color: var(--studio-danger); }
.studio-quality-quantity-flag.within { color: var(--studio-accent); }
.studio-quality-quantity-rank, .studio-quality-quantity-note {
  margin: 3px 0 0; font-size: 11.5px; color: var(--studio-muted);
}
.studio-quality-quantity-spark { margin-top: 4px; }

/* --- the sparkline: history, and named as such ---------------------------- */
.studio-quality-sparkline { display: inline-flex; align-items: center; gap: 6px; color: var(--studio-accent); }
.studio-quality-spark-svg { display: block; }
.studio-quality-spark-label { font-size: 11px; color: var(--studio-muted); font-variant-numeric: tabular-nums; }

/* --- gates: pass / fail / not run, and nothing a fourth colour would imply */
/* ONE GRID FOR ALL THE ROWS, not one flex row each. Per-row flex meant each
   row sized its own columns, so "Completeness" pushed its verdict and reason
   right while "purpose" left them where they were, and the reason column ran
   off the panel with no room to wrap. display:contents keeps the row element
   for the status selectors below while its four cells join the shared grid. */
.studio-quality-gate-rows {
  display: grid; grid-template-columns: auto auto auto minmax(0, 1fr);
  align-items: baseline; gap: 9px 8px; font-size: 12.5px;
}
.studio-quality-gate { display: contents; }
.studio-quality-gate-icon { display: inline-flex; flex: none; }
.studio-quality-gate-icon svg { width: 15px; height: 15px; }
.studio-quality-gate-pass .studio-quality-gate-icon { color: var(--studio-accent); }
.studio-quality-gate-fail .studio-quality-gate-icon { color: var(--studio-danger); }
.studio-quality-gate-skipped .studio-quality-gate-icon { color: var(--studio-muted); }
.studio-quality-gate-name { font-weight: 600; color: var(--studio-text); }
.studio-quality-gate-status { color: var(--studio-muted); }
.studio-quality-gate-fail .studio-quality-gate-status { color: var(--studio-danger); }
/* Wraps rather than ellipsises. On a "not run" row the reason IS the row's
   content — truncating "no detector exists for this yet" to "…for this …" hides
   the only thing it had to say, and the grid column above gives it the width to
   wrap into. */
.studio-quality-gate-detail {
  color: var(--studio-muted); font-size: 11.5px; font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
}

/* Screen-reader-only text, for the pass/fail glyph's spoken equivalent --
   the same pattern search-view.js's scope label uses. */
.studio-visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
`;

module.exports = {
    MEASURES_CSS,
    measuredListHtml,
    measuredFootText,
    distributionHtml,
    sparklineHtml,
    quantityRowHtml,
    categoryRowHtml,
    gateRowsHtml,
    segmentSectionsHtml
};
