import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { CommandService, Disposable, DisposableCollection, Emitter, Event } from '@theia/core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileResourceVersion } from '@theia/filesystem/lib/browser/file-resource';
import { Saveable, SaveOptions } from '@theia/core/lib/browser/saveable';
import URI from '@theia/core/lib/common/uri';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import {
    canonicalizeMarkdown,
    MarkdownCommentTokenTable,
    prepareMarkdownForEditorWithTokens,
    restoreMarkdownFromEditorWithTokens
} from './markdown-editor-shared';
import { Resource, ResourceError, ResourceProvider, ResourceVersion } from '@theia/core/lib/common/resource';
import { preserveUnchangedBlocks } from './markdown-preserve';

export type MarkdownUpdateOrigin = 'initial' | 'user' | 'external-sync' | 'revert';

/**
 * How often the file is stat'ed behind the file watcher — the Documents
 * editor's EXTERNAL_POLL_MS, for the same reason: a watcher can be silent. On a
 * workspace bind-mounted from Windows (9p/drvfs inside the container) it is
 * silent always, and without this the editor never learned that a colleague
 * saved, so it neither took their save nor raised a conflict against it.
 */
export const EXTERNAL_POLL_MS = 2000;

/** product-ext's co-editing claim (product-frontend-module.js). */
export const CLAIM_WRITE_COMMAND = 'studio.collab.claimWrite';

export interface MarkdownModifiedExternalChangeState {
    readonly kind: 'modified';
    readonly rawMarkdown: string;
    readonly markdown: string;
    readonly version: ResourceVersion | undefined;
}

export interface MarkdownDeletedExternalChangeState {
    readonly kind: 'deleted';
    readonly version: ResourceVersion | undefined;
}

export type MarkdownExternalChangeState = MarkdownModifiedExternalChangeState | MarkdownDeletedExternalChangeState;

@injectable()
export class MarkdownEditorModel implements Saveable {
    @inject(ResourceProvider)
    protected readonly resourceProvider: ResourceProvider;

    // Optional: the poll is a safety net, and a model without a file service
    // (a test harness) works from the watcher alone.
    @inject(FileService) @optional()
    protected readonly fileService: FileService | undefined;

    protected polling = false;

    // Optional for the same reason: the claim is a courtesy to the Documents
    // editor, and a model without commands (a test harness) saves without one.
    @inject(CommandService) @optional()
    protected readonly commands: CommandService | undefined;

    protected readonly toDispose = new DisposableCollection();
    protected readonly onDirtyChangedEmitter = new Emitter<void>();
    protected readonly onContentChangedEmitter = new Emitter<void>();
    protected readonly onExternalChangeChangedEmitter = new Emitter<void>();
    protected readonly onSavingChangedEmitter = new Emitter<void>();

    protected resourceUri: URI | undefined;
    protected resource: Resource | undefined;
    protected baselineRawMarkdown = '';
    protected baselineMarkdown = '';
    protected currentMarkdown = '';
    protected pendingExternalChangeState: MarkdownExternalChangeState | undefined;
    protected readonly commentTokens = new MarkdownCommentTokenTable();
    protected userEditGeneration = 0;
    protected externalReadGeneration = 0;
    protected activeSaveOperations = 0;
    protected queuedWriteOperations = 0;
    protected writeQueue: Promise<void> = Promise.resolve();
    protected keepLocalAndSavePromise: Promise<void> | undefined;
    protected disposed = false;

    readonly onDirtyChanged: Event<void> = this.onDirtyChangedEmitter.event;
    readonly onContentChanged: Event<void> = this.onContentChangedEmitter.event;
    readonly onExternalChangeChanged: Event<void> = this.onExternalChangeChangedEmitter.event;
    readonly onSavingChanged: Event<void> = this.onSavingChangedEmitter.event;

    get dirty(): boolean {
        return this.currentMarkdown !== this.baselineMarkdown;
    }

    get saving(): boolean {
        return this.queuedWriteOperations > 0;
    }

    get uri(): URI {
        if (!this.resourceUri) {
            throw new Error('Markdown editor model has not been initialized.');
        }
        return this.resourceUri;
    }

    get markdown(): string {
        return this.currentMarkdown;
    }

    get externalChange(): MarkdownExternalChangeState | undefined {
        return this.pendingExternalChangeState;
    }

    get editorMarkdown(): string {
        return prepareMarkdownForEditorWithTokens(this.currentMarkdown, this.commentTokens);
    }

    async init(uri: URI): Promise<void> {
        this.resourceUri = uri;
        const resource = await this.resourceProvider(uri);
        this.resource = resource;
        this.toDispose.push(resource);
        if (resource.onDidChangeContents) {
            this.toDispose.push(resource.onDidChangeContents(() => this.scheduleExternalSync()));
        }
        this.startExternalPoll(uri);
        const request = ++this.externalReadGeneration;
        const rawMarkdown = await resource.readContents();
        if (this.disposed || request !== this.externalReadGeneration) {
            return;
        }
        this.applyCleanSnapshot(rawMarkdown);
    }

    restoreEditorMarkdown(markdown: string): string {
        return restoreMarkdownFromEditorWithTokens(markdown, this.commentTokens);
    }

    updateMarkdown(markdown: string, origin: MarkdownUpdateOrigin = 'user'): void {
        const nextMarkdown = canonicalizeMarkdown(markdown);
        const nextBaselineMarkdown = origin === 'user' ? this.baselineMarkdown : nextMarkdown;
        const contentChanged = nextMarkdown !== this.currentMarkdown;
        if (nextMarkdown === this.currentMarkdown && nextBaselineMarkdown === this.baselineMarkdown) {
            return;
        }
        const wasDirty = this.dirty;
        if (origin === 'user' && contentChanged) {
            this.userEditGeneration += 1;
        }
        this.currentMarkdown = nextMarkdown;
        if (origin !== 'user') {
            this.baselineMarkdown = nextBaselineMarkdown;
        }
        if (origin !== 'external-sync' && origin !== 'revert') {
            this.reconcilePendingExternalChange();
        }
        if (contentChanged) {
            this.onContentChangedEmitter.fire();
        }
        if (wasDirty !== this.dirty) {
            this.onDirtyChangedEmitter.fire();
        }
    }

    async revert(options?: Saveable.RevertOptions): Promise<void> {
        if (options?.soft) {
            const wasDirty = this.dirty;
            this.baselineRawMarkdown = this.currentMarkdown;
            this.baselineMarkdown = this.currentMarkdown;
            this.reconcilePendingExternalChange();
            if (wasDirty !== this.dirty) {
                this.onDirtyChangedEmitter.fire();
            }
        } else {
            const request = ++this.externalReadGeneration;
            const rawMarkdown = await this.readResourceContents();
            if (this.disposed || request !== this.externalReadGeneration) {
                return;
            }
            this.applyCleanSnapshot(rawMarkdown);
            this.onContentChangedEmitter.fire();
            this.onDirtyChangedEmitter.fire();
        }
    }

    async save(_options?: SaveOptions): Promise<void> {
        await this.enqueueWrite(async () => {
            if (this.pendingExternalChangeState) {
                throw ResourceError.OutOfSync({
                    message: 'Markdown editor resource has pending external changes.',
                    data: { uri: this.uri }
                });
            }
            if (!this.dirty) {
                return;
            }
            const resource = this.resource;
            if (!resource?.saveContents) {
                throw new Error('Markdown editor resource is not saveable.');
            }
            const savedMarkdown = this.currentMarkdown;
            // What goes to disk: the edited blocks as the editor serialised
            // them, every other block as the file already spelled it
            // (markdown-preserve.ts) — so a save does not reformat what nobody
            // touched. The editor's own form stays the baseline it compares with.
            const savedRaw = preserveUnchangedBlocks(this.baselineRawMarkdown, savedMarkdown);
            const savedGeneration = this.userEditGeneration;
            const wasDirty = this.dirty;
            this.activeSaveOperations += 1;
            try {
                if (this.commands) {
                    await this.claimWrite(savedRaw);
                }
                await resource.saveContents(savedRaw, {
                    version: resource.version
                });
                this.baselineRawMarkdown = savedRaw;
                this.baselineMarkdown = savedMarkdown;
                if (savedGeneration === this.userEditGeneration) {
                    this.currentMarkdown = savedMarkdown;
                }
            } finally {
                this.activeSaveOperations -= 1;
            }
            this.reconcilePendingExternalChange();
            if (this.pendingExternalChangeState && this.canSafelyResolvePendingExternalChange(this.pendingExternalChangeState)) {
                this.clearPendingExternalChange();
            }
            if (wasDirty !== this.dirty) {
                this.onDirtyChangedEmitter.fire();
            }
        });
    }

    reloadFromExternalChange(): void {
        const pendingConflict = this.pendingExternalChangeState;
        if (!pendingConflict) {
            return;
        }
        const wasDirty = this.dirty;
        const nextRawMarkdown = this.getExternalRawMarkdown(pendingConflict);
        const nextMarkdown = this.getExternalMarkdown(pendingConflict);
        const contentChanged = this.currentMarkdown !== nextMarkdown;
        this.commentTokens.clear();
        this.baselineRawMarkdown = nextRawMarkdown;
        this.baselineMarkdown = nextMarkdown;
        this.currentMarkdown = nextMarkdown;
        this.clearPendingExternalChange(pendingConflict);
        if (contentChanged) {
            this.onContentChangedEmitter.fire();
        }
        if (wasDirty !== this.dirty) {
            this.onDirtyChangedEmitter.fire();
        }
    }

    keepLocalAndSave(): Promise<void> {
        if (this.keepLocalAndSavePromise) {
            return this.keepLocalAndSavePromise;
        }
        const operation = this.enqueueWrite(async () => {
            const pendingConflict = this.pendingExternalChangeState;
            if (!pendingConflict) {
                throw new Error('Markdown editor has no pending external change to overwrite.');
            }
            const resource = this.resource;
            if (!resource?.saveContents) {
                throw new Error('Markdown editor resource is not saveable.');
            }
            const localMarkdown = this.currentMarkdown;
            const localGeneration = this.userEditGeneration;
            const wasDirty = this.dirty;
            this.activeSaveOperations += 1;
            try {
                await resource.saveContents(localMarkdown, {
                    version: pendingConflict.kind === 'deleted' ? undefined : pendingConflict.version
                });
                this.baselineRawMarkdown = localMarkdown;
                this.baselineMarkdown = canonicalizeMarkdown(localMarkdown);
                if (localGeneration === this.userEditGeneration) {
                    this.currentMarkdown = this.baselineMarkdown;
                }
            } finally {
                this.activeSaveOperations -= 1;
            }
            this.reconcilePendingExternalChange();
            if (this.pendingExternalChangeState === pendingConflict) {
                this.clearPendingExternalChange(pendingConflict);
            }
            if (wasDirty !== this.dirty) {
                this.onDirtyChangedEmitter.fire();
            }
        });
        const sharedPromise = operation.finally(() => {
            if (this.keepLocalAndSavePromise === sharedPromise) {
                this.keepLocalAndSavePromise = undefined;
            }
        });
        this.keepLocalAndSavePromise = sharedPromise;
        return sharedPromise;
    }

    createSnapshot(): Saveable.Snapshot {
        return { value: this.currentMarkdown };
    }

    applySnapshot(snapshot: object): void {
        const markdown = Saveable.Snapshot.read(snapshot as Saveable.Snapshot);
        if (markdown !== undefined) {
            this.updateMarkdown(markdown);
        }
    }

    async serialize(): Promise<BinaryBuffer> {
        return BinaryBuffer.fromString(this.dirty ? this.currentMarkdown : this.baselineRawMarkdown);
    }

    /**
     * Tell co-editing these bytes are this person's (product-ext's
     * studio.collab.claimWrite), so a colleague's Documents editor applies the
     * save as theirs instead of holding it for review like an assistant's write.
     */
    protected async claimWrite(raw: string): Promise<void> {
        if (!this.commands || !this.resourceUri) {
            return;
        }
        try {
            await this.commands.executeCommand(CLAIM_WRITE_COMMAND, this.resourceUri.toString(), raw);
        } catch {
            // No co-editing here (the desktop, a build without product-ext): nobody to tell.
        }
    }

    protected startExternalPoll(uri: URI): void {
        if (!this.fileService || uri.scheme !== 'file') {
            return;
        }
        const timer = setInterval(() => void this.pollExternalChange(), EXTERNAL_POLL_MS);
        this.toDispose.push(Disposable.create(() => clearInterval(timer)));
    }

    /**
     * Read again when the file on disk is newer than the version this model
     * last read or wrote — what the watcher would have said. Skipped while a
     * save is in flight (its own write is not news) and while the page is
     * hidden (nobody is looking, and the next visible tick catches up).
     */
    protected async pollExternalChange(): Promise<void> {
        if (this.disposed || this.polling || this.activeSaveOperations > 0 || !this.fileService || !this.resourceUri) {
            return;
        }
        if (typeof document !== 'undefined' && document.hidden) {
            return;
        }
        const version = this.resource?.version;
        if (!FileResourceVersion.is(version)) {
            return;
        }
        this.polling = true;
        try {
            const stat = await this.fileService.resolve(this.resourceUri, { resolveMetadata: true });
            if (!this.disposed && stat.mtime > version.mtime && stat.etag !== version.etag) {
                this.scheduleExternalSync();
            }
        } catch {
            // Gone or unreadable: the watcher or the next save reports it, and
            // re-reading a missing file every two seconds would not.
        } finally {
            this.polling = false;
        }
    }

    protected scheduleExternalSync(): void {
        const request = ++this.externalReadGeneration;
        const observedUserEditGeneration = this.userEditGeneration;
        void this.syncExternalContents(request, observedUserEditGeneration);
    }

    protected async syncExternalContents(request: number, observedUserEditGeneration: number): Promise<void> {
        let nextExternalChange: MarkdownExternalChangeState;
        try {
            const rawMarkdown = await this.readResourceContents();
            nextExternalChange = {
                kind: 'modified',
                rawMarkdown,
                markdown: canonicalizeMarkdown(rawMarkdown),
                version: this.resource?.version
            };
        } catch (error) {
            if (ResourceError.NotFound.is(error)) {
                nextExternalChange = {
                    kind: 'deleted',
                    version: undefined
                };
            } else {
                console.error(error);
                return;
            }
        }
        if (this.disposed || request !== this.externalReadGeneration) {
            return;
        }

        if (this.matchesBaseline(nextExternalChange)) {
            this.clearPendingExternalChange();
            return;
        }

        const userEditedDuringRead = observedUserEditGeneration !== this.userEditGeneration;
        if (nextExternalChange.kind === 'modified' && !this.dirty && !userEditedDuringRead) {
            const contentChanged = nextExternalChange.markdown !== this.currentMarkdown;
            this.applyCleanSnapshot(nextExternalChange.rawMarkdown);
            if (contentChanged) {
                this.onContentChangedEmitter.fire();
            }
            return;
        }

        this.setPendingExternalChange(nextExternalChange);
        this.reconcilePendingExternalChange();
    }

    protected async readResourceContents(): Promise<string> {
        if (!this.resource) {
            throw new Error('Markdown editor model has not been initialized.');
        }
        return this.resource.readContents();
    }

    protected applyCleanSnapshot(rawMarkdown: string): void {
        this.commentTokens.clear();
        this.baselineRawMarkdown = rawMarkdown;
        this.baselineMarkdown = canonicalizeMarkdown(rawMarkdown);
        this.currentMarkdown = this.baselineMarkdown;
        this.clearPendingExternalChange();
    }

    protected reconcilePendingExternalChange(): void {
        const pending = this.pendingExternalChangeState;
        if (!pending) {
            return;
        }
        if (this.activeSaveOperations > 0) {
            return;
        }
        if (this.matchesBaseline(pending)) {
            this.clearPendingExternalChange();
            return;
        }
        if (this.canSafelyResolvePendingExternalChange(pending)) {
            this.baselineRawMarkdown = this.getExternalRawMarkdown(pending);
            this.baselineMarkdown = this.getExternalMarkdown(pending);
            this.clearPendingExternalChange();
        }
    }

    protected canSafelyResolvePendingExternalChange(pending: MarkdownExternalChangeState): boolean {
        if (pending.kind !== 'modified') {
            return false;
        }
        return this.currentMarkdown === pending.markdown && this.currentMarkdown === pending.rawMarkdown;
    }

    protected matchesBaseline(pending: MarkdownExternalChangeState): boolean {
        if (pending.kind === 'deleted') {
            return false;
        }
        return pending.rawMarkdown === this.baselineRawMarkdown;
    }

    protected getExternalRawMarkdown(pending: MarkdownExternalChangeState): string {
        return pending.kind === 'deleted' ? '' : pending.rawMarkdown;
    }

    protected getExternalMarkdown(pending: MarkdownExternalChangeState): string {
        return pending.kind === 'deleted' ? '' : pending.markdown;
    }

    protected setPendingExternalChange(next: MarkdownExternalChangeState): void {
        const current = this.pendingExternalChangeState;
        if (current?.kind === next.kind) {
            if (current.kind === 'deleted' && current.version === next.version) {
                return;
            }
            if (
                current.kind === 'modified'
                && next.kind === 'modified'
                && current.rawMarkdown === next.rawMarkdown
                && current.markdown === next.markdown
                && current.version === next.version
            ) {
                return;
            }
        }
        if (this.matchesBaseline(next)) {
            this.clearPendingExternalChange();
            return;
        }
        this.pendingExternalChangeState = next;
        this.onExternalChangeChangedEmitter.fire();
    }

    protected clearPendingExternalChange(conflict?: MarkdownExternalChangeState): void {
        if (!this.pendingExternalChangeState) {
            return;
        }
        if (conflict && this.pendingExternalChangeState !== conflict) {
            return;
        }
        this.pendingExternalChangeState = undefined;
        this.onExternalChangeChangedEmitter.fire();
    }

    protected async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
        const wasSaving = this.saving;
        this.queuedWriteOperations += 1;
        if (wasSaving !== this.saving) {
            this.onSavingChangedEmitter.fire();
        }
        const runPromise = wasSaving
            ? this.writeQueue.then(() => operation(), () => operation())
            : operation();
        this.writeQueue = runPromise.then(() => undefined, () => undefined);
        try {
            return await runPromise;
        } finally {
            const wasSavingBeforeDequeue = this.saving;
            this.queuedWriteOperations -= 1;
            if (wasSavingBeforeDequeue !== this.saving) {
                this.onSavingChangedEmitter.fire();
            }
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.commentTokens.dispose();
        this.toDispose.dispose();
        this.onSavingChangedEmitter.dispose();
        this.onExternalChangeChangedEmitter.dispose();
        this.onContentChangedEmitter.dispose();
        this.onDirtyChangedEmitter.dispose();
    }
}
