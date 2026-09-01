/*
 * Code blocks: the language, the colours, and the keyboard.
 *
 * WHY THIS FILE EXISTS. "Code blocks are completely broken" arrived as four
 * separate reports and they had four separate causes, none of which any
 * existing suite could see:
 *
 *   1. A fence with no info string was never highlighted, and most fences in a
 *      real document have no info string — so "plain text and that's it" was
 *      the normal case. detectLanguage is the answer and it is a guess, which
 *      makes a regression table the only honest way to hold it: the cases
 *      below are the contract.
 *   2. `import numpy` came out in one colour, because Prism's python grammar
 *      leaves the module name a bare word.
 *   3. TAB left the document entirely — nothing claimed it, so the browser
 *      advanced focus to the language <input> in the block's own head.
 *   4. BACKSPACE at the start of a fence joined it into the paragraph above,
 *      destroying the fence, the language and every newline in it.
 *
 * And one more, found while reproducing 3 in a real browser: naming the
 * language parked the caret at position 0 of the block, which is both why the
 * next line landed above the first one and why Backspace was at the start in
 * the first place.
 *
 * Run: `node test/code-block.test.js`.
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
const { detectLanguage } = require('../src/browser/code-highlight');
const { docToMarkdown } = require('../src/browser/markdown');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
    if (cond) { pass++; } else { failures.push(name + (extra ? '\n        ' + extra : '')); }
};

function fence(language, text, trailing) {
    const content = [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'codeBlock', attrs: { language }, content: text ? [{ type: 'text', text }] : [] }
    ];
    if (trailing !== false) { content.push({ type: 'paragraph', content: [{ type: 'text', text: 'after' }] }); }
    const host = dom.window.document.getElementById('host');
    host.innerHTML = '';
    const editor = new Editor({ element: host, extensions: buildExtensions(undefined), content: { type: 'doc', content } });
    // The code block always sits second, so its own position is the paragraph
    // before it (size 8) — and its first text position is one past that.
    return { editor, at: 8, start: 9, code: editor.view.dom.querySelector('pre code') };
}

const codeOf = editor => {
    let found;
    editor.state.doc.descendants(node => { if (node.type.name === 'codeBlock') { found = node; } return true; });
    return found;
};
const textOf = editor => (codeOf(editor) ? codeOf(editor).textContent : undefined);
const tokensOf = editor => [...editor.view.dom.querySelectorAll('pre code .token')]
    .map(t => t.className.replace('token ', '') + '=' + t.textContent).join(' ');

/* --- 1. detection is a contract, not a mood ------------------------------- */

const DETECTED = [
    ['import numpy', 'python'],
    ['def f(x):\n    return x * 2', 'python'],
    ['class A:\n    def __init__(self):\n        self.x = 1', 'python'],
    ['const a = 1;\nconsole.log(a)', 'javascript'],
    ['module.exports = { a: 1 }', 'javascript'],
    ['interface X { a: string }', 'typescript'],
    ['export type Id = string | number', 'typescript'],
    ['npm install foo\ncd bar && ls', 'bash'],
    ['$ git status', 'bash'],
    ['#!/bin/bash\nset -e', 'bash'],
    ['{\n  "a": 1,\n  "b": "two"\n}', 'json'],
    ['{ "name": "studio", "private": true }', 'json'],
    ['---\ntitle: "A doc"\ntags:\n  - one', 'yaml'],
    ['name: x\nitems:\n  - one\n  - two', 'yaml'],
    ['<div class="x">hi</div>', 'markup'],
    ['.a { color: red; }', 'css'],
    ['body {\n  margin: 0;\n}', 'css'],
    ['SELECT * FROM t WHERE x = 1', 'sql'],
    ['package main\n\nfunc main() { fmt.Println(1) }', 'go'],
    ['fn main() { let mut x = 1; }', 'rust'],
    ['public class A {\n  public static void main(String[] a) {}\n}', 'java'],
    ['FROM node:20\nRUN npm ci', 'docker'],
    ['@@ -1,2 +1,3 @@\n-old\n+new', 'diff'],
    ['[section]\nkey = value', 'ini'],
    /*
     * The negatives matter as much: a guess is only worth having if it declines
     * when it does not know, because a WRONG language colours the block as
     * something it is not, and the reader has no way to tell that from a bug.
     */
    ['hello world', ''],
    ['some prose that happens to be in a fence', ''],
    ['x', ''],
    ['', ''],
    ['TODO\n----', '']
];

for (const [source, expected] of DETECTED) {
    const got = detectLanguage(source);
    ok('detect ' + JSON.stringify(source.slice(0, 26)) + ' -> ' + (expected || 'nothing'),
        got === expected, 'got ' + JSON.stringify(got));
}

/* --- 2. the fence's own info string always wins --------------------------- */

let f = fence(null, 'import numpy');
ok('an unlabelled python fence is highlighted from the guess',
    tokensOf(f.editor).includes('keyword=import'), tokensOf(f.editor));
ok('the imported module gets its own colour',
    tokensOf(f.editor).includes('numpy'), tokensOf(f.editor));

f = fence('py', 'import numpy');
ok('a named fence is highlighted', tokensOf(f.editor).includes('keyword=import'), tokensOf(f.editor));

f = fence('text', 'import numpy');
ok('a language this build has no grammar for stays plain rather than falling back to the guess',
    tokensOf(f.editor) === '', tokensOf(f.editor));

f = fence(null, 'just some prose in a fence');
ok('an undetectable fence stays plain', tokensOf(f.editor) === '', tokensOf(f.editor));

/* --- 3. the node view says what it guessed -------------------------------- */

f = fence(null, 'def f():\n    return 1');
let lang = f.editor.view.dom.querySelector('.studio-code-lang');
ok('the guess shows as the placeholder', lang.placeholder === 'python', lang.placeholder);
ok('the guess is marked as a guess', lang.classList.contains('is-detected'));
ok('the field itself stays empty, so nothing is written to the file', lang.value === '');
ok('the document keeps its bare fence', docToMarkdown(f.editor.getJSON()).includes('```\ndef f():'),
    JSON.stringify(docToMarkdown(f.editor.getJSON())));

f = fence('python', 'def f():\n    return 1');
lang = f.editor.view.dom.querySelector('.studio-code-lang');
ok('a named language is the value, not a placeholder', lang.value === 'python' && !lang.classList.contains('is-detected'));

f = fence(null, 'nothing recognisable in here');
lang = f.editor.view.dom.querySelector('.studio-code-lang');
ok('no guess falls back to the generic placeholder', lang.placeholder === 'plain text', lang.placeholder);

ok('code is not spellchecked', f.code.getAttribute('spellcheck') === 'false');

/* --- 4. naming the language returns the caret ----------------------------- */

/*
 * The reported jump, in the two steps that produced it: the caret is in the
 * code, the language field takes focus, and Enter has to put the caret BACK
 * where it was rather than at the top of the block.
 */
f = fence(null, 'import numpy');
lang = f.editor.view.dom.querySelector('.studio-code-lang');
f.editor.commands.setTextSelection(f.start + 12);
lang.focus();
lang.value = 'py';
lang.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
ok('Enter in the language field commits it', (codeOf(f.editor).attrs || {}).language === 'py',
    JSON.stringify(codeOf(f.editor).attrs));
ok('Enter in the language field returns the caret to where it was',
    f.editor.state.selection.from === f.start + 12, String(f.editor.state.selection.from));

f = fence(null, 'import numpy');
lang = f.editor.view.dom.querySelector('.studio-code-lang');
lang.focus();     // never had the caret in the block
lang.value = 'py';
lang.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
ok('with no caret to return, the end of the block is where a person expects to be',
    f.editor.state.selection.from === f.start + 12, String(f.editor.state.selection.from));

f = fence('py', 'x = 1');
lang = f.editor.view.dom.querySelector('.studio-code-lang');
lang.focus();
lang.value = 'ruby';
lang.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
ok('Escape abandons the edit', (codeOf(f.editor).attrs || {}).language === 'py');
ok('Escape restores the field', lang.value === 'py', lang.value);

/* --- 5. the keyboard ------------------------------------------------------ */

const shortcut = (editor, name) => editor.commands.keyboardShortcut(name);

f = fence('py', 'x = 1');
f.editor.commands.setTextSelection(f.start);
shortcut(f.editor, 'Tab');
ok('Tab indents', textOf(f.editor) === '  x = 1', JSON.stringify(textOf(f.editor)));
shortcut(f.editor, 'Shift-Tab');
ok('Shift-Tab outdents', textOf(f.editor) === 'x = 1', JSON.stringify(textOf(f.editor)));

f = fence('py', 'a = 1\nb = 2\nc = 3');
f.editor.commands.setTextSelection({ from: f.start, to: f.start + 17 });
shortcut(f.editor, 'Tab');
ok('Tab indents every line of a selection', textOf(f.editor) === '  a = 1\n  b = 2\n  c = 3',
    JSON.stringify(textOf(f.editor)));
ok('and keeps the selection, so it can be pressed twice',
    f.editor.state.selection.from === f.start && f.editor.state.selection.to === f.start + 23,
    f.editor.state.selection.from + '..' + f.editor.state.selection.to);
shortcut(f.editor, 'Shift-Tab');
ok('Shift-Tab outdents every line', textOf(f.editor) === 'a = 1\nb = 2\nc = 3', JSON.stringify(textOf(f.editor)));

f = fence('py', 'x = 1');
f.editor.commands.setTextSelection(f.start + 3);
shortcut(f.editor, 'Shift-Tab');
ok('Shift-Tab inside a word takes nothing away', textOf(f.editor) === 'x = 1', JSON.stringify(textOf(f.editor)));

/*
 * Tab OUTSIDE a code block is somebody else's key — a list item's indent —
 * and the handler has to decline rather than insert spaces into prose.
 */
f = fence('py', 'x = 1');
f.editor.commands.setTextSelection(1);
shortcut(f.editor, 'Tab');
ok('Tab in a paragraph is not claimed by the code block',
    f.editor.state.doc.firstChild.textContent === 'before', f.editor.state.doc.firstChild.textContent);

f = fence('py', 'import numpy');
f.editor.commands.setTextSelection(f.start);
shortcut(f.editor, 'Backspace');
ok('Backspace at the start of a fence leaves the document alone',
    f.editor.state.doc.childCount === 3 && textOf(f.editor) === 'import numpy',
    docToMarkdown(f.editor.getJSON()));

f = fence('py', '');
f.editor.commands.setTextSelection(f.start);
shortcut(f.editor, 'Backspace');
ok('Backspace in an EMPTY fence clears it to a paragraph',
    !codeOf(f.editor) && f.editor.state.doc.childCount === 3, docToMarkdown(f.editor.getJSON()));

/*
 * Anywhere else, Backspace must leave the STRUCTURE alone. Two things cannot be
 * asserted here and both are worth recording rather than faking:
 *  - the character itself comes off via the browser's own beforeinput, which
 *    jsdom does not perform (a real browser was used for that one);
 *  - whether the key was claimed is not observable either, because Tiptap's
 *    `keyboardShortcut` command returns true unconditionally, however its
 *    handler chain answered.
 * What is left is the regression that matters: the fence must still be a fence.
 */
f = fence('py', 'x = 1');
f.editor.commands.setTextSelection(f.start + 5);
shortcut(f.editor, 'Backspace');
ok('Backspace in the middle of a line breaks nothing',
    f.editor.state.doc.childCount === 3 && textOf(f.editor) === 'x = 1',
    docToMarkdown(f.editor.getJSON()));

f = fence('py', 'x = 1', false);
f.editor.commands.setTextSelection(f.start + 5);
shortcut(f.editor, 'Mod-Enter');
ok('Mod-Enter leaves a fence that is the last block in the file',
    f.editor.state.doc.lastChild.type.name === 'paragraph', f.editor.state.doc.lastChild.type.name);

/* --- 6. the round trip is untouched -------------------------------------- */

f = fence(null, 'import numpy');
ok('a detected language never reaches the file',
    docToMarkdown(f.editor.getJSON()).trim() === 'before\n\n```\nimport numpy\n```\n\nafter',
    JSON.stringify(docToMarkdown(f.editor.getJSON())));

/* --- report -------------------------------------------------------------- */

if (failures.length) {
    console.error('\ncode-block: ' + failures.length + ' FAILING\n');
    for (const fail of failures) { console.error('  ✗ ' + fail); }
    process.exit(1);
}
console.log('\ncode-block: ' + pass + ' passing');
