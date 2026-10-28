// @cpt-dod:cpt-studiofrontend-dod-project-sources-menu:p1
import React from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@gears-frontx/ui-kit';
import { ExternalLink, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useSourcesText } from '../../../../i18n';
import type { SourcesTableRow } from '../../../../model/sourceRows';
import {
  sourceRowMenu,
  uploadsRowMenu,
  type SourceMenuItem,
  type SyncDisabled,
} from '../../../../model/sourceRowMenu';
import type { SourceRowActions } from '../../../../shared/useSourceRowActions';
import styles from './SourceRowMenu.module.css';

export interface SourceRowMenuProps {
  row: SourcesTableRow;
  actions: SourceRowActions;
  container?: HTMLElement | null;
}

export const SourceRowMenu: React.FC<SourceRowMenuProps> = ({ row, actions, container }) => {
  const t = useSourcesText();

  const disabledTitle = (disabled: SyncDisabled): string => {
    switch (disabled.reason) {
      case 'cancelling':
        return t('sync_cancelling');
      case 'requesting':
        return t('sync_requesting');
      case 'not_connected':
        return t('sync_not_connected');
      case 'unavailable':
        return t('sync_unavailable', { provider: actions.providerName(disabled.provider) });
      case 'connections_unread':
        return t('sync_connections_unread');
    }
  };

  const item = (entry: SourceMenuItem): React.ReactNode => {
    switch (entry.kind) {
      case 'cancel_sync':
        return (
          row.kind === 'repository' && (
            <DropdownMenuItem
              key="sync"
              className={styles.item}
              disabled={entry.disabled !== null}
              title={entry.disabled ? disabledTitle(entry.disabled) : undefined}
              onClick={() => actions.cancelSync(row)}
            >
              {t('menu_cancel_sync')}
            </DropdownMenuItem>
          )
        );
      case 'sync_now':
        return (
          row.kind === 'repository' && (
            <DropdownMenuItem
              key="sync"
              className={styles.item}
              disabled={entry.disabled !== null}
              title={entry.disabled ? disabledTitle(entry.disabled) : undefined}
              onClick={() => actions.syncNow(row, entry.retry)}
            >
              <RefreshCw />
              {t('menu_sync_now')}
            </DropdownMenuItem>
          )
        );
      case 'open_specs':
        return (
          row.kind === 'repository' && (
            <DropdownMenuItem key="specs" onClick={() => actions.openSpecs(row)}>
              {t('menu_open_specs')}
            </DropdownMenuItem>
          )
        );
      case 'open_uploads':
        return (
          <DropdownMenuItem key="uploads" onClick={actions.openUploads}>
            {t('menu_open_uploads')}
          </DropdownMenuItem>
        );
      case 'open_in':
        return (
          <DropdownMenuItem
            key="open-in"
            onClick={() => window.open(entry.url, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink />
            {t('menu_open_in', { provider: actions.providerName(entry.provider) })}
          </DropdownMenuItem>
        );
      case 'disconnect':
        return (
          <React.Fragment key="disconnect">
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={styles.item}
              disabled
              title={t('menu_disconnect_unavailable')}
            >
              {t('menu_disconnect')}
            </DropdownMenuItem>
          </React.Fragment>
        );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={styles.actionsButton}
            aria-label={t('row_actions', {
              name: row.kind === 'uploads' ? t('uploads_name') : row.name,
            })}
            icon={<MoreHorizontal size={16} strokeWidth={1.5} />}
          />
        }
      />
      <DropdownMenuContent align="end" container={container ?? undefined}>
        {(row.kind === 'uploads'
          ? uploadsRowMenu()
          : sourceRowMenu(row, actions.connectionsRead)
        ).map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

SourceRowMenu.displayName = 'SourceRowMenu';
