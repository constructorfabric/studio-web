import * as React from '@theia/core/shared/react';
import { MessageService } from '@theia/core';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    ContextMenuRenderer,
    Message,
    Navigatable,
    ReactWidget,
    SaveableSource,
    StatefulWidget
} from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { DisposableCollection } from '@theia/core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    BlockTypeSelect,
    BoldItalicUnderlineToggles,
    type CodeBlockEditorProps,
    CodeToggle,
    CreateLink,
    InsertImage,
    InsertTable,
    ListsToggle,
    MDXEditor,
    type MDXEditorMethods,
    Separator,
    UndoRedo,
    codeBlockPlugin,
    codeMirrorPlugin,
    frontmatterPlugin,
    headingsPlugin,
    imagePlugin,
    linkDialogPlugin,
    linkPlugin,
    listsPlugin,
    markdownShortcutPlugin,
    quotePlugin,
    tablePlugin,
    thematicBreakPlugin,
    toolbarPlugin
} from '@mdxeditor/editor';
import { ThemeService } from '@theia/core/lib/browser/theming';
import '@mdxeditor/editor/style.css';
import {
    chooseCollisionSafeAssetName,
    createAssetNaming,
    createAssetPlacement
} from './markdown-editor-shared';
import { syncEditorMarkdown } from './markdown-editor-sync';
import { MarkdownEditorMenus } from './markdown-editor-contribution';
import { MarkdownEditorModel, MarkdownUpdateOrigin } from './markdown-editor-model';
import { MarkdownEditorConflictService } from './markdown-editor-conflict-service';
import { MermaidCodeBlockEditor } from './markdown-editor-mermaid-block';
import { createMermaidCodeBlockDescriptor } from './markdown-editor-mermaid';

interface MarkdownEditorWidgetOptions {
    readonly uri: string;
}

interface MarkdownEditorWidgetState {
    readonly scrollTop: number;
}

@injectable()
export class MarkdownEditorWidget extends ReactWidget implements Navigatable, SaveableSource, StatefulWidget {
    static readonly FACTORY_ID = 'studio.markdownEditor';

    @inject(MarkdownEditorModel)
    readonly saveable: MarkdownEditorModel;

    @inject(ContextMenuRenderer)
    protected readonly contextMenuRenderer: ContextMenuRenderer;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(MarkdownEditorConflictService)
    protected readonly conflictService: MarkdownEditorConflictService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    protected readonly toDispose = new DisposableCollection();
    protected readonly editorRef = React.createRef<MDXEditorMethods>();
    protected readonly hostRef = React.createRef<HTMLDivElement>();
    protected readonly editorRootRef = React.createRef<HTMLDivElement>();
    protected readonly scrollTopRef = { current: 0 };
    protected pendingTableCellRestoreFrame: number | undefined;
    protected applyingEditorChange = false;
    protected resourceUri: URI | undefined;
    protected initialised = false;
    protected mermaidThemeType = 'light';

    @postConstruct()
    protected init(): void {
        this.id = `${MarkdownEditorWidget.FACTORY_ID}:pending`;
        this.title.closable = true;
        this.title.iconClass = 'file-icon markdown';
        this.addClass('studio-markdown-editor-widget');
        this.node.tabIndex = 0;
    }

    async configure(options: MarkdownEditorWidgetOptions): Promise<void> {
        this.resourceUri = new URI(options.uri);
        await this.saveable.init(this.resourceUri);
        this.id = `${MarkdownEditorWidget.FACTORY_ID}:${this.resourceUri.toString()}`;
        const fileName = this.resourceUri.path.base;
        this.title.label = fileName;
        this.title.caption = fileName;
        this.title.dataset = { uri: this.resourceUri.toString() };
        this.toDispose.push(this.saveable.onDirtyChanged(() => {
            this.update();
        }));
        this.toDispose.push(this.saveable.onContentChanged(() => this.handleModelContentChanged()));
        this.toDispose.push(this.saveable.onExternalChangeChanged(() => this.handleExternalChangeChanged()));
        this.toDispose.push(this.saveable.onSavingChanged(() => this.update()));
        this.mermaidThemeType = this.themeService.getCurrentTheme().type;
        this.toDispose.push(this.themeService.onDidColorThemeChange(event => {
            const nextThemeType = event.newTheme.type;
            if (nextThemeType !== this.mermaidThemeType) {
                this.mermaidThemeType = nextThemeType;
                this.update();
            }
        }));
        this.initialised = true;
        this.update();
    }

    getResourceUri(): URI | undefined {
        return this.resourceUri;
    }

    createMoveToUri(resourceUri: URI): URI | undefined {
        return resourceUri;
    }

    render(): React.ReactNode {
        if (!this.initialised) {
            return <div className='studio-markdown-editor-loading'>Loading Markdown editor...</div>;
        }
        return (
            <div
                className='studio-markdown-editor-shell'
                ref={this.hostRef}
                onContextMenu={this.handleContextMenu}
            >
                {this.renderConflictBanner()}
                <div
                    className='studio-markdown-editor-root'
                    ref={this.editorRootRef}
                    onPointerDownCapture={this.handleEditorRootPointerDownCapture}
                    onScrollCapture={this.handleEditorRootScrollCapture}
                >
                    <MDXEditor
                        ref={this.editorRef}
                        className='studio-markdown-editor'
                        contentEditableClassName='studio-markdown-editor-content'
                        markdown={this.saveable.editorMarkdown}
                        onChange={(value: string, initialMarkdownNormalize: boolean) =>
                            this.handleEditorChange(value, initialMarkdownNormalize ? 'initial' : 'user')}
                        plugins={[
                            headingsPlugin(),
                            listsPlugin(),
                            quotePlugin(),
                            thematicBreakPlugin(),
                            tablePlugin(),
                            linkPlugin(),
                            linkDialogPlugin(),
                            frontmatterPlugin(),
                            codeBlockPlugin({
                                defaultCodeBlockLanguage: 'txt',
                                codeBlockEditorDescriptors: [
                                    createMermaidCodeBlockDescriptor((props: CodeBlockEditorProps) => (
                                        <MermaidCodeBlockEditor {...props} mermaidThemeType={this.mermaidThemeType} />
                                    ))
                                ]
                            }),
                            codeMirrorPlugin({
                                codeBlockLanguages: {
                                    bash: 'Bash',
                                    css: 'CSS',
                                    html: 'HTML',
                                    js: 'JavaScript',
                                    json: 'JSON',
                                    markdown: 'Markdown',
                                    mermaid: 'Mermaid',
                                    ts: 'TypeScript',
                                    txt: 'Plain text',
                                    yaml: 'YAML'
                                }
                            }),
                            imagePlugin({ imageUploadHandler: file => this.saveImage(file) }),
                            markdownShortcutPlugin(),
                            toolbarPlugin({
                                toolbarContents: () => (
                                    <>
                                        <UndoRedo />
                                        <Separator />
                                        <BlockTypeSelect />
                                        <BoldItalicUnderlineToggles />
                                        <CodeToggle />
                                        <Separator />
                                        <ListsToggle />
                                        <CreateLink />
                                        <InsertImage />
                                        <InsertTable />
                                    </>
                                )
                            })
                        ]}
                    />
                </div>
            </div>
        );
    }

    protected renderConflictBanner(): React.ReactNode {
        const externalChange = this.saveable.externalChange;
        if (!externalChange) {
            return undefined;
        }
        const conflictActionsDisabled = this.saveable.saving;
        const conflictCopy = externalChange.kind === 'deleted'
            ? 'The file was deleted or moved on disk while you had local content open. Compare the versions, reload from disk, or keep your local content.'
            : 'The file changed on disk while you had local edits. Compare the versions, reload from disk, or keep your local content.';
        return (
            <div className='studio-markdown-editor-conflict-banner' role='status' aria-live='polite'>
                <span className='studio-markdown-editor-conflict-copy'>
                    {conflictCopy}
                </span>
                <div className='studio-markdown-editor-conflict-actions'>
                    <button type='button' disabled={conflictActionsDisabled} onClick={() => void this.compareExternalChange()}>Compare</button>
                    <button type='button' disabled={conflictActionsDisabled} title='Both versions rendered, side by side' onClick={() => void this.compareExternalChangeRendered()}>Side by side</button>
                    <button type='button' disabled={conflictActionsDisabled} onClick={() => void this.reloadFromDisk()}>Reload from Disk</button>
                    <button type='button' disabled={conflictActionsDisabled} onClick={() => void this.keepLocal()}>Keep Local</button>
                </div>
            </div>
        );
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.focusEditor();
    }

    protected override onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        this.title.caption = this.saveable.dirty ? `${this.resourceUri?.path.base ?? ''}*` : this.resourceUri?.path.base ?? '';
        this.title.label = this.resourceUri?.path.base ?? 'Markdown';
    }

    storeState(): MarkdownEditorWidgetState {
        return { scrollTop: this.captureScrollTop() };
    }

    restoreState(oldState: MarkdownEditorWidgetState): void {
        this.scrollTopRef.current = oldState.scrollTop;
        requestAnimationFrame(() => this.restoreScrollTop());
    }

    focusEditor(): void {
        const contentEditable = this.findContentEditable();
        contentEditable?.focus({ preventScroll: true });
    }

    hasToolbarAction(label: string): boolean {
        const button = this.findToolbarAction(label);
        return !!button && button.getAttribute('aria-disabled') !== 'true' && !button.hasAttribute('disabled');
    }

    supportsClipboardActions(): boolean {
        return !!this.findContentEditable();
    }

    supportsUndoRedo(): boolean {
        return !!this.findContentEditable();
    }

    execNativeAction(action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void {
        this.focusEditor();
        const command = action === 'selectAll' ? 'selectAll' : action;
        document.execCommand(command);
    }

    activateToolbarAction(label: string): boolean {
        const button = this.findToolbarAction(label);
        if (!button || !this.hasToolbarAction(label)) {
            return false;
        }
        this.focusEditor();
        button.click();
        return true;
    }

    protected readonly handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
        event.preventDefault();
        event.stopPropagation();
        this.focusEditor();
        this.contextMenuRenderer.render({
            menuPath: MarkdownEditorMenus.CONTEXT_MENU,
            anchor: event.nativeEvent,
            context: this.node,
            args: [this],
            includeAnchorArg: false
        });
    };

    protected readonly handleEditorRootScrollCapture = (event: React.UIEvent<HTMLDivElement>): void => {
        const editorScroller = this.findEditorScroller();
        if (editorScroller && event.target === editorScroller) {
            this.scrollTopRef.current = editorScroller.scrollTop;
        }
    };

    protected readonly handleEditorRootPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!this.isTableCellPointerDownTarget(event.target)) {
            return;
        }
        const editorScroller = this.findEditorScroller();
        if (!editorScroller) {
            return;
        }
        const scrollTop = editorScroller.scrollTop;
        this.scrollTopRef.current = scrollTop;
        this.cancelPendingTableCellRestore();
        this.pendingTableCellRestoreFrame = requestAnimationFrame(() => {
            this.restoreTableCellScrollTop(scrollTop);
            this.pendingTableCellRestoreFrame = requestAnimationFrame(() => {
                this.pendingTableCellRestoreFrame = undefined;
                this.restoreTableCellScrollTop(scrollTop);
            });
        });
    };

    protected findEditorScroller(): HTMLElement | null {
        return this.editorRootRef.current?.querySelector('.mdxeditor-root-contenteditable') ?? null;
    }

    protected isTableCellPointerDownTarget(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) {
            return false;
        }
        const cell = target.closest('td, th');
        if (!cell || !cell.closest('tbody') || cell.hasAttribute('data-tool-cell')) {
            return false;
        }
        return !!cell.querySelector('[contenteditable="true"]');
    }

    protected findContentEditable(): HTMLElement | null {
        return this.editorRootRef.current?.querySelector<HTMLElement>(
            '.mdxeditor-root-contenteditable .studio-markdown-editor-content[contenteditable="true"]'
        ) ?? this.editorRootRef.current?.querySelector<HTMLElement>(
            '.mdxeditor-root-contenteditable [contenteditable="true"]'
        ) ?? null;
    }

    protected findToolbarAction(label: string): HTMLElement | null {
        return this.editorRootRef.current?.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? null;
    }

    protected handleEditorChange(markdown: string, origin: MarkdownUpdateOrigin = 'user'): void {
        this.applyingEditorChange = true;
        try {
            this.saveable.updateMarkdown(this.saveable.restoreEditorMarkdown(markdown), origin);
        } finally {
            this.applyingEditorChange = false;
        }
    }

    protected handleModelContentChanged(): void {
        if (!this.applyingEditorChange) {
            syncEditorMarkdown(this.editorRef.current, this.saveable.editorMarkdown);
            this.restoreScrollTop();
        }
    }

    protected handleExternalChangeChanged(): void {
        this.update();
    }

    protected captureScrollTop(): number {
        const editorScroller = this.findEditorScroller();
        if (editorScroller) {
            this.scrollTopRef.current = editorScroller.scrollTop;
        }
        return this.scrollTopRef.current;
    }

    protected restoreScrollTop(): void {
        const editorScroller = this.findEditorScroller();
        if (editorScroller) {
            editorScroller.scrollTop = this.scrollTopRef.current;
        }
    }

    protected restoreTableCellScrollTop(scrollTop: number): void {
        const editorScroller = this.findEditorScroller();
        if (editorScroller) {
            editorScroller.scrollTop = scrollTop;
            this.scrollTopRef.current = scrollTop;
        }
    }

    protected cancelPendingTableCellRestore(): void {
        if (this.pendingTableCellRestoreFrame !== undefined) {
            cancelAnimationFrame(this.pendingTableCellRestoreFrame);
            this.pendingTableCellRestoreFrame = undefined;
        }
    }

    protected async saveImage(file: File): Promise<string> {
        const resourceUri = this.getResourceUri();
        if (!resourceUri) {
            throw new Error('Markdown editor resource is unavailable.');
        }
        if (resourceUri.scheme !== 'file') {
            // Assets live next to their document on disk. A portal document
            // (`studio-doc:`) has no directory to put them in, so say so
            // instead of failing inside the file service with "no provider".
            throw new Error('Images cannot be attached to a Studio document — it has no folder to store them in.');
        }
        const documentDirectory = resourceUri.parent;
        const naming = createAssetNaming(resourceUri.path.toString(), file.name, file.type || 'image/png');
        const assetDirectory = documentDirectory.resolve(naming.assetDirName);
        const fileName = await chooseCollisionSafeAssetName(naming, async (candidate: string) => this.fileService.exists(assetDirectory.resolve(candidate)));
        const fileUri = assetDirectory.resolve(fileName);
        await this.fileService.createFolder(assetDirectory);
        await this.fileService.writeFile(fileUri, BinaryBuffer.wrap(new Uint8Array(await file.arrayBuffer())));
        const placement = createAssetPlacement(resourceUri.path.toString(), file.name, file.type || 'image/png', fileName);
        return placement.markdownLink.match(/\((.*)\)/)?.[1] ?? `${naming.assetDirName}/${fileName}`;
    }

    protected async compareExternalChange(): Promise<void> {
        await this.runConflictAction('Compare', async () => {
            await this.conflictService.openDiff(this.saveable);
        });
    }

    protected async compareExternalChangeRendered(): Promise<void> {
        await this.runConflictAction('Side by side', async () => {
            await this.conflictService.openRenderedDiff(this.saveable);
        });
    }

    protected async reloadFromDisk(): Promise<void> {
        await this.runConflictAction('Reload from Disk', async () => {
            this.saveable.reloadFromExternalChange();
        });
    }

    protected async keepLocal(): Promise<void> {
        await this.runConflictAction('Keep Local', async () => {
            await this.saveable.keepLocalAndSave();
        });
    }

    protected async runConflictAction(actionLabel: string, action: () => Promise<void> | void): Promise<void> {
        try {
            await action();
        } catch (error) {
            this.messageService.error(this.describeConflictActionError(actionLabel, error));
        }
    }

    protected describeConflictActionError(actionLabel: string, error: unknown): string {
        const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
        return `${actionLabel} failed${detail}`;
    }

    dispose(): void {
        this.captureScrollTop();
        this.cancelPendingTableCellRestore();
        this.toDispose.dispose();
        this.saveable.dispose();
        super.dispose();
    }
}
