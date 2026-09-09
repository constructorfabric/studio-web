/**
 * The organization at a glance: the level's first screen.
 *
 * A placeholder for now — the aggregate it is meant to show has no endpoint
 * behind it yet, so the screen says so rather than standing numbers in.
 */

import React from 'react';
import { Empty, EmptyDescription, Skeleton } from '@gears-frontx/ui-kit';
import { useOrganization } from '@constructor-studio/mfe-shared';
import { useOverviewScreenTranslations, useOverviewText } from '../../i18n';
import styles from './OverviewScreen.module.css';

export const OverviewScreen: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useOverviewScreenTranslations();
  const t = useOverviewText();
  const { org, loading } = useOrganization();

  // Until the dictionary is in, `t` answers with the key it was asked for, so
  // the frame waits rather than painting `screen.organization.overview:title`.
  if (!isLoaded && !translationsFailed) {
    return (
      <div className={styles.screen} data-state="loading">
        <header className={styles.header}>
          <Skeleton className={styles.titleSkeleton} />
        </header>
      </div>
    );
  }

  if (!org) {
    return (
      <div className={styles.screen} data-state="no-organization">
        <header className={styles.header}>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.subtitle}>{loading ? t('resolving_org') : t('no_org')}</p>
        </header>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.subtitle}>{org.name}</p>
      </header>
      <Empty>
        <EmptyDescription>{t('tile_attention_owed')}</EmptyDescription>
      </Empty>
    </div>
  );
};

OverviewScreen.displayName = 'OverviewScreen';
