/*
 * Pending changes outlive the document they describe, unless something
 * follows the document around.
 *
 * changes-store.js and change-log.js both key their storage off the
 * document's OWN relative path:
 *
 *   .studio/changes/<relpath>.json        one assistant proposal (changes-store)
 *   .studio/changes/<relpath>/<author>.json   one suggestion each (change-log)
 *   .studio/changes/index.json            the derived "who has pending work" cache
 *
 * Neither store, nor anything else in this codebase, has ever listened for the
 * document itself moving. Found in a real repository: a review queue claiming
 * 43 pending changes against a file deleted months earlier. The sidecar and
 * its index row are just files; nothing deletes a person's file, so nothing
 * had ever deleted THEM either, and the row could not be opened, only stared
 * at. The same thing happens to a renamed file, quietly: the proposal does
 * not follow it, so a person opens the newly-named document and finds no
 * pending work at all, while the row for a path that no longer exists still
 * sits in the index.
 *
 * This module is that missing listener. It has exactly three jobs, matched
 * to the three ways a document stops being at the path its sidecar names:
 *
 *   RENAMED/MOVED -- the sidecar and the suggestion directory move with it,
 *   so the pending work arrives at the new path rather than being stranded
 *   at the old one.
 *
 *   DELETED -- the index row is removed (the queue must not keep listing
 *   something nobody can open) and the sidecar/directory are relocated to
 *   .studio/changes/.orphaned/<relpath>/, never deleted outright.
 *
 *   ALREADY DAMAGED -- a sweep at startup, per workspace root, finds every
 *   row and every sidecar/directory the first two jobs never had a chance to
 *   react to (because this module did not exist yet when the damage
 *   happened) and repairs it the same way.
 *
 * WHY ORPHANED, NOT DELETED
 *
 * A pending change is somebody's unreviewed work. This module runs
 * unattended, off a filesystem event or at startup, with nobody watching --
 * exactly the circumstances under which deleting anything should make
 * everyone nervous. Moving the sidecar sideways into .studio/changes/.orphaned
 * clears it from the index and from every place the product actually reads
 * pending work from (both stores resolve their paths from the document's own
 * relpath, which no longer has anything under it), while leaving the content
 * on disk for a person, not this module, to decide is truly gone. This file
 * deliberately does not add a UI for that directory -- reviewing or purging
 * .orphaned is the queue's own "discard" affordance, owned elsewhere.
 *
 * The orphaned copy is filed under the relpath it was stranded FROM, not
 * merged into anything keyed by name alone: a file re-created at the same
 * path is a different document that happens to share a name, and it must
 * start with an empty queue, not silently inherit proposals written against
 * text it never contained. Orphaning is also why a second file at the same
 * path is safe -- if that new file is later deleted too, its own (unrelated)
 * sidecar is stranded into a distinctly-named sibling under .orphaned (see
 * uniqueOrphanRelPath) rather than overwriting the first one.
 *
 * WHY A SEPARATE MODULE, NOT A METHOD ON EACH STORE
 *
 * changes-store.js and change-log.js are read/write APIs for a document
 * someone has open; neither owns a subscription to filesystem-wide events,
 * and folding one in would mean two independent listeners reacting to the
 * same rename. This module knows the on-disk layout both stores use (by the
 * same necessity that makes change-log.js recompute changes-store.js's path
 * convention rather than import it -- see change-log.js's header) and acts on
 * both sidecar shapes from one place, once.
 *
 * THE FILE OPERATION API, AND ONE THING THAT IS NOT WHAT IT LOOKS LIKE
 *
 * FileService.onDidRunOperation (node_modules/@theia/filesystem/lib/browser/
 * file-service.d.ts) is Theia's own signal for "this resource was created,
 * deleted, moved or copied", fired only after the operation actually
 * succeeded -- exactly what "follow a document that IS renamed" needs,
 * rather than inferring a rename from a delete-then-create pair that a
 * plain onDidFilesChange watch would also have to debounce and could still
 * get wrong for an unrelated delete immediately followed by an unrelated
 * create. FileOperationEvent.resource is the pre-operation path; for a MOVE,
 * .target is the resolved FileStat at the new path (verified by reading
 * file-service.js's own doMove: `new FileOperationEvent(source, MOVE,
 * fileStat)` where fileStat was just resolved at the destination); for a
 * DELETE there is no .target.
 *
 * FileOperation itself (node_modules/@theia/filesystem/lib/common/files.d.ts)
 * is declared `const enum`, which is not "an internal detail" so much as a
 * TypeScript compilation choice this project's build inlines away: at
 * runtime, `require('@theia/filesystem/lib/common/files').FileOperation` is
 * `undefined`, not the enum object -- confirmed against the installed
 * package, not assumed. So the numeric values FileOperationEvent's own
 * source documents (DELETE = 1, MOVE = 2) are used directly below, each
 * tagged with the const enum member it stands for so a version bump that
 * renumbers it is at least easy to find.
 */

const { URI } = require('@theia/core/lib/common/uri');
const { diffHunks, countPending } = require('./diff');

const CHANGES_DIR = '.studio/changes';
const INDEX_FILE = CHANGES_DIR + '/index.json';
const ORPHANED_DIR = CHANGES_DIR + '/.orphaned';

// See the header: FileOperation is a `const enum` and does not exist as a
// runtime value in this build. These are its DELETE and MOVE members, by
// number, from @theia/filesystem/lib/common/files.d.ts.
const OPERATION_DELETE = 1;
const OPERATION_MOVE = 2;

/* Identical to changes-store.js's and change-log.js's own relativePath: a
 * document outside every workspace root (a single opened file, in the
 * fallback both stores also use) is keyed by its bare filename rather than
 * failing outright. Recomputed here rather than imported, following the
 * precedent change-log.js's header sets for why these tiny primitives are
 * duplicated instead of cross-imported between the sidecar stores. */
function relativePath(rootUri, docUri) {
    const rootStr = rootUri.toString();
    const docStr = docUri.toString();
    return docStr.startsWith(rootStr) ? docStr.slice(rootStr.length).replace(/^\//, '') : docUri.path.base;
}

function changesDirUri(rootUri) { return new URI(rootUri.toString() + '/' + CHANGES_DIR); }
function indexUri(rootUri) { return new URI(rootUri.toString() + '/' + INDEX_FILE); }
function docUriFor(rootUri, relPath) { return new URI(rootUri.toString() + '/' + relPath); }

/* changes-store's sidecar and change-log's per-author directory, both
 * derived from CHANGES_DIR the same way those two modules derive them from
 * a docUri -- see legacyUri/logDirUri in change-log.js. Only one trailing
 * '.json' is stripped anywhere in this module, so a document literally
 * called data.json still lands its suggestions in ".../data.json/", exactly
 * as change-log.js documents. */
function sidecarUri(rootUri, relPath) { return new URI(rootUri.toString() + '/' + CHANGES_DIR + '/' + relPath + '.json'); }
function logDirUri(rootUri, relPath) { return new URI(rootUri.toString() + '/' + CHANGES_DIR + '/' + relPath); }
function orphanedSidecarUri(rootUri, relPath) { return new URI(rootUri.toString() + '/' + ORPHANED_DIR + '/' + relPath + '.json'); }
function orphanedLogDirUri(rootUri, relPath) { return new URI(rootUri.toString() + '/' + ORPHANED_DIR + '/' + relPath); }

class ChangesLifecycle {

    constructor(fileService, workspaceService) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
    }

    // -- small filesystem helpers, matched to changes-store.js's own -------

    async exists(uri) {
        try { return await this.fileService.exists(uri); }
        catch (e) { return false; }
    }

    /* Never throws: every caller in this module treats "could not resolve"
     * exactly like "does not exist", which is the only sane reading of a
     * failed resolve while sweeping a tree that might be mid-edit. */
    async resolveMaybe(uri) {
        try { return await this.fileService.resolve(uri); }
        catch (e) { return undefined; }
    }

    async readJson(uri, fallback) {
        try {
            if (!(await this.fileService.exists(uri))) { return fallback; }
            const parsed = JSON.parse((await this.fileService.read(uri)).value);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch (e) {
            console.warn('[studio] changes-lifecycle: could not read', uri.toString(), e);
            return fallback;
        }
    }

    async writeJson(uri, value) {
        const body = JSON.stringify(value, undefined, 2) + '\n';
        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            try {
                const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
                await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
            } catch (e2) {
                console.warn('[studio] changes-lifecycle: could not write', uri.toString(), e2);
            }
        }
    }

    async moveQuietly(source, target) {
        try {
            await this.fileService.move(source, target);
            return true;
        } catch (e) {
            console.warn('[studio] changes-lifecycle: could not relocate', source.toString(), '->', target.toString(), e);
            return false;
        }
    }

    /* Same root-matching rootFor uses in changes-store.js and change-log.js,
     * duplicated for the reason their own headers give: a document outside
     * every registered root still needs somewhere to look, and falling back
     * to its own parent directory is what keeps this module's idea of "where
     * the sidecar lives" from disagreeing with theirs. */
    async rootFor(docUri) {
        let roots;
        try { roots = await this.workspaceService.roots; }
        catch (e) { roots = []; }
        const match = (roots || [])
            .filter(r => docUri.toString().startsWith(r.resource.toString()))
            .sort((a, b) => b.resource.toString().length - a.resource.toString().length)[0];
        return match ? match.resource : docUri.parent;
    }

    /* A write inside .studio itself (this module's own orphan moves, or a
     * store rewriting index.json) must never be read back as "a document
     * changed" -- otherwise every sidecar write would recursively look like
     * a document that needs its OWN sidecar followed or stranded. */
    isInsideChangesArea(relPath) {
        return relPath === '.studio' || relPath.startsWith('.studio/');
    }

    // -- orphaning: the shared move-aside used by delete, sweep and a rename
    //    that collides with the destination's own pending work ------------

    /**
     * Pick a name under .orphaned that nothing is using yet.
     *
     * A second document ever landing at `relPath` after the first was
     * orphaned (deleted, deleted again, or renamed away twice) must not
     * overwrite the first one's stranded work -- that would be exactly the
     * silent data loss orphaning exists to avoid, just delayed. `~1`, `~2`,
     * ... are tried until both possible destinations (the sidecar shape and
     * the directory shape) are free, so unrelated orphan events can never
     * collide with each other.
     */
    async uniqueOrphanRelPath(rootUri, relPath) {
        let candidate = relPath;
        let n = 1;
        while (await this.exists(orphanedSidecarUri(rootUri, candidate)) || await this.exists(orphanedLogDirUri(rootUri, candidate))) {
            candidate = relPath + '~' + n;
            n += 1;
        }
        return candidate;
    }

    /**
     * Move whichever of the sidecar / suggestion directory exist at
     * `relPath` into .orphaned. `which` narrows it to one side for the
     * rename-collision case in handleMove, where only the half that
     * actually collides needs to be stranded; delete and sweep always pass
     * 'both'.
     *
     * Returns false, doing nothing, when there is nothing there -- the
     * normal outcome for the vast majority of documents, and also what
     * makes a second sweep or a duplicate event harmless.
     */
    async strand(rootUri, relPath, which) {
        const wantSidecar = which !== 'logdir';
        const wantLogDir = which !== 'sidecar';
        const sidecar = sidecarUri(rootUri, relPath);
        const logDir = logDirUri(rootUri, relPath);
        const hasSidecar = wantSidecar && await this.exists(sidecar);
        const hasLogDir = wantLogDir && await this.exists(logDir);
        if (!hasSidecar && !hasLogDir) { return false; }
        const dest = await this.uniqueOrphanRelPath(rootUri, relPath);
        if (hasSidecar) { await this.moveQuietly(sidecar, orphanedSidecarUri(rootUri, dest)); }
        if (hasLogDir) { await this.moveQuietly(logDir, orphanedLogDirUri(rootUri, dest)); }
        return true;
    }

    /**
     * Drop every index row for `relPath` AND anything nested under it.
     *
     * The nested half matters for a folder delete: FileService fires one
     * DELETE for the folder, never one per file inside it (verified against
     * file-service.js's doDelete, which fires a single event after the
     * whole recursive provider delete completes), so a folder holding ten
     * documents' pending work needs its ten index rows cleared from the one
     * event the folder itself produced, not just a row literally named
     * after the folder -- which almost never exists, since the index only
     * ever gets a row for an actual document.
     */
    async dropIndexSubtree(rootUri, relPath) {
        const uri = indexUri(rootUri);
        const index = await this.readJson(uri, undefined);
        if (!index || !index.files || typeof index.files !== 'object') { return; }
        let changed = false;
        for (const key of Object.keys(index.files)) {
            if (key === relPath || key.startsWith(relPath + '/')) {
                delete index.files[key];
                changed = true;
            }
        }
        if (changed) { await this.writeJson(uri, index); }
    }

    // -- rename / move -------------------------------------------------------

    /**
     * Recompute the moved sidecar's own index row from its proposals, the
     * same arithmetic updateIndex uses in changes-store.js, rather than
     * copying the old row across. A rename never changes what is proposed,
     * only where it lives, so recomputing is not strictly required to get
     * the RIGHT number -- but trusting a carried-over number is exactly the
     * kind of shortcut that turns this cache stale the next time it is
     * wrong for an unrelated reason, and the recomputation costs one read
     * that this code path already needs to make regardless (change-log's
     * suggestion directories, by contrast, have no index entry to move at
     * all -- see that module's header, "the pending index, untouched").
     */
    async transplantIndexEntry(oldRoot, oldRelPath, newRoot, newRelPath, newSidecarUri) {
        const data = await this.readJson(newSidecarUri, undefined);
        const proposals = data && Array.isArray(data.proposals) ? data.proposals.filter(p => p && p.status !== 'resolved') : [];
        const pending = proposals.reduce((sum, p) => {
            const { hunks } = diffHunks(p.baseBody, p.proposedBody);
            return sum + countPending(hunks, p.decisions);
        }, 0);

        if (oldRoot.toString() === newRoot.toString()) {
            const uri = indexUri(oldRoot);
            const index = await this.readJson(uri, { version: 1, files: {} });
            if (!index.files) { index.files = {}; }
            delete index.files[oldRelPath];
            if (pending > 0) {
                index.files[newRelPath] = { pending, proposals: proposals.length, updatedAt: new Date().toISOString() };
            }
            await this.writeJson(uri, index);
        } else {
            // A move across workspace roots touches two index files, not one.
            await this.dropIndexSubtree(oldRoot, oldRelPath);
            if (pending > 0) {
                const uri = indexUri(newRoot);
                const index = await this.readJson(uri, { version: 1, files: {} });
                if (!index.files) { index.files = {}; }
                index.files[newRelPath] = { pending, proposals: proposals.length, updatedAt: new Date().toISOString() };
                await this.writeJson(uri, index);
            }
        }
    }

    /**
     * A document was renamed or moved: bring its sidecar and its suggestion
     * directory with it.
     *
     * Sidecar and directory are moved independently because they can be in
     * different states at the moment of the rename (a document might have
     * an assistant proposal, or suggestions, or both, or -- most of the
     * time -- neither, in which case this returns having done nothing).
     *
     * COLLISION: if the destination path already has its OWN pending work
     * (a document is being renamed on top of / into the identity of another
     * document that already has proposals or suggestions), that work is not
     * this rename's to overwrite. The moving side is stranded into
     * .orphaned instead of clobbering what was already there -- the same
     * "never destroy someone's unreviewed work" rule that governs deletion,
     * applied to the one rename outcome that could otherwise silently erase
     * a stranger's pending review.
     */
    async handleMove(sourceUri, targetUri) {
        const oldRoot = await this.rootFor(sourceUri);
        const newRoot = await this.rootFor(targetUri);
        if (!oldRoot || !newRoot) { return; }
        const oldRelPath = relativePath(oldRoot, sourceUri);
        const newRelPath = relativePath(newRoot, targetUri);
        if (!oldRelPath || !newRelPath) { return; }
        if (this.isInsideChangesArea(oldRelPath) || this.isInsideChangesArea(newRelPath)) { return; }
        if (oldRoot.toString() === newRoot.toString() && oldRelPath === newRelPath) { return; }

        const oldSidecar = sidecarUri(oldRoot, oldRelPath);
        const oldLogDir = logDirUri(oldRoot, oldRelPath);
        const newSidecar = sidecarUri(newRoot, newRelPath);
        const newLogDir = logDirUri(newRoot, newRelPath);

        const hadSidecar = await this.exists(oldSidecar);
        const hadLogDir = await this.exists(oldLogDir);
        if (!hadSidecar && !hadLogDir) { return; }

        let sidecarMovedTo;
        if (hadSidecar) {
            if (await this.exists(newSidecar)) {
                console.warn('[studio] changes-lifecycle: ' + newRelPath +
                    ' already has pending changes of its own; keeping ' + oldRelPath +
                    "'s under .orphaned instead of overwriting them");
                await this.strand(oldRoot, oldRelPath, 'sidecar');
            } else if (await this.moveQuietly(oldSidecar, newSidecar)) {
                sidecarMovedTo = newSidecar;
            }
        }
        if (hadLogDir) {
            if (await this.exists(newLogDir)) {
                await this.strand(oldRoot, oldRelPath, 'logdir');
            } else {
                await this.moveQuietly(oldLogDir, newLogDir);
            }
        }

        if (sidecarMovedTo) {
            await this.transplantIndexEntry(oldRoot, oldRelPath, newRoot, newRelPath, sidecarMovedTo);
        } else if (hadSidecar) {
            // Collided and was stranded rather than moved: the OLD row is
            // simply gone, and nothing was ever written for the new path.
            await this.dropIndexSubtree(oldRoot, oldRelPath);
        }
    }

    // -- delete ----------------------------------------------------------

    /**
     * A document was deleted: clear the queue's claim on it, without
     * clearing the work itself. See the header for why this orphans rather
     * than deletes the sidecar/directory.
     */
    async handleDelete(uri) {
        const root = await this.rootFor(uri);
        if (!root) { return; }
        const relPath = relativePath(root, uri);
        if (!relPath || this.isInsideChangesArea(relPath)) { return; }
        // Guards a delete-then-recreate race (e.g. a save-as some tools do
        // as delete+create): if the document is back by the time this runs,
        // its queue is current work again, not stranded work.
        if (await this.exists(uri)) { return; }
        await this.strand(root, relPath, 'both');
        await this.dropIndexSubtree(root, relPath);
    }

    // -- the startup sweep -------------------------------------------------

    /**
     * Walk .studio/changes below `shadowDirUri`, collecting every relpath
     * that MIGHT be a document's sidecar or suggestion directory, into
     * `candidates`.
     *
     * The one thing this has to get right: a directory under CHANGES_DIR is
     * either a plain namespace segment (it exists as a real directory in the
     * workspace, e.g. "docs/", and documents are nested further inside it)
     * or it IS a document's own suggestion directory (change-log's one file
     * per author). Those look identical on disk -- both are "a directory
     * full of .json files" -- and the only way to tell them apart is to ask
     * the real workspace whether something matching that path is itself a
     * directory there.
     *
     * Getting this wrong in the naive direction (recursing into every
     * directory, unconditionally) turns a live document's own suggestion
     * files into false positives: `docs/prd.md/roman.json`, stripped of its
     * '.json' the same way a sidecar is, reads as a candidate document
     * "docs/prd.md/roman" that plainly does not exist, and a still-open
     * suggestion would be stranded right next to the very much still-open
     * document it belongs to. So a directory is only descended into when
     * the real workspace agrees it is a directory too; otherwise its whole
     * path is added as ONE candidate and left alone -- which, for a folder
     * that was deleted wholesale, also means its entire stale subtree is
     * relocated in one move (see strand/handleDelete) rather than
     * rediscovered file by file.
     */
    async collectCandidates(rootUri, shadowDirUri, candidates, relPrefix) {
        const stat = await this.resolveMaybe(shadowDirUri);
        if (!stat || !stat.isDirectory) { return; }
        for (const child of stat.children || []) {
            const base = child.resource.path.base;
            if (!relPrefix && base === 'index.json' && !child.isDirectory) { continue; }
            if (!relPrefix && base === '.orphaned' && child.isDirectory) { continue; }
            const rel = relPrefix ? relPrefix + '/' + base : base;
            if (child.isDirectory) {
                const real = await this.resolveMaybe(docUriFor(rootUri, rel));
                if (real && real.isDirectory) {
                    await this.collectCandidates(rootUri, child.resource, candidates, rel);
                } else {
                    candidates.add(rel);
                }
            } else if (base.endsWith('.json')) {
                candidates.add(rel.slice(0, -'.json'.length));
            }
        }
    }

    /**
     * Repair one workspace root: every index row, sidecar or suggestion
     * directory whose document no longer exists gets orphaned, exactly as
     * handleDelete would have done at the moment the document actually
     * disappeared, had this module existed then. This is what fixes a
     * repository that was already damaged before this file was written --
     * the 43-pending-changes-for-a-deleted-file case this module exists
     * for in the first place.
     *
     * A workspace with no .studio/changes at all -- the ordinary case for
     * most projects, every time this ever runs on them -- returns
     * immediately and writes nothing.
     */
    async sweepRoot(rootUri) {
        const dir = changesDirUri(rootUri);
        if (!(await this.exists(dir))) { return; }

        const idxUri = indexUri(rootUri);
        const index = await this.readJson(idxUri, { version: 1, files: {} });
        if (!index.files || typeof index.files !== 'object') { index.files = {}; }

        const candidates = new Set(Object.keys(index.files));
        await this.collectCandidates(rootUri, dir, candidates, '');

        // Shortest path first: an abandoned folder's own candidate is
        // stranded as one move before any document nested under it is
        // visited, so the usual case is one relocation instead of dozens.
        // Whatever is left of a nested candidate by the time its turn comes
        // (nothing, if its parent already carried it away) is fine either
        // way -- strand() is a no-op on an already-empty relpath.
        const ordered = Array.from(candidates).filter(Boolean).sort((a, b) => a.split('/').length - b.split('/').length);

        let indexChanged = false;
        for (const relPath of ordered) {
            if (await this.exists(docUriFor(rootUri, relPath))) { continue; }
            await this.strand(rootUri, relPath, 'both');
            if (Object.prototype.hasOwnProperty.call(index.files, relPath)) {
                delete index.files[relPath];
                indexChanged = true;
            }
        }
        if (indexChanged) { await this.writeJson(idxUri, index); }
    }

    /** Every workspace root, once. Failure in one root never stops the rest. */
    async sweepAll() {
        let roots;
        try { roots = await this.workspaceService.roots; }
        catch (e) { console.warn('[studio] changes-lifecycle: could not read workspace roots', e); return; }
        for (const root of roots || []) {
            try { await this.sweepRoot(root.resource); }
            catch (e) { console.warn('[studio] changes-lifecycle: sweep failed for', root.resource.toString(), e); }
        }
    }

    // -- wiring --------------------------------------------------------------

    /**
     * One event, one handler. Every failure inside handleOperation is
     * caught there, not here, per the module's own rule (see the header):
     * this listens to filesystem operations for the LIFETIME of the
     * frontend, and nothing it does is allowed to be the thing that takes
     * the app down.
     */
    async handleOperation(event) {
        try {
            if (event.isOperation(OPERATION_DELETE)) {
                await this.handleDelete(event.resource);
            } else if (event.isOperation(OPERATION_MOVE) && event.target && event.target.resource) {
                await this.handleMove(event.resource, event.target.resource);
            }
        } catch (e) {
            console.warn('[studio] changes-lifecycle: failed to react to a file operation', e);
        }
    }

    /** Start following renames and deletes. Returns a Disposable. */
    start() {
        const listener = this.fileService.onDidRunOperation(event => { this.handleOperation(event); });
        return {
            dispose: () => { try { listener.dispose(); } catch (e) { /* already disposed */ } }
        };
    }
}

module.exports = { ChangesLifecycle, CHANGES_DIR, ORPHANED_DIR, relativePath };
