/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 *
 * NB it lives HERE and not at the repository root. `build:browser` runs
 * `npm --prefix browser-app run bundle`, so `theia build` executes with this
 * directory as its working directory and reads this file; the root-level
 * esbuild.mjs/gen-esbuild.*.mjs are leftovers from the flat fabric-poc layout
 * and are not consulted. `.gitignore` ignores `*-app/*`, so this file is
 * exempted there explicitly — without that it would vanish from a fresh
 * checkout and the image would silently build without the two corrections
 * below.
 */
import { browserOptions, watch, minify, sourcemap } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';

import esbuild from 'esbuild';

/*
 * Mermaid as its own script.
 *
 * Measured 2026-08-14: mermaid, @mermaid-js/parser, cytoscape, katex and
 * layout-base accounted for 2.9 MB — 16% — of the initial bundle, even though
 * mermaid-view.js only ever reaches them through `import('mermaid')`. esbuild
 * splits a dynamic import only when the output is ESM and `splitting` is on;
 * this build is an IIFE, so the import was inlined. Making the whole
 * application ESM to fix that would also make the Monaco and plugin-host
 * workers ESM, which they are not, so mermaid gets its own entry point
 * instead and mermaid-view.js loads it with a script tag on first use.
 *
 * The entry point sits one level up because it is shared with the electron
 * build and is tracked normally there; `*-app/*` would otherwise hide it.
 */
const mermaidOptions = {
    entryPoints: { mermaid: '../mermaid-entry.mjs' },
    bundle: true,
    format: 'iife',
    globalName: 'studioMermaid',
    outdir: 'lib/frontend',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    loader: browserOptions.loader,
    minify,
    sourcemap
};

/*
 * Two corrections to the generated browser options.
 *
 * `.wasm` as a data URL: vscode-oniguruma's 616 KB grammar engine was being
 * base64-encoded into bundle.js and inflated by a third on the way in, then
 * parsed as part of the main script on every cold load. Theia's own code
 * already expects a URL there — createOnigasmLib does `fetch(onigasmPath)`
 * and its comment says "Webpack's wasm loader should give us a URL" — so the
 * `file` loader is what that call was written for. The browser fetches it in
 * parallel and caches it.
 *
 * `secondary-window`: an 11.59 MB second copy of the application, built for
 * Theia's "move this view to a separate window" feature. The product shell
 * suppresses the chrome that offers it, so nothing opens it, and it is 13.9 MB
 * of every image. Dropping the entry point is reversible in one line if the
 * feature is ever surfaced.
 */
const { 'secondary-window': _droppedSecondaryWindow, ...keptEntryPoints } = browserOptions.entryPoints;
const correctedBrowserOptions = {
    ...browserOptions,
    entryPoints: keptEntryPoints,
    loader: { ...browserOptions.loader, '.wasm': 'file' }
};

const browserContext = await esbuild.context(correctedBrowserOptions);
const nodeContext = await esbuild.context(nodeOptions);
const mermaidContext = await esbuild.context(mermaidOptions);

if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
        mermaidContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
        await mermaidContext.rebuild();
        await mermaidContext.dispose();
    } catch {
        process.exit(1);
    }
}
