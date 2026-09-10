import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';
import type {
    CancelWorkspaceJobRequest,
    ConfirmWorkspaceSyncRequest,
    CreateWorkspaceConfigRequest,
    DetectContainingWorkspaceRepositoryRequest,
    WorkspaceMigrationActivateRequest,
    WorkspaceMigrationRequest,
    WorkspaceMigrationRollbackRequest,
    WorkspaceMigrationStatusResponse,
    RemoveWorkspaceSourceRequest,
    ReadWorkspaceRawTomlRequest,
    ReadWorkspaceRawTomlResponse,
    RenameWorkspaceRequest,
    RetryWorkspaceJobRequest,
    SaveWorkspaceRawTomlRequest,
    StartWorkspaceSyncRequest,
    UpdateWorkspaceSuggestionRequest,
    UpdateWorkspaceConfigRequest,
    WorkspaceActivityEvent,
    WorkspaceConfigMutationResponse,
    WorkspaceRepositorySuggestion,
    WorkspaceScanRequest,
    WorkspaceScanResponse,
    WorkspaceSnapshot,
    WorkspaceSnapshotRequest,
    WorkspaceSnapshotResponse,
    WorkspaceSyncResponse
} from './workspace-protocol';

export const studioRuntimeServicePath = '/services/studio-runtime';
export const StudioRuntimeService = Symbol('StudioRuntimeService');

export interface StudioFeatureFlags {
    readonly fixedWorkspace: true;
    readonly allowWorkspaceSwitching: false;
    readonly allowGitMutations: boolean;
}

export interface StudioRuntimeSession {
    readonly actorId: string;
    readonly workspaceId: string;
    readonly workspaceRootName: string;
    readonly allowedOriginsMode: 'same-origin' | 'allowlist';
    readonly allowedOrigins: readonly string[];
    readonly trustProxy: boolean;
    readonly git: {
        readonly mode: 'disabled' | 'commit' | 'push';
        readonly branch?: string;
    };
    readonly features: StudioFeatureFlags;
}

export interface StudioRepositoryGitDescriptor {
    readonly configRevision: string;
    readonly mode: 'disabled' | 'commit' | 'push';
    readonly branch?: string;
    readonly remote?: string;
    readonly fetchSourceUrl?: string;
    readonly pushSourceUrl?: string;
    readonly fetchUrl?: string;
    readonly pushUrl?: string;
    readonly authorName?: string;
    readonly authorEmail?: string;
    readonly publishEnabled: boolean;
    readonly disabledReason?: string;
}

export interface StudioRepositoryDescriptor {
    readonly schemaVersion: 1;
    readonly repositoryId: string;
    readonly fingerprint: string;
    readonly rootUri: string;
    readonly workspaceRelativeRoot: string;
    readonly label: string;
    readonly git: StudioRepositoryGitDescriptor;
}

export interface StudioWorkspaceRequest {
    readonly relativePath?: string;
    readonly resourceUri?: string;
    readonly requireExists?: boolean;
}

export interface StudioWorkspaceLocation {
    readonly workspaceId: string;
    readonly repositoryId?: string;
    readonly repositoryFingerprint?: string;
    readonly repositoryRootUri?: string;
    readonly relativePath: string;
    readonly repositoryRelativePath: string;
    readonly exists: boolean;
    readonly isDirectory: boolean;
}

export type StudioOperationState =
    | 'queued'
    | 'validating'
    | 'no-changes'
    | 'committing'
    | 'committed'
    | 'committed-local'
    | 'pushing'
    | 'pushed'
    | 'failed'
    | 'push-pending'
    | 'blocked';

export interface StudioOperationScope {
    readonly journalSchemaVersion: 2;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFingerprint: string;
    readonly repositoryConfigRevision: string;
    readonly relativePath: string;
    readonly repositoryRelativePath: string;
    readonly languageId: 'markdown';
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly savedAt: string;
}

export interface StudioOperationSnapshot extends Omit<
    StudioOperationScope,
    'journalSchemaVersion' | 'repositoryId' | 'repositoryFingerprint' | 'repositoryConfigRevision'
> {
    readonly journalSchemaVersion: 1 | 2;
    readonly repositoryId?: string;
    readonly repositoryFingerprint?: string;
    readonly repositoryConfigRevision?: string;
    readonly operationId: string;
    readonly state: StudioOperationState;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly createdSequence: number;
    readonly lastSequence: number;
    readonly commitSha?: string;
    readonly failureReason?: string;
}

export interface StudioOperationEvent extends Omit<
    StudioOperationScope,
    'journalSchemaVersion' | 'repositoryId' | 'repositoryFingerprint' | 'repositoryConfigRevision'
> {
    readonly journalSchemaVersion?: 1 | 2;
    readonly repositoryId?: string;
    readonly repositoryFingerprint?: string;
    readonly repositoryConfigRevision?: string;
    readonly sequence: number;
    readonly operationId: string;
    readonly state: StudioOperationState;
    readonly timestamp: string;
    readonly commitSha?: string;
    readonly failureReason?: string;
}

export interface StudioAuditEntry {
    readonly sequence: number;
    readonly relativePath: string;
    readonly contentHash: string;
    readonly sha: string;
    readonly time: string;
    readonly outcome: 'modified' | 'committed' | 'pushing' | 'pushed' | 'pending' | 'failed' | 'blocked';
}

export interface EnqueueStudioOperationRequest {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly relativePath: string;
    readonly languageId: 'markdown';
    readonly contentHash: string;
    readonly idempotencyKey: string;
    readonly savedAt: string;
}

export interface EnqueueStudioOperationResponse {
    readonly operation: StudioOperationSnapshot;
    readonly reusedExisting: boolean;
}

export interface StudioOperationDeltaRequest {
    readonly afterSequence: number;
}

export interface StudioOperationDeltaResponse {
    readonly lastSequence: number;
    readonly events: readonly StudioOperationEvent[];
}

export interface StudioAuditDeltaRequest {
    readonly afterSequence: number;
}

export interface StudioAuditDeltaResponse {
    readonly lastSequence: number;
    readonly entries: readonly StudioAuditEntry[];
}

export interface StudioRuntimeClient {
    onOperationEvent(event: StudioOperationEvent): void;
    onAuditEvent?(entry: StudioAuditEntry): void;
    onRepositoriesChanged(repositories: readonly StudioRepositoryDescriptor[]): void;
    onWorkspaceSnapshotChanged?(snapshot: WorkspaceSnapshot): void;
    onWorkspaceActivityEvent?(event: WorkspaceActivityEvent): void;
    /** Open/reveal a workspace file in the running IDE (ADR-0010). Optional:
     * only browser clients implement it; the event forwarder ignores it. */
    onOpenInEditor?(request: StudioOpenInEditorRequest): void;
    /** Show a Studio-originated message in the running IDE (ADR-0010
     * `notifyEditor`). Optional for the same reason as `onOpenInEditor`: only a
     * browser client has a UI to show it in. */
    onNotifyEditor?(request: StudioNotifyEditorRequest): void;
}

export interface StudioOpenInEditorRequest {
    readonly relativePath: string;
    readonly preview?: boolean;
}

export interface StudioOpenInEditorResult {
    readonly opened: boolean;
    readonly resolvedRelativePath?: string;
}

/**
 * A message from Studio to show in this session's IDE.
 *
 * Display-only: it touches no workspace state, which is why the bridge contract
 * lists it beside `openInEditor` rather than among the mutations.
 */
export interface StudioNotifyEditorRequest {
    readonly level: 'info' | 'warn' | 'error';
    /** One line. The IDE shows it as a notification. */
    readonly message: string;
    /** Optional second line — what happened, in a sentence. */
    readonly detail?: string;
    /** An http(s) URL the message is about. Offered as an action on the
     * notification; anything else is ignored rather than opened. */
    readonly link?: string;
    /** Who sent it, for the notification's own label ("Studio", a job name). */
    readonly source?: string;
}

export interface StudioNotifyEditorResult {
    /** False when no browser client was attached to show it — a session whose
     * tab nobody has open. Deliberately not an error: the caller decides
     * whether an unseen notification matters. */
    readonly shown: boolean;
}

/** Trusted backend request to materialize one registry-approved kit. */
export interface StudioKitInstallRequest {
    readonly kitSlug: string;
    readonly version: string;
    readonly repositoryId?: string;
}

export interface StudioKitInstallResult {
    readonly kitSlug: string;
    readonly version: string;
    readonly repositoryId: string;
    readonly repositoryLabel: string;
    readonly output: string;
}

export interface StudioRetryOperationRequest {
    readonly operationId: string;
}

export interface StudioRuntimeService extends RpcServer<StudioRuntimeClient> {
    getSession(): Promise<StudioRuntimeSession>;
    getRepositories(): Promise<readonly StudioRepositoryDescriptor[]>;
    resolveWorkspacePath(request: StudioWorkspaceRequest): Promise<StudioWorkspaceLocation>;
    enqueueOperation(request: EnqueueStudioOperationRequest): Promise<EnqueueStudioOperationResponse>;
    getOperationDeltas(request: StudioOperationDeltaRequest): Promise<StudioOperationDeltaResponse>;
    getAuditDeltas(request: StudioAuditDeltaRequest): Promise<StudioAuditDeltaResponse>;
    retryOperation(request: StudioRetryOperationRequest): Promise<StudioOperationSnapshot>;
    notifyEditor?(request: StudioNotifyEditorRequest): Promise<StudioNotifyEditorResult>;
    getWorkspaceSnapshot?(request: WorkspaceSnapshotRequest): Promise<WorkspaceSnapshotResponse>;
    createWorkspaceConfig?(request: CreateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse>;
    addWorkspaceSource?(request: UpdateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse>;
    updateWorkspaceSource?(request: UpdateWorkspaceConfigRequest): Promise<WorkspaceConfigMutationResponse>;
    removeWorkspaceSource?(request: RemoveWorkspaceSourceRequest): Promise<WorkspaceConfigMutationResponse>;
    renameWorkspace?(request: RenameWorkspaceRequest): Promise<WorkspaceConfigMutationResponse>;
    readWorkspaceRawToml?(request: ReadWorkspaceRawTomlRequest): Promise<ReadWorkspaceRawTomlResponse>;
    saveWorkspaceRawToml?(request: SaveWorkspaceRawTomlRequest): Promise<WorkspaceConfigMutationResponse>;
    getWorkspaceMigrationStatus?(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse>;
    previewWorkspaceMigration?(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse>;
    applyWorkspaceMigration?(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse>;
    compareWorkspaceMigration?(request: WorkspaceMigrationRequest): Promise<WorkspaceMigrationStatusResponse>;
    activateWorkspaceMigration?(request: WorkspaceMigrationActivateRequest): Promise<WorkspaceMigrationStatusResponse>;
    rollbackWorkspaceMigration?(request: WorkspaceMigrationRollbackRequest): Promise<WorkspaceMigrationStatusResponse>;
    scanWorkspaceSources?(request: WorkspaceScanRequest): Promise<WorkspaceScanResponse>;
    detectContainingWorkspaceRepository?(request: DetectContainingWorkspaceRepositoryRequest): Promise<WorkspaceRepositorySuggestion | undefined>;
    ignoreWorkspaceSuggestion?(request: UpdateWorkspaceSuggestionRequest): Promise<WorkspaceSnapshotResponse>;
    unignoreWorkspaceSuggestion?(request: UpdateWorkspaceSuggestionRequest): Promise<WorkspaceSnapshotResponse>;
    startWorkspaceSync?(request: StartWorkspaceSyncRequest): Promise<WorkspaceSyncResponse>;
    confirmWorkspaceSync?(request: ConfirmWorkspaceSyncRequest): Promise<WorkspaceSyncResponse>;
    cancelWorkspaceJob?(request: CancelWorkspaceJobRequest): Promise<WorkspaceSyncResponse>;
    retryWorkspaceJob?(request: RetryWorkspaceJobRequest): Promise<WorkspaceSyncResponse>;
}
