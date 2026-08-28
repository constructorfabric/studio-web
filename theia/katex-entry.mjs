/*
 * KaTeX, built as its own script rather than as part of the main bundle.
 *
 * Same reasoning as mermaid-entry.mjs beside it, and the same measurement
 * behind it: esbuild splits a dynamic import only when the output is ESM with
 * splitting on, and this application builds as an IIFE because its Monaco and
 * plugin-host workers are not modules. So `import('katex')` in a node view
 * would read as lazy and would not be — it would put the renderer, and the
 * stylesheet's twenty embedded font faces, into the first parse of every
 * session for a construct most documents do not contain.
 *
 * The CSS is imported here rather than linked from index.html on purpose: it
 * is only meaningful once the renderer has produced markup for it to style, so
 * it belongs to this entry's lifetime. esbuild emits it as katex.css beside
 * katex.js with the fonts inlined by the .woff2 dataurl loader, and
 * katex-runtime.js adds both tags on first use.
 *
 * The entry point sits one level up because it is shared with the electron
 * build and is tracked normally there; `*-app/*` would otherwise hide it.
 */
import 'katex/dist/katex.min.css';
export { default } from 'katex';
