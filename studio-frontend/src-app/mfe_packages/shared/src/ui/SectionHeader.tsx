/** The kit's page header as an MFE screen draws it: an `h2` under the shell's level `h1`. */

import React from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
  Skeleton,
} from '@gears-frontx/ui-kit';
import styles from './SectionHeader.module.css';

interface SectionHeaderProps {
  title: string;
  busy: boolean;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  busy,
  description,
  actions,
  className,
}) => (
  <PageHeader className={className}>
    <PageHeaderContent>
      <PageHeaderTitle render={<h2 />}>
        {busy ? <Skeleton className={styles.titleSkeleton} /> : title}
      </PageHeaderTitle>
      {description ? <PageHeaderDescription>{description}</PageHeaderDescription> : null}
    </PageHeaderContent>
    <PageHeaderActions className={styles.actions}>{actions}</PageHeaderActions>
  </PageHeader>
);

SectionHeader.displayName = 'SectionHeader';
