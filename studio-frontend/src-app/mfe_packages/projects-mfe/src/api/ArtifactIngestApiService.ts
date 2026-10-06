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
} from './artifactTypes';
import { IdempotencyKeyPlugin } from './idempotencyKeyPlugin';

export const ARTIFACT_INGEST_API_BASE_URL = '/cf/studio-artifact-ingest/v1';

/** `POST /sync`: the one route here that starts a run. */
export const SYNC_PATH = '/sync';

/** Whether a request URL, as the plugins see it (base included), is `POST /sync`'s. */
export function startsSync(url: string): boolean {
  return url.split('?')[0] === `${ARTIFACT_INGEST_API_BASE_URL}${SYNC_PATH}`;
}

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
    // `POST /sync` starts a run (202 + run_id): its retry must answer that run.
    restProtocol.plugins.add(new IdempotencyKeyPlugin(startsSync));

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

  readonly sync = this.protocol(RestEndpointProtocol).mutation<SyncEnqueuedDto, SyncBody>(
    'POST',
    SYNC_PATH
  );
}
