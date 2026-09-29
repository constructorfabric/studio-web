import 'reflect-metadata';
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class WorkspaceService {}
}));
jest.mock('@theia/filesystem/lib/browser/file-tree/file-tree', () => ({
    DirNode: {
        is: (element: { fileStat?: { isDirectory?: boolean } } | undefined) => !!element?.fileStat?.isDirectory
    },
    FileStatNode: {
        is: (element: { fileStat?: object } | undefined) => !!element?.fileStat
    }
}));
jest.mock('@theia/navigator/lib/browser/navigator-filter', () => ({
    FileNavigatorFilter: class {
        protected filterPredicate = { filter: () => true };
        constructor(protected readonly preferences: object) {}
        async filter<T>(items: Promise<T[]> | T[]): Promise<T[]> {
            return Promise.resolve(items);
        }
        protected fireFilterChanged(): void {}
    }
}));
jest.mock('@theia/navigator/lib/browser/navigator-widget', () => ({
    FILE_NAVIGATOR_ID: 'files',
    FileNavigatorWidget: class {
        id = 'files';
    }
}));
jest.mock('@theia/navigator/lib/browser/navigator-tree', () => ({
    WorkspaceRootNode: {
        find: (node: { parent?: { id?: string; parent?: object } } | undefined) => {
            let candidate = node;
            while (candidate) {
                if (candidate.parent?.id === 'WorkspaceNodeId') {
                    return candidate;
                }
                candidate = candidate.parent as typeof candidate;
            }
            return undefined;
        }
    }
}));
import URI from '@theia/core/lib/common/uri';
import { FileType } from '@theia/filesystem/lib/common/files';
import { Emitter } from '@theia/core/lib/common/event';
import { FileNavigatorWidget } from '@theia/navigator/lib/browser/navigator-widget';
import { ExplorerModeContribution, StudioExplorerFilter, StudioFileTreeLabelProvider } from './explorer-contribution';

describe('StudioExplorerFilter', () => {
    it('keeps markdown files and directories that contain markdown files', async () => {
        const presentation = {
            onDidChange: () => ({ dispose: jest.fn() }),
            isMarkdownMode: () => true,
            isMarkdownUri: (uri: URI) => uri.path.ext.toLowerCase() === '.md',
            isShownUri: async (uri: URI) => uri.path.ext.toLowerCase() === '.md'
        };
        const fileService = {
            resolve: jest.fn().mockImplementation((uri: URI) => {
                if (uri.path.base === 'docs') {
                    return Promise.resolve({
                        children: [
                            { resource: new URI('file:///workspace/docs/guide.md'), isDirectory: false },
                            { resource: new URI('file:///workspace/docs/image.png'), isDirectory: false }
                        ]
                    });
                }
                return Promise.resolve({ children: [] });
            })
        };
        const filter = new TestStudioExplorerFilter({} as never, fileService as never, presentation as never, createLogger() as never);
        filter.setFilterPredicate({ filter: () => true });

        const items = [
            {
                id: '/workspace/readme.md',
                uri: new URI('file:///workspace/readme.md'),
                fileStat: { resource: new URI('file:///workspace/readme.md'), isDirectory: false, type: FileType.File }
            },
            {
                id: '/workspace/readme.txt',
                uri: new URI('file:///workspace/readme.txt'),
                fileStat: { resource: new URI('file:///workspace/readme.txt'), isDirectory: false, type: FileType.File }
            },
            {
                id: '/workspace/docs',
                uri: new URI('file:///workspace/docs'),
                fileStat: { resource: new URI('file:///workspace/docs'), isDirectory: true, type: FileType.Directory }
            }
        ];

        const visible = await filter.filter(items);
        expect(visible).toHaveLength(2);
        expect(visible.map(item => item.id)).toEqual(['/workspace/readme.md', '/workspace/docs']);
    });

    it('recomputes cached directory visibility after the base filter changes', async () => {
        const presentation = {
            onDidChange: () => ({ dispose: jest.fn() }),
            isMarkdownMode: () => true,
            isMarkdownUri: (uri: URI) => uri.path.ext.toLowerCase() === '.md',
            isShownUri: async (uri: URI) => uri.path.ext.toLowerCase() === '.md'
        };
        const fileService = {
            resolve: jest.fn().mockResolvedValue({
                children: [
                    { resource: new URI('file:///workspace/docs/guide.md'), isDirectory: false }
                ]
            })
        };
        const filter = new TestStudioExplorerFilter(
            {} as never,
            fileService as never,
            presentation as never,
            createLogger() as never
        );
        const docs = {
            id: '/workspace/docs',
            uri: new URI('file:///workspace/docs'),
            fileStat: { resource: new URI('file:///workspace/docs'), isDirectory: true, type: FileType.Directory }
        };
        filter.setFilterPredicate({ filter: () => true });
        expect(await filter.filter([docs])).toEqual([docs]);

        filter.setFilterPredicate({ filter: item => !item.id.endsWith('guide.md') });
        filter.triggerFilterChanged();

        expect(await filter.filter([docs])).toEqual([]);
        expect(fileService.resolve).toHaveBeenCalledTimes(2);
    });

    it('keeps a directory visible and retries after a resolve failure', async () => {
        const logger = createLogger();
        const presentation = {
            onDidChange: () => ({ dispose: jest.fn() }),
            isMarkdownMode: () => true,
            isMarkdownUri: (uri: URI) => uri.path.ext.toLowerCase() === '.md',
            isShownUri: async (uri: URI) => uri.path.ext.toLowerCase() === '.md'
        };
        const fileService = {
            resolve: jest.fn()
                .mockRejectedValueOnce(new Error('temporary failure'))
                .mockResolvedValueOnce({ children: [] })
        };
        const filter = new TestStudioExplorerFilter(
            {} as never,
            fileService as never,
            presentation as never,
            logger as never
        );
        filter.setFilterPredicate({ filter: () => true });
        const docs = {
            id: '/workspace/docs',
            uri: new URI('file:///workspace/docs'),
            fileStat: { resource: new URI('file:///workspace/docs'), isDirectory: true, type: FileType.Directory }
        };

        expect(await filter.filter([docs])).toEqual([docs]);
        expect(await filter.filter([docs])).toEqual([]);
        expect(fileService.resolve).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();
    });

    it('invalidates only directory caches affected by file changes', async () => {
        const presentationChanges = new Emitter<readonly URI[] | undefined>();
        const presentation = {
            onDidChange: presentationChanges.event,
            isMarkdownMode: () => true,
            isMarkdownUri: (uri: URI) => uri.path.ext.toLowerCase() === '.md',
            isShownUri: async (uri: URI) => uri.path.ext.toLowerCase() === '.md'
        };
        const fileService = {
            resolve: jest.fn().mockResolvedValue({
                children: [
                    { resource: new URI('file:///workspace/docs/guide.md'), isDirectory: false }
                ]
            })
        };
        const filter = new TestStudioExplorerFilter(
            {} as never,
            fileService as never,
            presentation as never,
            createLogger() as never
        );
        filter.setFilterPredicate({ filter: () => true });
        const docs = {
            id: '/workspace/docs',
            uri: new URI('file:///workspace/docs'),
            fileStat: { resource: new URI('file:///workspace/docs'), isDirectory: true, type: FileType.Directory }
        };

        await filter.filter([docs]);
        presentationChanges.fire([new URI('file:///workspace/unrelated.txt')]);
        await filter.filter([docs]);
        expect(fileService.resolve).toHaveBeenCalledTimes(1);

        presentationChanges.fire([new URI('file:///workspace/docs/guide.md')]);
        await filter.filter([docs]);
        expect(fileService.resolve).toHaveBeenCalledTimes(2);
    });

    it('disposes its presentation listener on stop', () => {
        const disposeListener = jest.fn();
        const listenerDisposable = { dispose: disposeListener };
        const presentation = {
            onDidChange: () => listenerDisposable,
            isMarkdownMode: () => true,
            isMarkdownUri: () => true,
            isShownUri: async () => true
        };
        const filter = new TestStudioExplorerFilter(
            {} as never,
            { resolve: jest.fn() } as never,
            presentation as never,
            createLogger() as never
        );

        filter.onStop();

        expect(disposeListener).toHaveBeenCalledTimes(1);
    });
});

describe('StudioFileTreeLabelProvider', () => {
    it('delegates markdown labels to the presentation service', () => {
        const labelChanges = new Emitter<never>();
        const provider = new TestStudioFileTreeLabelProvider();
        provider.setLabelProvider({
            getIcon: () => 'file-icon',
            getName: () => 'readme.md',
            getLongName: () => '/workspace/readme.md'
        });
        provider.setPresentation({
            onDidChangeLabels: labelChanges.event,
            getDisplayName: () => 'Overview'
        });

        const uri = new URI('file:///workspace/readme.md');
        const node = {
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        expect(provider.getName(node as never)).toBe('Overview');
        expect(provider.getLongName(node as never)).toBe('/workspace/readme.md');
    });

    it('handles only nodes that belong to the file navigator tree', () => {
        const provider = new TestStudioFileTreeLabelProvider();
        const uri = new URI('file:///workspace/readme.md');
        const workspace = {
            id: 'WorkspaceNodeId',
            name: 'WorkspaceNode',
            children: [],
            parent: undefined
        };
        const root = {
            id: '/workspace',
            uri: new URI('file:///workspace'),
            fileStat: { resource: new URI('file:///workspace'), isDirectory: true, type: FileType.Directory },
            children: [],
            parent: workspace
        };
        const navigatorNode = {
            id: '/workspace/readme.md',
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File },
            parent: root
        };
        const dialogNode = {
            id: '/workspace/readme.md',
            uri,
            fileStat: { resource: uri, isDirectory: false, type: FileType.File }
        };

        expect(provider.canHandle(navigatorNode as never)).toBe(101);
        expect(provider.canHandle(dialogNode as never)).toBe(0);
    });
});

describe('ExplorerModeContribution', () => {
    it('refreshes and disposes the toolbar item with the mode event', () => {
        const modeChanges = new Emitter<void>();
        const disposeCommand = jest.fn();
        const disposeToolbar = jest.fn();
        const commandDisposable = { dispose: disposeCommand };
        const toolbarDisposable = { dispose: disposeToolbar };
        let commandHandler: {
            execute(widget: unknown): unknown;
            isEnabled(widget: unknown): boolean;
            isVisible(widget: unknown): boolean;
            isToggled(): boolean;
        } | undefined;
        const commands = {
            registerCommand: jest.fn().mockImplementation((_command, handler) => {
                commandHandler = handler;
                return commandDisposable;
            })
        };
        const toolbar = {
            registerItem: jest.fn().mockReturnValue(toolbarDisposable)
        };
        const toggleMode = jest.fn();
        const contribution = new ExplorerModeContribution({
            onDidChange: modeChanges.event,
            isMarkdownMode: () => true,
            toggleMode
        } as never);

        contribution.registerCommands(commands as never);
        contribution.registerToolbarItems(toolbar as never);

        const toolbarItem = toolbar.registerItem.mock.calls[0][0];
        const toolbarChanged = jest.fn();
        toolbarItem.onDidChange(toolbarChanged);
        modeChanges.fire(undefined);
        expect(toolbarChanged).toHaveBeenCalledTimes(1);

        const MockFileNavigatorWidget = FileNavigatorWidget as unknown as { new(): FileNavigatorWidget };
        const navigator = new MockFileNavigatorWidget();
        expect(commandHandler?.isEnabled(navigator)).toBe(true);
        expect(commandHandler?.isVisible(navigator)).toBe(true);
        expect(commandHandler?.isToggled()).toBe(true);
        commandHandler?.execute(navigator);
        expect(toggleMode).toHaveBeenCalledTimes(1);
        expect(commandHandler?.isEnabled({ id: 'other' })).toBe(false);
        expect(commandHandler?.isVisible({ id: 'other' })).toBe(false);

        contribution.onStop();
        expect(disposeCommand).toHaveBeenCalledTimes(1);
        expect(disposeToolbar).toHaveBeenCalledTimes(1);
    });
});

class TestStudioExplorerFilter extends StudioExplorerFilter {
    setFilterPredicate(predicate: { filter(item: { id: string }): boolean }): void {
        this.filterPredicate = predicate;
    }

    triggerFilterChanged(): void {
        this.fireFilterChanged();
    }
}

class TestStudioFileTreeLabelProvider extends StudioFileTreeLabelProvider {
    setLabelProvider(labelProvider: object): void {
        Object.defineProperty(this, 'labelProvider', { value: labelProvider });
    }

    setPresentation(presentation: object): void {
        Object.defineProperty(this, 'presentation', { value: presentation });
    }
}

function createLogger() {
    return {
        warn: jest.fn().mockResolvedValue(undefined)
    };
}
