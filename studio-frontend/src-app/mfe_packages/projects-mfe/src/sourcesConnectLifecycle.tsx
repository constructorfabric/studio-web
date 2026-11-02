/**
 * The fourth entry of this MFE: Connect source, mounted by the shell into its
 * overlay domain over the project screen.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-sources-connect-overlay:p1
import React from 'react';
import { anchorKitThemeOnShadowHost, StudioMfeLifecycle } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { SourcesConnectDialog } from './screens/sources-connect/SourcesConnectDialog';

const KIT_THEME_ON_HOST = anchorKitThemeOnShadowHost(kitTheme);

class SourcesConnectLifecycle extends StudioMfeLifecycle {
  constructor() {
    super(mfeApp, KIT_THEME_ON_HOST);
  }

  protected renderContent(): React.ReactNode {
    return <SourcesConnectDialog />;
  }
}

export default new SourcesConnectLifecycle();
