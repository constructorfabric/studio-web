#!/usr/bin/env node
/**
 * Which part of the prototype calls which backend path — the map the
 * prototype's `/architecture/` page draws its "Prototype" section from.
 *
 * Built from the prototype's sources when its bundle is built (the vite plugin
 * in `studio-frontend-prototype/vite.config.ts` calls `buildPrototypeMap`), so
 * the map in an image is the map of the commit that image was built from. The
 * calls are read with the same reader as `check-api-usage.mjs`
 * (`api-usage-lib.mjs`), so the page and the CI check agree about what the
 * prototype calls.
 *
 * A call is rarely written where it is made: the screens call `api.listRuns()`
 * and the path is in `src/api.ts`. So the map follows names. Every top-level
 * declaration of every file is a symbol, and so is every member of a
 * top-level object (`api.listRuns`); a symbol's paths are the ones written in
 * it plus those of the symbols it names — imported or local — followed until
 * nothing new turns up. A React component (a capitalised top-level
 * declaration of a `.tsx` file) is an entry of the map, and following stops at
 * another component: what a screen renders is listed under that screen's own
 * name, not folded into everything that renders it.
 *
 * Comments are not calls here (unlike the CI check, where a stale path in a
 * comment is worth flagging), and the code is read as prettier lays it out:
 * a top-level declaration starts at column 0, an object member at column 2.
 *
 *   node scripts/prototype-api-map.mjs          # the map, as JSON
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WILDCARD, baseUrl, literals, normalise, readLiteral, relativeEndpoints, sources } from './api-usage-lib.mjs';

/** `text` with every comment blanked out — newlines kept, so lines still line up. */
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (char === '`' || char === "'" || char === '"') {
      const { end } = readLiteral(text, i);
      out += text.slice(i, Math.min(end, text.length));
      i = end;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

const TOP_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TOP_BINDING = /^(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const TOP_TYPE = /^(?:export\s+)?(?:declare\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const MEMBER = /^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|<)/;

/** The top-level declarations of a (comment-free) file, with their text. */
export function declarations(clean) {
  const lines = clean.split('\n');
  const out = [];
  let current = null;
  lines.forEach((line, index) => {
    const fn = line.match(TOP_FUNCTION);
    const binding = fn ? null : line.match(TOP_BINDING);
    const type = fn || binding ? null : line.match(TOP_TYPE);
    const match = fn ?? binding ?? type;
    if (match) {
      current = {
        name: match[1],
        kind: type ? 'type' : 'value',
        isObject: Boolean(binding) && /=\s*\{\s*$/.test(line),
        lines: [],
        start: index,
      };
      out.push(current);
    } else if (/^import\s/.test(line)) {
      current = null;
    }
    if (current) current.lines.push(line);
  });
  return out.map((d) => ({ ...d, text: d.lines.join('\n'), members: d.isObject ? members(d.lines) : [] }));
}

/** The members of a top-level object literal, each with its text. */
function members(lines) {
  const out = [];
  let current = null;
  for (const line of lines.slice(1)) {
    const match = line.match(MEMBER);
    if (match) {
      current = { name: match[1], lines: [] };
      out.push(current);
    }
    if (current) current.lines.push(line);
  }
  return out.map((m) => ({ name: m.name, text: m.lines.join('\n') }));
}

/** `import { a, b as c, type T } from "./x"` and friends → local name → { module, name }. */
export function imports(text) {
  const out = new Map();
  const named = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  const single = /import\s+(?:type\s+)?(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;
  let match;
  while ((match = named.exec(text)) !== null) {
    const [, fallback, list, module] = match;
    if (fallback) out.set(fallback, { module, name: 'default' });
    for (const part of list.split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (!spec) continue;
      const [name, alias] = spec.split(/\s+as\s+/);
      out.set((alias ?? name).trim(), { module, name: name.trim() });
    }
  }
  while ((match = single.exec(text)) !== null) {
    out.set(match[1], { module: match[2], name: 'default' });
  }
  return out;
}

/** A relative import resolved to a file of the scan, or null. */
function resolveModule(fromFile, module, known) {
  if (!module.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), module);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** The backend paths written in `text`, as `/seg/v1/{}/…` strings. */
export function pathsIn(text, base) {
  const found = new Set();
  const add = (raw) => {
    // file-storage is mounted one level down, at /api/file-storage/…
    const mounted = raw.startsWith('/api/');
    const segments = normalise(mounted ? raw.slice('/api'.length) : raw);
    if (!segments) return;
    const path = '/' + segments.map((s) => (s === WILDCARD ? '{}' : s)).join('/');
    found.add(mounted ? '/api' + path : path);
  };
  for (const literal of literals(text)) add(literal);
  if (base) for (const suffix of relativeEndpoints(text)) add(base + suffix);
  return found;
}

/** A React component: a capitalised name in a `.tsx` file — not a CONSTANT. */
const isComponent = (file, name) => /\.tsx$/.test(file) && /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name);

/**
 * The map for every source file under `srcDir`: one entry per React component
 * that reaches the backend, with the paths it reaches.
 */
export function buildPrototypeMap({ srcDir, root = dirname(srcDir), commit = null }) {
  const files = sources(srcDir)
    .filter((f) => !/\.test\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f))
    .filter((f) => !f.split(sep).includes('_to_delete'));
  const known = new Set(files);

  /** symbol key → { own: Set<path>, refs: Set<key>, component: bool } */
  const symbols = new Map();
  const key = (file, name, member) => `${file}#${name}${member ? '.' + member : ''}`;

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const clean = stripComments(raw);
    const base = baseUrl(raw);
    const imported = imports(raw);
    const decls = declarations(clean);
    const local = new Map(decls.map((d) => [d.name, d]));

    /** What `text` names: imported symbols, local declarations, object members. */
    const refsOf = (text, self) => {
      const refs = new Set();
      const words = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
      const memberUses = new Map();
      for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
        if (!memberUses.has(m[1])) memberUses.set(m[1], new Set());
        memberUses.get(m[1]).add(m[2]);
      }
      for (const word of words) {
        if (word === self) continue;
        let target = null;
        if (imported.has(word)) {
          const { module, name } = imported.get(word);
          const resolved = resolveModule(file, module, known);
          if (resolved) target = { file: resolved, name };
        } else if (local.has(word)) {
          target = { file, name: word };
        }
        if (!target) continue;
        refs.add(key(target.file, target.name));
        for (const member of memberUses.get(word) ?? []) refs.add(key(target.file, target.name, member));
      }
      return refs;
    };

    for (const decl of decls) {
      if (decl.kind === 'type') continue;
      if (decl.isObject) {
        // The object as a whole names nothing: a screen that passes `api`
        // around has not called every member of it.
        symbols.set(key(file, decl.name), { own: new Set(), refs: new Set(), component: false, file, name: decl.name });
        for (const member of decl.members) {
          symbols.set(key(file, decl.name, member.name), {
            own: pathsIn(member.text, base),
            refs: refsOf(member.text, decl.name),
            component: false,
            file,
            name: `${decl.name}.${member.name}`,
          });
        }
        continue;
      }
      symbols.set(key(file, decl.name), {
        own: pathsIn(decl.text, base),
        refs: refsOf(decl.text, decl.name),
        component: isComponent(file, decl.name),
        file,
        name: decl.name,
      });
    }
  }

  /** Everything `start` reaches, without passing through another component. */
  const reach = (start) => {
    const out = new Set();
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const symbol = symbols.get(stack.pop());
      if (!symbol) continue;
      for (const path of symbol.own) out.add(path);
      for (const ref of symbol.refs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const target = symbols.get(ref);
        if (target && !target.component) stack.push(ref);
      }
    }
    return out;
  };

  const screens = [];
  for (const [id, symbol] of symbols) {
    if (!symbol.component) continue;
    const paths = [...reach(id)].sort();
    if (paths.length === 0) continue;
    screens.push({
      name: symbol.name,
      file: relative(root, symbol.file).split(sep).join('/'),
      paths,
    });
  }
  screens.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return { commit, screens };
}

// CLI: print the map of the prototype in this repository.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'studio-frontend-prototype', 'src');
  if (!existsSync(srcDir)) {
    console.error(`no prototype sources at ${srcDir}`);
    process.exit(2);
  }
  console.log(JSON.stringify(buildPrototypeMap({ srcDir }), null, 2));
}
