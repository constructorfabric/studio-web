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
    /** Resolve the signed-in user's organizations. No payload — reads /me. */
    'app/context/fetch': void;
    /** An organization was picked in the switcher. */
    'app/context/org/changed': { orgId: string };
    /** A project was opened — published by whoever owns projects. `workspaceId` is the scope it was read in, so a late announcement from a workspace since left can be dropped. */
    'app/context/project/opened': { id: string; name: string; workspaceId?: string };
    /** The switchable project list — published by whoever owns projects. `workspaceId` is the scope it was read in, and carries the same meaning it has on `project/opened`: the list travels with that event and is dropped on the same terms. */
    'app/context/projects': { items: { id: string; name: string }[]; workspaceId?: string };
    /** A project was picked in the switcher; the owning MFE navigates. */
    'app/context/project/changed': { projectId: string };
    /** Left the project scope (a global screen mounted, or "All projects"). */
    'app/context/project/closed': void;
    /** Go to a level: mount its first item. Emitted when a slot above or below the level in scope is picked. */
    'app/context/level/requested': { level: 'organization' | 'workspace' | 'project' };
    /** Go to one screen of the level in scope, named in the rail. The shell decides what it means: another section of the mounted entry, or a mount. */
    'app/context/screen/requested': { extensionId: string };
    /** A section of the level in scope is now on screen — chosen in the rail, or moved by the MFE itself. */
    'app/context/project/section': { section: string | null };
    /** A workspace was picked — in its slot, or on a screen that read it itself (then with its name). `organizationId` is set only by the latter, and says which organization the screen was listing. */
    'app/context/workspace/changed': { workspaceId: string; name?: string; organizationId?: string };
    /** A workspace was created by an MFE and must become the current one. `organizationId` is the parent it was created under. */
    'app/context/workspace/created': { id: string; name: string; organizationId?: string };
    /** The mounted screen works inside a workspace, so the slot naming it belongs in the bar. */
    'app/context/workspace/scoped': void;
    /** The workspace read failed; the shell retries once so the chain regains its slot. */
    'app/context/workspaces/failed': void;
  }
}
