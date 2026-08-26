/**
 * Everything a component is allowed to *ask for*.
 *
 * Two different channels, and the difference is the realm boundary:
 *
 * - Navigation inside this MFE stays on the local `eventBus` — effects turn it
 *   into store state (`projects/nav`).
 * - Anything the shell must learn goes through `bridge.executeActionsChain`
 *   against the screen domain. The MFE's `eventBus` is NOT the shell's (isolated
 *   module realms), so the `app/context/*` events named in ADR-0008 never
 *   crossed; the action declared in `mfe.json` -> `domainActions` does.
 *
 * The shell is only told about ONE thing: which project is open and which
 * projects sit next to it. The organization list in the same slot is
 * account-management data the shell fetches itself, and there is deliberately no
 * "all projects of the organization" publish — with the tree loading one branch
 * per click, such a list would always be a subset dressed up as a whole.
 */

import { eventBus, type ChildMfeBridge } from '@gears-frontx/react';
import type { ProjectSection } from '../slices/navSlice';
import './../events/projectsEvents';

/** Host-owned action + its target. Both are declared in this MFE's mfe.json. */
const CONTEXT_PUBLISH_ACTION =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.projects.publish.v1~';
const SCREEN_DOMAIN = 'gts.frontx.mfes.ext.domain.v1~frontx.screensets.layout.screen.v1';

type ContextEntity = { id: string; name: string };

/**
 * A failed chain must not take the screen down with it: the context slot is
 * chrome, and the list it decorates is already rendered by the time we publish.
 */
function publish(
  bridge: ChildMfeBridge | null,
  payload: Record<string, unknown>
): void {
  if (!bridge) return;
  void bridge
    .executeActionsChain({
      action: { type: CONTEXT_PUBLISH_ACTION, target: SCREEN_DOMAIN, payload },
    })
    .catch((error: unknown) => {
      console.warn(
        '[projects-mfe] context publish failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
}

// ─── local navigation ────────────────────────────────────────────────────────

/**
 * `siblings` is what the top bar's switcher will offer while this project is
 * open: the projects of the same workspace, current one included. It travels
 * with the open event rather than as its own publish, so the slot never renders
 * a name with a stale list behind it.
 */
export function requestOpenProject(
  project: ContextEntity,
  siblings: ContextEntity[],
  bridge: ChildMfeBridge | null
): void {
  eventBus.emit('mfe/projects/open-requested', project);
  publish(bridge, { kind: 'opened', project, siblings });
}

export function requestCloseProject(bridge: ChildMfeBridge | null): void {
  eventBus.emit('mfe/projects/close-requested');
  publish(bridge, { kind: 'closed' });
}

export function requestSection(section: ProjectSection): void {
  eventBus.emit('mfe/projects/section-selected', { section });
}

