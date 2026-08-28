/*
 * ESM entry for the vendored markdown engine.
 *
 * unified, remark-parse, remark-stringify and the remark-* dialect plugins are
 * ESM-only (see their package.json `"type": "module"`), and `lib/browser/*.js`
 * is hand-written CommonJS with no build step of its own — the whole extension
 * loads as `require()`d files in an IIFE browser bundle (browser-app/esbuild.mjs)
 * and again under plain Node for the corpus test. Neither can `import()` these
 * packages at the point they need them (module init, synchronously), so this
 * file is the one place ESM is allowed to exist: build-engine.mjs bundles it
 * to a single CJS file that lib/browser/vendor/markdown-engine.js requires
 * like anything else in this package.
 *
 * Only the building blocks are re-exported, not an assembled processor —
 * md-parse.js and md-serialize.js each configure their own `unified()` chain,
 * because the parse-side tolerance options and the stringify-side pinned
 * options are decisions that belong in those files, not buried in a vendor
 * shim.
 */
export { unified } from 'unified';
export { default as remarkParse } from 'remark-parse';
export { default as remarkStringify } from 'remark-stringify';
export { default as remarkGfm } from 'remark-gfm';
export { default as remarkMath } from 'remark-math';
export { default as remarkDirective } from 'remark-directive';
export { default as remarkFrontmatter } from 'remark-frontmatter';
export { visit } from 'unist-util-visit';
export { toString as mdastToString } from 'mdast-util-to-string';

// The four symmetric-delimiter inline marks with no unified()-plugin form —
// see inline-marks.mjs for why each of the four is built the way it is.
export { subscript, superscript, insert, highlight } from './inline-marks.mjs';
