import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BusHandler = (payload?: unknown) => void | Promise<void>;

const { listeners, mockGetService } = vi.hoisted(() => ({
  listeners: new Map<string, BusHandler[]>(),
  mockGetService: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: {
    on: vi.fn((eventName: string, handler: BusHandler) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), handler]);
      return { unsubscribe: () => listeners.delete(eventName) };
    }),
    emit: vi.fn(),
  },
  apiRegistry: { getService: mockGetService },
}));

import type { AppDispatch, FrontXApp } from '@gears-frontx/react';
import { initArtifactEffects } from './artifactEffects';
import { ArtifactIngestApiService } from '../api/ArtifactIngestApiService';
import { StudioTasksApiService, type TaskRunDto } from '../api/StudioTasksApiService';
import { repoEnqueued, repoProgressed } from '../slices/artifactSyncSlice';
import { NAV_SLICE_KEY } from '../slices/navSlice';

const PROJECT = 'p-1';
const REPO = 'acme/api';

function run(overrides: Partial<TaskRunDto>): TaskRunDto {
  return {
    id: 'r-1',
    state: 'running',
    progress: null,
    summary: null,
    result: null,
    last_error: null,
    ...overrides,
  };
}

let syncFetch: ReturnType<typeof vi.fn>;
let runOf: ReturnType<typeof vi.fn>;
let dispatch: ReturnType<typeof vi.fn>;

/** Answers `GET /runs/{id}` with `answers`, one per poll, the last one repeated. */
function runsAnswer(...answers: (TaskRunDto | Error)[]): void {
  let poll = 0;
  runOf.mockImplementation(() => ({
    fetch: () => {
      const answer = answers[Math.min(poll, answers.length - 1)];
      poll += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  }));
}

function requestSync(): void {
  for (const handler of listeners.get('mfe/artifacts/sync-requested') ?? []) {
    void handler({
      projectId: PROJECT,
      workspaceId: 'ws-1',
      repos: [{ repo: REPO, provider: 'github', baseUrl: undefined, secretRef: 's' }],
      unsyncable: [],
    });
  }
}

function progressedWith() {
  return dispatch.mock.calls
    .map(([action]) => action)
    .filter((action) => action.type === repoProgressed.type)
    .map((action) => action.payload);
}

describe('a repository sync, followed through its studio-tasks run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    syncFetch = vi.fn().mockResolvedValue({ run_id: 'r-1', status: 'queued' });
    runOf = vi.fn();
    mockGetService.mockImplementation((service: unknown) => {
      if (service === ArtifactIngestApiService) return { sync: { fetch: syncFetch } };
      if (service === StudioTasksApiService) return { run: runOf };
      throw new Error('unexpected service');
    });
    dispatch = vi.fn();
    const app = {
      store: { getState: () => ({ [NAV_SLICE_KEY]: { projectId: PROJECT } }) },
    } as unknown as FrontXApp;
    initArtifactEffects(dispatch as unknown as AppDispatch, app);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('records the run id the sync answered', async () => {
    runsAnswer(run({ state: 'running' }));
    requestSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatch).toHaveBeenCalledWith(repoEnqueued({ projectId: PROJECT, repo: REPO, runId: 'r-1' }));
  });

  it('polls the run, shows its counts as it goes, and stops when it succeeds', async () => {
    runsAnswer(
      run({ state: 'running', progress: 'files', result: { stored: 3 } }),
      run({ state: 'succeeded', summary: '12 stored', result: { stored: 12 } })
    );
    requestSync();
    await vi.advanceTimersByTimeAsync(2500 * 4);

    expect(runOf).toHaveBeenCalledWith({ runId: 'r-1' });
    expect(runOf).toHaveBeenCalledTimes(2);
    expect(progressedWith()).toEqual([
      { projectId: PROJECT, repo: REPO, status: 'running', reason: { kind: 'provider', text: 'files' }, stored: 3 },
      { projectId: PROJECT, repo: REPO, status: 'succeeded', reason: { kind: 'provider', text: '12 stored' }, stored: 12 },
    ]);
  });

  it('counts a cancelled run as failed, with the reason it stopped', async () => {
    runsAnswer(run({ state: 'cancelled', last_error: 'cancelled by a person' }));
    requestSync();
    await vi.advanceTimersByTimeAsync(2500 * 2);

    expect(progressedWith()).toEqual([
      {
        projectId: PROJECT,
        repo: REPO,
        status: 'failed',
        reason: { kind: 'provider', text: 'cancelled by a person' },
        stored: 0,
      },
    ]);
  });

  it('calls a run the gear no longer has lost', async () => {
    runsAnswer(Object.assign(new Error('gone'), { response: { status: 404 } }));
    requestSync();
    await vi.advanceTimersByTimeAsync(2500 * 2);

    expect(progressedWith()).toHaveLength(1);
    expect(progressedWith()[0]).toMatchObject({ repo: REPO, status: 'lost' });
  });
});
