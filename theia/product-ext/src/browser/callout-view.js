/*
 * Callouts. `:::note … :::` and its accept forms (GitHub alerts, MkDocs
 * admonitions, MyST, raw directives — see md-parse.js) all land on the same
 * synthetic mdast node before md-schema.js ever sees them, so by the time a
 * document reaches this file every callout is one PM node: `callout`, attrs
 * `{ tone }`, `content: 'block+'`.
 *
 * NOT AN ATOM. A callout's body is a real editable region — lists, code,
 * nested callouts, whatever the reader would put in a paragraph — so this is
 * a node view with a `contentDOM`, the same shape Toggle already uses one
 * scroll up in markdown-editor.js. Only the head (icon + tone label) is
 * `contenteditable="false"` chrome; the body is ProseMirror's to own.
 */

const { Node, mergeAttributes } = require('@tiptap/core');
const { ICONS } = require('./icons');

const CALLOUT_TONES = ['note', 'tip', 'important', 'warning', 'caution'];

const TONE_ICON = {
    note: 'calloutNote', tip: 'calloutTip', important: 'calloutImportant',
    warning: 'calloutWarning', caution: 'calloutCaution'
};

const TONE_LABEL = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

function safeTone(tone) { return CALLOUT_TONES.includes(tone) ? tone : 'note'; }

function nextTone(tone) {
    const i = CALLOUT_TONES.indexOf(safeTone(tone));
    return CALLOUT_TONES[(i + 1) % CALLOUT_TONES.length];
}

/*
 * TONE CHANGE: CLICK THE ICON, CYCLING THROUGH THE FIVE.
 *
 * blocks.js already gives every tone its own BLOCKS entry (`callout-note` …
 * `callout-caution`, each `convert: true`) — the selection toolbar's block
 * selector can already turn a callout from one tone into another, and that
 * path needed nothing from this file; it lit up the moment the node existed.
 * So the question here was only whether that path is ENOUGH on its own, and
 * it is not the least-surprising one: it asks the author to select inside
 * the callout, open a menu spanning thirty other block types, and find the
 * one row that happens to share this callout's shape. The icon is already
 * sitting where their eye is, already labelled with the current tone, and a
 * reader who has ever used a segmented control expects a click on it to
 * change the setting it displays — closer to how the mode pill and the
 * suggest switch already behave in this product than to a block-type change.
 * Both paths stay open; this is the fast one, not the only one.
 */
function calloutNodeView({ node, editor, getPos }) {
    const dom = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'studio-callout-head';
    head.contentEditable = 'false';

    const iconBtn = document.createElement('button');
    iconBtn.type = 'button';
    iconBtn.className = 'studio-callout-icon';

    const label = document.createElement('span');
    label.className = 'studio-callout-label';

    head.append(iconBtn, label);

    const body = document.createElement('div');
    body.className = 'studio-callout-body';

    dom.append(head, body);

    function paint(tone) {
        const t = safeTone(tone);
        dom.className = 'studio-callout studio-callout-' + t;
        iconBtn.innerHTML = ICONS[TONE_ICON[t]];
        iconBtn.title = 'Tone: ' + TONE_LABEL[t] + ' — click to change';
        label.textContent = TONE_LABEL[t];
    }

    paint(node.attrs.tone);

    iconBtn.addEventListener('click', event => {
        event.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) { return; }
        const current = editor.state.doc.nodeAt(pos);
        const tone = nextTone(current && current.attrs.tone);
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { tone }));
    });

    return {
        dom,
        contentDOM: body,
        update(updated) {
            if (updated.type.name !== 'callout') { return false; }
            paint(updated.attrs.tone);
            return true;
        },
        // The head is chrome, not content: without this, the icon button and
        // the tone label register as document mutations the instant they
        // change, the same guard figure-view.js and mermaid-view.js need for
        // their own chrome around a contentDOM.
        ignoreMutation(mutation) {
            return !body.contains(mutation.target) || mutation.type === 'selection';
        }
    };
}

const Callout = Node.create({
    name: 'callout',
    group: 'block',
    content: 'block+',
    defining: true,
    /*
     * NOT `isolating`, and that is a correction.
     *
     * isolating makes a node a hard boundary that nothing may be lifted out
     * of — prosemirror-transform's liftTarget returns null for any range
     * inside one. That left a callout with no exit: the "Text" row in both
     * menus could not unwrap it, Backspace at the start of its first
     * paragraph did nothing, and a tone once chosen was permanent. Making one
     * was a one-way door.
     *
     * blockquote — the same shape, block+ content, also a container that holds
     * prose — is `defining` and not isolating, and behaves correctly for
     * exactly that reason. `defining` is the half that matters here: it keeps
     * the callout intact when content is replaced inside it, which is what
     * stops a paste from dissolving the wrapper.
     */
    addAttributes() {
        return {
            tone: {
                default: 'note',
                parseHTML: el => safeTone(el.getAttribute('data-callout')),
                renderHTML: attrs => ({ 'data-callout': safeTone(attrs.tone) })
            }
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-callout]', contentElement: '.studio-callout-body' }];
    },
    // Reached by copy/paste and by anything that serialises through
    // node.type.spec.toDOM rather than the live node view (Tiptap always
    // builds this from the static spec, never from addNodeView's DOM) — so
    // it has to stand on its own rather than only look right underneath the
    // interactive head above.
    renderHTML({ HTMLAttributes }) {
        const tone = safeTone(HTMLAttributes['data-callout']);
        return ['div', mergeAttributes(HTMLAttributes, { class: 'studio-callout studio-callout-' + tone }),
            ['div', { class: 'studio-callout-head', contenteditable: 'false' },
                ['span', { class: 'studio-callout-label' }, TONE_LABEL[tone]]],
            ['div', { class: 'studio-callout-body' }, 0]];
    },
    addNodeView() { return calloutNodeView; }
});

const CALLOUT_CSS = `
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout {
  border: 1px solid var(--studio-line); border-radius: var(--studio-radius);
  padding: 12px 14px; margin: 0 0 12px; background: var(--studio-surface-raised);
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-icon {
  display: inline-flex; flex: none; width: 17px; height: 17px; padding: 0;
  border: none; background: none; color: inherit; cursor: pointer; border-radius: 3px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-icon:hover { opacity: .75; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-icon:focus-visible {
  outline: 2px solid currentColor; outline-offset: 2px;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-icon svg { width: 17px; height: 17px; }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-label {
  font-size: 12px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase;
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-body > :last-child { margin-bottom: 0; }
/* Tinted surface + a 1px hairline + the tone colour on the icon and label —
   never a coloured left border above 1px. A thick border reads as a chat
   quote (blockquote already owns that silhouette two rules up in this file)
   and it breaks the 8px radius the document uses everywhere else. */
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-note {
  background: var(--studio-accent-soft);
  border-color: color-mix(in srgb, var(--studio-accent) 30%, var(--studio-line));
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-note .studio-callout-icon,
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-note .studio-callout-label { color: var(--studio-accent); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-tip {
  background: color-mix(in srgb, var(--studio-verified) 9%, var(--studio-bg));
  border-color: color-mix(in srgb, var(--studio-verified) 30%, var(--studio-line));
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-tip .studio-callout-icon,
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-tip .studio-callout-label { color: var(--studio-verified); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-important {
  background: color-mix(in srgb, var(--studio-accent) 14%, var(--studio-bg));
  border-color: color-mix(in srgb, var(--studio-accent) 42%, var(--studio-line));
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-important .studio-callout-icon,
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-important .studio-callout-label { color: var(--studio-accent); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-warning {
  background: color-mix(in srgb, var(--studio-warning) 10%, var(--studio-bg));
  border-color: color-mix(in srgb, var(--studio-warning) 32%, var(--studio-line));
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-warning .studio-callout-icon,
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-warning .studio-callout-label { color: var(--studio-warning); }
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-caution {
  background: color-mix(in srgb, var(--studio-danger) 9%, var(--studio-bg));
  border-color: color-mix(in srgb, var(--studio-danger) 32%, var(--studio-line));
}
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-caution .studio-callout-icon,
.studio-doc :is(.ProseMirror, .studio-tracked-page) .studio-callout-caution .studio-callout-label { color: var(--studio-danger); }
`;

module.exports = { Callout, CALLOUT_TONES, CALLOUT_CSS };
