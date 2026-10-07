import type { ShareDocument, ShareRepository } from '../../common/document-share-protocol';
import { coAuthorsOf, defaultMessage, describeOutcome, isMine, repositoryRootOf, sameFolder, splitDocuments, unsharedCount } from './share-model';

const inReview = (d: ShareDocument): ShareDocument => ({ ...d, inReview: true });
const committed = (d: ShareDocument): ShareDocument => ({ ...d, committed: true });

function document(path: string, title: string, editors: string[] = [], state: ShareDocument['state'] = 'modified'): ShareDocument {
    return { path, uri: `file:///w/${path}`, state, title, editors, companions: [] };
}

const ALICE = { name: 'Alice' };

describe('share model', () => {
    it('counts a document as mine when I edited it, or when nobody is recorded', () => {
        expect(isMine(document('a.md', 'A', ['Alice', 'Bob']), ALICE)).toBe(true);
        expect(isMine(document('b.md', 'B'), ALICE)).toBe(true);
        expect(isMine(document('c.md', 'C', ['Bob']), ALICE)).toBe(false);
        expect(isMine(document('c.md', 'C', ['Bob']), undefined)).toBe(false);
    });

    it('splits a repository into mine and others', () => {
        const repository: ShareRepository = { root: 'file:///w', name: 'w', unsent: 0, documents: [document('a.md', 'A', ['Alice']), document('c.md', 'C', ['Bob'])] };
        const { mine, others } = splitDocuments(repository, ALICE);
        expect(mine.map(d => d.path)).toEqual(['a.md']);
        expect(others.map(d => d.path)).toEqual(['c.md']);
    });

    it('keeps what is already in my pull request apart, and does not count it', () => {
        const repository: ShareRepository = { root: 'file:///w', name: 'w', unsent: 0, documents: [document('a.md', 'A', ['Alice']), inReview(document('b.md', 'B'))] };
        const { mine, others, inReview: proposed } = splitDocuments(repository, ALICE);
        expect(mine.map(d => d.path)).toEqual(['a.md']);
        expect(others).toEqual([]);
        expect(proposed.map(d => d.path)).toEqual(['b.md']);
        expect(unsharedCount([repository])).toBe(1);
    });

    it('lists what was committed and not sent to choose through review, and leaves it to the branch\'s share otherwise', () => {
        const repository: ShareRepository = {
            root: 'file:///w', name: 'w', unsent: 2,
            documents: [committed(document('a.md', 'A', ['Alice'])), committed(document('c.md', 'C', ['Bob'])), document('d.md', 'D')],
        };
        const reviewed = splitDocuments(repository, ALICE, true);
        expect(reviewed.mine.map(d => d.path)).toEqual(['a.md', 'd.md']);
        expect(reviewed.others.map(d => d.path)).toEqual(['c.md']);
        const straight = splitDocuments(repository, ALICE);
        expect(straight.mine.map(d => d.path)).toEqual(['d.md']);
        expect(straight.others).toEqual([]);
    });

    it('counts committed documents, and nothing more once they are in the pull request', () => {
        const pending: ShareRepository = { root: '1', name: '1', unsent: 2, documents: [committed(document('a.md', 'A')), committed(document('b.md', 'B'))] };
        expect(unsharedCount([pending])).toBe(2);
        const sent: ShareRepository = { ...pending, documents: pending.documents.map(inReview) };
        expect(unsharedCount([sent])).toBe(0);
    });

    it('says a pull request is the plan, and when it could not be opened', () => {
        expect(describeOutcome({ kind: 'review', branch: 'studio/alice/share', reviewUrl: 'https://x/pull/1' }, 2, true))
            .toEqual({ level: 'info', text: 'Your 2 documents are in your pull request, for the team to review.' });
        expect(describeOutcome({ kind: 'review', branch: 'studio/alice/share', detail: 'error: HTTP 400' }, 1, true))
            .toEqual({ level: 'warn', text: 'Your document is on "studio/alice/share", but the pull request could not be opened. (HTTP 400)' });
    });

    it('starts the message from the titles', () => {
        expect(defaultMessage([document('a.md', 'Spec findings')])).toBe('Update Spec findings');
        expect(defaultMessage([document('a.md', 'A', [], 'added'), document('b.md', 'B', [], 'added')])).toBe('Add A, B');
        expect(defaultMessage(['A', 'B', 'C', 'D', 'E'].map(t => document(`${t}.md`, t)))).toBe('Update A, B, C and 2 more');
        expect(defaultMessage([])).toBe('');
    });

    it('names the colleagues whose edits go along, once each, not me', () => {
        expect(coAuthorsOf([document('a.md', 'A', ['Alice', 'Bob']), document('b.md', 'B', ['Bob', 'Carol'])], ALICE))
            .toEqual([{ name: 'Bob' }, { name: 'Carol' }]);
    });

    it('counts what is not shared, a committed-but-unsent share included', () => {
        expect(unsharedCount([
            { root: '1', name: '1', unsent: 0, documents: [document('a.md', 'A'), document('b.md', 'B')] },
            { root: '2', name: '2', unsent: 1, documents: [] },
            { root: '3', name: '3', unsent: 0, documents: [] },
        ])).toBe(3);
    });

    it('says every outcome without git words', () => {
        const kinds = ['shared', 'review', 'conflict', 'sign-in', 'offline', 'nothing', 'failed'] as const;
        for (const kind of kinds) {
            const said = describeOutcome({ kind, branch: 'studio/alice/1', detail: 'fatal: something broke' }, 2);
            expect(said.text).not.toMatch(/\b(commit|push|rebase|pull|upstream|HEAD)\b/i);
        }
        expect(describeOutcome({ kind: 'shared' }, 1).text).toBe('Your document is shared with the team.');
        expect(describeOutcome({ kind: 'failed', detail: 'fatal: something broke\nmore' }, 1).text).toBe('Your changes could not be shared. (something broke)');
    });
});

describe('Share from Source Control', () => {
    it('shares the repository a row\'s menu was opened on, else the one the view shows', () => {
        expect(repositoryRootOf({ provider: { rootUri: 'file:///workspace/a' } }, 'file:///workspace/b')).toBe('file:///workspace/a');
        // The title bar passes the view itself.
        expect(repositoryRootOf({ id: 'scm-view' }, 'file:///workspace/b')).toBe('file:///workspace/b');
        expect(repositoryRootOf(undefined, undefined)).toBeUndefined();
    });

    it('matches a repository by its folder, whatever the trailing slash or escaping', () => {
        expect(sameFolder('file:///workspace/studio-web', 'file:///workspace/studio-web/')).toBe(true);
        expect(sameFolder('file:///workspace/my%20docs', 'file:///workspace/my docs')).toBe(true);
        expect(sameFolder('file:///workspace/a', 'file:///workspace/ab')).toBe(false);
    });
});
