/*
 * The flow rail — where you are in a green-field project, and the only surface
 * the flow has.
 *
 * STUDIO ASKS NOBODY ANYTHING. The interview belongs to an assistant, in the
 * assistant's own chat, because that is where a person can push back, go
 * sideways, paste half a document and change their mind — none of which a form
 * under a document can do. What Studio owns is the other three quarters: it
 * provisions the project so an agent can work in it (the contract, the skill,
 * the registered tools), it holds the append-only record, and it draws this.
 * An earlier version of this feature put the questions in a band under the
 * document; it demoed well and it was a mock of a conversation, so it is gone.
 *
 * A left panel beside Projects, not a page in the dock, and the reason is the
 * one thing the scenario is explicit about: the centre is a DOCUMENT. The
 * product's document is markdown-editor.js with its own topbar, comment rail,
 * tracked changes, quality marks and figure blocks; a Flow page that owned three
 * columns would have to either nest that widget inside another widget for an
 * hour-long session or reimplement it badly. So the flow takes the column, the
 * document keeps the dock, and every feature already built keeps working with no
 * adapter at all.
 *
 * THE RAIL CHANGES OBJECT BETWEEN ACTS. Intent coverage, then prerequisite
 * coverage and requirements, then the capability ledger, then the composition
 * manifest and the gates. The reference design keeps one rail throughout; ours
 * cannot, because what progress is being made ON changes four times, and a rail
 * that counts topics while the work is capabilities is measuring the wrong noun.
 *
 * THREE RULES IT MUST NOT BREAK, all of them inherited rather than invented:
 *
 *  - FOUR topic states, never three. "I do not know" is a recorded value with an
 *    author and a time; an empty row and a row somebody deliberately could not
 *    fill must not look alike.
 *  - No aggregate number anywhere. Not "78% ready", not a health dot. The
 *    quality feature refuses one on measured grounds (purpose-leak share has a
 *    median of exactly zero across 86 documents) and completeness must never
 *    render as quality: a set can be 3 of 3 present and carry a critical finding.
 *  - Every row is a jump. A topic opens the sentence it was written into; a gate
 *    opens its own record.
 */

const { Widget } = require('@theia/core/shared/@lumino/widgets');
const { URI } = require('@theia/core/lib/common/uri');
const { activeProject } = require('./active-project');
const flowSpec = require('./flow-spec');
const { FlowStore } = require('./flow-store');

const FLOW_RAIL_WIDGET_ID = 'studio-flow-rail';

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
}

/* The four states, spelled the way a person reads them. `open` is the fifth
 * word on screen and deliberately NOT a fifth state: it means nobody has said
 * anything yet, which is the absence of a value rather than a value. */
const STATE_WORDS = {
    'answered': 'answered',
    'assumed': 'assumed',
    'marked-unknown': 'unknown',
    'not-applicable': 'n/a',
    'open': 'open'
};

const GATE_WORDS = { passed: 'passed', waived: 'waived', failed: 'not yet', unreached: '—' };

class FlowRailWidget extends Widget {

    constructor(ctx) {
        super();
        this.workspaceService = ctx.workspaceService;
        this.fileService = ctx.fileService;
        this.openerService = ctx.openerService;
        this.commandRegistry = ctx.commandRegistry;
        this.store = new FlowStore(ctx.fileService, ctx.workspaceService);
        this.disposables = [];
        this.state = undefined;
        this.rootUri = undefined;

        this.id = FLOW_RAIL_WIDGET_ID;
        this.title.label = 'Flow';
        this.title.caption = 'The green-field flow in this project';
        this.title.closable = false;
        this.title.iconClass = 'codicon codicon-checklist';
        this.addClass('studio-flow-rail');

        this.node.innerHTML = '<div class="studio-flow-body" data-flow-body></div>';
        this.body = this.node.querySelector('[data-flow-body]');
        this.node.addEventListener('click', event => this.onClick(event));

        this.disposables.push(activeProject.onChanged(() => this.refresh()));
    }

    onAfterAttach() { this.refresh(); }

    dispose() {
        this.disposables.forEach(d => { try { d.dispose(); } catch (e) { /* going */ } });
        super.dispose();
    }

    async currentRoot() {
        const roots = await this.workspaceService.roots;
        const root = activeProject.resolve(roots);
        return root && root.resource;
    }

    /*
     * Re-read and re-draw.
     *
     * The watcher is rebuilt whenever the project changes, because it is
     * subscribed to one project's `.studio/flow` directory. It fires for this
     * client's own appends as well as anybody else's — a debounce rather than
     * write bookkeeping, exactly as comment-log.js does it, because re-folding
     * is cheap and idempotent while tracking your own writes is neither.
     */
    async refresh() {
        const rootUri = await this.currentRoot();
        const changedProject = String(rootUri) !== String(this.rootUri);
        this.rootUri = rootUri;
        if (changedProject) {
            if (this.watcher) { try { this.watcher.dispose(); } catch (e) { /* going */ } }
            this.watcher = rootUri ? this.store.watch(rootUri, () => this.refresh()) : undefined;
        }
        this.state = rootUri ? await this.store.readState(rootUri) : undefined;
        this.provisioning = rootUri && this.state ? await this.store.provisioning(rootUri) : undefined;
        this.render();
        if (this.onStateChanged) { this.onStateChanged(this.state, rootUri); }
    }

    render() {
        if (!this.rootUri) { this.body.innerHTML = this.emptyHtml('No project is connected.', ''); return; }
        if (!this.state) {
            this.body.innerHTML = this.emptyHtml(
                'This project has no flow.',
                'A flow is the green-field path: an idea, a few questions, and a specification repository at the end. ' +
                'It adds a <code>.studio/flow</code> directory, an <code>intent.md</code> and a <code>sources/</code> ' +
                'folder, and changes nothing else about the project.' +
                /* Two entries, because they answer different situations: a person
                 * with nothing yet needs a folder made for them, and a person who
                 * already connected one needs a flow put into it. Offering only
                 * the first strands the second. */
                '<button class="studio-btn primary" data-flow-act="start-here">Start a flow here</button>' +
                '<button class="studio-btn" data-flow-act="new">New project…</button>');
            return;
        }
        const state = this.state;
        const current = flowSpec.currentSection(state);
        const currentAct = (flowSpec.section(current) || {}).act;
        this.body.innerHTML =
            this.headHtml(state) +
            this.waitingHtml(state) +
            this.sectionsHtml(current) +
            this.railObjectHtml(state, currentAct) +
            this.gatesHtml(state) +
            this.openQuestionsHtml(state) +
            this.provisioningHtml();
    }

    emptyHtml(title, help) {
        return '<div class="studio-flow-empty"><p class="studio-flow-empty-title">' + escapeHtml(title) + '</p>' +
            (help ? '<p class="studio-flow-empty-help">' + help + '</p>' : '') + '</div>';
    }

    headHtml(state) {
        const destination = state.destination
            ? flowSpec.DESTINATION_LABELS[state.destination] || state.destination
            : 'destination not set';
        const kit = state.kit && state.kit.name ? escapeHtml(state.kit.name) + ' kit' : 'no organisation kit';
        return '<header class="studio-flow-head">' +
            '<p class="studio-flow-name">' + escapeHtml(state.name || 'This project') + '</p>' +
            '<p class="studio-flow-sub">' +
            '<button class="studio-flow-chip" data-flow-act="destination" title="Changing it re-opens what its new value requires; nothing already answered is discarded">' +
            escapeHtml(destination) + '</button>' +
            '<span class="studio-flow-kit">' + kit + '</span></p>' +
            '</header>';
    }

    /*
     * What this project is waiting on — the rail's answer to "why has nothing
     * happened".
     *
     * The question an agent recorded with `ask_question` is shown here, plainly
     * marked as a question it asked in its own chat, and NOT answerable here.
     * That distinction is the whole point of the surface: a person who closed
     * the assistant panel, or a colleague who opened this project this morning,
     * can see what is outstanding without a mock of a conversation to answer it
     * in. The answer goes back where the question was asked.
     *
     * When nothing is queued, this shows the question the scenario would ask
     * next — which is a briefing for whoever picks the project up, not a
     * prompt.
     */
    waitingHtml(state) {
        const asked = (state.questions || []).filter(q => q.state === 'open');
        if (asked.length) {
            const rows = asked.map(q =>
                '<div class="studio-flow-asked">' +
                '<p class="studio-flow-asked-text">' + escapeHtml(q.text) + '</p>' +
                (q.by && q.by.name ? '<p class="studio-flow-asked-by">asked by ' + escapeHtml(q.by.name) +
                    ' · answer in the assistant panel</p>' : '') +
                '</div>').join('');
            return this.groupHtml('Waiting on you', rows);
        }
        const next = flowSpec.nextQuestion(state);
        if (!next) { return ''; }
        return this.groupHtml('Next question',
            '<div class="studio-flow-asked pending">' +
            '<p class="studio-flow-asked-text">' + escapeHtml(next.text) + '</p>' +
            '<p class="studio-flow-asked-by">nobody has asked it yet</p></div>' +
            '<button class="studio-btn" data-flow-act="continue">Hand to an assistant</button>',
            'Studio does not ask. It records what was asked and what came back.');
    }

    /*
     * Whether an agent arriving here could actually work.
     *
     * Three rows because there are three failures, and the one that matters is
     * the quiet one: tools missing means an agent does the work and records
     * none of it. Each missing row carries the action that fixes it rather than
     * a sentence telling somebody to go and read something.
     */
    provisioningHtml() {
        const p = this.provisioning;
        if (!p) { return ''; }
        const row = (label, ok, help) =>
            '<div class="studio-flow-row static" title="' + escapeHtml(help) + '">' +
            '<span class="studio-flow-row-name">' + escapeHtml(label) + '</span>' +
            '<span class="studio-flow-state ' + (ok ? 's-answered' : 's-open') + '">' +
            (ok ? 'present' : 'missing') + '</span></div>';
        const rows =
            row('Contract · AGENTS.md, CLAUDE.md', p.contract, 'The rules every agent working in this repository follows.') +
            row('Skill · green-field-flow', p.skill, 'What Claude Code matches when somebody says "continue the flow".') +
            row('Tools · .mcp.json', p.tools, 'The studio-flow MCP server, registered for this project.');
        const missing = !p.contract || !p.skill || !p.tools;
        return this.groupHtml('For agents', rows +
            (missing ? '<button class="studio-btn" data-flow-act="provision">Set this project up for agents</button>' : ''),
            missing ? 'Until the tools are registered an agent can do the work and record none of it.' : '');
    }

    sectionsHtml(current) {
        const parts = ['<nav class="studio-flow-sections">'];
        for (const act of flowSpec.ACTS) {
            parts.push('<p class="studio-flow-act">' + escapeHtml(act.id + ' · ' + act.title) + '</p>');
            for (const id of act.sections) {
                const section = flowSpec.section(id);
                const done = Number(id) < Number(current);
                const isCurrent = id === current;
                const mark = isCurrent ? '▸' : (done ? '✓' : '○');
                parts.push('<button class="studio-flow-section' + (isCurrent ? ' current' : '') + (done ? ' done' : '') +
                    '" data-flow-act="section" data-section="' + id + '" title="' + escapeHtml(section.lede) + '">' +
                    '<span class="studio-flow-mark">' + mark + '</span>' +
                    '<span class="studio-flow-num">' + id + '</span>' +
                    '<span class="studio-flow-title">' + escapeHtml(section.title) + '</span>' +
                    (section.conditional ? '<span class="studio-flow-cond">cond</span>' : '') +
                    '</button>');
            }
        }
        parts.push('</nav>');
        return parts.join('');
    }

    /* The rail's object for this act — the part that changes four times. */
    railObjectHtml(state, act) {
        if (act === 'II') { return this.prerequisitesHtml(state); }
        if (act === 'III') { return this.ledgerHtml(state); }
        if (act === 'IV') { return this.manifestHtml(state); }
        return this.coverageHtml(state);
    }

    coverageHtml(state) {
        const rows = flowSpec.coverageRows(state).map(row =>
            '<button class="studio-flow-row" data-flow-act="topic" data-topic="' + row.id + '"' +
            (row.where && row.where.quote ? ' data-quote="' + escapeHtml(row.where.quote) + '"' : '') + '>' +
            '<span class="studio-flow-row-name">' + escapeHtml(row.title) + '</span>' +
            '<span class="studio-flow-state s-' + row.state + '">' + STATE_WORDS[row.state] + '</span>' +
            '</button>').join('');
        return this.groupHtml('Intent coverage', rows,
            'Four states, and “unknown” is one of them: a recorded value, not an empty field.');
    }

    prerequisitesHtml(state) {
        const rows = flowSpec.prerequisiteRows(state)
            .filter(row => row.required)
            .map(row =>
                '<div class="studio-flow-row static" title="' + escapeHtml(row.why) + '">' +
                '<span class="studio-flow-row-name">' + escapeHtml(row.title) + '</span>' +
                '<span class="studio-flow-state ' + (row.value ? 's-answered' : 's-open') + '">' +
                escapeHtml(row.value || 'open') + '</span></div>').join('');
        const deferred = flowSpec.prerequisiteRows(state).filter(row => !row.required).length;
        return this.groupHtml('Prerequisite coverage', rows,
            deferred ? deferred + ' more are not asked at this destination, and will be asked if it changes.' : '');
    }

    ledgerHtml(state) {
        const owners = new Map((state.owners || []).map(o => [o.cap, o]));
        const rows = (state.capabilities || []).map(cap => {
            const owner = owners.get(cap.id);
            const gap = (state.gaps || []).find(g => g.cap === cap.id);
            const exit = gap && (state.exits || []).find(e => e.gap === gap.id);
            const word = owner ? owner.bucket : (gap ? (exit ? 'routed' : 'gap') : 'unasked');
            return '<div class="studio-flow-row static">' +
                '<span class="studio-flow-row-name">' + escapeHtml(cap.text || cap.id) + '</span>' +
                '<span class="studio-flow-state b-' + escapeHtml(word) + '">' + escapeHtml(word) + '</span></div>';
        }).join('');
        return this.groupHtml('Capability ledger', rows || this.noneHtml('No capability has been asked about yet.'),
            'Asked from the domain toward the platform. There is no catalogue to browse.');
    }

    manifestHtml(state) {
        const rows = (state.owners || []).map(owner =>
            '<div class="studio-flow-row static">' +
            '<span class="studio-flow-row-name">' + escapeHtml(owner.block || owner.cap) + '</span>' +
            '<span class="studio-flow-state b-' + escapeHtml(owner.bucket) + '">' + escapeHtml(owner.bucket) + '</span></div>').join('');
        const options = (state.options || []).map(option =>
            '<div class="studio-flow-row static">' +
            '<span class="studio-flow-row-name">' + escapeHtml(option.name) + '</span>' +
            '<span class="studio-flow-basis">' + escapeHtml(option.time || '—') + ' · ' + escapeHtml(option.timeBasis || '') + '</span></div>').join('');
        return this.groupHtml('Composition manifest', rows || this.noneHtml('Nothing composed yet.')) +
            (options ? this.groupHtml('Ways to build it', options, 'Every number states its basis.') : '');
    }

    gatesHtml(state) {
        const rows = flowSpec.GATES.map(gate => {
            const value = flowSpec.gateState(state, gate.id);
            return '<button class="studio-flow-row" data-flow-act="gate" data-gate="' + gate.id + '" title="' +
                escapeHtml(gate.condition + (gate.waivableBy ? '' : ' Nobody can waive this.')) + '">' +
                '<span class="studio-flow-row-name"><b>' + gate.id + '</b> ' + escapeHtml(gate.title) + '</span>' +
                '<span class="studio-flow-state g-' + value + '">' + GATE_WORDS[value] + '</span></button>';
        }).join('');
        return this.groupHtml('Gates', rows);
    }

    openQuestionsHtml(state) {
        const open = (state.openQuestions || []).filter(q => !q.closed);
        if (!open.length) { return ''; }
        const rows = open.map(q =>
            '<div class="studio-flow-row static">' +
            '<span class="studio-flow-row-name">' + escapeHtml(q.text) + '</span>' +
            '<span class="studio-flow-basis">blocks ' + escapeHtml(q.blocks || 'architecture') + '</span></div>').join('');
        return this.groupHtml('Open questions', rows,
            'Expected to be non-empty. A full intent with nothing open is suspicious rather than excellent.');
    }

    groupHtml(title, rows, note) {
        return '<section class="studio-flow-group">' +
            '<p class="studio-flow-group-title">' + escapeHtml(title) + '</p>' + rows +
            (note ? '<p class="studio-flow-note">' + escapeHtml(note) + '</p>' : '') + '</section>';
    }

    noneHtml(text) { return '<p class="studio-flow-none">' + escapeHtml(text) + '</p>'; }

    async onClick(event) {
        const target = event.target.closest('[data-flow-act]');
        if (!target) { return; }
        const act = target.getAttribute('data-flow-act');
        if (act === 'new') { this.commandRegistry.executeCommand('studio.flow.new'); return; }
        if (act === 'start-here') { this.commandRegistry.executeCommand('studio.flow.start-here'); return; }
        if (act === 'destination') { this.commandRegistry.executeCommand('studio.flow.destination'); return; }
        if (act === 'continue') { this.commandRegistry.executeCommand('studio.flow.continue'); return; }
        if (act === 'provision') { this.commandRegistry.executeCommand('studio.flow.provision'); return; }
        if (act === 'topic' || act === 'section' || act === 'gate') { this.openIntent(target.getAttribute('data-quote')); }
    }

    /*
     * Every row is a jump, and the destination is the document — not a modal and
     * not a detail panel. The quote is passed through so the editor's own
     * find-by-quote can reveal the sentence; without one, the document itself is
     * still the right answer, because that is where the work is.
     */
    async openIntent(quote) {
        if (!this.rootUri || !this.state) { return; }
        const rel = (this.state.documents && this.state.documents.intent) || 'intent.md';
        const uri = new URI(this.rootUri.toString() + '/' + rel);
        try {
            const opener = await this.openerService.getOpener(uri);
            await opener.open(uri);
        } catch (e) {
            console.warn('[studio] could not open the intent document', e);
        }
    }
}

const FLOW_RAIL_CSS = `
.studio-flow-rail { display:flex; flex-direction:column; height:100%; min-width:0; background:var(--studio-surface, #fff); color:var(--studio-text, #1f2328); }
.studio-flow-body { flex:1; overflow-y:auto; padding-bottom:20px; }
.studio-flow-head { padding:16px 14px 12px; border-bottom:1px solid var(--studio-line, #e1e4e8); }
.studio-flow-name { margin:0; font:600 14px/1.3 inherit; }
.studio-flow-sub { margin:6px 0 0; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.studio-flow-chip { border:1px solid var(--studio-line, #e1e4e8); border-radius:999px; background:var(--studio-surface-raised, #fafbfc); color:var(--studio-text, #1f2328); cursor:pointer; font:600 10.5px/1 inherit; letter-spacing:.04em; padding:4px 9px; text-transform:uppercase; }
.studio-flow-chip:hover { border-color:var(--studio-amber, #d59b3b); }
.studio-flow-kit { color:var(--studio-muted, #9298a8); font-size:11px; }
.studio-flow-sections { display:flex; flex-direction:column; padding:10px 8px 4px; }
.studio-flow-act { margin:10px 6px 4px; color:var(--studio-muted, #9298a8); font:700 9.5px/1 inherit; letter-spacing:.13em; text-transform:uppercase; }
.studio-flow-section { display:flex; align-items:center; gap:7px; width:100%; border:0; border-radius:5px; background:transparent; color:var(--studio-text, #1f2328); cursor:pointer; font:400 12.5px/1.35 inherit; padding:5px 6px; text-align:left; }
.studio-flow-section:hover { background:var(--studio-selection-bg, #e9edfb); }
.studio-flow-section.current { background:var(--studio-selection-bg, #e9edfb); font-weight:600; }
.studio-flow-section.done .studio-flow-title { color:var(--studio-muted, #9298a8); }
.studio-flow-mark { width:10px; color:var(--studio-muted, #9298a8); flex:none; }
.studio-flow-section.current .studio-flow-mark { color:var(--studio-amber, #d59b3b); }
.studio-flow-num { color:var(--studio-muted, #9298a8); font-variant-numeric:tabular-nums; flex:none; font-size:11px; }
.studio-flow-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-flow-cond { margin-left:auto; color:var(--studio-muted, #9298a8); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; }
.studio-flow-group { padding:12px 14px 4px; border-top:1px solid var(--studio-line, #e1e4e8); margin-top:10px; }
.studio-flow-group-title { margin:0 0 6px; color:var(--studio-muted, #9298a8); font:700 9.5px/1 inherit; letter-spacing:.13em; text-transform:uppercase; }
.studio-flow-row { display:flex; align-items:baseline; gap:8px; width:100%; border:0; background:transparent; color:var(--studio-text, #1f2328); cursor:pointer; font:400 12px/1.5 inherit; padding:3px 0; text-align:left; }
.studio-flow-row.static { cursor:default; }
.studio-flow-row:not(.static):hover .studio-flow-row-name { text-decoration:underline; }
.studio-flow-row-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-flow-state { flex:none; font-size:10.5px; letter-spacing:.02em; color:var(--studio-muted, #9298a8); }
/* State is carried by the WORD; colour only reinforces it, so a reader who
   cannot separate two greys still reads "unknown". */
.studio-flow-state.s-answered, .studio-flow-state.g-passed { color:var(--studio-positive, #1a7f4b); }
.studio-flow-state.s-assumed, .studio-flow-state.g-waived { color:var(--studio-amber, #b5651d); }
.studio-flow-state.s-marked-unknown { color:var(--studio-text, #1f2328); font-style:italic; }
.studio-flow-state.g-failed { color:var(--studio-muted, #9298a8); }
.studio-flow-state.b-paper { color:var(--studio-danger, #c43d36); }
.studio-flow-state.b-take-as-is { color:var(--studio-positive, #1a7f4b); }
.studio-flow-basis { flex:none; color:var(--studio-muted, #9298a8); font-size:10.5px; }
.studio-flow-note, .studio-flow-none { margin:6px 0 0; color:var(--studio-muted, #9298a8); font-size:11px; line-height:1.45; }
.studio-flow-empty { padding:22px 16px; }
.studio-flow-empty-title { margin:0 0 8px; font:600 13px/1.4 inherit; }
.studio-flow-empty-help { margin:0 0 14px; color:var(--studio-muted, #9298a8); font-size:12px; line-height:1.5; }
.studio-flow-empty-help code { font-size:11px; }
.studio-flow-empty .studio-btn { margin-top:4px; margin-right:6px; }
.studio-flow-asked { border-left:2px solid var(--studio-amber, #d59b3b); padding:2px 0 2px 9px; margin:2px 0 8px; }
.studio-flow-asked.pending { border-left-color:var(--studio-line, #e1e4e8); }
.studio-flow-asked-text { margin:0; font:400 12.5px/1.45 inherit; }
.studio-flow-asked-by { margin:3px 0 0; color:var(--studio-muted, #9298a8); font-size:10.5px; }
.studio-flow-group .studio-btn { margin-top:8px; }
`;

module.exports = { FlowRailWidget, FLOW_RAIL_CSS, FLOW_RAIL_WIDGET_ID };
