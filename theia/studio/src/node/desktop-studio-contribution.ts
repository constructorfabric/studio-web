import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as express from '@theia/core/shared/express';
import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { DesktopEnvironment, DesktopEnvironmentChoice, customEnvironment, parseEnvironments } from '../common/desktop-environments';
import { DesktopSession, signIn } from './desktop-sign-in';
import { CREDENTIALS_ENV, TokenBroker, startTokenBroker } from './desktop-token-broker';

/**
 * The desktop Studio (ADR-0027): what turns `electron-app` from an editor into
 * a session of the Studio it is connected to.
 *
 * Which Studio: the one the member chose in the Studio view (kept in
 * `~/ConstructorStudio/settings.json`), from the list the build carries
 * (STUDIO_DESKTOP_ENVIRONMENTS, set by the packaged app's entry point), or the
 * build's default. STUDIO_DESKTOP_URL pins one Studio and hides the choice —
 * that is a developer's `theia start`. With none of these the IDE is an
 * ordinary editor and none of this runs.
 *
 * Signed in, the backend keeps the member's token in memory and serves it three
 * ways without writing it down: to `git` through the token broker, to the
 * IDE's own widgets through a `/studio-api` proxy that attaches it here, and to
 * nothing else.
 */
export interface DesktopStudioConfig {
    /** The Studio's public address, e.g. `https://studio.example.com`. */
    readonly studioUrl: string;
    /** Where the gateway mounts the gears under that address. */
    readonly gatewayPrefix: string;
    readonly issuer: string;
    readonly clientId: string;
    /** The workspace to open; its sources are cloned when absent. */
    readonly workspaceId?: string;
    readonly workspaceRoot: string;
    /** Where a workspace opened from the Studio view is checked out, one folder each. */
    readonly workspacesDir: string;
    /** A command to open the sign-in page with, instead of the system browser. */
    readonly browserCommand?: string;
}

/** What the member chose, as `settings.json` keeps it. */
export interface DesktopSettings {
    readonly environment?: string;
    readonly custom?: { readonly studioUrl: string; readonly issuer?: string };
    /** Which updates the app takes: `beta` adds pre-releases. Read by the
     *  electron main process (electron-app/desktop-updater.js), not here. */
    readonly updates?: 'stable' | 'beta';
    /** Which Studio tenant each folder was opened for, keyed by the folder.
     *  The folder is named after the workspace, not its id, and a session's
     *  handshake is not there to say it — so without this a window in the
     *  folder cannot tell Studio which project it is looking at. */
    readonly opened?: Readonly<Record<string, OpenedFolder>>;
}

/** What a folder opened from the Studio view was cloned for. */
export interface OpenedFolder {
    /** The Studio it came from: a tenant id means nothing on another one. */
    readonly studioUrl: string;
    readonly tenantId: string;
}

/** Folders compared the way the file system does: case matters nowhere on Windows. */
function folderKey(folder: string): string {
    const resolved = path.resolve(folder);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The settings with one more folder remembered against its tenant. */
export function rememberOpened(settings: DesktopSettings, folder: string, studioUrl: string, tenantId: string): DesktopSettings {
    return { ...settings, opened: { ...settings.opened, [folderKey(folder)]: { studioUrl, tenantId } } };
}

/**
 * The tenant a folder is a checkout of, on the Studio this app is connected
 * to: the one it was opened for from the Studio view, else the workspace a
 * deployment pinned with STUDIO_DESKTOP_WORKSPACE_ID at its root.
 */
export function openedTenant(settings: DesktopSettings, config: DesktopStudioConfig, folder: string): string | undefined {
    const key = folderKey(folder);
    const opened = settings.opened?.[key];
    if (opened && opened.studioUrl === config.studioUrl) {
        return opened.tenantId;
    }
    if (config.workspaceId && folderKey(config.workspaceRoot) === key) {
        return config.workspaceId;
    }
    return undefined;
}

/** The Studios on offer, and the one a developer pinned, from the environment. */
export function environmentsFrom(env: NodeJS.ProcessEnv): { list: DesktopEnvironment[]; pinned?: DesktopEnvironment; defaultId?: string } {
    const url = env.STUDIO_DESKTOP_URL?.trim().replace(/\/+$/, '');
    const pinned = url ? {
        id: 'pinned',
        label: url.replace(/^https?:\/\//, ''),
        studioUrl: url,
        issuer: env.STUDIO_DESKTOP_ISSUER?.trim() || `${url}/realms/studio`,
    } : undefined;
    let list: DesktopEnvironment[] = [];
    try {
        list = parseEnvironments(JSON.parse(env.STUDIO_DESKTOP_ENVIRONMENTS ?? '[]'));
    } catch {
        list = [];
    }
    return { list, pinned, defaultId: env.STUDIO_DESKTOP_DEFAULT?.trim() || undefined };
}

/** The Studio to connect to: pinned, else chosen, else the build's default, else the first. */
export function chooseEnvironment(
    list: readonly DesktopEnvironment[], pinned: DesktopEnvironment | undefined, settings: DesktopSettings, defaultId?: string
): DesktopEnvironment | undefined {
    if (pinned) {
        return pinned;
    }
    if (settings.custom?.studioUrl) {
        return customEnvironment(settings.custom.studioUrl, settings.custom.issuer);
    }
    return list.find(e => e.id === settings.environment) ?? list.find(e => e.id === defaultId) ?? list[0];
}

export function desktopConfigFrom(
    env: NodeJS.ProcessEnv, cwd: string, settings: DesktopSettings = {}
): DesktopStudioConfig | undefined {
    const { list, pinned, defaultId } = environmentsFrom(env);
    const environment = chooseEnvironment(list, pinned, settings, defaultId);
    if (!environment) {
        return undefined;
    }
    return {
        studioUrl: environment.studioUrl,
        gatewayPrefix: (env.STUDIO_DESKTOP_GATEWAY_PREFIX ?? '/cf').replace(/\/+$/, ''),
        issuer: environment.issuer,
        clientId: env.STUDIO_DESKTOP_CLIENT_ID?.trim() || 'studio-desktop',
        workspaceId: env.STUDIO_DESKTOP_WORKSPACE_ID?.trim() || undefined,
        workspaceRoot: env.STUDIO_WORKSPACE_ROOT?.trim() || cwd,
        workspacesDir: env.STUDIO_DESKTOP_WORKSPACES?.trim() || path.join(os.homedir(), 'ConstructorStudio', 'workspaces'),
        browserCommand: env.STUDIO_DESKTOP_BROWSER?.trim() || undefined,
    };
}

/** The system browser, the way each platform spells it. */
function openInBrowser(url: string, command?: string): void {
    const [file, args] = command
        ? [command, [url]]
        : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
            : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
}

/**
 * The credential helper script. Resolved through the package, because in a
 * bundled app `__dirname` is the bundle's directory, not this package's.
 */
export function desktopGitHelper(): string {
    try {
        return require.resolve('studio/scripts/desktop-git-credentials.mjs');
    } catch {
        return path.join(__dirname, '..', '..', 'scripts', 'desktop-git-credentials.mjs');
    }
}

/**
 * The `credential.helper` value: the helper run by this very executable. A
 * member's machine need not have Node — the app is one, when asked to be.
 */
export function helperCommand(execPath: string, helper: string): string {
    const slash = (p: string): string => p.split('\\').join('/');
    return `!ELECTRON_RUN_AS_NODE=1 "${slash(execPath)}" "${slash(helper)}"`;
}

/** A folder name for a workspace: its name with what a file system refuses removed, or its id. */
export function folderFor(name: string | undefined, id: string): string {
    const safe = (name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').trim().replace(/^[.-]+|[.-]+$/g, '');
    return safe || id;
}

/** What the IDE's Studio view shows; never a token. */
export interface DesktopStatus extends DesktopEnvironmentChoice {
    readonly enabled: boolean;
    readonly studioUrl?: string;
    readonly state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    readonly error?: string;
    readonly user?: { readonly sub: string; readonly name?: string; readonly tenantId?: string };
    /** The update channel the member chose. */
    readonly updates: 'stable' | 'beta';
}

function claimsOf(accessToken: string): Record<string, unknown> {
    try {
        return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString('utf8'));
    } catch {
        return {};
    }
}

function readSettings(file: string): DesktopSettings {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopSettings;
    } catch {
        return {};
    }
}

interface SourceDto {
    readonly name: string;
    readonly clone_path: string;
    readonly branch?: string;
    readonly target?: string;
}

@injectable()
export class DesktopStudioContribution implements BackendApplicationContribution {
    protected readonly settingsFile = process.env.STUDIO_DESKTOP_SETTINGS?.trim()
        || path.join(os.homedir(), 'ConstructorStudio', 'settings.json');
    protected readonly offered = environmentsFrom(process.env);
    protected settings = readSettings(this.settingsFile);
    protected config = desktopConfigFrom(process.env, process.cwd(), this.settings);
    protected session: DesktopSession | undefined;
    protected broker: TokenBroker | undefined;
    protected ready: Promise<void> | undefined;
    protected status: DesktopStatus = this.describe('signed-out');

    /** The status for the current Studio, in the given state and signed out of any other. */
    protected describe(state: DesktopStatus['state'], extra: Partial<DesktopStatus> = {}): DesktopStatus {
        const current = chooseEnvironment(this.offered.list, this.offered.pinned, this.settings, this.offered.defaultId);
        return {
            enabled: !!this.config,
            studioUrl: this.config?.studioUrl,
            environments: this.offered.pinned ? [this.offered.pinned] : this.offered.list,
            current,
            switchable: !this.offered.pinned,
            state,
            // The same default as electron-app/desktop-updater.js: a pre-release
            // follows betas until the member chooses.
            updates: this.settings.updates ?? ((process.env.STUDIO_DESKTOP_VERSION ?? '').includes('-') ? 'beta' : 'stable'),
            ...extra,
        };
    }

    /** Keep the member's choices, and say so if they could not be written. */
    protected saveSettings(settings: DesktopSettings): void {
        this.settings = settings;
        try {
            fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
            fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2));
        } catch (error) {
            console.warn(`[studio-desktop] the settings could not be saved: ${error}`);
        }
    }

    configure(app: express.Application): void {
        if (!this.config) {
            return;
        }
        app.get('/studio-desktop/status', (_req, res) => { res.json(this.status); });
        // Connect to another Studio: sign out of this one, remember the choice.
        app.post('/studio-desktop/environment', express.json(), async (req, res) => {
            if (this.offered.pinned) {
                res.status(409).json({ error: 'this run is pinned to one Studio by STUDIO_DESKTOP_URL' });
                return;
            }
            const { id, studioUrl, issuer } = (req.body ?? {}) as { id?: string; studioUrl?: string; issuer?: string };
            let settings: DesktopSettings;
            if (studioUrl) {
                if (!/^https?:\/\/[^/\s]+/.test(studioUrl.trim())) {
                    res.status(400).json({ error: 'a Studio address starts with https:// (or http:// on this machine)' });
                    return;
                }
                settings = { custom: { studioUrl: studioUrl.trim(), issuer: issuer?.trim() || undefined } };
            } else if (id && this.offered.list.some(e => e.id === id)) {
                settings = { environment: id };
            } else {
                res.status(400).json({ error: `no Studio "${id ?? ''}" in this build` });
                return;
            }
            await this.signOut();
            // The update channel is the member's too, and outlives a change of Studio.
            // So is what each folder was opened for: it says which Studio too.
            this.saveSettings({ ...settings, updates: this.settings.updates, opened: this.settings.opened });
            this.config = desktopConfigFrom(process.env, process.cwd(), this.settings);
            this.status = this.describe('signed-out');
            res.json(this.status);
        });
        // Which updates the app takes. The electron main process reads the
        // file before every check, so this needs no restart.
        app.post('/studio-desktop/updates', express.json(), (req, res) => {
            const { channel } = (req.body ?? {}) as { channel?: string };
            if (channel !== 'stable' && channel !== 'beta') {
                res.status(400).json({ error: 'the channel is stable or beta' });
                return;
            }
            this.saveSettings({ ...this.settings, updates: channel });
            this.status = { ...this.status, updates: channel };
            res.json(this.status);
        });
        app.post('/studio-desktop/sign-out', async (_req, res) => {
            await this.signOut();
            res.json(this.status);
        });
        // Open a workspace: clone what is not on disk yet, answer with the folder.
        app.post('/studio-desktop/open', express.json(), async (req, res) => {
            const config = this.config!;
            const { workspaceId, name } = (req.body ?? {}) as { workspaceId?: string; name?: string };
            if (!workspaceId || !this.session) {
                res.status(400).json({ error: this.session ? 'which workspace?' : 'not signed in' });
                return;
            }
            try {
                const dir = path.join(config.workspacesDir, folderFor(name, workspaceId));
                const cloned = await this.cloneSources(config, workspaceId, dir);
                this.saveSettings(rememberOpened(this.settings, dir, config.studioUrl, workspaceId));
                res.json({ path: dir, cloned });
            } catch (error) {
                res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
            }
        });
        // Which tenant a folder is a checkout of — what the Analyze panel asks
        // before it can name a project to Studio. 404 is an answer: a folder
        // somebody opened by hand is not one Studio knows.
        app.get('/studio-desktop/opened', (req, res) => {
            const root = typeof req.query.root === 'string' ? req.query.root : '';
            const tenantId = root ? openedTenant(this.settings, this.config!, root) : undefined;
            if (!tenantId) {
                res.status(404).json({ error: 'this folder was not opened from Studio' });
                return;
            }
            res.json({ tenantId });
        });
        app.post('/studio-desktop/sign-in', (_req, res) => {
            if (this.status.state !== 'signing-in' && this.status.state !== 'signed-in') {
                this.ready = this.start(this.config!);
            }
            res.status(202).json(this.status);
        });
        // The widgets call `studio-api/<gear path>` as they do inside a session,
        // where the session gate forwards it. Here the backend is the gate.
        app.use('/studio-api', async (req, res) => {
            try {
                await this.ready;
                const config = this.config!;
                if (!this.session) {
                    res.status(503).json({ error: 'not signed in to Constructor Studio' });
                    return;
                }
                const target = `${config.studioUrl}${config.gatewayPrefix}${req.url}`;
                const hasBody = !['GET', 'HEAD'].includes(req.method);
                const answer = await fetch(target, {
                    method: req.method,
                    headers: {
                        Authorization: `Bearer ${await this.session.accessToken()}`,
                        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
                        ...(req.headers.accept ? { Accept: String(req.headers.accept) } : {}),
                    },
                    body: hasBody ? (req as unknown as ReadableStream) : undefined,
                    // Node's fetch needs this to stream a request body.
                    ...(hasBody ? { duplex: 'half' } : {}),
                } as RequestInit);
                res.status(answer.status);
                const type = answer.headers.get('content-type');
                if (type) {
                    res.setHeader('Content-Type', type);
                }
                res.end(Buffer.from(await answer.arrayBuffer()));
            } catch (error) {
                res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
            }
        });
    }

    onStart(): void {
        // Signing in is the person's move, from the Studio view — except where
        // a deployment asks for it at launch.
        if (this.config && process.env.STUDIO_DESKTOP_AUTO_SIGN_IN === '1') {
            this.ready = this.start(this.config);
        }
    }

    onStop(): void {
        this.broker?.close();
    }

    /** Forget the token and stop handing it to git. */
    protected async signOut(): Promise<void> {
        this.session = undefined;
        await this.broker?.close();
        this.broker = undefined;
        delete process.env[CREDENTIALS_ENV];
        this.status = this.describe('signed-out');
    }

    protected async start(config: DesktopStudioConfig): Promise<void> {
        this.status = this.describe('signing-in');
        try {
            await this.signInAndPrepare(config);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[studio-desktop] ${message}`);
            this.status = this.session
                ? { ...this.status, error: message }
                : this.describe('failed', { error: message });
        }
    }

    protected async signInAndPrepare(config: DesktopStudioConfig): Promise<void> {
        const tokens = await signIn({
            issuer: config.issuer,
            clientId: config.clientId,
            openBrowser: url => {
                console.info(`[studio-desktop] sign in at ${url}`);
                openInBrowser(url, config.browserCommand);
            },
        });
        if (config !== this.config) {
            // The member switched Studios while the browser was open.
            return;
        }
        this.session = new DesktopSession(config.issuer, config.clientId, tokens);
        const session = this.session;
        this.broker = await startTokenBroker(new URL(config.studioUrl).host, () => session.accessToken());
        // Inherited by the plugin host, vscode.git, terminals and agents.
        process.env[CREDENTIALS_ENV] = this.broker.address;
        const claims = claimsOf(tokens.accessToken);
        this.status = this.describe('signed-in', {
            user: {
                sub: String(claims.sub ?? ''),
                name: typeof claims.name === 'string' ? claims.name
                    : typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
                tenantId: typeof claims.tenant_id === 'string' ? claims.tenant_id : undefined,
            },
        });
        console.info(`[studio-desktop] signed in to ${config.studioUrl} as ${this.status.user?.name ?? this.status.user?.sub}`);
        if (config.workspaceId) {
            await this.cloneSources(config, config.workspaceId, config.workspaceRoot);
        }
    }

    /** Clone every source of the workspace that is not on disk yet; answer with what was cloned. */
    protected async cloneSources(config: DesktopStudioConfig, workspaceId: string, root: string): Promise<string[]> {
        const answer = await fetch(
            `${config.studioUrl}${config.gatewayPrefix}/studio-git/v1/sources?project_id=${encodeURIComponent(workspaceId)}`,
            { headers: { Authorization: `Bearer ${await this.session!.accessToken()}` } }
        );
        if (answer.status === 404) {
            // Our own gear answers 404 as a problem that names the workspace; any
            // other 404 is the gateway's, meaning this Studio has no studio-git.
            const problem = await answer.json().catch(() => undefined) as { context?: { resource_name?: string } } | undefined;
            throw new Error(problem?.context?.resource_name
                ? 'you cannot see this workspace\'s settings'
                : `${config.studioUrl} cannot clone for a desktop yet (it runs no studio-git)`);
        }
        if (!answer.ok) {
            throw new Error(`the workspace's sources could not be listed (HTTP ${answer.status})`);
        }
        const { items } = await answer.json() as { items: SourceDto[] };
        fs.mkdirSync(root, { recursive: true });
        const cloned: string[] = [];
        for (const source of items) {
            const dir = path.resolve(root, source.target ?? source.name);
            if (fs.existsSync(path.join(dir, '.git'))) {
                continue;
            }
            const url = `${config.studioUrl}${config.gatewayPrefix}${source.clone_path}`;
            // `-c` on clone is written into the new repository's config: what
            // lands there is the helper's path, never a token.
            const helper = helperCommand(process.execPath, desktopGitHelper());
            const args = ['clone', '-c', 'credential.helper=', '-c', `credential.helper=${helper}`];
            if (source.branch) {
                args.push('--branch', source.branch);
            }
            args.push(url, dir);
            await new Promise<void>((resolve, reject) =>
                execFile('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, _out, stderr) =>
                    error ? reject(new Error(`cloning ${source.name} failed: ${stderr.trim()}`)) : resolve()));
            console.info(`[studio-desktop] cloned ${source.name} into ${dir}`);
            cloned.push(source.name);
        }
        return cloned;
    }
}
