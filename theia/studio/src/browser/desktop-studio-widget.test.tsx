// The desktop Studio view, rendered against a fake Studio: the account block,
// the open project's card, organizations told apart, a project with no
// repositories said so on its row, a failed open said on its row, the filter,
// the remembered collapse -- and no app settings: those are in Settings.

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
import * as fs from 'fs';
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DesktopStudioWidget } from './desktop-studio-widget';
import { TENANT_TYPES } from './desktop-projects';

const STUDIO = 'https://studio-dev.cfabric.org';
/** Help → Check for Updates, registered by the desktop app's electron module. */
const CHECK_FOR_UPDATES_COMMAND_ID = 'studio.desktop.checkForUpdates';
const ORG = TENANT_TYPES.organization;
const WS = TENANT_TYPES.workspace;
const PRJ = TENANT_TYPES.project;

const FABRIC_A = { id: '0b6f2c1e-1111-4000-8000-000000000001', name: 'Constructor Fabric', tenant_type: ORG };
const FABRIC_B = { id: '7d41aa90-2222-4000-8000-000000000002', name: 'Constructor Fabric', tenant_type: ORG };
const FABRIC_C = { id: 'c31da936-3333-4000-8000-000000000003', name: 'Constructor Fabric', tenant_type: ORG };
const TYPO = { id: 'e5e5e5e5-4444-4000-8000-000000000004', name: 'Constractor Fabric', tenant_type: ORG };

interface Answer { status: number; body: unknown }
type Routes = Record<string, Answer | (() => Answer | Promise<Answer>)>;

function studioRoutes(): Routes {
    const children = (id: string) => `/studio-api/account-management/v1/tenants/${id}/children`;
    const tenant = (id: string) => `/studio-api/account-management/v1/tenants/${id}`;
    const ok = (body: unknown): Answer => ({ status: 200, body });
    return {
        '/studio-desktop/status': ok({
            enabled: true, studioUrl: STUDIO, state: 'signed-in', switchable: true,
            environments: [{ id: 'dev', label: 'Dev', studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio` }],
            current: { id: 'dev', label: 'Dev', studioUrl: STUDIO, issuer: `${STUDIO}/auth/realms/studio` },
            user: { sub: 'u-1', name: 'ANDREI KUCHMA', email: 'andrei@example.com' },
        }),
        '/studio-desktop/opened': ok({ tenantId: 'p-web' }),
        '/studio-api/account-management/v1/me': ok({ subject_tenant_id: 'home' }),
        '/studio-api/studio-user/v1/me/memberships': ok({
            items: [
                { org_id: FABRIC_A.id, role: 'owner' }, { org_id: FABRIC_B.id, role: 'member' },
                { org_id: FABRIC_C.id, role: 'member' }, { org_id: TYPO.id, role: 'member' },
            ],
        }),
        [tenant(FABRIC_A.id)]: ok(FABRIC_A),
        [tenant(FABRIC_B.id)]: ok(FABRIC_B),
        [tenant(FABRIC_C.id)]: ok(FABRIC_C),
        [tenant(TYPO.id)]: ok(TYPO),
        [children(FABRIC_A.id)]: ok({ items: [{ id: 'ws-gears', name: 'Gears workspace', tenant_type: WS }] }),
        [children('ws-gears')]: ok({
            items: [
                { id: 'p-web', name: 'Studio-web', tenant_type: PRJ },
                { id: 'p-2', name: 'project 2', tenant_type: PRJ },
                { id: 'p-odd', name: 'Odd one', tenant_type: PRJ },
            ],
        }),
        [children(FABRIC_B.id)]: ok({ items: [{ id: 'ws-docs', name: 'Docs', tenant_type: WS }] }),
        [children('ws-docs')]: ok({ items: [] }),
        [children(FABRIC_C.id)]: ok({ items: [] }),
        [children(TYPO.id)]: ok({ items: [] }),
        '/studio-api/studio-git/v1/sources?project_id=ws-gears': ok({ items: [{ name: 'a' }], total: 1 }),
        '/studio-api/studio-git/v1/sources?project_id=p-web': ok({ items: [{ name: 'studio-web' }, { name: 'gears-rust' }], total: 2 }),
        // What studio-git answers for a project with no settings yet.
        '/studio-api/studio-git/v1/sources?project_id=p-2': { status: 404, body: { status: 404, context: { resource_name: 'p-2' } } },
        // An answer that says nothing about the project: the click stays.
        '/studio-api/studio-git/v1/sources?project_id=p-odd': { status: 502, body: {} },
        '/studio-api/studio-git/v1/sources?project_id=ws-docs': ok({ items: [], total: 0 }),
        '/studio-desktop/open-progress': ok(null),
        '/studio-desktop/open': { status: 400, body: { error: 'the workspace\'s sources could not be listed (HTTP 502)' } },
    };
}

describe('the desktop Studio view', () => {
    let widget: DesktopStudioWidget;
    let routes: Routes;
    let asked: Array<{ path: string; method: string }>;
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

    beforeAll(() => { act.IS_REACT_ACT_ENVIRONMENT = true; });

    beforeEach(async () => {
        routes = studioRoutes();
        asked = [];
        stored = new Map([[`studio.desktop.tree.collapsed:${STUDIO}`, [FABRIC_B.id]]]);
        external = [];
        executed = [];
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async (input: string, init?: RequestInit) => {
            const url = new URL(String(input), 'http://localhost');
            const path = url.pathname + url.search;
            asked.push({ path, method: init?.method ?? 'GET' });
            const key = Object.keys(routes).find(route => path === route || (!route.includes('?') && url.pathname === route));
            const found = key ? routes[key] : { status: 404, body: {} };
            const answer = typeof found === 'function' ? await found() : found;
            return {
                ok: answer.status >= 200 && answer.status < 300,
                status: answer.status,
                json: async () => answer.body,
            } as Response;
        });
        const module = new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue({
                tryGetRoots: () => [{ resource: { path: { fsPath: () => '/home/me/ConstructorStudio/workspaces/Gears workspace - Studio-web' } } }],
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
        expect(asked.filter(a => a.path === '/studio-desktop/open')).toHaveLength(0);
        // It asked again, in case a repository was added in the portal meanwhile.
        expect(asked.filter(a => a.path.endsWith('project_id=p-2'))).toHaveLength(2);
        await React.act(async () => { note.querySelector<HTMLButtonElement>('button')!.click(); });
        expect(external).toEqual([`${STUDIO}/?screen=projects;org=${FABRIC_A.id};workspace=ws-gears;project=p-2`]);
    });

    it('opens a project added a repository to since, on the next click', async () => {
        routes['/studio-api/studio-git/v1/sources?project_id=p-2'] = { status: 200, body: { items: [{ name: 'x' }], total: 1 } };
        await React.act(async () => { row('project 2').click(); });
        await settle();
        expect(asked.filter(a => a.path === '/studio-desktop/open' && a.method === 'POST')).toHaveLength(1);
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
        let finish!: (a: Answer) => void;
        const pending = new Promise<Answer>(resolve => { finish = resolve; });
        routes['/studio-desktop/open'] = () => pending;
        routes['/studio-desktop/open-progress'] = {
            status: 200,
            body: {
                workspaceId: 'p-odd', name: 'Gears workspace - Odd one', phase: 'cloning',
                sources: [{ name: 'studio-web', state: 'cloning', stage: 'Receiving objects', percent: 42 }, { name: 'docs', state: 'waiting' }],
            },
        };
        await React.act(async () => { row('Odd one').click(); });
        await React.act(async () => {
            await (widget as unknown as { readProgress(id: string): Promise<void> }).readProgress('p-odd');
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
        finish({ status: 400, body: { error: 'stopped by the test' } });
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
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async (input: string) => {
            const url = new URL(String(input), 'http://localhost');
            const body = url.pathname.endsWith('/status')
                ? { enabled: true, studioUrl: STUDIO, state: 'signed-in', switchable: false, environments: [], user: { sub: 'u' } }
                : url.pathname.endsWith('/memberships') ? { items: [] } : {};
            return { ok: true, status: 200, json: async () => body } as Response;
        });
        const container = new Container();
        container.load(new ContainerModule(bind => {
            bind(WorkspaceService).toConstantValue({ tryGetRoots: () => [], open: jest.fn() } as never);
            const commands = { executeCommand: jest.fn(async () => undefined), getCommand: () => undefined };
            bind(CommandService).toConstantValue(commands as never);
            bind(CommandRegistry).toConstantValue(commands as never);
            bind(StorageService).toConstantValue({ getData: async () => undefined, setData: async () => undefined } as never);
            bind(WindowService).toConstantValue({ openNewWindow: jest.fn() } as never);
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
