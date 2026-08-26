/*
 * The Findings tab of the Quality rail — string rendering only.
 *
 * This module owns none of the DOM the way comment-ui.js and search-view.js do
 * not: it takes a state object built elsewhere (the document widget, later —
 * see CONTRACT-quality.md §0 for why that wiring is a separate, serial step)
 * and returns HTML/text for the three slots the rail contract already defines
 * (railHeadEl.innerHTML, listEl.innerHTML, footEl.textContent — the exact shape
 * renderComments()/renderChanges() in markdown-editor.js use). Nothing here
 * attaches a listener, computes a fingerprint, bands a trust level or decides
 * what counts as a duplicate: quality-scan.js and quality-identity.js do that,
 * and this file is not allowed to duplicate it, on pain of the two drifting
 * apart the way CONTRACT-quality.md §3 warns a second fingerprint
 * implementation would.
 *
 * TWO REJECTED ALTERNATIVES, RECORDED SO THEY ARE NOT TRIED AGAIN:
 *
 *   - A floating "why?" popover, positioned with getBoundingClientRect() off
 *     the button that opened it. Every floating surface in this codebase
 *     (.studio-bubble, .studio-slash, .studio-table-bar) is positioned by the
 *     widget that owns the node, in JS this module is not allowed to own. The
 *     explain panel and the "Not an issue" picker are instead rendered INLINE,
 *     expanding the card that opened them — no coordinates, no owned node,
 *     and a click "elsewhere" is just a second click on the same toggle,
 *     which is a wiring detail for whoever owns the click switch.
 *
 *   - Deriving "shown / weak / dismissed / later" here from each finding's own
 *     `.status` and `.trust`. That would be correct today and silently wrong
 *     the day quality-scan.js's partition() grows a rule this module cannot
 *     see (the trust filter interacting with a status, say). So the FOUR
 *     BUCKETS come from `state.partitioned` verbatim; only the on-screen
 *     ORDER is re-derived, by filtering `state.findings` (already reconciled
 *     and ordered — see the state-object comment where it is handed to us)
 *     down to whichever fingerprints partition() put in `shown` or `later`.
 *     That way a reshuffled bucket never silently reshuffles the document.
 *
 * WHAT THIS FILE DOES NOT KNOW. quality-scan.js is being written in parallel
 * and may not exist yet (see CONTRACT-quality.md, "may be absent"), so the one
 * thing this module borrows from it — trustPhrase() — is required behind a
 * try/catch with a literal fallback table copied from CONTRACT §2's phrase
 * list. If quality-scan.js lands with a different function name, this file
 * still renders correctly from the fallback; it just stops taking the
 * canonical implementation's word for it.
 */

const { esc, relativeTime } = require('./comment-ui');
const { ICONS } = require('./icons');

let scanModule = null;
try {
    // Guarded, not required at the top of the dependency graph: see the header
    // comment. A syntax error in a sibling file mid-write must not take this
    // module down with it, so any throw here — not just "module not found" —
    // is treated the same way.
    scanModule = require('./quality-scan');
} catch (err) {
    scanModule = null;
}

/*
 * The four phrases from CONTRACT-quality.md §2 ("The phrases on a card, and
 * where they come from"). Kept here as the fallback only — quality-scan.js's
 * trustPhrase(), when present, is the one implementation everything else is
 * supposed to defer to.
 */
const FALLBACK_TRUST_PHRASES = {
    exact: 'identical wording',
    strong: 'near-identical wording',
    likely: 'reworded — matched by a model',
    weak: 'reworded'
};

function trustPhrase(trust) {
    if (scanModule && typeof scanModule.trustPhrase === 'function') {
        return scanModule.trustPhrase(trust);
    }
    return FALLBACK_TRUST_PHRASES[trust] || FALLBACK_TRUST_PHRASES.weak;
}

/*
 * WHAT A CARD SAYS ABOUT HOW THE MATCH WAS MADE — and why it is not
 * trustPhrase(trust).
 *
 * The band and the provenance are two axes, and collapsing them into one
 * string made the card lie. The detector's "lexical" pass matches on shared
 * n-grams rather than on byte equality, so a lexical cluster can carry
 * confidence 0.637 over three differently worded sentences; that bands to
 * `likely`, and `likely`'s phrase in CONTRACT §2's table says "matched by a
 * model" — crediting a model that was never involved. PLAN §3 is the authority
 * here and it is explicit: provenance is one of three phrases and must be
 * readable without opening the card, while confidence "becomes one word at the
 * bottom band only (weak)".
 *
 * quality-scan.js owns the mapping; the fallback covers the module being
 * absent, which is only ever the case in a preview harness.
 */
function provenancePhrase(finding) {
    if (scanModule && typeof scanModule.provenancePhrase === 'function') {
        return scanModule.provenancePhrase(finding);
    }
    if (finding.provenance === 'llm') { return 'judged by a model'; }
    if (finding.provenance === 'semantic') { return 'reworded — matched by a model'; }
    return finding.trust === 'exact' ? 'identical wording' : 'near-identical wording';
}

/*
 * The data-act vocabulary, exported as one object so the click switch that
 * will eventually own this rail (a later, serial step — see CONTRACT-quality
 * §0 and the top-level task's "OUT OF SCOPE") cannot invent a spelling this
 * file did not also use. Every value here is one of the exact strings the
 * task's vocabulary lists; nothing is added or renamed.
 */
const QUALITY_ACTS = Object.freeze({
    TAB: 'quality-tab',
    FOCUS: 'quality-focus',
    JUMP: 'quality-jump',
    EXPLAIN: 'quality-explain',
    EXPLAIN_CLOSE: 'quality-explain-close',
    DISMISS: 'quality-dismiss',
    REASON: 'quality-reason',
    DISMISS_CONFIRM: 'quality-dismiss-confirm',
    PICKER_CANCEL: 'quality-picker-cancel',
    LATER: 'quality-later',
    UNDO: 'quality-undo',
    RESTORE: 'quality-restore',
    TOGGLE_WEAK: 'quality-toggle-weak',
    TOGGLE_DISMISSED: 'quality-toggle-dismissed',
    TRUST: 'quality-trust',
    SORT: 'quality-sort',
    FIX: 'quality-fix',
    RECHECK: 'quality-recheck',
    CANCEL_RUN: 'quality-cancel-run',
    DISMISS_RESOLVED: 'quality-dismiss-resolved',
    OPEN_PROJECT: 'quality-open-project',
    DOCTYPE: 'quality-doctype'
});

// -- small formatting helpers, none of them detector logic -------------------

function pct1(x) { return (Number(x) * 100).toFixed(1); }
function pctWhole(x) { return Math.round(Number(x) * 100); }
function plural(n, one, many) { return n === 1 ? one : (many === undefined ? one + 's' : many); }
function truncate(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
function fileBase(path) { return String(path || '').split('/').pop(); }

/*
 * Is this anchor pointing at the document on screen?
 *
 * A segment-aligned suffix comparison in both directions, because the two paths
 * come from two different roots: the detector records its own
 * ("tests/traceability/assess/mcp-engine/DESIGN.md") and the editor knows the
 * project's ("mcp-engine/DESIGN.md"). Aligned on segments rather than a bare
 * endsWith, because that would make "api.md" match "internal-api.md" and put
 * one document's occurrence list on another's card with nothing on screen
 * saying so.
 */
function sameFile(reportPath, docRelPath) {
    if (!docRelPath) { return true; }
    if (!reportPath) { return false; }
    if (reportPath === docRelPath) { return true; }
    const a = String(reportPath).split('/').filter(Boolean);
    const b = String(docRelPath).split('/').filter(Boolean);
    const n = Math.min(a.length, b.length);
    for (let i = 1; i <= n; i++) { if (a[a.length - i] !== b[b.length - i]) { return false; } }
    return n > 0;
}

/* Anchors carry a full breadcrumb ("A > B > C"); every mock in PLAN-quality.md
   shows only the leaf, because the breadcrumb is the kind of thing that wraps
   a 360px card onto four lines for no information a reader asked for. */
function sectionLeaf(section) {
    const parts = String(section || '').split('>').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

function countOf(partitioned, key) {
    if (partitioned && partitioned.counts && typeof partitioned.counts[key] === 'number') {
        return partitioned.counts[key];
    }
    return ((partitioned && partitioned[key]) || []).length;
}

function shortStamp(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) { return ''; }
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/*
 * The purpose detector's own reason string already says the role in capitals
 * ("PRD section reads as DESIGN (belongs in a design doc, not a prd)") — see
 * tests/fixtures/quality/purpose/mcp-engine__PRD.md.json. The envelope in
 * CONTRACT-quality.md §2 does not promise a structured `role` field on the
 * finding, so rather than invent one, the header reads it back out of the
 * sentence the detector already wrote in the one form it is reliably in.
 * `finding.role` is checked FIRST in case a future normalizer does add the
 * field outright — this regex is a bridge, not the intended long-term source.
 */
function roleFromReason(reason) {
    const m = /reads as ([a-z]+)/i.exec(String(reason || ''));
    return m ? m[1].toLowerCase() : '';
}

const DOC_TYPE_LABELS = { prd: 'PRD', design: 'design doc', decomposition: 'decomposition', adr: 'ADR' };
function docTypeLabel(docType) {
    if (!docType) { return 'document'; }
    return DOC_TYPE_LABELS[String(docType).toLowerCase()] || String(docType).toUpperCase();
}

/*
 * The one line every finding's card and every explain popover open with. Rule
 * plus, for duplicate and drift, the trust phrase; for purpose, the role —
 * "identical wording" has no meaning for a section that is not being compared
 * to anything, so the phrase table does not apply there (CONTRACT §2's table
 * is written entirely in terms of "wording", which is a duplicate/drift idea).
 */
function findingHeadline(finding) {
    if (finding.rule === 'purpose') {
        const role = finding.role || roleFromReason(finding.explain && finding.explain.reason);
        return 'Reads as ' + (role || 'a different voice').toUpperCase();
    }
    if (finding.rule === 'drift') {
        return 'Traceability · ' + provenancePhrase(finding);
    }
    return 'Repeated · ' + provenancePhrase(finding);
}

// -- the head: title, freshness, tabs, trust filter, sort --------------------

const TRUST_OPTIONS = [
    { key: 'all', label: 'Everything' },
    { key: 'hide-weak', label: 'Hide weak' },
    { key: 'exact', label: 'Exact only' }
];
const SORT_OPTIONS = [
    { key: 'document', label: 'Document order' },
    { key: 'reach', label: 'By reach' }
];

/*
 * The progress of an actual detector run, and nothing when none is in flight.
 *
 * A run is seconds to a minute (the semantic pass loads a ~500 MB reranker), so
 * it is the one thing in this panel long enough that a person will wonder
 * whether it is still going. It says how far it has got and WHICH document it is
 * on, because "12 of 86" alone cannot be told apart from a stall.
 *
 * A failed run reports its reason here and does not clear the findings: the
 * previous run's results are still the truth about the last time anybody
 * checked, and blanking the panel because a new run failed would destroy
 * information rather than update it.
 */
function runRowHtml(state) {
    const run = state.runner;
    if (!run) { return ''; }
    if (run.running) {
        const total = Number(run.total) || 0;
        const done = Number(run.done) || 0;
        const count = total ? ' ' + done + ' of ' + total : '';
        const where = run.current ? ' · ' + esc(truncate(String(run.current), 34)) : '';
        return '<div class="studio-quality-run" role="status">' +
            '<span class="studio-quality-run-text">Checking…' + esc(count) + where + '</span>' +
            '<button class="studio-quality-run-cancel" data-act="' + QUALITY_ACTS.CANCEL_RUN + '">Cancel</button>' +
            '</div>';
    }
    if (run.error) {
        return '<div class="studio-quality-run failed" role="status">' +
            '<span class="studio-quality-run-text">The check failed — ' + esc(run.error) + '</span>' +
            '</div>';
    }
    return '';
}

function freshnessHtml(state) {
    if (state.scanning) {
        return '<span class="studio-quality-freshness">checking…</span>';
    }
    /*
     * ONE CONTROL, whose MEANING depends on whether a runner is reachable —
     * rather than two controls a person has to tell apart. "Check again" is what
     * somebody means either way; when the detectors are reachable it runs them,
     * and when they are not it re-reads whatever CI or a colleague dropped in
     * `reports/`. The tooltip states which of the two it will do, because the
     * difference is seconds versus milliseconds and they deserve to know that
     * before clicking.
     */
    const runner = state.runner || {};
    const title = runner.available
        ? 'Check this document again'
        : 'Re-read the reports on disk' + (runner.why ? ' — no detector here: ' + runner.why : '');
    const recheck = '<button class="studio-icon-btn" data-act="' + QUALITY_ACTS.RECHECK +
        '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' + ICONS.refresh + '</button>';
    if (!state.freshness || !state.freshness.present) {
        // PLAN-quality.md §13: the header states when the check ran, ALWAYS —
        // "not checked yet" is that statement's honest value when there is
        // nothing to date, not an omission of the freshness line.
        return recheck + '<span class="studio-quality-freshness">not checked yet</span>';
    }
    const full = esc(new Date(state.freshness.producedAt).toLocaleString());
    /* `relativeTime` already returns a complete phrase for the recent end of
     * its scale — "now", "just now" — and appending " ago" to it produced
     * "now ago" for every freshly finished run, which is the first thing a
     * person sees after pressing the button. Only the durations take the
     * suffix. */
    const when = relativeTime(state.freshness.producedAt);
    const phrase = /^(just )?now$/i.test(when) ? when : when + ' ago';
    return recheck + '<span class="studio-quality-freshness" title="' + full + '">' +
        esc(phrase) + '</span>';
}

function segmentedHtml(options, current, act, dataKey) {
    return '<div class="studio-seg" role="group">' + options.map(o =>
        '<button class="studio-seg-btn' + (o.key === current ? ' on' : '') + '" data-act="' + act + '" data-' +
        dataKey + '="' + o.key + '" aria-pressed="' + (o.key === current) + '">' + esc(o.label) + '</button>'
    ).join('') + '</div>';
}

function qualityHeadHtml(state) {
    const tab = state.tab || 'findings';
    const envelope = state.envelope;
    const badgeTotal = envelope ? (countOf(state.partitioned, 'shown') + countOf(state.partitioned, 'weak') +
        countOf(state.partitioned, 'later')) : 0;

    const tabs = '<div class="studio-quality-tabs" role="tablist">' +
        '<button class="studio-quality-tab' + (tab === 'findings' ? ' on' : '') + '" data-act="' + QUALITY_ACTS.TAB +
        '" data-tab="findings" role="tab" aria-selected="' + (tab === 'findings') + '">Findings' +
        (envelope ? ' <span class="studio-quality-tab-count">' + badgeTotal + '</span>' : '') + '</button>' +
        '<button class="studio-quality-tab' + (tab === 'measured' ? ' on' : '') + '" data-act="' + QUALITY_ACTS.TAB +
        '" data-tab="measured" role="tab" aria-selected="' + (tab === 'measured') + '">Measured</button>' +
        '</div>';

    /*
     * The trust filter and the sort only make a claim about the Findings list,
     * so they are withheld on the Measured tab rather than shown disabled — a
     * control that does nothing when clicked is worse than a control that is
     * not there (PLAN-quality.md never puts them in the §5 mock either).
     */
    const controls = (tab === 'findings' && envelope)
        ? '<div class="studio-quality-controls">' +
          segmentedHtml(TRUST_OPTIONS, state.trustFilter || 'all', QUALITY_ACTS.TRUST, 'trust') +
          segmentedHtml(SORT_OPTIONS, state.sort || 'document', QUALITY_ACTS.SORT, 'sort') +
          '</div>'
        : '';

    return '<div class="studio-quality-head">' +
        '<div class="studio-quality-head-top">' +
        '<span class="studio-rail-title">Quality</span>' +
        freshnessHtml(state) +
        '</div>' +
        tabs +
        controls +
        runRowHtml(state) +
        '</div>';
}

// -- the verdict block (purpose gate, only when it failed) -------------------

const BALANCE_ORDER = [['requirement', 'requirements'], ['design', 'design'], ['decision', 'decisions'], ['other', 'framing']];

/*
 * "Balance: requirements 66% · design 8% · framing 26%" — PLAN-quality.md §3.
 * Zero-share categories are dropped from the SENTENCE (the flagship's own
 * "decisions 0%" does not appear in the mock's balance line) even though the
 * Measured tab's distribution bar, out of scope here, shows all four. A
 * sentence that lists a zero is padding; a bar that omits one lies about the
 * total (PLAN §1's rule again: a number earns its place, and zero rarely
 * does inside a sentence already carrying three real ones).
 */
function balanceSentence(value) {
    if (!value || typeof value !== 'object') { return ''; }
    const parts = BALANCE_ORDER.filter(([key]) => Number(value[key]) > 0)
        .map(([key, label]) => label + ' ' + pctWhole(value[key]) + '%');
    return parts.join(' · ');
}

function verdictBlockHtml(envelope, gate) {
    const docType = docTypeLabel(envelope.document && envelope.document.docType);
    /*
     * The distribution measure is matched by SHAPE (valueType === 'distribution')
     * rather than by a guessed `name` — CONTRACT-quality.md §2 does not pin what
     * the role-mixture measure is called, and matching by shape is the one thing
     * that cannot drift out of sync with whatever quality-scan.js decides to
     * name it.
     */
    const dist = (envelope.measures || []).find(m => m.valueType === 'distribution');
    const balance = dist ? balanceSentence(dist.value) : '';
    return '<div class="studio-quality-verdict">' +
        '<div class="studio-quality-verdict-title">Purpose — failed</div>' +
        '<div class="studio-quality-verdict-sentence">' + pct1(gate.observed) + '% of this ' + esc(docType) +
        ' reads as DESIGN. The limit is ' + pctWhole(gate.threshold) + '%.</div>' +
        (balance ? '<div class="studio-quality-verdict-balance">Balance: ' + esc(balance) + '</div>' : '') +
        '</div>';
}

// -- the counts line -----------------------------------------------------

function countsLineHtml(findings) {
    if (!findings.length) { return ''; }
    const byRule = {};
    findings.forEach(f => { byRule[f.rule] = (byRule[f.rule] || 0) + 1; });
    const parts = [];
    if (byRule.duplicate) { parts.push(byRule.duplicate + ' ' + plural(byRule.duplicate, 'repeat')); }
    if (byRule.purpose) { parts.push(byRule.purpose + ' ' + plural(byRule.purpose, 'section') + ' in the wrong voice'); }
    if (byRule.drift) { parts.push(byRule.drift + ' ' + plural(byRule.drift, 'drifted link')); }
    return parts.length ? '<div class="studio-quality-counts">' + parts.join(' · ') + '</div>' : '';
}

// -- one card ------------------------------------------------------------

function cardHeadHtml(finding, badge) {
    const anchor = (finding.anchors && finding.anchors[0]) || {};
    const glyph = finding.rule === 'purpose' ? '§' : '¶';
    const label = glyph + (anchor.line != null ? anchor.line : '?');
    const leaf = finding.rule === 'purpose' ? sectionLeaf(anchor.section) : '';
    const why = '<button class="studio-quality-why" data-act="' + QUALITY_ACTS.EXPLAIN + '" data-fp="' +
        esc(finding.fingerprint) + '" aria-label="Why this was flagged">why?</button>';
    /*
     * THE BADGE IS A ROW MEMBER, NOT A FLOATING ORNAMENT. It used to be
     * `position: absolute; top: 10px; right: 11px` on the card, which is
     * precisely where this row's `why?` button sits — the two drew on top of
     * each other and rendered as "newhy?". Anything pinned to a card corner
     * collides with whatever the card's own layout puts there, so it goes in
     * the flow and the flow keeps them apart.
     */
    return '<div class="studio-quality-card-head">' +
        '<span class="studio-quality-anchor">' + esc(label) + '</span>' +
        '<span class="studio-quality-rule">' + esc(findingHeadline(finding)) + (leaf ? ' · ' + esc(leaf) : '') + '</span>' +
        (badge || '') + why +
        '</div>';
}

/*
 * The purpose detector's evidence array is written for a person debugging the
 * detector ("heading:\bapi contract|...", "content:schema, interface"), not
 * for a reader of the document. Rather than print regex soup on a card — the
 * exact "a labels feed" PLAN §14 rules out — this turns each fragment into one
 * plain clause and never repeats the raw pattern.
 */
function evidenceClause(evidence) {
    const clauses = (evidence || []).map(e => {
        const s = String(e);
        if (s.startsWith('heading:')) { return 'the heading'; }
        if (s.startsWith('content:')) { return 'content mentioning ' + s.slice('content:'.length).trim(); }
        return s;
    });
    return clauses.length ? 'Matched on ' + clauses.join(' and ') + '.' : '';
}

function cardBodyHtml(finding) {
    if (finding.rule === 'purpose') {
        const reason = finding.explain && finding.explain.reason;
        const evidence = evidenceClause(finding.explain && finding.explain.evidence);
        if (!reason && !evidence) { return ''; }
        return '<p class="studio-quality-justify">' + (reason ? esc(reason) + ' ' : '') + esc(evidence) + '</p>';
    }
    if (!finding.quote) { return ''; }
    return '<blockquote class="studio-quality-quote">' + esc(finding.quote) + '</blockquote>';
}

/*
 * "also at §External MCP CRUD, §External API…" — PLAN-quality.md §3 and §7:
 * one card, N jump targets, never N cards. Up to two more occurrences beyond
 * the card's own (three total) are named; the rest collapse behind a count.
 * An anchor in a file other than the one open in the editor is a LINK, not a
 * jump, and it uses the SAME act: the widget decides, from the anchor's own
 * file, whether the destination is a scroll or another document. That split
 * belongs there rather than here, because only the widget knows which document
 * is on screen — and the detector's path is its own root-relative one
 * ("tests/traceability/assess/mcp-engine/DESIGN.md" for a file that lives at
 * "mcp-engine/DESIGN.md" here), so deciding "same file?" is a suffix match
 * rather than a string comparison. This module gets it right for display and
 * lets the widget get it right for navigation.
 */
function occurrencesHtml(finding, docRelPath) {
    const anchors = finding.anchors || [];
    if (anchors.length <= 1) { return ''; }
    const shown = anchors.slice(0, 3);
    const rest = anchors.length - shown.length;
    const bits = shown.slice(1).map((a, i) => {
        const index = i + 1;
        const sameDoc = sameFile(a.file, docRelPath);
        const label = sameDoc
            ? '§' + esc(sectionLeaf(a.section) || fileBase(a.file))
            : esc(fileBase(a.file));
        return '<button class="studio-quality-occ-link' + (sameDoc ? '' : ' studio-quality-occ-other') +
            '" data-act="' + QUALITY_ACTS.JUMP + '" data-fp="' + esc(finding.fingerprint) +
            '" data-anchor="' + index + '" title="' +
            (sameDoc ? 'Go to this occurrence' : 'Open ' + esc(a.file)) + '">' + label + '</button>';
    });
    const more = rest > 0 ? ', +' + rest + ' more' : '';
    return '<div class="studio-quality-occurrences">also at ' + bits.join(', ') + more + '</div>';
}

/*
 * Fix buttons come from finding.fix.kind, and from nothing else — PLAN §8's
 * table is one tier per finding. (PLAN §3's ASCII mock shows a tier-1 button
 * next to "Ask Claude" on the same card; that reads as the mock illustrating
 * two POSSIBLE fix affordances rather than specifying both must render at
 * once, since §8 is unambiguous that the fix a card offers is singular and
 * "comes from finding.fix.kind". This file follows the prose rule over the
 * ASCII art — flagged in the final report as the one place they disagree.)
 */
function fixButtonHtml(finding) {
    const fix = finding.fix || { kind: 'none' };
    const fp = esc(finding.fingerprint);
    if (fix.kind === 'dedupe-link') {
        const n = Math.max(0, (finding.anchors || []).length - 1);
        return '<button class="studio-btn primary" data-act="' + QUALITY_ACTS.FIX + '" data-fp="' + fp +
            '" data-kind="dedupe-link">Keep this one · replace ' + n + ' ' + plural(n, 'other') + ' with a link</button>';
    }
    if (fix.kind === 'move-section') {
        const target = fix.suggestedFile || fix.target;
        /*
         * NO TARGET, NO MOVE BUTTON. A section that reads as a DECISION belongs
         * in an ADR that does not exist yet, and a move can only ever move into
         * a document that does — so offering "Move to the document that owns it"
         * would be a button that cannot do what it says. The honest control for
         * that case is the one that can: an assistant, labelled as one.
         */
        if (!target) {
            return '<button class="studio-btn" data-act="' + QUALITY_ACTS.FIX + '" data-fp="' + fp +
                '" data-kind="move-section">Ask Claude to move it</button>';
        }
        return '<button class="studio-btn primary" data-act="' + QUALITY_ACTS.FIX + '" data-fp="' + fp +
            '" data-kind="move-section">Move to ' + esc(target) + '</button>';
    }
    if (fix.kind === 'assistant') {
        return '<button class="studio-btn" data-act="' + QUALITY_ACTS.FIX + '" data-fp="' + fp +
            '" data-kind="assistant">Ask Claude</button>';
    }
    return '';
}

/*
 * The two decline verbs from PLAN §6 — "Not an issue" and "Later" — sit on
 * every open card. A parked (later) card swaps them for a single "Restore to
 * active", because a finding already parked has nothing left to park.
 */
function actionsRowHtml(finding, later) {
    const fp = esc(finding.fingerprint);
    if (later) {
        return '<div class="studio-rail-toolbar">' +
            '<button class="studio-btn" data-act="' + QUALITY_ACTS.RESTORE + '" data-fp="' + fp + '">Restore to active</button>' +
            '<button class="studio-btn ghost" data-act="' + QUALITY_ACTS.DISMISS + '" data-fp="' + fp + '">Not an issue</button>' +
            '</div>';
    }
    return '<div class="studio-rail-toolbar">' +
        fixButtonHtml(finding) +
        '<button class="studio-btn ghost" data-act="' + QUALITY_ACTS.DISMISS + '" data-fp="' + fp + '">Not an issue</button>' +
        '<button class="studio-btn ghost" data-act="' + QUALITY_ACTS.LATER + '" data-fp="' + fp + '">Later</button>' +
        '</div>';
}

function undoRowHtml(fp) {
    return '<div class="studio-quality-card studio-quality-undo" data-fp="' + esc(fp) + '">' +
        '<span>Dismissed</span>' +
        '<button class="studio-btn ghost" data-act="' + QUALITY_ACTS.UNDO + '" data-fp="' + esc(fp) + '">' +
        ICONS.undo + ' Undo</button>' +
        '</div>';
}

/*
 * The full card. `opts.later` swaps the action row; `opts.weak` only changes
 * which stylesheet class applies (the footer badge reading "weak" is driven
 * off finding.trust directly, since a card can be rendered inside the weak
 * disclosure OR — once shown === weak's fingerprint set, which never happens
 * today — inline, and the badge must not depend on which list called it).
 */
function cardHtml(finding, state, opts) {
    opts = opts || {};
    const fp = finding.fingerprint;
    if (state.undoFor === fp) { return undoRowHtml(fp); }

    const classes = ['studio-quality-card'];
    if (state.activeFingerprint === fp) { classes.push('active'); }
    if (finding.trust === 'weak') { classes.push('weak'); }
    if (opts.later) { classes.push('later'); }
    if (finding.stale) { classes.push('stale'); }

    const newBadge = (finding.isNew && !finding.supersedes) ? '<span class="studio-quality-badge">new</span>' : '';
    const supersedeNote = finding.supersedes
        ? '<div class="studio-quality-note">You dismissed something very like this.</div>' : '';
    const staleNote = finding.stale
        ? '<div class="studio-quality-note stale">This may already be fixed — <button class="studio-quality-inline-link" data-act="' +
          QUALITY_ACTS.RECHECK + '">re-check</button>.</div>'
        : '';

    const picker = state.pickerFor === fp ? reasonPickerHtml(finding, state.pickerReason) : '';
    const explain = (!picker && state.explainFor === fp) ? explainInline(finding, state) : '';
    const actions = picker ? '' : actionsRowHtml(finding, !!opts.later);
    const weakTag = finding.trust === 'weak' ? '<div class="studio-quality-weak-tag">weak</div>' : '';

    /*
     * `data-quality-card` as well as `data-fp`, because the two are asked
     * different questions. `data-fp` is on every control inside the card, so a
     * click can be routed; `data-quality-card` is on the card and nothing else,
     * which is what lets the widget find ONE element to scroll to when somebody
     * clicks an underlined sentence in the prose. Without it that lookup
     * silently matched nothing and the document-to-rail half of the pairing did
     * not work — the same pairing focusChange() already provides for tracked
     * changes, and the reason a reviewer who clicks a mark gets an answer.
     */
    return '<div class="' + classes.join(' ') + '" data-quality-card="' + esc(fp) + '" data-act="' +
        QUALITY_ACTS.FOCUS + '" data-fp="' + esc(fp) + '">' +
        cardHeadHtml(finding, newBadge) + cardBodyHtml(finding) + occurrencesHtml(finding, state.docRelPath) +
        supersedeNote + staleNote + explain + picker + actions + weakTag +
        '</div>';
}

/*
 * Bucketing the confidence values of every OTHER finding on the same rule into
 * a small histogram, purely for the sparkline in the explain popover. This is
 * presentation (turning numbers already on the findings into bar heights), not
 * detection — it does not decide what is a duplicate or how confidence is
 * banded, so it stays in this file rather than asking quality-scan.js for a
 * function whose only caller is a chart.
 */
const SPARK_BUCKETS = 9;
function buildConfidenceStats(findings, finding) {
    const conf = finding.confidence || {};
    const sample = (findings || []).filter(f => f.rule === finding.rule && f.confidence &&
        typeof f.confidence.value === 'number');
    if (!sample.length || conf.scaleMin == null || conf.scaleMax == null || conf.scaleMax <= conf.scaleMin) {
        return { count: sample.length };
    }
    const span = conf.scaleMax - conf.scaleMin;
    const counts = new Array(SPARK_BUCKETS).fill(0);
    const bucketOf = v => Math.min(SPARK_BUCKETS - 1, Math.max(0, Math.floor(((v - conf.scaleMin) / span) * SPARK_BUCKETS)));
    sample.forEach(f => { counts[bucketOf(f.confidence.value)]++; });
    const max = Math.max(1, ...counts);
    return { count: sample.length, buckets: counts.map(c => c / max), markerIndex: bucketOf(conf.value) };
}

function explainInline(finding, state) {
    const stats = buildConfidenceStats(state.findings, finding);
    const analyzers = (state.envelope && state.envelope.analyzers) || [];
    return explainHtml(finding, stats, analyzers);
}

// -- footer disclosures: weak, dismissed, not-run, project route ------------

function disclosureToggleHtml(count, noun, act, open) {
    const label = count + ' ' + plural(count, noun) + ' — ' + (open ? 'hide' : 'show');
    return '<button class="studio-quality-disclosure-toggle" data-act="' + act + '" aria-expanded="' + open + '">' +
        esc(label) + '</button>';
}

function weakDisclosureHtml(list, state) {
    if (!list.length) { return ''; }
    const open = !!state.showWeak;
    const body = open ? list.map(f => cardHtml(f, state, {})).join('') : '';
    return '<div class="studio-quality-disclosure">' +
        disclosureToggleHtml(list.length, 'weaker match', QUALITY_ACTS.TOGGLE_WEAK, open) + body + '</div>';
}

const REASON_LABELS = {
    'not-a-duplicate': { duplicate: 'Not actually a duplicate', purpose: 'Not really DESIGN', drift: 'Not actually drifted' },
    deliberate: { duplicate: 'Repeated on purpose', purpose: 'This belongs here on purpose', drift: 'The gap is intentional' },
    'wont-fix': { _default: "Won't fix here" },
    'wrong-doc-type': { _default: "Wrong document type — this isn't the right template" }
};
function reasonLabel(reasonKey, rule) {
    const entry = REASON_LABELS[reasonKey] || {};
    return entry[rule] || entry._default || reasonKey;
}

function dismissedItemHtml(finding) {
    const anchor = (finding.anchors && finding.anchors[0]) || {};
    const text = finding.quote || sectionLeaf(anchor.section) || '';
    const reason = finding.judgment && finding.judgment.reason;
    return '<div class="studio-quality-dismissed-item">' +
        '<span class="studio-quality-dismissed-quote">' + esc(truncate(text, 70)) + '</span>' +
        (reason ? '<span class="studio-quality-dismissed-reason">' + esc(reasonLabel(reason, finding.rule)) + '</span>' : '') +
        '<button class="studio-btn ghost" data-act="' + QUALITY_ACTS.RESTORE + '" data-fp="' + esc(finding.fingerprint) +
        '">Restore</button>' +
        '</div>';
}

function dismissedDisclosureHtml(list, state) {
    if (!list.length) { return ''; }
    const open = !!state.showDismissed;
    const body = open ? list.map(dismissedItemHtml).join('') : '';
    return '<div class="studio-quality-disclosure">' +
        disclosureToggleHtml(list.length, 'dismissed', QUALITY_ACTS.TOGGLE_DISMISSED, open) + body + '</div>';
}

/*
 * "Not measured: Completeness, Clarity, Traceability" — built from
 * envelope.notRun, never hand-written here. The absence is designed data
 * (CONTRACT-quality.md §2, PLAN-quality.md §1's corollary), not a fallback
 * string this file invents when it does not know what ran.
 */
function notRunLineHtml(notRun) {
    const axes = (notRun || []).map(n => n.axis).filter(Boolean);
    if (!axes.length) { return ''; }
    return '<div class="studio-quality-notrun">Not measured: ' + esc(axes.join(', ')) + '</div>';
}

function projectLinkHtml(state) {
    if (!state.projectCount) { return ''; }
    return '<button class="studio-quality-project-link" data-act="' + QUALITY_ACTS.OPEN_PROJECT + '">In this project: ' +
        state.projectCount + ' more ' + plural(state.projectCount, 'document') + '</button>';
}

function resolvedBannerHtml(n) {
    return '<div class="studio-quality-resolved">' +
        '<span>' + n + ' ' + plural(n, 'finding') + ' resolved since the last check</span>' +
        '<button class="studio-icon-btn" data-act="' + QUALITY_ACTS.DISMISS_RESOLVED +
        '" title="Dismiss this notice" aria-label="Dismiss this notice">' + ICONS.close + '</button>' +
        '</div>';
}

// -- the empty states, and why they must never look alike --------------------

/*
 * Two states, deliberately different (top-level task brief, and PLAN-quality
 * §3 "empty is the common case"). NO REPORT means envelope is absent — this
 * is CONTRACT-quality.md §5's "a document with no report is a real state that
 * says so", never an empty panel. A CLEAN report (envelope present, zero
 * findings) says when it ran and what was not measured, because 14 of 86 real
 * documents are clean and deserve to look checked, not broken.
 */
function emptyStateHtml(state) {
    if (!state.envelope) {
        const more = state.projectCount ? ' across ' + (state.projectCount + 1) + ' documents' : '';
        /*
         * "Nothing has been checked" and "nothing CAN be checked here" are
         * different facts and must not read alike. When the runner has been
         * probed and reported itself unavailable, this says so and names the
         * reason — the detectors are located, never bundled (CONTRACT-runner.md
         * §0 Q2), so "not available here" is a normal state on a machine
         * without them, and the report-drop route still works and is still
         * offered.
         */
        const runner = state.runner;
        if (runner && runner.available === false) {
            return '<div class="studio-rail-empty">Nothing has been checked for this document, and ' +
                'analysis is not available here' + (runner.why ? ' — ' + esc(runner.why) : '') +
                '. A report dropped into <code>.studio/quality/reports/</code> by CI or by hand ' +
                'still renders in full.</div>';
        }
        return '<div class="studio-rail-empty">Quality analysis has not run for this document. ' +
            '<button class="studio-quality-inline-link" data-act="' + QUALITY_ACTS.OPEN_PROJECT +
            '">Check the project</button>' + more + ', or drop a report into ' +
            '<code>.studio/quality/reports/</code>.</div>';
    }
    const when = (state.freshness && state.freshness.present) ? relativeTime(state.freshness.producedAt) + ' ago' : 'just now';
    return '<div class="studio-rail-empty">Checked ' + esc(when) + '. Nothing to act on.</div>' +
        notRunLineHtml(state.envelope.notRun);
}

// -- the list: verdict, counts, cards, disclosures, footer rows --------------

function qualityListHtml(state) {
    // The Measured tab's body belongs to a sibling module (quality-measures.js,
    // out of scope here) — this file only ever contributes its tab button.
    if ((state.tab || 'findings') !== 'findings') { return ''; }

    if (state.scanning) {
        return '<div class="studio-rail-empty">Checking this document…</div>';
    }
    if (!state.envelope || !(state.findings || []).length) {
        return emptyStateHtml(state);
    }

    const partitioned = state.partitioned || {};
    const shownSet = new Set((partitioned.shown || []).map(f => f.fingerprint));
    const laterSet = new Set((partitioned.later || []).map(f => f.fingerprint));
    // Bucketing trusts partition(); ORDER trusts state.findings (see header
    // comment) — a filter, never a re-sort, so document/reach order survives.
    const main = state.findings.filter(f => shownSet.has(f.fingerprint) || laterSet.has(f.fingerprint));

    const gate = (state.envelope.gates || []).find(g => g.name === 'purpose');
    const verdict = (gate && gate.status === 'fail') ? verdictBlockHtml(state.envelope, gate) : '';
    const resolvedBanner = state.resolvedSince ? resolvedBannerHtml(state.resolvedSince) : '';

    const weakList = partitioned.weak || [];
    const dismissedList = partitioned.dismissed || [];

    /*
     * THE UNDO ROW, kept in the list even though the finding it belongs to has
     * already left it.
     *
     * partition() puts a dismissed finding in `dismissed`, so it is no longer in
     * `main` and cardHtml() — which is what renders the undo row — is never
     * reached for it. That made the row unreachable: the card vanished the
     * instant it was dismissed and the only way back was the Dismissed
     * disclosure. Measured in the running application, and it matters more than
     * it looks: a dismissal writes to a file that gets committed, so a mis-click
     * has to be takeable back in the place it happened rather than three clicks
     * away.
     *
     * It renders where the card was — first in the list — because that is where
     * the eye already is.
     */
    const undoRow = state.undoFor && !shownSet.has(state.undoFor) && !laterSet.has(state.undoFor)
        ? undoRowHtml(state.undoFor) : '';

    let cardsHtml;
    if (main.length) {
        cardsHtml = main.map(f => cardHtml(f, state, { later: laterSet.has(f.fingerprint) })).join('');
    } else if (undoRow) {
        cardsHtml = '';
    } else if (weakList.length || dismissedList.length) {
        cardsHtml = '<div class="studio-rail-empty">Nothing open right now.</div>';
    } else {
        cardsHtml = '';
    }

    return resolvedBanner +
        verdict +
        countsLineHtml(main) +
        undoRow +
        cardsHtml +
        weakDisclosureHtml(weakList, state) +
        dismissedDisclosureHtml(dismissedList, state) +
        '<div class="studio-quality-footrows">' +
        notRunLineHtml(state.envelope.notRun) +
        projectLinkHtml(state) +
        '</div>';
}

// -- the foot text ------------------------------------------------------

function analyzerFootText(analyzers) {
    if (!analyzers || !analyzers.length) { return 'No analyzers reported.'; }
    const names = analyzers.map(a => a.id + (a.version ? ' ' + a.version : '') + (a.model ? ' · ' + a.model : '')).join(' · ');
    const uncalibrated = analyzers.some(a => a.calibration !== 'corpus');
    return names + (uncalibrated ? ' · every threshold uncalibrated' : '');
}

function qualityFootText(state) {
    if (!state.envelope) { return ''; }
    if ((state.tab || 'findings') === 'measured') {
        return analyzerFootText(state.envelope.analyzers);
    }
    const openN = countOf(state.partitioned, 'shown') + countOf(state.partitioned, 'later');
    const weakN = countOf(state.partitioned, 'weak');
    const dismissedN = countOf(state.partitioned, 'dismissed');
    const bits = [];
    if (openN) { bits.push(openN + ' open'); }
    if (weakN) { bits.push(weakN + ' weak'); }
    if (dismissedN) { bits.push(dismissedN + ' dismissed'); }
    return bits.length ? bits.join(' · ') : 'Nothing to act on.';
}

// -- the explain popover (rendered inline — see header comment) -------------

function sparklineHtml(stats, value) {
    if (!stats || !stats.buckets || !stats.buckets.length) { return ''; }
    const bars = stats.buckets.map((h, i) =>
        '<span class="studio-quality-bar' + (i === stats.markerIndex ? ' marked' : '') +
        '" style="height:' + Math.max(8, Math.round(h * 100)) + '%"></span>').join('');
    return '<div class="studio-quality-spark-row">' +
        '<div class="studio-quality-spark">' + bars + '</div>' +
        '<div class="studio-quality-spark-caption">where ' + Number(value).toFixed(2) + ' sits among the ' +
        (stats.count || 0) + ' ' + plural(stats.count || 0, 'match', 'matches') + ' in this project</div>' +
        '</div>';
}

/*
 * The one sentence PLAN-quality.md §4 insists on printing rather than hiding:
 * when confidence.discriminates is false, the popover says so in plain words
 * instead of quietly showing a number that means nothing on its own scale.
 */
function scaleSentence(conf) {
    if (conf.scaleMin == null || conf.scaleMax == null) { return ''; }
    const min = Number(conf.scaleMin).toFixed(2), max = Number(conf.scaleMax).toFixed(2);
    if (conf.discriminates === false) {
        return 'Every verdict in this run scores between ' + min + ' and ' + max +
            ' — this number does not separate them.';
    }
    return 'On this detector confidence runs ' + min + ' to ' + max + ' and is worth reading.';
}

/* Numeric cut points (0.60 / 0.85) only mean something on a lexical/semantic
   scale; a drift verdict's bands are categorical (contradiction/drift/
   partial/uncovered — CONTRACT §2's banding table), so the sentence about them
   names the bands instead of numbers that do not exist for that provenance. */
function cutPointsSentence(finding) {
    const calibration = (finding.confidence && finding.confidence.calibration) || 'none';
    if (finding.provenance === 'llm') {
        return 'Verdict bands (contradiction, drift, partial, uncovered) are assumptions — calibration: ' +
            esc(calibration) + '.';
    }
    return 'Cut points (weak below 0.60, strong at 0.85 and up) are assumptions — calibration: ' + esc(calibration) + '.';
}

/*
 * `analyzers` is rendered as the whole envelope.analyzers list rather than an
 * attempt to pick out "the one that produced this finding" — the envelope in
 * CONTRACT-quality.md §2 does not tag a finding with an analyzer id, and
 * guessing by matching `rule` to a naming convention would be exactly the
 * kind of silent coupling this file's header comment already rules out for
 * trustPhrase(). Listing every build behind the run is also the more honest
 * answer to "who produced it" when a run mixes detectors, per PLAN §4's own
 * "the analyser build line" — see the final report for this call.
 */
function explainHtml(finding, stats, analyzers) {
    stats = stats || {};
    analyzers = analyzers || [];
    const conf = finding.confidence || {};
    const number = conf.value != null ? Number(conf.value).toFixed(2) : '—';
    const evidence = (finding.explain && finding.explain.evidence) || [];
    const evidenceBlock = evidence.length
        ? '<div class="studio-quality-evidence">' +
          '<div class="studio-quality-evidence-label">Matched on ' + evidence.length + ' shared ' +
          plural(evidence.length, 'token') + ':</div>' +
          '<div class="studio-quality-evidence-tokens">' + evidence.map(e => esc(e)).join(' · ') + '</div>' +
          '</div>'
        : '';
    const analyzerLine = analyzers.length
        ? analyzers.map(a => esc(a.id) + (a.version ? ' ' + esc(a.version) : '') + (a.model ? ' · ' + esc(a.model) : '') +
            (a.benchmark === undefined ? ' · not benchmarked' : '')).join(' · ')
        : 'Analyzer build unknown — this finding would not normally be shown at all.';
    const readAt = finding.explain && finding.explain.readAt ? shortStamp(finding.explain.readAt) : '';

    return '<div class="studio-quality-explain">' +
        '<div class="studio-quality-explain-head"><span>Why this was flagged</span>' +
        '<button class="studio-icon-btn" data-act="' + QUALITY_ACTS.EXPLAIN_CLOSE +
        '" title="Close" aria-label="Close">' + ICONS.close + '</button></div>' +
        '<div class="studio-quality-explain-sub">' + esc(findingHeadline(finding)) + '</div>' +
        '<div class="studio-quality-explain-number">' +
        '<span class="studio-quality-explain-label">confidence</span>' +
        '<span class="studio-quality-explain-value">' + number + '</span></div>' +
        sparklineHtml(stats, conf.value) +
        '<div class="studio-quality-explain-scale">' + esc(scaleSentence(conf)) + ' ' + cutPointsSentence(finding) + '</div>' +
        evidenceBlock +
        '<div class="studio-quality-explain-foot">' + analyzerLine + (readAt ? '<br>read at ' + esc(readAt) : '') + '</div>' +
        '</div>';
}

// -- the "Not an issue" picker -----------------------------------------------

const REASON_KEYS = ['not-a-duplicate', 'deliberate', 'wont-fix', 'wrong-doc-type'];

/*
 * CONTRACT-quality.md §4's closed vocabulary, rendered as a click-delegated
 * row rather than a native <input type="radio"> — every other stateful choice
 * in this rail (the trust filter, the sort, a comment's resolve toggle) is a
 * data-act button the widget's one click switch already knows how to read,
 * and a radio input would need its own 'change' listener nobody asked for.
 */
function reasonPickerHtml(finding, reasonKey) {
    const fp = esc(finding.fingerprint);
    const rows = REASON_KEYS.map(key => {
        const on = key === reasonKey;
        const arrow = key === 'wrong-doc-type' ? ' →' : '';
        return '<button class="studio-quality-reason-row' + (on ? ' on' : '') + '" data-act="' + QUALITY_ACTS.REASON +
            '" data-fp="' + fp + '" data-reason="' + key + '" role="radio" aria-checked="' + on + '">' +
            '<span class="studio-quality-reason-bullet">' + (on ? '●' : '○') + '</span>' +
            '<span>' + esc(reasonLabel(key, finding.rule)) + arrow + '</span>' +
            '</button>';
    }).join('');
    return '<div class="studio-quality-picker" role="radiogroup" aria-label="Not an issue">' +
        '<div class="studio-quality-picker-title">Not an issue</div>' +
        rows +
        '<textarea class="studio-quality-picker-note" data-quality-note placeholder="note (optional)" rows="2"></textarea>' +
        '<div class="studio-rail-toolbar">' +
        '<button class="studio-btn ghost" data-act="' + QUALITY_ACTS.PICKER_CANCEL + '">Cancel</button>' +
        '<button class="studio-btn primary" data-act="' + QUALITY_ACTS.DISMISS_CONFIRM + '" data-fp="' + fp + '"' +
        (reasonKey ? '' : ' disabled') + '>Dismiss</button>' +
        '</div></div>';
}

// -- the stylesheet -----------------------------------------------------

/*
 * Every colour below is a --studio-* token (CONTRACT-quality.md §1 house
 * rule); there is no literal hex anywhere in this block, checked by the
 * scratchpad proof script rather than by eye. Geometry is borrowed rather
 * than reinvented wherever the rail already has an answer: .studio-rail-head/
 * -list/-empty/-toolbar/-foot-note from editor-css.js, .studio-seg/-seg-btn
 * for the two segmented controls, .studio-btn/-icon-btn for every button. The
 * only new geometry here is what the rail genuinely does not have yet — a
 * card, a disclosure row, a sparkline, an inline picker.
 */
const QUALITY_CSS = `
/* --- head: title row, tabs, trust filter, sort ----------------------------
 *
 * .studio-rail-head (editor-css.js) is a single flex row with align-items:
 * center, built for a title plus one or two icon buttons (Comments, Review
 * queue). This surface needs a title row, a tab strip AND a controls row, so
 * .studio-quality-head is one block-level child that becomes that row's only
 * flex item (flex: 1 1 auto) and lays its own three rows out internally —
 * the parent's row-flex is honoured (one child) without fighting it for a
 * second row inside a flex row's cross axis.
 */
.studio-quality-head { display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-width: 0; }
.studio-quality-head-top { display: flex; align-items: center; gap: 6px; }
.studio-quality-head-top .studio-rail-title { margin: 0; }
.studio-quality-freshness { font-size: 11px; color: var(--studio-muted); white-space: nowrap; }
/* The run row sits under the controls rather than in the title line: it appears
   and disappears, and anything that changes height in a title line makes the
   whole head jump every time a check starts. */
.studio-quality-run {
  display: flex; align-items: baseline; gap: 8px; margin-top: 2px; padding: 5px 2px;
  font-size: 11.5px; color: var(--studio-muted);
}
.studio-quality-run-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.studio-quality-run.failed .studio-quality-run-text { color: var(--studio-danger); }
.studio-quality-run-cancel {
  flex: none; font: inherit; font-size: 11.5px; color: var(--studio-cyan); background: none; border: none;
  padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.studio-quality-run-cancel:focus-visible { outline: 2px solid var(--studio-amber); outline-offset: 2px; }

.studio-quality-tabs { display: flex; gap: 14px; }
.studio-quality-tab {
  font: inherit; font-size: 12px; padding: 2px 0 6px; border: none; background: transparent;
  color: var(--studio-muted); cursor: pointer; border-bottom: 2px solid transparent;
}
.studio-quality-tab.on { color: var(--studio-text); font-weight: 620; border-bottom-color: var(--studio-amber); }
.studio-quality-tab:focus-visible { outline: 2px solid var(--studio-amber); outline-offset: 2px; }
/* Tabular figures: this badge sits beside a tab label that otherwise shifts
   width every time a finding resolves, which reads as the tab itself moving. */
.studio-quality-tab-count { font-variant-numeric: tabular-nums; color: var(--studio-muted); }
.studio-quality-tab.on .studio-quality-tab-count { color: var(--studio-text); }

.studio-quality-controls { display: flex; flex-wrap: wrap; gap: 6px; }

/* --- the resolved-since banner ---------------------------------------- */
.studio-quality-resolved {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 8px 2px 4px; padding: 6px 8px; border-radius: 7px;
  background: var(--studio-surface-sunken); color: var(--studio-muted); font-size: 12px;
}

/* --- the verdict block: the only place a raw percentage renders ------------
 *
 * PLAN-quality.md §1: a number earns its place by crossing a line somebody
 * drew. This block exists ONLY when the purpose gate failed (qualityListHtml
 * never calls it otherwise) — on a passing gate nothing here renders at all,
 * which is the point, not an edge case to special-case around.
 */
.studio-quality-verdict {
  margin: 8px 2px 12px; padding: 10px 11px; border-radius: 9px;
  background: var(--studio-surface-sunken); border: 1px solid var(--studio-line);
}
.studio-quality-verdict-title { font-size: 11px; font-weight: 650; letter-spacing: .02em; color: var(--studio-danger); margin-bottom: 4px; }
.studio-quality-verdict-sentence { font-size: 13px; line-height: 1.5; color: var(--studio-text); }
.studio-quality-verdict-balance { margin-top: 4px; font-size: 11.5px; color: var(--studio-muted); }

.studio-quality-counts { margin: 2px 2px 10px; font-size: 11.5px; color: var(--studio-muted); }

/* --- a card -----------------------------------------------------------
 *
 * No accent border and no fill by default: the document itself carries the
 * underline/left-rule marks (PLAN §7), and giving the CARD a matching colour
 * as well would be the badge-as-colour move CONTRACT §1 rules out for trust.
 * Selection is the same tinted-surface convention comment threads use.
 */
.studio-quality-card {
  position: relative; border-radius: 10px; padding: 10px 11px 11px; margin-bottom: 8px;
  background: var(--studio-surface); border: 1px solid var(--studio-line); cursor: pointer;
}
.studio-quality-card.active { background: var(--studio-selection-bg); border-color: var(--studio-amber); }
/* A stale finding gets a dashed edge rather than a second banner colour — the
   danger token is reserved for the purpose gate and for delete, and staleness
   is "go check", not "something is wrong". */
.studio-quality-card.stale { border-style: dashed; }
.studio-quality-card.later { opacity: .74; }
.studio-quality-card-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 5px; }
.studio-quality-anchor { flex: none; font-variant-numeric: tabular-nums; color: var(--studio-muted); font-size: 11.5px; }
.studio-quality-rule { flex: 1 1 auto; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--studio-text); }
.studio-quality-why {
  flex: none; font: inherit; font-size: 11.5px; color: var(--studio-cyan); background: none; border: none;
  padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.studio-quality-why:focus-visible { outline: 2px solid var(--studio-amber); outline-offset: 2px; }

.studio-quality-quote {
  margin: 0 0 8px; padding: 0 0 0 10px; border-left: 2px solid var(--studio-line);
  font-size: 13px; line-height: 1.55; color: var(--studio-text); font-style: italic;
  /* Multi-line quotes must wrap inside the 360px rail rather than push it wide. */
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.studio-quality-justify { margin: 0 0 8px; font-size: 12.5px; line-height: 1.5; color: var(--studio-muted); }

.studio-quality-occurrences { margin: 0 0 8px; font-size: 11.5px; color: var(--studio-muted); overflow-wrap: anywhere; }
.studio-quality-occ-link {
  font: inherit; font-size: 11.5px; color: var(--studio-cyan); background: none; border: none; padding: 0;
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.studio-quality-occ-other { color: var(--studio-muted); }

.studio-quality-badge {
  flex: none; align-self: center; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--studio-amber); border: 1px solid var(--studio-amber); border-radius: 999px; padding: 1px 6px;
}
/* The action row is the shared rail toolbar, whose 8px/10px margins are sized
   for sitting loose in a rail — inside a card they stack with the card's own
   11px bottom padding and leave 21px of empty box under the buttons. The card
   supplies the spacing here; the toolbar supplies none. */
.studio-quality-card .studio-rail-toolbar { margin: 0; }
.studio-quality-note { margin: 0 0 8px; font-size: 11.5px; color: var(--studio-muted); font-style: italic; }
.studio-quality-note.stale { color: var(--studio-text); font-style: normal; }
.studio-quality-inline-link {
  font: inherit; color: var(--studio-cyan); background: none; border: none; padding: 0; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}

/* "weak", the one word confidence is ever allowed to be on a card (CONTRACT
   §1, PLAN §4/§14) — bottom-right, quiet, never a bar and never a decimal. */
.studio-quality-weak-tag {
  margin-top: 6px; text-align: right; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--studio-muted);
}

.studio-quality-undo {
  display: flex; align-items: center; justify-content: space-between; cursor: default;
  color: var(--studio-muted); font-size: 12.5px;
}

/* --- footer disclosures: weak matches, dismissed — counted, never listed by
   default (PLAN §3, §6). Same shape as .studio-resolved-toggle in comment-ui's
   stylesheet neighbour, kept as a sibling class rather than reused directly
   because that one is scoped to comment threads specifically in its own
   selector story; the visual language (a plain row, a chevron-free "— show/
   hide" suffix) is deliberately identical. */
.studio-quality-disclosure { margin: 10px 2px 4px; padding-top: 8px; border-top: 1px solid var(--studio-line); }
.studio-quality-disclosure-toggle {
  display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; color: var(--studio-muted);
  background: none; border: none; padding: 2px 0; cursor: pointer;
}
.studio-quality-disclosure-toggle:hover { color: var(--studio-text); }
.studio-quality-dismissed-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--studio-line);
}
.studio-quality-dismissed-quote {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--studio-muted); font-style: italic;
}
.studio-quality-dismissed-reason { flex: none; font-size: 10.5px; color: var(--studio-muted); }

.studio-quality-footrows { margin-top: 10px; }
.studio-quality-notrun { font-size: 11px; color: var(--studio-muted); padding: 6px 2px; }
.studio-quality-project-link {
  display: block; width: 100%; text-align: left; font: inherit; font-size: 11.5px; color: var(--studio-cyan);
  background: none; border: none; padding: 6px 2px; cursor: pointer;
}

/* --- the explain popover, rendered INLINE inside the card that opened it
 * (see the file header for why this is not a floating .studio-bubble-style
 * surface: this module owns no node to position one from). A hairline and a
 * sunken tone separate it from the card's own quote the same way the rail
 * itself separates from the document — tone plus a hairline, never a heavy
 * border (the running convention set by editor-css.js's SLOT_PANEL note). */
.studio-quality-explain {
  margin: 4px 0 8px; padding: 9px 10px; border-radius: 8px; cursor: default;
  background: var(--studio-surface-sunken); border: 1px solid var(--studio-line); font-size: 12px;
}
.studio-quality-explain-head {
  display: flex; align-items: center; justify-content: space-between; font-weight: 650; margin-bottom: 6px;
}
.studio-quality-explain-sub { color: var(--studio-muted); margin-bottom: 8px; }
.studio-quality-explain-number { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.studio-quality-explain-label { color: var(--studio-muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
.studio-quality-explain-value { font-variant-numeric: tabular-nums; font-size: 15px; font-weight: 650; }

/* The sparkline is nine flexed bars, not a chart library — this is a shape
   for "where does one value sit among many", not a measurement anyone reads
   a number off, so nine div heights are the whole implementation. */
.studio-quality-spark-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.studio-quality-spark { flex: none; display: flex; align-items: flex-end; gap: 2px; height: 24px; width: 72px; }
.studio-quality-bar { flex: 1 1 auto; background: var(--studio-line); border-radius: 1px; min-height: 8%; }
.studio-quality-bar.marked { background: var(--studio-amber); }
.studio-quality-spark-caption { flex: 1 1 auto; min-width: 0; color: var(--studio-muted); font-size: 11px; line-height: 1.4; }

.studio-quality-explain-scale { color: var(--studio-muted); line-height: 1.5; margin-bottom: 6px; }
.studio-quality-evidence { margin-bottom: 6px; }
.studio-quality-evidence-label { color: var(--studio-muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px; }
.studio-quality-evidence-tokens { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
.studio-quality-explain-foot { color: var(--studio-muted); font-size: 10.5px; padding-top: 6px; border-top: 1px solid var(--studio-line); }

/* --- the "Not an issue" picker, also rendered inline (same reasoning as the
   explain popover above) --- */
.studio-quality-picker { margin: 4px 0 8px; padding: 9px 10px; border-radius: 8px; cursor: default; background: var(--studio-surface-sunken); border: 1px solid var(--studio-line); }
.studio-quality-picker-title { font-size: 12px; font-weight: 650; margin-bottom: 6px; }
.studio-quality-reason-row {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; font: inherit; font-size: 12.5px;
  background: none; border: none; padding: 4px 2px; border-radius: 6px; cursor: pointer; color: var(--studio-text);
}
.studio-quality-reason-row:hover { background: var(--studio-surface-raised); }
.studio-quality-reason-row.on { font-weight: 620; }
.studio-quality-reason-bullet { flex: none; color: var(--studio-muted); }
.studio-quality-reason-row.on .studio-quality-reason-bullet { color: var(--studio-amber); }
.studio-quality-picker-note {
  display: block; width: 100%; box-sizing: border-box; margin: 6px 0; padding: 6px 8px; resize: vertical;
  font: inherit; font-size: 12px; border-radius: 6px; border: 1px solid var(--studio-line);
  background: var(--studio-bg); color: var(--studio-text);
}
.studio-quality-picker-note:focus-visible { outline: 2px solid var(--studio-amber); outline-offset: 1px; }
`;

module.exports = {
    QUALITY_CSS,
    qualityHeadHtml,
    qualityListHtml,
    qualityFootText,
    explainHtml,
    reasonPickerHtml,
    emptyStateHtml,
    QUALITY_ACTS
};
