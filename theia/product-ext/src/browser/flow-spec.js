/*
 * The green-field flow, as data.
 *
 * WHY THIS FILE EXISTS. The scenario is 4 acts, 13 sections, 31 steps and 8
 * gates, and three separate consumers need to agree about every one of them:
 * the rail draws them, the question dock asks from them, and an agent is told
 * about them in prose. Three descriptions of one scenario is two too many —
 * the same argument active-project.js makes about three readings of one fact —
 * so this module is the single description and everything else derives.
 *
 * It is PURE: no DOM, no Theia, no filesystem, no `require`. That is what lets
 * `tests/flow-spec-test.mjs` run it under plain node in milliseconds, and it is
 * what lets tools/flow-mcp/server.mjs load the same file the frontend loads
 * rather than mirroring it (the coupling comments-mcp/server.mjs has to
 * comment-log.js, and pays for on every change).
 *
 * The same technique as figure-spec.js's FIGURE_API_DOC: one source, two
 * consumers — the surface and the model.
 *
 * THE ONE RULE THAT SHAPES THE WHOLE FILE. Question depth is a function of the
 * DESTINATION — prototype, internal tool, production. Somebody who came for a
 * prototype is never put through the production questionnaire. Without that
 * rule as data, the flow degrades into the standard questionnaire it exists to
 * prevent, which is why `destination` is a first-class field and why
 * `destinationNeeds` exists rather than a comment saying "ask fewer questions".
 */

const FLOW_ID = 'green-field';
const SPEC_VERSION = 'green-field@1';

const DESTINATIONS = ['prototype', 'internal-tool', 'production'];
const DESTINATION_LABELS = {
    'prototype': 'Prototype',
    'internal-tool': 'Internal tool',
    'production': 'Production'
};

/* The four topic states. FOUR, not three: "I do not know" is a recorded value
 * with an author and a time, and it must not render as an empty field. */
const TOPIC_STATES = ['answered', 'assumed', 'marked-unknown', 'not-applicable'];

/* What a gap's exit can be. Recording the exit is the cheapest step in stage 4
 * and the one most likely to be dropped — last time a workaround nobody
 * revisited silently became the architecture, and nothing recorded it. */
const EXIT_KINDS = ['workaround', 'pull-request', 'propose-to-platform', 'change-invariant'];

/* The four buckets. The fourth is a different KIND, not a worse first: a gear
 * that exists only on paper can never be composed. */
const BUCKETS = ['take-as-is', 'modify', 'write-ourselves', 'paper'];

/* Every number in act IV states which of these it is. */
const BASES = ['measured', 'analogous', 'assumed'];

/* What an open question can block. Ordered, so "blocks from" can be compared. */
const BLOCK_LEVELS = ['PRD', 'architecture', 'plan', 'delivery'];

// ---------------------------------------------------------------------------
// Acts and sections
// ---------------------------------------------------------------------------

const ACTS = [
    { id: 'I', title: 'Intent', settles: 'What they want, in whose vocabulary, written down well enough to build a level on', sections: ['01', '02', '03'] },
    { id: 'II', title: 'Requirements', settles: 'Only the prerequisites the destination requires, turned into requirements with a bar', sections: ['04', '05'] },
    { id: 'III', title: 'Architecture', settles: 'What not to build, on evidence, with every gap routed', sections: ['06', '07', '08', '09', '10'] },
    { id: 'IV', title: 'Decision and handover', settles: 'The architecture shown, the ways to build it priced, the repository handed over', sections: ['11', '12', '13'] }
];

/*
 * `rail` names what the left rail is counting in this section, and it changes
 * four times on purpose: topics, then prerequisites and requirements, then
 * capabilities, then the manifest and the gates. The reference design keeps one
 * rail throughout; ours cannot, because what progress is being made ON changes.
 */
const SECTIONS = [
    { id: '01', act: 'I', title: 'Idea intake', steps: [1, 2, 3], rail: 'intent-coverage',
      lede: 'The idea in their own words; whatever already exists lands alongside as files, unparsed and unclaimed.' },
    { id: '02', act: 'I', title: 'Company context', steps: [4, 5], rail: 'intent-coverage',
      lede: 'The organisation’s conventions plug in; when there is no organisation, the absence is stated in one line.' },
    { id: '03', act: 'I', title: 'Answers become the document', steps: [6, 7, 8], rail: 'intent-coverage', gates: ['G1', 'G2'],
      lede: 'One short question at a time, and the document fills in front of them — their words, and the agent’s additions marked as additions.' },
    { id: '04', act: 'II', title: 'Only what the destination needs', steps: [9, 10, 11], rail: 'prerequisite-coverage', gates: ['G3'],
      lede: 'A few questions architecture depends on, scaled to where the project is going.' },
    { id: '05', act: 'II', title: 'Requirements as objects', steps: [12], rail: 'requirements', gates: ['G4'],
      lede: 'Each requirement carries its own bar and its own verdict; complete and agreed stay two columns.' },
    { id: '06', act: 'III', title: 'Ownership sweep', steps: [13], rail: 'capability-ledger',
      lede: 'For every capability the requirements need, one question — who owns this? — asked from the domain toward the platform.' },
    { id: '07', act: 'III', title: 'Composition proposal', steps: [14], rail: 'capability-ledger',
      lede: 'Four buckets — take as is, modify, write ourselves, exists only on paper — and the fourth can never be composed.' },
    { id: '08', act: 'III', title: 'Block evidence', steps: [15, 16, 18], rail: 'capability-ledger',
      lede: 'Requirement → design line → registry line, openable; beside it what the block declares it does not own.' },
    { id: '09', act: 'III', title: 'Sufficiency and routed gaps', steps: [17, 19], rail: 'capability-ledger', gates: ['G5'],
      lede: 'Enough, for its layer — plus exactly what it will not do; every uncovered capability leaves as a routed decision.' },
    { id: '10', act: 'III', title: 'Prototype loop', steps: [20, 21, 22], rail: 'requirements', conditional: 'ui-first',
      lede: 'Conditional. HTML prototypes on partly mocked data, commented like documents, feeding the model back.' },
    { id: '11', act: 'IV', title: 'Architecture in view', steps: [23], rail: 'composition-manifest', gates: ['G6'],
      lede: 'The composition drawn from the manifest, so the picture cannot drift from the decision.' },
    { id: '12', act: 'IV', title: 'Ways to build it, priced', steps: [24, 25, 26], rail: 'composition-manifest', gates: ['G7'],
      lede: 'Two or three ways to build the same architecture, each with time, risk and token spend, every number stating its basis.' },
    { id: '13', act: 'IV', title: 'Handover', steps: [27, 28, 29, 30, 31], rail: 'gates', gates: ['G8'],
      lede: 'A specification repository and a zip, with three equal exits.' }
];

const RAIL_OBJECTS = {
    'intent-coverage': 'Intent coverage',
    'prerequisite-coverage': 'Prerequisite coverage',
    'requirements': 'Requirements',
    'capability-ledger': 'Capability ledger',
    'composition-manifest': 'Composition manifest',
    'gates': 'Gate stamps'
};

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/*
 * `waivableBy: null` means nobody — and there are exactly two of those, for the
 * two things the scenario says are the only blocking facts in the whole flow:
 * there is no level to build on without an intent (G1), and a handover with a
 * critical finding open, or a plan that depends on a gear that is not built,
 * stays closed (G8). Everything else is an insert of the G6 kind: skippable,
 * with `unvalidated` travelling with the project.
 */
const GATES = [
    { id: 'G1', title: 'intent is usable', section: '03', waivableBy: null,
      condition: 'All four parts of the statement present, each marked stated or assumed.' },
    { id: 'G2', title: 'discovery is sufficient', section: '03', waivableBy: 'PM',
      condition: 'Every blocking topic answered, assumed or marked unknown, at most two unknown, and every assumption resolved.' },
    { id: 'G3', title: 'one-pager is complete', section: '04', waivableBy: 'PM',
      condition: 'Every prerequisite this destination requires is answered, or recorded as deferred.' },
    { id: 'G4', title: 'requirements are reviewable', section: '05', waivableBy: 'PM',
      condition: 'Every requirement is singular, testable and bounded, and traces to something somebody said.' },
    { id: 'G5', title: 'composition is decidable', section: '09', waivableBy: null,
      condition: 'Every capability has an owner or a routed gap with a recorded exit, and nothing composed exists only on paper.' },
    { id: 'G6', title: 'composition validated, or explicitly not', section: '11', waivableBy: 'skip',
      condition: 'An architect validated the composition, or the project records that it is unvalidated.' },
    { id: 'G7', title: 'the plan is reviewable', section: '12', waivableBy: 'Delivery Manager',
      condition: 'At least two ways to build it, each with time, risk and token spend, and every number states its basis.' },
    { id: 'G8', title: 'ready for delivery work', section: '13', waivableBy: null,
      condition: 'Every earlier gate passed or waived, no critical finding open, and nothing planned depends on a gear that is not built.' }
];

// ---------------------------------------------------------------------------
// Topics, prerequisites, and the question inventory
// ---------------------------------------------------------------------------

/*
 * `blocking` here is the DEFAULT; `blockingFor` narrows it to the destinations
 * that actually require it. A prototype with no success signal is not an
 * incomplete intent, it is a prototype.
 */
const TOPICS = [
    { id: 'what', title: 'What is being made', blocking: true, section: '§ 1.1' },
    { id: 'audience', title: 'Who it is for', blocking: true, section: '§ 1.2' },
    { id: 'problem', title: 'The problem it removes', blocking: true, section: '§ 1.3' },
    { id: 'boundary', title: 'First boundary', blocking: true, section: '§ 1.4' },
    { id: 'success', title: 'Success signal', blocking: true, blockingFor: ['internal-tool', 'production'], section: '§ 5' },
    { id: 'organisation', title: 'Organisation context', blocking: true, section: '§ 3.2' }
];

/*
 * The prerequisites for architecture, and the destination that first requires
 * each. `why` is shown BESIDE the question, because a prerequisite whose
 * consequence is not stated is indistinguishable from a form field — and that
 * is the specific failure this stage exists to avoid.
 */
const PREREQUISITES = [
    { id: 'hosting', title: 'Where will this run?', requiredFor: ['prototype', 'internal-tool', 'production'],
      options: ['Our AWS', 'Our GCP', 'On-prem', 'Not decided'],
      why: 'It decides whether there is a third way to build this to price in act IV, and which storage blocks can be composed at all.' },
    { id: 'scale', title: 'Roughly how many people will use it?', requiredFor: ['internal-tool', 'production'],
      options: ['Under 50', 'Hundreds', 'Thousands or more', 'I do not know yet'],
      why: 'Scale is what separates a single-node answer from a distributed one, and it changes which blocks are worth composing.' },
    { id: 'country', title: 'Which country or region will it operate in?', requiredFor: ['production'],
      options: ['EU', 'US', 'Both', 'Not decided'],
      why: 'Where the data sits decides residency constraints, and those are architecture rather than configuration.' },
    { id: 'certification', title: 'Are there certifications it has to meet?', requiredFor: ['production'],
      options: ['None', 'ISO 27001', 'SOC 2', 'Something else'],
      why: 'A certification adds requirements with a bar of their own, and they are cheapest to design for before anything is built.' }
];

/*
 * Everything the person is ever asked, in order, with the condition that makes
 * a question exist at all. The BUDGET this encodes, from intent-template.md: a
 * prototype reaches a usable intent in one field, one tap, at most three
 * questions and two decision pages. Production adds two.
 *
 * Every question is at most two lines, offers two to four suggested answers,
 * and always offers "I do not know" — which the dock adds, so a question here
 * cannot forget it.
 */
const QUESTIONS = [
    { id: 'q-destination', topic: null, sets: 'destination',
      text: 'How far is this going?',
      options: ['Prototype', 'Internal tool', 'Production'],
      note: 'It is the only answer that changes which later questions exist.' },
    { id: 'q-audience', topic: 'audience',
      text: 'Who will use this?',
      /* Candidate ANSWERS, never instructions. An option that reads "name them
       * concretely" is a form field with extra steps: picking it writes those
       * three words into the person's own intent document. */
      options: ['A team inside our company', 'Our customers', 'Field staff, away from a desk'],
      blocks: 'PRD' },
    { id: 'q-problem', topic: 'problem',
      text: 'What breaks today without it?',
      options: ['Work is lost', 'It is done twice by hand', 'It is too slow to be useful'],
      blocks: 'PRD' },
    { id: 'q-boundary', topic: 'boundary',
      text: 'What is this explicitly not?',
      options: ['Not a replacement for the current system', 'Not for external users', 'No offline support'],
      blocks: 'architecture' },
    { id: 'q-success', topic: 'success', forDestinations: ['internal-tool', 'production'],
      text: 'If this works, what will you see happen?',
      options: ['A number moves', 'A meeting stops happening', 'None I can name'],
      blocks: 'plan' }
];

// ---------------------------------------------------------------------------
// Derivations — the three questions every surface asks this module
// ---------------------------------------------------------------------------

function section(id) { return SECTIONS.find(s => s.id === id); }
function gate(id) { return GATES.find(g => g.id === id); }
function topic(id) { return TOPICS.find(t => t.id === id); }

/** The prerequisite ids this destination requires. The depth rule, as code. */
function destinationNeeds(destination) {
    const d = DESTINATIONS.includes(destination) ? destination : 'production';
    return PREREQUISITES.filter(p => p.requiredFor.includes(d)).map(p => p.id);
}

/** Which topics block for this destination — `blockingFor` narrows `blocking`. */
function blockingTopics(destination) {
    return TOPICS.filter(t => t.blocking && (!t.blockingFor || t.blockingFor.includes(destination))).map(t => t.id);
}

function topicState(state, id) {
    const row = state && state.topics && state.topics[id];
    return row ? row.state : undefined;
}

/** A topic somebody has said something about, in any of the four states. */
function topicSettled(state, id) {
    return TOPIC_STATES.includes(topicState(state, id));
}

/*
 * The one question to ask next, or undefined.
 *
 * ORDER, and it is not arbitrary. An agent's own queued question wins over the
 * inventory, because the agent has read the material and this module has not.
 * The inventory is the floor: it is what keeps the flow answerable end to end
 * with no agent installed at all, which is the state the product must survive
 * (Codex cannot be seeded, and Claude only on a fresh session).
 */
function nextQuestion(state) {
    if (!state) { return undefined; }
    if (!state.destination) { return { ...QUESTIONS[0], source: 'spec' }; }

    const queued = (state.questions || []).filter(q => q.state === 'open');
    if (queued.length) { return { ...queued[0], source: 'agent' }; }

    for (const q of QUESTIONS) {
        if (q.id === 'q-destination') { continue; }
        if (q.forDestinations && !q.forDestinations.includes(state.destination)) { continue; }
        if (q.topic && topicSettled(state, q.topic)) { continue; }
        if ((state.questions || []).some(a => a.id === q.id && a.state !== 'open')) { continue; }
        return { ...q, source: 'spec' };
    }

    /* Act I is settled; the prerequisites this destination requires are next,
     * and only the ones it requires. */
    for (const id of destinationNeeds(state.destination)) {
        const p = PREREQUISITES.find(x => x.id === id);
        if (!p) { continue; }
        const asked = (state.questions || []).find(a => a.id === 'q-' + id);
        if (asked && asked.state !== 'open') { continue; }
        if (state.prerequisites && state.prerequisites[id]) { continue; }
        return { id: 'q-' + id, prerequisite: id, text: p.title, options: p.options, why: p.why, source: 'spec' };
    }
    return undefined;
}

/*
 * A gate's state, computed from the fold.
 *
 * `unreached` is a real answer and not a synonym for `failed`: a gate whose
 * section has not been entered has nothing to say, and drawing it as a failure
 * would make every new project open on a wall of red. A recorded stamp always
 * wins — a person's waiver is a fact, not a derivation.
 */
function gateState(state, gateId) {
    const stamped = state && state.gates && state.gates[gateId];
    if (stamped && stamped.state) { return stamped.state; }

    const destination = (state && state.destination) || 'production';
    switch (gateId) {
        case 'G1': {
            const parts = ['what', 'audience', 'problem', 'boundary'];
            if (!parts.some(id => topicSettled(state, id))) { return 'unreached'; }
            return parts.every(id => ['answered', 'assumed'].includes(topicState(state, id))) ? 'passed' : 'failed';
        }
        case 'G2': {
            const blocking = blockingTopics(destination);
            if (!blocking.some(id => topicSettled(state, id))) { return 'unreached'; }
            const settled = blocking.every(id => topicSettled(state, id));
            const unknown = blocking.filter(id => topicState(state, id) === 'marked-unknown').length;
            const assumptionsOpen = (state.assumptions || []).some(a => !a.state);
            return settled && unknown <= 2 && !assumptionsOpen ? 'passed' : 'failed';
        }
        case 'G3': {
            const needed = destinationNeeds(destination);
            const answered = id => state.prerequisites && state.prerequisites[id] && state.prerequisites[id].value !== undefined;
            if (!needed.some(answered)) { return 'unreached'; }
            return needed.every(answered) ? 'passed' : 'failed';
        }
        case 'G4': {
            const list = state.requirements || [];
            if (!list.length) { return 'unreached'; }
            return list.every(r => r.criteria && ['singular', 'testable', 'bounded', 'traced'].every(k => r.criteria[k])) ? 'passed' : 'failed';
        }
        case 'G5': {
            const caps = state.capabilities || [];
            if (!caps.length) { return 'unreached'; }
            const owned = id => (state.owners || []).some(o => o.cap === id);
            const routed = id => (state.gaps || []).some(g => g.cap === id && (state.exits || []).some(e => e.gap === g.id));
            const composedPaper = (state.owners || []).some(o => o.state === 'paper' && o.bucket !== 'paper');
            return !composedPaper && caps.every(c => owned(c.id) || routed(c.id)) ? 'passed' : 'failed';
        }
        case 'G6': {
            const validated = state.gates && state.gates.G6;
            const unvalidated = (state.unvalidated || []).some(u => u.insert === 'architect-review');
            if (validated) { return validated.state; }
            return unvalidated ? 'waived' : 'unreached';
        }
        case 'G7': {
            const options = state.options || [];
            if (!options.length) { return 'unreached'; }
            const priced = o => BASES.includes(o.timeBasis) && BASES.includes(o.tokensBasis);
            return options.length >= 2 && options.every(priced) ? 'passed' : 'failed';
        }
        case 'G8': {
            const earlier = ['G1', 'G2', 'G3', 'G4', 'G5', 'G7'].map(id => gateState(state, id));
            if (earlier.every(s => s === 'unreached')) { return 'unreached'; }
            const blocked = (state.handover && state.handover.blockedBy || []).length > 0;
            const paper = (state.owners || []).some(o => o.state === 'paper' && o.bucket !== 'paper');
            return !blocked && !paper && earlier.every(s => s === 'passed' || s === 'waived') ? 'passed' : 'failed';
        }
        default:
            return 'unreached';
    }
}

/*
 * Which section the flow is in — the first one whose work is not finished.
 *
 * Deliberately derived rather than stored: a stored "current step" is a second
 * source of truth about progress, and the first thing to go stale when somebody
 * answers a question out of order, which they will.
 */
function currentSection(state) {
    if (!state || !state.destination) { return '01'; }
    if (nextQuestion(state)) {
        const q = nextQuestion(state);
        return q.prerequisite ? '04' : '03';
    }
    if (gateState(state, 'G4') !== 'passed') { return '05'; }
    if (!(state.capabilities || []).length) { return '06'; }
    if (gateState(state, 'G5') !== 'passed') { return (state.owners || []).length ? '09' : '07'; }
    if (!(state.options || []).length) { return '11'; }
    if (gateState(state, 'G7') !== 'passed') { return '12'; }
    return '13';
}

/** The rail's rows for a section, already in the four states the rail draws. */
function coverageRows(state) {
    const destination = (state && state.destination) || 'production';
    const blocking = blockingTopics(destination);
    return TOPICS.map(t => ({
        id: t.id,
        title: t.title,
        blocking: blocking.includes(t.id),
        state: topicState(state, t.id) || 'open',
        where: state && state.topics && state.topics[t.id] ? state.topics[t.id].where : undefined
    }));
}

function prerequisiteRows(state) {
    const destination = (state && state.destination) || 'production';
    const needed = destinationNeeds(destination);
    return PREREQUISITES.map(p => ({
        id: p.id,
        title: p.title,
        required: needed.includes(p.id),
        why: p.why,
        value: state && state.prerequisites && state.prerequisites[p.id] ? state.prerequisites[p.id].value : undefined
    }));
}

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

/*
 * Written into a flow project as AGENTS.md and CLAUDE.md at creation. It is the
 * contract, not a summary of one: every rule here is enforced somewhere else as
 * well (the dock adds "I do not know" so a question cannot omit it; the MCP
 * server refuses to compose a paper block, refuses a bucket with no evidence
 * chain, and refuses to waive a gate), and the reasons are included because a
 * rule an agent is given without a reason is the first one it reasons its way
 * around.
 */
const FLOW_AGENT_DOC = [
    '# This project is a Studio green-field flow',
    '',
    'You are the agent driving a specification flow inside Constructor Studio. A',
    'person arrived with an idea and no repository. Your job is to end with a',
    'specification repository somebody can build from — and to get there by asking',
    'as little as the destination requires.',
    '',
    '**You run the interview.** Studio asks nobody anything — it provisions this',
    'contract, the tools and a rail that tracks what happened, and then reads. The',
    'questions are yours to ask, in your own chat, one at a time.',
    '',
    '**Your transcript is not the record.** The person is looking at a document and',
    'a rail; their colleague and your own next session see only this repository.',
    'Anything that matters goes into a file or into a tool call. A conclusion that',
    'exists only in the chat does not exist.',
    '',
    '## The loop',
    '',
    '1. `flow_state()` — where the flow is, what is covered, what is queued, which',
    '   gate is next. **Always start here**, including after every interruption.',
    '   Never hold flow state in your head across turns; it is shared with a human.',
    '2. Decide the single next thing. `flow_state().nextStep` is authoritative for',
    '   *which* step; you decide what the step needs.',
    '3. If it needs an answer: `ask_question(...)` to record that you are asking,',
    '   then ask it in chat — **one** question, at most two lines, two to four',
    '   suggested answers, and always let them say they do not know. Then stop.',
    '4. When they answer, `write_answer(topic, value)` puts it in the document in',
    '   their words with the right mark and id, `record_answer` records what they',
    '   said, and `record_coverage` marks the topic. Then continue.',
    '5. Anything you wrote that they did not say is `assumed`, and registered with',
    '   `record_assumption` — including what breaks if it is wrong.',
    '6. At a gate, `stamp_gate` only what the gate\'s condition allows. You never',
    '   waive a gate. You may say a gate is ready.',
    '',
    '## The rules that are not negotiable',
    '',
    '1. **Never invent to fill a section.** An empty section with a recorded reason',
    '   is correct; an invented one is the defect this product exists to detect.',
    '2. **"I do not know" is a value.** Record it, raise it as an open question at',
    '   the level it blocks, move on, and never re-ask it in different words.',
    '3. **Everything is `stated` or `assumed`, visibly.** An assumption written as',
    '   a fact is the same defect as inventing.',
    '4. **Never emit a score, a percentage, or a readiness number** — not in a',
    '   document, not in a figure, not in a sentence. Coverage is counted in topics,',
    '   quality in findings; neither is averaged and the two are never mixed.',
    '5. **One question at a time, two lines at most, two to four suggested answers.**',
    '   A question that will not fit in two lines is two questions or the wrong one.',
    '6. **Ask nothing the destination does not require.** A prototype is never put',
    '   through the production questionnaire: country, certification and scale wait',
    '   until it heads for production, and are asked then.',
    '7. **Never compose a block that only exists on paper.** Documentation and an',
    '   empty plugin folder is `paper`, whatever the README says. State is derived',
    '   from the tree, never asserted.',
    '8. **A match computed from descriptions is not a match.** Requirement, design',
    '   line, registry line — or say "worth checking" and label it your own guess.',
    '9. **Every uncovered capability leaves as a routed decision** with an owner and',
    '   one of four exits: work around it, raise a pull request, propose it to the',
    '   platform, or change a platform invariant. A workaround nobody revisits',
    '   becomes the architecture.',
    '10. **Every number states its basis** — measured, analogous or assumed — and',
    '    what it excludes. Nobody measures token spend per option yet; say so.',
    '11. **Cite what you read.** A claim that traces to nothing is a finding, not a',
    '    feature. Nothing is claimed about an attachment until `mark_source_read`.',
    '12. **Never write into a connected system.** Jira, YouTrack and the gear',
    '    repositories stay authoritative for their own content. You propose; a',
    '    person pushes.',
    '',
    '## How you write into documents',
    '',
    '| What | How |',
    '| --- | --- |',
    '| The person\'s own answer to a flow topic | `write_answer` — never by hand: the mark and the `cpt-` id are machine-read |',
    '| Their answer to something with no topic | **directly**, into the section it belongs to, in their words |',
    '| Your read-back of what you understood | **directly**, marked `stated` or `assumed` |',
    '| A section you authored | as a **proposed change**, never a silent write |',
    '| A ```figure block | as a **proposed change**, always |',
    '| An edit spanning two documents | as **one grouped proposal**, or not at all |',
    '| Flow state | through the tools, never by hand-editing `.studio/flow/` |',
    '',
    'Do not reformat or "tidy" a document you did not write. The person is watching',
    'it fill; a diff full of reflowed paragraphs hides the sentence that matters.',
    '',
    '## The material',
    '',
    '- Attachments live in `sources/`. Nothing is claimed about a source until you',
    '  have read it — `mark_source_read` records that you did, in one line.',
    '- A link the person pastes is **yours** to fetch, not Studio\'s. Download it',
    '  into `sources/`, record it with `record_fetch`, and treat it as an attachment',
    '  from then on. Say so if a fetch fails; never summarise a page you could not',
    '  open.',
    '- Never delete or rewrite anything in `sources/`. It is evidence.',
    '',
    '## Quality checks',
    '',
    'Findings live in `.studio/quality/reports/`. Read them; never invent them, and',
    'never claim a document is clean because you cannot see a report — a document',
    'with no report and a document with no findings are different states.',
    '',
    '## When a tool is missing',
    '',
    '- **No `studio-flow` tools?** They are registered in this repository\'s',
    '  `.mcp.json`; an assistant that has not been restarted since the flow was',
    '  created will not have them yet, and some assistants ask before starting a',
    '  project server. Say plainly that they are missing, then work by writing',
    '  files. Do not hand-write `.studio/flow/*.jsonl`: a malformed op is worse',
    '  than a missing one, and the fold is shared with a person.',
    '- **No `cfs` on the PATH?** Author from the templates here and say which you',
    '  used. Never claim a document passed a validation that never ran.',
    '',
    '## When `cfs` is available',
    '',
    '- `cfs validate --artifact <path>` is the deterministic gate. Run it before',
    '  claiming a document is done, and paste what it says rather than your reading',
    '  of what it says.',
    '- Use the kit\'s workflows (`doc-prd`, `doc-design`, `doc-adr`, `decompose`)',
    '  rather than the templates directly, so the organisation\'s conventions apply',
    '  instead of your defaults.',
    '- `.cf-studio/config/` is the organisation\'s context: read its `AGENTS.md`',
    '  before writing anything in the organisation\'s format.',
    '',
    '## What the person sees, so you can predict it',
    '',
    '- Your questions appear only in your own chat panel, which they may have',
    '  closed. **Nothing important goes only into the chat.**',
    '- `ask_question` is what puts the question on the rail, under *Waiting on*, so',
    '  a person who closed your panel — or a colleague, or your next session — can',
    '  still see what this project is stuck on. Skipping it makes the flow look',
    '  idle while you sit waiting.',
    '- `write_answer` lands directly in the document they are reading, live.',
    '- Anything you write with your own editing tools appears as a **pending',
    '  change** they accept or reject hunk by hunk. That is the right shape for a',
    '  section you authored; it is the wrong shape for their own answer, which is',
    '  why `write_answer` exists.',
    '- Your flow ops appear as rows in the rail on the left. That rail is the whole',
    '  of what Studio knows about this flow.'
].join('\n');

/*
 * The skill Studio drops into a flow project, at
 * `.claude/skills/green-field-flow/SKILL.md`.
 *
 * WHY A SKILL AS WELL AS AGENTS.md. They are read at different moments and by
 * different things. `AGENTS.md` and `CLAUDE.md` are ambient: whatever an agent
 * is doing in this repository, the rules apply. A skill is addressed: it is
 * matched by its description when somebody says "continue the flow", and it
 * loads a procedure. The contract is the constitution; this is the runbook, and
 * it deliberately restates almost nothing — it points at the contract, because
 * two copies of twelve rules drift and the drifted copy is the one that gets
 * read.
 *
 * It is written for Claude Code's skill format (frontmatter with `name` and
 * `description`). Codex and anything else reads AGENTS.md, which is why the
 * contract, not this file, carries the rules.
 */
const FLOW_SKILL_DOC = [
    '---',
    'name: green-field-flow',
    'description: Drive the Constructor Studio green-field flow in this project — interview the person one question at a time, fill intent.md, and record every step through the studio-flow tools. Use whenever asked to start, continue, or check the flow, the intent document, or the specification for this project.',
    '---',
    '',
    '# Driving this project\'s green-field flow',
    '',
    'Read `AGENTS.md` in the repository root first. It is the contract and this file',
    'does not repeat it — where the two ever disagree, `AGENTS.md` wins.',
    '',
    '## Every turn, in order',
    '',
    '1. `flow_state()`. Never skip it and never cache it: a person, and possibly',
    '   another session, are changing the same flow.',
    '2. Read what it gives you. `nextStep` is the step. `nextQuestion` is the',
    '   question the scenario would ask next — you may ask a better one, but you may',
    '   not skip the topic it covers.',
    '3. Ask exactly one question. Record it with `ask_question` **before** you ask,',
    '   so the rail shows what the project is waiting on.',
    '4. On an answer: `write_answer` → `record_answer` → `record_coverage`.',
    '   On "I don\'t know": `record_unknown`, and move on. It is an answer.',
    '5. Anything you wrote that nobody said: `record_assumption`, with what breaks',
    '   if it is wrong.',
    '',
    '## Where things live',
    '',
    '| | |',
    '| --- | --- |',
    '| The document being filled | `intent.md` |',
    '| Material the person gave you | `sources/` — read it before claiming anything about it |',
    '| Links they paste | **you** download them into `sources/`, then `record_fetch` |',
    '| HTML prototypes | `prototypes/` — they open in Studio\'s own viewer |',
    '| The flow\'s state | `.studio/flow/` — through the tools, never by hand |',
    '| Detector findings | `.studio/quality/reports/` — read, never invent |',
    '',
    '## The four things that get this wrong',
    '',
    '- **Asking more than the destination requires.** A prototype does not get the',
    '  production questionnaire. `flow_state().destinationNeeds` is the list.',
    '- **Filling a section to make it look finished.** An empty section with a',
    '  recorded reason is correct. An invented one is the defect this product was',
    '  built to detect.',
    '- **Batching questions.** One at a time. The person is thinking, not filling in',
    '  a form.',
    '- **Leaving a conclusion in the chat.** If it is not in a file or a tool call,',
    '  it is gone at the end of the session.',
    ''
].join('\n');

/*
 * The intent document a new project starts from — the ten sections of
 * intent-template.md, stubbed and NOT pre-filled. Every heading is present so
 * the document reads as a shape to fill rather than a blank page, and no
 * section contains plausible text: an invented section is a defect, and that
 * rule applies to the template as much as to the agent.
 */
function intentSkeleton(name) {
    const slug = String(name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    return [
        '# Intent — ' + (name || 'New project'),
        '',
        '> This document fills in as questions are answered. Every statement is marked',
        '> `stated` or `assumed`. "I do not know" is a recorded value, not an empty field.',
        '',
        '## 1. Statement',
        '',
        '### 1.1 What is being made',
        '',
        '`cpt-' + slug + '-intent-what` · _not yet answered_',
        '',
        '### 1.2 Who it is for',
        '',
        '`cpt-' + slug + '-intent-audience` · _not yet answered_',
        '',
        '### 1.3 The problem it removes',
        '',
        '`cpt-' + slug + '-intent-problem` · _not yet answered_',
        '',
        '### 1.4 First boundary',
        '',
        '`cpt-' + slug + '-bound-first` · _not yet answered_',
        '',
        '## 2. Destination and depth',
        '',
        '_Not yet set. It decides which later questions exist._',
        '',
        '## 3. Context',
        '',
        '### 3.1 Material already attached',
        '',
        '_Nothing attached yet. Files dropped into `sources/` appear here with what',
        'Studio believes each one is — and nothing is claimed about a file until it',
        'has been read._',
        '',
        '### 3.2 Organisation context',
        '',
        '_Not yet stated._',
        '',
        '## 4. Boundaries and non-goals',
        '',
        '## 5. Success signal',
        '',
        '## 6. Coverage',
        '',
        '_The rail is the record of what was asked. It is not filled by hand._',
        '',
        '## 7. Assumptions',
        '',
        '## 8. Open questions',
        '',
        '_This section is expected to be non-empty. A full intent with nothing open is',
        'suspicious rather than excellent._',
        '',
        '## 9. Gate record',
        '',
        '## 10. Traceability',
        ''
    ].join('\n');
}


/*
 * Where each topic's answer lands in the intent document.
 *
 * The heading text is the address, not a line number and not a section index:
 * a person reorders and renames sections, and both of those must fail visibly
 * (the answer is appended at the end with a note) rather than write into
 * whatever now sits at line 42.
 */
const TOPIC_HEADINGS = {
    what: '### 1.1 What is being made',
    audience: '### 1.2 Who it is for',
    problem: '### 1.3 The problem it removes',
    boundary: '### 1.4 First boundary',
    organisation: '### 3.2 Organisation context',
    success: '## 5. Success signal',
    destination: '## 2. Destination and depth'
};

/*
 * Write an answer into the document, in the person's own words.
 *
 * A direct write, not a proposal — decision 5 of the proposal: they just said
 * it, and asking somebody to accept a diff of their own sentence is theatre.
 * Everything the AGENT authors still arrives as a proposal.
 *
 * Pure, and separate from the file I/O, so tests/flow-spec-test.mjs can pin the
 * three cases that matter: the placeholder is replaced rather than appended to,
 * a second answer to the same topic replaces the first rather than stacking, and
 * a renamed heading does not silently write somewhere else.
 *
 * Returns the new body, or the body unchanged when there is nothing safe to do.
 */
function applyAnswer(body, topicId, value, mark) {
    const heading = TOPIC_HEADINGS[topicId];
    const answer = String(value || '').trim();
    if (!heading || !answer) { return body; }
    const lines = String(body || '').split('\n');
    const at = lines.findIndex(line => line.trim() === heading);
    if (at < 0) {
        /* The heading is gone — renamed, deleted, or this is not our template.
         * Appending under a stated note is honest; guessing a position is not. */
        return String(body || '').replace(/\s*$/, '\n') +
            '\n' + heading + '\n\n' + answer + (mark ? '  \n_' + mark + '_' : '') + '\n';
    }
    /* The block that belongs to this heading: up to the next heading of any
     * level, so a subsection is never swallowed. */
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
        if (/^#{1,6} /.test(lines[i])) { end = i; break; }
    }
    const block = lines.slice(at + 1, end);
    const idLine = block.find(line => /^`cpt-[^`]+`/.test(line.trim()));
    const kept = [];
    if (idLine) {
        /* The ID line carries the stated/assumed mark, and it is the one thing
         * in the block that is not prose. */
        kept.push(idLine.replace(/·.*$/, '· ' + (mark || 'stated')).trim());
    }
    kept.push('');
    kept.push(answer);
    const next = lines.slice(0, at + 1).concat([''], kept, [''], lines.slice(end));
    return next.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = {
    FLOW_ID, SPEC_VERSION, TOPIC_HEADINGS, applyAnswer,
    DESTINATIONS, DESTINATION_LABELS, TOPIC_STATES, EXIT_KINDS, BUCKETS, BASES, BLOCK_LEVELS,
    ACTS, SECTIONS, RAIL_OBJECTS, GATES, TOPICS, PREREQUISITES, QUESTIONS,
    section, gate, topic,
    destinationNeeds, blockingTopics, topicState, topicSettled,
    nextQuestion, gateState, currentSection, coverageRows, prerequisiteRows,
    FLOW_AGENT_DOC, FLOW_SKILL_DOC, intentSkeleton
};
