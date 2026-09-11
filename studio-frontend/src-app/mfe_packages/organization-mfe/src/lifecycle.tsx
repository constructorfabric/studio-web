import React from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { anchorKitThemeOnShadowHost, ThemeAwareReactLifecycle } from '@gears-frontx/react';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { OrganizationRoot } from './OrganizationRoot';

/**
 * The ui-kit theme travels inside this bundle (`?inline`; the kit is
 * deliberately absent from sharedDeps — externalizing it would strand its CSS)
 * and is re-anchored `:root`→`:host`, because a ShadowRoot is a
 * DocumentFragment that `:root` can never reach. Rewritten once at module load
 * rather than per mount.
 *
 * Known, measured-harmless collision: the base BASE_RESETS sheet paints `:host`
 * from `hsl(var(--background))`; the kit's re-anchored hex tokens make that
 * expression invalid, so the host computes transparent. That is what the screen
 * wants: its root keeps the kit's `[data-theme]` paint off deliberately, so the
 * shell's own ground shows through.
 */
const KIT_THEME_ON_HOST = anchorKitThemeOnShadowHost(kitTheme);

class ScreensetLifecycle extends ThemeAwareReactLifecycle {
  constructor() {
    // ThemeAwareReactLifecycle consumes the host handoff and passes the
    // shared server-state runtime into FrontXProvider for this mounted root.
    super(mfeApp, { additionalStyles: [KIT_THEME_ON_HOST] });
  }

  protected renderContent(bridge: ChildMfeBridge): React.ReactNode {
    return <OrganizationRoot bridge={bridge} />;
  }
}

/**
 * Export a singleton instance of the lifecycle class.
 * Module Federation expects a default export; the handler calls
 * moduleFactory() which returns this module, then validates it
 * has mount/unmount methods.
 */
export default new ScreensetLifecycle();
