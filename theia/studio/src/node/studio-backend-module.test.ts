import 'reflect-metadata';
import * as path from 'path';
import { StudioRuntimeEndpoint } from './studio-backend-module';
import type {
    StudioAuditEntry,
    StudioOperationEvent,
    StudioRepositoryDescriptor,
    StudioRuntimeClient
} from '../common/studio-protocol';
import type {
    WorkspaceActivityEvent,
    WorkspaceMigrationStatusResponse,
    WorkspaceRepositorySuggestion,
    WorkspaceScanResponse,
    WorkspaceSnapshot,
    WorkspaceSnapshotResponse,
    WorkspaceSyncResponse
} from '../common/workspace-protocol';

describe('StudioRuntimeEndpoint', () => {
    const workspaceRoot = '/workspace';
    const configPath = path.join(workspaceRoot, '.cf-workspace.toml');

    it('starts canonical runtime with configured repository projection only', async () => {
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active',
            projectedRepositories: [
                { repositoryRoot: '/workspace/repos/present', gitDirectory: '/workspace/repos/present/.git', commonDirectory: '/workspace/repos/present/.git' },
                { repositoryRoot: '/external/repo', gitDirectory: '/external/repo/.git', commonDirectory: '/external/repo/.git' }
            ]
        });

        await harness.endpoint.onStart();

        expect(harness.workspaceBoundary.initialize).toHaveBeenCalled();
        expect(harness.repositoryDiscovery.initialize).toHaveBeenCalledWith(
            expect.objectContaining({ workspaceRoot }),
            { mode: 'canonical' }
        );
        expect(harness.workspaceSourceRegistry.reconcile).toHaveBeenCalledWith(
            harness.loadResult,
            expect.any(String)
        );
        expect(harness.repositoryRegistry.replace).toHaveBeenCalledWith(
            [...harness.projectedRepositories, harness.hostRepository],
            { allowConfiguredExternalRoots: ['/external/repo'] }
        );
        expect(harness.workspaceSyncOrchestrator.initialize).toHaveBeenCalledTimes(1);
    });

    it('starts canonical shadow runtime with the same authoritative SCM projection', async () => {
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-shadow',
            projectedRepositories: [
                { repositoryRoot: '/workspace/repos/present', gitDirectory: '/workspace/repos/present/.git', commonDirectory: '/workspace/repos/present/.git' }
            ]
        });

        await harness.endpoint.onStart();

        expect(harness.repositoryDiscovery.initialize).toHaveBeenCalledWith(
            expect.objectContaining({ workspaceRoot }),
            { mode: 'canonical' }
        );
        expect(harness.workspaceSourceRegistry.reconcile).toHaveBeenCalledWith(
            harness.loadResult,
            expect.any(String)
        );
        expect(harness.repositoryRegistry.replace).toHaveBeenCalledWith(
            [...harness.projectedRepositories, harness.hostRepository],
            { allowConfiguredExternalRoots: [] }
        );
    });

    it('keeps configured source repositories when the synthetic host repository is unavailable', async () => {
        const projectedRepository = {
            repositoryRoot: '/workspace/studio-web',
            gitDirectory: '/workspace/studio-web/.git',
            commonDirectory: '/workspace/studio-web/.git'
        };
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-managed'),
            startupMode: 'canonical-active',
            projectedRepositories: [projectedRepository],
            hostDiscoveryError: new Error('git rev-parse failed with exit code 128')
        });

        await expect(harness.endpoint.onStart()).resolves.toBeUndefined();

        expect(harness.repositoryRegistry.replace).toHaveBeenCalledWith(
            [projectedRepository],
            { allowConfiguredExternalRoots: [] }
        );
    });

    it('preserves single-folder startup when canonical config is missing without recursive SCM discovery', async () => {
        const harness = createHarness({
            loadResult: {
                detection: 'missing',
                state: 'missing',
                configPath,
                diagnostics: []
            },
            startupMode: 'single-folder'
        });

        await harness.endpoint.onStart();

        expect(harness.repositoryDiscovery.initialize).toHaveBeenCalledWith(
            expect.objectContaining({ workspaceRoot }),
            { mode: 'single-folder' }
        );
        expect(harness.workspaceSourceRegistry.reconcile).not.toHaveBeenCalled();
        expect(harness.repositoryRegistry.replace).not.toHaveBeenCalled();
    });

    it('preserves legacy startup when only the legacy workspace marker is present', async () => {
        const harness = createHarness({
            loadResult: {
                detection: 'legacy',
                state: 'legacy',
                configPath,
                diagnostics: [{ code: 'workspace.config.legacy_detected', severity: 'warning', scope: 'config', message: 'legacy', path: '/workspace/.studio-workspace.toml' }]
            },
            startupMode: 'legacy'
        });

        await harness.endpoint.onStart();

        expect(harness.repositoryDiscovery.initialize).toHaveBeenCalledWith(
            expect.objectContaining({ workspaceRoot }),
            { mode: 'legacy' }
        );
        expect((await harness.endpoint.getWorkspaceSnapshot({ workspaceId: 'workspace-1', configPath })).snapshot.migration.mode)
            .toBe('legacy');
    });

    it('fails closed for canonical diagnostics mode while still serving snapshots', async () => {
        const snapshot = workspaceSnapshot('rev-invalid');
        const harness = createHarness({
            loadResult: {
                detection: 'canonical',
                state: 'invalid',
                configPath,
                revision: 'rev-invalid',
                diagnostics: [{ code: 'invalid', severity: 'error', scope: 'config', message: 'broken', path: configPath }]
            },
            startupMode: 'canonical-diagnostics',
            snapshotResponse: {
                schemaVersion: 1,
                snapshot,
                notModified: false
            }
        });

        await harness.endpoint.onStart();

        await expect(harness.endpoint.getWorkspaceSnapshot({ workspaceId: 'workspace-1', configPath }))
            .resolves.toEqual({
                ...harness.snapshotResponse,
                snapshot: {
                    ...harness.snapshotResponse.snapshot,
                    migration: harness.workspaceMigrationService.getSnapshotState()
                }
            });
        await expect(harness.endpoint.startWorkspaceSync({
            workspaceId: 'workspace-1',
            configPath,
            expectedRevision: 'rev-invalid'
        })).rejects.toThrow('valid canonical config');
        await expect(harness.endpoint.createWorkspaceConfig({
            workspaceId: 'workspace-1',
            configPath,
            sources: []
        })).rejects.toThrow('disabled');
    });

    it('broadcasts operation, repository, snapshot, and activity events without letting one client block others', async () => {
        let operationListener: ((event: StudioOperationEvent) => void) | undefined;
        let repositoryListener: ((repositories: readonly StudioRepositoryDescriptor[]) => void) | undefined;
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active'
        });
        (harness.operationQueue.subscribe as jest.Mock).mockImplementation((listener: (event: StudioOperationEvent) => void) => {
            operationListener = listener;
            return jest.fn();
        });
        (harness.repositoryRegistry.onDidChangeRepositories as jest.Mock).mockImplementation((listener: (repositories: readonly StudioRepositoryDescriptor[]) => void) => {
            repositoryListener = listener;
            return { dispose: jest.fn() };
        });
        const first = createClient();
        first.client.onWorkspaceSnapshotChanged = jest.fn(() => {
            throw new Error('disconnect');
        });
        const second = createClient();

        harness.endpoint.addClient(first.client);
        harness.endpoint.addClient(second.client);
        await harness.endpoint.onStart();

        operationListener?.(operationEvent());
        repositoryListener?.([repositoryDescriptor()]);
        harness.emitSnapshot(workspaceSnapshot('rev-2'));
        harness.emitActivity(workspaceActivityEvent('job-1'));

        expect(first.onOperationEvent).toHaveBeenCalledTimes(1);
        expect(second.onOperationEvent).toHaveBeenCalledTimes(1);
        expect(first.onRepositoriesChanged).toHaveBeenCalledTimes(1);
        expect(second.onRepositoriesChanged).toHaveBeenCalledTimes(1);
        expect(second.onWorkspaceSnapshotChanged).toHaveBeenCalledTimes(1);
        expect(second.onWorkspaceActivityEvent).toHaveBeenCalledTimes(1);

        harness.endpoint.removeClient(first.client);
        operationListener?.(operationEvent());
        expect(second.onOperationEvent).toHaveBeenCalledTimes(2);
    });

    it('validates workspace identity and path-bounds requests', async () => {
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active'
        });
        await harness.endpoint.onStart();

        await expect(harness.endpoint.getWorkspaceSnapshot({ workspaceId: 'wrong', configPath }))
            .rejects.toThrow('Workspace mismatch');
        await expect(harness.endpoint.scanWorkspaceSources({
            workspaceId: 'workspace-1',
            configPath,
            roots: ['../escape'],
            maxDepth: 1,
            maxEntries: 10
        })).rejects.toThrow('within the explicit workspace root');
        await expect(harness.endpoint.detectContainingWorkspaceRepository({
            workspaceId: 'workspace-1',
            configPath,
            openedPath: '/tmp/outside'
        })).rejects.toThrow('within the explicit workspace root');
    });

    it('maps applied mutations to snapshot responses and delegates save-and-sync through the orchestrator', async () => {
        const snapshot = workspaceSnapshot('rev-2');
        const syncResponse = workspaceSyncResponse(snapshot);
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active',
            refreshResult: validLoadResult(configPath, 'rev-2'),
            snapshotResponse: {
                schemaVersion: 1,
                snapshot,
                notModified: false
            },
            mutationResult: {
                status: 'applied',
                configPath,
                revision: 'rev-2',
                loadResult: validLoadResult(configPath, 'rev-2')
            },
            syncAfterMutation: syncResponse
        });
        await harness.endpoint.onStart();

        const response = await harness.endpoint.saveWorkspaceRawToml({
            workspaceId: 'workspace-1',
            configPath,
            expectedRevision: 'rev-1',
            rawToml: 'version = "1.0"\n',
            sync: {
                sourceIds: ['studio'],
                trustConfirmed: true
            }
        });

        expect(harness.workspaceConfigMutationService.saveRawToml).toHaveBeenCalledWith(workspaceRoot, {
            expectedRevision: 'rev-1',
            rawToml: 'version = "1.0"\n'
        });
        expect(harness.workspaceSyncOrchestrator.startSyncAfterMutation).toHaveBeenCalledWith(
            harness.mutationResult,
            { sourceIds: ['studio'], trustConfirmed: true }
        );
        expect(response.sync).toEqual(syncResponse);
        expect(response.snapshot).toEqual(snapshot);
    });

    it('delegates scan, suggestion ignore, cancel, and retry calls to the focused workspace services', async () => {
        const scanResponse: WorkspaceScanResponse = {
            schemaVersion: 1,
            preview: {
                requestId: 'scan-1',
                generatedAt: '2026-07-29T00:00:00.000Z',
                rootsScanned: ['.'],
                bounded: true,
                maxDepth: 1,
                maxEntries: 10,
                candidates: [],
                diagnostics: []
            },
            suggestions: []
        };
        const suggestion: WorkspaceRepositorySuggestion = {
            suggestionId: 'suggestion-1',
            kind: 'containing-repository',
            candidateId: 'candidate-1',
            label: 'repo',
            localPath: '/workspace/repo',
            rootPath: '/workspace/repo',
            disposition: 'new',
            reason: 'candidate'
        };
        const syncResponse = workspaceSyncResponse(workspaceSnapshot('rev-1'));
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active',
            scanResponse,
            suggestion,
            cancelResponse: syncResponse,
            retryResponse: syncResponse
        });
        await harness.endpoint.onStart();

        expect(await harness.endpoint.scanWorkspaceSources({
            workspaceId: 'workspace-1',
            configPath,
            roots: ['.'],
            maxDepth: 1,
            maxEntries: 10
        })).toEqual(scanResponse);
        expect(await harness.endpoint.detectContainingWorkspaceRepository({
            workspaceId: 'workspace-1',
            configPath,
            openedPath: 'repo/README.md'
        })).toEqual(suggestion);

        await harness.endpoint.ignoreWorkspaceSuggestion({
            workspaceId: 'workspace-1',
            configPath,
            candidateId: 'candidate-1',
            rootPath: 'repo'
        });
        await harness.endpoint.unignoreWorkspaceSuggestion({
            workspaceId: 'workspace-1',
            configPath,
            candidateId: 'candidate-1',
            rootPath: 'repo'
        });
        await harness.endpoint.cancelWorkspaceJob({
            workspaceId: 'workspace-1',
            configPath,
            jobId: 'job-1'
        });
        await harness.endpoint.retryWorkspaceJob({
            workspaceId: 'workspace-1',
            configPath,
            jobId: 'job-1',
            trustConfirmed: true
        });

        expect(harness.workspaceDiscoveryService.ignoreSuggestion).toHaveBeenCalledWith('candidate-1', 'repo');
        expect(harness.workspaceDiscoveryService.unignoreSuggestion).toHaveBeenCalledWith('candidate-1', 'repo');
        expect(harness.workspaceSyncOrchestrator.cancelJob).toHaveBeenCalledWith({ jobId: 'job-1' });
        expect(harness.workspaceSyncOrchestrator.retryJob).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath,
            jobId: 'job-1',
            trustConfirmed: true
        });
    });

    it('routes migration RPCs through the migration service and decorates snapshots', async () => {
        const migrationStatus: WorkspaceMigrationStatusResponse = {
            schemaVersion: 1,
            migration: {
                mode: 'canonical-shadow',
                status: 'completed',
                transactionId: 'txn-1',
                recoveryState: 'available',
                rollbackAvailable: true
            },
            diagnostics: []
        };
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-shadow',
            migrationStatus
        });
        await harness.endpoint.onStart();

        expect((await harness.endpoint.getWorkspaceSnapshot({ workspaceId: 'workspace-1', configPath })).snapshot.migration.mode)
            .toBe('canonical-shadow');
        expect(await harness.endpoint.getWorkspaceMigrationStatus({ workspaceId: 'workspace-1', configPath }))
            .toEqual(migrationStatus);
        expect(await harness.endpoint.compareWorkspaceMigration({ workspaceId: 'workspace-1', configPath }))
            .toEqual(migrationStatus);
        expect(harness.workspaceMigrationService.compareShadow).toHaveBeenCalled();
    });

    it('switches repository membership to canonical projection after applying migration', async () => {
        const harness = createHarness({
            loadResult: {
                detection: 'legacy',
                state: 'legacy',
                configPath,
                diagnostics: []
            },
            refreshResult: validLoadResult(configPath, 'rev-2'),
            startupMode: 'legacy',
            projectedRepositories: [
                { repositoryRoot: '/workspace/repos/present', gitDirectory: '/workspace/repos/present/.git', commonDirectory: '/workspace/repos/present/.git' }
            ]
        });
        harness.workspaceMigrationService.getStartupMode
            .mockReturnValueOnce('legacy')
            .mockReturnValueOnce('canonical-shadow');

        await harness.endpoint.onStart();
        await harness.endpoint.applyWorkspaceMigration({ workspaceId: 'workspace-1', configPath });

        expect(harness.repositoryDiscovery.initialize).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ workspaceRoot }),
            { mode: 'legacy' }
        );
        expect(harness.repositoryDiscovery.initialize).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ workspaceRoot }),
            { mode: 'canonical' }
        );
        expect(harness.workspaceSourceRegistry.reconcile).toHaveBeenCalledWith(
            validLoadResult(configPath, 'rev-2'),
            expect.any(String)
        );
        expect(harness.repositoryRegistry.replace).toHaveBeenCalledWith(
            [...harness.projectedRepositories, harness.hostRepository],
            { allowConfiguredExternalRoots: [] }
        );
    });

    it('shows a notification only to clients that can display one', async () => {
        // The event forwarder is a client too, and it has no UI: `shown` must
        // count the clients that can act, not the connections.
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active'
        });
        const forwarder = createClient();
        const browser = createClient();
        const onNotifyEditor = jest.fn();
        browser.client.onNotifyEditor = onNotifyEditor;

        harness.endpoint.addClient(forwarder.client);
        harness.endpoint.addClient(browser.client);
        await harness.endpoint.onStart();

        const request = { level: 'warn' as const, message: 'the import failed', source: 'Studio' };
        await expect(harness.endpoint.notifyEditor(request)).resolves.toEqual({ shown: true });
        expect(onNotifyEditor).toHaveBeenCalledWith(request);
    });

    it('reports a notification as unshown when no client has a UI', async () => {
        // A session whose tab nobody has open. Not an error — the caller
        // decides whether an unseen notification matters.
        const harness = createHarness({
            loadResult: validLoadResult(configPath, 'rev-1'),
            startupMode: 'canonical-active'
        });
        harness.endpoint.addClient(createClient().client);
        await harness.endpoint.onStart();

        await expect(
            harness.endpoint.notifyEditor({ level: 'info', message: 'nobody is looking' })
        ).resolves.toEqual({ shown: false });
    });

});

function createHarness(options: {
    loadResult: any;
    startupMode?: any;
    refreshResult?: any;
    snapshotResponse?: WorkspaceSnapshotResponse;
    mutationResult?: any;
    migrationStatus?: WorkspaceMigrationStatusResponse;
    scanResponse?: WorkspaceScanResponse;
    suggestion?: WorkspaceRepositorySuggestion;
    projectedRepositories?: readonly any[];
    hostDiscoveryError?: Error;
    syncAfterMutation?: WorkspaceSyncResponse;
    cancelResponse?: WorkspaceSyncResponse;
    retryResponse?: WorkspaceSyncResponse;
}) {
    const loadResults = [options.loadResult, options.refreshResult ?? options.loadResult];
    const runtimeConfigService = {
        getConfig: () => ({
            actorId: 'actor-1',
            workspaceId: 'workspace-1',
            workspaceRoot: '/workspace',
            repositoryRoot: '/workspace',
            dataDir: '/data',
            allowedOriginsMode: 'same-origin',
            allowedOrigins: [],
            trustProxy: false,
            git: { mode: 'disabled' },
            secrets: {}
        })
    };
    const workspaceBoundary = {
        initialize: jest.fn(),
        assertWorkspaceId: jest.fn((workspaceId: string) => {
            if (workspaceId !== 'workspace-1') {
                throw new Error('Workspace mismatch is not allowed');
            }
        })
    };
    const operationQueue = {
        initialize: jest.fn(),
        subscribe: jest.fn(() => jest.fn()),
        getAuditEntriesAfter: jest.fn((sequence: number) => ({
            lastSequence: sequence + 1,
            entries: [auditEntry(sequence + 1)]
        })),
        enqueue: jest.fn(),
        getEventsAfter: jest.fn(),
        retry: jest.fn()
    };
    const repositoryDiscovery = {
        initialize: jest.fn(),
        discoverConfiguredRepositoryRegistration: jest.fn(async () => {
            if (options.hostDiscoveryError) {
                throw options.hostDiscoveryError;
            }
            return {
                repositoryRoot: '/workspace',
                gitDirectory: '/workspace/.git',
                commonDirectory: '/workspace/.git'
            };
        }),
        dispose: jest.fn()
    };
    const repositoryRegistry = {
        descriptors: [],
        replace: jest.fn(),
        onDidChangeRepositories: jest.fn((_listener: (repositories: readonly StudioRepositoryDescriptor[]) => void) => ({ dispose: jest.fn() })),
        resolveOwnerForCanonicalPath: jest.fn(() => ({
            descriptor: repositoryDescriptor(),
            canonicalRoot: '/workspace'
        })),
        dispose: jest.fn()
    };
    const workspaceConfigService = {
        load: jest.fn(async () => loadResults.shift() ?? options.refreshResult ?? options.loadResult)
    };
    const mutationResult = options.mutationResult ?? {
        status: 'conflict',
        code: 'invalid-request',
        message: 'no-op',
        configPath: '/workspace/.cf-workspace.toml',
        diagnostics: []
    };
    const workspaceConfigMutationService = {
        create: jest.fn(async () => mutationResult),
        addSource: jest.fn(async () => mutationResult),
        updateSource: jest.fn(async () => mutationResult),
        removeSource: jest.fn(async () => mutationResult),
        renameSource: jest.fn(async () => mutationResult),
        saveRawToml: jest.fn(async () => mutationResult)
    };
    const migrationStatus = options.migrationStatus ?? {
        schemaVersion: 1,
        migration: {
            mode: options.startupMode ?? 'canonical-active',
            status: 'not-needed',
            rollbackAvailable: false
        },
        diagnostics: []
    };
    const workspaceMigrationService = {
        initialize: jest.fn(async () => ({
            mode: options.startupMode ?? 'canonical-active',
            migration: migrationStatus.migration,
            diagnostics: migrationStatus.diagnostics
        })),
        getStartupMode: jest.fn(() => options.startupMode ?? 'canonical-active'),
        getSnapshotState: jest.fn(() => migrationStatus.migration),
        getStatus: jest.fn(async () => migrationStatus),
        previewMigration: jest.fn(async () => migrationStatus),
        applyMigration: jest.fn(async () => migrationStatus),
        compareShadow: jest.fn(async () => migrationStatus),
        activateCanonical: jest.fn(async () => migrationStatus),
        rollbackMigration: jest.fn(async () => migrationStatus)
    };
    const projectedRepositories = options.projectedRepositories ?? [];
    const workspaceSourceRegistry = {
        reconcile: jest.fn(async () => undefined),
        projectRepositories: jest.fn(async () => projectedRepositories),
        dispose: jest.fn()
    };
    const workspaceDiscoveryService = {
        scan: jest.fn(async () => options.scanResponse ?? {
            schemaVersion: 1,
            preview: {
                requestId: 'scan-default',
                generatedAt: '2026-07-29T00:00:00.000Z',
                rootsScanned: ['.'],
                bounded: true,
                maxDepth: 1,
                maxEntries: 10,
                candidates: [],
                diagnostics: []
            },
            suggestions: []
        }),
        detectContainingRepository: jest.fn(async () => options.suggestion),
        ignoreSuggestion: jest.fn(async () => undefined),
        unignoreSuggestion: jest.fn(async () => undefined)
    };
    const snapshotResponse = options.snapshotResponse ?? {
        schemaVersion: 1,
        snapshot: workspaceSnapshot(options.loadResult.revision ?? 'missing'),
        notModified: false
    };
    const snapshotListeners: Array<(snapshot: WorkspaceSnapshot) => void> = [];
    const activityListeners: Array<(event: WorkspaceActivityEvent) => void> = [];
    const workspaceSyncOrchestrator = {
        initialize: jest.fn(async () => undefined),
        dispose: jest.fn(),
        onDidChangeSnapshot: jest.fn((listener: (snapshot: WorkspaceSnapshot) => void) => {
            snapshotListeners.push(listener);
            return { dispose: jest.fn() };
        }),
        onDidChangeActivity: jest.fn((listener: (event: WorkspaceActivityEvent) => void) => {
            activityListeners.push(listener);
            return { dispose: jest.fn() };
        }),
        getSnapshotResponse: jest.fn(async () => snapshotResponse),
        refresh: jest.fn(async () => snapshotResponse.snapshot),
        currentSnapshot: snapshotResponse.snapshot,
        startSync: jest.fn(async () => workspaceSyncResponse(snapshotResponse.snapshot)),
        confirmSync: jest.fn(async () => workspaceSyncResponse(snapshotResponse.snapshot)),
        cancelJob: jest.fn(async () => options.cancelResponse ?? workspaceSyncResponse(snapshotResponse.snapshot)),
        retryJob: jest.fn(async () => options.retryResponse ?? workspaceSyncResponse(snapshotResponse.snapshot)),
        startSyncAfterMutation: jest.fn(async () => options.syncAfterMutation)
    };
    const endpoint = new StudioRuntimeEndpoint(
        runtimeConfigService as any,
        workspaceBoundary as any,
        operationQueue as any,
        repositoryDiscovery as any,
        repositoryRegistry as any,
        workspaceConfigService as any,
        workspaceConfigMutationService as any,
        workspaceMigrationService as any,
        workspaceSourceRegistry as any,
        workspaceDiscoveryService as any,
        workspaceSyncOrchestrator as any,
        { install: jest.fn() } as any
    );

    return {
        endpoint,
        loadResult: options.loadResult,
        mutationResult,
        projectedRepositories,
        hostRepository: {
            repositoryRoot: '/workspace',
            gitDirectory: '/workspace/.git',
            commonDirectory: '/workspace/.git'
        },
        snapshotResponse,
        workspaceBoundary,
        operationQueue,
        repositoryDiscovery,
        repositoryRegistry,
        workspaceConfigMutationService,
        workspaceMigrationService,
        workspaceSourceRegistry,
        workspaceDiscoveryService,
        workspaceSyncOrchestrator,
        emitSnapshot: (snapshot: WorkspaceSnapshot) => snapshotListeners.forEach(listener => listener(snapshot)),
        emitActivity: (event: WorkspaceActivityEvent) => activityListeners.forEach(listener => listener(event))
    };
}

function createClient() {
    const onOperationEvent = jest.fn();
    const onAuditEvent = jest.fn();
    const onRepositoriesChanged = jest.fn();
    const onWorkspaceSnapshotChanged = jest.fn();
    const onWorkspaceActivityEvent = jest.fn();
    return {
        client: {
            onOperationEvent,
            onAuditEvent,
            onRepositoriesChanged,
            onWorkspaceSnapshotChanged,
            onWorkspaceActivityEvent
        } as StudioRuntimeClient,
        onOperationEvent,
        onAuditEvent,
        onRepositoriesChanged,
        onWorkspaceSnapshotChanged,
        onWorkspaceActivityEvent
    };
}

function validLoadResult(configPath: string, revision: string) {
    return {
        detection: 'canonical',
        state: 'valid',
        configPath,
        revision,
        rawToml: 'version = "1.0"\n',
        parsedData: {
            version: '1.0',
            sources: {}
        },
        diagnostics: []
    };
}

function workspaceSnapshot(revision: string): WorkspaceSnapshot {
    return {
        schemaVersion: 1,
        identity: {
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            configFileName: '.cf-workspace.toml'
        },
        config: {
            revision,
            schemaVersion: 1,
            rawTomlAvailable: true
        },
        state: 'ready',
        configuredSources: [],
        observedSources: [],
        suggestions: [],
        jobs: [],
        migration: {
            mode: 'canonical-active',
            status: 'not-needed',
            rollbackAvailable: false
        },
        diagnostics: []
    };
}

function workspaceSyncResponse(snapshot: WorkspaceSnapshot): WorkspaceSyncResponse {
    return {
        schemaVersion: 1,
        job: {
            jobId: 'job-1',
            kind: 'source-sync',
            state: 'completed',
            phase: 'completed',
            startedAt: '2026-07-29T00:00:00.000Z',
            updatedAt: '2026-07-29T00:00:01.000Z'
        },
        snapshot
    };
}

function workspaceActivityEvent(jobId: string): WorkspaceActivityEvent {
    return {
        schemaVersion: 1,
        eventId: `event-${jobId}`,
        snapshotRevision: 'rev-1',
        job: {
            jobId,
            kind: 'source-sync',
            state: 'running',
            phase: 'syncing-sources',
            startedAt: '2026-07-29T00:00:00.000Z',
            updatedAt: '2026-07-29T00:00:01.000Z'
        }
    };
}

function auditEntry(sequence: number): StudioAuditEntry {
    return {
        sequence,
        relativePath: 'README.md',
        contentHash: 'a'.repeat(64),
        sha: '',
        time: '2026-07-29T00:00:00.000Z',
        outcome: 'modified'
    };
}

function operationEvent(): StudioOperationEvent {
    return {
        journalSchemaVersion: 2,
        sequence: 1,
        operationId: 'operation',
        workspaceId: 'workspace-1',
        repositoryId: 'repository',
        repositoryFingerprint: 'fingerprint',
        repositoryConfigRevision: 'config',
        relativePath: 'README.md',
        repositoryRelativePath: 'README.md',
        languageId: 'markdown',
        contentHash: 'hash',
        idempotencyKey: 'key',
        savedAt: '2026-07-29T00:00:00.000Z',
        state: 'queued',
        timestamp: '2026-07-29T00:00:00.000Z'
    };
}

function repositoryDescriptor(): StudioRepositoryDescriptor {
    return {
        schemaVersion: 1,
        repositoryId: 'repository',
        fingerprint: 'fingerprint',
        rootUri: 'file:///workspace',
        workspaceRelativeRoot: '.',
        label: 'workspace',
        git: {
            configRevision: 'config',
            mode: 'disabled',
            publishEnabled: false
        }
    };
}
