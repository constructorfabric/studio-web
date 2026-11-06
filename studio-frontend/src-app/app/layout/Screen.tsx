/** Screen Component  */

import React from 'react';

export interface ScreenProps {
  children?: React.ReactNode;
}

export const Screen: React.FC<ScreenProps> = ({ children }) => {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
  );
};

Screen.displayName = 'Screen';
