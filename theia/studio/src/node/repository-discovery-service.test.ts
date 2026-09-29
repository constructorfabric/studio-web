import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ILogger } from '@theia/core/lib/common';
import { GitCommandError, type GitExecutor } from './git-executor';
import { RepositoryDiscoveryService } from './repository-discovery-service';
import { RepositoryRegistry, type RepositoryRegistration } from './repository-registry';
import type { StudioRuntimeConfig } from './studio-runtime-config';

describe('repository discovery service', () => {
    let tempDir: string;
    let workspaceRoot: string;
    let registry: RepositoryRegistry;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-repository-discovery-'));
        workspaceRoot = path.join(tempDir, 'workspace');
        await fs.mkdir(workspaceRoot);
        registry = new RepositoryRegistry();
        await registry.initialize(workspaceRoot);
    });

    afterEach(async () => {
        registry.dispose();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('detects Git directories and gitfiles while excluding node_modules', async () => {
        const rootRepository = workspaceRoot;
        const nestedRepository = path.join(workspaceRoot, 'sources', 'nested');
        const ignoredRepository = path.join(workspaceRoot, 'node_modules', 'ignored');
        await fs.mkdir(path.join(rootRepository, '.git'));
        await fs.mkdir(nestedRepository, { recursive: true });
        await fs.writeFile(path.join(nestedRepository, '.git'), 'gitdir: external');
        await fs.mkdir(path.join(ignoredRepository, '.git'), { recursive: true });
        const git = createGitStub(await Promise.all([
            fs.realpath(rootRepository),
            fs.realpath(nestedRepository)
        ]));
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());

        const registrations = await service.discover(workspaceRoot);
        const expectedRoots = await Promise.all([
            fs.realpath(nestedRepository),
            fs.realpath(rootRepository)
        ]);

        expect(registrations.map(item => item.repositoryRoot).sort()).toEqual(expectedRoots.sort());
        service.dispose();
    });

    it('does not traverse symlinked directories outside the workspace', async () => {
        const outsideRepository = path.join(tempDir, 'outside');
        await fs.mkdir(path.join(outsideRepository, '.git'), { recursive: true });
        await fs.symlink(outsideRepository, path.join(workspaceRoot, 'linked'));
        const git = createGitStub([]);
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());

        await expect(service.discover(workspaceRoot)).resolves.toEqual([]);
        service.dispose();
    });

    it('deduplicates candidates confirmed as the same canonical repository', async () => {
        const firstCandidate = path.join(workspaceRoot, 'one');
        const secondCandidate = path.join(workspaceRoot, 'two');
        await fs.mkdir(path.join(firstCandidate, '.git'), { recursive: true });
        await fs.mkdir(path.join(secondCandidate, '.git'), { recursive: true });
        const [canonicalFirst, canonicalSecond] = await Promise.all([
            fs.realpath(firstCandidate),
            fs.realpath(secondCandidate)
        ]);
        const git = createGitStub([canonicalFirst, canonicalSecond], canonicalFirst);
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());

        const registrations = await service.discover(workspaceRoot);

        expect(registrations).toHaveLength(1);
        expect(registrations[0].repositoryRoot).toBe(await fs.realpath(firstCandidate));
        service.dispose();
    });

    it('includes the configured repository that contains a nested workspace', async () => {
        const containingRepository = path.join(tempDir, 'repository');
        const nestedWorkspace = path.join(containingRepository, 'docs');
        await fs.mkdir(path.join(containingRepository, '.git'), { recursive: true });
        await fs.mkdir(nestedWorkspace);
        const canonicalRepository = await fs.realpath(containingRepository);
        const git = createGitStub([canonicalRepository]);
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());

        const registrations = await service.discover(nestedWorkspace, containingRepository);

        expect(registrations).toHaveLength(1);
        expect(registrations[0].repositoryRoot).toBe(canonicalRepository);
        service.dispose();
    });

    it('publishes versioned per-repository Git configuration and refreshes its revision', async () => {
        await fs.mkdir(path.join(workspaceRoot, '.git'));
        let branch = 'main';
        const git = {
            revParseTopLevel: async () => workspaceRoot,
            revParseAbsoluteGitDir: async () => path.join(workspaceRoot, '.git'),
            revParseGitCommonDir: async () => path.join(workspaceRoot, '.git'),
            revParseAbbrevHead: async () => branch,
            getConfigValue: async (_cwd: string, key: string) => ({
                'remote.origin.url': 'git@example.test:owner/repo.git',
                'user.name': 'Repository User',
                'user.email': 'repo@example.test'
            } as Record<string, string>)[key],
            getResolvedRemoteUrl: async (_cwd: string, _remote: string, push = false) =>
                push ? 'ssh://push.example.test/owner/repo.git' : 'ssh://fetch.example.test/owner/repo.git'
        } as unknown as GitExecutor;
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());
        await service.initialize(runtimeConfig(workspaceRoot));
        const [initial] = registry.descriptors;

        expect(initial.git).toMatchObject({
            mode: 'push',
            branch: 'main',
            remote: 'origin',
            fetchSourceUrl: 'git@example.test:owner/repo.git',
            pushSourceUrl: 'git@example.test:owner/repo.git',
            publishEnabled: true
        });

        branch = 'release';
        const refreshed = await service.refreshRepository(initial.repositoryId);

        expect(refreshed.branch).toBe('release');
        expect(refreshed.configRevision).not.toBe(initial.git.configRevision);
        service.dispose();
    });

    it('disables publish during discovery for an unsupported remote transport', async () => {
        await fs.mkdir(path.join(workspaceRoot, '.git'));
        const git = {
            revParseTopLevel: async () => workspaceRoot,
            revParseAbsoluteGitDir: async () => path.join(workspaceRoot, '.git'),
            revParseGitCommonDir: async () => path.join(workspaceRoot, '.git'),
            revParseAbbrevHead: async () => 'main',
            getConfigValue: async (_cwd: string, key: string) => ({
                'remote.origin.url': 'git://example.test/owner/repo.git',
                'user.name': 'Repository User',
                'user.email': 'repo@example.test'
            } as Record<string, string>)[key],
            getResolvedRemoteUrl: async () => 'git://example.test/owner/repo.git'
        } as unknown as GitExecutor;
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());

        await service.initialize(runtimeConfig(workspaceRoot));

        expect(registry.descriptors[0].git).toMatchObject({
            mode: 'disabled',
            publishEnabled: false,
            disabledReason: 'Git remote transport is unsupported'
        });
        service.dispose();
    });

    it('initializes the configured repository before background nested discovery completes', async () => {
        await fs.mkdir(path.join(workspaceRoot, '.git'));
        const git = {
            revParseTopLevel: jest.fn(async () => workspaceRoot),
            revParseAbsoluteGitDir: jest.fn(async (cwd: string) => path.join(cwd, '.git')),
            revParseGitCommonDir: jest.fn(async (cwd: string) => path.join(cwd, '.git')),
            revParseAbbrevHead: jest.fn(async () => 'main'),
            getConfigValue: jest.fn(async (_cwd: string, key: string) => ({
                'remote.origin.url': 'git@example.test:owner/repo.git',
                'user.name': 'Repository User',
                'user.email': 'repo@example.test'
            } as Record<string, string>)[key]),
            getResolvedRemoteUrl: jest.fn(async () => 'ssh://git@example.test/owner/repo.git')
        } as unknown as GitExecutor;
        let backgroundRescanStarted = false;
        let releaseBackgroundRescan: (() => void) | undefined;
        class DeferredRescanDiscoveryService extends RepositoryDiscoveryService {
            override async rescan(): Promise<void> {
                backgroundRescanStarted = true;
                await new Promise<void>(resolve => {
                    releaseBackgroundRescan = resolve;
                });
            }
        }
        const service = new DeferredRescanDiscoveryService(git, registry, createLoggerStub());

        await service.initialize(runtimeConfig(workspaceRoot));

        expect(registry.descriptors).toHaveLength(1);
        expect(registry.descriptors[0].workspaceRelativeRoot).toBe('.');
        await waitFor(() => backgroundRescanStarted);
        releaseBackgroundRescan?.();
        service.dispose();
    });

    it('does not start the watcher or eager rescan in canonical mode and can seed explicit registrations only', async () => {
        await fs.mkdir(path.join(workspaceRoot, '.git'));
        const canonicalWorkspaceRoot = await fs.realpath(workspaceRoot);
        const git = createGitStub([workspaceRoot, canonicalWorkspaceRoot]);
        let watcherStarted = false;
        let eagerRescanStarted = false;
        class CanonicalDiscoveryService extends RepositoryDiscoveryService {
            protected override async discoverConfiguredRepository(): Promise<RepositoryRegistration> {
                return {
                    repositoryRoot: canonicalWorkspaceRoot,
                    gitDirectory: path.join(canonicalWorkspaceRoot, '.git'),
                    commonDirectory: path.join(canonicalWorkspaceRoot, '.git')
                };
            }
            protected override startWatcher(_workspaceRoot: string): void {
                watcherStarted = true;
            }
            protected override rescanInBackground(_reason: string): void {
                eagerRescanStarted = true;
            }
        }
        const service = new CanonicalDiscoveryService(git, registry, createLoggerStub());

        await service.initialize(runtimeConfig(workspaceRoot), {
            mode: 'canonical',
            initialRegistrations: [{ repositoryRoot: workspaceRoot }]
        });

        expect(watcherStarted).toBe(false);
        expect(eagerRescanStarted).toBe(false);
        expect(registry.descriptors).toHaveLength(1);
        await expect(service.discoverConfiguredRepositoryRegistration()).resolves.toMatchObject({
            repositoryRoot: canonicalWorkspaceRoot,
            gitDirectory: path.join(canonicalWorkspaceRoot, '.git')
        });
        await expect(service.rescan()).rejects.toThrow('disabled in canonical mode');
        service.dispose();
    });

    it('initializes only the configured repository in single-folder mode without recursive scanning', async () => {
        const containingRepository = path.join(tempDir, 'repository');
        const nestedWorkspace = path.join(containingRepository, 'docs');
        await fs.mkdir(path.join(containingRepository, '.git'), { recursive: true });
        await fs.mkdir(nestedWorkspace, { recursive: true });
        const git = {
            revParseTopLevel: jest.fn(async () => containingRepository),
            revParseAbsoluteGitDir: jest.fn(async (_cwd: string) => path.join(containingRepository, '.git')),
            revParseGitCommonDir: jest.fn(async (_cwd: string) => path.join(containingRepository, '.git')),
            revParseAbbrevHead: jest.fn(async () => 'main'),
            getConfigValue: jest.fn(async (_cwd: string, key: string) => ({
                'remote.origin.url': 'git@example.test:owner/repo.git',
                'user.name': 'Repository User',
                'user.email': 'repo@example.test'
            } as Record<string, string>)[key]),
            getResolvedRemoteUrl: jest.fn(async () => 'ssh://git@example.test/owner/repo.git')
        } as unknown as GitExecutor;
        let watcherStarted = false;
        let eagerRescanStarted = false;
        class SingleFolderDiscoveryService extends RepositoryDiscoveryService {
            protected override startWatcher(_workspaceRoot: string): void {
                watcherStarted = true;
            }
            protected override rescanInBackground(_reason: string): void {
                eagerRescanStarted = true;
            }
        }
        const service = new SingleFolderDiscoveryService(git, registry, createLoggerStub());

        await service.initialize(runtimeConfig(nestedWorkspace, containingRepository), { mode: 'single-folder' });

        expect(watcherStarted).toBe(false);
        expect(eagerRescanStarted).toBe(false);
        expect(registry.descriptors).toHaveLength(1);
        expect(registry.descriptors[0]?.rootUri).toContain('/repository');
        await expect(service.rescan()).rejects.toThrow('disabled in single-folder mode');
        service.dispose();
    });

    it('leaves registry projection empty in canonical mode when no explicit registrations are supplied', async () => {
        await fs.mkdir(path.join(workspaceRoot, '.git'));
        const git = createGitStub([await fs.realpath(workspaceRoot)]);
        const service = new RepositoryDiscoveryService(git, registry, createLoggerStub());

        await service.initialize(runtimeConfig(workspaceRoot), { mode: 'canonical' });

        expect(registry.descriptors).toEqual([]);
        service.dispose();
    });

    it('does not let an in-flight legacy rescan overwrite a canonical projection', async () => {
        const staleRoot = path.join(workspaceRoot, 'stale');
        await fs.mkdir(path.join(workspaceRoot, '.git'), { recursive: true });
        await fs.mkdir(path.join(staleRoot, '.git'), { recursive: true });
        const canonicalWorkspaceRoot = await fs.realpath(workspaceRoot);
        let releaseScan: () => void = () => undefined;
        let scanStarted = false;
        const scanGate = new Promise<void>(resolve => {
            releaseScan = resolve;
        });
        class SwitchingDiscoveryService extends RepositoryDiscoveryService {
            override async discover(): Promise<readonly RepositoryRegistration[]> {
                scanStarted = true;
                await scanGate;
                return [{ repositoryRoot: staleRoot }];
            }
            protected override async discoverConfiguredRepository(): Promise<RepositoryRegistration> {
                return {
                    repositoryRoot: canonicalWorkspaceRoot,
                    gitDirectory: path.join(canonicalWorkspaceRoot, '.git'),
                    commonDirectory: path.join(canonicalWorkspaceRoot, '.git')
                };
            }
            protected override startWatcher(): void {
                // The test drives rescan explicitly.
            }
            protected override rescanInBackground(): void {
                // The test drives rescan explicitly.
            }
        }
        const service = new SwitchingDiscoveryService(
            createGitStub([canonicalWorkspaceRoot]),
            registry,
            createLoggerStub()
        );
        const config = runtimeConfig(workspaceRoot);
        await service.initialize(config, { mode: 'legacy' });

        const staleRescan = service.rescan();
        await waitFor(() => scanStarted);
        await service.initialize(config, {
            mode: 'canonical',
            initialRegistrations: [{
                repositoryRoot: canonicalWorkspaceRoot,
                gitDirectory: path.join(canonicalWorkspaceRoot, '.git'),
                commonDirectory: path.join(canonicalWorkspaceRoot, '.git')
            }]
        });
        releaseScan();
        await staleRescan;

        expect(registry.descriptors).toHaveLength(1);
        expect(registry.descriptors[0]?.rootUri).toContain('/workspace');
        expect(registry.descriptors[0]?.rootUri).not.toContain('/stale');
        service.dispose();
    });
    it('starts over a workspace root that is not a Git repository', async () => {
        // A managed workspace is a container: the root holds the manifest and
        // one directory per source. `git rev-parse` there exits 128, and this
        // used to take the whole Studio backend contribution down with it --
        // the IDE came up, the Studio half did not.
        const nestedRepository = path.join(workspaceRoot, 'sources', 'nested');
        await fs.mkdir(path.join(nestedRepository, '.git'), { recursive: true });
        const canonicalNested = await fs.realpath(nestedRepository);
        const warnings: string[] = [];
        const logger = createLoggerStub();
        logger.warn = (async (message: unknown) => {
            warnings.push(String(message));
        }) as ILogger['warn'];
        class RootlessDiscoveryService extends RepositoryDiscoveryService {
            protected override startWatcher(): void {
                // The test drives rescan explicitly.
            }
            protected override rescanInBackground(): void {
                // The test drives rescan explicitly.
            }
        }
        // `git rev-parse` outside a worktree exits 128, which the executor
        // reports as a GitCommandError -- exactly what the container does.
        const git = createGitStub([canonicalNested]);
        const rootless = {
            ...git,
            revParseTopLevel: async (cwd: string) => {
                if (cwd === workspaceRoot) {
                    throw new GitCommandError(
                        'git rev-parse failed with exit code 128',
                        ['rev-parse', '--show-toplevel'],
                        128,
                        '',
                        'fatal: not a git repository'
                    );
                }
                return git.revParseTopLevel(cwd);
            },
            // Enough of a repository for discovery to describe it. No remote,
            // so the descriptor comes back with publishing disabled -- which is
            // beside the point here: the assertion is that the source is found
            // at all once the root has stopped being one.
            revParseAbbrevHead: async () => 'main',
            getConfigValue: async () => undefined,
            getResolvedRemoteUrl: async () => undefined
        } as unknown as GitExecutor;
        const service = new RootlessDiscoveryService(rootless, registry, logger);

        await expect(
            service.initialize(runtimeConfig(workspaceRoot), { mode: 'legacy' })
        ).resolves.toBeUndefined();
        expect(registry.descriptors).toHaveLength(0);
        expect(warnings.join('\n')).toContain('not a Git repository');

        // The sources the workspace does contain still arrive on the rescan.
        await service.rescan();
        expect(registry.descriptors.map(descriptor => descriptor.workspaceRelativeRoot))
            .toEqual(['sources/nested']);
        service.dispose();
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Timed out waiting for test condition');
}

function createGitStub(candidates: readonly string[], forcedRoot?: string): GitExecutor {
    const roots = new Set(candidates);
    const requireCandidate = (cwd: string): string => {
        if (!roots.has(cwd)) {
            throw new Error(`Unexpected candidate: ${cwd}`);
        }
        return forcedRoot ?? cwd;
    };
    return {
        revParseTopLevel: async cwd => requireCandidate(cwd),
        revParseAbsoluteGitDir: async cwd => path.join(requireCandidate(cwd), '.git'),
        revParseGitCommonDir: async cwd => path.join(requireCandidate(cwd), '.git')
    } as GitExecutor;
}

function createLoggerStub(): ILogger {
    return {
        child: () => createLoggerStub(),
        debug: () => undefined,
        error: () => undefined,
        fatal: () => undefined,
        getLevel: () => 0,
        info: () => undefined,
        isEnabled: () => false,
        log: () => undefined,
        setLogLevel: async () => undefined,
        trace: () => undefined,
        warn: () => undefined
    } as unknown as ILogger;
}

function runtimeConfig(workspaceRoot: string, repositoryRoot = workspaceRoot): StudioRuntimeConfig {
    return {
        actorId: 'actor-1',
        workspaceId: 'workspace-1',
        workspaceRoot,
        repositoryRoot,
        dataDir: path.join(path.dirname(workspaceRoot), 'data'),
        allowedOriginsMode: 'same-origin',
        allowedOrigins: [],
        git: {
            mode: 'push',
            branch: 'main',
            remote: 'origin',
            fetchSourceUrl: 'git@example.test:owner/repo.git',
            pushSourceUrl: 'git@example.test:owner/repo.git',
            fetchUrl: 'ssh://git@example.test/owner/repo.git',
            pushUrl: 'ssh://git@example.test/owner/repo.git',
            authorName: 'Fallback User',
            authorEmail: 'fallback@example.test'
        },
        secrets: {}
    };
}
