import { inject, injectable, named } from '@theia/core/shared/inversify';
import { codicon } from '@theia/core/lib/browser/widgets';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { Command, CommandContribution, CommandRegistry, nls } from '@theia/core/lib/common';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { ILogger } from '@theia/core/lib/common/logger';
import { DidChangeLabelEvent, LabelProvider, LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Event } from '@theia/core/lib/common/event';
import URI from '@theia/core/lib/common/uri';
import { DirNode, FileStatNode } from '@theia/filesystem/lib/browser/file-tree/file-tree';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileNavigatorFilter } from '@theia/navigator/lib/browser/navigator-filter';
import { FileNavigatorWidget, FILE_NAVIGATOR_ID } from '@theia/navigator/lib/browser/navigator-widget';
import { WorkspaceRootNode } from '@theia/navigator/lib/browser/navigator-tree';
import { FileNavigatorPreferences } from '@theia/navigator/lib/common/navigator-preferences';
import { ExplorerPresentationService } from './explorer-presentation-service';

export const ToggleExplorerModeCommand: Command = {
    id: 'studio.explorer.toggle-mode',
    label: nls.localizeByDefault('Markdown Explorer Mode'),
    iconClass: codicon('list-tree')
};

@injectable()
export class StudioExplorerFilter extends FileNavigatorFilter implements FrontendApplicationContribution {
    protected readonly directoryMarkdownCache = new Map<string, Promise<boolean>>();
    protected readonly toDispose = new DisposableCollection();

    constructor(
        @inject(FileNavigatorPreferences) preferences: FileNavigatorPreferences,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(ExplorerPresentationService) protected readonly presentation: ExplorerPresentationService,
        @inject(ILogger) @named('studio:StudioExplorerFilter') protected readonly logger: ILogger
    ) {
        super(preferences);
        this.toDispose.push(this.presentation.onDidChange(changedUris => {
            if (changedUris) {
                this.invalidateDirectoryCache(changedUris);
            } else {
                this.directoryMarkdownCache.clear();
            }
            this.firePresentationFilterChanged();
        }));
    }

    onStop(): void {
        this.directoryMarkdownCache.clear();
        this.toDispose.dispose();
    }

    override async filter<T extends { id: string }>(items: Promise<T[]> | T[]): Promise<T[]> {
        const visibleItems = await super.filter(items);
        if (!this.presentation.isMarkdownMode()) {
            return visibleItems;
        }

        const keepFlags = await Promise.all(visibleItems.map(item => Promise.resolve(this.shouldKeepItem(item))));
        return visibleItems.filter((_, index) => keepFlags[index]);
    }

    protected shouldKeepItem(item: { id: string }): Promise<boolean> | boolean {
        if (!FileStatNode.is(item)) {
            return true;
        }
        if (DirNode.is(item)) {
            return this.directoryContainsMarkdown(item.uri);
        }
        return this.presentation.isShownUri(item.uri);
    }

    protected async directoryContainsMarkdown(uri: URI): Promise<boolean> {
        const cacheKey = uri.toString();
        const cached = this.directoryMarkdownCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const pending = this.doDirectoryContainsMarkdown(uri);
        this.directoryMarkdownCache.set(cacheKey, pending);
        try {
            return await pending;
        } catch (error) {
            if (this.directoryMarkdownCache.get(cacheKey) === pending) {
                this.directoryMarkdownCache.delete(cacheKey);
            }
            void this.logger.warn(`Failed to inspect '${uri.toString()}' for Markdown files.`, error);
            return true;
        }
    }

    protected async doDirectoryContainsMarkdown(uri: URI): Promise<boolean> {
        const directory = await this.fileService.resolve(uri);
        for (const child of directory.children || []) {
            if (!this.filterPredicate.filter({ id: child.resource.path.toString() })) {
                continue;
            }
            if (child.isDirectory) {
                if (await this.directoryContainsMarkdown(child.resource)) {
                    return true;
                }
                continue;
            }
            if (await this.presentation.isShownUri(child.resource)) {
                return true;
            }
        }
        return false;
    }

    protected override fireFilterChanged(): void {
        this.directoryMarkdownCache.clear();
        super.fireFilterChanged();
    }

    protected firePresentationFilterChanged(): void {
        super.fireFilterChanged();
    }

    protected invalidateDirectoryCache(changedUris: readonly URI[]): void {
        for (const cacheKey of this.directoryMarkdownCache.keys()) {
            const cachedUri = new URI(cacheKey);
            if (changedUris.some(changedUri =>
                cachedUri.isEqualOrParent(changedUri) || changedUri.isEqualOrParent(cachedUri)
            )) {
                this.directoryMarkdownCache.delete(cacheKey);
            }
        }
    }
}

@injectable()
export class StudioFileTreeLabelProvider implements LabelProviderContribution {
    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(ExplorerPresentationService)
    protected readonly presentation: ExplorerPresentationService;

    get onDidChange(): Event<DidChangeLabelEvent> {
        return this.presentation.onDidChangeLabels;
    }

    canHandle(element: object): number {
        return FileStatNode.is(element) && WorkspaceRootNode.find(element) ? 101 : 0;
    }

    getIcon(node: FileStatNode): string {
        return this.labelProvider.getIcon(node.fileStat);
    }

    getName(node: FileStatNode): string {
        return this.presentation.getDisplayName(node, this.labelProvider.getName(node.fileStat));
    }

    getLongName(node: FileStatNode): string {
        return this.labelProvider.getLongName(node.fileStat);
    }

    affects(node: FileStatNode, event: DidChangeLabelEvent): boolean {
        return event.affects(node);
    }
}

@injectable()
export class ExplorerModeContribution implements CommandContribution, TabBarToolbarContribution, FrontendApplicationContribution {
    protected readonly toDispose = new DisposableCollection();

    constructor(
        @inject(ExplorerPresentationService) protected readonly presentation: ExplorerPresentationService
    ) {}

    registerCommands(commands: CommandRegistry): void {
        this.toDispose.push(commands.registerCommand(ToggleExplorerModeCommand, {
            execute: widget => this.withNavigator(widget, () => this.presentation.toggleMode()),
            isEnabled: widget => this.withNavigator(widget, () => true),
            isVisible: widget => this.withNavigator(widget, () => true),
            isToggled: () => this.presentation.isMarkdownMode()
        }));
    }

    registerToolbarItems(toolbarRegistry: TabBarToolbarRegistry): void {
        this.toDispose.push(toolbarRegistry.registerItem({
            id: ToggleExplorerModeCommand.id,
            command: ToggleExplorerModeCommand.id,
            tooltip: nls.localizeByDefault('Show only documents (the types in Project settings → Files shown), or every file'),
            onDidChange: Event.map(this.presentation.onDidChange, () => undefined),
            priority: 4
        }));
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected withNavigator<T>(widget: unknown, callback: (navigator: FileNavigatorWidget) => T): T | false {
        if (widget instanceof FileNavigatorWidget && widget.id === FILE_NAVIGATOR_ID) {
            return callback(widget);
        }
        return false;
    }
}
