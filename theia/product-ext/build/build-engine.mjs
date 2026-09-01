/*
 * Bundles the ESM-only remark/unified stack (see markdown-engine.mjs) into
 * one CommonJS file that `src/browser/*.js` can `require()` directly, the
 * same way mermaid-entry.mjs exists to give the browser build a script-tag
 * entry point instead of an inlined dependency (see that file's header).
 *
 * This one is not split out for SIZE — the remark stack is small next to
 * mermaid's 2.9 MB — it exists because `require()` cannot load an ESM
 * package at all, in the IIFE browser build or under plain Node. Bundling to
 * CJS ahead of time, once, and checking in the result is what lets a
 * hand-written CommonJS file `require('./vendor/markdown-engine')` like any
 * other module in this package.
 *
 * format: 'cjs' — the consumer is `require()`, not `import`.
 * platform: 'neutral', mainFields: ['module', 'main'] — plain 'neutral' with
 *   no mainFields refuses to resolve two of remark-directive's transitive
 *   deps (`fault`, `format`), which ship only a legacy `main` field and no
 *   `exports` map; 'neutral' will not guess one, on the reasoning that
 *   guessing is how a platform assumption sneaks in. Naming the two fields
 *   explicitly fixes that resolution without adopting 'browser', which was
 *   tried first and actually broke the Node target: it makes esbuild prefer
 *   packages' `browser` condition/field, and something on this dependency
 *   tree has an unguarded top-level `document` reference behind that
 *   condition — the bundle threw `ReferenceError: document is not defined`
 *   the instant `require()`d under plain Node. `platform: 'neutral'` is the
 *   one setting that cannot pull that condition in, which is the whole
 *   reason the brief allows it as an alternative to 'browser'.
 * minify: true — this is a checked-in build artefact, not source; there is
 *   nothing to read here, only to run.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// esbuild's ESM entry has no `require`; build one for the version lookup below.
const require = createRequire(import.meta.url);

const ENGINE_PACKAGES = [
    'unified', 'remark-parse', 'remark-stringify', 'remark-gfm',
    'remark-math', 'remark-directive', 'remark-frontmatter',
    'unist-util-visit', 'mdast-util-to-string',
    'mdast-util-highlight-mark', 'micromark-extension-highlight-mark'
];

function versionOf(name) {
    // Read the installed version rather than the semver range in
    // package.json, so the banner records what was actually bundled. Resolve
    // the package's main file rather than its package.json directly — most
    // of these packages declare an `exports` map that (correctly) does not
    // expose package.json as a public subpath.
    const main = require.resolve(name, { paths: [here] });
    let dir = dirname(main);
    while (true) {
        const candidate = join(dir, 'package.json');
        try {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (pkg.name === name) { return pkg.version; }
        } catch (e) { /* keep walking up */ }
        const parent = dirname(dir);
        if (parent === dir) { throw new Error('could not find package.json for ' + name); }
        dir = parent;
    }
}

const versions = ENGINE_PACKAGES.map(name => name + '@' + versionOf(name)).join(', ');
const banner = '/*\n' +
    ' * Vendored markdown engine — built by build/build-engine.mjs from\n' +
    ' * build/markdown-engine.mjs. Do not edit by hand; re-run\n' +
    ' * `npm run build:engine` in theia/product-ext after changing that file.\n' +
    ' *\n' +
    ' * Bundled packages: ' + versions + '\n' +
    ' * Bundled: ' + new Date().toISOString() + '\n' +
    ' */\n';

const outfile = join(here, '..', 'lib', 'browser', 'vendor', 'markdown-engine.js');

const result = await build({
    entryPoints: [join(here, 'markdown-engine.mjs')],
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    outfile,
    banner: { js: banner },
    metafile: true
});

// The banner above the minified body is appended by esbuild verbatim; done.
const bytes = readFileSync(outfile).length;
console.log('[build:engine] wrote ' + outfile);
console.log('[build:engine] ' + bytes + ' bytes (' + (bytes / 1024).toFixed(1) + ' KiB)');
console.log('[build:engine] packages: ' + versions);

if (process.env.STUDIO_ENGINE_METAFILE) {
    writeFileSync(join(here, 'markdown-engine.meta.json'), JSON.stringify(result.metafile, null, 2));
}
