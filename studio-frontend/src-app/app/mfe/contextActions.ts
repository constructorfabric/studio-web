/** The MFE -> shell channel for the top bar's context slot. */


import { ActionHandler, eventBus } from '@gears-frontx/react';
import '@/app/events/bootstrapEvents';

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
 * The scope an announcement was made in, when the sender named one. Omitted
 * rather than defaulted: an absent id means "not claimed", which the shell
 * treats as "cannot be checked", and that is a different thing from a claim
 * that happens to match nothing.
 */
function scopeOf<K extends string>(
  payload: Record<string, unknown> | undefined,
  key: K
): Partial<Record<K, string>> {
  const value = payload?.[key];
  return typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {};
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
      const scope = scopeOf(payload, 'workspaceId');
      eventBus.emit('app/context/projects', { items: siblings.filter(isEntity), ...scope });
      eventBus.emit('app/context/project/opened', { ...payload.project, ...scope });
      return;
    }

    if (kind === 'closed') {
      eventBus.emit('app/context/project/closed');
      return;
    }

    if (kind === 'section') {
      if (typeof payload?.section !== 'string') return;
      eventBus.emit('app/context/project/section', { section: payload.section });
    }
  });
}

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-announce:p1
// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-slot:p1
export function createWorkspacePublishHandler(): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    if (payload?.kind === 'scoped') {
      eventBus.emit('app/context/workspace/scoped');
      return;
    }
    if (payload?.kind === 'selected') {
      if (!isEntity(payload?.workspace)) return;
      eventBus.emit('app/context/workspace/changed', {
        workspaceId: payload.workspace.id,
        name: payload.workspace.name,
        ...scopeOf(payload, 'organizationId'),
      });
      eventBus.emit('app/context/level/requested', { level: 'workspace' });
      return;
    }
    if (payload?.kind !== 'created') return;
    if (!isEntity(payload?.workspace)) return;
    eventBus.emit('app/context/workspace/created', {
      ...payload.workspace,
      ...scopeOf(payload, 'organizationId'),
    });
  });
}
