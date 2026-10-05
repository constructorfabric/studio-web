import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { InMemoryResources, Resource } from '@theia/core/lib/common/resource';
import { DiffService } from '@theia/workspace/lib/browser/diff-service';
import { MarkdownEditorModel } from './markdown-editor-model';
import { MarkdownDiffService } from '../markdown-diff/markdown-diff-service';

interface DiffResourcePair {
    readonly leftUri: URI;
    readonly rightUri: URI;
    readonly leftResource: Resource;
    readonly rightResource: Resource;
}

@injectable()
export class MarkdownEditorConflictService {
    @inject(DiffService)
    protected readonly diffService: DiffService;

    @inject(InMemoryResources)
    protected readonly resources: InMemoryResources;

    @inject(MarkdownDiffService)
    protected readonly markdownDiffs: MarkdownDiffService;

    protected resourceSequence = 0;

    /** The same two versions as openDiff, rendered side by side. */
    async openRenderedDiff(model: MarkdownEditorModel): Promise<void> {
        const pendingConflict = model.externalChange;
        if (!pendingConflict) {
            throw new Error('Markdown editor has no pending external change to compare.');
        }
        const localMarkdown = (await model.serialize()).toString();
        const deleted = pendingConflict.kind === 'deleted';
        await this.markdownDiffs.open({
            title: `${model.uri.path.base} (${deleted ? 'Disk Deleted' : 'Disk'} ↔ Local)`,
            left: { content: deleted ? '' : pendingConflict.rawMarkdown, label: deleted ? 'Deleted on disk' : 'On disk' },
            right: { content: localMarkdown, label: 'Your version' },
            base: model.uri.scheme === 'file' ? model.uri : undefined,
        });
    }

    async openDiff(model: MarkdownEditorModel): Promise<void> {
        const pendingConflict = model.externalChange;
        if (!pendingConflict) {
            throw new Error('Markdown editor has no pending external change to compare.');
        }
        const localMarkdown = (await model.serialize()).toString();
        const externalMarkdown = pendingConflict.kind === 'deleted' ? '' : pendingConflict.rawMarkdown;
        const pair = this.createResourcePair(externalMarkdown, localMarkdown);
        const diskLabel = pendingConflict.kind === 'deleted' ? 'Disk Deleted' : 'Disk';
        try {
            await this.diffService.openDiffEditor(pair.leftUri, pair.rightUri, `${model.uri.path.base}: ${diskLabel} <> Local`);
        } finally {
            pair.leftResource.dispose();
            pair.rightResource.dispose();
        }
    }

    protected createResourcePair(leftContents: string, rightContents: string): DiffResourcePair {
        const resourceId = String(this.resourceSequence++);
        const leftUri = new URI(`memory://studio-markdown-conflicts/${resourceId}/disk.md`);
        const rightUri = new URI(`memory://studio-markdown-conflicts/${resourceId}/local.md`);
        let leftResource: Resource | undefined;
        try {
            leftResource = this.resources.add(leftUri, leftContents);
            const rightResource = this.resources.add(rightUri, rightContents);
            return {
                leftUri,
                rightUri,
                leftResource,
                rightResource
            };
        } catch (error) {
            leftResource?.dispose();
            throw error;
        }
    }
}
