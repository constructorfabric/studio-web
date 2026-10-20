#!/usr/bin/env node
/**
 * How well a findings producer finds the bugs a repository's maintainers went
 * on to fix — the PROBE method (LogicStar, "Frontier coding agents find
 * different bugs than maintainers fix"), measured on real git history.
 *
 *   node scripts/probe-calibrate.mjs --t0 <ref|date> --t1 <ref|date> \
 *     --paths 'studio-backend/src/documents/**' [--findings findings.json] \
 *     [--repo .] [--tolerance 3] [--fix-pattern <regex>] [--branch HEAD] [--json]
 *
 * 1. The repository at T0 is the snapshot. The producer (a spec-findings run,
 *    a coding agent asked to "find all bugs") sees that checkout and nothing
 *    after it — see docs/probe-calibration.md for the discipline.
 * 2. The reference set: every non-merge commit in T0..T1 under the paths whose
 *    subject reads as a fix (`--fix-pattern`). Each changed hunk's old side —
 *    the lines the fix replaced, in the fix's parent — is mapped back to T0
 *    through `git diff -U0 T0 <fix>^`. A line the diff says changed after T0
 *    did not exist at T0: the bug it fixes was introduced later and is
 *    dropped. What maps is one reference item per (fix, file, T0 line range).
 *    A pure insertion is anchored at the line it was inserted after.
 * 3. The findings the producer emitted at T0 —
 *    `[{ "id", "file", "line" }]` or `"start"`/`"end"` (`line_start`/
 *    `line_end` are read too, as Studio's findings carry them) — are matched
 *    to the reference items by file and line overlap, with a tolerance.
 * 4. Recall is the share of reference items found; precision is the share of
 *    findings that match a later fix — a lower bound, since a real bug nobody
 *    fixed by T1 counts as unmatched.
 *
 * Matching is by place, not by meaning: a finding next to a fix may be about
 * another bug. The matched pairs are listed so a person (or a judge model)
 * can sort them into same bug / different bug, as PROBE does.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A subject that reads as a bug fix: conventional `fix:`, or "fix"/"bug" as a word. */
export const DEFAULT_FIX_PATTERN = /^(fix|bugfix|hotfix)(\([^)]*\))?!?:|\b(fix(es|ed)?|bugs?)\b/i;

export function isFix(subject, pattern = DEFAULT_FIX_PATTERN) {
  return pattern.test(subject);
}

/** A path as git prints it: `"a/b c"` unquoted, the `a/` or `b/` prefix dropped. */
function diffPath(raw) {
  let p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);
  return p.replace(/^[ab]\//, '');
}

/**
 * The hunks of a `git diff -U0` text, per file:
 * `[{ oldFile, newFile, hunks: [{ oldStart, oldCount, newStart, newCount }] }]`.
 * A file added has `oldFile` null, one removed `newFile` null.
 */
export function parseHunks(text) {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      cur = { oldFile: null, newFile: null, hunks: [] };
      files.push(cur);
    } else if (cur && line.startsWith('--- ')) {
      cur.oldFile = diffPath(line.slice(4));
    } else if (cur && line.startsWith('+++ ')) {
      cur.newFile = diffPath(line.slice(4));
    } else if (cur && line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      cur.hunks.push({
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
      });
    }
  }
  return files;
}

/**
 * Where line `n` of the new side of a diff was on its old side, or null when
 * the diff changed or added it. With -U0, a hunk with no new lines
 * (`+b,0`) is a deletion after line b.
 */
export function mapToOld(hunks, n) {
  let delta = 0;
  for (const h of hunks) {
    if (h.newCount > 0) {
      const last = h.newStart + h.newCount - 1;
      if (n >= h.newStart && n <= last) return null;
      if (last < n) delta += h.newCount - h.oldCount;
    } else if (h.newStart < n) {
      delta -= h.oldCount;
    }
  }
  return n - delta;
}

/** The lines (in the fix's parent) a fix hunk touches: its old side, or for an insertion the line before it. */
export function touchedLines(hunk) {
  if (hunk.oldCount > 0) {
    return Array.from({ length: hunk.oldCount }, (_, i) => hunk.oldStart + i);
  }
  return [Math.max(hunk.oldStart, 1)];
}

/** Sorted line numbers as contiguous `[start, end]` ranges. */
export function toRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/**
 * The reference items of one fix commit.
 * `fixDiff`: parsed `git diff -U0 <fix>^ <fix>`; `sinceT0`: parsed
 * `git diff -U0 T0 <fix>^` over the same files. A file missing from
 * `sinceT0` did not change between T0 and the fix's parent.
 */
export function referenceItemsForFix({ commit, subject }, fixDiff, sinceT0) {
  const drift = new Map(sinceT0.map((f) => [f.newFile, f]));
  const items = [];
  for (const file of fixDiff) {
    if (!file.oldFile) continue; // a file the fix added held no bug at T0
    const d = drift.get(file.oldFile);
    if (d && !d.oldFile) continue; // the file was created after T0
    const t0File = d ? d.oldFile : file.oldFile;
    const hunks = d ? d.hunks : [];
    const t0Lines = [];
    for (const h of file.hunks) {
      for (const n of touchedLines(h)) {
        const old = mapToOld(hunks, n);
        if (old !== null) t0Lines.push(old);
      }
    }
    for (const [start, end] of toRanges(t0Lines)) {
      items.push({ id: `${commit.slice(0, 10)}:${t0File}:${start}-${end}`, commit, subject, file: t0File, start, end });
    }
  }
  return items;
}

/** Reference items with the same id once. */
export function dedupe(items) {
  const seen = new Map();
  for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
  return [...seen.values()];
}

/** A path compared as written in the repository: forward slashes, no leading `./`. */
export function normalisePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** A producer's finding as `{ id, file, start, end, text }`, or null when it names no place. */
export function normaliseFinding(f, i) {
  const start = f.start ?? f.line_start ?? f.line;
  const end = f.end ?? f.line_end ?? f.line ?? start;
  if (!f.file || !Number.isFinite(Number(start))) return null;
  return {
    id: String(f.id ?? `#${i}`),
    file: normalisePath(f.file),
    start: Number(start),
    end: Math.max(Number(start), Number(end)),
    text: f.text ?? '',
  };
}

/** Findings from a file's JSON: an array, or `{ findings: [...] }`. */
export function readFindings(json) {
  const list = Array.isArray(json) ? json : json?.findings ?? [];
  return list.map(normaliseFinding).filter(Boolean);
}

/** Whether a finding lies within `tolerance` lines of a reference item in the same file. */
export function overlaps(finding, ref, tolerance) {
  return (
    normalisePath(finding.file) === normalisePath(ref.file) &&
    finding.start - tolerance <= ref.end &&
    ref.start <= finding.end + tolerance
  );
}

/** Every (finding, reference) pair that overlaps, and what was left on either side. */
export function match(findings, refs, tolerance = 3) {
  const pairs = [];
  for (const f of findings) for (const r of refs) if (overlaps(f, r, tolerance)) pairs.push({ finding: f.id, reference: r.id });
  const foundRefs = new Set(pairs.map((p) => p.reference));
  const usefulFindings = new Set(pairs.map((p) => p.finding));
  return {
    pairs,
    missed: refs.filter((r) => !foundRefs.has(r.id)),
    unmatched: findings.filter((f) => !usefulFindings.has(f.id)),
  };
}

/**
 * Recall over reference items and over fix commits (a fix counts as found when
 * any of its items is), and precision as a lower bound. A ratio over nothing is null.
 */
export function score(findings, refs, result) {
  const ratio = (a, b) => (b === 0 ? null : a / b);
  const foundRefs = new Set(result.pairs.map((p) => p.reference));
  const usefulFindings = new Set(result.pairs.map((p) => p.finding));
  const commits = new Set(refs.map((r) => r.commit));
  const foundCommits = new Set(refs.filter((r) => foundRefs.has(r.id)).map((r) => r.commit));
  return {
    references: refs.length,
    fixes: commits.size,
    findings: findings.length,
    recall: ratio(foundRefs.size, refs.length),
    recallByFix: ratio(foundCommits.size, commits.size),
    precisionLowerBound: ratio(usefulFindings.size, findings.length),
  };
}

// ---- git ----------------------------------------------------------------

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const DATE = /^\d{4}-\d{2}-\d{2}([ T].*)?$/;

/** A ref as a commit; a date as the last first-parent commit of `branch` before it. */
export function resolvePoint(repo, point, branch) {
  if (DATE.test(point)) {
    const sha = git(repo, ['rev-list', '-1', '--first-parent', `--before=${point}`, branch]).trim();
    if (!sha) throw new Error(`no commit on ${branch} before ${point}`);
    return sha;
  }
  return git(repo, ['rev-parse', '--verify', `${point}^{commit}`]).trim();
}

function pathspecs(paths) {
  return paths.map((p) => (/[*?[]/.test(p) && !p.startsWith(':') ? `:(glob)${p}` : p));
}

const DIFF = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames'];

export function buildReferenceSet({ repo, t0, t1, paths, fixPattern = DEFAULT_FIX_PATTERN }) {
  const specs = pathspecs(paths);
  const log = git(repo, ['log', '--no-merges', '--format=%H%x09%s', `${t0}..${t1}`, '--', ...specs]);
  const fixes = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [commit, ...rest] = l.split('\t');
      return { commit, subject: rest.join('\t') };
    })
    .filter((c) => isFix(c.subject, fixPattern));
  const items = [];
  for (const fix of fixes) {
    const fixDiff = parseHunks(git(repo, [...DIFF, `${fix.commit}^`, fix.commit, '--', ...specs]));
    const files = fixDiff.map((f) => f.oldFile).filter(Boolean);
    if (files.length === 0) continue;
    const sinceT0 = parseHunks(git(repo, [...DIFF, t0, `${fix.commit}^`, '--', ...files]));
    items.push(...referenceItemsForFix(fix, fixDiff, sinceT0));
  }
  return { fixes, items: dedupe(items) };
}

// ---- CLI ----------------------------------------------------------------

function parseArgs(argv) {
  const opts = { repo: '.', paths: [], tolerance: 3, branch: 'HEAD', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--repo') opts.repo = next();
    else if (a === '--t0') opts.t0 = next();
    else if (a === '--t1') opts.t1 = next();
    else if (a === '--paths') opts.paths.push(next());
    else if (a === '--findings') opts.findings = next();
    else if (a === '--tolerance') opts.tolerance = Number(next());
    else if (a === '--fix-pattern') opts.fixPattern = new RegExp(next(), 'i');
    else if (a === '--branch') opts.branch = next();
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.t0 || !opts.t1) throw new Error('--t0 and --t1 are required');
  if (opts.paths.length === 0) opts.paths.push('.');
  return opts;
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/probe-calibrate.mjs --t0 <ref|date> --t1 <ref|date> --paths <glob> [--findings f.json] [--repo .] [--tolerance 3] [--fix-pattern re] [--branch HEAD] [--json]`);
    process.exit(2);
  }
  const t0 = resolvePoint(opts.repo, opts.t0, opts.branch);
  const t1 = resolvePoint(opts.repo, opts.t1, opts.branch);
  const { fixes, items } = buildReferenceSet({ repo: opts.repo, t0, t1, paths: opts.paths, fixPattern: opts.fixPattern });
  const findings = opts.findings ? readFindings(JSON.parse(readFileSync(opts.findings, 'utf8'))) : [];
  const result = match(findings, items, opts.tolerance);
  const scores = score(findings, items, result);

  if (opts.json) {
    console.log(JSON.stringify({ t0, t1, paths: opts.paths, tolerance: opts.tolerance, fixes, scores, references: items, ...result }, null, 2));
    return;
  }
  console.log(`T0 ${t0.slice(0, 10)}  T1 ${t1.slice(0, 10)}  paths ${opts.paths.join(' ')}`);
  console.log(`fix commits ${fixes.length}, with lines present at T0 ${scores.fixes}, reference items ${scores.references}`);
  console.log(`findings ${scores.findings}, tolerance ±${opts.tolerance} lines`);
  console.log(`recall ${pct(scores.recall)} of items, ${pct(scores.recallByFix)} of fixes; precision ≥ ${pct(scores.precisionLowerBound)}`);
  const byId = new Map(items.map((r) => [r.id, r]));
  if (result.pairs.length) {
    console.log('\nmatched (check: same bug or a different one?)');
    for (const p of result.pairs) console.log(`  ${p.finding} ↔ ${p.reference}  ${byId.get(p.reference).subject}`);
  }
  if (result.missed.length) {
    console.log('\nmissed (fixed later, not reported at T0)');
    for (const r of result.missed) console.log(`  ${r.file}:${r.start}-${r.end}  ${r.commit.slice(0, 10)} ${r.subject}`);
  }
  if (result.unmatched.length) {
    console.log('\nunmatched findings (not a bug, or a bug nobody fixed by T1)');
    for (const f of result.unmatched) console.log(`  ${f.id}  ${f.file}:${f.start}-${f.end}  ${f.text}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
