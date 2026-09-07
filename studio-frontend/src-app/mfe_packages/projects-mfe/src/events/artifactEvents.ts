/**
 * The import's own event. Declared apart from `projectsEvents` because it
 * carries a payload the nav events do not: everything the gear needs to pull a
 * repository, resolved by the component that has the connections.
 */

import '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';

export interface SyncRepo {
  repo: string;
  provider: string;
  baseUrl?: string;
  secretRef: string;
}

export interface SyncRequest {
  projectId: string;
  workspaceId: string | null;
  repos: SyncRepo[];
  /** Sources with no task to wait for, and why. */
  unsyncable: { repo: string; reason: Refusal }[];
}

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    /** Pull these repositories into this project's graph. */
    'mfe/artifacts/sync-requested': SyncRequest;
  }
}
