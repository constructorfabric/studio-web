/*
 * Document history — the audit trail behind requirement 13.
 *
 *   <root>/.studio/history/docs/prd.md.json
 *
 * An append-only entry list, capped, with a full document snapshot attached
 * to the entry kinds that actually changed content. Snapshots are what make
 * "compare two versions" and "restore" possible without a Git dependency:
 * the product deliberately hides the stock Git UI (see the feasibility
 * notes), so history cannot be delegated to commits it has no surface for.
 *
 * Storing whole snapshots rather than patches is a size-for-simplicity trade
 * that is right at this scale — these are prose documents of a few kilobytes,
 * and a snapshot cannot drift out of sync with the entry that names it the
 * way a chain of patches can.
 */

const { URI } = require('@theia/core/lib/common/uri');

const HISTORY_DIR = '.studio/history';

// Enough to review a working session without the sidecar growing without
// bound. Trimming drops the OLDEST entries, so the restorable window is
// always the most recent work.
const MAX_ENTRIES = 200;

// Consecutive manual edits by the same author inside this window collapse
// into one entry whose snapshot keeps moving forward. Without it, an
// autosave every 700ms would bury the AI and comment events — the ones a
// reviewer actually scans for — under hundreds of keystroke checkpoints.
const COALESCE_MS = 120_000;

const KINDS = {
    edit: { label: 'Edited', snapshot: true },
    restore: { label: 'Restored', snapshot: true },
    accept: { label: 'Accepted change', snapshot: true },
    reject: { label: 'Rejected change', snapshot: true },
    proposal: { label: 'AI proposed changes', snapshot: false },
    comment: { label: 'Commented', snapshot: false },
    'comment-resolved': { label: 'Resolved comment', snapshot: false },
    'remote-edit': { label: 'Collaborator edited', snapshot: true }
};

function newEntryId() {
    return 'e-' + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) +
        '-' + Math.floor(Math.random() * 1e4).toString(36);
}

class HistoryStore {

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

    async sidecarUri(docUri) {
        const root = await this.rootFor(docUri);
        const rootStr = root.toString();
        const docStr = docUri.toString();
        const rel = docStr.startsWith(rootStr) ? docStr.slice(rootStr.length).replace(/^\//, '') : docUri.path.base;
        return new URI(rootStr + '/' + HISTORY_DIR + '/' + rel + '.json');
    }

    async load(docUri) {
        const uri = await this.sidecarUri(docUri);
        try {
            if (!(await this.fileService.exists(uri))) { return { version: 1, entries: [] }; }
            const parsed = JSON.parse((await this.fileService.read(uri)).value);
            return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
        } catch (e) {
            console.warn('[studio] could not read history', uri.toString(), e);
            return { version: 1, entries: [] };
        }
    }

    async write(docUri, entries) {
        const uri = await this.sidecarUri(docUri);
        const body = JSON.stringify({ version: 1, entries }, undefined, 2) + '\n';
        try {
            await this.fileService.write(uri, body);
        } catch (e) {
            const { BinaryBuffer } = require('@theia/core/lib/common/buffer');
            await this.fileService.createFile(uri, BinaryBuffer.fromString(body), { overwrite: true });
        }
        return uri;
    }

    /**
     * Append one event.
     *
     * @param entry.kind   a key of KINDS above
     * @param entry.title  what changed, in the user's terms
     * @param entry.detail optional secondary line (where, or how much)
     * @param entry.body   document body to snapshot, when the kind takes one
     */
    async record(docUri, entry) {
        const store = await this.load(docUri);
        const entries = store.entries;
        const spec = KINDS[entry.kind] || { label: entry.kind, snapshot: false };

        const record = {
            id: newEntryId(),
            at: new Date().toISOString(),
            author: entry.author || 'you',
            kind: entry.kind,
            label: spec.label,
            title: entry.title || spec.label,
            detail: entry.detail || '',
            proposalId: entry.proposalId,
            commentId: entry.commentId,
            hunkId: entry.hunkId
        };
        if (spec.snapshot && entry.body !== undefined) { record.snapshot = entry.body; }

        const last = entries[entries.length - 1];
        const coalesces = last && entry.kind === 'edit' && last.kind === 'edit' &&
            last.author === record.author &&
            (Date.parse(record.at) - Date.parse(last.at)) < COALESCE_MS;

        if (coalesces) {
            last.at = record.at;
            last.title = record.title;
            last.detail = record.detail;
            if (record.snapshot !== undefined) { last.snapshot = record.snapshot; }
        } else {
            entries.push(record);
        }

        while (entries.length > MAX_ENTRIES) { entries.shift(); }
        await this.write(docUri, entries);
        return entries;
    }
}

module.exports = { HistoryStore, KINDS };
