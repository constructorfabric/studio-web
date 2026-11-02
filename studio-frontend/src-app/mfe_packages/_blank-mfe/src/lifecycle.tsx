import React from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { anchorKitThemeOnShadowHost, StudioMfeLifecycle } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { HomeScreen } from './screens/home/HomeScreen';

/**
 * The ui-kit theme travels inside this bundle (`?inline`; the kit is
 * deliberately absent from sharedDeps — externalizing it would strand its CSS)
 * and is re-anchored `:root`→`:host`, because a ShadowRoot is a
 * DocumentFragment that `:root` can never reach. Rewritten once at module load
 * rather than per mount.
 */
const KIT_THEME_ON_HOST = anchorKitThemeOnShadowHost(kitTheme);

/**
 * A Studio MFE extends `StudioMfeLifecycle`, not FrontX's base class: its warm
 * style cache gives the first mount a styled paint, and it keeps the shell's
 * page showing through the shadow host.
 */
class BlankMfeLifecycle extends StudioMfeLifecycle {
  constructor() {
    // StudioMfeLifecycle puts the kit theme on the shadow host; the base class does the rest.
    super(mfeApp, KIT_THEME_ON_HOST);
  }

  protected renderContent(bridge: ChildMfeBridge): React.ReactNode {
    return <HomeScreen bridge={bridge} />;
  }
}

/**
 * Export a singleton instance of the lifecycle class.
 * Module Federation expects a default export; the handler calls
 * moduleFactory() which returns this module, then validates it
 * has mount/unmount methods.
 */
export default new BlankMfeLifecycle();
