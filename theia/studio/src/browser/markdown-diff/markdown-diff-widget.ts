// A rendered, side-by-side comparison of two versions of a markdown document.
//
// The two versions are any two Resources — a file, a `git:` revision read by
// the built-in git extension, an in-memory snapshot — so the same tab shows
// HEAD against the working tree, a save conflict, or two history entries. It
// follows both sides: when either changes (the file is saved, a commit moves
// HEAD) the comparison is drawn again, at the same scroll position.

import { inject, injectable } from '@theia/core/shared/inversify';
import { BaseWidget, codicon, Message, OpenerService, StatefulWidget, Widget, open } from '@theia/core/lib/browser';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { Disposable, DisposableCollection, MessageService } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { Resource, ResourceProvider } from '@theia/core/lib/common/resource';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { DiffService } from '@theia/workspace/lib/browser/diff-service';
import { countChanges, diffMarkdown, parseMarkdown } from './markdown-diff-model';
import { createMarkdownRenderer, MERMAID_PLACEHOLDER_CLASS, renderDiff } from './markdown-diff-render';
import { MarkdownDiffInput } from './markdown-diff-uri';
import { createMermaidRenderId, getMermaidTheme } from '../markdown-editor/markdown-editor-mermaid';
import { renderMermaidDiagram } from '../markdown-editor/markdown-editor-mermaid-render';

const IMAGE_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};

/** How long a burst of changes to either side settles before the comparison is drawn again. */
const RELOAD_DELAY_MS = 300;

interface Version {
    readonly content: string;
    /** Why it could not be read; the side is then compared as empty. */
    readonly missing?: string;
}

interface State {
    readonly changesOnly: boolean;
}

@injectable()
export class MarkdownDiffWidget extends BaseWidget implements StatefulWidget {
    static readonly FACTORY_ID = 'studio.markdownDiff';

    @inject(ResourceProvider)
    protected readonly resources: ResourceProvider;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(DiffService)
    protected readonly diffService: DiffService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    protected readonly md = createMarkdownRenderer();
    protected input: MarkdownDiffInput | undefined;
    protected changesOnly = false;
    protected expanded = new Set<number>();
    protected changes: HTMLElement[] = [];
    protected readonly watching = new DisposableCollection();
    protected readonly drawn = new DisposableCollection();
    protected reloadTimer: ReturnType<typeof setTimeout> | undefined;
    protected versions: [Version, Version] | undefined;
    protected generation = 0;

    protected readonly header: HTMLElement;
    protected readonly leftLabel: HTMLElement;
    protected readonly rightLabel: HTMLElement;
    protected readonly summary: HTMLElement;
    protected readonly changesOnlyButton: HTMLButtonElement;
    protected readonly scroller: HTMLElement;
    protected readonly ruler: HTMLElement;

    constructor() {
        super();
        this.addClass('studio-md-diff');
        this.title.closable = true;
        this.title.iconClass = codicon('diff');
        this.node.tabIndex = 0;

        this.header = this.element('div', 'studio-md-diff-header');
        const columns = this.element('div', 'studio-md-diff-columns');
        this.leftLabel = this.element('span', 'studio-md-diff-label old');
        this.rightLabel = this.element('span', 'studio-md-diff-label new');
        columns.append(this.leftLabel, this.rightLabel);
        const tools = this.element('div', 'studio-md-diff-tools');
        this.summary = this.element('span', 'studio-md-diff-summary');
        this.changesOnlyButton = this.button('list-filter', 'Show only the changes', () => this.setChangesOnly(!this.changesOnly));
        tools.append(
            this.summary,
            this.button('arrow-up', 'Previous change', () => this.reveal(-1)),
            this.button('arrow-down', 'Next change', () => this.reveal(1)),
            this.changesOnlyButton,
            this.button('go-to-file', 'Open as a text diff', () => this.openTextDiff()),
            this.button('refresh', 'Read both versions again', () => this.reload()),
        );
        this.header.append(columns, tools);

        const body = this.element('div', 'studio-md-diff-body');
        this.scroller = this.element('div', 'studio-md-diff-scroller');
        this.ruler = this.element('div', 'studio-md-diff-ruler');
        body.append(this.scroller, this.ruler);
        this.node.append(this.header, body);

        this.scroller.addEventListener('click', event => this.onClick(event));
        this.ruler.addEventListener('click', event => this.onRulerClick(event));
        this.toDispose.pushAll([this.watching, this.drawn, Disposable.create(() => clearTimeout(this.reloadTimer))]);
    }

    getInput(): MarkdownDiffInput | undefined {
        return this.input;
    }

    async setInput(input: MarkdownDiffInput): Promise<void> {
        this.input = input;
        this.title.label = input.title;
        // The file's path, as an editor tab's caption is; the title already names the two versions.
        this.title.caption = input.base ? new URI(input.base).path.fsPath() : input.title;
        this.leftLabel.textContent = input.left.label;
        this.rightLabel.textContent = input.right.label;
        this.toDispose.push(this.themeService.onDidColorThemeChange(() => this.drawDiagrams()));
        await this.watch();
        await this.reload();
    }

    storeState(): State {
        return { changesOnly: this.changesOnly };
    }

    restoreState(state: State): void {
        this.changesOnly = !!state.changesOnly;
        this.changesOnlyButton.classList.toggle('active', this.changesOnly);
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.drawRuler();
    }

    /** Draw again when either version changes. */
    protected async watch(): Promise<void> {
        this.watching.dispose();
        if (!this.input) {
            return;
        }
        for (const side of [this.input.left, this.input.right]) {
            try {
                const resource = await this.resources(new URI(side.uri));
                this.watching.push(resource);
                if (resource.onDidChangeContents) {
                    this.watching.push(resource.onDidChangeContents(() => this.scheduleReload()));
                }
            } catch {
                // Unreadable: reload() says so, and there is nothing to follow.
            }
        }
    }

    protected scheduleReload(): void {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DELAY_MS);
    }

    async reload(): Promise<void> {
        if (!this.input) {
            return;
        }
        const generation = ++this.generation;
        const versions = await Promise.all([this.read(this.input.left.uri), this.read(this.input.right.uri)]) as [Version, Version];
        if (generation !== this.generation || this.isDisposed) {
            return;
        }
        this.versions = versions;
        this.draw();
    }

    protected async read(uri: string): Promise<Version> {
        let resource: Resource | undefined;
        try {
            resource = await this.resources(new URI(uri));
            return { content: await resource.readContents() };
        } catch (error) {
            // A file added since HEAD is not in HEAD, and one deleted is not on
            // disk: both are ordinary, and compare as an empty side.
            return { content: '', missing: error instanceof Error ? error.message : String(error) };
        } finally {
            resource?.dispose();
        }
    }

    protected draw(): void {
        if (!this.versions) {
            return;
        }
        const [left, right] = this.versions;
        const scrollTop = this.scroller.scrollTop;
        // Why a column is empty, where the reader looks for it.
        this.leftLabel.title = left.missing ?? '';
        this.rightLabel.title = right.missing ?? '';
        this.leftLabel.classList.toggle('missing', !!left.missing);
        this.rightLabel.classList.toggle('missing', !!right.missing);
        this.drawn.dispose();
        this.scroller.textContent = '';
        if (left.missing && right.missing) {
            const error = this.element('div', 'studio-md-diff-error');
            error.textContent = `Neither version could be read. ${right.missing}`;
            this.scroller.appendChild(error);
            this.summary.textContent = '';
            this.changes = [];
            this.drawRuler();
            return;
        }
        const oldDoc = parseMarkdown(this.md, left.content);
        const newDoc = parseMarkdown(this.md, right.content);
        const rows = diffMarkdown(oldDoc, newDoc);
        const rendered = renderDiff(this.node.ownerDocument, this.md, rows, oldDoc, newDoc, {
            changesOnly: this.changesOnly,
            expanded: this.expanded,
        });
        rendered.root.classList.toggle('left-missing', !!left.missing);
        rendered.root.classList.toggle('right-missing', !!right.missing);
        this.scroller.appendChild(rendered.root);
        this.changes = rendered.changes;
        this.summary.textContent = summaryOf(countChanges(rows), left, right, this.input!);
        this.drawImages(rendered.root);
        this.drawDiagrams();
        this.scroller.scrollTop = scrollTop;
        this.drawRuler();
    }

    protected setChangesOnly(changesOnly: boolean): void {
        this.changesOnly = changesOnly;
        this.expanded = new Set();
        this.changesOnlyButton.classList.toggle('active', changesOnly);
        this.draw();
    }

    /** Scroll to the next (`1`) or previous (`-1`) change from the top of the view. */
    reveal(direction: 1 | -1): void {
        if (!this.changes.length) {
            return;
        }
        const top = this.scroller.scrollTop + 4;
        const offsets = this.changes.map(change => this.offsetOf(change));
        let index = direction > 0
            ? offsets.findIndex(offset => offset > top)
            : findLastIndex(offsets, offset => offset < top - 8);
        if (index < 0) {
            index = direction > 0 ? 0 : this.changes.length - 1;
        }
        this.scroller.scrollTo({ top: Math.max(0, offsets[index] - 16), behavior: 'smooth' });
        this.flash(this.changes[index]);
    }

    protected flash(element: HTMLElement): void {
        element.classList.remove('studio-md-diff-flash');
        void element.offsetWidth;
        element.classList.add('studio-md-diff-flash');
    }

    protected offsetOf(element: HTMLElement): number {
        return element.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    }

    /** The change markers beside the scrollbar, one per changed row, at its height in the document. */
    protected drawRuler(): void {
        this.ruler.textContent = '';
        const height = this.scroller.scrollHeight;
        if (!height || !this.changes.length) {
            return;
        }
        for (const change of this.changes) {
            const marker = this.element('div', 'studio-md-diff-marker');
            const kind = ['modified', 'replaced', 'added', 'removed'].find(name => change.classList.contains(name));
            if (kind) {
                marker.classList.add(kind);
            }
            marker.style.top = `${(this.offsetOf(change) / height) * 100}%`;
            marker.style.height = `${Math.max((change.offsetHeight / height) * 100, 0.4)}%`;
            this.ruler.appendChild(marker);
        }
    }

    protected onRulerClick(event: MouseEvent): void {
        const fraction = (event.clientY - this.ruler.getBoundingClientRect().top) / this.ruler.clientHeight;
        this.scroller.scrollTo({ top: fraction * this.scroller.scrollHeight - this.scroller.clientHeight / 2, behavior: 'smooth' });
    }

    protected onClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        const fold = target.closest<HTMLElement>('.studio-md-diff-fold');
        if (fold?.dataset.fold) {
            this.expanded.add(Number(fold.dataset.fold));
            this.draw();
            return;
        }
        const link = target.closest<HTMLAnchorElement>('a[href]');
        if (link) {
            event.preventDefault();
            void this.follow(link.getAttribute('href')!);
        }
    }

    /** A link in the document: the web in the browser, a relative path in the editor, an anchor nowhere. */
    protected async follow(href: string): Promise<void> {
        if (href.startsWith('#')) {
            return;
        }
        try {
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
                if (/^(https?|mailto):/i.test(href)) {
                    await open(this.openerService, new URI(href));
                }
                return;
            }
            const base = this.baseUri();
            if (base) {
                await open(this.openerService, base.parent.resolve(decodeURIComponent(href.split('#')[0])));
            }
        } catch (error) {
            this.messageService.warn(`Could not open ${href}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** The file the document's relative paths are relative to. */
    protected baseUri(): URI | undefined {
        if (!this.input) {
            return undefined;
        }
        const candidates = [this.input.base, this.input.right.uri, this.input.left.uri].filter((uri): uri is string => !!uri);
        const file = candidates.map(uri => new URI(uri)).find(uri => uri.scheme === 'file');
        return file;
    }

    /**
     * Relative images, read through the file service and shown from blob
     * URLs: the frontend has no URL of its own for a workspace file, and in
     * the portal's session the files are not on the machine showing them.
     * Both columns show the working tree's image — a revision's image is the
     * image's own diff, not this document's.
     */
    protected drawImages(root: HTMLElement): void {
        const base = this.baseUri();
        if (!base) {
            return;
        }
        const generation = this.generation;
        const urls = new Map<string, Promise<string | undefined>>();
        for (const image of Array.from(root.querySelectorAll('img'))) {
            const src = image.getAttribute('src');
            if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) {
                continue;
            }
            image.removeAttribute('src');
            const uri = base.parent.resolve(decodeURIComponent(src));
            const type = IMAGE_TYPES[uri.path.ext.toLowerCase()];
            if (!type) {
                continue;
            }
            const key = uri.toString();
            if (!urls.has(key)) {
                urls.set(key, this.fileService.readFile(uri).then(file => {
                    const url = URL.createObjectURL(new Blob([file.value.buffer], { type }));
                    this.drawn.push(Disposable.create(() => URL.revokeObjectURL(url)));
                    return url;
                }, () => undefined));
            }
            void urls.get(key)!.then(url => {
                if (url && generation === this.generation) {
                    image.src = url;
                    image.addEventListener('load', () => this.drawRuler(), { once: true });
                }
            });
        }
    }

    protected drawDiagrams(): void {
        const theme = getMermaidTheme(this.themeService.getCurrentTheme().type);
        const generation = this.generation;
        for (const placeholder of Array.from(this.scroller.querySelectorAll<HTMLElement>(`.${MERMAID_PLACEHOLDER_CLASS}`))) {
            const code = placeholder.dataset.source ?? placeholder.textContent ?? '';
            placeholder.dataset.source = code;
            // Unique in the page, not per widget: mermaid removes any element that
            // already has the id it renders under — another tab's diagram.
            renderMermaidDiagram({ code, theme, renderId: createMermaidRenderId('md-diff') }).then(svg => {
                if (generation === this.generation && placeholder.isConnected) {
                    placeholder.innerHTML = svg;
                    placeholder.classList.add('drawn');
                    this.drawRuler();
                }
            }, error => {
                placeholder.title = error instanceof Error ? error.message : String(error);
            });
        }
    }

    protected async openTextDiff(): Promise<void> {
        if (this.input) {
            await this.diffService.openDiffEditor(new URI(this.input.left.uri), new URI(this.input.right.uri), this.input.title);
        }
    }

    protected element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
        const element = this.node.ownerDocument.createElement(tag);
        element.className = className;
        return element;
    }

    protected button(icon: string, title: string, action: () => void): HTMLButtonElement {
        const button = this.element('button', `studio-md-diff-button ${codicon(icon)}`);
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.addEventListener('click', action);
        return button;
    }
}

function summaryOf(counts: ReturnType<typeof countChanges>, left: Version, right: Version, input: MarkdownDiffInput): string {
    const parts: Array<string | 0> = [
        left.missing ? `Not in ${input.left.label}` : 0,
        right.missing ? `Not in ${input.right.label}` : 0,
    ];
    parts.push(
        counts.modified && `${counts.modified} changed`,
        counts.added && `${counts.added} added`,
        counts.removed && `${counts.removed} removed`,
    );
    const shown = parts.filter((part): part is string => !!part);
    return shown.length ? shown.join(' · ') : 'No changes';
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
    for (let index = items.length - 1; index >= 0; index--) {
        if (predicate(items[index])) {
            return index;
        }
    }
    return -1;
}
