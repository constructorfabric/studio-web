// Internal server-to-server control API for the Theia node backend (ADR-0010).
//
// Mounts POST routes under /internal/theia/v1 that mirror the v1 slice of
// `StudioRuntimeService`, so studio-backend's `studio-theia` gear can drive the
// IDE from the server side. This is NOT the browser RPC surface: it is a
// separate, S2S-token-gated HTTP API. It stays dormant unless
// STUDIO_THEIA_S2S_TOKEN is present in the container environment (injected by
// the studio-session gear), so a normal IDE session is unaffected.
//
// The wire shapes are the camelCase subset in
// `studio-backend/docs/theia-bridge-contract-v1.md`; responses that are already
// a superset of that subset (operation snapshots, deltas) are passed through,
// while `getSession` / `getRepositories` are mapped to the subset explicitly.

import * as express from '@theia/core/shared/express';

import {
    EnqueueStudioOperationRequest,
    EnqueueStudioOperationResponse,
    StudioOperationDeltaRequest,
    StudioOperationDeltaResponse,
    StudioOperationSnapshot,
    StudioRepositoryDescriptor,
    StudioNotifyEditorRequest,
    StudioNotifyEditorResult,
    StudioOpenInEditorRequest,
    StudioOpenInEditorResult,
    StudioKitInstallRequest,
    StudioKitInstallResult,
    StudioRetryOperationRequest,
    StudioRuntimeSession
} from '../common/studio-protocol';

export const STUDIO_CONTROL_BASE_PATH = '/internal/theia/v1';
export const STUDIO_CONTROL_TOKEN_HEADER = 'x-cfs-theia-token';
export const STUDIO_CONTROL_TOKEN_ENV = 'STUDIO_THEIA_S2S_TOKEN';

export interface StudioControlRuntimeStatus {
    readonly ready: boolean;
    readonly workspaceMode: string;
    readonly activeClients: number;
    readonly lastEventSequence: number;
    readonly version: string;
}

/** The endpoint capabilities the control API needs, decoupled from the class. */
export interface StudioControlContext {
    workspaceId(): string;
    runtimeStatus(): StudioControlRuntimeStatus;
    getSession(): Promise<StudioRuntimeSession>;
    getRepositories(): Promise<readonly StudioRepositoryDescriptor[]>;
    /**
     * Repository id of the project's own repository -- the configured
     * repository root. Undefined only when the registry has not registered
     * it. Kept beside `getRepositories` rather than on the descriptor
     * because the registry is the single authority on which working tree is
     * the project, and `StudioRepositoryDescriptor` is constructed in a
     * dozen places that have no way to know.
     */
    projectRepositoryId(): string | undefined;
    enqueueOperation(request: EnqueueStudioOperationRequest): Promise<EnqueueStudioOperationResponse>;
    getOperationDeltas(request: StudioOperationDeltaRequest): Promise<StudioOperationDeltaResponse>;
    retryOperation(request: StudioRetryOperationRequest): Promise<StudioOperationSnapshot>;
    openInEditor(request: StudioOpenInEditorRequest): Promise<StudioOpenInEditorResult>;
    notifyEditor(request: StudioNotifyEditorRequest): Promise<StudioNotifyEditorResult>;
    installKit(request: StudioKitInstallRequest): Promise<StudioKitInstallResult>;
}

/**
 * Mount the control API on `app`. Returns `false` (and mounts nothing) when the
 * S2S token is not configured, leaving the IDE untouched.
 */
export function mountStudioControlApi(app: express.Application, context: StudioControlContext): boolean {
    const token = (process.env[STUDIO_CONTROL_TOKEN_ENV] ?? '').trim();
    if (!token) {
        return false;
    }

    const router = express.Router();
    router.use(express.json({ limit: '2mb' }));

    // S2S token gate. The browser never holds this token, so serving the
    // control API on the session's own port stays safe for the MVP.
    router.use((req, res, next) => {
        const presented = (req.header(STUDIO_CONTROL_TOKEN_HEADER) ?? '').trim();
        if (!presented || presented !== token) {
            res.status(401).json({ error: 'invalid or missing control token' });
            return;
        }
        next();
    });

    handle(router, '/getRuntimeStatus', async () => context.runtimeStatus());

    handle(router, '/getSession', async () => {
        const session = await context.getSession();
        return {
            actorId: session.actorId,
            workspaceId: session.workspaceId,
            workspaceRootName: session.workspaceRootName,
            gitMode: session.git.mode
        };
    });

    // `kind` tells the portal which working tree is the project itself: the
    // synthetic `/workspace` host in a managed workspace, the single checkout in
    // a classic one. It is the default target for project-level operations --
    // `.cf-studio-kit.toml` lives there -- so a caller that offers a choice needs
    // to be able to preselect it, and one that offers none needs to know what the
    // node will pick. Derived here from the registry rather than read off the
    // descriptor: the registry is the only component that knows the configured
    // root, and the descriptor is built in places that do not.
    handle(router, '/getRepositories', async () => {
        const repositories = await context.getRepositories();
        const projectRepositoryId = context.projectRepositoryId();
        return repositories.map(repository => ({
            repositoryId: repository.repositoryId,
            fingerprint: repository.fingerprint,
            rootUri: repository.rootUri,
            label: repository.label,
            gitMode: repository.git.mode,
            kind: repository.repositoryId === projectRepositoryId ? 'project' : 'source'
        }));
    });

    handle(router, '/enqueueOperation', async req => context.enqueueOperation({
        workspaceId: context.workspaceId(),
        repositoryId: asString(req.body?.repositoryId),
        relativePath: asString(req.body?.relativePath),
        languageId: 'markdown',
        contentHash: asString(req.body?.contentHash),
        idempotencyKey: asString(req.body?.idempotencyKey),
        savedAt: asString(req.body?.savedAt)
    }));

    handle(router, '/getOperationDeltas', async req =>
        context.getOperationDeltas({ afterSequence: asNumber(req.body?.afterSequence) }));

    handle(router, '/retryOperation', async req =>
        context.retryOperation({ operationId: asString(req.body?.operationId) }));

    // openInEditor reveals a file in the running IDE. The node backend cannot
    // drive the editor itself, so the endpoint broadcasts onOpenInEditor to the
    // browser clients; `opened` reports whether any browser client received it.
    handle(router, '/openInEditor', async req => context.openInEditor({
        relativePath: asString(req.body?.relativePath),
        preview: asBoolean(req.body?.preview)
    }));

    // notifyEditor shows a message in the running IDE. Display-only, so the
    // only validation is the level: anything the backend has not heard of is
    // information rather than a refusal, since this crosses a version boundary.
    handle(router, '/notifyEditor', async req => context.notifyEditor({
        level: asLevel(req.body?.level),
        message: asString(req.body?.message),
        detail: optionalString(req.body?.detail),
        link: optionalString(req.body?.link),
        source: optionalString(req.body?.source)
    }));

    handle(router, '/installKit', async req => context.installKit({
        kitSlug: asString(req.body?.kitSlug),
        version: asString(req.body?.version),
        repositoryId: optionalString(req.body?.repositoryId)
    }));

    app.use(STUDIO_CONTROL_BASE_PATH, router);
    return true;
}

function handle(
    router: express.Router,
    path: string,
    body: (req: express.Request) => Promise<unknown>
): void {
    router.post(path, (req, res) => {
        body(req)
            .then(result => res.json(result))
            .catch(error => {
                res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
            });
    });
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
    const parsed = asString(value).trim();
    return parsed || undefined;
}

function asNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function asBoolean(value: unknown): boolean {
    return value === true;
}

/**
 * The notification level, defaulting to `info`.
 *
 * A level this build does not know is information, not a refusal: the sender is
 * a backend that may be newer than this container, and dropping its message
 * over a word would be the wrong trade.
 */
function asLevel(value: unknown): StudioNotifyEditorRequest['level'] {
    switch (asString(value).trim().toLowerCase()) {
        case 'error':
            return 'error';
        case 'warn':
        case 'warning':
            return 'warn';
        default:
            return 'info';
    }
}
