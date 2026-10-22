// TODO: move to mfe-shared once another MFE uses it.

import React from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
  Skeleton,
} from '@gears-frontx/ui-kit';
import styles from './SectionHeader.module.css';

interface SectionHeaderProps {
  title: string;
  busy: boolean;
  actions?: React.ReactNode;
  className?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  busy,
  actions,
  className,
}) => (
  <PageHeader className={className}>
    <PageHeaderContent>
      <PageHeaderTitle render={<h2 />}>
        {busy ? <Skeleton className={styles.titleSkeleton} /> : title}
      </PageHeaderTitle>
    </PageHeaderContent>
    {actions ? <PageHeaderActions>{actions}</PageHeaderActions> : null}
  </PageHeader>
);

SectionHeader.displayName = 'SectionHeader';
