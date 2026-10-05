// Opening a rendered comparison: from two addresses, from two texts, or of a
// file against its last commit.

import { inject, injectable } from '@theia/core/shared/inversify';
import { WidgetOpenerOptions, WidgetOpenHandler } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { InMemoryResources } from '@theia/core/lib/common/resource';
import { MarkdownDiffWidget } from './markdown-diff-widget';
import { encodeMarkdownDiffUri, MARKDOWN_DIFF_SCHEME, sideLabel, toGitUri } from './markdown-diff-uri';

/** One version to compare: where to read it, or the text itself. */
export interface MarkdownDiffVersion {
    readonly uri?: URI | string;
    readonly content?: string;
    readonly label?: string;
}

export interface MarkdownDiffRequest {
    readonly left: MarkdownDiffVersion;
    readonly right: MarkdownDiffVersion;
    /** The tab's title; by default the file name and the two labels. */
    readonly title?: string;
    /** The document's file, for relative images and links. */
    readonly base?: URI | string;
    /** Open discussions to mark in the comparison (MarkdownDiffNote). */
    readonly notes?: ReadonlyArray<{ readonly quote: string; readonly label: string }>;
}

/** Discussions carried into one comparison; past this the badges are noise. */
const NOTE_LIMIT = 100;

@injectable()
export class MarkdownDiffOpenHandler extends WidgetOpenHandler<MarkdownDiffWidget> {
    // Also the widget factory's id: WidgetOpenHandler finds and creates its
    // widgets through the factory registered under its own id.
    readonly id = MarkdownDiffWidget.FACTORY_ID;

    canHandle(uri: URI): number {
        return uri.scheme === MARKDOWN_DIFF_SCHEME ? 500 : 0;
    }

    protected createWidgetOptions(uri: URI): { uri: string } {
        return { uri: uri.toString() };
    }
}

@injectable()
export class MarkdownDiffService {
    @inject(MarkdownDiffOpenHandler)
    protected readonly openHandler: MarkdownDiffOpenHandler;

    @inject(InMemoryResources)
    protected readonly memory: InMemoryResources;

    protected snapshotSequence = 0;
    // Snapshot addresses must not repeat across page loads: a tab restored with
    // the layout keeps its old address, and a new comparison at the same
    // address would be handed that tab, whose snapshots died with the page.
    protected readonly snapshotSession = Date.now().toString(36);

    async open(request: MarkdownDiffRequest, options?: WidgetOpenerOptions): Promise<MarkdownDiffWidget> {
        const snapshots: Array<{ dispose(): void }> = [];
        const side = (version: MarkdownDiffVersion, fallback: string): { uri: string; label: string } => {
            if (version.content !== undefined) {
                // A text with no address — a history entry, the unsaved side
                // of a conflict — lives in memory for as long as its tab.
                const uri = new URI(`memory://studio-markdown-diff/${this.snapshotSession}-${this.snapshotSequence++}/${fallback}.md`);
                snapshots.push(this.memory.add(uri, version.content));
                return { uri: uri.toString(), label: version.label ?? fallback };
            }
            if (!version.uri) {
                throw new Error('A version to compare needs a uri or its content.');
            }
            const uri = new URI(version.uri.toString());
            return { uri: uri.toString(), label: version.label ?? sideLabel(uri) };
        };
        const left = side(request.left, 'Before');
        const right = side(request.right, 'After');
        const base = request.base?.toString() ?? [request.right.uri, request.left.uri]
            .filter((uri): uri is URI | string => !!uri)
            .map(uri => new URI(uri.toString()))
            .find(uri => uri.scheme === 'file')?.toString();
        const name = base ? new URI(base).path.base : 'Markdown';
        const title = request.title ?? `${name} (${left.label} ↔ ${right.label})`;
        try {
            const notes = (request.notes ?? []).filter(note => note.quote && note.quote.trim()).slice(0, NOTE_LIMIT);
            const uri = encodeMarkdownDiffUri({ title, left, right, base, ...(notes.length ? { notes } : {}) });
            const existing = await this.openHandler.getByUri(uri);
            const widget = await this.openHandler.open(uri, { mode: 'activate', ...options });
            if (existing) {
                // Already open: show what the versions say now, not what they said then.
                await widget.reload();
            }
            widget.disposed.connect(() => snapshots.forEach(snapshot => snapshot.dispose()));
            return widget;
        } catch (error) {
            snapshots.forEach(snapshot => snapshot.dispose());
            throw error;
        }
    }

    /** The file against its last commit, read through the built-in git extension. */
    compareWithHead(file: URI, notes?: MarkdownDiffRequest['notes']): Promise<MarkdownDiffWidget> {
        return this.open({
            left: { uri: toGitUri(file, 'HEAD'), label: 'HEAD' },
            right: { uri: file, label: 'Working Tree' },
            base: file,
            ...(notes ? { notes } : {}),
        });
    }
}
