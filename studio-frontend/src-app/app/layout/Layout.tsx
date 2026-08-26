/**
 * Layout Component
 *
 * Main layout orchestrator for the application.
 *
 * The top bar is the only chrome in the flow: it takes a 56px row and the
 * mounted MFE gets everything below it, full width. Navigation is no longer a
 * column beside the content — `Menu` renders as an overlay drawer outside the
 * flow, so nothing reserves space for it while it is closed.
 */

import React, { useEffect } from 'react';
import { fetchCurrentUser, fetchAppContext } from '@/app/actions/bootstrapActions';
import { Header } from './Header';
import { Menu } from './Menu';
import { Screen } from './Screen';
import { Popup } from './Popup';
import { Overlay } from './Overlay';
import { OverlayDialog } from './OverlayDialog';

export interface LayoutProps {
  children?: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  useEffect(() => {
    // Bootstrap application on mount — the signed-in user, and the organizations
    // the top bar's context slot switches between.
    fetchCurrentUser();
    fetchAppContext();
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Global top bar: navigation control, product name, context, session */}
      <Header />

      {/* The mounted MFE owns everything below the top bar, full width. */}
      <Screen>{children}</Screen>

      {/* Out of the flow, over everything: drawer, dialogs, overlays. */}
      <Menu />
      <OverlayDialog />
      <Popup />
      <Overlay />
    </div>
  );
};

Layout.displayName = 'Layout';
