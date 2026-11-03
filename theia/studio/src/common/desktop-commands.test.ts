import { planCommand } from './desktop-commands';

const open = (params: Record<string, unknown>) => planCommand({ commandId: 'c1', command: 'open_in_editor', params });

describe('a command the portal sent a desktop window', () => {
    it('opens a file of the workspace, tidying its path', () => {
        expect(open({ relativePath: 'docs/spec.md' })).toEqual({ kind: 'open', relativePath: 'docs/spec.md', preview: false });
        expect(open({ relativePath: ' ./docs\\\\spec.md ', preview: true })).toEqual({ kind: 'open', relativePath: 'docs/spec.md', preview: true });
    });

    it('never opens a place outside the workspace', () => {
        for (const relativePath of ['/etc/passwd', 'C:/Windows/win.ini', 'c:\\\\x', '../secrets', 'docs/../../x']) {
            expect(open({ relativePath }).kind).toBe('refuse');
        }
    });

    it('says what is missing or unknown', () => {
        expect(open({})).toEqual({ kind: 'refuse', detail: 'no relativePath to open' });
        expect(open({ relativePath: './' })).toEqual({ kind: 'refuse', detail: 'no relativePath to open' });
        expect(planCommand({ commandId: 'c', command: 'enqueue_operation', params: {} })).toMatchObject({
            kind: 'refuse',
            detail: expect.stringMatching(/no operation queue/),
        });
        expect(planCommand({ commandId: 'c', command: 'format_disk', params: {} })).toEqual({
            kind: 'refuse',
            detail: 'a desktop does not know the command format_disk',
        });
    });
});
