/**
 * Screen Component
 *
 * Main content area that renders the active screen.
 *
 * No padding of its own: with the left column gone the MFE owns the full width
 * below the top bar, and the mockups place each screen's own gutters inside it —
 * a graph canvas and a data table do not want the same inset.
 */

import React from 'react';

export interface ScreenProps {
  children?: React.ReactNode;
}

export const Screen: React.FC<ScreenProps> = ({ children }) => {
  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">{children}</main>
  );
};

Screen.displayName = 'Screen';
