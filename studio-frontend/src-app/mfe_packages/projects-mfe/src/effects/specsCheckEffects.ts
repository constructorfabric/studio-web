/**
 * Check from the Specs list (#691): a `purpose` and a `leak` run over the
 * chosen specs, followed to the end. Started with the MFE, so a check outlives
 * a switch of section or project. The runs record their findings themselves.
 */

import { apiRegistry, eventBus, type AppDispatch } from '@gears-frontx/react';
import {
  StudioEventsApiService,
  StudioTasksApiService,
  createRunFollower,
  readCursor,
  refusalText,
  type RunUpdate,
} from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../api/DocumentsApiService';
import type { QualityDetector } from '../api/documentTypes';
import {
  CHECK_DETECTORS,
  checkOutcome,
  checkRequest,
  type CheckRun,
  type SpecsCheckTarget,
} from '../model/specsCheck';
import { checkEnded, checkProgressed, checkStarted } from '../slices/specsCheckSlice';
import type { SpecsCheckRequest } from '../events/specsEvents';
import '../events/specsEvents';

/** One accepted run, as its updates have described it so far. */
interface Followed {
  detector: QualityDetector;
  runId: string;
  documents: number;
  last: RunUpdate | null;
  ended: CheckRun | null;
}

/** M: the targets' findings, every detector's; `null` when they cannot be read. */
async function findingsOf(
  projectId: string,
  targets: readonly SpecsCheckTarget[]
): Promise<number | null> {
  try {
    const list = await apiRegistry
      .getService(DocumentsApiService)
      .specRows({ projectId })
      .fetch({ staleTime: 0 });
    if (!list.sources.reviews_known) return null;
    const checked = new Set(targets.map((row) => row.id));
    return list.items.reduce((sum, row) => sum + (checked.has(row.id) ? row.findings : 0), 0);
  } catch (error) {
    console.warn('[specs-check] could not read the findings:', error);
    return null;
  }
}

export function initSpecsCheckEffects(dispatch: AppDispatch): void {
  const running = new Set<string>();

  /** Resolves once every run has ended or been lost. */
  const follow = (projectId: string, runs: Followed[], cursor: number | null): Promise<void> =>
    new Promise((resolve) => {
      const end = (entry: Followed, ended: CheckRun): void => {
        if (entry.ended) return;
        entry.ended = ended;
        dispatch(checkProgressed({ projectId, detector: entry.detector, phase: null }));
        if (runs.every((run) => run.ended)) {
          follower.stop();
          resolve();
        }
      };
      const follower = createRunFollower({
        events: apiRegistry.getService(StudioEventsApiService),
        tasks: apiRegistry.getService(StudioTasksApiService),
        onRun: (update) => {
          const entry = runs.find((run) => run.runId === update.runId);
          if (!entry || entry.ended) return;
          // An event leaves out what did not change.
          const last: RunUpdate = { ...entry.last, ...update };
          entry.last = last;
          if (last.state === 'queued' || last.state === 'running') {
            if (last.phase) {
              dispatch(checkProgressed({ projectId, detector: entry.detector, phase: last.phase }));
            }
            return;
          }
          end(entry, {
            kind: 'ended',
            documents: entry.documents,
            state: last.state,
            phase: last.phase ?? null,
            error: last.error ?? null,
            result: last.result ?? null,
          });
        },
        onLost: (runId) => {
          const entry = runs.find((run) => run.runId === runId);
          if (entry) end(entry, { kind: 'lost' });
        },
      });
      follower.follow(
        runs.map((run) => run.runId),
        cursor
      );
    });

  const check = async ({ projectId, workspaceId, targets }: SpecsCheckRequest): Promise<void> => {
    const documents = apiRegistry.getService(DocumentsApiService);
    const cursor = await readCursor(apiRegistry.getService(StudioEventsApiService), 'specs-check');
    const body = checkRequest(targets);
    const answers = await Promise.allSettled(
      CHECK_DETECTORS.map((detector) =>
        documents.analyze({ workspaceId, projectId, detector }).fetch(body)
      )
    );

    // In detector order, refused or followed.
    const runs: (CheckRun | Followed)[] = answers.map((answer, index) =>
      answer.status === 'rejected'
        ? { kind: 'refused', reason: refusalText(answer.reason) }
        : {
            detector: CHECK_DETECTORS[index],
            runId: answer.value.run_id,
            documents: answer.value.documents,
            last: null,
            ended: null,
          }
    );
    const accepted = runs.filter((run): run is Followed => 'runId' in run);

    let findings: number | null = null;
    if (accepted.length > 0) {
      await follow(projectId, accepted, cursor);
      findings = await findingsOf(projectId, targets);
    }
    const outcome = checkOutcome(
      runs.map((run) => ('runId' in run ? (run.ended as CheckRun) : run)),
      findings
    );
    dispatch(checkEnded({ projectId, outcome }));
    if (accepted.length > 0) eventBus.emit('mfe/projects/specs-changed', { projectId });
  };

  eventBus.on('mfe/projects/specs-check-requested', (request) => {
    const { projectId, project, targets } = request;
    if (targets.length === 0 || running.has(projectId)) return;
    running.add(projectId);
    dispatch(checkStarted({ projectId, project, count: targets.length }));
    void check(request).finally(() => running.delete(projectId));
  });
}
