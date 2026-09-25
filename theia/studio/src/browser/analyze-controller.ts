// The Analyze panel's state: what Studio knows about the document in front of
// the person, and the run that asks Spec Quality about it again.
//
// Opening a document spends nothing. The panel reads what is already recorded
// — the type's template check, and the `spec_finding` nodes the last detector
// runs left in the artifact graph — and says "not analysed yet" for whatever
// nobody has measured. Only the Analyze button starts a detector.
//
// That run analyses the text ON SCREEN. The server has a checkout of its own,
// but it is the last sync's: an editor's unsaved changes, and everything a
// desktop app has changed locally, are not in it. So the panel sends the text
// with the request (`documents` on the quality route) under the path Studio
// knows the file by, and the verdicts are recorded against that file's node —
// exactly where the portal's Specs tab reads them.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { Navigatable } from '@theia/core/lib/browser/navigatable-types';
import { Saveable } from '@theia/core/lib/browser/saveable';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { DisposableCollection, Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextDocumentChangeEvent, TextEditor } from '@theia/editor/lib/browser/editor';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { parseStudioDocumentUri, StudioDocumentRef } from '../common/studio-document-uri';
import { AnalyzeMetric, ConformanceReport, buildMetrics } from './analyze-metrics';
import {
    AnalyzeStudioClient, DocumentBinding, FindingToSave, InlineDocument, SpecDetector, SpecVerdict, TaskRun,
    matchBindingByPath, pathCandidates,
} from './analyze-studio-client';

export type { AnalyzeMetric, AnalyzeMetricKey, AnalyzeMetricLevel } from './analyze-metrics';

/**
 * - `empty`: no document in front of the person.
 * - `loading`: reading what Studio knows about it.
 * - `unknown`: Studio does not know it, or the window cannot tell which
 *   project it is in; `message` says which, plainly.
 * - `ready`: the recorded metrics, about the text as it was when recorded.
 * - `stale`: the same, but the text has changed since the panel read them.
 * - `running`: Spec Quality is analysing the text on screen.
 * - `error`: Studio could not be reached; `message` says what it answered.
 */
export type AnalyzeStatus = 'empty' | 'loading' | 'unknown' | 'ready' | 'stale' | 'running' | 'error';

export interface AnalyzeViewModel {
    readonly status: AnalyzeStatus;
    readonly documentUri?: string;
    readonly documentLabel?: string;
    /** Which record the metrics are about: `docs/prd.md`, or the document's title. */
    readonly knownAs?: string;
    readonly typeKey?: string;
    readonly emptyStateTitle?: string;
    readonly emptyStateDescription?: string;
    /** Why there is nothing to show, or what went wrong. */
    readonly message?: string;
    /** What the last run did, once it is over. */
    readonly note?: string;
    /** What the run is doing, while it runs. */
    readonly progress?: string;
    readonly canAnalyze: boolean;
    readonly metrics: readonly AnalyzeMetric[];
}

/** What a document resolved to in Studio: where its findings live and what
 *  its run is called. */
export interface AnalyzeTarget {
    readonly kind: 'repository' | 'studio-document';
    readonly workspaceId: string;
    readonly projectId: string;
    /** The node its findings hang off: a file node id, or `studio-doc:<id>`. */
    readonly subject: string;
    /** The id the detector run reports it under. */
    readonly runPath: string;
    /** How the panel names it. */
    readonly knownAs: string;
    readonly typeKey?: string;
    readonly bindingId?: string;
    readonly conformance?: ConformanceReport;
    readonly conformanceMissing?: string;
}

type Resolved = { readonly ok: true; readonly target: AnalyzeTarget } | { readonly ok: false; readonly reason: string };

type EditorLike = {
    readonly uri?: { toString(): string };
    readonly document?: { uri?: { toString(): string }; getText?(): string };
    readonly onDocumentContentChanged?: (listener: (event: TextDocumentChangeEvent) => void) => { dispose(): void };
};

type WidgetLike = {
    readonly id?: string;
};

type DocumentLike = {
    readonly widget: unknown;
    readonly uri: string;
    readonly label: string;
    /** The text as it stands in the editor, saved or not. */
    readText(): string | undefined;
    onContentChanged(listener: () => void): { dispose(): void };
};

export interface AnalyzeApplicationShellLike {
    readonly activeWidget: unknown;
    onDidChangeActiveWidget(listener: () => void): { dispose(): void };
}

export const AnalyzeApplicationShellProvider = Symbol('AnalyzeApplicationShellProvider');
export type AnalyzeApplicationShellProvider = () => AnalyzeApplicationShellLike;

export const ANALYZE_WIDGET_ID = 'studio:analyze';

/** How often a run is asked how it is doing. A detector takes seconds to
 *  minutes per document; this is a person watching a panel, not a scheduler. */
export const RUN_POLL_MS = 1500;
/** When the panel stops watching. The run carries on server-side and its
 *  findings still land; the panel just says it stopped waiting. */
export const RUN_WATCH_BUDGET_MS = 20 * 60_000;

const NOT_A_SPEC = 'This file is not a spec Studio knows yet — give it a type on the portal\'s Specs tab.';
const NO_PROJECT = 'This window is not connected to a Studio project, so there is nothing recorded to show. ' +
    'Open the project from the portal, or from the Studio view in the desktop app.';

const DETECTOR_LABEL: Record<SpecDetector, string> = {
    purpose: 'Purpose',
    leak: 'Leak',
    bloat: 'Bloat',
    traceability: 'Traceability',
};

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

@injectable()
export class AnalyzeFrontendController implements FrontendApplicationContribution {
    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    @inject(AnalyzeApplicationShellProvider)
    protected readonly applicationShellProvider!: AnalyzeApplicationShellProvider;

    @inject(AnalyzeStudioClient)
    protected readonly studio!: AnalyzeStudioClient;

    // Optional: the panel still reads Studio documents in an application
    // without a workspace; it only cannot place repository files.
    @inject(WorkspaceService) @optional()
    protected readonly workspaceService: WorkspaceService | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    protected readonly toDispose = new DisposableCollection(this.onDidChangeEmitter);
    protected readonly editorListener = new DisposableCollection();
    protected documentListener = new DisposableCollection();
    protected currentDocument: DocumentLike | undefined;
    protected currentTarget: AnalyzeTarget | undefined;
    /** Bumped whenever the document in front changes; a read that finishes
     *  for an older one must not paint over the newer. */
    protected currentGeneration = 0;
    /** Documents edited since the panel last read or ran them. */
    protected readonly edited = new Set<string>();
    /** Runs in flight, by document, with what each last reported. */
    protected readonly running = new Map<string, { progress: string }>();
    /** What the last run said, by document, until it is next opened fresh. */
    protected readonly notes = new Map<string, string>();
    protected started = false;
    protected stopped = false;
    protected viewModel: AnalyzeViewModel = this.createEmptyViewModel();

    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    async onStart(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.stopped = false;
        this.toDispose.push(this.editorListener);
        this.toDispose.push(this.documentListener);
        this.editorListener.push(this.editorManager.onCurrentEditorChanged(() => this.syncActiveEditor()));
        this.editorListener.push(this.applicationShellProvider().onDidChangeActiveWidget(() => this.syncActiveEditor()));
        this.syncActiveEditor();
    }

    onStop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.currentGeneration += 1;
        this.toDispose.dispose();
    }

    getViewModel(): AnalyzeViewModel {
        return this.viewModel;
    }

    /** Read again what Studio knows about the document in front. */
    async refresh(): Promise<void> {
        const document = this.currentDocument;
        if (!document) {
            return;
        }
        const generation = ++this.currentGeneration;
        await this.load(document, generation);
    }

    /**
     * Send the text on screen to Spec Quality, record what it says, and read
     * the metrics again.
     *
     * `purpose` always; `leak` when the document has a type, because "foreign
     * content" means nothing until its native content is named. `bloat` and
     * `traceability` judge a set, so they run over the project's other typed
     * documents — read by the server — with this one's text in place of its
     * copy; only this document's findings are recorded, since the others were
     * judged on whatever the server held.
     */
    async analyze(): Promise<void> {
        const document = this.currentDocument;
        const target = this.currentTarget;
        if (!document || !target || this.running.has(document.uri)) {
            return;
        }
        const text = document.readText();
        if (text === undefined || !text.trim()) {
            this.notes.set(document.uri, 'There is no text to analyse yet.');
            this.publishTarget(document, target, this.viewModel.metrics);
            return;
        }
        const uri = document.uri;
        this.edited.delete(uri);
        this.notes.delete(uri);
        const state = { progress: 'Sending the text on screen to Spec Quality…' };
        this.running.set(uri, state);
        this.publishIfCurrent(uri);
        let note: string;
        try {
            note = await this.runDetectors(target, text, progress => {
                state.progress = progress;
                this.publishIfCurrent(uri);
            });
        } catch (error) {
            note = `Spec Quality could not analyse it: ${messageOf(error)}`;
        } finally {
            this.running.delete(uri);
        }
        this.notes.set(uri, note);
        this.studio.invalidate(target.workspaceId, target.projectId);
        if (!this.stopped && this.currentDocument?.uri === uri) {
            await this.refresh();
        }
    }

    protected async runDetectors(target: AnalyzeTarget, text: string, report: (progress: string) => void): Promise<string> {
        const inline: InlineDocument = {
            path: target.runPath,
            text,
            ...(target.typeKey ? { type_key: target.typeKey } : {}),
        };
        const skipped: string[] = [];
        const detectors: SpecDetector[] = ['purpose'];
        if (target.typeKey) {
            detectors.push('leak');
        } else {
            skipped.push('Leak needs a type to judge against — give it one on the portal\'s Specs tab.');
        }
        // The set: every other typed document of the project that the server
        // can read. A document written in Studio is not a binding, so it is
        // judged against the repository's specs.
        const others = (await this.studio.bindings(target.workspaceId, target.projectId))
            .filter(binding => binding.type_key && binding.id !== target.bindingId && binding.path !== target.runPath);
        if (others.length > 0) {
            detectors.push('bloat', 'traceability');
        } else {
            skipped.push('Bloat and traceability compare documents, and the project has no other typed one.');
        }

        const runs = new Map<SpecDetector, string>();
        const problems: string[] = [];
        for (const detector of detectors) {
            const set = detector === 'bloat' || detector === 'traceability';
            try {
                const started = await this.studio.startRun(target.workspaceId, target.projectId, detector, {
                    binding_ids: set ? others.map(binding => binding.id) : [],
                    documents: [inline],
                });
                runs.set(detector, started.run_id);
            } catch (error) {
                problems.push(`${DETECTOR_LABEL[detector]}: ${messageOf(error)}`);
            }
        }

        const finished = await this.watch(runs, report);
        const findings: FindingToSave[] = [];
        const gates: { detector: SpecDetector; state: 'pending' | 'passed' | 'failed'; taskId: string; summary: string }[] = [];
        const setPaths = [target.runPath, ...others.map(binding => binding.path)];
        for (const [detector, run] of finished) {
            if (!run) {
                problems.push(`${DETECTOR_LABEL[detector]}: still running when the panel stopped waiting; its result will be on the Specs tab.`);
                continue;
            }
            if (run.state !== 'succeeded') {
                problems.push(`${DETECTOR_LABEL[detector]}: ${run.last_error || run.state}`);
                continue;
            }
            const items = run.result?.items ?? [];
            const item = detector === 'bloat' || detector === 'traceability'
                ? items[0]
                : items.find(candidate => candidate.id === target.runPath);
            if (!item || item.status !== 'succeeded' || !item.task_id) {
                problems.push(`${DETECTOR_LABEL[detector]}: ${item?.error || 'the run reported nothing for this document'}`);
                continue;
            }
            const set = detector === 'bloat' || detector === 'traceability';
            const verdict = await this.studio.verdict(item.task_id, detector, set ? setPaths : []);
            const finding = findingFor(detector, target, verdict);
            if (!finding) {
                problems.push(`${DETECTOR_LABEL[detector]}: the result carried nothing this panel can read.`);
                continue;
            }
            findings.push(finding.finding);
            gates.push({ detector, state: finding.gate, taskId: item.task_id, summary: finding.finding.summary });
        }

        if (findings.length > 0) {
            report('Recording the results…');
            await this.studio.saveFindings(findings, target.workspaceId, target.projectId);
            // The pass/fail a stage gate reads. A document written in Studio
            // has no binding to keep one on, and losing the index is not worth
            // failing a run whose findings are already recorded.
            if (target.bindingId) {
                await Promise.all(gates.map(gate => this.studio.recordBindingAnalysis(
                    target.workspaceId, target.bindingId!, gate.detector,
                    { state: gate.state, task_id: gate.taskId, summary: gate.summary },
                ).catch(() => undefined)));
            }
        }
        const done = findings.map(finding => DETECTOR_LABEL[finding.detector]);
        const parts: string[] = [];
        parts.push(done.length > 0
            ? `Analysed the text on screen: ${done.join(', ')}.`
            : 'Nothing was recorded.');
        parts.push(...problems, ...skipped);
        return parts.join(' ');
    }

    /** Follow every run to its end, or to the budget. */
    protected async watch(
        runs: ReadonlyMap<SpecDetector, string>, report: (progress: string) => void,
    ): Promise<Map<SpecDetector, TaskRun | undefined>> {
        const out = new Map<SpecDetector, TaskRun | undefined>();
        const pending = new Map(runs);
        const phases = new Map<SpecDetector, string>();
        const deadline = Date.now() + RUN_WATCH_BUDGET_MS;
        while (pending.size > 0 && !this.stopped) {
            for (const [detector, runId] of [...pending]) {
                let run: TaskRun;
                try {
                    run = await this.studio.run(runId);
                } catch (error) {
                    out.set(detector, { id: runId, state: 'failed', last_error: messageOf(error) });
                    pending.delete(detector);
                    continue;
                }
                if (TERMINAL.has(run.state)) {
                    out.set(detector, run);
                    pending.delete(detector);
                    phases.set(detector, run.state === 'succeeded' ? 'done' : run.state);
                } else {
                    phases.set(detector, run.progress || run.state);
                }
            }
            report([...runs.keys()].map(detector => `${DETECTOR_LABEL[detector]}: ${phases.get(detector) ?? 'queued'}`).join(' · '));
            if (pending.size === 0 || Date.now() >= deadline) {
                break;
            }
            await delay(RUN_POLL_MS);
        }
        for (const detector of pending.keys()) {
            out.set(detector, undefined);
        }
        return out;
    }

    protected syncActiveEditor(): void {
        this.handleDocumentChangedFromShell(this.resolveActiveDocument());
    }

    protected resolveActiveDocument(): DocumentLike | undefined {
        const activeWidget = this.applicationShellProvider().activeWidget;
        if (this.isAnalyzeWidget(activeWidget)) {
            return this.currentDocument;
        }
        const activeDocument = this.normalizeDocument(activeWidget);
        if (activeDocument) {
            return activeDocument;
        }
        if (!activeWidget) {
            return this.normalizeDocument(this.editorManager.currentEditor);
        }
        return undefined;
    }

    protected handleDocumentChangedFromShell(document: DocumentLike | undefined): void {
        if (this.currentDocument?.widget === document?.widget) {
            return;
        }
        const generation = ++this.currentGeneration;
        this.resetDocumentListener();
        this.currentDocument = document;
        this.currentTarget = undefined;
        if (!document) {
            this.setViewModel(this.createEmptyViewModel());
            return;
        }
        this.documentListener.push(document.onContentChanged(() => this.handleTrackedDocumentChanged(document)));
        this.setViewModel({
            status: 'loading',
            documentUri: document.uri,
            documentLabel: document.label,
            canAnalyze: false,
            metrics: [],
        });
        void this.load(document, generation);
    }

    protected handleTrackedDocumentChanged(document: DocumentLike): void {
        if (this.stopped || this.currentDocument?.widget !== document.widget) {
            return;
        }
        this.edited.add(document.uri);
        if (this.viewModel.status === 'ready' && this.currentTarget) {
            this.publishTarget(document, this.currentTarget, this.viewModel.metrics);
        }
    }

    /** Resolve the document to Studio's record of it, then read its metrics. */
    protected async load(document: DocumentLike, generation: number): Promise<void> {
        try {
            const resolved = await this.resolve(document);
            if (!this.isCurrent(document, generation)) {
                return;
            }
            if (!resolved.ok) {
                this.setViewModel({
                    status: 'unknown',
                    documentUri: document.uri,
                    documentLabel: document.label,
                    message: resolved.reason,
                    canAnalyze: false,
                    metrics: [],
                });
                return;
            }
            const target = resolved.target;
            const findings = await this.studio.findings(target.projectId, target.subject);
            if (!this.isCurrent(document, generation)) {
                return;
            }
            this.currentTarget = target;
            this.publishTarget(document, target, buildMetrics({
                conformance: target.conformance,
                conformanceMissing: target.conformanceMissing,
                findings,
                typeKey: target.typeKey,
            }));
        } catch (error) {
            if (!this.isCurrent(document, generation)) {
                return;
            }
            this.setViewModel({
                status: 'error',
                documentUri: document.uri,
                documentLabel: document.label,
                message: `Studio could not be asked about this document: ${messageOf(error)}`,
                canAnalyze: false,
                metrics: [],
            });
        }
    }

    protected async resolve(document: DocumentLike): Promise<Resolved> {
        const uri = new URI(document.uri);
        const ref = parseStudioDocumentUri(uri);
        return ref ? this.resolveStudioDocument(ref) : this.resolveRepositoryFile(uri);
    }

    /**
     * A document written in Studio: its findings are kept under
     * `studio-doc:<id>` (the subject the portal's Specs tab reads), and a run
     * names it `studio-doc/<id>.md`. Its project is its own when it has one;
     * a workspace-level document is analysed in the project this window is.
     */
    protected async resolveStudioDocument(ref: StudioDocumentRef): Promise<Resolved> {
        const doc = await this.studio.studioDocument(ref.workspaceId, ref.documentId);
        if (!doc) {
            return { ok: false, reason: 'Studio has no such document any more.' };
        }
        let projectId = doc.project_id ?? undefined;
        if (!projectId) {
            const scope = await this.studio.scope(await this.rootFsPaths());
            if (scope?.kind === 'project' && scope.workspaceId === ref.workspaceId) {
                projectId = scope.projectId;
            }
        }
        if (!projectId) {
            return {
                ok: false,
                reason: 'This document belongs to the workspace rather than one project, and findings are kept per project — ' +
                    'open it from a project to analyse it.',
            };
        }
        let conformance: ConformanceReport | undefined;
        let conformanceMissing: string | undefined;
        try {
            const report = await this.studio.validateStudioDocument(ref.workspaceId, ref.documentId);
            conformance = { ...report, checkedAt: new Date().toISOString() };
        } catch (error) {
            conformanceMissing = `The template check could not be run: ${messageOf(error)}`;
        }
        return {
            ok: true,
            target: {
                kind: 'studio-document',
                workspaceId: ref.workspaceId,
                projectId,
                subject: `studio-doc:${doc.id}`,
                runPath: `studio-doc/${doc.id}.md`,
                knownAs: doc.title,
                typeKey: doc.type_key,
                conformance,
                conformanceMissing,
            },
        };
    }

    /** A repository file: the binding the project keeps for it, found by path. */
    protected async resolveRepositoryFile(uri: URI): Promise<Resolved> {
        if (uri.scheme !== 'file') {
            return { ok: false, reason: 'Only files in this workspace and documents written in Studio can be analysed.' };
        }
        const relative = await this.relativePath(uri);
        if (!relative) {
            return { ok: false, reason: 'This file is outside the workspace, so Studio has no record of it.' };
        }
        const scope = await this.studio.scope(await this.rootFsPaths());
        if (!scope) {
            return { ok: false, reason: NO_PROJECT };
        }
        const candidates = pathCandidates(relative);
        const projects = scope.kind === 'project' ? [scope.projectId] : scope.projectIds;
        for (const projectId of projects) {
            const match = matchBindingByPath(await this.studio.bindings(scope.workspaceId, projectId), candidates);
            if (match.kind === 'ambiguous') {
                return {
                    ok: false,
                    reason: `Studio knows ${match.count} files at ${match.path}, in different repositories, and cannot tell which this is.`,
                };
            }
            if (match.kind === 'found') {
                return this.bindingTarget(match.binding, scope.workspaceId, projectId);
            }
        }
        return { ok: false, reason: NOT_A_SPEC };
    }

    protected bindingTarget(binding: DocumentBinding, workspaceId: string, projectId: string): Resolved {
        if (binding.state === 'not_a_document') {
            return {
                ok: false,
                reason: 'Studio was told this file is not a document. If it is one, give it a type on the portal\'s Specs tab.',
            };
        }
        const typeKey = binding.type_key ?? undefined;
        return {
            ok: true,
            target: {
                kind: 'repository',
                workspaceId,
                projectId,
                subject: binding.node_id,
                runPath: binding.path,
                knownAs: binding.path,
                typeKey,
                bindingId: binding.id,
                conformance: binding.validation ? { ...binding.validation, checkedAt: binding.updated_at } : undefined,
                conformanceMissing: typeKey
                    ? 'The next sync checks it against its template.'
                    : 'No type yet, so there is no template to check it against — give it one on the portal\'s Specs tab.',
            },
        };
    }

    /**
     * The workspace roots, once the workspace has them. Awaited rather than
     * read with `tryGetRoots`: a restored editor becomes current before the
     * roots are known, and asking then would call every file outside the
     * workspace.
     */
    protected async roots(): Promise<URI[]> {
        const roots = this.workspaceService ? await this.workspaceService.roots : [];
        return roots.map(root => root.resource);
    }

    protected async relativePath(uri: URI): Promise<string | undefined> {
        for (const root of await this.roots()) {
            const relative = root.relative(uri);
            if (relative) {
                return relative.toString();
            }
        }
        return undefined;
    }

    protected async rootFsPaths(): Promise<string[]> {
        return (await this.roots()).map(root => root.path.fsPath());
    }

    /** Repaint for a run's progress, if its document is still the one in front
     *  — possibly re-read since the run started, so matched by address. */
    protected publishIfCurrent(uri: string): void {
        if (!this.stopped && this.currentDocument?.uri === uri && this.currentTarget) {
            this.publishTarget(this.currentDocument, this.currentTarget, this.viewModel.metrics);
        }
    }

    protected publishTarget(document: DocumentLike, target: AnalyzeTarget, metrics: readonly AnalyzeMetric[]): void {
        const run = this.running.get(document.uri);
        this.setViewModel({
            status: run ? 'running' : this.edited.has(document.uri) ? 'stale' : 'ready',
            documentUri: document.uri,
            documentLabel: document.label,
            knownAs: target.knownAs,
            typeKey: target.typeKey,
            progress: run?.progress,
            note: run ? undefined : this.notes.get(document.uri),
            canAnalyze: !run,
            metrics,
        });
    }

    protected isCurrent(document: DocumentLike, generation: number): boolean {
        return !this.stopped && generation === this.currentGeneration && this.currentDocument === document;
    }

    protected setViewModel(next: AnalyzeViewModel): void {
        this.viewModel = next;
        this.onDidChangeEmitter.fire(undefined);
    }

    protected createEmptyViewModel(): AnalyzeViewModel {
        return {
            status: 'empty',
            emptyStateTitle: 'No active document',
            emptyStateDescription: 'Open a specification to see what Studio knows about it.',
            canAnalyze: false,
            metrics: [],
        };
    }

    protected getDocumentLabel(uri: string): string {
        const segments = uri.split('/');
        return decodeURIComponent(segments[segments.length - 1] || uri);
    }

    protected isAnalyzeWidget(candidate: unknown): boolean {
        return Boolean(candidate && typeof candidate === 'object' && (candidate as WidgetLike).id === ANALYZE_WIDGET_ID);
    }

    protected resetDocumentListener(): void {
        this.documentListener.dispose();
        this.documentListener = new DisposableCollection();
        this.toDispose.push(this.documentListener);
    }

    protected normalizeDocument(candidate: unknown): DocumentLike | undefined {
        const textEditor = this.normalizeTextEditor(candidate);
        if (textEditor) {
            const uri = textEditor.document.uri.toString();
            return {
                widget: textEditor,
                uri,
                label: this.getDocumentLabel(uri),
                readText: () => textEditor.document.getText(),
                onContentChanged: listener => textEditor.onDocumentContentChanged(() => listener())
            };
        }

        if (candidate && Navigatable.is(candidate)) {
            const resourceUri = candidate.getResourceUri();
            const saveable = Saveable.get(candidate);
            if (resourceUri && saveable) {
                const uri = resourceUri.toString();
                return {
                    widget: candidate,
                    uri,
                    label: this.getDocumentLabel(uri),
                    // The Markdown editor keeps its text in a model, not a
                    // text document; its snapshot is the text a save would
                    // write, unsaved edits included.
                    readText: () => saveable.createSnapshot ? Saveable.Snapshot.read(saveable.createSnapshot()) : undefined,
                    onContentChanged: listener => saveable.onContentChanged(() => listener())
                };
            }
        }

        return undefined;
    }

    /**
     * A widget's text editor, if that is what it has.
     *
     * THE FIRST BRANCH USED TO TRUST THE NAME. `if (editorLike.editor) return
     * editorLike.editor` accepts whatever a widget happens to call `editor`,
     * and the caller immediately reads `.document.uri` off it — so a widget
     * whose `editor` is something else throws `Cannot read properties of
     * undefined (reading 'uri')`. The product has exactly such a widget: the
     * Markdown editor's `this.editor` is a TipTap `Editor`, which keeps its
     * document at `state.doc` and has no `document` at all.
     *
     * It threw on every activation of a Markdown tab, which is most of what
     * this product opens — nine times in one session on the dev stand, from
     * `onActiveChanged`. Nothing downstream noticed, because the throw
     * happened before there was anything to notice with.
     *
     * So both branches now ask the same question, which is the one the second
     * branch was already asking: does this thing have a `document` and can it
     * report a change to it? A Markdown widget answers no and is left alone —
     * it is not a `TextEditor`, and it was never going to be analyzed as one.
     */
    protected normalizeTextEditor(candidate: unknown): TextEditor | undefined {
        if (!candidate || typeof candidate !== 'object') {
            return undefined;
        }
        const editorLike = candidate as EditorLike & { readonly editor?: unknown };
        return this.asTextEditor(editorLike.editor) ?? this.asTextEditor(candidate);
    }

    /** A `TextEditor` by what it carries, never by what it is called. */
    protected asTextEditor(candidate: unknown): TextEditor | undefined {
        if (!candidate || typeof candidate !== 'object') {
            return undefined;
        }
        const editorLike = candidate as EditorLike;
        return editorLike.document && typeof editorLike.onDocumentContentChanged === 'function'
            ? (candidate as TextEditor)
            : undefined;
    }
}

/**
 * The finding a verdict makes, in the words the portal's Specs tab writes —
 * `severity` and `summary` are read there — plus the structured reading in
 * `details`, which the portal does not keep and this panel's metrics prefer.
 */
export function findingFor(
    detector: SpecDetector, target: AnalyzeTarget, verdict: SpecVerdict,
): { finding: FindingToSave; gate: 'pending' | 'passed' | 'failed' } | undefined {
    const base = { detector, subject: target.subject, path: target.runPath };
    switch (detector) {
        case 'purpose': {
            const share = verdict.spec_share ?? 0;
            const gatePassed = verdict.gate_passed ?? null;
            const docType = verdict.doc_type ?? null;
            return {
                finding: {
                    ...base,
                    severity: gatePassed === true ? 'gate-passed' : gatePassed === false ? 'gate-failed' : share >= 0.5 ? 'analyzed' : 'unrecognised',
                    summary: docType ? `purpose: ${docType} (${Math.round(share * 100)}% specification)` : 'purpose: no type named',
                    score: share,
                    details: { doc_type: docType, spec_share: share, gate_passed: gatePassed },
                },
                gate: gatePassed === true ? 'passed' : gatePassed === false ? 'failed' : 'pending',
            };
        }
        case 'leak': {
            const passed = verdict.passed ?? null;
            const share = verdict.leak_share ?? null;
            const roles = verdict.foreign_roles ?? [];
            const foreign = share === null ? '' : ` (${Math.round(share * 100)}% foreign)`;
            return {
                finding: {
                    ...base,
                    severity: passed === true ? 'clean' : passed === false ? 'high' : 'analyzed',
                    summary: passed === true
                        ? `leak: clean${foreign}`
                        : passed === false ? `leak: reads partly as ${roles.join(', ') || 'another kind'}${foreign}` : 'leak: no verdict',
                    ...(share === null ? {} : { score: share }),
                    details: { passed, leak_share: share, foreign_roles: roles },
                },
                gate: passed === true ? 'passed' : passed === false ? 'failed' : 'pending',
            };
        }
        case 'bloat': {
            const byPath = verdict.by_path ?? {};
            const repeats = byPath[target.runPath] ?? [];
            return {
                finding: {
                    ...base,
                    severity: repeats.length === 0 ? 'clean' : 'high',
                    summary: repeats.length === 0 ? 'bloat: nothing repeated elsewhere' : `bloat: repeats ${repeats.map(basename).join(', ')}`,
                    score: repeats.length,
                    details: { repeats },
                },
                gate: repeats.length === 0 ? 'passed' : 'failed',
            };
        }
        case 'traceability':
        default: {
            // An unreadable answer must not be recorded as "references
            // nothing": that reads as a fact about the document.
            if (!verdict.recognised) {
                return undefined;
            }
            const byPath = verdict.by_path ?? {};
            const references = byPath[target.runPath] ?? [];
            const referencedBy = Object.entries(byPath)
                .filter(([path, refs]) => path !== target.runPath && refs.includes(target.runPath))
                .map(([path]) => path);
            return {
                finding: {
                    ...base,
                    severity: references.length === 0 ? 'some' : 'clean',
                    summary: references.length === 0
                        ? 'traceability: references no other document in this set'
                        : `traceability: references ${references.map(basename).join(', ')}`,
                    score: references.length,
                    details: { references, referenced_by: referencedBy },
                },
                gate: 'passed',
            };
        }
    }
}

function basename(path: string): string {
    return path.split('/').pop() || path;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
