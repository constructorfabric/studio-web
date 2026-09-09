/**
 * Everything a component is allowed to *ask for*.
 *
 * One channel, and it leaves this realm: `bridge.executeActionsChain` against
 * the screen domain. The MFE's `eventBus` is NOT the shell's (isolated module
 * realms), so the `app/context/*` events named in ADR-0008 never crossed; the
 * action declared in `mfe.json` -> `domainActions` does.
 *
 * Nothing here writes `projects/nav`. What is open and which section is showing
 * are the shell's to decide, and they arrive back as shared properties —
 * `ChildMfeBridge` has no `updateSharedProperty`, which is the framework saying
 * the same thing. A local write beside the publish used to fork that answer
 * across the boundary: the shell's echo then matched what this MFE had already
 * set, and every listener keyed on "it changed" was skipped — the rail's
 * highlight among them.
 *
 * The shell is only told about ONE thing: which project is open and which
 * projects sit next to it. The organization list in the same slot is
 * account-management data the shell fetches itself, and there is deliberately no
 * "all projects of the organization" publish — with the tree loading one branch
 * per click, such a list would always be a subset dressed up as a whole.
 */

import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_ACTION_CONTEXT_PUBLISH,
  sendAndForget,
  sendToHost,
} from '@constructor-studio/mfe-shared';
import type { ProjectSection } from '../slices/navSlice';

type ContextEntity = { id: string; name: string };

/**
 * A failed chain must not take the screen down with it: the context slot is
 * chrome, and the list it decorates is already rendered by the time we publish.
 */
function publish(bridge: ChildMfeBridge | null, payload: Record<string, unknown>): void {
  sendAndForget(
    bridge,
    { type: STUDIO_ACTION_CONTEXT_PUBLISH, target: FRONTX_SCREEN_DOMAIN, payload },
    'projects'
  );
}

// ─── local navigation ────────────────────────────────────────────────────────

/**
 * `siblings` is what the top bar's switcher will offer while this project is
 * open: the projects of the same workspace, current one included. It travels
 * with the open event rather than as its own publish, so the slot never renders
 * a name with a stale list behind it.
 *
 * The shell is told and nothing is opened here. This used to dispatch locally
 * first and publish second, which forked the answer to "which project is open"
 * across the realm boundary: by the time the shell's echo came back, this MFE's
 * own state already matched it, so every listener keyed on "the project
 * changed" — the rail's section among them — was skipped. `ProjectsRoot` opens
 * the project when the property arrives, and that is the only way in.
 */
export function requestOpenProject(
  project: ContextEntity,
  siblings: ContextEntity[],
  bridge: ChildMfeBridge | null
): void {
  publish(bridge, { kind: 'opened', project, siblings });
}

/**
 * The created project, announced to the shell as the open one.
 *
 * Called from the wizard, which is a different entry of this MFE and so a
 * different module realm: emitting on the local `eventBus` would talk to
 * itself. The shell hop is the whole point — it publishes the project as
 * selected, and the screen realm's `ProjectsRoot` opens it from there.
 *
 * `siblings` is the switcher's list while the project is open, so it has to be
 * the workspace's projects and not the one row the wizard knows; the caller
 * reads them and this only makes sure the new project is among them.
 *
 * Awaited, because the wizard may only unmount once the shell has heard it:
 * the overlay closes on Escape and on the scrim without asking, and the wizard
 * is what holds the created project's identity.
 */
// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-open-after-create:p1
export function announceCreatedProject(
  bridge: ChildMfeBridge | null,
  project: ContextEntity,
  siblings: readonly ContextEntity[]
): Promise<void> {
  if (!bridge) return Promise.resolve();
  const listed = siblings.some((sibling) => sibling.id === project.id)
    ? [...siblings]
    : [...siblings, project];
  return sendToHost(bridge, {
    type: STUDIO_ACTION_CONTEXT_PUBLISH,
    target: FRONTX_SCREEN_DOMAIN,
    payload: { kind: 'opened', project, siblings: listed },
  });
}

/**
 * A section this MFE moved to by itself, told to the shell so the rail follows
 * it. The rail is the shell's now, and it would otherwise keep highlighting the
 * item that was last clicked — see `landOnFirstImport`.
 */
export function announceSection(bridge: ChildMfeBridge | null, section: ProjectSection): void {
  publish(bridge, { kind: 'section', section });
}

