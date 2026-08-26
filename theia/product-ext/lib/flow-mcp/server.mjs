#!/usr/bin/env node
/*
 * studio-flow — a stdio MCP server over `<root>/.studio/flow/`.
 *
 * WHAT IT IS FOR. A green-field flow is a shared, human-facing process: an agent
 * asks the next question in its own chat, writes what it hears into the
 * repository, and a rail in Studio draws what happened. Studio itself asks
 * nobody anything — it provisions this server and the contract beside it, and
 * then reads. An agent that has to GUESS the state of that process guesses
 * wrong, and an agent that hand-edits the sidecar corrupts it. This is the seam.
 *
 * ZERO DEPENDENCIES for the transport, exactly as comments-mcp/server.mjs: the
 * JSON-RPC 2.0 framing is newline-delimited JSON on stdin/stdout, hand-rolled,
 * protocolVersion "2024-11-05". A channel that is an npm install away from
 * working is not a cheap channel.
 *
 * IT LOADS THE PRODUCT'S OWN FOLD RATHER THAN MIRRORING IT. comments-mcp has to
 * reimplement comment-log.js because that module pulls in Theia's URI and file
 * service; flow-log.js and flow-spec.js were written pure precisely so this file
 * can `require` them. One fold, one validator, one scenario — so a rule added to
 * the product cannot silently not exist here.
 *
 * WHAT REGISTERING IT GRANTS — and this is a permission grant, so it is stated
 * in REGISTER.md and deliberately not applied for anybody:
 *
 *   READ    .studio/flow/ (the whole flow) and .studio/quality/reports/
 *   APPEND  .studio/flow/agent-<name>.jsonl — its own file, and nothing else
 *   WRITE   the intent document, and ONLY through `write_answer`, which is
 *           flow-spec.js's `applyAnswer` — one heading, one marked line
 *
 * It cannot write another author's log (so it cannot forge or erase what a
 * person answered), cannot write any document but the intent one and only
 * through the answer applier, cannot reach the network, and cannot waive a
 * gate. The three refusals that carry the scenario live in
 * flow-log.js's validator and are re-asserted here with `actor: 'agent'`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/*
 * The product's own modules, from wherever this copy of the server is standing.
 *
 * Two layouts are real. In the working tree this file sits at
 * `product-ext/lib/flow-mcp/`, one directory over from `lib/browser/`. In a
 * packaged application the three files are copied side by side into
 * `Contents/Resources/app/flow-mcp/`, because the browser bundle is esbuilt and
 * `lib/browser/*.js` does not exist on disk there at all.
 *
 * Both are tried, in that order, and the failure names both — a server that
 * silently fell back to its own copy of the rules is precisely the drift this
 * import exists to prevent, so there is no third branch that invents one.
 */
const CANDIDATE_LIBS = [
    path.resolve(here, '../browser'),
    here
];
let flowLog, flowSpec, loadedFrom;
for (const dir of CANDIDATE_LIBS) {
    try {
        flowLog = require(path.join(dir, 'flow-log.js'));
        flowSpec = require(path.join(dir, 'flow-spec.js'));
        loadedFrom = dir;
        break;
    } catch (e) { /* try the next layout */ }
}
if (!flowLog || !flowSpec) {
    process.stderr.write('[studio-flow] cannot load flow-log.js / flow-spec.js from any of:\n  ' +
        CANDIDATE_LIBS.join('\n  ') + '\n');
    process.exit(2);
}

const SERVER_NAME = 'studio-flow';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

/*
 * The project root: what STUDIO_PROJECT_ROOT says, or the nearest directory at
 * or above the working directory that actually has a flow in it.
 *
 * The walk is not a convenience. An assistant is commonly started from a
 * subdirectory, and "no flow here" for a project that plainly has one is a
 * failure nobody diagnoses quickly. Walking up finds it; the refusal below
 * still fires when there is genuinely none, and names the directory it looked
 * in.
 */
function discoverRoot(from) {
    let dir = path.resolve(from);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.studio', 'flow', 'flow.json'))) { return dir; }
        const up = path.dirname(dir);
        if (up === dir) { return path.resolve(from); }
        dir = up;
    }
}

const PROJECT_ROOT = process.env.STUDIO_PROJECT_ROOT
    ? path.resolve(process.env.STUDIO_PROJECT_ROOT)
    : discoverRoot(process.cwd());
const AGENT_TOKEN = (process.env.STUDIO_AGENT || 'assistant').toLowerCase().replace(/[^a-z0-9-]/g, '');
const ME = { id: 'agent:' + AGENT_TOKEN, name: AGENT_TOKEN.charAt(0).toUpperCase() + AGENT_TOKEN.slice(1), kind: 'agent', key: 'agent-' + AGENT_TOKEN };

const FLOW_DIR = path.join(PROJECT_ROOT, '.studio', 'flow');
const MY_LOG = path.join(FLOW_DIR, ME.key + '.jsonl');
const QUALITY_REPORTS = path.join(PROJECT_ROOT, '.studio', 'quality', 'reports');

class ToolError extends Error {}

function warn(message) { process.stderr.write('[' + SERVER_NAME + '] ' + message + '\n'); }

/*
 * Refuse to start rather than report an empty flow.
 *
 * comments-mcp makes the same choice for the same reason: an agent that is
 * silently shown zero questions will confidently do nothing, and nobody will
 * know why for an hour. A wrong STUDIO_PROJECT_ROOT is the commonest way to get
 * there.
 */
function requireFlowRoot() {
    if (!fs.existsSync(path.join(FLOW_DIR, 'flow.json'))) {
        process.stderr.write(
            '[' + SERVER_NAME + '] no flow at ' + FLOW_DIR + '/flow.json\n' +
            '  STUDIO_PROJECT_ROOT must be the Studio project root — the directory that contains .studio/.\n' +
            '  Refusing to start rather than reporting an empty flow.\n');
        process.exit(1);
    }
}

// ------------------------------------------------------------------ reading

function readFlowJson() {
    try { return JSON.parse(fs.readFileSync(path.join(FLOW_DIR, 'flow.json'), 'utf8')); }
    catch (e) { throw new ToolError('flow.json could not be read: ' + e.message); }
}

function readLogs() {
    const files = {};
    for (const name of fs.readdirSync(FLOW_DIR)) {
        if (!name.endsWith('.jsonl')) { continue; }
        try { files[name] = fs.readFileSync(path.join(FLOW_DIR, name), 'utf8'); }
        catch (e) { warn('could not read ' + name + ': ' + e.message); }
    }
    return files;
}

function readState() {
    const meta = readFlowJson();
    const folded = flowLog.foldFiles(readLogs());
    return {
        ...folded,
        flow: meta.flow, spec: meta.spec, name: meta.name,
        destination: folded.destination || meta.destination,
        kit: folded.kit || meta.kit,
        documents: { ...(meta.documents || {}), ...folded.documents }
    };
}

// ------------------------------------------------------------------ writing

/*
 * Append one op to MY OWN log, and to nothing else.
 *
 * Validation runs with `actor: 'agent'`, which is what makes the three refusals
 * real: a paper block cannot be composed, a proposed block needs its evidence
 * chain, and a gate cannot be waived. The refusal is returned as a TOOL error so
 * the model sees the sentence and corrects itself.
 */
function appendOp(op) {
    const verdict = flowLog.validateOp(op, { actor: 'agent' });
    if (!verdict.ok) { throw new ToolError('Refused: ' + verdict.reason); }
    const record = { ...op, at: op.at || new Date().toISOString(), by: ME };
    fs.mkdirSync(FLOW_DIR, { recursive: true });
    let existing = '';
    try { existing = fs.readFileSync(MY_LOG, 'utf8'); } catch (e) { /* first op */ }
    const line = JSON.stringify(record) + '\n';
    const body = existing && !existing.endsWith('\n') ? existing + '\n' + line : existing + line;
    fs.writeFileSync(MY_LOG, body);
    return { ok: true, wrote: path.relative(PROJECT_ROOT, MY_LOG), op: record };
}

function need(args, key) {
    const value = args && args[key];
    if (value === undefined || value === null || String(value).trim() === '') {
        throw new ToolError('`' + key + '` is required');
    }
    return value;
}

function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

// ------------------------------------------------------------------ the tools

const TOOLS = [
    { name: 'flow_state', description: 'Where the flow is: destination, the step, the next question to ask, coverage, gates, open questions. Call this FIRST in every turn — the state is shared with a person and with other sessions, and must never be held in your head across turns.', inputSchema: { type: 'object', properties: {} } },
    { name: 'flow_spec', description: 'The scenario as data: acts, sections, steps, gates, the destination→prerequisite mapping, and the question inventory. Same source the rail draws from.', inputSchema: { type: 'object', properties: { section: { type: 'string' } } } },
    { name: 'list_sources', description: 'The material attached to this project, with what each is believed to be and whether it has been read.', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_quality', description: 'Raw spec-quality detector reports on disk for this project. A document with no report and a document with no findings are different states; do not conflate them.', inputSchema: { type: 'object', properties: { doc: { type: 'string' } } } },

    { name: 'ask_question', description: 'Record that you are asking ONE question, then ask it in your own chat. At most two lines, two to four suggested answers, and always offer "I do not know". Recording it is what lets the rail show what the project is waiting on, and what stops a second session re-asking it.', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, blocks: { type: 'string', enum: ['PRD', 'architecture', 'plan', 'delivery'] }, q: { type: 'string' } }, required: ['text', 'options'] } },
    { name: 'record_answer', description: 'Record an answer the person gave you in chat. `wrote` anchors where it landed in the document, by quote and occurrence, never by line.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, value: { type: 'string' }, wrote: { type: 'object' } }, required: ['q', 'value'] } },
    { name: 'write_answer', description: 'Put an answer into the intent document under the heading that topic belongs to, marked `stated` or `assumed`, keeping the `cpt-…` id line. Use this rather than editing intent.md yourself for a topic answer: the mark and the id are what the rail reads, and hand-written ones drift. Returns the anchor to pass to record_answer/record_coverage as `where`.', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, value: { type: 'string' }, mark: { type: 'string', enum: ['stated', 'assumed'] } }, required: ['topic', 'value'] } },
    { name: 'record_unknown', description: '"I do not know", as a recorded value, plus the open question it becomes. Never re-ask it in different words.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, note: { type: 'string' }, blocks: { type: 'string' } }, required: ['q'] } },
    { name: 'record_coverage', description: 'Mark a topic answered, assumed, marked-unknown or not-applicable. There is no fifth state.', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, state: { type: 'string' }, where: { type: 'object' } }, required: ['topic', 'state'] } },
    { name: 'record_assumption', description: 'Something you wrote that nobody said, with what breaks if it is wrong.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, consequence: { type: 'string' } }, required: ['text', 'consequence'] } },
    { name: 'resolve_assumption', description: 'confirmed, rejected or carried. A carried assumption also becomes an open question.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } }, required: ['id', 'state'] } },
    { name: 'open_question', description: 'Something nobody could answer, with the level it blocks: PRD, architecture, plan or delivery.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, blocks: { type: 'string' }, owner: { type: 'string' }, id: { type: 'string' } }, required: ['text'] } },
    { name: 'close_question', description: 'An open question that has been answered.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] } },

    { name: 'record_fetch', description: 'Record that YOU downloaded a link into sources/. This server does not fetch; it records that you did.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' }, id: { type: 'string' } }, required: ['url', 'path'] } },
    { name: 'mark_source_read', description: 'The only way a source becomes claimable: one line on what it actually is.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' } }, required: ['id', 'summary'] } },
    { name: 'classify_source', description: 'Correct what a source is believed to be. A belief, never a claim about its content.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, believed: { type: 'string' } }, required: ['id', 'believed'] } },

    { name: 'record_requirement', description: 'A requirement as an object with its own bar: singular, testable, bounded, traced.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, criteria: { type: 'object' }, covers: { type: 'array', items: { type: 'string' } } }, required: ['id', 'text'] } },
    { name: 'record_capability', description: 'One capability the requirements need. Asked from the domain toward the platform — there is no catalogue.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    { name: 'record_owner', description: 'Who owns a capability. bucket: take-as-is | modify | write-ourselves | paper. A block whose state is `paper` can only go in the paper bucket, and any other bucket needs a design line AND a registry line in `evidence`.', inputSchema: { type: 'object', properties: { cap: { type: 'string' }, bucket: { type: 'string' }, block: { type: 'string' }, state: { type: 'string' }, evidence: { type: 'array' }, notOwned: { type: 'array' }, risk: { type: 'array' } }, required: ['cap', 'bucket'] } },
    { name: 'record_gap', description: 'A capability nothing owns, and why.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, cap: { type: 'string' }, why: { type: 'string' } }, required: ['cap', 'why'] } },
    { name: 'record_exit', description: 'How a gap leaves: workaround, pull-request, propose-to-platform or change-invariant. A workaround nobody revisits becomes the architecture.', inputSchema: { type: 'object', properties: { gap: { type: 'string' }, kind: { type: 'string' }, owner: { type: 'string' }, note: { type: 'string' } }, required: ['gap', 'kind'] } },
    { name: 'record_verdict', description: 'Sufficiency per layer, in the shape that proved useful: "enough, for its layer", plus what it will not do. No percentage.', inputSchema: { type: 'object', properties: { layer: { type: 'string' }, text: { type: 'string' }, wontDo: { type: 'array' } }, required: ['layer', 'text'] } },
    { name: 'record_option', description: 'One way to build the architecture, with time, token spend, and the basis of each: measured, analogous or assumed.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, time: { type: 'string' }, timeBasis: { type: 'string' }, tokens: { type: 'string' }, tokensBasis: { type: 'string' }, risks: { type: 'array' }, excludes: { type: 'array' } }, required: ['name', 'timeBasis', 'tokensBasis'] } },

    { name: 'gate_status', description: 'Every gate, its condition, its state, and who may waive it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'stamp_gate', description: 'Stamp a gate you have satisfied. You cannot waive, and you cannot stamp G1 or G8.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'record_unvalidated', description: 'A human review that was skipped, recorded as a state that travels with the project.', inputSchema: { type: 'object', properties: { insert: { type: 'string' }, note: { type: 'string' } }, required: ['insert'] } }
];

const HANDLERS = {
    flow_state: () => {
        const state = readState();
        const next = flowSpec.nextQuestion(state);
        const sectionId = flowSpec.currentSection(state);
        const section = flowSpec.section(sectionId);
        return {
            flow: state.flow, name: state.name,
            destination: state.destination || null,
            destinationNeeds: flowSpec.destinationNeeds(state.destination),
            kit: state.kit || null,
            documents: state.documents,
            nextStep: { section: sectionId, title: section.title, lede: section.lede, steps: section.steps },
            nextQuestion: next || null,
            coverage: flowSpec.coverageRows(state),
            prerequisites: flowSpec.prerequisiteRows(state),
            queue: (state.questions || []).filter(q => q.state === 'open'),
            assumptions: state.assumptions,
            openQuestions: (state.openQuestions || []).filter(q => !q.closed),
            capabilities: state.capabilities,
            owners: state.owners,
            gaps: state.gaps.map(gap => ({ ...gap, exit: state.exits.find(e => e.gap === gap.id) || null })),
            options: state.options,
            gates: flowSpec.GATES.map(g => ({ id: g.id, title: g.title, state: flowSpec.gateState(state, g.id), waivableBy: g.waivableBy })),
            sources: state.sources,
            ops: state.ops
        };
    },

    flow_spec: args => {
        if (args && args.section) {
            const section = flowSpec.section(String(args.section));
            if (!section) { throw new ToolError('No such section: ' + args.section); }
            return section;
        }
        return {
            acts: flowSpec.ACTS, sections: flowSpec.SECTIONS, gates: flowSpec.GATES,
            topics: flowSpec.TOPICS, prerequisites: flowSpec.PREREQUISITES, questions: flowSpec.QUESTIONS,
            destinations: flowSpec.DESTINATIONS, buckets: flowSpec.BUCKETS, exitKinds: flowSpec.EXIT_KINDS, bases: flowSpec.BASES
        };
    },

    list_sources: () => {
        const state = readState();
        return {
            sources: state.sources,
            note: 'Nothing is claimed about a source until mark_source_read records that it was actually read.'
        };
    },

    read_quality: args => {
        if (!fs.existsSync(QUALITY_REPORTS)) {
            return { present: false, reports: [], note: 'No detector has run on this project. That is different from "no findings" — do not report it as clean.' };
        }
        const wanted = args && args.doc ? String(args.doc) : undefined;
        const reports = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.json')) { continue; }
                if (wanted && !entry.name.includes(path.basename(wanted).replace(/\W+/g, '_'))) { continue; }
                try { reports.push({ file: path.relative(PROJECT_ROOT, full), body: JSON.parse(fs.readFileSync(full, 'utf8')) }); }
                catch (e) { warn('unreadable report ' + full); }
            }
        };
        walk(QUALITY_REPORTS);
        return { present: true, reports, note: 'Raw detector output, exactly as emitted. Findings are anchored by quote, never by line number.' };
    },

    ask_question: args => appendOp({
        op: 'ask', q: (args && args.q) || newId('q'), topic: args && args.topic,
        text: need(args, 'text'), options: need(args, 'options'), blocks: args && args.blocks
    }),

    record_answer: args => appendOp({
        op: 'answer', q: need(args, 'q'), value: need(args, 'value'), via: 'chat', wrote: args && args.wrote
    }),

    /*
     * The ONE document this server writes, and it writes it through a pure
     * function the product's own test suite pins.
     *
     * Everything else an agent puts in a repository it writes with its own
     * editing tools, where the person sees it as a proposal. A topic answer is
     * different in kind: the `cpt-…` id line and the `stated`/`assumed` mark are
     * machine-read by the rail, and an agent composing that line by hand gets it
     * subtly wrong in a way that reads perfectly. So the format is not the
     * agent's to produce.
     */
    write_answer: args => {
        const topic = need(args, 'topic');
        const value = need(args, 'value');
        const mark = (args && args.mark) === 'assumed' ? 'assumed' : 'stated';
        if (!flowSpec.TOPIC_HEADINGS[topic]) {
            throw new ToolError('No such topic: ' + topic + '. `flow_spec().topics` lists them.');
        }
        const meta = readFlowJson();
        const rel = (meta.documents && meta.documents.intent) || 'intent.md';
        const file = path.join(PROJECT_ROOT, rel);
        let before;
        try { before = fs.readFileSync(file, 'utf8'); }
        catch (e) { throw new ToolError(rel + ' could not be read: ' + e.message); }
        const after = flowSpec.applyAnswer(before, topic, value, mark);
        if (after === before) {
            return { ok: true, changed: false, note: 'Nothing changed — that heading already carries this answer.' };
        }
        fs.writeFileSync(file, after);
        return { ok: true, changed: true, wrote: { doc: rel, quote: String(value).trim(), occurrence: 0 },
            note: 'Pass `wrote` back as `where` on record_coverage so the rail can jump to the sentence.' };
    },

    record_unknown: args => {
        const first = appendOp({ op: 'unknown', q: need(args, 'q'), note: args && args.note });
        const state = readState();
        const question = (state.questions || []).find(q => q.id === args.q);
        const second = appendOp({
            op: 'open-question', id: newId('oq'),
            text: (question && question.text) || 'Unanswered: ' + args.q,
            blocks: (args && args.blocks) || (question && question.blocks) || 'architecture'
        });
        return { ok: true, recorded: [first.op, second.op], note: '"I do not know" is a value. It is recorded and carried as an open question — do not ask it again in different words.' };
    },

    record_coverage: args => appendOp({
        op: 'cover', topic: need(args, 'topic'), state: need(args, 'state'), where: args && args.where
    }),

    record_assumption: args => appendOp({
        op: 'assume', id: (args && args.id) || newId('assum'), text: need(args, 'text'), consequence: need(args, 'consequence')
    }),

    resolve_assumption: args => appendOp({ op: 'resolve-assumption', id: need(args, 'id'), state: need(args, 'state') }),

    open_question: args => appendOp({
        op: 'open-question', id: (args && args.id) || newId('oq'), text: need(args, 'text'),
        blocks: (args && args.blocks) || 'architecture', owner: args && args.owner
    }),

    close_question: args => appendOp({ op: 'close-question', id: need(args, 'id'), answer: need(args, 'answer') }),

    record_fetch: args => appendOp({
        op: 'fetch', id: (args && args.id) || newId('src'), url: need(args, 'url'), path: need(args, 'path'),
        believed: (args && args.believed) || 'fetched page'
    }),

    mark_source_read: args => appendOp({ op: 'read', id: need(args, 'id'), summary: need(args, 'summary') }),

    classify_source: args => appendOp({ op: 'classify', id: need(args, 'id'), believed: need(args, 'believed') }),

    record_requirement: args => appendOp({
        op: 'requirement', id: need(args, 'id'), text: need(args, 'text'),
        criteria: (args && args.criteria) || {}, covers: (args && args.covers) || []
    }),

    record_capability: args => appendOp({
        op: 'capability', id: (args && args.id) || newId('cap'), text: need(args, 'text'), asked: true
    }),

    record_owner: args => appendOp({
        op: 'owner', cap: need(args, 'cap'), bucket: need(args, 'bucket'), block: args && args.block,
        state: args && args.state, evidence: (args && args.evidence) || [],
        notOwned: (args && args.notOwned) || [], risk: (args && args.risk) || []
    }),

    record_gap: args => appendOp({ op: 'gap', id: (args && args.id) || newId('gap'), cap: need(args, 'cap'), why: need(args, 'why') }),

    record_exit: args => appendOp({
        op: 'exit', gap: need(args, 'gap'), kind: need(args, 'kind'), owner: args && args.owner, note: args && args.note
    }),

    record_verdict: args => appendOp({
        op: 'verdict', layer: need(args, 'layer'), text: need(args, 'text'), wontDo: (args && args.wontDo) || []
    }),

    record_option: args => appendOp({
        op: 'option', id: (args && args.id) || newId('opt'), name: need(args, 'name'),
        time: args && args.time, timeBasis: need(args, 'timeBasis'),
        tokens: args && args.tokens, tokensBasis: need(args, 'tokensBasis'),
        risks: (args && args.risks) || [], excludes: (args && args.excludes) || []
    }),

    gate_status: args => {
        const state = readState();
        const gates = flowSpec.GATES
            .filter(g => !args || !args.id || g.id === args.id)
            .map(g => ({ id: g.id, title: g.title, condition: g.condition, section: g.section, state: flowSpec.gateState(state, g.id), waivableBy: g.waivableBy }));
        if (!gates.length) { throw new ToolError('No such gate: ' + (args && args.id)); }
        return { gates };
    },

    /*
     * Stamping is deliberately not "record whatever you decided": the state is
     * recomputed here, and a gate whose condition the fold does not satisfy is
     * refused with the condition quoted back. An agent that could stamp an
     * unsatisfied gate could pass its own work.
     */
    stamp_gate: args => {
        const id = need(args, 'id');
        const gate = flowSpec.gate(id);
        if (!gate) { throw new ToolError('No such gate: ' + id); }
        const state = readState();
        const derived = flowSpec.gateState(state, id);
        if (derived !== 'passed') {
            throw new ToolError('Refused: ' + id + ' is "' + derived + '". Its condition is: ' + gate.condition);
        }
        return appendOp({ op: 'gate', id, state: 'passed' });
    },

    record_unvalidated: args => appendOp({ op: 'unvalidated', insert: need(args, 'insert'), note: args && args.note })
};

/* ------------------------------------------------------- JSON-RPC 2.0 / stdio */

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
        case 'initialize':
            reply(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME + '-' + AGENT_TOKEN, version: SERVER_VERSION },
                instructions:
                    'The green-field flow for the project at ' + PROJECT_ROOT + '. Call flow_state() first in every ' +
                    'turn — the state is shared with a person and with the rail on their screen. You write as ' +
                    ME.name + ' (' + ME.id + ') and you append to one file: .studio/flow/' + ME.key + '.jsonl. ' +
                    'You cannot write a document through this server, cannot waive a gate, and cannot compose a block ' +
                    'that exists only on paper. AGENTS.md in the repository is the contract.'
            });
            return;
        case 'notifications/initialized':
        case 'initialized':
            return;
        case 'ping':
            if (!isNotification) { reply(id, {}); }
            return;
        case 'tools/list':
            reply(id, { tools: TOOLS });
            return;
        case 'tools/call': {
            const name = params && params.name;
            const handler = HANDLERS[name];
            if (!handler) { replyError(id, -32602, 'Unknown tool: ' + name); return; }
            try {
                const result = handler((params && params.arguments) || {});
                reply(id, { content: [{ type: 'text', text: JSON.stringify(result, undefined, 2) }], isError: false });
            } catch (e) {
                /* A refusal is a TOOL error, not a protocol error: the model has
                 * to see the sentence and correct itself. */
                const text = e instanceof ToolError ? e.message : name + ' failed: ' + e.message;
                if (!(e instanceof ToolError)) { warn(name + ': ' + (e.stack || e.message)); }
                reply(id, { content: [{ type: 'text', text }], isError: true });
            }
            return;
        }
        default:
            if (!isNotification) { replyError(id, -32601, 'Method not found: ' + method); }
    }
}

function main() {
    requireFlowRoot();
    warn('agent=' + ME.id + ' key=' + ME.key + ' root=' + PROJECT_ROOT);
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) { continue; }
            let message;
            try { message = JSON.parse(line); }
            catch (e) { replyError(null, -32700, 'Parse error'); continue; }
            if (Array.isArray(message)) {
                for (const one of message) { try { handle(one); } catch (e) { warn(e.stack || e.message); } }
            } else if (message && typeof message === 'object') {
                try { handle(message); } catch (e) { warn(e.stack || e.message); }
            } else {
                replyError(null, -32600, 'Invalid Request');
            }
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

main();
