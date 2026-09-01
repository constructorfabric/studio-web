/*
 * The link editor.
 *
 * WHY THIS FILE EXISTS. Making a link was the one editing action in the
 * product with no test at all, and it did not work: both entry points (the
 * selection toolbar's button and the slash menu's /link row) called
 * window.prompt(), which Electron does not implement — it returns null and
 * logs "prompt() is and will not be supported", so in the desktop build
 * clicking Link did nothing whatsoever. A test at the document level would not
 * have caught that, and a test of a pure markup builder would not either; what
 * needed covering is the middle — the range a link edit applies to, what the
 * heading list offers, and what each of the four exits (apply, Enter on a
 * heading, remove, Escape) writes into the document.
 *
 * HOW THE WIDGET IS STOOD UP. MarkdownEditorWidget extends a Theia Widget and
 * its constructor wants a file, a workspace and six services; none of that is
 * available here and none of it is what these methods touch. So the methods
 * are called against a hand-built `this` carrying exactly the fields they read
 * — the real prototype methods, the real popover markup (linkEditorHtml, which
 * is why it is a function), a real Tiptap editor. Nothing about the link
 * editor is reimplemented here.
 *
 * Run: `node test/link-editor.test.js`.
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
const {
    MarkdownEditorWidget, buildExtensions, linkEditorHtml,
    linkTargets, filterLinkTargets, linkTargetsHtml, linkRange
} = require('../src/browser/markdown-editor');
const { markdownToDoc, docToMarkdown } = require('../src/browser/markdown');
const URI = require('@theia/core/lib/common/uri').default;

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
    if (cond) { pass++; } else { failures.push(name + (extra ? '\n        ' + extra : '')); }
};

/*
 * A widget stand-in, with the real prototype behind it.
 *
 * `rangeRect` is the one method replaced: it asks the ProseMirror view for the
 * screen coordinates of a range, and jsdom lays nothing out, so every rect
 * would be zeroes. Positioning is the part of this panel a screenshot has to
 * check anyway — see the verify-editor-rendering-headlessly note.
 */
function editorWith(markdown) {
    const host = document.getElementById('host');
    host.innerHTML = '<div class="studio-doc-page"></div>' + linkEditorHtml();
    const editor = new Editor({
        element: host.querySelector('.studio-doc-page'),
        extensions: buildExtensions(undefined),
        content: markdownToDoc(markdown).doc
    });
    const w = Object.create(MarkdownEditorWidget.prototype);
    w.node = host;
    w.editor = editor;
    w.mode = 'rich';
    w.readOnly = false;
    w.reviewing = false;
    w.linkEl = host.querySelector('.studio-link');
    w.linkTextEl = host.querySelector('.studio-link-text');
    w.linkHrefEl = host.querySelector('.studio-link-href');
    w.linkTargetsEl = host.querySelector('.studio-link-targets');
    /*
     * The open path's three collaborators, recorded rather than mocked away:
     * what a click on a link DOES is the assertion, and "it asked the workspace
     * opener for a file" is the failure being covered.
     */
    w.opened = [];
    w.messages = [];
    w.uri = new URI('file:///workspace/docs/guide.md');
    w.openerService = { getOpener: async target => ({ open: async t => { w.opened.push(String(t || target)); } }) };
    w.messageService = {
        error: text => w.messages.push('error: ' + text),
        warn: text => w.messages.push('warn: ' + text),
        info: text => w.messages.push('info: ' + text)
    };
    w.hideBubble = () => undefined;
    w.hideSlash = () => undefined;
    w.hideTableBar = () => undefined;
    w.rangeRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    return w;
}

const md = w => docToMarkdown(w.editor.getJSON()).trim();
/*
 * Select a run of text by its content rather than by a position literal: a
 * document with a heading in it shifts every offset, and a test whose
 * arithmetic is wrong asserts something other than what it says it does.
 */
const selectWords = (w, text) => {
    let found;
    w.editor.state.doc.descendants((node, pos) => {
        if (found || !node.isText || !node.text) { return true; }
        const at = node.text.indexOf(text);
        if (at >= 0) { found = { from: pos + at, to: pos + at + text.length }; }
        return true;
    });
    if (!found) { throw new Error('no such text in the document: ' + text); }
    w.editor.commands.setTextSelection(found);
    return found;
};
const key = (w, name, target) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target || w.linkHrefEl });
    w.onLinkKeyDown(event);
    return event;
};

/* --- 1. the range a link edit applies to --------------------------------- */

let w = editorWith('Some [linked words](https://example.com) in a line.');
let doc = w.editor.state.doc;
// A caret in the middle of the link: the whole link is the range.
w.editor.commands.setTextSelection(9);
let range = linkRange(w.editor.state);
ok('a caret inside a link ranges over the whole link',
    doc.textBetween(range.from, range.to) === 'linked words',
    JSON.stringify(doc.textBetween(range.from, range.to)));

selectWords(w, 'Some');
range = linkRange(w.editor.state);
ok('a real selection is the range', range.from === 1 && range.to === 5, JSON.stringify(range));

w = editorWith('Plain words only.');
w.editor.commands.setTextSelection(3);
range = linkRange(w.editor.state);
ok('an empty selection outside a link is an empty range', range.from === 3 && range.to === 3);

/* --- 2. what the heading list offers ------------------------------------- */

const HEADINGS = [
    '# Overview',
    '',
    'text',
    '',
    '## Getting started',
    '',
    'text',
    '',
    '## Overview',
    '',
    'text',
    '',
    '### A heading, with punctuation!',
    '',
    'text',
    ''
].join('\n');

w = editorWith(HEADINGS);
const targets = linkTargets(w.editor.state.doc);
ok('every heading is a target', targets.length === 4, JSON.stringify(targets.map(t => t.slug)));
ok('the slug is the GitHub anchor', targets[1].slug === 'getting-started', targets[1].slug);
ok('a repeated heading gets GitHub\'s suffix', targets[0].slug === 'overview' && targets[2].slug === 'overview-1',
    JSON.stringify([targets[0].slug, targets[2].slug]));
ok('punctuation is dropped from the slug', targets[3].slug === 'a-heading-with-punctuation', targets[3].slug);
ok('the level is carried', targets.map(t => t.level).join('') === '1223', targets.map(t => t.level).join(''));

/*
 * An empty field lists everything — that is the only thing that tells a reader
 * a section is a legal target — and a URL being typed lists nothing, because a
 * heading list under a half-typed URL is noise.
 */
ok('an empty query lists every heading', filterLinkTargets(targets, '').length === 4);
ok('a bare # lists every heading', filterLinkTargets(targets, '#').length === 4);
ok('# filters on the text', filterLinkTargets(targets, '#start').map(t => t.slug).join() === 'getting-started',
    JSON.stringify(filterLinkTargets(targets, '#start').map(t => t.slug)));
ok('# filters on the slug too', filterLinkTargets(targets, '#overview-1').map(t => t.slug).join() === 'overview-1');
ok('a URL lists nothing', filterLinkTargets(targets, 'https://exa').length === 0);
ok('the filter is case-insensitive', filterLinkTargets(targets, '#OVER').length === 2);

const html = linkTargetsHtml(filterLinkTargets(targets, ''), 1);
ok('the armed row is marked', (html.match(/studio-link-target sel/g) || []).length === 1, html.slice(0, 120));
ok('each row carries its slug', html.includes('data-link-target="getting-started"'));
ok('a heading with markup in it is escaped, not rendered',
    !linkTargetsHtml([{ level: 2, text: '<b>x</b>', slug: 'bx' }], -1).includes('<b>'));

/* --- 3. opening the editor ----------------------------------------------- */

w = editorWith('Link these words please.');
selectWords(w, 'these words');
w.openLinkEditor();
ok('the panel opens', w.linkEl.hidden === false);
ok('the selected text fills the text field', w.linkTextEl.value === 'these words', JSON.stringify(w.linkTextEl.value));
ok('the target field starts empty', w.linkHrefEl.value === '');
ok('the heading list is empty for a file with no headings', w.linkTargetsEl.hidden === true);

w = editorWith('# A section\n\nLink [these words](/other.md) please.\n');
w.editor.commands.setTextSelection(20);
w.openLinkEditor();
ok('an existing target is filled in', w.linkHrefEl.value === '/other.md', w.linkHrefEl.value);
ok('an existing link fills its own text', w.linkTextEl.value === 'these words', w.linkTextEl.value);
/*
 * The list is hidden HERE and that is the rule, not an omission: the field
 * already holds a URL, and a heading list under a URL is noise. Clearing the
 * field brings it back, which is the next assertion.
 */
ok('a filled URL hides the heading list', w.linkTargetsEl.hidden === true);
w.linkHrefEl.value = '';
w.renderLinkTargets();
ok('clearing the target shows every heading', w.linkTargetsEl.hidden === false &&
    w.linkTargetsEl.querySelectorAll('.studio-link-target').length === 1);
// 'target sel', not 'sel': every row carries aria-selected, which contains it.
ok('no row is armed until one is chosen', !w.linkTargetsEl.innerHTML.includes('target sel'));

/* --- 4. the four exits --------------------------------------------------- */

w = editorWith('Link these words please.');
selectWords(w, 'these words');
w.openLinkEditor();
w.linkHrefEl.value = 'https://example.com';
w.commitLinkEditor();
ok('apply links the selected words', md(w) === 'Link [these words](https://example.com) please.', md(w));
ok('apply closes the panel', w.linkEl.hidden === true && w.linkEdit === undefined);

w = editorWith('Link these words please.');
selectWords(w, 'these words');
w.openLinkEditor();
w.linkTextEl.value = 'those';
w.linkHrefEl.value = 'https://example.com';
w.commitLinkEditor();
ok('an edited text replaces the words', md(w) === 'Link [those](https://example.com) please.', md(w));

w = editorWith('Link **these words** please.');
selectWords(w, 'these words');
w.openLinkEditor();
w.linkHrefEl.value = 'https://example.com';
w.commitLinkEditor();
ok('unchanged words keep the marks they already had',
    md(w) === 'Link [**these words**](https://example.com) please.', md(w));

w = editorWith('Nothing selected here.');
w.editor.commands.setTextSelection(1);
w.openLinkEditor();
w.linkTextEl.value = 'a new link';
w.linkHrefEl.value = 'https://example.com';
w.commitLinkEditor();
ok('with no selection the typed text becomes the link',
    md(w) === '[a new link](https://example.com)Nothing selected here.', md(w));

w = editorWith('Nothing selected here.');
w.editor.commands.setTextSelection(1);
w.openLinkEditor();
w.linkHrefEl.value = 'https://example.com';
w.commitLinkEditor();
ok('with no text at all the URL is its own text',
    md(w) === '[https://example.com](https://example.com)Nothing selected here.', md(w));

w = editorWith('Link [these words](/old.md) please.');
w.editor.commands.setTextSelection(8);
w.openLinkEditor();
w.linkHrefEl.value = '/new.md';
w.commitLinkEditor();
ok('an existing link is repointed', md(w) === 'Link [these words](/new.md) please.', md(w));

w = editorWith('Link [these words](/old.md) please.');
w.editor.commands.setTextSelection(8);
w.openLinkEditor();
w.removeLinkFromEditor();
ok('remove keeps the words and drops the link', md(w) === 'Link these words please.', md(w));
ok('remove closes the panel', w.linkEl.hidden === true);

w = editorWith('Link [these words](/old.md) please.');
w.editor.commands.setTextSelection(8);
w.openLinkEditor();
w.linkHrefEl.value = '';
w.commitLinkEditor();
ok('an emptied target unlinks', md(w) === 'Link these words please.', md(w));

w = editorWith('Link [these words](/old.md) please.');
w.editor.commands.setTextSelection(8);
w.openLinkEditor();
w.linkHrefEl.value = '/typed-but-abandoned.md';
key(w, 'Escape');
ok('Escape writes nothing', md(w) === 'Link [these words](/old.md) please.', md(w));
ok('Escape closes the panel', w.linkEl.hidden === true && w.linkEdit === undefined);

/* --- 5. the keyboard ----------------------------------------------------- */

w = editorWith('# Getting started\n\nLink these words please.\n');
selectWords(w, 'these words');
w.openLinkEditor();
ok('the selection is the words, not the heading', w.linkTextEl.value === 'these words', w.linkTextEl.value);
w.linkHrefEl.value = 'https://example.com';
key(w, 'Enter');
ok('Enter with nothing armed uses the typed URL',
    md(w) === '# Getting started\n\nLink [these words](https://example.com) please.', md(w));

w = editorWith('# Getting started\n\nLink these words please.\n');
selectWords(w, 'these words');
w.openLinkEditor();
key(w, 'ArrowDown');
ok('ArrowDown arms the first heading', w.linkEdit.index === 0);
ok('the armed row is rendered as armed', w.linkTargetsEl.innerHTML.includes('studio-link-target sel'));
key(w, 'Enter');
ok('Enter on an armed heading links to its anchor',
    md(w) === '# Getting started\n\nLink [these words](#getting-started) please.', md(w));

w = editorWith('# One\n\n## Two\n\nLink these words please.\n');
selectWords(w, 'these words');
w.openLinkEditor();
key(w, 'ArrowUp');
ok('ArrowUp from nothing wraps to the last heading', w.linkEdit.index === 1, String(w.linkEdit.index));
w.pickLinkTarget('two');
ok('clicking a heading row links to it', md(w) === '# One\n\n## Two\n\nLink [these words](#two) please.', md(w));

/* --- 6. following a link ------------------------------------------------- */

/*
 * The reported defect: a link to a heading was reported as a file that could
 * not be opened. The anchor the editor wrote was right; opening it asked the
 * workspace for a FILE called "#5-success-signal".
 */
const SECTIONS = '# Intro\n\ntext\n\n## 5. Success signal\n\ntext\n\n## Обзор — часть 2\n\ntext\n';

w = editorWith(SECTIONS);
const slugs = linkTargets(w.editor.state.doc).map(t => t.slug);
ok('a non-Latin heading gets a real anchor', slugs.join() === 'intro,5-success-signal,обзор-часть-2', slugs.join());

w = editorWith(SECTIONS);
let heading;
w.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && node.textContent.startsWith('5.')) { heading = pos; }
    return true;
});
w.openLink('#5-success-signal');
ok('a fragment never reaches the file opener', w.opened.length === 0, JSON.stringify(w.opened));
ok('a fragment reports nothing', w.messages.length === 0, JSON.stringify(w.messages));
ok('a fragment moves the caret into that heading', w.editor.state.selection.from === heading + 1,
    w.editor.state.selection.from + ' vs ' + (heading + 1));

w = editorWith(SECTIONS);
w.openLink('#обзор-часть-2');
ok('a non-Latin anchor resolves too', w.messages.length === 0 && w.opened.length === 0,
    JSON.stringify(w.messages));

w = editorWith(SECTIONS);
w.openLink('#%D0%BE%D0%B1%D0%B7%D0%BE%D1%80-%D1%87%D0%B0%D1%81%D1%82%D1%8C-2');
ok('a percent-encoded anchor is the same anchor', w.messages.length === 0, JSON.stringify(w.messages));

w = editorWith(SECTIONS);
w.openLink('#no-such-section');
ok('an anchor with no heading warns rather than failing to open a file',
    w.messages.join() === 'warn: No heading in this document matches #no-such-section.', w.messages.join());

w = editorWith(SECTIONS);
w.trackedEl = document.createElement('div');
w.trackedEl.innerHTML = '<h2>5. Success signal</h2>';
w.trackedEl.hidden = false;
w.openLink('#5-success-signal');
ok('the review page resolves its own headings', w.messages.length === 0 && w.opened.length === 0,
    JSON.stringify(w.messages));
w.trackedEl.hidden = true;

/* --- 7. not inside a fence ----------------------------------------------- */

w = editorWith('text\n\n```py\nimport numpy\n```\n');
selectWords(w, 'numpy');
w.openLinkEditor();
ok('a code block has no links, so the editor does not open', w.linkEl.hidden === true);

/* --- 8. a locked document ------------------------------------------------ */

w = editorWith('Link these words please.');
selectWords(w, 'these words');
w.readOnly = true;
w.openLinkEditor();
ok('a read-only document does not open the editor', w.linkEl.hidden === true);
w.readOnly = false;
w.openLinkEditor();
w.reviewing = true;
w.linkHrefEl.value = 'https://example.com';
w.commitLinkEditor();
ok('a document under review is not written to', md(w) === 'Link these words please.', md(w));

/* --- report -------------------------------------------------------------- */

if (failures.length) {
    console.error('\nlink-editor: ' + failures.length + ' FAILING\n');
    for (const f of failures) { console.error('  ✗ ' + f); }
    process.exit(1);
}
console.log('\nlink-editor: ' + pass + ' passing');
