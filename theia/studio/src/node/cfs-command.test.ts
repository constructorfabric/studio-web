import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CFS_ON_PATH, cfsCommand, cfsCommandCandidates, cfsEnvironment, configuredCfsCommand } from './cfs-command';

describe('cfs command', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cfs-command-'));
    });

    afterEach(async () => {
        await fs.rm(workspace, { recursive: true, force: true });
    });

    async function withEngineScript(): Promise<string> {
        const scripts = path.join(workspace, '.cf-studio', '.core', 'skills', 'studio', 'scripts');
        await fs.mkdir(scripts, { recursive: true });
        await fs.writeFile(path.join(scripts, 'studio.py'), '', 'utf8');
        return fs.realpath(path.join(scripts, 'studio.py'));
    }

    it('runs the configured command, else cfs from PATH', () => {
        expect(cfsCommand({ STUDIO_CFS_COMMAND: ' /app/resources/cfs/bin/cfs ' })).toEqual({
            executable: '/app/resources/cfs/bin/cfs',
            prefixArguments: [],
            identity: '/app/resources/cfs/bin/cfs'
        });
        expect(cfsCommand({})).toMatchObject({ executable: 'cfs', prefixArguments: [] });
        expect(cfsCommand({ STUDIO_CFS_COMMAND: '   ' })).toMatchObject({ executable: 'cfs' });
    });

    it('refuses a configured command with a NUL byte', () => {
        expect(() => configuredCfsCommand({ STUDIO_CFS_COMMAND: 'cfs\0rm' })).toThrow('invalid NUL byte');
    });

    it('lists the configured command, cfs, then the Workspace engine through python3', async () => {
        const script = await withEngineScript();

        const candidates = await cfsCommandCandidates(workspace, { STUDIO_CFS_COMMAND: '/opt/shipped/cfs' }, 'linux');

        expect(candidates.map(candidate => [candidate.executable, ...candidate.prefixArguments])).toEqual([
            ['/opt/shipped/cfs'],
            ['cfs'],
            ['python3', script]
        ]);
    });

    it('does not list cfs twice when it is the configured command', async () => {
        const candidates = await cfsCommandCandidates(workspace, { STUDIO_CFS_COMMAND: 'cfs' }, 'linux');

        expect(candidates.map(candidate => candidate.executable)).toEqual(['cfs']);
    });

    it('reaches the engine through python or the py launcher on Windows, never python3', async () => {
        const script = await withEngineScript();

        const candidates = await cfsCommandCandidates(workspace, {}, 'win32');

        expect(candidates.map(candidate => [candidate.executable, ...candidate.prefixArguments])).toEqual([
            ['cfs'],
            ['python', script],
            ['py', '-3', script]
        ]);
    });

    async function withRuntime(platform: NodeJS.Platform, engine?: string): Promise<{ runtime: string; python: string }> {
        const runtime = path.join(workspace, 'plugins', 'constructorfabric.studio-cli-1', 'extension', 'runtime');
        const python = platform === 'win32'
            ? path.join(runtime, 'python', 'python.exe')
            : path.join(runtime, 'python', 'bin', 'python3');
        await fs.mkdir(path.dirname(python), { recursive: true });
        await fs.writeFile(python, '', 'utf8');
        if (engine) {
            await fs.writeFile(path.join(runtime, 'cfs.json'), JSON.stringify({ ref: 'abc', engine }), 'utf8');
        }
        return { runtime, python };
    }

    it('runs the CLI extension as a module of its own Python, with its own home and engine', async () => {
        const { runtime, python } = await withRuntime('win32', 'v1.6.2');

        const command = cfsCommand({ STUDIO_CFS_RUNTIME: runtime }, 'win32');

        expect(command).toEqual({
            executable: python,
            prefixArguments: ['-m', 'studio_proxy'],
            identity: 'cfs (Constructor Studio CLI extension)',
            env: {
                HOME: path.join(runtime, 'home'),
                USERPROFILE: path.join(runtime, 'home'),
                PYTHONUTF8: '1',
                CFS_NO_VERSION_CHECK: '1'
            },
            engine: 'v1.6.2'
        });
    });

    it('falls through to cfs on PATH until the CLI extension has arrived', async () => {
        const runtime = path.join(workspace, 'not-fetched-yet', 'runtime');

        expect(cfsCommand({ STUDIO_CFS_RUNTIME: runtime }, 'linux')).toMatchObject({ executable: 'cfs' });
        await withRuntime('linux');
        const fetched = path.join(workspace, 'plugins', 'constructorfabric.studio-cli-1', 'extension', 'runtime');
        expect(cfsCommand({ STUDIO_CFS_RUNTIME: fetched }, 'linux')).toMatchObject({
            executable: path.join(fetched, 'python', 'bin', 'python3'),
            engine: undefined
        });
    });

    it('lists the CLI extension after the configured command and before cfs on PATH', async () => {
        const { runtime, python } = await withRuntime('linux', 'v1.6.2');

        const candidates = await cfsCommandCandidates(
            workspace, { STUDIO_CFS_COMMAND: '/opt/shipped/cfs', STUDIO_CFS_RUNTIME: runtime }, 'linux'
        );

        expect(candidates.map(candidate => candidate.executable)).toEqual(['/opt/shipped/cfs', python, 'cfs']);
    });

    it('launches with the IDE environment unless the command brings its own', () => {
        expect(cfsEnvironment(CFS_ON_PATH, { PATH: '/bin' })).toBeUndefined();
        expect(cfsEnvironment({ ...CFS_ON_PATH, env: { HOME: '/h' } }, { PATH: '/bin', HOME: '/me' }))
            .toEqual({ PATH: '/bin', HOME: '/h' });
    });

    it('offers no Python fallback when the Workspace has no engine', async () => {
        const candidates = await cfsCommandCandidates(workspace, {}, 'linux');

        expect(candidates.map(candidate => candidate.executable)).toEqual(['cfs']);
    });
});
