/** The organization level's screens, in one entry. */

// @cpt-dod:cpt-studiofrontend-dod-organization-overview-item:p1
import React from 'react';
import { useSharedProperty, type ChildMfeBridge } from '@gears-frontx/react';
import {
  OrganizationProvider,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
} from '@constructor-studio/mfe-shared';
import { HomeScreen } from './screens/home/HomeScreen';
import { OverviewScreen } from './screens/overview/OverviewScreen';
import { WorkspacesScreen } from './screens/workspaces/WorkspacesScreen';

export interface OrganizationRootProps {
  bridge: ChildMfeBridge;
}

export const OrganizationRoot: React.FC<OrganizationRootProps> = ({ bridge }) => {
  const section = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_SECTION);

  if (section === 'settings') return <HomeScreen bridge={bridge} />;
  return (
    <OrganizationProvider>
      {section === 'workspaces' ? <WorkspacesScreen /> : <OverviewScreen />}
    </OrganizationProvider>
  );
};

OrganizationRoot.displayName = 'OrganizationRoot';
