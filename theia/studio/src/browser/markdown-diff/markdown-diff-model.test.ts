import { countChanges, diffMarkdown, parseMarkdown, similarity } from './markdown-diff-model';
import { createMarkdownRenderer } from './markdown-diff-render';

const md = createMarkdownRenderer();

function rows(before: string, after: string): Array<[string, string | undefined, string | undefined]> {
    return diffMarkdown(parseMarkdown(md, before), parseMarkdown(md, after))
        .map(row => [row.kind, row.old?.source, row.new?.source]);
}

describe('parseMarkdown', () => {
    it('cuts a document at its top-level blocks and keeps their source', () => {
        const doc = parseMarkdown(md, '# Title\n\nFirst paragraph\nstill first.\n\n```ts\nconst a = 1;\n```\n');
        expect(doc.blocks.map(block => [block.kind, block.source, block.line])).toEqual([
            ['heading:h1', '# Title', 0],
            ['paragraph', 'First paragraph\nstill first.', 2],
            ['fence', '```ts\nconst a = 1;\n```', 5],
        ]);
    });

    it('makes every list item its own block, numbered as in its list', () => {
        const doc = parseMarkdown(md, '3. three\n4. four\n');
        expect(doc.blocks.map(block => block.kind)).toEqual(['list_item:ordered', 'list_item:ordered']);
        expect(md.renderer.render(doc.blocks[1].tokens, md.options, doc.env)).toContain('<ol start="4">');
    });

    it('keeps front matter as one block and line numbers as the file has them', () => {
        const doc = parseMarkdown(md, '---\ntitle: x\n---\n\nBody\n');
        expect(doc.blocks.map(block => [block.kind, block.line])).toEqual([['front_matter', 0], ['paragraph', 4]]);
    });

    it('reads CRLF documents like LF ones', () => {
        expect(parseMarkdown(md, 'a\r\n\r\nb\r\n').blocks.map(block => block.source)).toEqual(['a', 'b']);
    });

    it('lets a block render a reference link defined elsewhere in its document', () => {
        const doc = parseMarkdown(md, 'See [docs][d].\n\n[d]: https://example.com\n');
        expect(md.renderer.render(doc.blocks[0].tokens, md.options, doc.env)).toContain('href="https://example.com"');
    });
});

describe('diffMarkdown', () => {
    it('reports nothing for equal documents, trailing spaces aside', () => {
        expect(rows('a  \n\nb\n', 'a\n\nb').map(row => row[0])).toEqual(['equal', 'equal']);
    });

    it('pairs an edited paragraph with what it became', () => {
        expect(rows('Intro\n\nThe quick brown fox.\n', 'Intro\n\nThe quick red fox.\n')).toEqual([
            ['equal', 'Intro', 'Intro'],
            ['modified', 'The quick brown fox.', 'The quick red fox.'],
        ]);
    });

    it('shows an inserted list item as added, not the whole list as changed', () => {
        expect(rows('- one\n- three\n', '- one\n- two\n- three\n')).toEqual([
            ['equal', '- one', '- one'],
            ['added', undefined, '- two'],
            ['equal', '- three', '- three'],
        ]);
    });

    it('puts a rewrite with nothing in common beside what it replaced, unpaired', () => {
        expect(rows('Alpha beta gamma.\n', 'Completely different words here.\n').map(row => row[0])).toEqual(['replaced']);
    });

    it('does not pair blocks of different kinds', () => {
        expect(rows('Setup steps\n', '## Setup steps\n').map(row => row[0])).toEqual(['replaced']);
    });

    it('finds the counterpart of an edited block far into a rewritten section', () => {
        const filler = Array.from({ length: 10 }, (_, i) => `Unrelated new paragraph number ${i} about ${'x'.repeat(i + 1)}.`).join('\n\n');
        const before = '# Old heading\n\nThe detectors are not deterministic, so a finding missing from one run has not been fixed.\n';
        const after = `# New heading\n\n${filler}\n\nThe detectors are not deterministic, so a finding missing from one run has not been fixed today.\n`;
        const result = rows(before, after);
        expect(result.filter(row => row[0] === 'modified').map(row => row[1])).toEqual([
            '# Old heading',
            'The detectors are not deterministic, so a finding missing from one run has not been fixed.',
        ]);
        expect(result.slice(1, 11).every(row => row[0] === 'added')).toBe(true);
    });

    it('keeps an addition before the edit it precedes', () => {
        expect(rows('A\n\nThe old sentence stays mostly.\n', 'A\n\nNew paragraph.\n\nThe old sentence stays mostly here.\n')).toEqual([
            ['equal', 'A', 'A'],
            ['added', undefined, 'New paragraph.'],
            ['modified', 'The old sentence stays mostly.', 'The old sentence stays mostly here.'],
        ]);
    });

    it('marks every block added for a new file and removed for a deleted one', () => {
        expect(rows('', '# T\n\nx\n').map(row => row[0])).toEqual(['added', 'added']);
        expect(rows('# T\n\nx\n', '').map(row => row[0])).toEqual(['removed', 'removed']);
    });

    it('counts the changes by kind', () => {
        const result = diffMarkdown(parseMarkdown(md, 'a b c\n\nx\n'), parseMarkdown(md, 'a b d\n\ny\n\nz\n'));
        expect(countChanges(result)).toEqual({ modified: 1, added: 2, removed: 1 });
    });
});

describe('similarity', () => {
    it('is 1 for equal texts and 0 for disjoint ones', () => {
        expect(similarity('same', 'same')).toBe(1);
        expect(similarity('alpha', 'omega')).toBe(0);
        expect(similarity('one two three', 'one two four')).toBeGreaterThan(0.5);
    });
});
