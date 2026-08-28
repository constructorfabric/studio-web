/*
 * Math, as two atoms — `mathBlock` (attrs: `latex`) sits on a raised surface
 * of its own; `mathInline` (attrs: `latex`) sits on the text baseline. Both
 * ATOMS, for the same reason footnoteRef is one in markdown-editor.js: the
 * LaTeX source is not prose a caret should be able to wander into a
 * character at a time, so editing it is a deliberate mode switch — click to
 * open a source field, blur or Escape to re-render — rather than in-place
 * contenteditable.
 *
 * Rendering goes through katex-runtime.js, which is the ONLY thing in this
 * file that touches KaTeX: it is fetched by script tag on first use (its own
 * esbuild entry — see that module's header) so a document with no equation
 * in it never pays for the 268 KB.
 *
 * THE FAILING CASE, not the happy one, is what this file is built around.
 * katex-runtime.js's renderMath() never throws — it returns `{ error }` for
 * bad LaTeX — and both node views below render that case as the raw source
 * in mono with the message underneath (block) or as a title tooltip (inline,
 * where there is no room for a second line without breaking the baseline).
 * Either way the equation stays selectable and one click from editable; a
 * document with a typo in it still opens instead of refusing to render.
 */

const { Node, mergeAttributes } = require('@tiptap/core');
const { renderMath } = require('./katex-runtime');

/** Keystrokes inside the source field are text editing, not document editing
 *  — ProseMirror must not intercept them as commands (Enter, Backspace at a
 *  boundary, Mod-B) while this atom's own input/textarea has focus. */
function guardKeydown(event, onEscape) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onEscape(); }
}

// --- block ------------------------------------------------------------------

function mathBlockNodeView({ node, editor, getPos }) {
    const dom = document.createElement('div');
    dom.className = 'studio-math-block';

    const stage = document.createElement('div');
    stage.className = 'studio-math-stage';
    stage.title = 'Click to edit the LaTeX source';

    const source = document.createElement('textarea');
    source.className = 'studio-math-source';
    source.spellcheck = false;
    source.hidden = true;

    dom.append(stage, source);

    let editing = false;
    let renderId = 0;

    function commit(latex) {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) { return; }
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { latex }));
    }

    async function paint(latex) {
        const id = ++renderId;
        dom.classList.remove('is-error');
        stage.textContent = '';
        if (!latex.trim()) {
            const empty = document.createElement('span');
            empty.className = 'studio-math-placeholder';
            empty.textContent = 'Empty equation — click to add LaTeX';
            stage.appendChild(empty);
            return;
        }
        const result = await renderMath(latex, { display: true });
        if (id !== renderId) { return; } // superseded by a later edit
        if (result.error) {
            dom.classList.add('is-error');
            const src = document.createElement('pre');
            src.className = 'studio-math-error-source';
            src.textContent = latex;
            const why = document.createElement('div');
            why.className = 'studio-math-error-why';
            why.textContent = result.error;
            stage.append(src, why);
            return;
        }
        stage.innerHTML = result.html;
    }

    function showStage() {
        editing = false;
        stage.hidden = false;
        source.hidden = true;
        paint(node.attrs.latex || '');
    }

    function showSource() {
        editing = true;
        source.value = node.attrs.latex || '';
        stage.hidden = true;
        source.hidden = false;
        source.focus();
        source.select();
    }

    stage.addEventListener('click', event => { event.preventDefault(); showSource(); });
    source.addEventListener('blur', () => { commit(source.value); showStage(); });
    source.addEventListener('keydown', event => guardKeydown(event, () => source.blur()));

    showStage();

    return {
        dom,
        update(updated) {
            if (updated.type.name !== 'mathBlock') { return false; }
            const changed = updated.attrs.latex !== node.attrs.latex;
            node = updated;
            if (changed && !editing) { paint(node.attrs.latex || ''); }
            return true;
        },
        // The rendered KaTeX markup and the error box both live outside
        // anything ProseMirror thinks is content — this node is an atom with
        // no contentDOM at all — so nothing here needs reporting back as an
        // edit; everything the source textarea does is handled explicitly by
        // its own listeners above instead.
        ignoreMutation() { return true; },
        stopEvent() { return editing; }
    };
}

const MathBlock = Node.create({
    name: 'mathBlock',
    group: 'block',
    atom: true,
    selectable: true,
    addAttributes() {
        return {
            latex: {
                default: '',
                parseHTML: el => el.getAttribute('data-latex') || '',
                renderHTML: attrs => ({ 'data-latex': attrs.latex || '' })
            }
        };
    },
    parseHTML() { return [{ tag: 'div[data-math-block]' }]; },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { class: 'studio-math-block', 'data-math-block': '' }),
            String(HTMLAttributes['data-latex'] || '')];
    },
    addNodeView() { return mathBlockNodeView; }
});

// --- inline -------------------------------------------------------------------

function mathInlineNodeView({ node, editor, getPos }) {
    const dom = document.createElement('span');
    dom.className = 'studio-math-inline';

    const rendered = document.createElement('span');
    rendered.className = 'studio-math-inline-render';

    const source = document.createElement('input');
    source.type = 'text';
    source.className = 'studio-math-inline-source';
    source.spellcheck = false;
    source.hidden = true;

    dom.append(rendered, source);

    let editing = false;
    let renderId = 0;

    function commit(latex) {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) { return; }
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { latex }));
    }

    async function paint(latex) {
        const id = ++renderId;
        rendered.classList.remove('is-error', 'is-empty');
        rendered.removeAttribute('title');
        if (!latex.trim()) {
            rendered.classList.add('is-empty');
            rendered.textContent = '∅';
            return;
        }
        const result = await renderMath(latex, { display: false });
        if (id !== renderId) { return; }
        if (result.error) {
            rendered.classList.add('is-error');
            rendered.textContent = latex;
            // No room beneath an inline run for the block treatment's second
            // line without breaking the baseline it is meant to sit on, so
            // the message goes in the tooltip instead — still reachable,
            // never dropped.
            rendered.title = result.error;
            return;
        }
        rendered.innerHTML = result.html;
    }

    function showRender() {
        editing = false;
        rendered.hidden = false;
        source.hidden = true;
        paint(node.attrs.latex || '');
    }

    function showSource() {
        editing = true;
        source.value = node.attrs.latex || '';
        rendered.hidden = true;
        source.hidden = false;
        source.focus();
        source.select();
    }

    rendered.addEventListener('click', event => { event.preventDefault(); showSource(); });
    source.addEventListener('blur', () => { commit(source.value); showRender(); });
    source.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(source.value); source.blur(); return; }
        guardKeydown(event, () => source.blur());
    });

    showRender();

    return {
        dom,
        update(updated) {
            if (updated.type.name !== 'mathInline') { return false; }
            const changed = updated.attrs.latex !== node.attrs.latex;
            node = updated;
            if (changed && !editing) { paint(node.attrs.latex || ''); }
            return true;
        },
        ignoreMutation() { return true; },
        stopEvent() { return editing; }
    };
}

const MathInline = Node.create({
    name: 'mathInline',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
        return {
            latex: {
                default: '',
                parseHTML: el => el.getAttribute('data-latex') || '',
                renderHTML: attrs => ({ 'data-latex': attrs.latex || '' })
            }
        };
    },
    parseHTML() { return [{ tag: 'span[data-math-inline]' }]; },
    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { class: 'studio-math-inline', 'data-math-inline': '' }),
            String(HTMLAttributes['data-latex'] || '')];
    },
    addNodeView() { return mathInlineNodeView; }
});

const MATH_CSS = `
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block {
  margin: 0 0 12px; padding: 14px 16px; text-align: center; cursor: text;
  border-radius: var(--studio-radius); background: var(--studio-surface-raised);
  font-family: 'Newsreader', Georgia, serif; font-size: 19px; font-style: italic;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block .studio-math-placeholder {
  font-family: var(--studio-mono); font-size: 12.5px; font-style: normal; color: var(--studio-muted);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block .katex-display { margin: 0; }
/* The failing case: left-aligned mono source plus the message beneath it,
   never the italic display face — a rendering error should not look like a
   rendered equation. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block.is-error {
  text-align: left; font-family: var(--studio-mono); font-size: 12.5px; font-style: normal;
  background: color-mix(in srgb, var(--studio-danger) 7%, var(--studio-bg));
  border: 1px solid color-mix(in srgb, var(--studio-danger) 30%, var(--studio-line));
  color: var(--studio-text);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block .studio-math-error-source {
  margin: 0; white-space: pre-wrap; word-break: break-word;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block .studio-math-error-why {
  display: block; margin-top: 6px; font-size: 11.5px; font-style: normal; color: var(--studio-danger);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-block .studio-math-source {
  width: 100%; min-height: 64px; resize: vertical; box-sizing: border-box;
  border: 1px solid var(--studio-accent); border-radius: 6px; padding: 8px 10px;
  background: var(--studio-bg); color: var(--studio-text);
  font-family: var(--studio-mono); font-size: 13px; font-style: normal; line-height: 1.5;
}
.studio-doc .ProseMirror .studio-math-block.ProseMirror-selectednode {
  outline: 2px solid var(--studio-accent); outline-offset: 2px;
}

.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-inline {
  display: inline-flex; align-items: baseline; vertical-align: baseline;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-inline-render {
  font-family: 'Newsreader', Georgia, serif; font-style: italic; cursor: text;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-inline-render.is-empty {
  font-family: var(--studio-mono); font-size: .85em; font-style: normal; color: var(--studio-muted);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-inline-render.is-error {
  font-family: var(--studio-mono); font-size: .85em; font-style: normal; color: var(--studio-danger);
  border-bottom: 1px dashed var(--studio-danger); cursor: help;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-math-inline-source {
  font: inherit; font-family: var(--studio-mono); font-size: .85em; font-style: normal;
  border: 1px solid var(--studio-accent); border-radius: 3px; padding: 0 3px; width: 9em;
  background: var(--studio-bg); color: var(--studio-text);
}
.studio-doc .ProseMirror .studio-math-inline.ProseMirror-selectednode .studio-math-inline-render {
  outline: 2px solid var(--studio-accent); outline-offset: 1px; border-radius: 2px;
}
`;

module.exports = { MathBlock, MathInline, MATH_CSS };
