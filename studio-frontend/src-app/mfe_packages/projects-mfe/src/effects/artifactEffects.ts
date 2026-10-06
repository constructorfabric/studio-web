// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-sync-unit:p1
// @cpt-algo:cpt-studiofrontend-algo-project-artifacts-sync:p2
import {
  apiRegistry,
  eventBus,
  type AppDispatch,
  type FrontXApp,
  type RootState,
} from '@gears-frontx/react';
import { refusalFrom, type Refusal } from '@constructor-studio/mfe-shared';
import { ArtifactIngestApiService } from '../api/ArtifactIngestApiService';
import { StudioTasksApiService, type TaskRunDto } from '../api/StudioTasksApiService';
import {
  importAbandoned,
  importStarted,
  repoEnqueued,
  repoProgressed,
  type RepoImportStatus,
} from '../slices/artifactSyncSlice';
import { NAV_SLICE_KEY } from '../slices/navSlice';
import { recordAttempt } from '../shared/importAttempts';
import type { SyncRequest } from '../events/artifactEvents';
import '../events/artifactEvents';

const CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2500;

const MAX_POLLS = 480;
const MAX_POLL_FAILURES = 3;

function isNotFound(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 404;
}

function gearSaid(text: string | null | undefined): Refusal | null {
  return text ? { kind: 'provider', text } : null;
}

/** A run's state as an import row's; a cancelled sync did not come through. */
function importStatus(run: TaskRunDto): RepoImportStatus {
  return run.state === 'cancelled' ? 'failed' : run.state;
}

/** Nodes the sync has flushed so far, from the counts in the run's `result`. */
function storedOf(run: TaskRunDto): number {
  const stored = run.result?.stored;
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
}

/** What the row says: what it did, why it stopped, or where it is. */
function runMessage(run: TaskRunDto): string | null {
  return run.summary ?? run.last_error ?? run.progress ?? null;
}

async function bounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await work(item);
    }
  });
  await Promise.all(runners);
}

export function initArtifactEffects(dispatch: AppDispatch, app: FrontXApp): void {
  const generations = new Map<string, number>();

  const openProjectId = (): string | null =>
    (app.store.getState() as RootState)[NAV_SLICE_KEY].projectId;

  eventBus.on('mfe/artifacts/sync-requested', (request: SyncRequest) => {
    const { projectId, workspaceId, repos, unsyncable } = request;
    const ingest = apiRegistry.getService(ArtifactIngestApiService);
    const studioTasks = apiRegistry.getService(StudioTasksApiService);
    const generation = (generations.get(projectId) ?? 0) + 1;
    generations.set(projectId, generation);

    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-1
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-2
    // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-3
    recordAttempt(projectId);
    dispatch(importStarted({ projectId, repos: repos.map((r) => r.repo), unsyncable }));
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-1
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-2
    // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-3

    if (repos.length === 0) return;

    const stored = new Map<string, number>();

    const superseded = (): boolean => generations.get(projectId) !== generation;

    const progressed = (repo: string, status: RepoImportStatus, reason: Refusal | null): void => {
      dispatch(repoProgressed({ projectId, repo, status, reason, stored: stored.get(repo) ?? 0 }));
    };

    void (async () => {
      const runs = new Map<string, string>();
      const failures = new Map<string, number>();

      // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-4
      await bounded(repos, CONCURRENCY, async (entry) => {
        if (superseded()) return;
        try {
          const enqueued = await ingest.sync.fetch({
            provider: entry.provider,
            base_url: entry.baseUrl,
            secret_ref: entry.secretRef,
            repo_full_path: entry.repo,
            project_id: projectId,
            workspace_id: workspaceId ?? undefined,
          });
          runs.set(entry.repo, enqueued.run_id);
          dispatch(repoEnqueued({ projectId, repo: entry.repo, runId: enqueued.run_id }));
        } catch (error) {
          progressed(entry.repo, 'failed', refusalFrom(error, 'artifacts_reason_request_failed'));
        }
      });
      // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-4

      for (let poll = 0; poll < MAX_POLLS && runs.size > 0; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (superseded()) return;
        if (openProjectId() !== projectId) {
          dispatch(importAbandoned(projectId));
          return;
        }

        // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-5
        const answers = await Promise.all(
          [...runs].map(async ([repo, runId]) => {
            try {
              const run = await studioTasks.run({ runId }).fetch({ staleTime: 0 });
              return { repo, run, error: null };
            } catch (error) {
              return { repo, run: null, error };
            }
          })
        );
        // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-5

        for (const { repo, run, error } of answers) {
          if (!run) {
            // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-8
            // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-9
            const misses = (failures.get(repo) ?? 0) + 1;
            failures.set(repo, misses);
            if (isNotFound(error) || misses >= MAX_POLL_FAILURES) {
              runs.delete(repo);
              progressed(repo, 'lost', refusalFrom(error, 'artifacts_reason_task_lost'));
            }
            // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-8
            // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-9
            continue;
          }

          failures.delete(repo);
          stored.set(repo, storedOf(run));

          // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-10
          // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-11
          const status = importStatus(run);
          if (status === 'succeeded' || status === 'failed') runs.delete(repo);
          progressed(repo, status, gearSaid(runMessage(run)));
          // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-10
          // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-11
        }
      }

      // @cpt-begin:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-12
      for (const repo of runs.keys()) {
        progressed(repo, 'unwatched', { kind: 'i18n', key: 'artifacts_reason_unwatched' });
      }
      // @cpt-end:cpt-studiofrontend-algo-project-artifacts-sync:p2:inst-12
    })();
  });
}
