// The worktree list of a member's own Orca: seven worktrees of two other
// repositories, two of them `main`, while a third project was open in Studio
// (the payload is trimmed from Orca 1.4.211's `worktree list --json`).

import type { OrcaRepository, OrcaWorktree } from './orca-protocol';
import { defaultWorktree, groupWorktrees, isWithin, normalizePath, repositoryInProject } from './orca-worktree-groups';

const wt = (repoId: string, path: string, branch: string, isMain = false, displayName = branch): OrcaWorktree => ({
    id: `${repoId}::${path}`,
    repoId,
    path,
    branch,
    displayName,
    comment: '',
    status: 'in-progress',
    isMain
});

const repos: OrcaRepository[] = [
    { id: 'main-repo', path: 'C:/Repos/CFS/studio-web-main', displayName: 'studio-web-main' },
    { id: 'fork', path: 'C:/Repos/CFS/studio-web-kuchma', displayName: 'studio-web-kuchma' }
];
const worktrees: OrcaWorktree[] = [
    wt('main-repo', 'C:/Repos/CFS/studio-web-main', 'main', true),
    wt('main-repo', 'C:/Users/m/orca/workspaces/studio-web-main/Contract', 'AndrejK666/error-contract'),
    wt('fork', 'C:/Repos/CFS/studio-web-kuchma', 'main', true),
    wt('fork', 'C:/Users/m/orca/workspaces/studio-web-kuchma/GearBox', '', false, 'GearBox'),
    wt('fork', 'C:/Users/m/orca/workspaces/studio-web-kuchma/demo', 'AndrejK666/studio-git-corpus')
];

describe('paths', () => {
    it('compares a Windows path however it is spelled', () => {
        expect(normalizePath('c:\\Repos\\X\\')).toBe(normalizePath('C:/Repos/X'));
        expect(normalizePath('/home/m/x/')).toBe('/home/m/x');
        expect(normalizePath('/home/M')).not.toBe(normalizePath('/home/m'));
    });

    it('knows inside from beside', () => {
        expect(isWithin('/w/src/a', '/w/src')).toBe(true);
        expect(isWithin('/w/src', '/w/src')).toBe(true);
        expect(isWithin('/w/src-other', '/w/src')).toBe(false);
    });

    it('takes a repository in the project folder, or a project folder inside a repository', () => {
        expect(repositoryInProject('/home/m/ConstructorStudio/workspaces/p/web', '/home/m/ConstructorStudio/workspaces/p')).toBe(true);
        expect(repositoryInProject('/src/web', '/src/web/docs')).toBe(true);
        expect(repositoryInProject('/src/web', '/src/api')).toBe(false);
        expect(repositoryInProject('/src/web', undefined)).toBe(false);
    });
});

describe('grouping worktrees by repository', () => {

    it('gives each repository its own group, so two `main` rows are told apart', () => {
        const groups = groupWorktrees(worktrees, repos, undefined);
        expect(groups.map(g => g.name)).toEqual(['studio-web-kuchma', 'studio-web-main']);
        for (const group of groups) {
            expect(group.worktrees[0].isMain).toBe(true);
            expect(group.worktrees[0].branch).toBe('main');
        }
    });

    it('puts the open project\'s repository first', () => {
        const groups = groupWorktrees(worktrees, repos, 'c:\\Repos\\CFS\\studio-web-main');
        expect(groups[0].name).toBe('studio-web-main');
        expect(groups[0].inProject).toBe(true);
        expect(groups[1].inProject).toBe(false);
    });

    it('marks no group as the project\'s when the project is another repository', () => {
        const groups = groupWorktrees(worktrees, repos, 'C:\\Users\\m\\ConstructorStudio\\workspaces\\other');
        expect(groups.every(g => !g.inProject)).toBe(true);
    });

    it('names a repository Orca did not list by its main checkout\'s folder', () => {
        const groups = groupWorktrees([wt('lost', '/src/api', 'main', true)], [], undefined);
        expect(groups[0].name).toBe('api');
    });

    it('keeps worktrees an older runtime reported without a repository', () => {
        const legacy: OrcaWorktree = { ...wt('', '/workspace/web', 'main', true), repoId: undefined };
        const groups = groupWorktrees([legacy], [], '/workspace');
        expect(groups).toHaveLength(1);
        expect(groups[0].inProject).toBe(true);
    });
});

describe('the worktree selected by default', () => {

    it('is the one the IDE is open in, when Orca says so', () => {
        const current = worktrees[3];
        expect(defaultWorktree(groupWorktrees(worktrees, repos, undefined), current, undefined)).toBe(current);
    });

    it('is the open project\'s, never another repository\'s', () => {
        const groups = groupWorktrees(worktrees, repos, 'C:\\Repos\\CFS\\studio-web-main');
        expect(defaultWorktree(groups, undefined, 'C:\\Repos\\CFS\\studio-web-main')?.repoId).toBe('main-repo');
    });

    it('is none when the open project is not in Orca', () => {
        const groups = groupWorktrees(worktrees, repos, '/elsewhere');
        expect(defaultWorktree(groups, undefined, '/elsewhere')).toBeUndefined();
    });
});
