import {
    parseGitRemoteCoordinates,
    resolveRemoteCheckoutRelativePath
} from './git-remote-reference';

describe('git remote checkout references', () => {
    it.each([
        ['git@github.com:constructorfabric/studio.git', 'github.com', 'constructorfabric', 'studio'],
        ['https://github.com/constructorfabric/ai-courses.git', 'github.com', 'constructorfabric', 'ai-courses'],
        ['ssh://git@git.acronis.com:7989/real/cyber-repo.git', 'git.acronis.com', 'real', 'cyber-repo'],
        ['https://gitlab.com/group/subgroup/repo.git', 'gitlab.com', 'group/subgroup', 'repo']
    ])('extracts owner and repository from %s', (remoteUrl, host, org, repo) => {
        expect(parseGitRemoteCoordinates(remoteUrl)).toEqual({ host, org, repo });
    });

    it('defaults remote checkouts to owner/repository below resolve.workdir', () => {
        expect(resolveRemoteCheckoutRelativePath(
            'git@github.com:constructorfabric/studio.git',
            'studio'
        )).toBe('constructorfabric/studio');
    });

    it('applies an exact-host namespace template', () => {
        expect(resolveRemoteCheckoutRelativePath(
            'https://gitlab.example.com/group/repo.git',
            'repo',
            { 'gitlab.example.com': 'mirrors/{org}/{repo}' }
        )).toBe('mirrors/group/repo');
    });

    it('falls back to the source id when coordinates cannot be extracted', () => {
        expect(resolveRemoteCheckoutRelativePath('not-a-remote', 'AI Courses')).toBe('AI-Courses');
    });
});
