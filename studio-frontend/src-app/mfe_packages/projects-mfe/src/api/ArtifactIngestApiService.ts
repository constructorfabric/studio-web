/** studio-artifact-ingest — the graph of what a project's repositories contain */

import {
  BaseApiService,
  RestEndpointProtocol,
  RestProtocol,
} from '@gears-frontx/react';
import type {
  ArtifactNodeListDto,
  SyncBody,
  SyncEnqueuedDto,
  TaskStatusDto,
} from './artifactTypes';

export const ARTIFACT_INGEST_API_BASE_URL = '/cf/studio-artifact-ingest/v1';

/**
 * A page is cheap now, but the read still fires on every window focus without
 * this; the shared fetch cache uses the same 30 s.
 */
const NODES_STALE_TIME_MS = 30_000;

export interface NodesParams {
  scope: string;
  type?: string;
  repo?: string;
  sort?: 'updated';
  q?: string;
  offset?: number;
  limit?: number;
}

function nodesPath({ scope, type, repo, sort, q, offset, limit }: NodesParams): string {
  const search = new URLSearchParams({ scope });
  if (type) search.set('type', type);
  if (repo) search.set('repo', repo);
  if (sort) search.set('sort', sort);
  if (q) search.set('q', q);
  if (offset) search.set('offset', String(offset));
  if (limit) search.set('limit', String(limit));
  return `/nodes?${search.toString()}`;
}

export class ArtifactIngestApiService extends BaseApiService {
  constructor() {
    const restProtocol = new RestProtocol({ timeout: 30000 });
    const restEndpoints = new RestEndpointProtocol(restProtocol);

    super({ baseURL: ARTIFACT_INGEST_API_BASE_URL }, restProtocol, restEndpoints);
  }

  // @cpt-dod:cpt-studiofrontend-dod-project-artifacts-scope:p1
  // @cpt-dod:cpt-studiofrontend-dod-project-artifacts-page:p1
  // TODO: ask the framework team for a `queryWith` that takes its own cacheKey.
  // The key is `[baseURL, 'GET', resolvedPath, params]`, and the query string is
  // glued into `resolvedPath`, so `/nodes` has no prefix under which its pages
  // sit
  readonly nodes = this.protocol(RestEndpointProtocol).queryWith<
    ArtifactNodeListDto,
    NodesParams
  >(nodesPath, { staleTime: NODES_STALE_TIME_MS });

  readonly task = this.protocol(RestEndpointProtocol).queryWith<
    TaskStatusDto,
    { taskId: string }
  >(({ taskId }) => `/tasks/${taskId}`);

  readonly sync = this.protocol(RestEndpointProtocol).mutation<SyncEnqueuedDto, SyncBody>(
    'POST',
    '/sync'
  );
}
