// node --test scripts/probe-calibrate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isFix,
  mapToOld,
  match,
  parseHunks,
  readFindings,
  referenceItemsForFix,
  score,
  toRanges,
  touchedLines,
} from './probe-calibrate.mjs';

const FIX_DIFF = `diff --git a/src/a.rs b/src/a.rs
index 1111111..2222222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -10,2 +10,3 @@ fn one() {
-    let x = 1;
-    let y = 2;
+    let x = 2;
+    let y = 3;
+    let z = 4;
@@ -40,0 +41 @@ fn two() {
+    check();
diff --git a/src/new.rs b/src/new.rs
new file mode 100644
--- /dev/null
+++ b/src/new.rs
@@ -0,0 +1,3 @@
+fn added() {}
`;

test('a -U0 diff parses into hunks per file, an omitted count read as 1', () => {
  const files = parseHunks(FIX_DIFF);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], {
    oldFile: 'src/a.rs',
    newFile: 'src/a.rs',
    hunks: [
      { oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 },
      { oldStart: 40, oldCount: 0, newStart: 41, newCount: 1 },
    ],
  });
  assert.equal(files[1].oldFile, null);
  assert.equal(files[1].newFile, 'src/new.rs');
});

test('a quoted path is unquoted', () => {
  const [f] = parseHunks('diff --git "a/x y.md" "b/x y.md"\n--- "a/x y.md"\n+++ "b/x y.md"\n@@ -1 +1 @@\n');
  assert.equal(f.oldFile, 'x y.md');
  assert.deepEqual(f.hunks[0], { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 });
});

test('a line maps back through insertions and deletions, a changed line maps to nothing', () => {
  const hunks = [
    { oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 }, // two lines inserted after old 5
    { oldStart: 20, oldCount: 3, newStart: 21, newCount: 0 }, // old 20–22 deleted after new 21
    { oldStart: 30, oldCount: 1, newStart: 29, newCount: 1 }, // old 30 changed
  ];
  assert.equal(mapToOld(hunks, 3), 3);
  assert.equal(mapToOld(hunks, 6), null);
  assert.equal(mapToOld(hunks, 7), null);
  assert.equal(mapToOld(hunks, 8), 6);
  assert.equal(mapToOld(hunks, 21), 19);
  assert.equal(mapToOld(hunks, 22), 23);
  assert.equal(mapToOld(hunks, 29), null);
  assert.equal(mapToOld(hunks, 30), 31);
  assert.equal(mapToOld([], 12), 12);
});

test('an insertion is anchored at the line it follows, a replacement covers its old side', () => {
  assert.deepEqual(touchedLines({ oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 }), [10, 11]);
  assert.deepEqual(touchedLines({ oldStart: 40, oldCount: 0, newStart: 41, newCount: 1 }), [40]);
  assert.deepEqual(touchedLines({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }), [1]);
  assert.deepEqual(toRanges([5, 3, 4, 9, 4]), [[3, 5], [9, 9]]);
});

test('reference items keep only the lines that existed at T0, in T0 numbers', () => {
  const fix = { commit: 'abcdef0123456789', subject: 'fix: off by one' };
  // Since T0 two lines were inserted at the top of a.rs, and line 11 (now) was written after T0.
  const sinceT0 = parseHunks(`diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@ -0,0 +1,2 @@
+use one;
+use two;
@@ -8,0 +11 @@
+    let y = 2;
diff --git a/src/later.rs b/src/later.rs
--- /dev/null
+++ b/src/later.rs
@@ -0,0 +1 @@
+x
`);
  const items = referenceItemsForFix(fix, parseHunks(FIX_DIFF), sinceT0);
  assert.deepEqual(
    items.map(({ file, start, end }) => ({ file, start, end })),
    [
      { file: 'src/a.rs', start: 8, end: 8 }, // now 10 → T0 8; now 11 born after T0
      { file: 'src/a.rs', start: 37, end: 37 }, // now 40 → T0 40 − 3
    ],
  );
  assert.equal(items[0].id, 'abcdef0123:src/a.rs:8-8');

  const onLater = parseHunks('diff --git a/src/later.rs b/src/later.rs\n--- a/src/later.rs\n+++ b/src/later.rs\n@@ -1 +1 @@\n');
  assert.deepEqual(referenceItemsForFix(fix, onLater, sinceT0), [], 'a file created after T0 held no T0 bug');
});

test('a fix is told by its subject', () => {
  assert.ok(isFix('fix(spec-mapping): the backend boots again'));
  assert.ok(isFix('feat!: Fixes the login loop'));
  assert.ok(isFix('docs: a bug in the example'));
  assert.ok(!isFix('feat(shell): horizontal navigation'));
  assert.ok(!isFix('refactor: prefix handling'));
  assert.ok(isFix('chore: x', /^chore/i));
});

test('findings are read from an array or { findings }, by line or by range', () => {
  const list = readFindings({
    findings: [
      { id: 'a', file: './src\\a.rs', line: 9, text: 'x' },
      { id: 'b', file: 'docs/x.md', line_start: 3, line_end: 5 },
      { id: 'c', file: 'docs/x.md' },
    ],
  });
  assert.deepEqual(
    list.map(({ id, file, start, end }) => ({ id, file, start, end })),
    [
      { id: 'a', file: 'src/a.rs', start: 9, end: 9 },
      { id: 'b', file: 'docs/x.md', start: 3, end: 5 },
    ],
  );
  assert.equal(readFindings([{ file: 'f', start: 1, end: 2 }])[0].id, '#0');
});

test('matching by file and overlap within the tolerance, and the scores', () => {
  const refs = [
    { id: 'r1', commit: 'c1', file: 'src/a.rs', start: 10, end: 12 },
    { id: 'r2', commit: 'c1', file: 'src/a.rs', start: 50, end: 50 },
    { id: 'r3', commit: 'c2', file: 'src/b.rs', start: 1, end: 1 },
  ];
  const findings = [
    { id: 'f1', file: 'src/a.rs', start: 14, end: 14 }, // 2 lines below r1
    { id: 'f2', file: 'src/b.rs', start: 50, end: 50 }, // right line, wrong file
    { id: 'f3', file: 'src/a.rs', start: 60, end: 60 },
  ];
  const result = match(findings, refs, 3);
  assert.deepEqual(result.pairs, [{ finding: 'f1', reference: 'r1' }]);
  assert.deepEqual(result.missed.map((r) => r.id), ['r2', 'r3']);
  assert.deepEqual(result.unmatched.map((f) => f.id), ['f2', 'f3']);
  assert.deepEqual(match(findings, refs, 1).pairs, [], 'outside a tolerance of 1');

  const s = score(findings, refs, result);
  assert.equal(s.recall, 1 / 3);
  assert.equal(s.recallByFix, 1 / 2);
  assert.equal(s.precisionLowerBound, 1 / 3);
  assert.equal(s.fixes, 2);

  const empty = score([], refs, match([], refs));
  assert.equal(empty.recall, 0);
  assert.equal(empty.precisionLowerBound, null);
});
