import { clonePercent, describeOpenProgress, parseGitProgress, type OpenProgress } from './desktop-open-progress';

describe('reading git clone --progress', () => {
    it('takes the stage and its percentage, with or without the remote prefix', () => {
        expect(parseGitProgress('remote: Counting objects:  45% (9/20)')).toEqual({ stage: 'Counting objects', percent: 45 });
        expect(parseGitProgress('Receiving objects:  45% (123/456), 1.20 MiB | 3.00 MiB/s')).toEqual({ stage: 'Receiving objects', percent: 45 });
        expect(parseGitProgress('Resolving deltas: 100% (80/80), done.')).toEqual({ stage: 'Resolving deltas', percent: 100 });
    });

    it('ignores what is not progress', () => {
        expect(parseGitProgress("Cloning into 'gears-rust'...")).toBeUndefined();
        expect(parseGitProgress('fatal: unable to access …: The requested URL returned error: 403')).toBeUndefined();
        expect(parseGitProgress('')).toBeUndefined();
    });

    it('puts each stage in its share of one bar, the download taking most of it', () => {
        expect(clonePercent('Counting objects', 100)).toBe(5);
        expect(clonePercent('Receiving objects', 0)).toBe(5);
        expect(clonePercent('Receiving objects', 100)).toBe(80);
        expect(clonePercent('Resolving deltas', 100)).toBe(95);
        expect(clonePercent('Updating files', 100)).toBe(100);
        expect(clonePercent('Something new', 50)).toBeUndefined();
    });
});

describe('the sentence under an opening project', () => {
    const base = { workspaceId: 'p-1', name: 'Gears-Rust' };

    it('says what it is doing, and which of several sources', () => {
        expect(describeOpenProgress({ ...base, phase: 'listing', sources: [] })).toBe('Finding its sources…');
        const two: OpenProgress = {
            ...base,
            phase: 'cloning',
            sources: [
                { name: 'docs', state: 'present' },
                { name: 'api', state: 'done' },
                { name: 'web', state: 'cloning', stage: 'Receiving objects', percent: 40 },
            ],
        };
        expect(describeOpenProgress(two)).toBe('Cloning 2 of 2: web · Receiving objects');
        expect(describeOpenProgress({ ...base, phase: 'cloning', sources: [{ name: 'gears-rust', state: 'cloning' }] }))
            .toBe('Cloning gears-rust');
    });

    it('says so when nothing needs cloning', () => {
        expect(describeOpenProgress({ ...base, phase: 'cloning', sources: [{ name: 'api', state: 'present' }] }))
            .toBe('Everything is on disk already; opening…');
    });
});
