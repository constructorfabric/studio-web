// node test/rendered-compare.test.js
//
// What the Documents editor hands theia/studio's rendered comparison: a
// colleague's run of saves kept as one change, what one history entry
// changed, two history versions, and whose version a conflict is up against.
const assert = require('assert');
const {
    RENDERED_COMPARE_COMMAND, RENDERED_HEAD_COMMAND, REMOTE_RUN_GAP_MS,
    coalesceRemoteChange, remoteChangeRequest, entryChangeRequest, entryHasChange,
    historyPairRequest, diskLabel, conflictRequest
} = require('../src/browser/rendered-compare.js');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; }
    catch (e) { console.error('FAIL ' + name); throw e; }
}

// The commands are theia/studio's (markdown-diff-contribution.ts).
test('command ids', () => {
    assert.strictEqual(RENDERED_COMPARE_COMMAND, 'studio.markdownDiff.compare');
    assert.strictEqual(RENDERED_HEAD_COMMAND, 'studio.markdownDiff.compareWithHead');
});

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0);

test('a colleague\'s autosaves are one change, from what I had before they began', () => {
    let change = coalesceRemoteChange(undefined, { author: 'Alice', before: 'v0', after: 'v1', at: T0 });
    change = coalesceRemoteChange(change, { author: 'Alice', before: 'v1', after: 'v2', at: T0 + 1000 });
    change = coalesceRemoteChange(change, { author: 'Alice', before: 'v2', after: 'v3', at: T0 + 2000 });
    assert.deepStrictEqual(change, { author: 'Alice', before: 'v0', after: 'v3', since: T0, at: T0 + 2000 });
});

test('another author starts a new change', () => {
    const alice = coalesceRemoteChange(undefined, { author: 'Alice', before: 'v0', after: 'v1', at: T0 });
    const bob = coalesceRemoteChange(alice, { author: 'Bob', before: 'v1', after: 'v2', at: T0 + 1000 });
    assert.strictEqual(bob.before, 'v1');
    assert.strictEqual(bob.since, T0 + 1000);
});

test('my own edit in between starts a new change', () => {
    const alice = coalesceRemoteChange(undefined, { author: 'Alice', before: 'v0', after: 'v1', at: T0 });
    // I edited and saved: what I had is no longer what Alice gave me.
    const again = coalesceRemoteChange(alice, { author: 'Alice', before: 'v1+mine', after: 'v2', at: T0 + 1000 });
    assert.strictEqual(again.before, 'v1+mine');
});

test('a long pause starts a new change', () => {
    const alice = coalesceRemoteChange(undefined, { author: 'Alice', before: 'v0', after: 'v1', at: T0 });
    const later = coalesceRemoteChange(alice, { author: 'Alice', before: 'v1', after: 'v2', at: T0 + REMOTE_RUN_GAP_MS + 1 });
    assert.strictEqual(later.before, 'v1');
});

test('the request for a colleague\'s change names them on both columns', () => {
    const change = { author: 'Alice', before: 'old', after: 'new', since: T0, at: T0 + 60000 };
    const request = remoteChangeRequest(change, 'spec.md');
    assert.strictEqual(request.title, 'spec.md (Alice’s changes)');
    assert.strictEqual(request.left.content, 'old');
    assert.ok(request.left.label.startsWith('Before Alice · '));
    assert.strictEqual(request.right.content, 'new');
    assert.ok(request.right.label.startsWith('Alice · '));
    assert.strictEqual(remoteChangeRequest(undefined, 'spec.md'), undefined);
    assert.strictEqual(remoteChangeRequest({ ...change, after: 'old' }, 'spec.md'), undefined, 'nothing changed, nothing to open');
});

const entries = [
    { id: 'e1', kind: 'edit', title: 'Edited spec.md', author: 'me', at: '2026-10-05T09:00:00Z', snapshot: 'one' },
    { id: 'e2', kind: 'comment', title: 'Commented', author: 'Bob', at: '2026-10-05T09:05:00Z' },
    { id: 'e3', kind: 'remote-edit', title: 'Alice edited this document', author: 'Alice', at: '2026-10-05T09:10:00Z', snapshot: 'two' },
];

test('an entry\'s change is its snapshot against the one recorded before it', () => {
    const request = entryChangeRequest(entries, 'e3', 'spec.md');
    assert.strictEqual(request.title, 'spec.md (Alice edited this document)');
    assert.strictEqual(request.left.content, 'one', 'skips the comment, which has no snapshot');
    assert.strictEqual(request.right.content, 'two');
    assert.ok(request.left.label.startsWith('Edited spec.md · me · '));
});

test('no change for the first snapshot, an entry without one, or an unknown id', () => {
    assert.strictEqual(entryChangeRequest(entries, 'e1', 'spec.md'), undefined);
    assert.strictEqual(entryChangeRequest(entries, 'e2', 'spec.md'), undefined);
    assert.strictEqual(entryChangeRequest(entries, 'nope', 'spec.md'), undefined);
    assert.deepStrictEqual(entries.map(e => entryHasChange(entries, e.id)), [false, false, true]);
});

test('a shared history\'s duplicate snapshot is skipped, not compared', () => {
    // Alice's own entry and Bob's record of it hold the same bytes.
    const shared = [
        { id: 'a', title: 'Edited spec.md', author: 'Bob', at: '2026-10-05T09:00:00Z', snapshot: 'one' },
        { id: 'b', title: 'Edited spec.md', author: 'Alice', at: '2026-10-05T09:01:00Z', snapshot: 'two' },
        { id: 'c', title: 'Alice edited this document', author: 'Alice', at: '2026-10-05T09:01:01Z', snapshot: 'two' },
    ];
    const request = entryChangeRequest(shared, 'c', 'spec.md');
    assert.strictEqual(request.left.content, 'one');
    assert.strictEqual(request.right.content, 'two');
    // Nothing different before it at all: no button.
    const same = [shared[1], shared[2]];
    assert.strictEqual(entryHasChange(same, 'c'), false);
});

test('two selected versions go older on the left, whichever was picked first', () => {
    const request = historyPairRequest(entries[2], entries[0], 'spec.md');
    assert.strictEqual(request.left.content, 'one');
    assert.strictEqual(request.right.content, 'two');
    assert.strictEqual(request.title, 'spec.md (history)');
});

test('a conflict names whose version is on disk, when co-editing knows', () => {
    assert.strictEqual(diskLabel(undefined), 'On disk');
    assert.strictEqual(diskLabel({ author: {} }), 'On disk');
    assert.strictEqual(diskLabel({ author: { name: 'Alice' } }), 'Alice’s version (on disk)');
    const request = conflictRequest({ heading: 'h', a: 'disk', b: 'mine', diskLabel: 'Alice’s version (on disk)' }, 'spec.md');
    assert.deepStrictEqual(request, {
        title: 'spec.md (h)',
        left: { content: 'disk', label: 'Alice’s version (on disk)' },
        right: { content: 'mine', label: 'Your unsaved version' }
    });
    assert.strictEqual(conflictRequest({ heading: 'h', a: 'd', b: 'm' }, 'x.md').left.label, 'On disk');
});

const { personName, proposalRequest, suggestionRequest, suggestionAuthors } = require('../src/browser/rendered-compare.js');

test('a person is a name or an author record', () => {
    assert.strictEqual(personName('Alice'), 'Alice');
    assert.strictEqual(personName({ id: 'a1', name: 'Alice' }), 'Alice');
    assert.strictEqual(personName({ id: 'a1' }), 'a1');
    assert.strictEqual(personName(undefined), 'Someone');
});

test('the assistant\'s proposal: its base beside what it proposes', () => {
    const request = proposalRequest({ title: 'Tighten the intro', author: 'Claude', baseBody: 'b', proposedBody: 'p' }, 'spec.md');
    assert.deepStrictEqual(request, {
        title: 'spec.md (Tighten the intro)',
        left: { content: 'b', label: 'Before' },
        right: { content: 'p', label: 'Proposed by Claude' }
    });
    assert.strictEqual(proposalRequest(undefined, 'spec.md'), undefined);
    assert.strictEqual(proposalRequest({ title: 't' }, 'spec.md'), undefined, 'a proposal without its bodies has nothing to show');
});

test('one person\'s suggestions applied, beside the document', () => {
    const request = suggestionRequest('doc', 'doc+alice', { name: 'Alice' }, 'spec.md');
    assert.strictEqual(request.title, 'spec.md (Alice’s suggestions)');
    assert.deepStrictEqual(request.left, { content: 'doc', label: 'Document' });
    assert.deepStrictEqual(request.right, { content: 'doc+alice', label: 'Alice’s suggestions' });
    assert.strictEqual(suggestionRequest('doc', 'doc', 'Alice', 'spec.md'), undefined, 'nothing applies: nothing to open');
});

test('one button per person, in the order their suggestions first appear', () => {
    const people = suggestionAuthors([
        { id: 's1', by: { name: 'Bob' } },
        { id: 's2', by: { name: 'Alice' } },
        { id: 's3', by: { name: 'Bob' } },
    ]);
    assert.deepStrictEqual(people, [{ name: 'Bob', ids: ['s1', 's3'] }, { name: 'Alice', ids: ['s2'] }]);
    assert.deepStrictEqual(suggestionAuthors(undefined), []);
});

console.log('rendered-compare: ' + passed + ' passing');
