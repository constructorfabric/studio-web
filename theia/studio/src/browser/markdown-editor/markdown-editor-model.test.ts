import 'reflect-metadata';
import { Disposable, Emitter } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import {
    Resource,
    ResourceError,
    ResourceProvider,
    ResourceSaveOptions,
    ResourceVersion
} from '@theia/core/lib/common/resource';
import { EXTERNAL_POLL_MS, MarkdownEditorModel } from './markdown-editor-model';
import { canonicalizeMarkdown, representativeRoundTripFixtures } from './markdown-editor-shared';

describe('MarkdownEditorModel', () => {
    it('loads, canonicalizes, saves, and reverts markdown through ResourceProvider', async () => {
        const uri = new URI('file:///workspace/guide.md');
        const resource = new MockMarkdownResource(uri, '# Title  \r\n\r\nText');
        const model = createModel(resource);

        await model.init(uri);
        const initialVersion = resource.version;

        expect(model.markdown).toBe('# Title\n\nText\n');
        expect(model.dirty).toBe(false);

        model.updateMarkdown('# Title\n\nChanged');
        expect(model.dirty).toBe(true);
        expect(model.createSnapshot()).toEqual({ value: '# Title\n\nChanged\n' });

        await model.save();
        expect(resource.saveContents).toHaveBeenCalledWith('# Title\n\nChanged\n', { version: initialVersion });
        expect(model.dirty).toBe(false);

        resource.setContents('# Disk\n');
        model.updateMarkdown('# Local\n');
        await model.revert();
        expect(model.markdown).toBe('# Disk\n');
        expect(model.dirty).toBe(false);
    });

    it('supports soft revert and round-trip fixtures', async () => {
        const uri = new URI('file:///workspace/notes.md');
        const resource = new MockMarkdownResource(uri, '');
        const model = createModel(resource);

        await model.init(uri);

        for (const fixture of representativeRoundTripFixtures) {
            expect(canonicalizeMarkdown(fixture.markdown)).toBe(fixture.markdown);
        }

        model.updateMarkdown('draft');
        await model.revert({ soft: true });
        expect(model.markdown).toBe('draft\n');
        expect(model.dirty).toBe(false);
    });

    it('preserves untouched disk bytes across open and save for CRLF, trailing spaces, and final blank lines', async () => {
        const uri = new URI('file:///workspace/preserved.md');
        const rawMarkdown = '# Title  \r\n\r\nLine with spaces   \r\n\r\n\r\n';
        const resource = new MockMarkdownResource(uri, rawMarkdown);
        const model = createModel(resource);

        await model.init(uri);

        expect(model.markdown).toBe('# Title\n\nLine with spaces\n');
        expect(model.dirty).toBe(false);
        expect((await model.serialize()).toString()).toBe(rawMarkdown);

        await model.save();
        expect(resource.saveContents).not.toHaveBeenCalled();
    });

    it('treats initial normalization as clean but real user edits as dirty', async () => {
        const uri = new URI('file:///workspace/origins.md');
        const model = createModel(new MockMarkdownResource(uri, 'Alpha\n\n<!-- keep -->\n\nOmega\n'));

        await model.init(uri);

        model.updateMarkdown('Alpha\n\n\n<!-- keep -->\n\n\nOmega\n', 'initial');
        expect(model.dirty).toBe(false);

        model.updateMarkdown('Alpha\n\n<!-- keep -->\n\nChanged\n', 'user');
        expect(model.dirty).toBe(true);
    });

    it('reloads clean external changes, stays clean, and fires a content change event', async () => {
        const uri = new URI('file:///workspace/clean-sync.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        let contentChangedCalls = 0;
        model.onContentChanged(() => {
            contentChangedCalls += 1;
        });

        resource.fireExternalChange('# Disk  \r\n\r\nText\r\n');
        await flushMicrotasks();

        expect(model.markdown).toBe('# Disk\n\nText\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
        expect(contentChangedCalls).toBe(1);
    });

    it('preserves dirty local edits and records pending external changes', async () => {
        const uri = new URI('file:///workspace/dirty-sync.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        let externalChangeCalls = 0;
        model.onExternalChangeChanged(() => {
            externalChangeCalls += 1;
        });

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk  \r\n\r\nText\r\n');
        await flushMicrotasks();

        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(true);
        expect(model.externalChange).toEqual({
            kind: 'modified',
            rawMarkdown: '# Disk  \r\n\r\nText\r\n',
            markdown: '# Disk\n\nText\n',
            version: resource.version
        });
        expect(externalChangeCalls).toBe(1);
    });

    it('keeps a user edit during a deferred external read and reports a conflict instead of auto-reloading', async () => {
        const uri = new URI('file:///workspace/deferred-sync.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        let contentChangedCalls = 0;
        model.onContentChanged(() => {
            contentChangedCalls += 1;
        });

        const pendingRead = resource.beginDeferredExternalChange('# Disk  \r\n');
        model.updateMarkdown('# Local\n');
        pendingRead.resolve('# Disk  \r\n');
        await flushMicrotasks();

        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(true);
        expect(model.externalChange).toEqual({
            kind: 'modified',
            rawMarkdown: '# Disk  \r\n',
            markdown: '# Disk\n',
            version: resource.version
        });
        expect(contentChangedCalls).toBe(1);
    });

    it('rejects save with ResourceError.OutOfSync while an external conflict is pending', async () => {
        const uri = new URI('file:///workspace/out-of-sync.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk\n');
        await flushMicrotasks();

        let rejection: unknown;
        try {
            await model.save();
        } catch (error) {
            rejection = error;
        }
        const rejectionObject = typeof rejection === 'object' && rejection !== null ? rejection : undefined;
        expect(ResourceError.OutOfSync.is(rejectionObject)).toBe(true);
        expect(resource.saveContents).not.toHaveBeenCalled();
    });

    it('reloads from disk using the pending external snapshot, clears the conflict, and becomes clean', async () => {
        const uri = new URI('file:///workspace/reload-from-disk.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        let contentChangedCalls = 0;
        let dirtyChangedCalls = 0;
        let externalChangeCalls = 0;
        model.onContentChanged(() => {
            contentChangedCalls += 1;
        });
        model.onDirtyChanged(() => {
            dirtyChangedCalls += 1;
        });
        model.onExternalChangeChanged(() => {
            externalChangeCalls += 1;
        });

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk  \r\n\r\nText\r\n');
        await flushMicrotasks();

        await conflictModel.reloadFromExternalChange();

        expect(model.markdown).toBe('# Disk\n\nText\n');
        expect((await model.serialize()).toString()).toBe('# Disk  \r\n\r\nText\r\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
        expect(contentChangedCalls).toBe(2);
        expect(dirtyChangedCalls).toBe(2);
        expect(externalChangeCalls).toBe(2);
    });

    it('keepLocalAndSave overwrites the conflicted version once and clears only the matching conflict after success', async () => {
        const uri = new URI('file:///workspace/keep-local-success.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk  \r\n');
        await flushMicrotasks();
        const conflictVersion = model.externalChange?.version;

        await conflictModel.keepLocalAndSave();

        expect(resource.saveContents).toHaveBeenLastCalledWith('# Local\n', { version: conflictVersion });
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
    });

    it('keepLocalAndSave retains dirty local content and the pending conflict when the overwrite fails', async () => {
        const uri = new URI('file:///workspace/keep-local-failure.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk\n');
        await flushMicrotasks();
        resource.rejectNextSave(ResourceError.OutOfSync({ message: 'save conflict', data: { uri } }));

        await expect(conflictModel.keepLocalAndSave()).rejects.toBeDefined();
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(true);
        expect(model.externalChange).toEqual({
            kind: 'modified',
            rawMarkdown: '# Disk\n',
            markdown: '# Disk\n',
            version: resource.version
        });
    });

    it('ignores a stale initial read when a newer external sync resolves first', async () => {
        const uri = new URI('file:///workspace/stale-init.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const initialRead = resource.deferNextRead();

        const initPromise = model.init(uri);
        await Promise.resolve();
        resource.fireExternalChange('# Disk newer\n');
        await flushMicrotasks();
        initialRead.resolve('# Disk older\n');
        await initPromise;

        expect(model.markdown).toBe('# Disk newer\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
    });

    it('ignores a stale hard-revert read when a newer external sync resolves first', async () => {
        const uri = new URI('file:///workspace/stale-revert.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        const revertRead = resource.deferNextRead();
        const revertPromise = model.revert();
        resource.fireExternalChange('# Disk newer\n');
        await flushMicrotasks();
        revertRead.resolve('# Disk older\n');
        await revertPromise;

        expect(model.markdown).toBe('# Disk newer\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
    });

    it('blocks save for a pending external conflict even after local edits return to the clean baseline', async () => {
        const uri = new URI('file:///workspace/clean-conflict.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk newer\n');
        await flushMicrotasks();
        model.updateMarkdown('# Base\n');

        let rejection: unknown;
        try {
            await model.save();
        } catch (error) {
            rejection = error;
        }
        expect(ResourceError.OutOfSync.is(rejection as object)).toBe(true);
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toEqual({
            kind: 'modified',
            rawMarkdown: '# Disk newer\n',
            markdown: '# Disk newer\n',
            version: resource.version
        });
    });

    it('records a deleted-on-disk conflict, preserves local content, and blocks ordinary save', async () => {
        const uri = new URI('file:///workspace/deleted-conflict.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalDeletion();
        await flushMicrotasks();

        expect(model.markdown).toBe('# Local\n');
        expect(model.externalChange).toEqual({
            kind: 'deleted',
            version: undefined
        });
        let rejection: unknown;
        try {
            await model.save();
        } catch (error) {
            rejection = error;
        }
        expect(ResourceError.OutOfSync.is(rejection as object)).toBe(true);
    });

    it('reloadFromExternalChange accepts a deleted-on-disk state and resets the model to a clean empty snapshot', async () => {
        const uri = new URI('file:///workspace/reload-deleted.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalDeletion();
        await flushMicrotasks();

        conflictModel.reloadFromExternalChange();

        expect(model.markdown).toBe('');
        expect((await model.serialize()).toString()).toBe('');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
    });

    it('keepLocalAndSave recreates a deleted file with version undefined and clears only the matching deleted conflict on success', async () => {
        const uri = new URI('file:///workspace/keep-local-deleted.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalDeletion();
        await flushMicrotasks();

        await conflictModel.keepLocalAndSave();

        expect(resource.saveContents).toHaveBeenLastCalledWith('# Local\n', { version: undefined });
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
    });

    it('retains the deleted-on-disk conflict when keepLocalAndSave fails', async () => {
        const uri = new URI('file:///workspace/keep-local-deleted-failure.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalDeletion();
        await flushMicrotasks();
        resource.rejectNextSave(ResourceError.OutOfSync({ message: 'save conflict', data: { uri } }));

        await expect(conflictModel.keepLocalAndSave()).rejects.toBeDefined();
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(true);
        expect(model.externalChange).toEqual({
            kind: 'deleted',
            version: undefined
        });
    });

    it('keepLocalAndSave leaves a newer external change pending when one arrives during the overwrite', async () => {
        const uri = new URI('file:///workspace/keep-local-newer-conflict.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk old\n');
        await flushMicrotasks();
        const priorConflictVersion = model.externalChange?.version;

        const saveGate = resource.deferNextSave();
        const keepLocalPromise = conflictModel.keepLocalAndSave();

        resource.fireExternalChange('# Disk newer\n');
        await flushMicrotasks();
        const newerConflict = model.externalChange;
        saveGate.resolve(undefined);
        await keepLocalPromise;

        expect(newerConflict).toBeDefined();
        expect(newerConflict).not.toBeUndefined();
        expect(newerConflict?.kind).toBe('modified');
        if (!newerConflict || newerConflict.kind !== 'modified') {
            throw new Error('Expected a modified external conflict.');
        }
        expect(newerConflict.rawMarkdown).toBe('# Disk newer\n');
        expect(newerConflict.markdown).toBe('# Disk newer\n');
        expect(newerConflict.version).not.toBe(priorConflictVersion);
        expect(resource.saveContents).toHaveBeenLastCalledWith('# Local\n', { version: priorConflictVersion });
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBe(newerConflict);
    });

    it('keeps newer local edits dirty after an async save resolves and uses the saved bytes as the new baseline', async () => {
        const uri = new URI('file:///workspace/async-save.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# Saved\n');
        const saveGate = resource.deferNextSave();
        const savePromise = model.save();

        model.updateMarkdown('# Newer local\n');
        expect(model.markdown).toBe('# Newer local\n');
        expect(model.dirty).toBe(true);

        saveGate.resolve(undefined);
        await savePromise;

        expect(resource.saveContents).toHaveBeenCalledWith('# Saved\n', { version: expect.any(Object) });
        expect(model.markdown).toBe('# Newer local\n');
        expect(model.dirty).toBe(true);

        model.updateMarkdown('# Saved\n');
        expect(model.dirty).toBe(false);
    });

    it('serializes queued saves so only one resource write runs at a time and later edits save in order', async () => {
        const uri = new URI('file:///workspace/serialized-saves.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# First\n');
        const firstSaveGate = resource.deferNextSave();
        const firstSavePromise = model.save();

        model.updateMarkdown('# Second\n');
        const secondSavePromise = model.save();

        expect(resource.saveContents).toHaveBeenCalledTimes(1);
        expect(resource.saveContents).toHaveBeenNthCalledWith(1, '# First\n', { version: expect.any(Object) });

        firstSaveGate.resolve(undefined);
        await firstSavePromise;
        await secondSavePromise;

        expect(resource.saveContents).toHaveBeenCalledTimes(2);
        expect(resource.saveContents).toHaveBeenNthCalledWith(2, '# Second\n', { version: expect.any(Object) });
        expect(model.markdown).toBe('# Second\n');
        expect(model.dirty).toBe(false);
    });

    it('keeps the write queue alive after a rejected save and persists the next queued snapshot', async () => {
        const uri = new URI('file:///workspace/save-queue-recovery.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# First\n');
        resource.rejectNextSave(ResourceError.OutOfSync({ message: 'save failed', data: { uri } }));
        const firstSavePromise = model.save();

        model.updateMarkdown('# Second\n');
        const secondSavePromise = model.save();

        await expect(firstSavePromise).rejects.toBeDefined();
        await secondSavePromise;

        expect(resource.saveContents).toHaveBeenCalledTimes(2);
        expect(resource.saveContents).toHaveBeenNthCalledWith(1, '# First\n', { version: expect.any(Object) });
        expect(resource.saveContents).toHaveBeenNthCalledWith(2, '# Second\n', { version: expect.any(Object) });
        expect(model.markdown).toBe('# Second\n');
        expect(model.dirty).toBe(false);
    });

    it('coalesces duplicate keepLocalAndSave calls into a single overwrite', async () => {
        const uri = new URI('file:///workspace/keep-local-coalesced.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk\n');
        await flushMicrotasks();

        const saveGate = resource.deferNextSave();
        const firstKeepLocalPromise = conflictModel.keepLocalAndSave();
        const secondKeepLocalPromise = conflictModel.keepLocalAndSave();

        expect(firstKeepLocalPromise).toBe(secondKeepLocalPromise);
        expect(resource.saveContents).toHaveBeenCalledTimes(1);

        saveGate.resolve(undefined);
        await firstKeepLocalPromise;

        expect(resource.saveContents).toHaveBeenCalledTimes(1);
        expect(model.dirty).toBe(false);
        expect(model.externalChange).toBeUndefined();
    });

    it('publishes saving state while writes are queued or in progress', async () => {
        const uri = new URI('file:///workspace/saving-state.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const savingStates: boolean[] = [];

        await model.init(uri);

        model.onSavingChanged(() => {
            savingStates.push(model.saving);
        });

        model.updateMarkdown('# First\n');
        const firstSaveGate = resource.deferNextSave();
        const firstSavePromise = model.save();

        expect(model.saving).toBe(true);

        model.updateMarkdown('# Second\n');
        const secondSavePromise = model.save();

        expect(model.saving).toBe(true);
        expect(savingStates).toEqual([true]);

        firstSaveGate.resolve(undefined);
        await firstSavePromise;
        expect(model.saving).toBe(true);

        await secondSavePromise;
        expect(model.saving).toBe(false);
        expect(savingStates).toEqual([true, false]);
    });

    it('retains a same-content external conflict when an in-flight save later fails', async () => {
        const uri = new URI('file:///workspace/save-conflict-during-flight.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        const saveGate = resource.deferNextSave();
        const savePromise = model.save();
        resource.fireExternalChange('# Local\n');
        await flushMicrotasks();
        resource.rejectNextSave(ResourceError.OutOfSync({ message: 'save failed', data: { uri } }));
        saveGate.resolve(undefined);

        await expect(savePromise).rejects.toBeDefined();
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(true);
        expect(model.externalChange).toEqual({
            kind: 'modified',
            rawMarkdown: '# Local\n',
            markdown: '# Local\n',
            version: resource.version
        });
    });

    it('retains a same-content external conflict when keepLocalAndSave later fails in flight', async () => {
        const uri = new URI('file:///workspace/keep-local-flight-failure.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const conflictModel = model as unknown as ConflictCapableMarkdownEditorModel;

        await model.init(uri);

        model.updateMarkdown('# Local\n');
        resource.fireExternalChange('# Disk old\n');
        await flushMicrotasks();

        const saveGate = resource.deferNextSave();
        const keepLocalPromise = conflictModel.keepLocalAndSave();
        resource.fireExternalChange('# Local\n');
        await flushMicrotasks();
        resource.rejectNextSave(ResourceError.OutOfSync({ message: 'overwrite failed', data: { uri } }));
        saveGate.resolve(undefined);

        await expect(keepLocalPromise).rejects.toBeDefined();
        expect(model.markdown).toBe('# Local\n');
        expect(model.dirty).toBe(true);
        expect(model.externalChange).toEqual({
            kind: 'modified',
            rawMarkdown: '# Local\n',
            markdown: '# Local\n',
            version: resource.version
        });
    });

    it('notices a newer file on disk by polling when the watcher stays silent', async () => {
        jest.useFakeTimers();
        try {
            const uri = new URI('file:///workspace/poll.md');
            const resource = new MockMarkdownResource(uri, '# Base\n');
            const model = createModel(resource);
            const stat = { mtime: 0, etag: 'e0' };
            const fileService = { resolve: jest.fn(async () => stat) };
            Object.defineProperty(model, 'fileService', { value: fileService });
            const sync = jest.spyOn(model as unknown as { scheduleExternalSync(): void }, 'scheduleExternalSync');

            await model.init(uri);
            // What the model last read, as a FileResource reports it.
            Object.defineProperty(resource, 'version', { value: { encoding: 'utf8', mtime: 100, etag: 'e1' }, writable: true });

            stat.mtime = 100;
            stat.etag = 'e1';
            jest.advanceTimersByTime(EXTERNAL_POLL_MS);
            await flushMicrotasks();
            expect(sync).not.toHaveBeenCalled();

            // A colleague saved; no file event came.
            stat.mtime = 200;
            stat.etag = 'e2';
            jest.advanceTimersByTime(EXTERNAL_POLL_MS);
            await flushMicrotasks();
            expect(sync).toHaveBeenCalledTimes(1);

            model.dispose();
            jest.advanceTimersByTime(EXTERNAL_POLL_MS * 3);
            await flushMicrotasks();
            expect(fileService.resolve).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not poll a resource that is not a file', async () => {
        jest.useFakeTimers();
        try {
            const uri = new URI('studio-doc:/doc/1.md');
            const resource = new MockMarkdownResource(uri, '# Base\n');
            const model = createModel(resource);
            const fileService = { resolve: jest.fn() };
            Object.defineProperty(model, 'fileService', { value: fileService });
            await model.init(uri);
            jest.advanceTimersByTime(EXTERNAL_POLL_MS * 2);
            expect(fileService.resolve).not.toHaveBeenCalled();
            model.dispose();
        } finally {
            jest.useRealTimers();
        }
    });

    it('disposes the resource and external-change listener when the model is disposed', async () => {
        const uri = new URI('file:///workspace/dispose.md');
        const resource = new MockMarkdownResource(uri, '# Base\n');
        const model = createModel(resource);
        const disposeSpy = resource.dispose;

        await model.init(uri);

        expect(resource.listenerDisposeCount).toBe(0);
        model.dispose();

        expect(resource.listenerDisposeCount).toBe(1);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
});

function createModel(resource: MockMarkdownResource): MarkdownEditorModel {
    const model = new MarkdownEditorModel();
    const resourceProvider: ResourceProvider = jest.fn(async requestedUri => {
        expect(requestedUri.toString()).toBe(resource.uri.toString());
        return resource;
    });
    Object.defineProperty(model, 'resourceProvider', { value: resourceProvider });
    return model;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 4): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
    }
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value?: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
}

interface MockVersion extends ResourceVersion {
    readonly id: number;
}

interface PendingRead {
    readonly promise: Promise<string>;
    readonly version: ResourceVersion;
}

interface ConflictCapableMarkdownEditorModel {
    reloadFromExternalChange(): Promise<void> | void;
    keepLocalAndSave(): Promise<void>;
}

class MockMarkdownResource implements Resource {
    readonly onDidChangeContentsEmitter = new Emitter<void>();
    readonly readContents = jest.fn(async (): Promise<string> => {
        const pendingRead = this.pendingReads.shift();
        if (pendingRead) {
            const contents = await pendingRead.promise;
            this.contents = contents;
            this.version = pendingRead.version;
            return contents;
        }
        if (!this.version) {
            this.version = this.nextVersion();
        }
        return this.contents;
    });
    readonly saveContents = jest.fn(async (content: string, options?: ResourceSaveOptions): Promise<void> => {
        if (options?.version !== undefined && this.version !== undefined && options.version !== this.version) {
            throw ResourceError.OutOfSync({ message: 'version mismatch', data: { uri: this.uri } });
        }
        const gate = this.pendingSaves.shift();
        if (gate) {
            await gate.promise;
        }
        const rejection = this.pendingSaveRejections.shift();
        if (rejection) {
            throw rejection;
        }
        this.contents = content;
        this.version = this.nextVersion();
    });
    readonly dispose = jest.fn(() => {
        this.onDidChangeContentsEmitter.dispose();
    });

    version: ResourceVersion | undefined;
    listenerDisposeCount = 0;

    private readonly pendingReads: PendingRead[] = [];
    private readonly pendingSaves: Deferred<void>[] = [];
    private readonly pendingSaveRejections: unknown[] = [];
    private nextVersionId = 1;

    constructor(
        readonly uri: URI,
        private contents: string
    ) { }

    readonly onDidChangeContents: NonNullable<Resource['onDidChangeContents']> = listener => {
        const disposable = this.onDidChangeContentsEmitter.event(listener);
        return Disposable.create(() => {
            this.listenerDisposeCount += 1;
            disposable.dispose();
        });
    };

    setContents(contents: string): void {
        this.contents = contents;
    }

    fireExternalChange(contents: string): void {
        this.contents = contents;
        this.pendingReads.push({
            promise: Promise.resolve(contents),
            version: this.nextVersion()
        });
        this.onDidChangeContentsEmitter.fire();
    }

    fireExternalDeletion(): void {
        const error = ResourceError.NotFound({ message: 'missing file', data: { uri: this.uri } });
        this.pendingReads.push({
            promise: Promise.reject(error),
            version: this.nextVersion()
        });
        this.onDidChangeContentsEmitter.fire();
    }

    beginDeferredExternalChange(contents: string): Deferred<string> {
        const deferred = createDeferred<string>();
        this.contents = contents;
        this.pendingReads.push({
            promise: deferred.promise,
            version: this.nextVersion()
        });
        this.onDidChangeContentsEmitter.fire();
        return deferred;
    }

    deferNextRead(): Deferred<string> {
        const deferred = createDeferred<string>();
        this.pendingReads.push({
            promise: deferred.promise,
            version: this.nextVersion()
        });
        return deferred;
    }

    deferNextSave(): Deferred<void> {
        const deferred = createDeferred<void>();
        this.pendingSaves.push(deferred);
        return deferred;
    }

    rejectNextSave(error: unknown): void {
        this.pendingSaveRejections.push(error);
    }

    private nextVersion(): MockVersion {
        const id = this.nextVersionId;
        this.nextVersionId += 1;
        return { id };
    }
}
