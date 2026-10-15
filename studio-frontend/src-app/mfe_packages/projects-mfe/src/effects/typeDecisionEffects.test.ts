import { beforeEach, describe, expect, it, vi } from 'vitest';

type BusHandler = (payload?: unknown) => void;

const { listeners, emitted, decide, invalidate } = vi.hoisted(() => ({
  listeners: new Map<string, BusHandler>(),
  emitted: [] as [string, unknown][],
  decide: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
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
      decideBinding: (target: unknown) => ({ fetch: (body: unknown) => decide(target, body) }),
      specsPerSource: (params: unknown) => ({ specsPerSource: params }),
    }),
  },
  invalidateQueryCacheForApp: invalidate,
}));
vi.mock('../api/DocumentsApiService', () => ({ DocumentsApiService: class {} }));

import type { AppDispatch, FrontXApp } from '@gears-frontx/react';
import { initTypeDecisionEffects } from './typeDecisionEffects';
import { decisionSettled, decisionStarted } from '../slices/typeDecisionSlice';
import type { TypeDecisionRequest } from '../events/specsEvents';

const APP = {} as FrontXApp;
const REQUEST: TypeDecisionRequest = {
  projectId: 'p-1',
  workspaceId: 'w-1',
  bindingId: 'b-1',
  name: 'prd.md',
  decision: { action: 'set', type_key: 'adr' },
};

function harness() {
  const dispatch = vi.fn();
  initTypeDecisionEffects(dispatch as unknown as AppDispatch, APP);
  const request = () => listeners.get('mfe/projects/type-decision-requested')?.(REQUEST);
  return { dispatch, request };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const names = () => emitted.map(([name]) => name);

beforeEach(() => {
  listeners.clear();
  emitted.length = 0;
  decide.mockReset();
  invalidate.mockClear();
});

describe('a type decision', () => {
  it("sends the decision for the binding in the project's workspace", async () => {
    decide.mockResolvedValue({ id: 'b-1', type_key: 'adr', state: 'manual' });
    harness().request();
    await settle();
    expect(decide).toHaveBeenCalledWith(
      { workspaceId: 'w-1', bindingId: 'b-1' },
      { action: 'set', type_key: 'adr' }
    );
  });

  it('is pending until it settles', async () => {
    decide.mockResolvedValue({});
    const { dispatch, request } = harness();
    request();
    expect(dispatch.mock.calls).toEqual([[decisionStarted('b-1')]]);
    await settle();
    expect(dispatch.mock.calls).toEqual([[decisionStarted('b-1')], [decisionSettled('b-1')]]);
  });

  it("reloads the list and drops the project's Specs counts once it is taken", async () => {
    decide.mockResolvedValue({});
    harness().request();
    await settle();
    expect(emitted).toEqual([['mfe/projects/specs-changed', { projectId: 'p-1' }]]);
    expect(invalidate).toHaveBeenCalledWith(APP, { specsPerSource: { scope: 'p-1' } });
  });

  it('reports a refusal with the document and the reason, and changes nothing', async () => {
    decide.mockRejectedValue(new Error('type is not in this workspace'));
    const { dispatch, request } = harness();
    request();
    await settle();
    expect(emitted).toEqual([
      [
        'mfe/projects/type-decision-refused',
        {
          projectId: 'p-1',
          name: 'prd.md',
          refusal: { kind: 'provider', text: 'type is not in this workspace' },
        },
      ],
    ]);
    expect(names()).not.toContain('mfe/projects/specs-changed');
    expect(invalidate).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenLastCalledWith(decisionSettled('b-1'));
  });

  it('falls back to its own words when the refusal says nothing readable', async () => {
    decide.mockRejectedValue(new Error(''));
    harness().request();
    await settle();
    expect(emitted[0][1]).toMatchObject({ refusal: { kind: 'i18n', key: 'type_refused' } });
  });
});
