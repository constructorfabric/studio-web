// Portal bridge: makes an embedded session feel native inside the Studio
// portal (the IDE runs in an iframe there — a "Space"). Two duties:
//
//  * portal → IDE: `studio.init` / `studio.theme` messages carry the
//    portal's theme; the bridge maps it onto Theia's color theme so a dark
//    portal never opens a light IDE.
//  * IDE → portal: `studio.status` messages report the dirty-editor count,
//    so the portal can mark the space ("unsaved changes" dot) without
//    polling, and `studio.documentSaved` reports a portal document the IDE
//    has just written back through the documents gear.
//
// The portal→IDE half also carries the *editing hand-off*: `studio.openInEditor`
// (a repository file), `studio.openGraph`, `studio.openDocument` (a portal
// document, opened in the markdown editor via the `studio-doc:` resolver) and
// `studio.openProduct` (a product.gdl, opened in the Gearbox perspective) and
// `studio.openGear` (a gear project's gear, in the same perspective).
// The bridge listens only once the session's origin rules have arrived
// (`listenToPortal`) and drops whatever was posted before, so the portal
// repeats `studio.init` until it is answered and holds these until then: that
// is what lets "open the IDE" and "edit this thing" be one click.
//
// Security (#324): messages are only exchanged with the embedding window, and
// only when its origin is one the session allows — its own origin, or the
// list in `STUDIO_ALLOWED_ORIGINS`, which the server also puts into the
// page's `frame-ancestors`. The bridge does not listen until it has that
// list. The first accepted message pins the portal's origin for the life of
// the frame; everything is posted to it and nothing to `*`.
// Standalone (non-embedded) sessions skip all of this.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Saveable } from '@theia/core/lib/browser/saveable';
import { CommandContribution, CommandRegistry, CommandService, Disposable, PreferenceService, PreferenceScope } from '@theia/core/lib/common';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { ArtifactGraphCommand } from './artifact-graph-contribution';
import { NotifyEditorFrontendController } from './notify-editor-controller';
import { OpenInEditorFrontendController } from './open-in-editor-controller';
import { StudioApi } from './studio-api';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { DOCUMENTS_PERSPECTIVE_ID } from '../common/studio-modes';
import { StudioRuntimeService, type StudioRuntimeSession } from '../common/studio-protocol';
import { StudioDocumentOpener } from './studio-document-opener';
import { StudioWorkspaceName } from './studio-workspace-name';
import { StudioDocumentResourceResolver } from './studio-document-resource';

/**
 * The person the portal has signed in, as `studio.init` and `studio.token`
 * carry them.
 *
 * The IDE has no login of its own — it is served through the session gate, and
 * one session container is shared by everybody who opens that workspace — so
 * the portal is the only side that knows who is at the keyboard. Until this
 * arrived, the product's identity was a display name typed into a text field
 * and kept in the browser's own storage, which made every author in a document
 * indistinguishable from every other.
 */
export interface PortalViewer {
    /** The identity provider's subject. Stable across a rename, which is why
     *  it and not the name is what an authored comment is keyed by. */
    sub?: string;
    /** Display only. */
    name?: string;
    /** What the IDE commits as. Absent when the identity provider states no
     *  address, and then the session keeps its own default. */
    email?: string;
    /** `person` unless the portal is driving the IDE as something else. */
    kind?: string;
}

/**
 * Hands `PortalViewer` to the product extension's identity module.
 *
 * A command id rather than an import: `product-ext` is a separate Theia
 * extension that this package does not depend on (and which is plain
 * JavaScript). Declared here as a literal because a shared constant would need
 * exactly the dependency the command exists to avoid — the two spellings are
 * pinned together by `portal-bridge-contribution.test.ts`.
 */
export const IDENTITY_VIEWER_COMMAND_ID = 'studio.identity.viewer';

/** gearbox-studio's command for `studio.openProduct` (`StudioGearboxPerspective`).
 *  By id, so studio does not depend on the package that registers it. */
export const GEARBOX_OPEN_PRODUCT_COMMAND_ID = 'gearbox.product.openAt';

/** gearbox-studio's command for `studio.openGear`: the gear at a path, or the
 *  project's own gear when no path is given. */
export const GEARBOX_OPEN_GEAR_COMMAND_ID = 'gearbox.gear.openAt';

/** Asks the portal to show a component's page in its catalogue, by catalogue
 *  name (`cf-gears-api-gateway`). gearbox-studio links a gear to it by id. */
export const OPEN_COMPONENT_IN_PORTAL_COMMAND_ID = 'studio.portal.openComponent';

interface PortalMessage {
    type?: string;
    theme?: string;
    apiToken?: string;
    path?: string;
    /** `studio.openProduct`: the branch the description was saved onto, when
     *  that is not the branch the session has checked out. */
    branch?: string;
    /** Who the portal has signed in; see {@link PortalViewer}. */
    viewer?: PortalViewer;
    /** Tenant that opened this session — a workspace tenant (shows every
     *  project under it) or a project tenant (shows just that project). Scopes
     *  the Artifact Graph's reads so it never bleeds other projects' nodes.
     *
     *  On `studio.openDocument` it means something narrower: the workspace
     *  tenant that STORES the document. A project shows its parent workspace's
     *  documents, so the two ids genuinely differ and the handshake's scope
     *  cannot stand in for it. */
    workspaceId?: string;
    /** `studio.openDocument`: the document to open, and the title its editor
     *  tab shows. */
    documentId?: string;
    title?: string;
    /** `studio.notify`: a message the portal wants shown here — the same
     *  shape the S2S `notifyEditor` call carries, so both routes end up in
     *  one place. */
    level?: 'info' | 'warn' | 'error';
    message?: string;
    detail?: string;
    source?: string;
    link?: string;
    /** What the portal calls this session. The IDE opens `/workspace`, so
     *  without this every surface names the project after the container's
     *  directory. */
    workspaceName?: string;
}

/**
 * Latest portal-issued API token (module-scoped, never persisted). The
 * portal renews it silently and re-posts `studio.token`; gears calls go
 * same-origin through the session gate at `/studio-api/<gear path>`.
 */
/**
 * Whether a portal on `origin` may talk to this session: the session's own
 * origin, or one on its list. `null` (a sandboxed or opaque sender) never.
 */
function isAllowedPortalOrigin(
    origin: string,
    session: Pick<StudioRuntimeSession, 'allowedOriginsMode' | 'allowedOrigins'>,
    ownOrigin: string,
): boolean {
    if (origin === 'null') {
        return false;
    }
    return session.allowedOriginsMode === 'allowlist'
        ? session.allowedOrigins.includes(origin)
        : origin === ownOrigin;
}

/** The two spellings the document surfaces arbitrate over. */
function isMarkdownPath(relativePath: string): boolean {
    const path = relativePath.toLowerCase();
    return path.endsWith('.md') || path.endsWith('.markdown');
}

@injectable()
export class PortalBridgeContribution implements FrontendApplicationContribution, CommandContribution {

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(CommandService)
    protected readonly commands: CommandService;

    @inject(OpenInEditorFrontendController)
    protected readonly opener: OpenInEditorFrontendController;

    @inject(StudioDocumentOpener)
    protected readonly documentOpener: StudioDocumentOpener;

    @inject(NotifyEditorFrontendController)
    protected readonly notifier: NotifyEditorFrontendController;

    @inject(StudioDocumentResourceResolver)
    protected readonly documentResources: StudioDocumentResourceResolver;

    // Optional: an application without perspectives still opens documents, it
    // just does not rearrange itself around them.
    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    @inject(StudioWorkspaceName)
    protected readonly workspaceName: StudioWorkspaceName;

    @inject(StudioRuntimeService)
    protected readonly runtime: StudioRuntimeService;

    protected readonly toDispose = new DisposableCollection();
    /** See [`openWhenLayoutReady`]. */
    protected layoutReady = false;
    protected readonly deferredOpens: (() => void)[] = [];
    protected portalOrigin: string | undefined;
    protected lastDirty = -1;
    protected lastAiToken = '';

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: OPEN_COMPONENT_IN_PORTAL_COMMAND_ID }, {
            isEnabled: () => window.parent !== window,
            execute: (name?: string) => this.openComponentInPortal(name),
        });
    }

    /**
     * The component's page in the portal's catalogue. Posted only to the
     * portal origin the handshake established, like every other message this
     * bridge sends; before the handshake there is nowhere to say it.
     */
    protected openComponentInPortal(name: string | undefined): boolean {
        if (!name || window.parent === window || !this.portalOrigin) {
            return false;
        }
        window.parent.postMessage({ type: 'studio.openComponent', name }, this.portalOrigin);
        return true;
    }

    onStart(): void {
        if (window.parent === window) {
            return; // standalone tab — no portal to talk to
        }
        void this.listenToPortal();
    }

    /**
     * Not before the session's origin list has arrived, and not at all if it
     * never does. The portal repeats its opening messages until one is
     * answered, so what it posted before is not lost.
     */
    protected async listenToPortal(): Promise<void> {
        let session: StudioRuntimeSession;
        try {
            session = await this.runtime.getSession();
        } catch (e) {
            console.warn('[studio] portal bridge disabled: session unavailable', e);
            return;
        }
        const ownOrigin = window.location.origin;

        // Tell the portal about every document this session writes back, so its
        // list, status and conformance checklist re-read the row instead of
        // showing the copy it held before the hand-off.
        this.toDispose.push(this.documentResources.onDidSaveDocument(ref => {
            if (!this.portalOrigin) {
                return;
            }
            window.parent.postMessage({
                type: 'studio.documentSaved',
                workspaceId: ref.workspaceId,
                documentId: ref.documentId,
            }, this.portalOrigin);
        }));

        const onMessage = (event: MessageEvent): void => {
            if (event.source !== window.parent) {
                return; // only the embedding portal window is trusted
            }
            if (this.portalOrigin
                ? event.origin !== this.portalOrigin
                : !isAllowedPortalOrigin(event.origin, session, ownOrigin)) {
                return;
            }
            const msg = event.data as PortalMessage;
            if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('studio.')) {
                return;
            }
            this.portalOrigin = event.origin;
            if ((msg.type === 'studio.init' || msg.type === 'studio.theme') && msg.theme) {
                this.applyPortalTheme(msg.theme);
            }
            if ((msg.type === 'studio.init' || msg.type === 'studio.token') && msg.apiToken) {
                StudioApi.token = msg.apiToken;
                // Alongside the token, and from the same message, so nothing
                // can call a gear as a person the portal has not named.
                StudioApi.viewer = msg.viewer;
                void this.configureTheiaAi(msg.apiToken);
            }
            if ((msg.type === 'studio.init' || msg.type === 'studio.token') && typeof msg.workspaceId === 'string') {
                StudioApi.scope = msg.workspaceId;
            }
            if (msg.type === 'studio.init' || msg.type === 'studio.token') {
                // Restated on every silent renew, not only at the handshake: a
                // hosted session outlives a token, and the person can change
                // under a live page when the portal posts a different one.
                this.adoptPortalViewer(msg.viewer);
            }
            if (typeof msg.workspaceName === 'string') {
                this.workspaceName.setName(msg.workspaceName);
            }
            if (msg.type === 'studio.init') {
                this.postStatus(); // answer the handshake right away
            }
            if (msg.type === 'studio.openGraph') {
                // Experiment (ADR-0010): the portal's artifact list asks the
                // embedded IDE to open the Artifact Graph view (backend graph,
                // no `cfs map` dependency).
                this.openWhenLayoutReady(() => void this.commands.executeCommand(ArtifactGraphCommand.id));
            }
            if (msg.type === 'studio.openInEditor' && msg.path) {
                // The portal's file list asks the embedded IDE to open a
                // repository file in its editor (ADR-0010 openInEditor). Resolved
                // against the first workspace root by the controller.
                const relativePath = msg.path;
                this.openWhenLayoutReady(() => void this.openFileInMode(relativePath));
            }
            if (msg.type === 'studio.openProduct' && msg.path) {
                // The portal's Components tab asks for a product: the Gearbox
                // perspective, with the product open through Gearbox (resolved,
                // with its graph, lock and conflicts), not a bare file. The
                // command belongs to gearbox-studio; an image without it opens
                // the description as a file, which is what the portal asked
                // before this message existed.
                const productPath = msg.path;
                const productBranch = typeof msg.branch === 'string' && msg.branch ? msg.branch : undefined;
                this.openWhenLayoutReady(() => void this.openProductInMode(productPath, productBranch));
            }
            if (msg.type === 'studio.openGear') {
                // A gear project's "Open in IDE": its gear, in the Gearbox
                // perspective. The portal knows the repository, not where in it
                // the gear went, so the path is optional and gearbox-studio
                // finds the gear. Without gearbox-studio there is nothing to
                // open it with, and the IDE simply stays as it opened.
                const gearPath = msg.path;
                this.openWhenLayoutReady(
                    () => void this.commands.executeCommand(GEARBOX_OPEN_GEAR_COMMAND_ID, gearPath).catch(() => undefined),
                );
            }
            if (msg.type === 'studio.notify' && msg.message) {
                // Background work finished, and the person may be looking at
                // this editor rather than at the portal that told it — the
                // session runs inside that very page.
                //
                // NOT gated on the layout, unlike the opens: a notification
                // moves nothing and steals no focus, and holding it back would
                // only make it arrive after the thing it is about is stale.
                //
                // The same controller the backend's notifyEditor uses (ADR-0010
                // §4). Two ways to ask, one way to show.
                void this.notifier.onNotifyEditor({
                    level: msg.level ?? 'info',
                    message: msg.message,
                    detail: msg.detail,
                    source: msg.source,
                    link: msg.link,
                });
            }
            if (msg.type === 'studio.openDocument' && msg.workspaceId && msg.documentId) {
                // A portal DOCUMENT — not a file in any checkout. It opens in
                // the markdown editor over the `studio-doc:` resolver, which
                // reads and writes it through the documents gear, so the portal
                // and the IDE edit one row rather than two copies.
                const ref = { workspaceId: msg.workspaceId, documentId: msg.documentId };
                const title = msg.title;
                // Asking to edit a document IS the request for the documents
                // mode — the portal does not have to say both, and a person
                // who came to write should not have to rearrange the workbench
                // first. Switching before the open also decides which editor
                // takes the file: the handlers arbitrate on the active
                // perspective (see MARKDOWN_PRIORITY).
                this.openWhenLayoutReady(() => void this.openDocumentInMode(ref, title));
            }
        };
        window.addEventListener('message', onMessage);
        this.toDispose.push(Disposable.create(() => window.removeEventListener('message', onMessage)));

        // Dirty-state reporting: cheap 2s poll over the shell's widgets —
        // there is no aggregate dirty event, and per-widget listeners would
        // leak on close. Only changes are posted.
        const statusTimer = setInterval(() => this.postStatus(), 2000);
        this.toDispose.push(Disposable.create(() => clearInterval(statusTimer)));
    }

    /**
     * Hand the signed-in person to the product extension's identity module.
     *
     * A viewer without a `sub` is dropped rather than forwarded: the portal
     * posts `studio.token` on every silent renew whether or not it has anybody
     * signed in, and adopting a subject-less viewer would replace a verified
     * identity with an anonymous one halfway through a session.
     *
     * The rejection is caught rather than `void`-ed. This command belongs to a
     * different extension, and a build composed without `product-ext` answers
     * an unknown id by throwing — which would turn every token renew into an
     * unhandled rejection in the console.
     */
    protected adoptPortalViewer(viewer: PortalViewer | undefined): void {
        if (!viewer?.sub) {
            return;
        }
        this.commands.executeCommand(IDENTITY_VIEWER_COMMAND_ID, viewer)
            .catch(e => console.warn('[studio] portal viewer not adopted', e));
    }

    /**
     * Runs after Theia has restored (or built) its shell layout.
     *
     * The portal's hand-off arrives during `onStart`, which is EARLIER: the
     * frontend starts its contributions, and only then restores the layout,
     * which re-activates whichever tab was active when the session was last
     * used. A file opened from `onStart` therefore opens correctly and is then
     * buried — the tab is there, with the old view in front of it, which reads
     * as "the hand-off did nothing".
     */
    onDidInitializeLayout(): void {
        this.layoutReady = true;
        for (const open of this.deferredOpens.splice(0)) {
            open();
        }
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    /** Put the workbench in the documents mode, then open the document. */
    /**
     * A file the portal asked for, in the mode that asking implies.
     *
     * Only for Markdown, and that restraint is the point. Two editors claim a
     * `.md` file and the active perspective decides between them: the studio
     * editor at 600 in the workbench and 400 in documents, the product's rich
     * surface — the one with diagrams, comments and suggestions — at 500. So
     * the same file opens in a different editor depending on a mode the person
     * never chose, and from the portal they had no way to choose it.
     *
     * Asking to edit a document from the portal IS the request for the
     * documents mode, exactly as `studio.openDocument` already treats it. This
     * is the same sentence applied to a file in a checkout rather than a row in
     * the documents gear.
     *
     * Everything else opens where it is: switching perspective for a `.rs`
     * file would rearrange the workbench under somebody who came to read code,
     * and nothing arbitrates on perspective for those anyway — Monaco wins
     * because Monaco is what wins for them.
     */
    /**
     * A product the portal asked for, in the Gearbox perspective and opened
     * through Gearbox. Falls back to opening the description as a file when
     * gearbox-studio is not in this build, which is what `studio.openInEditor`
     * did for it before.
     */
    protected async openProductInMode(relativePath: string, branch?: string): Promise<void> {
        try {
            await this.commands.executeCommand(GEARBOX_OPEN_PRODUCT_COMMAND_ID, relativePath, branch);
        } catch {
            await this.openFileInMode(relativePath);
        }
    }

    protected async openFileInMode(relativePath: string): Promise<void> {
        if (isMarkdownPath(relativePath)) {
            try {
                if (this.perspectives && this.perspectives.getActivePerspectiveId() !== DOCUMENTS_PERSPECTIVE_ID) {
                    await this.perspectives.switchPerspective(DOCUMENTS_PERSPECTIVE_ID);
                }
            } catch (e) {
                // A perspective that will not switch is not a reason to refuse
                // the open: the person still gets the file, in whichever editor
                // the current mode prefers.
                console.warn('[studio] could not switch to the documents perspective', e);
            }
        }
        await this.opener.onOpenInEditor({ relativePath });
    }

    protected async openDocumentInMode(
        ref: { workspaceId: string; documentId: string },
        title: string | undefined,
    ): Promise<void> {
        try {
            if (this.perspectives && this.perspectives.getActivePerspectiveId() !== DOCUMENTS_PERSPECTIVE_ID) {
                await this.perspectives.switchPerspective(DOCUMENTS_PERSPECTIVE_ID);
            }
        } catch (error) {
            // A layout that would not rearrange is no reason to withhold the
            // document the person asked for.
            console.warn('studio: could not switch to the documents perspective', error);
        }
        await this.documentOpener.open(ref, title);
    }

    /**
     * Open something only once the layout can no longer take the focus back.
     *
     * Theme and token messages are applied the moment they arrive — they have
     * nothing to do with the shell's layout. Only the ones that put something
     * in front of the user wait, and they keep their order, so the last thing
     * the portal asked for is the thing on top.
     */
    protected openWhenLayoutReady(open: () => void): void {
        if (this.layoutReady) {
            open();
            return;
        }
        this.deferredOpens.push(open);
    }

    /**
     * Wire the native Theia AI stack (Coder, Universal, code completion, …)
     * to the Studio backend's OpenAI-compatible LLM proxy.
     *
     * Provider-agnostic on purpose: the IDE image knows nothing about the
     * LLM vendor. The backend decides (STUDIO_LLM_BASE_URL / _MODEL /
     * _API_KEY on the server) and advertises the client side of that choice
     * via GET /studio-llm/v1/client-config; we fetch it here and configure
     * Theia's `ai-openai` accordingly.
     *
     * The `ai-openai` provider runs in Theia's NODE backend and calls
     * `{url}/chat/completions` with `Authorization: Bearer {apiKey}`. We
     * point it at the in-container session gate (`127.0.0.1:3003`), whose
     * `/studio-api` route forwards to the Studio gateway with headers
     * passed through — and we use the portal-issued USER token as the
     * apiKey. The real provider key stays on the Studio backend; revoking
     * the user session revokes in-IDE AI with it.
     *
     * Written at User scope: settings live in the throwaway session
     * container, not in the workspace repo. Re-applied on every silent
     * token renewal the portal posts (`studio.token`).
     */
    protected async configureTheiaAi(token: string): Promise<void> {
        if (token === this.lastAiToken) {
            return;
        }
        this.lastAiToken = token;
        try {
            const res = await StudioApi.fetch('/studio-llm/v1/client-config');
            if (!res.ok) {
                console.warn(`studio: LLM client-config unavailable (HTTP ${res.status}) — Theia AI left unconfigured`);
                this.lastAiToken = ''; // retry on the next token post
                return;
            }
            const cfg = await res.json() as { model?: string; developer_message_settings?: string };
            if (!cfg.model) {
                console.warn('studio: LLM client-config has no model — Theia AI left unconfigured');
                this.lastAiToken = '';
                return;
            }
            const model = {
                id: 'studio-llm',
                model: cfg.model,
                url: 'http://127.0.0.1:3003/studio-api/studio-llm/v1',
                apiKey: token,
                developerMessageSettings: cfg.developer_message_settings ?? 'system',
            };
            const aliases = Object.fromEntries(
                ['universal', 'code', 'code-completion', 'summarize', 'fast']
                    .map(a => [`default/${a}`, { selectedModel: model.id }]),
            );
            await Promise.all([
                this.preferences.set('ai-features.AiEnable.enableAI', true, PreferenceScope.User),
                this.preferences.set('ai-features.openAiCustom.customOpenAiModels', [model], PreferenceScope.User),
                this.preferences.set('ai-features.languageModelAliases', aliases, PreferenceScope.User),
                // Without a default agent an un-mentioned chat message errors
                // with "No agent was found to handle this request". This image
                // ships Codex and Claude Code (no Universal/Coder), so the
                // default must name an agent that actually exists.
                this.preferences.set('ai-features.chat.defaultChatAgent', 'Codex', PreferenceScope.User),
            ]);
        } catch (e) {
            console.warn('studio: Theia AI auto-config failed', e);
            this.lastAiToken = ''; // retry on the next token renewal
        }
    }

    protected applyPortalTheme(portalTheme: string): void {
        const target = portalTheme === 'light' ? 'light' : 'dark';
        if (this.themeService.getCurrentTheme().type !== target) {
            const theme = this.themeService
                .getThemes()
                .find(t => t.type === target);
            if (theme) {
                this.themeService.setCurrentTheme(theme.id, true);
            }
        }
    }

    protected postStatus(): void {
        if (!this.portalOrigin) {
            return; // no handshake yet — nowhere trusted to report to
        }
        const dirty = this.shell.widgets.filter(w => Saveable.isDirty(w)).length;
        if (dirty === this.lastDirty) {
            return;
        }
        this.lastDirty = dirty;
        window.parent.postMessage({ type: 'studio.status', dirty }, this.portalOrigin);
    }
}
