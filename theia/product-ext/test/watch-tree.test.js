// node test/watch-tree.test.js
//
// The first comment or suggestion in a project must reach a colleague who has
// the document open. Against the real change log and comment log, with a file
// service that behaves like Theia's on the two points that broke it: a watch
// on a path that does not exist is inert, and a watch is shallow unless asked
// to be recursive.
const assert = require('assert');
const URI = require('@theia/core/lib/common/uri').default;
const { watchTree } = require('../src/browser/watch-tree.js');
const { ChangeLog } = require('../src/browser/change-log.js');

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL ' + name); throw e; }
}

/** Theia's FileService, as far as watching goes, over a set of existing folders. */
function fakeFileService(existing) {
    const watches = [];
    const listeners = [];
    return {
        watches,
        watch(uri, options = { recursive: false, excludes: [] }) {
            const watch = { uri: uri.toString(), recursive: !!options.recursive, live: existing.has(uri.toString()), disposed: false };
            watches.push(watch);
            return { dispose: () => { watch.disposed = true; } };
        },
        onDidFilesChange(listener) {
            listeners.push(listener);
            return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
        },
        /** A file appears: reported only when a live watch covers it. */
        create(fileUri) {
            const covered = watches.some(w => !w.disposed && w.live && (
                fileUri === w.uri || (w.recursive ? fileUri.startsWith(w.uri + '/') : fileUri.slice(0, fileUri.lastIndexOf('/')) === w.uri)));
            if (!covered) { return false; }
            for (const listener of listeners.slice()) { listener({ changes: [{ resource: new URI(fileUri) }] }); }
            return true;
        },
        // ChangeLog.load reads the folder; an empty answer is enough here.
        async resolve() { return { children: [] }; },
        async exists() { return false; },
        async read() { throw new Error('missing'); }
    };
}

(async () => {
    const ROOT = 'file:///workspace';

    await test('watches the root, recursively', () => {
        const fs = fakeFileService(new Set([ROOT]));
        const watch = watchTree(fs, new URI(ROOT));
        assert.deepStrictEqual(fs.watches.map(w => [w.uri, w.recursive]), [[ROOT, true]]);
        watch.dispose();
        assert.strictEqual(fs.watches[0].disposed, true);
    });

    await test('says why when the watch cannot be registered, and does not throw', () => {
        const broken = { watch() { throw new Error('no watcher'); } };
        let reported;
        assert.strictEqual(watchTree(broken, new URI(ROOT), e => { reported = e.message; }), undefined);
        assert.strictEqual(reported, 'no watcher');
    });

    await test('the first suggestion in a project with no .studio yet reaches the open editor', async () => {
        // Only the repository root exists: nobody has suggested or commented here.
        const fs = fakeFileService(new Set([ROOT]));
        const workspace = { roots: Promise.resolve([{ resource: new URI(ROOT) }]) };
        const log = new ChangeLog(fs, workspace);
        log.load = async () => ({ proposals: [{ id: 'p1', updatedAt: 'now', proposedBody: 'x' }], rejections: {} });
        let seen;
        const watch = await log.watch(new URI(ROOT + '/docs/spec.md'), data => { seen = data; });
        // Bob's first suggestion creates .studio/changes/docs/spec.md/ and his file in it.
        const reported = fs.create(ROOT + '/.studio/changes/docs/spec.md/local-bob.json');
        assert.strictEqual(reported, true, 'the change is reported at all');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(seen, 'and reaches the editor');
        assert.strictEqual(seen.proposals[0].id, 'p1');
        watch.dispose();
    });

    await test('a file for another document does not wake this one', async () => {
        const fs = fakeFileService(new Set([ROOT]));
        const log = new ChangeLog(fs, { roots: Promise.resolve([{ resource: new URI(ROOT) }]) });
        let calls = 0;
        log.load = async () => { calls++; return { proposals: [], rejections: {} }; };
        const watch = await log.watch(new URI(ROOT + '/docs/spec.md'), () => {});
        fs.create(ROOT + '/.studio/changes/docs/other.md/local-bob.json');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.strictEqual(calls, 0);
        watch.dispose();
    });

    await test('a project with no review index has an empty queue, not a broken one', async () => {
        const { ChangesStore } = require('../src/browser/changes-store.js');
        const files = new Map();
        const fs = {
            async exists(uri) { return files.has(uri.toString()); },
            async read(uri) { return { value: files.get(uri.toString()) }; },
        };
        const store = new ChangesStore(fs, { roots: Promise.resolve([{ resource: new URI(ROOT) }]) });
        assert.deepStrictEqual(await store.pendingFilesStatus(new URI(ROOT + '/docs/spec.md')), { available: true, files: [] });
        files.set(ROOT + '/.studio/changes/index.json', '{ not json');
        assert.strictEqual((await store.pendingFilesStatus(new URI(ROOT + '/docs/spec.md'))).available, false, 'an unreadable index is still unavailable');
    });

    console.log('watch-tree: ' + passed + ' passing');
})().catch(e => { console.error(e); process.exit(1); });
