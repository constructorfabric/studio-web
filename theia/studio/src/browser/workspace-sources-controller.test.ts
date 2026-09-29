import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
import URI from '@theia/core/lib/common/uri';
import { Emitter } from '@theia/core/lib/common';
import type { Command, CommandRegistry } from '@theia/core/lib/common/command';
import type { WorkspaceSnapshot, WorkspaceActivityEvent, WorkspaceRepositorySuggestion } from '../common/workspace-protocol';
import {
    WorkspaceSourcesCreateCommand,
    WorkspaceSourcesFrontendController,
    WorkspaceSourcesOpenCommand,
    WorkspaceSourcesRefreshCommand,
    WorkspaceSourcesScanCommand,
    WorkspaceSourcesSyncCommand,
    WorkspaceSourcesToggleCommand
} from './workspace-sources-controller';

describe('WorkspaceSourcesFrontendController', () => {
    it('loads snapshot on startup, rebinds on reconnect, and only detects the explicit opened root', async () => {
        const harness = createHarness();
        const controller = harness.controller;

        await controller.onStart();

        expect(harness.runtime.getSession).toHaveBeenCalledTimes(1);
        expect(harness.runtime.getWorkspaceSnapshot).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: undefined
        });
        expect(harness.runtime.detectContainingWorkspaceRepository).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            openedPath: '/workspace/opened-root'
        });
        expect(harness.runtime.scanWorkspaceSources).not.toHaveBeenCalled();
        expect(harness.runtime.startWorkspaceSync).not.toHaveBeenCalled();
        expect(harness.runtime.addWorkspaceSource).not.toHaveBeenCalled();

        const pushedSnapshot = snapshotWith({
            configRevision: 'rev-2',
            suggestions: [containingSuggestion('candidate-a', '/workspace/opened-root')]
        });
        controller.onWorkspaceSnapshotChanged(pushedSnapshot);
        const activity: WorkspaceActivityEvent = {
            schemaVersion: 1,
            eventId: 'job-1:2026-07-29T09:00:10.000Z',
            job: {
                jobId: 'job-1',
                kind: 'source-sync',
                state: 'running',
                phase: 'syncing-sources',
                startedAt: '2026-07-29T09:00:00.000Z',
                updatedAt: '2026-07-29T09:00:10.000Z',
                progress: {
                    completedSources: 0,
                    totalSources: 1
                }
            },
            snapshotRevision: 'rev-2'
        };
        controller.onWorkspaceActivityEvent(activity);

        expect(controller.getSnapshot()?.config.revision).toBe('rev-2');
        expect(controller.getSnapshot()?.jobs).toHaveLength(1);
        expect(controller.getActivity()).toEqual(activity);

        harness.runtime.emitOpen();
        await flushPromises();

        expect(harness.runtime.getWorkspaceSnapshot).toHaveBeenCalledTimes(2);
        expect(harness.runtime.detectContainingWorkspaceRepository).toHaveBeenCalledTimes(2);
    });

    it('registers commands for open, refresh, create, scan, and sync without auto-network actions', async () => {
        const harness = createHarness();
        await harness.controller.onStart();

        const onDidRequestOpenView = jest.fn();
        harness.controller.onDidRequestOpenView(onDidRequestOpenView);
        harness.registry.execute(WorkspaceSourcesOpenCommand.id);
        expect(onDidRequestOpenView).toHaveBeenCalledTimes(1);

        await harness.registry.execute(WorkspaceSourcesRefreshCommand.id);
        expect(harness.runtime.getWorkspaceSnapshot).toHaveBeenCalledTimes(2);
        expect(harness.runtime.detectContainingWorkspaceRepository).toHaveBeenCalledTimes(2);

        await harness.registry.execute(WorkspaceSourcesCreateCommand.id);
        expect(harness.runtime.createWorkspaceConfig).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            revisionToken: 'rev-1',
            sources: []
        });

        await harness.registry.execute(WorkspaceSourcesScanCommand.id);
        expect(harness.runtime.scanWorkspaceSources).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            roots: ['.'],
            maxDepth: 3,
            maxEntries: 100
        });
        expect(onDidRequestOpenView).toHaveBeenCalledTimes(2);

        await harness.registry.execute(WorkspaceSourcesSyncCommand.id);
        expect(harness.runtime.startWorkspaceSync).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            expectedRevision: 'rev-1',
            trustConfirmed: false
        });
        expect(harness.runtime.confirmWorkspaceSync).not.toHaveBeenCalled();
    });

    it('shows actionable suggestion notifications, deduplicates by revision, and routes Open and Ignore correctly', async () => {
        const suggestion = containingSuggestion('candidate-a', '/workspace/opened-root');
        const harness = createHarness({
            snapshot: snapshotWith({ suggestions: [suggestion] })
        });

        harness.messageService.enqueueAction('Open Workspace Sources');
        await harness.controller.onStart();
        await flushPromises();

        expect(harness.messageService.info).toHaveBeenCalledWith(
            'Workspace source suggestion: opened-root contains the opened folder and is not configured yet.',
            { timeout: 0 },
            'Open Workspace Sources',
            'Ignore'
        );
        expect(harness.commandService.executeCommand).toHaveBeenCalledWith(WorkspaceSourcesToggleCommand.id);

        harness.controller.onWorkspaceSnapshotChanged(snapshotWith({ suggestions: [suggestion] }));
        await flushPromises();
        expect(harness.messageService.info).toHaveBeenCalledTimes(1);

        harness.messageService.enqueueAction('Ignore');
        harness.controller.onWorkspaceSnapshotChanged(snapshotWith({
            configRevision: 'rev-2',
            suggestions: [suggestion]
        }));
        await flushPromises();

        expect(harness.messageService.info).toHaveBeenCalledTimes(2);
        expect(harness.runtime.ignoreWorkspaceSuggestion).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            candidateId: 'candidate-a',
            rootPath: '/workspace/opened-root'
        });
    });

    it('suppresses ignored or configured suggestions and skips containing detection for saved workspaces', async () => {
        const harness = createHarness({
            workspace: createWorkspaceState({
                saved: true,
                workspacePath: '/workspace/theia.code-workspace',
                workspaceIsDirectory: false,
                roots: ['/workspace/a', '/workspace/b']
            }),
            snapshot: snapshotWith({
                configuredSources: [{
                    sourceId: 'opened-root',
                    label: 'opened-root',
                    localPath: '/workspace/opened-root',
                    configured: true,
                    authoritative: true,
                    include: 'member'
                }],
                suggestions: [
                    containingSuggestion('candidate-a', '/workspace/opened-root', 'already-configured'),
                    containingSuggestion('candidate-b', '/workspace/ignored-root', 'ignored-locally')
                ]
            })
        });

        await harness.controller.onStart();
        await flushPromises();

        expect(harness.runtime.detectContainingWorkspaceRepository).not.toHaveBeenCalled();
        expect(harness.messageService.info).not.toHaveBeenCalled();
    });

    it('logs background failures instead of leaving rejected startup or root-change tasks unhandled', async () => {
        const harness = createHarness();
        await harness.controller.onStart();

        harness.runtime.detectContainingWorkspaceRepository.mockRejectedValueOnce(new Error('offline'));
        harness.workspace.emitLocationChanged();
        await flushPromises();

        expect(harness.logger.error).toHaveBeenCalledWith(
            'Workspace sources root detection failed during workspace-location-changed',
            expect.any(Error)
        );
    });
});

function createHarness(options: {
    snapshot?: WorkspaceSnapshot;
    workspace?: ReturnType<typeof createWorkspaceState>;
} = {}) {
    const workspace = options.workspace ?? createWorkspaceState();
    const runtime = createRuntime(options.snapshot ?? snapshotWith());
    const messageService = createMessageService();
    const logger = {
        error: jest.fn(),
        debug: jest.fn()
    };
    const sourceRootService = {
        updateSnapshot: jest.fn(),
        isRootElement: jest.fn(() => false)
    };
    const controller = new WorkspaceSourcesFrontendController();
    const registry = createRegistry();
    const commandService = {
        executeCommand: jest.fn((id: string, ...args: unknown[]) => registry.execute(id, ...args))
    };

    Object.assign(controller as object, {
        workspaceService: workspace.service,
        messageService,
        commandService,
        logger,
        sourceRootService
    });
    controller.bindRuntime(runtime.proxy as never);
    controller.registerCommands(registry as unknown as CommandRegistry);

    return {
        controller,
        runtime,
        workspace,
        messageService,
        logger,
        registry,
        commandService
    };
}

function createRuntime(initialSnapshot: WorkspaceSnapshot) {
    let openListener: (() => void) | undefined;
    let closeListener: (() => void) | undefined;
    let currentSnapshot = initialSnapshot;
    const proxy = {
        getSession: jest.fn(async () => ({
            actorId: 'actor-1',
            workspaceId: 'workspace-1',
            workspaceRootName: 'workspace',
            allowedOriginsMode: 'same-origin',
            allowedOrigins: [],
            git: { mode: 'disabled' as const },
            features: {
                fixedWorkspace: true as const,
                allowWorkspaceSwitching: false as const,
                allowGitMutations: false
            }
        })),
        getWorkspaceSnapshot: jest.fn(async () => ({
            schemaVersion: 1 as const,
            snapshot: currentSnapshot,
            notModified: false
        })),
        createWorkspaceConfig: jest.fn(async () => ({
            schemaVersion: 1 as const,
            snapshot: currentSnapshot
        })),
        addWorkspaceSource: jest.fn(),
        updateWorkspaceSource: jest.fn(),
        removeWorkspaceSource: jest.fn(),
        renameWorkspace: jest.fn(),
        readWorkspaceRawToml: jest.fn(),
        saveWorkspaceRawToml: jest.fn(),
        getWorkspaceMigrationStatus: jest.fn(),
        previewWorkspaceMigration: jest.fn(),
        applyWorkspaceMigration: jest.fn(),
        compareWorkspaceMigration: jest.fn(),
        activateWorkspaceMigration: jest.fn(),
        rollbackWorkspaceMigration: jest.fn(),
        scanWorkspaceSources: jest.fn(async () => {
            currentSnapshot = {
                ...currentSnapshot,
                config: { ...currentSnapshot.config, revision: 'rev-scan' },
                state: 'scan-preview',
                latestScan: {
                    requestId: 'scan-1',
                    generatedAt: '2026-07-29T09:01:00.000Z',
                    rootsScanned: ['/workspace'],
                    bounded: true,
                    maxDepth: 3,
                    maxEntries: 100,
                    candidates: [],
                    diagnostics: []
                },
                suggestions: []
            };
            return {
                schemaVersion: 1 as const,
                preview: currentSnapshot.latestScan!,
                suggestions: []
            };
        }),
        detectContainingWorkspaceRepository: jest.fn(async () => undefined),
        ignoreWorkspaceSuggestion: jest.fn(async (request: { candidateId: string; rootPath: string }) => ({
            schemaVersion: 1 as const,
            snapshot: snapshotWith({
                configRevision: 'rev-2',
                suggestions: [
                    containingSuggestion(request.candidateId, request.rootPath, 'ignored-locally')
                ]
            })
        })),
        unignoreWorkspaceSuggestion: jest.fn(),
        startWorkspaceSync: jest.fn(async () => {
            currentSnapshot = {
                ...currentSnapshot,
                config: { ...currentSnapshot.config, revision: 'rev-sync' },
                jobs: [{
                    jobId: 'job-sync',
                    kind: 'source-sync',
                    state: 'awaiting-confirmation',
                    phase: 'awaiting-confirmation',
                    startedAt: '2026-07-29T09:02:00.000Z',
                    updatedAt: '2026-07-29T09:02:00.000Z',
                    preview: {
                        jobId: 'job-sync',
                        requiresConfirmation: true,
                        saveConfig: false,
                        impactedSourceIds: ['studio'],
                        reasons: ['Confirmation required.']
                    },
                    sourcePreviews: [{
                        sourceId: 'studio',
                        status: 'present',
                        eligibility: 'safe',
                        forceRequired: false
                    }]
                }]
            };
            return {
                schemaVersion: 1 as const,
                job: currentSnapshot.jobs[0],
                snapshot: currentSnapshot
            };
        }),
        confirmWorkspaceSync: jest.fn(),
        cancelWorkspaceJob: jest.fn(),
        retryWorkspaceJob: jest.fn(),
        onDidOpenConnection: jest.fn(listener => {
            openListener = listener;
            return { dispose: jest.fn() };
        }),
        onDidCloseConnection: jest.fn(listener => {
            closeListener = listener;
            return { dispose: jest.fn() };
        })
    };

    return {
        proxy,
        getSession: proxy.getSession,
        getWorkspaceSnapshot: proxy.getWorkspaceSnapshot,
        createWorkspaceConfig: proxy.createWorkspaceConfig,
        addWorkspaceSource: proxy.addWorkspaceSource,
        scanWorkspaceSources: proxy.scanWorkspaceSources,
        startWorkspaceSync: proxy.startWorkspaceSync,
        confirmWorkspaceSync: proxy.confirmWorkspaceSync,
        detectContainingWorkspaceRepository: proxy.detectContainingWorkspaceRepository,
        ignoreWorkspaceSuggestion: proxy.ignoreWorkspaceSuggestion,
        emitOpen: () => openListener?.(),
        emitClose: () => closeListener?.()
    };
}

function createWorkspaceState(options: {
    saved?: boolean;
    workspacePath?: string;
    workspaceIsDirectory?: boolean;
    roots?: readonly string[];
} = {}) {
    const workspaceChanged = new Emitter<unknown>();
    const workspaceLocationChanged = new Emitter<unknown>();
    const workspacePath = options.workspacePath ?? '/workspace/opened-root';
    const roots = options.roots ?? [workspacePath];
    const workspace = {
        resource: new URI(`file://${workspacePath}`),
        isDirectory: options.workspaceIsDirectory ?? true
    };

    return {
        service: {
            ready: Promise.resolve(),
            opened: true,
            saved: options.saved ?? false,
            workspace,
            roots: Promise.resolve(roots.map(root => ({
                resource: new URI(`file://${root}`),
                isDirectory: true
            }))),
            onWorkspaceChanged: workspaceChanged.event,
            onWorkspaceLocationChanged: workspaceLocationChanged.event
        },
        emitWorkspaceChanged: () => workspaceChanged.fire(undefined),
        emitLocationChanged: () => workspaceLocationChanged.fire(undefined)
    };
}

function createMessageService() {
    const queuedActions: Array<string | undefined> = [];
    return {
        info: jest.fn(async () => queuedActions.shift()),
        enqueueAction: (action: string | undefined) => queuedActions.push(action)
    };
}

function createRegistry() {
    const handlers = new Map<string, { execute: (...args: unknown[]) => unknown }>();
    return {
        registerCommand: jest.fn((command: Command, handler: { execute: (...args: unknown[]) => unknown }) => {
            handlers.set(command.id, handler);
            return { dispose: () => handlers.delete(command.id) };
        }),
        execute: async (id: string, ...args: unknown[]) => handlers.get(id)?.execute(...args)
    };
}

function containingSuggestion(
    candidateId: string,
    rootPath: string,
    disposition: WorkspaceRepositorySuggestion['disposition'] = 'new'
): WorkspaceRepositorySuggestion {
    return {
        suggestionId: `suggestion:${candidateId}:${disposition}`,
        kind: 'containing-repository',
        candidateId,
        label: rootPath.split('/').pop() ?? candidateId,
        localPath: rootPath,
        rootPath,
        disposition,
        reason: 'Opened folder is inside a containing repository that is not configured yet.'
    };
}

function snapshotWith(options: {
    configRevision?: string;
    configuredSources?: WorkspaceSnapshot['configuredSources'];
    suggestions?: WorkspaceSnapshot['suggestions'];
    jobs?: WorkspaceSnapshot['jobs'];
} = {}): WorkspaceSnapshot {
    return {
        schemaVersion: 1,
        identity: {
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            configFileName: '.cf-workspace.toml'
        },
        config: {
            revision: options.configRevision ?? 'rev-1',
            schemaVersion: 1,
            rawTomlAvailable: true
        },
        state: 'ready',
        configuredSources: options.configuredSources ?? [{
            sourceId: 'studio',
            label: 'studio',
            localPath: '/workspace/studio',
            configured: true,
            authoritative: true,
            include: 'member'
        }],
        observedSources: [],
        suggestions: options.suggestions ?? [],
        jobs: options.jobs ?? [],
        migration: {
            mode: 'canonical-active',
            status: 'completed',
            rollbackAvailable: false
        },
        diagnostics: []
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}
