import 'reflect-metadata';
import * as childProcess from 'child_process';
import { promises as fs } from 'fs';
import { KitInstallerImpl } from './kit-installer';
import type { RepositoryRegistry } from './repository-registry';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('kit installer', () => {
    afterEach(() => jest.restoreAllMocks());

    it('runs only the allow-listed kit and regenerates agent integrations', async () => {
        const calls: Array<{ executable: string; args: string[]; cwd: string | undefined }> = [];
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            calls.push({
                executable: String(executable),
                args: [...(args ?? [])].map(String),
                cwd: options && typeof options === 'object' ? options.cwd?.toString() : undefined
            });
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        const result = await new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'v1.2.3' },
            registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
        );

        expect(result).toMatchObject({
            kitSlug: 'sdlc',
            version: 'v1.2.3',
            repositoryId: 'repo-1',
            repositoryLabel: 'app'
        });
        expect(calls).toEqual([
            {
                executable: 'cfs',
                args: ['init', '--yes', '--migrate-from-cypilot=no', '--update-legacy-studio=no'],
                cwd: '/workspace/app'
            },
            {
                executable: 'cfs',
                args: ['kit', 'install', 'constructorfabric/studio-kit-sdlc', '--version', 'v1.2.3', '--force'],
                cwd: '/workspace/app'
            },
            {
                executable: 'cfs',
                args: ['generate-agents'],
                cwd: '/workspace/app'
            }
        ]);
    });

    it('does not reinitialize a repository that already has Studio configured', async () => {
        const calls: string[][] = [];
        jest.spyOn(fs, 'access').mockResolvedValue(undefined);
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            calls.push([String(executable), ...(args ?? []).map(String)]);
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        await new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
        );

        expect(calls).toEqual([
            ['cfs', 'kit', 'install', 'constructorfabric/studio-kit-sdlc', '--version', 'main', '--force'],
            ['cfs', 'generate-agents']
        ]);
    });

    it('runs the configured cfs, the one a desktop build ships', async () => {
        const previous = process.env.STUDIO_CFS_COMMAND;
        process.env.STUDIO_CFS_COMMAND = '/app/resources/cfs/bin/cfs';
        const executables: string[] = [];
        jest.spyOn(fs, 'access').mockResolvedValue(undefined);
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            executables.push(String(executable));
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        try {
            await new KitInstallerImpl().install(
                { kitSlug: 'sdlc', version: 'main' },
                registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
            );
        } finally {
            if (previous === undefined) {
                delete process.env.STUDIO_CFS_COMMAND;
            } else {
                process.env.STUDIO_CFS_COMMAND = previous;
            }
        }

        expect(executables).toEqual(['/app/resources/cfs/bin/cfs', '/app/resources/cfs/bin/cfs']);
    });

    it('pins init to the CLI extension\'s engine and runs every step with its home', async () => {
        const os = await import('os');
        const path = await import('path');
        const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cli-runtime-'));
        const python = process.platform === 'win32'
            ? path.join(runtime, 'python', 'python.exe')
            : path.join(runtime, 'python', 'bin', 'python3');
        await fs.mkdir(path.dirname(python), { recursive: true });
        await fs.writeFile(python, '');
        await fs.writeFile(path.join(runtime, 'cfs.json'), JSON.stringify({ engine: 'v1.6.2' }));
        const previous = process.env.STUDIO_CFS_RUNTIME;
        process.env.STUDIO_CFS_RUNTIME = runtime;
        const calls: Array<{ executable: string; args: string[]; home: string | undefined }> = [];
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            calls.push({
                executable: String(executable),
                args: [...(args ?? [])].map(String),
                home: (options as childProcess.ExecFileOptions | undefined)?.env?.HOME
            });
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        try {
            await new KitInstallerImpl().install(
                { kitSlug: 'sdlc', version: 'v1.2.3' },
                registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
            );
        } finally {
            if (previous === undefined) {
                delete process.env.STUDIO_CFS_RUNTIME;
            } else {
                process.env.STUDIO_CFS_RUNTIME = previous;
            }
            await fs.rm(runtime, { recursive: true, force: true });
        }

        const home = path.join(runtime, 'home');
        expect(calls).toEqual([
            {
                executable: python,
                args: ['-m', 'studio_proxy', 'init', '--yes', '--migrate-from-cypilot=no', '--update-legacy-studio=no', '--version', 'v1.6.2'],
                home
            },
            {
                executable: python,
                args: ['-m', 'studio_proxy', 'kit', 'install', 'constructorfabric/studio-kit-sdlc', '--version', 'v1.2.3', '--force'],
                home
            },
            { executable: python, args: ['-m', 'studio_proxy', 'generate-agents'], home }
        ]);
    });

    it('names the kit when its repository holds more than one', async () => {
        // `studio-kits-pm` carries a `[[kits]]` entry per kit in one root
        // manifest, so `cfs` offers a selector and installing without `--kit`
        // does not identify anything. The slug in the request is the KIT.
        const calls: string[][] = [];
        jest.spyOn(fs, 'access').mockResolvedValue(undefined);
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            calls.push([String(executable), ...(args ?? []).map(String)]);
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        await new KitInstallerImpl().install(
            { kitSlug: 'compete', version: 'main' },
            registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
        );

        expect(calls).toEqual([
            [
                'cfs',
                'kit',
                'install',
                'constructorfabric/studio-kits-pm',
                '--kit',
                'compete',
                '--version',
                'main',
                '--force'
            ],
            ['cfs', 'generate-agents']
        ]);
    });

    it('rejects unknown kits and option-like refs before executing a process', async () => {
        const run = jest.spyOn(childProcess, 'execFile');
        const repositories = registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }]);
        await expect(new KitInstallerImpl().install(
            { kitSlug: 'custom', version: 'main' }, repositories
        )).rejects.toThrow('not allow-listed');
        await expect(new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: '--help' }, repositories
        )).rejects.toThrow('safe Git ref');
        expect(run).not.toHaveBeenCalled();
    });

    it('defaults to the project repository in a multi-repository workspace', async () => {
        const directories: string[] = [];
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            directories.push(options && typeof options === 'object' ? String(options.cwd) : '');
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        const result = await new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([
                { id: 'repo-app', label: 'app', root: '/workspace/app' },
                { id: 'repo-docs', label: 'docs', root: '/workspace/docs' },
                { id: 'repo-project', label: 'project', root: '/workspace' }
            ], '/workspace')
        );

        // Deliberately not the first entry: the registry is ordered
        // deepest-first, so a positional default would have installed the kit
        // into a source clone instead of the project root.
        expect(result).toMatchObject({ repositoryId: 'repo-project', repositoryLabel: 'project' });
        expect(directories).toEqual(['/workspace', '/workspace', '/workspace']);
    });

    it('installs into the only checkout of a workspace whose root is a plain directory', async () => {
        const directories: string[] = [];
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            directories.push(options && typeof options === 'object' ? String(options.cwd) : '');
            (callback as ExecFileCallback)(null, 'ok', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        // A managed workspace: /workspace holds the manifest and one repository
        // per source, and is not a repository itself. One source leaves nothing
        // to disambiguate, so a caller that names no repository still lands
        // somewhere sensible.
        const result = await new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([{ id: 'repo-app', label: 'app', root: '/workspace/app' }])
        );

        expect(result).toMatchObject({ repositoryId: 'repo-app', repositoryLabel: 'app' });
        expect(directories.every(directory => directory === '/workspace/app')).toBe(true);
    });

    it('refuses to guess among several sources when no repository is the project', async () => {
        const run = jest.spyOn(childProcess, 'execFile');

        await expect(new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([
                { id: 'repo-app', label: 'app', root: '/workspace/app' },
                { id: 'repo-docs', label: 'docs', root: '/workspace/docs' }
            ])
        )).rejects.toThrow('repositoryId is required');
        expect(run).not.toHaveBeenCalled();
    });

    it('reports both streams when cfs fails, with stdout first', async () => {
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            (callback as ExecFileCallback)(
                new Error('Command failed: cfs kit install'),
                'kit manifest is invalid: unknown resource kind "widget"',
                [
                    '  Constructor Studio skill engine not found.',
                    '  Downloading automatically (non-interactive mode)...',
                    '  Cached: v1.6.2'
                ].join('\n')
            );
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        const failure = new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
        );

        // The reason lives on stdout while stderr carries only narration. A
        // `stderr || stdout` fallback reported the narration and lost the
        // reason entirely -- twice, in a live session.
        await expect(failure).rejects.toThrow('kit manifest is invalid');
        // stdout leads: both consumers downstream truncate from the front.
        await expect(failure).rejects.toThrow(/stdout:[\s\S]*stderr:/);
    });

    it('falls back to the process error when cfs says nothing', async () => {
        jest.spyOn(childProcess, 'execFile').mockImplementation(((executable, args, options, callback) => {
            (callback as ExecFileCallback)(new Error('spawn cfs ENOENT'), '', '');
            return {} as childProcess.ChildProcess;
        }) as typeof childProcess.execFile);

        await expect(new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([{ id: 'repo-1', label: 'app', root: '/workspace/app' }])
        )).rejects.toThrow('spawn cfs ENOENT');
    });

    it('requires an explicit repository when the project repository is not registered', async () => {
        const run = jest.spyOn(childProcess, 'execFile');
        await expect(new KitInstallerImpl().install(
            { kitSlug: 'sdlc', version: 'main' },
            registry([
                { id: 'repo-1', label: 'app', root: '/workspace/app' },
                { id: 'repo-2', label: 'docs', root: '/workspace/docs' }
            ])
        )).rejects.toThrow('repositoryId is required');
        expect(run).not.toHaveBeenCalled();
    });
});

function registry(
    entries: Array<{ id: string; label: string; root: string }>,
    configuredRoot?: string
): RepositoryRegistry {
    const repositories = entries.map(entry => ({
        canonicalRoot: entry.root,
        descriptor: { repositoryId: entry.id, label: entry.label }
    }));
    const configuredRepository = repositories.find(candidate => candidate.canonicalRoot === configuredRoot);
    return {
        repositories,
        configuredRepository,
        // Mirrors RepositoryRegistry.projectRepository: the configured root
        // when there is one, otherwise the only checkout — a managed workspace
        // has no repository at its root and still has to have a kit target.
        projectRepository: configuredRepository ?? (repositories.length === 1 ? repositories[0] : undefined),
        requireRepository: (id: string) => {
            const repository = repositories.find(candidate => candidate.descriptor.repositoryId === id);
            if (!repository) throw new Error(`Unknown repository: ${id}`);
            return repository;
        }
    } as unknown as RepositoryRegistry;
}
