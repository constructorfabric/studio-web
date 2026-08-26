/**
 * Which organization this MFE is working in — told by the shell, not derived.
 *
 * It used to be derived here, and that was the bug: the shell owns the
 * organization switcher in the top bar, and this file re-answered the same
 * question from `/me` and the tenant tree by a *different* rule (home tenant if
 * it is an organization, otherwise its FIRST organization child). The two agree
 * only while the user has exactly one organization. Past that, switching in the
 * top bar left the wizard creating projects under a parent nobody had named.
 *
 * Now the shell publishes `{id, name}` as a shared property and both of this
 * MFE's roots read it. That also settles what could not be settled before: the
 * screen entry and the overlay entry live in separate module graphs
 * (`MfeHandlerMF` builds a blob-URL chain per expose), so neither could ever
 * hand the other an answer — but both can be told the same one.
 *
 * The provider survives as a provider only to keep the call sites unchanged;
 * there is no request behind it any more.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-org-scope:p1
import React, { createContext, useContext, type ReactNode } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION } from './hostProperties';
import { useBridgeProperty } from './useBridgeProperty';

/** All the shell publishes, and all any screen here reads. */
export interface OrganizationRef {
  id: string;
  name: string;
}

export interface OrganizationState {
  org: OrganizationRef | null;
  /** The shell has not said yet. Distinct from "there is none". */
  loading: boolean;
  /**
   * Kept for the callers that branch on it, and now always false: reading a
   * published value cannot fail. A shell that never publishes reads as
   * `loading`, which is the honest answer — nothing failed, nothing arrived.
   */
  failed: boolean;
}

const EMPTY: OrganizationState = { org: null, loading: false, failed: false };

const OrganizationContext = createContext<OrganizationState>(EMPTY);

/** Null `org` with `loading` false means: the shell says there is none. */
export function useOrganization(): OrganizationState {
  return useContext(OrganizationContext);
}

function isOrganizationRef(value: unknown): value is OrganizationRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Partial<OrganizationRef>;
  return typeof ref.id === 'string' && !!ref.id && typeof ref.name === 'string';
}

/**
 * `bridge` is a prop rather than a `useBridge()` read: the wizard's provider
 * sits above its `BridgeProvider`, and a null bridge here would look exactly
 * like a shell that has not published — an indistinguishable, silent failure.
 */
export const OrganizationProvider: React.FC<{
  bridge: ChildMfeBridge | null;
  children: ReactNode;
}> = ({ bridge, children }) => {
  const published = useBridgeProperty<unknown>(
    bridge,
    STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION
  );

  // Anything that is not the shape we asked for is treated as "not yet": the
  // property is schema-checked at the publisher, so a malformed value means the
  // protocol changed under us, and guessing would be worse than waiting.
  const value: OrganizationState =
    published === undefined
      ? { org: null, loading: true, failed: false }
      : { org: isOrganizationRef(published) ? published : null, loading: false, failed: false };

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
};

OrganizationProvider.displayName = 'OrganizationProvider';
