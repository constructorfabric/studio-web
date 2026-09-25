import 'reflect-metadata';
jest.mock('@theia/core/lib/browser', () => ({
    ApplicationShell: class ApplicationShell {}
}));
jest.mock('@theia/editor/lib/browser/editor-manager', () => ({
    EditorManager: class EditorManager {}
}));
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class WorkspaceService {}
}));
import URI from '@theia/core/lib/common/uri';
import { Emitter } from '@theia/core/lib/common';
import type { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor, TextDocumentChangeEvent } from '@theia/editor/lib/browser/editor';
import { ANALYZE_WIDGET_ID, AnalyzeFrontendController, AnalyzeViewModel, findingFor } from './analyze-controller';
import type { AnalyzeScope, AnalyzeStudioClient, DocumentBinding, FindingToSave, TaskRun } from './analyze-studio-client';
import type { ConformanceReport } from './analyze-metrics';
import { studioDocumentUri } from '../common/studio-document-uri';

const PRD = binding('b-prd', 'docs/prd.md', {
    type_key: 'prd',
    validation: {
        conforms: false,
        sections: [
            { key: 'goals', title: 'Goals', present: true, required: true, ok: true },
            { key: 'risks', title: 'Risks', present: false, required: true, ok: false },
        ],
        issues: [],
    },
    updated_at: '2026-09-20T10:00:00Z',
});
const ADR = binding('b-adr', 'docs/adr.md', { type_key: 'adr' });
const UNTYPED = binding('b-notes', 'notes.md', { type_key: null, state: 'unknown' });
const PROJECT: AnalyzeScope = { kind: 'project', workspaceId: 'ws-1', projectId: 'p-1' };

describe('AnalyzeFrontendController', () => {
    it('finds a repository file\'s binding by path and shows what Studio recorded, spending nothing', async () => {
        const studio = createStudio();
        studio.findings.mockResolvedValue([
            { detector: 'purpose', subject: 'node-b-prd', score: 0.86, summary: 'purpose: prd (86% specification)', recordedAt: '2026-09-24T08:00:00Z' },
            { detector: 'leak', subject: 'node-b-prd', score: 0.3, severity: 'high', recordedAt: '2026-09-24T08:00:00Z' },
        ]);
        const { controller } = await start(studio, createEditor('file:///workspace/api/docs/prd.md'));

        const model = controller.getViewModel();
        expect(model).toMatchObject({ status: 'ready', knownAs: 'docs/prd.md', typeKey: 'prd', canAnalyze: true, documentLabel: 'prd.md' });
        expect(studio.bindings).toHaveBeenCalledWith('ws-1', 'p-1');
        expect(studio.findings).toHaveBeenCalledWith('p-1', 'node-b-prd');
        expect(studio.startRun).not.toHaveBeenCalled();

        const byKey = Object.fromEntries(model.metrics.map(metric => [metric.key, metric]));
        expect(byKey.conformance).toMatchObject({ scoreText: '50%', level: 'Attention', recordedAt: '2026-09-20T10:00:00Z' });
        expect(byKey.purpose).toMatchObject({ scoreText: '86%', level: 'Good', recordedAt: '2026-09-24T08:00:00Z' });
        expect(byKey.leak).toMatchObject({ scoreText: '30%', level: 'Risk' });
        expect(byKey.bloat).toMatchObject({ analysed: false, scoreText: undefined, interpretation: 'Not analysed yet.' });
        expect(byKey.traceability).toMatchObject({ analysed: false });
    });

    it('looks through a workspace session\'s projects for the one that knows the file', async () => {
        const studio = createStudio({ scope: { kind: 'workspace', workspaceId: 'ws-1', projectIds: ['p-a', 'p-b'] } });
        studio.bindings.mockImplementation(async (_ws: string, project: string) => project === 'p-b' ? [PRD] : [ADR]);
        const { controller } = await start(studio, createEditor('file:///workspace/docs/prd.md'));

        expect(controller.getViewModel().status).toBe('ready');
        expect(studio.findings).toHaveBeenCalledWith('p-b', 'node-b-prd');
    });

    it('says plainly that a file Studio has no binding for is not a spec it knows', async () => {
        const studio = createStudio();
        const { controller } = await start(studio, createEditor('file:///workspace/src/main.rs'));

        expect(controller.getViewModel()).toMatchObject({
            status: 'unknown',
            canAnalyze: false,
            message: 'This file is not a spec Studio knows yet — give it a type on the portal\'s Specs tab.',
            metrics: [],
        });
        expect(studio.findings).not.toHaveBeenCalled();
    });

    it('says so, without an error, when the window knows no Studio project', async () => {
        const studio = createStudio({ scope: undefined });
        const { controller } = await start(studio, createEditor('file:///workspace/docs/prd.md'));

        const model = controller.getViewModel();
        expect(model.status).toBe('unknown');
        expect(model.message).toContain('not connected to a Studio project');
        expect(studio.bindings).not.toHaveBeenCalled();
    });

    it('reports Studio being unreachable as that, not as a verdict', async () => {
        const studio = createStudio();
        studio.bindings.mockRejectedValue(new Error('HTTP 502'));
        const { controller } = await start(studio, createEditor('file:///workspace/docs/prd.md'));

        expect(controller.getViewModel()).toMatchObject({ status: 'error', canAnalyze: false, metrics: [] });
        expect(controller.getViewModel().message).toContain('HTTP 502');
    });

    it('reads a document written in Studio under studio-doc:<id>, with its template check', async () => {
        const studio = createStudio();
        studio.studioDocument.mockResolvedValue({ id: 'd-1', project_id: 'p-7', type_key: 'adr', title: 'Roles over tenant', updated_at: '2026-09-01T00:00:00Z' });
        studio.validateStudioDocument.mockResolvedValue({
            conforms: true,
            sections: [{ key: 'context', title: 'Context', present: true, required: true, ok: true }],
            issues: [],
        });
        const uri = studioDocumentUri({ workspaceId: 'ws-1', documentId: 'd-1' }, 'Roles over tenant').toString();
        const { controller } = await start(studio, createEditor(uri));

        expect(studio.studioDocument).toHaveBeenCalledWith('ws-1', 'd-1');
        expect(studio.validateStudioDocument).toHaveBeenCalledWith('ws-1', 'd-1');
        expect(studio.findings).toHaveBeenCalledWith('p-7', 'studio-doc:d-1');
        expect(studio.bindings).not.toHaveBeenCalled();
        const model = controller.getViewModel();
        expect(model).toMatchObject({ status: 'ready', knownAs: 'Roles over tenant', typeKey: 'adr' });
        expect(model.metrics[0]).toMatchObject({ key: 'conformance', level: 'Good', scoreText: '100%' });
    });

    it('analyses a workspace-level Studio document in the project the window is', async () => {
        const studio = createStudio();
        studio.studioDocument.mockResolvedValue({ id: 'd-2', project_id: null, type_key: 'prd', title: 'Shared', updated_at: '' });
        const uri = studioDocumentUri({ workspaceId: 'ws-1', documentId: 'd-2' }, 'Shared').toString();
        const { controller } = await start(studio, createEditor(uri));

        expect(controller.getViewModel().status).toBe('ready');
        expect(studio.findings).toHaveBeenCalledWith('p-1', 'studio-doc:d-2');
    });

    it('says why a workspace-level Studio document has nowhere to keep findings outside a project', async () => {
        const studio = createStudio({ scope: undefined });
        studio.studioDocument.mockResolvedValue({ id: 'd-2', project_id: null, type_key: 'prd', title: 'Shared', updated_at: '' });
        const uri = studioDocumentUri({ workspaceId: 'ws-1', documentId: 'd-2' }, 'Shared').toString();
        const { controller } = await start(studio, createEditor(uri));

        expect(controller.getViewModel().status).toBe('unknown');
        expect(controller.getViewModel().message).toContain('open it from a project');
    });

    it('says a Studio document that is gone is gone', async () => {
        const studio = createStudio();
        studio.studioDocument.mockResolvedValue(undefined);
        const uri = studioDocumentUri({ workspaceId: 'ws-1', documentId: 'gone' }, 'Old').toString();
        const { controller } = await start(studio, createEditor(uri));

        expect(controller.getViewModel()).toMatchObject({ status: 'unknown', message: 'Studio has no such document any more.' });
    });

    it('runs Spec Quality on the text on screen, records it against the file\'s node, and reads the metrics again', async () => {
        const studio = createStudio();
        const editor = createEditor('file:///workspace/api/docs/prd.md', '# PRD\n\nSaved text.');
        const { controller } = await start(studio, editor);

        // An unsaved edit: the server's checkout has the saved text only.
        editor.setText('# PRD\n\nUnsaved text on screen.');
        editor.changeEvents.fire(changeEvent(editor));
        expect(controller.getViewModel().status).toBe('stale');

        const seen: AnalyzeViewModel[] = [];
        controller.onDidChange(() => seen.push(controller.getViewModel()));
        studio.findings.mockResolvedValue([
            { detector: 'purpose', subject: 'node-b-prd', score: 0.9, recordedAt: '2026-09-25T09:00:00Z' },
        ]);
        await controller.analyze();

        // Four detectors: purpose and leak on this document alone, bloat and
        // traceability over the project's other typed documents.
        const started = studio.startRun.mock.calls.map(call => call[2]);
        expect(started).toEqual(['purpose', 'leak', 'bloat', 'traceability']);
        const inline = { path: 'docs/prd.md', text: '# PRD\n\nUnsaved text on screen.', type_key: 'prd' };
        expect(studio.startRun).toHaveBeenCalledWith('ws-1', 'p-1', 'purpose', { binding_ids: [], documents: [inline] });
        expect(studio.startRun).toHaveBeenCalledWith('ws-1', 'p-1', 'bloat', { binding_ids: ['b-adr'], documents: [inline] });
        expect(studio.verdict).toHaveBeenCalledWith('task-purpose', 'purpose', []);
        expect(studio.verdict).toHaveBeenCalledWith('task-bloat', 'bloat', ['docs/prd.md', 'docs/adr.md']);

        expect(studio.saveFindings).toHaveBeenCalledTimes(1);
        const [findings, workspaceId, projectId] = studio.saveFindings.mock.calls[0];
        expect([workspaceId, projectId]).toEqual(['ws-1', 'p-1']);
        expect(findings.map((f: { detector: string }) => f.detector)).toEqual(['purpose', 'leak', 'bloat', 'traceability']);
        expect(findings.every((f: { subject: string; path: string }) => f.subject === 'node-b-prd' && f.path === 'docs/prd.md')).toBe(true);
        expect(findings[3]).toMatchObject({ details: { references: ['docs/adr.md'], referenced_by: ['docs/adr.md'] } });
        expect(studio.recordBindingAnalysis).toHaveBeenCalledWith('ws-1', 'b-prd', 'purpose', expect.objectContaining({ state: 'passed', task_id: 'task-purpose' }));

        expect(seen.some(model => model.status === 'running' && !model.canAnalyze)).toBe(true);
        expect(seen.some(model => model.progress?.includes('Purpose: done'))).toBe(true);
        expect(studio.invalidate).toHaveBeenCalledWith('ws-1', 'p-1');
        const after = controller.getViewModel();
        expect(after.status).toBe('ready');
        expect(after.note).toBe('Analysed the text on screen: Purpose, Leak, Bloat, Traceability.');
        expect(after.metrics.find(metric => metric.key === 'purpose')).toMatchObject({ scoreText: '90%', recordedAt: '2026-09-25T09:00:00Z' });
    });

    it('asks only what a document can answer: no leak without a type, no set detectors without another document', async () => {
        const studio = createStudio({ bindings: [UNTYPED] });
        const { controller } = await start(studio, createEditor('file:///workspace/notes.md', 'Some notes.'));

        await controller.analyze();

        expect(studio.startRun.mock.calls.map(call => call[2])).toEqual(['purpose']);
        expect(studio.startRun).toHaveBeenCalledWith('ws-1', 'p-1', 'purpose', { binding_ids: [], documents: [{ path: 'notes.md', text: 'Some notes.' }] });
        const note = controller.getViewModel().note ?? '';
        expect(note).toContain('Leak needs a type');
        expect(note).toContain('the project has no other typed one');
    });

    it('records a Studio document\'s run under studio-doc:<id> and keeps no binding gate for it', async () => {
        const studio = createStudio();
        studio.studioDocument.mockResolvedValue({ id: 'd-1', project_id: 'p-1', type_key: 'adr', title: 'Roles', updated_at: '' });
        const uri = studioDocumentUri({ workspaceId: 'ws-1', documentId: 'd-1' }, 'Roles').toString();
        const { controller } = await start(studio, createEditor(uri, '# Roles\n\nOn screen.'));

        await controller.analyze();

        expect(studio.startRun).toHaveBeenCalledWith('ws-1', 'p-1', 'purpose', {
            binding_ids: [],
            documents: [{ path: 'studio-doc/d-1.md', text: '# Roles\n\nOn screen.', type_key: 'adr' }],
        });
        // Every typed repository document is the set it is compared with.
        expect(studio.startRun).toHaveBeenCalledWith('ws-1', 'p-1', 'bloat', expect.objectContaining({ binding_ids: ['b-prd', 'b-adr'] }));
        const [findings] = studio.saveFindings.mock.calls[0];
        expect(findings.every((f: { subject: string }) => f.subject === 'studio-doc:d-1')).toBe(true);
        expect(studio.recordBindingAnalysis).not.toHaveBeenCalled();
    });

    it('says which detector failed and why, and records the ones that finished', async () => {
        const studio = createStudio();
        studio.run.mockImplementation(async (runId: string): Promise<TaskRun> => runId === 'run-leak'
            ? { id: runId, state: 'failed', last_error: 'Spec Quality does not analyse `prd` documents' }
            : succeeded(runId));
        studio.startRun.mockImplementation(async (_ws: string, _p: string, detector: string) => {
            if (detector === 'traceability') {
                throw new Error('documents cannot be analysed in this deployment');
            }
            return { run_id: `run-${detector}` };
        });
        const { controller } = await start(studio, createEditor('file:///workspace/docs/prd.md', '# PRD'));

        await controller.analyze();

        const note = controller.getViewModel().note ?? '';
        expect(note).toContain('Analysed the text on screen: Purpose, Bloat.');
        expect(note).toContain('Leak: Spec Quality does not analyse `prd` documents');
        expect(note).toContain('Traceability: documents cannot be analysed in this deployment');
        expect(studio.saveFindings.mock.calls[0][0].map((f: { detector: string }) => f.detector)).toEqual(['purpose', 'bloat']);
    });

    it('does not run a document it could not place', async () => {
        const studio = createStudio();
        const { controller } = await start(studio, createEditor('file:///workspace/src/main.rs'));
        await controller.analyze();
        expect(studio.startRun).not.toHaveBeenCalled();
    });

    it('reads the text of the Markdown editor from its snapshot, unsaved edits included', async () => {
        const studio = createStudio();
        const markdown = createMarkdownLikeWidget('file:///workspace/docs/prd.md', '# PRD\n\nTyped in the Markdown editor.');
        const { controller } = await start(studio, markdown.widget);

        expect(controller.getViewModel().status).toBe('ready');
        markdown.changeEvents.fire();
        expect(controller.getViewModel().status).toBe('stale');
        await controller.analyze();
        expect(studio.startRun.mock.calls[0][3].documents[0].text).toBe('# PRD\n\nTyped in the Markdown editor.');
    });

    it('shows empty for unrelated widgets but keeps the document while the Analyze panel itself is active', async () => {
        const studio = createStudio();
        const editor = createEditor('file:///workspace/docs/prd.md');
        const { controller, shell, activeWidgetEvents } = await start(studio, editor);

        shell.activeWidget = { id: ANALYZE_WIDGET_ID };
        activeWidgetEvents.fire();
        expect(controller.getViewModel().documentUri).toBe(editor.uri.toString());

        shell.activeWidget = { id: 'terminal' };
        activeWidgetEvents.fire();
        expect(controller.getViewModel()).toMatchObject({ status: 'empty', emptyStateTitle: 'No active document' });
    });

    it('never paints an older document\'s answer over a newer one', async () => {
        const studio = createStudio();
        let release: () => void = () => undefined;
        studio.bindings.mockImplementationOnce(() => new Promise(resolve => {
            release = () => resolve([PRD, ADR]);
        }));
        const first = createEditor('file:///workspace/docs/prd.md');
        const second = createEditor('file:///workspace/src/main.rs');
        const { controller, shell, activeWidgetEvents } = await start(studio, first, false);

        shell.activeWidget = second.editor;
        activeWidgetEvents.fire();
        await settle();
        release();
        await settle();

        expect(controller.getViewModel()).toMatchObject({ status: 'unknown', documentUri: second.uri.toString() });
    });

    /* The product's OWN Markdown editor is a plain Widget whose `editor` is a
       TipTap `Editor`. Reading `.document.uri` off whatever a widget calls
       `editor` threw on every activation of a Markdown tab. */
    it('leaves alone a widget whose "editor" is not a text editor', async () => {
        const studio = createStudio();
        const tiptapLike = { id: 'studio-md:file:///workspace/AGENTS.md', editor: { state: { doc: {} }, commands: {} } };
        const { controller } = await start(studio, tiptapLike);
        expect(controller.getViewModel().status).toBe('empty');
    });

    it('disposes editor subscriptions when switching editors and stopping', async () => {
        const studio = createStudio();
        const first = createEditor('file:///workspace/docs/prd.md');
        const second = createEditor('file:///workspace/docs/adr.md');
        const { controller, shell, activeWidgetEvents, editorManager } = await start(studio, first);

        shell.activeWidget = second.editor;
        activeWidgetEvents.fire();
        expect(first.listenerDisposable.dispose).toHaveBeenCalledTimes(1);

        controller.onStop();
        expect(editorManager.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(shell.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(second.listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    });
});

describe('findingFor', () => {
    const target = {
        kind: 'repository' as const, workspaceId: 'ws', projectId: 'p', subject: 'node-1', runPath: 'docs/prd.md', knownAs: 'docs/prd.md',
    };

    it('writes purpose in the words the Specs tab reads', () => {
        expect(findingFor('purpose', target, { doc_type: 'prd', spec_share: 0.86, gate_passed: false })).toEqual({
            finding: {
                detector: 'purpose', subject: 'node-1', path: 'docs/prd.md', severity: 'gate-failed',
                summary: 'purpose: prd (86% specification)', score: 0.86,
                details: { doc_type: 'prd', spec_share: 0.86, gate_passed: false },
            },
            gate: 'failed',
        });
    });

    it('does not record an unreadable traceability answer as "references nothing"', () => {
        expect(findingFor('traceability', target, { recognised: false, by_path: {} })).toBeUndefined();
    });

    it('keeps which documents this one repeats', () => {
        expect(findingFor('bloat', target, { by_path: { 'docs/prd.md': ['docs/adr.md'] } })?.finding)
            .toMatchObject({ severity: 'high', score: 1, summary: 'bloat: repeats adr.md', details: { repeats: ['docs/adr.md'] } });
    });
});

function binding(id: string, path: string, extra: Partial<DocumentBinding> = {}): DocumentBinding {
    return { id, node_id: `node-${id}`, path, state: 'confirmed', type_key: 'prd', updated_at: '2026-09-20T00:00:00Z', ...extra };
}

function succeeded(runId: string, path = 'docs/prd.md'): TaskRun {
    const detector = runId.replace('run-', '');
    const set = detector === 'bloat' || detector === 'traceability';
    return {
        id: runId,
        state: 'succeeded',
        result: { items: [{ id: set ? 'p-1' : path, task_id: `task-${detector}`, status: 'succeeded' }] },
    };
}

function createStudio(options: { scope?: AnalyzeScope | undefined; bindings?: DocumentBinding[] } = {}) {
    const scope = 'scope' in options ? options.scope : PROJECT;
    const runPaths = new Map<string, string>();
    const studio = {
        scope: jest.fn(async () => scope),
        bindings: jest.fn(async (_ws: string, _project: string) => options.bindings ?? [PRD, ADR]),
        studioDocument: jest.fn(),
        validateStudioDocument: jest.fn(async (_ws: string, _id: string) => ({ conforms: true, sections: [] as ConformanceReport['sections'][number][], issues: [] as string[] })),
        findings: jest.fn(async (_project: string, _subject: string) => [] as unknown[]),
        invalidate: jest.fn(),
        startRun: jest.fn(async (_ws: string, _p: string, detector: string, _body: { binding_ids: string[]; documents: { path: string; text: string }[] }) =>
            ({ run_id: `run-${detector}` })),
        run: jest.fn(async (runId: string): Promise<TaskRun> => succeeded(runId)),
        verdict: jest.fn(async (_task: string, detector: string) => {
            switch (detector) {
                case 'purpose':
                    return { doc_type: 'prd', spec_share: 0.9, gate_passed: true };
                case 'leak':
                    return { passed: true, leak_share: 0.02, foreign_roles: [] };
                case 'bloat':
                    return { by_path: { 'docs/prd.md': [], 'docs/adr.md': [] } };
                default:
                    return { recognised: true, by_path: { 'docs/prd.md': ['docs/adr.md'], 'docs/adr.md': ['docs/prd.md'] } };
            }
        }),
        saveFindings: jest.fn(async (_findings: FindingToSave[], _ws: string, _project: string) => undefined),
        recordBindingAnalysis: jest.fn(async (_ws: string, _binding: string, _detector: string, _body: object) => undefined),
    };
    // The run echoes the inline document back under the path it was sent as.
    studio.startRun.mockImplementation(async (_ws, _p, detector, body) => {
        runPaths.set(`run-${detector}`, body.documents[0]?.path ?? "");
        return { run_id: `run-${detector}` };
    });
    studio.run.mockImplementation(async (runId: string) => succeeded(runId, runPaths.get(runId)));
    return studio;
}

async function start(studio: ReturnType<typeof createStudio>, active: unknown, wait = true) {
    const editorEvents = new Emitter<TextEditor | undefined>();
    const activeWidgetEvents = new Emitter<void>();
    const shell = createShell(activeWidgetEvents, active);
    const editorManager = createEditorManager(editorEvents, undefined);
    const controller = new AnalyzeFrontendController();
    Object.defineProperty(controller, 'editorManager', { value: editorManager as unknown as EditorManager });
    Object.defineProperty(controller, 'applicationShellProvider', { value: () => shell });
    Object.defineProperty(controller, 'studio', { value: studio as unknown as AnalyzeStudioClient });
    Object.defineProperty(controller, 'workspaceService', {
        value: { roots: Promise.resolve([{ resource: new URI('file:///workspace') }]) },
    });
    await controller.onStart();
    if (wait) {
        await settle();
    }
    return { controller, shell, activeWidgetEvents, editorManager };
}

/** Let the reads a document switch starts run to their end. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

function createShell(activeWidgetEvents: Emitter<void>, activeWidget: unknown) {
    const listenerDisposable = { dispose: jest.fn() };
    return {
        activeWidget,
        listenerDisposable,
        onDidChangeActiveWidget: jest.fn(listener => {
            const disposable = activeWidgetEvents.event(listener);
            return {
                dispose: jest.fn(() => {
                    disposable.dispose();
                    listenerDisposable.dispose();
                })
            };
        })
    };
}

function createEditorManager(editorEvents: Emitter<TextEditor | undefined>, currentEditor: TextEditor | undefined) {
    const listenerDisposable = { dispose: jest.fn() };
    return {
        currentEditor,
        listenerDisposable,
        onCurrentEditorChanged: jest.fn(listener => {
            const disposable = editorEvents.event(listener);
            return {
                dispose: jest.fn(() => {
                    disposable.dispose();
                    listenerDisposable.dispose();
                })
            };
        })
    };
}

function createEditor(uriString: string, initialText = '# Document') {
    const uri = new URI(uriString);
    const changeEvents = new Emitter<TextDocumentChangeEvent>();
    const listenerDisposable = { dispose: jest.fn() };
    let text = initialText;
    const document = {
        uri,
        getText: () => text,
        dispose: jest.fn()
    };
    const editor: Partial<TextEditor> = {
        uri,
        document: document as unknown as TextEditor['document'],
        onDocumentContentChanged: listener => {
            const disposable = changeEvents.event(listener);
            return {
                dispose: jest.fn(() => {
                    disposable.dispose();
                    listenerDisposable.dispose();
                })
            };
        }
    };
    return {
        uri,
        document,
        editor: editor as TextEditor,
        changeEvents,
        listenerDisposable,
        setText: (next: string) => {
            text = next;
        },
    };
}

function changeEvent(editor: ReturnType<typeof createEditor>): TextDocumentChangeEvent {
    return {
        document: editor.document as unknown as TextDocumentChangeEvent['document'],
        contentChanges: [{ range: undefined as never, rangeLength: 0, text: 'changed' }]
    };
}

function createMarkdownLikeWidget(uriString: string, text: string) {
    const uri = new URI(uriString);
    const changeEvents = new Emitter<void>();
    const saveable = {
        dirty: true,
        onDirtyChanged: jest.fn(() => ({ dispose: jest.fn() })),
        onContentChanged: changeEvents.event,
        createSnapshot: () => ({ value: text }),
    };
    return {
        uri,
        changeEvents,
        widget: {
            saveable,
            getResourceUri: () => uri,
            createMoveToUri: (resourceUri: URI) => resourceUri
        }
    };
}
