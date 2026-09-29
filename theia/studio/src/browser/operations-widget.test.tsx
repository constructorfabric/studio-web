import 'reflect-metadata';
jest.mock('@theia/core/lib/browser/shell/view-contribution', () => ({
    AbstractViewContribution: class {
        constructor(_options?: unknown) {}
    }
}));
import { Container } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import URI from '@theia/core/lib/common/uri';
import { OperationsWidget } from './operations-widget';
import { OperationsContribution } from './operations-contribution';
import { GitOperationsFrontendController } from './git-operations-contribution';
import { AuditFrontendController } from './audit-controller';

describe('Git operations browser slice', () => {
    let controller: GitOperationsFrontendController;
    let widget: OperationsWidget;
    let runtime: ReturnType<typeof createRuntime>;
    let statusBar: {
        setElement: jest.Mock;
        removeElement: jest.Mock;
    };
    let logger: {
        error: jest.Mock;
        warn: jest.Mock;
    };
    let commandService: { executeCommand: jest.Mock };
    let commandRegistry: {
        getAllHandlers: jest.Mock;
        onCommandsChanged: jest.Mock;
    };
    let scmService: {
        repositories: Array<{ provider: { rootUri: string } }>;
        selectedRepository?: { provider: { rootUri: string } };
        onDidAddRepository: jest.Mock;
        onDidRemoveRepository: jest.Mock;
        onDidChangeSelectedRepository: jest.Mock;
    };
    let repositoryAdded: ((repository: { provider: { rootUri: string } }) => void) | undefined;
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        controller = new GitOperationsFrontendController();
        repositoryAdded = undefined;
        statusBar = {
            setElement: jest.fn().mockResolvedValue(undefined),
            removeElement: jest.fn().mockResolvedValue(undefined)
        };
        logger = {
            error: jest.fn().mockResolvedValue(undefined),
            warn: jest.fn().mockResolvedValue(undefined)
        };
        scmService = {
            repositories: [],
            onDidAddRepository: jest.fn((listener: (repository: { provider: { rootUri: string } }) => void) => {
                repositoryAdded = listener;
                return { dispose: jest.fn() };
            }),
            onDidRemoveRepository: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeSelectedRepository: jest.fn(() => ({ dispose: jest.fn() }))
        };
        commandService = {
            executeCommand: jest.fn().mockImplementation(async (_command: string, repositoryPath: string) => {
                scmService.repositories.push({
                    provider: {
                        rootUri: new URI(`file://${repositoryPath}`).normalizePath().toString()
                    }
                });
            })
        };
        commandRegistry = {
            getAllHandlers: jest.fn().mockReturnValue([{}]),
            onCommandsChanged: jest.fn(() => ({ dispose: jest.fn() }))
        };
        Object.defineProperty(controller, 'statusBar', { value: statusBar });
        Object.defineProperty(controller, 'logger', { value: logger });
        Object.defineProperty(controller, 'commandService', { value: commandService });
        Object.defineProperty(controller, 'commandRegistry', { value: commandRegistry });
        Object.defineProperty(controller, 'scmService', { value: scmService });
        runtime = createRuntime();
        controller.bindRuntime(runtime);
        const container = new Container();
        container.bind(GitOperationsFrontendController).toConstantValue(controller);
        /* The panel also carries the history half now. This suite is about the
         * queue, so the journal is bound empty rather than simulated: an empty
         * one renders its "no entries" state and gets out of the way. */
        container.bind(AuditFrontendController).toConstantValue({
            onDidChange: () => ({ dispose: () => undefined }),
            getEntries: () => []
        } as unknown as AuditFrontendController);
        container.bind(OperationsWidget).toSelf();
        React.act(() => {
            widget = container.resolve(OperationsWidget);
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

    it('merges initial and reconnect deltas and rejects stale events', async () => {
        runtime.getOperationDeltas
            .mockResolvedValueOnce({ lastSequence: 1, events: [operationEvent(1, 'op-1', 'committed', 'b'.repeat(40))] })
            .mockResolvedValueOnce({ lastSequence: 2, events: [operationEvent(2, 'op-1', 'pushing')] });

        await React.act(async () => {
            await controller.onStart();
            await runtime.reconnect();
            controller.onOperationEvent(operationEvent(1, 'op-1', 'blocked'));
            MessageLoop.flush();
        });

        expect(runtime.getOperationDeltas.mock.calls.map(call => call[0])).toEqual([
            { afterSequence: 0 },
            { afterSequence: 1 }
        ]);
        expect(controller.getOperations().map(operation => operation.state)).toEqual(['pushing']);
        expect(controller.getOperations()[0].commitSha).toBe('b'.repeat(40));
        expect(widget.node.textContent).toContain('pushing');
    });

    it('renders backend states, status surface, and retry controls with stable test ids', async () => {
        await React.act(async () => {
            await controller.onStart();
            for (const [index, state] of ['committed', 'pushing', 'pushed', 'push-pending', 'blocked'].entries()) {
                controller.onOperationEvent(operationEvent(index + 1, `op-${index}`, state));
            }
            MessageLoop.flush();
        });

        const html = widget.node.innerHTML;
        expect(html).toContain('data-testid="git-operations-widget"');
        expect(html).toContain('data-testid="git-operations-status"');
        expect(html).toContain('data-testid="git-operation-state-op-0"');
        expect(html).toContain('data-testid="git-operation-retry-op-3"');
        expect(html).toContain('data-testid="git-operation-retry-op-4"');
        expect(widget.node.textContent).toContain('committed');
        expect(widget.node.textContent).toContain('pushing');
        expect(widget.node.textContent).toContain('pushed');
        expect(widget.node.textContent).toContain('push-pending');
        expect(widget.node.textContent).toContain('blocked');
        expect(widget.node.textContent).toContain('no repository selected');
        expect(widget.node.textContent).toContain('no branch');
    });

    it('retries only backend-permitted states and updates Theia status entries', async () => {
        await React.act(async () => {
            await controller.onStart();
            controller.onOperationEvent(operationEvent(1, 'op-1', 'failed'));
            controller.onOperationEvent(operationEvent(2, 'op-2', 'pushed'));
            await controller.retryOperation('op-1');
            await controller.retryOperation('op-2');
            MessageLoop.flush();
        });

        expect(runtime.retryOperation).toHaveBeenCalledTimes(1);
        expect(runtime.retryOperation).toHaveBeenCalledWith({ operationId: 'op-1' });
        expect(statusBar.setElement.mock.calls.some(call => call[0] === 'studio.status.mode')).toBe(true);
        expect(statusBar.removeElement).toHaveBeenCalledWith('studio.status.branch');
        expect(statusBar.setElement.mock.calls.some(call => call[0] === 'studio.status.operation')).toBe(true);
        expect(statusBar.setElement.mock.calls.find(call => call[0] === 'studio.status.mode')?.[1]).toMatchObject({
            command: 'studio.git-operations:toggle'
        });
        expect(statusBar.setElement.mock.calls.find(call => call[0] === 'studio.status.operation')?.[1]).toMatchObject({
            command: 'studio.git-operations:toggle'
        });
    });

    it('resolves onStart even when status bar rendering is still waiting on layout', async () => {
        let resolveSetElement: (() => void) | undefined;
        let statusBarCalls = 0;
        statusBar.setElement.mockImplementation(() => {
            statusBarCalls += 1;
            if (statusBarCalls === 1) {
                return new Promise<void>(resolve => {
                    resolveSetElement = resolve;
                });
            }
            return Promise.resolve();
        });

        const onStartPromise = controller.onStart();

        await expect(Promise.race([
            onStartPromise.then(() => 'resolved'),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 0))
        ])).resolves.toBe('resolved');
        expect(runtime.getSession).toHaveBeenCalledTimes(1);
        expect(runtime.getOperationDeltas).toHaveBeenCalledWith({ afterSequence: 0 });

        resolveSetElement?.();
        await expect(onStartPromise).resolves.toBeUndefined();
    });

    it('logs reconnect refresh rejections without creating unhandled failures', async () => {
        const reconnectError = new Error('reconnect refresh failed');
        runtime.getOperationDeltas
            .mockResolvedValueOnce({ lastSequence: 0, events: [] })
            .mockRejectedValueOnce(reconnectError);

        await React.act(async () => {
            await controller.onStart();
            await runtime.reconnect();
            await flushMicrotasks();
            MessageLoop.flush();
        });

        expect(logger.error).toHaveBeenCalledWith(
            'Failed to refresh Studio Git operations after reconnect.',
            reconnectError
        );
        expect(controller.isConnected()).toBe(true);
        expect(runtime.getOperationDeltas).toHaveBeenNthCalledWith(2, { afterSequence: 0 });
    });

    it('logs first status bar render failure, keeps onStart non-blocking, and retries after layout initialization', async () => {
        const renderError = new Error('layout not ready');
        let failed = false;
        statusBar.setElement.mockImplementation(() => {
            if (!failed) {
                failed = true;
                return Promise.reject(renderError);
            }
            return Promise.resolve();
        });

        await expect(controller.onStart()).resolves.toBeUndefined();
        await flushMicrotasks();

        expect(logger.error).toHaveBeenCalledWith(
            'Failed to render Studio Git operations status bar.',
            renderError
        );
        expect(statusBar.setElement.mock.calls.length).toBeGreaterThanOrEqual(1);
        const callsBeforeLayoutRetry = statusBar.setElement.mock.calls.length;

        await React.act(async () => {
            controller.onDidInitializeLayout();
            await flushMicrotasks();
            MessageLoop.flush();
        });

        expect(statusBar.setElement.mock.calls.length).toBeGreaterThan(callsBeforeLayoutRetry);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('renders branch and mode from the selected repository instead of the session defaults', async () => {
        const descriptor = {
            schemaVersion: 1 as const,
            repositoryId: 'nested-repository',
            fingerprint: 'fingerprint',
            rootUri: 'file:///workspace/nested',
            workspaceRelativeRoot: 'nested',
            label: 'nested',
            git: {
                configRevision: 'config',
                mode: 'commit' as const,
                branch: 'docs',
                publishEnabled: true
            }
        };
        scmService.selectedRepository = { provider: { rootUri: descriptor.rootUri } };

        await React.act(async () => {
            controller.onRepositoriesChanged([descriptor]);
            await flushMicrotasks();
            MessageLoop.flush();
        });

        expect(widget.node.textContent).toContain('nested');
        expect(widget.node.textContent).toContain('docs');
        expect(widget.node.textContent).toContain('commit');
        expect(statusBar.setElement.mock.calls.find(call => call[0] === 'studio.status.branch')?.[1])
            .toMatchObject({ text: 'docs' });
    });

    it('renders repository header metadata in separate semantic elements, including repository status, and preserves the full path title', async () => {
        const descriptor = {
            schemaVersion: 1 as const,
            repositoryId: 'cyber-wiki',
            fingerprint: 'fingerprint-cyber-wiki',
            rootUri: 'file:///workspace/workspace-sources/constructorfabric/cyber-wiki',
            workspaceRelativeRoot: 'workspace-sources/constructorfabric/cyber-wiki',
            label: 'cyber-wiki',
            git: {
                configRevision: 'config-cyber-wiki',
                mode: 'push' as const,
                branch: 'main',
                publishEnabled: false,
                disabledReason: 'publish disabled by policy'
            }
        };

        await React.act(async () => {
            controller.onRepositoriesChanged([descriptor]);
            controller.onOperationEvent({
                ...operationEvent(1, 'op-cyber-wiki', 'pushing'),
                repositoryId: descriptor.repositoryId
            });
            await flushMicrotasks();
            MessageLoop.flush();
        });

        const header = widget.node.querySelector('.studio-git-operations__repository-header');
        expect(header).toBeTruthy();

        const label = header?.querySelector('.studio-git-operations__repository-label');
        const path = header?.querySelector('.studio-git-operations__repository-path');
        const branch = header?.querySelector('.studio-git-operations__repository-branch');
        const mode = header?.querySelector('.studio-git-operations__repository-mode');
        const status = header?.querySelector('.studio-git-operations__repository-status');

        expect(label?.textContent).toBe('cyber-wiki');
        expect(path?.textContent).toBe('workspace-sources/constructorfabric/cyber-wiki');
        expect(path?.getAttribute('title')).toBe('workspace-sources/constructorfabric/cyber-wiki');
        expect(branch?.textContent).toBe('main');
        expect(mode?.textContent).toBe('push');
        expect(status?.textContent).toBe('publish disabled by policy');
        expect(status?.className).toBe('studio-git-operations__repository-status');

        expect(Array.from(header?.children ?? []).map(element => element.className)).toEqual([
            'studio-git-operations__repository-label',
            'studio-git-operations__repository-path',
            'studio-git-operations__repository-branch',
            'studio-git-operations__repository-mode',
            'studio-git-operations__repository-status'
        ]);
    });

    it('does not duplicate reconnect listeners when the same runtime is bound twice', async () => {
        controller.bindRuntime(runtime);
        runtime.getOperationDeltas
            .mockResolvedValueOnce({ lastSequence: 0, events: [] })
            .mockResolvedValueOnce({ lastSequence: 1, events: [operationEvent(1, 'op-1', 'pushing')] });

        await React.act(async () => {
            await controller.onStart();
            await runtime.reconnect();
            await flushMicrotasks();
            MessageLoop.flush();
        });

        expect(runtime.openListenerCount()).toBe(1);
        expect(runtime.closeListenerCount()).toBe(1);
        expect(runtime.getSession).toHaveBeenCalledTimes(2);
        expect(runtime.getOperationDeltas).toHaveBeenCalledTimes(2);
        expect(controller.getOperations().map(operation => operation.state)).toEqual(['pushing']);
    });

    it('forwards Theia layout initialization to the controller retry hook', () => {
        const lifecycleController = {
            bindRuntime: jest.fn(),
            onDidInitializeLayout: jest.fn()
        };
        const contribution = new OperationsContribution(lifecycleController as never, runtime as never);

        contribution.onDidInitializeLayout();

        expect(lifecycleController.bindRuntime).toHaveBeenCalledWith(runtime);
        expect(lifecycleController.onDidInitializeLayout).toHaveBeenCalledTimes(1);
    });

    it('opens backend-discovered repositories through vscode.git and selects the owning native SCM repository', async () => {
        const descriptor = {
            schemaVersion: 1 as const,
            repositoryId: 'nested-repository',
            fingerprint: 'fingerprint',
            rootUri: 'file:///workspace/nested',
            workspaceRelativeRoot: 'nested',
            label: 'nested',
            git: {
                configRevision: 'config',
                mode: 'push' as const,
                publishEnabled: true
            }
        };

        await React.act(async () => {
            controller.onRepositoriesChanged([descriptor]);
            await flushMicrotasks();
            await controller.selectRepository(descriptor.repositoryId);
            await flushMicrotasks();
            MessageLoop.flush();
        });

        expect(commandService.executeCommand).toHaveBeenCalledWith('git.openRepository', '/workspace/nested');
        expect(scmService.repositories).toHaveLength(1);
        expect(scmService.selectedRepository).toBe(scmService.repositories[0]);
    });

    it('uses the backend repository identity even before the frontend descriptor cache refreshes', async () => {
        runtime.resolveWorkspacePath.mockResolvedValue({
            workspaceId: 'workspace-1',
            repositoryId: 'late-repository',
            relativePath: 'docs/guide.md',
            repositoryRelativePath: 'guide.md',
            exists: true,
            isDirectory: false
        });

        await expect(controller.resolveWorkspaceResource('file:///workspace/docs/guide.md')).resolves.toEqual({
            relativePath: 'docs/guide.md',
            repository: { repositoryId: 'late-repository' }
        });
    });

    it('settles repository-open waiters when a queued repository is removed', async () => {
        commandService.executeCommand.mockImplementation(() => new Promise<void>(() => undefined));
        const descriptor = repositoryDescriptor('removed-repository', 'removed', 'file:///workspace/removed');
        controller.onRepositoriesChanged([descriptor]);
        const pending = (controller as unknown as {
            requestScmRepository(value: typeof descriptor): Promise<void>;
        }).requestScmRepository(descriptor);
        await flushMicrotasks();

        controller.onRepositoriesChanged([]);

        await expect(Promise.race([
            pending.then(() => 'settled'),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 0))
        ])).resolves.toBe('settled');
    });

    it('waits for the vscode.git command handler before opening discovered repositories', async () => {
        let commandsChanged: (() => void) | undefined;
        commandRegistry.getAllHandlers.mockReturnValue([]);
        commandRegistry.onCommandsChanged.mockImplementation((listener: () => void) => {
            commandsChanged = listener;
            return { dispose: jest.fn() };
        });
        runtime.getRepositories.mockResolvedValue([{
            schemaVersion: 1,
            repositoryId: 'nested-repository',
            fingerprint: 'fingerprint',
            rootUri: 'file:///workspace/nested',
            workspaceRelativeRoot: 'nested',
            label: 'nested',
            git: {
                configRevision: 'config',
                mode: 'push',
                publishEnabled: true
            }
        }]);

        await controller.onStart();
        expect(commandService.executeCommand).not.toHaveBeenCalled();

        commandRegistry.getAllHandlers.mockReturnValue([{}]);
        commandsChanged?.();
        await flushMicrotasks();

        expect(commandService.executeCommand).toHaveBeenCalledWith('git.openRepository', '/workspace/nested');
    });

    it('opens the configured repository first and selects it so SCM views stay populated', async () => {
        const root = repositoryDescriptor('root-repository', '.', 'file:///workspace');
        const nested = repositoryDescriptor('nested-repository', 'nested', 'file:///workspace/nested');
        let releaseRootOpen: (() => void) | undefined;
        commandService.executeCommand.mockImplementation(async (_command: string, repositoryPath: string) => {
            if (repositoryPath === '/workspace') {
                await new Promise<void>(resolve => {
                    releaseRootOpen = resolve;
                });
            }
            scmService.repositories.push({
                provider: {
                    rootUri: new URI(`file://${repositoryPath}`).normalizePath().toString()
                }
            });
        });

        await React.act(async () => {
            controller.onRepositoriesChanged([root, nested]);
            await flushMicrotasks();
            MessageLoop.flush();
        });

        expect(commandService.executeCommand).toHaveBeenCalledTimes(1);
        expect(commandService.executeCommand).toHaveBeenCalledWith('git.openRepository', '/workspace');

        await React.act(async () => {
            releaseRootOpen?.();
            await waitFor(() => commandService.executeCommand.mock.calls.length === 2);
            MessageLoop.flush();
        });

        expect(scmService.selectedRepository?.provider.rootUri).toBe(root.rootUri);
        expect(commandService.executeCommand.mock.calls[1]).toEqual(['git.openRepository', '/workspace/nested']);
    });

    it('selects the preferred repository when vscode.git registers it asynchronously', async () => {
        const descriptor = repositoryDescriptor('studio-web', 'studio-web', 'file:///workspace/studio-web');
        runtime.getRepositories.mockResolvedValue([descriptor]);
        commandService.executeCommand.mockResolvedValue(undefined);

        await React.act(async () => {
            await controller.onStart();
            await flushMicrotasks();
        });

        expect(scmService.selectedRepository).toBeUndefined();
        const nativeRepository = { provider: { rootUri: descriptor.rootUri } };
        scmService.repositories.push(nativeRepository);
        await React.act(async () => {
            repositoryAdded?.(nativeRepository);
            await flushMicrotasks();
        });

        expect(scmService.selectedRepository).toBe(nativeRepository);
        expect(controller.getSelectedRepository()).toBe(descriptor);
    });

    it('keeps operation history bounded and reports latest status without sorting the full map', async () => {
        await React.act(async () => {
            await controller.onStart();
            for (let index = 1; index <= 220; index += 1) {
                controller.onOperationEvent(operationEvent(index, `op-${index}`, index === 220 ? 'pushing' : 'queued'));
            }
            MessageLoop.flush();
        });

        const operations = controller.getOperations();

        expect(operations).toHaveLength(200);
        expect(operations[0].operationId).toBe('op-220');
        expect(operations[operations.length - 1]?.operationId).toBe('op-21');
        expect(operations.some(operation => operation.operationId === 'op-1')).toBe(false);
        expect(widget.node.textContent).toContain('pushing');
    });
});

function repositoryDescriptor(repositoryId: string, workspaceRelativeRoot: string, rootUri: string) {
    return {
        schemaVersion: 1 as const,
        repositoryId,
        fingerprint: `fingerprint-${repositoryId}`,
        rootUri,
        workspaceRelativeRoot,
        label: workspaceRelativeRoot === '.' ? 'workspace' : workspaceRelativeRoot,
        git: {
            configRevision: `config-${repositoryId}`,
            mode: 'push' as const,
            publishEnabled: true
        }
    };
}

function createRuntime() {
    const openListeners: Array<() => void> = [];
    const closeListeners: Array<() => void> = [];
    const runtime = {
        getSession: jest.fn().mockResolvedValue({
            actorId: 'actor-1',
            workspaceId: 'workspace-1',
            workspaceRootName: 'repo',
            allowedOriginsMode: 'same-origin',
            allowedOrigins: [],
            git: { mode: 'push', branch: 'main' },
            features: {
                fixedWorkspace: true,
                allowWorkspaceSwitching: false,
                allowGitMutations: true
            }
        }),
        getOperationDeltas: jest.fn().mockResolvedValue({ lastSequence: 0, events: [] }),
        getRepositories: jest.fn().mockResolvedValue([]),
        resolveWorkspacePath: jest.fn().mockResolvedValue(undefined),
        retryOperation: jest.fn().mockResolvedValue(undefined),
        enqueueOperation: jest.fn().mockResolvedValue(undefined),
        onDidOpenConnection: (listener: () => void) => {
            openListeners.push(listener);
            return { dispose: jest.fn() };
        },
        onDidCloseConnection: (listener: () => void) => {
            closeListeners.push(listener);
            return { dispose: jest.fn() };
        },
        reconnect: async () => {
            for (const listener of openListeners) {
                listener();
            }
            await Promise.resolve();
            await Promise.resolve();
        },
        openListenerCount: () => openListeners.length,
        closeListenerCount: () => closeListeners.length
    };
    return runtime;
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Timed out waiting for test condition');
}

function operationEvent(sequence: number, operationId: string, state: string, commitSha?: string) {
    return {
        sequence,
        operationId,
        workspaceId: 'workspace-1',
        relativePath: `file-${operationId}.txt`,
        repositoryRelativePath: `file-${operationId}.txt`,
        languageId: 'markdown',
        contentHash: 'a'.repeat(64),
        idempotencyKey: `key-${operationId}`,
        savedAt: new Date(2026, 6, 27, 0, 0, sequence - 1).toISOString(),
        state,
        timestamp: new Date(2026, 6, 27, 0, 0, sequence).toISOString(),
        ...(commitSha ? { commitSha } : {})
    };
}
