/*
 * Mermaid diagrams as first-class document content — requirement 20.
 *
 * A Mermaid diagram in Markdown is already just a fenced code block, so this
 * is a node view over the existing codeBlock node rather than a new node
 * type. That is the whole reason the round trip is safe: nothing about the
 * document model changes, the source stays the source, and a document
 * containing diagrams opens identically in the Raw and Split editors.
 *
 * Mermaid itself is loaded through a dynamic import so it lands in its own
 * webpack chunk. It is a large library and most documents have no diagram in
 * them; making every editor open pay for it would be the wrong trade.
 */

const { CodeBlock } = require('@tiptap/extension-code-block');
const { showLoading } = require('./loader');

const MERMAID_LANGUAGES = ['mermaid'];

// Re-render this long after the last keystroke. Mermaid throws on
// half-typed syntax, so rendering on every character would mean the preview
// spends most of its time showing a parse error for a diagram that is fine.
const RENDER_DEBOUNCE_MS = 450;

let mermaidPromise;
let mermaidTheme;

/*
 * Mermaid is fetched on first use, not parsed at startup.
 *
 * This used to be `import('mermaid')`, which reads as lazy and was not: esbuild
 * inlines a dynamic import unless the output is ESM with splitting on, and this
 * application builds as an IIFE because its Monaco and plugin-host workers are
 * not modules. Measured 2026-08-14, that inlining put mermaid, its parser,
 * cytoscape, katex and layout-base — 2.9 MB, 16% of the bundle — into the first
 * parse of every session, for a diagram type most documents never contain.
 *
 * So mermaid is built as its own script (see esbuild.mjs) and loaded here by
 * tag. A document with no diagram in it never fetches it at all. The failure
 * mode is deliberately the same as before: the promise is cleared on error, so
 * a diagram typed after a transient network failure retries rather than being
 * stuck with a rejected promise for the life of the page.
 */
const MERMAID_SCRIPT = 'mermaid.js';
const MERMAID_GLOBAL = 'studioMermaid';

function loadMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = new Promise((resolve, reject) => {
            const existing = globalThis[MERMAID_GLOBAL];
            if (existing) { return resolve(existing.default || existing); }
            const script = document.createElement('script');
            // Relative to the application root, the same way bundle.js is
            // loaded, so this follows the app wherever it is mounted.
            script.src = new URL(MERMAID_SCRIPT, document.baseURI).toString();
            script.async = true;
            script.onload = () => {
                const loaded = globalThis[MERMAID_GLOBAL];
                if (!loaded) {
                    reject(new Error('mermaid.js loaded but exposed no global'));
                    return;
                }
                resolve(loaded.default || loaded);
            };
            script.onerror = () => reject(new Error('could not load mermaid.js'));
            document.head.appendChild(script);
        }).catch(error => { mermaidPromise = undefined; throw error; });
    }
    return mermaidPromise;
}

function currentTheme() {
    return document.body.getAttribute('data-studio-theme') === 'dark' ? 'dark' : 'default';
}

async function renderDiagram(id, source) {
    const mermaid = await loadMermaid();
    const theme = currentTheme();
    // initialize() is cheap and idempotent, but re-running it is what makes a
    // light/dark switch actually repaint existing diagrams.
    if (mermaidTheme !== theme) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'Inter, system-ui, sans-serif' });
        mermaidTheme = theme;
    }
    const { svg } = await mermaid.render(id, source);
    return svg;
}

let diagramSeq = 0;

function button(label, title) {
    const b = document.createElement('button');
    b.className = 'studio-diagram-btn';
    b.type = 'button';
    b.textContent = label;
    b.title = title || label;
    return b;
}

/*
 * The node view.
 *
 * ProseMirror owns the text: `contentDOM` is the <code> element, so typing,
 * undo, selection and the Markdown serialiser all keep working exactly as
 * they do for any other code block. The preview is a sibling ProseMirror is
 * told to ignore — which is what `ignoreMutation` below is for. Without it,
 * every SVG the renderer injects would look like a user edit.
 */
function mermaidNodeView({ node, editor, getPos }) {
    const dom = document.createElement('div');
    dom.className = 'studio-codeblock';

    const head = document.createElement('div');
    head.className = 'studio-diagram-head';
    const name = document.createElement('span');
    name.className = 'studio-diagram-name';
    const tools = document.createElement('div');
    tools.className = 'studio-diagram-tools';
    const sourceBtn = button('Source', 'Edit the diagram source');
    const diagramBtn = button('Diagram', 'Show the rendered diagram');
    const copyBtn = button('Copy SVG', 'Copy the rendered diagram as SVG');
    tools.append(diagramBtn, sourceBtn, copyBtn);
    head.append(name, tools);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.appendChild(code);

    const preview = document.createElement('div');
    preview.className = 'studio-diagram-preview';

    dom.append(head, pre, preview);

    const id = 'studio-mermaid-' + (++diagramSeq);
    let showing = 'diagram';
    let timer;
    let lastRendered;
    let lastSvg = '';
    let destroyed = false;

    const isMermaid = current => MERMAID_LANGUAGES.includes((current.attrs && current.attrs.language) || '');

    async function render(current) {
        const source = current.textContent.trim();
        if (!source) {
            preview.innerHTML = '<div class="studio-diagram-empty">Empty diagram — switch to <b>Source</b> and describe one.</div>';
            lastRendered = source;
            return;
        }
        if (source === lastRendered) { return; }
        lastRendered = source;
        /*
         * ONLY when there is nothing rendered yet, and that condition is the
         * whole design of this one.
         *
         * The first diagram in a session is the slowest thing in the editor: it
         * fetches the 3.4 MB mermaid script (see loadMermaid above) before it
         * can draw anything, behind a blank rectangle that is indistinguishable
         * from a diagram that failed silently. That is the wait worth showing.
         *
         * Every LATER render is a re-render of a diagram that is already on
         * screen, 450ms after the user stopped typing. Replacing a correct
         * diagram with a spinner because the source changed would be a flicker
         * on a surface the user is watching, and it would throw away the one
         * useful thing there — the previous version — to say "working" about a
         * job that usually finishes in a few milliseconds. So the old diagram
         * stays up and the new one swaps in under it.
         */
        const done = lastSvg
            ? () => undefined
            : showLoading(preview, 'Rendering diagram…', { replace: true, className: 'studio-diagram-loading' });
        try {
            const svg = await renderDiagram(id + '-' + Date.now().toString(36), source);
            if (destroyed) { return; }
            lastSvg = svg;
            preview.innerHTML = svg;
            preview.classList.remove('failed');
        } catch (error) {
            if (destroyed) { return; }
            lastSvg = '';
            // Requirement 20's fallback: never swallow the diagram. The source
            // stays one click away and the reason is stated, rather than
            // leaving a blank rectangle where a diagram used to be.
            preview.classList.add('failed');
            preview.textContent = '';
            const box = document.createElement('div');
            box.className = 'studio-diagram-error';
            box.innerHTML = '<b>This diagram could not be rendered.</b> The source is unchanged and still saved.';
            const detail = document.createElement('pre');
            detail.textContent = String((error && error.message) || error).split('\n').slice(0, 4).join('\n');
            box.appendChild(detail);
            preview.appendChild(box);
        } finally {
            // Reached on the destroyed-mid-render returns too, which is the
            // point: a node view torn down while mermaid was still fetching
            // must not leave a timer holding a reference to its preview.
            done();
        }
    }

    function applyMode(current) {
        const mermaid = isMermaid(current);
        dom.classList.toggle('is-diagram', mermaid);
        head.hidden = !mermaid;
        if (!mermaid) {
            pre.hidden = false;
            preview.hidden = true;
            return;
        }
        name.textContent = 'Mermaid diagram';
        const asDiagram = showing === 'diagram';
        pre.hidden = asDiagram;
        preview.hidden = !asDiagram;
        diagramBtn.classList.toggle('on', asDiagram);
        sourceBtn.classList.toggle('on', !asDiagram);
        copyBtn.hidden = !asDiagram;
        if (asDiagram) { render(current); }
    }

    function scheduleRender(current) {
        clearTimeout(timer);
        timer = setTimeout(() => { if (showing === 'diagram') { render(current); } }, RENDER_DEBOUNCE_MS);
    }

    diagramBtn.addEventListener('click', event => {
        event.preventDefault();
        showing = 'diagram';
        lastRendered = undefined;
        applyMode(editor.state.doc.nodeAt(typeof getPos === 'function' ? getPos() : 0) || node);
    });
    sourceBtn.addEventListener('click', event => {
        event.preventDefault();
        showing = 'source';
        applyMode(node);
        // Put the caret in the source the user just asked to edit.
        if (typeof getPos === 'function') {
            editor.chain().focus().setTextSelection(getPos() + 1).run();
        }
    });
    copyBtn.addEventListener('click', async event => {
        event.preventDefault();
        if (!lastSvg) { return; }
        try {
            await navigator.clipboard.writeText(lastSvg);
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy SVG'; }, 1400);
        } catch (e) {
            console.error('[studio] could not copy the diagram', e);
        }
    });

    // The product's theme toggle is not a ProseMirror event, so diagrams
    // subscribe to it directly to re-render in the other palette.
    const onThemeChange = () => {
        if (showing !== 'diagram') { return; }
        lastRendered = undefined;
        render(editor.state.doc.nodeAt(typeof getPos === 'function' ? getPos() : 0) || node);
    };
    document.addEventListener('studio-theme-changed', onThemeChange);

    applyMode(node);

    return {
        dom,
        contentDOM: code,
        update(updated) {
            if (updated.type.name !== node.type.name) { return false; }
            const wasMermaid = isMermaid(node);
            node = updated;
            if (isMermaid(updated) !== wasMermaid) { applyMode(updated); return true; }
            if (isMermaid(updated)) {
                head.hidden = false;
                scheduleRender(updated);
            }
            return true;
        },
        // Everything the renderer writes lives outside contentDOM; without
        // this, each injected SVG would be read back as a document edit and
        // fight the editor's own state.
        ignoreMutation(mutation) {
            return !code.contains(mutation.target) || mutation.type === 'selection';
        },
        destroy() {
            destroyed = true;
            clearTimeout(timer);
            document.removeEventListener('studio-theme-changed', onThemeChange);
        }
    };
}

const DiagramCodeBlock = CodeBlock.extend({
    addNodeView() { return mermaidNodeView; }
});

const DIAGRAM_CSS = `
.studio-codeblock { margin: 0 0 14px; }
.studio-codeblock.is-diagram {
  border: 1px solid var(--studio-line); border-radius: 10px; overflow: hidden; background: var(--studio-surface);
}
.studio-codeblock.is-diagram pre { margin: 0; border-radius: 0; background: var(--studio-surface-raised); }
.studio-diagram-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--studio-line); background: var(--studio-surface);
}
.studio-diagram-name { flex: 1; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--studio-muted); }
.studio-diagram-tools { display: flex; gap: 2px; }
.studio-diagram-btn {
  font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--studio-muted);
}
.studio-diagram-btn:hover { background: var(--studio-surface-raised); color: var(--studio-text); }
.studio-diagram-btn.on { background: var(--studio-surface-raised); color: var(--studio-text); font-weight: 600; }
.studio-diagram-preview { padding: 16px; display: flex; justify-content: center; overflow-x: auto; }
.studio-diagram-preview svg { max-width: 100%; height: auto; }
.studio-diagram-preview.failed { justify-content: flex-start; }
.studio-diagram-empty { font-size: 12.5px; color: var(--studio-muted); }
/* No padding of its own: .studio-diagram-preview already pads by 16px, and
   .studio-loading's own 24px on top would make the first diagram of a session
   taller than the diagram that replaces it, so the block would jump. */
.studio-diagram-loading { padding: 0; }
.studio-diagram-error {
  font-size: 12.5px; line-height: 1.55; color: var(--studio-text);
  background: color-mix(in srgb, var(--studio-danger) 12%, transparent);
  border: 1px solid var(--studio-danger); border-radius: 8px; padding: 10px 12px; width: 100%;
}
.studio-diagram-error pre {
  margin: 8px 0 0; padding: 8px; font-size: 11.5px; background: var(--studio-surface-sunken);
  border-radius: 6px; white-space: pre-wrap; color: var(--studio-muted);
}
`;

/*
 * `mermaidNodeView` and `renderDiagram` are exported for figure-view.js, which
 * needs both and neither of which this module has any reason to know about:
 *
 *  - the NODE VIEW, because ProseMirror allows exactly one per node type and
 *    both figures and diagrams are code blocks. figure-view.js owns the
 *    dispatch and calls this one when the language is Mermaid, so the
 *    dependency points one way and this file stays unaware of figures.
 *  - the RENDERER, because a figure runs in a sandboxed frame with no network
 *    and therefore cannot load Mermaid itself. It posts its source out, this
 *    renders it, and the SVG goes back in — which means a document with both a
 *    diagram and a figure that wants one loads the 3 MB library once.
 */
module.exports = {
    DiagramCodeBlock, DIAGRAM_CSS, MERMAID_LANGUAGES,
    mermaidNodeView, renderMermaid: renderDiagram
};
