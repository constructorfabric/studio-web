import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class {}
}));
jest.mock('@theia/core/lib/browser/shell/view-contribution', () => ({
    AbstractViewContribution: class<T> {
        protected readonly singletonWidget: T;
        protected readonly toDispose = { push: jest.fn() };

        constructor(protected readonly options: { widgetId: string; widgetName: string; defaultWidgetOptions: { area: string } }) {
            this.singletonWidget = { id: options.widgetId } as T;
        }

        get viewId(): string {
            return this.options.widgetId;
        }

        get defaultViewOptions(): { area: string } {
            return this.options.defaultWidgetOptions;
        }

        async openView(): Promise<T> {
            return this.singletonWidget;
        }

        registerCommands(): void {}
    }
}));
jest.mock('@theia/core/lib/browser', () => ({
    open: jest.fn(async () => undefined),
    OpenerService: class {}
}));
import * as React from '@theia/core/shared/react';
import { Emitter } from '@theia/core/lib/common';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Container } from '@theia/core/shared/inversify';
import { OpenerService, open } from '@theia/core/lib/browser';
import type {
    ReadWorkspaceRawTomlResponse,
    WorkspaceActivityEvent,
    WorkspaceConfigMutationResponse,
    WorkspaceConfiguredSource,
    WorkspaceSnapshot,
    WorkspaceSyncResponse
} from '../common/workspace-protocol';
import { WorkspaceSourcesWidget } from './workspace-sources-widget';
import { WorkspaceSourcesFrontendController, WorkspaceSourcesToggleCommand } from './workspace-sources-controller';
import { WorkspaceSourcesContribution } from './workspace-sources-contribution';

describe('WorkspaceSourcesWidget', () => {
    let widget: WorkspaceSourcesWidget;
    let controller: WorkspaceSourcesControllerStub;
    let openerService: OpenerService;
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        controller = new WorkspaceSourcesControllerStub();
        openerService = {} as OpenerService;
        const container = new Container();
        container.bind(WorkspaceSourcesWidget).toSelf();
        container.bind(WorkspaceSourcesFrontendController).toConstantValue(controller as never);
        container.bind(OpenerService).toConstantValue(openerService);
        React.act(() => {
            widget = container.resolve(WorkspaceSourcesWidget);
            MessageLoop.flush();
        });
    });

    afterEach(() => {
        React.act(() => {
            widget.dispose();
            MessageLoop.flush();
        });
        jest.clearAllMocks();
    });

    afterAll(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    });

    it('renders stable workspace source ids and routes the existing top-level actions', async () => {
        controller.snapshot = snapshotWith();
        controller.activity = activityWith();

        await emitChange(controller);

        expect(widget.node.innerHTML).toContain('data-testid="workspace-sources-widget"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-sources-status"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-sources-panel-canonical-active"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-source-row-core"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-source-edit-core"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-source-remove-core"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-suggestion-add-candidate-1"');
        expect(widget.node.innerHTML).toContain('data-testid="workspace-sources-edit-raw"');

        await click('[data-testid="workspace-sources-refresh"]', widget.node);
        await click('[data-testid="workspace-sources-sync"]', widget.node);
        await click('[data-testid="workspace-sources-open-raw"]', widget.node);

        expect(controller.refresh).toHaveBeenCalledTimes(1);
        expect(controller.startWorkspaceSync).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            expectedRevision: 'rev-1',
            trustConfirmed: false
        });
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('validates add-source input before calling the controller', async () => {
        controller.snapshot = snapshotWith();
        await emitChange(controller);

        await click('[data-testid="workspace-sources-add"]', widget.node);
        await click('[data-testid="workspace-source-editor-save"]', widget.node);

        expect(controller.addWorkspaceSource).not.toHaveBeenCalled();
        expect(text(widget.node, '[data-testid="workspace-source-editor-dialog"]')).toContain('Source ID is required.');
        expect(text(widget.node, '[data-testid="workspace-source-editor-dialog"]')).toContain('Local path is required for local sources.');
    });

    it('uses the configured resolve.workdir in remote checkout previews', async () => {
        controller.snapshot = snapshotWith({
            config: {
                ...snapshotWith().config,
                resolveWorkdir: 'workspace-sources',
                resolveRootUri: 'file:///workspace/workspace-sources'
            },
            identity: {
                ...snapshotWith().identity,
                configPath: 'C:\\workspace\\.cf-workspace.toml'
            }
        });
        await emitChange(controller);

        await click('[data-testid="workspace-sources-add"]', widget.node);
        await setInputValue('[data-testid="workspace-source-input-source-id"]', widget.node, 'ai-courses');
        await setSelectValue('[data-testid="workspace-source-input-kind"]', widget.node, 'remote');
        await setInputValue(
            '[data-testid="workspace-source-input-remote-url"]',
            widget.node,
            'git@github.com:constructorfabric/ai-courses.git'
        );

        expect(text(widget.node, '[data-testid="workspace-source-resolved-local-path"]'))
            .toBe('/workspace/workspace-sources/constructorfabric/ai-courses');
    });

    it('derives remote checkout previews from a Windows config path when resolveRootUri is absent', async () => {
        controller.snapshot = snapshotWith({
            config: {
                ...snapshotWith().config,
                resolveWorkdir: 'workspace-sources',
                resolveRootUri: undefined
            },
            identity: {
                ...snapshotWith().identity,
                configPath: 'C:\\workspace\\.cf-workspace.toml'
            }
        });
        await emitChange(controller);

        await click('[data-testid="workspace-sources-add"]', widget.node);
        await setInputValue('[data-testid="workspace-source-input-source-id"]', widget.node, 'ai-courses');
        await setSelectValue('[data-testid="workspace-source-input-kind"]', widget.node, 'remote');
        await setInputValue(
            '[data-testid="workspace-source-input-remote-url"]',
            widget.node,
            'git@github.com:constructorfabric/ai-courses.git'
        );

        expect(text(widget.node, '[data-testid="workspace-source-resolved-local-path"]'))
            .toBe('C:/workspace/workspace-sources/constructorfabric/ai-courses');
    });

    it('uses a destructive confirmation before removal', async () => {
        controller.snapshot = snapshotWith();
        await emitChange(controller);

        await click('[data-testid="workspace-source-remove-core"]', widget.node);
        expect(text(widget.node, '[data-testid="workspace-source-remove-dialog"]')).toContain('Remove core');

        await click('[data-testid="workspace-source-remove-dialog-confirm"]', widget.node);

        expect(controller.removeWorkspaceSource).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            expectedRevision: 'rev-1',
            sourceId: 'core'
        });
    });

    it('previews rename impacts and confirms with explicit impact ids', async () => {
        controller.snapshot = snapshotWith();
        controller.renameResponses = [
            {
                schemaVersion: 1,
                snapshot: snapshotWith(),
                conflict: {
                    code: 'confirmation-required',
                    message: 'Rename requires confirmation.',
                    currentRevision: 'rev-1',
                    diagnostics: [],
                    impacts: [{
                        impactId: 'impact-1',
                        sourceId: 'core',
                        nextSourceId: 'guides',
                        path: 'sources.other.adapter',
                        evidence: '"core"',
                        range: { start: 0, end: 1, line: 4, column: 11 },
                        confirmed: false,
                        requiresExplicitEdit: true
                    }]
                }
            },
            {
                schemaVersion: 1,
                snapshot: snapshotWith({
                    config: { ...snapshotWith().config, revision: 'rev-2' },
                    configuredSources: [{
                        sourceId: 'guides',
                        label: 'guides',
                        localPath: '/workspace/core',
                        provider: 'local',
                        configured: true,
                        authoritative: true,
                        include: 'member'
                    }]
                })
            }
        ];

        await emitChange(controller);
        await click('[data-testid="workspace-source-edit-core"]', widget.node);
        await setInputValue('[data-testid="workspace-source-input-source-id"]', widget.node, 'guides');
        await click('[data-testid="workspace-source-editor-save"]', widget.node);

        expect(text(widget.node, '[data-testid="workspace-source-rename-dialog"]')).toContain('Rename requires confirmation.');
        expect(text(widget.node, '[data-testid="workspace-source-rename-impacts"]')).toContain('sources.other.adapter');

        await click('[data-testid="workspace-source-rename-confirm"]', widget.node);

        expect(controller.renameWorkspace).toHaveBeenNthCalledWith(1, expect.objectContaining({
            sourceId: 'core',
            nextSourceId: 'guides'
        }));
        expect(controller.renameWorkspace).toHaveBeenNthCalledWith(2, expect.objectContaining({
            sourceId: 'core',
            nextSourceId: 'guides',
            confirmedImpactIds: ['impact-1']
        }));
    });

    it('recovers raw TOML revision conflicts with reload-latest', async () => {
        controller.snapshot = snapshotWith();
        controller.readRawResponses = [
            rawTomlResponse('rev-1', 'version = "1.0"\n[sources.core]\npath = "core"\n'),
            rawTomlResponse('rev-2', 'version = "1.0"\n[sources.guides]\npath = "guides"\n')
        ];
        controller.saveRawResponse = {
            schemaVersion: 1,
            snapshot: snapshotWith({ config: { ...snapshotWith().config, revision: 'rev-2' } }),
            conflict: {
                code: 'revision-mismatch',
                message: 'Workspace config changed while the mutation was in flight.',
                currentRevision: 'rev-2',
                diagnostics: [{
                    code: 'revision-mismatch',
                    severity: 'warning',
                    scope: 'config',
                    message: 'Workspace config changed while the mutation was in flight.'
                }]
            }
        };

        await emitChange(controller);
        await click('[data-testid="workspace-sources-edit-raw"]', widget.node);
        await setTextareaValue('[data-testid="workspace-source-raw-input"]', widget.node, 'version = "1.0"\n[sources.local]\npath = "local"\n');
        await click('[data-testid="workspace-source-raw-save"]', widget.node);

        expect(text(widget.node, '[data-testid="workspace-source-raw-conflict"]')).toContain('Revision conflict');

        await click('[data-testid="workspace-source-raw-reload-latest"]', widget.node);

        const textarea = widget.node.querySelector('[data-testid="workspace-source-raw-input"]') as HTMLTextAreaElement | null;
        expect(textarea?.value).toContain('[sources.guides]');
        expect(controller.readWorkspaceRawToml).toHaveBeenCalledTimes(2);
    });

    it('confirms trust-required syncs explicitly', async () => {
        controller.snapshot = snapshotWith();
        controller.startSyncResponse = syncResponse(snapshotWith(), {
            sourceId: 'core',
            eligibility: 'requires-trust',
            forceRequired: false,
            confirmationMessage: 'Trust is required.'
        });

        await emitChange(controller);
        await click('[data-testid="workspace-source-sync-core"]', widget.node);

        expect(text(widget.node, '[data-testid="workspace-source-sync-dialog"]')).toContain('Trust is required.');
        await click('[data-testid="workspace-source-sync-confirm"]', widget.node);

        expect(controller.confirmWorkspaceSync).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            jobId: 'job-sync',
            trustConfirmed: true
        });
    });

    it('requires per-source force confirmation before enabling sync confirm', async () => {
        controller.snapshot = snapshotWith();
        controller.startSyncResponse = syncResponse(snapshotWith(), {
            sourceId: 'core',
            eligibility: 'requires-force',
            forceRequired: true,
            confirmationMessage: 'Force update requires explicit confirmation.'
        });

        await emitChange(controller);
        await click('[data-testid="workspace-source-sync-core"]', widget.node);

        const confirmButton = widget.node.querySelector('[data-testid="workspace-source-sync-confirm"]') as HTMLButtonElement | null;
        expect(confirmButton?.disabled).toBe(true);

        await toggleCheckbox('[data-testid="workspace-source-sync-force-core"]', widget.node);
        expect(confirmButton?.disabled).toBe(false);

        await click('[data-testid="workspace-source-sync-confirm"]', widget.node);
        expect(controller.confirmWorkspaceSync).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            jobId: 'job-sync',
            trustConfirmed: true,
            forceSourceIds: ['core']
        });
    });
});

describe('WorkspaceSourcesContribution', () => {
    it('uses the existing toggle command and does not auto-open on startup', async () => {
        const controller = new WorkspaceSourcesControllerStub();
        const contribution = new WorkspaceSourcesContribution(controller as never);
        const openView = jest.spyOn(contribution, 'openView');

        expect(contribution.viewId).toBe('studio:workspace-sources');
        expect(contribution.defaultViewOptions.area).toBe('right');

        await contribution.onStart();
        expect(openView).not.toHaveBeenCalled();

        controller.emitOpenRequest();
        await flushMicrotasks();

        expect(openView).toHaveBeenCalledWith({ activate: true, reveal: true });
    });

    it('does not register a duplicate toggle command', () => {
        const controller = new WorkspaceSourcesControllerStub();
        const contribution = new WorkspaceSourcesContribution(controller as never);
        const commands = { registerCommand: jest.fn() };

        contribution.registerCommands(commands as never);

        expect(commands.registerCommand).not.toHaveBeenCalledWith(expect.objectContaining({ id: WorkspaceSourcesToggleCommand.id }));
    });
});

class WorkspaceSourcesControllerStub {
    snapshot: WorkspaceSnapshot | undefined;
    activity: WorkspaceActivityEvent | undefined;
    connected = true;
    renameResponses: WorkspaceConfigMutationResponse[] = [];
    readRawResponses: ReadWorkspaceRawTomlResponse[] = [];
    saveRawResponse: WorkspaceConfigMutationResponse | undefined;
    startSyncResponse: WorkspaceSyncResponse | undefined;
    readonly changeEmitter = new Emitter<void>();
    readonly openEmitter = new Emitter<void>();
    readonly refresh = jest.fn(async () => undefined);
    readonly createWorkspaceConfig = jest.fn(async () => undefined);
    readonly scanWorkspaceSources = jest.fn(async () => undefined);
    readonly startWorkspaceSync = jest.fn(async () => this.startSyncResponse);
    readonly confirmWorkspaceSync = jest.fn(async () => undefined);
    readonly addWorkspaceSource = jest.fn(async () => undefined);
    readonly updateWorkspaceSource = jest.fn(async () => undefined);
    readonly removeWorkspaceSource = jest.fn(async () => undefined);
    readonly renameWorkspace = jest.fn(async () => this.renameResponses.shift());
    readonly readWorkspaceRawToml = jest.fn(async () => this.readRawResponses.shift());
    readonly saveWorkspaceRawToml = jest.fn(async () => this.saveRawResponse);
    readonly ignoreWorkspaceSuggestion = jest.fn(async () => undefined);

    onDidChange(listener: () => void): { dispose(): void } {
        return this.changeEmitter.event(listener);
    }

    onDidRequestOpenView(listener: () => void): { dispose(): void } {
        return this.openEmitter.event(listener);
    }

    getSnapshot(): WorkspaceSnapshot | undefined {
        return this.snapshot;
    }

    getActivity(): WorkspaceActivityEvent | undefined {
        return this.activity;
    }

    isConnected(): boolean {
        return this.connected;
    }

    emitChange(): void {
        this.changeEmitter.fire();
    }

    emitOpenRequest(): void {
        this.openEmitter.fire();
    }
}

function snapshotWith(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
    return {
        schemaVersion: 1,
        identity: {
            workspaceId: 'workspace-1',
            configPath: '/workspace/.cf-workspace.toml',
            configFileName: '.cf-workspace.toml'
        },
        config: {
            revision: 'rev-1',
            schemaVersion: 1,
            rawTomlAvailable: true,
            lastLoadedAt: '2026-07-29T08:00:00.000Z'
        },
        state: 'ready',
        configuredSources: [localSource('core', '/workspace/core')],
        observedSources: [{
            sourceId: 'core',
            status: 'present',
            syncEligibility: 'safe',
            isPresent: true,
            isDirty: false,
            isDiverged: false,
            isNested: false,
            hasBlockingIssue: false
        }],
        suggestions: [{
            suggestionId: 'suggestion-1',
            kind: 'containing-repository',
            candidateId: 'candidate-1',
            sourceId: 'core',
            label: 'core',
            localPath: '/workspace/core',
            rootPath: '/workspace/core',
            disposition: 'new',
            reason: 'Contains the opened root'
        }],
        latestScan: {
            requestId: 'scan-1',
            generatedAt: '2026-07-29T08:01:00.000Z',
            rootsScanned: ['.'],
            bounded: true,
            maxDepth: 3,
            maxEntries: 100,
            candidates: [{
                candidateId: 'candidate-1',
                label: 'core',
                localPath: '/workspace/core',
                rootPath: '/workspace/core',
                provider: 'github',
                remoteUrl: 'https://github.com/example/core.git',
                ignoredLocally: false
            }],
            diagnostics: []
        },
        jobs: [{
            jobId: 'job-1',
            kind: 'source-sync',
            state: 'running',
            phase: 'syncing-sources',
            startedAt: '2026-07-29T08:02:00.000Z',
            updatedAt: '2026-07-29T08:03:00.000Z'
        }],
        migration: {
            mode: 'canonical-active',
            status: 'completed',
            rollbackAvailable: false
        },
        diagnostics: [],
        ...overrides
    };
}

function localSource(sourceId: string, localPath: string): WorkspaceConfiguredSource {
    return {
        sourceId,
        label: sourceId,
        localPath,
        provider: 'local',
        configured: true,
        authoritative: true,
        include: 'member'
    };
}

function activityWith(): WorkspaceActivityEvent {
    return {
        schemaVersion: 1,
        eventId: 'job-1:2026-07-29T08:03:00.000Z',
        job: {
            jobId: 'job-1',
            kind: 'source-sync',
            state: 'running',
            phase: 'syncing-sources',
            startedAt: '2026-07-29T08:02:00.000Z',
            updatedAt: '2026-07-29T08:03:00.000Z'
        },
        snapshotRevision: 'rev-1'
    };
}

function rawTomlResponse(revision: string, rawToml: string): ReadWorkspaceRawTomlResponse {
    return {
        schemaVersion: 1,
        configPath: '/workspace/.cf-workspace.toml',
        revision,
        rawToml,
        diagnostics: []
    };
}

function syncResponse(
    snapshot: WorkspaceSnapshot,
    preview: {
        sourceId: string;
        eligibility: 'requires-trust' | 'requires-force';
        forceRequired: boolean;
        confirmationMessage: string;
    }
): WorkspaceSyncResponse {
    return {
        schemaVersion: 1,
        snapshot,
        job: {
            jobId: 'job-sync',
            kind: 'source-sync',
            state: 'awaiting-confirmation',
            phase: 'awaiting-confirmation',
            startedAt: '2026-07-29T09:00:00.000Z',
            updatedAt: '2026-07-29T09:00:00.000Z',
            preview: {
                jobId: 'job-sync',
                requiresConfirmation: true,
                saveConfig: false,
                impactedSourceIds: [preview.sourceId],
                reasons: [preview.confirmationMessage]
            },
            sourcePreviews: [{
                sourceId: preview.sourceId,
                status: 'present',
                eligibility: preview.eligibility,
                forceRequired: preview.forceRequired,
                confirmationMessage: preview.confirmationMessage
            }]
        }
    };
}

async function emitChange(controller: WorkspaceSourcesControllerStub): Promise<void> {
    await React.act(async () => {
        controller.emitChange();
        MessageLoop.flush();
    });
}

async function click(selector: string, root: ParentNode): Promise<void> {
    const element = root.querySelector(selector) as HTMLButtonElement | null;
    expect(element).toBeTruthy();
    await React.act(async () => {
        element?.click();
        await flushMicrotasks();
        MessageLoop.flush();
    });
}

async function setInputValue(selector: string, root: ParentNode, value: string): Promise<void> {
    const element = root.querySelector(selector) as HTMLInputElement | null;
    expect(element).toBeTruthy();
    await React.act(async () => {
        if (element) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await flushMicrotasks();
        MessageLoop.flush();
    });
}

async function setTextareaValue(selector: string, root: ParentNode, value: string): Promise<void> {
    const element = root.querySelector(selector) as HTMLTextAreaElement | null;
    expect(element).toBeTruthy();
    await React.act(async () => {
        if (element) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await flushMicrotasks();
        MessageLoop.flush();
    });
}

async function setSelectValue(selector: string, root: ParentNode, value: string): Promise<void> {
    const element = root.querySelector(selector) as HTMLSelectElement | null;
    expect(element).toBeTruthy();
    await React.act(async () => {
        if (element) {
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            setter?.call(element, value);
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await flushMicrotasks();
        MessageLoop.flush();
    });
}

async function toggleCheckbox(selector: string, root: ParentNode): Promise<void> {
    const element = root.querySelector(selector) as HTMLInputElement | null;
    expect(element).toBeTruthy();
    await React.act(async () => {
        if (element) {
            element.click();
        }
        await flushMicrotasks();
        MessageLoop.flush();
    });
}

function text(root: ParentNode, selector: string): string {
    return root.querySelector(selector)?.textContent ?? '';
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
