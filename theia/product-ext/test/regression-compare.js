/*
 * Old-vs-new serialisation regression check.
 *
 * For a document that uses only the block set the OLD hand-written converter
 * (test/legacy/markdown-legacy.js — a verbatim copy of markdown.js as it
 * stood before this rewrite, kept only for this comparison) supported, the
 * new engine should produce the same markdown on save — or, where it
 * differs, the difference should be a defensible improvement, not a
 * regression. This is informational, not a gate: a cosmetic difference is
 * often the CORRECT outcome of pinning md-serialize.js's options, and the
 * judgement of "improvement vs regression" is exactly the kind of call this
 * script exists to surface for a human to make, not to automate away.
 *
 * The old converter parsed by going through an HTML string
 * (markdownToHtml + generateJSON against a live Tiptap schema); reproducing
 * that requires a real Tiptap extension list. markdown-editor.js's own
 * buildExtensions() is not reusable here — it requires a `widget` and
 * Theia's runtime services, and CONTRACT.md forbids editing that file, so
 * this cannot become "require it and patch the environment until it loads"
 * either. Instead this rebuilds just the OLD SUPPORTED SUBSET's schema
 * locally, from the same extension packages and the same Toggle/
 * FootnoteRef/FootnoteDef node shapes markdown-editor.js defines (copied
 * for this test only, not imported) — no strike, no highlight, no callout,
 * no math, because the old engine could not produce those nodes either.
 */

const fs = require('fs');
const path = require('path');

const { generateJSON, Node, mergeAttributes } = require('@tiptap/core');
const { StarterKit } = require('@tiptap/starter-kit');
const { Link } = require('@tiptap/extension-link');
const { Image } = require('@tiptap/extension-image');
const { TaskList } = require('@tiptap/extension-task-list');
const { TaskItem } = require('@tiptap/extension-task-item');
const { TABLE_EXTENSIONS } = require('../lib/browser/editor-tables');

const { markdownToHtml, jsonToMarkdown } = require('./legacy/markdown-legacy');
const { markdownToDoc, docToMarkdown } = require('../lib/browser/markdown');

// Same shape as markdown-editor.js's Toggle/FootnoteRef/FootnoteDef — see
// that file for the reasoning behind each; copied rather than imported (see
// this file's header).
const Toggle = Node.create({
    name: 'toggle', group: 'block', content: 'block+', isolating: true,
    addAttributes() { return { summary: { default: 'Toggle' } }; },
    parseHTML() {
        return [{
            tag: 'details', contentElement: '[data-studio-toggle-body]',
            getAttrs: element => ({ summary: element.querySelector('summary')?.textContent || 'Toggle' })
        }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['details', ['summary', HTMLAttributes.summary], ['div', { 'data-studio-toggle-body': '' }, 0]];
    }
});

const FootnoteRef = Node.create({
    name: 'footnoteRef', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes() {
        return { label: { default: '', parseHTML: el => el.getAttribute('data-footnote-ref') || '', renderHTML: attrs => ({ 'data-footnote-ref': attrs.label || '' }) } };
    },
    parseHTML() { return [{ tag: 'sup[data-footnote-ref]' }]; },
    renderHTML({ HTMLAttributes }) {
        return ['sup', mergeAttributes(HTMLAttributes, { class: 'studio-footnote-ref' }), HTMLAttributes['data-footnote-ref'] || ''];
    }
});

const FootnoteDef = Node.create({
    name: 'footnoteDef', group: 'block', content: 'inline*', defining: true,
    addAttributes() {
        return { label: { default: '', parseHTML: el => el.getAttribute('data-footnote-def') || '', renderHTML: attrs => ({ 'data-footnote-def': attrs.label || '' }) } };
    },
    parseHTML() { return [{ tag: 'div[data-footnote-def]', contentElement: '[data-studio-footnote-body]' }]; },
    renderHTML({ HTMLAttributes }) {
        const label = HTMLAttributes['data-footnote-def'] || '';
        return ['div', mergeAttributes(HTMLAttributes, { class: 'studio-footnote-def' }),
            ['span', { class: 'studio-footnote-def-label', contenteditable: 'false' }, '[^' + label + ']'],
            ['span', { class: 'studio-footnote-def-body', 'data-studio-footnote-body': '' }, 0]];
    }
});

const LEGACY_EXTENSIONS = [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
    Link.configure({ openOnClick: false, autolink: false, validate: () => true, isAllowedUri: () => true }),
    Image,
    TaskList,
    TaskItem.configure({ nested: true }),
    Toggle, FootnoteRef, FootnoteDef,
    ...TABLE_EXTENSIONS
];

const dir = path.join(__dirname, 'fixtures', 'regression');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

console.log('\n--- Old-vs-new serialisation regression (informational) ---\n');

for (const file of files) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    let oldOut, newOut;
    try {
        const oldJson = generateJSON(markdownToHtml(body), LEGACY_EXTENSIONS);
        oldOut = jsonToMarkdown(oldJson);
    } catch (e) {
        console.log(file + ': old engine could not process this fixture (' + e.message + ')');
        continue;
    }
    try {
        newOut = docToMarkdown(markdownToDoc(body).doc);
    } catch (e) {
        console.log(file + ': new engine could not process this fixture (' + e.message + ')');
        continue;
    }
    if (oldOut === newOut) {
        console.log(file + ': identical output');
        continue;
    }
    console.log(file + ': DIFFERS');
    console.log('  --- old ---');
    console.log('  ' + oldOut.split('\n').join('\n  '));
    console.log('  --- new ---');
    console.log('  ' + newOut.split('\n').join('\n  '));
    console.log('');
}
