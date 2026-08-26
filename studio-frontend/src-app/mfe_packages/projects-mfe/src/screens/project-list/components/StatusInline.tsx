import React from 'react';
import { Badge } from '@gears-frontx/ui-kit';
import { statusTone } from '../../../model/project';
import { useProjectListText } from '../../../i18n';
import type { TenantDto } from '../../../api/types';

/**
 * The tenant's own lifecycle: `active` / `suspended` / `deleted`. It is the only
 * status the list can show for free — the project's `draft` / `active` /
 * `archived` lives in `project.config` tenant metadata
 */
export const StatusInline: React.FC<{ tenant: TenantDto }> = ({ tenant }) => {
  const t = useProjectListText();

  return (
    <Badge variant={statusTone(tenant.status)} shape="plain" dot>
      {t(`status_${tenant.status}`)}
    </Badge>
  );
};

StatusInline.displayName = 'StatusInline';
