/**
 * Layout Component
 *
 * Main layout orchestrator for the application.
 */

import React, { useEffect } from 'react';
import { fetchCurrentUser, fetchAppContext } from '@/app/actions/bootstrapActions';
import { Header } from './Header';
import { Rail } from './Rail';
import { Screen } from './Screen';
import { Popup } from './Popup';
import { Overlay } from './Overlay';
import { OverlayDialog } from './OverlayDialog';
import { OrganizationAccessGate, useHasNoOrganization } from './OrganizationAccessGate';

export interface LayoutProps {
  children?: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  // An authenticated person with no organization membership gets the onboarding
  // state instead of the mounted screen (ADR-0011 §3). The top bar stays — they
  // still need the account menu and a way to sign out — but its context slot has
  // nothing to offer and the screen below has no scope to render in.
  const noOrganization = useHasNoOrganization();

  useEffect(() => {
    // Bootstrap application on mount — the signed-in user, and the organizations
    // the top bar's context slot switches between.
    fetchCurrentUser();
    fetchAppContext();
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Global top bar: brand, the path to the level in scope, session */}
      <Header />

      {/* The level's rail, then the screen it mounts. */}
      <div className="flex min-h-0 flex-1">
        <Rail />
          <Screen>{noOrganization ? <OrganizationAccessGate /> : children}</Screen>
      </div>

      {/* Out of the flow, over everything: dialogs and overlays. */}
      <OverlayDialog />
      <Popup />
      <Overlay />
    </div>
  );
};

Layout.displayName = 'Layout';
