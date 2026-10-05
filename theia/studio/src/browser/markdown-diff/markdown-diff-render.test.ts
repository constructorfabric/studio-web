import { diffMarkdown, parseMarkdown } from './markdown-diff-model';
import { coalesce, createMarkdownRenderer, describeChanges, markWordChanges, renderDiff, sanitizeHtml, visibleRows } from './markdown-diff-render';

const md = createMarkdownRenderer();

function render(before: string, after: string, changesOnly = false, expanded: number[] = []): ReturnType<typeof renderDiff> {
    const oldDoc = parseMarkdown(md, before);
    const newDoc = parseMarkdown(md, after);
    return renderDiff(document, md, diffMarkdown(oldDoc, newDoc), oldDoc, newDoc, { changesOnly, expanded: new Set(expanded) });
}

function element(html: string): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
}

describe('markWordChanges', () => {
    it('marks the changed word on each side, inside the rendered markup', () => {
        const oldCell = element('<p>The <strong>quick brown</strong> fox jumps over it.</p>');
        const newCell = element('<p>The <strong>quick red</strong> fox jumps over it.</p>');
        expect(markWordChanges(oldCell, newCell)).toBe('words');
        expect(oldCell.innerHTML).toBe('<p>The <strong>quick <del class="studio-md-diff-word removed">brown</del></strong> fox jumps over it.</p>');
        expect(newCell.innerHTML).toBe('<p>The <strong>quick <ins class="studio-md-diff-word added">red</ins></strong> fox jumps over it.</p>');
    });

    it('wraps a change that crosses an element boundary piece by piece', () => {
        const oldCell = element('<p>Keep this sentence as it is.</p>');
        const newCell = element('<p>Keep this sentence as <em>it</em> was before, mostly.</p>');
        markWordChanges(oldCell, newCell);
        expect(newCell.querySelectorAll('ins').length).toBeGreaterThan(0);
        expect(newCell.textContent).toBe('Keep this sentence as it was before, mostly.');
    });

    it('takes a rewrapped paragraph for formatting, not an edit', () => {
        expect(markWordChanges(element('<p>one two\nthree four</p>'), element('<p>one two three\nfour</p>'))).toBe('markup');
    });

    it('says when only the markup changed', () => {
        expect(markWordChanges(element('<p><a href="a">link</a></p>'), element('<p><a href="b">link</a></p>'))).toBe('markup');
    });

    it('gives up on word marks when most of the block changed', () => {
        const oldCell = element('<p>one two</p>');
        expect(markWordChanges(oldCell, element('<p>three four five six</p>'))).toBe('whole');
        expect(oldCell.querySelector('del')).toBeNull();
    });
});

describe('coalesce', () => {
    it('joins changed words across the spaces between them', () => {
        expect(coalesce([
            { value: 'A ' },
            { value: 'old', removed: true }, { value: 'new', added: true },
            { value: ' ' },
            { value: 'words', removed: true }, { value: 'phrase', added: true },
            { value: ' end.' },
        ])).toEqual([
            { value: 'A ' },
            { value: 'old words', removed: true }, { value: 'new phrase', added: true },
            { value: ' end.' },
        ]);
    });

    it('keeps a real unchanged stretch between two changes', () => {
        const parts = [{ value: 'x', added: true }, { value: ' stays the same ' }, { value: 'y', added: true }];
        expect(coalesce(parts)).toEqual(parts);
    });
});

describe('renderDiff', () => {
    it('renders one row per block with both sides', () => {
        const { root, changes } = render('# T\n\nThe quick brown fox.\n', '# T\n\nThe quick red fox.\n');
        const rows = Array.from(root.querySelectorAll('.studio-md-diff-row'));
        expect(rows.map(row => row.className)).toEqual(['studio-md-diff-row equal', 'studio-md-diff-row modified marked-words']);
        expect(rows[0].querySelector('.old h1')?.textContent).toBe('T');
        expect(changes).toEqual([rows[1]]);
        expect((rows[1] as HTMLElement).dataset.newLine).toBe('3');
    });

    it('leaves the other side empty for an added block', () => {
        const { root } = render('a\n', 'a\n\nb\n');
        const added = root.querySelector('.studio-md-diff-row.added')!;
        expect(added.querySelector('.old')!.classList.contains('empty')).toBe(true);
        expect(added.querySelector('.new p')!.textContent).toBe('b');
    });

    it('keeps mermaid source for the widget to draw, and out of the word marks', () => {
        const { root } = render('```mermaid\ngraph TD; A-->B\n```\n', '```mermaid\ngraph TD; A-->C\n```\n');
        expect(root.querySelectorAll('.studio-md-diff-mermaid').length).toBe(2);
        expect(root.querySelector('ins, del')).toBeNull();
    });

    it('folds unchanged runs when asked, keeping one block of context', () => {
        const before = ['a', 'b', 'c', 'd', 'e'].join('\n\n');
        const after = ['a', 'b', 'c', 'd', 'E changed'].join('\n\n');
        const folded = render(before, after, true);
        expect(folded.root.querySelector('.studio-md-diff-fold')!.textContent).toBe('3 unchanged blocks');
        expect(folded.root.querySelectorAll('.studio-md-diff-row').length).toBe(2);
        const opened = render(before, after, true, [0]);
        expect(opened.root.querySelector('.studio-md-diff-fold')).toBeNull();
        expect(opened.root.querySelectorAll('.studio-md-diff-row').length).toBe(5);
    });

    it('says so when the versions are identical', () => {
        expect(render('same\n', 'same\n').root.querySelector('.studio-md-diff-identical')).not.toBeNull();
    });

    it('turns task-list markers into boxes', () => {
        const { root } = render('- [ ] todo\n- [x] done\n', '- [ ] todo\n- [x] done\n');
        expect(Array.from(root.querySelectorAll('.new .studio-md-diff-task')).map(box => box.textContent)).toEqual(['☐', '☑']);
    });
});

describe('describeChanges', () => {
    it('counts formatting-only rows apart from real edits', () => {
        expect(describeChanges({ modified: 18, added: 0, removed: 0 }, 17)).toBe('1 changed · 17 formatting only');
        expect(describeChanges({ modified: 2, added: 3, removed: 1 }, 0)).toBe('2 changed · 3 added · 1 removed');
        expect(describeChanges({ modified: 4, added: 0, removed: 0 }, 4)).toBe('4 formatting only');
        expect(describeChanges({ modified: 0, added: 0, removed: 0 }, 0)).toBe('No changes');
    });

    it('says which version could not be read', () => {
        expect(describeChanges({ modified: 0, added: 5, removed: 0 }, 0, ['HEAD'])).toBe('Not in HEAD · 5 added');
    });

    it('is fed the formatting-only count by renderDiff', () => {
        const { formattingOnly } = render('See [docs](a.md) here.\n\nOld words stay mostly.\n', 'See [docs](b.md) here.\n\nOld words stay mostly here.\n');
        expect(formattingOnly).toBe(1);
    });
});

describe('visibleRows', () => {
    it('shows everything unless folding', () => {
        expect(visibleRows([{ kind: 'equal' }, { kind: 'equal' }], false)).toEqual([true, true]);
        expect(visibleRows([{ kind: 'equal' }, { kind: 'equal' }, { kind: 'added' }], true)).toEqual([false, true, true]);
    });
});

describe('sanitizeHtml', () => {
    it('removes scripts, handlers, inline styles and form controls from document HTML', () => {
        const html = sanitizeHtml('<p style="position:fixed" onclick="x()">t</p><script>x()</script><input><img src="a.png" onerror="x()">');
        expect(html).toBe('<p>t</p><img src="a.png">');
    });

    it('keeps the raw HTML documents use', () => {
        expect(sanitizeHtml('<details><summary>More</summary>body</details>')).toBe('<details><summary>More</summary>body</details>');
    });
});
