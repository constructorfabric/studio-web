/*
 * Comment persistence, take two: per-author append-only op logs, folded on read.
 *
 * WHAT WAS WRONG WITH comments-store.js. It serialises the WHOLE thread array
 * with one `fileService.write` and no compare-and-swap. Two parties commenting
 * on the same document therefore race at the level of the entire file: both
 * load `{threads:[…]}`, both append their own thread in memory, both write, and
 * the second write silently destroys the first party's thread. Nothing reports
 * it — not the UI, not git, because the loser's line was never on disk to
 * conflict with. Measured directly (see comment-log-test.mjs, case 1): with the
 * old store, "A's thread survived: false".
 *
 * A file lock would not fix it either, because the two writers are not
 * necessarily on the same machine: the sidecar is committed, so the other
 * writer may be a colleague on a branch, or an agent in a different process.
 * The fix has to be a data-model fix.
 *
 * THE LAYOUT. One log file per party, named after that party's identity key:
 *
 *   <root>/.studio/comments/docs/prd.md/local-roma.jsonl
 *   <root>/.studio/comments/docs/prd.md/agent-claude.jsonl
 *
 * Note that `docs/prd.md` here is a DIRECTORY named after the document, while
 * the legacy sidecar is the FILE `.studio/comments/docs/prd.md.json`. Both
 * coexist on purpose (see the migration note below).
 *
 * Because I only ever write the file named after MY key, and nobody else ever
 * writes that file, a lost update is not merely unlikely — it is structurally
 * impossible. There is no shared mutable cell to race over. Two logs written
 * independently on two machines merge the way two appended files merge in git:
 * both halves survive, and the fold puts them in one order.
 *
 * APPEND-ONLY, WITH TOMBSTONES. Deleting a thread or retracting a message
 * writes a `delete` / `retract` op that the fold honours; it never rewrites or
 * truncates a log file. That is what "a log cannot forget" means, and it is not
 * pedantry: rewriting a file to drop a line is exactly the whole-file overwrite
 * this module exists to stop doing, and it would delete a concurrent writer's
 * lines along with the one being retracted.
 *
 * MIGRATION IS NON-DESTRUCTIVE. Threads already committed in the legacy
 * `.json` sidecar are read as the BASE LAYER and folded ops are applied on top.
 * That file is never deleted, moved, or rewritten — it is committed data, and a
 * migration that mutates committed data on read is a migration that loses it
 * when it is wrong. New writes go only to `.jsonl` logs, so the sidecar simply
 * stops growing. A legacy thread whose id also appears in the logs is the SAME
 * thread; log ops win for the fields they set.
 *
 * WHAT DOES NOT CHANGE: the in-memory thread shape. The UI (markdown-editor.js,
 * html-viewer.js, comment-ui.js) and every regression suite already read
 *   { id, scope, quote, occurrence, resolved, messages:[{author, at, body}] }
 * and the fold produces exactly that, plus `messages[].by` (the structured
 * record from identity.js) and `messages[].id` (needed to address a retract).
 * `author` stays the display string, so nothing downstream has to change on the
 * day this ships. The store changes; the shape does not.
 *
 * Anchoring is unchanged too: quoted text plus occurrence index, per
 * comments-store.js's reasoning.
 */

const { URI } = require('@theia/core/lib/common/uri');
const { newId, sidecarUri } = require('./comments-store');
const { identity, authorRecord } = require('./identity');

/* Re-folding is cheap and idempotent, so the watcher debounces rather than
 * tracking its own writes — see watch(). */
const WATCH_DEBOUNCE_MS = 150;

const LOG_SUFFIX = '.jsonl';

/* The directory the watcher subscribes to — see watch() on why it is this and
 * not the per-document log directory. Mirrors comments-store.js's SIDECAR_DIR,
 * which is not exported. */
const SIDECAR_ROOT = '.studio/comments';

/*
 * The log directory for a document: the legacy sidecar path with its trailing
 * '.json' removed.
 *
 * Derived rather than recomputed on purpose. The relative-path rule (strip the
 * root prefix, fall back to the basename for a document outside every root)
 * lives in exactly one place — comments-store.js's sidecarUri — so the two
 * layouts cannot drift apart and start disagreeing about where a document's
 * comments are. Only one trailing '.json' is stripped, so a document that is
 * itself called data.json lands in `…/data.json/`, which is correct.
 */
function logDirUri(rootUri, docUri) {
    return new URI(sidecarUri(rootUri, docUri).toString().replace(/\.json$/, ''));
}

/* My own log file, and the only file this module ever writes. */
function myLogUri(rootUri, docUri) {
    return new URI(logDirUri(rootUri, docUri).toString() + '/' + identity.current().key + LOG_SUFFIX);
}

/* Message ids are minted in the same shape as thread ids (comments-store.js's
 * newId), with an 'm-' prefix so a mis-wired call site is obvious in the data
 * rather than silently addressing a thread as a message. */
function messageId() {
    return 'm-' + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) +
        '-' + (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.floor(Math.random() * 1e6).toString(36));
}

/*
 * A message id that both machines will independently agree on.
 *
 * Ops that carry no explicit message id — an `open`, and every message already
 * sitting in a legacy sidecar — get a DERIVED id rather than a freshly minted
 * one. Minting during a fold would give the same message a different id on
 * every read and on every machine, and a `retract` naming that id would then
 * refer to nothing. Derived ids are positional and stable, which is what makes
 * "retract the second legacy message" a statement two clients can both honour.
 */
function derivedMessageId(threadId, index) {
    return threadId + '-m' + index;
}

/* Only the canonical keys, in the order the UI's own literals use them.
 * Anything else a legacy sidecar happens to carry is dropped here rather than
 * leaking a second, wider shape into the surfaces.
 *
 * `anchor` is canonical but optional, and is NOT set here. It is the rendered-
 * page surface's anchoring model (html-viewer.js: {type, path, tag, describe,
 * snippet}), exactly parallel to quote+occurrence for Markdown — a DOM path
 * cannot be expressed as a quote, and a quote cannot be expressed as a DOM
 * path. Dropping it, which is what this function did at first, silently
 * destroys every comment on every rendered page: the thread survives the fold
 * and its card then has nothing to attach to. Carried through wherever a
 * thread is built, never invented. */
function blankThread(id) {
    return { id, scope: 'inline', quote: '', occurrence: 0, resolved: false, messages: [] };
}

function normaliseMessage(m, threadId, index) {
    const record = authorRecord(m.by || m.author);
    return {
        id: m.id || derivedMessageId(threadId, index),
        /* The display string stays the display string. comment-ui.js prefers
         * `by` when it is present and falls back to `author`, so both have to
         * be right — and a folded message must be indistinguishable from one
         * the old store produced. */
        author: m.author || record.name,
        at: m.at,
        body: m.body,
        by: record
    };
}

function legacyThread(t) {
    const thread = blankThread(t.id);
    if (t.scope !== undefined) { thread.scope = t.scope; }
    if (t.quote !== undefined) { thread.quote = t.quote; }
    if (t.occurrence !== undefined) { thread.occurrence = t.occurrence; }
    if (t.anchor !== undefined) { thread.anchor = t.anchor; }
    thread.resolved = !!t.resolved;
    thread.messages = (Array.isArray(t.messages) ? t.messages : [])
        .map((m, i) => normaliseMessage(m, t.id, i));
    return thread;
}

/*
 * THE TOTAL ORDER, and why it is the property that makes two machines agree.
 *
 * Every op is sorted by (at, by.key, line index within its own file). `at` is
 * an ISO-8601 UTC stamp of fixed width, so a plain string compare is a
 * chronological compare. Two ops written in the same millisecond by different
 * parties are separated by the author key, which is unique per file; two ops by
 * the same party are separated by their position in that party's file, which is
 * append-only and therefore already causal.
 *
 * The consequence: the order does NOT depend on which log file happened to be
 * read first, on directory listing order, on mtimes, or on which machine is
 * doing the folding. Two clients holding the same set of files fold to the same
 * thread list, byte for byte. That is the whole reason the fold can be trusted
 * as the single source of truth instead of being a best-effort merge.
 */
function compareOps(a, b) {
    if (a.at !== b.at) { return a.at < b.at ? -1 : 1; }
    if (a.party !== b.party) { return a.party < b.party ? -1 : 1; }
    if (a.file !== b.file) { return a.file < b.file ? -1 : 1; }
    return a.line - b.line;
}

/*
 * Fold ops over a base layer into threads.
 *
 * THREE PHASES, and the reason is that the total order is not a causal order.
 * Clocks on two machines are not synchronised, and two ops written in the same
 * millisecond are separated by an author key that knows nothing about which
 * caused which. So a `reply` can legitimately sort BEFORE the `open` it answers
 * (measured: a second party replying inside the same millisecond as the open —
 * with a single-pass fold the reply was silently dropped, which is precisely the
 * class of silent loss this module exists to end), and a `retract` can sort
 * before the message it names.
 *
 *   1. every `open`, in total order: threads come into existence first, so no
 *      later op can be orphaned by a millisecond of clock skew. An open also
 *      contributes the thread's first message, which is what makes the opening
 *      comment message 0 of its thread regardless of what raced with it.
 *   2. every other op, in total order: replies appended, resolution toggled,
 *      tombstones collected.
 *   3. tombstones applied.
 *
 * A `delete` is final: there is no undelete op, so a deleted thread stays gone
 * however many ops follow it. A `resolve`/`reopen` pair is NOT final in that
 * way — last one in the total order wins, which is why resolution is a field
 * and deletion is a set.
 */
function foldOps(baseThreads, ops) {
    const threads = new Map();
    (baseThreads || []).forEach(t => { if (t && t.id) { threads.set(t.id, legacyThread(t)); } });

    const deletedThreads = new Set();
    const retractedMessages = new Set();
    const ordered = ops.slice().sort(compareOps);

    const messageFor = (op, id, thread) => normaliseMessage(
        { id: op.message, author: authorRecord(op.by).name, at: op.at, body: op.body, by: authorRecord(op.by) },
        id, thread.messages.length);

    // -- phase 1: the threads themselves ------------------------------------
    for (const entry of ordered) {
        const op = entry.op;
        if (op.op !== 'open') { continue; }
        if (!op.thread) {
            console.warn('[studio] comment op with no thread id, ignored', entry.file, entry.line);
            continue;
        }
        /* An open over a thread that already exists is the legacy base layer
         * being re-stated: keep the thread, let the op win for the fields it
         * sets. */
        const thread = threads.get(op.thread) || blankThread(op.thread);
        if (op.scope !== undefined) { thread.scope = op.scope; }
        if (op.quote !== undefined) { thread.quote = op.quote; }
        if (op.occurrence !== undefined) { thread.occurrence = op.occurrence; }
        // The rendered-page anchor; see blankThread on why it is carried.
        if (op.anchor !== undefined) { thread.anchor = op.anchor; }
        if (op.body) { thread.messages.push(messageFor(op, op.thread, thread)); }
        threads.set(op.thread, thread);
    }

    // -- phase 2: everything said about a thread ----------------------------
    for (const entry of ordered) {
        const op = entry.op;
        const id = op.thread;
        if (op.op === 'open') { continue; }
        if (!id) {
            console.warn('[studio] comment op with no thread id, ignored', entry.file, entry.line);
            continue;
        }
        /*
         * The thread may legitimately not exist even after phase 1: a partial
         * clone, or a branch where the opening party's log file was never
         * merged. That is normal, so an unknown thread is ignored — never
         * thrown on, because one such op would otherwise cost the user every
         * thread in the document. Its tombstones are still honoured, in case
         * the missing half arrives later in the same fold's file set.
         */
        const thread = threads.get(id);
        if (!thread) {
            if (op.op === 'delete') { deletedThreads.add(id); }
            if (op.op === 'retract' && op.message) { retractedMessages.add(op.message); }
            continue;
        }
        switch (op.op) {
            case 'reply':
                thread.messages.push(messageFor(op, id, thread));
                break;
            case 'resolve':
                thread.resolved = true;
                break;
            case 'reopen':
                thread.resolved = false;
                break;
            case 'retract':
                if (op.message) { retractedMessages.add(op.message); }
                break;
            case 'delete':
                deletedThreads.add(id);
                break;
            default:
                /* An op kind this build does not know about. A newer client may
                 * write one; dropping it is right, losing the file is not. */
                console.warn('[studio] unknown comment op', op.op, entry.file, entry.line);
                break;
        }
    }

    // -- phase 3: tombstones ------------------------------------------------

    const out = [];
    for (const thread of threads.values()) {
        if (deletedThreads.has(thread.id)) { continue; }
        thread.messages = thread.messages.filter(m => !retractedMessages.has(m.id));
        out.push(thread);
    }
    return out;
}

class CommentLog {

    constructor(fileService, workspaceService) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
    }

    /* Same longest-prefix rule as CommentsStore, so a document resolves to the
     * same root under both stores and the legacy sidecar is found where the old
     * store left it. */
    async rootFor(docUri) {
        const roots = await this.workspaceService.roots;
        const match = roots
            .filter(r => docUri.toString().startsWith(r.resource.toString()))
            .sort((a, b) => b.resource.toString().length - a.resource.toString().length)[0];
        return match ? match.resource : docUri.parent;
    }

    logDirUri(rootUri, docUri) { return logDirUri(rootUri, docUri); }

    myLogUri(rootUri, docUri) { return myLogUri(rootUri, docUri); }

    /** The committed pre-log threads, read and never written. */
    async readLegacy(rootUri, docUri) {
        const uri = sidecarUri(rootUri, docUri);
        try {
            if (!(await this.fileService.exists(uri))) { return []; }
            const parsed = JSON.parse((await this.fileService.read(uri)).value);
            return Array.isArray(parsed.threads) ? parsed.threads : [];
        } catch (e) {
            console.warn('[studio] could not read the legacy comments sidecar', uri.toString(), e);
            return [];
        }
    }

    /**
     * Every op in every party's log for one document.
     *
     * Files are read in whatever order the file service lists them; the fold's
     * total order makes that irrelevant, and the test asserts it by folding the
     * same directory twice with the listing reversed.
     */
    async readOps(rootUri, docUri) {
        const dir = logDirUri(rootUri, docUri);
        let stat;
        try {
            if (!(await this.fileService.exists(dir))) { return []; }
            stat = await this.fileService.resolve(dir);
        } catch (e) {
            console.warn('[studio] could not list the comment logs', dir.toString(), e);
            return [];
        }
        const files = (stat && stat.children ? stat.children : [])
            .filter(child => !child.isDirectory && child.resource.toString().endsWith(LOG_SUFFIX));
        const ops = [];
        for (const child of files) {
            const uri = child.resource;
            const name = uri.path.base;
            const party = name.slice(0, -LOG_SUFFIX.length);
            let text;
            try {
                text = (await this.fileService.read(uri)).value;
            } catch (e) {
                console.warn('[studio] could not read a comment log', uri.toString(), e);
                continue;
            }
            text.split('\n').forEach((line, index) => {
                const trimmed = line.trim();
                if (!trimmed) { return; }
                let op;
                try {
                    op = JSON.parse(trimmed);
                } catch (e) {
                    /*
                     * A half-flushed final line, or a line mangled by a bad
                     * merge. Skipping one line and keeping the rest is the
                     * whole reason the format is line-oriented; making it fatal
                     * would trade a lost line for a lost document.
                     */
                    console.warn('[studio] skipping malformed comment op', uri.toString() + ':' + (index + 1), e);
                    return;
                }
                if (!op || typeof op !== 'object') { return; }
                /* The author key from the op wins over the filename: an op
                 * carries the record that was true when it was written, and a
                 * file could in principle be renamed. The filename is kept only
                 * as a tiebreak so the order stays total. */
                ops.push({ op, file: name, party: (op.by && op.by.key) || party, line: index, at: op.at || '' });
            });
        }
        return ops;
    }

    /** Legacy base layer plus folded ops. The only read path. */
    async load(docUri) {
        const root = await this.rootFor(docUri);
        const base = await this.readLegacy(root, docUri);
        const ops = await this.readOps(root, docUri);
        return { version: 1, threads: foldOps(base, ops) };
    }

    /**
     * Append one op to MY OWN log file.
     *
     * This is a read-modify-write, which is exactly the pattern that broke
     * CommentsStore — and it is safe here for one reason only: no other writer
     * ever touches this file. The read cannot be stale with respect to anyone
     * but me, and my own writes are serialised by being mine. Every other
     * party's ops live in files this method never opens.
     *
     * `at` and `by` are stamped here when absent so a call site cannot forget
     * them; an op that already carries them (a replayed or imported op) keeps
     * what it has.
     */
    async append(docUri, op) {
        /* The file about to be written is named after my id, so the id stops
         * being provisional here and nowhere else. Before this existed the id
         * froze on the first keystroke in the name field — see identity.js. */
        identity.seal();
        const root = await this.rootFor(docUri);
        const uri = myLogUri(root, docUri);
        const record = { ...op };
        if (!record.at) { record.at = new Date().toISOString(); }
        if (!record.by) { record.by = authorRecord(identity.current()); }
        const line = JSON.stringify(record) + '\n';

        let existing = '';
        try {
            if (await this.fileService.exists(uri)) { existing = (await this.fileService.read(uri)).value || ''; }
        } catch (e) {
            console.warn('[studio] could not read my comment log, appending to a fresh one', uri.toString(), e);
        }
        /* A previous write that lost its trailing newline (a crash mid-flush)
         * must not glue two ops onto one line and cost both of them. */
        const body = existing && !existing.endsWith('\n') ? existing + '\n' + line : existing + line;

        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            // Neither the file nor .studio/comments/<doc>/ exists yet.
            const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
        }
        return record;
    }

    // -- the five things a surface actually does ------------------------------

    /**
     * @returns the new thread's id, minted with comments-store.js's newId.
     *
     * `id` may be supplied instead: both surfaces create a thread in memory and
     * mark the document with its id BEFORE the first message exists, so the open
     * op has to be able to adopt an id that is already referenced by a
     * ProseMirror mark or a rendered-page card. Minting a second id here would
     * leave the mark pointing at a thread that never reaches disk.
     *
     * `anchor` is for the rendered-page surface, which anchors by DOM path
     * rather than by quote.
     */
    async openThread(docUri, { id, scope, quote, occurrence, body, anchor }) {
        const thread = id || newId();
        const op = {
            op: 'open',
            thread,
            scope: scope || 'inline',
            quote: quote || '',
            occurrence: occurrence || 0,
            body: body || ''
        };
        if (anchor !== undefined) { op.anchor = anchor; }
        await this.append(docUri, op);
        return thread;
    }

    /** @returns the new message's id, which is what a later retract names. */
    async reply(docUri, threadId, body) {
        const message = messageId();
        await this.append(docUri, { op: 'reply', thread: threadId, message, body: body || '' });
        return message;
    }

    /* Resolution is a pair of ops rather than a boolean field, so that two
     * parties disagreeing about it resolve by timestamp instead of by whoever
     * wrote last. */
    async setResolved(docUri, threadId, resolved) {
        await this.append(docUri, { op: resolved ? 'resolve' : 'reopen', thread: threadId });
    }

    async deleteThread(docUri, threadId) {
        await this.append(docUri, { op: 'delete', thread: threadId });
    }

    async retractMessage(docUri, threadId, id) {
        await this.append(docUri, { op: 'retract', thread: threadId, message: id });
    }

    /**
     * Re-fold when any party's log changes.
     *
     * This half is what makes collaboration visible: without it a second
     * writer's reply sits on disk until the document is reopened, and the
     * append-only log buys nothing a user can see.
     *
     * The DIRECTORY is watched, not my file — the interesting writes are by
     * definition somebody else's, into a file that may not exist yet.
     * `onDidFilesChange` only reports resources something has asked to watch
     * (the same trap documented in repositories-view.js), so the explicit
     * `watch(dir)` is what makes the subscription real rather than decorative.
     *
     * SELF-WRITE GUARD: a plain debounce, not bookkeeping of what I just wrote.
     * Re-folding is a pure function of the files on disk, so a redundant fold
     * after my own append produces the state the caller already has — costing
     * one small read and nothing else. Tracking my own writes, by contrast,
     * needs a matcher that stays correct as writes coalesce, and when it is
     * wrong it is wrong in the expensive direction: a suppressed event means
     * another party's reply never appears. Cheap-and-redundant beats
     * clever-and-silently-lossy.
     */
    async watch(docUri, onChange) {
        const root = await this.rootFor(docUri);
        const dir = logDirUri(root, docUri);
        const prefix = dir.toString() + '/';
        const disposables = [];
        /*
         * Watch <root>/.studio, NOT the log directory.
         *
         * A document with no comments yet has no log directory, and a watch
         * registered on a path that does not exist is silently inert and never
         * recovers when the path appears — so the FIRST party to comment on a
         * document would never see the second party's reply, which is the one
         * case that matters. repositories-view.js documents the same trap for the
         * pending-changes index. Measured by collaboration-regression: the reply
         * reached disk and never reached the screen.
         *
         * The filter below keeps this precise despite the broader subscription.
         */
        try {
            disposables.push(this.fileService.watch(new URI(root.toString() + '/' + SIDECAR_ROOT)));
        } catch (e) {
            console.warn('[studio] could not watch the comment logs', dir.toString(), e);
        }
        let timer;
        /* `event.contains` tests one named resource, and the resource of
         * interest is "any .jsonl under this directory" — including files this
         * client has never seen — so the change list is read directly. */
        disposables.push(this.fileService.onDidFilesChange(event => {
            const touched = (event && event.changes ? event.changes : [])
                .some(change => change.resource && change.resource.toString().startsWith(prefix));
            if (!touched) { return; }
            clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    onChange(await this.load(docUri));
                } catch (e) {
                    console.warn('[studio] could not re-fold the comment logs', dir.toString(), e);
                }
            }, WATCH_DEBOUNCE_MS);
        }));
        return {
            dispose() {
                clearTimeout(timer);
                disposables.forEach(d => { try { d && d.dispose && d.dispose(); } catch (e) { /* already disposed */ } });
                disposables.length = 0;
            }
        };
    }
}

/*
 * A cheap identity for "has the folded state changed", for surfaces that
 * re-render on a watcher.
 *
 * The watcher deliberately fires for this client's own appends as well as
 * anyone else's (a debounce, not write bookkeeping — see watch()). A surface
 * that re-rendered on every one of those would rebuild its cards underneath the
 * user's caret on every keystroke-sized write, so it compares this instead and
 * drops a fold that says nothing new. Computed over the folded threads ONLY,
 * never over a merged list, or a local unsaved thread would mask a real change.
 */
function signature(threads) {
    return JSON.stringify((threads || []).map(t => [
        t.id, t.resolved ? 1 : 0, t.quote, t.occurrence,
        t.anchor ? JSON.stringify(t.anchor) : 0,
        (t.messages || []).map(m => [m.id, m.author, m.at, m.body])
    ]));
}

/*
 * The folded state, plus the threads that exist only in this client's memory.
 *
 * Both surfaces create a thread and mark the document BEFORE anything has been
 * said in it — the open op is written with the first message, because a thread
 * nobody ever typed into should not become a permanent record. Such a thread is
 * therefore absent from every fold, and a re-fold that simply replaced the list
 * would make the card the user is typing into disappear the moment a colleague
 * wrote anywhere else in the document.
 */
function mergeFolded(current, folded) {
    const known = new Set((folded || []).map(t => t.id));
    const unsaved = (current || []).filter(t => !known.has(t.id) && !(t.messages || []).length);
    return [...(folded || []), ...unsaved];
}

module.exports = {
    CommentLog, foldOps, logDirUri, myLogUri, messageId, derivedMessageId,
    signature, mergeFolded, LOG_SUFFIX, WATCH_DEBOUNCE_MS
};
