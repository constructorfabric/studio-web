/*
 * The adapter between two Python detectors and a directory of JSON —
 * CONTRACT-runner.md's whole subject. This file spawns processes; nothing
 * else in this feature does. Everything that decides WHAT to spawn and WHAT
 * to do with the result is a pure function below, exported so
 * `quality-runner-test.mjs` can drive it against a stub interpreter — a
 * fake `python` that costs milliseconds and never imports torch — rather
 * than the real ~500 MB reranker on every commit. `resolveInterpreter`,
 * `discoverDocsets`, `rewritePurposeReport`, `rewriteBloatReport` and
 * `deriveDocumentBloat` are the load-bearing ones; `QualityRunner` itself is
 * mostly wiring around them.
 *
 * WHY THIS FILE OWNS PROCESS LIFECYCLE AND NOTHING ELSE. `quality-scan.js`
 * already normalises the four detector shapes into the envelope the
 * frontend reads — that job is not repeated here, on purpose. This module's
 * entire contract with the rest of the feature is: given a project root,
 * produce (or reuse) the files `quality-store.js` already knows how to read
 * under `.studio/quality/runs/<runId>/`. Nothing here parses a `duplicate`
 * finding out of a cluster, bands trust, or computes a fingerprint — that
 * would be a second, drifting implementation of logic `quality-scan.js`
 * already owns.
 *
 * ROOT IS A FILESYSTEM PATH, NEVER A URI. CONTRACT-runner.md §5 draws this
 * line explicitly: the RPC layer (`quality-backend.js`) converts a Theia
 * `URI` to `uri.path.fsPath()` before it ever reaches this file, so this
 * module never requires `@theia/core` at all — it is plain Node, testable
 * with plain `node`, and it would still work if the frontend were not Theia.
 *
 * WHAT "one process per docset" ACTUALLY BUYS. `bloat_detector.py` has no
 * server mode and no lexical-only fallback — the semantic pass loads a
 * ~500 MB reranker on every invocation, whether it is given one file or
 * twelve. So batching every file in a docset into ONE invocation (the CLI
 * already accepts `paths [paths ...]`) is not an optimisation on top of a
 * per-file design; it is the *only* design that does not pay that load once
 * per document. The consequence, worked through in full below: the detector
 * only ever emits ONE combined report per docset, and `bloat/<slug>.json`
 * (per document, per CONTRACT §2) does not come from a second invocation —
 * it is DERIVED by filtering the docset's own clusters down to the ones that
 * touch that file (`deriveDocumentBloat`). That derivation is not spelled
 * out anywhere in CONTRACT-runner.md; see the function's own header for the
 * reasoning and for the one thing this module refuses to fabricate as a
 * result (per-document `metrics`).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// -- layout, mirroring CONTRACT-runner.md §2 and quality-store.js's QUALITY_DIR --

const QUALITY_DIR = '.studio/quality';
const RUNNER_CONFIG_FILE = 'runner.json';
const STATE_FILE = 'state.json';
const RUNS_SUBDIR = 'runs';
const PURPOSE_SUBDIR = 'purpose';
const BLOAT_SUBDIR = 'bloat';
const DOCSET_SUBDIR = 'bloat-docset';
/* `reports/` — CONTRACT-quality.md §5's hand-drop directory, read-only to
 * this module. Named here only so a run with no predecessor of its own can
 * still inherit from it (see `resolveInheritanceSource`) — this file never
 * writes a single byte under this name. */
const REPORTS_SUBDIR = 'reports';
/* `trace-<docset>.json` lives at the TOP of a run/reports directory, not
 * inside a subdirectory — matched by prefix/suffix rather than an exact
 * name, same as quality-store.js's own `TRACE_PREFIX`/`TRACE_SUFFIX`. Nothing
 * in this module ever PRODUCES one (no detector for traceability exists
 * yet), but CONTRACT §2 lists it among what a run directory holds, and a
 * hand-dropped or future one must survive being carried forward like every
 * other artifact. */
const TRACE_PREFIX = 'trace-';
const TRACE_SUFFIX = '.json';

/* A directory one level under root needs at least this many Markdown files
 * (recursively) to count as a docset on its own — CONTRACT-runner.md §0, Q1.
 * Below this a directory is prose that happens to live in its own folder,
 * not a service with cross-document duplication worth a dedicated pass. */
const MIN_DOCSET_MARKDOWN_FILES = 2;

/* Never walked into when discovering docsets or hashing "every document in
 * the project": `.git` is not prose, `.studio` is this feature's own sidecar
 * (walking into it would let a runner treat its own run history as a
 * docset), and `node_modules` is the generic "not content" guard every other
 * walker in this codebase (`search-view.js`, `quality-store.js`) applies.
 * Applied together with a plain dotdir skip, since a hidden folder is never
 * a person's documentation by convention in this product either. */
const SKIP_DIR_NAMES = new Set(['.git', '.studio', 'node_modules']);

/* Purpose is 68 ms and model-free (measured, CONTRACT §1) — parallelising it
 * costs nothing but wall clock and is worth doing. Bloat loads a model that
 * competes for the same RAM a laptop's browser and editor are already using,
 * so it is never run more than one docset at a time (see the sequential loop
 * in `_runBloatPasses`) — the same reasoning CONTRACT §5 gives for making a
 * run singleton per root: two concurrent torch loads is a hang, not speed. */
const PURPOSE_CONCURRENCY = 4;

/* Mirrors purpose_classifier.py's own `--doc-type` choices exactly. Kept here
 * so an override this module is about to pass as a CLI argument can be
 * rejected BEFORE a process is spawned for a guaranteed argparse failure —
 * "refuse rather than guess" applies to input as much as to output. This is
 * the same category of hand-synced constant as quality-scan.js's analyser
 * version strings: if the classifier's enum ever changes, this must be
 * updated by hand, and nothing here can detect that it has drifted. */
const KNOWN_DOC_TYPES = new Set(['adr', 'decomposition', 'design', 'feature', 'prd']);

/* The three passes a caller may ask for via `run(..., { detectors })`.
 * Deliberately a flat list rather than a hierarchy: 'bloat' and
 * 'bloat-docset' share ONE underlying process per docset (see the file
 * header), but a caller who wants only the per-document view (the document
 * rail) should not be forced to pay for writing sixteen files' worth of
 * cross-document report it will never read, and vice versa for the project
 * tab. Naming them as two independent toggles over one computation is what
 * lets that be true without a second process. */
const KNOWN_DETECTORS = ['purpose', 'bloat', 'bloat-docset'];

// -- small pure helpers -------------------------------------------------------

/** `mcp-engine/PRD.md` -> `mcp-engine__PRD.md` — CONTRACT §2, the same slug
 *  the 179 hand-dropped reports already use, so one reader serves both. */
function slugify(relPath) {
    return String(relPath).split('/').join('__');
}

/** `YYYYMMDD-HHMMSS`, UTC, from the clock at start — CONTRACT §2. Exported
 *  so the test suite can assert the format without waiting on a real clock. */
function formatRunId(date) {
    const pad = n => String(n).padStart(2, '0');
    return String(date.getUTCFullYear()) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
        + '-' + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds());
}

function sha256File(absPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function readJsonFileSync(absPath) {
    try {
        if (!fs.existsSync(absPath)) { return undefined; }
        return JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (error) {
        // A malformed runner.json or state.json costs this call the
        // sidecar's contents, never the run — same defensive-parse rule
        // quality-store.js's readJson applies to the browser side of the
        // same two files.
        console.warn('[studio] could not read', absPath, error);
        return undefined;
    }
}

function writeJsonFile(absPath, value) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(value, undefined, 2) + '\n');
}

function copyIfExists(fromAbs, toAbs) {
    if (!fs.existsSync(fromAbs)) { return false; }
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.copyFileSync(fromAbs, toAbs);
    return true;
}

/*
 * A path handed in from OUTSIDE this module — a caller's `paths` option, or a
 * detector's own recorded `path`/`file` — resolved against the root and
 * proven to stay inside it. Returns the project-relative, `/`-joined form on
 * success, `undefined` on anything that would escape (`..`, an absolute path
 * naming somewhere else entirely, a path that resolves through a symlink out
 * of the root — `path.relative` catches all three the same way).
 *
 * REFUSE RATHER THAN GUESS is CONTRACT §2's own phrase for the detector-output
 * half of this; the coordinator's note extends it to the REQUEST half too
 * (a caller-supplied `paths` entry that escapes root), and one function
 * proves both, since "does this path stay inside the root" does not care
 * which direction the path came from.
 */
function toRelativeUnderRoot(rootFsPath, absOrRelPath) {
    if (typeof absOrRelPath !== 'string' || !absOrRelPath) { return undefined; }
    const abs = path.isAbsolute(absOrRelPath) ? absOrRelPath : path.resolve(rootFsPath, absOrRelPath);
    const rel = path.relative(rootFsPath, abs);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        return undefined;
    }
    return rel.split(path.sep).join('/');
}

// -- §0: locating the interpreter and the checkout ---------------------------

function runnerConfigPath(rootFsPath) { return path.join(rootFsPath, QUALITY_DIR, RUNNER_CONFIG_FILE); }
function stateFilePath(rootFsPath) { return path.join(rootFsPath, QUALITY_DIR, STATE_FILE); }
function runsDir(rootFsPath) { return path.join(rootFsPath, QUALITY_DIR, RUNS_SUBDIR); }
function reportsDir(rootFsPath) { return path.join(rootFsPath, QUALITY_DIR, REPORTS_SUBDIR); }

function isExecutableFile(candidate) {
    try {
        if (!fs.statSync(candidate).isFile()) { return false; }
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch (error) {
        return false;
    }
}

/* A directory is trusted as a `spec-analysis` checkout only once both CLIs
 * this module actually spawns are found inside it — cheap, and it turns a
 * typo'd `specAnalysis` in runner.json into "not available, and why" at
 * probe time instead of a spawn failure buried in a run's `failures[]`. */
function looksLikeSpecAnalysisCheckout(dir) {
    return fs.existsSync(path.join(dir, 'src', 'purpose_classification', 'purpose_classifier.py'))
        && fs.existsSync(path.join(dir, 'src', 'bloat_detection', 'bloat_detector.py'));
}

/*
 * CONTRACT §0's three-step resolution, first hit wins — with one reading
 * spelled out because the contract's prose does not quite say it: "first hit
 * wins" is per FIELD (python, specAnalysis independently fall through
 * runner.json -> env -> the venv guess), not "use runner.json for everything,
 * or nothing from it at all". A repository that commits `specAnalysis` in
 * runner.json but leaves `python` for a developer's own `$STUDIO_QUALITY_PYTHON`
 * is a real, sensible split — pinning the checkout to the branch while
 * letting the interpreter be whichever venv a machine actually has — and a
 * strictly all-or-nothing reading of "first hit wins" would refuse it.
 *
 * Step 3 ("a `.venv/bin/python` beside the configured `specAnalysis`
 * checkout, or its parent") only has something to be "beside": it engages
 * exactly when `specAnalysis` resolved via steps 1-2 but `python` did not.
 * Measured against the real checkout this feature was built against,
 * `.venv/bin/python` lives in the CHECKOUT'S PARENT, not beside it
 * (`studio-experiments/.venv/` next to `studio-experiments/spec-analysis/`)
 * — "which is where the real one is" in the contract's own words — so the
 * parent is checked, not just the sibling.
 */
function resolveInterpreter(rootFsPath, env) {
    env = env || process.env;
    const config = readJsonFileSync(runnerConfigPath(rootFsPath)) || {};

    let python = typeof config.python === 'string' && config.python ? config.python : undefined;
    let pythonSource = python ? 'runner.json' : undefined;
    let specAnalysis = typeof config.specAnalysis === 'string' && config.specAnalysis ? config.specAnalysis : undefined;
    let specSource = specAnalysis ? 'runner.json' : undefined;

    if (!python && env.STUDIO_QUALITY_PYTHON) { python = env.STUDIO_QUALITY_PYTHON; pythonSource = 'env'; }
    if (!specAnalysis && env.STUDIO_QUALITY_SPEC_ANALYSIS) { specAnalysis = env.STUDIO_QUALITY_SPEC_ANALYSIS; specSource = 'env'; }

    const base = {
        python, specAnalysis,
        docsets: Array.isArray(config.docsets) ? config.docsets.slice() : undefined,
        gateThreshold: typeof config.gateThreshold === 'number' ? config.gateThreshold : undefined,
        semantic: typeof config.semantic === 'boolean' ? config.semantic : undefined
    };

    if (!specAnalysis) {
        return {
            ...base, available: false, source: undefined,
            why: 'no detector checkout is configured — set "specAnalysis" in .studio/quality/runner.json, '
                + 'or the STUDIO_QUALITY_SPEC_ANALYSIS environment variable'
        };
    }
    if (!fs.existsSync(specAnalysis) || !fs.statSync(specAnalysis).isDirectory()) {
        return { ...base, available: false, source: specSource, why: 'the configured detector checkout does not exist: ' + specAnalysis };
    }
    if (!looksLikeSpecAnalysisCheckout(specAnalysis)) {
        return {
            ...base, available: false, source: specSource,
            why: 'the configured path does not look like a spec-analysis checkout '
                + '(purpose_classifier.py / bloat_detector.py not found under it): ' + specAnalysis
        };
    }

    if (!python) {
        // "beside the checkout, or its parent" — see the header comment for
        // why the parent is checked too, and checked second (the sibling
        // reading is the literal one; the parent is where it actually lives).
        const candidates = [
            path.join(specAnalysis, '.venv', 'bin', 'python'),
            path.join(path.dirname(specAnalysis), '.venv', 'bin', 'python')
        ];
        const found = candidates.find(isExecutableFile);
        if (found) { python = found; pythonSource = 'venv'; }
    }
    if (!python) {
        return {
            ...base, available: false, source: specSource,
            why: 'no python interpreter found — checked runner.json, STUDIO_QUALITY_PYTHON, '
                + 'and .venv/bin/python beside/above ' + specAnalysis
        };
    }
    /* A bare command name (`"python3"`, no path separator) is left to `spawn`
     * to resolve against PATH rather than stat'd here: PATH resolution is not
     * this function's job to reimplement, and refusing a value that merely
     * LOOKS unfamiliar would punish a valid, deliberately unqualified
     * runner.json entry. A value that DOES look like a path is checked,
     * because that is the common case and the one worth a precise "why". */
    if (python.includes(path.sep) && !isExecutableFile(python)) {
        return { ...base, python, available: false, source: pythonSource, why: 'the configured python interpreter is not an executable file: ' + python };
    }

    const source = pythonSource || specSource;
    return {
        ...base, python, available: true, source, why: undefined,
        purposeScript: path.join(specAnalysis, 'src', 'purpose_classification', 'purpose_classifier.py'),
        bloatScript: path.join(specAnalysis, 'src', 'bloat_detection', 'bloat_detector.py')
    };
}

// -- §0 Q1: docset discovery --------------------------------------------------

function listMarkdownFilesRecursive(absDir, rootFsPath, acc) {
    acc = acc || [];
    let entries;
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
        return acc; // vanished or unreadable mid-walk: this directory contributes nothing, not a thrown error
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) { continue; }
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) { continue; }
            listMarkdownFilesRecursive(abs, rootFsPath, acc);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            acc.push(path.relative(rootFsPath, abs).split(path.sep).join('/'));
        }
    }
    return acc;
}

/*
 * CONTRACT §0, Q1: "every immediate subdirectory of the root holding two or
 * more Markdown files" — when `configuredNames` (runner.json's `docsets`) is
 * absent. Once a directory qualifies (by either route), its FILE SET is every
 * Markdown file recursively beneath it, not just its direct children — the
 * committed `bloat-docset/mcp-engine.json` fixture proves this: `mcp-engine`
 * has three files directly inside it and nine more under `ADR/` and
 * `features/`, and the fixture's `paths` lists all twelve. The two-file
 * THRESHOLD only ever gates which directories get discovered automatically;
 * it says nothing about which files belong to a docset once named, which is
 * why an explicit `docsets` entry is never threshold-checked here — a person
 * who names a directory in runner.json meant it, however few files it holds.
 */
function discoverDocsets(rootFsPath, configuredNames) {
    let names = Array.isArray(configuredNames) && configuredNames.length ? configuredNames.slice() : undefined;
    if (!names) {
        names = [];
        let entries;
        try { entries = fs.readdirSync(rootFsPath, { withFileTypes: true }); } catch (error) { entries = []; }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) { continue; }
            const files = listMarkdownFilesRecursive(path.join(rootFsPath, entry.name), rootFsPath, []);
            if (files.length >= MIN_DOCSET_MARKDOWN_FILES) { names.push(entry.name); }
        }
    }
    return names
        .map(name => ({ name, files: listMarkdownFilesRecursive(path.join(rootFsPath, name), rootFsPath, []) }))
        .filter(docset => docset.files.length > 0); // a configured name holding nothing readable is not a docset to run
}

function findDocsetContaining(rootFsPath, configuredNames, relPath) {
    const top = String(relPath).split('/')[0];
    return discoverDocsets(rootFsPath, configuredNames).find(d => d.name === top);
}

// -- §2: path rewriting, refused rather than guessed -------------------------

/*
 * `purpose/*.json`'s only path-shaped field is the top-level `path` the
 * classifier was invoked with. Rewritten to project-relative before the file
 * is written to disk, or the whole report is refused — CONTRACT §2 is
 * explicit that a report naming `/Users/.../mcp-engine/PRD.md` cannot be
 * addressed by a project and must not be written half-rewritten.
 */
function rewritePurposeReport(report, rootFsPath) {
    if (!report || typeof report.path !== 'string') {
        return { ok: false, why: 'purpose report has no "path" field to rewrite' };
    }
    const rel = toRelativeUnderRoot(rootFsPath, report.path);
    if (!rel) {
        return { ok: false, why: 'purpose report path is not under the project root: ' + report.path };
    }
    return { ok: true, report: Object.assign({}, report, { path: rel }) };
}

/*
 * `bloat/*.json` and `bloat-docset/*.json` share this shape: `paths[]` at the
 * top, and every `clusters[].occurrences[].file`. All of them are rewritten
 * together and the whole report is refused if ANY of them falls outside
 * root — a report half addressable and half not would let a duplicate
 * finding jump to a file the project cannot resolve, silently, deep inside
 * an otherwise-valid cluster.
 */
function rewriteBloatReport(report, rootFsPath) {
    if (!report || !Array.isArray(report.paths)) {
        return { ok: false, why: 'bloat report has no "paths" array to rewrite' };
    }
    const paths = [];
    for (const original of report.paths) {
        const rel = toRelativeUnderRoot(rootFsPath, original);
        if (!rel) { return { ok: false, why: 'bloat report path is not under the project root: ' + original }; }
        paths.push(rel);
    }
    const clusters = [];
    for (const cluster of (report.clusters || [])) {
        const occurrences = [];
        for (const occurrence of (cluster.occurrences || [])) {
            const rel = toRelativeUnderRoot(rootFsPath, occurrence.file);
            if (!rel) { return { ok: false, why: 'bloat report occurrence path is not under the project root: ' + occurrence.file }; }
            occurrences.push(Object.assign({}, occurrence, { file: rel }));
        }
        clusters.push(Object.assign({}, cluster, { occurrences }));
    }
    return { ok: true, report: Object.assign({}, report, { paths, clusters }) };
}

/*
 * `bloat/<slug>.json`, PER DOCUMENT, derived from the one docset-wide
 * invocation — see the file header for why there is no second process to
 * derive it from instead. A cluster belongs to a document if any of its
 * (already root-relative) occurrences names that document; kept WHOLE, every
 * occurrence in every file, not trimmed to this document's own — a duplicate
 * that also lives in DESIGN.md is exactly the "also at DESIGN.md" line
 * PLAN §3's rail mockup shows even from inside one document, and trimming
 * the cluster here would make that impossible to render later.
 *
 * `metrics` IS DELIBERATELY ABSENT FROM THE RESULT. The docset invocation's
 * `metrics` block (dup_rate, n_paragraphs, ...) describes the WHOLE docset —
 * mcp-engine's real `bloat-docset/mcp-engine.json` reports 912 paragraphs
 * across twelve files, not any one of them. Relabelling that object as one
 * document's own metrics would be a fabrication with a plausible decimal
 * point, which is a worse failure than a blank field: `quality-scan.js`'s
 * `normalizeDocument` already treats an absent `bloat.metrics` as "this
 * document's duplication rate and paragraph count are not known" (it simply
 * skips those measures) rather than throwing, so leaving it out here is a
 * real, designed degradation, not a shortcut. Recovering a genuine
 * per-document rate would mean invoking the detector once per file, which is
 * exactly the cost §1 batching exists to avoid — CONTRACT-runner.md does not
 * say which of the two to give up, and this module gives up the number
 * rather than the batching.
 */
function deriveDocumentBloat(docsetReport, relDocPath) {
    const clusters = (docsetReport && Array.isArray(docsetReport.clusters) ? docsetReport.clusters : [])
        .filter(cluster => (cluster.occurrences || []).some(occurrence => occurrence.file === relDocPath));
    return { paths: [relDocPath], clusters };
}

// -- `run(..., { detectors })`, the coordinator's addition -------------------

/*
 * `detectors` narrows which of the three passes actually run — added after
 * this file's first draft, once the two callers (on-save in
 * `markdown-editor.js`, and the project tab's "Check project") were being
 * wired up and it became clear `scope` alone cannot express "purpose only":
 * a document-scope on-save check and a document-scope "run everything on
 * this one file, including its docset's duplication" are the SAME scope with
 * different costs, and only the caller knows which it wants.
 *
 * OMITTED MEANS ALL THREE — the on-demand case, and the safe default for
 * anything that does not know to ask for less. An EXPLICIT EMPTY ARRAY IS
 * NOT THE SAME AS OMITTED: a caller that deliberately passed `[]` (or named
 * only detectors this build has never heard of) gets nothing run, and the
 * manifest says so, rather than this module silently reinterpreting an empty
 * list as "I suppose you wanted everything" — that reinterpretation is
 * exactly the failure mode the coordinator's note calls out.
 */
function resolveDetectorSet(requested) {
    if (requested === undefined) {
        return { requested: undefined, run: KNOWN_DETECTORS.slice(), unrecognized: [] };
    }
    const list = Array.isArray(requested) ? requested : [];
    const run = list.filter(name => KNOWN_DETECTORS.includes(name));
    const unrecognized = list.filter(name => !KNOWN_DETECTORS.includes(name));
    return { requested: list.slice(), run, unrecognized };
}

// -- spawning ------------------------------------------------------------

/*
 * One child process, collected in full — these detectors both print one JSON
 * document to stdout and exit; there is no streaming output worth reacting to
 * mid-run. `signal` is the run's own `AbortController.signal`, shared across
 * every child a run spawns: `cancel()` aborts it once and Node's `spawn`
 * turns that into SIGTERM for whichever child is alive at that instant — the
 * mechanism that makes cancellation real rather than "the loop stops asking
 * for more work" (CONTRACT-runner.md's own emphasis, and this module's).
 *
 * Resolves rather than rejects even on a spawn error or an abort, with
 * `code: null` and an `aborted` flag — the caller (`_runOnePurpose` /
 * `_runOneBloatPass`) already has a uniform "this detector did not produce a
 * usable report" branch for a non-zero exit, and a rejected promise would
 * need a second, parallel error path for the exact same outcome.
 */
function runChild(pythonPath, args, signal) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(pythonPath, args, { signal });
        } catch (error) {
            resolve({ code: null, stdout: '', stderr: String((error && error.message) || error), aborted: !!(signal && signal.aborted) });
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            resolve({ code: null, stdout, stderr: stderr || String((error && error.message) || error), aborted: !!(signal && signal.aborted) });
        });
        child.on('close', code => {
            resolve({ code, stdout, stderr, aborted: !!(signal && signal.aborted) });
        });
    });
}

/** A small worker pool: at most `limit` calls to `worker` in flight, in `items`
 *  order otherwise unconstrained — purpose's concurrency cap (CONTRACT §5's
 *  "run a few in parallel"), written once rather than pulled in as a dependency
 *  this CommonJS, no-build tree does not otherwise have. */
async function runWithConcurrency(items, limit, worker) {
    let next = 0;
    const lanes = new Array(Math.max(0, Math.min(limit, items.length))).fill(0).map(async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) { return; }
            await worker(items[index], index);
        }
    });
    await Promise.all(lanes);
}

// -- state.json: read-only here ----------------------------------------------

/*
 * `overrides[path].docType` — CONTRACT-runner.md's own words, "the
 * highest-leverage control in the feature", read here and never written:
 * `quality-store.js` owns writing `state.json` (`saveDocTypeOverride`), and
 * this module only ever reads the one field it needs from it. Same file,
 * disjoint responsibilities — the layering CONTRACT-quality.md's header
 * comment describes for `judgments.json` applies here too.
 */
function loadDocTypeOverrides(rootFsPath) {
    const data = readJsonFileSync(stateFilePath(rootFsPath));
    const overrides = data && data.overrides && typeof data.overrides === 'object' && !Array.isArray(data.overrides)
        ? data.overrides : {};
    return overrides;
}

// -- manifest / previous-run bookkeeping --------------------------------------

function listRunIdsAscending(rootFsPath) {
    let entries;
    try { entries = fs.readdirSync(runsDir(rootFsPath)); } catch (error) { return []; }
    // The fixed-width `YYYYMMDD-HHMMSS` format sorts lexically in the same
    // order as chronologically — no need to parse a date to order runs.
    return entries.filter(name => /^\d{8}-\d{6}/.test(name)).sort();
}

/** The newest run STRICTLY BEFORE `beforeRunId` that has a readable manifest —
 *  "before" so a run in progress can never treat its own (not yet written)
 *  manifest, or a same-second sibling, as its own predecessor. */
function findPreviousManifest(rootFsPath, beforeRunId) {
    const ids = listRunIdsAscending(rootFsPath);
    for (let i = ids.length - 1; i >= 0; i--) {
        if (ids[i] >= beforeRunId) { continue; }
        const manifest = readJsonFileSync(path.join(runsDir(rootFsPath), ids[i], 'manifest.json'));
        if (manifest) { return manifest; }
    }
    return undefined;
}

function findPreviousDocumentEntry(previousManifest, relPath) {
    if (!previousManifest || !Array.isArray(previousManifest.documents)) { return undefined; }
    return previousManifest.documents.find(entry => entry.path === relPath);
}

/*
 * Whether the artifact(s) THIS run actually needs for `relPath` already sit
 * in the previous run's directory. Deliberately keyed to what is being asked
 * for now, not to some detector-independent notion of "this file did not
 * change": CONTRACT §4's manifest has one `reused` boolean per document, but
 * the previous run may not have produced every artifact THIS run wants (a
 * save-time, purpose-only run followed by a "Check project" that also wants
 * bloat) — treating that document as reusable would silently skip generating
 * something nobody has ever produced for it. Checking existence rather than
 * trusting the previous manifest's own `reused` flag also means a chain of
 * many short-circuited runs can never compound a missing file into a
 * permanently-missing one; the moment something is not actually on disk this
 * returns false and the file gets produced again.
 */
function neededArtifactsExist(previousRunDir, relPath, wantPurpose, wantBloatDoc) {
    const slug = slugify(relPath);
    if (wantPurpose && !fs.existsSync(path.join(previousRunDir, PURPOSE_SUBDIR, slug + '.json'))) { return false; }
    if (wantBloatDoc && !fs.existsSync(path.join(previousRunDir, BLOAT_SUBDIR, slug + '.json'))) { return false; }
    return true;
}

// -- carrying forward what this run did not itself produce -------------------

/*
 * A RUN DIRECTORY MUST BE A COMPLETE SNAPSHOT OF THE PROJECT, not only of
 * what that particular run was asked to compute. Found by wiring this module
 * to `quality-store.js` against the real 86-document corpus: `loadReports`
 * treats the NEWEST run as the whole truth, so a save-time run
 * (`scope: 'document'`, `detectors: ['purpose']`) that wrote one purpose
 * report and nothing else made THAT the newest run — and every duplication
 * finding for the other 85 documents vanished from the project tab, because
 * this module had only ever written what it was asked for, never what a
 * reader would need to keep treating the directory as the whole project.
 *
 * The fix: after this run does whatever it was asked to do, walk its
 * inheritance source (below) and copy forward every artifact this run did
 * NOT itself produce, so the new directory is a superset of the old one.
 * `neededArtifactsExist` above stays exactly as it was — it answers "does
 * this document need recomputing", which is a genuinely different question
 * from "what belongs in the finished directory regardless of whether it was
 * recomputed" — this function answers the second one, unconditionally, for
 * every artifact kind, not just the ones a short-circuited document already
 * copied for itself (that copy and this one never collide: this pass only
 * ever fills a slot that is still empty after everything else has run).
 *
 * PRUNED, NOT BLINDLY COPIED. An artifact is only carried forward when the
 * document (or docset directory) it describes still exists in the project.
 * Copying forward a report for a file that has since been deleted or moved
 * would be "a complete snapshot of the project" in name only — a project tab
 * showing a finding against a document that is no longer there is worse than
 * one that has simply not looked at it yet.
 */
function slugToRelPath(slug) { return String(slug).split('__').join('/'); }

function directoryExists(candidate) {
    try { return fs.statSync(candidate).isDirectory(); } catch (error) { return false; }
}

/*
 * One artifact KIND (`purpose`, `bloat`, or `bloat-docset`) — every file
 * under `source.dir/subdir/*.json` that this run's own directory does not
 * already have a copy of. `toRelPath` turns a bare filename stem back into
 * the thing `stillExists` needs to check against the live project
 * (`slugToRelPath` for a per-document slug; the identity function for a
 * docset name, which is already a single path segment with nothing to
 * reverse).
 */
function carryForwardKind(source, runDir, subdir, kind, root, toRelPath, stillExists, carried) {
    let names;
    try { names = fs.readdirSync(path.join(source.dir, subdir)); } catch (error) { return; }
    for (const fileName of names) {
        if (!fileName.endsWith('.json')) { continue; }
        const dest = path.join(runDir, subdir, fileName);
        if (fs.existsSync(dest)) { continue; } // this run already produced its own — never clobbered by an inherited one
        const label = toRelPath(fileName.slice(0, -'.json'.length));
        if (!stillExists(label)) { continue; } // the document/docset behind this file is gone from the project
        if (copyIfExists(path.join(source.dir, subdir, fileName), dest)) {
            carried.push({ path: label, artifact: kind, from: source.label });
        }
    }
}

/** `trace-<docset>.json`, top-level rather than inside a subdirectory —
 *  otherwise the same rule as `carryForwardKind`. */
function carryForwardTraceFiles(source, runDir, root, carried) {
    let names;
    try { names = fs.readdirSync(source.dir); } catch (error) { return; }
    for (const fileName of names) {
        if (!fileName.startsWith(TRACE_PREFIX) || !fileName.endsWith(TRACE_SUFFIX)) { continue; }
        const dest = path.join(runDir, fileName);
        if (fs.existsSync(dest)) { continue; }
        const docsetName = fileName.slice(TRACE_PREFIX.length, -TRACE_SUFFIX.length);
        if (!directoryExists(path.join(root, docsetName))) { continue; } // the docset this traced is gone
        if (copyIfExists(path.join(source.dir, fileName), dest)) {
            carried.push({ path: docsetName, artifact: 'trace', from: source.label });
        }
    }
}

/*
 * WHERE this run inherits from — CONTRACT-runner.md never anticipated a
 * FIRST run on a project that already carries 179 hand-dropped reports:
 * the corpus this feature was built against has `reports/` fully populated
 * and no `runs/` at all, so a first-ever save-time run would otherwise
 * inherit nothing and the project tab would drop from 86 documents to one —
 * the exact same failure this whole mechanism exists to prevent, just on
 * the first run instead of the second.
 *
 * So the chain is: the newest run if one exists, `reports/` if it does not
 * — never both, and never merged, because once this fix is in place every
 * run this module ever writes is already a full superset of whatever it
 * inherited, so the newest run alone is always a superset of `reports/` too
 * by induction. `reports/` only ever matters for the very first check.
 */
function resolveInheritanceSource(rootFsPath, previousManifest, previousRunDir) {
    if (previousRunDir) { return { dir: previousRunDir, label: previousManifest.runId }; }
    const reports = reportsDir(rootFsPath);
    if (fs.existsSync(reports)) { return { dir: reports, label: REPORTS_SUBDIR }; }
    return undefined; // genuinely nothing to inherit — the very first check this project has ever had, and that is normal
}

/** The whole carry-forward pass, across every artifact kind. `source` may be
 *  `undefined` (nothing to inherit from at all), in which case this is a
 *  no-op that returns an empty list — never an error. */
function carryForwardArtifacts(root, runDir, source) {
    const carried = [];
    if (!source) { return carried; }
    const stillExistsAsDocument = relPath => fs.existsSync(path.join(root, relPath));
    const stillExistsAsDocset = name => directoryExists(path.join(root, name));
    carryForwardKind(source, runDir, PURPOSE_SUBDIR, 'purpose', root, slugToRelPath, stillExistsAsDocument, carried);
    carryForwardKind(source, runDir, BLOAT_SUBDIR, 'bloat', root, slugToRelPath, stillExistsAsDocument, carried);
    carryForwardKind(source, runDir, DOCSET_SUBDIR, 'bloat-docset', root, name => name, stillExistsAsDocset, carried);
    carryForwardTraceFiles(source, runDir, root, carried);
    return carried;
}

// ============================================================================
// QualityRunner
// ============================================================================

/*
 * One instance is shared across every browser connection — `quality-backend.js`
 * constructs it exactly once, at module load, and binds the SAME reference
 * into every connection's container (see that file's own header). That is
 * what makes "a run is per root and singleton" (CONTRACT §5) true without a
 * cross-connection lock of its own: there is only ever one `_byRoot` map in
 * the whole backend process.
 *
 * NO THEIA DEPENDENCIES IN THE CONSTRUCTOR, on purpose — this class is
 * constructed by `require('./quality-runner')` inside a `try/catch` in
 * `quality-backend.js` specifically so a broken import here degrades to
 * "analysis unavailable" instead of taking the rest of the backend down.
 * Reaching for `@theia/core` here would reintroduce exactly the coupling that
 * `try/catch` exists to route around.
 */
class QualityRunner {

    constructor() {
        /** normalized root path -> its current/most recent runId. */
        this._byRoot = new Map();
        /** runId -> the run's live bookkeeping (see `run()` for the shape). */
        this._byId = new Map();
    }

    /** CONTRACT §5: `{ available, python, specAnalysis, source, why }`. Cheap —
     *  filesystem checks only, no process spawned — so a caller can probe
     *  before offering "Check project" at all. */
    async probe(rootFsPath) {
        const resolved = resolveInterpreter(rootFsPath);
        return {
            available: resolved.available,
            python: resolved.python,
            specAnalysis: resolved.specAnalysis,
            source: resolved.source,
            why: resolved.why
        };
    }

    /*
     * CONTRACT §5: returns `{ runId }` as soon as the run is registered; the
     * detector work continues after this resolves. Registration itself is
     * synchronous filesystem work (`resolveInterpreter`), which is why this
     * can return almost immediately without needing to be fire-and-forget in
     * two separate steps.
     *
     * SINGLETON PER ROOT: a second call on a root with a run still `running`
     * returns THAT run's id rather than starting a second — two concurrent
     * bloat passes loading their own reranker is the hang CONTRACT §5 warns
     * about, worse on the very machines least able to absorb it.
     */
    async run(rootFsPath, options) {
        options = options || {};
        const root = path.resolve(rootFsPath);

        const existingId = this._byRoot.get(root);
        if (existingId) {
            const existing = this._byId.get(existingId);
            if (existing && existing.state === 'running') { return { runId: existingId }; }
        }

        const runId = this._newRunId();
        const interpreter = resolveInterpreter(root);
        const detectorSet = resolveDetectorSet(options.detectors);

        const run = {
            runId, root,
            scope: options.scope === 'docset' || options.scope === 'document' ? options.scope : 'project',
            requestedPaths: Array.isArray(options.paths) ? options.paths.slice() : [],
            semantic: options.semantic,
            force: !!options.force,
            detectorSet,
            interpreter,
            state: 'running',
            done: 0, total: 0, current: undefined,
            startedAt: new Date().toISOString(),
            error: undefined,
            failures: [], skipped: [],
            cancelled: false,
            controller: new AbortController()
        };
        this._byId.set(runId, run);
        this._byRoot.set(root, runId);

        if (!interpreter.available) {
            // "analysis is not available here, and why" (CONTRACT §0, Q2)
            // applies just as much to a run somebody actually started as it
            // does to `probe()` — the panel needs a `status()` to read, not a
            // rejected promise it has to translate into the same message.
            run.state = 'failed';
            run.error = interpreter.why;
            this._writeManifest(run, { finishedAt: new Date().toISOString() });
            return { runId };
        }

        // Fire-and-forget: `run()` itself already resolved above conceptually
        // (CONTRACT: "returns as soon as the run is registered"); this promise
        // is awaited by nothing on the caller's side, and its own rejections
        // are turned into `run.state = 'failed'` rather than an unhandled
        // rejection warning.
        this._execute(run).catch(error => {
            run.state = 'failed';
            run.error = (error && error.message) || String(error);
        });

        return { runId };
    }

    /** CONTRACT §5: `{ state, done, total, current, startedAt, error }`.
     *  `total`/`current` are populated even for a one-document run — the
     *  progress line the rail draws from this is what tells a person "still
     *  going" from "stalled", and a single document's own path IS `current`
     *  for the (short) time it is being worked on. */
    async status(runId) {
        const run = this._byId.get(runId);
        if (!run) {
            return { state: 'failed', done: 0, total: 0, current: undefined, startedAt: undefined, error: 'unknown run id: ' + runId };
        }
        return { state: run.state, done: run.done, total: run.total, current: run.current, startedAt: run.startedAt, error: run.error };
    }

    /*
     * `true` if a running run was told to stop, `false` if there was nothing
     * to cancel (unknown id, or already finished). ACTUALLY KILLS THE CHILD:
     * `run.controller.abort()` — the same `AbortSignal` every child of this
     * run was spawned with — turns into SIGTERM for whichever process is
     * alive right now, not merely a flag the run loop happens to notice
     * between documents. A long bloat pass mid-rerank is killed within the
     * process's own signal-handling latency, not at the end of its current
     * step.
     */
    async cancel(runId) {
        const run = this._byId.get(runId);
        if (!run || run.state !== 'running') { return false; }
        run.cancelled = true;
        try { run.controller.abort(); } catch (error) { /* already aborted */ }
        return true;
    }

    // -- internals ------------------------------------------------------------

    _newRunId() {
        const base = formatRunId(new Date());
        if (!this._byId.has(base)) { return base; }
        // Two runs on DIFFERENT roots in the same UTC second is the only way
        // to reach this — the singleton-per-root rule above already prevents
        // it for the same root. `status`/`cancel` are keyed by runId alone
        // (CONTRACT §5's own signatures take no root), so ids must be unique
        // across every root this process ever serves, not just within one.
        let suffix = 2;
        while (this._byId.has(base + '-' + suffix)) { suffix++; }
        return base + '-' + suffix;
    }

    async _execute(run) {
        const runDir = path.join(runsDir(run.root), run.runId);
        fs.mkdirSync(path.join(runDir, PURPOSE_SUBDIR), { recursive: true });
        fs.mkdirSync(path.join(runDir, BLOAT_SUBDIR), { recursive: true });
        fs.mkdirSync(path.join(runDir, DOCSET_SUBDIR), { recursive: true });

        /*
         * A manifest with no `finishedAt`, written BEFORE any detector spawns —
         * on purpose, so a hard crash mid-run (the whole app killed, not just
         * this run cancelled) leaves evidence behind. `quality-store.js`'s
         * `isHalfWrittenRun` reads exactly this signal ("parses but carries no
         * finishedAt") to keep a half-written run from ever being picked as
         * "the newest run" — its own header is explicit that a MISSING
         * manifest gets no such protection, on the reasoning that guessing
         * from a file that never got written at all is worse than not
         * guessing. Writing this stub is what turns that protection on for
         * the one case it exists for: this run finishes, this same file is
         * overwritten with `finishedAt` set, and this line's own manifest was
         * never anything but scaffolding; this run instead gets killed
         * outright, and the missing `finishedAt` is the only trace left that
         * something was in progress here.
         */
        this._writeManifest(run, {});

        // Computed up front, before the "nothing recognised" early return
        // below, because BOTH exits from this function need it: a run that
        // computes nothing of its own still has to leave a complete
        // directory behind (see `carryForwardArtifacts`'s own header).
        const previousManifest = findPreviousManifest(run.root, run.runId);
        const previousRunDir = previousManifest ? path.join(runsDir(run.root), previousManifest.runId) : undefined;
        const inheritFrom = resolveInheritanceSource(run.root, previousManifest, previousRunDir);

        const { run: activeDetectors } = run.detectorSet;
        if (run.detectorSet.requested !== undefined && activeDetectors.length === 0) {
            // "A `detectors` array naming nothing you recognise should run
            // nothing and say so" — said in the manifest, not by silently
            // running everything nor by throwing (a caller polling `status`
            // deserves a `done` run with an empty `documents[]`, the same
            // honest-empty-state discipline PLAN §3 asks for in the rail).
            // It must still be a full snapshot: this run produced nothing,
            // so EVERYTHING in the finished directory is carried forward.
            run.total = 0;
            const carriedForward = carryForwardArtifacts(run.root, runDir, inheritFrom);
            this._writeManifest(run, { finishedAt: new Date().toISOString(), documents: [], carriedForward });
            run.state = run.cancelled ? 'cancelled' : 'done';
            return;
        }
        const wantPurpose = activeDetectors.includes('purpose');
        const wantBloatDoc = activeDetectors.includes('bloat');
        const wantBloatDocset = activeDetectors.includes('bloat-docset');
        const needsBloatPass = wantBloatDoc || wantBloatDocset;

        const overrides = loadDocTypeOverrides(run.root);

        const { documents, docsets } = this._resolveScope(run);

        run.total = documents.length;
        run.done = 0;

        // -- hashing + short-circuit decision, for every document in scope --
        const docEntries = [];
        for (const relPath of documents) {
            if (run.cancelled) { break; }
            const abs = path.join(run.root, relPath);
            let stat;
            let sha;
            try {
                stat = fs.statSync(abs);
                sha = sha256File(abs);
            } catch (error) {
                run.failures.push({ path: relPath, detector: 'read', exit: null, stderr: String((error && error.message) || error) });
                run.done++;
                continue;
            }
            const previousEntry = !run.force ? findPreviousDocumentEntry(previousManifest, relPath) : undefined;
            const reused = !!(previousEntry && previousEntry.sha256 === sha && previousRunDir
                && neededArtifactsExist(previousRunDir, relPath, wantPurpose, wantBloatDoc));
            docEntries.push({ path: relPath, sha256: sha, bytes: stat.size, mtimeMs: stat.mtimeMs, reused });
            if (reused) {
                if (wantPurpose) { copyIfExists(path.join(previousRunDir, PURPOSE_SUBDIR, slugify(relPath) + '.json'), path.join(runDir, PURPOSE_SUBDIR, slugify(relPath) + '.json')); }
                if (wantBloatDoc) { copyIfExists(path.join(previousRunDir, BLOAT_SUBDIR, slugify(relPath) + '.json'), path.join(runDir, BLOAT_SUBDIR, slugify(relPath) + '.json')); }
                run.skipped.push({ path: relPath, why: 'unchanged since ' + previousManifest.runId });
                run.done++;
            }
        }
        const byPath = new Map(docEntries.map(entry => [entry.path, entry]));

        // -- purpose: parallel, capped -----------------------------------
        if (wantPurpose && !run.cancelled) {
            const toRun = docEntries.filter(entry => !entry.reused).map(entry => entry.path);
            await runWithConcurrency(toRun, PURPOSE_CONCURRENCY, async relPath => {
                if (run.cancelled) { return; }
                await this._runOnePurpose(run, runDir, relPath, overrides[relPath] && overrides[relPath].docType);
            });
        }

        // -- bloat: one process per docset, sequential --------------------
        if (needsBloatPass && !run.cancelled) {
            for (const docset of docsets) {
                if (run.cancelled) { break; }
                await this._runOneBloatPass(run, runDir, docset, byPath, {
                    wantBloatDoc, wantBloatDocset, previousRunDir
                });
            }
        }

        /*
         * Fill every slot this run left empty from whatever it inherits from
         * — unconditionally, even if `run.cancelled`: a cancelled run's
         * manifest still gets `finishedAt` set below (CONTRACT §4 does not
         * distinguish "done" from "cancelled" by withholding it), so
         * `quality-store.js` will treat this directory as a complete, pickable
         * run either way. A cancelled project-wide check that skipped this
         * step would leave the exact half-a-project directory this whole fix
         * exists to prevent, just reached by a different door.
         */
        const carriedForward = carryForwardArtifacts(run.root, runDir, inheritFrom);

        this._writeManifest(run, {
            finishedAt: new Date().toISOString(),
            documents: docEntries,
            carriedForward
        });
        run.state = run.cancelled ? 'cancelled' : 'done';
    }

    /*
     * Which documents and which docsets are "in scope", from `scope` +
     * `paths` (project-relative, per the coordinator's note — resolved
     * against root here, and a path that escapes root is refused and
     * recorded as a failure rather than silently dropped or silently
     * resolved to somewhere else).
     */
    _resolveScope(run) {
        const configuredDocsets = run.interpreter.docsets;

        if (run.scope === 'document') {
            const documents = [];
            for (const requested of run.requestedPaths) {
                const rel = toRelativeUnderRoot(run.root, requested);
                if (!rel) {
                    run.failures.push({ path: requested, detector: 'path', exit: null, stderr: 'path escapes the project root, refused' });
                    continue;
                }
                documents.push(rel);
            }
            // Bloat, if asked for at document scope, still needs the WHOLE
            // docset a requested document lives in (batching is the point —
            // see file header); a document outside any discovered docset is
            // treated as a docset of one, so it still gets a bloat report
            // without inventing cross-document siblings for it.
            const docsets = [];
            const seen = new Set();
            for (const relPath of documents) {
                const found = findDocsetContaining(run.root, configuredDocsets, relPath);
                const key = found ? found.name : ' singleton:' + relPath;
                if (seen.has(key)) { continue; }
                seen.add(key);
                docsets.push(found || { name: undefined, files: [relPath], singleton: true });
            }
            return { documents, docsets };
        }

        const allDocsets = discoverDocsets(run.root, configuredDocsets);
        let docsets = allDocsets;
        if (run.scope === 'docset' && run.requestedPaths.length) {
            const wanted = new Set(run.requestedPaths);
            docsets = allDocsets.filter(d => wanted.has(d.name));
            for (const name of run.requestedPaths) {
                if (!allDocsets.some(d => d.name === name)) {
                    run.failures.push({ path: name, detector: 'discovery', exit: null, stderr: 'not a docset under this root (no such directory, or fewer than two Markdown files in it)' });
                }
            }
        }

        const documents = new Set();
        for (const docset of docsets) { for (const file of docset.files) { documents.add(file); } }
        if (run.scope === 'project') {
            // Purpose is per-document and cheap; it runs over every Markdown
            // file in the project, including ones outside any docset (a lone
            // top-level README has no siblings to be cross-checked against,
            // but its own purpose gate is still worth knowing). Bloat stays
            // scoped to `docsets` above — a file with no docset has nothing
            // to batch it with.
            for (const file of listMarkdownFilesRecursive(run.root, run.root, [])) { documents.add(file); }
        }
        return { documents: [...documents], docsets };
    }

    async _runOnePurpose(run, runDir, relPath, docTypeOverride) {
        run.current = relPath;
        const abs = path.join(run.root, relPath);
        const args = [run.interpreter.purposeScript, abs];

        if (docTypeOverride !== undefined) {
            const normalized = String(docTypeOverride).toLowerCase();
            if (!KNOWN_DOC_TYPES.has(normalized)) {
                run.failures.push({ path: relPath, detector: 'purpose', exit: null, stderr: 'unknown doc-type override: ' + docTypeOverride });
                run.done++;
                return;
            }
            args.push('--doc-type', normalized);
        }
        if (typeof run.interpreter.gateThreshold === 'number') {
            args.push('--gate-threshold', String(run.interpreter.gateThreshold));
        }

        const result = await runChild(run.interpreter.python, args, run.controller.signal);
        if (run.cancelled) { return; } // an abort-induced failure is not this document's fault — see file header on runChild

        if (result.code !== 0) {
            run.failures.push({ path: relPath, detector: 'purpose', exit: result.code, stderr: (result.stderr || '').slice(0, 4000) });
            run.done++;
            return;
        }
        let parsed;
        try { parsed = JSON.parse(result.stdout); } catch (error) {
            run.failures.push({ path: relPath, detector: 'purpose', exit: result.code, stderr: 'could not parse JSON on stdout' });
            run.done++;
            return;
        }
        const rewritten = rewritePurposeReport(parsed, run.root);
        if (!rewritten.ok) {
            run.failures.push({ path: relPath, detector: 'purpose', exit: result.code, stderr: rewritten.why });
            run.done++;
            return;
        }
        writeJsonFile(path.join(runDir, PURPOSE_SUBDIR, slugify(relPath) + '.json'), rewritten.report);
        run.done++;
    }

    async _runOneBloatPass(run, runDir, docset, byPath, opts) {
        const { wantBloatDoc, wantBloatDocset, previousRunDir } = opts;
        const label = docset.name || docset.files[0];
        run.current = label + ' (duplication)';

        // Short-circuit the WHOLE invocation when every file in this docset
        // was already marked `reused` above (which already accounts for
        // whether THIS run even wants a per-document bloat file) AND, when
        // the docset-level file is also wanted, it exists in the previous
        // run to copy forward. Skipping here is what saves the ~500 MB model
        // load on the common "nothing changed" check.
        const allReused = docset.files.every(file => { const entry = byPath.get(file); return entry && entry.reused; });
        // Per-document reuse (`byPath`) already accounts for `wantBloatDoc` —
        // see `neededArtifactsExist`. It says nothing about the DOCSET-level
        // file, so that half is checked here, symmetrically: skipping the
        // invocation is only safe when either nobody asked for
        // `bloat-docset/<name>.json` at all, or the previous run actually has
        // one to copy forward. Without this a run that asks for
        // `bloat-docset` right after one that only asked for `bloat` would
        // "reuse" a docset file that was never produced, and silently ship
        // no cross-document report at all.
        const docsetArtifactAvailable = docset.singleton || !wantBloatDocset
            || (previousRunDir && fs.existsSync(path.join(previousRunDir, DOCSET_SUBDIR, docset.name + '.json')));
        if (allReused && docsetArtifactAvailable && !run.force && previousRunDir) {
            if (!docset.singleton && wantBloatDocset) {
                copyIfExists(path.join(previousRunDir, DOCSET_SUBDIR, docset.name + '.json'), path.join(runDir, DOCSET_SUBDIR, docset.name + '.json'));
            }
            return;
        }

        const args = [run.interpreter.bloatScript, ...docset.files.map(f => path.join(run.root, f)), '--json'];
        const semantic = run.semantic !== undefined ? run.semantic : run.interpreter.semantic;
        if (semantic === false) { args.push('--no-sentence-semantic'); }
        args.push('-q');

        const result = await runChild(run.interpreter.python, args, run.controller.signal);
        if (run.cancelled) { return; }

        if (result.code !== 0) {
            run.failures.push({ path: label, detector: 'bloat', exit: result.code, stderr: (result.stderr || '').slice(0, 4000) });
            return;
        }
        let parsed;
        try { parsed = JSON.parse(result.stdout); } catch (error) {
            run.failures.push({ path: label, detector: 'bloat', exit: result.code, stderr: 'could not parse JSON on stdout' });
            return;
        }
        const rewritten = rewriteBloatReport(parsed, run.root);
        if (!rewritten.ok) {
            run.failures.push({ path: label, detector: 'bloat', exit: result.code, stderr: rewritten.why });
            return;
        }
        if (!docset.singleton && wantBloatDocset) {
            writeJsonFile(path.join(runDir, DOCSET_SUBDIR, docset.name + '.json'), rewritten.report);
        }
        if (wantBloatDoc) {
            for (const file of docset.files) {
                writeJsonFile(path.join(runDir, BLOAT_SUBDIR, slugify(file) + '.json'), deriveDocumentBloat(rewritten.report, file));
            }
        }
    }

    _writeManifest(run, extra) {
        const runDir = path.join(runsDir(run.root), run.runId);
        const manifest = Object.assign({
            runId: run.runId,
            startedAt: run.startedAt,
            root: 'file://' + run.root,
            scope: { kind: run.scope, paths: run.requestedPaths },
            detectors: { requested: run.detectorSet.requested, run: run.detectorSet.run },
            analyzers: this._analyzerList(run),
            documents: [],
            skipped: run.skipped,
            failures: run.failures,
            /* Empty by default (the interpreter-unavailable early-fail path
             * in `run()` never gets far enough to inherit anything); `_execute`
             * always passes the real list explicitly via `extra`. */
            carriedForward: [],
            interpreter: { python: run.interpreter.python, specAnalysis: run.interpreter.specAnalysis, source: run.interpreter.source }
        }, extra);
        writeJsonFile(path.join(runDir, 'manifest.json'), manifest);
    }

    /* Stated rather than invented, same discipline as quality-scan.js's own
     * BLOAT_DETECTOR/PURPOSE_CLASSIFIER constants — this module does not
     * import that file (a `lib/node/` file requiring a `lib/browser/` one
     * would cross the one-way dependency line CONTRACT-quality.md §8 draws),
     * so the two small tables are kept in sync by hand rather than shared. */
    _analyzerList(run) {
        const { run: active } = run.detectorSet;
        const list = [];
        if (active.includes('purpose')) {
            list.push({ id: 'purpose-classifier', version: '0.3.0', model: null, calibration: 'none', gateThreshold: run.interpreter.gateThreshold });
        }
        if (active.includes('bloat') || active.includes('bloat-docset')) {
            list.push({ id: 'bloat-detector', version: '0.4.1', model: 'bge-m3 reranker', calibration: 'none' });
        }
        return list;
    }
}

module.exports = {
    QualityRunner,
    // Pure helpers, exported for tests/quality-runner-test.mjs and for any
    // future caller that needs the same primitive without a live process.
    resolveInterpreter,
    discoverDocsets,
    findDocsetContaining,
    listMarkdownFilesRecursive,
    slugify,
    formatRunId,
    toRelativeUnderRoot,
    rewritePurposeReport,
    rewriteBloatReport,
    deriveDocumentBloat,
    resolveDetectorSet,
    sha256File,
    slugToRelPath,
    resolveInheritanceSource,
    carryForwardArtifacts,
    KNOWN_DETECTORS,
    KNOWN_DOC_TYPES
};
