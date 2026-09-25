import 'reflect-metadata';
jest.mock('@theia/editor/lib/browser/editor-manager', () => ({
    EditorManager: class EditorManager {}
}));
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class WorkspaceService {}
}));
import * as React from '@theia/core/shared/react';
import { Container } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Emitter } from '@theia/core/lib/common';
import type { AnalyzeFrontendController, AnalyzeViewModel } from './analyze-controller';
import { AnalyzeWidget } from './analyze-widget';
import { buildMetrics } from './analyze-metrics';

describe('AnalyzeWidget', () => {
    const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousReactActEnvironment: boolean | undefined;

    beforeAll(() => {
        previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
    });

    it('shows each recorded metric with its score, level, meaning and when it was recorded', () => {
        const controller = createController(readyModel());
        const widget = mountWidget(controller);

        const purpose = widget.node.querySelector('[data-testid="analyze-metric-purpose"]');
        expect(purpose?.textContent).toContain('Purpose');
        expect(purpose?.textContent).toContain('86%');
        expect(purpose?.textContent).toContain('Good');
        expect(purpose?.textContent).toContain('how much of it reads as specification');
        expect(widget.node.querySelector('[data-testid="analyze-recorded-purpose"]')?.textContent).toContain('Recorded');
        expect(purpose?.getAttribute('aria-label')).toContain('Purpose: 86% (Good)');

        const leak = widget.node.querySelector('[data-testid="analyze-metric-leak"]');
        expect(leak?.textContent).toContain('30%');
        expect(leak?.textContent).toContain('Risk');
        expect(leak?.textContent).toContain('Lower is better');
        expect(widget.node.textContent).toContain('docs/prd.md');
        expect(widget.node.textContent).toContain('Type: prd');

        disposeWidget(widget);
    });

    it('says "not analysed yet" and shows no number for a metric nobody has measured', () => {
        const controller = createController(readyModel());
        const widget = mountWidget(controller);

        const bloat = widget.node.querySelector('[data-testid="analyze-metric-bloat"]');
        expect(bloat?.textContent).toContain('Not analysed yet.');
        expect(bloat?.className).toContain('studio-analyze__metric--pending');
        expect(widget.node.querySelector('[data-testid="analyze-score-bloat"]')).toBeNull();
        expect(bloat?.textContent).not.toMatch(/\d+%/);
        expect(bloat?.querySelector('.studio-analyze__metric-level')).toBeNull();

        disposeWidget(widget);
    });

    it('has no trend chart and no token counter: there is no history, and no run reports its spend', () => {
        const controller = createController(readyModel());
        const widget = mountWidget(controller);

        expect(widget.node.innerHTML).not.toContain('analyze-trend-chart');
        expect(widget.node.innerHTML).not.toContain('analyze-token-usage');
        expect(widget.node.querySelector('svg')).toBeNull();
        expect(widget.node.textContent).not.toContain('Mock');

        disposeWidget(widget);
    });

    it('runs the analysis from the button, and disables it while a run is in flight', () => {
        const controller = createController(readyModel());
        const widget = mountWidget(controller);

        const button = widget.node.querySelector('[data-testid="analyze-run"]') as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        React.act(() => {
            button.click();
            MessageLoop.flush();
        });
        expect(controller.analyze).toHaveBeenCalledTimes(1);

        React.act(() => {
            controller.setViewModel({ ...readyModel(), status: 'running', canAnalyze: false, progress: 'Purpose: 1/1 · prd.md · Leak: queued' });
            MessageLoop.flush();
        });
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('Analyzing…');
        expect(widget.node.querySelector('[data-testid="analyze-progress"]')?.textContent).toBe('Purpose: 1/1 · prd.md · Leak: queued');

        React.act(() => {
            controller.setViewModel({ ...readyModel(), note: 'Analysed the text on screen: Purpose, Leak.' });
            MessageLoop.flush();
        });
        expect(widget.node.querySelector('[data-testid="analyze-note"]')?.textContent).toBe('Analysed the text on screen: Purpose, Leak.');

        disposeWidget(widget);
    });

    it('marks results the editor has moved past', () => {
        const controller = createController({ ...readyModel(), status: 'stale' });
        const widget = mountWidget(controller);

        expect(widget.node.querySelector('[data-testid="analyze-status"]')?.textContent).toBe('Edited');
        expect(widget.node.textContent).toContain('Analyze checks the text on screen');

        disposeWidget(widget);
    });

    it('says plainly when Studio does not know the file, with nothing to run', () => {
        const controller = createController({
            status: 'unknown',
            documentUri: 'file:///workspace/notes.md',
            documentLabel: 'notes.md',
            message: 'This file is not a spec Studio knows yet — give it a type on the portal\'s Specs tab.',
            canAnalyze: false,
            metrics: [],
        });
        const widget = mountWidget(controller);

        expect(widget.node.querySelector('[data-testid="analyze-message"]')?.textContent).toContain('not a spec Studio knows yet');
        expect((widget.node.querySelector('[data-testid="analyze-run"]') as HTMLButtonElement).disabled).toBe(true);
        expect(widget.node.querySelector('[data-testid^="analyze-metric-"]')).toBeNull();

        disposeWidget(widget);
    });

    it('renders an honest empty state without an active document', () => {
        const controller = createController({
            status: 'empty',
            emptyStateTitle: 'No active document',
            emptyStateDescription: 'Open a specification to see what Studio knows about it.',
            canAnalyze: false,
            metrics: [],
        });
        const widget = mountWidget(controller);

        expect(widget.node.innerHTML).toContain('data-testid="analyze-empty-state"');
        expect(widget.node.textContent).toContain('No active document');
        expect(widget.node.querySelector('[data-testid="analyze-status"]')).toBeNull();

        disposeWidget(widget);
    });
});

function readyModel(): AnalyzeViewModel {
    return {
        status: 'ready',
        documentUri: 'file:///workspace/api/docs/prd.md',
        documentLabel: 'prd.md',
        knownAs: 'docs/prd.md',
        typeKey: 'prd',
        canAnalyze: true,
        metrics: buildMetrics({
            typeKey: 'prd',
            conformance: {
                conforms: true,
                sections: [{ key: 'goals', title: 'Goals', present: true, required: true, ok: true }],
                issues: [],
                checkedAt: '2026-09-20T10:00:00Z',
            },
            findings: [
                { detector: 'purpose', subject: 'node-1', score: 0.86, summary: 'purpose: prd (86% specification)', recordedAt: '2026-09-24T08:00:00Z' },
                { detector: 'leak', subject: 'node-1', score: 0.3, severity: 'high', recordedAt: '2026-09-24T08:00:00Z' },
            ],
        }),
    };
}

function mountWidget(controller: ReturnType<typeof createController>): AnalyzeWidget {
    const container = new Container();
    container.bind(AnalyzeWidget).toSelf();
    container.bind(require('./analyze-controller').AnalyzeFrontendController).toConstantValue(controller as never);
    let widget: AnalyzeWidget;
    React.act(() => {
        widget = container.resolve(AnalyzeWidget);
        document.body.appendChild(widget!.node);
        widget!.update();
        MessageLoop.flush();
    });
    return widget!;
}

function disposeWidget(widget: AnalyzeWidget): void {
    React.act(() => {
        widget.node.remove();
        widget.dispose();
        MessageLoop.flush();
    });
}

function createController(initialViewModel: AnalyzeViewModel) {
    const onDidChangeEmitter = new Emitter<void>();
    let viewModel = initialViewModel;
    return {
        analyze: jest.fn().mockResolvedValue(undefined),
        onDidChange: onDidChangeEmitter.event,
        getViewModel: () => viewModel,
        setViewModel: (next: AnalyzeViewModel) => {
            viewModel = next;
            onDidChangeEmitter.fire();
        }
    } as unknown as AnalyzeFrontendController & { analyze: jest.Mock; setViewModel(next: AnalyzeViewModel): void };
}
