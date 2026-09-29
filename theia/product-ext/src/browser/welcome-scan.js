/*
 * The start page, as arithmetic — no DOM, no Theia, nothing that needs a window.
 *
 * Same split as `search-scan.js` and `collab-scan.js`: what the start page
 * decides — which documents count as recent, which threads are waiting for the
 * person looking, what a proposal row says, what a new document is called, when
 * the page explains the product instead of listing work — is a pure question
 * with a checkable answer, and it is tested in node (test/welcome.test.js).
 * `welcome-view.js` owns the reads and the paint and nothing else.
 *
 * WHAT THE PAGE IS ALLOWED TO CLAIM. Everything on it is read from files the
 * project already has, at the moment the page is shown:
 *
 *   - recent documents from the tree's own mtimes, plus the documents this
 *     browser opened (the one fact the files cannot hold, kept per project in
 *     local storage and labelled as "opened", never as "edited");
 *   - threads from the per-author comment logs, folded by comment-log.js;
 *   - proposals from `.studio/changes/index.json` and the per-document files it
 *     names.
 *
 * No indexer, no background walk. The walk here is bounded by a file count and
 * a depth, and when a bound bites the page says so rather than implying it saw
 * the whole tree.
 */

const collabScan = require('./collab-scan');

/* What the start page calls a document: the files Doc editing opens as prose. */
const DOC_EXTENSIONS = ['.md', '.markdown'];

/* Rows per section. A start page is a glance, not a list; the Collaboration page
 * and Search are where the whole list lives. */
const RECENT_MAX = 6;
const WAITING_MAX = 5;
const PENDING_MAX = 5;

/* The walk's bounds. Generous for a document project, small enough that a
 * repository with a vendored tree does not turn an empty dock into a
 * file-server workout. */
const WALK_MAX_FILES = 1500;
const WALK_MAX_DEPTH = 8;
const WALK_SKIP = new Set(['.studio', '.git', 'node_modules', 'target', 'dist', 'lib', 'build', 'out']);

/* How many opened documents this browser remembers per project. */
const OPENED_MAX = 12;

function isDocument(path) {
    const lower = String(path || '').toLowerCase();
    return DOC_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/*
 * A uri string is percent-encoded — `docs/Q3%20rollout.md` — and a path shown
 * to a person or remembered as a key is not. Decoded once, here, so a name with
 * a space reads as typed and an opened document matches its walked twin.
 */
function decodePath(path) {
    try { return decodeURIComponent(String(path || '')); } catch (e) { return String(path || ''); }
}

function relativeTo(rootString, uriString) {
    const root = String(rootString || '');
    const uri = String(uriString || '');
    if (!root || !uri.startsWith(root + '/')) { return undefined; }
    return decodePath(uri.slice(root.length + 1));
}

function baseName(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1];
}

function folderOf(path) {
    const parts = String(path || '').split('/');
    parts.pop();
    return parts.join('/');
}

/**
 * Every document under a root, with its mtime, depth-first and bounded.
 *
 * The file service is a parameter so this runs against a fake in node. It is
 * asked for directory listings only — `resolve` with metadata hands back each
 * child's mtime, so no document is read to be listed.
 *
 * @returns {{ files: [{path, uri, mtime}], truncated: boolean, skipped: number }}
 */
async function walkDocuments(fileService, rootUri, token = {}, limits = {}) {
    const maxFiles = limits.maxFiles === undefined ? WALK_MAX_FILES : limits.maxFiles;
    const maxDepth = limits.maxDepth === undefined ? WALK_MAX_DEPTH : limits.maxDepth;
    const rootString = rootUri.toString();
    const out = { files: [], truncated: false, skipped: 0, entries: 0 };

    async function visit(dirUri, depth) {
        if (token.cancelled) { return; }
        if (depth > maxDepth) { out.truncated = true; return; }
        let stat;
        try {
            stat = await fileService.resolve(dirUri, { resolveMetadata: true });
        } catch (e) {
            out.skipped++;
            return;
        }
        const children = ((stat && stat.children) || []).slice()
            .sort((a, b) => a.resource.toString().localeCompare(b.resource.toString()));
        for (const child of children) {
            if (token.cancelled) { return; }
            if (out.entries >= maxFiles) { out.truncated = true; return; }
            out.entries++;
            const base = child.resource.path.base;
            if (child.isDirectory) {
                if (WALK_SKIP.has(base) || base.startsWith('.')) { continue; }
                await visit(child.resource, depth + 1);
                continue;
            }
            if (!isDocument(base)) { continue; }
            const uri = child.resource.toString();
            out.files.push({ path: relativeTo(rootString, uri) || decodePath(base), uri, mtime: Number(child.mtime) || 0 });
        }
    }

    await visit(rootUri, 0);
    return { files: out.files, truncated: out.truncated, skipped: out.skipped, entries: out.entries };
}

/**
 * Remember that a document was opened. Most recent first, one row per path.
 * Returns a new list; the caller persists it.
 */
function rememberOpened(list, path, at, max = OPENED_MAX) {
    if (!path || !isDocument(path)) { return (list || []).slice(0, max); }
    const kept = (Array.isArray(list) ? list : [])
        .filter(entry => entry && typeof entry.path === 'string' && entry.path !== path);
    return [{ path, at: Number(at) || Date.now() }, ...kept].slice(0, max);
}

/**
 * The recent documents: the tree's own mtimes, merged with what this browser
 * opened.
 *
 * One row per path, stamped with whichever happened later, and the row says
 * which — "edited" is a fact about the file, "opened" is a fact about this
 * browser, and the two must not read alike.
 *
 * A remembered path the walk did not find is dropped when the walk was complete
 * (the document is gone) and kept when it was not (it may simply be past the
 * bound).
 */
function recentDocuments(walk, opened, options = {}) {
    const max = options.max === undefined ? RECENT_MAX : options.max;
    const rootString = options.rootString || '';
    const files = (walk && walk.files) || [];
    const complete = !(walk && walk.truncated);
    const byPath = new Map();

    for (const file of files) {
        if (!file.mtime) { continue; }
        byPath.set(file.path, { path: file.path, uri: file.uri, at: file.mtime, reason: 'edited' });
    }
    const onDisk = new Set(files.map(file => file.path));
    for (const entry of opened || []) {
        if (!entry || !entry.path || !isDocument(entry.path)) { continue; }
        if (complete && !onDisk.has(entry.path)) { continue; }
        const at = Number(entry.at) || 0;
        const known = byPath.get(entry.path);
        if (known && known.at >= at) { continue; }
        const file = files.find(f => f.path === entry.path);
        byPath.set(entry.path, {
            path: entry.path,
            uri: file ? file.uri : (rootString ? rootString + '/' + entry.path.split('/').map(encodeURIComponent).join('/') : entry.path),
            at,
            reason: 'opened'
        });
    }

    return [...byPath.values()]
        .sort((a, b) => (b.at - a.at) || a.path.localeCompare(b.path))
        .slice(0, max)
        .map(row => Object.assign(row, { name: baseName(row.path), folder: folderOf(row.path) }));
}

/**
 * "Waiting for you", or — when that cannot be told — every open thread, saying
 * so.
 *
 * What CAN be told, from the data: a thread mentions me (`@name` in a message),
 * or I wrote in it and the last word is somebody else's. Both come from
 * collab-scan.js, so this page and the Collaboration page agree about what
 * "waiting on you" means. What cannot be told: who a thread is assigned to
 * (threads carry no assignee) and whether I have read it (nothing tracks
 * reads).
 *
 * And none of it can be told for a person with no name: an unnamed identity
 * matches no mention and may have written under another name. Then the section
 * lists the open threads and says why.
 */
function waitingSection(inboxResult, me, options = {}) {
    const max = options.max === undefined ? WAITING_MAX : options.max;
    const items = (inboxResult && inboxResult.items) || [];
    const open = items.length;
    const known = !!(me && me.name && !me.unnamed);

    if (!known) {
        return {
            mode: 'open',
            title: 'Open threads',
            items: items.slice(0, max),
            more: Math.max(0, open - max),
            open,
            note: open
                ? 'You are not signed in under a name, so which of these wait for you cannot be told.'
                : ''
        };
    }

    const mine = items.filter(item => item.mentionsMe || item.waitingOnMe);
    return {
        mode: 'mine',
        title: 'Waiting for you',
        items: mine.slice(0, max),
        more: Math.max(0, mine.length - max),
        open,
        others: open - mine.length,
        note: ''
    };
}

/** The tag a waiting row carries: why it is on the list. */
function waitingReason(item) {
    if (item.mentionsMe) { return 'mentions you'; }
    if (item.waitingOnMe) { return 'your turn'; }
    return '';
}

/**
 * The proposals waiting for a decision, one row per document.
 *
 * `pending` is ChangesStore.pendingFilesStatus's answer; `details` maps a path
 * to that document's open proposals, read for the rows that will be shown
 * only. A row with no readable details still shows its count: the index is
 * the authority on "something is waiting", the per-document file only adds
 * words to it.
 */
function pendingSection(pending, details, options = {}) {
    const max = options.max === undefined ? PENDING_MAX : options.max;
    const available = !!(pending && pending.available);
    const files = ((pending && pending.files) || []).filter(file => file && file.pending > 0);
    const rows = files.map(file => {
        const proposals = ((details && details[file.path]) || []).filter(p => p && p.status !== 'resolved');
        const newest = proposals.slice().sort((a, b) =>
            String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
        return {
            path: file.path,
            uri: file.uri ? file.uri.toString() : '',
            name: baseName(decodePath(file.path)),
            folder: folderOf(decodePath(file.path)),
            pending: file.pending,
            proposals: proposals.length || file.proposals || 0,
            title: newest ? collabScan.clip(newest.title || '', 80) : '',
            author: newest ? String(newest.author || '') : '',
            at: newest ? newest.createdAt : undefined
        };
    }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || a.path.localeCompare(b.path));
    return {
        available,
        rows: rows.slice(0, max),
        more: Math.max(0, rows.length - max),
        total: rows.reduce((sum, row) => sum + row.pending, 0)
    };
}

/** "3 changes in 2 documents", the pending section's count line. */
function pendingCountText(section) {
    const documents = section.rows.length + section.more;
    if (!documents) { return ''; }
    return collabScan.plural(section.total, 'change', 'changes') + ' in ' +
        collabScan.plural(documents, 'document', 'documents');
}

/**
 * Whether the page explains the product.
 *
 * On first run, and whenever there is nothing to list: a project with no
 * documents, no threads and no proposals has no start page to show, and the
 * explanation is the useful thing on the screen. A project with work in it gets
 * the work.
 */
function showExplainer(state) {
    if (!state || !state.hasProject) { return true; }
    if (state.firstRun) { return true; }
    return !state.documents && !state.threads && !state.pending;
}

/**
 * A name typed for a new document, as the path it will be created at.
 *
 * Relative to the project root. `.md` is added when no document extension was
 * typed; a path that climbs out of the project, starts at the root of the
 * filesystem or names a hidden folder is refused with a sentence rather than
 * normalised into something the person did not type.
 */
function newDocumentPath(input) {
    const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
    if (!raw) { return { ok: false, reason: 'Type a name for the document.' }; }
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
        return { ok: false, reason: 'Give a name inside the project, not a full path.' };
    }
    const parts = raw.split('/').filter(part => part.length);
    if (parts.some(part => part === '..' || part === '.')) {
        return { ok: false, reason: 'The document has to stay inside the project.' };
    }
    if (parts.some(part => part.startsWith('.'))) {
        return { ok: false, reason: 'Names starting with a dot are hidden. Pick another.' };
    }
    if (parts.some(part => /[<>:"|?*\u0000-\u001f]/.test(part))) {
        return { ok: false, reason: 'The name has a character a file name cannot hold.' };
    }
    let path = parts.join('/');
    if (!isDocument(path)) { path += '.md'; }
    return { ok: true, path };
}

/** The heading a new document starts with: "q3-rollout_plan.md" -> "Q3 rollout plan". */
function titleFromPath(path) {
    const name = baseName(path).replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) { return 'Untitled'; }
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The one line at the foot of the page: what was read, and where it stopped.
 */
function honestyLine(stats) {
    const parts = [];
    const s = stats || {};
    if (s.walkTruncated) {
        parts.push('The walk for recent documents stopped after ' + collabScan.plural(s.walked || 0, 'entry', 'entries') +
            '; a document deeper in the tree may be missing.');
    }
    if (s.unreadable) { parts.push(collabScan.plural(s.unreadable, 'comment log', 'comment logs') + ' could not be read.'); }
    if (s.cappedDocuments) { parts.push('Comments were read from the first ' + s.commentDocuments + ' documents only.'); }
    parts.push('Read from this project’s files when the page opened. Comments made in connected tools are not here.');
    return parts.join(' ');
}

module.exports = {
    DOC_EXTENSIONS, RECENT_MAX, WAITING_MAX, PENDING_MAX, WALK_MAX_FILES, WALK_MAX_DEPTH, OPENED_MAX,
    isDocument, decodePath, relativeTo, baseName, folderOf,
    walkDocuments, rememberOpened, recentDocuments,
    waitingSection, waitingReason, pendingSection, pendingCountText,
    showExplainer, newDocumentPath, titleFromPath, honestyLine,
    ageText: collabScan.ageText, agoText: collabScan.agoText
};
