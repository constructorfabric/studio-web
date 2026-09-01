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
 * The control, as a segmented control — the SAME one as Rich/Split/Raw.
 *
 * This used to be its own rounded pill (.studio-suggest-switch/-btn) with a
 * solid accent fill on the pressed segment, styled from scratch a few lines
 * from the .studio-seg control it sits right next to in the topbar and looks
 * nothing like. editor-css.js's own comment on .studio-seg warns about this
 * exact failure by name — "two near-identical rule sets is how the old
 * per-surface pills drifted apart" — so re-skinning the pill to merely
 * resemble .studio-seg would have been repeating the mistake the comment
 * describes, not fixing it. This emits .studio-seg / .studio-seg-btn
 * directly and defines no shape, colour or spacing of its own; there is
 * nothing left here to drift out of sync with the view switcher, because it
 * is not a second copy of it.
 *
 * Same reasoning as the Project page's review-style choice: neither mode is the
 * absence of the other, so both are named and the pressed one is the state.
 * "Suggesting off" describes nothing.
 *
 * It lives in the document topbar rather than in a menu because it changes what
 * the next keystroke DOES, and a mode with that much consequence has to be
 * visible without being opened — the same argument that put the save status
 * there. `.on` carries the shared visual state, the same class Rich/Split/Raw
 * use, so this paints identically to them; `aria-pressed` stays too, because
 * it is the better-considered ARIA of the two switches in this file's
 * history and is what a screen reader actually announces. Both are written
 * from the one `on` boolean below, so the visual state and the announced
 * state cannot fall out of agreement with each other.
 */
function suggestSwitchHtml() {
    const on = suggestMode.suggesting();
    return '<div class="studio-seg" role="group" ' +
        'aria-label="How your edits are recorded">' +
        '<button class="studio-seg-btn' + (on ? '' : ' on') + '" data-act="suggest-mode" data-mode="edit" ' +
        'aria-pressed="' + String(!on) + '" title="Your edits change the document">Editing</button>' +
        '<button class="studio-seg-btn' + (on ? ' on' : '') + '" data-act="suggest-mode" data-mode="suggest" ' +
        'aria-pressed="' + String(on) + '" title="Your edits are recorded as suggestions for review">Suggesting</button>' +
        '</div>';
}

const SUGGEST_MODE_CSS = `
/*
 * One rule, not a pill's worth.
 *
 * Everything else about this control's look — track, segment shape, the
 * pressed segment's raised-surface treatment — is .studio-seg / .studio-seg-
 * btn from editor-css.js, verbatim, not restyled here. What is genuinely
 * specific to THIS switch is that Suggesting is consequential in a way
 * "Split view" is not: it changes what the next keystroke does to the
 * document. The neutral .on treatment the view switcher uses for its own
 * state is quieter than the solid accent fill this pill used to have — and a
 * version of this control that answered that by adding a heavy accent
 * BORDER on top of a filled segment, beside a save-status field that already
 * says the same thing in words, was reviewed and rejected as three emphatic
 * treatments of one fact ("this seems overloaded", and it was). So: exactly
 * one added cue, not zero and not that pile of three — the label itself
 * tints to the accent when Suggesting is on, echoing
 * .studio-doc-status.state-suggesting right next to it (editor-css.js), so
 * the two places that both answer "is what I type going into the file" say
 * so with the one signal this palette already spends on "something is
 * happening", instead of a second ring or a border colour change.
 */
.studio-seg-btn.on[data-mode="suggest"],
.studio-seg-btn[aria-pressed="true"][data-mode="suggest"] {
  color: var(--studio-accent);
}
`;

module.exports = { suggestMode, suggestSwitchHtml, SUGGEST_MODE_CSS };
