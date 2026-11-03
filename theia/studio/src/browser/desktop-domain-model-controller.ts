// What the desktop's Domain model view shows, and what it does.
//
// The project is the one the window has open, as Analyze finds it
// (`AnalyzeStudioClient.scope`: the desktop backend remembers which project a
// folder was opened for). The model, its findings and its glossary are the
// documents gear's (desktop-domain-model-client.ts). What only the IDE adds:
//
//   - the document in front, by its path in the model, so the view can say
//     what the model reads in it and finds about it;
//   - a passage opened in the file on this machine, found by its quote
//     (common/desktop-domain-model.ts, `locatePassage`), since the model read
//     what is pushed and the file may have been edited since;
//   - the findings as Problems markers on those files, under one owner, put
//     back whenever one of the files changes on disk.
//
// Desktop-only: bound in electron-browser/studio-electron-frontend-module.ts,
// so a session never loads it (docs/desktop-contributing.md, rule 1).

import { inject, injectable } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Navigatable } from '@theia/core/lib/browser/navigatable-types';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { DiagnosticSeverity, type Diagnostic } from '@theia/core/shared/vscode-languageserver-protocol';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { AnalyzeStudioClient, pathCandidates } from './analyze-studio-client';
import { DesktopDomainModelClient, failureText } from './desktop-domain-model-client';
import { revealQuoteWhenRendered } from './desktop-domain-model-reveal';
import { studioDocumentUri } from '../common/studio-document-uri';
import {
    DomainModel, DomainModelFinding, DomainModelSide, FindingDecision, GlossaryEntry, Passage,
    STUDIO_DOCUMENT_PREFIX, locatePassage, markedFindings, markerSeverity, modelPathOf, ruleLabel,
} from '../common/desktop-domain-model';

/** The Problems owner of the findings: one, so each publication replaces the last whole. */
export const DOMAIN_MODEL_MARKER_OWNER = 'studio-domain-model';

const POLL_MS = 3000;
const MARKER_DEBOUNCE_MS = 300;

export type DomainModelStatus =
    /** Not asked yet. */
    | 'idle'
    | 'loading'
    | 'ready'
    /** The window has no Studio project open. */
    | 'no-project'
    | 'error';

export interface DomainModelState {
    readonly status: DomainModelStatus;
    readonly projectId?: string;
    readonly workspaceId?: string;
    readonly model?: DomainModel;
    readonly findings: readonly DomainModelFinding[];
    readonly glossary: readonly GlossaryEntry[];
    readonly error?: string;
    /** The document in front, when it has a path at all. */
    readonly current?: { readonly uri: string; readonly label: string; readonly modelPath?: string };
    /** A finding's decision being sent. */
    readonly deciding?: string;
    /** Where each finding's side is in the file here now (`sideKey`); a side
     *  with no file here is absent. */
    readonly passages?: ReadonlyMap<string, Passage['kind']>;
}

/** A side's key in `DomainModelState.passages`. */
export function sideKey(side: DomainModelSide): string {
    return `${side.path}|${side.line_start ?? ''}|${side.quote ?? ''}`;
}

const EMPTY: DomainModelState = { status: 'idle', findings: [], glossary: [] };

@injectable()
export class DesktopDomainModelController implements FrontendApplicationContribution {

    @inject(DesktopDomainModelClient) protected readonly client!: DesktopDomainModelClient;
    @inject(AnalyzeStudioClient) protected readonly studio!: AnalyzeStudioClient;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(OpenerService) protected readonly openers!: OpenerService;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(ProblemManager) protected readonly problems!: ProblemManager;
    @inject(MessageService) protected readonly messages!: MessageService;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;
    protected readonly toDispose = new DisposableCollection(this.onDidChangeEmitter);

    protected state: DomainModelState = EMPTY;
    /** Files carrying this owner's markers now, by URI string. */
    protected marked = new Set<string>();
    protected poll: ReturnType<typeof setTimeout> | undefined;
    protected markerTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped by every load, so an older answer arriving late is dropped. */
    protected generation = 0;

    onStart(): void {
        this.toDispose.push(this.shell.onDidChangeCurrentWidget(() => void this.followCurrent()));
        this.toDispose.push(this.files.onDidFilesChange(event => {
            if ([...this.marked].some(uri => event.contains(new URI(uri)))) {
                this.scheduleMarkers();
            }
        }));
        // Another project in the window: its model, once the view has been
        // asked for one. A window that never opened the view asks nothing.
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => {
            const asked = this.state.status !== 'idle';
            this.stopPolling();
            this.clearMarkers();
            this.set(EMPTY);
            if (asked) {
                void this.refresh();
            }
        }));
    }

    onStop(): void {
        this.stopPolling();
        if (this.markerTimer) {
            clearTimeout(this.markerTimer);
        }
        this.toDispose.dispose();
    }

    getState(): DomainModelState {
        return this.state;
    }

    /** Ask Studio again: the project, then its model, findings and glossary. */
    async refresh(): Promise<void> {
        const generation = ++this.generation;
        this.set({ ...this.state, status: 'loading', error: undefined });
        try {
            const project = await this.project();
            if (generation !== this.generation) {
                return;
            }
            if (!project) {
                this.clearMarkers();
                this.set({ ...EMPTY, status: 'no-project' });
                return;
            }
            const [model, findings, glossary] = await Promise.all([
                this.client.model(project.projectId),
                this.client.findings(project.projectId),
                this.client.glossary(project.projectId),
            ]);
            if (generation !== this.generation) {
                return;
            }
            this.set({ ...this.state, status: 'ready', ...project, model, findings, glossary, error: undefined });
            await this.followCurrent();
            this.scheduleMarkers();
            if (model.build.running) {
                this.pollBuild();
            }
        } catch (error) {
            if (generation === this.generation) {
                this.set({ ...this.state, status: 'error', error: failureText(error) });
            }
        }
    }

    /** Build the model, or with `path` read that one document again, on the
     *  member's own model key; then follow it until it ends. */
    async build(path?: string): Promise<void> {
        const { projectId, model } = this.state;
        if (!projectId || !model) {
            return;
        }
        try {
            const build = await this.client.startBuild(projectId, path);
            this.set({ ...this.state, model: { ...model, build }, error: undefined });
            this.pollBuild();
        } catch (error) {
            this.messages.error(`The domain model was not built: ${failureText(error)}`);
        }
    }

    async decide(finding: DomainModelFinding, decision: FindingDecision): Promise<void> {
        const { projectId } = this.state;
        if (!projectId) {
            return;
        }
        if (finding.decision === decision) {
            return;
        }
        this.set({ ...this.state, deciding: finding.fingerprint });
        try {
            await this.client.decide(projectId, finding.fingerprint, decision);
            this.set({
                ...this.state,
                findings: this.state.findings.map(f => (f.fingerprint === finding.fingerprint ? { ...f, decision } : f)),
            });
            this.scheduleMarkers();
        } catch (error) {
            this.messages.error(`The decision was not saved: ${failureText(error)}`);
        } finally {
            this.set({ ...this.state, deciding: undefined });
        }
    }

    /** Open the passage `side` names, in the file on this machine when there is
     *  one, at the quote as the file reads now. */
    async openSide(side: DomainModelSide): Promise<void> {
        if (side.path.startsWith(STUDIO_DOCUMENT_PREFIX)) {
            const { workspaceId } = this.state;
            if (workspaceId) {
                await open(this.openers, studioDocumentUri({ workspaceId, documentId: side.path.slice(STUDIO_DOCUMENT_PREFIX.length) }));
            }
            return;
        }
        const uri = await this.localFile(side.path);
        if (!uri) {
            this.messages.warn(`${side.path} is not in the folder this window has open.`);
            return;
        }
        const passage = locatePassage((await this.files.read(uri)).value, side);
        if (passage.kind === 'gone') {
            this.messages.info(`The passage the model read in ${side.path} is not in the file any more: it was edited since. Build the model again once the edit is shared.`);
            await open(this.openers, uri);
            return;
        }
        const widget = await open(this.openers, uri, { selection: { start: passage.start, end: passage.end }, mode: 'activate' } as object);
        // Monaco takes the selection. The product's rendered editor (Doc
        // editing) drops it, so the quote is found in its text instead
        // (desktop-domain-model-reveal.ts).
        const node = (widget as { node?: unknown } | undefined)?.node;
        if (side.quote && node instanceof HTMLElement && !node.querySelector('.monaco-editor')) {
            await revealQuoteWhenRendered(node.querySelector<HTMLElement>('.ProseMirror') ?? node, side.quote);
        }
    }

    protected async project(): Promise<{ projectId: string; workspaceId: string } | undefined> {
        const scope = await this.studio.scope((await this.roots()).map(root => root.path.fsPath()));
        if (scope?.kind === 'project') {
            return { projectId: scope.projectId, workspaceId: scope.workspaceId };
        }
        // A workspace opened as a whole has no one model; with a single
        // project under it there is no doubt which.
        if (scope?.kind === 'workspace' && scope.projectIds.length === 1) {
            return { projectId: scope.projectIds[0], workspaceId: scope.workspaceId };
        }
        return undefined;
    }

    protected async roots(): Promise<URI[]> {
        return (await this.workspace.roots).map(root => root.resource);
    }

    /**
     * The file on this machine the model's `path` is: under a root, or under
     * one of a root's folders, since a project with several repositories has
     * each cloned in a folder of its own and the model names a path inside the
     * repository.
     */
    protected async localFile(path: string): Promise<URI | undefined> {
        for (const root of await this.roots()) {
            const direct = root.resolve(path);
            if (await this.files.exists(direct)) {
                return direct;
            }
            const stat = await this.files.resolve(root).catch(() => undefined);
            for (const child of stat?.children ?? []) {
                if (child.isDirectory && !child.name.startsWith('.')) {
                    const nested = child.resource.resolve(path);
                    if (await this.files.exists(nested)) {
                        return nested;
                    }
                }
            }
        }
        return undefined;
    }

    protected async followCurrent(): Promise<void> {
        const widget = this.shell.getCurrentWidget('main');
        const uri = widget && Navigatable.is(widget) ? widget.getResourceUri() : undefined;
        if (!uri) {
            if (this.state.current) {
                this.set({ ...this.state, current: undefined });
            }
            return;
        }
        let relative: string | undefined;
        for (const root of await this.roots()) {
            relative = root.relative(uri)?.toString();
            if (relative) {
                break;
            }
        }
        const modelPath = relative && this.state.model ? modelPathOf(pathCandidates(relative), this.state.model.documents) : undefined;
        const current = { uri: uri.toString(), label: uri.path.base, modelPath };
        const was = this.state.current;
        if (was?.uri !== current.uri || was.modelPath !== current.modelPath) {
            this.set({ ...this.state, current });
        }
    }

    protected pollBuild(): void {
        this.stopPolling();
        this.poll = setTimeout(async () => {
            this.poll = undefined;
            const { projectId, model } = this.state;
            if (!projectId || !model) {
                return;
            }
            try {
                const next = await this.client.model(projectId);
                if (next.build.running) {
                    this.set({ ...this.state, model: next });
                    this.pollBuild();
                } else {
                    // The build ended: what it found is read with the rest.
                    await this.refresh();
                }
            } catch {
                this.pollBuild();
            }
        }, POLL_MS);
    }

    protected stopPolling(): void {
        if (this.poll) {
            clearTimeout(this.poll);
            this.poll = undefined;
        }
    }

    protected scheduleMarkers(): void {
        if (this.markerTimer) {
            clearTimeout(this.markerTimer);
        }
        this.markerTimer = setTimeout(() => {
            this.markerTimer = undefined;
            void this.publishMarkers();
        }, MARKER_DEBOUNCE_MS);
    }

    /** Every finding not dismissed, as a marker on each of its sides that is a
     *  file here and still holds the passage; the files no finding names any
     *  more are cleared. */
    protected async publishMarkers(): Promise<void> {
        const byPath = new Map<string, { finding: DomainModelFinding; side: DomainModelSide }[]>();
        // Every finding's sides are located, so the view can say which were
        // edited since; only the ones not dismissed are marked.
        for (const finding of this.state.findings) {
            for (const side of finding.sides) {
                if (!side.path.startsWith(STUDIO_DOCUMENT_PREFIX)) {
                    byPath.set(side.path, [...(byPath.get(side.path) ?? []), { finding, side }]);
                }
            }
        }
        const marked = new Set(markedFindings(this.state.findings));
        const passages = new Map<string, Passage['kind']>();
        const now = new Set<string>();
        for (const [path, entries] of byPath) {
            const uri = await this.localFile(path);
            if (!uri) {
                continue;
            }
            let text: string;
            try {
                text = (await this.files.read(uri)).value;
            } catch {
                continue;
            }
            const diagnostics: Diagnostic[] = [];
            for (const { finding, side } of entries) {
                const passage = locatePassage(text, side);
                passages.set(sideKey(side), passage.kind);
                if (passage.kind !== 'gone' && marked.has(finding)) {
                    diagnostics.push(diagnosticOf(finding, side, passage));
                }
            }
            this.problems.setMarkers(uri, DOMAIN_MODEL_MARKER_OWNER, diagnostics);
            now.add(uri.toString());
        }
        for (const uri of this.marked) {
            if (!now.has(uri)) {
                this.problems.setMarkers(new URI(uri), DOMAIN_MODEL_MARKER_OWNER, []);
            }
        }
        this.marked = now;
        this.set({ ...this.state, passages });
    }

    protected clearMarkers(): void {
        for (const uri of this.marked) {
            this.problems.setMarkers(new URI(uri), DOMAIN_MODEL_MARKER_OWNER, []);
        }
        this.marked = new Set();
    }

    protected set(state: DomainModelState): void {
        this.state = state;
        this.onDidChangeEmitter.fire();
    }
}

/** One finding on one of its sides, as the Problems view lists it. The other
 *  sides are named in the message, since a disagreement is between them. */
export function diagnosticOf(finding: DomainModelFinding, side: DomainModelSide, passage: Exclude<Passage, { kind: 'gone' }>): Diagnostic {
    const others = finding.sides.filter(s => s !== side).map(s => s.path + (s.line_start ? `:${s.line_start}` : ''));
    const decided = finding.decision === 'confirmed' ? ' (confirmed)' : '';
    return {
        range: { start: passage.start, end: passage.end },
        severity: markerSeverity(finding) === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
        source: 'Domain model',
        code: finding.rule,
        message: `${ruleLabel(finding.rule)}${decided}: ${finding.message}${others.length ? ` — also ${others.join(', ')}` : ''}`,
    };
}
