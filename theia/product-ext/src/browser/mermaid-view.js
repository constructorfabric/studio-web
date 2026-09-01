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
const { TextSelection } = require('@tiptap/pm/state');
const { showLoading } = require('./loader');
const { LANGUAGE_MENU, grammarFor, detectLanguage } = require('./code-highlight');

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
/*
 * ONE datalist for every code block in the session.
 *
 * A <datalist> per node view would put thirty-nine <option>s into the document
 * for each fence, and they are identical. The element is referenced by id, so
 * one shared list is what the platform expects here.
 */
const LANGUAGE_LIST_ID = 'studio-code-languages';

function ensureLanguageList() {
    if (document.getElementById(LANGUAGE_LIST_ID)) { return; }
    const list = document.createElement('datalist');
    list.id = LANGUAGE_LIST_ID;
    for (const name of LANGUAGE_MENU) {
        const option = document.createElement('option');
        option.value = name;
        list.appendChild(option);
    }
    document.body.appendChild(list);
}

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

    /*
     * THE LANGUAGE FIELD, and why a code block needs one at all.
     *
     * Syntax highlighting is driven entirely by the fence's info string, and
     * before this there was no way to set it: `/code` and the block selector
     * both produce a fence with no language, the head was hidden for anything
     * that was not Mermaid, and Raw mode was the only place a language could be
     * typed. So a code block created in the editor could never be highlighted,
     * which made the highlighting look broken rather than unconfigured.
     *
     * Free text over a <select>: the grammar set is 106 names deep and a
     * document may legitimately name one that is not in the picker at all
     * (`text`, a language we do not ship, a made-up tag someone's toolchain
     * reads). The datalist suggests; it does not restrict.
     */
    ensureLanguageList();
    const lang = document.createElement('input');
    lang.className = 'studio-code-lang';
    lang.setAttribute('list', LANGUAGE_LIST_ID);
    lang.setAttribute('spellcheck', 'false');
    lang.setAttribute('autocomplete', 'off');
    lang.placeholder = 'plain text';
    lang.title = 'Language for syntax highlighting';

    const copyCode = button('Copy', 'Copy this code');
    const codeTools = document.createElement('div');
    codeTools.className = 'studio-diagram-tools';
    codeTools.append(copyCode);

    head.append(name, lang, tools, codeTools);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    /*
     * No spelling underlines inside code. The editable region is one
     * contenteditable for the whole document, so the browser's spellchecker
     * treats a fence like prose and dots every identifier in it -- `numpy` came
     * back from the report underlined in red, which reads as an error in the
     * code rather than as a dictionary miss. setAttribute rather than the
     * property: jsdom implements only the attribute, and the tests read it.
     */
    code.setAttribute('spellcheck', 'false');
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

    /*
     * WHAT THE FIELD SAYS WHEN NOBODY NAMED A LANGUAGE.
     *
     * The block is highlighted from a guess when the fence carries no info
     * string (see detectLanguage in code-highlight.js), and a colour appearing
     * with nothing anywhere saying why is worse than no colour: the reader
     * cannot tell a detected language from a stored one, and cannot tell a
     * WRONG guess from a bug. So the guess is the field's placeholder --
     * present, in the field that would hold the real answer, and in the
     * placeholder's own muted italic so it never reads as a value that was
     * saved. Clicking the field and pressing Enter is what turns it into one.
     */
    function showDetected(current, language) {
        const detected = language ? '' : detectLanguage(current.textContent);
        lang.placeholder = detected || 'plain text';
        lang.classList.toggle('is-detected', !!detected);
        lang.title = detected
            ? 'Highlighted as ' + detected + ' (detected) — type a language to set it'
            : 'Language for syntax highlighting';
    }

    /*
     * PUTTING THE CARET BACK IN THE CODE.
     *
     * Two shipped defects were this one function's absence. The Enter handler
     * used to run `editor.chain().focus().setTextSelection(getPos() + 1)`:
     *
     *  - `getPos() + 1` is the START of the block, not where the caret was, so
     *    naming the language of a block you had already written moved your
     *    cursor to the top of it and the next line you typed landed above the
     *    first one. That is the reported "I can't add more lines, it just jumps
     *    somewhere" -- and the same jump is what put the caret at position 0 of
     *    the block, where Backspace joins the block into the paragraph above,
     *    which is the reported "it jumps to previous block".
     *  - `chain().focus()` defers the DOM focus to a requestAnimationFrame, so
     *    for one frame after Enter the language <input> still had it. Measured
     *    in a real browser: typing `py`, Enter, `import numpy` produced a fence
     *    whose LANGUAGE was `pyimport numpy` and whose body was empty.
     *
     * `view.focus()` is synchronous, and the position defaults to the end of
     * the block's text -- which is where a person who just named the language
     * of a block they are about to write expects to be.
     */
    function caretInside() {
        if (typeof getPos !== 'function') { return undefined; }
        const pos = getPos();
        const current = pos === undefined || pos === null ? undefined : editor.state.doc.nodeAt(pos);
        if (!current) { return undefined; }
        const from = editor.state.selection.from;
        return from > pos && from < pos + current.nodeSize ? from : undefined;
    }

    function returnCaret(remembered) {
        if (typeof getPos !== 'function') { return; }
        const pos = getPos();
        if (pos === undefined || pos === null) { return; }
        const current = editor.state.doc.nodeAt(pos);
        if (!current || current.type.name !== node.type.name) { return; }
        const end = pos + 1 + current.content.size;
        const at = Math.min(Math.max(remembered === undefined ? end : remembered, pos + 1), end);
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
        editor.view.focus();
    }

    function applyMode(current) {
        const mermaid = isMermaid(current);
        const language = (current.attrs && current.attrs.language) || '';
        dom.classList.toggle('is-diagram', mermaid);
        dom.classList.toggle('is-code', !mermaid);
        /*
         * The head is no longer Mermaid-only — a plain fence shows its
         * language and a copy button instead. `is-quiet` is how it stays out
         * of the way: an unset language renders the head at low opacity until
         * the block is hovered or the field is focused, so a document full of
         * fences does not become a document full of chrome, while a fence that
         * HAS a language always shows it (that is information about the
         * content, not a control).
         */
        head.hidden = false;
        name.hidden = !mermaid;
        tools.hidden = !mermaid;
        lang.hidden = mermaid;
        codeTools.hidden = mermaid;
        if (!mermaid) {
            if (document.activeElement !== lang) { lang.value = language; }
            dom.classList.toggle('is-quiet', !language);
            showDetected(current, language);
            pre.hidden = false;
            preview.hidden = true;
            return;
        }
        dom.classList.remove('is-quiet');
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
        if (typeof getPos === 'function') { returnCaret(getPos() + 1); }
    });
    /*
     * Writing the language back into the document.
     *
     * setNodeMarkup on this node's own position, dispatched straight through
     * the view rather than as a chained command, because a chain focuses the
     * editor and focusing it would take the caret out of the field the user is
     * still typing in.
     *
     * `commit` runs on `change` (blur, Enter, or a datalist pick) and not on
     * every `input` event: an intermediate value like "pyth" is not a language
     * anybody meant, and a transaction per keystroke would put thirty
     * indistinguishable steps in the undo history for one word.
     */
    function commitLanguage() {
        if (typeof getPos !== 'function') { return; }
        const pos = getPos();
        if (pos === undefined || pos === null) { return; }
        const current = editor.state.doc.nodeAt(pos);
        if (!current || current.type.name !== node.type.name) { return; }
        const next = lang.value.trim().toLowerCase();
        if (((current.attrs && current.attrs.language) || '') === next) { return; }
        const tr = editor.state.tr.setNodeMarkup(pos, undefined,
            Object.assign({}, current.attrs, { language: next || null }));
        editor.view.dispatch(tr);
    }

    /*
     * Where the caret was when the field took focus, so Enter and Escape can
     * both give it back. Undefined means it was not in this block at all --
     * clicking the field of a fence you were not editing -- and then the end of
     * the block is the right destination rather than a position from some other
     * part of the document.
     */
    let caretWas;
    lang.addEventListener('focus', () => { caretWas = caretInside(); });
    lang.addEventListener('change', commitLanguage);
    lang.addEventListener('blur', commitLanguage);
    lang.addEventListener('keydown', event => {
        // Enter commits and returns the caret to the code; Escape abandons the
        // edit. Both are stopped here so ProseMirror never sees them — Enter in
        // particular would otherwise split the block.
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commitLanguage();
            returnCaret(caretWas);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            lang.value = (node.attrs && node.attrs.language) || '';
            returnCaret(caretWas);
        }
    });

    copyCode.addEventListener('click', async event => {
        event.preventDefault();
        const source = (typeof getPos === 'function' && editor.state.doc.nodeAt(getPos()) || node).textContent;
        try {
            await navigator.clipboard.writeText(source);
            copyCode.textContent = 'Copied';
            setTimeout(() => { copyCode.textContent = 'Copy'; }, 1400);
        } catch (e) {
            console.error('[studio] could not copy the code', e);
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
            const hadLanguage = (node.attrs && node.attrs.language) || '';
            node = updated;
            if (isMermaid(updated) !== wasMermaid) { applyMode(updated); return true; }
            // The language can change from outside this view — Raw mode, undo,
            // a paste — and the field has to follow it. applyMode already
            // leaves a focused field alone, so this cannot fight typing.
            if (((updated.attrs && updated.attrs.language) || '') !== hadLanguage) { applyMode(updated); return true; }
            if (isMermaid(updated)) {
                head.hidden = false;
                scheduleRender(updated);
                return true;
            }
            /*
             * A plain fence's placeholder is a function of its TEXT, so it has
             * to follow every edit and not only a language change -- typing the
             * first line of a python block is exactly when the guess appears.
             */
            showDetected(updated, hadLanguage);
            return true;
        },
        // Everything the renderer writes lives outside contentDOM; without
        // this, each injected SVG would be read back as a document edit and
        // fight the editor's own state.
        ignoreMutation(mutation) {
            return !code.contains(mutation.target) || mutation.type === 'selection';
        },
        /*
         * The language field is a real <input> inside the node view, so
         * ProseMirror must keep its hands off every event that happens in it —
         * otherwise arrow keys move the document selection instead of the text
         * cursor, and a click is read as a click on the node.
         */
        stopEvent(event) {
            const target = event.target;
            return !!target && (target === lang || (lang.contains && lang.contains(target)));
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
/* --- a plain fence ------------------------------------------------------
   The block owns the border and the radius; the <pre> inside it drops both,
   so the head and the code read as one object rather than as a box inside a
   box. editor-css.js gives the bare <pre> its own border for the cases a node
   view never runs (the tracked review page), and this overrides it here. */
.studio-codeblock.is-code {
  border: 1px solid var(--studio-line); border-radius: 8px; overflow: hidden;
  background: var(--studio-surface-sunken);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-codeblock.is-code > pre {
  border: none; border-radius: 0; background: transparent;
}
.studio-codeblock.is-code .studio-diagram-head {
  justify-content: flex-end; gap: 4px; padding: 4px 6px 4px 10px;
  background: transparent; border-bottom: 1px solid var(--studio-line);
  /* A row of controls must never be taller than the code it labels. */
  min-height: 30px;
}
/* An unset language is a control, so it recedes until wanted. A set language
   is information about the content, so it always shows. */
.studio-codeblock.is-code.is-quiet .studio-diagram-head { opacity: .45; }
.studio-codeblock.is-code.is-quiet:hover .studio-diagram-head,
.studio-codeblock.is-code.is-quiet:focus-within .studio-diagram-head { opacity: 1; }
.studio-code-lang {
  font: inherit; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  width: 108px; padding: 2px 7px; border-radius: 5px; text-align: right;
  border: 1px solid transparent; background: transparent; color: var(--studio-muted);
}
.studio-code-lang::placeholder { color: var(--studio-muted); opacity: .7; }
/* A DETECTED language shows in the placeholder, so it has to be legible as a
   guess and not as a value: italic, and never the field's own text colour.
   (No backticks in this file: the CSS is a template literal.) */
.studio-code-lang.is-detected::placeholder { font-style: italic; opacity: .9; }
.studio-code-lang:hover { border-color: var(--studio-line); background: var(--studio-surface); }
.studio-code-lang:focus {
  outline: none; text-align: left; border-color: var(--studio-accent);
  background: var(--studio-surface); color: var(--studio-text);
}
.studio-diagram-tools { display: flex; gap: 2px; }
/* A display:flex declaration beats the hidden attribute, and the shell's own
   global hidden rule lives in a different stylesheet -- a node view that
   toggles .hidden must not depend on stylesheet load order to actually hide
   anything. applyMode hides exactly these three when the block is not a
   diagram. (No backticks in this file: the CSS is a template literal.) */
.studio-diagram-tools[hidden], .studio-diagram-preview[hidden], .studio-code-lang[hidden] { display: none !important; }
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
