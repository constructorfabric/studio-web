// What matters here: we read Orca's payloads correctly, and we read them
// defensively. The fixtures are trimmed copies of real output from a live
// runtime (Orca 1.4.197, `--json`), not invented shapes.

import {
    OrcaServiceImpl,
    shortBranch,
    terminalTail,
    toTerminal,
    toWaitOutcome,
    toWorktree
} from './orca-service';
import { OrcaCliError } from './orca-cli';
import { parseEnvelope, describeError, candidateBinaries } from './orca-cli';

describe('orca payload mapping', () => {

    // Trimmed from `orca worktree list --json`.
    const worktreeRow = {
        id: '6e2af3f5::C:/Repos/CFS/studio-web-main',
        instanceId: 'dfee4684-b867-4213-a68b-0d8d21d454fa',
        repoId: '6e2af3f5',
        projectId: 'github:constructorfabric/studio-web',
        path: 'C:/Repos/CFS/studio-web-main',
        head: '3a067495',
        branch: 'refs/heads/main',
        isMainWorktree: true,
        displayName: 'main',
        comment: '',
        linkedGitLabMR: null,
        sortOrder: 1788838655832,
        lastActivityAt: 1788429527540,
        workspaceStatus: 'in-progress'
    };

    it('keeps the fields the panel renders and drops the rest', () => {
        const worktree = toWorktree(worktreeRow);
        expect(worktree).toEqual({
            id: '6e2af3f5::C:/Repos/CFS/studio-web-main',
            path: 'C:/Repos/CFS/studio-web-main',
            branch: 'main',
            displayName: 'main',
            comment: '',
            status: 'in-progress',
            isMain: true,
            lastActivityAt: 1788429527540
        });
    });

    it('accepts the id under either name the two commands use', () => {
        // `worktree ps` says worktreeId where `worktree list` says id.
        expect(toWorktree({ worktreeId: 'wt-1', path: '/w' }).id).toBe('wt-1');
        expect(toWorktree({ id: 'wt-2', path: '/w' }).id).toBe('wt-2');
    });

    it('falls back to something visible when a name is missing', () => {
        const worktree = toWorktree({ id: 'x', path: '/w/feature', branch: 'refs/heads/feature' });
        expect(worktree.displayName).toBe('feature');
        expect(toWorktree({ id: 'x', path: '/w/only-path' }).displayName).toBe('/w/only-path');
        expect(worktree.status).toBe('unknown');
    });

    it('shortens a ref but leaves anything else alone', () => {
        expect(shortBranch('refs/heads/feat/gts')).toBe('feat/gts');
        expect(shortBranch('detached@abc123')).toBe('detached@abc123');
        expect(shortBranch('')).toBe('');
    });

    // Trimmed from `orca terminal list --worktree active --json`.
    it('reads a terminal, including which agent is in it', () => {
        const terminal = toTerminal({
            handle: 'term_30b442cb',
            ptyId: '6e2af3f5::C:/w@@e004437d',
            worktreePath: 'C:/w',
            branch: 'refs/heads/feat/gts',
            title: '◑ GTS resolution in type registry',
            connected: true,
            writable: true,
            lastOutputAt: 1788838962188,
            preview: 'Calculating…',
            agentIdentity: 'claude'
        });
        expect(terminal.handle).toBe('term_30b442cb');
        expect(terminal.agent).toBe('claude');
        expect(terminal.connected).toBe(true);
        expect(terminal.preview).toBe('Calculating…');
    });

    it('reports no agent rather than an empty one', () => {
        expect(toTerminal({ handle: 'term_1' }).agent).toBeUndefined();
        expect(toTerminal({ handle: 'term_1' }).warning).toBeUndefined();
    });

    it('keeps the warning a headless runtime attaches to a new terminal', () => {
        // Real text from `terminal create` against `orca serve`: the process
        // runs, but with no UI to adopt the tab it stays on a background
        // surface. The panel shows this instead of reading it as a failure.
        const terminal = toTerminal({
            handle: 'term_0ba28a76',
            title: null,
            surface: 'background',
            warning: 'Terminal term_0ba28a76 is running, but Orca could not make it discoverable.'
        });
        expect(terminal.warning).toMatch(/could not make it discoverable/);
        // No title yet: fall back to something the panel can render.
        expect(terminal.title).toBe('term_0ba28a76');
    });
});

describe('terminal output', () => {

    // Trimmed from a real `orca terminal read --terminal ... --json` inside a
    // session container: the lines are nested under result.terminal.tail.
    it('reads the nested tail the runtime actually returns', () => {
        expect(
            terminalTail({
                terminal: {
                    handle: 'term_fef2188c',
                    status: 'running',
                    tail: [
                        'node@host:/workspace$bash',
                        'node@host:/workspace$echo studio-orca-prototype-42',
                        'studio-orca-prototype-42',
                        'node@host:/workspace$'
                    ],
                    truncated: false,
                    latestCursor: '3'
                }
            })
        ).toContain('studio-orca-prototype-42');
    });

    it('falls back to the flatter shapes and never returns undefined', () => {
        expect(terminalTail({ tail: ['a', 'b'] })).toBe('a' + '\n' + 'b');
        expect(terminalTail({ lines: ['x'] })).toBe('x');
        expect(terminalTail({ terminal: { text: 'plain' } })).toBe('plain');
        expect(terminalTail({})).toBe('');
    });
});

describe('wait outcome', () => {

    it('recognizes idle and exit however the field is named', () => {
        expect(toWaitOutcome({ outcome: 'tui-idle' })).toBe('idle');
        expect(toWaitOutcome({ status: 'IDLE' })).toBe('idle');
        expect(toWaitOutcome({ idle: true })).toBe('idle');
        expect(toWaitOutcome({ outcome: 'exit' })).toBe('exit');
        expect(toWaitOutcome({ exited: true })).toBe('exit');
    });

    it('reads an unrecognized payload as still busy, never as idle', () => {
        // Believing "idle" too early types into a working TUI.
        expect(toWaitOutcome({})).toBe('timeout');
        expect(toWaitOutcome({ outcome: 'something-new' })).toBe('timeout');
    });
});

describe('the CLI envelope', () => {

    it('reads the result out of a success envelope', () => {
        const envelope = parseEnvelope('{"id":"1","ok":true,"result":{"worktrees":[]}}');
        expect(envelope?.ok).toBe(true);
    });

    it('survives noise printed before the payload', () => {
        // An update notice must not turn a successful command into a failure.
        const envelope = parseEnvelope('Update available!\n{"id":"1","ok":true,"result":{}}');
        expect(envelope?.ok).toBe(true);
    });

    it('is undefined for output that is not JSON at all', () => {
        expect(parseEnvelope('command not found')).toBeUndefined();
        expect(parseEnvelope('')).toBeUndefined();
    });

    it('picks the most specific message an error envelope carries', () => {
        expect(describeError({ ok: false, error: { message: 'no such worktree' } })).toBe('no such worktree');
        expect(describeError({ ok: false, error: 'plain string' })).toBe('plain string');
        expect(describeError({ ok: false, error: { code: 'ENOENT' } })).toBe('ENOENT');
        expect(describeError({ ok: false })).toMatch(/without a reason/);
    });
});

describe('binary resolution', () => {

    it('prefers ORCA_CLI over anything installed', () => {
        const candidates = candidateBinaries({ ORCA_CLI: '/opt/custom/orca' }, 'linux');
        expect(candidates[0]).toBe('/opt/custom/orca');
    });

    it('knows the desktop install path per platform and ends on PATH', () => {
        const win = candidateBinaries({ LOCALAPPDATA: 'C:/u/AppData/Local' }, 'win32');
        expect(win.some(c => c.endsWith('orca.exe'))).toBe(true);
        const mac = candidateBinaries({ HOME: '/Users/me' }, 'darwin');
        expect(mac.some(c => c.includes('Orca.app'))).toBe(true);
        // The Linux packages name the binary `orca-ide` (verified against
        // v1.4.197's amd64 deb: /opt/Orca/resources/bin/orca-ide, linked as
        // /usr/bin/orca-ide), so looking only for `orca` finds nothing.
        const linux = candidateBinaries({}, 'linux');
        expect(linux).toContain('/opt/Orca/resources/bin/orca-ide');
        expect(linux).toContain('/usr/bin/orca-ide');
        // The bare names are last: PATH is the case we can neither verify nor
        // blame precisely.
        expect(win.slice(-2)).toEqual(['orca', 'orca-ide']);
        expect(linux.slice(-2)).toEqual(['orca', 'orca-ide']);
    });
});

describe('OrcaServiceImpl', () => {

    function service(json: jest.Mock): OrcaServiceImpl {
        const impl = new OrcaServiceImpl();
        // The CLI is the only collaborator; inject a fake in its place.
        (impl as unknown as { cli: { json: jest.Mock } }).cli = { json };
        return impl;
    }

    it('reports an unreachable runtime instead of throwing', async () => {
        const json = jest.fn().mockRejectedValue(new OrcaCliError('the orca CLI was not found', [], ''));
        const status = await service(json).status();
        expect(status.reachable).toBe(false);
        expect(status.state).toBe('unreachable');
        expect(status.error).toMatch(/not found/);
    });

    it('maps a live status payload from a desktop host', async () => {
        const json = jest.fn().mockResolvedValue({
            app: { running: true, pid: 15948, desktopWindowStatus: 'available' },
            runtime: { state: 'ready', reachable: true, appVersion: '1.4.197' }
        });
        expect(await service(json).status()).toEqual({
            reachable: true,
            state: 'ready',
            appVersion: '1.4.197',
            desktopRunning: true
        });
    });

    it('does not call a headless runtime a desktop one', async () => {
        // `orca serve` in the session container answers running: true with
        // desktopWindowStatus: openable — a window it *could* open, not one
        // that is open. Reading that as "desktop" mislabels every session.
        const json = jest.fn().mockResolvedValue({
            app: { running: true, pid: 62, desktopWindowStatus: 'openable' },
            runtime: { state: 'ready', reachable: true, appVersion: '1.4.197' }
        });
        expect((await service(json).status()).desktopRunning).toBe(false);
    });

    it('falls back to the process flag when the window status is absent', async () => {
        const json = jest.fn().mockResolvedValue({
            app: { running: true },
            runtime: { state: 'ready', reachable: true }
        });
        expect((await service(json).status()).desktopRunning).toBe(true);
    });

    it('treats "no current worktree" as absence, not failure', async () => {
        const json = jest.fn().mockRejectedValue(new OrcaCliError('not an orca worktree', [], ''));
        await expect(service(json).currentWorktree()).resolves.toBeUndefined();
    });

    it('waits for the TUI to settle before typing a prompt into it', async () => {
        const calls: string[][] = [];
        const json = jest.fn().mockImplementation((args: string[]) => {
            calls.push(args);
            if (args[1] === 'create') {
                return Promise.resolve({ terminal: { handle: 'term_9', title: 'codex' } });
            }
            if (args[1] === 'wait') {
                return Promise.resolve({ outcome: 'tui-idle' });
            }
            return Promise.resolve({});
        });
        const terminal = await service(json).startAgent({
            worktree: 'active',
            agent: 'codex',
            prompt: 'fix the failing test'
        });
        expect(terminal?.handle).toBe('term_9');
        expect(calls.map(c => `${c[0]} ${c[1]}`)).toEqual([
            'terminal create',
            'terminal wait',
            'terminal send'
        ]);
        expect(calls[2]).toContain('--enter');
    });

    it('starts an agent without a prompt without waiting on anything', async () => {
        const json = jest.fn().mockResolvedValue({ terminal: { handle: 'term_1' } });
        await service(json).startAgent({ worktree: 'active', agent: 'claude' });
        expect(json).toHaveBeenCalledTimes(1);
    });

    it('reports a wait that ran out as a timeout, not an error', async () => {
        const json = jest.fn().mockRejectedValue(new OrcaCliError('wait timed out after 1000ms', [], ''));
        await expect(service(json).waitForIdle('term_1', 1000)).resolves.toBe('timeout');
    });

    it('re-throws a wait failure that is not a timeout', async () => {
        const json = jest.fn().mockRejectedValue(new OrcaCliError('unknown terminal handle', [], ''));
        await expect(service(json).waitForIdle('term_1', 1000)).rejects.toThrow(/unknown terminal/);
    });

    it('reads terminal output through the nested tail', async () => {
        const json = jest.fn().mockResolvedValue({ terminal: { tail: ['one', 'two'] } });
        await expect(service(json).read('t')).resolves.toBe('one' + '\n' + 'two');
        await expect(service(jest.fn().mockResolvedValue({})).read('t')).resolves.toBe('');
    });

    it('drops rows with no identity rather than rendering blanks', async () => {
        const json = jest.fn().mockResolvedValue({
            worktrees: [{ id: 'a', path: '/w/a' }, { id: 'b' }, 'nonsense']
        });
        const worktrees = await service(json).listWorktrees();
        expect(worktrees.map(w => w.id)).toEqual(['a']);
    });
});
