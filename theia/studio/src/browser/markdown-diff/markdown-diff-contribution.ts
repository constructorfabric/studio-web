// Where a rendered comparison is opened from: a markdown file's tab and the
// explorer (against HEAD), any text diff of two markdown versions (the same
// two versions, rendered), and other extensions by command.

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, codicon, Navigatable } from '@theia/core/lib/browser';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { Command, CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService, QuickInputService, SelectionService } from '@theia/core';
import { MarkdownDiffGitService, type MarkdownDiffRef } from '../../common/markdown-diff-git-protocol';
import { UriSelection } from '@theia/core/lib/common/selection';
import URI from '@theia/core/lib/common/uri';
import { EditorWidget } from '@theia/editor/lib/browser';
import { MonacoDiffEditor } from '@theia/monaco/lib/browser/monaco-diff-editor';
import { NavigatorContextMenu } from '@theia/navigator/lib/browser/navigator-contribution';
import { MarkdownDiffRequest, MarkdownDiffService, MarkdownDiffVersion } from './markdown-diff-service';
import { isMarkdownUri, sideLabel, toGitUri } from './markdown-diff-uri';

export namespace MarkdownDiffCommands {
    export const COMPARE_WITH_HEAD: Command = Command.toDefaultLocalizedCommand({
        id: 'studio.markdownDiff.compareWithHead',
        category: 'Markdown',
        label: 'Compare with HEAD (Rendered)',
        iconClass: codicon('git-compare'),
    });
    export const COMPARE_WITH_REF: Command = Command.toDefaultLocalizedCommand({
        id: 'studio.markdownDiff.compareWithRef',
        category: 'Markdown',
        label: 'Compare with Branch or Tag... (Rendered)',
        iconClass: codicon('git-branch'),
    });
    export const OPEN_RENDERED: Command = Command.toDefaultLocalizedCommand({
        id: 'studio.markdownDiff.openRendered',
        category: 'Markdown',
        label: 'Open Rendered Diff',
        iconClass: codicon('open-preview'),
    });
    /**
     * Compare two versions given by the caller — a `MarkdownDiffRequest`, with
     * uris as strings. No label, so not in the command palette: it is how
     * other extensions (the Documents editor's history and conflicts) open
     * the view without depending on this package.
     */
    export const COMPARE: Command = { id: 'studio.markdownDiff.compare' };
    /**
     * `(uri, content)` → `{ commit, author }` when `content` is what a commit
     * has for that file (a pull, a checkout, Share with the team wrote it),
     * else undefined. The Documents editor asks before it holds a write
     * nobody claimed for review.
     */
    export const COMMITTED_VERSION: Command = { id: 'studio.git.committedVersion' };
}

/** Schemes read live; anything else in a text diff is taken as the text the diff editor holds. */
const LIVE_SCHEMES = new Set(['file', 'git']);

@injectable()
export class MarkdownDiffContribution implements CommandContribution, MenuContribution, TabBarToolbarContribution {
    @inject(MarkdownDiffService)
    protected readonly diffs: MarkdownDiffService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(SelectionService)
    protected readonly selectionService: SelectionService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MarkdownDiffGitService)
    protected readonly git: MarkdownDiffGitService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(MarkdownDiffCommands.COMPARE_WITH_HEAD, {
            isEnabled: (...args: unknown[]) => !!this.markdownFile(args[0]),
            isVisible: (...args: unknown[]) => !!this.markdownFile(args[0]),
            execute: (...args: unknown[]) => {
                const file = this.markdownFile(args[0]);
                // A second argument may carry the caller's open discussions (product-ext's editor).
                const notes = (args[1] as Pick<MarkdownDiffRequest, 'notes'> | undefined)?.notes;
                return file && this.report(this.diffs.compareWithHead(file, notes));
            },
        });
        commands.registerCommand(MarkdownDiffCommands.COMPARE_WITH_REF, {
            isEnabled: (...args: unknown[]) => !!this.markdownFile(args[0]),
            isVisible: (...args: unknown[]) => !!this.markdownFile(args[0]),
            execute: (...args: unknown[]) => {
                const file = this.markdownFile(args[0]);
                return file && this.report(this.compareWithRef(file));
            },
        });
        commands.registerCommand(MarkdownDiffCommands.OPEN_RENDERED, {
            isEnabled: (...args: unknown[]) => !!this.markdownDiffEditor(args[0]),
            isVisible: (...args: unknown[]) => !!this.markdownDiffEditor(args[0]),
            execute: (...args: unknown[]) => {
                const diff = this.markdownDiffEditor(args[0]);
                const widget = args[0] ?? this.shell.activeWidget ?? this.shell.currentWidget;
                const title = widget instanceof EditorWidget ? widget.title.label : 'Markdown';
                return diff && this.report(this.diffs.open(this.requestFrom(diff, title)));
            },
        });
        commands.registerCommand(MarkdownDiffCommands.COMPARE, {
            execute: (request: MarkdownDiffRequest) => this.report(this.diffs.open(request)),
        });
        commands.registerCommand(MarkdownDiffCommands.COMMITTED_VERSION, {
            execute: async (uri: string, content: string) => {
                const file = new URI(String(uri));
                if (file.scheme !== 'file' || typeof content !== 'string') {
                    return undefined;
                }
                try {
                    return await this.git.committedVersion(file.toString(), content);
                } catch {
                    // Not knowing is the old behaviour: the write is held for review.
                    return undefined;
                }
            },
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NavigatorContextMenu.COMPARE, {
            commandId: MarkdownDiffCommands.COMPARE_WITH_HEAD.id,
            label: MarkdownDiffCommands.COMPARE_WITH_HEAD.label,
        });
        menus.registerMenuAction(NavigatorContextMenu.COMPARE, {
            commandId: MarkdownDiffCommands.COMPARE_WITH_REF.id,
            label: MarkdownDiffCommands.COMPARE_WITH_REF.label,
        });
    }

    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        toolbar.registerItem({
            id: MarkdownDiffCommands.OPEN_RENDERED.id,
            command: MarkdownDiffCommands.OPEN_RENDERED.id,
            tooltip: 'Show these two versions rendered, side by side',
            priority: 10,
        });
        toolbar.registerItem({
            id: MarkdownDiffCommands.COMPARE_WITH_HEAD.id,
            command: MarkdownDiffCommands.COMPARE_WITH_HEAD.id,
            tooltip: 'Show what changed since the last commit, rendered',
            priority: 10,
        });
    }

    /**
     * The markdown file a command is about: the tab it was clicked on, the
     * file the focused widget shows, or the explorer's selection — in that
     * order, because the explorer keeps its selection while the reader is
     * somewhere else. Not a text diff's: that one compares two versions
     * already, and OPEN_RENDERED shows those.
     */
    protected markdownFile(arg: unknown): URI | undefined {
        const widget = arg === undefined ? this.shell.activeWidget : arg;
        if (widget instanceof EditorWidget && widget.editor instanceof MonacoDiffEditor) {
            return undefined;
        }
        const candidates = [
            widget instanceof URI ? widget : undefined,
            Navigatable.is(widget) ? widget.getResourceUri() : undefined,
            arg === undefined ? UriSelection.getUri(this.selectionService.selection) : undefined,
        ];
        const uri = candidates.find(candidate => !!candidate);
        return uri && uri.scheme === 'file' && isMarkdownUri(uri) ? uri : undefined;
    }

    /**
     * A text diff editor whose two sides are markdown. Asked of the editor
     * itself: a diff editor's resource uri is its MODIFIED side
     * (MonacoDiffEditor.getResourceUri), not the `diff:` uri it was opened with.
     */
    protected markdownDiffEditor(arg: unknown): MonacoDiffEditor | undefined {
        const widget = arg ?? this.shell.activeWidget ?? this.shell.currentWidget;
        if (!(widget instanceof EditorWidget) || !(widget.editor instanceof MonacoDiffEditor)) {
            return undefined;
        }
        const diff = widget.editor;
        return [diff.originalModel.uri, diff.modifiedModel.uri].every(uri => isMarkdownUri(new URI(uri))) ? diff : undefined;
    }

    protected requestFrom(diff: MonacoDiffEditor, title: string): MarkdownDiffRequest {
        const left = new URI(diff.originalModel.uri);
        const right = new URI(diff.modifiedModel.uri);
        const version = (uri: URI, text: () => string): MarkdownDiffVersion => {
            // An in-memory side (a conflict's two versions) may be gone as
            // soon as its diff editor opened; the editor still holds the text.
            if (!LIVE_SCHEMES.has(uri.scheme)) {
                return { content: text(), label: sideLabel(uri).replace(/\.(md|markdown)$/i, '') };
            }
            return { uri };
        };
        return {
            title: `${title} (Rendered)`,
            left: version(left, () => diff.originalModel.getText()),
            right: version(right, () => diff.modifiedModel.getText()),
            base: [right, left].find(uri => uri.scheme === 'file') ?? fileOfGitUri(right) ?? fileOfGitUri(left),
        };
    }

    /**
     * A colleague's branch, a release tag: pick the ref, then which question —
     * how my document differs from theirs, or what their branch changed since
     * it left mine (the merge base against the branch: a pull request's view).
     */
    protected async compareWithRef(file: URI): Promise<unknown> {
        const { refs, current } = await this.git.listRefs(file.toString());
        const candidates = refs.filter(ref => ref.name !== current);
        if (!candidates.length) {
            this.messageService.info(`${file.path.base}: no other branch or tag to compare with.`);
            return undefined;
        }
        const pickedRef = await this.quickInput.pick(candidates.map(ref => ({ label: ref.name, description: refDescription(ref), ref })), {
            placeHolder: `Compare ${file.path.base} with...`,
            matchOnDescription: true,
        });
        if (!pickedRef) {
            return undefined;
        }
        const ref = pickedRef.ref;
        const question = await this.quickInput.pick([
            { label: `Mine \u2194 ${ref.name}`, description: 'how your document differs from it', id: 'mine' as const },
            { label: `What ${ref.name} changed`, description: 'since it branched off yours, as a pull request shows it', id: 'branch' as const },
        ], { placeHolder: ref.name });
        if (!question) {
            return undefined;
        }
        if (question.id === 'mine') {
            return this.diffs.open({
                left: { uri: toGitUri(file, ref.name), label: ref.name },
                right: { uri: file, label: 'Working Tree' },
                base: file,
            });
        }
        const base = await this.git.mergeBase(file.toString(), ref.name);
        if (!base) {
            this.messageService.warn(`${ref.name} and your branch share no history to compare from.`);
            return undefined;
        }
        return this.diffs.open({
            title: `${file.path.base} (what ${ref.name} changed)`,
            left: { uri: toGitUri(file, base), label: `Where it branched \u00b7 ${base.slice(0, 7)}` },
            right: { uri: toGitUri(file, ref.name), label: ref.name },
            base: file,
        });
    }

    protected async report<T>(opening: Promise<T>): Promise<T | undefined> {
        try {
            return await opening;
        } catch (error) {
            this.messageService.error(`Could not open the rendered comparison: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }
}

function refDescription(ref: MarkdownDiffRef): string {
    const kind = ref.kind === 'remote' ? 'remote branch' : ref.kind;
    const when = ref.date ? new Date(ref.date).toLocaleDateString() : '';
    return [kind, ref.author, when].filter(Boolean).join(' \u00b7 ');
}

/** The working-tree file behind a `git:` revision uri. */
function fileOfGitUri(uri: URI): URI | undefined {
    return uri.scheme === 'git' ? uri.withScheme('file').withQuery('') : undefined;
}
