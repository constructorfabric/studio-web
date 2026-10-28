// The desktop landing page, rendered against the fake desktop client: signed
// out, signing in, a Studio out of reach, signed in with projects, with no
// organization, with projects that could not load; the onboarding cards and
// their "Got it"; and "Work offline".

import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
// The portal bridge pulls in the markdown editor, which jest cannot load.
jest.mock('./portal-bridge-contribution', () => ({
    IDENTITY_VIEWER_COMMAND_ID: 'studio.identity.viewer'
}));
jest.mock('./desktop-studio-client', () => jest.requireActual('./desktop-studio-client.fake'));
import * as fs from 'fs';
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DesktopLandingWidget, OPEN_FOLDER_COMMAND_ID } from './desktop-landing-widget';
import { ONBOARDING_STORAGE_KEY } from './desktop-landing-state';
import { TENANT_TYPES } from './desktop-projects';
import { fakeStudio } from './desktop-studio-client.fake';

const STUDIO = 'https://studio-dev.cfabric.org';
const START = '/home/me/ConstructorStudio/workspace';
const ENVIRONMENTS = [
    { id: 'dev', label: 'Dev', studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio` },
    { id: 'test', label: 'Test', studioUrl: 'https://studio-test.cfabric.org', issuer: 'https://studio-test.cfabric.org/auth/realms/studio' },
    { id: 'local', label: 'Local', studioUrl: 'http://127.0.0.1:8090', issuer: 'http://127.0.0.1:8088/realms/studio' },
];

const ORG = { id: '0b6f2c1e-1111-4000-8000-000000000001', name: 'Constructor Fabric', tenant_type: TENANT_TYPES.organization };

/** A desktop backend in `state`; `undefined` status is a build with no Studio. */
function backend(state: string | undefined, extra: object = {}): void {
    fakeStudio.reset();
    fakeStudio.status = state === undefined ? undefined : {
        enabled: true, studioUrl: STUDIO, state: state as 'signed-in', switchable: true, updates: 'stable', startFolder: START,
        environments: ENVIRONMENTS, current: ENVIRONMENTS[0],
        ...(state === 'signed-in' ? { user: { sub: 'u-1', name: 'ANDREI KUCHMA', email: 'andrei@example.com' } } : {}),
        ...extra,
    };
}

/** Signed in, with one organization, one workspace and two projects, one of them with no repositories. */
function signedIn(): void {
    backend('signed-in');
    fakeStudio.projects = [{
        ...ORG, role: 'owner', projects: [{
            id: 'ws-gears', name: 'Gears workspace', tenant_type: TENANT_TYPES.workspace, nested: [
                { id: 'p-web', name: 'Studio-web', tenant_type: TENANT_TYPES.project },
                { id: 'p-2', name: 'project 2', tenant_type: TENANT_TYPES.project },
            ],
        }],
    }];
    fakeStudio.sources = {
        'ws-gears': { state: 'ready', repositories: 1 },
        'p-web': { state: 'ready', repositories: 2 },
        'p-2': { state: 'empty' },
    };
    fakeStudio.open = async () => '/home/me/ConstructorStudio/workspaces/Gears workspace - Studio-web';
}

describe('the desktop landing page', () => {
    let widget: DesktopLandingWidget;
    let stored: Map<string, unknown>;
    let executed: string[];
    let opened: string[];
    let switched: string[];
    let external: string[];
    const act = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

    const settle = async () => {
        for (let i = 0; i < 6; i++) {
            await React.act(async () => {
                await new Promise(resolve => setTimeout(resolve, 0));
                MessageLoop.flush();
            });
        }
    };
    const text = () => widget.node.textContent ?? '';
    const button = (label: string) => Array.from(widget.node.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => b.textContent?.trim() === label || b.textContent?.includes(label))!;
    const click = async (el: HTMLElement) => {
        await React.act(async () => { el.click(); });
        await settle();
    };

    async function mount(given: () => void): Promise<void> {
        given();
        const module = new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue({
                tryGetRoots: () => [{ resource: { path: { fsPath: () => START }, isEqual: () => false } }],
                recentWorkspaces: async () => [
                    'file:///home/me/ConstructorStudio/workspace',
                    'file:///home/me/code/my-app',
                    'file:///home/me/notes',
                ],
                // A project or a recent folder opens in place (desktop-open-project.ts):
                // `save` to its workspace file, then `spliceRoots`. `open` is what
                // reloads the window, and must not be what opens a folder.
                workspace: { resource: { isEqual: () => false }, isDirectory: true },
                save: jest.fn(async () => undefined),
                spliceRoots: jest.fn(async (_start: number, _del: number, ...uris: unknown[]) => {
                    opened.push(...uris.map(String));
                    return [];
                }),
                open: jest.fn(async () => { throw new Error('open reloads the window'); }),
            } as never);
            bind(CommandRegistry).toConstantValue({
                executeCommand: jest.fn(async (id: string) => { executed.push(id); }),
                getCommand: (id: string) => (id === OPEN_FOLDER_COMMAND_ID ? { id } : undefined),
                isEnabled: () => true,
            } as never);
            bind(StorageService).toConstantValue({
                getData: async (key: string) => stored.get(key),
                setData: async (key: string, value: unknown) => { stored.set(key, value); },
            } as never);
            bind(WindowService).toConstantValue({ openNewWindow: (url: string) => { external.push(url); } } as never);
            bind(PerspectiveService).toConstantValue({
                onDidChangePerspective: () => ({ dispose: () => undefined }),
                getRegisteredPerspectives: () => [],
                getActivePerspectiveId: () => 'default',
                switchPerspective: async (id: string) => { switched.push(id); },
            } as never);
            bind(DesktopLandingWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        widget = container.get(DesktopLandingWidget);
        widget.node.style.width = '900px';
        await React.act(async () => {
            Widget.attach(widget, document.body);
            MessageLoop.flush();
        });
        await settle();
    }

    beforeAll(() => { act.IS_REACT_ACT_ENVIRONMENT = true; });

    beforeEach(() => {
        stored = new Map();
        executed = [];
        opened = [];
        switched = [];
        external = [];
    });

    afterEach(() => {
        if (process.env.DESKTOP_LANDING_HTML) {
            const name = expect.getState().currentTestName?.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
            fs.mkdirSync(process.env.DESKTOP_LANDING_HTML, { recursive: true });
            fs.writeFileSync(`${process.env.DESKTOP_LANDING_HTML}/${name}.html`, widget.node.innerHTML);
        }
        React.act(() => {
            widget.dispose();
            MessageLoop.flush();
        });
    });

    it('signed out: says where you are, what connecting gives, and offers the sign-in and the Studio picker', async () => {
        await mount(() => backend('signed-out'));
        expect(text()).toContain('You are in Constructor Studio Desktop.');
        expect(text()).toContain('Connect to your organization and choose a project, or keep working offline.');
        expect(text()).toContain('organization\'s projects, clone their sources through Studio');
        const picker = widget.node.querySelector<HTMLSelectElement>('select')!;
        expect(Array.from(picker.options).map(o => o.textContent)).toEqual([
            'Dev — studio-dev.cfabric.org', 'Test — studio-test.cfabric.org', 'Local — 127.0.0.1:8090', 'Other…',
        ]);
        expect(widget.node.querySelector('[data-view]')!.getAttribute('data-view')).toBe('connect');

        await click(button('Sign in with Constructor ID'));
        expect(fakeStudio.calls).toContain('sign-in');
        expect(text()).toContain('Finish signing in in your browser.');
    });

    it('signed out: switching the Studio goes through the backend', async () => {
        await mount(() => backend('signed-out'));
        const picker = widget.node.querySelector<HTMLSelectElement>('select')!;
        await React.act(async () => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
            setValue.call(picker, 'test');
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settle();
        expect(fakeStudio.calls).toContain('switch test');
        // Read again: the page is on the Studio switched to.
        expect(text()).toContain('studio-test.cfabric.org');
    });

    it('a Studio out of reach: says so, and makes Open folder the primary way on', async () => {
        await mount(() => backend('failed', { error: 'fetch failed' }));
        expect(text()).toContain('studio-dev.cfabric.org could not be reached (fetch failed)');
        expect(text()).toContain('or work offline below');
        expect(button('Open folder…').className).toContain('studio-landing__btn--primary');
    });

    it('no Studio at all: offline is all there is, said plainly', async () => {
        await mount(() => backend(undefined));
        expect(text()).toContain('This app is not set up for a Constructor Studio');
        expect(text()).not.toContain('Sign in with Constructor ID');
        expect(text()).toContain('Open folder…');
    });

    it('signed in: chooses a project from the member\'s organizations, with the no-repositories state on its row', async () => {
        await mount(signedIn);
        expect(text()).toContain('Choose a project');
        expect(text()).toContain('ANDREI KUCHMA');
        const names = Array.from(widget.node.querySelectorAll('.studio-landing__row[data-row-id] .studio-landing__row-name')).map(e => e.textContent);
        expect(names).toEqual(['Gears workspace', 'Studio-web', 'project 2']);
        const web = widget.node.querySelector('[data-row-id="p-web"]')!;
        expect(web.textContent).toContain('2 repositories');
        const empty = widget.node.querySelector('[data-row-id="p-2"]')!;
        expect(empty.textContent).toContain('no repositories');
        expect(text()).toContain('No repositories yet, so there is nothing to clone.');
        await click(button('Add one in the portal'));
        expect(external).toEqual([`${STUDIO}/?screen=projects;org=0b6f2c1e-1111-4000-8000-000000000001;workspace=ws-gears;project=p-2`]);
    });

    it('signed in: the filter narrows the list, and says when nothing matches', async () => {
        await mount(signedIn);
        const filter = widget.node.querySelector<HTMLInputElement>('.studio-landing__filter input')!;
        const type = async (value: string) => {
            await React.act(async () => {
                const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
                setValue.call(filter, value);
                filter.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await settle();
        };
        await type('web');
        expect(Array.from(widget.node.querySelectorAll('[data-row-id] .studio-landing__row-name')).map(e => e.textContent))
            .toEqual(['Gears workspace', 'Studio-web']);
        await type('zzz');
        expect(text()).toContain('Nothing is called “zzz”.');
    });

    it('signed in: opening a project clones it with progress, then opens its folder here', async () => {
        let release: () => void = () => undefined;
        await mount(() => {
            signedIn();
            const done = fakeStudio.open;
            fakeStudio.open = (id, folder) => new Promise<string>(resolve => { release = () => resolve(done(id, folder)); });
        });
        await React.act(async () => { (widget.node.querySelector('[data-row-id="p-web"]') as HTMLElement).click(); });
        await React.act(async () => {
            fakeStudio.progress!({
                workspaceId: 'p-web', name: 'Studio-web', phase: 'cloning',
                sources: [{ name: 'studio-web', state: 'cloning', percent: 40 }, { name: 'gears-rust', state: 'waiting' }],
            } as never);
        });
        await settle();
        expect(text()).toContain('Opening Studio-web');
        expect(text()).toContain('studio-web40%');
        expect(fakeStudio.calls).toContain('open p-web Gears workspace - Studio-web');
        await React.act(async () => { release(); });
        await settle();
        expect(opened).toHaveLength(1);
        expect(decodeURIComponent(opened[0])).toContain('Gears workspace - Studio-web');
    });

    it('signed in with no organization yet: says what to do in the portal', async () => {
        await mount(() => backend('signed-in'));
        expect(text()).toContain('You belong to no organization on studio-dev.cfabric.org yet.');
        await click(button('Open the portal'));
        expect(external).toEqual([STUDIO]);
    });

    it('signed in with no organization, where the Studio lets them create one: points to the portal for it', async () => {
        await mount(() => {
            backend('signed-in');
            fakeStudio.onboarding = { creation: 'open' };
        });
        expect(text()).toContain('Create your own or accept an invitation in the portal');
    });

    it('signed in with no organization, where they may ask for one: points to the portal, never offers to create', async () => {
        await mount(() => {
            backend('signed-in');
            fakeStudio.onboarding = { creation: 'request' };
        });
        expect(text()).toContain('Ask for one in the portal');
        expect(text()).not.toContain('Create your own');
        expect(button('Open the portal')).toBeTruthy();
    });

    it('signed in with no organization and a request waiting: names it, and nothing else', async () => {
        await mount(() => {
            backend('signed-in');
            fakeStudio.onboarding = { creation: 'request', request: { name: 'Acme', status: 'pending', created_at_ms: 1_767_225_600_000 } };
        });
        expect(text()).toContain('You asked for Acme');
        expect(text()).toContain('reload once it is approved');
    });

    it('signed in with no organization and a request turned down: says why, and that they can ask again', async () => {
        await mount(() => {
            backend('signed-in');
            fakeStudio.onboarding = {
                creation: 'request', request: { name: 'Acme', status: 'rejected', reason: 'Use your work email.', created_at_ms: 1 },
            };
        });
        expect(text()).toContain('Your request for Acme was not approved. Use your work email.');
        expect(text()).toContain('You can ask again');
    });

    it('signed in with organizations: never asks how to get one', async () => {
        await mount(signedIn);
        expect(fakeStudio.calls).not.toContain('onboarding');
    });

    it('signed in, projects out of reach: says so and offers to try again', async () => {
        await mount(() => {
            backend('signed-in');
            fakeStudio.projects = new Error('HTTP 502');
        });
        expect(text()).toContain('studio-dev.cfabric.org could not be reached (HTTP 502)');
        expect(button('Try again')).toBeTruthy();
    });

    it('onboarding: a card per mode, between connecting and working offline, and each switches to its mode', async () => {
        await mount(() => backend('signed-out'));
        const sections = Array.from(widget.node.querySelectorAll('section')).map(s => s.getAttribute('aria-label'));
        expect(sections).toEqual(['Connect', 'Modes', 'Work offline']);
        const cards = Array.from(widget.node.querySelectorAll('.studio-landing__card'));
        expect(cards.map(c => c.querySelector('b')!.textContent)).toEqual(['Doc editing', 'Building', 'Development', 'Agent development', 'Full functionality']);
        expect(cards[0].textContent).toContain('Write the specs and check them');
        expect(cards[2].getAttribute('aria-pressed')).toBe('true');
        await click(cards[0] as HTMLElement);
        expect(switched).toEqual(['studio.documents']);
    });

    it('onboarding: "Got it" puts it away on this machine, and Help → Welcome brings it back', async () => {
        await mount(signedIn);
        expect(widget.node.querySelector('.studio-landing__onboarding')).not.toBeNull();
        await click(button('Got it'));
        expect(widget.node.querySelector('.studio-landing__onboarding')).toBeNull();
        expect(stored.get(ONBOARDING_STORAGE_KEY)).toBe(true);
        await React.act(async () => { widget.showOnboarding(); });
        await settle();
        expect(widget.node.querySelector('.studio-landing__onboarding')).not.toBeNull();
        expect(stored.get(ONBOARDING_STORAGE_KEY)).toBe(false);
    });

    it('onboarding: stays away once dismissed', async () => {
        stored.set(ONBOARDING_STORAGE_KEY, true);
        await mount(() => backend('signed-out'));
        expect(widget.node.querySelector('.studio-landing__onboarding')).toBeNull();
    });

    it('work offline: Open folder runs Theia\'s own command, and recent folders open here', async () => {
        await mount(() => backend('signed-out'));
        await click(button('Open folder…'));
        expect(executed).toContain(OPEN_FOLDER_COMMAND_ID);
        const recent = Array.from(widget.node.querySelectorAll('.studio-landing__row--recent .studio-landing__row-name')).map(e => e.textContent);
        // The placeholder is where the member already is: not listed.
        expect(recent).toEqual(['my-app', 'notes']);
        await click(widget.node.querySelector('.studio-landing__row--recent') as HTMLElement);
        expect(opened).toEqual(['file:///home/me/code/my-app']);
    });
});
