import React from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { useConnectionHealth } from '../../../shared/useConnectionHealth';
import { useConnectionListText } from '../../../i18n';
import { LoadFailed } from './LoadFailed';
import { NoData } from './NoData';
import styles from '../ConnectionListScreen.module.css';

export const HealthInline: React.FC<{ connectionId: string; tenantId: string }> = ({
  connectionId,
  tenantId,
}) => {
  const t = useConnectionListText();
  const { health, reason, loading, failed } = useConnectionHealth(connectionId, tenantId);

  if (loading) return <Skeleton className={styles.cellSkeleton} />;
  if (failed) return <LoadFailed label={t('load_failed')} />;
  if (!health) return <NoData label={t('no_data')} />;

  // TODO: plain text until ui-kit carries a plain status badge again (0.4 dropped
  // Badge's `shape="plain"`/`dot`). The tone mapping is kept for that swap.
  return <span title={reason ?? undefined}>{t(`health_${health}`)}</span>;
};

HealthInline.displayName = 'HealthInline';
