import { ago, lastDeployLine, repoLine } from './desktop-open-card';

describe('the open project card', () => {
    const files = (n: number) => ({ resources: Array.from({ length: n }, (_, i) => i) });

    it('reads a checkout\'s branch, its uncommitted files and how far it is from its remote', () => {
        expect(repoLine({
            rootUri: 'file:///c%3A/ws/Gears%20workspace%20-%20Studio-web/studio-web',
            groups: [files(2), files(1)],
            statusBarCommands: [{ title: '$(git-branch) main*' }, { title: '$(sync) 2↓ 0↑' }],
        })).toEqual({ name: 'studio-web', branch: 'main', changes: 3, behind: 2, ahead: 0 });
    });

    it('says less when the SCM says less', () => {
        expect(repoLine({ rootUri: 'file:///ws/shop/', groups: [] })).toEqual({ name: 'shop', branch: undefined, changes: 0 });
        expect(repoLine({ rootUri: 'file:///ws/shop', groups: [], statusBarCommands: [{ title: '$(git-branch) feature/x' }, { title: '$(cloud-upload)' }] }))
            .toEqual({ name: 'shop', branch: 'feature/x', changes: 0 });
    });

    it('puts the last deploy in one line, a preview not counted', () => {
        const now = Date.parse('2026-10-30T12:00:00Z');
        expect(lastDeployLine([
            { state: 'succeeded', environment_name: 'dev', preview: { name: 'pr-1' }, requested_at: '2026-10-30T11:59:00Z' },
            { state: 'failed', environment_name: 'dev', chart_version: '0.1.0', requested_at: '2026-10-30T10:00:00Z' },
        ], now)).toEqual({ text: 'Failed in dev · 0.1.0 · 2 h ago', failed: true });
        expect(lastDeployLine([{ state: 'succeeded', environment_name: 'prod', requested_at: '2026-10-27T12:00:00Z' }], now))
            .toEqual({ text: 'Runs in prod · 3 d ago', failed: false });
        expect(lastDeployLine([], now)).toBeUndefined();
    });

    it('says how long ago in the largest unit that fits', () => {
        const now = Date.parse('2026-10-30T12:00:00Z');
        expect(ago('2026-10-30T11:59:40Z', now)).toBe('1 min ago');
        expect(ago('2026-10-30T11:15:00Z', now)).toBe('45 min ago');
        expect(ago(undefined, now)).toBe('');
    });
});
