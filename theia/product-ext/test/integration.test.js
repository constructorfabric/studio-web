const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio.test/' });
for (const k of ['Element','HTMLElement','Node','DOMParser','MutationObserver','Event','CustomEvent',
                 'KeyboardEvent','MouseEvent','getComputedStyle','requestAnimationFrame',
                 'cancelAnimationFrame','innerHeight','innerWidth']) global[k] = dom.window[k];
global.window = dom.window; global.document = dom.window.document; global.navigator = dom.window.navigator;
global.DragEvent = dom.window.Event; global.ClipboardEvent = dom.window.Event;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const me = require('../lib/browser/markdown-editor.js');
const { trackedHtml } = require('../lib/browser/tracked-changes.js');
const { generateHTML } = require('@tiptap/core');
const { markdownToDoc } = require('../lib/browser/markdown.js');
const { MarkdownEditorWidget } = me;

let pass = 0; const fail = [];
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail.push(name + (extra ? ' -- ' + extra : '')); } };

const fake = { uri: { path: { base: 'test.md' } } };
const fidelity = body => MarkdownEditorWidget.prototype.checkFidelity.call(fake, body);

/* 1. an ordinary document is editable and byte-stable */
let f = fidelity('# Title\n\nSome **text** and a [link](https://x.test).\n\n- one\n- two\n');
ok('plain doc lossless', f.lossless, f.reason);
ok('plain doc identical', f.identical, JSON.stringify(f.roundTripped));

/* 2. a document containing a code fence is editable -- the P0 regression */
f = fidelity('# Title\n\n```js\nconst a = 1;\n```\n\ntext\n');
ok('fenced code doc lossless', f.lossless, f.reason);
ok('fenced code doc identical', f.identical, JSON.stringify(f.roundTripped));

/* 3. all six new types survive the gate */
f = fidelity([
    '# Report', '',
    ':::warning', 'Careful.', ':::', '',
    'Inline $x^2$ and ==marked== and ~~struck~~.', '',
    '$$', '\\int_0^1 x^2', '$$', '',
    '<div class="x">raw</div>', ''
].join('\n'));
ok('rich doc lossless', f.lossless, f.reason);
ok('rich doc identical', f.identical, JSON.stringify(f.roundTripped));

/* 4. dialect input normalises, and the banner is told it will */
f = fidelity('# T\n\n> [!NOTE]\n> An alert.\n\nSetext\n======\n');
ok('drifted doc lossless', f.lossless, f.reason);
ok('drifted doc reports reformat', f.lossless && !f.identical);
ok('drifted doc normalises the alert', /:::note/.test(f.roundTripped || ''), JSON.stringify(f.roundTripped));
ok('drifted doc normalises setext', /^# Setext$/m.test(f.roundTripped || ''));

/* 5. stage N repairs on import and the gate judges the repair, not the bytes */
f = fidelity('# T\n\nsome **unfinished\n\n```js\nconst a = 1;\n');
ok('interrupted doc is still editable', f.lossless, f.reason);
ok('interrupted doc exposes a repaired body', typeof f.repaired === 'string');
ok('repair closed the open fence', /```\s*$/.test((f.repaired || '').trim()), JSON.stringify(f.repaired));

/* 6. the shortlist still bites where it should */
f = fidelity('# T\n\n<script>alert(1)</script>\n');
ok('script tag still locks the document', !f.lossless);
ok('script lock names the reason', /script/i.test(f.reason || ''), f.reason);

/* 7. editorBody() prefers the repaired text */
const eb = MarkdownEditorWidget.prototype.editorBody;
ok('editorBody falls back to disk bytes', eb.call({ originalBody: 'A', repairedBody: undefined }) === 'A');
ok('editorBody prefers the repaired text', eb.call({ originalBody: 'A', repairedBody: 'B' }) === 'B');

/* 8. the tracked review surface renders through the editor's own schema */
const D_OPEN = '', D_MID = '', D_END = '', SEP = '';
const marked = '## ' + D_OPEN + '0' + SEP + 'p1' + SEP + 'r1' + D_MID + 'Deleted heading' + D_END +
    '\n\n- bullet ' + D_OPEN + '0' + SEP + 'p1' + SEP + 'r2' + D_MID + 'gone' + D_END + ' kept\n';
const exts = me.buildExtensions(undefined);
const render = md => generateHTML(markdownToDoc(md).doc, exts);
const reviewed = trackedHtml(marked, [], render);
ok('tracked render keeps the heading a heading', /<h2/.test(reviewed), reviewed.slice(0, 140));
ok('tracked render keeps the bullet a bullet', /<ul/.test(reviewed), reviewed.slice(0, 200));
ok('tracked render substituted the sentinels', /studio-tc|<del/.test(reviewed), reviewed.slice(0, 240));
ok('no control characters leak into the HTML', !/[-]/.test(reviewed));

/* 9. plainBlockText walks a document rather than parsing HTML */
if (typeof me.plainBlockText === 'function') {
    const { doc } = markdownToDoc('# One\n\ntwo words\n\n- a\n- b\n');
    const text = me.plainBlockText(doc);
    ok('plainBlockText yields one line per top-level block', text.split('\n').length === 3, JSON.stringify(text));
}

console.log('');
if (!fail.length) { console.log('integration: ' + pass + ' passing'); }
else { fail.forEach(x => console.log('  FAIL  ' + x)); console.log('\nintegration: ' + pass + ' passing, ' + fail.length + ' failing'); }
process.exitCode = fail.length ? 1 : 0;
