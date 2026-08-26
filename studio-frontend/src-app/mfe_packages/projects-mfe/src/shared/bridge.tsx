import React, { createContext, useContext, type ReactNode } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';

/**
 * The bridge, made reachable from anywhere in the screen tree.
 *
 * Needed because talking to the shell is not a redux dispatch and not an event:
 * the MFE runs in its own module realm, so the only channel is
 * `bridge.executeActionsChain`, and the bridge arrives per mount. Prop-drilling
 * it into every row of a table is worse than one context.
 */
const BridgeContext = createContext<ChildMfeBridge | null>(null);

export const BridgeProvider: React.FC<{ bridge: ChildMfeBridge; children: ReactNode }> = ({
  bridge,
  children,
}) => <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;

/** Null only outside a mounted MFE (a bare unit test rendering a component). */
export function useBridge(): ChildMfeBridge | null {
  return useContext(BridgeContext);
}
