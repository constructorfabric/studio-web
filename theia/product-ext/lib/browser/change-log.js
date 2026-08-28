/*
 * Suggestions — many authors, one document, one file each.
 *
 * WHY THIS EXISTS ALONGSIDE changes-store.js
 *
 * changes-store.js holds the ASSISTANT path: an external write is captured as
 * one proposal against one recorded base, and per-hunk verdicts compose a body
 * through applyHunks. That is unchanged and still the default review path.
 *
 * Suggesting mode is a different shape and needs a different store, for two
 * reasons that are both about plurality:
 *
 *   Many WRITERS. Several people can have a suggestion open on the same
 *   document at once. `.studio/changes/<relpath>.json` is one file rewritten in
 *   place, so two of them saving close together loses an update — the exact
 *   defect the comment log was built to end.
 *
 *   Many PROPOSALS. changes-store deliberately keeps one open proposal per
 *   document and EXTENDS it rather than stacking. Google Docs needs N
 *   suggestions from M authors, each decidable on its own.
 *
 * So the layout follows the precedent comments set, one directory per document
 * and one file per author:
 *
 *   <root>/.studio/changes/docs/prd.md/local-roman-novikov.json
 *   <root>/.studio/changes/docs/prd.md/agent-claude.json
 *   <root>/.studio/changes/docs/prd.md.json      <- changes-store's, untouched
 *   <root>/.studio/changes/index.json            <- the pending index, untouched
 *
 * A file is written by exactly one author and read by everyone. Single writer
 * per file is what removes the lost update; it is the same guarantee the comment
 * log gets, by a cheaper route.
 *
 * WHY NOT AN APPEND-ONLY OP LOG, like comments
 *
 * Comments are `.jsonl` because a review conversation must not be quietly
 * rewritable: a withdrawn message has to stay visible AS withdrawn. A suggestion
 * is not that. It is a live editing state, revised on every pause by its author,
 * and an op log would grow an op per keystroke burst for a value only ever read
 * at its latest. The audit trail is not lost by this — history-store.js already
 * records every proposal and every verdict as an append-only entry with an
 * author and a timestamp. That is the record; this directory is the working set.
 *
 * THE IDEA THAT MAKES N PROPOSALS WORK: INTENT, RE-ANCHORED
 *
 * A suggestion stores the body its author proposes AND the document body they
 * were working from. Both are needed, and the reason is worth stating because
 * getting it wrong is silent and destructive.
 *
 * A suggestion is a whole-document snapshot, so diffing it against the CURRENT
 * document conflates two different things: what its author asked for, and every
 * change anyone else has had accepted since. Measured, on two authors editing one
 * file: Alex's edit is accepted, and Roman's suggestion — untouched, and nowhere
 * near Alex's line — immediately reads as proposing to REVERT Alex's change,
 * because Roman's snapshot predates it. Accepting Roman's suggestion would then
 * quietly undo Alex's, which is the worst failure this whole feature could have.
 *
 * So the author's INTENT is `diff(theirBase, theirProposal)` — computed against
 * the base they actually saw — and that is the only thing this store ever offers
 * for decision. Each intent hunk is then re-anchored in the live document by
 * CONTENT (findLines), because position cannot survive an accepted change above
 * it. A hunk whose original text is still there is offered at its new position; a
 * hunk whose text is gone is a genuine conflict with somebody else's accepted
 * change and is marked `conflicted` rather than dropped, because a suggestion
 * that silently stops saying what its author meant is worse than one that says it
 * cannot be applied.
 *
 * The re-anchoring is done at DERIVATION time and never written. A suggestion is
 * therefore always read as current without anybody's file being rewritten, which
 * matters because another author's file is not this client's to write.
 *
 * WHAT A VERDICT IS KEYED TO, and why not the hunk id
 *
 * diff.js hashes a hunk id from its content AND its position in the base, which
 * is correct for a fixed base and useless for a moving one — accepting anything
 * above a hunk changes its id. So a verdict here is keyed by CONTENT alone
 * (`hunkKey`): the old lines and the new lines, nothing positional. A rejected
 * suggestion therefore stays rejected when it moves down the page, and an
 * author who revises a suggestion without touching a rejected part does not
 * resurrect it.
 *
 * ACCEPT and REJECT are asymmetric here, and that follows from the above:
 * accepting writes the text into the document, after which the hunk is simply
 * gone from the next derivation and needs no record. Rejecting must be
 * REMEMBERED, or the hunk reappears on every render. So this store persists
 * rejections and not acceptances — the acceptance is persisted as the document.
 *
 * A verdict lives in the file of whoever CAST it, not of whoever authored the
 * proposal. A reviewer writes to their own file and nobody else's, the same rule
 * as the comment log, for the same reason.
 */

const { URI } = require('@theia/core/lib/common/uri');
const { identity, authorRecord, keyForId } = require('./identity');
const { diffHunks, hash, splitLines } = require('./diff');

const CHANGES_DIR = '.studio/changes';

function relativePath(rootUri, docUri) {
    const rootStr = rootUri.toString();
    const docStr = docUri.toString();
    return docStr.startsWith(rootStr) ? docStr.slice(rootStr.length).replace(/^\//, '') : docUri.path.base;
}

/* Derived from changes-store's own path so the two layouts cannot drift. Only
 * one trailing '.json' is stripped, so a document actually called data.json
 * lands in `…/data.json/` — the same rule comment-log.js documents. */
function legacyUri(rootUri, docUri) {
    return new URI(rootUri.toString() + '/' + CHANGES_DIR + '/' + relativePath(rootUri, docUri) + '.json');
}

function logDirUri(rootUri, docUri) {
    return new URI(legacyUri(rootUri, docUri).toString().replace(/\.json$/, ''));
}

function fileUriFor(rootUri, docUri, author) {
    return new URI(logDirUri(rootUri, docUri).toString() + '/' + keyForId(authorRecord(author).id) + '.json');
}

/**
 * A verdict key: what the change IS, with no reference to where it is.
 *
 * See the header. This is the one thing that must not be the hunk id.
 */
function hunkKey(hunk) {
    return 'k' + hash(hunk.oldLines.join('\n') + '\u0000' + hunk.newLines.join('\n'));
}

/** True when `author` is the person using this window. */
function isMine(author) {
    return authorRecord(author).id === identity.current().id;
}

/**
 * Find a run of lines in a document, by content.
 *
 * Re-anchoring needs to answer "is the text this suggestion was written against
 * still here, and where". Position cannot answer it — an accepted change above
 * shifts everything below — so the answer is a content search, the same way a
 * comment thread re-anchors to its quote rather than to an offset.
 *
 * `near` biases the search to the neighbourhood the hunk used to be in, so a
 * document containing the same line twice re-anchors to the closer one.
 */
function findLines(lines, needle, near) {
    if (!needle.length) { return -1; }
    const matches = [];
    for (let start = 0; start <= lines.length - needle.length; start++) {
        let hit = true;
        for (let i = 0; i < needle.length; i++) {
            if (lines[start + i] !== needle[i]) { hit = false; break; }
        }
        if (hit) { matches.push(start); }
    }
    if (!matches.length) { return -1; }
    if (near === undefined) { return matches[0]; }
    return matches.reduce((best, at) => Math.abs(at - near) < Math.abs(best - near) ? at : best, matches[0]);
}

/**
 * What one suggestion is asking for, expressed against the document as it now
 * stands.
 *
 * See the header: the author's intent is diffed against THEIR base, never against
 * the current document, and then re-anchored into it. That is what stops a
 * suggestion written before somebody else's change from appearing to revert it.
 *
 * Every returned hunk carries:
 *   key         the content-only verdict key (see hunkKey)
 *   rejected    this reviewer has already dismissed it
 *   conflicted  the text it edits is no longer in the document, so it cannot be
 *               applied — offered for dismissal only
 *
 * Rejected and conflicted hunks are RETURNED, not filtered: a reviewer who
 * dismissed something still needs to see that they did, and undo it.
 */
function suggestionHunks(proposal, documentBody, rejections) {
    /* A suggestion written before this store existed, or one whose base was not
     * recorded, degrades to the current document as its base. That is the old
     * behaviour and it is the conservative fallback — never a crash. */
    const base = typeof proposal.baseBody === 'string' ? proposal.baseBody : documentBody;
    const intent = diffHunks(base, proposal.proposedBody).hunks;
    const lines = splitLines(documentBody);

    const out = [];
    for (const hunk of intent) {
        const key = hunkKey(hunk);
        const rejected = !!(rejections && rejections[key]);
        /* A pure insertion has no old text to search for, so it anchors to the
         * context line before it instead. */
        const needle = hunk.oldLines.length ? hunk.oldLines : hunk.before;
        const at = needle.length ? findLines(lines, needle, hunk.oldStart) : hunk.oldStart;
        if (at === -1) {
            out.push({ ...hunk, key, rejected, conflicted: true });
            continue;
        }
        const oldStart = hunk.oldLines.length ? at : at + needle.length;
        out.push({ ...hunk, key, rejected, conflicted: false, oldStart });
    }
    /* Document order, so applyHunks and the rail agree about sequence. */
    return out.sort((a, b) => a.oldStart - b.oldStart);
}

/** Hunks a reviewer has not answered yet — the badge number, per suggestion. */
function openHunks(proposal, documentBody, rejections) {
    return suggestionHunks(proposal, documentBody, rejections)
        .filter(h => !h.rejected && !h.conflicted);
}

class ChangeLog {

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

    async readJson(uri, fallback) {
        try {
            if (!(await this.fileService.exists(uri))) { return fallback; }
            const parsed = JSON.parse((await this.fileService.read(uri)).value);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
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
    }

    /**
     * Every open suggestion on this document, from every author, plus MY
     * rejections.
     *
     * Rejections are read only from my own file on purpose. A verdict is a
     * reviewer's own answer, and folding everyone's together would mean somebody
     * else's dismissal silently hides a suggestion from me — which is a decision
     * about my review that they do not get to make. Roles would change this;
     * absent roles, each reviewer sees the full set and answers it themselves.
     */
    async load(docUri) {
        const root = await this.rootFor(docUri);
        const dir = logDirUri(root, docUri);
        const proposals = [];
        let entries = [];

        try {
            if (await this.fileService.exists(dir)) {
                const stat = await this.fileService.resolve(dir);
                entries = (stat.children || [])
                    .filter(child => !child.isDirectory && /\.json$/.test(child.resource.path.base));
            }
        } catch (e) {
            console.warn('[studio] could not list', dir.toString(), e);
        }

        let rejections = {};
        const myKey = keyForId(identity.current().id) + '.json';

        for (const entry of entries) {
            const data = await this.readJson(entry.resource, undefined);
            if (!data || data.version !== 1) { continue; }
            for (const proposal of Array.isArray(data.proposals) ? data.proposals : []) {
                if (!proposal || !proposal.id || typeof proposal.proposedBody !== 'string') { continue; }
                if (proposal.status === 'withdrawn') { continue; }
                proposals.push({ ...proposal, by: proposal.by || data.by, kind: 'suggestion' });
            }
            if (entry.resource.path.base === myKey && data.rejections && typeof data.rejections === 'object') {
                rejections = data.rejections;
            }
        }

        /* Oldest first, so a counter-suggestion renders under the thing it
         * answers rather than above it. */
        proposals.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
        return { proposals, rejections };
    }

    async loadFile(docUri, author) {
        const root = await this.rootFor(docUri);
        const data = await this.readJson(fileUriFor(root, docUri, author), undefined);
        const valid = data && data.version === 1 ? data : undefined;
        return {
            version: 1,
            by: authorRecord(author),
            proposals: valid && Array.isArray(valid.proposals) ? valid.proposals : [],
            rejections: valid && valid.rejections && typeof valid.rejections === 'object' ? valid.rejections : {}
        };
    }

    async saveFile(docUri, author, data) {
        const root = await this.rootFor(docUri);
        await this.writeJson(fileUriFor(root, docUri, author), {
            version: 1,
            by: authorRecord(author),
            proposals: (data.proposals || []).filter(p => p && p.status !== 'withdrawn'),
            rejections: data.rejections || {}
        });
    }

    /**
     * Create or revise one author's suggestion on this document.
     *
     * One open suggestion per author per document — the same rule the assistant
     * store enforces globally, scoped to the author it belongs to. Suggesting
     * mode revises this record on every pause, so a second one per author would
     * put a card on the rail per keystroke burst.
     *
     * An empty diff between the proposal and the document withdraws it. An
     * author who undoes their own suggestion back to the document has no
     * suggestion, and leaving one open would put a card with nothing in it on
     * the rail. This is intentionally NOT `proposedBody === documentBody`: a
     * round-trip through re-wrapping or re-serialisation can change the exact
     * string without changing a single line the reviewer would see, which used
     * to leave an unkillable card behind.
     */
    async upsert(docUri, author, { documentBody, proposedBody, title, origin, instruction, commentId, inReplyTo }) {
        const record = authorRecord(author);
        const file = await this.loadFile(docUri, record);
        const open = file.proposals.find(p => p.status !== 'withdrawn');
        const now = new Date().toISOString();

        if (diffHunks(documentBody, proposedBody).hunks.length === 0) {
            if (!open) { return undefined; }
            file.proposals = file.proposals.filter(p => p !== open);
            await this.saveFile(docUri, record, file);
            return undefined;
        }

        if (open) {
            /*
             * The base moves with the revision, deliberately. The author is
             * looking at the document as it is NOW while they revise, so that is
             * what their next intent is expressed against — pinning the base at
             * first-write would make every change accepted in the meantime part
             * of their suggestion.
             */
            open.baseBody = documentBody;
            open.proposedBody = proposedBody;
            open.updatedAt = now;
            if (title) { open.title = title; }
            if (instruction) { open.instruction = instruction; }
            if (inReplyTo) { open.inReplyTo = inReplyTo; }
            await this.saveFile(docUri, record, file);
            return { ...open, by: record, kind: 'suggestion' };
        }

        const proposal = {
            id: 'p-' + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) +
                '-' + (globalThis.crypto && globalThis.crypto.randomUUID
                    ? globalThis.crypto.randomUUID().slice(0, 6)
                    : Math.floor(Math.random() * 1e6).toString(36)),
            title: title || 'Suggestions from ' + record.name,
            origin: origin || 'suggest-mode',
            instruction: instruction || '',
            commentId: commentId || undefined,
            inReplyTo: inReplyTo || undefined,
            by: record,
            author: record.name,
            createdAt: now,
            updatedAt: now,
            baseBody: documentBody,
            proposedBody,
            status: 'open'
        };
        file.proposals.push(proposal);
        await this.saveFile(docUri, record, file);
        return { ...proposal, kind: 'suggestion' };
    }

    /**
     * Withdraw a suggestion.
     *
     * Only ever the author's own. A reviewer who wants somebody's suggestion
     * gone rejects it, which is recorded as their answer in their own file — it
     * does not reach into the author's file and remove what they wrote. That is
     * the repository's standing rule about a person's words, applied to a
     * proposal.
     */
    async withdraw(docUri, author, proposalId) {
        const record = authorRecord(author);
        if (!isMine(record)) { return false; }
        const file = await this.loadFile(docUri, record);
        const before = file.proposals.length;
        file.proposals = file.proposals.filter(p => p.id !== proposalId);
        if (file.proposals.length === before) { return false; }
        await this.saveFile(docUri, record, file);
        return true;
    }

    /**
     * Remember that I rejected this change, or forget it again.
     *
     * Keyed by content (see hunkKey), written to my own file. Acceptance has no
     * counterpart here because accepting writes the text into the document — the
     * document IS the record of it.
     */
    async reject(docUri, key, on) {
        const me = identity.current();
        const file = await this.loadFile(docUri, me);
        if (on) {
            file.rejections[key] = { at: new Date().toISOString(), by: me };
        } else {
            delete file.rejections[key];
        }
        await this.saveFile(docUri, me, file);
        return file.rejections;
    }

    /**
     * Watch every author's file for this document.
     *
     * Watches `<root>/.studio/changes`, not the document's own directory, for the
     * reason comment-log.js records at length: a document with no suggestions has
     * no directory, and a Theia watch registered on a path that does not exist is
     * silently inert and never recovers when the path appears — so the FIRST
     * person to suggest would never see the second person's suggestion, which is
     * the only case collaboration means. The prefix filter keeps it precise
     * despite the broader subscription.
     *
     * Fires for this client's own writes too. That is a debounce rather than write
     * bookkeeping, so the caller has to drop a reload that says nothing new — the
     * same contract the comment log states.
     */
    async watch(docUri, onChange) {
        const root = await this.rootFor(docUri);
        const prefix = logDirUri(root, docUri).toString() + '/';
        const disposables = [];
        try {
            disposables.push(this.fileService.watch(new URI(root.toString() + '/' + CHANGES_DIR)));
        } catch (e) {
            console.warn('[studio] could not watch the suggestion files', prefix, e);
        }
        let timer;
        disposables.push(this.fileService.onDidFilesChange(event => {
            const touched = (event && event.changes ? event.changes : [])
                .some(change => change.resource && change.resource.toString().startsWith(prefix));
            if (!touched) { return; }
            clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    onChange(await this.load(docUri));
                } catch (e) {
                    console.warn('[studio] could not re-read the suggestion files', prefix, e);
                }
            }, 200);
        }));
        return {
            dispose() {
                clearTimeout(timer);
                disposables.forEach(d => { try { d && d.dispose && d.dispose(); } catch (e) { /* already disposed */ } });
                disposables.length = 0;
            }
        };
    }

    /** Total unanswered suggestion hunks on this document, for the badge. */
    pendingCount(proposals, documentBody, rejections) {
        return (proposals || []).reduce((sum, p) =>
            sum + openHunks(p, documentBody, rejections).length, 0);
    }
}

module.exports = {
    ChangeLog, hunkKey, isMine, suggestionHunks, openHunks, findLines,
    logDirUri, fileUriFor, legacyUri
};
