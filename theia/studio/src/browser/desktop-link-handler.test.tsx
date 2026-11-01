// The portal's "Open in desktop" link, against the one fake desktop client the
// views are tested with: what the link does goes through the client, its
// failures reach the member with the client's reason, and what it changed is
// news to the landing page and the Studio view at once, through the client's
// real change event.

import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
jest.mock('./portal-bridge-contribution', () => ({
    IDENTITY_VIEWER_COMMAND_ID: 'studio.identity.viewer'
}));
jest.mock('./desktop-studio-client', () => jest.requireActual('./desktop-studio-client.fake'));
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { desktopLink } from '../common/desktop-link';
import type * as Client from './desktop-studio-client';
import { DesktopLinkHandler } from './desktop-link-handler';
import { DesktopLandingWidget } from './desktop-landing-widget';
import { DesktopStudioWidget } from './desktop-studio-widget';
import { TENANT_TYPES } from './desktop-projects';
import { fakeStudio, onDesktopChange, type DesktopChange } from './desktop-studio-client.fake';
import { ScmService } from '@theia/scm/lib/browser/scm-service';

const actual = jest.requireActual<typeof Client>('./desktop-studio-client');

const STUDIO = 'https://studio-dev.cfabric.org';
const ENVIRONMENTS = [
    { id: 'dev', label: 'Dev', studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio` },
    { id: 'test', label: 'Test', studioUrl: 'https://studio-test.cfabric.org', issuer: 'https://studio-test.cfabric.org/auth/realms/studio' },
];
const PROJECT = 'p-web-0001';
const FOLDER = '/home/member/ConstructorStudio/workspaces/Studio-web';

describe('the desktop link handler', () => {
    let handler: DesktopLinkHandler;
    let landing: DesktopLandingWidget;
    let panel: DesktopStudioWidget;
    let roots: { resource: URI }[];
    let changes: DesktopChange[];
    let disposeListener: () => void;
    const commands = { executeCommand: jest.fn(async (..._args: unknown[]) => undefined as unknown), getCommand: () => undefined, isEnabled: () => true };
    const messages = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        showProgress: jest.fn(async () => ({ id: 'p', report: jest.fn(), cancel: jest.fn(), result: Promise.resolve('') })),
    };
    const act = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const realFetch = globalThis.fetch;

    const settle = async () => {
        for (let i = 0; i < 6; i++) {
            await React.act(async () => {
                await new Promise(resolve => setTimeout(resolve, 0));
                MessageLoop.flush();
            });
        }
    };
    /** Neither view's own poll: only the event can tell them what the link did. */
    const stopPolls = () => {
        for (const view of [landing, panel] as unknown as { poll?: number }[]) {
            window.clearInterval(view.poll);
            view.poll = undefined;
        }
    };
    const linkTo = (studio: string) =>
        new URI(desktopLink({ studioUrl: studio, issuer: `${studio}/auth/realms/studio`, project: PROJECT, name: 'Studio-web' }));
    const follow = async (studio: string = STUDIO) => {
        const uri = linkTo(studio);
        expect(handler.canHandle(uri)).toBeGreaterThan(0);
        await React.act(async () => { await handler.open(uri); });
        await settle();
    };
    /** What the link asked of the backend; the views' own listings left out. */
    const linkCalls = () => fakeStudio.calls.filter(c => c !== 'projects' && !c.startsWith('sources '));

    beforeAll(() => { act.IS_REACT_ACT_ENVIRONMENT = true; });

    beforeEach(async () => {
        fakeStudio.reset();
        messages.error.mockClear();
        messages.info.mockClear();
        messages.warn.mockClear();
        commands.executeCommand.mockReset();
        commands.executeCommand.mockImplementation(async () => undefined);
        messages.showProgress.mockClear();
        fakeStudio.status = {
            enabled: true, studioUrl: STUDIO, state: 'signed-in', user: { sub: 'u-1', name: 'ANDREI KUCHMA' },
            switchable: true, environments: ENVIRONMENTS, current: ENVIRONMENTS[0],
        };
        fakeStudio.projects = [{
            id: 'org-1', name: 'Constructor Fabric', tenant_type: TENANT_TYPES.organization, role: 'owner', projects: [{
                id: 'ws-gears', name: 'Gears workspace', tenant_type: TENANT_TYPES.workspace,
                nested: [{ id: PROJECT, name: 'Studio-web', tenant_type: TENANT_TYPES.project }],
            }],
        }];
        roots = [];
        const workspaces = {
            tryGetRoots: () => roots,
            recentWorkspaces: async () => [],
            workspace: undefined,
            save: jest.fn(async () => undefined),
            // In place (desktop-open-project.ts); `open` would reload the window.
            spliceRoots: jest.fn(async (_start: number, _del: number, uri: URI) => { roots = [{ resource: uri }]; return []; }),
            open: jest.fn(async () => { throw new Error('open reloads the window'); }),
        };
        const container = new Container();
        container.load(new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue(workspaces as never);
            // The open project's checkouts come from SCM; none here.
            bind(ScmService).toConstantValue({ repositories: [], onDidAddRepository: () => ({ dispose() { /* nothing */ } }), onDidRemoveRepository: () => ({ dispose() { /* nothing */ } }) } as never);
            bind(CommandService).toConstantValue(commands as never);
            bind(CommandRegistry).toConstantValue(commands as never);
            bind(MessageService).toConstantValue(messages as never);
            bind(StorageService).toConstantValue({ getData: async () => undefined, setData: async () => undefined } as never);
            bind(WindowService).toConstantValue({ openNewWindow: jest.fn(), focus: jest.fn() } as never);
            bind(OpenerService).toConstantValue({ getOpener: async () => { throw new Error('no opener'); }, getOpeners: async () => [] } as never);
            bind(PerspectiveService).toConstantValue({
                onDidChangePerspective: () => ({ dispose: () => undefined }),
                getRegisteredPerspectives: () => [],
                getActivePerspectiveId: () => 'default',
                switchPerspective: async () => undefined,
            } as never);
            bind(DesktopLinkHandler).toSelf();
            bind(DesktopLandingWidget).toSelf();
            bind(DesktopStudioWidget).toSelf();
        }));
        handler = container.get(DesktopLinkHandler);
        landing = container.get(DesktopLandingWidget);
        panel = container.get(DesktopStudioWidget);
        // Perfect Scrollbar cannot start in jsdom; the landing page has none of its own.
        (panel as unknown as { scrollOptions?: object }).scrollOptions = undefined;
        await React.act(async () => {
            Widget.attach(landing, document.body);
            Widget.attach(panel, document.body);
            MessageLoop.flush();
        });
        await settle();
        stopPolls();
        changes = [];
        disposeListener = onDesktopChange(change => { changes.push(change); }).dispose;
    });

    afterEach(() => {
        disposeListener();
        globalThis.fetch = realFetch;
        React.act(() => {
            landing.dispose();
            panel.dispose();
            MessageLoop.flush();
        });
    });

    it('opens the project through the client and tells both views', async () => {
        const toLanding = jest.spyOn(landing as unknown as { onOtherViewChanged(c: DesktopChange): void }, 'onOtherViewChanged');
        const toPanel = jest.spyOn(panel as unknown as { onOtherViewChanged(c: DesktopChange): Promise<void> }, 'onOtherViewChanged');
        fakeStudio.open = async () => FOLDER;
        fakeStudio.opened[FOLDER] = PROJECT;
        expect(panel.node.textContent).toContain('No Studio project is open here');

        await follow();

        expect(messages.error).not.toHaveBeenCalled();
        expect(linkCalls()).toContain(`open ${PROJECT} Studio-web`);
        expect(changes.map(c => [c.kind, c.origin])).toEqual([['opened', handler]]);
        expect(toLanding).toHaveBeenCalledWith(expect.objectContaining({ kind: 'opened', origin: handler }));
        expect(toPanel).toHaveBeenCalledWith(expect.objectContaining({ kind: 'opened', origin: handler }));
        // The Studio view read the news, without its poll: the project is open here now.
        expect(panel.node.textContent).not.toContain('No Studio project is open here');
        expect(panel.node.textContent).toContain('Open in this window');
    });

    it('opens the product the portal composed, in Gearbox, once the project is open', async () => {
        fakeStudio.open = async () => FOLDER;
        const uri = new URI(desktopLink({
            studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio`, project: PROJECT, name: 'Studio-web',
            product: 'product.gdl', branch: 'product/studio-web-1a2b3c4d',
        }));

        await React.act(async () => { await handler.open(uri); });
        await settle();

        expect(messages.error).not.toHaveBeenCalled();
        expect(roots.map(r => r.resource.path.toString())).toEqual([FOLDER]);
        expect(commands.executeCommand).toHaveBeenCalledWith('gearbox.product.openAt', 'product.gdl', 'product/studio-web-1a2b3c4d');
    });

    it('generates and builds the product when the link asks, once Gearbox has it open', async () => {
        fakeStudio.open = async () => FOLDER;
        commands.executeCommand.mockImplementation(async (id: unknown) => id === 'gearbox.product.openAt' ? true : undefined);
        const uri = new URI(desktopLink({ studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio`, project: PROJECT, product: 'product.gdl', build: true }));

        await React.act(async () => { await handler.open(uri); });
        await settle();

        expect(messages.error).not.toHaveBeenCalled();
        expect(commands.executeCommand.mock.calls.map(call => call[0]).filter(id => String(id).startsWith('gearbox.'))).toEqual(['gearbox.product.openAt', 'gearbox.product.generateAndBuild']);
    });

    it('does not build a product Gearbox could not open, and says so', async () => {
        fakeStudio.open = async () => FOLDER;
        commands.executeCommand.mockImplementation(async () => false);
        const uri = new URI(desktopLink({ studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio`, project: PROJECT, product: 'product.gdl', build: true }));

        await React.act(async () => { await handler.open(uri); });
        await settle();

        expect(commands.executeCommand).not.toHaveBeenCalledWith('gearbox.product.generateAndBuild');
        expect(messages.warn).toHaveBeenCalledWith(expect.stringContaining('not built'));
    });

    it('says where the product is when nothing can open it', async () => {
        fakeStudio.open = async () => FOLDER;
        commands.executeCommand.mockImplementation(async () => { throw new Error('no Gearbox'); });
        const uri = new URI(desktopLink({ studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio`, project: PROJECT, product: 'product.gdl' }));

        await React.act(async () => { await handler.open(uri); });
        await settle();

        expect(messages.error).not.toHaveBeenCalled();
        expect(messages.info).toHaveBeenCalledWith(expect.stringContaining('product.gdl'));
    });

    it('draws the open\'s progress in its notification', async () => {
        let finish!: (path: string) => void;
        fakeStudio.open = () => new Promise(resolve => { finish = resolve; });
        const opening = handler.open(linkTo(STUDIO));
        for (let i = 0; i < 20 && !fakeStudio.progress; i++) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        fakeStudio.progress!({ workspaceId: PROJECT, name: 'Studio-web', phase: 'cloning', sources: [{ name: 'studio-web', state: 'cloning', stage: 'Receiving objects' }] });
        finish(FOLDER);
        await opening;
        await settle();
        const progress = await messages.showProgress.mock.results[0].value;
        expect(progress.report).toHaveBeenCalledWith({ message: 'Cloning studio-web · Receiving objects' });
        expect(progress.cancel).toHaveBeenCalled();
    });

    it('reports a non-JSON error from the open as its HTTP status', async () => {
        // The real client's open, against a backend that answers with a proxy's HTML page.
        globalThis.fetch = jest.fn(async (url: string) => (String(url).endsWith('open-progress')
            ? { ok: true, status: 200, json: async () => null }
            : { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } })) as never;
        fakeStudio.open = (id, folder) => actual.openStudioProject(id, folder, () => undefined, 10);

        await follow();

        expect(messages.error).toHaveBeenCalledWith('Studio: Studio-web could not be opened — HTTP 502');
        expect(changes).toEqual([]);
    });

    it('reports a refused sign-in with the backend\'s reason', async () => {
        fakeStudio.setState('signed-out', { user: undefined });
        fakeStudio.refuse['sign-in'] = 'the browser could not be started';

        await follow();

        expect(linkCalls()).toEqual(['sign-in']);
        expect(messages.error).toHaveBeenCalledWith(
            'Studio: Studio-web could not be opened — sign-in could not start: the browser could not be started');
        expect(changes).toEqual([]);
    });

    it('switches the Studio, signs in and opens, announcing each', async () => {
        fakeStudio.onSignIn = () => fakeStudio.setState('signed-in', { user: { sub: 'u-1', name: 'ANDREI KUCHMA' } });
        fakeStudio.open = async () => FOLDER;

        await follow('https://studio-test.cfabric.org');

        expect(messages.error).not.toHaveBeenCalled();
        expect(linkCalls()).toEqual(['switch test', 'sign-in', `open ${PROJECT} Studio-web`]);
        expect(changes.map(c => c.kind)).toEqual(['switched', 'signed-in', 'opened']);
        expect(changes.every(c => c.origin === handler)).toBe(true);
    });

    it('reports a refused switch with the backend\'s reason', async () => {
        fakeStudio.refuse.switch = 'a clone is still running';

        await follow('https://studio-test.cfabric.org');

        expect(messages.error).toHaveBeenCalledWith('Studio: Studio-web could not be opened — a clone is still running');
        expect(linkCalls()).toEqual(['switch test']);
    });
});
