/*
 * The X-01 fallback, on screen. `rawBlock` (attrs `source`, `kind`) and
 * `rawInline` (attrs `source`) are md-schema.js's catch-all — literally any
 * mdast node this module cannot otherwise place keeps its exact original
 * text and comes back out byte-identical. Until these two nodes existed
 * Tiptap dropped that content on the floor the instant it reached the live
 * schema (an unmodelled node type is silently discarded, not preserved),
 * which is the read-only gate this whole pass retires: a document containing
 * a Pandoc grid table or a `<script>` block can now actually open.
 *
 * BOTH NODE VIEWS ARE READ-ONLY DISPLAY, ON PURPOSE. `source` is never
 * touched in place — there is no contentDOM, no contenteditable region, only
 * a `<pre>`/`<span>` painted from the attribute every time it changes. The
 * one affordance either view offers is a jump to Raw mode, where the text
 * *is* the document and editing it is unambiguous; a node view that let
 * someone type into the middle of a preserved grid table would be editing
 * text this module has no way to re-parse, and the byte-identical promise
 * would quietly stop being true.
 */

const { Node, mergeAttributes } = require('@tiptap/core');

/**
 * Switches to Raw and puts the caret on this node's own text, so "Edit in
 * Raw" lands the author where they meant rather than at the top of the file.
 * Best-effort: `indexOf` can miss on a source string that recurs verbatim
 * elsewhere in the document, and that is an acceptable miss — the mode
 * switch itself, the one affordance the brief actually asks for, still
 * happens either way.
 */
function revealInRaw(widget, source) {
    if (!widget || typeof widget.setMode !== 'function') { return; }
    widget.setMode('raw');
    if (!source) { return; }
    // setMode() focuses the source textarea on its own setTimeout(0); this
    // runs after that one so the selection it sets is not immediately lost.
    setTimeout(() => {
        const el = widget.sourceEl;
        if (!el || typeof el.value !== 'string') { return; }
        const at = el.value.indexOf(source);
        if (at === -1) { return; }
        el.focus();
        el.setSelectionRange(at, at + source.length);
        const before = el.value.slice(0, at);
        const line = before.split('\n').length;
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
        el.scrollTop = Math.max(0, (line - 3) * lineHeight);
    }, 30);
}

// --- block --------------------------------------------------------------------

function rawBlockNodeView({ node }, options) {
    const widget = options && options.widget;
    const dom = document.createElement('div');
    dom.className = 'studio-preserved';
    dom.setAttribute('contenteditable', 'false');

    const bar = document.createElement('div');
    bar.className = 'studio-preserved-bar';
    const label = document.createElement('span');
    const grow = document.createElement('span');
    grow.className = 'studio-preserved-grow';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Edit in Raw';
    button.title = 'Open the Markdown source to edit this directly';
    bar.append(label, grow, button);

    const pre = document.createElement('pre');
    pre.className = 'studio-preserved-source';

    dom.append(bar, pre);

    function paint(current) {
        label.textContent = 'Preserved source · ' + (current.attrs.kind || 'markdown');
        pre.textContent = current.attrs.source || '';
    }

    button.addEventListener('click', event => {
        event.preventDefault();
        revealInRaw(widget, node.attrs.source);
    });

    paint(node);

    return {
        dom,
        update(updated) {
            if (updated.type.name !== 'rawBlock') { return false; }
            node = updated;
            paint(updated);
            return true;
        },
        ignoreMutation() { return true; }
    };
}

const RawBlock = Node.create({
    name: 'rawBlock',
    group: 'block',
    atom: true,
    selectable: true,
    addOptions() { return { widget: null }; },
    addAttributes() {
        return {
            source: {
                default: '',
                parseHTML: el => el.getAttribute('data-source') || '',
                renderHTML: attrs => ({ 'data-source': attrs.source || '' })
            },
            kind: {
                default: 'markdown',
                parseHTML: el => el.getAttribute('data-kind') || 'markdown',
                renderHTML: attrs => ({ 'data-kind': attrs.kind || 'markdown' })
            }
        };
    },
    parseHTML() { return [{ tag: 'div[data-studio-raw-block]' }]; },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { class: 'studio-preserved', 'data-studio-raw-block': '' }),
            ['pre', {}, String(HTMLAttributes['data-source'] || '')]];
    },
    addNodeView() {
        const options = this.options;
        return props => rawBlockNodeView(props, options);
    }
});

// --- inline -------------------------------------------------------------------

function rawInlineNodeView({ node }, options) {
    const widget = options && options.widget;
    const dom = document.createElement('span');
    dom.className = 'studio-preserved-inline';
    dom.title = 'Preserved markdown — click to edit in Raw';

    function paint(current) { dom.textContent = current.attrs.source || ''; }
    paint(node);

    dom.addEventListener('click', event => {
        event.preventDefault();
        revealInRaw(widget, node.attrs.source);
    });

    return {
        dom,
        update(updated) {
            if (updated.type.name !== 'rawInline') { return false; }
            node = updated;
            paint(updated);
            return true;
        },
        ignoreMutation() { return true; }
    };
}

const RawInline = Node.create({
    name: 'rawInline',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addOptions() { return { widget: null }; },
    addAttributes() {
        return {
            source: {
                default: '',
                parseHTML: el => el.getAttribute('data-source') || '',
                renderHTML: attrs => ({ 'data-source': attrs.source || '' })
            }
        };
    },
    parseHTML() { return [{ tag: 'span[data-studio-raw-inline]' }]; },
    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { class: 'studio-preserved-inline', 'data-studio-raw-inline': '' }),
            String(HTMLAttributes['data-source'] || '')];
    },
    addNodeView() {
        const options = this.options;
        return props => rawInlineNodeView(props, options);
    }
});

const RAW_CSS = `
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved {
  border: 1px solid var(--studio-edge); border-radius: var(--studio-radius);
  background: var(--studio-surface-sunken); margin: 0 0 12px; overflow: hidden;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-bar {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-bottom: 1px solid var(--studio-line);
  font-family: var(--studio-mono); font-size: 10.5px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--studio-muted);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-grow { flex: 1; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-bar button {
  font: inherit; text-transform: none; letter-spacing: 0; font-size: 11px;
  border: 1px solid var(--studio-line); background: var(--studio-surface);
  color: var(--studio-text); border-radius: 5px; padding: 2px 7px; cursor: pointer;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-bar button:hover {
  border-color: var(--studio-accent); color: var(--studio-accent);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-source {
  margin: 0; padding: 10px 12px; overflow-x: auto;
  font-family: var(--studio-mono); font-size: 12.5px; line-height: 1.6; color: var(--studio-text);
}
.studio-doc .ProseMirror .studio-preserved.ProseMirror-selectednode {
  outline: 2px solid var(--studio-accent); outline-offset: 1px;
}
/* A dashed underline rather than a box: a sentence carrying one preserved
   token — a wikilink, most often — still has to read as a sentence, not as a
   run of code dropped into it. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-inline {
  font-family: var(--studio-mono); font-size: .88em; cursor: pointer;
  background: var(--studio-surface-sunken);
  border-bottom: 1px dashed var(--studio-edge); border-radius: 3px; padding: 0 3px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-preserved-inline:hover {
  border-bottom-color: var(--studio-accent); color: var(--studio-accent);
}
.studio-doc .ProseMirror .studio-preserved-inline.ProseMirror-selectednode {
  outline: 2px solid var(--studio-accent); outline-offset: 1px;
}
`;

module.exports = { RawBlock, RawInline, RAW_CSS, revealInRaw };
