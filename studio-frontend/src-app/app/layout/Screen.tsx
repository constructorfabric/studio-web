/** Screen Component  */

import React from 'react';

export interface ScreenProps {
  children?: React.ReactNode;
}

export const Screen: React.FC<ScreenProps> = ({ children }) => {
  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-card">{children}</main>
  );
};

Screen.displayName = 'Screen';
