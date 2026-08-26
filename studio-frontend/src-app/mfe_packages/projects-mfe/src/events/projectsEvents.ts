/**
 * Event types this MFE emits and listens to.
 *
 * Two groups, and the difference matters:
 *
 * - `mfe/projects/*` are its own. Actions emit them, effects dispatch on them.
 * The shell's `app/context/*` keys are deliberately NOT declared here any more:
 * they cannot be emitted from this realm at all (the MFE has its own eventBus),
 * so declaring them would only invite someone to try. The shell hears us through
 * the action chain in actions/projectsActions.ts.
 */

import '@gears-frontx/react';

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    /** A row was activated — open that project's frame. */
    'mfe/projects/open-requested': { id: string; name: string };
    /** Back out to the list (breadcrumb, "All projects"). */
    'mfe/projects/close-requested': void;
    /** The rail was clicked. */
    'mfe/projects/section-selected': { section: string };
  }
}
