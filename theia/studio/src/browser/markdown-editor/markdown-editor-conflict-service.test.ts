import 'reflect-metadata';
import URI from '@theia/core/lib/common/uri';
import { Resource } from '@theia/core/lib/common/resource';
import type { DiffService } from '@theia/workspace/lib/browser/diff-service';

jest.mock('@theia/workspace/lib/browser/diff-service', () => ({
    DiffService: class DiffService {
        readonly openDiffEditor = jest.fn();
    }
}));

describe('MarkdownEditorConflictService', () => {
    it('opens a compare diff with immutable disk and local snapshots', async () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const resources = new MockInMemoryResources();
        const diffService = { openDiffEditor: jest.fn().mockResolvedValue(undefined) } as unknown as DiffService;
        const model = createConflictModel();

        Object.defineProperty(service, 'resources', { value: resources });
        Object.defineProperty(service, 'diffService', { value: diffService });

        await service.openDiff(model);

        expect(resources.added).toHaveLength(2);
        expect(resources.added.map(entry => entry.contents)).toEqual(['# Disk  \r\n\r\nText\r\n', '# Local\n']);
        expect(diffService.openDiffEditor).toHaveBeenCalledWith(
            resources.added[0]?.uri,
            resources.added[1]?.uri,
            'guide.md: Disk <> Local'
        );
        expect(resources.added[0]?.disposeSpy).toHaveBeenCalledTimes(1);
        expect(resources.added[1]?.disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('creates unique resource URIs for each compare so earlier tabs keep their original content', async () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const resources = new MockInMemoryResources();
        const diffService = { openDiffEditor: jest.fn().mockResolvedValue(undefined) } as unknown as DiffService;
        const firstModel = createConflictModel();
        const secondModel = createConflictModel({
            rawMarkdown: '# Disk newer\n',
            localMarkdown: '# Local newer\n'
        });

        Object.defineProperty(service, 'resources', { value: resources });
        Object.defineProperty(service, 'diffService', { value: diffService });

        await service.openDiff(firstModel);
        await service.openDiff(secondModel);

        expect(resources.added).toHaveLength(4);
        expect(resources.added[0]?.uri.toString()).not.toBe(resources.added[2]?.uri.toString());
        expect(resources.added[1]?.uri.toString()).not.toBe(resources.added[3]?.uri.toString());
        expect(resources.added.map(entry => entry.contents)).toEqual([
            '# Disk  \r\n\r\nText\r\n',
            '# Local\n',
            '# Disk newer\n',
            '# Local newer\n'
        ]);
    });

    it('represents a deleted disk side as empty content and uses a deletion-aware diff label', async () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const resources = new MockInMemoryResources();
        const diffService = { openDiffEditor: jest.fn().mockResolvedValue(undefined) } as unknown as DiffService;
        const model = createDeletedConflictModel();

        Object.defineProperty(service, 'resources', { value: resources });
        Object.defineProperty(service, 'diffService', { value: diffService });

        await service.openDiff(model);

        expect(resources.added.map(entry => entry.contents)).toEqual(['', '# Local\n']);
        expect(diffService.openDiffEditor).toHaveBeenCalledWith(
            resources.added[0]?.uri,
            resources.added[1]?.uri,
            'guide.md: Disk Deleted <> Local'
        );
    });

    it('disposes the initial in-memory references when the diff open fails', async () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const resources = new MockInMemoryResources();
        const diffService = {
            openDiffEditor: jest.fn().mockRejectedValue(new Error('open failed'))
        } as unknown as DiffService;
        const model = createConflictModel();

        Object.defineProperty(service, 'resources', { value: resources });
        Object.defineProperty(service, 'diffService', { value: diffService });

        await expect(service.openDiff(model)).rejects.toThrow('open failed');
        expect(resources.added[0]?.disposeSpy).toHaveBeenCalledTimes(1);
        expect(resources.added[1]?.disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('disposes the left initial reference if right resource creation fails', () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const resources = new MockInMemoryResources();
        const creationError = new Error('right add failed');

        resources.throwOnAddCall = 2;
        resources.throwOnAddError = creationError;
        Object.defineProperty(service, 'resources', { value: resources });

        expect(() => service.createResourcePair('# Disk\n', '# Local\n')).toThrow(creationError);
        expect(resources.added).toHaveLength(1);
        expect(resources.added[0]?.disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('fails clearly when openDiff is called without a pending conflict', async () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const resources = new MockInMemoryResources();
        const diffService = { openDiffEditor: jest.fn().mockResolvedValue(undefined) } as unknown as DiffService;
        const model = createCleanModel();

        Object.defineProperty(service, 'resources', { value: resources });
        Object.defineProperty(service, 'diffService', { value: diffService });

        await expect(service.openDiff(model)).rejects.toThrow('Markdown editor has no pending external change to compare.');
        expect(diffService.openDiffEditor).not.toHaveBeenCalled();
        expect(resources.added).toHaveLength(0);
    });

    it('opens the same two versions rendered side by side, as texts beside the file', async () => {
        const { MarkdownEditorConflictService } = loadConflictServiceModule();
        const service = new MarkdownEditorConflictService() as ConflictServiceUnderTest;
        const markdownDiffs = { open: jest.fn().mockResolvedValue(undefined) };
        Object.defineProperty(service, 'markdownDiffs', { value: markdownDiffs });

        await service.openRenderedDiff(createConflictModel());
        await service.openRenderedDiff(createDeletedConflictModel());

        expect(markdownDiffs.open.mock.calls.map(call => ({ ...call[0], base: call[0].base?.toString() }))).toEqual([
            {
                title: 'guide.md (Disk ↔ Local)',
                left: { content: '# Disk  \r\n\r\nText\r\n', label: 'On disk' },
                right: { content: '# Local\n', label: 'Your version' },
                base: 'file:///workspace/guide.md',
            },
            expect.objectContaining({
                title: 'guide.md (Disk Deleted ↔ Local)',
                left: { content: '', label: 'Deleted on disk' },
            }),
        ]);
        await expect(service.openRenderedDiff(createCleanModel())).rejects.toThrow('no pending external change');
    });
});

function loadConflictServiceModule(): { MarkdownEditorConflictService: new () => unknown } {
    return require('./markdown-editor-conflict-service') as { MarkdownEditorConflictService: new () => unknown };
}

function createConflictModel(options?: { rawMarkdown?: string; localMarkdown?: string }): ConflictModelStub {
    const rawMarkdown = options?.rawMarkdown ?? '# Disk  \r\n\r\nText\r\n';
    const localMarkdown = options?.localMarkdown ?? '# Local\n';
    return {
        uri: new URI('file:///workspace/guide.md'),
        markdown: localMarkdown,
        externalChange: {
            kind: 'modified',
            rawMarkdown,
            markdown: rawMarkdown.replace(/\r\n/g, '\n'),
            version: { id: 2 }
        },
        serialize: jest.fn(async () => ({ toString: () => localMarkdown }))
    };
}

function createDeletedConflictModel(): ConflictModelStub {
    return {
        uri: new URI('file:///workspace/guide.md'),
        markdown: '# Local\n',
        externalChange: {
            kind: 'deleted',
            version: undefined
        },
        serialize: jest.fn(async () => ({ toString: () => '# Local\n' }))
    };
}

function createCleanModel(): ConflictModelStub {
    return {
        uri: new URI('file:///workspace/guide.md'),
        markdown: '# Local\n',
        externalChange: undefined,
        serialize: jest.fn(async () => ({ toString: () => '# Local\n' }))
    };
}

interface ConflictServiceUnderTest {
    openDiff(model: ConflictModelStub): Promise<void>;
    openRenderedDiff(model: ConflictModelStub): Promise<void>;
    createResourcePair(leftContents: string, rightContents: string): unknown;
}

interface ConflictModelStub {
    readonly uri: URI;
    readonly markdown: string;
    readonly externalChange: {
        readonly kind: 'modified';
        readonly rawMarkdown: string;
        readonly markdown: string;
        readonly version: object | undefined;
    } | {
        readonly kind: 'deleted';
        readonly version: undefined;
    } | undefined;
    serialize(): Promise<{ toString(): string }>;
}

class MockInMemoryResources {
    readonly added: Array<{ uri: URI; contents: string; resource: Resource; disposeSpy: jest.Mock }> = [];
    throwOnAddCall: number | undefined;
    throwOnAddError: Error | undefined;

    add(uri: URI, contents: string): Resource {
        if (this.throwOnAddCall === this.added.length + 1) {
            throw this.throwOnAddError ?? new Error('add failed');
        }
        const disposeSpy = jest.fn();
        const resource = {
            uri,
            dispose: disposeSpy,
            readContents: jest.fn(async () => contents)
        } as unknown as Resource;
        this.added.push({ uri, contents, resource, disposeSpy });
        return resource;
    }
}
