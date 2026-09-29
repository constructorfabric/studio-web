// How Studio finds Orca on a machine, and what it reports when it does not.
//
// Every case here is one a member's machine can be in and this one cannot be
// arranged into: Orca installed per machine, only on PATH as a `.cmd` shim,
// behind a launcher with a bare PATH, or not at all. So the lookup is pure,
// given an environment, a platform and a file-existence probe, and tested
// that way; nothing here spawns a process or opens a socket.

import { candidateBinaries, findOrcaBinary, orcaHost } from './orca-cli';
import { OrcaServiceImpl, toWorktree, toRepository } from './orca-service';
import { attachFailure } from './orca-terminal-bridge';
import { STALE_ORCA_PAIRING, needsPairing, NO_ORCA_PAIRING } from '../common/orca-terminal-protocol';

const files = (...present: string[]) => (file: string) => present.includes(file);

describe('finding the orca executable', () => {

    it('takes the per-user Windows install first', () => {
        const exe = 'C:\\Users\\m\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe';
        const lookup = findOrcaBinary(
            { LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local', PATH: '' },
            'win32',
            files(exe)
        );
        expect(lookup.found).toBe(exe);
    });

    it('finds a per-machine Windows install under Program Files', () => {
        const exe = 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe';
        const lookup = findOrcaBinary(
            { LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: '' },
            'win32',
            files(exe)
        );
        expect(lookup.found).toBe(exe);
    });

    it('follows a .cmd shim on PATH to the orca.exe beside it', () => {
        // Node spawns no .cmd without a shell; Orca's own shim only forwards
        // to the exe in the same folder.
        const lookup = findOrcaBinary(
            { PATH: 'D:\\tools\\orca\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
            'win32',
            files('D:\\tools\\orca\\bin\\orca.cmd', 'D:\\tools\\orca\\bin\\orca.exe')
        );
        expect(lookup.found).toBe('D:\\tools\\orca\\bin\\orca.exe');
    });

    it('does not offer a lone .cmd it cannot run', () => {
        const lookup = findOrcaBinary(
            { PATH: 'D:\\shims', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
            'win32',
            files('D:\\shims\\orca.cmd')
        );
        expect(lookup.found).toBeUndefined();
    });

    it('resolves a bare name on PATH to an absolute path', () => {
        // The terminal bridge loads Orca's client from next to the CLI, which
        // a bare `orca` does not locate.
        const lookup = findOrcaBinary({ PATH: '/usr/bin:/home/m/bin', HOME: '/home/m' }, 'linux', files('/home/m/bin/orca'));
        expect(lookup.found).toBe('/home/m/bin/orca');
    });

    it('finds the Linux AppImage CLI in ~/.local/bin, which a desktop launcher leaves off PATH', () => {
        const lookup = findOrcaBinary({ PATH: '/usr/bin:/bin', HOME: '/home/m' }, 'linux', files('/home/m/.local/bin/orca-ide'));
        expect(lookup.found).toBe('/home/m/.local/bin/orca-ide');
    });

    it('finds the macOS shell command when the app bundle is elsewhere and PATH is the Dock\'s', () => {
        const lookup = findOrcaBinary({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/m' }, 'darwin', files('/usr/local/bin/orca'));
        expect(lookup.found).toBe('/usr/local/bin/orca');
        const brew = findOrcaBinary({ PATH: '/usr/bin', HOME: '/Users/m' }, 'darwin', files('/opt/homebrew/bin/orca'));
        expect(brew.found).toBe('/opt/homebrew/bin/orca');
    });

    it('prefers the app bundle over a shell command', () => {
        const bundle = '/Applications/Orca.app/Contents/Resources/bin/orca';
        const lookup = findOrcaBinary({ PATH: '/usr/local/bin', HOME: '/Users/m' }, 'darwin', files(bundle, '/usr/local/bin/orca'));
        expect(lookup.found).toBe(bundle);
    });

    it('treats ORCA_CLI as the answer, even when it points at nothing', () => {
        const installed = '/Applications/Orca.app/Contents/Resources/bin/orca';
        const lookup = findOrcaBinary({ ORCA_CLI: '/nowhere/orca', HOME: '/Users/m' }, 'darwin', files(installed));
        expect(lookup.found).toBeUndefined();
        expect(lookup.searched).toEqual(['/nowhere/orca']);
    });

    it('names everything it looked at when there is nothing', () => {
        const lookup = findOrcaBinary({ PATH: '/usr/bin', HOME: '/home/m' }, 'linux', files());
        expect(lookup.found).toBeUndefined();
        expect(lookup.searched).toContain('/opt/Orca/resources/bin/orca-ide');
        expect(lookup.searched).toContain('/home/m/.local/bin/orca-ide');
        expect(lookup.searched).toContain('orca on PATH');
    });

    it('lists the new install locations per platform', () => {
        expect(candidateBinaries({ ProgramFiles: 'C:\\Program Files' }, 'win32'))
            .toContain('C:\\Program Files\\Orca\\resources\\bin\\orca.exe');
        expect(candidateBinaries({ HOME: '/Users/m' }, 'darwin')).toContain('/Users/m/.local/bin/orca');
        expect(candidateBinaries({ HOME: '/home/m' }, 'linux')).toContain('/home/m/.local/bin/orca');
    });
});

describe('where the IDE runs', () => {
    it('is a session when the session gate handed it a token, local otherwise', () => {
        expect(orcaHost({ STUDIO_SESSION_TOKEN: 'x' })).toBe('session');
        expect(orcaHost({})).toBe('local');
        expect(orcaHost({ STUDIO_SESSION_TOKEN: '  ' })).toBe('local');
    });
});

describe('why a terminal stream did not attach', () => {
    const clientError = (code: string) => Object.assign(new Error('refused'), { code });

    it('reads a refused device token as a stale pairing, which pairing again fixes', () => {
        const message = attachFailure(clientError('unauthorized'), {});
        expect(message).toContain(STALE_ORCA_PAIRING);
        expect(message).toContain('Pair again');
        expect(needsPairing(message)).toBe(true);
    });

    it('reads a runtime that is not the paired one (Orca reinstalled) the same way', () => {
        expect(needsPairing(attachFailure(clientError('invalid_runtime_response'), {}))).toBe(true);
    });

    it('in a session, says to restart it rather than to paste a link', () => {
        const message = attachFailure(clientError('unauthorized'), { STUDIO_SESSION_TOKEN: 't' });
        expect(message).toContain('Restart the session');
        expect(message).not.toContain('Pair again');
    });

    it('reads a refused connection as Orca not running', () => {
        const message = attachFailure(clientError('ECONNREFUSED'), {});
        expect(message).toMatch(/not answering/);
        expect(needsPairing(message)).toBe(false);
    });

    it('keeps any other reason as it came', () => {
        expect(attachFailure(new Error('socket hang up'), {})).toBe('Could not attach to the Orca terminal: socket hang up');
    });

    it('still treats a missing pairing as one to make', () => {
        expect(needsPairing(`${NO_ORCA_PAIRING} on this computer yet`)).toBe(true);
    });
});

describe('the status the panel decides from', () => {
    const saved = process.env.STUDIO_SESSION_TOKEN;
    afterEach(() => {
        if (saved === undefined) {
            delete process.env.STUDIO_SESSION_TOKEN;
        } else {
            process.env.STUDIO_SESSION_TOKEN = saved;
        }
    });

    function service(cli: Record<string, jest.Mock>): OrcaServiceImpl {
        const impl = new OrcaServiceImpl();
        (impl as unknown as { cli: unknown }).cli = cli;
        return impl;
    }

    it('says where it runs and which executable answered', async () => {
        delete process.env.STUDIO_SESSION_TOKEN;
        const status = await service({
            json: jest.fn().mockResolvedValue({ app: { running: true }, runtime: { state: 'ready', reachable: true } }),
            binary: jest.fn().mockReturnValue('C:\\o\\orca.exe')
        }).status();
        expect(status.host).toBe('local');
        expect(status.binary).toBe('C:\\o\\orca.exe');
        expect(typeof status.paired).toBe('boolean');
    });

    it('passes Orca\'s own not-running state through, so the panel can offer to start it', async () => {
        const status = await service({
            json: jest.fn().mockResolvedValue({ app: { running: false }, runtime: { state: 'not_running', reachable: false } })
        }).status();
        expect(status.reachable).toBe(false);
        expect(status.state).toBe('not_running');
        expect(status.cliMissing).toBeUndefined();
    });

    it('starts Orca with `orca open` off a session, and reports the status after', async () => {
        delete process.env.STUDIO_SESSION_TOKEN;
        const json = jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ app: { running: true }, runtime: { state: 'ready', reachable: true } });
        const status = await service({ json }).start();
        expect(json.mock.calls[0][0]).toEqual(['open']);
        expect(status.reachable).toBe(true);
    });

    it('refuses to start Orca in a session, where the container does', async () => {
        process.env.STUDIO_SESSION_TOKEN = 'session';
        const json = jest.fn();
        await expect(service({ json }).start()).rejects.toThrow(/restart the session/);
        expect(json).not.toHaveBeenCalled();
    });

    it('names the repository a task branches from', async () => {
        const json = jest.fn().mockResolvedValue({ worktree: { id: 'r1::/w/x', path: '/w/x' } });
        await service({ json }).createTask({ name: 'x', agent: 'claude', prompt: 'p', repo: 'id:r1' });
        const args: string[] = json.mock.calls[0][0];
        expect(args.slice(args.indexOf('--repo'), args.indexOf('--repo') + 2)).toEqual(['--repo', 'id:r1']);
    });

    it('leaves the repository to Orca when the panel names none', async () => {
        const json = jest.fn().mockResolvedValue({});
        await service({ json }).createTask({ name: 'x', agent: 'claude', prompt: 'p' });
        expect(json.mock.calls[0][0]).not.toContain('--repo');
    });

    it('lists the repositories Orca knows', async () => {
        const json = jest.fn().mockResolvedValue({
            repos: [
                { id: 'r1', path: 'C:/Repos/studio-web', displayName: 'studio-web', kind: 'git' },
                { id: '', path: '/nowhere' }
            ]
        });
        expect(await service({ json }).listRepositories()).toEqual([
            { id: 'r1', path: 'C:/Repos/studio-web', displayName: 'studio-web' }
        ]);
    });
});

describe('the repository of a worktree', () => {
    it('reads repoId, or the repository half of the worktree id', () => {
        expect(toWorktree({ id: 'r1::C:/a', repoId: 'r1', path: 'C:/a' }).repoId).toBe('r1');
        expect(toWorktree({ id: 'r2::/b', path: '/b' }).repoId).toBe('r2');
        expect(toWorktree({ id: 'plain', path: '/c' }).repoId).toBeUndefined();
    });

    it('names a repository by its folder when Orca gives no name', () => {
        expect(toRepository({ id: 'r', path: '/src/studio-web' }).displayName).toBe('studio-web');
    });
});
