/*
 * Quality — the project tab. Cross-document duplication and every link
 * verdict, in one place, because neither exists anywhere else.
 *
 * WHY A MAIN-DOCK TAB AND NOT A PANEL, and not the document rail either. A
 * duplicate cluster that spans sixteen files and a traceability verdict that
 * compares two documents are both facts about a DOCSET, not about the one
 * document a person happens to have open — opening PRD.md tells you nothing
 * about the six other files it repeats itself against. That is not a defect
 * in the rail, it is the rail's whole shape: one document, one column, 360px.
 * The same measurement that moved Search out of a 257px panel and into a
 * closable main-dock tab (search-view.js's own header explains the arithmetic)
 * applies again here, harder — a 16-file occurrence list plus the quote that
 * produced it does not fit a rail at any width worth keeping. So this is the
 * same class of surface as Search and the Project page: a tab you open when
 * you want it, costing nothing in the common case where nobody has.
 *
 * WHAT THIS TAB SHOWS, per PLAN-quality.md §9:
 *
 *   - SHARED BETWEEN DOCUMENTS. Every duplicate (and, once a docset has a
 *     judged run, drift) finding whose anchors touch more than one file, as a
 *     card: the quote, a provenance PHRASE (never a decimal, never a bar —
 *     CONTRACT-quality.md §1), and up to three occurrences with the rest
 *     folded behind a native <details> count. One real cluster in this
 *     product's own fixtures spans sixteen files; sixteen chips is a wall,
 *     not a list.
 *   - DOCUMENTS WITH SOMETHING TO ACT ON, as rows: a path and a plain-English
 *     summary of what is wrong with it — its own within-document repeats, its
 *     purpose gate, and how many of its repeats are shared with another file.
 *     Clicking a row opens the document, where ITS rail does the triage; this
 *     tab never repeats that surface's job.
 *   - CLEAN DOCUMENTS, COUNTED, NOT LISTED. The corpus this feature was built
 *     against has a median of two findings per document and 14 of 86 with
 *     none at all — a table of every document is mostly rows that say
 *     nothing, so a clean document is one integer.
 *   - THE NOT-EVALUATED LINE, ONCE. Traceability's LLM pass is the one axis
 *     that costs real money to run, and PLAN §9 is explicit: state that once,
 *     here, with its cost — not as an empty traceability panel repeated once
 *     per docset.
 *   - AN HONESTY LINE, monospace, in Search's own idiom: what was read, by
 *     which analysers, and whether their thresholds were ever calibrated.
 *     "Nothing shared" and "we could not read the last check" must never look
 *     alike, which is why they are two different functions below rather than
 *     one render path with a blank in it.
 *
 * WHAT THIS TAB DOES NOT SHOW, said out loud because this product says its
 * gaps in the UI as well as in the comments that produced it:
 *
 *   - SEVERITY. Nothing in any detector's output ranks a finding by
 *     importance (CONTRACT-quality.md, PLAN §14). The only two orders offered
 *     for the shared cards are REACH (measured) and DOCUMENT ORDER — the two
 *     PLAN §3 settles on, not a dropdown of five.
 *   - A WITHIN-ONE-DOCUMENT FINDING. A cluster whose occurrences never leave
 *     a single file is already in that document's own report and its own
 *     rail; showing it here too would double every count this tab presents
 *     as "shared". CONTRACT-quality.md §2 makes this a rule, not a preference.
 *   - A LIVE SCAN. This tab renders the LAST check that was written to
 *     `.studio/quality/runs/`; it does not run one. The header always says
 *     when that check happened, because a panel that cannot say how old it is
 *     invites more trust than it has earned (PLAN §13) — the same reason the
 *     document rail's clock never stops either.
 *
 * THE DOCSET BOUNDARY — PLAN §17 Q1, left open on purpose. The research this
 * feature is built from treats a docset as a service folder (PRD, DESIGN,
 * ADRs); Studio's unit is a connected project root, and a root holding six
 * services would make one cross-document run over all of them both slow and
 * wrong. This file does not resolve that: it renders ONE docset at a time and
 * shows a picker the moment more than one is found under the connected roots.
 * See `pickDefaultDocset` below for exactly how far that gets pushed and
 * where it runs out of information to go further.
 *
 * `quality-scan.js` AND `quality-store.js` MAY NOT EXIST YET — they are being
 * written by other agents against the same contract this file reads
 * (CONTRACT-quality.md §2). Both are required LAZILY, inside `load()`, and any
 * failure — missing file, missing export, a read that throws — funnels into
 * ONE rendered state: "analysis is not available here" (`renderUnavailable`).
 * That is not a stub for today; PLAN §11 asks the real runner to degrade the
 * same way when the Python side is absent, so this is the production
 * behaviour arriving early rather than a placeholder standing in for it.
 *
 * Exactly like `search-view.js`/`search-scan.js`: every piece of markup below
 * is a PURE function — data in, an HTML string out — and the widget class at
 * the foot does nothing but call `load()`, hold the small pile of UI state
 * (which docset is selected, which sort is active), and assign the string
 * these functions produce to one node. They are exported alongside the
 * widget for exactly the reason `search-scan.js` is a separate module: a
 * function that only takes data can be tested without a browser, and can be
 * fed the real fixtures to render a standalone preview page (see the
 * scratchpad script referenced in this feature's handoff notes).
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { open } = require('@theia/core/lib/browser/opener-service');
const { esc, relativeTime } = require('./comment-ui');
const { loadingMarkup } = require('./loader');

const QUALITY_PROJECT_WIDGET_ID = 'studio-quality-project';

/*
 * How long a bulk dismissal waits before it actually writes anything.
 *
 * CONTRACT-quality.md §6 (via PLAN §6): "a mis-click here writes to a file
 * that gets committed, so undo is not a nicety." Four seconds is long enough
 * to read the confirmation toast and react, short enough that a person who
 * meant it is not left staring at a tab that looks like nothing happened.
 */
const BULK_UNDO_MS = 4000;

/*
 * THE TWO NUMBERS BEHIND THE "NOT EVALUATED" LINE, AND WHERE THEY ARE FROM.
 *
 * Neither is inferable from the envelope this widget reads — the docset
 * envelope's own `notRun` entry (CONTRACT §2) says only THAT traceability was
 * not run and WHY, not how many pairs are waiting or what judging them would
 * cost. Both numbers below are the two real measurements that exist:
 *
 *   TRACE_TOTAL_PAIRS  — `extract_pairs()` found 2,198 candidate reference
 *                         pairs across the whole 86-document research corpus
 *                         (spec-quality-design-handoff.md, "How each file was
 *                         produced"). It is a PROJECT-WIDE figure, not a
 *                         per-docset one — the pair extractor's own output is
 *                         not part of the envelope contract, so there is no
 *                         per-docset split to show instead. Saying "across
 *                         the project" in the sentence below is the honest
 *                         fix rather than inventing a docset-scoped number.
 *   TRACE_RATE_PER_MIN — the one judged run that exists, `trace-overwork_
 *                         alert.json`, took 9 min 56 s for 112 pairs under
 *                         `gemini-3.7-flash` at the express-mode quota: 11.3
 *                         pairs/minute. That is "the measured rate" the mock
 *                         in PLAN §9 names.
 *
 * When `quality-store` starts recording a real per-project pair count and a
 * live rate from whatever runs have actually happened, these two constants
 * are what get deleted — `buildNotEvaluatedLine` already takes them as
 * parameters rather than closing over them, for exactly that day.
 */
const TRACE_TOTAL_PAIRS = 2198;
const TRACE_RATE_PER_MIN = 112 / (9 + 56 / 60);
const TRACE_JUDGED_EXAMPLE = { label: 'overwork_alert', pairs: 112 };

// -- small pure helpers -------------------------------------------------

function plural(n, singular, pluralForm) {
    return n === 1 ? singular : (pluralForm || singular + 's');
}

function groupDigits(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function truncate(text, max) {
    const s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

function baseName(path) {
    const s = String(path == null ? '' : path);
    return s.slice(s.lastIndexOf('/') + 1) || s;
}

/* The docset's display name: the last segment of its root. `scope.root` is
 * whatever quality-store resolved the connected folder to — a path or a URI
 * string — so this only ever looks at the tail of it. */
/*
 * The deepest directory every path shares, by name.
 *
 * Compared segment by segment rather than as strings, because a string prefix of
 * two sibling paths can end mid-segment and produce a name that is not a
 * directory at all. Returns '' when the paths share nothing, which the caller
 * reads as "fall back to the project's own name".
 */
function commonDirectoryName(paths) {
    const lists = (paths || []).filter(Boolean).map(p => String(p).split('/').filter(Boolean).slice(0, -1));
    if (!lists.length) { return ''; }
    let shared = lists[0];
    for (const list of lists.slice(1)) {
        let i = 0;
        while (i < shared.length && i < list.length && shared[i] === list[i]) { i++; }
        shared = shared.slice(0, i);
    }
    return shared.length ? shared[shared.length - 1] : '';
}

function docsetLabelFromRoot(root) {
    const s = String(root == null ? '' : root).replace(/\/+$/, '');
    return baseName(s) || 'this project';
}

// -- pure data shaping: envelope(s) -> the small view model below --------

/*
 * Every distinct file touched by a cross-document finding, and what it
 * shares with which other files.
 *
 * This is the join between "Shared between documents" (grouped by CLUSTER)
 * and "Documents with something to act on" (grouped by FILE) — both read the
 * same findings, differently sliced, and this is the one place that slicing
 * happens so the two sections cannot silently disagree about a count.
 */
function buildSharedIndex(findings) {
    const index = new Map();
    for (const finding of (findings || [])) {
        const files = [...new Set((finding.anchors || []).map(a => a && a.file).filter(Boolean))];
        for (const file of files) {
            if (!index.has(file)) { index.set(file, { count: 0, otherFiles: new Set(), weakFingerprints: [] }); }
            const entry = index.get(file);
            entry.count++;
            for (const other of files) { if (other !== file) { entry.otherFiles.add(other); } }
            if (finding.trust === 'weak' && finding.fingerprint) { entry.weakFingerprints.push(finding.fingerprint); }
        }
    }
    return index;
}

/*
 * One finding (CONTRACT §2 shape) -> one card's worth of shaped data.
 *
 * `trustPhrase` is injected rather than imported at module scope: it is
 * `quality-scan.trustPhrase`, required lazily by the widget because
 * quality-scan.js may not exist yet (see the header). Passing it in as a
 * parameter is also what keeps this function testable with a hand-written
 * fake, no module system involved.
 */
function buildSharedCard(finding, trustPhrase) {
    const anchors = finding.anchors || [];
    const files = [...new Set(anchors.map(a => a && a.file).filter(Boolean))];
    let phrase;
    try {
        /* The whole finding, not its band: the phrase is about how the match
         * was made, and provenance is what says that. Passing only the band is
         * what let a lexical cluster read as "matched by a model". */
        phrase = trustPhrase(finding) || finding.trust || '';
    } catch (e) {
        phrase = finding.trust || '';
    }
    return {
        fingerprint: finding.fingerprint,
        rule: finding.rule,
        trust: finding.trust,
        phrase,
        // `drift` findings carry their own one-line justification
        // (CONTRACT §2 `explain.reason`) the way a purpose violation does in
        // the document rail — a duplicate's phrase already says everything a
        // wording match needs said, so this stays empty for `duplicate`.
        reason: finding.rule === 'drift' ? ((finding.explain && finding.explain.reason) || '') : '',
        quote: finding.quote || '',
        reach: Number.isFinite(finding.reach) ? finding.reach : files.length,
        occurrences: anchors.map(a => ({
            file: a.file || '',
            label: baseName(a.file || ''),
            section: a.section || '',
            line: a.line,
            granularity: a.granularity
        })),
        // The tie-break for "document order": the earliest file, then line,
        // among this cluster's own anchors — a cluster has no single
        // document to sort by, so its EARLIEST occurrence stands in.
        sortKey: anchors.slice().sort((a, b) =>
            (a.file || '').localeCompare(b.file || '') || (a.line || 0) - (b.line || 0))
            .map(a => (a.file || '') + '#' + String(a.line || 0).padStart(8, '0')).join('|')
    };
}

/*
 * The two sorts PLAN §3 settles on and no others: REACH, because it is
 * measured, and DOCUMENT ORDER, because it needs no justification. Anything
 * resembling severity would be a fabrication rendered as a fact — see the
 * header comment.
 */
function sortCards(cards, mode) {
    const sorted = cards.slice();
    if (mode === 'document') {
        sorted.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    } else {
        sorted.sort((a, b) => (b.reach - a.reach) || a.sortKey.localeCompare(b.sortKey));
    }
    return sorted;
}

/*
 * One document envelope (CONTRACT §2, `scope.kind: 'document'`) -> one row.
 *
 * Two independent facts are combined into a short clause list, capped at
 * what the PLAN §9 mock itself shows (never more than two clauses) — a row
 * that tries to say everything about a document stops being scannable, which
 * is the entire reason clean documents are a count and not a row at all.
 */
function buildDocumentRow(documentEnvelope, sharedIndex) {
    const path = (documentEnvelope.document && documentEnvelope.document.path) || '';
    const openFindings = (documentEnvelope.findings || []).filter(f => f.status !== 'dismissed');
    const ownDuplicates = openFindings.filter(f => f.rule === 'duplicate').length;
    const purposeViolations = openFindings.filter(f => f.rule === 'purpose').length;
    const purposeGate = (documentEnvelope.gates || []).find(g => g.name === 'purpose');
    const purposeFailed = !!purposeGate && purposeGate.status === 'fail';
    const shared = sharedIndex.get(path);
    const sharedCount = shared ? shared.count : 0;

    const clauses = [];
    if (purposeFailed) { clauses.push('purpose gate failed'); }

    const repeatsClause = buildRepeatsClause(ownDuplicates, sharedCount, shared && shared.otherFiles);
    if (repeatsClause) {
        clauses.push(repeatsClause);
    } else if (purposeViolations > 0 && !purposeFailed) {
        // The one case the PLAN mock shows on its own: a document with a
        // purpose defect but no repeats at all reads the violation count the
        // same way a repeat count would, rather than inventing a second
        // sentence shape for one fact.
        clauses.push(purposeViolations + ' ' + plural(purposeViolations, 'section') + ' in the wrong voice');
    }

    return {
        path,
        label: baseName(path),
        clauses,
        clean: clauses.length === 0,
        weakFingerprints: shared ? shared.weakFingerprints.slice() : []
    };
}

function buildRepeatsClause(own, sharedCount, otherFiles) {
    if (!own && !sharedCount) { return ''; }
    if (!own) { return sharedCount + ' shared ' + plural(sharedCount, 'match', 'matches'); }
    let clause = own + ' ' + plural(own, 'repeat');
    if (sharedCount) { clause += ', ' + sharedCount + ' shared with ' + sharedLabel(otherFiles); }
    return clause;
}

function sharedLabel(otherFiles) {
    const files = otherFiles ? [...otherFiles] : [];
    if (files.length === 1) { return baseName(files[0]); }
    return files.length + ' files';
}

/*
 * The one line PLAN §9 asks for once, project-wide, rather than as an empty
 * traceability panel per unjudged docset. Returns '' when the docset's own
 * `notRun` says traceability WAS run (or was never expected to be) — this is
 * additive information, not a permanent fixture of the page.
 */
function buildNotEvaluatedLine(notRun, opts) {
    const entry = (notRun || []).find(item => item && item.axis === 'traceability');
    if (!entry) { return ''; }
    const { totalPairs, ratePerMinute, judgedExample } = opts || {};
    if (!totalPairs || !ratePerMinute) {
        // The degraded form: we know the axis did not run, but not its cost.
        // Still true, still useful, and it is what a caller gets if it does
        // not pass the two constants above — never a hard-coded sentence.
        return 'Not evaluated: traceability — ' + (entry.why || 'the LLM pass did not run.');
    }
    const hours = totalPairs / ratePerMinute / 60;
    const hoursLabel = hours >= 10 ? String(Math.round(hours)) : String(Math.round(hours * 10) / 10);
    let line = 'Not evaluated: traceability — ' + groupDigits(totalPairs) +
        ' link pairs across the project, judging them costs ~' + hoursLabel + ' h at the measured rate.';
    if (judgedExample && judgedExample.pairs) {
        line += ' ' + groupDigits(judgedExample.pairs) + ' judged in ' + judgedExample.label + '.';
    }
    return line;
}

/*
 * The foot of the panel, in Search's own idiom (`search-scan.js`'s
 * `honestyLine`): what was read, by what, and whether it was ever
 * calibrated. "Nothing shared" and "the last check could not be read" must
 * never look alike, which is why this only ever runs for the READY state —
 * the other states have their own, differently-worded, renderers below.
 */
function buildHonestyLine(docset, documents, sharedCards) {
    const parts = ['read ' + groupDigits(documents.length) + ' ' + plural(documents.length, 'document')];
    if (sharedCards.length) {
        parts.push(groupDigits(sharedCards.length) + ' shared ' + plural(sharedCards.length, 'cluster'));
    }
    const analyzers = (docset && docset.analyzers) || [];
    if (analyzers.length) {
        parts.push(analyzers
            .map(a => a.id + ' ' + a.version + (a.benchmark ? '' : ' (not benchmarked)'))
            .join(', '));
    }
    const notRunCount = ((docset && docset.notRun) || []).length;
    if (notRunCount) { parts.push(notRunCount + ' ' + plural(notRunCount, 'axis', 'axes') + ' not evaluated'); }
    return parts.join(' · ');
}

/*
 * Assemble everything above into the one small object every renderer below
 * reads. Nothing past this point touches an envelope directly — a renderer
 * that needs a new fact gets it added here, not by reaching back into the
 * raw finding shape from inside a markup function.
 */
function buildViewModel({ docsetLabel, docset, documents, trustPhrase, notEvaluated, sortMode }) {
    const docs = documents || [];
    const sharedFindings = ((docset && docset.findings) || []).filter(f => f.status !== 'dismissed');
    const sharedIndex = buildSharedIndex(sharedFindings);
    const sharedCards = sortCards(sharedFindings.map(f => buildSharedCard(f, trustPhrase)), sortMode || 'reach');
    const documentRows = docs.map(doc => buildDocumentRow(doc, sharedIndex))
        .sort((a, b) => a.path.localeCompare(b.path));
    const actionableRows = documentRows.filter(row => !row.clean);
    const cleanCount = documentRows.length - actionableRows.length;

    return {
        docsetLabel,
        producedAt: docset && docset.producedAt,
        documentCount: docs.length,
        sharedCards,
        sharedCount: sharedCards.length,
        actionableRows,
        cleanCount,
        totalDocuments: docs.length,
        notEvaluatedLine: notEvaluated || '',
        honesty: buildHonestyLine(docset, docs, sharedCards)
    };
}

// -- pure markup -----------------------------------------------------------

/*
 * "Check project" belongs HERE and nowhere else.
 *
 * Cross-document duplication is the expensive pass — it is the one that loads
 * the ~500 MB reranker, and it takes seconds to a minute over a docset. A
 * document rail cannot honestly offer it: from inside one file, "check" means
 * the 68 ms purpose pass, and giving the same word two costs three orders of
 * magnitude apart in two places is how a person learns not to trust either.
 *
 * `run` carries the runner's state. Absent, it means the frontend has not asked
 * yet; `available: false` means it asked and there is no detector reachable, and
 * the button is replaced by the REASON rather than shown disabled — a disabled
 * button that never explains itself is the failure mode PLAN §13 is about.
 */
function renderRunControl(run) {
    if (!run) { return ''; }
    if (run.running) {
        const total = Number(run.total) || 0;
        const done = Number(run.done) || 0;
        const count = total ? ' ' + done + ' of ' + total : '';
        const where = run.current ? ' · ' + esc(String(run.current)) : '';
        return '<span class="studio-qp-run" role="status">Checking…' + esc(count) + where +
            ' <button type="button" class="studio-qp-runbtn link" data-act="cancel-run">Cancel</button></span>';
    }
    if (!run.available) {
        return '<span class="studio-qp-run muted" title="' + esc(run.why || '') + '">' +
            'Analysis is not available here' + (run.why ? ' — ' + esc(run.why) : '') + '</span>';
    }
    const failed = run.error
        ? '<span class="studio-qp-run failed">The last check failed — ' + esc(run.error) + '</span>' : '';
    return failed + '<button type="button" class="studio-qp-runbtn" data-act="run-project">Check project</button>';
}

function renderHeader(vm, run) {
    /* `relativeTime` already returns a finished phrase at the recent end of its
     * scale, so appending " ago" produced "checked now ago" the instant a run
     * finished — the same slip the document rail's freshness line had. */
    const recent = vm.producedAt ? relativeTime(vm.producedAt) : '';
    const when = vm.producedAt
        ? (/^(just )?now$/i.test(recent) ? recent : recent + ' ago')
        : 'never checked';
    const whenFull = vm.producedAt ? new Date(vm.producedAt).toLocaleString() : '';
    return '<header class="studio-qp-head">' +
        '<h2>Quality — ' + esc(vm.docsetLabel) + '</h2>' +
        '<span class="studio-qp-meta" title="' + esc(whenFull) + '">checked ' + esc(when) +
        ' · ' + esc(groupDigits(vm.documentCount)) + ' ' + esc(plural(vm.documentCount, 'document')) + '</span>' +
        renderRunControl(run) +
        '</header>';
}

/*
 * The docset picker — the visible half of the open question in PLAN §17 Q1.
 * It only exists at all once more than one docset has been found under the
 * connected roots; a single docset gets a plain label instead, because a
 * one-option select is a control with nothing to control.
 */
function renderDocsetPicker(docsets, selectedId) {
    if (!docsets || docsets.length < 2) { return ''; }
    const options = docsets.map(bundle =>
        '<option value="' + esc(bundle.id) + '"' + (bundle.id === selectedId ? ' selected' : '') + '>' +
        esc(bundle.label) + '</option>').join('');
    return '<label class="studio-qp-picker-label">' +
        '<span class="studio-visually-hidden">Which docset</span>' +
        '<select class="studio-qp-picker" data-act="docset-select" aria-label="Which docset">' + options + '</select>' +
        '</label>';
}

function sortButton(mode, current, label) {
    return '<button type="button" class="studio-qp-sortbtn' + (mode === current ? ' on' : '') +
        '" data-act="sort" data-mode="' + esc(mode) + '" aria-pressed="' + (mode === current) + '">' +
        esc(label) + '</button>';
}

/* One occurrence, as a clickable chip. `¶line` mirrors PLAN §9's own mock
 * ("PRD.md ¶88"); a section-granularity anchor (a drift finding's reference
 * site, which has no line the way a duplicate span does) falls back to its
 * section name instead of inventing a paragraph number it does not have. */
function occurrenceChip(occ) {
    const where = occ.line ? '¶' + occ.line : (occ.section ? truncate(occ.section, 40) : '');
    return '<button type="button" class="studio-qp-occ" data-act="open-occurrence" ' +
        'data-file="' + esc(occ.file) + '" data-line="' + esc(occ.line || '') + '" ' +
        'title="' + esc(occ.file) + (occ.section ? ' — ' + esc(occ.section) : '') + '">' +
        esc(occ.label) + (where ? ' ' + esc(where) : '') + '</button>';
}

/*
 * A shared card: quote, provenance phrase (never a colour, never a decimal —
 * CONTRACT §1), and up to three occurrences with the rest behind a native
 * <details> — no click handler needed to expand it, which keeps this a
 * pure string with no wiring of its own.
 */
function renderSharedCard(card) {
    const shown = card.occurrences.slice(0, 3).map(occurrenceChip);
    const rest = card.occurrences.slice(3);
    if (rest.length) {
        shown.push('<details class="studio-qp-more">' +
            '<summary>+' + rest.length + ' ' + plural(rest.length, 'file') + '</summary>' +
            '<span class="studio-qp-more-list">' + rest.map(occurrenceChip).join(' · ') + '</span>' +
            '</details>');
    }
    return '<article class="studio-qp-card" data-fingerprint="' + esc(card.fingerprint || '') + '">' +
        '<p class="studio-qp-quote" title="' + esc(card.quote) + '">“' + esc(truncate(card.quote, 220)) + '”</p>' +
        '<p class="studio-qp-phrase">' + esc(card.phrase) +
        (card.trust === 'weak' ? '<span class="studio-qp-weak">weak</span>' : '') + '</p>' +
        (card.reason ? '<p class="studio-qp-reason">' + esc(card.reason) + '</p>' : '') +
        '<p class="studio-qp-occlist">' + shown.join(' · ') + '</p>' +
        '</article>';
}

function renderSharedSection(vm, sortMode) {
    const head = '<div class="studio-qp-section-head"><h3>Shared between documents</h3>' +
        (vm.sharedCount
            ? '<span class="studio-qp-count">' + esc(groupDigits(vm.sharedCount)) + ' ' +
              esc(plural(vm.sharedCount, 'repeat')) + '</span>' +
              '<div class="studio-qp-sort" role="group" aria-label="Sort shared repeats">' +
              sortButton('reach', sortMode, 'By reach') + sortButton('document', sortMode, 'Document order') +
              '</div>'
            : '') +
        '</div>';
    const body = vm.sharedCards.length
        ? vm.sharedCards.map(renderSharedCard).join('')
        : '<p class="studio-qp-hint">No text repeats across more than one document in this docset. ' +
          'A repeat confined to one file is already in that document’s own report.</p>';
    return '<section class="studio-qp-section">' + head + body + '</section>';
}

/*
 * A bulk-judgment affordance appears on a row ONLY when that document has
 * open weak-trust cross-document matches — the one class of finding low
 * enough in confidence that clearing several at once, rather than one at a
 * time, is worth offering. PLAN §6: bulk belongs at project scope because
 * the document rail's median of two findings makes the same control clutter
 * there.
 */
function renderDocumentRow(row) {
    const bulk = row.weakFingerprints.length
        ? '<button type="button" class="studio-qp-bulk" data-act="bulk-weak" data-path="' + esc(row.path) + '">' +
          'Not an issue for every weak match in this document (' + row.weakFingerprints.length + ')</button>'
        : '';
    return '<div class="studio-qp-row">' +
        '<button type="button" class="studio-qp-rowpath" data-act="open-document" data-path="' + esc(row.path) +
        '" title="' + esc(row.path) + '">' + esc(row.label) + '</button>' +
        '<span class="studio-qp-rowdesc">' + esc(row.clauses.join(' · ')) + '</span>' +
        bulk +
        '</div>';
}

/* Clean documents are a count, never a row (PLAN §9) — 14 of 86 in the
 * research corpus have nothing to say, and a table with mostly-empty rows
 * teaches a reader to stop reading it. */
function renderDocumentsSection(vm) {
    const rows = vm.actionableRows;
    const head = '<div class="studio-qp-section-head"><h3>Documents with something to act on</h3>' +
        '<span class="studio-qp-count">' + esc(groupDigits(rows.length)) + ' of ' +
        esc(groupDigits(vm.totalDocuments)) + '</span></div>';
    const body = rows.length
        ? '<div class="studio-qp-rows">' + rows.map(renderDocumentRow).join('') + '</div>'
        : '<p class="studio-qp-hint">Nothing to act on in this docset.</p>';
    const clean = vm.cleanCount
        ? '<p class="studio-qp-clean">' + esc(groupDigits(vm.cleanCount)) + ' ' +
          esc(plural(vm.cleanCount, 'document')) + ' clean.</p>'
        : '';
    return '<section class="studio-qp-section">' + head + body + clean + '</section>';
}

function renderNotEvaluated(line) {
    return line ? '<p class="studio-qp-notrun">' + esc(line) + '</p>' : '';
}

function renderHonesty(line) {
    return '<footer class="studio-qp-foot" title="What this check actually read">' + esc(line) + '</footer>';
}

/* The whole ready-state panel. `opts.docsetPicker` is pre-rendered by the
 * caller (it needs the FULL bundle list, not just this one docset's view
 * model) and simply spliced in beside the header. */
function renderPanel(vm, opts) {
    const o = opts || {};
    return renderHeader(vm, o.run) +
        (o.docsetPicker || '') +
        '<div class="studio-qp-body">' +
        renderSharedSection(vm, o.sortMode || 'reach') +
        renderDocumentsSection(vm) +
        renderNotEvaluated(vm.notEvaluatedLine) +
        '</div>' +
        renderHonesty(vm.honesty);
}

/*
 * "Analysis is not available here" — the one state every failure funnels
 * into, per the header comment. `reason` only changes the sentence, never
 * the shape: a reader should never have to learn a new layout to learn a
 * new way this tab can be unable to help.
 */
function renderUnavailable(reason) {
    const detail = reason === 'read-failed'
        ? 'The last check could not be read. See the console for what stopped it.'
        : 'quality-scan.js and quality-store.js are not installed in this build yet, so there is nothing to ' +
          'normalise the reports with or to read judgments from.';
    return '<div class="studio-qp-unavailable">' +
        '<h3>Analysis is not available here</h3>' +
        '<p>' + esc(detail) + '</p>' +
        '<p class="studio-qp-unavailable-note">This is the same rule the rest of the product follows for a ' +
        'missing capability: it is stated, not hidden behind a panel that quietly looks broken instead.</p>' +
        '</div>';
}

function renderEmptyState() {
    return '<div class="studio-qp-empty">' +
        '<h3>No quality run found</h3>' +
        '<p>Nothing has been checked for this project yet. A check writes into ' +
        '<code>.studio/quality/runs/</code>, and this tab reads whatever it finds there — start one from a ' +
        'document’s Quality rail, or drop a report into <code>.studio/quality/reports/</code>.</p>' +
        '</div>';
}

// -- the widget --------------------------------------------------------------

class QualityProjectWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.messageService = ctx.messageService;
        // Not used today. Kept because this ctx shape is SearchWidget's,
        // mechanically, and the first thing this tab will want is a command
        // for "open the document-type control" once E3 lands.
        this.commandRegistry = ctx.commandRegistry;
        /*
         * The detector runner, or undefined in a deployment that has none. This
         * tab is the only surface that starts a cross-document run, because it
         * is the only one whose scope matches what such a run costs — see
         * renderRunControl.
         */
        this.runnerClient = ctx.runnerClient;

        this.id = QUALITY_PROJECT_WIDGET_ID;
        this.title.label = 'Quality';
        this.title.caption = 'Cross-document duplication and traceability across this project';
        this.title.closable = true;
        // A magnifier is already claimed by Search; a beaker reads as
        // "inspection, not navigation", which is the distinction this tab
        // and that one need to keep at a glance in a crowded dock.
        this.title.iconClass = 'codicon codicon-beaker';
        this.addClass('studio-quality-project');

        // -- state -------------------------------------------------------
        this.state = 'loading';               // 'loading' | 'unavailable' | 'empty' | 'ready'
        this.unavailableReason = '';
        this.scanModule = undefined;
        this.storeModule = undefined;
        this.bundles = [];                    // [{ id, label, rootUri, docset, documents }]
        this.selectedId = undefined;
        this.sortMode = 'reach';
        this.currentViewModel = undefined;    // cached each render(); bulk actions read row data from it
        this.disposables = [];
        /*
         * What the runner said last. `undefined` until probed, which renders no
         * control at all — better than a "Check project" button that turns out
         * to be unbacked the moment somebody presses it.
         */
        this.run = undefined;
        this.runId = undefined;
        this.runWatch = undefined;

        /*
         * One root node, fully reassigned on every render(). Unlike Search —
         * whose query input must never be recreated because every keystroke
         * repaints — nothing on THIS page is typed into. A render here only
         * follows an initial load, a docset switch, a sort click, or a
         * judgment write, all of which are already full-panel changes in
         * substance, so there is no in-place-sync problem worth the extra
         * code Search's facet rail needed.
         */
        this.node.innerHTML = '<div class="studio-qp-root" data-qp-root></div>';
        this.rootEl = this.node.querySelector('[data-qp-root]');

        this.node.addEventListener('click', event => this.onClick(event));
        this.node.addEventListener('change', event => this.onChange(event));
    }

    onAfterAttach(message) {
        super.onAfterAttach(message);
        this.load();
        void this.probeRunner();
    }

    onBeforeDetach(message) {
        /* A poll that outlives its widget keeps a dead panel's timer alive and
         * writes into a detached DOM. Stopped here rather than in the watcher,
         * because only the widget knows it is going away. */
        if (this.runWatch) { this.runWatch.cancel(); this.runWatch = undefined; }
        if (super.onBeforeDetach) { super.onBeforeDetach(message); }
    }

    /* Ask once, on attach. The answer is a property of the machine and the
     * project, not of anything the person is about to do, so re-asking on every
     * render would be a spawn per repaint for an answer that does not change. */
    async probeRunner() {
        if (!this.runnerClient) { this.run = { available: false, why: 'this build has no detector runner' }; this.render(); return; }
        try {
            const root = await this.firstRoot();
            const probe = await this.runnerClient.probe(root);
            this.run = { available: !!(probe && probe.available), why: probe && probe.why };
        } catch (e) {
            this.run = { available: false, why: 'the runner could not be reached' };
        }
        this.render();
    }

    async firstRoot() {
        const roots = await this.workspaceService.roots;
        const bundle = this.bundles.find(b => b.id === this.selectedId);
        return (bundle && bundle.rootUri) || (roots[0] && roots[0].resource);
    }

    /*
     * Start a run over the SELECTED docset, not the whole project.
     *
     * The picker above already says which docset this page is about, and running
     * the other five while a person is looking at one of them is a minute of
     * reranker time they did not ask for. CONTRACT-runner.md §0 Q1 is the same
     * decision one layer down.
     */
    async runProject() {
        if (!this.runnerClient || !this.run || !this.run.available || this.run.running) { return; }
        const bundle = this.bundles.find(b => b.id === this.selectedId);
        /*
         * A DOCSET NAME, not its file paths. At `scope: 'docset'` the runner
         * reads `paths` as the docsets to run — passing files instead made it
         * match no docset, fall back to every one of them, and check all 86
         * documents when the page was showing seven. `bundle.docset` is the
         * normalised envelope rather than the raw report, so it has no `paths`
         * of its own; `label` is the name both sides already agree on.
         */
        const name = bundle && bundle.label;
        const paths = name ? [name] : undefined;
        const total = bundle && Array.isArray(bundle.documents) ? bundle.documents.length : 0;
        this.run = { ...this.run, running: true, done: 0, total, error: undefined };
        this.render();
        try {
            const root = await this.firstRoot();
            const started = await this.runnerClient.run(root, { scope: 'docset', paths });
            this.runId = started && started.runId;
            this.runWatch = this.runnerClient.watch(this.runId, progress => {
                this.run = { ...this.run, running: true, done: progress.done, total: progress.total, current: progress.current };
                this.render();
            });
            const final = await this.runWatch;
            this.runWatch = undefined;
            this.run = {
                ...this.run, running: false,
                error: final && final.state === 'failed' ? (final.error || 'the detectors reported an error') : undefined
            };
            /* Results are FILES (PLAN §11), so the panel re-reads them rather
             * than being handed a payload over RPC. */
            await this.load();
        } catch (e) {
            this.runWatch = undefined;
            this.run = { ...this.run, running: false, error: String((e && e.message) || e) };
            this.render();
        }
    }

    async cancelRun() {
        if (!this.runnerClient || !this.runId) { return; }
        try { await this.runnerClient.cancel(this.runId); } catch (e) { /* already gone */ }
        if (this.runWatch) { this.runWatch.cancel(); this.runWatch = undefined; }
        this.run = { ...this.run, running: false };
        this.render();
    }

    /*
     * Constraint 27, exactly as search-view.js and project-page.js already
     * document it: this widget extends the raw Lumino Widget, and Lumino's
     * onCloseRequest detaches without disposing, which would leave a closed
     * tab in the shell's FocusTracker forever and break reopening it.
     */
    onCloseRequest(message) {
        for (const disposable of this.disposables) {
            try { disposable.dispose(); } catch (e) { /* already gone */ }
        }
        this.disposables = [];
        super.onCloseRequest(message);
        this.dispose();
    }

    /*
     * THE DATA SEAM, and the one place a module name appears.
     *
     * `quality-store.js` reads the report directory and `quality-scan.js`
     * normalises it; nothing below this method knows either module exists. The
     * two are required lazily and their absence is a rendered state rather than
     * an exception — this widget is a closable tab somebody asked for, and a tab
     * that throws on open is worse than one that says why it is empty.
     *
     * WHAT A "DOCSET" IS HERE is the open half of PLAN §17 Q1. The detectors'
     * unit is a service folder (`mcp-engine/` with its PRD, DESIGN and ADRs) and
     * Studio's is a connected project root, and they are not the same thing — a
     * root holding six services would make one cross-document run over all of
     * them both slow and wrong. So one `bloat-docset/<name>.json` is treated as
     * one docset, the per-document reports are attached to it by the paths the
     * docset report itself lists, and when there is more than one the picker
     * appears. That is the honest shape of the ambiguity rather than a
     * resolution of it.
     */
    async load() {
        this.state = 'loading';
        this.render();

        let scan;
        let storeModule;
        try {
            scan = require('./quality-scan');
            storeModule = require('./quality-store');
        } catch (e) {
            this.state = 'unavailable';
            this.unavailableReason = 'missing-modules';
            this.render();
            return;
        }
        if (typeof scan.normalizeDocset !== 'function' || typeof storeModule.QualityStore !== 'function') {
            this.state = 'unavailable';
            this.unavailableReason = 'missing-modules';
            this.render();
            return;
        }

        let roots = [];
        try {
            roots = await this.workspaceService.roots;
        } catch (e) {
            console.warn('[studio] quality project view could not read the workspace roots', e);
        }

        try {
            const store = new storeModule.QualityStore(this.fileService, this.workspaceService);
            const bundles = [];
            let read = 0;
            let skipped = 0;

            for (const root of roots) {
                const rootUri = root.resource;
                const reports = await store.loadReports(rootUri);
                if (!reports.present) { continue; }
                read += reports.read || 0;
                skipped += reports.skipped || 0;

                /*
                 * Per-document envelopes, normalised once and reused: the rows
                 * need each document's own findings and its purpose gate, and
                 * the docset report carries neither — it only knows about
                 * repetition that crosses files.
                 */
                const perDocument = new Map();
                for (const purpose of reports.purpose) {
                    const path = purpose.path;
                    if (!path) { continue; }
                    const bloat = reports.bloat.find(candidate =>
                        (candidate.paths && candidate.paths[0]) === path);
                    perDocument.set(path, scan.normalizeDocument({
                        bloat, purpose, docPath: path, root: rootUri.toString(),
                        runId: reports.runId, producedAt: reports.producedAt
                    }));
                }

                for (const docsetReport of reports.docsets) {
                    const paths = Array.isArray(docsetReport.paths) ? docsetReport.paths : [];
                    /*
                     * The docset's name is the deepest directory ALL of its
                     * documents share — `mcp-engine` for a set whose members are
                     * `mcp-engine/PRD.md` and `mcp-engine/ADR/0001-….md`. Taking
                     * the basename of the first path instead named the whole
                     * docset after whichever ADR happened to sort first, which
                     * put a filename in the tab's title and in the picker.
                     */
                    const name = commonDirectoryName(paths) || root.resource.path.base;
                    /* The trace report for this docset, matched on the docset
                     * name its `source` path ends with — the only join the two
                     * files share, since neither carries an id. */
                    const trace = reports.traces.find(candidate =>
                        String(candidate.source || '').split('/').filter(Boolean).pop() === name);
                    const documents = paths.map(path => perDocument.get(path)).filter(Boolean);
                    const envelope = scan.normalizeDocset({
                        docset: docsetReport, trace,
                        docsetName: name, root: rootUri.toString(),
                        runId: reports.runId, producedAt: reports.producedAt,
                        documents: paths
                    });
                    bundles.push({
                        id: rootUri.toString() + '::' + name,
                        label: name,
                        rootUri: rootUri.toString(),
                        docset: envelope,
                        documents
                    });
                }
            }

            this.scanModule = scan;
            this.storeModule = storeModule;
            this.bundles = bundles;
            this.readStats = { read, skipped };

            if (!bundles.length) {
                this.state = 'empty';
            } else {
                if (!this.selectedId || !bundles.some(b => b.id === this.selectedId)) {
                    this.selectedId = this.pickDefaultDocset(bundles);
                }
                this.state = 'ready';
            }
        } catch (e) {
            /*
             * A malformed report is another tool's output, so this is an
             * expected condition rather than a defect. One rendered state that
             * says what happened, because a tab somebody asked for must never
             * come back blank and silent.
             */
            console.warn('[studio] quality project view could not read the runs', e);
            this.state = 'unavailable';
            this.unavailableReason = 'read-failed';
            this.unavailableDetail = String((e && e.message) || e);
        }
        this.render();
    }

    /*
     * PLAN §9 asks the picker to default to "the docset the current document
     * belongs to". This widget's ctx is deliberately identical to
     * SearchWidget's (see the header and this file's own construction), and
     * that shape carries no editor or shell reference — there is no signal
     * here for "what is open right now" to default against, and inventing
     * one (reaching for a global, guessing at a DOM query into a sibling
     * widget) would be exactly the kind of undocumented coupling this
     * product's own `active-project.js` was written to stop happening again.
     *
     * So the default is the most recently produced run — freshest data
     * first, and correct until the shell-wiring step that registers this tab
     * can hand it an actual "current document" reference to prefer instead.
     * That gap is the honest state of PLAN §17 Q1 today, not a bug in this
     * file.
     */
    pickDefaultDocset(bundles) {
        return bundles.slice().sort((a, b) =>
            new Date((b.docset && b.docset.producedAt) || 0) - new Date((a.docset && a.docset.producedAt) || 0)
        )[0].id;
    }

    get selectedBundle() {
        return this.bundles.find(b => b.id === this.selectedId);
    }

    render() {
        if (this.isDisposed) { return; }

        if (this.state === 'loading') {
            this.rootEl.innerHTML = loadingMarkup('Reading the last check…');
            return;
        }
        if (this.state === 'unavailable') {
            this.rootEl.innerHTML = renderUnavailable(this.unavailableReason);
            return;
        }
        const bundle = this.selectedBundle;
        if (this.state === 'empty' || !bundle) {
            this.rootEl.innerHTML = renderEmptyState();
            return;
        }

        const notEvaluated = buildNotEvaluatedLine((bundle.docset && bundle.docset.notRun) || [], {
            totalPairs: TRACE_TOTAL_PAIRS,
            ratePerMinute: TRACE_RATE_PER_MIN,
            judgedExample: TRACE_JUDGED_EXAMPLE
        });
        const vm = buildViewModel({
            docsetLabel: bundle.label,
            docset: bundle.docset,
            documents: bundle.documents,
            /*
             * provenancePhrase, not trustPhrase. A card says how the match was
             * made — "identical wording" / "near-identical wording" / "reworded,
             * matched by a model" — and the trust BAND contributes only the word
             * "weak" at the bottom. Keying the phrase off the band credited a
             * model on lexical clusters it was never involved in; see
             * quality-scan.js's own note on the two axes.
             */
            trustPhrase: finding => this.scanModule.provenancePhrase(finding),
            notEvaluated,
            sortMode: this.sortMode
        });
        this.currentViewModel = vm;
        const picker = renderDocsetPicker(this.bundles, this.selectedId);
        this.rootEl.innerHTML = renderPanel(vm, {
            sortMode: this.sortMode, docsetPicker: picker, run: this.run
        });
    }

    // -- events ---------------------------------------------------------

    onChange(event) {
        const target = event.target;
        if (target.matches('[data-act="docset-select"]')) {
            this.selectedId = target.value;
            this.render();
        }
    }

    onClick(event) {
        if (event.target.closest('[data-act="run-project"]')) { void this.runProject(); return; }
        if (event.target.closest('[data-act="cancel-run"]')) { void this.cancelRun(); return; }
        const sortBtn = event.target.closest('[data-act="sort"]');
        if (sortBtn) {
            this.sortMode = sortBtn.getAttribute('data-mode') === 'document' ? 'document' : 'reach';
            this.render();
            return;
        }
        const occ = event.target.closest('[data-act="open-occurrence"]');
        if (occ) {
            this.openPath(occ.getAttribute('data-file'), occ.getAttribute('data-line'));
            return;
        }
        const rowPath = event.target.closest('[data-act="open-document"]');
        if (rowPath) {
            this.openPath(rowPath.getAttribute('data-path'));
            return;
        }
        const bulk = event.target.closest('[data-act="bulk-weak"]');
        if (bulk) {
            this.bulkDismissWeak(bulk.getAttribute('data-path'));
        }
    }

    /*
     * Open a document, and best-effort a line inside it.
     *
     * THE SAME HONEST GAP search-view.js's own `openSelection` names: this
     * product's document surfaces are RENDERED (a ProseMirror document, or a
     * rendered HTML page), not raw text editors, so there is no guaranteed
     * mapping from a source line to a position on screen — that mapping is
     * quote-plus-occurrence anchoring (`quality-anchor.js`, PLAN §7), which
     * belongs to the per-document rail, not to this tab. Passing `selection`
     * costs nothing when the opener ignores it and helps on the openers that
     * do not.
     */
    async openPath(path, line) {
        const bundle = this.selectedBundle;
        if (!bundle || !path) { return; }
        try {
            const { URI } = require('@theia/core/lib/common/uri');
            const uri = new URI(bundle.rootUri + '/' + path);
            const options = { mode: 'activate' };
            if (line) { options.selection = { start: { line: Math.max(0, Number(line) - 1), character: 0 } }; }
            await open(this.openerService, uri, options);
        } catch (e) {
            console.error('[studio] quality project view could not open', path, e);
            if (this.messageService) {
                this.messageService.error('Could not open ' + path + '. It may have moved or been deleted since this check ran.');
            }
        }
    }

    /*
     * Bulk judgment — offered here and only here (PLAN §6): the document
     * rail's median of two findings makes the same control clutter, and the
     * 91 clusters in this product's own docset fixture is the volume that
     * justifies it existing at all.
     *
     * IT WRITES THE SAME PER-FINGERPRINT RECORDS a single dismissal would,
     * one `quality-store.saveJudgment` call per fingerprint rather than a
     * parallel bulk-write path — so nothing about reconciliation (CONTRACT
     * §4) has a bulk-shaped special case to get wrong. The reason vocabulary
     * offered is a SUBSET of CONTRACT §4's four: "wrong document type" is
     * left out because it routes to the doc-type control instead of
     * dismissing anything, and that control is a property of one document,
     * not of however many share a weak match with it.
     */
    async bulkDismissWeak(path) {
        const bundle = this.selectedBundle;
        const store = this.storeModule;
        const vm = this.currentViewModel;
        if (!bundle || !store || typeof store.saveJudgment !== 'function' || !vm) { return; }
        const row = vm.actionableRows.find(r => r.path === path);
        const fingerprints = row ? row.weakFingerprints.slice() : [];
        if (!fingerprints.length) { return; }

        const REASONS = [
            { label: 'Not a duplicate', value: 'not-a-duplicate' },
            { label: 'Deliberate', value: 'deliberate' },
            { label: 'Won’t fix', value: 'wont-fix' }
        ];
        let choice;
        try {
            choice = await this.messageService.info(
                'Mark ' + fingerprints.length + ' weak ' + plural(fingerprints.length, 'match', 'matches') +
                ' in ' + baseName(path) + ' as not an issue — why?',
                ...REASONS.map(r => r.label));
        } catch (e) {
            return;
        }
        const picked = REASONS.find(r => r.label === choice);
        if (!picked) { return; }

        /*
         * THE UNDO WINDOW. The write is delayed rather than written-then-
         * reverted, so a genuine Undo click never touches judgments.json at
         * all — only a confirmed decision does.
         */
        let undone = false;
        this.messageService.info(
            fingerprints.length + ' marked ' + picked.label.toLowerCase() + ' — undo?', 'Undo'
        ).then(action => { if (action === 'Undo') { undone = true; } }).catch(() => { /* dismissed, not undone */ });

        await new Promise(resolve => setTimeout(resolve, BULK_UNDO_MS));
        if (undone || this.isDisposed) { return; }

        try {
            for (const fingerprint of fingerprints) {
                await store.saveJudgment({
                    fileService: this.fileService,
                    root: bundle.rootUri,
                    fingerprint,
                    status: 'dismissed',
                    reason: picked.value,
                    note: ''
                });
            }
            await this.load();
        } catch (e) {
            console.error('[studio] quality project view could not save a bulk judgment', e);
            if (this.messageService) {
                this.messageService.error('Could not save those decisions. See the console for what stopped it.');
            }
        }
    }
}

/*
 * Tokens only — CONTRACT §1's rule, restated because it is the one this file
 * is most likely to be tempted to break: a shared-cluster card is exactly the
 * kind of element a design pass reaches for a hex value on. Every colour
 * below is a `--studio-*` variable so the light and dark themes both follow
 * it without this file knowing either exists.
 */
const QUALITY_PROJECT_CSS = `
.studio-quality-project {
  height: 100%; overflow: hidden; background: var(--studio-bg); color: var(--studio-text);
}
.studio-qp-root { height: 100%; overflow-y: auto; display: flex; flex-direction: column; }
.studio-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

/* --- header --------------------------------------------------------- */
.studio-qp-head {
  flex: none; display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  padding: 16px 20px 12px; border-bottom: 1px solid var(--studio-line);
}
.studio-qp-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.studio-qp-meta { font-size: 11.5px; color: var(--studio-muted); white-space: nowrap; cursor: default; }
/* The head is a baseline row of three: title, when it was checked, and the run
   control. The control shrinks rather than taking a fixed width, so the
   "not available here" sentence can be long without
   squeezing the meta line into a column of single words — the failure the
   document-type row in the Measured tab already made once. */
.studio-qp-run { flex: 0 1 auto; min-width: 0; font-size: 11.5px; color: var(--studio-muted); overflow-wrap: anywhere; }
.studio-qp-run.failed { color: var(--studio-danger); }
.studio-qp-runbtn {
  flex: none; font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
  border-radius: var(--studio-radius); border: 1px solid var(--studio-line);
  background: var(--studio-surface-raised); color: var(--studio-text);
}
.studio-qp-runbtn:hover { border-color: var(--studio-accent); }
.studio-qp-runbtn.link {
  border: none; background: none; padding: 0; color: var(--studio-accent);
  text-decoration: underline; text-underline-offset: 2px;
}
.studio-qp-runbtn:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }
.studio-qp-picker-label { flex: none; padding: 8px 20px 0; display: block; }
.studio-qp-picker {
  font-size: 12px; padding: 4px 8px; border-radius: var(--studio-radius);
  border: 1px solid var(--studio-line); background: var(--studio-surface); color: var(--studio-text);
}

/* --- body / sections -------------------------------------------------- */
.studio-qp-body { flex: 1; padding: 4px 20px 20px; }
.studio-qp-section { margin-top: 20px; }
.studio-qp-section:first-child { margin-top: 16px; }
.studio-qp-section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.studio-qp-section-head h3 { margin: 0; font-size: 12.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .03em; color: var(--studio-muted); }
.studio-qp-count {
  font-size: 11px; color: var(--studio-muted); background: var(--studio-surface-sunken);
  border-radius: 999px; padding: 1px 8px;
}
.studio-qp-sort { margin-left: auto; display: flex; gap: 4px; }
.studio-qp-sortbtn {
  font-size: 11px; padding: 3px 8px; border-radius: var(--studio-radius);
  border: 1px solid var(--studio-line); background: var(--studio-surface); color: var(--studio-muted); cursor: pointer;
}
.studio-qp-sortbtn.on { color: var(--studio-text); border-color: var(--studio-accent); background: var(--studio-selection-bg); }
.studio-qp-hint { font-size: 12.5px; color: var(--studio-muted); margin: 0; }

/* --- shared cards ------------------------------------------------------ */
.studio-qp-card {
  border: 1px solid var(--studio-line); border-radius: var(--studio-radius);
  background: var(--studio-surface); padding: 10px 12px; margin-bottom: 8px;
}
.studio-qp-quote {
  margin: 0 0 4px; font-size: 13px; line-height: 1.45; font-style: italic;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
}
.studio-qp-phrase { margin: 0 0 4px; font-size: 11.5px; color: var(--studio-muted); }
.studio-qp-weak {
  margin-left: 6px; font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
  color: var(--studio-danger);
}
.studio-qp-reason { margin: 0 0 6px; font-size: 12px; color: var(--studio-text); }
.studio-qp-occlist { margin: 0; font-size: 11.5px; display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; }
.studio-qp-occ {
  border: 1px solid var(--studio-line); background: var(--studio-surface-raised); color: var(--studio-text);
  border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer;
}
.studio-qp-occ:hover { border-color: var(--studio-accent); color: var(--studio-accent); }
.studio-qp-more { display: inline; }
.studio-qp-more summary {
  display: inline; cursor: pointer; color: var(--studio-muted); font-size: 11px; list-style: none;
}
.studio-qp-more summary::-webkit-details-marker { display: none; }
.studio-qp-more summary:hover { color: var(--studio-accent); }
.studio-qp-more-list { display: inline-flex; flex-wrap: wrap; gap: 4px 6px; margin-left: 6px; }

/* --- document rows ------------------------------------------------------ */
.studio-qp-rows { display: flex; flex-direction: column; gap: 1px; border-top: 1px solid var(--studio-line); }
.studio-qp-row {
  display: flex; align-items: baseline; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--studio-line);
  flex-wrap: wrap;
}
.studio-qp-rowpath {
  flex: none; border: none; background: none; padding: 0; font: inherit; font-weight: 600; font-size: 13px;
  color: var(--studio-text); cursor: pointer; text-decoration: none;
}
.studio-qp-rowpath:hover { color: var(--studio-accent); text-decoration: underline; }
.studio-qp-rowdesc { font-size: 12.5px; color: var(--studio-muted); }
.studio-qp-bulk {
  margin-left: auto; font-size: 11px; border: 1px solid var(--studio-line); background: var(--studio-surface);
  color: var(--studio-muted); border-radius: var(--studio-radius); padding: 3px 8px; cursor: pointer;
}
.studio-qp-bulk:hover { color: var(--studio-danger); border-color: var(--studio-danger); }
.studio-qp-clean { margin: 10px 0 0; font-size: 12px; color: var(--studio-muted); }

/* --- not-evaluated + honesty --------------------------------------------- */
.studio-qp-notrun {
  margin: 20px 0 0; font-size: 12px; color: var(--studio-muted); padding-top: 12px;
  border-top: 1px solid var(--studio-line);
}
.studio-qp-foot {
  flex: none; padding: 8px 20px; border-top: 1px solid var(--studio-line); background: var(--studio-surface-sunken);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10.5px; color: var(--studio-muted);
}

/* --- unavailable / empty ------------------------------------------------- */
.studio-qp-unavailable, .studio-qp-empty {
  margin: auto; max-width: 420px; padding: 32px 24px; text-align: center; color: var(--studio-muted);
}
.studio-qp-unavailable h3, .studio-qp-empty h3 { color: var(--studio-text); font-size: 14px; margin: 0 0 8px; }
.studio-qp-unavailable p, .studio-qp-empty p { font-size: 12.5px; line-height: 1.5; margin: 0 0 8px; }
.studio-qp-unavailable-note { font-size: 11.5px; opacity: .85; }
`;

module.exports = {
    QualityProjectWidget,
    QUALITY_PROJECT_CSS,
    QUALITY_PROJECT_WIDGET_ID,

    // Pure functions, exported alongside the widget for the same reason
    // search-scan.js is a separate module from search-view.js: a function
    // that only takes data can be driven by a node test suite and by a
    // standalone preview page, with no browser and no Theia involved.
    buildSharedIndex,
    buildSharedCard,
    sortCards,
    buildDocumentRow,
    buildRepeatsClause,
    buildNotEvaluatedLine,
    buildHonestyLine,
    buildViewModel,
    renderHeader,
    renderDocsetPicker,
    occurrenceChip,
    renderSharedCard,
    renderSharedSection,
    renderDocumentRow,
    renderDocumentsSection,
    renderNotEvaluated,
    renderHonesty,
    renderPanel,
    renderUnavailable,
    renderEmptyState,
    docsetLabelFromRoot,
    baseName,
    plural,
    groupDigits,
    truncate
};
