import React from 'react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { projectStatus } from '../../../model/project';
import type { ProjectConfigState } from '../../../shared/useProjectConfig';
import { useProjectListText } from '../../../i18n';
import type { TenantDto } from '../../../api/types';
import { LoadFailed } from './LoadFailed';
import styles from '../ProjectListScreen.module.css';

/** Everything the column can say, in one word. */
type CellStatus = ReturnType<typeof projectStatus> | 'unset';

const StatusBadge: React.FC<{ status: CellStatus }> = ({ status }) => {
  const t = useProjectListText();

  // TODO: plain text until ui-kit carries a plain status badge again (0.4 dropped
  // Badge's `shape="plain"`/`dot`). The tone mapping is kept for that swap.
  return <>{t(`status_${status}`)}</>;
};

StatusBadge.displayName = 'StatusBadge';

/**
 * The tenant's own lifecycle: `active` / `suspended` / `deleted`.
 */
export const StatusInline: React.FC<{ tenant: TenantDto }> = ({ tenant }) => (
  <StatusBadge status={tenant.status} />
);

StatusInline.displayName = 'StatusInline';

export const ProjectStatusInline: React.FC<{ tenant: TenantDto; state: ProjectConfigState }> = ({
  tenant,
  state,
}) => {
  const t = useProjectListText();
  const { config, loading, unset, failed } = state;

  if (loading) return <Skeleton className={styles.cellSkeleton} />;
  if (failed) return <LoadFailed label={t('load_failed')} />;

  const status = projectStatus(tenant, config);
  if (status === 'suspended' || status === 'deleted') return <StatusBadge status={status} />;

  return <StatusBadge status={unset ? 'unset' : status} />;
};

ProjectStatusInline.displayName = 'ProjectStatusInline';
