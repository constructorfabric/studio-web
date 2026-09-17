/*
 * Pointing at something that was rendered, in a way that survives re-rendering.
 *
 * A comment on a paragraph of Markdown anchors to the words it quotes
 * (comment-log.js: quote plus occurrence). A comment on a rendered THING —
 * a heading, a table, an image, a diagram — has no words to quote, and
 * requirement 22 is exactly that case: "attach a comment to a rendered heading,
 * table, image, chart, diagram, slide element, or other eligible component
 * without selecting text".
 *
 * So the anchor is the element's position in the tree.
 *
 * # Why a child-index path and not a CSS selector
 *
 * Both surfaces that render a document INJECT nodes into it — the HTML viewer
 * adds thread panels, the Markdown editor adds markers and overlays. A selector
 * like `:nth-of-type(3)` counts those, so every anchor in the document silently
 * re-points the moment a panel opens. The walker below skips anything marked as
 * injected, so the path describes the DOCUMENT rather than the document plus
 * whatever the surface is currently showing.
 *
 * An id-based selector fails differently and worse: rendered Markdown has no
 * ids, and the ids an HTML page does have are the author's to change.
 *
 * # What it does not promise
 *
 * The path is stable against re-rendering and against injected chrome. It is
 * NOT stable against editing: insert a paragraph above a table and the table's
 * path changes, exactly as a quoted sentence moves when the sentence is
 * rewritten. That is why `describe` and `snippet` are stored beside the path —
 * not to find the element, but so a surface can say WHAT was lost when the path
 * no longer resolves, rather than dropping the thread or silently attaching it
 * to whatever now sits in that position. Requirement 22 asks for exactly that:
 * "flagged for reattachment rather than moved".
 *
 * # Why this module exists
 *
 * It was written inside `html-viewer.js`, where it worked and where it could
 * only ever serve HTML pages. The rich Markdown surface needs the same thing
 * and must not grow a second, subtly different copy — two anchoring models
 * would disagree about what "the third child" means the first time one of them
 * learned to skip a node the other did not.
 *
 * The root is a parameter rather than `document.body`, which is the only change
 * the extraction needed: an HTML page anchors within its body, and an editor
 * anchors within its own content element.
 */

/** Marks nodes a surface injected into the rendered document. */
const INJECTED = 'data-studio-injected';

/** The children that belong to the document, in order. */
function realChildren(parent) {
    return [...parent.children].filter(child => !child.hasAttribute(INJECTED));
}

/**
 * Where an element sits, as indices from `root`.
 *
 * `undefined` when the element is not inside the root, or when it is itself
 * injected chrome — neither is a thing a comment may be attached to, and
 * answering with a path that resolves to something else would be worse than
 * refusing.
 */
function pathOf(el, root) {
    if (!el || !root || el === root) { return undefined; }
    const path = [];
    let node = el;
    while (node && node !== root) {
        const parent = node.parentElement;
        if (!parent) { return undefined; }
        const index = realChildren(parent).indexOf(node);
        if (index < 0) { return undefined; }
        path.unshift(index);
        node = parent;
    }
    return node === root ? path : undefined;
}

/**
 * The element a path names, or `undefined` when the document no longer has
 * one there.
 *
 * `undefined` is the answer a caller has to handle, not an error: a document
 * is edited between the comment and the reading of it, and "the thing this was
 * about is gone" is ordinary.
 */
function resolvePath(path, root) {
    if (!root || !Array.isArray(path)) { return undefined; }
    let node = root;
    for (const index of path) {
        const kids = realChildren(node);
        if (!kids[index]) { return undefined; }
        node = kids[index];
    }
    return node === root ? undefined : node;
}

/** Enough of the element's text to recognise it in a list of threads. */
function snippetOf(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * A short name for the element, for the case where the path stops resolving.
 *
 * Deliberately structural — tag, then id or first class — rather than a
 * description of what it looked like. It is read next to the snippet, which
 * carries the meaning; this carries the shape, and the two together are what
 * lets somebody decide where a lost comment should go back.
 */
function describe(el) {
    if (!el || !el.tagName) { return ''; }
    let out = el.tagName.toLowerCase();
    if (el.id) { return out + '#' + el.id; }
    if (el.className && typeof el.className === 'string') {
        const first = el.className.trim().split(/\s+/)[0];
        if (first) { out += '.' + first; }
    }
    return out;
}

/**
 * The whole anchor for an element, as a thread stores it.
 *
 * `undefined` when the element cannot be anchored, so a caller cannot
 * accidentally store an anchor with no path in it.
 */
function anchorFor(el, root) {
    const path = pathOf(el, root);
    if (!path) { return undefined; }
    return {
        type: 'element',
        path,
        tag: el.tagName.toLowerCase(),
        describe: describe(el),
        snippet: snippetOf(el)
    };
}

/** What a surface shows for an anchor whose element it can no longer find. */
function lostText(anchor) {
    if (!anchor) { return ''; }
    const shape = anchor.describe || anchor.tag || 'something';
    return anchor.snippet ? shape + ' — ' + anchor.snippet : shape;
}

module.exports = {
    INJECTED, realChildren, pathOf, resolvePath, snippetOf, describe, anchorFor, lostText
};
