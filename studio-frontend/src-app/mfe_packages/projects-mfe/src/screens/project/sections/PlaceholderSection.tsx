import React from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@gears-frontx/ui-kit';

export const PlaceholderSection: React.FC<{ title: string; note: string }> = ({ title, note }) => (
  <Empty>
    <EmptyHeader>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{note}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

PlaceholderSection.displayName = 'PlaceholderSection';
