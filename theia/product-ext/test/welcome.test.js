/*
 * The start page: what it lists, and what it refuses to claim.
 *
 * Run: `node test/welcome.test.js` (or `npm run test:welcome`).
 */

const assert = require('node:assert');
const scan = require('../src/browser/welcome-scan');
const collabScan = require('../src/browser/collab-scan');

const ROMA = { id: 'oidc:sub-1', name: 'Roma', kind: 'person', key: 'oidc-sub-1' };
const ANA = { id: 'oidc:sub-2', name: 'Ana', kind: 'person', key: 'oidc-sub-2' };
const NOBODY = { id: 'local:x', name: 'Someone', kind: 'person', key: 'local-x', unnamed: true };

const clock = Date.parse('2026-09-28T12:00:00.000Z');
const ago = minutes => new Date(clock - minutes * 60_000).toISOString();
const msg = (by, body, minutesAgo) => ({ id: 'm-' + by.key + '-' + minutesAgo, by, author: by.name, at: ago(minutesAgo), body });
const thread = (id, messages, extra) => Object.assign({ id, scope: 'inline', quote: 'ships in Q3', resolved: false, messages }, extra);
const file = (path, threads) => ({ path, uri: 'file:///ws/' + path, threads });

let failures = 0;
const pending = [];
function test(name, fn) {
    pending.push((async () => {
        try {
            await fn();
            console.log('  ok   ' + name);
        } catch (error) {
            failures++;
            console.error('  FAIL ' + name);
            console.error('       ' + (error && error.stack || error));
        }
    })());
}

/* A file service over a plain object tree: directories are objects, files are
 * numbers (their mtime). Only what walkDocuments calls. */
function fakeFs(tree, calls) {
    const uriOf = path => ({
        toString: () => 'file:///ws' + (path ? '/' + path : ''),
        path: { base: path.split('/').pop() }
    });
    const lookup = path => path.split('/').filter(Boolean).reduce((node, part) => node && node[part], tree);
    return {
        async resolve(uri) {
            const path = uri.toString().replace(/^file:\/\/\/ws\/?/, '');
            if (calls) { calls.push(path); }
            const node = path ? lookup(path) : tree;
            if (node === 'boom') { throw new Error('unreadable'); }
            if (!node || typeof node !== 'object') { throw new Error('not a directory: ' + path); }
            return {
                children: Object.keys(node).map(name => {
                    const child = path ? path + '/' + name : name;
                    const value = node[name];
                    return { resource: uriOf(child), isDirectory: typeof value === 'object' || value === 'boom', mtime: typeof value === 'number' ? value : undefined };
                })
            };
        }
    };
}
const ROOT = { toString: () => 'file:///ws', path: { base: 'ws' } };

console.log('start page');

// -- the walk ----------------------------------------------------------------

test('the walk lists documents with their mtimes and nothing else', async () => {
    const fs = fakeFs({
        'readme.md': 100,
        'notes.txt': 200,
        docs: { 'prd.md': 300, 'img.png': 50, deep: { 'x.markdown': 400 } },
        '.studio': { comments: { 'prd.md': {} } },
        node_modules: { 'pkg.md': 999 }
    });
    const walk = await scan.walkDocuments(fs, ROOT);
    assert.deepStrictEqual(walk.files.map(f => f.path).sort(), ['docs/deep/x.markdown', 'docs/prd.md', 'readme.md']);
    assert.strictEqual(walk.files.find(f => f.path === 'docs/prd.md').mtime, 300);
    assert.strictEqual(walk.truncated, false);
});

test('the walk stops at its bounds and says it did', async () => {
    const fs = fakeFs({ a: { b: { c: { 'deep.md': 1 } } }, 'one.md': 1, 'two.md': 2, 'three.md': 3 });
    const shallow = await scan.walkDocuments(fs, ROOT, {}, { maxDepth: 1 });
    assert.strictEqual(shallow.truncated, true);
    assert.ok(!shallow.files.some(f => f.path === 'a/b/c/deep.md'));
    const few = await scan.walkDocuments(fs, ROOT, {}, { maxFiles: 2 });
    assert.strictEqual(few.truncated, true);
    assert.ok(few.files.length <= 2);
});

test('one unreadable folder is counted, not fatal', async () => {
    const fs = fakeFs({ broken: 'boom', 'ok.md': 5 });
    const walk = await scan.walkDocuments(fs, ROOT);
    assert.deepStrictEqual(walk.files.map(f => f.path), ['ok.md']);
    assert.strictEqual(walk.skipped, 1);
});

test('a cancelled walk stops reading', async () => {
    const calls = [];
    const token = { cancelled: true };
    await scan.walkDocuments(fakeFs({ a: { 'x.md': 1 } }, calls), ROOT, token);
    assert.strictEqual(calls.length, 0);
});

// -- recent ------------------------------------------------------------------

test('recent documents are newest first, capped, with where they live', () => {
    const walk = { files: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ path: 'docs/d' + n + '.md', uri: 'file:///ws/docs/d' + n + '.md', mtime: n * 1000 })) };
    const rows = scan.recentDocuments(walk, []);
    assert.strictEqual(rows.length, scan.RECENT_MAX);
    assert.strictEqual(rows[0].path, 'docs/d8.md');
    assert.strictEqual(rows[0].name, 'd8.md');
    assert.strictEqual(rows[0].folder, 'docs');
    assert.strictEqual(rows[0].reason, 'edited');
});

test('an opening later than the last edit says "opened", not "edited"', () => {
    const walk = { files: [{ path: 'a.md', uri: 'u:a', mtime: 1000 }, { path: 'b.md', uri: 'u:b', mtime: 5000 }] };
    const rows = scan.recentDocuments(walk, [{ path: 'a.md', at: 9000 }, { path: 'b.md', at: 2000 }]);
    assert.deepStrictEqual(rows.map(r => [r.path, r.reason]), [['a.md', 'opened'], ['b.md', 'edited']]);
    assert.strictEqual(rows[0].uri, 'u:a');
});

test('a remembered document that is gone is dropped, unless the walk stopped early', () => {
    const complete = { files: [{ path: 'a.md', uri: 'u:a', mtime: 1 }], truncated: false };
    assert.deepStrictEqual(scan.recentDocuments(complete, [{ path: 'gone.md', at: 9 }]).map(r => r.path), ['a.md']);
    const partial = { files: [{ path: 'a.md', uri: 'u:a', mtime: 1 }], truncated: true };
    const rows = scan.recentDocuments(partial, [{ path: 'far/away.md', at: 9 }], { rootString: 'file:///ws' });
    assert.deepStrictEqual(rows.map(r => r.path), ['far/away.md', 'a.md']);
    assert.strictEqual(rows[0].uri, 'file:///ws/far/away.md');
});

test('a name with a space reads as typed, and an opening matches its walked file', async () => {
    const fs = fakeFs({ docs: { 'Q3%20rollout.md': 10 } });
    const walk = await scan.walkDocuments(fs, ROOT);
    assert.deepStrictEqual(walk.files.map(f => f.path), ['docs/Q3 rollout.md']);
    const rows = scan.recentDocuments(walk, [{ path: 'docs/Q3 rollout.md', at: 99 }]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'Q3 rollout.md');
    assert.strictEqual(rows[0].reason, 'opened');
    assert.strictEqual(rows[0].uri, 'file:///ws/docs/Q3%20rollout.md');
    assert.strictEqual(scan.relativeTo('file:///ws', 'file:///ws/a%20b.md'), 'a b.md');
    const pendingRows = scan.pendingSection({ available: true, files: [{ path: 'docs/Q3%20rollout.md', pending: 1 }] }, {}).rows;
    assert.strictEqual(pendingRows[0].name, 'Q3 rollout.md');
});

test('an empty project has no recent documents, not an error', () => {
    assert.deepStrictEqual(scan.recentDocuments({ files: [] }, []), []);
    assert.deepStrictEqual(scan.recentDocuments(undefined, undefined), []);
});

test('remembering an opening dedupes, orders and caps', () => {
    let list = [];
    for (let n = 0; n < 20; n++) { list = scan.rememberOpened(list, 'd' + n + '.md', n); }
    list = scan.rememberOpened(list, 'd5.md', 100);
    assert.strictEqual(list.length, scan.OPENED_MAX);
    assert.strictEqual(list[0].path, 'd5.md');
    assert.strictEqual(list.filter(e => e.path === 'd5.md').length, 1);
    // Not a document: not remembered.
    assert.strictEqual(scan.rememberOpened([], 'data.csv', 1).length, 0);
    // Garbage from storage does not survive.
    assert.deepStrictEqual(scan.rememberOpened([null, { nope: 1 }], 'a.md', 3), [{ path: 'a.md', at: 3 }]);
});

// -- waiting -----------------------------------------------------------------

const INBOX_FILES = [
    file('m.md', [thread('t1', [msg(ANA, 'what do you think @Roma', 10)])]),
    file('w.md', [thread('t2', [msg(ROMA, 'asked', 30), msg(ANA, 'answered', 20)])]),
    file('o.md', [thread('t3', [msg(ANA, 'unrelated', 5)])]),
    file('r.md', [thread('t4', [msg(ANA, 'done', 5)], { resolved: true })])
];

test('waiting for you is mentions and your turn, from the Collaboration page’s own rules', () => {
    const section = scan.waitingSection(collabScan.inbox(INBOX_FILES, ROMA), ROMA);
    assert.strictEqual(section.mode, 'mine');
    assert.strictEqual(section.title, 'Waiting for you');
    assert.deepStrictEqual(section.items.map(i => i.threadId), ['t1', 't2']);
    assert.deepStrictEqual(section.items.map(scan.waitingReason), ['mentions you', 'your turn']);
    assert.strictEqual(section.others, 1);
    assert.strictEqual(section.open, 3);
});

test('without a name, the section lists open threads and says why', () => {
    const section = scan.waitingSection(collabScan.inbox(INBOX_FILES, NOBODY), NOBODY);
    assert.strictEqual(section.mode, 'open');
    assert.strictEqual(section.title, 'Open threads');
    assert.strictEqual(section.items.length, 3);
    assert.ok(/cannot be told/.test(section.note), section.note);
});

test('the waiting cap is reported as more, not dropped silently', () => {
    const many = Array.from({ length: 9 }, (_, n) => file('d' + n + '.md', [thread('t' + n, [msg(ANA, '@Roma ' + n, n)])]));
    const section = scan.waitingSection(collabScan.inbox(many, ROMA), ROMA);
    assert.strictEqual(section.items.length, scan.WAITING_MAX);
    assert.strictEqual(section.more, 9 - scan.WAITING_MAX);
});

test('no threads is an empty section with no excuse attached', () => {
    const section = scan.waitingSection(collabScan.inbox([], NOBODY), NOBODY);
    assert.strictEqual(section.items.length, 0);
    assert.strictEqual(section.note, '');
});

// -- pending -----------------------------------------------------------------

test('proposals are one row per document, titled by the newest', () => {
    const status = {
        available: true,
        files: [
            { path: 'docs/prd.md', pending: 3, proposals: 2, uri: 'file:///ws/docs/prd.md' },
            { path: 'plan.md', pending: 1, proposals: 1, uri: 'file:///ws/plan.md' }
        ]
    };
    const details = {
        'docs/prd.md': [
            { title: 'Old one', author: 'claude', createdAt: ago(300), status: 'open' },
            { title: 'Tighten the rollout paragraph', author: 'codex', createdAt: ago(60), status: 'open' }
        ]
    };
    const section = scan.pendingSection(status, details);
    assert.deepStrictEqual(section.rows.map(r => r.path), ['docs/prd.md', 'plan.md']);
    assert.strictEqual(section.rows[0].title, 'Tighten the rollout paragraph');
    assert.strictEqual(section.rows[0].author, 'codex');
    assert.strictEqual(section.rows[0].proposals, 2);
    // No details read: the index's count still stands.
    assert.strictEqual(section.rows[1].title, '');
    assert.strictEqual(section.rows[1].pending, 1);
    assert.strictEqual(scan.pendingCountText(section), '4 changes in 2 documents');
});

test('no index is "not available", which is not the same as nothing waiting', () => {
    const none = scan.pendingSection({ available: false, files: [] }, {});
    assert.strictEqual(none.available, false);
    const empty = scan.pendingSection({ available: true, files: [] }, {});
    assert.strictEqual(empty.available, true);
    assert.strictEqual(empty.rows.length, 0);
    assert.strictEqual(scan.pendingCountText(empty), '');
});

// -- when the page explains ---------------------------------------------------

test('the explanation shows on first run, with no project, and in an empty project', () => {
    assert.strictEqual(scan.showExplainer({ hasProject: false }), true);
    assert.strictEqual(scan.showExplainer({ hasProject: true, firstRun: true, documents: 4 }), true);
    assert.strictEqual(scan.showExplainer({ hasProject: true, documents: 0, threads: 0, pending: 0 }), true);
    assert.strictEqual(scan.showExplainer({ hasProject: true, documents: 2, threads: 0, pending: 0 }), false);
});

// -- a new document ----------------------------------------------------------

test('a new document’s name becomes a Markdown path inside the project', () => {
    assert.deepStrictEqual(scan.newDocumentPath('Q3 plan'), { ok: true, path: 'Q3 plan.md' });
    assert.deepStrictEqual(scan.newDocumentPath('  docs\\rollout.md '), { ok: true, path: 'docs/rollout.md' });
    assert.deepStrictEqual(scan.newDocumentPath('notes.markdown'), { ok: true, path: 'notes.markdown' });
    for (const bad of ['', '   ', '/etc/x', 'C:/x', '../out', 'a/./b', '.secret', 'a/.git/x', 'what?']) {
        const result = scan.newDocumentPath(bad);
        assert.strictEqual(result.ok, false, bad);
        assert.ok(result.reason, bad);
    }
});

test('the first heading is the name, said as words', () => {
    assert.strictEqual(scan.titleFromPath('docs/q3-rollout_plan.md'), 'Q3 rollout plan');
    assert.strictEqual(scan.titleFromPath('.md'), 'Untitled');
});

// -- honesty -----------------------------------------------------------------

test('the foot line says where it read from and where it stopped', () => {
    const plain = scan.honestyLine({});
    assert.ok(plain.includes('connected tools'), plain);
    const stopped = scan.honestyLine({ walkTruncated: true, walked: 1500, unreadable: 1 });
    assert.ok(stopped.includes('stopped after 1500 entries'), stopped);
    assert.ok(stopped.includes('1 comment log could not be read.'), stopped);
});

Promise.all(pending).then(() => {
    if (failures) {
        console.error(failures + ' failing');
        process.exit(1);
    }
    console.log('  all passing');
});
