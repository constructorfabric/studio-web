/*
 * Pending AI changes — proposals a user reviews before they touch the
 * document.
 *
 * Storage follows the same decision comments made: a sidecar inside the
 * repository, not a Studio-side database, so a proposal travels with the
 * branch and is reviewable as an ordinary diff.
 *
 *   <root>/.studio/changes/docs/prd.md.json   proposals for one document
 *   <root>/.studio/changes/index.json         which files have pending work
 *
 * The index exists for requirement 12 (multi-file awareness): the Projects
 * browser needs per-file pending counts without walking and diffing every
 * document in the workspace. It is a derived cache — every writer updates it
 * from the per-document file it just wrote, and a reader that finds it stale
 * is never wrong about a file it actually opens, only about a badge.
 *
 * A proposal stores the BASE it was computed against and the PROPOSED body,
 * never a hunk list. Hunks are always re-derived through diff.js, so a
 * persisted decision can never disagree with what the reviewer is looking at.
 */

const { URI } = require('@theia/core/lib/common/uri');
const { diffHunks, countPending, applyHunks } = require('./diff');

const CHANGES_DIR = '.studio/changes';
const INDEX_FILE = CHANGES_DIR + '/index.json';

function newProposalId() {
    return 'p-' + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) +
        '-' + (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().slice(0, 6) : Math.floor(Math.random() * 1e6).toString(36));
}

function relativePath(rootUri, docUri) {
    const rootStr = rootUri.toString();
    const docStr = docUri.toString();
    return docStr.startsWith(rootStr) ? docStr.slice(rootStr.length).replace(/^\//, '') : docUri.path.base;
}

class ChangesStore {

    constructor(fileService, workspaceService) {
        this.fileService = fileService;
        this.workspaceService = workspaceService;
    }

    async rootFor(docUri) {
        const roots = await this.workspaceService.roots;
        const match = roots
            .filter(r => docUri.toString().startsWith(r.resource.toString()))
            .sort((a, b) => b.resource.toString().length - a.resource.toString().length)[0];
        return match ? match.resource : docUri.parent;
    }

    sidecarUri(rootUri, docUri) {
        return new URI(rootUri.toString() + '/' + CHANGES_DIR + '/' + relativePath(rootUri, docUri) + '.json');
    }

    async readJson(uri, fallback) {
        try {
            if (!(await this.fileService.exists(uri))) { return fallback; }
            return JSON.parse((await this.fileService.read(uri)).value);
        } catch (e) {
            console.warn('[studio] could not read', uri.toString(), e);
            return fallback;
        }
    }

    async writeJson(uri, value) {
        const body = JSON.stringify(value, undefined, 2) + '\n';
        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
        }
        return uri;
    }

    // -- per-document --------------------------------------------------------

    async load(docUri) {
        const root = await this.rootFor(docUri);
        const data = await this.readJson(this.sidecarUri(root, docUri), undefined);
        const proposals = data && Array.isArray(data.proposals) ? data.proposals : [];
        return { version: 1, proposals: proposals.filter(p => p && p.status !== 'resolved') };
    }

    async save(docUri, proposals) {
        const root = await this.rootFor(docUri);
        const open = proposals.filter(p => p.status !== 'resolved');
        await this.writeJson(this.sidecarUri(root, docUri), { version: 1, proposals: open });
        await this.updateIndex(root, docUri, open);
        return this.sidecarUri(root, docUri);
    }

    /**
     * A proposal captured from a full replacement body — the shape every
     * origin produces, whether the new text came from an assistant writing
     * the file directly, an inline selection edit, or a comment follow-up.
     *
     * `groupId` is optional and is the whole of tier 2's linked move: a
     * cross-file move is a cut proposal in one document and an insert
     * proposal in another, and sharing a groupId is what tells the store
     * they must be accepted or rejected together. Every proposal already on
     * disk was written before this field existed, so it must decode as
     * `undefined` — not `null`, not `''` — and behave exactly as a solo
     * proposal always has. That is why this is the one field here with no
     * `|| undefined` normalisation of a falsy default: a caller that does not
     * pass one gets `undefined` for free from destructuring, which is also
     * exactly what `JSON.parse` hands back for an old proposal that never had
     * the key.
     *
     * `groupMembers`, when a groupId is given, is the relative path of every
     * document in the group, INCLUDING this one, fixed at creation time. It
     * is never read as the live membership — `proposalsInGroup` below finds
     * that by looking at what is actually still open — but it is what lets a
     * lone survivor of a half-finished group resolution recognise itself as
     * incomplete rather than as an ordinary single-document proposal that
     * happens to carry a groupId.
     */
    static proposal({ title, origin, instruction, commentId, baseBody, proposedBody, author, groupId, groupMembers }) {
        return {
            id: newProposalId(),
            title: title || 'Proposed change',
            origin: origin || 'manual',
            instruction: instruction || '',
            commentId: commentId || undefined,
            author: author || 'assistant',
            createdAt: new Date().toISOString(),
            baseBody,
            proposedBody,
            decisions: {},
            status: 'open',
            groupId,
            groupMembers: groupId ? (groupMembers || undefined) : undefined
        };
    }

    /** Undecided hunks across every open proposal for one document. */
    static pendingCount(proposals) {
        return (proposals || []).reduce((sum, p) => {
            const { hunks } = diffHunks(p.baseBody, p.proposedBody);
            return sum + countPending(hunks, p.decisions);
        }, 0);
    }

    // -- workspace index -----------------------------------------------------

    indexUri(rootUri) { return new URI(rootUri.toString() + '/' + INDEX_FILE); }

    async updateIndex(rootUri, docUri, proposals) {
        const uri = this.indexUri(rootUri);
        const index = await this.readJson(uri, { version: 1, files: {} });
        if (!index.files) { index.files = {}; }
        const path = relativePath(rootUri, docUri);
        const pending = ChangesStore.pendingCount(proposals);
        if (pending > 0) {
            index.files[path] = { pending, proposals: proposals.length, updatedAt: new Date().toISOString() };
        } else {
            delete index.files[path];
        }
        await this.writeJson(uri, index);
        return index;
    }

    /**
     * Every file with pending changes, for the changed-file list and the
     * Projects badges. Reads one small file rather than the whole tree.
     *
     * The index is a derived cache (see header) and nothing keeps it in step
     * with a document being deleted out from under it — a deleted document
     * leaves its row behind forever otherwise, stuck in the review queue with
     * nothing left to review. So every listed row is checked against the
     * filesystem here and a row whose document is gone is dropped from the
     * result AND rewritten out of index.json, so the repair sticks instead of
     * being redone on every read.
     *
     * Only a definite `false` prunes a row. `exists` throwing — a transient
     * filesystem hiccup, a permissions blip — is not evidence the document is
     * gone, and treating it as such would delete somebody's pending work from
     * the index over a glitch; such a row is kept. The index is rewritten only
     * when a row was actually dropped, so an ordinary read that finds nothing
     * stale stays a read.
     */
    async pendingFilesStatus(anyUri, options) {
        const root = await this.rootFor(anyUri);
        const indexUri = this.indexUri(root);
        const data = await this.readJson(indexUri, undefined);
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
            !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
            return { available: false, files: [] };
        }

        const rows = Object.entries(data.files)
            .filter(([path, info]) => typeof path === 'string' && Number.isInteger(info?.pending) && info.pending > 0)
            .map(([path, info]) => ({
                path,
                pending: info.pending,
                proposals: Number.isInteger(info.proposals) && info.proposals >= 0 ? info.proposals : 0,
                uri: new URI(root.toString() + '/' + path)
            }));

        /*
         * Pruning is for the QUEUE, which must never list a row a reviewer
         * cannot open. It is wrong for a caller asking "is every member of this
         * linked group still here" — there, a document that has gone missing is
         * the answer, and hiding it turns a group that must refuse whole into
         * one that silently resolves its surviving half. See proposalsInGroup.
         */
        if (options && options.prune === false) {
            return { available: true, files: rows.sort((a, b) => a.path.localeCompare(b.path)) };
        }

        const files = [];
        const gone = [];
        for (const row of rows) {
            let stillThere = true;
            try {
                stillThere = await this.fileService.exists(row.uri);
            } catch (e) {
                stillThere = true; // unknown, not gone — see header
            }
            if (stillThere) { files.push(row); } else { gone.push(row.path); }
        }

        if (gone.length) {
            for (const path of gone) { delete data.files[path]; }
            /*
             * The repair is best-effort, and that is the whole point of the
             * catch. Pruning the file on disk only makes the fix PERMANENT —
             * the answer this call returns is already correct without it — so a
             * read-only checkout, a lost lock or a filesystem that refuses the
             * write must not turn reading the review queue into an exception.
             * The rows are dropped again on the next read at no cost.
             */
            try {
                await this.writeJson(indexUri, data);
            } catch (e) {
                console.warn('[studio] could not prune the pending index', indexUri.toString(), e);
            }
        }

        return { available: true, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
    }

    async pendingFiles(anyUri, options) {
        return (await this.pendingFilesStatus(anyUri, options)).files;
    }

    /**
     * Every open proposal that shares `groupId`, across every document that
     * currently has pending work — the cross-file half of a linked move,
     * found without a caller having to know which document "the other side"
     * lives in.
     *
     * This walks `pendingFiles`, the same index the badges use, rather than
     * adding a second index for groups: a grouped proposal is, by
     * construction, pending in its own document until the whole group
     * resolves, so the existing "which files have open proposals" cache
     * already enumerates every place a group member can be.
     *
     * `expected` and `partial` are what make a half-resolved group visible
     * on the next load instead of silent. Each surviving member remembers,
     * in `groupMembers`, how many documents the group was created with; if
     * fewer members are still open than that, some of the group already
     * went through (or crashed partway through) a resolution and the rest
     * did not — a state that must never look like an ordinary, still-open
     * group of the same size.
     *
     * `groupId` undefined/null always returns no members, on purpose: the
     * vast majority of proposals have no groupId at all, and `p.groupId ===
     * groupId` would otherwise treat every one of them as one giant "group
     * undefined" the moment a caller forgot to pass an id. Backward
     * compatibility is the point of this field, not an afterthought, so an
     * ungrouped proposal must never be reachable through this method.
     */
    async proposalsInGroup(anyUri, groupId) {
        if (groupId === undefined || groupId === null) { return { members: [], expected: 0, partial: false }; }
        /* Unpruned on purpose: a member whose document is gone must still be
         * FOUND, so resolveGroup can refuse the whole move rather than apply
         * the half of it that still resolves. */
        const files = await this.pendingFiles(anyUri, { prune: false });
        const members = [];
        for (const file of files) {
            const { proposals } = await this.load(file.uri);
            for (const proposal of proposals) {
                if (proposal.groupId === groupId) { members.push({ uri: file.uri, proposal }); }
            }
        }
        const expected = members.reduce((max, m) => Math.max(max, (m.proposal.groupMembers || []).length), 0);
        return { members, expected, partial: members.length > 0 && expected > members.length };
    }
}

/*
 * Resolve every pending hunk in one file without opening it.
 *
 * This is what makes requirement 12's global "accept all" / "reject all"
 * honest: the other affected files are decided through exactly the same
 * diff-and-apply path the open editor uses, not left for the user to visit
 * one by one. It writes the composed body straight to disk, so a file that
 * IS open sees it as an external change and reloads through its normal path.
 *
 * Frontmatter is preserved because proposals only ever store the body — the
 * same split the editor makes on load (see splitFrontmatter's contract).
 */
async function resolveFile({ fileService, changesStore, historyStore, uri, verdict, splitFrontmatter, joinFrontmatter }) {
    const store = await changesStore.load(uri);
    if (!store.proposals.length) { return { changed: false, hunks: 0 }; }

    /* A document that is gone cannot have hunks applied to it — there is no
     * body left to compose. This used to fall through to fileService.read()
     * below and throw; the caller (decideAllFiles in markdown-editor.js)
     * turned that into an error toast and left the index row alone, which is
     * exactly why "reject all, everywhere" could not clear a stuck row for a
     * deleted document either. Clearing it through the same save([]) path an
     * ordinary resolution uses (it prunes an index entry whose pending count
     * drops to zero) is what makes the bulk action actually finish the job. */
    if (!(await fileService.exists(uri))) {
        await changesStore.save(uri, []);
        return { changed: false, hunks: 0, missing: true };
    }

    const current = await fileService.read(uri);
    const split = splitFrontmatter(current.value);
    let body = split.body;
    let decided = 0;

    for (const proposal of store.proposals) {
        const { hunks } = diffHunks(proposal.baseBody, proposal.proposedBody);
        const undecided = hunks.filter(h => !proposal.decisions[h.id]);
        for (const hunk of undecided) { proposal.decisions[hunk.id] = verdict; }
        decided += undecided.length;
        const accepted = hunks.filter(h => proposal.decisions[h.id] === 'accepted').map(h => h.id);
        body = require('./diff').applyHunks(proposal.baseBody, hunks, accepted);
        proposal.status = 'resolved';
    }

    await fileService.write(uri, joinFrontmatter(split.frontmatter, body));
    await changesStore.save(uri, store.proposals);
    if (historyStore) {
        await historyStore.record(uri, {
            kind: verdict === 'accepted' ? 'accept' : 'reject',
            title: (verdict === 'accepted' ? 'Accepted' : 'Rejected') + ' ' + decided + ' pending change' + (decided === 1 ? '' : 's'),
            detail: 'Resolved in bulk across files',
            body
        });
    }
    return { changed: true, hunks: decided, body };
}

/*
 * Resolve every member of a linked group the same way — the all-or-nothing
 * accept/reject that a cross-file move needs (CONTRACT-runner.md §6): a cut
 * in one document and an insert in another must not come apart, because a
 * half-accepted move deletes a section from one file without it ever landing
 * in the other, which loses the reader's text outright.
 *
 * WHY THIS CANNOT BE ATOMIC, AND WHAT STANDS IN FOR IT. There is no
 * transaction across two files on a plain filesystem, and this store does
 * not pretend otherwise. What it does instead is push everything that CAN be
 * checked in advance to before the first write:
 *
 *   1. Every member must still exist and be readable. A group whose second
 *      document has gone missing refuses whole rather than resolving the
 *      first document and silently stranding the second.
 *   2. Every member's document body must still match the `baseBody` its
 *      proposal was computed against. If a member's document was edited
 *      underneath the proposal — the reader touched that file while the
 *      move sat pending — the hunk was built against text that no longer
 *      exists, and applying it anyway would silently discard whatever the
 *      reader just wrote there. REFUSING THE WHOLE GROUP IS THE CHOSEN
 *      BEHAVIOUR: it is visible and recoverable (re-run once the conflict is
 *      dealt with), where accepting the still-valid half and dropping the
 *      other is a silent partial edit — exactly the failure mode this
 *      mechanism exists to prevent.
 *
 * Only once both checks pass for every member does this write anything, and
 * even then a write can still fail mid-flight (disk full, a lock, the
 * process dying) after some members are already resolved. That residual
 * risk is not swallowed: a member write is never wrapped in a try/catch that
 * lets its neighbours proceed as if nothing happened, so a real failure here
 * throws and stops immediately, leaving the group in exactly the state
 * `proposalsInGroup` above is built to recognise — some members gone,
 * others still open, `partial: true` — on the very next load. That is the
 * "detectable rather than invisible" half of the contract; re-calling
 * resolveGroup with the same verdict is the recovery, because the members
 * already resolved are already gone from their own sidecars and only the
 * survivors get touched again.
 *
 * A group with no open members left (already resolved, or never existed) is
 * a no-op: re-resolving a settled group must not be a second write.
 */
async function resolveGroup({ fileService, changesStore, historyStore, anyUri, groupId, verdict, splitFrontmatter, joinFrontmatter }) {
    const { members } = await changesStore.proposalsInGroup(anyUri, groupId);
    if (!members.length) { return { ok: true, changed: false, resolved: [] }; }

    for (const { uri, proposal } of members) {
        let current;
        try {
            if (!(await fileService.exists(uri))) { throw new Error('document is missing'); }
            current = await fileService.read(uri);
        } catch (e) {
            return { ok: false, why: 'could not read ' + uri.toString() + ' (' + e.message + ')', groupId };
        }
        if (splitFrontmatter(current.value).body !== proposal.baseBody) {
            return { ok: false, why: 'document has changed since the linked proposal was computed: ' + uri.toString(), groupId };
        }
    }

    const resolved = [];
    for (const { uri } of members) {
        const store = await changesStore.load(uri);
        const proposal = store.proposals.find(p => p.groupId === groupId);
        if (!proposal) { continue; } // a previous, partial attempt already resolved this one

        const { hunks } = diffHunks(proposal.baseBody, proposal.proposedBody);
        const undecided = hunks.filter(h => !proposal.decisions[h.id]);
        for (const hunk of undecided) { proposal.decisions[hunk.id] = verdict; }
        const accepted = hunks.filter(h => proposal.decisions[h.id] === 'accepted').map(h => h.id);
        const body = applyHunks(proposal.baseBody, hunks, accepted);
        proposal.status = 'resolved';

        const current = await fileService.read(uri);
        const split = splitFrontmatter(current.value);
        await fileService.write(uri, joinFrontmatter(split.frontmatter, body));
        await changesStore.save(uri, store.proposals);
        if (historyStore) {
            await historyStore.record(uri, {
                kind: verdict === 'accepted' ? 'accept' : 'reject',
                title: (verdict === 'accepted' ? 'Accepted' : 'Rejected') + ' a linked change',
                detail: 'Resolved together with its linked proposal in another document',
                body
            });
        }
        resolved.push(uri.toString());
    }

    return { ok: true, changed: true, resolved };
}

module.exports = { ChangesStore, newProposalId, relativePath, resolveFile, resolveGroup };
