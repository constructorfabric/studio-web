/**
 * The second entry of this MFE: the New project wizard, mounted by the shell
 * into its overlay domain.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-overlay:p1
import React from 'react';
import { anchorKitThemeOnShadowHost, StudioMfeLifecycle } from '@constructor-studio/mfe-shared';
import kitTheme from '@gears-frontx/ui-kit/theme.css?inline';
import { mfeApp } from './init';
import { NewProjectWizard } from './screens/project-create/NewProjectWizard';

/** Same re-anchored kit theme as the screenset entry; see `lifecycle.tsx`. */
const KIT_THEME_ON_HOST = anchorKitThemeOnShadowHost(kitTheme);

class ProjectCreateLifecycle extends StudioMfeLifecycle {
  constructor() {
    super(mfeApp, KIT_THEME_ON_HOST);
  }

  protected renderContent(): React.ReactNode {
    return <NewProjectWizard />;
  }
}

export default new ProjectCreateLifecycle();
