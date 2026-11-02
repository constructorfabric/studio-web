import { describe, expect, it, vi } from 'vitest';
import type { Action, ActionsChain } from '@gears-frontx/react';
import {
  STUDIO_ACTION_CHAIN_DONE,
  STUDIO_ACTION_CHAIN_FAILED,
  createChainOutcomes,
} from './chainOutcome';

const MOUNT: Action = {
  type: 'gts.frontx.mfes.comm.action.v1~frontx.mfes.ext.mount_ext.v1~',
  target: 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1',
  payload: { subject: 'projects' },
};
const REPLY_TARGET = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';

/** One run, with the chain it handed to the runtime. */
function started() {
  const outcomes = createChainOutcomes();
  const chains: ActionsChain[] = [];
  const settled = outcomes.run((chain) => chains.push(chain), MOUNT, REPLY_TARGET);
  return { outcomes, chain: chains[0], settled };
}

/** What a promise has done so far, without waiting for it. */
function watch(promise: Promise<void>): () => string {
  let state = 'pending';
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected')
  );
  return () => state;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('chain outcomes', () => {
  it('run hands one chain with the done reply as next and the failed reply as fallback', () => {
    const execute = vi.fn();

    void createChainOutcomes().run(execute, MOUNT, REPLY_TARGET);

    expect(execute).toHaveBeenCalledTimes(1);
    const chain = execute.mock.calls[0][0] as ActionsChain;
    expect(chain.action).toBe(MOUNT);
    const requestId = chain.next?.action.payload?.requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(chain.next).toEqual({
      action: { type: STUDIO_ACTION_CHAIN_DONE, target: REPLY_TARGET, payload: { requestId } },
    });
    expect(chain.fallback).toEqual({
      action: { type: STUDIO_ACTION_CHAIN_FAILED, target: REPLY_TARGET, payload: { requestId } },
    });
  });

  it('run resolves when the done reply arrives', async () => {
    const { outcomes, chain, settled } = started();

    await outcomes.done.handleAction(STUDIO_ACTION_CHAIN_DONE, chain.next?.action.payload);

    await expect(settled).resolves.toBeUndefined();
  });

  it('run rejects when the failed reply arrives', async () => {
    const { outcomes, chain, settled } = started();

    await outcomes.failed.handleAction(STUDIO_ACTION_CHAIN_FAILED, chain.fallback?.action.payload);

    await expect(settled).rejects.toThrow();
  });

  it('a reply for another requestId is ignored', async () => {
    const { outcomes, settled } = started();
    const state = watch(settled);

    await outcomes.done.handleAction(STUDIO_ACTION_CHAIN_DONE, { requestId: 'another' });
    await outcomes.failed.handleAction(STUDIO_ACTION_CHAIN_FAILED, { requestId: 'another' });
    await flush();

    expect(state()).toBe('pending');
  });

  it('two runs settle independently', async () => {
    const outcomes = createChainOutcomes();
    const chains: ActionsChain[] = [];
    const first = outcomes.run((chain) => chains.push(chain), MOUNT, REPLY_TARGET);
    const second = outcomes.run((chain) => chains.push(chain), MOUNT, REPLY_TARGET);

    await outcomes.failed.handleAction(STUDIO_ACTION_CHAIN_FAILED, chains[1].fallback?.action.payload);
    await outcomes.done.handleAction(STUDIO_ACTION_CHAIN_DONE, chains[0].next?.action.payload);

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow();
  });
});
