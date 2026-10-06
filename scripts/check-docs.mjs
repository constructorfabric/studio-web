#!/usr/bin/env node
/**
 * What the documents under docs/ must be true of, checked without Studio.
 *
 *   node scripts/check-docs.mjs
 *
 * Studio reads this repository's specifications the way it reads any other:
 * by the directory and the `type` in the front matter, and by the `cpt-` ids
 * that tie a requirement to the design, the decomposition and the feature that
 * cite it. Nothing checks either on the way in. A spec without its type is
 * classified by guessing, a template published unfilled reads as a real
 * design, and an id cited after its definition was renamed points at nothing —
 * and each of these shows up as a finding in somebody else's Specs list, long
 * after the PR that caused it.
 *
 * Links are checked for the same reason: a document that was moved or renamed
 * leaves its readers on a 404 that no review notices.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DOCS = 'docs';

/** The spec directories and the `type` a document in each must declare. */
const SPEC_DIRS = {
  prd: 'prd',
  design: 'design',
  decomposition: 'decomposition',
  feature: 'feature',
  adr: 'adr',
};

/**
 * Where an id is defined. `**ID**:` defines an actor, requirement, component,
 * entry or decision; `**Contract**:` (singular) defines an external contract
 * in the design's External Dependencies. Everything else that names an id
 * cites it.
 */
const DEFINITION = /\*\*(?:ID|Contract)\*\*:\s*`(cpt-[a-z0-9-]+)`/g;
const CITATION = /`(cpt-[a-z0-9-]+)`/g;

/** A placeholder left over from a template, e.g. `# Technical Design — {Gear Name}`. */
const PLACEHOLDER_TITLE = /^#\s.*\{[A-Z][^}]*\}/m;

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.md') ? [path] : [];
  });
}

function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return Object.fromEntries(
    m[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z_]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.trim()]),
  );
}

/** Text outside fenced code blocks, where ids and links are examples, not claims. */
function prose(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

const errors = [];
const fail = (file, message) => errors.push(`${file.split(sep).join('/')}: ${message}`);

const files = walk(DOCS);
const definedIn = new Map();
const citations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const body = prose(text);
  const [top, sub] = relative(DOCS, file).split(sep);
  const specType = sub !== undefined && sub !== 'README.md' ? SPEC_DIRS[top] : undefined;

  if (specType) {
    const fm = frontMatter(text);
    if (!fm?.type) fail(file, `a ${specType} spec must start with front matter declaring \`type: ${specType}\``);
    else if (fm.type !== specType) fail(file, `declares \`type: ${fm.type}\` but lives under docs/${top}/`);
    if (PLACEHOLDER_TITLE.test(text)) fail(file, 'is an unfilled template (its title still has a {placeholder})');
  }

  for (const [, id] of body.matchAll(DEFINITION)) {
    const first = definedIn.get(id);
    if (first) fail(file, `defines ${id}, already defined in ${first}`);
    else definedIn.set(id, file.split(sep).join('/'));
  }
  for (const [, id] of body.matchAll(CITATION)) citations.push([file, id]);

  for (const [, target] of body.matchAll(LINK)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    if (!existsSync(resolve(dirname(file), path))) fail(file, `links to ${target}, which does not exist`);
  }
}

// A document nobody can find from the index is one nobody keeps up to date.
const INDEXES = [join(DOCS, 'README.md'), join(DOCS, 'adr', 'README.md')];
const indexed = new Set(
  INDEXES.flatMap((index) =>
    [...prose(readFileSync(index, 'utf8')).matchAll(LINK)].map(([, target]) =>
      resolve(dirname(index), decodeURIComponent(target.split('#')[0])),
    ),
  ),
);
for (const file of files) {
  if (!file.endsWith('README.md') && !indexed.has(resolve(file))) {
    fail(file, 'is not linked from docs/README.md or docs/adr/README.md');
  }
}

const dangling = new Map();
for (const [file, id] of citations) {
  if (!definedIn.has(id)) dangling.set(`${file}\0${id}`, [file, id]);
}
for (const [file, id] of dangling.values()) fail(file, `cites ${id}, which no document defines`);

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s) in ${DOCS}/.`);
  process.exit(1);
}
console.log(`${files.length} documents, ${definedIn.size} ids: all specs typed, every id defined once and cited ids exist, every link resolves.`);
