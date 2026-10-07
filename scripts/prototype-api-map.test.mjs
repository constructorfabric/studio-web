// node --test scripts/prototype-api-map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildPrototypeMap, declarations, imports, stripComments } from './prototype-api-map.mjs';

/** A throwaway prototype: `files` maps a path under src/ to its text. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'proto-map-'));
  const src = join(root, 'src');
  mkdirSync(src);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text);
  return { root, src, done: () => rmSync(root, { recursive: true, force: true }) };
}

const API = `import { thing } from "./thing";

async function request(path, token) {
  return fetch("/cf" + path, { headers: { Authorization: token } });
}

export const api = {
  /** Lists runs. \`GET /studio-docs/v1/never-a-call\` in a comment is not a call. */
  listRuns: (token) => request("/studio-tasks/v1/runs", token),
  getRun: (token, id) =>
    request(\`/studio-tasks/v1/runs/\${encodeURIComponent(id)}\`, token),
  presence: (token) => request("/studio-presence/v1/me", token),
  unused: (token) => request("/studio-reports/v1/reports", token),
};
`;

test('a screen reaches the paths behind the api members it calls', () => {
  const f = fixture({
    'api.ts': API,
    'tasks.tsx': `import { api } from "./api";
export function TasksScreen({ token }) {
  const load = () => api.listRuns(token);
  return <Row token={token} onOpen={(id) => api
    .getRun(token, id)} />;
}
function Row({ token }) {
  return <button onClick={() => api.presence(token)} />;
}
`,
    'thing.ts': 'export const thing = 1;\n',
  });
  try {
    const map = buildPrototypeMap({ srcDir: f.src, commit: 'abc' });
    assert.equal(map.commit, 'abc');
    const byName = Object.fromEntries(map.screens.map((s) => [s.name, s]));
    // Following stops at another component: Row's call is Row's, not TasksScreen's.
    assert.deepEqual(byName.TasksScreen.paths, ['/studio-tasks/v1/runs', '/studio-tasks/v1/runs/{}']);
    assert.deepEqual(byName.Row.paths, ['/studio-presence/v1/me']);
    assert.equal(byName.TasksScreen.file, 'src/tasks.tsx');
    // A member nobody calls reaches no screen, and a comment is not a call.
    const all = map.screens.flatMap((s) => s.paths);
    assert.ok(!all.includes('/studio-reports/v1/reports'));
    assert.ok(!all.some((p) => p.includes('never-a-call')));
  } finally {
    f.done();
  }
});

test('a hook in another file is followed, and a test file is not read', () => {
  const f = fixture({
    'api.ts': API,
    'use-runs.ts': `import { api as client } from "./api";
export function useRuns(token) { return client.listRuns(token); }
`,
    'board.tsx': `import { useRuns } from "./use-runs";
export const Board = ({ token }) => { useRuns(token); return null; };
`,
    'board.test.tsx': `import { api } from "./api";
export function Fake() { return api.presence("t"); }
`,
  });
  try {
    const map = buildPrototypeMap({ srcDir: f.src });
    assert.deepEqual(
      map.screens.map((s) => [s.name, s.paths]),
      [['Board', ['/studio-tasks/v1/runs']]],
    );
  } finally {
    f.done();
  }
});

test('a CONSTANT is not a screen; the component that uses it is', () => {
  const f = fixture({
    'page.tsx': `const MANIFEST_URL = "/cf/studio-assembly/v1/manifest";
async function load() { return fetch(MANIFEST_URL); }
export function Page() { load(); return null; }
`,
  });
  try {
    assert.deepEqual(
      buildPrototypeMap({ srcDir: f.src }).screens.map((s) => [s.name, s.paths]),
      [['Page', ['/studio-assembly/v1/manifest']]],
    );
  } finally {
    f.done();
  }
});

test('file-storage, mounted one level down, keeps its mount', () => {
  const f = fixture({
    'files.tsx': `export function Files() { return fetch("/api/file-storage/v1/files"); }\n`,
  });
  try {
    assert.deepEqual(buildPrototypeMap({ srcDir: f.src }).screens[0].paths, ['/api/file-storage/v1/files']);
  } finally {
    f.done();
  }
});

test('the pieces: comments, declarations, imports', () => {
  assert.equal(stripComments('a // b\nc /* d\ne */ f "// kept"'), 'a     \nc     \n     f "// kept"');
  const decls = declarations('import x from "y";\nexport const api = {\n  one: () => 1,\n  two() {},\n};\nfunction Z() {}\n');
  assert.deepEqual(decls.map((d) => d.name), ['api', 'Z']);
  assert.deepEqual(decls[0].members.map((m) => m.name), ['one', 'two']);
  const imported = imports('import { a, b as c, type T } from "./m";\nimport D from "./d";\n');
  assert.deepEqual([...imported.keys()].sort(), ['D', 'T', 'a', 'c']);
  assert.deepEqual(imported.get('c'), { module: './m', name: 'b' });
});
