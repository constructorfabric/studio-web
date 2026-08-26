/**
 * Bootstrap Events
 * App-level events for bootstrap operations
 */

import '@gears-frontx/react';

/**
 * Module augmentation for type-safe event payloads
 * Define payload types for each event
 *
 * NOTE: We augment @gears-frontx/react's EventPayloadMap interface.
 * This maintains layer architecture by not importing from L1 packages directly.
 * The @gears-frontx/react package re-declares EventPayloadMap to enable this pattern.
 */
declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    /** Fetch current user - no payload needed */
    'app/user/fetch': void;
    /** MFE manifest fetch + extension registration reached a terminal state */
    'app/mfe/bootstrap': { status: 'pending' | 'ready' | 'failed' };

    // Top-bar context slot
    // Two directions on purpose. The shell owns organizations and asks itself
    // to load them; projects belong to the studio-project gear, so the shell
    // only announces a selection and projects-mfe answers by publishing state.
    // See slices/appContextSlice.ts for who writes what.

    /** Resolve the signed-in user's organizations. No payload — reads /me. */
    'app/context/fetch': void;
    /** An organization was picked in the switcher. */
    'app/context/org/changed': { orgId: string };
    /** A project was opened — published by whoever owns projects. */
    'app/context/project/opened': { id: string; name: string };
    /** The switchable project list — published by whoever owns projects. */
    'app/context/projects': { items: { id: string; name: string }[] };
    /** A project was picked in the switcher; the owning MFE navigates. */
    'app/context/project/changed': { projectId: string };
    /** Left the project scope (a global screen mounted, or "All projects"). */
    'app/context/project/closed': void;
  }
}
