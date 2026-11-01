/**
 * The second entry of this MFE: the Connect source form, mounted by the shell
 * into its overlay domain.
 */

// @cpt-dod:cpt-studiofrontend-dod-connection-create-overlay:p1
import React from 'react';
import { anchorKitThemeOnShadowHost, StudioMfeLifecycle } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { ConnectSourceDialog } from './screens/connect-source/ConnectSourceDialog';

/** Same re-anchored kit theme as the screenset entry; see `lifecycle.tsx`. */
const KIT_THEME_ON_HOST = anchorKitThemeOnShadowHost(kitTheme);

class ConnectSourceLifecycle extends StudioMfeLifecycle {
  constructor() {
    super(mfeApp, KIT_THEME_ON_HOST);
  }

  protected renderContent(): React.ReactNode {
    return <ConnectSourceDialog />;
  }
}

export default new ConnectSourceLifecycle();
