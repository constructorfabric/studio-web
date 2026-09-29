/** The MFE -> shell channel for the top bar's context slot. */


import { ActionHandler, eventBus } from '@gears-frontx/react';
import '@/app/events/bootstrapEvents';
import { isStudioArtifactKind, type StudioArtifactRequest } from '@constructor-studio/mfe-shared';

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

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-claim:p1
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
      const workspaceId = payload?.workspaceId;
      if (typeof workspaceId !== 'string' || !workspaceId) return;
      // Order matters: the list first, so the slot never names a project while
      // the menu behind it still holds the previous workspace's siblings.
      const siblings = Array.isArray(payload?.siblings) ? payload.siblings : [];
      eventBus.emit('app/context/projects', { items: siblings.filter(isEntity), workspaceId });
      eventBus.emit('app/context/project/opened', { ...payload.project, workspaceId });
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
/** Scope claims here too — the marker for that DoD is on the handler above. */
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
        enter: true,
        ...scopeOf(payload, 'organizationId'),
      });
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

/** The open-artifact payload as the schema names it, or `null` when it is not one. */
export function artifactRequestOf(payload: Record<string, unknown> | undefined): StudioArtifactRequest | null {
  const { projectId, artifactId, repository, path, kind } = payload ?? {};
  if (typeof projectId !== 'string' || !projectId) return null;
  if (typeof artifactId !== 'string' || !artifactId) return null;
  if (typeof repository !== 'string' || typeof path !== 'string') return null;
  if (!isStudioArtifactKind(kind)) return null;
  return { projectId, artifactId, repository, path, kind };
}

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-open-request:p1
export function createArtifactOpenHandler(): ActionHandler {
  return ActionHandler.fromFunction(async (_actionTypeId, payload) => {
    const request = artifactRequestOf(payload);
    if (!request) {
      console.warn('[shell] artifact open: payload refused', payload);
      return;
    }
    eventBus.emit('app/context/artifact/requested', request);
  });
}
