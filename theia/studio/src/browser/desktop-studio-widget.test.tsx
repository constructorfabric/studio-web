// The desktop Studio view, rendered against the fake desktop client: the
// account block, the open project's card, organizations told apart, a project
// with no repositories said so on its row, a failed open said on its row, the
// filter, the remembered collapse -- and no app settings: those are in Settings.

import 'reflect-metadata';
// The real module imports the @theia/core/lib/browser barrel, whose
// common-frontend-contribution calls document.queryCommandSupported at load
// time — absent from this jsdom (the other widget tests do the same).
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
// The portal bridge pulls in the markdown editor, which jest cannot load; the
// view needs only the command id it names.
jest.mock('./portal-bridge-contribution', () => ({
    IDENTITY_VIEWER_COMMAND_ID: 'studio.identity.viewer'
}));
jest.mock('./desktop-studio-client', () => jest.requireActual('./desktop-studio-client.fake'));
import * as fs from 'fs';
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { DesktopStudioWidget } from './desktop-studio-widget';
import { TENANT_TYPES } from './desktop-projects';
import { fakeStudio } from './desktop-studio-client.fake';

const STUDIO = 'https://studio-dev.cfabric.org';
const ROOT = '/home/me/ConstructorStudio/workspaces/Gears workspace - Studio-web';
/** Help → Check for Updates, registered by the desktop app's electron module. */
const CHECK_FOR_UPDATES_COMMAND_ID = 'studio.desktop.checkForUpdates';
const ORG = TENANT_TYPES.organization;
const WS = TENANT_TYPES.workspace;
const PRJ = TENANT_TYPES.project;

const FABRIC_A = { id: '0b6f2c1e-1111-4000-8000-000000000001', name: 'Constructor Fabric', tenant_type: ORG };
const FABRIC_B = { id: '7d41aa90-2222-4000-8000-000000000002', name: 'Constructor Fabric', tenant_type: ORG };
const FABRIC_C = { id: 'c31da936-3333-4000-8000-000000000003', name: 'Constructor Fabric', tenant_type: ORG };
const TYPO = { id: 'e5e5e5e5-4444-4000-8000-000000000004', name: 'Constractor Fabric', tenant_type: ORG };

const DEV = { id: 'dev', label: 'Dev', studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio` };
const TEST = { id: 'test', label: 'Test', studioUrl: 'https://studio-test.cfabric.org', issuer: 'https://studio-test.cfabric.org/auth/realms/studio' };

/** The Studio the view is shown against: four organizations, three of one name, and a project of each kind of sources. */
function studio(): void {
    fakeStudio.reset();
    fakeStudio.status = {
        enabled: true, studioUrl: STUDIO, state: 'signed-in', switchable: true, environments: [DEV, TEST], current: DEV,
        user: { sub: 'u-1', name: 'ANDREI KUCHMA', email: 'andrei@example.com' },
    };
    fakeStudio.opened = { [ROOT]: 'p-web' };
    fakeStudio.projects = [
        {
            ...FABRIC_A, role: 'owner', projects: [{
                id: 'ws-gears', name: 'Gears workspace', tenant_type: WS, nested: [
                    { id: 'p-web', name: 'Studio-web', tenant_type: PRJ },
                    { id: 'p-2', name: 'project 2', tenant_type: PRJ },
                    { id: 'p-odd', name: 'Odd one', tenant_type: PRJ },
                ],
            }],
        },
        { ...FABRIC_B, role: 'member', projects: [{ id: 'ws-docs', name: 'Docs', tenant_type: WS, nested: [] }] },
        { ...FABRIC_C, role: 'member', projects: [] },
        { ...TYPO, role: 'member', projects: [] },
    ];
    fakeStudio.sources = {
        'ws-gears': { state: 'ready', repositories: 1 },
        'p-web': { state: 'ready', repositories: 2 },
        // What studio-git answers for a project with no settings yet.
        'p-2': { state: 'empty' },
        // p-odd: an answer that says nothing about the project, so the click stays.
        'ws-docs': { state: 'empty' },
    };
    fakeStudio.open = async () => { throw new Error('the workspace\'s sources could not be listed (HTTP 502)'); };
}

/** No checkouts: the card's SCM lines are another test's. */
const NO_SCM = { repositories: [], onDidAddRepository: () => ({ dispose: () => undefined }), onDidRemoveRepository: () => ({ dispose: () => undefined }) } as never;

describe('the desktop Studio view', () => {
    let widget: DesktopStudioWidget;
    let stored: Map<string, unknown>;
    let external: string[];
    let executed: string[];
    const act = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

    const settle = async () => {
        for (let i = 0; i < 5; i++) {
            await React.act(async () => {
                await new Promise(resolve => setTimeout(resolve, 0));
                MessageLoop.flush();
            });
        }
    };
    const text = () => widget.node.textContent ?? '';
    const row = (name: string) => Array.from(widget.node.querySelectorAll<HTMLElement>('[role="treeitem"]'))
        .find(el => el.querySelector('.studio-desktop__row-name')?.textContent === name)!;
    const opens = () => fakeStudio.calls.filter(c => c.startsWith('open '));

    beforeAll(() => { act.IS_REACT_ACT_ENVIRONMENT = true; });

    beforeEach(async () => {
        studio();
        stored = new Map([[`studio.desktop.tree.collapsed:${STUDIO}`, [FABRIC_B.id]]]);
        external = [];
        executed = [];
        const module = new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue({
                tryGetRoots: () => [{ resource: { path: { fsPath: () => ROOT } } }],
                open: jest.fn(),
            } as never);
            const commands = {
                executeCommand: jest.fn(async (id: string) => { executed.push(id); }),
                getCommand: (id: string) => (id === CHECK_FOR_UPDATES_COMMAND_ID ? { id } : undefined),
            };
            bind(CommandService).toConstantValue(commands as never);
            bind(CommandRegistry).toConstantValue(commands as never);
            bind(StorageService).toConstantValue({
                getData: async (key: string) => stored.get(key),
                setData: async (key: string, value: unknown) => { stored.set(key, value); },
            } as never);
            bind(WindowService).toConstantValue({ openNewWindow: (url: string) => { external.push(url); } } as never);
            bind(ScmService).toConstantValue(NO_SCM);
            bind(DesktopStudioWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        React.act(() => {
            widget = container.get(DesktopStudioWidget);
            MessageLoop.flush();
        });
        await React.act(async () => {
            await (widget as unknown as { refresh(): Promise<void> }).refresh();
            MessageLoop.flush();
        });
        await settle();
    });

    afterEach(() => {
        if (process.env.DESKTOP_PANEL_HTML) {
            const name = expect.getState().currentTestName?.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
            fs.mkdirSync(process.env.DESKTOP_PANEL_HTML, { recursive: true });
            fs.writeFileSync(`${process.env.DESKTOP_PANEL_HTML}/${name}.html`, widget.node.innerHTML);
        }
        React.act(() => {
            widget.dispose();
            MessageLoop.flush();
        });
    });

    it('says which Studio and who in one block, with Switch Studio and Sign out', () => {
        const account = widget.node.querySelector('.studio-desktop__account')!;
        expect(account.textContent).toContain('Dev');
        expect(account.textContent).toContain('studio-dev.cfabric.org');
        expect(account.textContent).toContain('ANDREI KUCHMA');
        expect(account.textContent).toContain('Switch Studio');
        expect(account.textContent).toContain('Sign out');
    });

    it('switches the Studio through the shared picker, in the view\'s own classes, and forgets the old tree', async () => {
        await React.act(async () => { widget.node.querySelector<HTMLButtonElement>('.studio-desktop__links button')!.click(); });
        await settle();
        const picker = widget.node.querySelector<HTMLSelectElement>('.studio-desktop__picker select')!;
        expect(picker.id).toBe('studio-desktop-picker');
        await React.act(async () => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
            setValue.call(picker, 'test');
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settle();
        expect(fakeStudio.calls).toContain('switch test');
        expect(text()).toContain('Sign in to Constructor Studio');
        expect(text()).not.toContain('Studio-web');
    });

    it('says why a switch was refused, under the picker', async () => {
        fakeStudio.refuse.switch = 'that Studio is not reachable';
        await React.act(async () => { widget.node.querySelector<HTMLButtonElement>('.studio-desktop__links button')!.click(); });
        await settle();
        const picker = widget.node.querySelector<HTMLSelectElement>('.studio-desktop__picker select')!;
        await React.act(async () => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
            setValue.call(picker, 'test');
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settle();
        expect(widget.node.querySelector('.studio-desktop__picker .studio-desktop__error')!.textContent).toBe('that Studio is not reachable');
        expect(text()).toContain('Studio-web');
    });

    it('keeps the list and says why when signing out is refused', async () => {
        fakeStudio.refuse['sign-out'] = 'HTTP 500';
        const signOut = Array.from(widget.node.querySelectorAll<HTMLButtonElement>('.studio-desktop__links button')).find(b => b.textContent === 'Sign out')!;
        await React.act(async () => { signOut.click(); });
        await settle();
        expect(widget.node.querySelector('.studio-desktop__account [role="alert"]')!.textContent).toBe('Could not sign out: HTTP 500');
        expect(row('Studio-web')).toBeDefined();
    });

    it('signs out, and says how to sign in again', async () => {
        const signOut = Array.from(widget.node.querySelectorAll<HTMLButtonElement>('.studio-desktop__links button')).find(b => b.textContent === 'Sign out')!;
        await React.act(async () => { signOut.click(); });
        await settle();
        expect(fakeStudio.calls).toContain('sign-out');
        expect(text()).toContain('Sign in to Constructor Studio');
    });

    it('shows the project open here as a card with its path, repositories and a portal link', async () => {
        const card = widget.node.querySelector('.studio-desktop__card')!;
        expect(card.textContent).toContain('Studio-web');
        expect(card.textContent).toContain('Constructor Fabric');
        expect(card.textContent).toContain('0b6f2c1e · owner');
        expect(card.textContent).toContain('Gears workspace');
        expect(card.textContent).toContain('2 repositories');
        await React.act(async () => {
            card.querySelector<HTMLButtonElement>('button')!.click();
        });
        expect(external).toEqual([`${STUDIO}/?screen=projects;org=${FABRIC_A.id};workspace=ws-gears;project=p-web`]);
    });

    it('tells organizations of one name apart, and leaves a different name alone', () => {
        const hints = Array.from(widget.node.querySelectorAll('.studio-desktop__row--organization'))
            .map(el => [el.querySelector('.studio-desktop__row-name')!.textContent, el.querySelector('.studio-desktop__hint')?.textContent]);
        expect(hints).toEqual([
            ['Constructor Fabric', '0b6f2c1e · owner'],
            ['Constructor Fabric', '7d41aa90 · member'],
            ['Constructor Fabric', 'c31da936 · member'],
            ['Constractor Fabric', undefined],
        ]);
    });

    it('draws codicons for each level and no text icons', () => {
        expect(row('Constructor Fabric').querySelector('.codicon-organization')).not.toBeNull();
        expect(row('Gears workspace').querySelector('.codicon-folder-library')).not.toBeNull();
        expect(row('project 2').querySelector('.codicon-project')).not.toBeNull();
        expect(text()).not.toContain('{ }');
        expect(text()).not.toMatch(/[\u{1F300}-\u{1FAFF}✔✅]/u);
    });

    it('says on the row that a project has no repositories, and does not try to open it', async () => {
        expect(row('project 2').classList).toContain('studio-desktop__row--empty');
        const note = row('project 2').nextElementSibling!;
        expect(note.textContent).toContain('No repositories yet');
        await React.act(async () => { row('project 2').click(); });
        await settle();
        expect(opens()).toHaveLength(0);
        // It asked again, in case a repository was added in the portal meanwhile.
        expect(fakeStudio.calls.filter(c => c === 'sources p-2')).toHaveLength(2);
        await React.act(async () => { note.querySelector<HTMLButtonElement>('button')!.click(); });
        expect(external).toEqual([`${STUDIO}/?screen=projects;org=${FABRIC_A.id};workspace=ws-gears;project=p-2`]);
    });

    it('opens a project added a repository to since, on the next click', async () => {
        fakeStudio.sources['p-2'] = { state: 'ready', repositories: 1 };
        await React.act(async () => { row('project 2').click(); });
        await settle();
        expect(opens()).toEqual(['open p-2 Gears workspace - project 2']);
    });

    it('shows a failed open on the row that failed, not at the bottom', async () => {
        await React.act(async () => { row('Odd one').click(); });
        await settle();
        const note = row('Odd one').nextElementSibling!;
        expect(note.getAttribute('role')).toBe('alert');
        expect(note.textContent).toContain('Could not open Odd one');
        expect(note.textContent).toContain('HTTP 502');
        // Nothing at the bottom of the panel: the one error is the row's.
        expect(widget.node.querySelectorAll('.studio-desktop > .studio-desktop__error')).toHaveLength(0);
        expect(widget.node.querySelectorAll('[role="alert"]')).toHaveLength(1);
    });

    it('shows the clone progress in the card at the top while a project opens', async () => {
        let finish!: (e: Error) => void;
        fakeStudio.open = () => new Promise<string>((_, reject) => { finish = reject; });
        await React.act(async () => { row('Odd one').click(); });
        await React.act(async () => {
            fakeStudio.progress!({
                workspaceId: 'p-odd', name: 'Gears workspace - Odd one', phase: 'cloning',
                sources: [{ name: 'studio-web', state: 'cloning', stage: 'Receiving objects', percent: 42 }, { name: 'docs', state: 'waiting' }],
            } as never);
            MessageLoop.flush();
        });
        await settle();
        const card = widget.node.querySelector('.studio-desktop__card')!;
        expect(card.textContent).toContain('Opening');
        expect(card.textContent).toContain('Odd one');
        expect(card.textContent).toContain('studio-web');
        expect(card.textContent).toContain('42%');
        expect(card.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('42');
        expect(row('Odd one').getAttribute('aria-busy')).toBe('true');
        if (process.env.DESKTOP_PANEL_HTML) {
            fs.mkdirSync(process.env.DESKTOP_PANEL_HTML, { recursive: true });
            fs.writeFileSync(`${process.env.DESKTOP_PANEL_HTML}/opening.html`, widget.node.innerHTML);
        }
        finish(new Error('stopped by the test'));
        await settle();
    });

    it('narrows the tree by name', async () => {
        const input = widget.node.querySelector<HTMLInputElement>('.studio-desktop__filter input')!;
        await React.act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, 'odd');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await settle();
        const names = Array.from(widget.node.querySelectorAll('[role="treeitem"] .studio-desktop__row-name')).map(el => el.textContent);
        expect(names).toEqual(['Constructor Fabric', 'Gears workspace', 'Odd one']);
    });

    it('remembers what was collapsed, per Studio', async () => {
        // FABRIC_B was stored collapsed: its workspace is not drawn.
        expect(row('Docs')).toBeUndefined();
        await React.act(async () => {
            row('Gears workspace').querySelector<HTMLElement>('.studio-desktop__twisty')!.click();
        });
        await settle();
        expect(row('Studio-web')).toBeUndefined();
        expect(stored.get(`studio.desktop.tree.collapsed:${STUDIO}`)).toEqual([FABRIC_B.id, 'ws-gears']);
    });

    it('moves through the tree with the keyboard', async () => {
        const tree = widget.node.querySelector<HTMLElement>('[role="tree"]')!;
        // The focus starts on the project open here.
        expect(row('Studio-web').tabIndex).toBe(0);
        await React.act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
        await settle();
        expect(row('project 2').tabIndex).toBe(0);
        expect(document.activeElement === row('project 2') || !widget.node.isConnected).toBe(true);
        await React.act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
        await settle();
        expect(row('Gears workspace').tabIndex).toBe(0);
        await React.act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
        await settle();
        expect(row('Studio-web')).toBeUndefined();
    });

    it('has no App section: the beta channel is in Settings, Check for Updates in Help', () => {
        // Even with the command registered, as it is on the desktop.
        expect(widget.node.querySelector('.studio-desktop__settings')).toBeNull();
        expect(widget.node.querySelector('input[type="checkbox"]')).toBeNull();
        expect(widget.node.textContent).not.toContain('Check for Updates');
        expect(widget.node.textContent).not.toMatch(/beta versions/i);
        const heads = [...widget.node.querySelectorAll('.studio-desktop__section-head')].map(head => head.textContent);
        expect(heads).not.toContain('App');
        expect(executed).not.toContain(CHECK_FOR_UPDATES_COMMAND_ID);
    });
});

describe('the desktop Studio view, before anything is known', () => {
    it('says so honestly: no organization is a state with its own message', async () => {
        fakeStudio.reset();
        fakeStudio.status = { enabled: true, studioUrl: STUDIO, state: 'signed-in', switchable: false, environments: [], user: { sub: 'u' } };
        const container = new Container();
        container.load(new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue({ tryGetRoots: () => [], open: jest.fn() } as never);
            const commands = { executeCommand: jest.fn(async () => undefined), getCommand: () => undefined };
            bind(CommandService).toConstantValue(commands as never);
            bind(CommandRegistry).toConstantValue(commands as never);
            bind(StorageService).toConstantValue({ getData: async () => undefined, setData: async () => undefined } as never);
            bind(WindowService).toConstantValue({ openNewWindow: jest.fn() } as never);
            bind(ScmService).toConstantValue(NO_SCM);
            bind(DesktopStudioWidget).toSelf();
        }));
        let widget!: DesktopStudioWidget;
        React.act(() => { widget = container.get(DesktopStudioWidget); });
        await React.act(async () => {
            await (widget as unknown as { refresh(): Promise<void> }).refresh();
            MessageLoop.flush();
        });
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); MessageLoop.flush(); });
        expect(widget.node.textContent).toContain('You belong to no organization on this Studio yet');
        expect(widget.node.textContent).toContain('No Studio project is open here');
        // Nor, signed out or in, an App section.
        expect(widget.node.textContent).not.toContain('Check for Updates');
        React.act(() => widget.dispose());
    });
});
