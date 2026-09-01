/*
 * The flow's op log: the vocabulary, the validator, and the fold.
 *
 * `.studio/flow/<authorKey>.jsonl` — one JSON op per line, one file per author,
 * committed with the branch. Modelled on comment-log.js deliberately and
 * closely: that format was arrived at by hitting the lost-update problem in
 * production, and a second sidecar that solved it differently would be a second
 * thing to get wrong.
 *
 * WHY THE STATE IS NOT A `state.json`. Two writers — a person answering in the
 * dock and an agent appending through the MCP server — would share that file and
 * lose each other's writes. One file per author removes the shared write
 * entirely; the fold is what turns N files back into one state, and it is
 * deterministic (see compareOps) so every reader gets the same answer.
 *
 * WHY THE PROSE IS NOT IN HERE. Documents hold the words, because a person has
 * to be able to edit their own brief. This holds the facts that must stay
 * computable with the conversation deleted: coverage, assumptions, gates, gaps
 * and their exits. Ops that point at prose carry `{doc, quote, occurrence}` and
 * NEVER an offset — the rule quality-anchor.js exists to enforce, for the reason
 * it documents: an edit above an anchor must not move it, and an edit to it must
 * orphan it visibly rather than mis-highlight silently.
 *
 * PURE. No DOM, no Theia, no filesystem, no `require`. tests/flow-log-test.mjs
 * runs it under plain node, and tools/flow-mcp/server.mjs loads THIS file rather
 * than mirroring it — which is the one improvement over comments-mcp, where the
 * fold is duplicated in a second implementation that has to be kept in step.
 */

const OP_KINDS = [
    // the project itself
    'destination', 'kit', 'document',
    // the interview
    'ask', 'answer', 'unknown', 'skip', 'cover',
    // what is known, and how well
    'assume', 'resolve-assumption', 'open-question', 'close-question',
    // material
    'attach', 'fetch', 'read', 'classify',
    // requirements
    'requirement', 'requirement-state',
    // architecture
    'capability', 'owner', 'gap', 'exit', 'verdict',
    // decision and handover
    'option', 'gate', 'unvalidated', 'handover',
    // withdrawal
    'retract'
];

/* Ops that bring something into existence. They are applied before everything
 * else, for the reason comment-log.js gives: the total order is not a causal
 * order, so an `answer` written in the same millisecond as its `ask` can sort
 * first, and a single-pass fold would silently drop it. */
const CREATION_OPS = ['ask', 'assume', 'open-question', 'attach', 'fetch', 'requirement', 'capability', 'gap', 'option'];

const TOPIC_STATES = ['answered', 'assumed', 'marked-unknown', 'not-applicable'];
const BUCKETS = ['take-as-is', 'modify', 'write-ourselves', 'paper'];
const BLOCK_STATES = ['shipped', 'planned', 'deprecated', 'paper'];
const EXIT_KINDS = ['workaround', 'pull-request', 'propose-to-platform', 'change-invariant'];
const BASES = ['measured', 'analogous', 'assumed'];
const GATE_STATES = ['passed', 'waived', 'failed'];
const ASSUMPTION_STATES = ['confirmed', 'rejected', 'carried'];

const QUESTION_MAX_LINES = 2;
const QUESTION_MAX_CHARS = 160;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const fail = reason => ({ ok: false, reason });
const pass = () => ({ ok: true });

function isArray(v) { return Array.isArray(v); }
function text(v) { return typeof v === 'string' ? v.trim() : ''; }

/*
 * Is this op writable, and by this actor?
 *
 * THE THREE REFUSALS THAT MATTER are all here, because a tool that accepts
 * everything lets a model write something the product then renders as if it were
 * true:
 *
 *   1. a block whose own state is `paper` cannot be placed in any bucket but
 *      `paper` — the one thing in the scenario nobody may waive;
 *   2. a bucket other than `paper` needs its evidence chain, because a match
 *      computed from descriptions is not a match and twice a gear's docs and its
 *      code disagreed;
 *   3. an agent cannot waive a gate. Waiving is a human act with a recorded
 *      reason, and an agent that could waive could pass its own work.
 *
 * Each refusal returns WHY in one sentence, so a caller corrects rather than
 * retries.
 */
function validateOp(op, context) {
    const actor = (context && context.actor) || 'person';
    if (!op || typeof op !== 'object') { return fail('an op must be an object'); }
    if (!OP_KINDS.includes(op.op)) { return fail('unknown op kind: ' + String(op.op)); }

    switch (op.op) {
        case 'ask': {
            const body = text(op.text);
            if (!body) { return fail('a question needs text'); }
            if (body.split('\n').length > QUESTION_MAX_LINES) { return fail('a question is at most two lines'); }
            if (body.length > QUESTION_MAX_CHARS) { return fail('a question is at most ' + QUESTION_MAX_CHARS + ' characters; this one is ' + body.length); }
            if (!isArray(op.options) || op.options.length < 2 || op.options.length > 4) {
                return fail('a question offers two to four suggested answers; "I do not know" is added by the dock and is not yours to omit');
            }
            if (!op.q) { return fail('a question needs an id'); }
            return pass();
        }
        case 'answer':
            if (!op.q) { return fail('an answer names the question it answers'); }
            if (!text(op.value)) { return fail('an answer needs a value; use the `unknown` op to record "I do not know"'); }
            return pass();
        case 'cover':
            if (!op.topic) { return fail('coverage names a topic'); }
            if (!TOPIC_STATES.includes(op.state)) { return fail('a topic is ' + TOPIC_STATES.join(', ') + ' — there is no fifth state'); }
            return pass();
        case 'assume':
            if (!op.id || !text(op.text)) { return fail('an assumption needs an id and text'); }
            if (!text(op.consequence)) { return fail('an assumption records what breaks if it is wrong'); }
            return pass();
        case 'resolve-assumption':
            if (!ASSUMPTION_STATES.includes(op.state)) { return fail('an assumption resolves to ' + ASSUMPTION_STATES.join(', ')); }
            return pass();
        case 'owner': {
            if (!op.cap) { return fail('an owner names the capability it owns'); }
            if (!BUCKETS.includes(op.bucket)) { return fail('bucket is one of ' + BUCKETS.join(', ')); }
            if (op.state && !BLOCK_STATES.includes(op.state)) { return fail('block state is one of ' + BLOCK_STATES.join(', ')); }
            if (op.state === 'paper' && op.bucket !== 'paper') {
                return fail('a block that exists only on paper cannot be composed: its bucket must be `paper`, and the state is derived from the tree rather than asserted');
            }
            if (op.bucket !== 'paper' && op.bucket !== 'write-ourselves') {
                const evidence = isArray(op.evidence) ? op.evidence : [];
                const kinds = evidence.map(e => e && e.kind);
                if (!kinds.includes('design') || !kinds.includes('registry')) {
                    return fail('a proposed block needs its evidence chain — a design line and a registry line, each openable. A match computed from descriptions is not a match');
                }
            }
            return pass();
        }
        case 'exit':
            if (!op.gap) { return fail('an exit names the gap it closes'); }
            if (!EXIT_KINDS.includes(op.kind)) { return fail('an exit is one of ' + EXIT_KINDS.join(', ')); }
            return pass();
        case 'verdict': {
            const body = text(op.text);
            if (!body) { return fail('a verdict needs text'); }
            if (/\d\s*%|percent/i.test(body)) { return fail('a sufficiency verdict carries no percentage — the shape that proved useful is "enough, for its layer", plus what it will not do'); }
            return pass();
        }
        case 'option':
            if (!op.id || !text(op.name)) { return fail('an option needs an id and a name'); }
            if (!BASES.includes(op.timeBasis) || !BASES.includes(op.tokensBasis)) {
                return fail('every number states its basis: ' + BASES.join(', '));
            }
            return pass();
        case 'gate': {
            if (!op.id) { return fail('a gate op names the gate'); }
            if (!GATE_STATES.includes(op.state)) { return fail('a gate is ' + GATE_STATES.join(', ')); }
            if (actor === 'agent' && op.state === 'waived') {
                return fail('waiving is a human act with a recorded reason; an agent that could waive a gate could pass its own work');
            }
            if (actor === 'agent' && (op.id === 'G1' || op.id === 'G8')) {
                return fail('G1 and G8 are not stampable by an agent: there is no level to build on without an intent, and a handover with a critical finding stays closed');
            }
            if (op.state === 'waived' && !text(op.reason)) { return fail('a waiver carries a reason'); }
            return pass();
        }
        case 'requirement':
            if (!op.id || !text(op.text)) { return fail('a requirement needs an id and text'); }
            return pass();
        case 'read':
            if (!op.id) { return fail('reading names the source'); }
            if (!text(op.summary)) { return fail('marking a source read records one line about what it is'); }
            return pass();
        default:
            return pass();
    }
}

// ---------------------------------------------------------------------------
// The total order
// ---------------------------------------------------------------------------

/*
 * (at, author key, file, line). `at` is a fixed-width ISO stamp so a string
 * compare is a chronological compare; the rest only make the order TOTAL, so
 * the fold does not depend on which file was read first, on mtimes, or on which
 * machine is folding. Same rule, and the same reasoning, as comment-log.js.
 */
function compareOps(a, b) {
    if (a.at !== b.at) { return a.at < b.at ? -1 : 1; }
    if (a.party !== b.party) { return a.party < b.party ? -1 : 1; }
    if (a.file !== b.file) { return a.file < b.file ? -1 : 1; }
    return a.line - b.line;
}

/** Parse one author's log file into entries the fold can sort. */
function parseLog(fileName, body, party) {
    const out = [];
    String(body || '').split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) { return; }
        let op;
        try { op = JSON.parse(trimmed); }
        catch (e) {
            // One malformed line must not cost the other 200. It is reported and
            // skipped, which is also what makes a hand-edited log visible.
            console.warn('[studio] unreadable flow op, skipped', fileName, index + 1);
            return;
        }
        out.push({ op, at: op.at || '', party: party || (op.by && op.by.key) || '', file: fileName, line: index });
    });
    return out;
}

function emptyState() {
    return {
        version: 1,
        flow: undefined,
        destination: undefined,
        kit: undefined,
        documents: {},
        topics: {},
        prerequisites: {},
        questions: [],
        assumptions: [],
        openQuestions: [],
        sources: [],
        requirements: [],
        capabilities: [],
        owners: [],
        gaps: [],
        exits: [],
        verdicts: [],
        options: [],
        gates: {},
        unvalidated: [],
        handover: { exits: [], blockedBy: [] },
        ops: 0
    };
}

const byId = (list, id) => list.find(x => x.id === id);

/* Copy only the fields an op actually carries. Undefined means "said nothing
 * about this", which is not the same as "set this to empty" — the distinction
 * the per-field rule rests on. */
function assignDefined(target, fields) {
    Object.keys(fields).forEach(key => { if (fields[key] !== undefined) { target[key] = fields[key]; } });
    return target;
}

/*
 * Fold ops into state.
 *
 * Three phases, as in comment-log.js: creation, then everything said about what
 * was created, then tombstones. A `retract` is a tombstone the fold HONOURS —
 * a log cannot forget, it can only record that something was withdrawn.
 *
 * Last write wins PER FIELD, not per record, so an agent recording contract risk
 * on a block cannot erase the note a person attached to it a minute earlier.
 */
function foldOps(entries) {
    const state = emptyState();
    const ordered = (entries || []).slice().sort(compareOps);
    const retracted = new Set();

    const stamp = op => ({ at: op.at, by: op.by });

    for (const entry of ordered) {
        const op = entry.op;
        if (!CREATION_OPS.includes(op.op)) { continue; }
        switch (op.op) {
            case 'ask':
                if (!byId(state.questions, op.q)) {
                    state.questions.push({
                        id: op.q, topic: op.topic, prerequisite: op.prerequisite,
                        text: op.text, options: op.options || [], blocks: op.blocks,
                        why: op.why, state: 'open', askedBy: op.by, askedAt: op.at
                    });
                }
                break;
            case 'assume':
                if (!byId(state.assumptions, op.id)) {
                    state.assumptions.push({ id: op.id, text: op.text, consequence: op.consequence, state: undefined, ...stamp(op) });
                }
                break;
            case 'open-question':
                if (!byId(state.openQuestions, op.id)) {
                    state.openQuestions.push({ id: op.id, text: op.text, blocks: op.blocks, owner: op.owner, closed: false, ...stamp(op) });
                }
                break;
            case 'attach':
            case 'fetch':
                if (!byId(state.sources, op.id)) {
                    state.sources.push({
                        id: op.id, path: op.path, url: op.url, believed: op.believed,
                        read: false, summary: undefined, fetched: op.op === 'fetch', ...stamp(op)
                    });
                }
                break;
            case 'requirement':
                if (!byId(state.requirements, op.id)) {
                    state.requirements.push({
                        id: op.id, text: op.text, criteria: op.criteria || {}, covers: op.covers || [],
                        complete: false, agreed: false, failing: undefined, ...stamp(op)
                    });
                }
                break;
            case 'capability':
                if (!byId(state.capabilities, op.id)) {
                    state.capabilities.push({ id: op.id, text: op.text, asked: !!op.asked, ...stamp(op) });
                }
                break;
            case 'gap':
                if (!byId(state.gaps, op.id)) {
                    state.gaps.push({ id: op.id, cap: op.cap, why: op.why, ...stamp(op) });
                }
                break;
            case 'option':
                if (!byId(state.options, op.id)) {
                    state.options.push({
                        id: op.id, name: op.name, time: op.time, timeBasis: op.timeBasis,
                        tokens: op.tokens, tokensBasis: op.tokensBasis,
                        risks: op.risks || [], excludes: op.excludes || [], ...stamp(op)
                    });
                }
                break;
            default: break;
        }
    }

    for (const entry of ordered) {
        const op = entry.op;
        state.ops++;
        if (CREATION_OPS.includes(op.op)) { continue; }
        switch (op.op) {
            case 'destination':
                state.destination = op.value;
                state.destinationBy = op.by;
                state.destinationAt = op.at;
                break;
            case 'kit':
                state.kit = { name: op.name, via: op.via, path: op.path };
                break;
            case 'document':
                state.documents[op.role] = op.path;
                break;
            case 'answer': {
                const q = byId(state.questions, op.q);
                if (q) { q.state = 'answered'; q.value = op.value; q.via = op.via || 'dock'; q.wrote = op.wrote; q.answeredBy = op.by; q.answeredAt = op.at; }
                if (op.prerequisite || (q && q.prerequisite)) {
                    state.prerequisites[op.prerequisite || q.prerequisite] = { value: op.value, ...stamp(op) };
                }
                break;
            }
            case 'unknown': {
                const q = byId(state.questions, op.q);
                if (q) { q.state = 'unknown'; q.note = op.note; q.answeredBy = op.by; q.answeredAt = op.at; }
                break;
            }
            case 'skip': {
                const q = byId(state.questions, op.q);
                if (q) { q.state = 'skipped'; }
                break;
            }
            case 'cover':
                state.topics[op.topic] = { state: op.state, where: op.where, blocking: op.blocking, ...stamp(op) };
                break;
            case 'resolve-assumption': {
                const a = byId(state.assumptions, op.id);
                if (a) { a.state = op.state; a.resolvedBy = op.by; }
                break;
            }
            case 'close-question': {
                const q = byId(state.openQuestions, op.id);
                if (q) { q.closed = true; q.answer = op.answer; }
                break;
            }
            case 'read': {
                const s = byId(state.sources, op.id);
                if (s) { s.read = true; s.summary = op.summary; s.readBy = op.by; }
                break;
            }
            case 'classify': {
                const s = byId(state.sources, op.id);
                if (s) { s.believed = op.believed; }
                break;
            }
            case 'requirement-state': {
                const r = byId(state.requirements, op.id);
                if (r) {
                    if (op.complete !== undefined) { r.complete = op.complete; }
                    if (op.agreed !== undefined) { r.agreed = op.agreed; }
                    if (op.failing !== undefined) { r.failing = op.failing; }
                    if (op.criteria) { r.criteria = { ...r.criteria, ...op.criteria }; }
                }
                break;
            }
            case 'owner': {
                const existing = state.owners.find(o => o.cap === op.cap);
                /*
                 * Per FIELD, not per record — and this is the line that makes it
                 * true. An agent recording a bucket change must not erase the
                 * contract risk a person attached a minute earlier just by not
                 * mentioning it, which is exactly what spreading `op.risk || []`
                 * over the record would do.
                 */
                const record = existing || { cap: op.cap, evidence: [], notOwned: [], risk: [] };
                assignDefined(record, {
                    bucket: op.bucket, block: op.block, state: op.state,
                    evidence: op.evidence, notOwned: op.notOwned, risk: op.risk,
                    at: op.at, by: op.by
                });
                if (!existing) { state.owners.push(record); }
                const cap = byId(state.capabilities, op.cap);
                if (cap) { cap.asked = true; }
                break;
            }
            case 'exit': {
                const existing = state.exits.find(e => e.gap === op.gap);
                const record = existing || { gap: op.gap };
                assignDefined(record, { kind: op.kind, owner: op.owner, note: op.note, at: op.at, by: op.by });
                if (!existing) { state.exits.push(record); }
                break;
            }
            case 'verdict': {
                const existing = state.verdicts.find(v => v.layer === op.layer);
                const record = existing || { layer: op.layer, wontDo: [] };
                assignDefined(record, { text: op.text, wontDo: op.wontDo, at: op.at, by: op.by });
                if (!existing) { state.verdicts.push(record); }
                break;
            }
            case 'gate':
                state.gates[op.id] = { state: op.state, who: (op.by && op.by.name) || op.who, reason: op.reason, at: op.at };
                break;
            case 'unvalidated':
                if (!state.unvalidated.some(u => u.insert === op.insert)) {
                    state.unvalidated.push({ insert: op.insert, note: op.note, ...stamp(op) });
                }
                break;
            case 'handover':
                state.handover = { exits: op.exits || [], blockedBy: op.blockedBy || [], ...stamp(op) };
                break;
            case 'retract':
                if (op.target) { retracted.add(op.target); }
                break;
            default:
                console.warn('[studio] unknown flow op', op.op, entry.file, entry.line);
                break;
        }
    }

    if (retracted.size) {
        const keep = list => list.filter(x => !retracted.has(x.id));
        state.questions = keep(state.questions);
        state.assumptions = keep(state.assumptions);
        state.openQuestions = keep(state.openQuestions);
        state.sources = keep(state.sources);
        state.requirements = keep(state.requirements);
        state.capabilities = keep(state.capabilities);
        state.gaps = keep(state.gaps);
        state.options = keep(state.options);
        state.owners = state.owners.filter(o => !retracted.has(o.cap));
    }
    return state;
}

/** Fold a `{ fileName: body }` map — what the store and the MCP server both hold. */
function foldFiles(files) {
    const entries = [];
    Object.keys(files || {}).sort().forEach(name => {
        const party = name.replace(/\.jsonl$/, '');
        parseLog(name, files[name], party).forEach(e => entries.push(e));
    });
    return foldOps(entries);
}

module.exports = {
    OP_KINDS, CREATION_OPS, TOPIC_STATES, BUCKETS, BLOCK_STATES, EXIT_KINDS, BASES,
    GATE_STATES, ASSUMPTION_STATES, QUESTION_MAX_LINES, QUESTION_MAX_CHARS,
    validateOp, compareOps, parseLog, foldOps, foldFiles, emptyState
};
