import { preserveUnchangedBlocks } from './markdown-preserve';

describe('preserveUnchangedBlocks', () => {
    const original = [
        '# Spec findings',
        '',
        'What Studio reports about a specification document, where in the text it',
        'is, and what a person can do with it.',
        '',
        '| Rule   | Gate |',
        '|--------|------|',
        '| purpose | yes |',
        '',
        '* first',
        '* second',
        '',
        'The paragraph somebody edits.',
        '',
    ].join('\n');

    it('keeps the file\'s own spelling of every block that renders the same', () => {
        // What a serializer that unwraps, pads tables its own way and prefers "-" writes.
        const serialized = [
            '# Spec findings',
            '',
            'What Studio reports about a specification document, where in the text it is, and what a person can do with it.',
            '',
            '| Rule | Gate |',
            '| --- | --- |',
            '| purpose | yes |',
            '',
            '* first',
            '* second',
            '',
            'The paragraph somebody edited, with a new clause.',
            '',
        ].join('\n');
        const saved = preserveUnchangedBlocks(original, serialized);
        expect(saved).toBe(original.replace('The paragraph somebody edits.', 'The paragraph somebody edited, with a new clause.'));
    });

    it('lets an edited block out as the serializer wrote it', () => {
        const serialized = original.replace('purpose | yes', 'purpose | no');
        expect(preserveUnchangedBlocks(original, serialized)).toContain('| purpose | no |');
    });

    it('keeps a list\'s own bullet, for an added item too, so the list stays one list', () => {
        // The WYSIWYG serializer writes every bullet as "-"; the file uses "*".
        const serialized = original.replace('* first\n* second', '- first\n- second, edited\n- third');
        const saved = preserveUnchangedBlocks(original, serialized);
        expect(saved).toContain('* first\n* second, edited\n* third');
        expect(saved).not.toContain('- ');
    });

    it('leaves a list nobody kept anything of as the serializer wrote it', () => {
        expect(preserveUnchangedBlocks('* a\n* b\n', '- x\n- y\n')).toBe('- x\n- y\n');
    });

    it('gives nested lists their own bullet, not the outer one\'s', () => {
        const before = '- outer\n\n  * inner one\n  * inner two\n\n- second\n';
        const after = '* outer\n\n  * inner one\n  * inner two\n\n* second, edited\n';
        expect(preserveUnchangedBlocks(before, after)).toBe('- outer\n\n  * inner one\n  * inner two\n\n- second, edited\n');
    });

    it('keeps the original line endings', () => {
        const crlf = 'A paragraph\nwrapped.\n\nAnother.\n'.replace(/\n/g, '\r\n');
        expect(preserveUnchangedBlocks(crlf, 'A paragraph wrapped.\n\nAnother, edited.\n'))
            .toBe('A paragraph\r\nwrapped.\r\n\r\nAnother, edited.\r\n');
    });

    it('adds and removes blocks around the ones it keeps', () => {
        const before = 'One\nwrapped.\n\nTwo.\n\nThree\nwrapped.\n';
        const after = 'One wrapped.\n\nNew block.\n\nThree wrapped.\n';
        expect(preserveUnchangedBlocks(before, after)).toBe('One\nwrapped.\n\nNew block.\n\nThree\nwrapped.\n');
    });

    it('returns the text unchanged when there is nothing to compare with', () => {
        expect(preserveUnchangedBlocks('', 'New file.\n')).toBe('New file.\n');
        expect(preserveUnchangedBlocks('Same.\n', 'Same.\n')).toBe('Same.\n');
    });
});
