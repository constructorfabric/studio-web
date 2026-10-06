import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as express from '@theia/core/shared/express';
import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { DesktopEnvironment, DesktopEnvironmentChoice, customEnvironment, parseEnvironments } from '../common/desktop-environments';
import { clonePercent, parseGitProgress, type OpenProgress, type SourceProgress } from '../common/desktop-open-progress';
import { GitRunner, describeRepository, pushRepository, repositoriesUnder, runGit, syncRepository } from './desktop-git';
import { DesktopLeases, LeaseTarget } from './desktop-leases';
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
    /** Which updates the app took before the choice moved to Settings
     *  (`studio.desktop.updateChannel`). Read once by the desktop frontend,
     *  which copies it into the preference and then removes it from here. */
    readonly updates?: 'stable' | 'beta';
    /** Which Studio tenant each folder was opened for, keyed by the folder.
     *  The folder is named after the workspace, not its id, and a session's
     *  handshake is not there to say it — so without this a window in the
     *  folder cannot tell Studio which project it is looking at. */
    readonly opened?: Readonly<Record<string, OpenedFolder>>;
    /** This installation's id, which keys its desktop sessions in Studio.
     *  Drawn once and kept, so a restart renews the leases it had. */
    readonly deviceId?: string;
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

/** A folder the git routes may work in: an absolute path to an existing directory. */
export function projectFolder(candidate: unknown): string | undefined {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
        return undefined;
    }
    try {
        return fs.statSync(candidate).isDirectory() ? path.resolve(candidate) : undefined;
    } catch {
        return undefined;
    }
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

/**
 * The folder the app opens when the member chose none, when it is only that: a
 * deployment that pinned a workspace there (STUDIO_DESKTOP_WORKSPACE_ID) made
 * it a project.
 */
export function startFolderOf(config: DesktopStudioConfig | undefined): string | undefined {
    return config && !config.workspaceId ? config.workspaceRoot : undefined;
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

/** The gateway a Studio Git remote is rooted at, while signed in (`https://studio.example/cf`). */
export const GIT_BASE_ENV = 'STUDIO_DESKTOP_GIT_BASE';
/** The `credential.helper` value that signs a request to it with the member's token. */
export const GIT_HELPER_ENV = 'STUDIO_DESKTOP_GIT_HELPER';

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

/**
 * Why a project's sources could not be listed, from a 404 of `studio-git`:
 * `named` when the gear itself answered (its problem names the project),
 * `visible` when the member can read the project tenant nonetheless.
 */
export function missingSourcesMessage(studioUrl: string, named: boolean, visible: boolean): string {
    if (!named) {
        // Any other 404 is the gateway's: this Studio runs no studio-git.
        return `${studioUrl} cannot clone for a desktop yet (it runs no studio-git)`;
    }
    return visible
        ? 'it has no sources yet: add a repository to it in the portal (Sources), then open it again'
        : 'you cannot see this project\'s settings';
}

/** What the IDE's Studio view shows; never a token. */
export interface DesktopStatus extends DesktopEnvironmentChoice {
    readonly enabled: boolean;
    readonly studioUrl?: string;
    readonly state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    readonly error?: string;
    readonly user?: { readonly sub: string; readonly name?: string; readonly email?: string; readonly tenantId?: string };
    /**
     * The folder the app opens when the member has chosen none
     * (`~/ConstructorStudio/workspace` in an installed app): a placeholder, not
     * a project. The desktop landing page takes the main area while it is open.
     */
    readonly startFolder?: string;
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
    /** How the git routes run git; a test swaps it. */
    protected git: GitRunner = runGit;
    protected readonly leases = new DesktopLeases();

    /** The open in progress, or the last one, for the Studio view to draw. */
    protected openProgress: OpenProgress | undefined;

    /** Where this desktop's leases go, while it is signed in. */
    protected leaseTarget(): LeaseTarget | undefined {
        const session = this.session;
        if (!this.config || !session) {
            return undefined;
        }
        let deviceId = this.settings.deviceId;
        if (!deviceId) {
            deviceId = randomUUID();
            this.saveSettings({ ...this.settings, deviceId });
        }
        return {
            studioUrl: this.config.studioUrl,
            gatewayPrefix: this.config.gatewayPrefix,
            accessToken: () => session.accessToken(),
            deviceId,
            deviceName: os.hostname(),
        };
    }

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
            startFolder: startFolderOf(this.config),
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

    /** Whether this backend is connected to a Studio: a desktop, never a session. */
    isEnabled(): boolean {
        return !!this.config;
    }

    /** The project a folder is a checkout of (`openedTenant`), for another desktop route. */
    openedProject(folder: string): string | undefined {
        return this.config ? openedTenant(this.settings, this.config, folder) : undefined;
    }

    /** A gear call to the connected Studio, as the signed-in member. */
    async studioFetch(gearPath: string, init: RequestInit = {}): Promise<Response> {
        const config = this.config;
        const session = this.session;
        if (!config || !session) {
            throw new Error('not signed in to a Studio');
        }
        return fetch(`${config.studioUrl}${config.gatewayPrefix}${gearPath}`, {
            ...init,
            headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await session.accessToken()}` },
        });
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
            // And the device is the same machine whichever Studio it talks to.
            this.saveSettings({
                ...settings, updates: this.settings.updates, opened: this.settings.opened, deviceId: this.settings.deviceId,
            });
            this.config = desktopConfigFrom(process.env, process.cwd(), this.settings);
            this.status = this.describe('signed-out');
            res.json(this.status);
        });
        // The update channel as the Studio view kept it before the choice
        // moved to Settings: the desktop frontend copies it into the
        // preference, then removes it here, so the preference is the only
        // place it lives (electron-browser/desktop-update-channel.ts).
        app.get('/studio-desktop/updates', (_req, res) => {
            const channel = this.settings.updates;
            res.json({ channel: channel === 'stable' || channel === 'beta' ? channel : null });
        });
        app.delete('/studio-desktop/updates', (_req, res) => {
            if (this.settings.updates !== undefined) {
                const { updates: _moved, ...rest } = this.settings;
                this.saveSettings(rest);
            }
            res.status(204).end();
        });
        app.post('/studio-desktop/sign-out', async (_req, res) => {
            await this.signOut();
            res.json(this.status);
        });
        // How far the open is: listing the sources, then each one's clone.
        app.get('/studio-desktop/open-progress', (_req, res) => {
            res.json(this.openProgress ?? null);
        });
        // Open a workspace: clone what is not on disk yet, answer with the folder.
        app.post('/studio-desktop/open', express.json(), async (req, res) => {
            const config = this.config!;
            const { workspaceId, name } = (req.body ?? {}) as { workspaceId?: string; name?: string };
            if (!workspaceId || !this.session) {
                res.status(400).json({ error: this.session ? 'which workspace?' : 'not signed in' });
                return;
            }
            this.openProgress = { workspaceId, name: name ?? workspaceId, phase: 'listing', sources: [] };
            try {
                const dir = path.join(config.workspacesDir, folderFor(name, workspaceId));
                const cloned = await this.cloneSources(config, workspaceId, dir);
                this.saveSettings(rememberOpened(this.settings, dir, config.studioUrl, workspaceId));
                this.openProgress = { ...this.openProgress, phase: 'done' };
                res.json({ path: dir, cloned });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.openProgress = { ...this.openProgress, phase: 'failed', error: message };
                res.status(502).json({ error: message });
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
        // A window showing a folder Studio opened says so every heartbeat, and
        // this renews the workspace's desktop session. 404 is an answer, as for
        // `opened`: a folder somebody opened by hand has no workspace to hold.
        app.post('/studio-desktop/heartbeat', express.json(), async (req, res) => {
            const root = (req.body as { root?: string } | undefined)?.root ?? '';
            const tenantId = root ? openedTenant(this.settings, this.config!, root) : undefined;
            if (!tenantId) {
                res.status(404).json({ error: 'this folder was not opened from Studio' });
                return;
            }
            const target = this.leaseTarget();
            if (!target) {
                res.status(503).json({ error: 'not signed in to Constructor Studio' });
                return;
            }
            try {
                const had = this.leases.open.includes(tenantId);
                const held = await this.leases.renew(target, tenantId);
                // Only a change is worth a line; a renewal every 30 s is not.
                if (held && !had) {
                    console.info(`[studio-desktop] ${target.studioUrl} sees workspace ${tenantId} open on this device`);
                } else if (!held && had) {
                    console.warn(`[studio-desktop] ${target.studioUrl} no longer holds workspace ${tenantId} open for this device`);
                }
                res.status(held ? 204 : 409).end();
            } catch (error) {
                res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
            }
        });
        // The window closed. Another window on the same workspace renews the
        // lease again on its next heartbeat, so ending it here is never wrong
        // for longer than one interval.
        app.post('/studio-desktop/closed', express.json({ type: () => true }), async (req, res) => {
            const root = (req.body as { root?: string } | undefined)?.root ?? '';
            const tenantId = root ? openedTenant(this.settings, this.config!, root) : undefined;
            const target = this.leaseTarget();
            if (tenantId && target) {
                await this.leases.end(target, tenantId);
            }
            res.status(204).end();
        });
        // Git on the opened project's clones (node/desktop-git.ts): what the
        // Sources view lists, and what Sync and Push do on the desktop, where
        // there is no canonical workspace config and no operations queue.
        app.get('/studio-desktop/git/repositories', async (req, res) => {
            const root = projectFolder(req.query.root);
            if (!root) {
                res.status(400).json({ error: 'which folder? (an existing absolute path)' });
                return;
            }
            res.json({ repositories: await Promise.all(repositoriesUnder(root).map(dir => describeRepository(this.git, root, dir))) });
        });
        app.post('/studio-desktop/git/sync', express.json(), async (req, res) => {
            const root = projectFolder((req.body as { root?: unknown } | undefined)?.root);
            if (!root) {
                res.status(400).json({ error: 'which folder? (an existing absolute path)' });
                return;
            }
            const results = [];
            // One at a time: the clones share a remote host and a helper.
            for (const dir of repositoriesUnder(root)) {
                results.push(await syncRepository(this.git, root, dir));
            }
            console.info(`[studio-desktop] sync in ${root}: ${results.map(r => `${r.name} ${r.outcome}`).join(', ') || 'no repositories'}`);
            res.json({ results });
        });
        app.post('/studio-desktop/git/push', express.json(), async (req, res) => {
            const body = (req.body ?? {}) as { root?: unknown; repository?: unknown };
            const root = projectFolder(body.root);
            const dir = root && typeof body.repository === 'string'
                ? repositoriesUnder(root).find(candidate => folderKey(candidate) === folderKey(String(body.repository)))
                : undefined;
            if (!root || !dir) {
                res.status(400).json({ error: 'which repository? (one of the folder\'s clones)' });
                return;
            }
            const result = await pushRepository(this.git, root, dir);
            console.info(`[studio-desktop] push ${result.name}: ${result.outcome}`);
            res.json(result);
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
                    // `reason` is what the widgets tell a sign-in from an outage
                    // by (browser/studio-api.ts `STUDIO_SIGNED_OUT`).
                    res.status(503).json({ error: 'not signed in to Constructor Studio', reason: 'signed-out' });
                    return;
                }
                const target = `${config.studioUrl}${config.gatewayPrefix}${req.url}`;
                const hasBody = !['GET', 'HEAD'].includes(req.method);
                // A buffer, not the request stream: fetch sends a streamed body
                // once, and anything that needs it again -- a redirect it
                // follows, a body parser that got there first -- failed with
                // "Response body object should not be disturbed or locked".
                // Every POST through here did (Analyze's four checks, Sync).
                const body = hasBody ? await requestBody(req) : undefined;
                const answer = await fetch(target, {
                    method: req.method,
                    headers: {
                        Authorization: `Bearer ${await this.session.accessToken()}`,
                        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
                        ...(req.headers.accept ? { Accept: String(req.headers.accept) } : {}),
                        // What makes a retried POST that starts work answer the run it
                        // already started (studio-backend `idempotency.rs`).
                        ...(req.headers['idempotency-key'] ? { 'Idempotency-Key': String(req.headers['idempotency-key']) } : {}),
                    },
                    body,
                });
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
        // Best effort: the process may be gone before Studio answers, and a
        // lease nobody renews ends on its own there.
        const target = this.leaseTarget();
        if (target) {
            void this.leases.endAll(target);
        }
        this.broker?.close();
    }

    /** Forget the token and stop handing it to git. */
    protected async signOut(): Promise<void> {
        const target = this.leaseTarget();
        if (target) {
            await this.leases.endAll(target);
        }
        this.leases.forget();
        this.session = undefined;
        await this.broker?.close();
        this.broker = undefined;
        delete process.env[CREDENTIALS_ENV];
        delete process.env[GIT_BASE_ENV];
        delete process.env[GIT_HELPER_ENV];
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
        // And where Studio's own Git remotes are, with the helper that signs
        // them: for a clone this contribution does not start itself -- the gear
        // corpus, which gearbox-studio brings once per machine.
        process.env[GIT_BASE_ENV] = `${config.studioUrl}${config.gatewayPrefix}`;
        process.env[GIT_HELPER_ENV] = helperCommand(process.execPath, desktopGitHelper());
        const claims = claimsOf(tokens.accessToken);
        this.status = this.describe('signed-in', {
            user: {
                sub: String(claims.sub ?? ''),
                name: typeof claims.name === 'string' ? claims.name
                    : typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
                email: typeof claims.email === 'string' ? claims.email : undefined,
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
            const problem = await answer.json().catch(() => undefined) as { context?: { resource_name?: string } } | undefined;
            const named = !!problem?.context?.resource_name;
            // studio-git answers the same 404 for "no settings" and "not yours";
            // whether the project tenant itself can be read tells the two apart.
            const visible = named && (await fetch(
                `${config.studioUrl}${config.gatewayPrefix}/account-management/v1/tenants/${encodeURIComponent(workspaceId)}`,
                { headers: { Authorization: `Bearer ${await this.session!.accessToken()}` } }
            ).catch(() => undefined))?.ok === true;
            throw new Error(missingSourcesMessage(config.studioUrl, named, visible));
        }
        if (!answer.ok) {
            throw new Error(`the workspace's sources could not be listed (HTTP ${answer.status})`);
        }
        const { items } = await answer.json() as { items: SourceDto[] };
        fs.mkdirSync(root, { recursive: true });
        const cloned: string[] = [];
        const dirOf = (source: SourceDto) => path.resolve(root, source.target ?? source.name);
        const states: SourceProgress[] = items.map(source => ({
            name: source.name,
            state: fs.existsSync(path.join(dirOf(source), '.git')) ? 'present' : 'waiting',
        }));
        const report = (index: number, change: Partial<SourceProgress>) => {
            states[index] = { ...states[index], ...change };
            if (this.openProgress?.workspaceId === workspaceId) {
                this.openProgress = { ...this.openProgress, phase: 'cloning', sources: [...states] };
            }
        };
        if (this.openProgress?.workspaceId === workspaceId) {
            this.openProgress = { ...this.openProgress, phase: 'cloning', sources: [...states] };
        }
        for (const [index, source] of items.entries()) {
            const dir = dirOf(source);
            if (states[index].state === 'present') {
                continue;
            }
            report(index, { state: 'cloning', percent: 0 });
            const url = `${config.studioUrl}${config.gatewayPrefix}${source.clone_path}`;
            // `-c` on clone is written into the new repository's config: what
            // lands there is the helper's path, never a token.
            const helper = helperCommand(process.execPath, desktopGitHelper());
            // --progress: git reports only to a terminal otherwise, and this is a pipe.
            const args = ['clone', '--progress', '-c', 'credential.helper=', '-c', `credential.helper=${helper}`];
            if (source.branch) {
                args.push('--branch', source.branch);
            }
            args.push(url, dir);
            try {
                await this.gitClone(args, (stage, percent) => report(index, { stage, percent }));
            } catch (error) {
                report(index, { state: 'failed' });
                throw new Error(`cloning ${source.name} failed: ${error instanceof Error ? error.message : error}`);
            }
            report(index, { state: 'done', percent: 100, stage: undefined });
            console.info(`[studio-desktop] cloned ${source.name} into ${dir}`);
            cloned.push(source.name);
        }
        return cloned;
    }

    /**
     * Run one `git clone`, handing each progress line on as the stage and the
     * whole clone's percentage. Rejects with what git said last that was not
     * progress — the reason, not a bar at 43%.
     */
    protected gitClone(args: string[], onProgress: (stage: string, percent: number) => void): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
            let said = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => {
                // Progress redraws one line with a carriage return; a chunk may
                // end mid-line, which only costs one reading of the bar.
                for (const line of chunk.split(/[\r\n]+/)) {
                    const progress = parseGitProgress(line);
                    const percent = progress && clonePercent(progress.stage, progress.percent);
                    if (progress && percent !== undefined) {
                        onProgress(progress.stage, percent);
                    } else if (line.trim()) {
                        said = `${said}\n${line.trim()}`.slice(-2000);
                    }
                }
            });
            child.on('error', reject);
            child.on('close', code => code === 0
                ? resolve()
                : reject(new Error(said.trim().split('\n').slice(-3).join(' ') || `git exited with ${code}`)));
        });
    }
}

/**
 * The whole body of a request the proxy forwards, as bytes that can be sent
 * again. A body a parser already read is serialised back; otherwise the stream
 * is read to its end.
 */
export async function requestBody(req: express.Request): Promise<Buffer | undefined> {
    const parsed = (req as { body?: unknown }).body;
    if (parsed !== undefined && (req.readableEnded || Buffer.isBuffer(parsed) || typeof parsed === 'string')) {
        if (Buffer.isBuffer(parsed)) {
            return parsed;
        }
        return Buffer.from(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
    }
    if (req.readableEnded) {
        return undefined;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}
