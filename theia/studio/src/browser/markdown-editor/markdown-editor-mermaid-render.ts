// Drawing a mermaid block, shared by the WYSIWYG editor's code block and the
// rendered comparison (../markdown-diff), so both queue on one renderer —
// mermaid keeps global state between `initialize` and `render`, and two
// concurrent renders with different themes interleave.
//
// Mermaid is the page's one copy: the `mermaid.js` script both applications
// build beside bundle.js (browser-app/esbuild.mjs, electron-app/esbuild.mjs,
// from mermaid-entry.mjs), exposed as the global `studioMermaid` — the same
// script and global product-ext's mermaid-view.js loads. This used to be
// `import('mermaid')`, which esbuild inlines into the IIFE bundle: a second
// mermaid, 2.9 MB of the first parse, and in the Documents mode — where
// product-ext had already loaded the first — a render that never settled.

import {
    createMermaidConfig,
    sanitizeMermaidSvg,
    validateMermaidSource,
    type MermaidPreviewTheme
} from './markdown-editor-mermaid';

interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, text: string): Promise<{ svg: string }>;
}

const MERMAID_SCRIPT = 'mermaid.js';
const MERMAID_GLOBAL = 'studioMermaid';

/** How long the script may take before the diagram says so instead of waiting forever. */
const LOAD_TIMEOUT_MS = 30_000;

export async function renderMermaidDiagram(options: {
    readonly code: string;
    readonly theme: MermaidPreviewTheme;
    readonly renderId: string;
}): Promise<string> {
    validateMermaidSource(options.code);
    const task = mermaidRenderQueue.then(async () => {
        const mermaid = await loadMermaid();
        mermaid.initialize(createMermaidConfig(options.theme));
        const result = await mermaid.render(options.renderId, options.code);
        return sanitizeMermaidSvg(result.svg);
    });
    mermaidRenderQueue = task.then(() => undefined, () => undefined);
    return task;
}

let mermaidModulePromise: Promise<MermaidApi> | undefined;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

function loadedMermaid(): MermaidApi | undefined {
    const loaded = (globalThis as Record<string, unknown>)[MERMAID_GLOBAL] as { default?: MermaidApi } & MermaidApi | undefined;
    return loaded ? loaded.default ?? loaded : undefined;
}

function loadMermaid(): Promise<MermaidApi> {
    if (!mermaidModulePromise) {
        mermaidModulePromise = new Promise<MermaidApi>((resolve, reject) => {
            const existing = loadedMermaid();
            if (existing) {
                resolve(existing);
                return;
            }
            const src = new URL(MERMAID_SCRIPT, document.baseURI).toString();
            // product-ext may have added the tag already and be waiting on it.
            let script = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]')).find(candidate => candidate.src === src);
            if (!script) {
                script = document.createElement('script');
                script.src = src;
                script.async = true;
                document.head.appendChild(script);
            }
            const timer = setTimeout(() => reject(new Error(`${MERMAID_SCRIPT} did not load`)), LOAD_TIMEOUT_MS);
            script.addEventListener('load', () => {
                clearTimeout(timer);
                const loaded = loadedMermaid();
                if (loaded) {
                    resolve(loaded);
                } else {
                    reject(new Error(`${MERMAID_SCRIPT} loaded but exposed no ${MERMAID_GLOBAL}`));
                }
            }, { once: true });
            script.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error(`Could not load ${MERMAID_SCRIPT}`));
            }, { once: true });
        }).catch(error => {
            // A transient failure retries on the next diagram, as product-ext's does.
            mermaidModulePromise = undefined;
            throw error;
        });
    }
    return mermaidModulePromise;
}
