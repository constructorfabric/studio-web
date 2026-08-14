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
const { diffHunks, countPending } = require('./diff');

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
     */
    static proposal({ title, origin, instruction, commentId, baseBody, proposedBody, author }) {
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
            status: 'open'
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
     */
    async pendingFilesStatus(anyUri) {
        const root = await this.rootFor(anyUri);
        const data = await this.readJson(this.indexUri(root), undefined);
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
            !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
            return { available: false, files: [] };
        }
        return { available: true, files: Object.entries(data.files)
            .filter(([path, info]) => typeof path === 'string' && Number.isInteger(info?.pending) && info.pending > 0)
            .map(([path, info]) => ({
                path,
                pending: info.pending,
                proposals: Number.isInteger(info.proposals) && info.proposals >= 0 ? info.proposals : 0,
                uri: new URI(root.toString() + '/' + path)
            }))
            .sort((a, b) => a.path.localeCompare(b.path)) };
    }

    async pendingFiles(anyUri) {
        return (await this.pendingFilesStatus(anyUri)).files;
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

module.exports = { ChangesStore, newProposalId, relativePath, resolveFile };
