/*
 * Mermaid, built as its own script instead of as 2.9 MB of the main bundle.
 *
 * `mermaid-view.js` always loaded it behind `import('mermaid')`, which reads as
 * lazy and is not: esbuild only splits a dynamic import when the output format
 * is ESM and `splitting` is on, and the browser build is an IIFE — so the whole
 * library, plus cytoscape, katex and layout-base, was inlined into the first
 * parse for a diagram type most documents do not contain.
 *
 * Making the whole application ESM to get splitting would also make the Monaco
 * and plugin-host workers ESM, which they are not. A separate entry point costs
 * one script tag and changes nothing else.
 */
export { default } from 'mermaid';
