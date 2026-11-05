import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class WorkspaceService {} }));
jest.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
jest.mock('@theia/markers/lib/browser/problem/problem-manager', () => ({ ProblemManager: class ProblemManager {} }));
jest.mock('@theia/core/lib/browser/shell/application-shell', () => ({ ApplicationShell: class ApplicationShell {} }));
jest.mock('@theia/core/lib/browser/opener-service', () => ({ OpenerService: Symbol('OpenerService'), open: jest.fn(async () => undefined) }));
import { Emitter } from '@theia/core/lib/common/event';
import URI from '@theia/core/lib/common/uri';
import { open } from '@theia/core/lib/browser/opener-service';
import { DesktopDomainModelController, DOMAIN_MODEL_MARKER_OWNER, sideKey } from './desktop-domain-model-controller';
import type { AnalyzeScope } from './analyze-studio-client';
import type { DomainModel, DomainModelFinding } from '../common/desktop-domain-model';

const ROOT = new URI('file:///work/shop');
const DOC = 'An order has one customer.\n\nAn order is paid once.\n';

const MODEL: DomainModel = {
    build: { running: false, documents: 2, done: 2, candidates: 1, judged: 1, finished_at: 'now' },
    documents: [
        { path: 'docs/orders.md', revision: 'abc12345', state: 'extracted', facts: 2, dropped: 0 },
        { path: 'docs/pay.md', revision: 'abc12345', state: 'extracted', facts: 1, dropped: 0 },
    ],
    facts: [],
};

const TWO_VALUES: DomainModelFinding = {
    fingerprint: 'two-values',
    rule: 'contradiction.value',
    severity: 'high',
    message: 'One customer or many?',
    sides: [
        { path: 'docs/orders.md', line_start: 1, quote: 'An order has one customer.' },
        { path: 'docs/pay.md', line_start: 9, quote: 'An order has many customers.' },
    ],
    decide: [],
};

const DISMISSED: DomainModelFinding = {
    ...TWO_VALUES, fingerprint: 'dismissed', severity: 'low', decision: 'dismissed',
    sides: [{ path: 'docs/orders.md', line_start: 3, quote: 'An order is paid once.' }],
};

/** The project folder: `docs/orders.md` at its root, `docs/pay.md` in a
 *  repository's own folder, as a project with two repositories is cloned. */
const FILES = new Map<string, string>([
    [ROOT.resolve('docs/orders.md').toString(), DOC],
    [ROOT.resolve('backend/docs/pay.md').toString(), 'Payments.\nAn order has several customers now.\n'],
]);

/** Every controller made, stopped after each test so no marker timer outlives it. */
const made: DesktopDomainModelController[] = [];

function setup({ scope = { kind: 'project', workspaceId: 'ws', projectId: 'p' } as AnalyzeScope | null, findings = [TWO_VALUES, DISMISSED] } = {}) {
    const controller = new DesktopDomainModelController();
    made.push(controller);
    const changes = new Emitter<{ contains(uri: URI): boolean }>();
    const client = {
        model: jest.fn(async () => MODEL),
        findings: jest.fn(async () => findings),
        glossary: jest.fn(async () => []),
        startBuild: jest.fn(async () => ({ ...MODEL.build, running: true })),
        decide: jest.fn(async () => ({})),
    };
    const problems = { setMarkers: jest.fn() };
    const messages = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let inFront: unknown;
    const shell = { getCurrentWidget: () => inFront, onDidChangeCurrentWidget: new Emitter<void>().event };
    Object.assign(controller, {
        client,
        studio: { scope: jest.fn(async () => scope ?? undefined) },
        workspace: { roots: Promise.resolve([{ resource: ROOT }]), onWorkspaceChanged: new Emitter<void>().event },
        files: {
            exists: async (uri: URI) => FILES.has(uri.toString()),
            read: async (uri: URI) => ({ value: FILES.get(uri.toString()) ?? '' }),
            resolve: async () => ({ children: [{ isDirectory: true, name: 'backend', resource: ROOT.resolve('backend') }, { isDirectory: true, name: '.git', resource: ROOT.resolve('.git') }] }),
            onDidFilesChange: changes.event,
        },
        openers: {},
        shell,
        problems,
        messages,
    });
    return {
        controller, client, problems, messages,
        show: (uri: URI) => { inFront = { getResourceUri: () => uri, createMoveToUri: () => uri }; },
    };
}

/** The markers the controller set last on `path` under the project root. */
function markersOn(problems: { setMarkers: jest.Mock }, path: string): { message: string; range: unknown; severity: number }[] {
    const calls = problems.setMarkers.mock.calls.filter(([uri, owner]) => owner === DOMAIN_MODEL_MARKER_OWNER && uri.toString() === ROOT.resolve(path).toString());
    return calls.length ? calls[calls.length - 1][2] : [];
}

describe('DesktopDomainModelController', () => {
    beforeEach(() => (open as jest.Mock).mockClear());
    afterEach(() => made.splice(0).forEach(controller => controller.onStop()));

    it('says so when the window has no Studio project open', async () => {
        const { controller, client } = setup({ scope: null });
        await controller.refresh();
        expect(controller.getState().status).toBe('no-project');
        expect(client.model).not.toHaveBeenCalled();
    });

    it('takes the one project of a workspace opened whole, and no project of several', async () => {
        const one = setup({ scope: { kind: 'workspace', workspaceId: 'ws', projectIds: ['only'] } });
        await one.controller.refresh();
        expect(one.client.model).toHaveBeenCalledWith('only');
        const many = setup({ scope: { kind: 'workspace', workspaceId: 'ws', projectIds: ['a', 'b'] } });
        await many.controller.refresh();
        expect(many.controller.getState().status).toBe('no-project');
    });

    it('reads the project\'s model, findings and glossary', async () => {
        const { controller } = setup();
        await controller.refresh();
        expect(controller.getState()).toEqual(expect.objectContaining({ status: 'ready', projectId: 'p', workspaceId: 'ws', model: MODEL }));
        expect(controller.getState().findings).toHaveLength(2);
    });

    it('says what went wrong instead of a model', async () => {
        const { controller, client } = setup();
        client.model.mockRejectedValueOnce(new Error('offline'));
        await controller.refresh();
        expect(controller.getState()).toEqual(expect.objectContaining({ status: 'error', error: 'offline' }));
    });

    it('marks each finding where its quote is in the file here, also in a repository\'s folder, and notes a passage edited since', async () => {
        const { controller, problems } = setup();
        await controller.refresh();
        await (controller as unknown as { publishMarkers(): Promise<void> }).publishMarkers();
        const orders = markersOn(problems, 'docs/orders.md');
        expect(orders).toEqual([expect.objectContaining({
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 26 } },
            severity: 2,
            source: 'Domain model',
            message: 'Two values: One customer or many? — also docs/pay.md:9',
        })]);
        // The other side was edited on this machine since the model read it:
        // no marker on a stale line, and the view is told.
        expect(markersOn(problems, 'backend/docs/pay.md')).toEqual([]);
        const passages = controller.getState().passages!;
        expect(passages.get(sideKey(TWO_VALUES.sides[0]))).toBe('found');
        expect(passages.get(sideKey(TWO_VALUES.sides[1]))).toBe('gone');
        // The dismissed finding is located but not marked.
        expect(passages.get(sideKey(DISMISSED.sides[0]))).toBe('found');
    });

    it('clears the markers of a file no finding names any more', async () => {
        const { controller, problems, client } = setup();
        await controller.refresh();
        const publish = () => (controller as unknown as { publishMarkers(): Promise<void> }).publishMarkers();
        await publish();
        client.findings.mockResolvedValueOnce([]);
        await controller.refresh();
        await publish();
        expect(markersOn(problems, 'docs/orders.md')).toEqual([]);
    });

    it('sends a decision and shows it, and sends nothing for the decision already made', async () => {
        const { controller, client } = setup();
        await controller.refresh();
        await controller.decide(TWO_VALUES, 'confirmed');
        expect(client.decide).toHaveBeenCalledWith('p', 'two-values', 'confirmed');
        expect(controller.getState().findings.find(f => f.fingerprint === 'two-values')?.decision).toBe('confirmed');
        await controller.decide(DISMISSED, 'dismissed');
        expect(client.decide).toHaveBeenCalledTimes(1);
        expect(controller.getState().deciding).toBeUndefined();
    });

    it('opens a passage at its quote in the file here', async () => {
        const { controller } = setup();
        await controller.refresh();
        await controller.openSide(DISMISSED.sides[0]);
        const [, uri, options] = (open as jest.Mock).mock.calls[0];
        expect(uri.toString()).toBe(ROOT.resolve('docs/orders.md').toString());
        expect(options).toEqual(expect.objectContaining({ selection: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } } }));
    });

    it('finds the quote in the text of an editor that drops the selection, as Doc editing\'s does', async () => {
        const { controller } = setup();
        await controller.refresh();
        const node = document.createElement('div');
        node.innerHTML = '<div class="ProseMirror"><p>An order has one customer.</p><p>An order is <em>paid</em> once.</p></div>';
        document.body.appendChild(node);
        (open as jest.Mock).mockResolvedValueOnce({ node });
        await controller.openSide(DISMISSED.sides[0]);
        expect(document.getSelection()?.toString()).toBe('An order is paid once.');
        node.remove();
    });

    it('opens a file whose passage is gone at its top, and says why', async () => {
        const { controller, messages } = setup();
        await controller.refresh();
        await controller.openSide(TWO_VALUES.sides[1]);
        expect((open as jest.Mock).mock.calls[0][2]).toBeUndefined();
        expect(messages.info).toHaveBeenCalledWith(expect.stringMatching(/not in the file any more/));
    });

    it('opens a Studio-held document as one, and says when a file is not here', async () => {
        const { controller, messages } = setup();
        await controller.refresh();
        await controller.openSide({ path: 'studio:doc-1' });
        expect(String((open as jest.Mock).mock.calls[0][1])).toMatch(/^studio-doc:\/ws\/doc-1\//);
        await controller.openSide({ path: 'docs/missing.md' });
        expect(messages.warn).toHaveBeenCalledWith('docs/missing.md is not in the folder this window has open.');
    });

    it('names the document in front by its path in the model', async () => {
        const { controller, show } = setup();
        show(ROOT.resolve('docs/orders.md'));
        await controller.refresh();
        expect(controller.getState().current).toEqual(expect.objectContaining({ label: 'orders.md', modelPath: 'docs/orders.md' }));
        show(ROOT.resolve('notes/todo.md'));
        await (controller as unknown as { followCurrent(): Promise<void> }).followCurrent();
        expect(controller.getState().current).toEqual(expect.objectContaining({ label: 'todo.md', modelPath: undefined }));
    });

    it('builds on the member\'s key and follows the build until it ends', async () => {
        jest.useFakeTimers();
        try {
            const { controller, client } = setup();
            await controller.refresh();
            await controller.build('docs/orders.md');
            expect(client.startBuild).toHaveBeenCalledWith('p', 'docs/orders.md');
            expect(controller.getState().model?.build.running).toBe(true);
            await jest.advanceTimersByTimeAsync(3000);
            // The build ended: the whole model is read again, findings with it.
            expect(client.findings).toHaveBeenCalledTimes(2);
            expect(controller.getState().model?.build.running).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    it('says why a build was refused', async () => {
        const { controller, client, messages } = setup();
        await controller.refresh();
        client.startBuild.mockRejectedValueOnce(new Error('No model key'));
        await controller.build();
        expect(messages.error).toHaveBeenCalledWith('The domain model was not built: No model key');
    });
});
