import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as express from '@theia/core/shared/express';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { PluginServer, PluginType } from '@theia/plugin-ext/lib/common/plugin-protocol';
import { parseAssistantsManifest } from '../common/desktop-assistants';
import { AssistantStore } from './desktop-assistants-store';
import { DesktopStudioContribution } from './desktop-studio-contribution';

/**
 * Where the assistants come from on a desktop, from the environment the
 * packaged app's entry point (electron-app/desktop-main.js) sets:
 * STUDIO_DESKTOP_ASSISTANTS names the manifest the installer carries, and
 * STUDIO_DESKTOP_PLUGINS the folder they are unpacked into.
 */
export function assistantsConfigFrom(env: NodeJS.ProcessEnv): { manifest: string; pluginsDir: string; dropDirs: string[] } | undefined {
    const manifest = env.STUDIO_DESKTOP_ASSISTANTS?.trim();
    if (!manifest) {
        return undefined;
    }
    return {
        manifest,
        pluginsDir: env.STUDIO_DESKTOP_PLUGINS?.trim() || path.join(os.homedir(), 'ConstructorStudio', 'plugins'),
        dropDirs: (env.STUDIO_DESKTOP_VSIX_DIRS ?? '').split(path.delimiter).map(d => d.trim()).filter(Boolean),
    };
}

/**
 * Claude Code and Codex on a desktop (#480): not in the installer, fetched on
 * first need and deployed into the running app.
 *
 * Mounted only on a desktop whose build carries a manifest, like the rest of
 * `/studio-desktop` (docs/desktop-contributing.md, rule 1): a browser session
 * sets neither variable, so there is no route and nothing runs.
 *
 * - `GET  /studio-desktop/assistants`         what each one is doing.
 * - `POST /studio-desktop/assistants/ensure`  fetch what is missing (the
 *   window asks once it is up; the call returns at once).
 * - `POST /studio-desktop/assistants/retry`   try a failed one again.
 */
@injectable()
export class DesktopAssistantsContribution implements BackendApplicationContribution {
    @inject(DesktopStudioContribution)
    protected readonly desktop: DesktopStudioContribution;

    @inject(PluginServer) @optional()
    protected readonly pluginServer: PluginServer | undefined;

    protected store: AssistantStore | undefined;

    configure(app: express.Application): void {
        const config = assistantsConfigFrom(process.env);
        if (!config || !this.desktop.isEnabled()) {
            return;
        }
        let manifest: unknown;
        try {
            manifest = JSON.parse(fs.readFileSync(config.manifest, 'utf8'));
        } catch (error) {
            console.warn(`[studio-desktop] no assistants: ${config.manifest} cannot be read (${error})`);
            return;
        }
        const { pins, rejected } = parseAssistantsManifest(manifest);
        if (rejected.length) {
            console.warn(`[studio-desktop] assistants manifest: ignored ${rejected.join(', ')}`);
        }
        const pluginServer = this.pluginServer;
        this.store = new AssistantStore({
            pluginsDir: config.pluginsDir,
            dropDirs: config.dropDirs,
            pins,
            // Theia 1.75: PluginDeployerImpl resolves the entry, deploys it and
            // fires onDidDeploy, on which every window's HostedPluginSupport
            // loads and starts the new plugin. No restart.
            deploy: async entry => {
                if (!pluginServer) {
                    throw new Error('this app cannot install extensions while it runs; restart it to load the download');
                }
                await pluginServer.install(entry, PluginType.System);
            },
        });
        const store = this.store;
        app.get('/studio-desktop/assistants', (_req, res) => { res.json(store.status()); });
        app.post('/studio-desktop/assistants/ensure', (_req, res) => {
            void store.ensure();
            res.json(store.status());
        });
        app.post('/studio-desktop/assistants/retry', express.json(), (req, res) => {
            const id = typeof req.body?.id === 'string' ? req.body.id : undefined;
            void store.retry(id);
            res.json(store.status());
        });
    }
}
