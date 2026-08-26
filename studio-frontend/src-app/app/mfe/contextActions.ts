/**
 * The MFE -> shell channel for the top bar's context slot.
 *
 * What crosses: the project that was just opened, plus the projects next to it
 * inside the same workspace — the list the switcher offers while it is open.
 * What does NOT cross: the organizations in the same slot (account-management
 * data the shell fetches itself) and any notion of "all projects", which the
 * tree cannot know since it loads one branch per click.
 *
 * ADR-0008 has projects-mfe publish the project list and the open project, and
 * described that as `eventBus` events. That cannot work: `MfeHandlerMF` gives
 * every MFE its own module realm, so the MFE's `eventBus` is a different
 * instance and the shell never hears it. The sanctioned crossing is an actions
 * chain executed against a host domain — this action is its payload contract,
 * and the handler below is the thin adapter back onto the shell-side events
 * that `appContextEffects` already handles.
 */

import { ActionHandler, eventBus } from '@gears-frontx/react';
import '@/app/events/bootstrapEvents';

/** Declared by an MFE in `mfe.json` -> `entries[].domainActions`. */
export const STUDIO_ACTION_CONTEXT_PUBLISH =
  'gts.frontx.mfes.comm.action.v1~constructor_studio.context.projects.publish.v1~';

/**
 * The other direction: which project the shell says we are inside, or `null` at
 * organization scope. Declared on the screen domain (`sharedProperties`) and in
 * the MFE's `mfe.json` -> `requiredProperties`.
 *
 * Without it the switcher this action feeds is decoration — selecting an item
 * emits `app/context/project/changed` on the SHELL's eventBus, which the owning
 * MFE cannot hear. A shared property is the one host -> child channel that
 * crosses a module realm.
 *
 * The trailing `~` is required: `updateSharedProperty` appends to this string to
 * derive the ephemeral GTS instance it validates.
 */
export const STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT =
  'gts.frontx.mfes.comm.shared_property.v1~constructor_studio.context.project.selected.v1~';

/**
 * The organization the session is working in, as `{id, name}` or `null`.
 */
export const STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION =
  'gts.frontx.mfes.comm.shared_property.v1~constructor_studio.context.organization.selected.v1~';

/**
 * Who is signed in, for display: `{id, displayName?, email?}` or `null`.
 * Display only. Every authorization decision stays with the backend, which
 * verifies the signature.
 */
export const STUDIO_SHARED_PROPERTY_SESSION_PROFILE =
  'gts.frontx.mfes.comm.shared_property.v1~constructor_studio.session.user.profile.v1~';

interface ContextEntityPayload {
  id: string;
  name: string;
}

function isEntity(value: unknown): value is ContextEntityPayload {
  if (typeof value !== 'object' || value === null) return false;
  const entity = value as Partial<ContextEntityPayload>;
  return typeof entity.id === 'string' && typeof entity.name === 'string';
}

/**
 * Handler for the action, registered on the screen domain.
 *
 * Payload is validated here rather than trusted: GTS checks the action instance
 * against its schema, but the handler is what turns it into store state, and a
 * malformed `items` would otherwise leave the switcher listing `undefined`.
 */
export function createContextPublishHandler(): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    const kind = payload?.kind;

    if (kind === 'opened') {
      if (!isEntity(payload?.project)) return;
      // Order matters: the list first, so the slot never names a project while
      // the menu behind it still holds the previous workspace's siblings.
      const siblings = Array.isArray(payload?.siblings) ? payload.siblings : [];
      eventBus.emit('app/context/projects', { items: siblings.filter(isEntity) });
      eventBus.emit('app/context/project/opened', payload.project);
      return;
    }

    if (kind === 'closed') {
      eventBus.emit('app/context/project/closed');
    }
  });
}
