/**
 * Everything the shell tells the MFEs about itself, in one place.
 *
 * A shared property is the only host -> child channel that survives an MFE's
 * module realm, and it is fire-and-forget: `updateSharedProperty` throws on a
 * value its schema refuses, and a publish that matches no registered domain is
 * **silently dropped**. Both facts shape this file.
 *
 * Throwing is contained here — these properties are chrome, and a malformed
 * publish must fail loudly in the console without taking down the effect that
 * made it, or the top bar's slot would take the whole identity flow with it.
 *
 * Dropping is handled by not needing a buffer. Every published fact has a home
 * in the store — `app/context` for the organization and the open project,
 * `app/session` for the subject — so each publisher reads that home rather than
 * being handed a value. The effects call these when something changes, and
 * `bootstrapMFE` calls `publishStudioContext` the moment the domains exist.
 * Startup is a race (`Layout` resolves the subject and the organization over the
 * network while `bootstrapMFE` fetches manifests), and whichever side wins, the
 * MFEs end up with the same truth — read from one source, not mirrored into a
 * second one.
 */

import type { FrontXApp } from '@gears-frontx/react';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
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
  project?: ContextEntity | null;
}

function contextState(app: FrontXApp): ContextSliceShape {
  const state = app.store.getState() as Record<string, unknown>;
  return (state[APP_CONTEXT_SLICE_KEY] as ContextSliceShape | undefined) ?? {};
}

function sessionState(app: FrontXApp): { profile?: SessionProfile | null } {
  const state = app.store.getState() as Record<string, unknown>;
  return (state[APP_SESSION_SLICE_KEY] as { profile?: SessionProfile | null } | undefined) ?? {};
}

/**
 * Which project the session is inside, as a tenant id — `null` at organization
 * scope, which is a published answer and not an absent one.
 */
export function publishSelectedProject(app: FrontXApp): void {
  publish(app, STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, contextState(app).project?.id ?? null);
}

/**
 * Which organization is in scope — the answer no MFE should be deriving.
 *
 * Read from the slice rather than from the event that triggered it, and that is
 * load-bearing: `setContextOrg` resolves an id against the offered list and
 * no-ops on an unknown one, so only the store knows whether a switch actually
 * happened. Publishing the payload instead would name an organization the top
 * bar is not showing.
 */
export function publishSelectedOrganization(app: FrontXApp): void {
  const org = contextState(app).org ?? null;
  publish(
    app,
    STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
    org ? { id: org.id, name: org.name } : null
  );
}

/** Who is signed in, for display. See `appSessionSlice` for why it is stored. */
export function publishSessionProfile(app: FrontXApp): void {
  publish(app, STUDIO_SHARED_PROPERTY_SESSION_PROFILE, sessionState(app).profile ?? null);
}

/**
 * All three at once, for `bootstrapMFE` to call as soon as the domains are
 * registered. Anything already resolved lands here; anything not yet resolved
 * lands as `null`, which is the seed every declared property needs.
 */
export function publishStudioContext(app: FrontXApp): void {
  publishSelectedOrganization(app);
  publishSelectedProject(app);
  publishSessionProfile(app);
}
