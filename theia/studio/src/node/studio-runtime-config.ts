import * as path from 'path';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application';
import { StudioRuntimeSession } from '../common/studio-protocol';

export interface StudioOriginCheckRequest {
    readonly origin?: string;
    readonly host?: string;
    readonly forwardedHost?: string;
}

export type StudioGitConfig =
    | { readonly mode: 'disabled' }
    | {
        readonly mode: 'commit' | 'push';
        readonly branch: string;
        readonly remote: string;
        readonly fetchSourceUrl: string;
        readonly pushSourceUrl: string;
        readonly fetchUrl: string;
        readonly pushUrl: string;
        readonly authorName: string;
        readonly authorEmail: string;
    };

export interface StudioRuntimeConfig {
    readonly actorId: string;
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly repositoryRoot: string;
    readonly dataDir: string;
    readonly allowedOriginsMode: 'same-origin' | 'allowlist';
    readonly allowedOrigins: readonly string[];
    readonly trustProxy: boolean;
    readonly git: StudioGitConfig;
    readonly secrets: {
        readonly sessionToken?: string;
    };
}

export interface StudioRuntimeConfigSource {
    readonly STUDIO_ACTOR_ID?: string;
    readonly STUDIO_WORKSPACE_ID?: string;
    readonly STUDIO_WORKSPACE_ROOT?: string;
    readonly STUDIO_REPOSITORY_ROOT?: string;
    readonly STUDIO_DATA_DIR?: string;
    readonly STUDIO_ALLOWED_ORIGINS?: string;
    readonly STUDIO_TRUST_PROXY?: string;
    readonly STUDIO_SESSION_TOKEN?: string;
    readonly STUDIO_GIT_MODE?: string;
    readonly STUDIO_GIT_BRANCH?: string;
    readonly STUDIO_GIT_REMOTE?: string;
    readonly STUDIO_GIT_FETCH_SOURCE_URL?: string;
    readonly STUDIO_GIT_PUSH_SOURCE_URL?: string;
    readonly STUDIO_GIT_FETCH_URL?: string;
    readonly STUDIO_GIT_PUSH_URL?: string;
    readonly STUDIO_GIT_AUTHOR_NAME?: string;
    readonly STUDIO_GIT_AUTHOR_EMAIL?: string;
}

export function loadStudioRuntimeConfig(env: StudioRuntimeConfigSource = process.env): StudioRuntimeConfig {
    const actorId = readRequiredValue(env.STUDIO_ACTOR_ID, 'STUDIO_ACTOR_ID');
    const workspaceId = readRequiredValue(env.STUDIO_WORKSPACE_ID, 'STUDIO_WORKSPACE_ID');
    const workspaceRootInput = readRequiredValue(env.STUDIO_WORKSPACE_ROOT, 'STUDIO_WORKSPACE_ROOT');
    const repositoryRootInput = readRequiredValue(env.STUDIO_REPOSITORY_ROOT, 'STUDIO_REPOSITORY_ROOT');
    const workspaceRoot = path.resolve(workspaceRootInput);
    const repositoryRoot = path.resolve(repositoryRootInput);
    const dataDir = path.resolve(readRequiredValue(env.STUDIO_DATA_DIR, 'STUDIO_DATA_DIR'));
    const allowedOrigins = parseAllowedOrigins(env.STUDIO_ALLOWED_ORIGINS);
    const trustProxy = parseTrustProxy(env.STUDIO_TRUST_PROXY);
    const git = parseGitConfig(env);

    return {
        actorId,
        workspaceId,
        workspaceRoot,
        repositoryRoot,
        dataDir,
        allowedOriginsMode: allowedOrigins.length > 0 ? 'allowlist' : 'same-origin',
        allowedOrigins,
        trustProxy,
        git,
        secrets: {
            sessionToken: readOptionalValue(env.STUDIO_SESSION_TOKEN)
        }
    };
}

export function createBrowserSession(config: StudioRuntimeConfig): StudioRuntimeSession {
    return {
        actorId: config.actorId,
        workspaceId: config.workspaceId,
        workspaceRootName: path.basename(config.workspaceRoot),
        allowedOriginsMode: config.allowedOriginsMode,
        allowedOrigins: [...config.allowedOrigins],
        trustProxy: config.trustProxy,
        git: config.git.mode === 'disabled'
            ? { mode: 'disabled' }
            : { mode: config.git.mode, branch: config.git.branch },
        features: {
            fixedWorkspace: true,
            allowWorkspaceSwitching: false,
            allowGitMutations: config.git.mode !== 'disabled'
        }
    };
}

export function isOriginAllowed(config: StudioRuntimeConfig, request: StudioOriginCheckRequest): boolean {
    if (!request.origin) {
        // Match Theia's WsOriginValidator: browsers omit Origin for same-origin
        // polling, while cross-origin browser requests include it.
        return true;
    }

    let originUrl: URL;
    try {
        originUrl = new URL(request.origin);
    } catch {
        return false;
    }

    if (config.allowedOriginsMode === 'allowlist') {
        return config.allowedOrigins.includes(originUrl.origin);
    }

    const host = config.trustProxy && request.forwardedHost ? request.forwardedHost : request.host;
    if (!host) {
        return false;
    }
    return originUrl.host === host;
}

function readRequiredValue(value: string | undefined, name: string): string {
    const trimmed = readOptionalValue(value);
    if (!trimmed) {
        throw new Error(`Missing required runtime configuration: ${name}`);
    }
    return trimmed;
}

function readOptionalValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function parseAllowedOrigins(rawValue: string | undefined): string[] {
    const rawOrigins = rawValue
        ?.split(',')
        .map(value => value.trim())
        .filter(Boolean) ?? [];

    return rawOrigins.map(origin => {
        let parsed: URL;
        try {
            parsed = new URL(origin);
        } catch {
            throw new Error(`Invalid allowed origin: ${origin}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Invalid allowed origin protocol: ${origin}`);
        }
        if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error(`Allowed origins must be bare origins: ${origin}`);
        }
        return parsed.origin;
    });
}

function parseTrustProxy(rawValue: string | undefined): boolean {
    const value = rawValue?.trim();
    if (value === undefined || value === '') {
        return false;
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error('STUDIO_TRUST_PROXY must be "true" or "false"');
}

function parseGitConfig(env: StudioRuntimeConfigSource): StudioGitConfig {
    const mode = readOptionalValue(env.STUDIO_GIT_MODE) ?? 'disabled';
    if (mode === 'disabled') {
        return { mode };
    }
    if (mode !== 'commit' && mode !== 'push') {
        throw new Error('STUDIO_GIT_MODE must be "disabled", "commit", or "push"');
    }
    return {
        mode,
        branch: readRequiredValue(env.STUDIO_GIT_BRANCH, 'STUDIO_GIT_BRANCH'),
        remote: readRequiredValue(env.STUDIO_GIT_REMOTE, 'STUDIO_GIT_REMOTE'),
        fetchSourceUrl: readRequiredValue(env.STUDIO_GIT_FETCH_SOURCE_URL, 'STUDIO_GIT_FETCH_SOURCE_URL'),
        pushSourceUrl: readRequiredValue(env.STUDIO_GIT_PUSH_SOURCE_URL, 'STUDIO_GIT_PUSH_SOURCE_URL'),
        fetchUrl: readRequiredValue(env.STUDIO_GIT_FETCH_URL, 'STUDIO_GIT_FETCH_URL'),
        pushUrl: readRequiredValue(env.STUDIO_GIT_PUSH_URL, 'STUDIO_GIT_PUSH_URL'),
        authorName: readRequiredValue(env.STUDIO_GIT_AUTHOR_NAME, 'STUDIO_GIT_AUTHOR_NAME'),
        authorEmail: readRequiredValue(env.STUDIO_GIT_AUTHOR_EMAIL, 'STUDIO_GIT_AUTHOR_EMAIL')
    };
}

@injectable()
export class StudioRuntimeConfigService implements BackendApplicationContribution {
    protected cachedConfig: StudioRuntimeConfig | undefined;

    @inject(EarlyExpressMiddleware) @optional()
    protected readonly earlyMiddleware: EarlyExpressMiddleware | undefined;

    /**
     * `frame-ancestors` on the application page (#324) — the portal origins
     * the portal bridge talks to, its own origin unless a list is set — early
     * so it runs before `express.static()` answers. Only that page: webviews
     * and the drawio runtime keep their own policies. A configuration that
     * does not load narrows the list to the page's own origin rather than
     * dropping it.
     */
    initialize(): void {
        this.earlyMiddleware?.handlers.push((req, res, next) => {
            if (req.path === '/' || req.path === '/index.html') {
                let ancestors = "'self'";
                try {
                    const config = this.getConfig();
                    if (config.allowedOriginsMode === 'allowlist') {
                        ancestors = config.allowedOrigins.join(' ');
                    }
                } catch {
                    // keep 'self'
                }
                res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
            }
            next();
        });
    }

    onStart(): void {
        this.cachedConfig = loadStudioRuntimeConfig();
    }

    getConfig(): StudioRuntimeConfig {
        if (!this.cachedConfig) {
            this.cachedConfig = loadStudioRuntimeConfig();
        }
        return this.cachedConfig;
    }
}
