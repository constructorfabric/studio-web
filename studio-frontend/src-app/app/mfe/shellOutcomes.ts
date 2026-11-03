/**
 * The shell's chain outcomes: one set per registry, and every reply goes to the
 * screen domain, whichever domain the action targeted.
 */

import { screenDomain, type Action, type MfeRegistry } from '@gears-frontx/react';
import { createChainOutcomes, type ChainOutcomes } from '@constructor-studio/mfe-shared';

const outcomes = new WeakMap<MfeRegistry, ChainOutcomes>();

export function outcomesOf(registry: MfeRegistry): ChainOutcomes {
  let registryOutcomes = outcomes.get(registry);
  if (registryOutcomes === undefined) {
    registryOutcomes = createChainOutcomes();
    outcomes.set(registry, registryOutcomes);
  }
  return registryOutcomes;
}

/** Resolves once the runtime has carried `action` out, and rejects when it took the fallback. */
export function executeAndSettle(registry: MfeRegistry, action: Action): Promise<void> {
  return outcomesOf(registry).run((chain) => registry.executeActionsChain(chain), action, screenDomain.id);
}
