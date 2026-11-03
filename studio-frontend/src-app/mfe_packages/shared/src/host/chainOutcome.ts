/**
 * How a request ended, from the chain's own `next` and `fallback`: the runtime
 * takes one of them for every request, and `executeActionsChain` itself says
 * nothing (mfes 0.4.0 returns void). No timer.
 */

import { ActionHandler, type Action, type ActionsChain } from '@gears-frontx/react';

export const STUDIO_ACTION_CHAIN_DONE =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.shell.chain_outcome.done.v1~';

export const STUDIO_ACTION_CHAIN_FAILED =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.shell.chain_outcome.failed.v1~';

export interface ChainOutcomes {
  run(execute: (chain: ActionsChain) => unknown, action: Action, replyTarget: string): Promise<void>;
  readonly done: ActionHandler;
  readonly failed: ActionHandler;
}

interface Waiting {
  resolve(): void;
  reject(): void;
}

export function createChainOutcomes(): ChainOutcomes {
  const waiting = new Map<string, Waiting>();
  let requests = 0;

  const settle = (outcome: keyof Waiting) =>
    ActionHandler.fromFunction(async (_type, payload) => {
      const requestId = payload?.requestId;
      if (typeof requestId !== 'string') return;
      const request = waiting.get(requestId);
      if (!request) return;
      waiting.delete(requestId);
      request[outcome]();
    });

  return {
    run(execute, action, replyTarget) {
      requests += 1;
      const requestId = String(requests);
      const reply = (type: string): ActionsChain => ({
        action: { type, target: replyTarget, payload: { requestId } },
      });
      return new Promise<void>((resolve, reject) => {
        waiting.set(requestId, {
          resolve,
          reject: () => reject(new Error(`${action.type} on ${action.target} failed`)),
        });
        try {
          execute({ action, next: reply(STUDIO_ACTION_CHAIN_DONE), fallback: reply(STUDIO_ACTION_CHAIN_FAILED) });
        } catch (error) {
          waiting.delete(requestId);
          throw error;
        }
      });
    },
    done: settle('resolve'),
    failed: settle('reject'),
  };
}
