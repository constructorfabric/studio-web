import * as path from 'path';
import * as express from '@theia/core/shared/express';
import { ContainerModule } from '@theia/core/shared/inversify';
import { mountStudioControlApi } from './studio-control-api';
import { StudioEventForwarder, resolveForwarderConfig } from './studio-event-forwarder';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, Disposable, DisposableCollection, RpcConnectionHandler } from '@theia/core/lib/common';
import {
    StudioRuntimeService,
    studioRuntimeServicePath,
    type EnqueueStudioOperationRequest,
    type StudioAuditDeltaRequest,
    type StudioOperationDeltaRequest,
    type StudioOpenInEditorRequest,
    type StudioOpenInEditorResult,
    type StudioRetryOperationRequest,
    type StudioRuntimeClient,
    type StudioWorkspaceRequest
} from '../common/studio-protocol';
import {
    WORKSPACE_PROTOCOL_SCHEMA_VERSION,
    type WorkspaceMigrationActivateRequest,
    type WorkspaceMigrationRequest,
    type WorkspaceMigrationRollbackRequest,
    type WorkspaceMigrationStatusResponse,
    type ConfirmWorkspaceSyncRequest,
    type CreateWorkspaceConfigRequest,
    type DetectContainingWorkspaceRepositoryRequest,
    type ReadWorkspaceRawTomlRequest,
    type ReadWorkspaceRawTomlResponse,
    type RemoveWorkspaceSourceRequest,
    type RenameWorkspaceRequest,
    type RetryWorkspaceJobRequest,
    type SaveWorkspaceRawTomlRequest,
    type StartWorkspaceSyncRequest,
    type UpdateWorkspaceConfigRequest,
    type UpdateWorkspaceSuggestionRequest,
    type WorkspaceConfigConflict,
    type WorkspaceConfigMutationResponse,
    type WorkspaceConfiguredSource,
    type WorkspaceDiagnostic,
    type WorkspacePostMutationSyncRequest,
    type WorkspaceRepositorySuggestion,
    type WorkspaceScanRequest,
    type WorkspaceScanResponse,
    type WorkspaceSnapshot,
    type WorkspaceSnapshotRequest,
    type WorkspaceSnapshotResponse,
    type WorkspaceSyncResponse
} from '../common/workspace-protocol';
import {
    WorkspaceGraphService,
    workspaceGraphServicePath,
    type WorkspaceGraphClient
} from '../common/graph-model';
import { StudioRuntimeConfigService, createBrowserSession } from './studio-runtime-config';
import { WorkspaceBoundary } from './workspace-boundary';
import { GitExecutor } from './git-executor';
import { OrcaCli } from './orca-cli';
import { OrcaServiceImpl } from './orca-service';
import { orcaServicePath, type OrcaService } from '../common/orca-protocol';
import { GitPublishService } from './git-publish-service';
import { OperationJournal } from './operation-journal';
import { RepositoryOperationQueue } from './repository-operation-queue';
import { RepositoryDiscoveryService } from './repository-discovery-service';
import { RepositoryRegistry } from './repository-registry';
import { CfsMapRunner, CfsMapRunnerImpl } from './cfs-map-runner';
import { KitInstaller, KitInstallerImpl } from './kit-installer';
import { WorkspaceGraphServiceImpl } from './workspace-graph-service';
import {
    CANONICAL_WORKSPACE_CONFIG_FILENAME,
    type WorkspaceSourceEntry,
    WorkspaceConfigService
} from './workspace-config-service';
import {
    WorkspaceConfigMutationService,
    type WorkspaceConfigMutationResult
} from './workspace-config-mutation-service';
import { WorkspaceDiscoveryService } from './workspace-discovery-service';
import { WorkspaceGitService } from './workspace-git-service';
import { WorkspaceMigrationService, type WorkspaceStartupMode } from './workspace-migration-service';
import { WorkspaceSourceRegistry } from './workspace-source-registry';
import { WorkspaceSyncOrchestrator } from './workspace-sync-orchestrator';

type WorkspaceRuntimeMode = WorkspaceStartupMode;

export class StudioRuntimeEndpoint implements StudioRuntimeService, BackendApplicationContribution {
    protected readonly clients = new Set<StudioRuntimeClient>();
    protected readonly toDispose = new DisposableCollection();
    protected runtimeMode: WorkspaceRuntimeMode = 'legacy';
    protected canonicalConfigPath = '';
    protected workspaceRoot = '';
    // Bridge status (ADR-0010): set once onStart completes; the max operation
    // sequence observed, so the control API's runtime status is cheap.
    protected started = false;
    protected lastEventSequence = 0;

    constructor(
        protected readonly runtimeConfigService: StudioRuntimeConfigService,
        protected readonly workspaceBoundary: WorkspaceBoundary,
        protected readonly operationQueue: RepositoryOperationQueue,
        protected readonly repositoryDiscovery: RepositoryDiscoveryService,
        protected readonly repositoryRegistry: RepositoryRegistry,
        protected readonly workspaceConfigService: WorkspaceConfigService,
        protected readonly workspaceConfigMutationService: WorkspaceConfigMutationService,
        protected readonly workspaceMigrationService: WorkspaceMigrationService,
        protected readonly workspaceSourceRegistry: WorkspaceSourceRegistry,
        protected readonly workspaceDiscoveryService: WorkspaceDiscoveryService,
        protected readonly workspaceSyncOrchestrator: WorkspaceSyncOrchestrator,
        protected readonly kitInstaller: KitInstallerImpl
    ) { }

    async onStart(): Promise<void> {
        const config = this.runtimeConfigService.getConfig();
        this.workspaceRoot = config.workspaceRoot;
        this.canonicalConfigPath = path.join(path.resolve(config.workspaceRoot), CANONICAL_WORKSPACE_CONFIG_FILENAME);
        await this.workspaceBoundary.initialize(config);

        await this.workspaceMigrationService.initialize(config.workspaceRoot, path.join(config.dataDir, 'workspace-migration'));
        const loadResult = await this.workspaceConfigService.load(config.workspaceRoot);
        this.runtimeMode = this.workspaceMigrationService.getStartupMode();
        await this.configureRepositoryMembership(loadResult);

        await this.workspaceSyncOrchestrator.initialize();
        this.toDispose.push(Disposable.create(
            this.operationQueue.subscribe(event => {
                this.lastEventSequence = Math.max(this.lastEventSequence, event.sequence);
                this.broadcast(client => {
                    client.onOperationEvent(event);
                    const auditEntry = this.operationQueue.getAuditEntriesAfter(event.sequence - 1).entries[0];
                    if (auditEntry) {
                        client.onAuditEvent?.(auditEntry);
                    }
                });
            })
        ));
        this.toDispose.push(this.repositoryRegistry.onDidChangeRepositories(repositories =>
            this.broadcast(client => client.onRepositoriesChanged(repositories))
        ));
        this.toDispose.push(this.workspaceSyncOrchestrator.onDidChangeSnapshot(snapshot =>
            this.broadcast(client => client.onWorkspaceSnapshotChanged?.(this.decorateSnapshot(snapshot)))
        ));
        this.toDispose.push(this.workspaceSyncOrchestrator.onDidChangeActivity(event =>
            this.broadcast(client => client.onWorkspaceActivityEvent?.(event))
        ));
        const forwarderConfig = resolveForwarderConfig(config.workspaceId);
        if (forwarderConfig) {
            const forwarder = new StudioEventForwarder(forwarderConfig);
            this.addClient(forwarder);
            this.toDispose.push(Disposable.create(() => this.removeClient(forwarder)));
        }
        await this.operationQueue.initialize();
        this.started = true;
    }

    /**
     * Mount the internal S2S control API (ADR-0010). Dormant unless the
     * STUDIO_THEIA_S2S_TOKEN is set, so a normal IDE session is unaffected.
     */
    configure(app: express.Application): void {
        mountStudioControlApi(app, {
            workspaceId: () => this.runtimeConfigService.getConfig().workspaceId,
            runtimeStatus: () => ({
                ready: this.started,
                workspaceMode: this.runtimeMode,
                activeClients: this.clients.size,
                lastEventSequence: this.lastEventSequence,
                version: (process.env.STUDIO_THEIA_VERSION ?? '').trim() || 'dev'
            }),
            getSession: () => this.getSession(),
            getRepositories: () => this.getRepositories(),
            projectRepositoryId: () =>
                this.repositoryRegistry.configuredRepository?.descriptor.repositoryId,
            enqueueOperation: request => this.enqueueOperation(request),
            getOperationDeltas: request => this.getOperationDeltas(request),
            retryOperation: request => this.retryOperation(request),
            openInEditor: request => this.openInEditor(request),
            installKit: request => this.kitInstaller.install(request, this.repositoryRegistry)
        });
    }

    async getSession() {
        return createBrowserSession(this.runtimeConfigService.getConfig());
    }

    async getRepositories() {
        return this.repositoryRegistry.descriptors;
    }

    async openInEditor(request: StudioOpenInEditorRequest): Promise<StudioOpenInEditorResult> {
        // Broadcast to the runtime clients; browser clients open the file, the
        // event forwarder (no onOpenInEditor) is skipped. `delivered` counts the
        // clients that can act on it, so a session with no open browser tab
        // reports opened:false instead of a false positive.
        let delivered = 0;
        this.broadcast(client => {
            if (client.onOpenInEditor) {
                client.onOpenInEditor(request);
                delivered++;
            }
        });
        return { opened: delivered > 0, resolvedRelativePath: request.relativePath };
    }

    async resolveWorkspacePath(request: StudioWorkspaceRequest) {
        const resolved = await this.workspaceBoundary.resolveWorkspaceLocation(request);
        if (!resolved.location.exists) {
            return resolved.location;
        }
        const owner = this.repositoryRegistry.resolveOwnerForCanonicalPath(resolved.absolutePath);
        return {
            ...resolved.location,
            repositoryId: owner.descriptor.repositoryId,
            repositoryFingerprint: owner.descriptor.fingerprint,
            repositoryRootUri: owner.descriptor.rootUri,
            repositoryRelativePath: toRepositoryRelativePath(
                owner.canonicalRoot,
                resolved.absolutePath,
                resolved.location.isDirectory
            )
        };
    }

    addClient(client: StudioRuntimeClient): void {
        this.clients.add(client);
    }

    setClient(client: StudioRuntimeClient | undefined): void {
        if (client) {
            this.addClient(client);
        }
    }

    removeClient(client: StudioRuntimeClient): void {
        this.clients.delete(client);
    }

    dispose(): void {
        this.repositoryDiscovery.dispose();
        this.workspaceSourceRegistry.dispose();
        this.workspaceSyncOrchestrator.dispose();
        this.toDispose.dispose();
        this.repositoryRegistry.dispose();
        this.clients.clear();
    }

    async enqueueOperation(request: EnqueueStudioOperationRequest) {
        return this.operationQueue.enqueue(request);
    }

    async getOperationDeltas(request: StudioOperationDeltaRequest) {
        return this.operationQueue.getEventsAfter(request.afterSequence);
    }

    async getAuditDeltas(request: StudioAuditDeltaRequest) {
        return this.operationQueue.getAuditEntriesAfter(request.afterSequence);
    }

    async retryOperation(request: StudioRetryOperationRequest) {
        return this.operationQueue.retry(request.operationId);
    }

    async getWorkspaceSnapshot(request: WorkspaceSnapshotRequest = {}): Promise<WorkspaceSnapshotResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const response = await this.workspaceSyncOrchestrator.getSnapshotResponse(request.knownRevision);
        return {
            ...response,
            snapshot: this.decorateSnapshot(response.snapshot)
        };
    }

    async readWorkspaceRawToml(request: ReadWorkspaceRawTomlRequest = {}): Promise<ReadWorkspaceRawTomlResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const loadResult = await this.workspaceConfigService.load(this.workspaceRoot);
        return {
            schemaVersion: WORKSPACE_PROTOCOL_SCHEMA_VERSION,
            configPath: loadResult.configPath,
            revision: loadResult.revision ?? 'missing',
            rawToml: loadResult.rawToml,
            diagnostics: freezeDiagnostics(loadResult.diagnostics)
        };
    }

    async createWorkspaceConfig(request: CreateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertMutationsAllowed();
        const result = await this.workspaceConfigMutationService.create(this.workspaceRoot, {
            expectedRevision: request.revisionToken,
            sources: mapConfiguredSourcesForCreate(this.workspaceRoot, request.sources)
        });
        return this.toMutationResponse(result, request.sync);
    }

    async addWorkspaceSource(request: UpdateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertMutationsAllowed();
        const result = await this.workspaceConfigMutationService.addSource(this.workspaceRoot, {
            expectedRevision: request.expectedRevision,
            sourceId: request.source.sourceId,
            source: this.toWorkspaceSourceEntry(request.source)
        });
        return this.toMutationResponse(result, request.sync);
    }

    async updateWorkspaceSource(request: UpdateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertMutationsAllowed();
        const result = await this.workspaceConfigMutationService.updateSource(this.workspaceRoot, {
            expectedRevision: request.expectedRevision,
            sourceId: request.source.sourceId,
            ...this.toWorkspaceSourceEntry(request.source)
        });
        return this.toMutationResponse(result, request.sync);
    }

    async removeWorkspaceSource(request: RemoveWorkspaceSourceRequest): Promise<WorkspaceConfigMutationResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertMutationsAllowed();
        const result = await this.workspaceConfigMutationService.removeSource(this.workspaceRoot, {
            expectedRevision: request.expectedRevision,
            sourceId: request.sourceId
        });
        return this.toMutationResponse(result, request.sync);
    }

    async renameWorkspace(request: RenameWorkspaceRequest): Promise<WorkspaceConfigMutationResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertMutationsAllowed();
        const result = await this.workspaceConfigMutationService.renameSource(this.workspaceRoot, {
            expectedRevision: request.expectedRevision,
            sourceId: request.sourceId,
            nextSourceId: request.nextSourceId,
            confirmedImpactIds: request.confirmedImpactIds
        });
        return this.toMutationResponse(result, request.sync);
    }

    async saveWorkspaceRawToml(request: SaveWorkspaceRawTomlRequest): Promise<WorkspaceConfigMutationResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertMutationsAllowed();
        const result = await this.workspaceConfigMutationService.saveRawToml(this.workspaceRoot, {
            expectedRevision: request.expectedRevision,
            rawToml: request.rawToml
        });
        return this.toMutationResponse(result, request.sync);
    }

    async scanWorkspaceSources(request: WorkspaceScanRequest): Promise<WorkspaceScanResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        for (const root of request.roots) {
            this.assertPathWithinWorkspace(root, 'roots');
        }
        const snapshot = (await this.workspaceSyncOrchestrator.getSnapshotResponse()).snapshot;
        return this.workspaceDiscoveryService.scan(request, snapshot);
    }

    async detectContainingWorkspaceRepository(
        request: DetectContainingWorkspaceRepositoryRequest
    ): Promise<WorkspaceRepositorySuggestion | undefined> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertPathWithinWorkspace(request.openedPath, 'openedPath');
        const snapshot = (await this.workspaceSyncOrchestrator.getSnapshotResponse()).snapshot;
        return this.workspaceDiscoveryService.detectContainingRepository(
            request.openedPath,
            this.workspaceRoot,
            snapshot
        );
    }

    async ignoreWorkspaceSuggestion(request: UpdateWorkspaceSuggestionRequest): Promise<WorkspaceSnapshotResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertPathWithinWorkspace(request.rootPath, 'rootPath');
        await this.workspaceDiscoveryService.ignoreSuggestion(request.candidateId, request.rootPath);
        return this.workspaceSyncOrchestrator.getSnapshotResponse();
    }

    async unignoreWorkspaceSuggestion(request: UpdateWorkspaceSuggestionRequest): Promise<WorkspaceSnapshotResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertPathWithinWorkspace(request.rootPath, 'rootPath');
        await this.workspaceDiscoveryService.unignoreSuggestion(request.candidateId, request.rootPath);
        return this.workspaceSyncOrchestrator.getSnapshotResponse();
    }

    async startWorkspaceSync(request: StartWorkspaceSyncRequest): Promise<WorkspaceSyncResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertSyncAllowed();
        return this.workspaceSyncOrchestrator.startSync(request);
    }

    async confirmWorkspaceSync(request: ConfirmWorkspaceSyncRequest): Promise<WorkspaceSyncResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertSyncAllowed();
        return this.workspaceSyncOrchestrator.confirmSync(request);
    }

    async cancelWorkspaceJob(request: RetryWorkspaceJobRequest): Promise<WorkspaceSyncResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertSyncAllowed();
        return this.workspaceSyncOrchestrator.cancelJob({ jobId: request.jobId });
    }

    async retryWorkspaceJob(request: RetryWorkspaceJobRequest): Promise<WorkspaceSyncResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        this.assertSyncAllowed();
        return this.workspaceSyncOrchestrator.retryJob(request);
    }

    async getWorkspaceMigrationStatus(request: WorkspaceMigrationRequest = {}): Promise<WorkspaceMigrationStatusResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        return this.workspaceMigrationService.getStatus();
    }

    async previewWorkspaceMigration(request: WorkspaceMigrationRequest = {}): Promise<WorkspaceMigrationStatusResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const response = await this.workspaceMigrationService.previewMigration();
        this.broadcastMigrationState();
        return response;
    }

    async applyWorkspaceMigration(request: WorkspaceMigrationRequest = {}): Promise<WorkspaceMigrationStatusResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const response = await this.workspaceMigrationService.applyMigration();
        await this.reconcileRuntimeMode();
        this.broadcastMigrationState();
        return response;
    }

    async compareWorkspaceMigration(request: WorkspaceMigrationRequest = {}): Promise<WorkspaceMigrationStatusResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const response = await this.workspaceMigrationService.compareShadow();
        this.broadcastMigrationState();
        return response;
    }

    async activateWorkspaceMigration(request: WorkspaceMigrationActivateRequest = {}): Promise<WorkspaceMigrationStatusResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const response = await this.workspaceMigrationService.activateCanonical(request.acknowledgedDifferenceHash);
        await this.reconcileRuntimeMode();
        this.broadcastMigrationState();
        return response;
    }

    async rollbackWorkspaceMigration(request: WorkspaceMigrationRollbackRequest): Promise<WorkspaceMigrationStatusResponse> {
        this.assertWorkspaceRequest(request.workspaceId, request.configPath);
        const response = await this.workspaceMigrationService.rollbackMigration(request.transactionId);
        await this.reconcileRuntimeMode();
        this.broadcastMigrationState();
        return response;
    }

    protected async toMutationResponse(
        result: WorkspaceConfigMutationResult,
        syncRequest?: WorkspacePostMutationSyncRequest
    ): Promise<WorkspaceConfigMutationResponse> {
        const snapshot = await this.refreshWorkspaceState();
        let sync: WorkspaceSyncResponse | undefined;
        if (result.status === 'applied' && syncRequest) {
            sync = await this.workspaceSyncOrchestrator.startSyncAfterMutation(result, syncRequest);
        }
        return {
            schemaVersion: WORKSPACE_PROTOCOL_SCHEMA_VERSION,
            snapshot: this.decorateSnapshot(snapshot),
            ...(result.status === 'conflict' ? { conflict: toPublicConflict(result) } : {}),
            ...(sync ? { sync } : {})
        };
    }

    protected async refreshWorkspaceState(): Promise<WorkspaceSnapshot> {
        await this.reconcileRuntimeMode();
        await this.workspaceSyncOrchestrator.refresh();
        return this.decorateSnapshot(this.workspaceSyncOrchestrator.currentSnapshot);
    }

    protected async reconcileRuntimeMode(): Promise<void> {
        const loadResult = await this.workspaceConfigService.load(this.workspaceRoot);
        this.runtimeMode = this.workspaceMigrationService.getStartupMode();
        await this.configureRepositoryMembership(loadResult);
    }

    protected async configureRepositoryMembership(loadResult: ReturnType<WorkspaceConfigService['load']> extends Promise<infer TResult> ? TResult : never): Promise<void> {
        const config = this.runtimeConfigService.getConfig();
        if (isCanonicalProjectionMode(this.runtimeMode)) {
            await this.workspaceSourceRegistry.reconcile(loadResult, new Date().toISOString());
            await this.repositoryDiscovery.initialize(config, { mode: 'canonical' });
            await this.refreshRepositoryProjection();
            return;
        }
        await this.repositoryDiscovery.initialize(config, {
            mode: this.runtimeMode === 'single-folder' ? 'single-folder' : 'legacy'
        });
    }

    protected async refreshRepositoryProjection(): Promise<void> {
        const sourceRepositories = await this.workspaceSourceRegistry.projectRepositories();
        let hostRepository;
        try {
            hostRepository = await this.repositoryDiscovery.discoverConfiguredRepositoryRegistration();
        } catch (error) {
            // Managed Kubernetes workspaces keep the canonical manifest in a
            // synthetic /workspace repository and clone real sources below
            // it. The synthetic repository is optional for SCM operations;
            // a startup race or an absent host .git must not discard valid,
            // configured source checkouts from RepositoryRegistry.
            if (sourceRepositories.length === 0) {
                throw error;
            }
        }
        // The host registration carries the authoritative Git descriptor. Keep it
        // last so canonical-root deduplication cannot replace it with a source-only
        // registration for the same working tree.
        const registrations = hostRepository
            ? [...sourceRepositories, hostRepository]
            : [...sourceRepositories];
        const externalRoots = registrations
            .map(registration => registration.repositoryRoot)
            .filter(repositoryRoot => !isWithin(this.workspaceRoot, repositoryRoot));
        await this.repositoryRegistry.replace(registrations, {
            allowConfiguredExternalRoots: externalRoots
        });
    }

    protected assertWorkspaceRequest(workspaceId?: string, configPath?: string): void {
        if (workspaceId !== undefined) {
            this.workspaceBoundary.assertWorkspaceId(workspaceId);
        }
        if (configPath !== undefined && path.resolve(configPath) !== path.resolve(this.canonicalConfigPath)) {
            throw new Error('Workspace config path mismatch is not allowed');
        }
    }

    protected assertMutationsAllowed(): void {
        if (this.runtimeMode === 'canonical-diagnostics') {
            throw new Error('Workspace mutations are disabled while the canonical config is invalid or unsupported');
        }
    }

    protected assertSyncAllowed(): void {
        if (this.runtimeMode !== 'canonical-active') {
            throw new Error('Workspace sync is unavailable until a valid canonical config is active');
        }
    }

    protected decorateSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
        return {
            ...snapshot,
            migration: this.workspaceMigrationService.getSnapshotState()
        };
    }

    protected broadcastMigrationState(): void {
        const snapshot = this.decorateSnapshot(this.workspaceSyncOrchestrator.currentSnapshot);
        this.broadcast(client => client.onWorkspaceSnapshotChanged?.(snapshot));
    }

    protected assertPathWithinWorkspace(candidatePath: string, fieldName: string): void {
        const absolutePath = path.isAbsolute(candidatePath)
            ? path.resolve(candidatePath)
            : path.resolve(this.workspaceRoot, candidatePath);
        if (!isWithin(this.workspaceRoot, absolutePath)) {
            throw new Error(`${fieldName} must stay within the explicit workspace root`);
        }
    }

    protected toWorkspaceSourceEntry(source: WorkspaceConfiguredSource): WorkspaceSourceEntry {
        if (source.remoteUrl) {
            return {
                url: source.remoteUrl,
                branch: source.defaultBranch ?? source.ref
            };
        }
        this.assertPathWithinWorkspace(source.localPath, `source.localPath:${source.sourceId}`);
        const relativePath = path.relative(this.workspaceRoot, path.resolve(source.localPath)).replace(/\\/g, '/');
        return {
            path: relativePath === '' ? '.' : relativePath
        };
    }

    protected broadcast(callback: (client: StudioRuntimeClient) => void): void {
        for (const client of this.clients) {
            try {
                callback(client);
            } catch {
                // A disconnected client cannot prevent delivery to remaining clients.
            }
        }
    }
}

function isCanonicalProjectionMode(mode: WorkspaceRuntimeMode): mode is 'canonical-active' | 'canonical-shadow' {
    return mode === 'canonical-active' || mode === 'canonical-shadow';
}

export default new ContainerModule(bind => {
    bind(StudioRuntimeConfigService).toSelf().inSingletonScope();
    bind(WorkspaceBoundary).toSelf().inSingletonScope();
    bind(RepositoryRegistry).toSelf().inSingletonScope();
    bind(RepositoryDiscoveryService).toSelf().inSingletonScope();
    bind(WorkspaceConfigService).toSelf().inSingletonScope();
    bind(WorkspaceConfigMutationService).toSelf().inSingletonScope();
    bind(WorkspaceMigrationService).toSelf().inSingletonScope();
    bind(WorkspaceSourceRegistry).toSelf().inSingletonScope();
    bind(GitExecutor).toDynamicValue(() => new GitExecutor({
        allowLocalTransport: process.env.NODE_ENV === 'test'
            && process.env.STUDIO_TEST_ALLOW_LOCAL_GIT_TRANSPORT === '1'
    })).inSingletonScope();
    bind(WorkspaceGitService).toDynamicValue(ctx =>
        new WorkspaceGitService(ctx.container.get(GitExecutor))
    ).inSingletonScope();
    bind(WorkspaceDiscoveryService).toDynamicValue(ctx => {
        const config = ctx.container.get(StudioRuntimeConfigService).getConfig();
        return new WorkspaceDiscoveryService({
            workspaceRoot: config.workspaceRoot,
            operationalStatePath: path.join(config.dataDir, 'workspace-discovery-state.json')
        });
    }).inSingletonScope();
    bind(WorkspaceSyncOrchestrator).toDynamicValue(ctx => {
        const config = ctx.container.get(StudioRuntimeConfigService).getConfig();
        return new WorkspaceSyncOrchestrator(
            {
                workspaceId: config.workspaceId,
                workspaceRoot: config.workspaceRoot,
                dataDir: path.join(config.dataDir, 'workspace-jobs')
            },
            ctx.container.get(WorkspaceConfigService),
            ctx.container.get(WorkspaceSourceRegistry),
            ctx.container.get(WorkspaceGitService)
        );
    }).inSingletonScope();
    bind(GitPublishService).toSelf().inSingletonScope();
    bind(CfsMapRunnerImpl).toSelf().inSingletonScope();
    bind(CfsMapRunner).toService(CfsMapRunnerImpl);
    bind(KitInstallerImpl).toSelf().inSingletonScope();
    bind(KitInstaller).toService(KitInstallerImpl);
    bind(WorkspaceGraphServiceImpl).toSelf().inSingletonScope();
    bind(WorkspaceGraphService).toService(WorkspaceGraphServiceImpl);
    bind(OperationJournal).toDynamicValue(ctx => {
        const config = ctx.container.get(StudioRuntimeConfigService).getConfig();
        return new OperationJournal({
            dataDir: config.dataDir,
            repositoryRoot: config.repositoryRoot
        });
    }).inSingletonScope();
    bind(RepositoryOperationQueue).toDynamicValue(ctx =>
        new RepositoryOperationQueue(
            ctx.container.get(OperationJournal),
            ctx.container.get(WorkspaceBoundary),
            ctx.container.get(GitPublishService),
            ctx.container.get(RepositoryRegistry)
        )
    ).inSingletonScope();
    bind(StudioRuntimeEndpoint).toDynamicValue(ctx =>
        new StudioRuntimeEndpoint(
            ctx.container.get(StudioRuntimeConfigService),
            ctx.container.get(WorkspaceBoundary),
            ctx.container.get(RepositoryOperationQueue),
            ctx.container.get(RepositoryDiscoveryService),
            ctx.container.get(RepositoryRegistry),
            ctx.container.get(WorkspaceConfigService),
            ctx.container.get(WorkspaceConfigMutationService),
            ctx.container.get(WorkspaceMigrationService),
            ctx.container.get(WorkspaceSourceRegistry),
            ctx.container.get(WorkspaceDiscoveryService),
            ctx.container.get(WorkspaceSyncOrchestrator),
            ctx.container.get(KitInstaller)
        )
    ).inSingletonScope();

    bind(BackendApplicationContribution).toService(StudioRuntimeConfigService);
    bind(BackendApplicationContribution).toService(StudioRuntimeEndpoint);
    bind(BackendApplicationContribution).toService(WorkspaceGraphServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler<StudioRuntimeClient>(studioRuntimeServicePath, client => {
            const endpoint = ctx.container.get(StudioRuntimeEndpoint);
            endpoint.addClient(client);
            client.onDidCloseConnection(() => endpoint.removeClient(client));
            return endpoint;
        })
    ).inSingletonScope();
    // Orca: the IDE drives an Orca runtime through its CLI (see orca-cli.ts).
    // Backend-side on purpose — the binary, and any pairing secret a remote
    // runtime needs, must not be reachable from the browser.
    bind(OrcaCli).toSelf().inSingletonScope();
    bind(OrcaServiceImpl).toSelf().inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler<OrcaService>(orcaServicePath, () => ctx.container.get(OrcaServiceImpl))
    ).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler<WorkspaceGraphClient>(workspaceGraphServicePath, client => {
            const service = ctx.container.get(WorkspaceGraphServiceImpl);
            service.addClient(client);
            client.onDidCloseConnection(() => service.removeClient(client));
            return service;
        })
    ).inSingletonScope();
});

function mapConfiguredSourcesForCreate(
    workspaceRoot: string,
    sources: readonly WorkspaceConfiguredSource[]
): Readonly<Record<string, WorkspaceSourceEntry>> {
    return Object.freeze(Object.fromEntries(sources.map(source => {
        if (source.remoteUrl) {
            return [source.sourceId, {
                url: source.remoteUrl,
                branch: source.defaultBranch ?? source.ref
            }];
        }
        const resolved = path.resolve(source.localPath);
        if (!isWithin(workspaceRoot, resolved)) {
            throw new Error(`source.localPath:${source.sourceId} must stay within the explicit workspace root`);
        }
        const relativePath = path.relative(workspaceRoot, resolved).replace(/\\/g, '/');
        return [source.sourceId, { path: relativePath === '' ? '.' : relativePath }];
    })));
}

function toPublicConflict(result: Extract<WorkspaceConfigMutationResult, { status: 'conflict' }>): WorkspaceConfigConflict {
    return {
        code: result.code,
        message: result.message,
        currentRevision: result.currentRevision,
        diagnostics: freezeDiagnostics(result.diagnostics),
        ...(result.impacts ? { impacts: Object.freeze(result.impacts.map(impact => Object.freeze({ ...impact }))) } : {})
    };
}

function freezeDiagnostics(diagnostics: readonly WorkspaceDiagnostic[]): readonly WorkspaceDiagnostic[] {
    return Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic })));
}

function isWithin(parent: string, candidate: string): boolean {
    const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toRepositoryRelativePath(
    repositoryRoot: string,
    absolutePath: string,
    allowRepositoryRoot = false
): string {
    const relativePath = path.relative(repositoryRoot, absolutePath).replace(/\\/g, '/');
    if ((relativePath === '' || relativePath === '.') && allowRepositoryRoot) {
        return '.';
    }
    if (!relativePath || relativePath === '.' || relativePath.startsWith('../')) {
        throw new Error('Workspace path cannot be mapped into its owning repository');
    }
    return relativePath;
}
