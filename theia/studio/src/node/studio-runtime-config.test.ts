import { createBrowserSession, isOriginAllowed, loadStudioRuntimeConfig, StudioRuntimeConfigService } from './studio-runtime-config';

describe('studio runtime config', () => {
    const validEnv = {
        STUDIO_ACTOR_ID: 'actor-1',
        STUDIO_WORKSPACE_ID: 'workspace-1',
        STUDIO_WORKSPACE_ROOT: '/tmp/repo/workspace',
        STUDIO_REPOSITORY_ROOT: '/tmp/repo',
        STUDIO_DATA_DIR: '/tmp/studio-data',
        STUDIO_ALLOWED_ORIGINS: 'https://studio.example.com,https://preview.example.com',
        STUDIO_TRUST_PROXY: 'true',
        STUDIO_SESSION_TOKEN: 'top-secret'
    };

    it('fails fast on missing required config', () => {
        expect(() => loadStudioRuntimeConfig({
            STUDIO_WORKSPACE_ID: 'workspace-1',
            STUDIO_REPOSITORY_ROOT: '/tmp/repo'
        })).toThrow('STUDIO_ACTOR_ID');
    });

    it('fails fast when the Studio data directory is missing', () => {
        const { STUDIO_DATA_DIR: _dataDir, ...envWithoutDataDir } = validEnv;
        expect(() => loadStudioRuntimeConfig(envWithoutDataDir)).toThrow('STUDIO_DATA_DIR');
    });

    it('rejects malformed origin policy', () => {
        expect(() => loadStudioRuntimeConfig({
            ...validEnv,
            STUDIO_ALLOWED_ORIGINS: 'notaurl'
        })).toThrow('Invalid allowed origin');
    });

    it('redacts secret values from the browser session dto', () => {
        const config = loadStudioRuntimeConfig(validEnv);
        const session = createBrowserSession(config);

        expect(session).toEqual({
            actorId: 'actor-1',
            workspaceId: 'workspace-1',
            workspaceRootName: 'workspace',
            allowedOriginsMode: 'allowlist',
            allowedOrigins: ['https://studio.example.com', 'https://preview.example.com'],
            trustProxy: true,
            git: { mode: 'disabled' },
            features: {
                fixedWorkspace: true,
                allowWorkspaceSwitching: false,
                allowGitMutations: false
            }
        });
        expect(JSON.stringify(session)).not.toContain('top-secret');
        expect(JSON.stringify(session)).not.toContain('/tmp/repo');
        expect(JSON.stringify(session)).not.toContain('/tmp/studio-data');
        expect(JSON.stringify(session)).not.toContain('studio@example.test');
    });

    it('uses an explicit allowlist when configured', () => {
        const config = loadStudioRuntimeConfig(validEnv);
        expect(isOriginAllowed(config, {
            origin: 'https://studio.example.com',
            host: 'internal-host:3000'
        })).toBe(true);
        expect(isOriginAllowed(config, {
            origin: 'https://evil.example.com',
            host: 'studio.example.com'
        })).toBe(false);
    });

    it('allows a missing origin only for Theia same-origin polling semantics', () => {
        const config = loadStudioRuntimeConfig(validEnv);
        expect(isOriginAllowed(config, {
            host: 'studio.example.com'
        })).toBe(true);
    });

    it('honors proxy trust decisions for same-origin mode', () => {
        const config = loadStudioRuntimeConfig({
            STUDIO_ACTOR_ID: 'actor-1',
            STUDIO_WORKSPACE_ID: 'workspace-1',
            STUDIO_WORKSPACE_ROOT: '/tmp/repo/workspace',
            STUDIO_REPOSITORY_ROOT: '/tmp/repo',
            STUDIO_DATA_DIR: '/tmp/studio-data',
            STUDIO_TRUST_PROXY: 'true'
        });
        expect(isOriginAllowed(config, {
            origin: 'https://studio.example.com',
            host: 'internal-host:3000',
            forwardedHost: 'studio.example.com'
        })).toBe(true);
        expect(isOriginAllowed(config, {
            origin: 'https://studio.example.com',
            host: 'internal-host:3000',
            forwardedHost: 'other.example.com'
        })).toBe(false);
    });

    it('rejects malformed proxy trust values', () => {
        expect(() => loadStudioRuntimeConfig({
            STUDIO_ACTOR_ID: 'actor-1',
            STUDIO_WORKSPACE_ID: 'workspace-1',
            STUDIO_WORKSPACE_ROOT: '/tmp/repo/workspace',
            STUDIO_REPOSITORY_ROOT: '/tmp/repo',
            STUDIO_DATA_DIR: '/tmp/studio-data',
            STUDIO_TRUST_PROXY: 'maybe'
        })).toThrow('STUDIO_TRUST_PROXY');
    });

    it('defaults Git mutations to disabled', () => {
        const config = loadStudioRuntimeConfig(validEnv);
        expect(config.git).toEqual({ mode: 'disabled' });
        expect(createBrowserSession(config).features.allowGitMutations).toBe(false);
    });

    it('requires server-owned Git settings when mutations are enabled', () => {
        expect(() => loadStudioRuntimeConfig({
            ...validEnv,
            STUDIO_GIT_MODE: 'push'
        })).toThrow('STUDIO_GIT_BRANCH');

        const config = loadStudioRuntimeConfig({
            ...validEnv,
            STUDIO_GIT_MODE: 'push',
            STUDIO_GIT_BRANCH: 'main',
            STUDIO_GIT_REMOTE: 'origin',
            STUDIO_GIT_FETCH_SOURCE_URL: 'git@github.com:owner/repo.git',
            STUDIO_GIT_PUSH_SOURCE_URL: 'git@github.com:owner/repo.git',
            STUDIO_GIT_FETCH_URL: 'git@github.com-personal:owner/repo.git',
            STUDIO_GIT_PUSH_URL: 'git@github.com-personal:owner/repo.git',
            STUDIO_GIT_AUTHOR_NAME: 'Studio',
            STUDIO_GIT_AUTHOR_EMAIL: 'studio@example.test'
        });
        expect(config.git).toEqual({
            mode: 'push',
            branch: 'main',
            remote: 'origin',
            fetchSourceUrl: 'git@github.com:owner/repo.git',
            pushSourceUrl: 'git@github.com:owner/repo.git',
            fetchUrl: 'git@github.com-personal:owner/repo.git',
            pushUrl: 'git@github.com-personal:owner/repo.git',
            authorName: 'Studio',
            authorEmail: 'studio@example.test'
        });
        expect(createBrowserSession(config).features.allowGitMutations).toBe(true);
        expect(createBrowserSession(config).git).toEqual({ mode: 'push', branch: 'main' });
    });

    it('rejects unknown Git modes', () => {
        expect(() => loadStudioRuntimeConfig({
            ...validEnv,
            STUDIO_GIT_MODE: 'force'
        })).toThrow('STUDIO_GIT_MODE');
    });
});

/**
 * Who may frame the IDE (#324): the application page names the portal origins
 * the bridge talks to, so a site outside the list cannot show the editor.
 */
describe('frame-ancestors on the application page', () => {
    const env = {
        STUDIO_ACTOR_ID: 'actor-1',
        STUDIO_WORKSPACE_ID: 'workspace-1',
        STUDIO_WORKSPACE_ROOT: '/tmp/repo/workspace',
        STUDIO_REPOSITORY_ROOT: '/tmp/repo',
        STUDIO_DATA_DIR: '/tmp/studio-data'
    };
    type Handler = (req: { path: string }, res: { setHeader: jest.Mock }, next: () => void) => void;

    const headerFor = (path: string, config: (() => ReturnType<typeof loadStudioRuntimeConfig>) | undefined): string | undefined => {
        const service = new StudioRuntimeConfigService();
        const handlers: Handler[] = [];
        Object.assign(service, { earlyMiddleware: { handlers } });
        jest.spyOn(service, 'getConfig').mockImplementation(config ?? (() => { throw new Error('no config'); }));
        service.initialize();
        const res = { setHeader: jest.fn() };
        const next = jest.fn();
        handlers[0]({ path }, res, next);
        expect(next).toHaveBeenCalled();
        return res.setHeader.mock.calls.find(([name]) => name === 'Content-Security-Policy')?.[1];
    };

    it('is the page’s own origin when no list is set', () => {
        expect(headerFor('/', () => loadStudioRuntimeConfig(env))).toBe("frame-ancestors 'self'");
    });

    it('is exactly the listed origins when a list is set', () => {
        const listed = () => loadStudioRuntimeConfig({ ...env, STUDIO_ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:8080' });
        expect(headerFor('/index.html', listed)).toBe('frame-ancestors http://localhost:5173 http://localhost:8080');
    });

    it('narrows to the own origin when the configuration does not load', () => {
        expect(headerFor('/', undefined)).toBe("frame-ancestors 'self'");
    });

    it('leaves every other response alone — webviews and drawio have their own policies', () => {
        expect(headerFor('/webview/index.html', () => loadStudioRuntimeConfig(env))).toBeUndefined();
        expect(headerFor('/bundle.js', () => loadStudioRuntimeConfig(env))).toBeUndefined();
    });
});
