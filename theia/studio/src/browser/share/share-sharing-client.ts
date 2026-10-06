// How a repository is shared, as the project decided when it picked the
// repository from its connection (`share_mode` of the project's source), and
// the pull request that goes with it. Studio answers both, through the same
// `studio-api` gate as the Analyze panel: the request is opened with the
// connection's token, which neither a portal session's browser nor the
// desktop holds.
//
// When Studio cannot say — no project behind the window, a repository the
// project does not list, a backend without the route — the answer is
// `undefined` and Share does what it always did: straight to the branch.

import { inject, injectable } from '@theia/core/shared/inversify';
import { AnalyzeStudioClient } from '../analyze-studio-client';
import { StudioApi, StudioApiError } from '../studio-api';

export interface OpenPullRequest {
    readonly number: number;
    readonly url?: string;
}

export interface RepositorySharing {
    /** The tenant whose project config lists the repository. */
    readonly projectId: string;
    /** The project's name for the repository: its checkout folder. */
    readonly source: string;
    readonly mode: 'branch' | 'pull-request';
    /** The branch a request goes into. */
    readonly base?: string;
    /** Whether the repository's host can open requests through the connection. */
    readonly pullRequests: boolean;
    /** The person's request, when one is open from their branch. */
    readonly open?: OpenPullRequest;
}

interface SharingDto {
    readonly share_mode?: string;
    readonly base?: string | null;
    readonly pull_requests?: boolean;
    readonly open_pull_request?: { readonly number: number; readonly url?: string | null } | null;
}

interface OpenedDto {
    readonly number: number;
    readonly url?: string | null;
}

/** `/studio-connector/v1/sources/{source}/<what>?project_id=` — the project is a scope, so a query (api-conventions C2). */
function sourcePath(projectId: string, source: string, what: string): string {
    return `/studio-connector/v1/sources/${encodeURIComponent(source)}/${what}?project_id=${encodeURIComponent(projectId)}`;
}

@injectable()
export class ShareSharingClient {
    @inject(AnalyzeStudioClient) protected readonly analyze: AnalyzeStudioClient;

    /**
     * How `source` is shared, asked of the window's project — or, in a
     * workspace's window, of the workspace and then each of its projects, the
     * first that lists it. `head` is the person's review branch, so the answer
     * says whether a request from it is open.
     */
    async sharing(rootFsPaths: readonly string[], source: string, head: string): Promise<RepositorySharing | undefined> {
        const scope = await this.analyze.scope(rootFsPaths);
        const candidates = !scope ? [] : scope.kind === 'project' ? [scope.projectId] : [scope.workspaceId, ...scope.projectIds];
        for (const projectId of candidates) {
            const res = await StudioApi.fetch(`${sourcePath(projectId, source, 'sharing')}&head=${encodeURIComponent(head)}`);
            if (!res.ok) {
                continue;
            }
            const body = await res.json() as SharingDto;
            const open = body.open_pull_request;
            return {
                projectId,
                source,
                mode: body.share_mode === 'pull_request' ? 'pull-request' : 'branch',
                ...(body.base ? { base: body.base } : {}),
                pullRequests: !!body.pull_requests,
                ...(open ? { open: { number: open.number, ...(open.url ? { url: open.url } : {}) } } : {}),
            };
        }
        return undefined;
    }

    /** Open the request from `head`, or the one already open from it. */
    async openPullRequest(sharing: RepositorySharing, head: string, title: string, body: string): Promise<OpenPullRequest> {
        const res = await StudioApi.fetch(sourcePath(sharing.projectId, sharing.source, 'pull-requests'), {
            method: 'POST',
            body: JSON.stringify({ head, ...(sharing.base ? { base: sharing.base } : {}), title, body }),
        });
        if (!res.ok) {
            throw await StudioApiError.from(res);
        }
        const opened = await res.json() as OpenedDto;
        return { number: opened.number, ...(opened.url ? { url: opened.url } : {}) };
    }
}
