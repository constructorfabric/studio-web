/*
 * What a quality finding IS, across runs.
 *
 * Every finding is re-derived by every check; every triage decision must
 * survive one. The line between them is a single sentence — the sidecar stores
 * judgments, the run stores observations, and a fingerprint is the only thing
 * joining the two. So this file is small, has no dependencies, and is specified
 * to the byte in CONTRACT-quality.md §3 rather than left to read as obvious.
 *
 * WHY IT IS ITS OWN FILE, separate from quality-scan.js. Two reasons, and the
 * second is the real one:
 *
 *   - Nothing in the normalisers calls anything here except fingerprint(), and
 *     nothing here calls the normalisers at all. The two halves of the pure
 *     layer genuinely do not touch.
 *   - Two implementations of a fingerprint drifting apart is a silent, total
 *     loss of every triage decision in a project, and it surfaces weeks later
 *     as "why is this dismissed finding back". A file whose entire job is
 *     identity is a file nobody edits casually.
 *
 * WHY SHA-256 IS WRITTEN OUT HERE. The browser tree has no dependencies of its
 * own and is not built, so there is nothing to import. `crypto.subtle` exists
 * but is asynchronous, which would make every fingerprint a promise and every
 * caller — including the ordering comparator — async for no gain. Sixty lines
 * of a published algorithm is cheaper than that, and it is byte-identical in
 * node and in Electron, which is what lets the test suite check real
 * fingerprints instead of checking that two calls agree with each other.
 */

/* Neither can survive normalizeText, which is the entire reason they were
 * chosen: a separator that could appear inside a key would let two different
 * findings serialise to the same payload. */
const UNIT = '\u001f';
const RECORD = '\u001e';

/*
 * The one text normalisation, used for anchor text and for section paths.
 *
 * PUNCTUATION IS STRIPPED, AND THAT IS A DECISION. "MUST allow" and "MUST
 * allow," are one finding. Keeping punctuation would detach a stored judgment
 * the moment somebody fixes a comma inside the sentence a finding points at,
 * which is the single most common edit a reviewer makes to flagged text — and
 * the failure is invisible: the old judgment stays in the file, keyed to a
 * fingerprint nothing produces any more, and the finding comes back as new.
 *
 * The cost is that two sentences differing only in punctuation collide. In
 * prose that does not happen, and the supersede rule in reconcile() is the
 * backstop for the cases where normalisation is not enough anyway.
 *
 * \p{L}\p{N} rather than [a-z0-9]: these documents contain em dashes, smart
 * quotes and the occasional non-ASCII identifier, and folding a Cyrillic word
 * to nothing would make two unrelated headings identical.
 */
function normalizeText(value) {
    if (typeof value !== 'string' || !value) { return ''; }
    return value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/*
 * The sorted, normalised text of every anchor.
 *
 * SORTED, so the order the detector happened to emit occurrences in cannot
 * change identity. The bloat detector's cluster order is the order its pair
 * search found them, which is a function of the model's ranking and is not
 * stable between builds — an unsorted key would rotate every fingerprint in a
 * project on a detector upgrade.
 */
function anchorKey(anchors) {
    return (anchors || [])
        .map(anchor => normalizeText(anchor && anchor.text))
        .filter(text => text.length > 0)
        .sort()
        .join(UNIT);
}

/*
 * Where the finding lives, independent of its wording.
 *
 * This is what makes the supersede case in reconcile() decidable: an edit
 * changes anchorKey and leaves structuralKey alone, so "the same place, new
 * words" is a comparison rather than a guess.
 */
function structuralKey(anchors) {
    return (anchors || [])
        .map(anchor => (anchor && anchor.file ? anchor.file : '') + '#' + normalizeText(anchor && anchor.section))
        .sort()
        .join(UNIT);
}

/*
 * 'q1-' is a version prefix, not decoration. Changing anything above means
 * 'q2-', and every stored judgment then reads as belonging to a finding that no
 * longer exists — which is recoverable and inspectable — rather than as a
 * corrupt key silently matching the wrong finding.
 *
 * 16 hex characters, 64 bits. A project has hundreds of findings, not billions;
 * the full digest would make judgments.json unreadable as a diff, and being
 * readable as a diff is why it is committed with the branch at all.
 */
function fingerprint(finding) {
    const rule = (finding && finding.rule) || 'unknown';
    const ruleVersion = String((finding && finding.ruleVersion) || '1');
    const payload = [rule, ruleVersion, anchorKey(finding && finding.anchors),
        structuralKey(finding && finding.anchors)].join(RECORD);
    return 'q1-' + sha256hex(payload).slice(0, 16);
}

/*
 * Reconcile a fresh run against the previous one and the stored judgments.
 *
 * The four cases are the information model's, and each one exists because
 * without it something specific goes wrong on screen:
 *
 *   unchanged    the fingerprint is in both runs. Carry the judgment. Without
 *                this the feature has no memory at all.
 *   resolved     in the previous run, gone from this one. Reported as a count,
 *                because "3 findings resolved since the last check" is the only
 *                positive feedback this feature can give.
 *   appeared     new fingerprint. Marked, so a rescan does not silently grow.
 *   superseded   appeared, but overlaps something that just resolved. Carries
 *                the judgment over and says so. WITHOUT THIS RULE, fixing a
 *                typo inside a dismissed duplicate resurrects it as a brand-new
 *                finding, which is the behaviour that makes people stop
 *                dismissing things.
 *
 * `previous` may be empty — the first run of a project is the appeared case for
 * everything, and that is correct rather than a special case.
 */
function reconcile({ previous = [], next = [], judgments = {} } = {}) {
    const previousByPrint = new Map(previous.map(finding => [finding.fingerprint, finding]));
    const nextPrints = new Set(next.map(finding => finding.fingerprint));

    const resolved = previous.filter(finding => !nextPrints.has(finding.fingerprint));

    /*
     * The supersede index, built from what just resolved rather than from the
     * whole history. A finding that resolved six runs ago is gone; only the
     * immediately preceding run can explain a finding that appeared now, and
     * indexing further back would make an unrelated edit in an unrelated
     * paragraph carry somebody's dismissal onto it.
     */
    const resolvedByStructure = new Map();
    for (const finding of resolved) {
        const key = finding.rule + RECORD + structuralKey(finding.anchors);
        if (!resolvedByStructure.has(key)) { resolvedByStructure.set(key, []); }
        resolvedByStructure.get(key).push(finding);
    }

    const appeared = [];
    const superseded = [];

    const findings = next.map(finding => {
        const carried = previousByPrint.get(finding.fingerprint);
        const stored = judgments[finding.fingerprint];

        if (carried) {
            return {
                ...finding,
                status: (stored && stored.status) || carried.status || 'open',
                judgment: stored || carried.judgment,
                isNew: false
            };
        }

        /*
         * A fresh fingerprint. Before calling it new, ask whether something
         * that just resolved was the same finding in different words.
         */
        const key = finding.rule + RECORD + structuralKey(finding.anchors);
        const candidates = resolvedByStructure.get(key) || [];
        const texts = new Set(anchorKey(finding.anchors).split(UNIT).filter(Boolean));
        const ancestor = candidates.find(candidate =>
            anchorKey(candidate.anchors).split(UNIT).filter(Boolean).some(text => texts.has(text)));

        if (ancestor) {
            const inherited = judgments[ancestor.fingerprint] || ancestor.judgment;
            const result = {
                ...finding,
                status: (stored && stored.status) || (inherited && inherited.status) || ancestor.status || 'open',
                judgment: stored || inherited,
                supersedes: ancestor.fingerprint,
                isNew: true
            };
            superseded.push(result);
            return result;
        }

        const result = {
            ...finding,
            status: (stored && stored.status) || 'open',
            judgment: stored,
            isNew: true
        };
        appeared.push(result);
        return result;
    });

    /*
     * A superseded finding is NOT reported as resolved as well. It is the same
     * problem in new words, and counting it in both columns would tell somebody
     * they fixed something at the same moment as telling them it is still there.
     */
    const supersededAncestors = new Set(superseded.map(finding => finding.supersedes));

    return {
        findings,
        resolved: resolved.filter(finding => !supersededAncestors.has(finding.fingerprint)),
        appeared,
        superseded
    };
}

/*
 * Is this finding still about text that exists?
 *
 * Every finding carries the content hash of what it was read from, so a finding
 * whose source has changed is marked STALE — "this may already be fixed" —
 * rather than silently dropped or, worse, silently re-drawn against text that
 * no longer says what it said. A quality panel that cannot tell you how old it
 * is invites more trust than it has earned, and that is this feature's actual
 * failure mode.
 */
function isStale(finding, hashesNow) {
    const recorded = finding && finding.sourceHashes;
    if (!recorded || !hashesNow) { return false; }
    return Object.keys(recorded).some(file =>
        hashesNow[file] !== undefined && hashesNow[file] !== recorded[file]);
}

/*
 * A cheap, stable content hash for the staleness check above.
 *
 * Deliberately NOT sha256: this runs on every save over a whole document body,
 * where sha256's 64 rounds per 64-byte block is real work for a value nobody
 * stores or compares across machines. FNV-1a mixed with the length is enough to
 * answer "did this file change", which is the only question asked of it.
 */
function contentHash(text) {
    const value = typeof text === 'string' ? text : '';
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'h' + hash.toString(16) + '-' + value.length.toString(16);
}

// -- sha256 ------------------------------------------------------------------
//
// FIPS 180-4, the standard implementation. Written out for the reason in the
// header: nothing to import, and the async API would make identity a promise.
// Operates on the UTF-8 bytes of the payload, so a fingerprint computed here
// equals one computed by any other sha256 over the same string.

const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

/* TextEncoder is present in both Electron's renderer and node ≥ 11; the manual
 * fallback exists because this module is required by a test runner that may be
 * pointed at an older interpreter, and a fingerprint that differs by
 * interpreter would be the exact bug this file is written to prevent. */
function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') { return new TextEncoder().encode(text); }
    const out = [];
    for (const character of text) {
        let code = character.codePointAt(0);
        if (code < 0x80) { out.push(code); }
        else if (code < 0x800) { out.push(0xc0 | (code >> 6), 0x80 | (code & 63)); }
        else if (code < 0x10000) { out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
        else {
            out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63),
                0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        }
    }
    return Uint8Array.from(out);
}

function sha256hex(text) {
    const bytes = utf8Bytes(text);
    const bitLength = bytes.length * 8;

    // Pad to a multiple of 64 bytes: 0x80, then zeros, then the length as a
    // 64-bit big-endian integer in the last eight bytes.
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    // The high word of the length is written too, and is zero for anything
    // under 512 MB — which every fingerprint payload is, by four orders of
    // magnitude. Written anyway so this is the algorithm and not an
    // approximation of it.
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let block = 0; block < padded.length; block += 64) {
        for (let i = 0; i < 16; i++) { w[i] = view.getUint32(block + i * 4); }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }

        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map(word => word.toString(16).padStart(8, '0')).join('');
}

module.exports = {
    normalizeText, anchorKey, structuralKey,
    fingerprint, reconcile,
    isStale, contentHash,
    sha256hex
};
