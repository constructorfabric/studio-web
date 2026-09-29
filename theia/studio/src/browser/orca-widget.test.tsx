// The Agents panel's Changes section: it is the only place that says what an
// agent actually did, and the click on a row is the only way out of the panel
// into the code. Both are asserted here, and the click deliberately checks the
// path that reaches the opener — a `file://${path}` template would send a
// Windows drive letter through as a host and open nothing.

import 'reflect-metadata';
// Same reason the other widget tests do this: the real module imports the
// @theia/core/lib/browser barrel, whose common-frontend-contribution calls
// document.queryCommandSupported at load time — absent from this jsdom.
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
import * as React from '@theia/core/shared/react';
import { Container, ContainerModule } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { OrcaTerminalOpener } from './orca-terminal-opener';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { OrcaService, type OrcaWorktree, type OrcaWorktreeChange } from '../common/orca-protocol';
import { OrcaWidget } from './orca-widget';

const worktree: OrcaWorktree = {
    id: 'wt-1',
    path: '/workspace/.orca/feature-x',
    branch: 'feature-x',
    displayName: 'feature-x',
    comment: 'add the thing',
    status: 'in-progress',
    isMain: false
};

describe('OrcaWidget changes', () => {
    let widget: OrcaWidget;
    let opened: URI[];
    let changes: OrcaWorktreeChange[];
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        opened = [];
        changes = [
            { code: ' M', path: 'src/app.ts', absolutePath: '/workspace/.orca/feature-x/src/app.ts' },
            { code: '??', path: 'docs/notes.md', absolutePath: '/workspace/.orca/feature-x/docs/notes.md' }
        ];
        const orca = {
            status: async () => ({ reachable: true, state: 'ready', desktopRunning: false }),
            currentWorktree: async () => undefined,
            listWorktrees: async () => [worktree],
            listRepositories: async () => [],
            listTerminals: async () => [],
            changes: async (path: string) => (path === worktree.path ? changes : []),
            registerWorkspace: async () => [],
            createTask: async () => undefined,
            startAgent: async () => undefined,
            send: async () => undefined,
            interrupt: async () => undefined,
            waitForIdle: async () => 'idle' as const,
            read: async () => ''
        };
        const module = new ContainerModule(bind => {
            bind(OrcaService).toConstantValue(orca as never);
            bind(MessageService).toConstantValue({ error: jest.fn(), info: jest.fn() } as never);
            bind(WorkspaceService).toConstantValue({ roots: Promise.resolve([]) } as never);
            bind(OpenerService).toConstantValue({
                getOpener: async (uri: URI) => ({ open: async () => opened.push(uri) })
            } as never);
            bind(OrcaTerminalOpener).toConstantValue({ open: jest.fn() } as never);
            bind(OrcaWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        React.act(() => {
            widget = container.resolve<OrcaWidget>(OrcaWidget);
            MessageLoop.flush();
        });
        // The panel loads on attach; nothing is attached in a unit test, so the
        // load is driven directly and the render asserted against its result.
        await React.act(async () => {
            await (widget as unknown as { refresh(): Promise<void> }).refresh();
            MessageLoop.flush();
        });
    });

    afterEach(() => {
        React.act(() => {
            widget.dispose();
            MessageLoop.flush();
        });
    });

    afterAll(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    });

    it('lists what the agent changed in the selected worktree', () => {
        const text = widget.node.textContent ?? '';
        expect(text).toContain('src/app.ts');
        expect(text).toContain('docs/notes.md');
        // The porcelain code is shown trimmed, so ' M' reads as 'M'.
        const codes = Array.from(widget.node.querySelectorAll('.studio-orca-change-code'))
            .map(node => node.textContent);
        expect(codes).toEqual(['M', '??']);
    });

    it('opens the file the row names, by its absolute path', async () => {
        const rows = widget.node.querySelectorAll<HTMLElement>('.studio-orca-changes > li');
        expect(rows).toHaveLength(2);

        await React.act(async () => {
            rows[0].click();
            MessageLoop.flush();
        });

        expect(opened).toHaveLength(1);
        // The path, in its POSIX form: `fsPath()` would answer with backslashes
        // when the test itself runs on Windows, which says nothing about what
        // the editor was asked to open.
        expect(opened[0].path.toString()).toBe('/workspace/.orca/feature-x/src/app.ts');
        expect(opened[0].scheme).toBe('file');
    });

    it('says a clean worktree is clean instead of rendering an empty list', async () => {
        changes = [];
        await React.act(async () => {
            await (widget as unknown as { loadSelection(): Promise<void> }).loadSelection();
            widget.update();
            MessageLoop.flush();
        });

        expect(widget.node.textContent).toContain('Nothing uncommitted');
        expect(widget.node.querySelectorAll('.studio-orca-changes > li')).toHaveLength(0);
    });
});

// The advice shown when the runtime is not reachable. Two different causes
// used to get one message: a session image built without the runtime was told
// to start `orca serve`, which is not there to start — the thing a stand
// actually showed.
describe('OrcaWidget advice when the runtime is unreachable', () => {
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    });

    const render = async (status: Record<string, unknown>): Promise<string> => {
        const orca = {
            status: async () => status,
            currentWorktree: async () => undefined,
            listWorktrees: async () => [],
            listRepositories: async () => [],
            listTerminals: async () => [],
            changes: async () => [],
            registerWorkspace: async () => [],
            createTask: async () => undefined,
            startAgent: async () => undefined,
            send: async () => undefined,
            interrupt: async () => undefined,
            waitForIdle: async () => 'idle' as const,
            read: async () => ''
        };
        const container = new Container();
        container.load(new ContainerModule(bind => {
            bind(OrcaService).toConstantValue(orca as never);
            bind(MessageService).toConstantValue({ error: jest.fn(), info: jest.fn() } as never);
            bind(WorkspaceService).toConstantValue({ roots: Promise.resolve([]) } as never);
            bind(OpenerService).toConstantValue({ getOpener: async () => ({ open: async () => undefined }) } as never);
            bind(OrcaTerminalOpener).toConstantValue({ open: jest.fn() } as never);
            bind(OrcaWidget).toSelf();
        }));
        let widget!: OrcaWidget;
        React.act(() => {
            widget = container.resolve<OrcaWidget>(OrcaWidget);
            MessageLoop.flush();
        });
        await React.act(async () => {
            await (widget as unknown as { refresh(): Promise<void> }).refresh();
            MessageLoop.flush();
        });
        const text = widget.node.textContent ?? '';
        React.act(() => {
            widget.dispose();
            MessageLoop.flush();
        });
        return text;
    };

    it('points at the image when there is no binary to start', async () => {
        const text = await render({
            reachable: false,
            state: 'unreachable',
            desktopRunning: false,
            cliMissing: true,
            error: 'the orca CLI is not installed. A session image carries it only when built…'
        });

        expect(text).toContain('built without the Orca runtime');
        expect(text).toContain('STUDIO_ORCA_DEB_URL');
        // Telling someone to start a runtime that is not in the image is the
        // bug this replaced.
        expect(text).not.toContain('orca serve');
    });

    it('points at the runtime when a binary is there but nothing answers', async () => {
        const text = await render({
            reachable: false,
            state: 'unreachable',
            desktopRunning: false,
            cliMissing: false,
            error: 'connection refused'
        });

        expect(text).toContain('orca serve');
        expect(text).not.toContain('STUDIO_ORCA_DEB_URL');
        // The reason still travels with the advice either way.
        expect(text).toContain('connection refused');
    });
});

// A member's own Orca knows every repository they ever added to it. The panel
// showed them flat, as this project's, with two `main` rows and "Not in this
// image" on a machine that has no image.
describe('OrcaWidget on a member\'s machine', () => {
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    });

    const row = (repoId: string, path: string, branch: string, isMain: boolean): OrcaWorktree => ({
        id: `${repoId}::${path}`, repoId, path, branch, displayName: branch, comment: '', status: 'in-progress', isMain
    });
    const worktrees = [
        row('a', '/src/alpha', 'main', true),
        row('a', '/orca/alpha/fix', 'fix/thing', false),
        row('b', '/src/beta', 'main', true)
    ];
    const repositories = [
        { id: 'a', path: '/src/alpha', displayName: 'alpha' },
        { id: 'b', path: '/src/beta', displayName: 'beta' }
    ];

    const mount = async (root: string | undefined, over: Record<string, unknown> = {}) => {
        const createTask = jest.fn(async () => undefined);
        const orca = {
            status: async () => ({
                reachable: true, state: 'ready', appVersion: '1.4.211', desktopRunning: true,
                host: 'local', paired: true, agents: ['claude']
            }),
            currentWorktree: async () => undefined,
            listWorktrees: async () => worktrees,
            listRepositories: async () => repositories,
            listTerminals: async () => [],
            changes: async () => [],
            registerWorkspace: async () => [],
            createTask,
            start: async () => undefined,
            startAgent: async () => undefined,
            send: async () => undefined,
            interrupt: async () => undefined,
            waitForIdle: async () => 'idle' as const,
            read: async () => '',
            ...over
        };
        const roots = root ? [{ resource: { path: { fsPath: () => root } } }] : [];
        const container = new Container();
        container.load(new ContainerModule(bind => {
            bind(OrcaService).toConstantValue(orca as never);
            bind(MessageService).toConstantValue({ error: jest.fn(), info: jest.fn(), warn: jest.fn() } as never);
            bind(WorkspaceService).toConstantValue({ roots: Promise.resolve(roots) } as never);
            bind(OpenerService).toConstantValue({ getOpener: async () => ({ open: async () => undefined }) } as never);
            bind(OrcaTerminalOpener).toConstantValue({ open: jest.fn() } as never);
            bind(OrcaWidget).toSelf();
        }));
        let widget!: OrcaWidget;
        React.act(() => {
            widget = container.resolve<OrcaWidget>(OrcaWidget);
            MessageLoop.flush();
        });
        await React.act(async () => {
            await (widget as unknown as { refresh(): Promise<void> }).refresh();
            MessageLoop.flush();
        });
        return { widget, createTask };
    };

    const unmount = (widget: OrcaWidget) => React.act(() => {
        widget.dispose();
        MessageLoop.flush();
    });

    const headings = (widget: OrcaWidget) =>
        Array.from(widget.node.querySelectorAll('.studio-orca-group-name')).map(h => h.textContent);

    it('with no project open, says so and lists every repository under its own name', async () => {
        const { widget } = await mount(undefined);
        expect(widget.node.textContent).toContain('No project is open');
        expect(headings(widget)).toEqual(['alpha', 'beta']);
        unmount(widget);
    });

    it('with a project open, shows its repository first and the others behind a toggle', async () => {
        const { widget } = await mount('/src/beta');
        expect(headings(widget)).toEqual(['beta · this project']);
        const toggle = widget.node.querySelector<HTMLButtonElement>('.studio-orca-others')!;
        expect(toggle.textContent).toBe('Other repositories in Orca (1)');
        await React.act(async () => {
            toggle.click();
            MessageLoop.flush();
        });
        expect(headings(widget)).toEqual(['beta · this project', 'alpha']);
        unmount(widget);
    });

    it('offers to add the open project when Orca does not know it', async () => {
        const { widget } = await mount('/home/m/ConstructorStudio/workspaces/p');
        expect(widget.node.textContent).toContain("Add this project's repositories to Orca");
        unmount(widget);
    });

    it('does not say "Not in this image" where there is no image, and offers every agent', async () => {
        const { widget } = await mount('/src/beta');
        const text = widget.node.textContent ?? '';
        expect(text).not.toContain('Not in this image');
        expect(text).toContain('Start codex');
        unmount(widget);
    });

    it('creates a task in the selected worktree\'s repository', async () => {
        const { widget, createTask } = await mount('/src/beta');
        const w = widget as unknown as { taskName: string; taskPrompt: string; createTask(): void };
        w.taskName = 'task';
        w.taskPrompt = 'do it';
        await React.act(async () => {
            w.createTask();
            await new Promise(resolve => setTimeout(resolve, 0));
            MessageLoop.flush();
        });
        expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ repo: 'id:b' }));
        unmount(widget);
    });

    it('offers to install Orca when it is not there', async () => {
        const { widget } = await mount(undefined, {
            status: async () => ({ reachable: false, state: 'unreachable', desktopRunning: false, host: 'local', cliMissing: true })
        });
        const buttons = Array.from(widget.node.querySelectorAll('.studio-orca-status button')).map(b => b.textContent);
        expect(buttons).toEqual(['Get Orca', 'Refresh']);
        unmount(widget);
    });

    it('offers to start Orca when it is installed but closed', async () => {
        const { widget } = await mount(undefined, {
            status: async () => ({ reachable: false, state: 'not_running', desktopRunning: false, host: 'local' })
        });
        const buttons = Array.from(widget.node.querySelectorAll('.studio-orca-status button')).map(b => b.textContent);
        expect(buttons).toEqual(['Start Orca', 'Refresh']);
        unmount(widget);
    });
});
