/*
 * Node views and decorations, against a REAL editor's DOM.
 *
 * WHY THIS FILE EXISTS. The other suites all work on the document: they parse,
 * serialise, rank menu rows, and run commands. Nothing looked at what the view
 * actually put on screen — and two shipped defects lived entirely there.
 *
 *   1. Toggle rendered a plain <details>/<summary> and left the disclosure to
 *      the browser. Inside a contenteditable region a summary click is a caret
 *      placement, not a disclosure, so every toggle in the product was stuck in
 *      whatever state it was rendered with; and `summary` is an attribute the
 *      static render prints as text, so the title could not be edited either.
 *      Both are invisible to any test that only reads the document.
 *   2. The placeholder decoration landed on CONTAINER nodes, because the
 *      Placeholder plugin's descendants() walk stops at the top level unless
 *      includeChildren is on and a callout holding one empty paragraph counts
 *      as empty. The hint is a zero-height float, so it painted straight
 *      through the callout's tone label and the toggle's title.
 *
 * Run: `node test/node-views.test.js`.
 */

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://studio.test/' });
for (const k of ['Element', 'HTMLElement', 'Node', 'DOMParser', 'MutationObserver', 'Event', 'CustomEvent',
    'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'innerHeight', 'innerWidth']) { global[k] = dom.window[k]; }
global.window = dom.window; global.document = dom.window.document; global.navigator = dom.window.navigator;
global.DragEvent = dom.window.Event; global.ClipboardEvent = dom.window.Event;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame = cb => setTimeout(cb, 0);
global.cancelAnimationFrame = id => clearTimeout(id);
dom.window.requestAnimationFrame = global.requestAnimationFrame;
dom.window.cancelAnimationFrame = global.cancelAnimationFrame;

const { Editor } = require('@tiptap/core');
const { buildExtensions } = require('../src/browser/markdown-editor');
const { markdownToDoc, docToMarkdown } = require('../src/browser/markdown');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
    if (cond) { pass++; } else { failures.push(name + (extra ? '\n        ' + extra : '')); }
};

function editorFor(doc) {
    const host = dom.window.document.getElementById('host');
    host.innerHTML = '';
    return new Editor({ element: host, extensions: buildExtensions(undefined), content: doc });
}

function click(el) {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/* --- 1. the toggle opens and closes ------------------------------------- */

const TOGGLE_DOC = {
    type: 'doc',
    content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'above' }] },
        {
            type: 'toggle',
            attrs: { summary: 'Reading section' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hidden body' }] }]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'below' }] }
    ]
};

let editor = editorFor(TOGGLE_DOC);
let view = editor.view.dom;
let toggle = view.querySelector('.studio-toggle');
let twisty = view.querySelector('.studio-toggle-twisty');
let title = view.querySelector('.studio-toggle-title');
let body = view.querySelector('.studio-toggle-body');

ok('toggle gets a node view, not a bare details', !!toggle && !view.querySelector('details'));
ok('toggle renders a twisty button', !!twisty && twisty.tagName === 'BUTTON');
ok('toggle renders its title as editable text', !!title && title.getAttribute('contenteditable') === 'true');
ok('toggle title shows the summary attribute', title && title.textContent === 'Reading section', title && title.textContent);
ok('toggle body holds the content', !!body && /hidden body/.test(body.textContent));
ok('toggle starts open', toggle.classList.contains('is-open'));

click(twisty);
ok('a twisty click closes the toggle', !toggle.classList.contains('is-open'));
ok('a closed twisty reports collapsed', twisty.getAttribute('aria-expanded') === 'false');
click(twisty);
ok('a second twisty click opens it again', toggle.classList.contains('is-open'));
ok('an open twisty reports expanded', twisty.getAttribute('aria-expanded') === 'true');

/* The body stays in the document either way: collapsing is a reading state,
   never a deletion, and it must not touch the file. */
click(twisty);
ok('collapsing does not change the document', /hidden body/.test(docToMarkdown(editor.getJSON())));
ok('collapsing writes nothing about open state to the file',
    !/<details open/.test(docToMarkdown(editor.getJSON())), docToMarkdown(editor.getJSON()));

/* --- 2. collapsing parks a caret that was inside ------------------------ */

editor = editorFor(TOGGLE_DOC);
view = editor.view.dom;
toggle = view.querySelector('.studio-toggle');
twisty = view.querySelector('.studio-toggle-twisty');

/* pos 7 is the toggle, its paragraph opens at 8, so 9 is inside the body */
editor.commands.setTextSelection(12);
const insideBefore = editor.state.selection.from;
ok('the caret is inside the toggle body to begin with', insideBefore > 8 && insideBefore < 22, String(insideBefore));
click(twisty);
const parked = editor.state.selection.from;
ok('collapsing moves the caret out of the hidden body', parked <= 7 || parked >= 22,
    'selection ' + parked + ' toggle at 7');

/* --- 3. the title is editable and writes markdown ---------------------- */

editor = editorFor(TOGGLE_DOC);
view = editor.view.dom;
title = view.querySelector('.studio-toggle-title');
title.textContent = 'Why this matters';
title.dispatchEvent(new dom.window.Event('blur'));
let md = docToMarkdown(editor.getJSON());
ok('editing the title writes the summary attribute',
    editor.getJSON().content[1].attrs.summary === 'Why this matters',
    JSON.stringify(editor.getJSON().content[1].attrs));
ok('the edited title reaches the markdown', /<summary>Why this matters<\/summary>/.test(md), md);

/* A summary is one line of plain text in the source; a newline pasted into it
   would be written and then silently lost on the next read. */
title = view.querySelector('.studio-toggle-title');
title.textContent = 'two\nlines   here';
title.dispatchEvent(new dom.window.Event('blur'));
ok('a multi-line title is collapsed to one line',
    editor.getJSON().content[1].attrs.summary === 'two lines here',
    JSON.stringify(editor.getJSON().content[1].attrs.summary));

/* An emptied title falls back rather than writing <summary></summary>, which
   reads back as a toggle with no name at all. */
title.textContent = '   ';
title.dispatchEvent(new dom.window.Event('blur'));
ok('an emptied title falls back to Toggle',
    editor.getJSON().content[1].attrs.summary === 'Toggle',
    JSON.stringify(editor.getJSON().content[1].attrs.summary));

/* --- 4. the title round-trips through a real markdown read ------------- */

editor = editorFor(markdownToDoc('<details>\n<summary>Named by hand</summary>\n\nbody\n\n</details>\n').doc);
title = editor.view.dom.querySelector('.studio-toggle-title');
ok('a hand-written summary reaches the node view', title && title.textContent === 'Named by hand',
    title && title.textContent);

/* --- 5. the placeholder never lands on a container -------------------- */

const EMPTY_DOC = {
    type: 'doc',
    content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'above' }] },
        { type: 'callout', attrs: { tone: 'note' }, content: [{ type: 'paragraph' }] },
        { type: 'toggle', attrs: { summary: 'Toggle' }, content: [{ type: 'paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'below' }] }
    ]
};

/* pos 7 is the callout, 8 its empty paragraph, 9 inside it */
editor = editorFor(EMPTY_DOC);
editor.commands.setTextSelection(9);
view = editor.view.dom;
let callout = view.querySelector('.studio-callout');
let hinted = view.querySelector('.studio-callout p[data-placeholder]');
ok('the hint lands on the empty paragraph inside a callout',
    !!hinted && hinted.getAttribute('data-placeholder').length > 0,
    hinted && hinted.outerHTML);
ok('the hint does not land on the callout itself',
    !callout.getAttribute('data-placeholder'),
    callout.getAttribute('data-placeholder'));

/* and the same for a toggle, whose title is the thing it used to paint over */
editor = editorFor(EMPTY_DOC);
editor.commands.setTextSelection(13);
view = editor.view.dom;
toggle = view.querySelector('.studio-toggle');
hinted = view.querySelector('.studio-toggle-body p[data-placeholder]');
ok('the hint lands on the empty paragraph inside a toggle',
    !!hinted && hinted.getAttribute('data-placeholder').length > 0,
    hinted && hinted.outerHTML);
ok('the hint does not land on the toggle itself',
    !toggle.getAttribute('data-placeholder'),
    toggle.getAttribute('data-placeholder'));

/* An ordinary empty paragraph still gets one -- the point was never to have
   fewer hints, only to put them where the caret is. */
editor = editorFor({ type: 'doc', content: [{ type: 'paragraph' }] });
editor.commands.setTextSelection(1);
ok('an empty document still shows the hint',
    /data-placeholder="Type/.test(editor.view.dom.innerHTML), editor.view.dom.innerHTML);

/* A table cell is too narrow to hold the sentence, and the hint is a float:
   it runs out over the next column rather than wrapping or clipping. */
editor = editorFor(markdownToDoc('| a | b |\n| - | - |\n|   |   |\n').doc);
let cellPos;
editor.state.doc.descendants((n, pos) => {
    if (cellPos === undefined && n.type.name === 'tableCell') { cellPos = pos + 2; }
    return true;
});
editor.commands.setTextSelection(cellPos);
ok('an empty table cell gets no block hint',
    !/data-placeholder="Type/.test(editor.view.dom.innerHTML),
    'caret at ' + cellPos);
/* ...and the decoration DID land there, which is what makes the assertion
   above a test of the filter rather than of the plugin not firing. */
ok('the table cell decoration is present but empty',
    /<td[^>]*data-placeholder=""|<p[^>]*data-placeholder=""/.test(editor.view.dom.innerHTML),
    editor.view.dom.querySelector('td') && editor.view.dom.querySelector('td').outerHTML);

/* A code block is a textblock too, and "/" opens no menu inside it. */
editor = editorFor({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'js' } }] });
editor.commands.setTextSelection(1);
ok('an empty code block gets no block hint',
    !/data-placeholder="Type/.test(editor.view.dom.innerHTML));

/* --- report ------------------------------------------------------------ */

console.log('');
if (!failures.length) {
    console.log('node-views: ' + pass + ' passing');
    process.exitCode = 0;
} else {
    for (const f of failures) { console.log('  FAIL  ' + f); }
    console.log('\nnode-views: ' + pass + ' passing, ' + failures.length + ' failing');
    process.exitCode = 1;
}
