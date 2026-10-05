/*
 * What the Documents editor hands theia/studio's rendered comparison
 * (`studio.markdownDiff.compare`, docs/rendered-markdown-diff.md), worked out
 * here so the decisions can be tested without an editor.
 *
 * Three of them are about other people, and that is why this module exists:
 *
 *   WHAT A COLLEAGUE CHANGED. A colleague's save is applied in place
 *   (applyRemoteEdit) and named in the status line for five seconds — and
 *   then the change is simply part of the text, with nothing to say what it
 *   was. With autosave on the other side those saves arrive every second, so
 *   "what changed" is not one save but a run of them: from the version I had
 *   before they started to the one I have now. `coalesceRemoteChange` keeps
 *   that run as one change.
 *
 *   WHAT ANY RECORDED VERSION CHANGED. The history rail records a snapshot
 *   with every entry that changed content; the change an entry made is its
 *   snapshot against the one recorded before it. That is how a colleague's
 *   edit stays readable after the status line has moved on.
 *
 *   WHOSE VERSION IS ON DISK. A conflict compares the file against my unsaved
 *   work, and the file was written by somebody. When co-editing knows who
 *   (collab.lastWriter), the column says so rather than "On disk".
 */

const RENDERED_COMPARE_COMMAND = 'studio.markdownDiff.compare';
const RENDERED_HEAD_COMMAND = 'studio.markdownDiff.compareWithHead';

/*
 * How long a pause still continues the same colleague's change. Their
 * autosave writes about every second while they type; a gap longer than this
 * is a new piece of work, and "what changed" starts again from what I had.
 */
const REMOTE_RUN_GAP_MS = 2 * 60 * 1000;

/**
 * The colleague's change as I should see it, after one more of their saves.
 *
 * @param previous  the change kept so far, or undefined
 * @param save      { author, before, after, at } — `before` is the body I had
 *                  just before this save was applied, `after` what it applied
 * @returns the change to keep: `before` reaches back to the start of an
 *          uninterrupted run by the same author
 */
function coalesceRemoteChange(previous, save, gapMs) {
    const gap = gapMs === undefined ? REMOTE_RUN_GAP_MS : gapMs;
    const continues = !!previous &&
        previous.author === save.author &&
        // Nothing happened in between: what I had is exactly what they last gave me.
        previous.after === save.before &&
        save.at - previous.at <= gap;
    return {
        author: save.author,
        before: continues ? previous.before : save.before,
        after: save.after,
        since: continues ? previous.since : save.at,
        at: save.at
    };
}

function timeLabel(at) {
    const d = new Date(at);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** The comparison request for a colleague's change. */
function remoteChangeRequest(change, docName) {
    if (!change || change.before === change.after) { return undefined; }
    return {
        title: docName + ' (' + change.author + '’s changes)',
        left: { content: change.before, label: 'Before ' + change.author + ' · ' + timeLabel(change.since) },
        right: { content: change.after, label: change.author + ' · ' + timeLabel(change.at) }
    };
}

function entryLabel(entry) {
    return entry.title + ' · ' + entry.author + ' · ' + new Date(entry.at).toLocaleString();
}

/**
 * What one history entry changed: its snapshot against the last DIFFERENT
 * snapshot recorded before it. `entries` are in the order the store keeps them,
 * oldest first. Undefined when the entry has no snapshot, or nothing different
 * came before it.
 *
 * Different, not merely earlier, because the history of a shared checkout is
 * written by every editor open on it: Alice's own "Edited" entry and Bob's
 * "Alice edited this document" record the same bytes, one after the other, and
 * the second compared with the first is "no changes" — true, and useless.
 */
function entryChangeRequest(entries, entryId, docName) {
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0 || entries[index].snapshot === undefined) { return undefined; }
    let previous;
    for (let i = index - 1; i >= 0; i--) {
        if (entries[i].snapshot !== undefined && entries[i].snapshot !== entries[index].snapshot) { previous = entries[i]; break; }
    }
    if (!previous) { return undefined; }
    const entry = entries[index];
    return {
        title: docName + ' (' + entry.title + ')',
        left: { content: previous.snapshot, label: entryLabel(previous) },
        right: { content: entry.snapshot, label: entryLabel(entry) }
    };
}

/** Whether an entry has an earlier snapshot to be compared against. */
function entryHasChange(entries, entryId) {
    return !!entryChangeRequest(entries, entryId, '');
}

/** Two selected history entries, older on the left. */
function historyPairRequest(a, b, docName) {
    const [older, newer] = Date.parse(a.at) <= Date.parse(b.at) ? [a, b] : [b, a];
    return {
        title: docName + ' (history)',
        left: { content: older.snapshot, label: entryLabel(older) },
        right: { content: newer.snapshot, label: entryLabel(newer) }
    };
}

/** The file's column in a conflict: whose version it is, when that is known. */
function diskLabel(writer) {
    const name = writer && writer.author && writer.author.name;
    return name ? name + '’s version (on disk)' : 'On disk';
}

function conflictRequest(comparing, docName) {
    return {
        title: docName + ' (' + comparing.heading + ')',
        left: { content: comparing.a, label: comparing.diskLabel || 'On disk' },
        right: { content: comparing.b, label: 'Your unsaved version' }
    };
}

/** A person as the stores record them — a name, or an author record with one. */
function personName(person) {
    if (!person) { return 'Someone'; }
    if (typeof person === 'string') { return person; }
    return person.name || person.id || 'Someone';
}

/*
 * READING A PROPOSAL WHOLE. The review queue and the tracked page are where a
 * change is decided, one hunk at a time. A long rewrite is also read — does the
 * section still hold together — and that is the document before beside the
 * document as proposed, nothing decided by looking.
 */

/** The assistant's proposal: the base it was computed against beside what it proposes. */
function proposalRequest(proposal, docName) {
    if (!proposal || proposal.baseBody === undefined || proposal.proposedBody === undefined) { return undefined; }
    return {
        title: docName + ' (' + (proposal.title || 'proposal') + ')',
        left: { content: proposal.baseBody, label: 'Before' },
        right: { content: proposal.proposedBody, label: 'Proposed by ' + personName(proposal.by || proposal.author) }
    };
}

/**
 * One person's suggestions: the document beside the document with only their
 * suggestions applied — `suggestedBody` is tracked-changes.js's
 * suggestedMarkdown over that person's entries alone.
 */
function suggestionRequest(documentBody, suggestedBody, by, docName) {
    if (suggestedBody === undefined || suggestedBody === documentBody) { return undefined; }
    const name = personName(by);
    return {
        title: docName + ' (' + name + '’s suggestions)',
        left: { content: documentBody, label: 'Document' },
        right: { content: suggestedBody, label: name + '’s suggestions' }
    };
}

/**
 * The people with suggestions open, once each, in the order their first
 * suggestion appears — one "side by side" per person, not per card.
 */
function suggestionAuthors(suggestions) {
    const seen = new Map();
    for (const suggestion of suggestions || []) {
        const name = personName(suggestion.by);
        if (!seen.has(name)) { seen.set(name, []); }
        seen.get(name).push(suggestion.id);
    }
    return Array.from(seen, ([name, ids]) => ({ name, ids }));
}

module.exports = {
    personName,
    proposalRequest,
    suggestionRequest,
    suggestionAuthors,
    RENDERED_COMPARE_COMMAND,
    RENDERED_HEAD_COMMAND,
    REMOTE_RUN_GAP_MS,
    coalesceRemoteChange,
    remoteChangeRequest,
    entryChangeRequest,
    entryHasChange,
    historyPairRequest,
    diskLabel,
    conflictRequest
};
