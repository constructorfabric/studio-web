/**
 * The MFE -> shell crossing for a section this MFE moved to by itself.
 *
 * The rail is the shell's, so a tile that leads somewhere announces the section
 * rather than rendering it: the shell relays it back, which moves the rail's
 * highlight and this root together. See
 * `cpt-studiofrontend-dod-organization-overview-leads`.
 */

import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import { STUDIO_ACTION_CONTEXT_PUBLISH, sendAndForget } from '@constructor-studio/mfe-shared';

export type OrganizationSection = 'overview' | 'workspaces' | 'settings';

export function announceSection(
  bridge: ChildMfeBridge | null,
  section: OrganizationSection
): void {
  sendAndForget(
    bridge,
    {
      type: STUDIO_ACTION_CONTEXT_PUBLISH,
      target: FRONTX_SCREEN_DOMAIN,
      payload: { kind: 'section', section },
    },
    'organization'
  );
}
