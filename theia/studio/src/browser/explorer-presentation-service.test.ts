import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class WorkspaceService {}
}));
jest.mock('@theia/filesystem/lib/browser/file-tree/file-tree', () => ({
    FileStatNode: {
        is: (element: { fileStat?: object } | undefined) => !!element?.fileStat
    }
}));
import URI from '@theia/core/lib/common/uri';
import { FileChangesEvent, FileChangeType, FileOperation, FileType } from '@theia/filesystem/lib/common/files';
import { Emitter } from '@theia/core/lib/common/event';
import { ExplorerPresentationService, extractPrimaryMarkdownHeading } from './explorer-presentation-service';

describe('ExplorerPresentationService', () => {
    it('extracts the first markdown heading', () => {
        expect(extractPrimaryMarkdownHeading('Intro\n\n# Title\n## Subtitle')).toBe('Title');
        expect(extractPrimaryMarkdownHeading('## Title with closing hashes ##')).toBe('Title with closing hashes');
        expect(extractPrimaryMarkdownHeading('Title\n====\n\nBody')).toBe('Title');
        expect(extractPrimaryMarkdownHeading('---\ntitle: Metadata\n---\n\n# Real Title')).toBe('Real Title');
        expect(extractPrimaryMarkdownHeading('No heading here')).toBeUndefined();
    });

    it('uses markdown headings as display names in markdown mode', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const operationEmitter = new Emitter<unknown>();
        const fileService = {
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn().mockResolvedValue({ value: '# Overview\n\nBody' })
        };
        const storageService = {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn().mockResolvedValue(undefined)
        };
        const service = createService(fileService, storageService);

        const uri = new URI('file:///workspace/docs/readme.md');
        const node = {
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        expect(service.getDisplayName(node as never, 'readme.md')).toBe('readme.md');
        await Promise.resolve();
        await Promise.resolve();
        expect(service.getDisplayName(node as never, 'readme.md')).toBe('Overview');
        expect(fileService.read).toHaveBeenCalledWith(uri, {
            acceptTextOnly: true,
            length: 64 * 1024
        });
    });

    it('clears cached titles when the file service reports changes', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const operationEmitter = new Emitter<unknown>();
        const fileService = {
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn()
                .mockResolvedValueOnce({ value: '# First' })
                .mockResolvedValueOnce({ value: '# Second' })
        };
        const storageService = {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn().mockResolvedValue(undefined)
        };
        const service = createService(fileService, storageService);

        const uri = new URI('file:///workspace/docs/readme.md');
        const node = {
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        service.getDisplayName(node as never, 'readme.md');
        await Promise.resolve();
        await Promise.resolve();
        expect(service.getDisplayName(node as never, 'readme.md')).toBe('First');

        filesChangeEmitter.fire(new FileChangesEvent([{
            resource: uri,
            type: FileChangeType.UPDATED
        }]));
        service.getDisplayName(node as never, 'readme.md');
        await Promise.resolve();
        await Promise.resolve();
        expect(service.getDisplayName(node as never, 'readme.md')).toBe('Second');
    });

    it('persists explorer mode toggles', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const operationEmitter = new Emitter<unknown>();
        const fileService = {
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn()
        };
        const storageService = {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn().mockResolvedValue(undefined)
        };
        const service = createService(fileService, storageService);

        expect(service.isMarkdownMode()).toBe(true);
        await service.toggleMode();
        expect(service.getMode()).toBe('all');
        expect(storageService.setData).toHaveBeenCalledWith('studio.explorer.mode', 'all');

        operationEmitter.fire({ resource: new URI('file:///workspace/docs/readme.md'), operation: FileOperation.CREATE });
    });

    it('serializes overlapping mode toggles without losing user intent', async () => {
        const firstWrite = deferred<void>();
        const secondWrite = deferred<void>();
        const storageService = {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn()
                .mockReturnValueOnce(firstWrite.promise)
                .mockReturnValueOnce(secondWrite.promise)
        };
        const service = createService({
            onDidFilesChange: new Emitter<FileChangesEvent>().event,
            onDidRunOperation: new Emitter<unknown>().event,
            read: jest.fn()
        }, storageService);

        const firstToggle = service.toggleMode();
        const secondToggle = service.toggleMode();
        await flushPromises();

        expect(storageService.setData).toHaveBeenCalledTimes(1);
        expect(storageService.setData).toHaveBeenLastCalledWith('studio.explorer.mode', 'all');

        firstWrite.resolve();
        await firstToggle;
        await flushPromises();
        expect(storageService.setData).toHaveBeenCalledTimes(2);
        expect(storageService.setData).toHaveBeenLastCalledWith('studio.explorer.mode', 'markdown');

        secondWrite.resolve();
        await Promise.all([firstToggle, secondToggle]);

        expect(service.getMode()).toBe('markdown');
    });

    it('does not apply stale title loads after invalidation', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const operationEmitter = new Emitter<unknown>();
        let resolveFirstRead: ((content: { value: string }) => void) | undefined;
        const firstRead = new Promise<{ value: string }>(resolve => {
            resolveFirstRead = resolve;
        });
        const fileService = {
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn()
                .mockReturnValueOnce(firstRead)
                .mockResolvedValueOnce({ value: '# Current' })
        };
        const storageService = {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn().mockResolvedValue(undefined)
        };
        const service = createService(fileService, storageService);
        const uri = new URI('file:///workspace/docs/readme.md');
        const node = {
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        service.getDisplayName(node as never, 'readme.md');
        filesChangeEmitter.fire(new FileChangesEvent([{
            resource: uri,
            type: FileChangeType.UPDATED
        }]));
        service.getDisplayName(node as never, 'readme.md');
        await flushPromises();
        resolveFirstRead?.({ value: '# Stale' });
        await flushPromises();

        expect(service.getDisplayName(node as never, 'readme.md')).toBe('Current');
    });

    it('disposes file listeners and ignores pending reads on stop', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const operationEmitter = new Emitter<unknown>();
        let resolveRead: ((content: { value: string }) => void) | undefined;
        const fileService = {
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn().mockReturnValue(new Promise<{ value: string }>(resolve => {
                resolveRead = resolve;
            }))
        };
        const storageService = {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn().mockResolvedValue(undefined)
        };
        const service = createService(fileService, storageService);
        const uri = new URI('file:///workspace/docs/readme.md');
        const node = {
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        service.getDisplayName(node as never, 'readme.md');
        service.onStop();
        resolveRead?.({ value: '# Too Late' });
        await flushPromises();

        expect(service.getDisplayName(node as never, 'readme.md')).toBe('readme.md');
    });

    it('restores a persisted all-files mode and emits a presentation change', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const operationEmitter = new Emitter<unknown>();
        const storageService = {
            getData: jest.fn().mockResolvedValue('all'),
            setData: jest.fn()
        };
        const service = createService({
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn()
        }, storageService);
        const onDidChange = jest.fn();
        service.onDidChange(onDidChange);

        await flushPromises();

        expect(service.getMode()).toBe('all');
        expect(onDidChange).toHaveBeenCalledWith(undefined);
    });

    it('keeps the markdown default when restoring storage fails', async () => {
        const logger = createLogger();
        const service = createService({
            onDidFilesChange: new Emitter<FileChangesEvent>().event,
            onDidRunOperation: new Emitter<unknown>().event,
            read: jest.fn()
        }, {
            getData: jest.fn().mockRejectedValue(new Error('broken storage')),
            setData: jest.fn()
        }, logger);

        await flushPromises();

        expect(service.getMode()).toBe('markdown');
        expect(logger.warn).toHaveBeenCalledWith(
            'Failed to restore the Explorer mode.',
            expect.any(Error)
        );
    });

    it('does not publish a mode change when persistence fails', async () => {
        const logger = createLogger();
        const service = createService({
            onDidFilesChange: new Emitter<FileChangesEvent>().event,
            onDidRunOperation: new Emitter<unknown>().event,
            read: jest.fn()
        }, {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn().mockRejectedValue(new Error('storage unavailable'))
        }, logger);
        const onDidChange = jest.fn();
        service.onDidChange(onDidChange);

        await expect(service.toggleMode()).rejects.toThrow('storage unavailable');

        expect(service.getMode()).toBe('markdown');
        expect(onDidChange).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    it('retries a title read after a transient failure', async () => {
        const logger = createLogger();
        const fileService = {
            onDidFilesChange: new Emitter<FileChangesEvent>().event,
            onDidRunOperation: new Emitter<unknown>().event,
            read: jest.fn()
                .mockRejectedValueOnce(new Error('temporary failure'))
                .mockResolvedValueOnce({ value: '# Recovered' })
        };
        const service = createService(fileService, {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn()
        }, logger);
        const uri = new URI('file:///workspace/retry.md');
        const node = {
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        expect(service.getDisplayName(node as never, 'retry.md')).toBe('retry.md');
        await flushPromises();
        expect(service.getDisplayName(node as never, 'retry.md')).toBe('retry.md');
        await flushPromises();

        expect(service.getDisplayName(node as never, 'retry.md')).toBe('Recovered');
        expect(fileService.read).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('retains cached titles for unrelated file changes', async () => {
        const filesChangeEmitter = new Emitter<FileChangesEvent>();
        const fileService = {
            onDidFilesChange: filesChangeEmitter.event,
            onDidRunOperation: new Emitter<unknown>().event,
            read: jest.fn()
                .mockResolvedValueOnce({ value: '# First' })
                .mockResolvedValueOnce({ value: '# Second' })
        };
        const service = createService(fileService, {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn()
        });
        const firstUri = new URI('file:///workspace/first.md');
        const secondUri = new URI('file:///workspace/second.md');
        const firstNode = { uri: firstUri, fileStat: { resource: firstUri, isDirectory: false, type: FileType.File } };
        const secondNode = { uri: secondUri, fileStat: { resource: secondUri, isDirectory: false, type: FileType.File } };

        service.getDisplayName(firstNode as never, 'first.md');
        service.getDisplayName(secondNode as never, 'second.md');
        await flushPromises();
        filesChangeEmitter.fire(new FileChangesEvent([{
            resource: firstUri,
            type: FileChangeType.UPDATED
        }]));

        expect(service.getDisplayName(secondNode as never, 'second.md')).toBe('Second');
        expect(fileService.read).toHaveBeenCalledTimes(2);
    });

    it('invalidates cached titles below a changed directory', async () => {
        const operationEmitter = new Emitter<unknown>();
        const fileService = {
            onDidFilesChange: new Emitter<FileChangesEvent>().event,
            onDidRunOperation: operationEmitter.event,
            read: jest.fn()
                .mockResolvedValueOnce({ value: '# Before' })
                .mockResolvedValueOnce({ value: '# After' })
        };
        const service = createService(fileService, {
            getData: jest.fn().mockResolvedValue(undefined),
            setData: jest.fn()
        });
        const directoryUri = new URI('file:///workspace/docs');
        const fileUri = new URI('file:///workspace/docs/nested/readme.md');
        const node = {
            uri: fileUri,
            fileStat: { resource: fileUri, isDirectory: false, type: FileType.File }
        };

        service.getDisplayName(node as never, 'readme.md');
        await flushPromises();
        expect(service.getDisplayName(node as never, 'readme.md')).toBe('Before');

        operationEmitter.fire({ resource: directoryUri, operation: FileOperation.DELETE });
        expect(service.getDisplayName(node as never, 'readme.md')).toBe('readme.md');
        await flushPromises();

        expect(service.getDisplayName(node as never, 'readme.md')).toBe('After');
        expect(fileService.read).toHaveBeenCalledTimes(2);
    });
});

function createService(
    fileService: object,
    storageService: object,
    logger: ReturnType<typeof createLogger> = createLogger()
): ExplorerPresentationService {
    const service = new ExplorerPresentationService(fileService as never, storageService as never, logger as never);
    (service as unknown as { init(): void }).init();
    return service;
}

function createLogger() {
    return {
        warn: jest.fn().mockResolvedValue(undefined)
    };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('the document types the documents mode shows', () => {
    // Imported here so the suite above keeps its own imports as they were.
    const { shownExtensionsFrom, DEFAULT_SHOWN_EXTENSIONS } = require('./explorer-presentation-service');

    it('takes the project Files shown, lower case and without the dot', () => {
        expect([...shownExtensionsFrom({ visibleExtensions: ['MD', '.yaml', 'csv'] })]).toEqual(['md', 'yaml', 'csv']);
    });

    it('falls back to the types the product edits when the project chose none', () => {
        expect([...shownExtensionsFrom(undefined)]).toEqual([...DEFAULT_SHOWN_EXTENSIONS]);
        expect([...shownExtensionsFrom({ autosave: true })]).toEqual([...DEFAULT_SHOWN_EXTENSIONS]);
    });
});
