import {
    AssistantStatus, assistantFolderName, assistantUnavailableMessage, assistantVsixName, parseAssistantsManifest, progressLine
} from './desktop-assistants';

const SHA = 'a'.repeat(64);
const good = {
    id: 'Anthropic.claude-code', label: 'Claude Code', version: '2.1.227', target: 'win32-x64',
    url: 'https://open-vsx.org/api/Anthropic/claude-code/win32-x64/2.1.227/file/Anthropic.claude-code-2.1.227@win32-x64.vsix',
    sha256: SHA.toUpperCase(),
};

describe('parseAssistantsManifest', () => {
    it('takes a manifest as the workflow writes it, ids and digests lower case', () => {
        const { pins, rejected } = parseAssistantsManifest({ assistants: [good] });
        expect(rejected).toEqual([]);
        expect(pins).toEqual([{ ...good, id: 'anthropic.claude-code', sha256: SHA }]);
    });

    it('drops entries that could fetch something else or write outside the plugins folder', () => {
        const { pins, rejected } = parseAssistantsManifest({
            assistants: [
                good,
                { ...good },                                    // a second claude-code
                { ...good, id: '../evil.x' },
                { ...good, id: 'openai.chatgpt', version: '../1' },
                { ...good, id: 'openai.chatgpt', url: 'http://open-vsx.org/x.vsix' },
                { ...good, id: 'openai.chatgpt', sha256: 'abc' },
                null,
            ],
        });
        expect(pins.map(p => p.id)).toEqual(['anthropic.claude-code']);
        expect(rejected).toHaveLength(6);
    });

    it('says so when there is no list at all', () => {
        expect(parseAssistantsManifest({}).rejected).toEqual(['the manifest has no list of assistants']);
    });

    it('falls back to the id for a label', () => {
        expect(parseAssistantsManifest([{ ...good, label: ' ' }]).pins[0].label).toBe('anthropic.claude-code');
    });
});

describe('names on disk', () => {
    it('keeps one folder per pinned version', () => {
        expect(assistantFolderName({ id: 'openai.chatgpt', version: '26.5730.61309' })).toBe('openai.chatgpt-26.5730.61309');
    });

    it('names a hand-placed VSIX the way the download is named', () => {
        expect(assistantVsixName({ ...good, id: 'anthropic.claude-code' })).toBe('Anthropic.claude-code-2.1.227@win32-x64.vsix');
        expect(assistantVsixName({ id: 'openai.chatgpt', version: '1.0.0', target: 'win32-x64' })).toBe('openai.chatgpt-1.0.0@win32-x64.vsix');
    });
});

describe('what the member reads', () => {
    const status = (extra: Partial<AssistantStatus>): AssistantStatus => ({ id: 'openai.chatgpt', label: 'Codex', version: '1', state: 'ready', ...extra });

    it('says an assistant is on its way rather than not available', () => {
        expect(assistantUnavailableMessage('Codex', status({ state: 'downloading', percent: 37 })))
            .toBe('Codex is downloading (37 %). It opens here once it is installed.');
        expect(assistantUnavailableMessage('Codex', status({ state: 'downloading' }))).toMatch(/^Codex is downloading\. /);
        expect(assistantUnavailableMessage('Codex', status({ state: 'installing' }))).toMatch(/being installed/);
        expect(assistantUnavailableMessage('Codex', status({ state: 'missing' }))).toMatch(/not downloaded yet/);
    });

    it('says what failed', () => {
        expect(assistantUnavailableMessage('Codex', status({ state: 'failed', error: 'open-vsx.org could not be reached (offline)' })))
            .toBe('Codex could not be installed: open-vsx.org could not be reached (offline).');
    });

    it('adds nothing when it is ready or not one the desktop fetches', () => {
        expect(assistantUnavailableMessage('Codex', status({ state: 'ready' }))).toBeUndefined();
        expect(assistantUnavailableMessage('Codex', undefined)).toBeUndefined();
    });

    it('shows progress for the first one still on its way', () => {
        expect(progressLine([status({ state: 'ready' }), status({ label: 'Claude Code', version: '2', state: 'downloading', percent: 5 })]))
            .toEqual({ text: 'Downloading Claude Code 2…', percent: 5 });
        expect(progressLine([status({ state: 'installing' })])).toEqual({ text: 'Installing Codex…' });
        expect(progressLine([status({ state: 'ready' }), status({ state: 'failed' })])).toBeUndefined();
    });
});
