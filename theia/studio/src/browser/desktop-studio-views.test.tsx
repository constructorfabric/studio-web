// The landing page and the Studio view side by side, against the one fake
// desktop client: what one of them does -- sign in, switch the Studio -- the
// other reads at once, through the client's change event, not its own poll.

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
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DesktopLandingWidget } from './desktop-landing-widget';
import { DesktopStudioWidget } from './desktop-studio-widget';
import { TENANT_TYPES } from './desktop-projects';
import { fakeStudio } from './desktop-studio-client.fake';
import { ScmService } from '@theia/scm/lib/browser/scm-service';

const STUDIO = 'https://studio-dev.cfabric.org';
const ENVIRONMENTS = [
    { id: 'dev', label: 'Dev', studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio` },
    { id: 'test', label: 'Test', studioUrl: 'https://studio-test.cfabric.org', issuer: 'https://studio-test.cfabric.org/auth/realms/studio' },
];

describe('the landing page and the Studio view', () => {
    let landing: DesktopLandingWidget;
    let panel: DesktopStudioWidget;
    const act = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

    const settle = async () => {
        for (let i = 0; i < 6; i++) {
            await React.act(async () => {
                await new Promise(resolve => setTimeout(resolve, 0));
                MessageLoop.flush();
            });
        }
    };
    const click = async (el: HTMLElement) => {
        await React.act(async () => { el.click(); });
        await settle();
    };
    const button = (widget: Widget, label: string) => Array.from(widget.node.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => b.textContent?.includes(label))!;
    /** Neither view's own poll: only the event can tell one what the other did. */
    const stopPolls = () => {
        window.clearInterval((landing as unknown as { poll?: number }).poll);
        window.clearInterval((panel as unknown as { poll?: number }).poll);
        (landing as unknown as { poll?: number }).poll = undefined;
        (panel as unknown as { poll?: number }).poll = undefined;
    };
    /** The sign-in finished in the browser: the backend now says so. */
    const signInFinishes = () => {
        fakeStudio.setState('signed-in', { user: { sub: 'u-1', name: 'ANDREI KUCHMA' } });
    };

    beforeAll(() => { act.IS_REACT_ACT_ENVIRONMENT = true; });

    beforeEach(async () => {
        fakeStudio.reset();
        fakeStudio.status = { enabled: true, studioUrl: STUDIO, state: 'signed-out', switchable: true, environments: ENVIRONMENTS, current: ENVIRONMENTS[0] };
        fakeStudio.projects = [{
            id: 'org-1', name: 'Constructor Fabric', tenant_type: TENANT_TYPES.organization, role: 'owner', projects: [{
                id: 'ws-gears', name: 'Gears workspace', tenant_type: TENANT_TYPES.workspace,
                nested: [{ id: 'p-web', name: 'Studio-web', tenant_type: TENANT_TYPES.project }],
            }],
        }];
        const container = new Container();
        container.load(new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue({
                tryGetRoots: () => [], recentWorkspaces: async () => [], open: jest.fn(),
            } as never);
            const commands = { executeCommand: jest.fn(async () => undefined), getCommand: () => undefined, isEnabled: () => true };
            // The open project's checkouts come from SCM; none here.
            bind(ScmService).toConstantValue({ repositories: [], onDidAddRepository: () => ({ dispose() { /* nothing */ } }), onDidRemoveRepository: () => ({ dispose() { /* nothing */ } }) } as never);
            bind(CommandService).toConstantValue(commands as never);
            bind(CommandRegistry).toConstantValue(commands as never);
            bind(StorageService).toConstantValue({ getData: async () => undefined, setData: async () => undefined } as never);
            bind(WindowService).toConstantValue({ openNewWindow: jest.fn() } as never);
            bind(PerspectiveService).toConstantValue({
                onDidChangePerspective: () => ({ dispose: () => undefined }),
                getRegisteredPerspectives: () => [],
                getActivePerspectiveId: () => 'default',
                switchPerspective: async () => undefined,
            } as never);
            bind(DesktopLandingWidget).toSelf();
            bind(DesktopStudioWidget).toSelf();
        }));
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
        expect(landing.node.textContent).toContain('Sign in with Constructor ID');
        expect(panel.node.textContent).toContain('Sign in with Constructor ID');
    });

    afterEach(() => {
        React.act(() => {
            landing.dispose();
            panel.dispose();
            MessageLoop.flush();
        });
    });

    it('a sign-in finished on the landing page refreshes the Studio view', async () => {
        await click(button(landing, 'Sign in with Constructor ID'));
        stopPolls();
        signInFinishes();
        // The landing's poll would have read this; read it as that poll does.
        await React.act(async () => { await landing.refresh(); });
        await settle();
        expect(landing.node.textContent).toContain('Choose a project');
        expect(panel.node.textContent).toContain('ANDREI KUCHMA');
        expect(panel.node.querySelector('[role="treeitem"][data-row-id="p-web"]')).not.toBeNull();
    });

    it('a sign-in finished in the Studio view refreshes the landing page', async () => {
        await click(button(panel, 'Sign in with Constructor ID'));
        expect(panel.node.textContent).toContain('Finish signing in in your browser.');
        stopPolls();
        signInFinishes();
        // The view's own poll, the one it starts for a sign-in it started.
        await React.act(async () => { await (panel as unknown as { refresh(): Promise<void> }).refresh(); });
        await settle();
        expect(panel.node.querySelector('[role="treeitem"][data-row-id="p-web"]')).not.toBeNull();
        expect(landing.node.textContent).toContain('Choose a project');
        expect(landing.node.querySelector('[data-row-id="p-web"]')).not.toBeNull();
    });

    it('a Studio switched on the landing page is the Studio view\'s too', async () => {
        const picker = landing.node.querySelector<HTMLSelectElement>('select')!;
        stopPolls();
        await React.act(async () => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
            setValue.call(picker, 'test');
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settle();
        expect(fakeStudio.calls).toEqual(['switch test']);
        expect(panel.node.querySelector<HTMLSelectElement>('.studio-desktop__picker select')!.value).toBe('test');
    });

    it('neither view reads its own news again', async () => {
        await click(button(landing, 'Sign in with Constructor ID'));
        stopPolls();
        signInFinishes();
        await React.act(async () => { await landing.refresh(); });
        await settle();
        // One listing each: the landing's, and the Studio view's on the news -- no echo back.
        expect(fakeStudio.calls.filter(c => c === 'projects')).toHaveLength(2);
    });
});
