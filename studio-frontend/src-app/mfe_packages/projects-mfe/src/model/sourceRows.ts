/** The Sources table's rows */
// @cpt-algo:cpt-studiofrontend-algo-project-sources-rows:p2
// @cpt-algo:cpt-studiofrontend-algo-project-sources-footer:p2
// @cpt-dod:cpt-studiofrontend-dod-project-sources-rows:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-last-sync:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-row-sync:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-gaps:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-search:p1
// @cpt-dod:cpt-studiofrontend-dod-project-sources-footer:p1
import type { ConnectionDto, ProjectSource, Refusal } from '@constructor-studio/mfe-shared';
import type {
  ArtifactNodeDto,
  RepoActivityDto,
  SourceActivityListDto,
} from '../api/artifactTypes';
import type { SpecsPerSourceListDto } from '../api/documentTypes';
import { canCancel, canRetry, inFlight, type RepoImportStatus } from './repoImport';
import { SYNCABLE_PROVIDERS, pathKey, repoNodeOf } from './syncRequest';

export type SourceLastSync =
  | { kind: 'synced'; at: string }
  | { kind: 'not_synced' }
  | { kind: 'not_connected' }
  | { kind: 'unavailable'; provider: string };

export type SourceSync =
  | { kind: 'none' }
  | { kind: 'in_flight'; cancelling: boolean; canCancel: boolean }
  | {
      kind: 'stopped';
      status: 'failed' | 'cancelled' | 'lost';
      reason: Refusal | null;
      canRetry: boolean;
    };

export interface SourceActivity {
  open: number;
  merged: number;
  commits: number;
  days: number[];
}

export interface SourceRow {
  id: string;
  connectionId: string;
  provider: string | null;
  name: string;
  fullPath: string;
  branch: string | null;
  nodeId: string | null;
  specs: number | null;
  activity: SourceActivity | null;
  lastSync: SourceLastSync;
  sync: SourceSync;
}

export interface SourceImportLine {
  repo: string;
  runId: string | null;
  status: RepoImportStatus;
  reason: Refusal | null;
  cancelling: boolean;
}

export interface SourcesAnswers {
  sources: readonly ProjectSource[];
  nodes: readonly ArtifactNodeDto[];
  connections: readonly ConnectionDto[] | null;
  activity: SourceActivityListDto | null;
  specs: SpecsPerSourceListDto | null;
  lines: readonly SourceImportLine[];
}

export interface SourcesFooter {
  sources: number;
  specs: number | null;
  createdInStudio: number | null;
  openPullRequests: number | null;
}

const NO_SYNC: SourceSync = { kind: 'none' };

function nameOf(fullPath: string): string {
  return fullPath.slice(fullPath.lastIndexOf('/') + 1);
}

function activityOf(listed: RepoActivityDto | undefined, window: number): SourceActivity {
  if (!listed) {
    return {
      open: 0,
      merged: 0,
      commits: 0,
      days: new Array<number>(window).fill(0),
    };
  }
  return {
    open: listed.open,
    merged: listed.merged,
    commits: listed.commits,
    days: listed.days,
  };
}

function lastSyncOf(
  node: ArtifactNodeDto | null,
  connected: boolean,
  provider: string | null
): SourceLastSync {
  if (!connected) return { kind: 'not_connected' };
  if (provider !== null && !SYNCABLE_PROVIDERS.includes(provider)) {
    return { kind: 'unavailable', provider };
  }
  const at = node?.value.synced_at;
  return at ? { kind: 'synced', at } : { kind: 'not_synced' };
}

function syncOf(line: SourceImportLine | undefined): SourceSync {
  if (!line) return NO_SYNC;
  if (inFlight(line.status)) {
    return {
      kind: 'in_flight',
      cancelling: line.cancelling,
      canCancel: canCancel(line) && !line.cancelling,
    };
  }
  if (line.status === 'failed' || line.status === 'cancelled' || line.status === 'lost') {
    return { kind: 'stopped', status: line.status, reason: line.reason, canRetry: canRetry(line) };
  }
  return NO_SYNC;
}

export function buildSourceRows(answers: SourcesAnswers): SourceRow[] {
  const connections = answers.connections && new Map(answers.connections.map((c) => [c.id, c]));
  const specsKnown = answers.specs?.files_known === true;
  const specsByNode = new Map(answers.specs?.items.map((item) => [item.repo, item.specs]));
  const activityByNode = new Map(answers.activity?.items.map((item) => [item.repo, item]));
  const lines = new Map(answers.lines.map((line) => [pathKey(line.repo), line]));

  const rows: SourceRow[] = [];
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-1
  for (const source of answers.sources) {
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-2
    const node = repoNodeOf(answers.nodes, source);
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-2
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-3
    const connection = connections?.get(source.connection_id) ?? null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-3
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-4
    const provider = node?.value.provider ?? connection?.provider ?? null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-4
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-6
    const specs = specsKnown && node ? (specsByNode.get(node.instance_id) ?? 0) : null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-6
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-7
    const activity =
      answers.activity && node
        ? activityOf(activityByNode.get(node.instance_id), answers.activity.days)
        : null;
    // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-7
    rows.push({
      id: `${source.connection_id}:${source.full_path}`,
      connectionId: source.connection_id,
      provider,
      // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-5
      name: nameOf(source.full_path),
      fullPath: source.full_path,
      branch: source.branch ?? null,
      // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-5
      nodeId: node?.instance_id ?? null,
      specs,
      activity,
      // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-8
      // Connections that could not be read say nothing about this one.
      lastSync: lastSyncOf(node, connections === null || connection !== null, provider),
      // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-8
      // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-9
      sync: syncOf(lines.get(pathKey(source.full_path))),
      // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-9
    });
  }
  // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-1
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-rows:p2:inst-10
  return rows;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-rows:p2:inst-10
}

export function filterSourceRows(rows: readonly SourceRow[], search: string): SourceRow[] {
  const needle = search.trim().toLowerCase();
  return needle ? rows.filter((row) => row.fullPath.toLowerCase().includes(needle)) : [...rows];
}

export function sourcesFooter(
  rows: readonly SourceRow[],
  answers: Pick<SourcesAnswers, 'specs' | 'activity'>,
  documents: number | null
): SourcesFooter {
  const footer: SourcesFooter = {
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-1
    sources: rows.length,
    // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-1
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-2
    specs: answers.specs?.files_known
      ? rows.reduce((sum, row) => sum + (row.specs ?? 0), 0)
      : null,
    // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-2
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-3
    createdInStudio: documents,
    // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-3
    // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-4
    openPullRequests: answers.activity
      ? rows.reduce((sum, row) => sum + (row.activity?.open ?? 0), 0)
      : null,
    // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-4
  };
  // @cpt-begin:cpt-studiofrontend-algo-project-sources-footer:p2:inst-5
  return footer;
  // @cpt-end:cpt-studiofrontend-algo-project-sources-footer:p2:inst-5
}
