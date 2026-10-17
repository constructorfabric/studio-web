import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunFollowerOptions, RunUpdate } from '@constructor-studio/mfe-shared';

type BusHandler = (payload?: unknown) => void;

interface FakeFollower {
  options: RunFollowerOptions;
  follow: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const { listeners, emitted, analyze, specRows, followers } = vi.hoisted(() => ({
  listeners: new Map<string, BusHandler>(),
  emitted: [] as [string, unknown][],
  analyze: vi.fn(),
  specRows: vi.fn(),
  followers: [] as FakeFollower[],
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: {
    on: vi.fn((name: string, handler: BusHandler) => {
      listeners.set(name, handler);
      return { unsubscribe: () => listeners.delete(name) };
    }),
    emit: vi.fn((name: string, payload: unknown) => emitted.push([name, payload])),
  },
  apiRegistry: {
    getService: () => ({
      analyze: (target: unknown) => ({ fetch: (body: unknown) => analyze(target, body) }),
      specRows: (params: unknown) => ({ fetch: (options: unknown) => specRows(params, options) }),
    }),
  },
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  readCursor: vi.fn(() => Promise.resolve(42)),
  createRunFollower: vi.fn((options: RunFollowerOptions) => {
    const follower = { options, follow: vi.fn(), stop: vi.fn() };
    followers.push(follower);
    return follower;
  }),
}));
vi.mock('../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));

import type { AppDispatch } from '@gears-frontx/react';
import { initSpecsCheckEffects } from './specsCheckEffects';
import reducer, { type SpecsCheckState } from '../slices/specsCheckSlice';
import type { SpecsCheckRequest } from '../events/specsEvents';

const REQUEST: SpecsCheckRequest = {
  projectId: 'p-1',
  workspaceId: 'w-1',
  project: 'Billing',
  targets: [
    { id: 'b-1', origin: 'repository' },
    { id: 'd-1', origin: 'authored' },
  ],
};

const ITEMS = [
  { id: 'docs/prd.md', status: 'succeeded' },
  { id: 'studio-doc/d-1.md', status: 'succeeded' },
];

const SPEC_ROWS = {
  items: [
    { id: 'b-1', findings: 4 },
    { id: 'd-1', findings: 3 },
    { id: 'b-9', findings: 10 },
  ],
  total: 3,
  sources: { files_known: true, reviews_known: true, repos_known: true, counts: [] },
};

function harness() {
  let state: SpecsCheckState = reducer(undefined, { type: '@@init' });
  const dispatch = vi.fn((action: { type: string }) => {
    state = reducer(state, action as never);
    return action;
  });
  initSpecsCheckEffects(dispatch as unknown as AppDispatch);
  const request = (overrides: Partial<SpecsCheckRequest> = {}) =>
    listeners.get('mfe/projects/specs-check-requested')?.({ ...REQUEST, ...overrides });
  return { request, state: () => state };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const update = (runId: string, rest: Omit<RunUpdate, 'runId'>) =>
  followers[0].options.onRun({ runId, ...rest });

const succeed = (runId: string, items = ITEMS) =>
  update(runId, { state: 'succeeded', result: { items } });

beforeEach(() => {
  listeners.clear();
  emitted.length = 0;
  followers.length = 0;
  analyze.mockReset();
  analyze.mockImplementation((target: { detector: string }) =>
    Promise.resolve({ run_id: `run-${target.detector}`, poll: '', documents: 2 })
  );
  specRows.mockReset();
  specRows.mockResolvedValue(SPEC_ROWS);
});

describe('a check', () => {
  it('starts a purpose and a leak run over the bindings and the Studio documents, and follows both', async () => {
    harness().request();
    await settle();
    const body = { binding_ids: ['b-1'], document_ids: ['d-1'] };
    expect(analyze.mock.calls).toEqual([
      [{ workspaceId: 'w-1', projectId: 'p-1', detector: 'purpose' }, body],
      [{ workspaceId: 'w-1', projectId: 'p-1', detector: 'leak' }, body],
    ]);
    expect(followers[0].follow).toHaveBeenCalledWith(['run-purpose', 'run-leak'], 42);
  });

  it('runs once per project at a time', async () => {
    const { request, state } = harness();
    request();
    request();
    request({ projectId: 'p-2' });
    await settle();
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(Object.keys(state().checks)).toEqual(['p-1', 'p-2']);
    expect(state().checks['p-1']).toMatchObject({ project: 'Billing', count: 2, outcome: null });
  });

  it("keeps each run's phase while it runs, including through events that leave it out", async () => {
    const { request, state } = harness();
    request();
    await settle();
    update('run-purpose', { state: 'running', phase: '2/2 · studio-doc/d-1.md' });
    update('run-leak', { state: 'running', phase: '1/2 · docs/prd.md' });
    update('run-leak', { state: 'running', summary: 'still going' });
    expect(state().checks['p-1'].phases).toEqual({
      purpose: '2/2 · studio-doc/d-1.md',
      leak: '1/2 · docs/prd.md',
    });
    succeed('run-purpose');
    expect(state().checks['p-1'].phases).toEqual({ leak: '1/2 · docs/prd.md' });
  });

  it('reads M once both have ended, then reloads the list', async () => {
    const { request, state } = harness();
    request();
    await settle();
    succeed('run-purpose');
    await settle();
    expect(state().checks['p-1'].outcome).toBeNull();
    expect(specRows).not.toHaveBeenCalled();

    succeed('run-leak');
    await settle();
    expect(specRows).toHaveBeenCalledWith({ projectId: 'p-1' }, { staleTime: 0 });
    expect(followers[0].stop).toHaveBeenCalled();
    expect(state().checks['p-1'].outcome).toEqual({
      kind: 'checked',
      checked: 2,
      findings: 7,
      unchecked: 0,
      reason: null,
    });
    expect(emitted).toEqual([['mfe/projects/specs-changed', { projectId: 'p-1' }]]);
  });

  it('has no M when the findings cannot be read, or the verdicts are not known', async () => {
    specRows.mockRejectedValueOnce(new Error('down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, state } = harness();
    request();
    await settle();
    succeed('run-purpose');
    succeed('run-leak');
    await settle();
    expect(state().checks['p-1'].outcome).toMatchObject({ kind: 'checked', findings: null });

    specRows.mockResolvedValueOnce({
      ...SPEC_ROWS,
      sources: { ...SPEC_ROWS.sources, reviews_known: false },
    });
    request({ projectId: 'p-2' });
    await settle();
    followers[1].options.onRun({
      runId: 'run-purpose',
      state: 'succeeded',
      result: { items: ITEMS },
    });
    followers[1].options.onRun({ runId: 'run-leak', state: 'succeeded', result: { items: ITEMS } });
    await settle();
    expect(state().checks['p-2'].outcome).toMatchObject({ kind: 'checked', findings: null });
  });

  it('reports a run that failed as a whole with its last progress', async () => {
    const { request, state } = harness();
    request();
    await settle();
    update('run-purpose', { state: 'running', phase: '2/2 · studio-doc/d-1.md' });
    update('run-purpose', { state: 'failed', error: 'lease expired' });
    succeed('run-leak');
    await settle();
    expect(state().checks['p-1'].outcome).toEqual({
      kind: 'stopped',
      done: 1,
      total: 2,
      error: 'lease expired',
    });
    expect(emitted).toEqual([['mfe/projects/specs-changed', { projectId: 'p-1' }]]);
  });

  it('follows the other run when one POST is refused', async () => {
    analyze.mockImplementation((target: { detector: string }) =>
      target.detector === 'purpose'
        ? Promise.reject(new Error('detector unavailable'))
        : Promise.resolve({ run_id: 'run-leak', poll: '', documents: 2 })
    );
    const { request, state } = harness();
    request();
    await settle();
    expect(followers[0].follow).toHaveBeenCalledWith(['run-leak'], 42);
    succeed('run-leak');
    await settle();
    expect(state().checks['p-1'].outcome).toEqual({
      kind: 'checked',
      checked: 0,
      findings: 7,
      unchecked: 2,
      reason: 'detector unavailable',
    });
  });

  it('follows nothing and reloads nothing when both POSTs are refused', async () => {
    analyze.mockRejectedValue(new Error('Spec Quality is not configured'));
    const { request, state } = harness();
    request();
    await settle();
    expect(followers).toEqual([]);
    expect(specRows).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(state().checks['p-1'].outcome).toEqual({
      kind: 'not_started',
      reason: 'Spec Quality is not configured',
    });
    // The project can be checked again.
    request();
    await settle();
    expect(analyze).toHaveBeenCalledTimes(4);
  });

  it('says it lost track of a run the follower gave up on', async () => {
    const { request, state } = harness();
    request();
    await settle();
    succeed('run-purpose');
    followers[0].options.onLost('run-leak', new Error('not found'));
    await settle();
    expect(state().checks['p-1'].outcome).toEqual({ kind: 'lost' });
  });

  it('starts nothing with nothing to check', async () => {
    const { request, state } = harness();
    request({ targets: [] });
    await settle();
    expect(analyze).not.toHaveBeenCalled();
    expect(state().checks).toEqual({});
  });
});
