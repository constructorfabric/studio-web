/*
 * Editing or Suggesting — whose call it is, and where the answer lives.
 *
 * This is a PER-PERSON, PER-MACHINE choice, and it deliberately does not live
 * in `.studio/settings.json` with the project's policies.
 *
 * The reason is the same one that keeps the display name out of that file: it
 * is committed. A project-wide "everyone suggests" is a coherent policy and may
 * well be wanted one day, but it is a different setting from this one. This one
 * answers "how should MY next keystroke land", which is a decision I make about
 * my own work several times an hour — reviewing someone's draft, then going back
 * to writing my own — and writing it to a committed file would push my mode onto
 * everyone who clones the repository.
 *
 * So it is localStorage, next to the identity name, and it is scoped by
 * identity: two people sharing a machine profile do not inherit each other's
 * mode. Nothing here is a security boundary — a person in Editing mode can still
 * edit, and that is the intended behaviour, not a hole. Suggesting mode is a
 * courtesy toward the document's other readers, exactly as it is in Google Docs.
 *
 * WHY NOT PER DOCUMENT: because the mode is about the person, not the file. A
 * per-document flag would mean opening a colleague's draft in Editing mode
 * because that is how the file was left, which is the failure this exists to
 * prevent.
 */

const { identity } = require('./identity');

const KEY_PREFIX = 'studio.suggest.mode.';
const EDIT = 'edit';
const SUGGEST = 'suggest';

function storeKey() {
    /* Keyed by identity, not global: the mode is a property of the person, and
     * the id is already stable per person on this machine. */
    return KEY_PREFIX + identity.current().key;
}

function read() {
    try {
        return globalThis.localStorage ? globalThis.localStorage.getItem(storeKey()) : undefined;
    } catch (e) {
        return undefined;
    }
}

const listeners = [];

const suggestMode = {

    /*
     * Editing is the default, and that is a deliberate choice rather than an
     * omission. A product whose default is Suggesting tells a single author
     * working alone that their own writing needs approving, which is absurd; a
     * product whose default is Editing tells a reviewer to say so before they
     * start marking up someone else's draft, which is one click and is what
     * Docs does.
     */
    current() {
        return read() === SUGGEST ? SUGGEST : EDIT;
    },

    suggesting() {
        return this.current() === SUGGEST;
    },

    set(mode) {
        const next = mode === SUGGEST ? SUGGEST : EDIT;
        try {
            if (globalThis.localStorage) { globalThis.localStorage.setItem(storeKey(), next); }
        } catch (e) {
            console.warn('[studio] could not persist the suggesting mode', e);
        }
        this.fireChanged();
        return next;
    },

    toggle() {
        return this.set(this.suggesting() ? EDIT : SUGGEST);
    },

    onChanged(fn) { listeners.push(fn); },

    fireChanged() {
        listeners.forEach(fn => { try { fn(this.current()); } catch (e) { console.error(e); } });
    },

    EDIT, SUGGEST
};

/*
 * The control, as a two-option pill.
 *
 * Same reasoning as the Project page's review-style choice: neither mode is the
 * absence of the other, so both are named and the pressed one is the state.
 * "Suggesting off" describes nothing.
 *
 * It lives in the document topbar rather than in a menu because it changes what
 * the next keystroke DOES, and a mode with that much consequence has to be
 * visible without being opened — the same argument that put the save status
 * there. It is also why the pill turns solid in Suggesting: the quiet state is
 * the one where nothing unusual is happening.
 */
function suggestSwitchHtml() {
    const on = suggestMode.suggesting();
    return '<div class="studio-suggest-switch' + (on ? ' on' : '') + '" role="group" ' +
        'aria-label="How your edits are recorded">' +
        '<button class="studio-suggest-btn" data-act="suggest-mode" data-mode="edit" ' +
        'aria-pressed="' + String(!on) + '" title="Your edits change the document">Editing</button>' +
        '<button class="studio-suggest-btn" data-act="suggest-mode" data-mode="suggest" ' +
        'aria-pressed="' + String(on) + '" title="Your edits are recorded as suggestions for review">Suggesting</button>' +
        '</div>';
}

const SUGGEST_MODE_CSS = `
/*
 * Sized to the topbar, not to its own importance.
 *
 * The first version was a 36px pill with a heavy accent border on top of a filled
 * segment, beside a status that says the same thing — three emphatic treatments of
 * one fact, which read as louder than the document. "This seems overloaded", and
 * it was. What carries the state is the FILLED SEGMENT and nothing else: no ring
 * on the container, no border colour change, and the same type size as the save
 * status it sits next to.
 */
.studio-suggest-switch {
  display: inline-flex; flex: none; padding: 1px; border-radius: 999px;
  border: 1px solid var(--studio-line); background: var(--studio-surface-raised);
}
.studio-suggest-btn {
  border: 0; border-radius: 999px; padding: 2px 8px; background: transparent;
  color: var(--studio-muted); cursor: pointer; font: 600 11px/1.45 inherit; white-space: nowrap;
}
.studio-suggest-btn:hover { color: var(--studio-text); }
.studio-suggest-btn[aria-pressed="true"] { background: var(--studio-accent); color: var(--studio-bg); }
.studio-suggest-btn:focus-visible { outline: 2px solid var(--studio-accent); outline-offset: 2px; }
`;

module.exports = { suggestMode, suggestSwitchHtml, SUGGEST_MODE_CSS };
