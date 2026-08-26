/*
 * Quality, as arithmetic — no DOM, no Theia, nothing that needs a window.
 *
 * WHY THIS IS A SEPARATE FILE. `search-scan.js` set the precedent this module
 * follows to the letter: everything hard about a quality report is a pure
 * question with a checkable answer — which cluster becomes which finding,
 * what trust band a piece of evidence earns, which order sixteen findings
 * belong in, which of them a "hide weak" click removes. Everything easy about
 * it — the card, the popover, the tab strip — is DOM, and lives in
 * `quality-view.js`, not here. Keeping the split lets `quality-scan-test.mjs`
 * drive this file in node in a few milliseconds, against real fixtures cut
 * from the actual 86-document corpus, instead of a browser.
 *
 * WHAT CROSSES THE BOUNDARY. Four detectors write four different JSON shapes
 * to disk — `bloat/*.json`, `purpose/*.json`, `bloat-docset/*.json`,
 * `trace-*.json` — and CONTRACT-quality.md §0 is explicit that the frontend
 * must never learn any of them. `normalizeDocument` and `normalizeDocset` are
 * the only two functions that read a detector's own field names
 * (`char_start`, `line_start`, `leak_share`, `def_doc` …); everything past
 * them speaks only the envelope's vocabulary (`rule`, `trust`, `anchors`,
 * `measures`, `gates`). A view that reaches past this file to read
 * `cluster.occurrences` directly has broken the one promise this module makes.
 *
 * WHAT THIS MODULE IS HONEST ABOUT, because a quality panel is a machine for
 * making people believe a heuristic is a fact:
 *
 *  - `trust` is a word chosen from a fixed table (CONTRACT §2), never a
 *    decimal rendered as if it were self-explanatory. The decimal still
 *    exists — `confidence.value` — but hiding it by default is a display
 *    decision made once, in the view, not a claim that it does not exist.
 *  - `confidence.scaleMin` / `scaleMax` are computed from the findings THIS
 *    RUN actually produced for THAT rule, never from a constant baked in
 *    here. A cluster score of 0.57 means nothing on its own; against this
 *    run's observed 0.41–1.00 it means something, and that spread cannot be
 *    known in advance of reading the reports.
 *  - `calibration` is `'none'` on every analyzer today, stated rather than
 *    omitted, because every threshold in every detector — 0.60, 0.85, 0.05 —
 *    is an assumption nobody has measured against ground truth yet.
 *  - Ordering never encodes an invented severity. `orderFindings` offers
 *    exactly two orders, both derived from data the detectors actually
 *    produced (position in the document; reach across files) — see PLAN §14,
 *    which records that a third, "important first", order was considered and
 *    rejected for having nothing to compute it from.
 */

const { normalizeText, fingerprint } = require('./quality-identity');

// -- the rule version, and why it is a constant rather than a field read off
//    a report --------------------------------------------------------------

/*
 * Every finding needs a `ruleVersion` before it can be fingerprinted — it is
 * part of the fingerprint payload, specified byte-for-byte in
 * CONTRACT-quality.md §3, precisely so that a future change to how a rule
 * computes its findings can bump this string and let old judgments read as
 * "belongs to a finding that no longer exists" rather than silently
 * misattaching to a new one.
 *
 * Neither `bloat/*.json` nor `purpose/*.json` carries any such version today
 * — the Python detectors were not written with this product in mind — so
 * there is nothing to read off the report. `'1'` is this module's own
 * declaration that today's clustering and gate logic is "version 1" of the
 * `duplicate` and `purpose` rules. The day the detector's clustering
 * algorithm changes in a way that would silently reshuffle which occurrences
 * land in which cluster, this constant is what should become `'2'`.
 */
const RULE_VERSION = '1';

// -- analyzer identity — stated, not invented -------------------------------

/*
 * Neither report names the build of the tool that produced it, which is
 * itself worth surfacing (`benchmark: undefined` renders as "not
 * benchmarked" downstream, and the same honesty applies to the version
 * numbers here: they come from the detectors' own `pyproject.toml` /
 * `package.json` at the time these fixtures were generated, copied in by
 * hand, and MUST be updated by hand if the detector is rebuilt). `model` is
 * set only for `bloat-detector`, because the semantic half of duplicate
 * detection is a reranker call and the lexical half is not; `purpose`
 * classifies by rule and regex, so it has no model to name.
 */
const BLOAT_DETECTOR = Object.freeze({
    id: 'bloat-detector', version: '0.4.1', model: 'bge-m3 reranker',
    calibration: 'none', benchmark: undefined
});
const PURPOSE_CLASSIFIER = Object.freeze({
    id: 'purpose-classifier', version: '0.3.0', model: undefined,
    calibration: 'none', benchmark: undefined
});
/*
 * The traceability judge is an LLM call rather than a shipped build with a
 * version number of its own — `trace-*.json` records only which model
 * answered (`gemini-3.7-flash` in the fixture), not a tool version. `id` is
 * this module's own name for "whatever ran the LLM traceability pass",
 * invented here because CONTRACT-quality.md never names one.
 */
const TRACE_JUDGE_ID = 'traceability-judge';

// -- the closed vocabularies -------------------------------------------------

/*
 * The five document types the purpose classifier actually emits, derived
 * from the real corpus (86 reports under
 * CFS-DDD/product-tests/studio-experiments/out/purpose/) rather than guessed:
 * 6 prd, 6 design, 6 decomposition, 29 adr, 39 feature. The label is written
 * for the picker PLAN §5 asks for ("Document type … Change ▾"), where a
 * reader who does not already know the classifier's vocabulary still needs
 * to recognise what they are choosing.
 */
const DOC_TYPES = [
    { key: 'prd', label: 'PRD — a product requirements document' },
    { key: 'design', label: 'DESIGN — a technical design document' },
    { key: 'decomposition', label: 'DECOMPOSITION — a feature breakdown' },
    { key: 'adr', label: 'ADR — an architecture decision record' },
    { key: 'feature', label: 'Feature — a single feature specification' }
];

/*
 * The closed reason vocabulary from CONTRACT §4. Labels follow the exact
 * wording in the PLAN §6 mockup ("Not actually a duplicate", "Repeated on
 * purpose", "Won't fix here", "Wrong document type"), which is written for a
 * `duplicate` finding. A `purpose` finding reusing `not-a-duplicate` reads
 * oddly on screen ("not actually a duplicate" said of a section that was
 * never claimed to duplicate anything) — CONTRACT §4's own table header
 * acknowledges this by writing the row as "Not actually a duplicate / not
 * really DESIGN". The vocabulary is one closed enum either way (the value
 * that lands in judgments.json must be rule-independent, or a rescan that
 * changes a finding's rule would orphan the reason), so this module exports
 * one label per key and leaves the rule-specific phrasing — swapping in "not
 * really DESIGN" when `finding.rule === 'purpose'` — to the view, which is
 * where CONTRACT-quality.md's own table already does the same swap.
 */
const REASONS = [
    { key: 'not-a-duplicate', label: 'Not actually a duplicate' },
    { key: 'deliberate', label: 'Repeated on purpose' },
    { key: 'wont-fix', label: "Won't fix here" },
    { key: 'wrong-doc-type', label: 'Wrong document type' }
];

/* CONTRACT §2's trust ladder, most-trusted first — the order the trust
 * filter's "Exact only" state and any legend walk it in. */
const TRUST_ORDER = ['exact', 'strong', 'likely', 'weak'];

/*
 * Three states, not a slider (PLAN §4: "a slider over an uncalibrated score
 * is a precision instrument bolted to a guess"). `partition()` below is what
 * actually applies these; this array is only the vocabulary a header control
 * renders buttons from.
 */
const TRUST_FILTERS = [
    { key: 'all', label: 'Everything' },
    { key: 'hide-weak', label: 'Hide weak' },
    { key: 'exact', label: 'Exact only' }
];

/* CONTRACT §2's phrase table, verbatim. `weak` additionally collapses the
 * card into the footer — that placement is the view's job, not this string's. */
const TRUST_PHRASE = {
    exact: 'identical wording',
    strong: 'near-identical wording',
    likely: 'reworded — matched by a model',
    weak: 'reworded'
};

/*
 * What a drift finding's headline says, keyed by TRUST rather than by the raw
 * `verdict` string. This is a deliberate narrowing: the envelope's finding
 * schema (CONTRACT §2) has no field for "the detector's verdict word" — only
 * `rule`, `provenance`, `trust`, `confidence` and `explain` — and adding one
 * that only `drift` findings populate would be a schema exception invented by
 * this file rather than specified anywhere. CONTRACT §2's own banding table
 * already collapses `verdict` onto `trust` losslessly enough for a headline
 * (`contradiction`→strong, `drift`/`partial`→likely, `uncovered`→weak), so
 * the headline is keyed the same way the trust was computed. The one cost:
 * `drift` and `partial` — two different verdicts — share one headline word,
 * because they also share one trust band and this module has nowhere else to
 * keep them apart without adding that field.
 */
const DRIFT_HEADLINE_BY_TRUST = {
    strong: 'Contradicts the requirement',
    likely: 'Coverage has drifted',
    weak: 'Not covered'
};

/* Where a mis-classified section belongs, for the `move-section` fix payload
 * (PLAN §8 tier 2: "Move §X to DESIGN.md"). `other` has no single destination
 * — a section reading as pure narrative framing is not obviously anywhere
 * else's problem — so it is left unset rather than guessed. */
/*
 * Where a section that reads as ROLE actually belongs — as a sentence a person
 * reads, and as a FILE when there is one.
 *
 * The two are not the same thing and conflating them was a bug: this map held
 * only the prose, so `fix.suggestedFile` was "the PRD" for a requirement and
 * "an ADR" for a decision — neither of which is a filename anything can open.
 * A decision has no `file` on purpose: its home is a NEW ADR, and a tier-2 move
 * can only ever move INTO an existing document. That absence is what makes the
 * move offer itself for a design leak and fall through to an assistant for a
 * decision, which is the honest split.
 */
const ROLE_HOME = {
    requirement: { label: 'the PRD', file: 'PRD.md' },
    design: { label: 'the design document', file: 'DESIGN.md' },
    decision: { label: 'an ADR', file: undefined },
    other: { label: undefined, file: undefined }
};

/* What the detector's four roles are called in a sentence. `other` is
 * "framing" everywhere this feature speaks to a person — see the Measured
 * tab's balance legend, which uses the same word. */
const ROLE_LABEL = { requirement: 'requirements', design: 'design', decision: 'a decision', other: 'framing' };

// -- small shared helpers ---------------------------------------------------

function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

/*
 * A best-effort document-type guess from a filename alone, used ONLY when a
 * document has a `bloat` report but no `purpose` report — the two are
 * produced by independent detector runs, and CONTRACT §2's table is explicit
 * that either may be absent. Without a purpose report there is no classifier
 * output to read `doc_type` off at all, and the `docType` measure would
 * otherwise have to disappear rather than degrade — which fails PLAN §5's
 * "the document type is the highest-leverage control", since a document with
 * no visible type also has no picker to correct it from. This mirrors the
 * naming convention visible in every fixture path here
 * (`PRD.md`, `DESIGN.md`, `DECOMPOSITION.md`, `ADR/0010-*.md`,
 * `features/*.md`) rather than reimplementing the classifier's own filename
 * heuristic, which this module has no access to.
 */
function inferDocTypeFromFilename(path) {
    const base = String(path || '').toLowerCase();
    if (/(^|\/)prd\.md$/.test(base)) { return 'prd'; }
    if (/(^|\/)design\.md$/.test(base)) { return 'design'; }
    if (/(^|\/)decomposition\.md$/.test(base)) { return 'decomposition'; }
    if (/(^|\/)adr(\/|_)/.test(base) || /\badr[-_]/.test(base)) { return 'adr'; }
    if (/(^|\/)features?\//.test(base)) { return 'feature'; }
    return undefined;
}

// -- trust banding ------------------------------------------------------

/* The three confidence cuts shared by every provenance that is not lexical
 * and not a drift verdict — CONTRACT §2's "same three cuts" for `purpose`,
 * and the semantic half of `duplicate`. Never returns `exact`: the only path
 * to `exact` is byte-identical lexical text, handled separately in
 * `bandTrust` before this is ever called. */
function tierByConfidence(confidence) {
    const value = isFiniteNumber(confidence) ? confidence : 0;
    if (value >= 0.85) { return 'strong'; }
    if (value >= 0.60) { return 'likely'; }
    return 'weak';
}

/**
 * The trust table from CONTRACT §2, and nothing else — every cut in this
 * function is a decision recorded there, not derived from first principles,
 * because nothing about "how much to trust a 0.637 lexical match" is
 * derivable without a human having drawn a line somewhere first.
 *
 * @param {{rule, source, verdict, confidence}} params `source` is the
 *   finding's provenance ('lexical' | 'semantic' | 'llm'); `verdict` is only
 *   meaningful for `rule: 'drift'`.
 */
function bandTrust({ rule, source, verdict, confidence, identical } = {}) {
    if (rule === 'duplicate') {
        /*
         * TEXTUAL IDENTITY IS THE ONLY DOOR TO `exact`, and `source` is not a
         * proxy for it.
         *
         * CONTRACT §2's prose and its own table disagreed on this, and the
         * corpus settles it: the detector's "lexical" pass matches on shared
         * n-grams rather than on byte equality, so a `source: 'lexical'`
         * cluster can carry confidence 0.637 over three differently worded
         * sentences. Banding those as `exact` would print "identical wording"
         * over text that is not identical — which is the single most direct way
         * this feature could lie, and the card is where a reader would believe
         * it. So the caller measures identity and passes the answer.
         *
         * `identical` is therefore required rather than defaulted: an omitted
         * flag bands by confidence, which is the safe direction.
         */
        if (identical === true) { return 'exact'; }
        return tierByConfidence(confidence);
    }
    if (rule === 'purpose') {
        // Lexical evidence (regex over headings and content), but never
        // `exact` — a section "reading as" the wrong role is a classification,
        // not a byte match, however confident the classifier is.
        return tierByConfidence(confidence);
    }
    if (rule === 'drift') {
        if (verdict === 'contradiction') { return 'strong'; }
        if (verdict === 'drift' || verdict === 'partial') { return 'likely'; }
        // 'uncovered', or any verdict this module does not recognise, bands
        // conservatively to `weak` rather than throwing — an unrecognised
        // verdict is far more likely to be a detector update than a bug here,
        // and `weak` is always a safe (collapsible, deprioritised) landing.
        return 'weak';
    }
    return 'weak';
}

/** CONTRACT §2's card phrase, verbatim, keyed on the trust band alone. */
function trustPhrase(trust) { return TRUST_PHRASE[trust] || TRUST_PHRASE.weak; }

/*
 * What a CARD says about where a finding came from — and why this is not
 * trustPhrase().
 *
 * PLAN §3 and §4 put two different things on a card and they are on two
 * different axes. PROVENANCE is how the match was made, and it has to be
 * readable without opening anything, because 55% of the real clusters were
 * matched by a model rather than by comparison and trust in the two genuinely
 * differs. TRUST is how tight that match is, and it surfaces as exactly one
 * word — `weak` — at the bottom band, never as a decimal and never as a bar.
 *
 * Collapsing them into one string is what produced the bug this function
 * exists to prevent: a lexical cluster at confidence 0.637 bands to `likely`,
 * and `likely`'s phrase says "matched by a model" — which would credit a model
 * that was never involved. So the phrase comes from provenance, and the band
 * contributes only the qualifier.
 */
function provenancePhrase(finding) {
    const provenance = finding && finding.provenance;
    const trust = finding && finding.trust;
    if (provenance === 'llm') { return 'judged by a model'; }
    if (provenance === 'semantic') { return 'reworded — matched by a model'; }
    if (trust === 'exact') { return 'identical wording'; }
    return 'near-identical wording';
}

// -- confidence, and the spread it is read against --------------------------

/* Reads a confidence value back off a finding regardless of whether its
 * `confidence` field is still the raw number this module uses while building
 * a run (before the per-rule spread is known) or the finalised
 * `{ value, scaleMin, … }` object every finished finding carries. Accepting
 * both is what lets `confidenceStats` double as an internal step of
 * `normalizeDocument` AND as a general-purpose export a caller can run again
 * later over a RECONCILED set of findings — e.g. the explain popover's "where
 * 0.57 sits among the 91 matches in this project" (PLAN §4), which needs the
 * spread of a set this module never built. */
function readConfidenceValue(finding) {
    const raw = finding && finding.confidence;
    if (typeof raw === 'number') { return raw; }
    if (raw && isFiniteNumber(raw.value)) { return raw.value; }
    return undefined;
}

function computeScale(values) {
    if (!values.length) { return { min: 0, max: 0, discriminates: false }; }
    let min = values[0];
    let max = values[0];
    for (const value of values) {
        if (value < min) { min = value; }
        if (value > max) { max = value; }
    }
    // The 0.15 cut is CONTRACT §2's own: "On the real corpus that makes
    // clusters (0.41–1.00) discriminate and link verdicts (0.90–1.00) not."
    return { min, max, discriminates: (max - min) >= 0.15 };
}

/**
 * The confidence spread for one rule, across whatever findings are handed in.
 *
 * `scaleMin`/`scaleMax` are deliberately NOT research constants — see the
 * header. This is the one function computing them, used both while this
 * module is still assembling a run's findings (values are plain numbers at
 * that point) and by a caller re-deriving the spread later over a reconciled,
 * filtered, or merged set (values are already `{ value, … }` objects by then).
 */
function confidenceStats(findings, rule) {
    const values = (findings || [])
        .filter(finding => finding && finding.rule === rule)
        .map(readConfidenceValue)
        .filter(isFiniteNumber);
    const scale = computeScale(values);
    return { min: scale.min, max: scale.max, discriminates: scale.discriminates, values };
}

/*
 * Finalises every finding's `confidence` field in one pass, once every
 * finding of every rule for this run exists. This has to happen AFTER all
 * findings are built and BEFORE any of them are returned, because
 * `scaleMin`/`scaleMax` is a property of "every finding of this rule in this
 * run" — not of any one finding — and cannot be known while building the
 * first one.
 */
function finalizeConfidence(findings) {
    const byRule = new Map();
    for (const finding of findings) {
        if (!byRule.has(finding.rule)) { byRule.set(finding.rule, confidenceStats(findings, finding.rule)); }
        const scale = byRule.get(finding.rule);
        const value = readConfidenceValue(finding);
        finding.confidence = {
            value: isFiniteNumber(value) ? value : 0,
            scaleMin: scale.min,
            scaleMax: scale.max,
            discriminates: scale.discriminates,
            // Every threshold in every detector is an assumption today — see
            // the header. Nothing computed here could ever justify 'corpus'.
            calibration: 'none'
        };
    }
    return findings;
}

// -- occurrence, computed rather than read -----------------------------------

/*
 * CONTRACT §2: "the index of this anchor among the anchors in the same file
 * whose normalised text is identical, ordered by charStart." Computed per
 * FINDING — the anchors array here is always one cluster's or one
 * violation's own occurrences, never the whole document's — which is what
 * lets a lexical cluster's three identical occurrences land on 0, 1, 2 while
 * a semantic cluster's three DIFFERENT sentences all land on 0, exactly as
 * `reanchorThreads()` (comments' own occurrence resolver) expects to find
 * them.
 *
 * Anchors without a `charStart` (every `purpose` anchor — the report has no
 * character offsets, only line numbers) sort by 0, which is harmless: a
 * `purpose` finding has exactly one anchor, so its group has exactly one
 * member and the ordering never matters.
 */
function withOccurrence(anchors) {
    const indexed = anchors.map((anchor, index) => ({ anchor, index }));
    // Stable ordering by charStart; `index` is the tie-break so two anchors
    // that both lack an offset keep the order the detector emitted them in.
    indexed.sort((a, b) =>
        (isFiniteNumber(a.anchor.charStart) ? a.anchor.charStart : 0) -
        (isFiniteNumber(b.anchor.charStart) ? b.anchor.charStart : 0) ||
        a.index - b.index);
    const counters = new Map();
    const result = new Array(anchors.length);
    for (const { anchor, index } of indexed) {
        const key = (anchor.file || '') + '\u0000' + normalizeText(anchor.text);
        const occurrence = counters.get(key) || 0;
        counters.set(key, occurrence + 1);
        result[index] = { ...anchor, occurrence };
    }
    return result;
}

// -- fix tiers ----------------------------------------------------------

/* Tier 1 (PLAN §8) applies only when every occurrence is the SAME sentence —
 * the case the product can rewrite mechanically, because there is no judgment
 * about WHICH wording to keep when they already all agree. */
function allAnchorsTextIdentical(anchors) {
    const distinct = new Set(anchors.map(anchor => normalizeText(anchor.text)));
    return distinct.size <= 1;
}

/*
 * The canonical occurrence to keep, for a tier-1 dedupe-link fix: the one
 * that appears first in the document, by (file, line). Any of them would be
 * textually correct since they are identical by construction; "the one you
 * read first" is the only tie-break that needs no justification to a reader
 * who opens the file and sees the others turn into links pointing at it.
 */
function earliestAnchor(anchors) {
    return anchors.slice().sort((a, b) =>
        String(a.file || '').localeCompare(String(b.file || '')) ||
        (isFiniteNumber(a.line) ? a.line : 0) - (isFiniteNumber(b.line) ? b.line : 0))[0];
}

/**
 * `fix.kind`, decided in the order CONTRACT's own detector-output table
 * implies: a deterministic tier-1 rewrite beats every other tier, because it
 * needs no judgment at all; a `purpose` violation always has a structural
 * move available; a semantic duplicate always has SOMETHING for an assistant
 * to look at; anything else (a lexical duplicate whose occurrences differ —
 * matched on shared tokens rather than identical text, which the corpus does
 * contain) gets `'none'` rather than a fix this module cannot respons
 * ibly compute or hand to a model with confidence.
 */
function buildFix(rule, provenance, anchors, violation) {
    if (rule === 'duplicate' && allAnchorsTextIdentical(anchors)) {
        const keep = earliestAnchor(anchors);
        return {
            kind: 'dedupe-link',
            keep: { file: keep.file, section: keep.section, line: keep.line },
            replace: anchors
                .filter(anchor => anchor !== keep)
                .map(anchor => ({ file: anchor.file, section: anchor.section, line: anchor.line }))
        };
    }
    if (rule === 'purpose') {
        const role = violation && violation.role;
        const home = ROLE_HOME[role] || {};
        /*
         * `readsAs` / `belongsIn` / `docType` are here because the surfaces
         * already asked for them and were getting `undefined`: the section chip
         * in the prose fell back to a regex over the detector's own reason
         * string, and the tier-3 prompt read "this section reads as another
         * kind of document rather than as part of a document" — vaguer than the
         * data it was built from. The detector knows the role and the document
         * type; there is no reason for the panel not to say them.
         */
        return {
            kind: 'move-section',
            role,
            readsAs: ROLE_LABEL[role],
            belongsIn: home.label,
            suggestedFile: home.file,
            docType: (violation && violation.docType) || undefined
        };
    }
    if (rule === 'duplicate' && provenance === 'semantic') {
        // The seeded prompt itself is `ai-context.js`'s job (PLAN §8 tier 3) —
        // it already knows how to compose one from a finding's own anchors,
        // and duplicating that composition here would be a second place for
        // the prompt's shape to drift out of sync with the one that is
        // actually sent.
        return { kind: 'assistant' };
    }
    return { kind: 'none' };
}

// -- duplicate findings, from bloat/*.json and bloat-docset/*.json ----------

/* Why a cluster's occurrence anchors sometimes disagree even when
 * `source: 'lexical'`: the detector's "lexical" pass matches on shared
 * n-grams / token overlap, not on byte equality — `confidence` on a lexical
 * cluster can be well under 1.0, and its occurrences can be worded
 * differently while still counting as the same requirement said three ways.
 * Byte-identical text is simply the confidence-1.0 END of that same lexical
 * spectrum, not a separate source. This is WHY `fix.kind` checks textual
 * identity independently of `source` (above) rather than trusting `source`
 * to imply it, and it is worth a reader knowing that CONTRACT §2's prose
 * ("exact is reserved for byte-identical text") and CONTRACT §2's own
 * trust TABLE ("duplicate, source: lexical → exact", unconditionally) do not
 * actually agree on this point — the table wins here, because it is the more
 * specific, more operational of the two, but see this file's own report for
 * the disagreement flagged rather than silently resolved. */
function duplicateReason(cluster, anchorCount, distinctFiles) {
    if (cluster.source === 'lexical') {
        const where = distinctFiles > 1 ? ('across ' + distinctFiles + ' files') : 'in this document';
        return 'This wording repeats ' + anchorCount + ' time' + (anchorCount === 1 ? '' : 's') + ' ' + where + '.';
    }
    const percent = Math.round((isFiniteNumber(cluster.confidence) ? cluster.confidence : 0) * 100);
    return 'Matched as a reworded repeat across ' + anchorCount + ' places by the semantic model (confidence ' + percent + '%).';
}

/**
 * One `bloat` cluster → one `duplicate` finding with N anchors, never N
 * findings — CONTRACT §2's own table, stated first because it is the rule
 * that is easiest to get wrong under the pull of "just emit one row per
 * occurrence".
 */
function buildDuplicateFinding(cluster) {
    const rawAnchors = (cluster.occurrences || []).map(occurrence => ({
        file: occurrence.file,
        section: occurrence.section,
        granularity: 'span',
        line: occurrence.line,
        lineEnd: occurrence.line_end,
        charStart: occurrence.char_start,
        charEnd: occurrence.char_end,
        text: occurrence.text
    }));
    const anchors = withOccurrence(rawAnchors);
    const distinctFiles = new Set(anchors.map(anchor => anchor.file)).size;

    // "The longest occurrence text — it is the most informative one to show"
    // (this module's own brief, restating PLAN's "quote the sentence that
    // says the most"). Ties keep the first anchor in detector order, which is
    // an arbitrary but stable choice.
    const quote = anchors.reduce((best, anchor) =>
        (!best || (anchor.text || '').length > (best.text || '').length) ? anchor : best, undefined);

    const finding = {
        rule: 'duplicate',
        ruleVersion: RULE_VERSION,
        provenance: cluster.source === 'semantic' ? 'semantic' : 'lexical',
        // A number for now — `finalizeConfidence` turns every finding's
        // `confidence` into the full `{ value, scaleMin, … }` object once
        // every finding in this run exists (see its own header comment).
        confidence: isFiniteNumber(cluster.confidence) ? cluster.confidence : 1,
        quote: quote ? quote.text : '',
        reach: distinctFiles,
        anchors,
        explain: {
            reason: duplicateReason(cluster, anchors.length, distinctFiles),
            // The trimmed fixtures dropped per-occurrence token arrays
            // (CONTRACT §6) — an absent `tokens` field is a real state, not a
            // bug, and becomes an empty evidence list rather than `undefined`,
            // since the view can render "no shared tokens recorded" but not
            // "explain.evidence is not an array".
            evidence: Array.isArray(cluster.tokens) ? cluster.tokens : []
        },
        sourceHashes: {}
    };
    const identical = allAnchorsTextIdentical(anchors);
    finding.trust = bandTrust({
        rule: 'duplicate', source: finding.provenance,
        confidence: cluster.confidence, identical
    });
    finding.fix = buildFix('duplicate', finding.provenance, anchors);
    finding.fingerprint = fingerprint(finding);
    return finding;
}

// -- purpose findings, from purpose/*.json -----------------------------------

/**
 * One `gate.violations[]` entry → one `purpose` finding with ONE anchor —
 * unlike a duplicate cluster, a violation has no other occurrences to fold
 * in; it is a single section that reads as the wrong role.
 */
/*
 * `docPath` IS REQUIRED, and passing it late was a real bug rather than a
 * tidiness question.
 *
 * The anchor's file used to be stamped in by the caller AFTER this function had
 * already computed the fingerprint, so every purpose finding was fingerprinted
 * with `file: undefined`. Two ADRs whose "More Information" section both read as
 * DESIGN then shared one fingerprint — measured on the real corpus, three
 * collisions across 86 documents — and a fingerprint collision is not a display
 * bug: judgments.json is keyed by it, so dismissing one document's violation
 * silently dismissed the other document's too, in a file that gets committed.
 *
 * The file is therefore part of the anchor before anything hashes it.
 */
function buildPurposeFinding(violation, docPath, docType) {
    const anchors = withOccurrence([{
        file: docPath,
        section: violation.section,
        granularity: 'section',
        line: violation.line_start,
        lineEnd: violation.line_end,
        charStart: undefined,          // the report carries no character offsets for a section
        charEnd: undefined,
        // There is no section BODY in the report, only its name — CONTRACT
        // §2 is explicit that `anchor.text` is the section name here, and the
        // card's quote is the same string for the same reason.
        text: violation.section
    }]);
    const finding = {
        rule: 'purpose',
        ruleVersion: RULE_VERSION,
        provenance: 'lexical',
        confidence: isFiniteNumber(violation.confidence) ? violation.confidence : 1,
        quote: violation.section,
        reach: 1,
        anchors,
        explain: {
            reason: violation.reason,
            evidence: Array.isArray(violation.evidence) ? violation.evidence : []
        },
        sourceHashes: {}
    };
    finding.trust = bandTrust({ rule: 'purpose', source: 'lexical', confidence: violation.confidence });
    finding.fix = buildFix('purpose', 'lexical', anchors, { ...violation, docType });
    finding.fingerprint = fingerprint(finding);
    return finding;
}

// -- drift findings, from trace-*.json ---------------------------------------

/**
 * One `verdicts[]` entry that is not `covered` → one `drift` finding.
 * `covered` verdicts never reach here: the trimmed fixtures already dropped
 * them (CONTRACT §6 — "trimming dropped only fields the envelope never
 * reads … covered verdicts"), and the filter below is defensive rather than
 * load-bearing, in case a future, untrimmed report is dropped in directly.
 *
 * Anchoring a drift finding is the one place this module cannot do what
 * `withOccurrence` does for the other two rules: the traceability report
 * carries no character offsets AND no line numbers at all, only a section
 * PATH (`ref_section`) inside a named file (`ref_doc`). `line`/`lineEnd` are
 * therefore left undefined here — an honest "the detector did not say",
 * matching how `sourceHashes` is left `{}` when the caller has nothing to put
 * there, rather than a fabricated guess.
 */
function buildDriftFinding(verdict) {
    const anchors = withOccurrence([{
        file: verdict.ref_doc,
        section: verdict.ref_section,
        granularity: 'section',
        line: undefined,
        lineEnd: undefined,
        charStart: undefined,
        charEnd: undefined,
        text: verdict.ref_section
    }]);
    const finding = {
        rule: 'drift',
        ruleVersion: RULE_VERSION,
        provenance: 'llm',
        confidence: isFiniteNumber(verdict.confidence) ? verdict.confidence : 1,
        // `drifted_obligation` is the LLM's own account of what is missing or
        // wrong — the closest thing a coverage gap has to "the text the card
        // shows", since there is no repeated sentence to quote.
        quote: verdict.drifted_obligation || verdict.ref_section,
        reach: 1,
        anchors,
        explain: {
            reason: verdict.drifted_obligation,
            evidence: (verdict.design_evidence && verdict.design_evidence !== 'none') ? [verdict.design_evidence] : []
        },
        // No fix tier in PLAN §8 covers a coverage gap — judging one requires
        // reading the definition and deciding what "covering" it would even
        // mean, which is squarely tier-3 territory, but PLAN scopes tier 3 to
        // duplicate findings explicitly and traceability fixes are listed
        // nowhere in that table. `'none'` is the honest reading until that
        // table grows a row.
        fix: { kind: 'none' },
        sourceHashes: {}
    };
    finding.trust = bandTrust({ rule: 'drift', source: 'llm', verdict: verdict.verdict, confidence: verdict.confidence });
    finding.fingerprint = fingerprint(finding);
    return finding;
}

// -- measures -----------------------------------------------------------

/*
 * `labelRefs` for the balance distribution: for each role, the section PATHS
 * (not the sections themselves — a path is enough to jump to one, and is all
 * the distribution's click-through in PLAN §5 needs) that `purpose.sections`
 * assigned that role. This is deliberately the ONLY place the 2,252 section
 * labels in the real corpus are read at all (PLAN §1's "never as a feed").
 */
function labelRefsByRole(sections) {
    const byRole = { requirement: [], design: [], decision: [], other: [] };
    for (const section of sections || []) {
        const role = section && section.role;
        if (byRole[role]) { byRole[role].push(section.path); }
    }
    return byRole;
}

/**
 * Rank a document's own value against an array of its project's OTHER
 * documents' values (`projectMetrics`, per this module's own exported
 * signature). `{ rank, of }` rather than a pre-formatted string: "highest of
 * 7" (PLAN §5) is one legitimate rendering of `{ rank: 1, of: 7 }`, but so is
 * "3rd of 7", and formatting belongs to the view that also knows what
 * language the reader is in.
 */
function rankAmong(ownValue, otherValues) {
    if (!isFiniteNumber(ownValue) || !Array.isArray(otherValues)) { return undefined; }
    const all = otherValues.filter(isFiniteNumber).concat([ownValue]);
    if (all.length < 2) { return undefined; } // "highest of 1" tells a reader nothing
    const sorted = all.slice().sort((a, b) => b - a);
    return { rank: sorted.indexOf(ownValue) + 1, of: all.length };
}

/**
 * PLAN §5's five measures, and no others — `n_sections` / `n_tokens` /
 * `n_paragraphs` are deliberately excluded here; they live on
 * `envelope.document` instead (PLAN §1: "a denominator inside a sentence,
 * never a tile"), which is why this function takes the SAME `bloat`/`purpose`
 * reports as the finding builders but returns a much smaller set of numbers.
 */
function buildDocumentMeasures({ bloat, purpose, overrides, projectMetrics, docType }) {
    const measures = [];

    measures.push({
        name: 'docType',
        label: 'Document type',
        valueType: 'category',
        value: docType,
        origin: (overrides && overrides.docType)
            ? 'corrected by a person, overriding the inferred value'
            : 'inferred from the filename'
    });

    if (purpose && purpose.mixture) {
        measures.push({
            name: 'balance',
            label: 'Balance — what this document is made of',
            valueType: 'distribution',
            value: {
                requirement: purpose.mixture.requirement || 0,
                design: purpose.mixture.design || 0,
                decision: purpose.mixture.decision || 0,
                other: purpose.mixture.other || 0
            },
            labelRefs: labelRefsByRole(purpose.sections)
        });
    }

    if (purpose && purpose.gate) {
        measures.push({
            name: 'leakShare',
            label: 'Purpose leak',
            valueType: 'quantity',
            value: purpose.gate.leak_share,
            threshold: purpose.gate.threshold,
            breached: !purpose.gate.passed
            // No rankInProject here: PLAN §1 records leak share's median as
            // EXACTLY ZERO across the corpus, and ranking a quantity that is
            // zero on 77 of 86 documents manufactures a "highest of 7" that
            // means nothing — the same reasoning that keeps leak share off
            // the findings list unless its gate actually breaches.
        });
    }

    if (bloat && bloat.metrics) {
        const dupRate = bloat.metrics.dup_rate;
        /*
         * THE DOCUMENT'S OWN ENTRY COMES OUT FIRST. `projectMetrics` is every
         * document in the project — the caller has no reason to exclude one —
         * and rankAmong appends `ownValue` itself, so leaving it in counted
         * this document twice and produced "of 87 documents" in a project of
         * 86. Matched on the path the report declares about itself, which is
         * the same key `projectMetrics` is built from.
         */
        const own = (bloat.paths && bloat.paths[0]) || undefined;
        const others = (projectMetrics || [])
            .filter(entry => entry && (own === undefined || entry.path !== own))
            .map(entry => entry.dupRate);
        measures.push({
            name: 'duplication',
            label: 'Duplication',
            valueType: 'quantity',
            value: dupRate,
            // No threshold: CONTRACT's own worked example says so outright.
            note: 'no threshold exists for this yet — dup_rate is non-zero on almost every document in the corpus, so a fixed cut would flag nearly everything or nothing',
            rankInProject: rankAmong(dupRate, others)
        });
        measures.push({
            name: 'clusters',
            label: 'Duplicate clusters',
            valueType: 'quantity',
            value: bloat.metrics.n_clusters
        });
    }

    // Filled in by the caller who actually has stored runs to merge — see the
    // exported measure's own comment in CONTRACT §2 ("series … merged in").
    for (const measure of measures) { measure.series = []; }
    return measures;
}

// -- normalizeDocument --------------------------------------------------

/**
 * One document's envelope, from its `bloat` report, its `purpose` report, and
 * optionally a `trace` report scoped to it — any of the three may be absent
 * (CONTRACT §2), and this function degrades rather than throwing when they
 * are: a document with no report at all still gets a real, honest envelope
 * (empty findings, both axes in `notRun`) rather than the caller having to
 * special-case "nothing came back".
 *
 * `trace` at document scope is not the shape most of this corpus produces —
 * `trace-overwork_alert.json`'s own verdicts span many `ref_doc` files, which
 * reads as a whole project's traceability run rather than one document's
 * (see `normalizeDocset`, which is where it is actually exercised in this
 * module's own proof script). It is accepted here too, because the exported
 * signature promises it and because a smaller, single-document trace report
 * is a reasonable shape for the runner to produce later (PLAN §13's on-save
 * pass is scoped to one document); every verdict handed in is trusted to
 * already belong to this document, since nothing here has enough information
 * to double check against `docPath`.
 */
function normalizeDocument({ bloat, purpose, trace, docPath, root, runId, producedAt, overrides, projectMetrics } = {}) {
    const findings = [];

    if (bloat && Array.isArray(bloat.clusters)) {
        for (const cluster of bloat.clusters) {
            const finding = buildDuplicateFinding(cluster);
            // The report's own paths are already correct; nothing to stamp.
            findings.push(finding);
        }
    }

    if (purpose && purpose.gate && Array.isArray(purpose.gate.violations)) {
        for (const violation of purpose.gate.violations) {
            /* The document's own path goes IN, not on afterwards: the
             * fingerprint is computed inside, and a fingerprint that does not
             * know which file it is about collides across documents. */
            const finding = buildPurposeFinding(violation, docPath, purpose.doc_type);
            finding.sourceHashes = {};
            findings.push(finding);
        }
    }

    if (trace && Array.isArray(trace.verdicts)) {
        for (const verdict of trace.verdicts) {
            if (verdict.verdict === 'covered') { continue; } // defensive — see buildDriftFinding's header
            findings.push(buildDriftFinding(verdict));
        }
    }

    finalizeConfidence(findings);

    const docType = (overrides && overrides.docType) || (purpose && purpose.doc_type) || inferDocTypeFromFilename(docPath);

    const analyzers = [];
    if (bloat) { analyzers.push({ ...BLOAT_DETECTOR }); }
    if (purpose) { analyzers.push({ ...PURPOSE_CLASSIFIER }); }
    if (trace) {
        analyzers.push({ id: TRACE_JUDGE_ID, version: undefined, model: trace.model, calibration: 'none', benchmark: undefined });
    }

    const gates = [];
    if (purpose && purpose.gate) {
        gates.push({
            name: 'purpose',
            status: purpose.gate.passed ? 'pass' : 'fail',
            observed: purpose.gate.leak_share,
            threshold: purpose.gate.threshold
        });
    }
    const notRun = [
        { axis: 'Completeness', why: 'no detector exists for this yet' },
        { axis: 'Clarity', why: 'no detector exists for this yet' }
    ];
    if (trace) {
        gates.push({ name: 'traceability', status: trace.passed ? 'pass' : 'fail', observed: trace.counts, threshold: undefined });
    } else {
        gates.push({ name: 'traceability', status: 'skipped', reason: 'the LLM pass did not run' });
        notRun.push({ axis: 'Traceability', why: 'the LLM pass did not run' });
    }

    return {
        runId,
        producedAt,
        analyzers,
        scope: { kind: 'document', root, paths: [docPath] },
        document: {
            path: docPath,
            docType,
            sections: purpose ? purpose.n_sections : undefined,
            tokens: purpose ? purpose.n_tokens : undefined,
            paragraphs: bloat && bloat.metrics ? bloat.metrics.n_paragraphs : undefined
        },
        findings,
        measures: buildDocumentMeasures({ bloat, purpose, overrides, projectMetrics, docType }),
        gates,
        notRun,
        overrides: { docType: overrides && overrides.docType }
    };
}

// -- normalizeDocset ----------------------------------------------------

/**
 * The project-tab envelope, from one `bloat-docset` report and optionally a
 * project-wide `trace` report. CONTRACT §2's table is explicit about the one
 * filter that matters here: a docset cluster is only worth a SECOND finding
 * when it says something a single document's own report could not already
 * say — which is exactly the clusters whose occurrences land in more than one
 * file. A single-file cluster inside a docset report is the same repetition
 * the document-scope `bloat` report for that file already turned into a
 * finding; keeping it here too would put the same card in front of a reader
 * twice under two different scopes.
 *
 * `pairs`: CONTRACT-quality.md never pins this parameter's shape, and PLAN
 * §9's mockup implies a number worth stating ("2,198 link pairs, judging them
 * costs ~3.2 h") when traceability has not been run for this docset at all.
 * This function's reading — an optional total pair count folded into the
 * `notRun`/`traceability`-gate reason string — is this module's own choice,
 * flagged here and in this module's proof report rather than resolved
 * silently, because nothing in either spec file confirms it.
 */
function normalizeDocset({ docset, trace, pairs, docsetName, root, runId, producedAt, documents: known } = {}) {
    const findings = [];
    const clusters = (docset && Array.isArray(docset.clusters)) ? docset.clusters : [];

    for (const cluster of clusters) {
        const distinctFiles = new Set((cluster.occurrences || []).map(occurrence => occurrence.file)).size;
        if (distinctFiles <= 1) { continue; } // already surfaced at document scope — see header
        findings.push(buildDuplicateFinding(cluster));
    }

    if (trace && Array.isArray(trace.verdicts)) {
        for (const verdict of trace.verdicts) {
            if (verdict.verdict === 'covered') { continue; }
            findings.push(buildDriftFinding(verdict));
        }
    }

    finalizeConfidence(findings);

    // Per-document rollups for the project tab (PLAN §9): which documents
    // have something to act on, how much, and which other documents they
    // share a finding with. `gateFailed` is left `undefined` rather than
    // `false` for every document — a docset report has no purpose data at
    // all, so "this document's gate did not fail" would be a fabrication
    // indistinguishable from "this module was never told". The caller that
    // assembles the actual project tab already has each document's own
    // `normalizeDocument()` envelope and its `gates` array; merging that
    // `status` in is a composition step downstream of this function, not
    // inside it — CONTRACT §11 draws this exact line ("the artifact is the
    // contract"; assembling several documents' artifacts into one screen is
    // wiring, not normalisation).
    /*
     * THE PROJECT KNOWS MORE DOCUMENTS THAN THE REPORT DOES, and the clean
     * count is the reason this matters.
     *
     * PLAN §9 renders "4 documents clean" — counted, not listed, because with a
     * median of two findings a table of every document is mostly rows saying
     * nothing. But a document the detector never mentioned cannot be counted
     * from the report alone: it is absent from `docset.paths` precisely because
     * there was nothing to say about it. So the caller may pass the documents it
     * knows about, and they are unioned in. Omitting `documents` falls back to
     * the report's own paths, which is correct for a caller that has no project
     * to enumerate.
     */
    const reported = (docset && Array.isArray(docset.paths)) ? docset.paths.slice() : [];
    const supplied = (known || []).map(entry => (typeof entry === 'string' ? entry : entry && entry.path))
        .filter(Boolean);
    const paths = [...new Set([...reported, ...supplied])];
    const documents = paths.map(path => {
        const own = findings.filter(finding => finding.anchors.some(anchor => anchor.file === path));
        const sharedWith = new Set();
        for (const finding of own) {
            for (const anchor of finding.anchors) {
                if (anchor.file !== path) { sharedWith.add(anchor.file); }
            }
        }
        return { path, findings: own.length, gateFailed: undefined, sharedWith: [...sharedWith] };
    });

    const analyzers = [];
    if (docset) { analyzers.push({ ...BLOAT_DETECTOR }); }
    if (trace) { analyzers.push({ id: TRACE_JUDGE_ID, version: undefined, model: trace.model, calibration: 'none', benchmark: undefined }); }

    const gates = [];
    const notRun = [
        { axis: 'Completeness', why: 'no detector exists for this yet' },
        { axis: 'Clarity', why: 'no detector exists for this yet' }
    ];
    if (trace) {
        gates.push({ name: 'traceability', status: trace.passed ? 'pass' : 'fail', observed: trace.counts, threshold: undefined });
    } else {
        const reason = isFiniteNumber(pairs)
            ? pairs + ' link pairs not yet judged — the LLM pass did not run'
            : 'the LLM pass did not run';
        gates.push({ name: 'traceability', status: 'skipped', reason });
        notRun.push({ axis: 'Traceability', why: reason });
    }

    return {
        runId,
        producedAt,
        analyzers,
        scope: { kind: 'docset', root, paths },
        // No single `document` denominator makes sense at docset scope — see
        // `documents` above, which is this scope's equivalent.
        documents,
        findings,
        // The project tab (PLAN §9) is its own bespoke layout — shared
        // duplicates, a document rollup, a clean count, one "not evaluated"
        // line — not the per-document Measured tab's four value shapes.
        // Nothing here calls for a docset-level `measures` entry today.
        measures: [],
        gates,
        notRun,
        overrides: {}
    };
}

// -- ordering -----------------------------------------------------------

/* `Infinity` for a missing line/offset sorts that anchor LAST rather than
 * first — a finding this module could not place (a drift finding, which
 * carries no line number at all) should not float to the top of "document
 * order" ahead of everything the report actually located. */
function minAnchorLine(finding) {
    return (finding.anchors || []).reduce((min, anchor) =>
        Math.min(min, isFiniteNumber(anchor.line) ? anchor.line : Infinity), Infinity);
}
function minAnchorCharStart(finding) {
    return (finding.anchors || []).reduce((min, anchor) =>
        Math.min(min, isFiniteNumber(anchor.charStart) ? anchor.charStart : Infinity), Infinity);
}

/*
 * Document order: smallest line, then smallest charStart, then fingerprint —
 * the fingerprint tie-break is what makes this a TOTAL order (PLAN §3: "and
 * there is one alternative"). Two findings that both start at the same line
 * and the same offset (a purpose violation and, in principle, a duplicate
 * span beginning at the same section) would otherwise sort however the array
 * happened to arrive, which is not stable across two runs whose detectors
 * finished their work in a different order.
 */
function documentOrderCompare(a, b) {
    return minAnchorLine(a) - minAnchorLine(b) ||
        minAnchorCharStart(a) - minAnchorCharStart(b) ||
        String(a.fingerprint || '').localeCompare(String(b.fingerprint || ''));
}

/**
 * PLAN §3/§14: exactly two orders exist, because exactly two things about a
 * finding are MEASURED rather than invented — where it sits in the document,
 * and how many places it reaches. No severity ordering: nothing in either
 * detector's output ranks a finding by importance, and manufacturing one here
 * would be, in PLAN §14's own words, "a fabrication rendered as a fact".
 */
function orderFindings(findings, mode) {
    const list = (findings || []).slice();
    if (mode === 'reach') {
        return list.sort((a, b) => (b.reach || 0) - (a.reach || 0) || documentOrderCompare(a, b));
    }
    return list.sort(documentOrderCompare);
}

// -- partition ------------------------------------------------------------

/*
 * How a trust filter interacts with the weak-collapse rule that applies
 * regardless of it — CONTRACT §2 and PLAN §3/§4 each specify one half of this
 * clearly and never state the other half's interaction explicitly, so this
 * comment records the reading `partition()` implements rather than leaving it
 * to be reverse-engineered from the code:
 *
 *   'all'        — the default. Every non-weak trust band is shown; weak
 *                  findings are collapsed into the counted footer (PLAN §3:
 *                  "collapsed, not interleaved"), and `showWeak: true` is
 *                  what a click on that footer's "show" link means — it
 *                  moves them into `shown` without changing the filter.
 *   'hide-weak'  — weak findings are dropped entirely, footer included: the
 *                  control's own label is "Hide weak", not "collapse weak",
 *                  and a footer offering to reveal something the reader just
 *                  asked to hide would contradict the click that produced it.
 *   'exact'      — only byte-identical findings are shown; `strong` and
 *                  `likely` findings are ALSO dropped here, for the same
 *                  reason as above ("Exact only" is not "exact, plus a
 *                  footer for the rest").
 *
 * `later` and `dismissed` are unconditional buckets — PLAN §6 describes both
 * as always-present, always-counted footer rows regardless of the trust
 * filter, which is a different axis entirely (a person's own triage decision,
 * not the detector's confidence).
 */
function passesTrustFilter(trust, trustFilter) {
    if (trustFilter === 'exact') { return trust === 'exact'; }
    if (trustFilter === 'hide-weak') { return trust !== 'weak'; }
    return true; // 'all', or an unrecognised value — never filter more than asked
}

/**
 * Splits a run's findings into the buckets the rail and the tab badge need.
 *
 * `status` is filled in by `reconcile()` in `quality-identity.js`, never by a
 * normaliser (CONTRACT §2) — this function reads it but never sets it, and a
 * finding with no `status` at all (the very first run, before reconciliation
 * has ever touched it) is treated as `'open'`, which is the correct reading
 * for "nobody has judged this yet".
 */
function partition(findings, { trustFilter = 'all', showWeak = false, showDismissed = false } = {}) {
    const all = findings || [];
    const dismissed = all.filter(finding => finding.status === 'dismissed');
    const later = all.filter(finding => finding.status === 'later');
    /*
     * `later` IS STILL OPEN, and that is the difference between the two verbs.
     *
     * PLAN §6: "Later parks a finding and keeps it in the count; Not an issue is
     * the real decision." So a parked finding keeps its place in document order,
     * keeps its decorations in the text, and keeps counting on the tab badge —
     * only its action row changes, which is the view's business. An earlier
     * reading of this excluded `later` from every bucket, which made parking a
     * finding indistinguishable from dismissing it everywhere except the
     * sidecar: the card vanished, the badge dropped, and the only way to find it
     * again was to open the Dismissed row, where it was not.
     *
     * A parked finding that is also weak collapses into the weak group like any
     * other weak finding. Trust and triage are two axes and neither overrides
     * the other.
     */
    const open = all.filter(finding => finding.status !== 'dismissed');

    const weakOpen = open.filter(finding => finding.trust === 'weak');
    const nonWeakOpen = open.filter(finding => finding.trust !== 'weak');

    const shown = nonWeakOpen.filter(finding => passesTrustFilter(finding.trust, trustFilter));
    // Weak findings only ever reach `shown` through an explicit `showWeak`
    // click, and only when the trust filter has not already ruled them out
    // entirely (see the header comment above).
    const weakEligible = trustFilter === 'all';
    if (weakEligible && showWeak) { shown.push(...weakOpen); }
    const weak = (weakEligible && !showWeak) ? weakOpen : [];

    // `showDismissed` does not change which findings are dismissed — that is
    // a `status`, not a view state — so it is accepted for signature
    // compatibility with the caller's "has the footer been opened" toggle,
    // but this function always returns the full dismissed list either way:
    // the footer's own count ("4 dismissed — show") needs the number
    // regardless of whether the row is currently expanded, and a pure
    // function has no reason to withhold data the caller already has a
    // `status` field to filter itself if it truly wants to.
    void showDismissed;

    return {
        shown,
        weak,
        dismissed,
        later,
        counts: {
            shown: shown.length,
            weak: weakOpen.length,
            dismissed: dismissed.length,
            later: later.length,
            open: open.length,
            total: all.length
        }
    };
}

// -- card text ------------------------------------------------------------

/**
 * The short line a card's title row shows (PLAN §3's mockup rows: "Repeated
 * · identical wording", "Reads as DESIGN · MCP Protocol Endpoint"). The `why?`
 * affordance next to it is interactive chrome, not text this function
 * produces.
 */
function findingHeadline(finding) {
    if (!finding) { return ''; }
    if (finding.rule === 'duplicate') {
        return 'Repeated · ' + trustPhrase(finding.trust);
    }
    if (finding.rule === 'purpose') {
        const role = finding.fix && finding.fix.role;
        const roleWord = role ? role.toUpperCase() : 'a different section type';
        return 'Reads as ' + roleWord + ' · ' + (finding.quote || '');
    }
    if (finding.rule === 'drift') {
        const headline = DRIFT_HEADLINE_BY_TRUST[finding.trust] || 'Coverage gap';
        return headline + ' · ' + trustPhrase(finding.trust);
    }
    return trustPhrase(finding.trust);
}

/**
 * The analyzer build line — PLAN §4's "who produced it, and whether its
 * thresholds were ever calibrated" and PLAN §5's Measured-tab footer. One
 * analyzer per detector actually consulted, `model` folded in immediately
 * after its owner (`bge-m3 reranker` beside `bloat-detector 0.4.1`, matching
 * the explain-popover mockup in PLAN §4), and one closing clause about
 * calibration — `'none'` on everything today, which is worth a reader seeing
 * plainly rather than inferring from the absence of a benchmark link.
 */
function honestyLine(analyzers) {
    const list = (analyzers || []).filter(Boolean);
    const parts = [];
    for (const analyzer of list) {
        parts.push(analyzer.id + ' ' + (analyzer.version || 'unversioned'));
        if (analyzer.model) { parts.push(analyzer.model); }
    }
    const calibrations = list.map(analyzer => analyzer.calibration || 'none');
    if (calibrations.length && calibrations.every(value => value === 'none')) {
        parts.push('every threshold uncalibrated');
    } else if (calibrations.some(value => value === 'none')) {
        parts.push('some thresholds uncalibrated');
    }
    return parts.join(' · ');
}

module.exports = {
    normalizeDocument,
    normalizeDocset,
    orderFindings,
    partition,
    bandTrust,
    trustPhrase,
    provenancePhrase,
    honestyLine,
    findingHeadline,
    confidenceStats,
    TRUST_ORDER,
    TRUST_FILTERS,
    DOC_TYPES,
    REASONS
};
