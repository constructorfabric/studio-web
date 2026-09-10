/**
 * Everything the shell tells the MFEs about itself, in one place.
 */

import type { FrontXApp } from '@gears-frontx/react';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
  STUDIO_SHARED_PROPERTY_SESSION_PROFILE,
} from '@/app/mfe/contextActions';
import { APP_CONTEXT_SLICE_KEY, type ContextEntity } from '@/app/slices/appContextSlice';
import { APP_SESSION_SLICE_KEY, type SessionProfile } from '@/app/slices/appSessionSlice';

function publish(app: FrontXApp, propertyId: string, value: unknown): void {
  try {
    app.mfeRegistry?.updateSharedProperty(propertyId, value);
  } catch (error) {
    console.warn(
      `Failed to publish ${propertyId} to MFEs:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

interface ContextSliceShape {
  org?: ContextEntity | null;
  workspace?: ContextEntity | null;
  project?: ContextEntity | null;
  section?: string | null;
}

function contextState(app: FrontXApp): ContextSliceShape {
  const state = app.store.getState() as Record<string, unknown>;
  return (state[APP_CONTEXT_SLICE_KEY] as ContextSliceShape | undefined) ?? {};
}

function sessionState(app: FrontXApp): { profile?: SessionProfile | null } {
  const state = app.store.getState() as Record<string, unknown>;
  return (state[APP_SESSION_SLICE_KEY] as { profile?: SessionProfile | null } | undefined) ?? {};
}

export function publishSelectedProject(app: FrontXApp): void {
  publish(app, STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, contextState(app).project?.id ?? null);
}

export function publishSelectedSection(app: FrontXApp): void {
  publish(app, STUDIO_SHARED_PROPERTY_CONTEXT_SECTION, contextState(app).section ?? null);
}

export function publishSelectedOrganization(app: FrontXApp): void {
  const org = contextState(app).org ?? null;
  publish(
    app,
    STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
    org ? { id: org.id, name: org.name } : null
  );
}

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-shell-owns:p1
export function publishSelectedWorkspace(app: FrontXApp): void {
  const workspace = contextState(app).workspace ?? null;
  publish(
    app,
    STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
    workspace ? { id: workspace.id, name: workspace.name } : null
  );
}

export function publishSessionProfile(app: FrontXApp): void {
  publish(app, STUDIO_SHARED_PROPERTY_SESSION_PROFILE, sessionState(app).profile ?? null);
}

export function publishStudioContext(app: FrontXApp): void {
  publishSelectedOrganization(app);
  publishSelectedWorkspace(app);
  publishSelectedProject(app);
  publishSelectedSection(app);
  publishSessionProfile(app);
}
