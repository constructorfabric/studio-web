/*
 * The flow on disk: `<root>/.studio/flow/`.
 *
 *   flow.json              what this flow is — written once, edited rarely
 *   <authorKey>.jsonl      append-only ops, ONE FILE PER AUTHOR
 *
 * The per-author rule is the whole design, and it is comment-log.js's rule for
 * comment-log.js's reason: a person answering in the dock and an agent appending
 * through the MCP server would otherwise share a file and lose each other's
 * writes. Two writers never share a file here, so a read-modify-write of MY OWN
 * log cannot be stale with respect to anybody but me.
 *
 * Nothing derived is persisted. There is no index and no cached state: the fold
 * is cheap (flow-log.js is pure and the files are small), and a cache would be a
 * second answer to "what is the state of this project" that goes stale exactly
 * when two people are working at once.
 *
 * WHY A PROJECT IS DETECTED BY A DIRECTORY. `hasFlow` is one `exists` call on
 * `.studio/flow/flow.json`. A project with no flow sees no rail tile, no dock
 * and no changed behaviour anywhere — which is what makes this a feature rather
 * than a mode the product is in.
 */

const { URI } = require('@theia/core/lib/common/uri');
const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
const flowLog = require('./flow-log');
const flowSpec = require('./flow-spec');
const { flowTools } = require('./flow-tools-client');
const { identity } = require('./identity');
const { fileTypeSettings } = require('./file-type-settings');

const FLOW_DIR = '.studio/flow';
const FLOW_FILE = 'flow.json';
const LOG_SUFFIX = '.jsonl';
const WATCH_DEBOUNCE_MS = 120;

function authorRecord(who) {
    const record = who || identity.current();
    return { id: record.id, name: record.name, kind: record.kind, key: record.key };
}

function newId(prefix) {
    const rand = globalThis.crypto && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID().slice(0, 8)
        : Math.floor(Math.random() * 1e8).toString(36);
    return (prefix || 'f') + '-' + Date.now().toString(36) + '-' + rand;
}

class FlowStore {

    /*
     * NO EDITOR HANDLE, AND THAT IS THE DESIGN.
     *
     * Studio does not put prose into a person's document. It writes the
     * skeleton once, provisions what an agent needs to work here, records ops,
     * and reads. Everything else arrives the way any other content arrives in
     * this product — an agent's edit, captured as a proposal by
     * markdown-editor.js, or the person's own typing.
     *
     * The earlier version of this file did write answers into `intent.md`, and
     * the packaged build reported exactly why that is somebody else's job:
     * markdown-editor.js treats any write to a file it has open as an
     * assistant's edit, so the write survived while the document was closed and
     * reverted the instant it was open. That is the correct behaviour for an
     * agent's edit. It is the wrong shape for a product surface, and the answer
     * was to stop having one.
     */
    constructor(fileService, workspaceService) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
    }

    dirUri(rootUri) { return new URI(rootUri.toString() + '/' + FLOW_DIR); }
    flowUri(rootUri) { return new URI(this.dirUri(rootUri).toString() + '/' + FLOW_FILE); }
    myLogUri(rootUri) { return new URI(this.dirUri(rootUri).toString() + '/' + identity.current().key + LOG_SUFFIX); }
    documentUri(rootUri, relPath) { return new URI(rootUri.toString() + '/' + String(relPath).replace(/^\//, '')); }

    async hasFlow(rootUri) {
        if (!rootUri) { return false; }
        try { return await this.fileService.exists(this.flowUri(rootUri)); }
        catch (e) { return false; }
    }

    async readFlowJson(rootUri) {
        try {
            const uri = this.flowUri(rootUri);
            if (!(await this.fileService.exists(uri))) { return undefined; }
            return JSON.parse((await this.fileService.read(uri)).value);
        } catch (e) {
            console.warn('[studio] could not read flow.json', e);
            return undefined;
        }
    }

    /** Every author's log, as `{ fileName: body }` — what flow-log folds. */
    async readLogs(rootUri) {
        const files = {};
        const dir = this.dirUri(rootUri);
        try {
            if (!(await this.fileService.exists(dir))) { return files; }
            const stat = await this.fileService.resolve(dir, { resolveMetadata: false });
            for (const child of stat.children || []) {
                if (child.isDirectory || !child.name.endsWith(LOG_SUFFIX)) { continue; }
                try { files[child.name] = (await this.fileService.read(child.resource)).value || ''; }
                catch (e) { console.warn('[studio] could not read a flow log', child.name, e); }
            }
        } catch (e) {
            console.warn('[studio] could not list the flow directory', e);
        }
        return files;
    }

    /**
     * The whole state: flow.json's facts, then the fold on top.
     *
     * flow.json is FIRST and the ops win, so a `destination` op recorded later
     * supersedes the value the project was created with — changing the
     * destination re-opens what its new value requires and discards nothing.
     */
    async readState(rootUri) {
        const meta = await this.readFlowJson(rootUri);
        if (!meta) { return undefined; }
        const folded = flowLog.foldFiles(await this.readLogs(rootUri));
        return {
            ...folded,
            flow: meta.flow || flowSpec.FLOW_ID,
            spec: meta.spec || flowSpec.SPEC_VERSION,
            name: meta.name,
            createdAt: meta.createdAt,
            createdBy: meta.createdBy,
            destination: folded.destination || meta.destination,
            kit: folded.kit || meta.kit,
            documents: { ...(meta.documents || {}), ...folded.documents },
            root: rootUri.toString()
        };
    }

    /**
     * Append one op to MY OWN log.
     *
     * Validation happens HERE as well as in the MCP server, because both are
     * writers and a rule enforced in one writer is not a rule. A refusal is
     * returned rather than thrown: every caller has a surface to report it on,
     * and none of them should lose the rest of their work over one bad op.
     */
    async append(rootUri, op, context) {
        const verdict = flowLog.validateOp(op, { actor: (context && context.actor) || 'person' });
        if (!verdict.ok) {
            console.warn('[studio] refused a flow op:', verdict.reason, op);
            return { ok: false, reason: verdict.reason };
        }
        identity.seal();
        const record = { ...op };
        if (!record.at) { record.at = new Date().toISOString(); }
        if (!record.by) { record.by = authorRecord(); }
        const uri = this.myLogUri(rootUri);
        const line = JSON.stringify(record) + '\n';

        let existing = '';
        try {
            if (await this.fileService.exists(uri)) { existing = (await this.fileService.read(uri)).value || ''; }
        } catch (e) {
            console.warn('[studio] could not read my flow log; appending to a fresh one', e);
        }
        /* A previous write that lost its trailing newline must not glue two ops
         * onto one line and cost both. Same guard as comment-log.js. */
        const body = existing && !existing.endsWith('\n') ? existing + '\n' + line : existing + line;
        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
        }
        return { ok: true, record };
    }

    // -- watching -------------------------------------------------------------

    /*
     * The DIRECTORY is watched, not my own file: the interesting writes are
     * somebody else's — an agent appending through the MCP server, or a
     * colleague's log arriving in a pull. `onDidFilesChange` only reports what
     * something has asked to watch, so `watch(dir)` is what makes the
     * subscription real rather than decorative. Debounced rather than
     * write-tracked: re-folding is cheap and idempotent, so reacting to my own
     * write costs nothing and removes a whole class of bookkeeping bugs.
     */
    watch(rootUri, onChange) {
        const disposables = [];
        const dir = this.dirUri(rootUri);
        try { disposables.push(this.fileService.watch(dir)); }
        catch (e) { console.warn('[studio] could not watch the flow directory', e); }
        try { disposables.push(this.fileService.watch(new URI(rootUri.toString() + '/.studio'))); }
        catch (e) { /* the parent may not exist yet; the directory watch above is the real one */ }

        let timer;
        disposables.push(this.fileService.onDidFilesChange(event => {
            const touched = event.changes && event.changes.some(change =>
                change.resource.toString().startsWith(dir.toString()));
            if (!touched) { return; }
            clearTimeout(timer);
            timer = setTimeout(() => onChange(), WATCH_DEBOUNCE_MS);
        }));
        return { dispose: () => { clearTimeout(timer); disposables.forEach(d => { try { d.dispose(); } catch (e) { /* going */ } }); } };
    }

    // -- creating one ---------------------------------------------------------

    /**
     * Make a green-field project on disk.
     *
     * The scenario's own premise is that there is no repository yet, so the only
     * entry point the product had — a folder chooser — could not start one. What
     * this writes is a SHAPE, never content: every section of the intent is
     * present and empty, because an invented section is a defect and that rule
     * applies to a template as much as to an agent.
     *
     * `git init` is deliberately NOT run here. The frontend has no process to
     * run it in, the folder is a perfectly good project without it, and the git
     * extension offers "Initialize Repository" on a folder that has none — which
     * is a better place for that decision than a wizard that assumes it.
     */
    async createProject(parentUri, name, destination) {
        const folderName = String(name || 'new-project').trim().replace(/[/\\:*?"<>|]/g, '-');
        const rootUri = new URI(parentUri.toString() + '/' + encodeURIComponent(folderName));

        if (await this.fileService.exists(rootUri)) {
            const stat = await this.fileService.resolve(rootUri, { resolveMetadata: false });
            if (stat.children && stat.children.length) {
                return { ok: false, reason: 'That folder already exists and is not empty. Pick a name that is not in use, or connect the folder as an ordinary project.' };
            }
        } else {
            await this.fileService.createFolder(rootUri);
        }
        return this.writeSkeleton(rootUri, folderName, destination);
    }

    /**
     * Start a flow in a folder that already exists.
     *
     * The second entry point, and it is not a convenience: a person who has
     * already connected an empty folder — or who wants to put a flow beside work
     * that has begun — cannot use "New project…", which insists on creating a
     * directory. It refuses rather than merges when a flow is already there,
     * because there is exactly one flow per project and a second `flow.json`
     * would make "what is the destination" a question with two answers.
     */
    async startHere(rootUri, name, destination) {
        if (await this.hasFlow(rootUri)) {
            return { ok: false, reason: 'This project already has a flow. Its rail is on the left.' };
        }
        return this.writeSkeleton(rootUri, name || rootUri.path.base, destination);
    }

    /*
     * Everything an agent needs to work in this project, written into it.
     *
     * THIS IS THE FEATURE. Studio's part of a green-field flow is not asking
     * questions; it is making a folder that an agent can walk into and be
     * immediately correct in — the rules it must follow, the procedure it should
     * run, and a channel through which what it learns becomes shared state
     * instead of a transcript.
     *
     * Separate from `writeSkeleton` and callable on its own, because it is the
     * repair as well as the creation: a project cloned from git has the contract
     * and the skill (they are tracked files) and a `.mcp.json` whose absolute
     * path belongs to somebody else's machine. Running this again fixes exactly
     * that, and cannot damage anything — every write skips a file that exists,
     * and the registration only adds a key that is not there.
     */
    async provision(rootUri) {
        const write = async (rel, body) => {
            const uri = this.documentUri(rootUri, rel);
            if (await this.fileService.exists(uri)) { return false; }
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: false });
            return true;
        };
        try { await this.fileService.createFolder(new URI(rootUri.toString() + '/.claude/skills/green-field-flow')); }
        catch (e) { /* already there */ }
        /*
         * The two ambient contracts, byte-identical because they are the same
         * contract: `AGENTS.md` is what Codex and most other agents read,
         * `CLAUDE.md` is what Claude Code reads. Two files rather than a symlink
         * — a symlink does not survive a zip, a Windows checkout or a copy, and
         * a contract that silently is not there is the whole failure mode this
         * feature exists to avoid.
         */
        const wrote = [];
        if (await write('AGENTS.md', flowSpec.FLOW_AGENT_DOC + '\n')) { wrote.push('AGENTS.md'); }
        if (await write('CLAUDE.md', flowSpec.FLOW_AGENT_DOC + '\n')) { wrote.push('CLAUDE.md'); }
        // The addressed half: a skill Claude Code matches when somebody says
        // "continue the flow". See the header of FLOW_SKILL_DOC.
        if (await write('.claude/skills/green-field-flow/SKILL.md', flowSpec.FLOW_SKILL_DOC)) {
            wrote.push('.claude/skills/green-field-flow/SKILL.md');
        }
        const registered = await this.registerTools(rootUri, write);
        if (registered.ok && !registered.already) { wrote.push('.mcp.json'); }
        return { ok: true, wrote, registered };
    }

    /*
     * What an agent arriving in this project would actually find.
     *
     * Three separate answers, never rolled into one "set up ✓", because they
     * fail separately and are fixed separately: the ambient contract, the
     * addressed skill, and the tools. A project with the contract and no tools
     * is a project where an agent will do the right work and record none of it,
     * and that reads as success until somebody opens the rail a week later.
     */
    async provisioning(rootUri) {
        const has = async rel => {
            try { return await this.fileService.exists(this.documentUri(rootUri, rel)); }
            catch (e) { return false; }
        };
        const [agents, claude, skill, mcp] = await Promise.all([
            has('AGENTS.md'), has('CLAUDE.md'),
            has('.claude/skills/green-field-flow/SKILL.md'), has('.mcp.json')
        ]);
        let tools = false;
        if (mcp) {
            try {
                const parsed = JSON.parse((await this.fileService.read(this.documentUri(rootUri, '.mcp.json'))).value || '{}');
                tools = !!(parsed && parsed.mcpServers && parsed.mcpServers['studio-flow']);
            } catch (e) { tools = false; }
        }
        return { contract: agents && claude, partialContract: agents !== claude, skill, tools };
    }

    /*
     * Register the flow's MCP server with the assistants that will work here.
     *
     * This is the difference between a project that has instructions in it and a
     * project an agent can actually work in. `.mcp.json` is the project-scoped
     * registration Claude Code reads on startup; writing it is not a permission
     * grant — the assistant still asks before it starts a project server, which
     * is the prompt that should exist and is not ours to suppress. What Studio
     * removes is the part nobody should have to do by hand: knowing where the
     * server lives inside an installed application.
     *
     * BOTH VALUES GO IN AS `${VAR:-default}`. The default is this machine's
     * absolute path, which is what makes it work immediately; the variable is
     * what keeps the file worth committing, because a colleague who checks the
     * repository out somewhere else sets `STUDIO_FLOW_MCP` instead of editing a
     * tracked file. A path baked in with no way past it is a file every team
     * ends up gitignoring, and then nobody has the tools.
     *
     * IT DOES NOT OVERWRITE. A `.mcp.json` that is already here belongs to
     * whoever wrote it. If it has no `studio-flow` entry the entry is added and
     * everything else is left exactly as it was; if it has one, nothing happens
     * at all.
     */
    async registerTools(rootUri, write) {
        let tools;
        try { tools = await flowTools.describe(); }
        catch (e) { tools = { ok: false, why: (e && e.message) || 'the flow tools service did not answer' }; }
        if (!tools || !tools.ok || !tools.server) {
            /* No registration rather than a broken one. The flow still works:
             * the contract and the skill are files, and REGISTER.md documents
             * the command line by hand. */
            return { ok: false, why: (tools && tools.why) || 'the flow MCP server could not be located' };
        }
        const runtime = tools.runtime || {};
        const entry = {
            command: '${STUDIO_FLOW_NODE:-' + (runtime.command || 'node') + '}',
            args: ['${STUDIO_FLOW_MCP:-' + tools.server + '}'],
            env: { ...(runtime.env || {}), STUDIO_AGENT: '${STUDIO_AGENT:-assistant}' }
        };
        const uri = new URI(rootUri.toString() + '/.mcp.json');
        let config = { mcpServers: {} };
        let existed = false;
        try {
            if (await this.fileService.exists(uri)) {
                existed = true;
                const parsed = JSON.parse((await this.fileService.read(uri)).value || '{}');
                config = parsed && typeof parsed === 'object' ? parsed : {};
                if (!config.mcpServers || typeof config.mcpServers !== 'object') { config.mcpServers = {}; }
            }
        } catch (e) {
            /* Unparseable, and somebody wrote it. Refusing is the only safe
             * answer: rewriting it would silently drop whatever else it
             * registered. */
            return { ok: false, why: '.mcp.json is already here and could not be parsed, so it was left alone: ' + ((e && e.message) || 'invalid JSON') };
        }
        if (config.mcpServers['studio-flow']) { return { ok: true, already: true, server: tools.server }; }
        config.mcpServers['studio-flow'] = entry;
        const body = JSON.stringify(config, undefined, 2) + '\n';
        if (existed) {
            await this.fileService.write(uri, body);
        } else {
            await write('.mcp.json', body);
        }
        return { ok: true, server: tools.server, merged: existed };
    }

    /** The shape both entry points write. Files only; never `git init`. */
    async writeSkeleton(rootUri, name, destination) {
        const folderName = String(name || 'new-project').trim();
        const write = async (rel, body) => {
            const uri = new URI(rootUri.toString() + '/' + rel);
            /* `overwrite: false`, so starting a flow beside existing work cannot
             * destroy a README somebody wrote. A file that is already there is
             * left exactly as it is. */
            if (await this.fileService.exists(uri)) { return; }
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: false });
        };
        await this.fileService.createFolder(new URI(rootUri.toString() + '/sources'));
        await this.fileService.createFolder(new URI(rootUri.toString() + '/prototypes'));

        const now = new Date().toISOString();
        const meta = {
            version: 1,
            flow: flowSpec.FLOW_ID,
            spec: flowSpec.SPEC_VERSION,
            name: folderName,
            destination: destination || undefined,
            createdAt: now,
            createdBy: authorRecord(),
            documents: { intent: 'intent.md' }
        };

        await write('intent.md', flowSpec.intentSkeleton(folderName));
        const registered = (await this.provision(rootUri)).registered;
        await write('sources/README.md', [
            '# Sources',
            '',
            'Material that already existed when this project started: notes, decks, chat',
            'logs, draft requirements. Drop files in here, or paste a link and let the',
            'agent fetch it.',
            '',
            'Nothing here is parsed on arrival and nothing is claimed about a file until',
            'somebody — or an agent — has actually read it and said so.',
            ''
        ].join('\n'));
        await write('prototypes/README.md', [
            '# Prototypes',
            '',
            'HTML prototypes on partly mocked data. They open in Studio\'s own viewer,',
            'where a comment can be left on a component of the rendered page rather than',
            'on a line of its source.',
            ''
        ].join('\n'));
        await write('.gitignore', ['.studio/flow/index.json', '.DS_Store', ''].join('\n'));
        await this.fileService.createFile(this.flowUri(rootUri), BinaryBuffer.fromString(JSON.stringify(meta, null, 2) + '\n'), { overwrite: false });

        /*
         * Turn the feature on for THIS project, in the project's own committed
         * settings.
         *
         * Gear-based development is hidden by default (file-type-settings.js),
         * and a person who has just started a flow has asked for it about as
         * plainly as it can be asked. Writing it here rather than at the two
         * call sites is what makes the answer travel: the next person to clone
         * this repository gets the Flow tab without having to discover a setting
         * to explain the files they can already see.
         *
         * Merged, not written over — setGearFlow re-reads the file first, so a
         * flow started beside an existing `.studio/settings.json` keeps its
         * file-type list and its saving policy.
         */
        try {
            await fileTypeSettings.setGearFlow(rootUri, true);
        } catch (e) {
            console.warn('[studio] the flow was written but the project setting could not be', e);
        }

        if (destination) { await this.append(rootUri, { op: 'destination', value: destination }); }
        await this.append(rootUri, { op: 'document', role: 'intent', path: 'intent.md' });
        return { ok: true, rootUri, meta, registered };
    }
}

module.exports = { FlowStore, FLOW_DIR, FLOW_FILE, newId, authorRecord };
